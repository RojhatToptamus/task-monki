import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
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
  AcceptPreviewRecipeDraftRequest,
  AppUpdateEvent,
  ContinueRunRequest,
  CreateBoardRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  DisconnectRepositoryRequest,
  DeletePreviewLocalAttachmentBindingRequest,
  DiscardPreviewRecipeDraftRequest,
  GeneratePreviewRecipeRequest,
  GetPreviewRecipeGenerationRequest,
  ApprovePreviewPlanRequest,
  GitHubPreflightRequest,
  InspectOpenTargetRequest,
  OpenPreviewRequest,
  ExecuteOpenTargetActionRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  ReadPreviewLogRequest,
  ResetPreviewDataRequest,
  RetryPreviewSetupRequest,
  ResolvePreviewRequest,
  RespondToInteractionRequest,
  RefinePromptRequest,
  ReconnectRepositoryRequest,
  StartRunRequest,
  StartPreviewRequest,
  SetPreviewLocalAttachmentBindingRequest,
  StartReviewRequest,
  SteerRunRequest,
  RetryRunRequest,
  SyncAgentGoalRequest,
  ReadProtocolMessageRequest,
  TestExternalToolRequest,
  TransitionTaskRequest,
  UpdateAppSettingsRequest,
  StopPreviewRequest,
  UpdateBoardRequest,
  ValidatePreviewRecipeDraftRequest
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
  assertAttachmentIpcBatch
} from './attachmentIpcSecurity';
import { createElectronOpenTargetHost } from './openTargetHost';
import { getMacDockIconPath } from './dockIcon';
import { getMacTrafficLightPosition, getMainWindowChromeOptions } from './windowChrome';
import { shouldCreateWindowOnActivate } from './windowLifecycle';
import { resolveNativePreviewLauncherPath } from '../core/preview/runtime/launcherPath';
import { parseSelectedEnvValue } from '../core/preview/private/PreviewEnvImport';
import { createElectronPreviewUrlHost } from './previewOpenHost';
import {
  createRendererTrustPolicy,
  isSafeExternalUrl,
  isTrustedIpcInvokeEvent,
  isTrustedRendererPermissionRequest,
  type RendererTrustPolicy
} from './rendererTrust';
const MAX_PRIVATE_ENV_IMPORT_BYTES = 256 * 1024;

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
  handleTrustedIpc('agent:providerState', () => service.getAgentProviderState());
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

  handleTrustedIpc('repository:add', async (_, repositoryPath: string) => {
    return service.addRepository(repositoryPath);
  });
  handleTrustedIpc('repository:impact', async (_, repositoryId: string) => {
    return service.getRepositoryImpact(repositoryId);
  });
  handleTrustedIpc('repository:disconnect', async (_, input: DisconnectRepositoryRequest) => {
    return service.disconnectRepository(input);
  });
  handleTrustedIpc('repository:reconnect', async (_, input: ReconnectRepositoryRequest) => {
    return service.reconnectRepository(input);
  });
  handleTrustedIpc('repository:refresh', async (_, repositoryId: string) => {
    return service.refreshRepository(repositoryId);
  });
  handleTrustedIpc('board:create', async (_, input: CreateBoardRequest) => {
    return service.createBoard(input);
  });
  handleTrustedIpc('board:update', async (_, input: UpdateBoardRequest) => {
    return service.updateBoard(input);
  });
  handleTrustedIpc('board:delete', async (_, boardId: string) => {
    return service.deleteBoard(boardId);
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

  handleTrustedIpc('codex:startRun', async (_, input: StartRunRequest) => {
    return service.startRun(input);
  });

  handleTrustedIpc('codex:steerRun', async (_, input: SteerRunRequest) => {
    return service.steerRun(input);
  });

  handleTrustedIpc('codex:continueRun', async (_, input: ContinueRunRequest) => {
    return service.continueRun(input);
  });

  handleTrustedIpc('codex:retryRun', async (_, input: RetryRunRequest) => {
    return service.retryRun(input);
  });

  handleTrustedIpc('codex:startReview', async (_, input: StartReviewRequest) => {
    return service.startReview(input);
  });

  handleTrustedIpc('agent:syncGoal', async (_, input: SyncAgentGoalRequest) => {
    return service.syncAgentGoal(input);
  });

  handleTrustedIpc('codex:cancelRun', async (_, { runId }: { runId: string }) => {
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

  handleTrustedIpc('preview:resolve', async (_, input: ResolvePreviewRequest) =>
    service.resolvePreview(input)
  );
  handleTrustedIpc(
    'preview:recipe-generation:get',
    async (_, input: GetPreviewRecipeGenerationRequest) =>
      service.getPreviewRecipeGeneration(input)
  );
  handleTrustedIpc(
    'preview:recipe-generation:generate',
    async (_, input: GeneratePreviewRecipeRequest) => service.generatePreviewRecipe(input)
  );
  handleTrustedIpc(
    'preview:recipe-generation:validate',
    async (_, input: ValidatePreviewRecipeDraftRequest) =>
      service.validatePreviewRecipeDraft(input)
  );
  handleTrustedIpc(
    'preview:recipe-generation:accept',
    async (_, input: AcceptPreviewRecipeDraftRequest) =>
      service.acceptPreviewRecipeDraft(input)
  );
  handleTrustedIpc(
    'preview:recipe-generation:discard',
    async (_, input: DiscardPreviewRecipeDraftRequest) =>
      service.discardPreviewRecipeDraft(input)
  );
  handleTrustedIpc('preview:approve', async (_, input: ApprovePreviewPlanRequest) =>
    service.approvePreviewPlan(input)
  );
  handleTrustedIpc('preview:start', async (_, input: StartPreviewRequest) =>
    service.startPreview(input)
  );
  handleTrustedIpc('preview:stop', async (_, input: StopPreviewRequest) =>
    service.stopPreview(input)
  );
  handleTrustedIpc('preview:open', async (_, input: OpenPreviewRequest) =>
    service.openPreview(input)
  );
  handleTrustedIpc('preview:log:read', async (_, input: ReadPreviewLogRequest) =>
    service.readPreviewLog(input)
  );
  handleTrustedIpc('preview:resetData', async (_, input: ResetPreviewDataRequest) =>
    service.resetPreviewData(input)
  );
  handleTrustedIpc('preview:retrySetup', async (_, input: RetryPreviewSetupRequest) =>
    service.retryPreviewSetup(input)
  );
  handleTrustedIpc('preview:binding:set', async (_, input: SetPreviewLocalAttachmentBindingRequest) =>
    service.setPreviewLocalAttachmentBinding(input)
  );
  handleTrustedIpc('preview:binding:delete', async (_, input: DeletePreviewLocalAttachmentBindingRequest) =>
    service.deletePreviewLocalAttachmentBinding(input)
  );
  handleTrustedIpc('preview:private:set', async (_, input: { taskId: string; inputId: string; value: string }) =>
    service.setPreviewPrivateInput(input)
  );
  handleTrustedIpc('preview:private:delete', async (_, input: { taskId: string; inputId: string }) =>
    service.deletePreviewPrivateInput(input)
  );
  handleTrustedIpc('preview:private:retryCleanup', async () => service.retryPreviewPrivateVaultCleanup());
  handleTrustedIpc('preview:private:import', async (_, input: { taskId: string; inputId: string; key: string }) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.key)) return { status: 'FAILED', code: 'INVALID_KEY' };
    const options: OpenDialogOptions = { title: `Import ${input.key}`, properties: ['openFile'] };
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return { status: 'CANCELED' };
    try {
      const selectedPath = selected.filePaths[0];
      const before = await fs.promises.lstat(selectedPath);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PRIVATE_ENV_IMPORT_BYTES || (typeof process.getuid === 'function' && before.uid !== process.getuid()) || (before.mode & 0o077) !== 0) {
        return { status: 'FAILED', code: 'UNSAFE_IMPORT_FILE' };
      }
      const handle = await fs.promises.open(selectedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer | undefined;
      try {
        bytes = await readBoundedFile(handle, MAX_PRIVATE_ENV_IMPORT_BYTES);
        const after = await handle.stat();
        if (
          !after.isFile() ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          (after.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && after.uid !== process.getuid())
        ) {
          return { status: 'FAILED', code: 'UNSAFE_IMPORT_FILE' };
        }
        const parsed = parseSelectedEnvValue(bytes, input.key);
        if (parsed.status !== 'VALUE') {
          const codes = { INVALID_KEY: 'INVALID_KEY', KEY_MISSING: 'KEY_MISSING', KEY_DUPLICATE: 'KEY_DUPLICATE', INVALID_FILE: 'UNSAFE_IMPORT_FILE' } as const;
          return { status: 'FAILED', code: codes[parsed.status] };
        }
        const result = await service.setPreviewPrivateInput({ taskId: input.taskId, inputId: input.inputId, value: parsed.value });
        return result.status === 'STORED' ? { status: 'IMPORTED' } : result;
      } finally {
        bytes?.fill(0);
        await handle.close();
      }
    } catch { return { status: 'FAILED', code: 'UNSAFE_IMPORT_FILE' }; }
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

async function readBoundedFile(handle: fs.promises.FileHandle, maximumBytes: number): Promise<Buffer> {
  const allocation = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  try {
    while (offset < allocation.length) {
      const { bytesRead } = await handle.read(allocation, offset, allocation.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new Error('Selected private input file is too large.');
    return Buffer.from(allocation.subarray(0, offset));
  } finally {
    allocation.fill(0);
  }
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
      openTargetHost: createElectronOpenTargetHost(),
      previewEnabled: true,
      previewRoot: path.join(app.getPath('userData'), 'preview-runtime'),
      previewLauncherPath: resolveNativePreviewLauncherPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      }),
      previewLauncherExecPath: process.execPath,
      previewLauncherEnv: { ELECTRON_RUN_AS_NODE: '1' },
      previewSecretProtector: {
        isAvailable: () => process.platform === 'darwin' && safeStorage.isEncryptionAvailable(),
        encrypt: async (value) => safeStorage.encryptString(value.toString('utf8')),
        decrypt: async (value) => Buffer.from(safeStorage.decryptString(value), 'utf8')
      },
      previewOpenHost: createElectronPreviewUrlHost()
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
