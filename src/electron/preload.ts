import { contextBridge, ipcRenderer } from 'electron';
import type {
  AcceptPreviewRecipeDraftRequest,
  AppUpdateEvent,
  CancelRunRequest,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  DiscardPreviewRecipeDraftRequest,
  ExecuteOpenTargetActionRequest,
  GitHubPreflightRequest,
  GeneratePreviewRecipeRequest,
  GetPreviewRecipeGenerationRequest,
  InspectOpenTargetRequest,
  PrepareWorktreeRequest,
  ApprovePreviewPlanRequest,
  OpenPreviewRequest,
  PublishBranchRequest,
  ReadArtifactRequest,
  ReadPreviewLogRequest,
  ResetPreviewDataRequest,
  SetPreviewLocalAttachmentBindingRequest,
  DeletePreviewLocalAttachmentBindingRequest,
  RetryPreviewSetupRequest,
  ResolvePreviewRequest,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RespondToInteractionRequest,
  RefinePromptRequest,
  StartRunRequest,
  StartPreviewRequest,
  StartReviewRequest,
  SteerRunRequest,
  RetryRunRequest,
  SyncAgentGoalRequest,
  ReadProtocolMessageRequest,
  TestExternalToolRequest,
  TaskManagerApi,
  TransitionTaskRequest,
  UpdateAgentNativeSessionRequest,
  StopPreviewRequest,
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
import type { PreviewPrivateInputApi } from '../shared/preview';

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
  chooseRepositoryFolder: () => ipcRenderer.invoke('repository:chooseFolder'),
  addRepository: (path) => ipcRenderer.invoke('repository:add', path),
  getRepositoryImpact: (repositoryId) =>
    ipcRenderer.invoke('repository:impact', repositoryId),
  disconnectRepository: (input) => ipcRenderer.invoke('repository:disconnect', input),
  reconnectRepository: (input) => ipcRenderer.invoke('repository:reconnect', input),
  refreshRepository: (repositoryId) =>
    ipcRenderer.invoke('repository:refresh', repositoryId),
  createBoard: (input) => ipcRenderer.invoke('board:create', input),
  updateBoard: (input) => ipcRenderer.invoke('board:update', input),
  deleteBoard: (boardId) => ipcRenderer.invoke('board:delete', boardId),
  getAppSettings: () => ipcRenderer.invoke('settings:get'),
  updateAppSettings: (input: UpdateAppSettingsRequest) =>
    ipcRenderer.invoke('settings:update', input),
  getExternalToolStatus: () => ipcRenderer.invoke('settings:tools:status'),
  testExternalTool: (input: TestExternalToolRequest) =>
    ipcRenderer.invoke('settings:tools:test', input),
  inspectOpenTarget: (input: InspectOpenTargetRequest) =>
    ipcRenderer.invoke('openTarget:inspect', input),
  executeOpenTargetAction: (input: ExecuteOpenTargetActionRequest) =>
    ipcRenderer.invoke('openTarget:execute', input),
  getAgentRuntimeCatalog: () => ipcRenderer.invoke('agent:runtimeCatalog'),
  discoverAgentRuntimeModels: (runtimeId) =>
    ipcRenderer.invoke('agent:discoverRuntimeModels', runtimeId),
  updateAgentNativeSession: (input: UpdateAgentNativeSessionRequest) =>
    ipcRenderer.invoke('agent:updateNativeSession', input),
  listTasks: () => ipcRenderer.invoke('task:list'),
  listDiscourseConversations: (input?: ListDiscourseConversationsRequest) =>
    ipcRenderer.invoke('discourse:conversations:list', input),
  getDiscourseConversation: (conversationId: string) =>
    ipcRenderer.invoke('discourse:conversation:get', conversationId),
  listDiscourseMessages: (input: ListDiscourseMessagesRequest) =>
    ipcRenderer.invoke('discourse:messages:list', input),
  getDiscourseMessageByClientId: (input: GetDiscourseMessageByClientIdRequest) =>
    ipcRenderer.invoke('discourse:message:get-by-client-id', input),
  getDiscourseMentionCatalog: () => ipcRenderer.invoke('discourse:mentions:get'),
  createDiscourseConversation: (input: CreateDiscourseConversationRequest) =>
    ipcRenderer.invoke('discourse:conversation:create', input),
  appendHumanDiscourseMessage: (input: AppendHumanDiscourseMessageRequest) =>
    ipcRenderer.invoke('discourse:message:append', input),
  sendDiscourseMessage: (input: SendDiscourseMessageRequest) =>
    ipcRenderer.invoke('discourse:message:send', input),
  resumeDiscourseAcceptedSend: (input: ResumeDiscourseAcceptedSendRequest) =>
    ipcRenderer.invoke('discourse:message:resume', input),
  cancelDiscourseAcceptedSend: (input: CancelDiscourseAcceptedSendRequest) =>
    ipcRenderer.invoke('discourse:message:cancel-response', input),
  tombstoneDiscourseMessage: (input: TombstoneDiscourseMessageRequest) =>
    ipcRenderer.invoke('discourse:message:tombstone', input),
  setPinnedDiscourseContext: (input: SetPinnedDiscourseContextRequest) =>
    ipcRenderer.invoke('discourse:context:pin', input),
  previewDiscourseContext: (input: PreviewDiscourseContextRequest) =>
    ipcRenderer.invoke('discourse:context:preview', input),
  saveDiscourseDraft: (input: SaveDiscourseDraftRequest) =>
    ipcRenderer.invoke('discourse:draft:save', input),
  getDiscourseDraft: (draftId: string) =>
    ipcRenderer.invoke('discourse:draft:get', draftId),
  listDiscourseDrafts: () => ipcRenderer.invoke('discourse:drafts:list'),
  deleteDiscourseDraft: (input: DeleteDiscourseDraftRequest) =>
    ipcRenderer.invoke('discourse:draft:delete', input),
  renameDiscourseConversation: (input: RenameDiscourseConversationRequest) =>
    ipcRenderer.invoke('discourse:conversation:rename', input),
  setDiscourseConversationRead: (input: SetDiscourseConversationReadRequest) =>
    ipcRenderer.invoke('discourse:conversation:read', input),
  setDiscourseConversationArchived: (input: SetDiscourseConversationArchivedRequest) =>
    ipcRenderer.invoke('discourse:conversation:archive', input),
  deleteDiscourseConversation: (input: DeleteDiscourseConversationRequest) =>
    ipcRenderer.invoke('discourse:conversation:delete', input),
  stopDiscourseWave: (input: StopDiscourseWaveRequest) =>
    ipcRenderer.invoke('discourse:wave:stop', input),
  confirmDiscourseWaveContext: (input: ConfirmDiscourseWaveContextRequest) =>
    ipcRenderer.invoke('discourse:wave:confirm-context', input),
  stageTaskAttachmentBatch: async (input: StageTaskAttachmentBatchRequest) => {
    const byteCount = assertAttachmentIpcBatch(input);
    return attachmentIpcClientGate.run(byteCount, () =>
      ipcRenderer.invoke('attachment:stage-batch', input)
    );
  },
  discardTaskAttachmentDraft: (input: DiscardTaskAttachmentDraftRequest) =>
    ipcRenderer.invoke('attachment:draft:discard', input),
  readTaskAttachment: (input: ReadTaskAttachmentRequest) =>
    attachmentIpcClientGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () =>
      ipcRenderer.invoke('attachment:read', input)
    ),
  readClipboardImage: () =>
    attachmentIpcClientGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () =>
      ipcRenderer.invoke('attachment:clipboard:readImage')
    ),
  createTask: (input: CreateTaskRequest) => ipcRenderer.invoke('task:create', input),
  refinePrompt: (input: RefinePromptRequest) => ipcRenderer.invoke('prompt:refine', input),
  prepareWorktree: (input: PrepareWorktreeRequest) => ipcRenderer.invoke('worktree:prepare', input),
  startRun: (input: StartRunRequest) => ipcRenderer.invoke('agent:startRun', input),
  steerRun: (input: SteerRunRequest) => ipcRenderer.invoke('agent:steerRun', input),
  continueRun: (input: ContinueRunRequest) =>
    ipcRenderer.invoke('agent:continueRun', input),
  retryRun: (input: RetryRunRequest) => ipcRenderer.invoke('agent:retryRun', input),
  startReview: (input: StartReviewRequest) =>
    ipcRenderer.invoke('agent:startReview', input),
  syncAgentGoal: (input: SyncAgentGoalRequest) =>
    ipcRenderer.invoke('agent:syncGoal', input),
  cancelRun: (input: CancelRunRequest) => ipcRenderer.invoke('agent:cancelRun', input),
  respondToInteraction: (input: RespondToInteractionRequest) =>
    ipcRenderer.invoke('agent:respondToInteraction', input),
  refreshEvidence: (input: RefreshEvidenceRequest) => ipcRenderer.invoke('evidence:refresh', input),
  createDeliveryCommit: (input: CreateDeliveryCommitRequest) =>
    ipcRenderer.invoke('git:deliveryCommit', input),
  preflightGitHub: (input: GitHubPreflightRequest) => ipcRenderer.invoke('github:preflight', input),
  publishBranch: (input: PublishBranchRequest) => ipcRenderer.invoke('github:publish', input),
  createPullRequest: (input: CreatePullRequestRequest) =>
    ipcRenderer.invoke('github:createPullRequest', input),
  refreshGitHub: (input: RefreshGitHubRequest) => ipcRenderer.invoke('github:refresh', input),
  resolvePreview: (input: ResolvePreviewRequest) => ipcRenderer.invoke('preview:resolve', input),
  getPreviewRecipeGeneration: (input: GetPreviewRecipeGenerationRequest) =>
    ipcRenderer.invoke('preview:recipe-generation:get', input),
  generatePreviewRecipe: (input: GeneratePreviewRecipeRequest) =>
    ipcRenderer.invoke('preview:recipe-generation:generate', input),
  validatePreviewRecipeDraft: (input: ValidatePreviewRecipeDraftRequest) =>
    ipcRenderer.invoke('preview:recipe-generation:validate', input),
  acceptPreviewRecipeDraft: (input: AcceptPreviewRecipeDraftRequest) =>
    ipcRenderer.invoke('preview:recipe-generation:accept', input),
  discardPreviewRecipeDraft: (input: DiscardPreviewRecipeDraftRequest) =>
    ipcRenderer.invoke('preview:recipe-generation:discard', input),
  approvePreviewPlan: (input: ApprovePreviewPlanRequest) =>
    ipcRenderer.invoke('preview:approve', input),
  startPreview: (input: StartPreviewRequest) => ipcRenderer.invoke('preview:start', input),
  stopPreview: (input: StopPreviewRequest) => ipcRenderer.invoke('preview:stop', input),
  openPreview: (input: OpenPreviewRequest) => ipcRenderer.invoke('preview:open', input),
  readPreviewLog: (input: ReadPreviewLogRequest) => ipcRenderer.invoke('preview:log:read', input),
  resetPreviewData: (input: ResetPreviewDataRequest) => ipcRenderer.invoke('preview:resetData', input),
  retryPreviewSetup: (input: RetryPreviewSetupRequest) => ipcRenderer.invoke('preview:retrySetup', input),
  setPreviewLocalAttachmentBinding: (input: SetPreviewLocalAttachmentBindingRequest) =>
    ipcRenderer.invoke('preview:binding:set', input),
  deletePreviewLocalAttachmentBinding: (input: DeletePreviewLocalAttachmentBindingRequest) =>
    ipcRenderer.invoke('preview:binding:delete', input),
  transitionTask: (input: TransitionTaskRequest) => ipcRenderer.invoke('task:transition', input),
  deleteTask: (input: DeleteTaskRequest) => ipcRenderer.invoke('task:delete', input),
  readArtifact: (input: ReadArtifactRequest) => ipcRenderer.invoke('artifact:read', input),
  readProtocolMessage: (input: ReadProtocolMessageRequest) =>
    ipcRenderer.invoke('agent:readProtocolMessage', input),
  onUpdate: (listener: (event: AppUpdateEvent) => void) => {
    const wrapped = (_: Electron.IpcRendererEvent, event: AppUpdateEvent) => listener(event);
    ipcRenderer.on('app:update', wrapped);
    return () => ipcRenderer.off('app:update', wrapped);
  }
};

contextBridge.exposeInMainWorld('taskManager', api);
const privateInputs: PreviewPrivateInputApi = {
  set: (input) => ipcRenderer.invoke('preview:private:set', input),
  import: (input) => ipcRenderer.invoke('preview:private:import', input),
  delete: (input) => ipcRenderer.invoke('preview:private:delete', input),
  retryCleanup: () => ipcRenderer.invoke('preview:private:retryCleanup')
};
contextBridge.exposeInMainWorld('previewPrivateInputs', privateInputs);
const shellApi: TaskManagerShellApi = {
  windowChromePlatform: getWindowChromePlatform(),
  syncWindowChrome: () => ipcRenderer.send('windowChrome:sync')
};

contextBridge.exposeInMainWorld('taskManagerShell', shellApi);
