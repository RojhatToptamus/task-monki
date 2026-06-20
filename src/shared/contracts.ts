export type WorkflowPhase =
  | 'BACKLOG'
  | 'READY'
  | 'IN_PROGRESS'
  | 'REVIEW'
  | 'IN_REVIEW'
  | 'DONE'
  | 'BLOCKED'
  | 'CANCELED'
  | 'ARCHIVED';

export type Resolution =
  | 'NONE'
  | 'COMPLETED'
  | 'CANCELED'
  | 'NOT_PLANNED'
  | 'DUPLICATE'
  | 'SUPERSEDED';

export type CompletionPolicy =
  | 'ARTIFACT_ACCEPTANCE'
  | 'LOCAL_ACCEPTANCE'
  | 'MERGED'
  | 'MERGED_AND_VERIFIED'
  | 'MANUAL';

export type RequestedActionStatus =
  | 'NONE'
  | 'REQUESTED'
  | 'STARTING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELED';

export type CodexRunStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'CANCELED'
  | 'LOST'
  | 'UNKNOWN';

export type ProcessStatus =
  | 'CREATED'
  | 'SPAWNING'
  | 'RUNNING'
  | 'EXITED'
  | 'SIGNALED'
  | 'CANCELING'
  | 'ORPHANED'
  | 'UNKNOWN';

export type RepositoryPreflightStatus = 'VALID' | 'INVALID' | 'UNKNOWN';

export type ArtifactStatus = 'NONE' | 'FINAL_MESSAGE_PRESENT' | 'MISSING';

export type HealthStatus = 'HEALTHY' | 'INFO' | 'WARNING' | 'ERROR' | 'BLOCKED';

export type WorktreeStatus =
  | 'NOT_CREATED'
  | 'CREATING'
  | 'PRESENT'
  | 'LOCKED'
  | 'PRUNABLE'
  | 'MISSING'
  | 'REMOVING'
  | 'REMOVED'
  | 'ERROR'
  | 'UNKNOWN';

export type GitStatus =
  | 'NOT_INSPECTED'
  | 'CLEAN'
  | 'DIRTY'
  | 'COMMITTED_UNPUSHED'
  | 'PUSHED'
  | 'CONFLICTED'
  | 'DIVERGED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export type TestStatus =
  | 'NOT_CONFIGURED'
  | 'NOT_RUN'
  | 'QUEUED'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'ERROR'
  | 'CANCELED'
  | 'STALE'
  | 'UNKNOWN';

export type RunMode = 'READ_ONLY_ANALYSIS' | 'IMPLEMENTATION';

export type GitHubRepositoryStatus =
  | 'NOT_CHECKED'
  | 'READY'
  | 'MISSING_REMOTE'
  | 'GH_MISSING'
  | 'AUTH_REQUIRED'
  | 'UNSUPPORTED_HOST'
  | 'ERROR'
  | 'UNKNOWN';

export type BranchPublicationStatus =
  | 'NOT_PUSHED'
  | 'PUSHING'
  | 'PUSHED'
  | 'FAILED'
  | 'AMBIGUOUS'
  | 'UNKNOWN';

export type PullRequestStatus =
  | 'UNLINKED'
  | 'NOT_CREATED'
  | 'OPEN_DRAFT'
  | 'OPEN_READY'
  | 'CLOSED_UNMERGED'
  | 'MERGED'
  | 'UNKNOWN';

export type CiChecksStatus =
  | 'NOT_APPLICABLE'
  | 'NO_CHECKS'
  | 'EXPECTED_NOT_REPORTED'
  | 'PENDING'
  | 'PASSING'
  | 'FAILING'
  | 'CANCELED'
  | 'BLOCKED'
  | 'STALE'
  | 'UNKNOWN';

export type ReviewStatus =
  | 'NOT_APPLICABLE'
  | 'NOT_REQUESTED'
  | 'REQUESTED'
  | 'PENDING'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'SATISFIED'
  | 'STALE'
  | 'UNKNOWN';

export type MergeStatus =
  | 'NOT_APPLICABLE'
  | 'NOT_MERGED'
  | 'COMPUTING'
  | 'MERGEABLE'
  | 'BLOCKED'
  | 'QUEUED'
  | 'MERGED'
  | 'CLOSED_UNMERGED'
  | 'UNKNOWN';

export type DomainEventType =
  | 'TASK_CREATED'
  | 'TASK_ITERATION_CREATED'
  | 'TRANSITION_REQUESTED'
  | 'TRANSITION_COMPLETED'
  | 'TRANSITION_BLOCKED'
  | 'ACTION_ATTEMPT_STARTED'
  | 'WORKTREE_CREATE_REQUESTED'
  | 'WORKTREE_CREATED'
  | 'WORKTREE_VERIFIED'
  | 'WORKTREE_FAILED'
  | 'GIT_SNAPSHOT_CAPTURED'
  | 'DELIVERY_COMMIT_CREATED'
  | 'DIFF_ARTIFACT_CREATED'
  | 'TEST_RUN_STARTED'
  | 'TEST_PROCESS_STARTED'
  | 'TEST_STDOUT_CHUNK'
  | 'TEST_STDERR_CHUNK'
  | 'TEST_RUN_COMPLETED'
  | 'TEST_RESULT_STALE'
  | 'PROMPT_REFINED'
  | 'GITHUB_PREFLIGHT_COMPLETED'
  | 'BRANCH_PUBLISH_REQUESTED'
  | 'BRANCH_PUBLISHED'
  | 'BRANCH_PUBLISH_FAILED'
  | 'PR_CREATE_REQUESTED'
  | 'PR_BODY_ARTIFACT_CREATED'
  | 'PR_SNAPSHOT_CAPTURED'
  | 'CI_ROLLUP_CAPTURED'
  | 'REVIEW_ROLLUP_CAPTURED'
  | 'MERGE_SNAPSHOT_CAPTURED'
  | 'GITHUB_SYNC_FAILED'
  | 'PROCESS_STARTED'
  | 'CODEX_STDOUT_LINE'
  | 'CODEX_EVENT_PARSED'
  | 'CODEX_STDERR_CHUNK'
  | 'CODEX_RUN_COMPLETED'
  | 'CODEX_RUN_FAILED'
  | 'PROCESS_EXITED'
  | 'PROCESS_SIGNALED'
  | 'CANCEL_REQUESTED'
  | 'ARTIFACT_CREATED'
  | 'PROJECTION_UPDATED'
  | 'REPOSITORY_PREFLIGHT_COMPLETED';

export type ArtifactKind =
  | 'stdout'
  | 'stderr'
  | 'jsonl'
  | 'final-message'
  | 'diff'
  | 'git-snapshot'
  | 'test-stdout'
  | 'test-stderr'
  | 'pr-body';

export interface Finding {
  id: string;
  code: string;
  severity: HealthStatus;
  message: string;
  createdAt: string;
  clearedAt?: string;
}

export interface StatusProjection {
  requestedAction: RequestedActionStatus;
  codexRun: CodexRunStatus;
  osProcess: ProcessStatus;
  repositoryPreflight: RepositoryPreflightStatus;
  worktree: WorktreeStatus;
  git: GitStatus;
  tests: TestStatus;
  githubRepository: GitHubRepositoryStatus;
  branchPublication: BranchPublicationStatus;
  githubPullRequest: PullRequestStatus;
  ciChecks: CiChecksStatus;
  reviews: ReviewStatus;
  merge: MergeStatus;
  artifact: ArtifactStatus;
  health: HealthStatus;
  summary: string;
  findings: Finding[];
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  repositoryPath: string;
  workflowPhase: WorkflowPhase;
  resolution: Resolution;
  completionPolicy: CompletionPolicy;
  phaseVersion: number;
  currentRunId?: string;
  currentIterationId?: string;
  currentWorktreeId?: string;
  currentTestRunId?: string;
  testCommand?: string;
  createdAt: string;
  updatedAt: string;
  projection: StatusProjection;
}

export interface TaskIteration {
  id: string;
  taskId: string;
  actionRequestId: string;
  generationKey: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'COMPLETED' | 'CANCELED';
  branchName: string;
  baseRef?: string;
  baseSha: string;
  worktreeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeRecord {
  id: string;
  taskId: string;
  iterationId: string;
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
  baseRef?: string;
  baseSha: string;
  headSha?: string;
  status: WorktreeStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
}

export interface GitSnapshotRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  worktreePath: string;
  repoRoot: string;
  gitCommonDir: string;
  headSha?: string;
  branch?: string;
  baseRef?: string;
  baseSha?: string;
  upstreamRef?: string;
  upstreamSha?: string;
  aheadCount: number;
  behindCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  operationInProgress?: string;
  commitsAheadOfBase: number;
  committedDiffFileCount: number;
  workingDiffFileCount: number;
  diffStat: string;
  dirtyFingerprint: string;
  status: GitStatus;
  capturedAt: string;
  diffArtifactId?: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  iterationId?: string;
  worktreeId?: string;
  mode: RunMode;
  generationKey?: string;
  status: CodexRunStatus;
  processStatus: ProcessStatus;
  executable: string;
  argv: string[];
  cwd: string;
  pid?: number;
  startedAt: string;
  lastEventAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutArtifactId: string;
  stderrArtifactId: string;
  jsonlArtifactId: string;
  finalArtifactId?: string;
  eventCount: number;
  lastEventType?: string;
  finalMessage?: string;
}

export interface TestRunRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  generationKey: string;
  command: string;
  executable: string;
  argv: string[];
  cwd: string;
  status: TestStatus;
  processStatus: ProcessStatus;
  stdoutArtifactId: string;
  stderrArtifactId: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  testedHeadSha?: string;
  testedDirtyFingerprint?: string;
  staleReason?: string;
}

export interface GitHubRepositoryRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  remoteName?: string;
  remoteUrl?: string;
  host?: string;
  owner?: string;
  repo?: string;
  ghVersion?: string;
  authStatus?: 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'UNKNOWN';
  status: GitHubRepositoryStatus;
  error?: string;
  checkedAt: string;
}

export interface BranchPublicationRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  remoteName: string;
  branchName: string;
  remoteRef: string;
  headSha?: string;
  status: BranchPublicationStatus;
  error?: string;
  requestedAt: string;
  updatedAt: string;
}

export interface PullRequestSnapshotRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  number?: number;
  url?: string;
  status: PullRequestStatus;
  state?: 'OPEN' | 'CLOSED' | 'MERGED' | string;
  isDraft?: boolean;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  mergedAt?: string | null;
  title?: string;
  bodyArtifactId?: string;
  observedAt: string;
  raw?: unknown;
}

export interface CiRollupRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  pullRequestNumber?: number;
  headSha?: string;
  status: CiChecksStatus;
  requiredStatus: CiChecksStatus;
  totalCount: number;
  pendingCount: number;
  passingCount: number;
  failingCount: number;
  skippedCount: number;
  observedAt: string;
  raw?: unknown;
}

export interface ReviewRollupRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  pullRequestNumber?: number;
  headSha?: string;
  status: ReviewStatus;
  reviewDecision?: string;
  observedAt: string;
  raw?: unknown;
}

export interface MergeSnapshotRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  pullRequestNumber?: number;
  headSha?: string;
  status: MergeStatus;
  mergedAt?: string | null;
  observedAt: string;
  raw?: unknown;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  runId?: string;
  testRunId?: string;
  kind: ArtifactKind;
  path: string;
  byteCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DomainEvent {
  id: string;
  type: DomainEventType;
  taskId: string;
  iterationId?: string;
  runId?: string;
  testRunId?: string;
  worktreeId?: string;
  source:
    | 'ui'
    | 'codex'
    | 'process'
    | 'storage'
    | 'repository'
    | 'projection'
    | 'git'
    | 'test'
    | 'github'
    | 'prompt';
  sourceEventId: string;
  occurredAt: string;
  receivedAt: string;
  payload: unknown;
}

export interface RepositoryPreflight {
  path: string;
  status: RepositoryPreflightStatus;
  root?: string;
  headSha?: string;
  branch?: string;
  remotes: Array<{ name: string; url: string; direction: 'fetch' | 'push' }>;
  error?: string;
  checkedAt: string;
}

export interface TaskSnapshot {
  tasks: Task[];
  iterations: TaskIteration[];
  worktrees: WorktreeRecord[];
  gitSnapshots: GitSnapshotRecord[];
  testRuns: TestRunRecord[];
  githubRepositories: GitHubRepositoryRecord[];
  branchPublications: BranchPublicationRecord[];
  pullRequests: PullRequestSnapshotRecord[];
  ciRollups: CiRollupRecord[];
  reviewRollups: ReviewRollupRecord[];
  mergeSnapshots: MergeSnapshotRecord[];
  runs: RunRecord[];
  events: DomainEvent[];
  artifacts: ArtifactRecord[];
}

export interface CreateTaskRequest {
  title: string;
  prompt: string;
  repositoryPath: string;
  testCommand?: string;
}

export interface StartRunRequest {
  taskId: string;
  mode?: RunMode;
}

export interface CancelRunRequest {
  runId: string;
}

export interface PrepareWorktreeRequest {
  taskId: string;
}

export interface RunTestsRequest {
  taskId: string;
}

export interface RefreshEvidenceRequest {
  taskId: string;
}

export interface CreateDeliveryCommitRequest {
  taskId: string;
}

export interface TransitionTaskRequest {
  taskId: string;
  toPhase: WorkflowPhase;
}

export interface ReadArtifactRequest {
  artifactId: string;
}

export interface RefinePromptRequest {
  repositoryPath: string;
  input: string;
}

export interface RefinePromptResponse {
  prompt: string;
  titleSuggestion: string;
  source: 'model' | 'deterministic-fallback';
}

export interface GitHubPreflightRequest {
  taskId: string;
}

export interface PublishBranchRequest {
  taskId: string;
}

export interface CreatePullRequestRequest {
  taskId: string;
}

export interface RefreshGitHubRequest {
  taskId: string;
}

export interface AppUpdateEvent {
  type:
    | 'task.updated'
    | 'run.started'
    | 'run.output'
    | 'run.eventParsed'
    | 'run.stderr'
    | 'run.terminal'
    | 'worktree.updated'
    | 'git.updated'
    | 'test.started'
    | 'test.output'
    | 'test.terminal'
    | 'github.updated'
    | 'prompt.refined'
    | 'projection.updated'
    | 'finding.updated';
  taskId: string;
  iterationId?: string;
  runId?: string;
  testRunId?: string;
  worktreeId?: string;
  payload: unknown;
  at: string;
}

export interface TaskManagerApi {
  getDefaultRepositoryPath(): Promise<string>;
  validateRepository(path: string): Promise<RepositoryPreflight>;
  listTasks(): Promise<TaskSnapshot>;
  createTask(input: CreateTaskRequest): Promise<Task>;
  refinePrompt(input: RefinePromptRequest): Promise<RefinePromptResponse>;
  prepareWorktree(input: PrepareWorktreeRequest): Promise<WorktreeRecord>;
  startRun(input: StartRunRequest): Promise<RunRecord>;
  cancelRun(input: CancelRunRequest): Promise<void>;
  runTests(input: RunTestsRequest): Promise<TestRunRecord>;
  refreshEvidence(input: RefreshEvidenceRequest): Promise<GitSnapshotRecord>;
  createDeliveryCommit(input: CreateDeliveryCommitRequest): Promise<GitSnapshotRecord>;
  preflightGitHub(input: GitHubPreflightRequest): Promise<GitHubRepositoryRecord>;
  publishBranch(input: PublishBranchRequest): Promise<BranchPublicationRecord>;
  createPullRequest(input: CreatePullRequestRequest): Promise<PullRequestSnapshotRecord>;
  refreshGitHub(input: RefreshGitHubRequest): Promise<PullRequestSnapshotRecord | undefined>;
  transitionTask(input: TransitionTaskRequest): Promise<Task>;
  readArtifact(input: ReadArtifactRequest): Promise<string>;
  onUpdate(listener: (event: AppUpdateEvent) => void): () => void;
}

export function createInitialProjection(now: string): StatusProjection {
  return {
    requestedAction: 'NONE',
    codexRun: 'UNKNOWN',
    osProcess: 'UNKNOWN',
    repositoryPreflight: 'UNKNOWN',
    worktree: 'NOT_CREATED',
    git: 'NOT_INSPECTED',
    tests: 'NOT_RUN',
    githubRepository: 'NOT_CHECKED',
    branchPublication: 'NOT_PUSHED',
    githubPullRequest: 'UNLINKED',
    ciChecks: 'NOT_APPLICABLE',
    reviews: 'NOT_APPLICABLE',
    merge: 'NOT_APPLICABLE',
    artifact: 'NONE',
    health: 'INFO',
    summary: 'Ready for isolated implementation.',
    findings: [],
    updatedAt: now
  };
}
