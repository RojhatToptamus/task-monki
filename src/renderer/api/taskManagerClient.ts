import type {
  AppUpdateEvent,
  CancelRunRequest,
  ContinueRunRequest,
  BranchPublicationRecord,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  DeleteTaskResult,
  GitSnapshotRecord,
  GitHubPreflightRequest,
  GitHubRepositoryRecord,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  PullRequestSnapshotRecord,
  ReadArtifactRequest,
  RepositoryPreflight,
  RunTestsRequest,
  RunRecord,
  StartRunRequest,
  Task,
  TaskManagerApi,
  TaskSnapshot,
  TestRunRecord,
  TransitionTaskRequest,
  WorktreeRecord,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RefinePromptRequest,
  RefinePromptResponse,
  RespondToInteractionRequest,
  RetryRunRequest,
  SyncAgentGoalRequest,
  ReadProtocolMessageRequest,
  StartReviewRequest,
  SteerRunRequest
} from '../../shared/contracts';

const apiBase = import.meta.env.VITE_TASK_MANAGER_API_URL ?? 'http://127.0.0.1:3099';

export const taskManagerApi: TaskManagerApi =
  window.taskManager ?? createBrowserTaskManagerApi(apiBase);

function createBrowserTaskManagerApi(baseUrl: string): TaskManagerApi {
  let eventSource: EventSource | undefined;
  const listeners = new Set<(event: AppUpdateEvent) => void>();

  const ensureEventSource = () => {
    if (eventSource) {
      return;
    }

    eventSource = new EventSource(`${baseUrl}/api/events`);
    eventSource.addEventListener('update', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as AppUpdateEvent;
      for (const listener of listeners) {
        listener(event);
      }
    });
  };

  return {
    getDefaultRepositoryPath: () => get<string>(baseUrl, '/api/defaultRepositoryPath'),
    chooseRepositoryFolder: async () => {
      const selectedPath = await post<string | null>(baseUrl, '/api/repository/chooseFolder', {});
      return selectedPath ?? undefined;
    },
    getAgentProviderState: () => get(baseUrl, '/api/agent/provider'),
    validateRepository: (path) =>
      post<RepositoryPreflight>(baseUrl, '/api/repository/validate', { path }),
    listTasks: () => get<TaskSnapshot>(baseUrl, '/api/tasks'),
    createTask: (input: CreateTaskRequest) => post<Task>(baseUrl, '/api/tasks', input),
    refinePrompt: (input: RefinePromptRequest) =>
      post<RefinePromptResponse>(baseUrl, '/api/prompt/refine', input),
    prepareWorktree: (input: PrepareWorktreeRequest) =>
      post<WorktreeRecord>(baseUrl, '/api/worktrees/prepare', input),
    startRun: (input: StartRunRequest) => post<RunRecord>(baseUrl, '/api/runs/start', input),
    steerRun: (input: SteerRunRequest) => post<void>(baseUrl, '/api/runs/steer', input),
    continueRun: (input: ContinueRunRequest) =>
      post<RunRecord>(baseUrl, '/api/runs/continue', input),
    retryRun: (input: RetryRunRequest) =>
      post<RunRecord>(baseUrl, '/api/runs/retry', input),
    startReview: (input: StartReviewRequest) =>
      post<RunRecord>(baseUrl, '/api/runs/review', input),
    syncAgentGoal: (input: SyncAgentGoalRequest) =>
      post(baseUrl, '/api/agent/goal/sync', input),
    cancelRun: (input: CancelRunRequest) => post<void>(baseUrl, '/api/runs/cancel', input),
    respondToInteraction: (input: RespondToInteractionRequest) =>
      post(baseUrl, '/api/interactions/respond', input),
    runTests: (input: RunTestsRequest) => post<TestRunRecord>(baseUrl, '/api/tests/run', input),
    refreshEvidence: (input: RefreshEvidenceRequest) =>
      post<GitSnapshotRecord>(baseUrl, '/api/evidence/refresh', input),
    createDeliveryCommit: (input: CreateDeliveryCommitRequest) =>
      post<GitSnapshotRecord>(baseUrl, '/api/git/delivery-commit', input),
    preflightGitHub: (input: GitHubPreflightRequest) =>
      post<GitHubRepositoryRecord>(baseUrl, '/api/github/preflight', input),
    publishBranch: (input: PublishBranchRequest) =>
      post<BranchPublicationRecord>(baseUrl, '/api/github/publish', input),
    createPullRequest: (input: CreatePullRequestRequest) =>
      post<PullRequestSnapshotRecord>(baseUrl, '/api/github/pr/create', input),
    refreshGitHub: (input: RefreshGitHubRequest) =>
      post<PullRequestSnapshotRecord | undefined>(baseUrl, '/api/github/refresh', input),
    transitionTask: (input: TransitionTaskRequest) =>
      post<Task>(baseUrl, '/api/tasks/transition', input),
    deleteTask: (input: DeleteTaskRequest) =>
      post<DeleteTaskResult>(baseUrl, '/api/tasks/delete', input),
    readArtifact: (input: ReadArtifactRequest) => post<string>(baseUrl, '/api/artifact/read', input),
    readProtocolMessage: (input: ReadProtocolMessageRequest) =>
      post(baseUrl, '/api/agent/protocol/read', input),
    onUpdate: (listener) => {
      listeners.add(listener);
      ensureEventSource();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          eventSource?.close();
          eventSource = undefined;
        }
      };
    }
  };
}

async function get<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  return readResponse<T>(response);
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    throw new Error(
      typeof body === 'object' && body && 'error' in body && body.error
        ? body.error
        : `HTTP ${response.status}`
    );
  }
  return body as T;
}
