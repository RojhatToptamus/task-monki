import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  powerMonitor,
  safeStorage,
  session,
  shell,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { projectAppUpdateEventForClient } from '../core/app/AppUpdateClientProjection';
import { ApplicationPersistence } from '../core/storage/sqlite/ApplicationPersistence';
import type {
  AcceptPreviewRecipeDraftRequest,
  AddDesignReferencesRequest,
  AppUpdateEvent,
  ContinueRunRequest,
  CreateBlankDesignRequest,
  CancelDesignTurnRequest,
  CancelPromptRefinementRequest,
  CreateBoardRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  DeleteDesignDraftRequest,
  DisconnectRepositoryRequest,
  DeletePreviewLocalAttachmentBindingRequest,
  DiscardPreviewRecipeDraftRequest,
  GeneratePreviewRecipeRequest,
  GetPreviewRecipeGenerationRequest,
  ApprovePreviewPlanRequest,
  GitHubPreflightRequest,
  InspectOpenTargetRequest,
  ImportDesignReferenceAssetRequest,
  OpenPreviewRequest,
  ExecuteOpenTargetActionRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  ReadPreviewLogRequest,
  ReadDesignDraftAttachmentRequest,
  ResetPreviewDataRequest,
  RetryPreviewSetupRequest,
  RestartDesignPreviewRequest,
  RestoreDesignRevisionRequest,
  DuplicateDesignRequest,
  RenameDesignRequest,
  ArchiveDesignRequest,
  ListDesignConversationRequest,
  ResolvePreviewRequest,
  RespondToInteractionRequest,
  RefinePromptRequest,
  RemoveDesignReferenceRequest,
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
  UpdateAgentNativeSessionRequest,
  UpdateAppSettingsRequest,
  StopPreviewRequest,
  SaveDesignDraftRequest,
  SubmitDesignTurnRequest,
  UpdateBoardRequest,
  ValidatePreviewRecipeDraftRequest
} from '../shared/contracts';
import type {
  AppendHumanDiscourseMessageRequest,
  CancelDiscourseAcceptedSendRequest,
  ConfirmDiscourseWaveContextRequest,
  CreateDiscourseConversationRequest,
  DeleteDiscourseConversationRequest,
  DeleteDiscourseDraftRequest,
  GetDiscourseMessageByClientIdRequest,
  ListDiscourseConversationsRequest,
  ListDiscourseMessagesRequest,
  PreviewDiscourseContextRequest,
  RenameDiscourseConversationRequest,
  ResumeDiscourseAcceptedSendRequest,
  SaveDiscourseDraftRequest,
  SendDiscourseMessageRequest,
  SetDiscourseConversationArchivedRequest,
  SetDiscourseConversationReadRequest,
  SetPinnedDiscourseContextRequest,
  StopDiscourseWaveRequest,
  TombstoneDiscourseMessageRequest
} from '../shared/discourse';
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
import { SoftwareUpdateController } from './SoftwareUpdateController';
import {
  resolveManagedDesignStaticServerPath,
  resolveNativePreviewLauncherPath
} from '../core/preview/runtime/launcherPath';
import {
  configureOwnedProcessLauncher,
  resolveOwnedProcessLauncherPath
} from '../core/process/ownedProcess';
import { parseSelectedEnvValue } from '../core/preview/private/PreviewEnvImport';
import { resolveDesignSkillPackRoot } from '../core/design/DesignSkillPack';
import { resolveDesignToolMcpServerPath } from '../core/design/DesignClientToolBridge';
import {
  resolveDesignBrowserRuntimePaths,
  resolveDesignBrowserSocketRoot
} from '../core/design/AgentBrowserRuntimePath';
import { createElectronPreviewUrlHost } from './previewOpenHost';
import {
  createRendererTrustPolicy,
  isSafeExternalUrl,
  isTrustedIpcInvokeEvent,
  isTrustedRendererPermissionRequest,
  type RendererTrustPolicy
} from './rendererTrust';
import {
  IPC_UPDATE_CHANNEL,
  IPC_SOFTWARE_UPDATE_CHANNEL,
  IPC_WINDOW_CHROME_CHANNEL,
  type IpcInvokeChannel
} from '../shared/ipcChannels';
import type {
  DesignCanvasHostEvent,
  DesignCanvasRuntime
} from './DesignCanvasHost';
import { DesignCanvasHost } from './DesignCanvasHost';
import type {
  ApproveDesignCanvasExternalRequest,
  HideDesignCanvasRequest,
  RefreshDesignCanvasRequest,
  ShowDesignCanvasRequest
} from '../shared/designCanvas';
const MAX_PRIVATE_ENV_IMPORT_BYTES = 256 * 1024;

let mainWindow: BrowserWindow | undefined;
let service: TaskManagerService;
let persistence: ApplicationPersistence | undefined;
let designCanvasHost: DesignCanvasHost | undefined;
let softwareUpdateController: SoftwareUpdateController | undefined;
let serviceCreated = false;
let ipcHandlersInstalled = false;
let quitAfterShutdown = false;
let shutdownPromise: Promise<void> | undefined;
let restartToInstallUpdate = false;
let operatingSystemSessionEnding = false;
let autoInstallUpdatesOnQuit = true;
let rendererTrustPolicy: RendererTrustPolicy | undefined;
const attachmentIpcGate = new AttachmentIpcOperationGate();

const appId = 'dev.taskmonki.desktop';
const safeStorageVerificationName =
  process.env.TASK_MONKI_SAFE_STORAGE_VERIFICATION_NAME;
if (safeStorageVerificationName) {
  const isPackagedVerification =
    app.isPackaged &&
    process.argv.some((argument) =>
      argument.startsWith('--remote-debugging-port=')
    ) &&
    /^task-monki-safe-storage-verifier-[0-9a-f-]{36}$/u.test(
      safeStorageVerificationName
    );
  if (!isPackagedVerification) {
    throw new Error('Invalid packaged safeStorage verification identity.');
  }
  app.setName(safeStorageVerificationName);
}
const ownsSingleInstanceLock = app.requestSingleInstanceLock();

if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (shutdownPromise) {
      return;
    }
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
  designCanvasHost?.attachWindow(window as never);
  window.once('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined;
      rendererTrustPolicy = undefined;
    }
  });
  if (process.platform === 'win32') {
    window.on('session-end', () => {
      operatingSystemSessionEnding = true;
    });
  }

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
    isPackaged: app.isPackaged
  });
  if (iconPath !== undefined && fs.existsSync(iconPath)) {
    app.dock?.setIcon(iconPath);
  }
}

function installIpcHandlers(): void {
  ipcMain.on(IPC_WINDOW_CHROME_CHANNEL, (event: IpcMainEvent) => {
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
  handleTrustedIpc('agent:runtimeCatalog', () => service.getAgentRuntimeCatalog());
  handleTrustedIpc('agent:discoverRuntimeModels', async (_, runtimeId: string) =>
    service.discoverAgentRuntimeModels(runtimeId)
  );
  handleTrustedIpc(
    'agent:updateNativeSession',
    async (_, input: UpdateAgentNativeSessionRequest) => {
      return service.updateAgentNativeSession(input);
    }
  );
  handleTrustedIpc('settings:get', () => service.getAppSettings());
  handleTrustedIpc('settings:update', async (_, input: UpdateAppSettingsRequest) => {
    const settings = await service.updateAppSettings(input);
    autoInstallUpdatesOnQuit = settings.autoInstallUpdatesOnQuit;
    return settings;
  });
  handleTrustedIpc('softwareUpdate:get', () => requireSoftwareUpdateController().getState());
  handleTrustedIpc('softwareUpdate:check', () =>
    requireSoftwareUpdateController().checkForUpdates()
  );
  handleTrustedIpc('softwareUpdate:download', () =>
    requireSoftwareUpdateController().downloadUpdate()
  );
  handleTrustedIpc('softwareUpdate:install', async () => {
    if (!requireSoftwareUpdateController().hasDownloadedUpdate()) {
      throw new Error('No downloaded update is ready to install.');
    }
    restartToInstallUpdate = true;
    await beginApplicationShutdown();
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

  handleTrustedIpc('task:getBoardSnapshot', async () => {
    return service.getBoardSnapshot();
  });
  handleTrustedIpc('task:getDetail', async (_, taskId: string) => {
    return service.getTaskDetail(taskId);
  });
  handleTrustedIpc('design:list', () => service.listDesigns());
  handleTrustedIpc('design:get', async (_, designId: string) =>
    service.getDesign(designId)
  );
  handleTrustedIpc(
    'design:conversation:list',
    async (_, input: ListDesignConversationRequest) =>
      service.listDesignConversation(input)
  );
  handleTrustedIpc('design:draft:get', async (_, designId: string) =>
    service.getDesignDraft(designId)
  );
  handleTrustedIpc(
    'design:draft:attachment:read',
    async (_, input: ReadDesignDraftAttachmentRequest) =>
      service.readDesignDraftAttachment(input)
  );
  handleTrustedIpc(
    'design:draft:save',
    async (_, input: SaveDesignDraftRequest) => service.saveDesignDraft(input)
  );
  handleTrustedIpc(
    'design:draft:delete',
    async (_, input: DeleteDesignDraftRequest) => service.deleteDesignDraft(input)
  );
  handleTrustedIpc(
    'design:create',
    async (_, input: CreateBlankDesignRequest) => service.createBlankDesign(input)
  );
  handleTrustedIpc(
    'design:turn:submit',
    async (_, input: SubmitDesignTurnRequest) => service.submitDesignTurn(input)
  );
  handleTrustedIpc(
    'design:reference:add',
    async (_, input: AddDesignReferencesRequest) => service.addDesignReferences(input)
  );
  handleTrustedIpc(
    'design:reference:remove',
    async (_, input: RemoveDesignReferenceRequest) =>
      service.removeDesignReference(input)
  );
  handleTrustedIpc(
    'design:reference:import-asset',
    async (_, input: ImportDesignReferenceAssetRequest) =>
      service.importDesignReferenceAsset(input)
  );
  handleTrustedIpc(
    'design:turn:cancel',
    async (_, input: CancelDesignTurnRequest) => service.cancelDesignTurn(input)
  );
  handleTrustedIpc(
    'design:preview:restart',
    async (_, input: RestartDesignPreviewRequest) =>
      service.restartDesignPreview(input)
  );
  handleTrustedIpc(
    'design:revision:restore',
    async (_, input: RestoreDesignRevisionRequest) =>
      service.restoreDesignRevision(input)
  );
  handleTrustedIpc(
    'design:duplicate',
    async (_, input: DuplicateDesignRequest) => service.duplicateDesign(input)
  );
  handleTrustedIpc(
    'design:rename',
    async (_, input: RenameDesignRequest) => service.renameDesign(input)
  );
  handleTrustedIpc(
    'design:archive',
    async (_, input: ArchiveDesignRequest) => service.archiveDesign(input)
  );
  handleTrustedIpc(
    'design:canvas:show',
    async (_, input: ShowDesignCanvasRequest) => {
      if (input.designId !== input.taskId) {
        throw new Error('The Design canvas task identity does not match the Design.');
      }
      return requireDesignCanvasHost().show(input);
    }
  );
  handleTrustedIpc(
    'design:canvas:hide',
    async (_, input: HideDesignCanvasRequest) => {
      if (shutdownPromise) return;
      requireDesignCanvasHost().hide(input);
    }
  );
  handleTrustedIpc(
    'design:canvas:refresh',
    async (_, input: RefreshDesignCanvasRequest) =>
      requireDesignCanvasHost().refresh(input)
  );
  handleTrustedIpc(
    'design:canvas:approve-external',
    async (_, input: ApproveDesignCanvasExternalRequest) =>
      requireDesignCanvasHost().approveExternal(input)
  );

  handleTrustedIpc(
    'discourse:conversations:list',
    async (_, input: ListDiscourseConversationsRequest = {}) =>
      service.listDiscourseConversations(input)
  );
  handleTrustedIpc('discourse:conversation:get', async (_, conversationId: string) =>
    service.getDiscourseConversation(conversationId)
  );
  handleTrustedIpc('discourse:messages:list', async (_, input: ListDiscourseMessagesRequest) =>
    service.listDiscourseMessages(input)
  );
  handleTrustedIpc(
    'discourse:message:get-by-client-id',
    async (_, input: GetDiscourseMessageByClientIdRequest) =>
      service.getDiscourseMessageByClientId(input)
  );
  handleTrustedIpc('discourse:mentions:get', () => service.getDiscourseMentionCatalog());
  handleTrustedIpc(
    'discourse:conversation:create',
    async (_, input: CreateDiscourseConversationRequest) =>
      service.createDiscourseConversation(input)
  );
  handleTrustedIpc(
    'discourse:message:append',
    async (_, input: AppendHumanDiscourseMessageRequest) =>
      service.appendHumanDiscourseMessage(input)
  );
  handleTrustedIpc(
    'discourse:message:send',
    async (_, input: SendDiscourseMessageRequest) => service.sendDiscourseMessage(input)
  );
  handleTrustedIpc(
    'discourse:message:resume',
    async (_, input: ResumeDiscourseAcceptedSendRequest) =>
      service.resumeDiscourseAcceptedSend(input)
  );
  handleTrustedIpc(
    'discourse:message:cancel-response',
    async (_, input: CancelDiscourseAcceptedSendRequest) =>
      service.cancelDiscourseAcceptedSend(input)
  );
  handleTrustedIpc(
    'discourse:message:tombstone',
    async (_, input: TombstoneDiscourseMessageRequest) =>
      service.tombstoneDiscourseMessage(input)
  );
  handleTrustedIpc(
    'discourse:context:pin',
    async (_, input: SetPinnedDiscourseContextRequest) =>
      service.setPinnedDiscourseContext(input)
  );
  handleTrustedIpc(
    'discourse:context:preview',
    async (_, input: PreviewDiscourseContextRequest) =>
      service.previewDiscourseContext(input)
  );
  handleTrustedIpc('discourse:draft:save', async (_, input: SaveDiscourseDraftRequest) =>
    service.saveDiscourseDraft(input)
  );
  handleTrustedIpc('discourse:draft:get', async (_, draftId: string) =>
    service.getDiscourseDraft(draftId)
  );
  handleTrustedIpc('discourse:drafts:list', () => service.listDiscourseDrafts());
  handleTrustedIpc('discourse:draft:delete', async (_, input: DeleteDiscourseDraftRequest) =>
    service.deleteDiscourseDraft(input)
  );
  handleTrustedIpc(
    'discourse:conversation:rename',
    async (_, input: RenameDiscourseConversationRequest) =>
      service.renameDiscourseConversation(input)
  );
  handleTrustedIpc(
    'discourse:conversation:read',
    async (_, input: SetDiscourseConversationReadRequest) =>
      service.setDiscourseConversationRead(input)
  );
  handleTrustedIpc(
    'discourse:conversation:archive',
    async (_, input: SetDiscourseConversationArchivedRequest) =>
      service.setDiscourseConversationArchived(input)
  );
  handleTrustedIpc(
    'discourse:conversation:delete',
    async (_, input: DeleteDiscourseConversationRequest) =>
      service.deleteDiscourseConversation(input)
  );
  handleTrustedIpc(
    'discourse:wave:stop',
    async (_, input: StopDiscourseWaveRequest) => service.stopDiscourseWave(input)
  );
  handleTrustedIpc(
    'discourse:wave:confirm-context',
    async (_, input: ConfirmDiscourseWaveContextRequest) =>
      service.confirmDiscourseWaveContext(input)
  );

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
      scope: { kind: 'TASK', taskId: task.id },
      taskId: task.id,
      payload: task,
      at: new Date().toISOString()
    });
    return task;
  });

  handleTrustedIpc('prompt:refine', async (_, input: RefinePromptRequest) => {
    return service.refinePrompt(input);
  });

  handleTrustedIpc(
    'prompt:refine:cancel',
    async (_, input: CancelPromptRefinementRequest) => {
      return service.cancelPromptRefinement(input);
    }
  );

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
  channel: IpcInvokeChannel,
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
  mainWindow?.webContents.send(
    IPC_UPDATE_CHANNEL,
    projectAppUpdateEventForClient(event)
  );
}

function broadcastSoftwareUpdate(state: import('../shared/softwareUpdate').SoftwareUpdateState): void {
  mainWindow?.webContents.send(IPC_SOFTWARE_UPDATE_CHANNEL, state);
}

function requireSoftwareUpdateController(): SoftwareUpdateController {
  if (!softwareUpdateController) {
    throw new Error('Software updates are not initialized.');
  }
  return softwareUpdateController;
}

function requireDesignCanvasHost(): DesignCanvasHost {
  if (shutdownPromise) {
    throw new Error('The Design canvas is shutting down.');
  }
  if (!designCanvasHost) {
    throw new Error('The Design canvas is available in the macOS desktop app.');
  }
  return designCanvasHost;
}

function createDesignCanvasRuntime(): DesignCanvasRuntime {
  return {
    sessionForPartition: (partition) => session.fromPartition(partition) as never,
    createView: ({ webPreferences }) => {
      const { session: targetSession, ...preferences } = webPreferences;
      return new WebContentsView({
        webPreferences: {
          ...preferences,
          session: targetSession as never
        }
      }) as never;
    },
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now()
  };
}

function broadcastDesignCanvasEvent(event: DesignCanvasHostEvent): void {
  broadcast({
    type: 'design.updated',
    scope: { kind: 'DESIGN', designId: event.designId },
    taskId: event.designId,
    previewGenerationId:
      event.type === 'load-failed' ? event.generationId : undefined,
    payload: { reason: event.type, canvasEvent: event },
    at: new Date().toISOString()
  });
}

function previewGenerationUnavailable(event: AppUpdateEvent): string | undefined {
  if (
    event.type !== 'preview.updated' ||
    !event.previewGenerationId ||
    !event.payload ||
    typeof event.payload !== 'object'
  ) {
    return;
  }
  const state = (event.payload as { state?: unknown }).state;
  return [
    'STOPPING',
    'STOPPED',
    'FAILED',
    'RECOVERY_REQUIRED',
    'CLEANUP_INCOMPLETE'
  ].includes(String(state))
    ? event.previewGenerationId
    : undefined;
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

function beginApplicationShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = service
    .shutdown()
    .catch((error: unknown) => {
      console.error('Failed to shut down the agent runtimes cleanly.', error);
    })
    .then(() => designCanvasHost?.shutdown())
    .catch((error: unknown) => {
      console.error('Failed to shut down the Design canvas cleanly.', error);
    })
    .then(() => persistence?.close())
    .catch((error: unknown) => {
      console.error('Failed to close application persistence cleanly.', error);
    })
    .then(() => {
      quitAfterShutdown = true;
      softwareUpdateController?.dispose();
      const installUpdate =
        softwareUpdateController?.hasDownloadedUpdate() &&
        !operatingSystemSessionEnding &&
        (restartToInstallUpdate || autoInstallUpdatesOnQuit);
      if (installUpdate) {
        try {
          softwareUpdateController!.installUpdate(restartToInstallUpdate);
          return;
        } catch (error) {
          console.error('Task Monki could not start the update installer.', error);
        }
      }
      app.quit();
    });
  return shutdownPromise;
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
  configureOwnedProcessLauncher({
    launcherPath: resolveOwnedProcessLauncherPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    }),
    launcherExecutable: process.execPath,
    launcherEnvironment: { ELECTRON_RUN_AS_NODE: '1' }
  });
  if (process.platform === 'darwin') {
    designCanvasHost = new DesignCanvasHost({
      runtime: createDesignCanvasRuntime(),
      resolveRoute: (identity) => service.resolveDesignCanvasRoute(identity),
      emit: broadcastDesignCanvasEvent
    });
  }
  const designBrowserPaths = designCanvasHost
    ? resolveDesignBrowserRuntimePaths({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      })
    : undefined;
  persistence = await ApplicationPersistence.open({
    profileRoot: userDataDir,
    appVersion: app.getVersion(),
    previewSecretProtector: {
      isAvailable: () =>
        process.platform === 'darwin' && safeStorage.isEncryptionAvailable(),
      encrypt: async (value) => safeStorage.encryptString(value.toString('utf8')),
      decrypt: async (value) =>
        Buffer.from(safeStorage.decryptString(value), 'utf8')
    }
  });
  service = new TaskManagerService(
    persistence.tasks,
    defaultRepositoryPath,
    undefined,
    {
      agentCwd: defaultRepositoryPath || app.getPath('home'),
      appSettingsStore: persistence.settings,
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
      managedDesignStaticServerPath: resolveManagedDesignStaticServerPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      }),
      designSkillRoot: resolveDesignSkillPackRoot({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      }),
      previewPrivateVault: persistence.previewPrivateVault,
      previewOpenHost: createElectronPreviewUrlHost(),
      agentRuntimeStore: persistence.agentRuntime,
      taskRuntimeAccess: persistence.taskRuntime,
      discourseStore: persistence.discourse,
      discourseWorkspaceRoot: path.join(userDataDir, 'discourse-workspaces'),
      ...(designCanvasHost
        ? {
            designRepositoryRoot: persistence.paths.designRepositoryRoot,
            designWorktreeRoot: persistence.paths.designWorktreeRoot,
            designDraftStore: persistence.designDrafts,
            designBrowserExecutablePath: designBrowserPaths!.executablePath,
            designBrowserChromeExecutablePath:
              designBrowserPaths!.browserExecutablePath,
            designBrowserScratchRoot: path.join(
              userDataDir,
              'design-browser-runtime'
            ),
            designBrowserSocketRoot: resolveDesignBrowserSocketRoot(userDataDir),
            designBrowserRequireCodeSignature: app.isPackaged,
            designToolMcpExecutablePath: process.execPath,
            designToolMcpServerPath: resolveDesignToolMcpServerPath({
              isPackaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
              appPath: app.getAppPath()
            }),
            designToolCredentialRoot: path.join(
              userDataDir,
              'design-tool-credentials'
            ),
            designCanvasFence: designCanvasHost
          }
        : {})
    }
  );
  serviceCreated = true;
  await service.init();
  if (shutdownPromise) {
    return;
  }
  const settings = await service.getAppSettings();
  autoInstallUpdatesOnQuit = settings.autoInstallUpdatesOnQuit;
  softwareUpdateController = new SoftwareUpdateController(
    autoUpdater,
    app.isPackaged && autoUpdater.isUpdaterActive(),
    app.getVersion(),
    broadcastSoftwareUpdate
  );
  powerMonitor.on('shutdown', () => {
    operatingSystemSessionEnding = true;
  });
  service.events.on((event) => {
    const unavailableGenerationId = previewGenerationUnavailable(event);
    if (unavailableGenerationId) {
      designCanvasHost?.handleGenerationUnavailable(unavailableGenerationId);
    }
    if (event.type === 'task.deleted' && event.scope.kind === 'DESIGN') {
      void designCanvasHost?.close(event.scope.designId).catch((error: unknown) => {
        console.error('Task Monki could not close the deleted Design canvas.', error);
      });
    }
    broadcast(event);
  });
  installIpcHandlers();
  createWindow();
  softwareUpdateController.start();
}).catch(async (error: unknown) => {
  console.error('Task Monki failed to initialize its trusted local services.', error);
  if (serviceCreated) {
    await service.shutdown().catch((shutdownError: unknown) => {
      console.error('Failed to shut down after application startup failed.', shutdownError);
    });
  }
  await designCanvasHost?.shutdown().catch((shutdownError: unknown) => {
    console.error('Failed to close the Design canvas after startup failed.', shutdownError);
  });
  await persistence?.close().catch((shutdownError: unknown) => {
    console.error('Failed to close persistence after startup failed.', shutdownError);
  });
  quitAfterShutdown = true;
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
  void beginApplicationShutdown();
});

app.on('activate', () => {
  if (
    ownsSingleInstanceLock &&
    shouldCreateWindowOnActivate({
      ipcHandlersInstalled,
      openWindowCount: BrowserWindow.getAllWindows().length,
      shuttingDown: shutdownPromise !== undefined
    })
  ) {
    createWindow();
  }
});
