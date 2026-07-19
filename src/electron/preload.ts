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
  UpdateAgentNativeSessionRequest,
  UpdateAppSettingsRequest
} from '../shared/contracts';
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
  getDefaultRepositoryPath: () => ipcRenderer.invoke('repository:defaultPath'),
  chooseRepositoryFolder: () => ipcRenderer.invoke('repository:chooseFolder'),
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
  validateRepository: (path) => ipcRenderer.invoke('repository:validate', path),
  listTasks: () => ipcRenderer.invoke('task:list'),
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
