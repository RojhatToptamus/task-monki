import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppUpdateEvent,
  CancelRunRequest,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  GitHubPreflightRequest,
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

const api: TaskManagerApi = {
  getDefaultRepositoryPath: () => ipcRenderer.invoke('repository:defaultPath'),
  chooseRepositoryFolder: () => ipcRenderer.invoke('repository:chooseFolder'),
  getAppSettings: () => ipcRenderer.invoke('settings:get'),
  updateAppSettings: (input: UpdateAppSettingsRequest) =>
    ipcRenderer.invoke('settings:update', input),
  getExternalToolStatus: () => ipcRenderer.invoke('settings:tools:status'),
  testExternalTool: (input: TestExternalToolRequest) =>
    ipcRenderer.invoke('settings:tools:test', input),
  getAgentProviderState: () => ipcRenderer.invoke('agent:providerState'),
  validateRepository: (path) => ipcRenderer.invoke('repository:validate', path),
  listTasks: () => ipcRenderer.invoke('task:list'),
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
