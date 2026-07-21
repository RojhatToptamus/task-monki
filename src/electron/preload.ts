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
import {
  IPC_UPDATE_CHANNEL,
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
  listTasks: () => invokeIpc('task:list'),
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
  readTaskAttachment: (input: ReadTaskAttachmentRequest) =>
    attachmentIpcClientGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () =>
      invokeIpc('attachment:read', input)
    ),
  readClipboardImage: () =>
    attachmentIpcClientGate.run(ATTACHMENT_MAX_IMAGE_BYTES, () =>
      invokeIpc('attachment:clipboard:readImage')
    ),
  createTask: (input: CreateTaskRequest) => invokeIpc('task:create', input),
  refinePrompt: (input: RefinePromptRequest) => invokeIpc('prompt:refine', input),
  prepareWorktree: (input: PrepareWorktreeRequest) => invokeIpc('worktree:prepare', input),
  startRun: (input: StartRunRequest) => invokeIpc('agent:startRun', input),
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
  resolvePreview: (input: ResolvePreviewRequest) => invokeIpc('preview:resolve', input),
  getPreviewRecipeGeneration: (input: GetPreviewRecipeGenerationRequest) =>
    invokeIpc('preview:recipe-generation:get', input),
  generatePreviewRecipe: (input: GeneratePreviewRecipeRequest) =>
    invokeIpc('preview:recipe-generation:generate', input),
  validatePreviewRecipeDraft: (input: ValidatePreviewRecipeDraftRequest) =>
    invokeIpc('preview:recipe-generation:validate', input),
  acceptPreviewRecipeDraft: (input: AcceptPreviewRecipeDraftRequest) =>
    invokeIpc('preview:recipe-generation:accept', input),
  discardPreviewRecipeDraft: (input: DiscardPreviewRecipeDraftRequest) =>
    invokeIpc('preview:recipe-generation:discard', input),
  approvePreviewPlan: (input: ApprovePreviewPlanRequest) =>
    invokeIpc('preview:approve', input),
  startPreview: (input: StartPreviewRequest) => invokeIpc('preview:start', input),
  stopPreview: (input: StopPreviewRequest) => invokeIpc('preview:stop', input),
  openPreview: (input: OpenPreviewRequest) => invokeIpc('preview:open', input),
  readPreviewLog: (input: ReadPreviewLogRequest) => invokeIpc('preview:log:read', input),
  resetPreviewData: (input: ResetPreviewDataRequest) => invokeIpc('preview:resetData', input),
  retryPreviewSetup: (input: RetryPreviewSetupRequest) => invokeIpc('preview:retrySetup', input),
  setPreviewLocalAttachmentBinding: (input: SetPreviewLocalAttachmentBindingRequest) =>
    invokeIpc('preview:binding:set', input),
  deletePreviewLocalAttachmentBinding: (input: DeletePreviewLocalAttachmentBindingRequest) =>
    invokeIpc('preview:binding:delete', input),
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
const privateInputs: PreviewPrivateInputApi = {
  set: (input) => invokeIpc('preview:private:set', input),
  import: (input) => invokeIpc('preview:private:import', input),
  delete: (input) => invokeIpc('preview:private:delete', input),
  retryCleanup: () => invokeIpc('preview:private:retryCleanup')
};
contextBridge.exposeInMainWorld('previewPrivateInputs', privateInputs);
const shellApi: TaskManagerShellApi = {
  windowChromePlatform: getWindowChromePlatform(),
  syncWindowChrome: () => ipcRenderer.send(IPC_WINDOW_CHROME_CHANNEL)
};

contextBridge.exposeInMainWorld('taskManagerShell', shellApi);
