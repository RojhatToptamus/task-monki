import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppUpdateEvent,
  CancelRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  GitHubPreflightRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  ReadArtifactRequest,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RefinePromptRequest,
  RunTestsRequest,
  StartRunRequest,
  TaskManagerApi,
  TransitionTaskRequest
} from '../shared/contracts';

const api: TaskManagerApi = {
  getDefaultRepositoryPath: () => ipcRenderer.invoke('repository:defaultPath'),
  validateRepository: (path) => ipcRenderer.invoke('repository:validate', path),
  listTasks: () => ipcRenderer.invoke('task:list'),
  createTask: (input: CreateTaskRequest) => ipcRenderer.invoke('task:create', input),
  refinePrompt: (input: RefinePromptRequest) => ipcRenderer.invoke('prompt:refine', input),
  prepareWorktree: (input: PrepareWorktreeRequest) => ipcRenderer.invoke('worktree:prepare', input),
  startRun: (input: StartRunRequest) => ipcRenderer.invoke('codex:startRun', input),
  cancelRun: (input: CancelRunRequest) => ipcRenderer.invoke('codex:cancelRun', input),
  runTests: (input: RunTestsRequest) => ipcRenderer.invoke('test:run', input),
  refreshEvidence: (input: RefreshEvidenceRequest) => ipcRenderer.invoke('evidence:refresh', input),
  createDeliveryCommit: (input: CreateDeliveryCommitRequest) =>
    ipcRenderer.invoke('git:deliveryCommit', input),
  preflightGitHub: (input: GitHubPreflightRequest) => ipcRenderer.invoke('github:preflight', input),
  publishBranch: (input: PublishBranchRequest) => ipcRenderer.invoke('github:publish', input),
  createPullRequest: (input: CreatePullRequestRequest) =>
    ipcRenderer.invoke('github:createPullRequest', input),
  refreshGitHub: (input: RefreshGitHubRequest) => ipcRenderer.invoke('github:refresh', input),
  transitionTask: (input: TransitionTaskRequest) => ipcRenderer.invoke('task:transition', input),
  readArtifact: (input: ReadArtifactRequest) => ipcRenderer.invoke('artifact:read', input),
  onUpdate: (listener: (event: AppUpdateEvent) => void) => {
    const wrapped = (_: Electron.IpcRendererEvent, event: AppUpdateEvent) => listener(event);
    ipcRenderer.on('app:update', wrapped);
    return () => ipcRenderer.off('app:update', wrapped);
  }
};

contextBridge.exposeInMainWorld('taskManager', api);
