import type {
  AgentExecutionSettings,
  AgentGoalSnapshotRecord,
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentReviewTarget,
  AgentRetryStrategy,
  AgentRecoveryState,
  AgentRunMode,
  AgentRunStatus,
  AgentServerInstance,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentSubagentObservationRecord,
  AgentUsageSnapshotRecord,
  InteractionRequestRecord
} from './agent';
import type {
  ApprovePreviewPlanRequest,
  OpenPreviewRequest,
  OpenPreviewResult,
  PreviewApprovalRecord,
  PreviewGenerationRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  PreviewResourceRecord,
  ReadPreviewLogRequest,
  ReadPreviewLogResult,
  ResetPreviewDataRequest,
  ResolvePreviewRequest,
  ResolvePreviewResult,
  StartPreviewRequest,
  StopPreviewRequest
} from './preview';

export * from './agent';
export * from './preview';

export const TASK_STORE_SCHEMA_VERSION = 12 as const;

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

export function completionPolicyRequiresMerge(policy: CompletionPolicy): boolean {
  return policy === 'MERGED' || policy === 'MERGED_AND_VERIFIED';
}

export function completionPolicyRequiresPassingChecks(policy: CompletionPolicy): boolean {
  return policy === 'MERGED_AND_VERIFIED';
}

export interface VerifiedChecksEvidence {
  ciStatus?: CiChecksStatus;
  ciHeadSha?: string;
  ciPullRequestNumber?: number;
  mergeHeadSha?: string;
  mergePullRequestNumber?: number;
}

export function verifiedChecksMatchMergeHead(evidence: VerifiedChecksEvidence): boolean {
  return (
    evidence.ciStatus === 'PASSING' &&
    typeof evidence.ciPullRequestNumber === 'number' &&
    evidence.ciPullRequestNumber === evidence.mergePullRequestNumber &&
    Boolean(
      evidence.ciHeadSha &&
        evidence.mergeHeadSha &&
        evidence.ciHeadSha === evidence.mergeHeadSha
    )
  );
}

export const PULL_REQUEST_TITLE_MAX_LENGTH = 256;

export function normalizePullRequestTitle(
  title: string | null | undefined,
  fallback: string
): string {
  return (
    compactPullRequestTitle(title) ||
    compactPullRequestTitle(fallback) ||
    'Task Monki PR'
  );
}

function compactPullRequestTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim().slice(0, PULL_REQUEST_TITLE_MAX_LENGTH).trim();
}

export type RequestedActionStatus =
  | 'NONE'
  | 'REQUESTED'
  | 'STARTING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELED';

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

export type GitHubCheckStatus = 'passed' | 'failed' | 'pending' | 'skipped' | 'canceled';

export interface GitHubCheckDetailRecord {
  name: string;
  status: GitHubCheckStatus;
  state?: string;
  workflow?: string;
  link?: string;
  description?: string;
  event?: string;
  startedAt?: string;
  completedAt?: string;
}

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

export type CodexReviewGateStatus =
  | 'NOT_RUN'
  | 'RUNNING'
  | 'PASSED'
  | 'NEEDS_CHANGES'
  | 'INCONCLUSIVE'
  | 'FAILED'
  | 'CANCELED'
  | 'STALE';

export type CodexReviewFindingSeverity = 'BLOCKER' | 'MAJOR' | 'MINOR' | 'NIT';

export interface CodexReviewFinding {
  id: string;
  severity: CodexReviewFindingSeverity;
  title: string;
  explanation: string;
  path?: string;
  line?: number;
  endLine?: number;
  recommendation?: string;
}

export interface CodexReviewResult {
  schemaVersion: 'codex-review/v1';
  verdict: 'PASSED' | 'NEEDS_CHANGES' | 'INCONCLUSIVE';
  summary: string;
  findings: CodexReviewFinding[];
}

export interface CodexReviewGateProjection {
  status: CodexReviewGateStatus;
  runId?: string;
  sourceRunId?: string;
  reviewedGitSnapshotId?: string;
  reviewedHeadSha?: string;
  reviewedDirtyFingerprint?: string;
  finalArtifactId?: string;
  summary?: string;
  result?: CodexReviewResult;
  updatedAt?: string;
}

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
  | 'TASK_ALTERNATIVE_CREATED'
  | 'TASK_ITERATION_CREATED'
  | 'TRANSITION_REQUESTED'
  | 'TRANSITION_COMPLETED'
  | 'TRANSITION_BLOCKED'
  | 'WORKTREE_CREATE_REQUESTED'
  | 'WORKTREE_CREATED'
  | 'WORKTREE_VERIFIED'
  | 'WORKTREE_FAILED'
  | 'GIT_SNAPSHOT_CAPTURED'
  | 'DELIVERY_COMMIT_CREATED'
  | 'DIFF_ARTIFACT_CREATED'
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
  | 'AGENT_SESSION_CREATED'
  | 'AGENT_RUN_STARTED'
  | 'AGENT_ACTIVITY_RECEIVED'
  | 'AGENT_GOAL_UPDATED'
  | 'AGENT_GOAL_CLEARED'
  | 'AGENT_GOAL_SYNC_FAILED'
  | 'AGENT_PLAN_REVISED'
  | 'AGENT_USAGE_UPDATED'
  | 'AGENT_SETTINGS_OBSERVED'
  | 'AGENT_SUBAGENT_DISCOVERED'
  | 'AGENT_SUBAGENT_UPDATED'
  | 'AGENT_SUBAGENT_RELATIONSHIP_UNRESOLVED'
  | 'AGENT_PROTOCOL_INCIDENT'
  | 'AGENT_ITEM_UPDATED'
  | 'AGENT_INTERACTION_REQUESTED'
  | 'AGENT_INTERACTION_RESOLVED'
  | 'AGENT_RUN_COMPLETED'
  | 'AGENT_RUN_FAILED'
  | 'AGENT_RUN_INTERRUPTED'
  | 'AGENT_MUTATION_AMBIGUOUS'
  | 'AGENT_REVIEW_POLICY_VIOLATION'
  | 'AGENT_RUNTIME_LOST'
  | 'AGENT_RUNTIME_RECONCILED'
  | 'PROCESS_EXITED'
  | 'PROCESS_SIGNALED'
  | 'CANCEL_REQUESTED'
  | 'ARTIFACT_CREATED'
  | 'PROJECTION_UPDATED'
  | 'REPOSITORY_PREFLIGHT_COMPLETED'
  | 'PREVIEW_PLAN_RESOLVED'
  | 'PREVIEW_PLAN_APPROVED'
  | 'PREVIEW_GENERATION_CREATED'
  | 'PREVIEW_GENERATION_UPDATED'
  | 'PREVIEW_NODE_UPDATED'
  | 'PREVIEW_RESOURCE_UPDATED'
  | 'PREVIEW_RECONCILED';

export type ArtifactKind =
  | 'agent-prompt'
  | 'agent-output'
  | 'agent-diagnostics'
  | 'agent-final'
  | 'diff'
  | 'git-snapshot'
  | 'pr-body'
  | 'preview-source-manifest'
  | 'preview-stdout'
  | 'preview-stderr';

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
  agentRun: AgentRunStatus | 'IDLE';
  osProcess: ProcessStatus;
  repositoryPreflight: RepositoryPreflightStatus;
  worktree: WorktreeStatus;
  git: GitStatus;
  githubRepository: GitHubRepositoryStatus;
  branchPublication: BranchPublicationStatus;
  githubPullRequest: PullRequestStatus;
  githubPullRequestNumber?: number;
  githubPullRequestUrl?: string;
  ciChecks: CiChecksStatus;
  reviews: ReviewStatus;
  /**
   * Local Codex diff-review gate. This is intentionally separate from
   * GitHub PR review rollups above and is additive for older local stores.
   */
  codexReview?: CodexReviewGateProjection;
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
  currentAgentSessionId?: string;
  currentIterationId?: string;
  currentWorktreeId?: string;
  forkedAlternativeTaskIds: string[];
  forkedFromTaskId?: string;
  forkedFromRunId?: string;
  agentSettings: AgentExecutionSettings;
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
  iterationId: string;
  worktreeId: string;
  sessionId: string;
  serverInstanceId?: string;
  providerTurnId?: string;
  mode: AgentRunMode;
  origin: import('./agent').AgentRunOrigin;
  parentRunId?: string;
  generationKey?: string;
  retryOfRunId?: string;
  continuedFromRunId?: string;
  status: AgentRunStatus;
  recoveryState: AgentRecoveryState;
  requestedSettings: AgentExecutionSettings;
  observedSettings?: AgentExecutionSettings;
  promptArtifactId: string;
  outputArtifactId: string;
  diagnosticArtifactId: string;
  beforeGitSnapshotId?: string;
  afterGitSnapshotId?: string;
  terminalReason?: string;
  providerTerminalSource?: 'TURN_COMPLETED_NOTIFICATION' | 'RECOVERY_RESUME_RESPONSE';
  providerTerminalRawMessage?: import('./agent').AgentProtocolMessageReference;
  startedAt: string;
  lastEventAt?: string;
  endedAt?: string;
  finalArtifactId?: string;
  eventCount: number;
  lastEventType?: string;
  finalMessage?: string;
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
  canceledCount: number;
  checkDetails: GitHubCheckDetailRecord[];
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
  agentSessionId?: string;
  serverInstanceId?: string;
  agentItemId?: string;
  interactionRequestId?: string;
  worktreeId?: string;
  previewPlanId?: string;
  previewGenerationId?: string;
  source:
    | 'ui'
    | 'provider'
    | 'process'
    | 'storage'
    | 'repository'
    | 'projection'
    | 'git'
    | 'github'
    | 'prompt'
    | 'preview';
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
  schemaVersion: typeof TASK_STORE_SCHEMA_VERSION;
  tasks: Task[];
  iterations: TaskIteration[];
  worktrees: WorktreeRecord[];
  gitSnapshots: GitSnapshotRecord[];
  githubRepositories: GitHubRepositoryRecord[];
  branchPublications: BranchPublicationRecord[];
  pullRequests: PullRequestSnapshotRecord[];
  ciRollups: CiRollupRecord[];
  reviewRollups: ReviewRollupRecord[];
  mergeSnapshots: MergeSnapshotRecord[];
  runs: RunRecord[];
  agentServers: AgentServerInstance[];
  agentSessions: AgentSessionRecord[];
  agentItems: AgentItemRecord[];
  agentGoalSnapshots: AgentGoalSnapshotRecord[];
  agentPlanRevisions: AgentPlanRevisionRecord[];
  agentUsageSnapshots: AgentUsageSnapshotRecord[];
  agentSettingsObservations: AgentSettingsObservationRecord[];
  agentSubagentObservations: AgentSubagentObservationRecord[];
  interactionRequests: InteractionRequestRecord[];
  previewPlans: PreviewPlanRecord[];
  previewApprovals: PreviewApprovalRecord[];
  previewGenerations: PreviewGenerationRecord[];
  previewNodeAttempts: PreviewNodeAttemptRecord[];
  previewResources: PreviewResourceRecord[];
  events: DomainEvent[];
  artifacts: ArtifactRecord[];
}

export interface CreateTaskRequest {
  title: string;
  prompt: string;
  repositoryPath: string;
  completionPolicy?: CompletionPolicy;
  agentSettings?: AgentExecutionSettings;
}

export interface StartRunRequest {
  taskId: string;
  mode?: AgentRunMode;
  settings?: AgentExecutionSettings;
}

export interface CancelRunRequest {
  runId: string;
}

export interface SteerRunRequest {
  taskId: string;
  runId: string;
  instruction: string;
}

export interface ContinueRunRequest {
  taskId: string;
  runId: string;
  instruction?: string;
  settings?: AgentExecutionSettings;
}

export interface RetryRunRequest {
  taskId: string;
  runId: string;
  strategy: AgentRetryStrategy;
  instruction?: string;
  settings?: AgentExecutionSettings;
}

export interface StartReviewRequest {
  taskId: string;
  runId?: string;
  target?: AgentReviewTarget;
  settings?: AgentExecutionSettings;
}

export interface SyncAgentGoalRequest {
  taskId: string;
  sessionId: string;
}

export interface RespondToInteractionRequest {
  taskId: string;
  runId: string;
  interactionRequestId: string;
  decision: import('./agent').AgentInteractionDecision;
}

export interface PrepareWorktreeRequest {
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

export interface DeleteTaskRequest {
  taskId: string;
  removeWorktree?: boolean;
}

export interface DeleteTaskResult {
  taskId: string;
  removedWorktree: boolean;
}

export interface ReadArtifactRequest {
  artifactId: string;
}

export interface ReadProtocolMessageRequest {
  reference: import('./agent').AgentProtocolMessageReference;
}

export interface ProtocolMessageRecord {
  raw: string;
  metadata?: Record<string, unknown>;
}

export interface RefinePromptRequest {
  repositoryPath: string;
  input: string;
  model?: string;
}

export interface RefinePromptResponse {
  prompt: string;
  titleSuggestion: string;
  source: 'model' | 'deterministic-fallback';
}

export interface UpdateAppSettingsRequest {
  theme?: import('./agent').TaskManagerThemePreference;
  sidebarCollapsed?: boolean;
  showMascot?: boolean;
  firstLaunchSetupCompleted?: boolean;
  defaultModel?: string | null;
  defaultReasoningEffort?: string | null;
  promptRefinementModel?: string | null;
  reviewModel?: string | null;
  reviewReasoningEffort?: string | null;
  codexExternalTools?: Partial<import('./agent').CodexExternalToolSettings>;
  externalExecutables?: Partial<import('./agent').ExternalExecutablePathSettings>;
  repositories?: Partial<import('./agent').TaskManagerRepositorySettings>;
  previewGateway?: Partial<import('./agent').PreviewGatewaySettings>;
}

export type ExternalToolId = 'git' | 'codex' | 'gh';
export type ExternalToolResolutionSource = 'env' | 'override' | 'settings' | 'auto';
export type ExternalToolProbeStatus = 'ok' | 'error';

export interface ExternalToolProbeResult {
  tool: ExternalToolId;
  label: string;
  required: boolean;
  source: ExternalToolResolutionSource;
  configuredPath: string | null;
  executable: string;
  resolvedPath: string | null;
  status: ExternalToolProbeStatus;
  version: string | null;
  error: string | null;
}

export interface ExternalToolStatusReport {
  tools: Record<ExternalToolId, ExternalToolProbeResult>;
  refreshedAt: string;
}

export interface TestExternalToolRequest {
  tool: ExternalToolId;
  executablePath?: string | null;
}

export type OpenTargetAppId =
  | 'vscode'
  | 'vscode-insiders'
  | 'cursor'
  | 'windsurf'
  | 'sublime'
  | 'intellij-idea'
  | 'xcode'
  | 'default';

export type OpenTargetAppIcon = { kind: 'image'; dataUrl: string };

export interface OpenTargetDetectedApp {
  id: OpenTargetAppId;
  label: string;
  icon?: OpenTargetAppIcon;
}

export type OpenTargetRef =
  | {
      type: 'repository';
      repositoryPath: string;
    }
  | {
      type: 'worktree';
      worktreeId: string;
      taskId?: string;
    }
  | {
      type: 'worktreeFile';
      worktreeId: string;
      relativePath: string;
      taskId?: string;
      line?: number;
      column?: number;
    };

export interface InspectOpenTargetRequest {
  target: OpenTargetRef;
}

export interface OpenTargetInspection {
  target: {
    type: OpenTargetRef['type'];
    kind: 'file' | 'directory' | 'other' | 'missing';
  };
  apps: OpenTargetDetectedApp[];
  preferredAppId: OpenTargetAppId;
  revealLabel: string;
  canOpen: boolean;
  canReveal: boolean;
  canOpenTerminal: boolean;
  canCopyFileContents: boolean;
  copyFileContentsDisabledReason?: string;
  disabledReason?: string;
}

export type OpenTargetAction =
  | 'open'
  | 'reveal'
  | 'openTerminal'
  | 'copyPath'
  | 'copyFileContents';

export interface ExecuteOpenTargetActionRequest {
  target: OpenTargetRef;
  action: OpenTargetAction;
  appId?: OpenTargetAppId;
}

export interface OpenTargetActionResult {
  ok: boolean;
  message?: string;
  clipboardText?: string;
}

export interface GitHubPreflightRequest {
  taskId: string;
}

export interface PublishBranchRequest {
  taskId: string;
}

export interface CreatePullRequestRequest {
  taskId: string;
  title?: string;
}

export interface RefreshGitHubRequest {
  taskId: string;
}

export interface AppUpdateEvent {
  type:
    | 'task.updated'
    | 'run.started'
    | 'run.output'
    | 'run.activity'
    | 'agent.goal.updated'
    | 'run.diagnostic'
    | 'run.terminal'
    | 'interaction.updated'
    | 'worktree.updated'
    | 'git.updated'
    | 'github.updated'
    | 'prompt.refined'
    | 'provider.updated'
    | 'projection.updated'
    | 'finding.updated'
    | 'preview.updated'
    | 'preview.log.updated'
    | 'task.deleted';
  taskId: string;
  iterationId?: string;
  runId?: string;
  worktreeId?: string;
  previewGenerationId?: string;
  payload: unknown;
  at: string;
}

export interface TaskManagerApi {
  getDefaultRepositoryPath(): Promise<string>;
  chooseRepositoryFolder(): Promise<string | undefined>;
  validateRepository(path: string): Promise<RepositoryPreflight>;
  getAppSettings(): Promise<import('./agent').TaskManagerAppSettings>;
  updateAppSettings(
    input: UpdateAppSettingsRequest
  ): Promise<import('./agent').TaskManagerAppSettings>;
  getExternalToolStatus(): Promise<ExternalToolStatusReport>;
  testExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  inspectOpenTarget(input: InspectOpenTargetRequest): Promise<OpenTargetInspection>;
  executeOpenTargetAction(
    input: ExecuteOpenTargetActionRequest
  ): Promise<OpenTargetActionResult>;
  getAgentProviderState(): Promise<import('./agent').AgentProviderState>;
  listTasks(): Promise<TaskSnapshot>;
  createTask(input: CreateTaskRequest): Promise<Task>;
  refinePrompt(input: RefinePromptRequest): Promise<RefinePromptResponse>;
  prepareWorktree(input: PrepareWorktreeRequest): Promise<WorktreeRecord>;
  startRun(input: StartRunRequest): Promise<RunRecord>;
  steerRun(input: SteerRunRequest): Promise<void>;
  continueRun(input: ContinueRunRequest): Promise<RunRecord>;
  retryRun(input: RetryRunRequest): Promise<RunRecord>;
  startReview(input: StartReviewRequest): Promise<RunRecord>;
  syncAgentGoal(input: SyncAgentGoalRequest): Promise<AgentGoalSnapshotRecord>;
  cancelRun(input: CancelRunRequest): Promise<void>;
  respondToInteraction(
    input: RespondToInteractionRequest
  ): Promise<InteractionRequestRecord>;
  refreshEvidence(input: RefreshEvidenceRequest): Promise<GitSnapshotRecord>;
  createDeliveryCommit(input: CreateDeliveryCommitRequest): Promise<GitSnapshotRecord>;
  preflightGitHub(input: GitHubPreflightRequest): Promise<GitHubRepositoryRecord>;
  publishBranch(input: PublishBranchRequest): Promise<BranchPublicationRecord>;
  createPullRequest(input: CreatePullRequestRequest): Promise<PullRequestSnapshotRecord>;
  refreshGitHub(input: RefreshGitHubRequest): Promise<PullRequestSnapshotRecord | undefined>;
  resolvePreview(input: ResolvePreviewRequest): Promise<ResolvePreviewResult>;
  approvePreviewPlan(input: ApprovePreviewPlanRequest): Promise<PreviewApprovalRecord>;
  startPreview(input: StartPreviewRequest): Promise<PreviewGenerationRecord>;
  stopPreview(input: StopPreviewRequest): Promise<PreviewGenerationRecord>;
  openPreview(input: OpenPreviewRequest): Promise<OpenPreviewResult>;
  readPreviewLog(input: ReadPreviewLogRequest): Promise<ReadPreviewLogResult>;
  resetPreviewData(input: ResetPreviewDataRequest): Promise<PreviewGenerationRecord>;
  transitionTask(input: TransitionTaskRequest): Promise<Task>;
  deleteTask(input: DeleteTaskRequest): Promise<DeleteTaskResult>;
  readArtifact(input: ReadArtifactRequest): Promise<string>;
  readProtocolMessage(
    input: ReadProtocolMessageRequest
  ): Promise<ProtocolMessageRecord>;
  onUpdate(listener: (event: AppUpdateEvent) => void): () => void;
}

export function createInitialProjection(now: string): StatusProjection {
  return {
    requestedAction: 'NONE',
    agentRun: 'IDLE',
    osProcess: 'UNKNOWN',
    repositoryPreflight: 'UNKNOWN',
    worktree: 'NOT_CREATED',
    git: 'NOT_INSPECTED',
    githubRepository: 'NOT_CHECKED',
    branchPublication: 'NOT_PUSHED',
    githubPullRequest: 'UNLINKED',
    ciChecks: 'NOT_APPLICABLE',
    reviews: 'NOT_APPLICABLE',
    codexReview: { status: 'NOT_RUN' },
    merge: 'NOT_APPLICABLE',
    artifact: 'NONE',
    health: 'INFO',
    summary: 'Ready for isolated implementation.',
    findings: [],
    updatedAt: now
  };
}
