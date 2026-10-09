import { contextBridge, ipcRenderer } from 'electron';
import type {
  AcceptPreviewRecipeDraftRequest,
  AddDesignReferencesRequest,
  AppUpdateEvent,
  CancelRunRequest,
  CancelDesignTurnRequest,
  ContinueRunRequest,
  CreateDesignRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  ImportTaskRequest,
  PreviewImportRequest,
  ReconnectWorktreeRequest,
  UpdateWorktreeComparisonRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  DeleteDesignDraftRequest,
  DiscardPreviewRecipeDraftRequest,
  ExecuteOpenTargetActionRequest,
  GitHubPreflightRequest,
  SendPreviewAgentMessageRequest,
  StopPreviewAgentRequest,
  GetPreviewRecipeGenerationRequest,
  InspectOpenTargetRequest,
  ImportDesignReferenceAssetRequest,
  PrepareWorktreeRequest,
  InspectWorktreePreparationRequest,
  OpenPreviewRequest,
  PublishBranchRequest,
  ReadArtifactRequest,
  ReadDesignDraftAttachmentRequest,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RespondToInteractionRequest,
  CancelPromptRefinementRequest,
  RefinePromptRequest,
  RemoveDesignReferenceRequest,
  StartRunRequest,
  StartReviewRequest,
  QueueTaskInstructionRequest,
  EditTaskInstructionRequest,
  SendTaskInstructionRequest,
  SaveTaskAgentDraftRequest,
  SaveTaskPromptRequest,
  SteerRunRequest,
  RetryRunRequest,
  RestartDesignPreviewRequest,
  RestoreDesignRevisionRequest,
  DuplicateDesignRequest,
  RenameDesignRequest,
  ArchiveDesignRequest,
  ListDesignConversationRequest,
  SaveDesignDraftRequest,
  SubmitDesignTurnRequest,
  SyncAgentGoalRequest,
  ReadProtocolMessageRequest,
  TestExternalToolRequest,
  TaskManagerApi,
  TransitionTaskRequest,
  UpdateAgentNativeSessionRequest,
  UpdateAppSettingsRequest,
  ValidatePreviewRecipeDraftRequest
} from '../shared/contracts';
import {
  ATTACHMENT_MAX_IMAGE_BYTES,
  type DiscardTaskAttachmentDraftRequest,
  type ReadTaskAttachmentRequest,
  type StageTaskAttachmentBatchRequest,
} from '../shared/attachments';
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
  AttachmentIpcOperationGate,
  assertAttachmentIpcBatch,
} from './attachmentIpcSecurity';
import type { TaskManagerShellApi, WindowChromePlatform } from '../shared/shell';
import type { SoftwareUpdateState } from '../shared/softwareUpdate';
import type { DesignCanvasApi } from '../shared/designCanvas';
import {
  IPC_UPDATE_CHANNEL,
  IPC_SOFTWARE_UPDATE_CHANNEL,
  IPC_WINDOW_CHROME_CHANNEL,
  type IpcInvokeChannel
} from '../shared/ipcChannels';

function invokeIpc(channel: IpcInvokeChannel, ...args: unknown[]): Promise<any> {
  return ipcRenderer.invoke(channel, ...args);
}

function getWindowChromePlatform(): WindowChromePlatform {
  if (process.platform === 'darwin') {
    return 'macos';
  }
  if (process.platform === 'win32') {
    return 'windows';
  }
  if (process.platform === 'linux') {
    return 'linux';
  }
  return 'other';
}

const attachmentIpcClientGate = new AttachmentIpcOperationGate();

const api: TaskManagerApi = {
  listApplicationPreviews: () => invokeIpc('application:listApplicationPreviews'),
  getApplicationPreview: input => invokeIpc('application:getApplicationPreview', input),
  connectApplicationPreviewSource: input => invokeIpc('application:connectApplicationPreviewSource', input),
  inspectApplicationPreviewSetup: input => invokeIpc('application:inspectApplicationPreviewSetup', input),
  readApplicationPreviewFile: input => invokeIpc('application:readApplicationPreviewFile', input),
  saveApplicationPreviewFile: input => invokeIpc('application:saveApplicationPreviewFile', input),
  chooseApplicationPreviewFile: input => invokeIpc('application:chooseApplicationPreviewFile', input),
  startRetainedApplicationPreview: input => invokeIpc('application:startRetainedApplicationPreview', input),
  startApplicationPreview: input => invokeIpc('application:startApplicationPreview', input),
  approveApplicationPreview: input => invokeIpc('application:approveApplicationPreview', input),
  stopApplicationPreview: input => invokeIpc('application:stopApplicationPreview', input),
  cancelApplicationPreview: input => invokeIpc('application:cancelApplicationPreview', input),
  openApplicationPreview: input => invokeIpc('application:openApplicationPreview', input),
  readApplicationPreviewLogs: input => invokeIpc('application:readApplicationPreviewLogs', input),
  inspectApplicationPreviewConfiguration: input => invokeIpc('application:inspectApplicationPreviewConfiguration', input),
  rerunApplicationPreviewJob: input => invokeIpc('application:rerunApplicationPreviewJob', input),
  deleteApplicationPreviewData: input => invokeIpc('application:deleteApplicationPreviewData', input),

  chooseRepositoryFolder: () => invokeIpc('repository:chooseFolder'),
  addRepository: (path) => invokeIpc('repository:add', path),
  getRepositoryImpact: (repositoryId) =>
    invokeIpc('repository:impact', repositoryId),
  disconnectRepository: (input) => invokeIpc('repository:disconnect', input),
  reconnectRepository: (input) => invokeIpc('repository:reconnect', input),
  refreshRepository: (repositoryId) =>
    invokeIpc('repository:refresh', repositoryId),
  createBoard: (input) => invokeIpc('board:create', input),
  updateBoard: (input) => invokeIpc('board:update', input),
  deleteBoard: (boardId) => invokeIpc('board:delete', boardId),
  saveAgentProfile: (input) => invokeIpc('profile:save', input),
  deleteAgentProfile: (profileId) => invokeIpc('profile:delete', profileId),
  getAppSettings: () => invokeIpc('settings:get'),
  updateAppSettings: (input: UpdateAppSettingsRequest) =>
    invokeIpc('settings:update', input),
  getExternalToolStatus: () => invokeIpc('settings:tools:status'),
  testExternalTool: (input: TestExternalToolRequest) =>
    invokeIpc('settings:tools:test', input),
  inspectOpenTarget: (input: InspectOpenTargetRequest) =>
    invokeIpc('openTarget:inspect', input),
  executeOpenTargetAction: (input: ExecuteOpenTargetActionRequest) =>
    invokeIpc('openTarget:execute', input),
  getAgentRuntimeCatalog: () => invokeIpc('agent:runtimeCatalog'),
  discoverAgentRuntimeModels: (runtimeId) =>
    invokeIpc('agent:discoverRuntimeModels', runtimeId),
  updateAgentNativeSession: (input: UpdateAgentNativeSessionRequest) =>
    invokeIpc('agent:updateNativeSession', input),
  getBoardSnapshot: () => invokeIpc('task:getBoardSnapshot'),
  getTaskDetail: (taskId) => invokeIpc('task:getDetail', taskId),
  listDiscourseConversations: (input?: ListDiscourseConversationsRequest) =>
    invokeIpc('discourse:conversations:list', input),
  getDiscourseConversation: (conversationId: string) =>
    invokeIpc('discourse:conversation:get', conversationId),
  listDiscourseMessages: (input: ListDiscourseMessagesRequest) =>
    invokeIpc('discourse:messages:list', input),
  getDiscourseMessageByClientId: (input: GetDiscourseMessageByClientIdRequest) =>
    invokeIpc('discourse:message:get-by-client-id', input),
  getDiscourseMentionCatalog: () => invokeIpc('discourse:mentions:get'),
  createDiscourseConversation: (input: CreateDiscourseConversationRequest) =>
    invokeIpc('discourse:conversation:create', input),
  appendHumanDiscourseMessage: (input: AppendHumanDiscourseMessageRequest) =>
    invokeIpc('discourse:message:append', input),
  sendDiscourseMessage: (input: SendDiscourseMessageRequest) =>
    invokeIpc('discourse:message:send', input),
  resumeDiscourseAcceptedSend: (input: ResumeDiscourseAcceptedSendRequest) =>
    invokeIpc('discourse:message:resume', input),
  cancelDiscourseAcceptedSend: (input: CancelDiscourseAcceptedSendRequest) =>
    invokeIpc('discourse:message:cancel-response', input),
  tombstoneDiscourseMessage: (input: TombstoneDiscourseMessageRequest) =>
    invokeIpc('discourse:message:tombstone', input),
  setPinnedDiscourseContext: (input: SetPinnedDiscourseContextRequest) =>
    invokeIpc('discourse:context:pin', input),
  previewDiscourseContext: (input: PreviewDiscourseContextRequest) =>
    invokeIpc('discourse:context:preview', input),
  saveDiscourseDraft: (input: SaveDiscourseDraftRequest) =>
    invokeIpc('discourse:draft:save', input),
  getDiscourseDraft: (draftId: string) =>
    invokeIpc('discourse:draft:get', draftId),
  listDiscourseDrafts: () => invokeIpc('discourse:drafts:list'),
  deleteDiscourseDraft: (input: DeleteDiscourseDraftRequest) =>
    invokeIpc('discourse:draft:delete', input),
  renameDiscourseConversation: (input: RenameDiscourseConversationRequest) =>
    invokeIpc('discourse:conversation:rename', input),
  setDiscourseConversationRead: (input: SetDiscourseConversationReadRequest) =>
    invokeIpc('discourse:conversation:read', input),
  setDiscourseConversationArchived: (input: SetDiscourseConversationArchivedRequest) =>
    invokeIpc('discourse:conversation:archive', input),
  deleteDiscourseConversation: (input: DeleteDiscourseConversationRequest) =>
    invokeIpc('discourse:conversation:delete', input),
  stopDiscourseWave: (input: StopDiscourseWaveRequest) =>
    invokeIpc('discourse:wave:stop', input),
  confirmDiscourseWaveContext: (input: ConfirmDiscourseWaveContextRequest) =>
    invokeIpc('discourse:wave:confirm-context', input),
  stageTaskAttachmentBatch: async (input: StageTaskAttachmentBatchRequest) => {
    const byteCount = assertAttachmentIpcBatch(input);
    return attachmentIpcClientGate.run(byteCount, () =>
      invokeIpc('attachment:stage-batch', input)
    );
  },
  discardTaskAttachmentDraft: (input: DiscardTaskAttachmentDraftRequest) =>
    invokeIpc('attachment:draft:discard', input),
  getAttachmentDraft: (draftId: string) => invokeIpc('attachment:draft:get', draftId),
  readTaskAttachment: (input: ReadTaskAttachmentRequest) =>
    attachmentIpcClientGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () =>
      invokeIpc('attachment:read', input)
    ),
  readDesignDraftAttachment: (input: ReadDesignDraftAttachmentRequest) =>
    attachmentIpcClientGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () =>
      invokeIpc('design:draft:attachment:read', input)
    ),
  readClipboardImage: () =>
    attachmentIpcClientGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () =>
      invokeIpc('attachment:clipboard:readImage')
    ),
  createTask: (input: CreateTaskRequest) => invokeIpc('task:create', input),
  importTask: (input: ImportTaskRequest) => invokeIpc('task:import', input),
  previewImport: (input: PreviewImportRequest) => invokeIpc('task:importPreview', input),
  listExistingWorktrees: (repositoryId: string) => invokeIpc('worktree:list', repositoryId),
  reconnectWorktree: (input: ReconnectWorktreeRequest) => invokeIpc('worktree:reconnect', input),
  updateWorktreeComparison: (input: UpdateWorktreeComparisonRequest) => invokeIpc('worktree:comparison', input),
  listDesigns: () => invokeIpc('design:list'),
  getDesign: (designId: string) => invokeIpc('design:get', designId),
  listDesignConversation: (input: ListDesignConversationRequest) =>
    invokeIpc('design:conversation:list', input),
  getDesignDraft: (designId: string) => invokeIpc('design:draft:get', designId),
  saveDesignDraft: (input: SaveDesignDraftRequest) =>
    invokeIpc('design:draft:save', input),
  deleteDesignDraft: (input: DeleteDesignDraftRequest) =>
    invokeIpc('design:draft:delete', input),
  inspectDesignRepository: (input: import('../shared/design').InspectDesignRepositoryRequest) => invokeIpc('design:repository:inspect', input),
  updateDesignPreviewTarget: (input: import('../shared/design').UpdateDesignPreviewTargetRequest) => invokeIpc('design:target:update', input),
  startDesign: (input: import('../shared/design').StartDesignRequest) => invokeIpc('design:start', input),
  createDesign: (input: CreateDesignRequest) =>
    invokeIpc('design:create', input),
  submitDesignTurn: (input: SubmitDesignTurnRequest) =>
    invokeIpc('design:turn:submit', input),
  addDesignReferences: (input: AddDesignReferencesRequest) =>
    invokeIpc('design:reference:add', input),
  removeDesignReference: (input: RemoveDesignReferenceRequest) =>
    invokeIpc('design:reference:remove', input),
  importDesignReferenceAsset: (input: ImportDesignReferenceAssetRequest) =>
    invokeIpc('design:reference:import-asset', input),
  cancelDesignTurn: (input: CancelDesignTurnRequest) =>
    invokeIpc('design:turn:cancel', input),
  restartDesignPreview: (input: RestartDesignPreviewRequest) =>
    invokeIpc('design:preview:restart', input),
  restoreDesignRevision: (input: RestoreDesignRevisionRequest) =>
    invokeIpc('design:revision:restore', input),
  duplicateDesign: (input: DuplicateDesignRequest) =>
    invokeIpc('design:duplicate', input),
  renameDesign: (input: RenameDesignRequest) =>
    invokeIpc('design:rename', input),
  archiveDesign: (input: ArchiveDesignRequest) =>
    invokeIpc('design:archive', input),
  refinePrompt: (input: RefinePromptRequest) => invokeIpc('prompt:refine', input),
  cancelPromptRefinement: (input: CancelPromptRefinementRequest) =>
    invokeIpc('prompt:refine:cancel', input),
  prepareWorktree: (input: PrepareWorktreeRequest) => invokeIpc('worktree:prepare', input),
  inspectWorktreePreparation: (input: InspectWorktreePreparationRequest) =>
    invokeIpc('worktree:inspectPreparation', input),
  startRun: (input: StartRunRequest) => invokeIpc('agent:startRun', input),
  queueTaskInstruction: (input: QueueTaskInstructionRequest) => invokeIpc('agent:queueTaskInstruction', input),
  editTaskInstruction: (input: EditTaskInstructionRequest) => invokeIpc('agent:editTaskInstruction', input),
  sendTaskInstruction: (input: SendTaskInstructionRequest) => invokeIpc('agent:sendTaskInstruction', input),
  saveTaskPrompt: (input: SaveTaskPromptRequest) => invokeIpc('task:savePrompt', input),
  saveTaskAgentDraft: (input: SaveTaskAgentDraftRequest) => invokeIpc('agent:saveTaskAgentDraft', input),
  steerRun: (input: SteerRunRequest) => invokeIpc('agent:steerRun', input),
  continueRun: (input: ContinueRunRequest) =>
    invokeIpc('agent:continueRun', input),
  retryRun: (input: RetryRunRequest) => invokeIpc('agent:retryRun', input),
  startReview: (input: StartReviewRequest) =>
    invokeIpc('agent:startReview', input),
  syncAgentGoal: (input: SyncAgentGoalRequest) =>
    invokeIpc('agent:syncGoal', input),
  cancelRun: (input: CancelRunRequest) => invokeIpc('agent:cancelRun', input),
  respondToInteraction: (input: RespondToInteractionRequest) =>
    invokeIpc('agent:respondToInteraction', input),
  refreshEvidence: (input: RefreshEvidenceRequest) => invokeIpc('evidence:refresh', input),
  createDeliveryCommit: (input: CreateDeliveryCommitRequest) =>
    invokeIpc('git:deliveryCommit', input),
  preflightGitHub: (input: GitHubPreflightRequest) => invokeIpc('github:preflight', input),
  publishBranch: (input: PublishBranchRequest) => invokeIpc('github:publish', input),
  createPullRequest: (input: CreatePullRequestRequest) =>
    invokeIpc('github:createPullRequest', input),
  refreshGitHub: (input: RefreshGitHubRequest) => invokeIpc('github:refresh', input),
  getPreviewRecipeGeneration: (input: GetPreviewRecipeGenerationRequest) =>
    invokeIpc('preview:recipe-generation:get', input),
  sendPreviewAgentMessage: (input: SendPreviewAgentMessageRequest) =>
    invokeIpc('preview:agent:send', input),
  stopPreviewAgent: (input: StopPreviewAgentRequest) => invokeIpc('preview:agent:stop', input),
  validatePreviewRecipeDraft: (input: ValidatePreviewRecipeDraftRequest) =>
    invokeIpc('preview:recipe-generation:validate', input),
  acceptPreviewRecipeDraft: (input: AcceptPreviewRecipeDraftRequest) =>
    invokeIpc('preview:recipe-generation:accept', input),
  discardPreviewRecipeDraft: (input: DiscardPreviewRecipeDraftRequest) =>
    invokeIpc('preview:recipe-generation:discard', input),
  openDesignPreview: (input: OpenPreviewRequest) => invokeIpc('design:preview:open', input),
  transitionTask: (input: TransitionTaskRequest) => invokeIpc('task:transition', input),
  deleteTask: (input: DeleteTaskRequest) => invokeIpc('task:delete', input),
  readArtifact: (input: ReadArtifactRequest) => invokeIpc('artifact:read', input),
  readProtocolMessage: (input: ReadProtocolMessageRequest) =>
    invokeIpc('agent:readProtocolMessage', input),
  onUpdate: (listener: (event: AppUpdateEvent) => void) => {
    const wrapped = (_: Electron.IpcRendererEvent, event: AppUpdateEvent) => listener(event);
    ipcRenderer.on(IPC_UPDATE_CHANNEL, wrapped);
    return () => ipcRenderer.off(IPC_UPDATE_CHANNEL, wrapped);
  }
};

contextBridge.exposeInMainWorld('taskManager', api);
const designCanvas: DesignCanvasApi = {
  show: (input) => invokeIpc('design:canvas:show', input),
  hide: (input) => invokeIpc('design:canvas:hide', input),
  refresh: (input) => invokeIpc('design:canvas:refresh', input),
  approveExternal: (input) =>
    invokeIpc('design:canvas:approve-external', input)
};
if (process.platform === 'darwin') {
  contextBridge.exposeInMainWorld('designCanvas', designCanvas);
}
const shellApi: TaskManagerShellApi = {
  windowChromePlatform: getWindowChromePlatform(),
  syncWindowChrome: () => ipcRenderer.send(IPC_WINDOW_CHROME_CHANNEL),
  getSoftwareUpdateState: () => invokeIpc('softwareUpdate:get'),
  checkForSoftwareUpdates: () => invokeIpc('softwareUpdate:check'),
  downloadSoftwareUpdate: () => invokeIpc('softwareUpdate:download'),
  installSoftwareUpdate: () => invokeIpc('softwareUpdate:install'),
  onSoftwareUpdateState: (listener: (state: SoftwareUpdateState) => void) => {
    const wrapped = (_: Electron.IpcRendererEvent, state: SoftwareUpdateState) => listener(state);
    ipcRenderer.on(IPC_SOFTWARE_UPDATE_CHANNEL, wrapped);
    return () => ipcRenderer.off(IPC_SOFTWARE_UPDATE_CHANNEL, wrapped);
  }
};

contextBridge.exposeInMainWorld('taskManagerShell', shellApi);

const previewSecrets: import('../shared/applicationPreview').PreviewSecretsApi = {
  list: input => invokeIpc('secrets:list', input),
  unlock: input => invokeIpc('secrets:unlock', input),
  create: input => invokeIpc('secrets:create', input),
  update: input => invokeIpc('secrets:update', input),
  has: input => invokeIpc('secrets:has', input),
  remove: input => invokeIpc('secrets:remove', input),
  status: () => invokeIpc('secrets:status'),
  lock: () => invokeIpc('secrets:lock'),
  remember: () => invokeIpc('secrets:remember'),
  forget: () => invokeIpc('secrets:forget'),
};
contextBridge.exposeInMainWorld('previewSecrets', previewSecrets);
