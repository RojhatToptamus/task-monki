import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppUpdateEvent,
  CancelRunRequest,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  ExecuteOpenTargetActionRequest,
  GitHubPreflightRequest,
  InspectOpenTargetRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  ReadArtifactRequest,
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
  TaskManagerApi,
  TransitionTaskRequest,
  UpdateAppSettingsRequest
} from '../shared/contracts';
import type {
  AddRepositoryRequest,
  RelinkRepositoryRequest,
  RemoveRepositoryRequest,
  SelectRepositoryRequest
} from '../shared/repositories';
import {
  ATTACHMENT_MAX_IMAGE_BYTES,
  type DiscardTaskAttachmentDraftRequest,
  type ReadTaskAttachmentRequest,
  type StageTaskAttachmentBatchRequest,
} from '../shared/attachments';
import {
  AttachmentIpcOperationGate,
  assertAttachmentIpcBatch,
} from './attachmentIpcSecurity';
import type { TaskManagerShellApi, WindowChromePlatform } from '../shared/shell';

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
  getRepositoryCatalog: () => ipcRenderer.invoke('repository:catalog'),
  selectRepository: (input: SelectRepositoryRequest) =>
    ipcRenderer.invoke('repository:select', input),
  addRepository: (input: AddRepositoryRequest) =>
    ipcRenderer.invoke('repository:add', input),
  removeRepository: (input: RemoveRepositoryRequest) =>
    ipcRenderer.invoke('repository:remove', input),
  relinkRepository: (input: RelinkRepositoryRequest) =>
    ipcRenderer.invoke('repository:relink', input),
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
  getAgentProviderState: () => ipcRenderer.invoke('agent:providerState'),
  listTasks: () => ipcRenderer.invoke('task:list'),
  listDiscourseConversations: (input = {}) =>
    ipcRenderer.invoke('discourse:conversations:list', input),
  getDiscourseConversation: (conversationId) =>
    ipcRenderer.invoke('discourse:conversation:get', conversationId),
  listDiscourseMessages: (input) => ipcRenderer.invoke('discourse:messages:list', input),
  getDiscourseMentionCatalog: () => ipcRenderer.invoke('discourse:catalog'),
  createDiscourseConversation: (input) =>
    ipcRenderer.invoke('discourse:conversation:create', input),
  appendHumanDiscourseMessage: (input) =>
    ipcRenderer.invoke('discourse:message:append-human', input),
  sendDiscourseMessage: (input) =>
    ipcRenderer.invoke('discourse:message:send', input),
  tombstoneDiscourseMessage: (input) =>
    ipcRenderer.invoke('discourse:message:tombstone', input),
  setPinnedDiscourseContext: (input) =>
    ipcRenderer.invoke('discourse:context:set-pinned', input),
  previewDiscourseContext: (input) =>
    ipcRenderer.invoke('discourse:context:preview', input),
  saveDiscourseDraft: (input) => ipcRenderer.invoke('discourse:draft:save', input),
  getDiscourseDraft: (draftId) => ipcRenderer.invoke('discourse:draft:get', draftId),
  listDiscourseDrafts: () => ipcRenderer.invoke('discourse:drafts:list'),
  deleteDiscourseDraft: (input) => ipcRenderer.invoke('discourse:draft:delete', input),
  renameDiscourseConversation: (input) =>
    ipcRenderer.invoke('discourse:conversation:rename', input),
  setDiscourseConversationRead: (input) =>
    ipcRenderer.invoke('discourse:conversation:read', input),
  setDiscourseConversationArchived: (input) =>
    ipcRenderer.invoke('discourse:conversation:archive', input),
  deleteDiscourseConversation: (input) =>
    ipcRenderer.invoke('discourse:conversation:delete', input),
  stopDiscourseWave: (input) => ipcRenderer.invoke('discourse:wave:stop', input),
  confirmDiscourseWaveContext: (input) =>
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
  startRun: (input: StartRunRequest) => ipcRenderer.invoke('codex:startRun', input),
  steerRun: (input: SteerRunRequest) => ipcRenderer.invoke('codex:steerRun', input),
  continueRun: (input: ContinueRunRequest) =>
    ipcRenderer.invoke('codex:continueRun', input),
  retryRun: (input: RetryRunRequest) => ipcRenderer.invoke('codex:retryRun', input),
  startReview: (input: StartReviewRequest) =>
    ipcRenderer.invoke('codex:startReview', input),
  syncAgentGoal: (input: SyncAgentGoalRequest) =>
    ipcRenderer.invoke('agent:syncGoal', input),
  cancelRun: (input: CancelRunRequest) => ipcRenderer.invoke('codex:cancelRun', input),
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
const shellApi: TaskManagerShellApi = {
  windowChromePlatform: getWindowChromePlatform(),
  syncWindowChrome: () => ipcRenderer.send('windowChrome:sync')
};

contextBridge.exposeInMainWorld('taskManagerShell', shellApi);
