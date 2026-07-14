import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { AppSettingsStore } from '../core/settings/AppSettingsStore';
import type {
  AppUpdateEvent,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  GitHubPreflightRequest,
  InspectOpenTargetRequest,
  ExecuteOpenTargetActionRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RespondToInteractionRequest,
  RefinePromptRequest,
  StartRunRequest,
  StartReviewRequest,
  SteerRunRequest,
  RetryRunRequest,
  SyncAgentGoalRequest,
  ReadProtocolMessageRequest,
  TestExternalToolRequest,
  TransitionTaskRequest,
  UpdateAgentNativeSessionRequest,
  UpdateAppSettingsRequest
} from '../shared/contracts';
import {
  ATTACHMENT_MAX_CLIPBOARD_IMAGE_PIXELS,
  ATTACHMENT_MAX_IMAGE_BYTES,
  type ClipboardAttachmentImage,
  type DiscardTaskAttachmentDraftRequest,
  type ReadTaskAttachmentRequest,
  type StageTaskAttachmentBatchRequest
} from '../shared/attachments';
import {
  rendererContentSecurityPolicy,
  VITE_REACT_REFRESH_PREAMBLE_SOURCE
} from '../shared/rendererSecurity';
import {
  AttachmentIpcOperationGate,
  assertAttachmentIpcBatch,
} from './attachmentIpcSecurity';
import { createElectronOpenTargetHost } from './openTargetHost';
import { getMacDockIconPath } from './dockIcon';
import { getMacTrafficLightPosition, getMainWindowChromeOptions } from './windowChrome';
import { shouldCreateWindowOnActivate } from './windowLifecycle';
import {
  createRendererTrustPolicy,
  isSafeExternalUrl,
  isTrustedIpcInvokeEvent,
  isTrustedRendererPermissionRequest,
  type RendererTrustPolicy
} from './rendererTrust';

let mainWindow: BrowserWindow | undefined;
let service: TaskManagerService;
let serviceCreated = false;
let ipcHandlersInstalled = false;
let quitAfterShutdown = false;
let shutdownPromise: Promise<void> | undefined;
let rendererTrustPolicy: RendererTrustPolicy | undefined;
const attachmentIpcGate = new AttachmentIpcOperationGate();

const appId = 'dev.taskmonki.desktop';
const ownsSingleInstanceLock = app.requestSingleInstanceLock();

if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    if (app.isReady() && serviceCreated && ipcHandlersInstalled) {
      createWindow();
    }
  });
}

function syncWindowChrome(window: BrowserWindow): void {
  if (process.platform !== 'darwin' || window.isDestroyed()) {
    return;
  }
  window.setWindowButtonPosition(
    getMacTrafficLightPosition(window.webContents.getZoomFactor())
  );
}

function createWindow(): void {
  const rendererFilePath = path.join(__dirname, '../../dist-renderer/index.html');
  const trustPolicy = createRendererTrustPolicy({
    isPackaged: app.isPackaged,
    rendererFilePath,
    devServerUrl: process.env.VITE_DEV_SERVER_URL
  });
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Task Monki',
    backgroundColor: '#101217',
    ...getMainWindowChromeOptions(process.platform),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      webviewTag: false
    }
  });
  mainWindow = window;
  rendererTrustPolicy = trustPolicy;

  hardenRendererWindow(window, trustPolicy);
  window.once('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined;
      rendererTrustPolicy = undefined;
    }
  });
  const createdWindow = mainWindow;

  createdWindow.webContents.on('did-finish-load', () => {
    syncWindowChrome(createdWindow);
  });
  createdWindow.webContents.on('zoom-changed', () => {
    setTimeout(() => {
      syncWindowChrome(createdWindow);
    }, 0);
  });

  if (trustPolicy.kind === 'development-server') {
    void window.loadURL(trustPolicy.entryUrl);
  } else {
    void window.loadFile(rendererFilePath);
  }
}

function hardenRendererWindow(
  window: BrowserWindow,
  trustPolicy: RendererTrustPolicy
): void {
  window.webContents.on('will-navigate', (event) => {
    if (!trustPolicy.isTrustedUrl(event.url)) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !trustPolicy.isTrustedUrl(event.url)) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !trustPolicy.isTrustedUrl(event.url)) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (
      trustPolicy.isTrustedUrl(window.webContents.getURL()) &&
      isSafeExternalUrl(url)
    ) {
      void shell.openExternal(url).catch((error: unknown) => {
        console.error('Task Monki could not open an external link.', error);
      });
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  const rendererSession = window.webContents.session;
  rendererSession.webRequest.onHeadersReceived(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      if (!trustPolicy.isTrustedUrl(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            rendererContentSecurityPolicy(
              trustPolicy.kind === 'development-server'
                ? {
                    developmentWebSocketOrigin: webSocketOrigin(trustPolicy.entryUrl),
                    developmentScriptSources: [VITE_REACT_REFRESH_PREAMBLE_SOURCE]
                  }
                : undefined
            )
          ],
          'X-Frame-Options': ['DENY'],
          'X-Content-Type-Options': ['nosniff'],
          'Referrer-Policy': ['no-referrer']
        }
      });
    }
  );
  rendererSession.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) =>
      isTrustedRendererPermissionRequest(
        {
          permission,
          requestingUrl: details.requestingUrl ?? webContents?.getURL(),
          isMainFrame: details.isMainFrame,
          senderMatches:
            webContents === window.webContents &&
            trustPolicy.isTrustedUrl(window.webContents.getURL())
        },
        trustPolicy
      )
  );
  rendererSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        isTrustedRendererPermissionRequest(
          {
            permission,
            requestingUrl: details.requestingUrl,
            isMainFrame: details.isMainFrame,
            senderMatches:
              webContents === window.webContents &&
              trustPolicy.isTrustedUrl(window.webContents.getURL())
          },
          trustPolicy
        )
      );
    }
  );
  rendererSession.setDevicePermissionHandler(() => false);
}

function webSocketOrigin(entryUrl: string): string {
  const url = new URL(entryUrl);
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
}

function configureMacDockIcon(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const iconPath = getMacDockIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  });
  if (fs.existsSync(iconPath)) {
    app.dock.setIcon(iconPath);
  }
}

function installIpcHandlers(): void {
  ipcMain.on('windowChrome:sync', (event: IpcMainEvent) => {
    const window = mainWindow;
    const trustPolicy = rendererTrustPolicy;
    if (
      !window ||
      window.isDestroyed() ||
      !trustPolicy ||
      !isTrustedIpcInvokeEvent(event, window.webContents, trustPolicy)
    ) {
      return;
    }
    syncWindowChrome(window);
  });
  handleTrustedIpc('repository:defaultPath', () => service.getDefaultRepositoryPath());
  handleTrustedIpc('repository:chooseFolder', async () => {
    const options: OpenDialogOptions = {
      title: 'Add repository',
      properties: ['openDirectory']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
  handleTrustedIpc('agent:runtimeCatalog', () => service.getAgentRuntimeCatalog());
  handleTrustedIpc(
    'agent:updateNativeSession',
    async (_, input: UpdateAgentNativeSessionRequest) => {
      return service.updateAgentNativeSession(input);
    }
  );
  handleTrustedIpc('settings:get', () => service.getAppSettings());
  handleTrustedIpc('settings:update', async (_, input: UpdateAppSettingsRequest) => {
    return service.updateAppSettings(input);
  });
  handleTrustedIpc('settings:tools:status', () => service.getExternalToolStatus());
  handleTrustedIpc('settings:tools:test', async (_, input: TestExternalToolRequest) => {
    return service.testExternalTool(input);
  });
  handleTrustedIpc('openTarget:inspect', async (_, input: InspectOpenTargetRequest) => {
    return service.inspectOpenTarget(input);
  });
  handleTrustedIpc('openTarget:execute', async (_, input: ExecuteOpenTargetActionRequest) => {
    return service.executeOpenTargetAction(input);
  });

  handleTrustedIpc('repository:validate', async (_, repositoryPath: string) => {
    return service.validateRepository(repositoryPath);
  });

  handleTrustedIpc('task:list', async () => {
    return service.listTasks();
  });

  handleTrustedIpc(
    'attachment:stage-batch',
    async (_, input: StageTaskAttachmentBatchRequest) => {
      const byteCount = assertAttachmentIpcBatch(input);
      return attachmentIpcGate.run(byteCount, () =>
        service.stageTaskAttachmentBatch(input)
      );
    }
  );

  handleTrustedIpc(
    'attachment:draft:discard',
    async (_, input: DiscardTaskAttachmentDraftRequest) =>
      service.discardTaskAttachmentDraft(input)
  );

  handleTrustedIpc(
    'attachment:read',
    async (_, input: ReadTaskAttachmentRequest) =>
      attachmentIpcGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () =>
        service.readTaskAttachment(input)
      )
  );

  handleTrustedIpc('attachment:clipboard:readImage', () =>
    attachmentIpcGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () => readClipboardImage())
  );

  handleTrustedIpc('task:create', async (_, input: CreateTaskRequest) => {
    const task = await service.createTask(input);
    broadcast({
      type: 'task.updated',
      taskId: task.id,
      payload: task,
      at: new Date().toISOString()
    });
    return task;
  });

  handleTrustedIpc('prompt:refine', async (_, input: RefinePromptRequest) => {
    return service.refinePrompt(input);
  });

  handleTrustedIpc('worktree:prepare', async (_, input: PrepareWorktreeRequest) => {
    return service.prepareWorktree(input);
  });

  handleTrustedIpc('agent:startRun', async (_, input: StartRunRequest) => {
    return service.startRun(input);
  });

  handleTrustedIpc('agent:steerRun', async (_, input: SteerRunRequest) => {
    return service.steerRun(input);
  });

  handleTrustedIpc('agent:continueRun', async (_, input: ContinueRunRequest) => {
    return service.continueRun(input);
  });

  handleTrustedIpc('agent:retryRun', async (_, input: RetryRunRequest) => {
    return service.retryRun(input);
  });

  handleTrustedIpc('agent:startReview', async (_, input: StartReviewRequest) => {
    return service.startReview(input);
  });

  handleTrustedIpc('agent:syncGoal', async (_, input: SyncAgentGoalRequest) => {
    return service.syncAgentGoal(input);
  });

  handleTrustedIpc('agent:cancelRun', async (_, { runId }: { runId: string }) => {
    await service.cancelRun({ runId });
  });

  handleTrustedIpc(
    'agent:respondToInteraction',
    async (_, input: RespondToInteractionRequest) => {
      return service.respondToInteraction(input);
    }
  );

  handleTrustedIpc('evidence:refresh', async (_, input: RefreshEvidenceRequest) => {
    return service.refreshEvidence(input);
  });

  handleTrustedIpc('git:deliveryCommit', async (_, input: CreateDeliveryCommitRequest) => {
    return service.createDeliveryCommit(input);
  });

  handleTrustedIpc('github:preflight', async (_, input: GitHubPreflightRequest) => {
    return service.preflightGitHub(input);
  });

  handleTrustedIpc('github:publish', async (_, input: PublishBranchRequest) => {
    return service.publishBranch(input);
  });

  handleTrustedIpc('github:createPullRequest', async (_, input: CreatePullRequestRequest) => {
    return service.createPullRequest(input);
  });

  handleTrustedIpc('github:refresh', async (_, input: RefreshGitHubRequest) => {
    return service.refreshGitHub(input);
  });

  handleTrustedIpc('task:transition', async (_, input: TransitionTaskRequest) => {
    return service.transitionTask(input);
  });

  handleTrustedIpc('task:delete', async (_, input: DeleteTaskRequest) => {
    return service.deleteTask(input);
  });

  handleTrustedIpc('artifact:read', async (_, { artifactId }: { artifactId: string }) => {
    return service.readArtifact({ artifactId });
  });

  handleTrustedIpc(
    'agent:readProtocolMessage',
    async (_, input: ReadProtocolMessageRequest) => {
      return service.readProtocolMessage(input);
    }
  );
  ipcHandlersInstalled = true;
}

function readClipboardImage(): ClipboardAttachmentImage | undefined {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return undefined;
  }
  const size = image.getSize();
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width * size.height > ATTACHMENT_MAX_CLIPBOARD_IMAGE_PIXELS
  ) {
    throw new Error('The clipboard image is too large to attach.');
  }
  const png = image.toPNG();
  if (png.byteLength === 0 || png.byteLength > ATTACHMENT_MAX_IMAGE_BYTES) {
    throw new Error('The clipboard image is too large to attach.');
  }
  const copy = Uint8Array.from(png);
  return {
    displayName: 'Pasted image.png',
    mediaType: 'image/png',
    bytes: copy.buffer
  };
}

type TrustedIpcHandler<TArgs extends unknown[], TResult> = (
  event: IpcMainInvokeEvent,
  ...args: TArgs
) => TResult | Promise<TResult>;

function handleTrustedIpc<TArgs extends unknown[], TResult>(
  channel: string,
  handler: TrustedIpcHandler<TArgs, TResult>
): void {
  ipcMain.handle(channel, (event, ...args: TArgs) => {
    const window = mainWindow;
    const trustPolicy = rendererTrustPolicy;
    if (
      !window ||
      window.isDestroyed() ||
      !trustPolicy ||
      !isTrustedIpcInvokeEvent(event, window.webContents, trustPolicy)
    ) {
      throw new Error('Blocked IPC request from an untrusted renderer.');
    }
    return handler(event, ...args);
  });
}

function broadcast(event: AppUpdateEvent): void {
  mainWindow?.webContents.send('app:update', event);
}

function configureDesktopCliPath(): void {
  const existingPath = process.env.PATH ?? '';
  const existingEntries = existingPath.split(path.delimiter).filter(Boolean);
  const windowsLocalGitPath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd')
    : undefined;
  const commonEntries =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
      : process.platform === 'linux'
        ? ['/usr/local/bin', '/usr/bin', '/bin']
        : [
            'C:\\Program Files\\Git\\cmd',
            'C:\\Program Files\\GitHub CLI',
            windowsLocalGitPath
          ];

  const entries = [
    ...commonEntries.filter((entry): entry is string => Boolean(entry)),
    ...existingEntries
  ];
  process.env.PATH = [...new Set(entries)].join(path.delimiter);
}

function resolveDefaultRepositoryPath(): string {
  if (process.env.TASK_MANAGER_REPO_PATH !== undefined) {
    return process.env.TASK_MANAGER_REPO_PATH;
  }
  return app.isPackaged ? '' : process.cwd();
}

void app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) {
    return;
  }
  app.setAppUserModelId(appId);
  configureDesktopCliPath();
  configureMacDockIcon();
  const defaultRepositoryPath = resolveDefaultRepositoryPath();
  const userDataDir = app.getPath('userData');
  const taskStoreDir = path.join(userDataDir, 'task-store');
  service = new TaskManagerService(
    new FileTaskStore(taskStoreDir),
    defaultRepositoryPath,
    undefined,
    {
      agentCwd: defaultRepositoryPath || app.getPath('home'),
      appSettingsStore: new AppSettingsStore(
        path.join(userDataDir, 'app-settings.json')
      ),
      openTargetHost: createElectronOpenTargetHost()
    }
  );
  serviceCreated = true;
  await service.init();
  service.events.on((event) => {
    broadcast(event);
  });
  installIpcHandlers();
  createWindow();
}).catch((error: unknown) => {
  console.error('Task Monki failed to initialize its trusted local services.', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (quitAfterShutdown || !serviceCreated) {
    return;
  }
  event.preventDefault();
  shutdownPromise ??= service
    .shutdown()
    .catch((error: unknown) => {
      console.error('Failed to shut down the Codex App Server cleanly.', error);
    })
    .then(() => {
      quitAfterShutdown = true;
      app.quit();
    });
});

app.on('activate', () => {
  if (
    ownsSingleInstanceLock &&
    shouldCreateWindowOnActivate({
      ipcHandlersInstalled,
      openWindowCount: BrowserWindow.getAllWindows().length
    })
  ) {
    createWindow();
  }
});
