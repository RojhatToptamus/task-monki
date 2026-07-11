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
  ApprovePreviewPlanRequest,
  OpenPreviewRequest,
  PublishBranchRequest,
  ReadArtifactRequest,
  ReadPreviewLogRequest,
  ResetPreviewDataRequest,
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
  StopPreviewRequest,
  UpdateAppSettingsRequest
} from '../shared/contracts';
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
  resolvePreview: (input: ResolvePreviewRequest) => ipcRenderer.invoke('preview:resolve', input),
  approvePreviewPlan: (input: ApprovePreviewPlanRequest) =>
    ipcRenderer.invoke('preview:approve', input),
  startPreview: (input: StartPreviewRequest) => ipcRenderer.invoke('preview:start', input),
  stopPreview: (input: StopPreviewRequest) => ipcRenderer.invoke('preview:stop', input),
  openPreview: (input: OpenPreviewRequest) => ipcRenderer.invoke('preview:open', input),
  readPreviewLog: (input: ReadPreviewLogRequest) => ipcRenderer.invoke('preview:log:read', input),
  resetPreviewData: (input: ResetPreviewDataRequest) => ipcRenderer.invoke('preview:resetData', input),
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
