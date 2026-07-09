import type {
  AgentRunMode,
  CiChecksStatus,
  DomainEvent,
  GitStatus,
  MergeStatus,
  PullRequestStatus,
  ReviewStatus,
  RunRecord,
  Task,
  WorktreeStatus
} from '../../shared/contracts';

export type TaskActivityActor =
  | 'User'
  | 'Task Monki'
  | 'Agent'
  | 'Review'
  | 'Git'
  | 'GitHub';

export type TaskActivityTone = 'neutral' | 'info' | 'action' | 'success' | 'error';

export type TaskActivityCategory =
  | 'workflow'
  | 'run'
  | 'review'
  | 'git'
  | 'delivery'
  | 'risk';

export interface TaskActivityItem {
  id: string;
  at: string;
  actor: TaskActivityActor;
  title: string;
  tone: TaskActivityTone;
  category: TaskActivityCategory;
  evidence?: TaskActivityEvidence;
  provenance?: {
    eventId?: string;
    runId?: string;
    recordId?: string;
    artifactId?: string;
  };
}

export interface TaskActivityEvidence {
  summary: string;
  rows?: TaskActivityEvidenceRow[];
}

export interface TaskActivityEvidenceRow {
  label: string;
  value?: string;
  href?: string;
}

export interface TaskActivityViewModel {
  items: TaskActivityItem[];
  hiddenCount: number;
  totalCount: number;
}

export interface TaskActivityInput {
  task?: Task;
  events: DomainEvent[];
  runs?: RunRecord[];
}

export interface OverviewTaskActivityInput extends TaskActivityInput {
  task: Task;
  limit?: number;
}

interface BuiltTaskActivityItem extends TaskActivityItem {
  order: number;
  replaceKey?: string;
}

interface TaskActivityCandidate extends TaskActivityItem {
  replaceKey?: string;
}

interface TaskActivityBuildState {
  lastGitSnapshotSignature?: string;
  lastGitStatus?: GitStatus;
  lastBranchPublicationSignature?: string;
  lastPullRequest?: {
    signature: string;
    status?: PullRequestStatus;
    isDraft?: boolean;
  };
  lastCiSignature?: string;
  lastReviewSignature?: string;
  lastMerge?: {
    signature: string;
    status?: MergeStatus;
  };
  lastGithubFailureSignature?: string;
}

const DEFAULT_LIMIT = 5;
const TERMINAL_RUN_EVENT_TYPES = new Set<DomainEvent['type']>([
  'AGENT_RUN_COMPLETED',
  'AGENT_RUN_FAILED',
  'AGENT_RUN_INTERRUPTED'
]);
const TERMINAL_RUN_STATUSES = new Set<RunRecord['status']>([
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
  'LOST'
]);

/**
 * Builds the canonical renderer activity ledger for a task. It is intentionally
 * richer than any single surface: Overview and Debug should filter this output
 * instead of reinterpreting domain events independently.
 */
export function buildTaskActivityLedger(input: TaskActivityInput): TaskActivityItem[] {
  const built = buildTaskActivityItems(input);
  return built.map(stripOrder);
}

export function buildOverviewTaskActivityViewModel(
  input: OverviewTaskActivityInput
): TaskActivityViewModel {
  return projectOverviewTaskActivity(buildTaskActivityLedger(input), { limit: input.limit });
}

export function buildDebugTaskActivityViewModel(input: TaskActivityInput): TaskActivityViewModel {
  return projectDebugTaskActivity(buildTaskActivityLedger(input));
}

export function projectOverviewTaskActivity(
  ledger: TaskActivityItem[],
  options: { limit?: number } = {}
): TaskActivityViewModel {
  const items = collapseAdjacentOverviewDuplicates(ledger.filter(isOverviewActivityItem));
  if (items.length === 0) {
    return emptyView();
  }

  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const visible = items.slice(-limit);
  return {
    items: visible,
    hiddenCount: Math.max(0, items.length - visible.length),
    totalCount: items.length
  };
}

function collapseAdjacentOverviewDuplicates(items: TaskActivityItem[]): TaskActivityItem[] {
  const collapsed: TaskActivityItem[] = [];
  for (const item of items) {
    const previous = collapsed.at(-1);
    if (previous && isDuplicateOverviewActivity(previous, item)) {
      collapsed[collapsed.length - 1] = item;
    } else {
      collapsed.push(item);
    }
  }
  return collapsed;
}

function isDuplicateOverviewActivity(a: TaskActivityItem, b: TaskActivityItem): boolean {
  return (
    ['run', 'review'].includes(a.category) &&
    a.actor === b.actor &&
    a.title === b.title &&
    a.category === b.category &&
    a.tone === b.tone &&
    !a.evidence &&
    !b.evidence
  );
}

export function projectDebugTaskActivity(ledger: TaskActivityItem[]): TaskActivityViewModel {
  return {
    items: ledger,
    hiddenCount: 0,
    totalCount: ledger.length
  };
}

function buildTaskActivityItems(
  input: TaskActivityInput
): BuiltTaskActivityItem[] {
  const runById = new Map((input.runs ?? []).map((run) => [run.id, run]));
  const terminalRunIds = terminalRunIdsFor(input.events, input.runs ?? []);
  const state: TaskActivityBuildState = {};
  const items: BuiltTaskActivityItem[] = [];
  let order = 0;

  const events = input.events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => compareTimeAscending(a.event.receivedAt, b.event.receivedAt) || a.index - b.index);

  for (const { event } of events) {
    const candidate = itemForEvent(event, runById, terminalRunIds, state);
    if (candidate) {
      order = appendOrReplaceHistoryItem(items, candidate, order);
    }
  }

  const staleReview = input.task ? currentStaleReviewItem(input.task) : undefined;
  if (staleReview) {
    items.push({ ...staleReview, order });
  }

  return items.sort((a, b) => compareTimeAscending(a.at, b.at) || a.order - b.order);
}

function itemForEvent(
  event: DomainEvent,
  runById: Map<string, RunRecord>,
  terminalRunIds: Set<string>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const payload = objectPayload(event.payload);
  const run = event.runId ? runById.get(event.runId) : undefined;
  const mode = (stringField(payload, 'mode') as AgentRunMode | undefined) ?? run?.mode;

  switch (event.type) {
    case 'TASK_CREATED':
      return item(event, 'workflow', 'User', 'Task created', undefined, 'info');
    case 'WORKTREE_CREATED':
      return item(
        event,
        'workflow',
        'Task Monki',
        'Worktree ready',
        undefined,
        'success'
      );
    case 'WORKTREE_VERIFIED':
      return worktreeVerificationItem(event, payload);
    case 'WORKTREE_FAILED':
      return item(
        event,
        'risk',
        'Task Monki',
        'Worktree preparation failed',
        evidence(
          'Fix the worktree before running or reviewing this task.',
          evidenceRows(stringField(payload, 'error'))
        ),
        'error'
      );
    case 'AGENT_RUN_STARTED':
      if (event.runId && terminalRunIds.has(event.runId)) {
        return undefined;
      }
      return runStartedItem(event, mode, payload);
    case 'AGENT_RUN_COMPLETED':
      return runCompletedItem(event, run?.mode ?? mode, payload);
    case 'AGENT_RUN_FAILED':
      return runFailedItem(event, run?.mode ?? mode, payload);
    case 'AGENT_RUN_INTERRUPTED':
      return runInterruptedItem(event, run?.mode ?? mode, payload);
    case 'CANCEL_REQUESTED':
      if (event.runId && terminalRunIds.has(event.runId)) {
        return undefined;
      }
      return item(
        event,
        runCategory(run?.mode ?? mode),
        'User',
        run?.mode === 'REVIEW' || mode === 'REVIEW' ? 'Stop review requested' : 'Stop requested',
        undefined,
        'action'
      );
    case 'AGENT_INTERACTION_REQUESTED':
      return item(
        event,
        'run',
        'Agent',
        'Agent needs input',
        evidence('Respond before the run can continue.', evidenceRows(interactionDetail(payload))),
        'action'
      );
    case 'GIT_SNAPSHOT_CAPTURED':
      return gitSnapshotItem(event, payload, state);
    case 'DELIVERY_COMMIT_CREATED':
      return item(
        event,
        'git',
        'Git',
        'Commit created',
        commitEvidence(payload),
        'success'
      );
    case 'BRANCH_PUBLISHED':
      return branchPublishedItem(event, payload, state);
    case 'BRANCH_PUBLISH_FAILED':
      return branchPublishFailedItem(event, payload, state);
    case 'PR_SNAPSHOT_CAPTURED':
      return pullRequestItem(event, payload, state);
    case 'CI_ROLLUP_CAPTURED':
      return ciRollupItem(event, payload, state);
    case 'REVIEW_ROLLUP_CAPTURED':
      return githubReviewItem(event, payload, state);
    case 'MERGE_SNAPSHOT_CAPTURED':
      return mergeItem(event, payload, state);
    case 'GITHUB_SYNC_FAILED':
      return githubFailureItem(event, payload, state);
    case 'TRANSITION_COMPLETED':
      return transitionCompletedItem(event, payload);
    case 'TRANSITION_BLOCKED':
      return item(
        event,
        'workflow',
        'Task Monki',
        'Transition blocked',
        transitionBlockedEvidence(payload),
        'error'
      );
    case 'AGENT_REVIEW_POLICY_VIOLATION':
      return item(
        event,
        'risk',
        'Task Monki',
        'Review changed Git state',
        evidence('Review output cannot be accepted as detached review evidence.'),
        'error'
      );
    case 'AGENT_RUNTIME_LOST':
      return item(
        event,
        'risk',
        'Task Monki',
        'Agent runtime lost',
        evidence('Resolve recovery before continuing this task.', evidenceRows(stringField(payload, 'reason'))),
        'error'
      );
    case 'AGENT_RUNTIME_RECONCILED':
      return runtimeReconciledItem(event, payload);
    default:
      return undefined;
  }
}

function runStartedItem(
  event: DomainEvent,
  mode: AgentRunMode | undefined,
  payload: Record<string, unknown>
): TaskActivityCandidate {
  switch (mode) {
    case 'REVIEW':
      return item(
        event,
        'review',
        'Review',
        'Review started',
        reviewStartedEvidence(payload),
        'info'
      );
    case 'FOLLOW_UP':
      return item(
        event,
        'run',
        'Agent',
        'Follow-up implementation started',
        undefined,
        'action'
      );
    case 'RETRY':
      return item(event, 'run', 'Agent', 'Retry started', undefined, 'action');
    default:
      return item(
        event,
        'run',
        'Agent',
        'Implementation started',
        undefined,
        'action'
      );
  }
}

function runCompletedItem(
  event: DomainEvent,
  mode: AgentRunMode | undefined,
  payload: Record<string, unknown>
): TaskActivityCandidate {
  if (mode === 'REVIEW') {
    const reviewStatus = stringField(payload, 'codexReviewStatus');

    switch (reviewStatus) {
      case 'PASSED':
        return item(
          event,
          'review',
          'Review',
          'Review passed',
          undefined,
          'success'
        );
      case 'NEEDS_CHANGES':
        return item(
          event,
          'review',
          'Review',
          'Review requested changes',
          undefined,
          'action'
        );
      case 'INCONCLUSIVE':
        return item(
          event,
          'review',
          'Review',
          'Review inconclusive',
          undefined,
          'action'
        );
      default:
        return item(
          event,
          'review',
          'Review',
          'Review completed',
          undefined,
          'success'
        );
    }
  }

  if (mode === 'FOLLOW_UP') {
    return item(
      event,
      'run',
      'Agent',
      'Follow-up implementation completed',
      undefined,
      'success'
    );
  }
  if (mode === 'RETRY') {
    return item(event, 'run', 'Agent', 'Retry completed', undefined, 'success');
  }
  return item(
    event,
    'run',
    'Agent',
    'Implementation completed',
    undefined,
    'success'
  );
}

function runFailedItem(
  event: DomainEvent,
  mode: AgentRunMode | undefined,
  payload: Record<string, unknown>
): TaskActivityCandidate {
  const error = stringField(payload, 'error') ?? stringField(payload, 'terminalReason');
  const title =
    mode === 'REVIEW'
      ? 'Review failed'
      : mode === 'FOLLOW_UP'
        ? 'Follow-up implementation failed'
        : 'Implementation failed';
  return item(
    event,
    mode === 'REVIEW' ? 'review' : 'run',
    mode === 'REVIEW' ? 'Review' : 'Agent',
    title,
    evidence(
      mode === 'REVIEW'
        ? 'Run review again after the failure is resolved.'
        : 'Continue or retry before this task can advance.',
      evidenceRows(error)
    ),
    'error'
  );
}

function runInterruptedItem(
  event: DomainEvent,
  mode: AgentRunMode | undefined,
  payload: Record<string, unknown>
): TaskActivityCandidate {
  const title =
    mode === 'REVIEW'
      ? 'Review stopped'
      : mode === 'FOLLOW_UP'
        ? 'Follow-up implementation stopped'
        : 'Implementation stopped';
  return item(
    event,
    mode === 'REVIEW' ? 'review' : 'run',
    mode === 'REVIEW' ? 'Review' : 'Agent',
    title,
    evidence('Run stopped before it completed.', evidenceRows(stringField(payload, 'terminalReason'))),
    'action'
  );
}

function gitSnapshotItem(
  event: DomainEvent,
  payload: Record<string, unknown>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const signature = gitSnapshotSignature(payload);
  const status = stringField(payload, 'status') as GitStatus | undefined;
  if (signature === state.lastGitSnapshotSignature) {
    return undefined;
  }
  const previousStatus = state.lastGitStatus;
  state.lastGitSnapshotSignature = signature;
  state.lastGitStatus = status;

  switch (status) {
    case 'CLEAN':
      if (!previousStatus) {
        return undefined;
      }
      return item(event, 'git', 'Git', 'Worktree clean', undefined, 'neutral');
    case 'DIRTY':
      return item(event, 'git', 'Git', 'Working changes captured', undefined, 'info');
    case 'COMMITTED_UNPUSHED':
      return item(event, 'git', 'Git', 'Commit ready to push', commitEvidence(payload), 'info');
    case 'PUSHED':
      return undefined;
    case 'CONFLICTED':
      return item(
        event,
        'git',
        'Git',
        'Git conflicts detected',
        evidence(
          'Resolve conflicts before review or delivery can proceed.',
          gitCountEvidenceRows(payload)
        ),
        'error'
      );
    case 'DIVERGED':
      return item(
        event,
        'git',
        'Git',
        'Branch diverged',
        evidence('Reconcile the local branch before delivery can proceed.', branchDivergenceRows(payload)),
        'error'
      );
    case 'UNAVAILABLE':
      return item(
        event,
        'git',
        'Git',
        'Git evidence unavailable',
        evidence('Refresh local Git evidence before using workflow or delivery decisions.'),
        'error'
      );
    default:
      return undefined;
  }
}

function branchPublishedItem(
  event: DomainEvent,
  payload: Record<string, unknown>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const signature = [
    stringField(payload, 'branchName') ?? '',
    stringField(payload, 'remoteRef') ?? '',
    stringField(payload, 'headSha') ?? ''
  ].join(':');
  if (signature === state.lastBranchPublicationSignature) {
    return undefined;
  }
  state.lastBranchPublicationSignature = signature;
  return item(
    event,
    'delivery',
    'GitHub',
    'Branch pushed',
    undefined,
    'success'
  );
}

function branchPublishFailedItem(
  event: DomainEvent,
  payload: Record<string, unknown>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const signature = [
    stringField(payload, 'branchName') ?? '',
    stringField(payload, 'remoteRef') ?? '',
    stringField(payload, 'headSha') ?? '',
    stringField(payload, 'error') ?? ''
  ].join(':');
  if (signature === state.lastBranchPublicationSignature) {
    return undefined;
  }
  state.lastBranchPublicationSignature = signature;
  return item(
    event,
    'delivery',
    'GitHub',
    'Branch push failed',
    evidence('PR delivery cannot update until the branch push succeeds.', evidenceRows(stringField(payload, 'error'))),
    'error'
  );
}

function pullRequestItem(
  event: DomainEvent,
  payload: Record<string, unknown>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const status = stringField(payload, 'status') as PullRequestStatus | undefined;
  const isDraft = booleanField(payload, 'isDraft');
  const signature = [
    numberField(payload, 'number') ?? '',
    stringField(payload, 'url') ?? '',
    status ?? '',
    isDraft === undefined ? '' : String(isDraft)
  ].join(':');
  const previous = state.lastPullRequest;
  if (signature === previous?.signature) {
    return undefined;
  }
  state.lastPullRequest = { signature, status, isDraft };

  if (!numberField(payload, 'number') && !stringField(payload, 'url')) {
    return undefined;
  }

  if (!previous) {
    if (status === 'OPEN_DRAFT' || isDraft) {
      return item(
        event,
        'delivery',
        'GitHub',
        'Draft PR available',
        undefined,
        'info'
      );
    }
    if (status === 'OPEN_READY') {
      return item(event, 'delivery', 'GitHub', 'PR available', undefined, 'info');
    }
  }

  if (
    previous &&
    (previous.status === 'OPEN_DRAFT' || previous.isDraft) &&
    (status === 'OPEN_READY' || isDraft === false)
  ) {
    return item(event, 'delivery', 'GitHub', 'PR marked ready', undefined, 'success');
  }
  if (status === 'CLOSED_UNMERGED') {
    return item(
      event,
      'delivery',
      'GitHub',
      'PR closed without merge',
      evidence('Delivery is not complete because the PR closed without merge.', prEvidenceRows(payload)),
      'error',
      { replaceKey: terminalPrReplaceKey(payload, status) }
    );
  }
  if (status === 'MERGED') {
    return item(event, 'delivery', 'GitHub', 'PR merged', undefined, 'success', {
      replaceKey: terminalPrReplaceKey(payload, status)
    });
  }
  return undefined;
}

function ciRollupItem(
  event: DomainEvent,
  payload: Record<string, unknown>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const status = stringField(payload, 'status') as CiChecksStatus | undefined;
  const signature = ciRollupSignature(payload, status);
  if (signature === state.lastCiSignature) {
    return undefined;
  }
  state.lastCiSignature = signature;
  const replaceKey = `ci:${ciRollupCoreSignature(payload, status)}`;

  switch (status) {
    case 'PENDING':
      return item(event, 'delivery', 'GitHub', 'Checks running', undefined, 'action', {
        replaceKey
      });
    case 'PASSING':
      return item(event, 'delivery', 'GitHub', 'Checks passed', undefined, 'success', {
        replaceKey
      });
    case 'FAILING':
    case 'BLOCKED':
      return item(
        event,
        'delivery',
        'GitHub',
        'Checks failed',
        failedCheckEvidence(payload, status),
        'error',
        { replaceKey }
      );
    case 'CANCELED':
      return item(
        event,
        'delivery',
        'GitHub',
        'Checks canceled',
        canceledCheckEvidence(payload),
        'action',
        { replaceKey }
      );
    case 'STALE':
      return item(
        event,
        'delivery',
        'Task Monki',
        'Check evidence is stale',
        evidence('Refresh GitHub evidence before using checks for PR readiness.'),
        'action',
        { replaceKey }
      );
    default:
      return undefined;
  }
}

function githubReviewItem(
  event: DomainEvent,
  payload: Record<string, unknown>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const status = stringField(payload, 'status') as ReviewStatus | undefined;
  const signature = [
    numberField(payload, 'pullRequestNumber') ?? '',
    stringField(payload, 'headSha') ?? '',
    status ?? '',
    stringField(payload, 'reviewDecision') ?? ''
  ].join(':');
  if (signature === state.lastReviewSignature) {
    return undefined;
  }
  state.lastReviewSignature = signature;

  switch (status) {
    case 'REQUESTED':
      return item(
        event,
        'delivery',
        'GitHub',
        'GitHub review requested',
        undefined,
        'action'
      );
    case 'PENDING':
      return item(
        event,
        'delivery',
        'GitHub',
        'GitHub review pending',
        undefined,
        'action'
      );
    case 'CHANGES_REQUESTED':
      return item(
        event,
        'delivery',
        'GitHub',
        'GitHub requested changes',
        evidence(
          'Blocks PR approval until the requested changes are addressed.',
          prEvidenceRows(payload)
        ),
        'error'
      );
    case 'APPROVED':
    case 'SATISFIED':
      return item(
        event,
        'delivery',
        'GitHub',
        'GitHub review approved',
        undefined,
        'success'
      );
    case 'STALE':
      return item(
        event,
        'delivery',
        'Task Monki',
        'GitHub review evidence is stale',
        evidence('Refresh GitHub review evidence before using approval as current.', prEvidenceRows(payload)),
        'action'
      );
    default:
      return undefined;
  }
}

function mergeItem(
  event: DomainEvent,
  payload: Record<string, unknown>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const status = stringField(payload, 'status') as MergeStatus | undefined;
  const signature = [
    numberField(payload, 'pullRequestNumber') ?? '',
    stringField(payload, 'headSha') ?? '',
    status ?? '',
    stringField(payload, 'mergedAt') ?? ''
  ].join(':');
  const previous = state.lastMerge;
  if (signature === previous?.signature) {
    return undefined;
  }
  state.lastMerge = { signature, status };

  switch (status) {
    case 'MERGED':
      return item(event, 'delivery', 'GitHub', 'PR merged', undefined, 'success', {
        replaceKey: terminalPrReplaceKey(payload, status)
      });
    case 'CLOSED_UNMERGED':
      return item(
        event,
        'delivery',
        'GitHub',
        'PR closed without merge',
        evidence('Delivery is not complete because the PR closed without merge.', prEvidenceRows(payload)),
        'error',
        { replaceKey: terminalPrReplaceKey(payload, status) }
      );
    case 'BLOCKED':
      return item(
        event,
        'delivery',
        'GitHub',
        'Merge blocked',
        evidence('Merge cannot complete until GitHub requirements are satisfied.', prEvidenceRows(payload)),
        'error'
      );
    case 'QUEUED':
      return item(event, 'delivery', 'GitHub', 'Merge queued', undefined, 'action');
    case 'MERGEABLE':
      if (previous?.status === 'BLOCKED') {
        return item(
          event,
          'delivery',
          'GitHub',
          'Merge unblocked',
          undefined,
          'success'
        );
      }
      return undefined;
    default:
      return undefined;
  }
}

function githubFailureItem(
  event: DomainEvent,
  payload: Record<string, unknown>,
  state: TaskActivityBuildState
): TaskActivityCandidate | undefined {
  const signature = stringField(payload, 'error') ?? 'github-failure';
  if (signature === state.lastGithubFailureSignature) {
    return undefined;
  }
  state.lastGithubFailureSignature = signature;
  return item(
    event,
    'delivery',
    'GitHub',
    'Could not update GitHub evidence',
    evidence('PR Status may be stale until GitHub evidence updates.', evidenceRows(stringField(payload, 'error'))),
    'error'
  );
}

function transitionCompletedItem(
  event: DomainEvent,
  payload: Record<string, unknown>
): TaskActivityCandidate | undefined {
  const toPhase = stringField(payload, 'toPhase');
  switch (toPhase) {
    case 'REVIEW':
      return item(event, 'workflow', 'User', 'Moved to review', undefined, 'info');
    case 'DONE':
      return item(event, 'workflow', 'User', 'Task marked done', undefined, 'success');
    case 'BLOCKED':
      return item(
        event,
        'workflow',
        'User',
        'Task marked blocked',
        evidence('Task owner marked this task blocked.', evidenceRows(stringField(payload, 'reason'))),
        'error'
      );
    case 'CANCELED':
      return item(
        event,
        'workflow',
        'User',
        'Task canceled',
        evidence('Task owner canceled this task.', evidenceRows(stringField(payload, 'reason'))),
        'action'
      );
    case 'ARCHIVED':
      return item(event, 'workflow', 'User', 'Task archived', undefined, 'neutral');
    default:
      return undefined;
  }
}

function runtimeReconciledItem(
  event: DomainEvent,
  payload: Record<string, unknown>
): TaskActivityCandidate | undefined {
  const recoveryState = stringField(payload, 'recoveryState');
  if (recoveryState === 'RECOVERED') {
    return item(
      event,
      'risk',
      'Task Monki',
      'Run recovered',
      undefined,
      'success'
    );
  }
  if (recoveryState === 'REQUIRES_USER_ACTION' || recoveryState === 'UNRECOVERABLE') {
    return item(
      event,
      'risk',
      'Task Monki',
      'Run needs recovery',
      evidence('Resolve recovery before continuing this task.', evidenceRows(stringField(payload, 'status'))),
      'error'
    );
  }
  return undefined;
}

function currentStaleReviewItem(task: Task): TaskActivityItem | undefined {
  const review = task.projection.codexReview;
  if (review?.status !== 'STALE') {
    return undefined;
  }
  const at = review.updatedAt ?? task.projection.updatedAt ?? task.updatedAt;
  return {
    id: `codex-review-stale:${review.runId ?? task.id}:${at}`,
    at,
    actor: 'Task Monki',
    title: 'Review is stale',
    tone: 'action',
    category: 'review',
    evidence: evidence('Run a fresh review before treating the review result as current.', [
      { label: 'Reason', value: 'The diff changed after the last review.' }
    ]),
    provenance: {
      runId: review.runId,
      artifactId: review.finalArtifactId
    }
  };
}

function worktreeVerificationItem(
  event: DomainEvent,
  payload: Record<string, unknown>
): TaskActivityCandidate | undefined {
  const status = stringField(payload, 'status') as WorktreeStatus | undefined;
  if (status === 'ERROR' || status === 'MISSING') {
    return item(
      event,
      'risk',
      'Task Monki',
      'Worktree needs attention',
      evidence(
        'Fix the worktree before running or reviewing this task.',
        evidenceRows(stringField(payload, 'error') ?? stringField(payload, 'worktreePath') ?? status)
      ),
      'error'
    );
  }
  return undefined;
}

function item(
  event: DomainEvent,
  category: TaskActivityCategory,
  actor: TaskActivityActor,
  title: string,
  itemEvidence: TaskActivityEvidence | undefined,
  tone: TaskActivityTone,
  options: { replaceKey?: string } = {}
): TaskActivityCandidate {
  const payload = objectPayload(event.payload);
  return {
    id: event.id,
    at: event.receivedAt,
    actor,
    title,
    tone,
    category,
    evidence: itemEvidence,
    replaceKey: options.replaceKey,
    provenance: {
      eventId: event.id,
      runId: event.runId,
      recordId: stringField(payload, 'id'),
      artifactId: stringField(payload, 'artifactId') ?? stringField(payload, 'finalArtifactId')
    }
  };
}

function evidence(
  summary: string,
  rows?: TaskActivityEvidenceRow[]
): TaskActivityEvidence {
  const filteredRows = rows?.filter((row) => row.label || row.value || row.href);
  return {
    summary,
    rows: filteredRows?.length ? filteredRows : undefined
  };
}

function evidenceRows(
  value: string | undefined,
  label = 'Reason'
): TaskActivityEvidenceRow[] | undefined {
  return value ? [{ label, value }] : undefined;
}

function appendOrReplaceHistoryItem(
  items: BuiltTaskActivityItem[],
  candidate: TaskActivityCandidate,
  order: number
): number {
  const existingIndex = candidate.replaceKey
    ? items.findIndex((item) => item.replaceKey === candidate.replaceKey)
    : -1;
  if (existingIndex >= 0) {
    items[existingIndex] = {
      ...candidate,
      order: items[existingIndex].order
    };
    return order;
  }
  items.push({ ...candidate, order });
  return order + 1;
}

function terminalRunIdsFor(events: DomainEvent[], runs: RunRecord[]): Set<string> {
  const ids = new Set(
    runs.filter((run) => TERMINAL_RUN_STATUSES.has(run.status)).map((run) => run.id)
  );
  for (const event of events) {
    if (event.runId && TERMINAL_RUN_EVENT_TYPES.has(event.type)) {
      ids.add(event.runId);
    }
    if (
      event.runId &&
      event.type === 'AGENT_RUNTIME_RECONCILED' &&
      booleanField(objectPayload(event.payload), 'terminal')
    ) {
      ids.add(event.runId);
    }
  }
  return ids;
}

function runCategory(mode: AgentRunMode | undefined): TaskActivityCategory {
  return mode === 'REVIEW' ? 'review' : 'run';
}

function interactionDetail(payload: Record<string, unknown>): string | undefined {
  const type = stringField(payload, 'type');
  return type ? humanizeEnum(type) : undefined;
}

function gitSnapshotSignature(payload: Record<string, unknown>): string {
  const dirtyFingerprint = stringField(payload, 'dirtyFingerprint');
  if (dirtyFingerprint) {
    return dirtyFingerprint;
  }
  return [
    stringField(payload, 'status') ?? '',
    stringField(payload, 'headSha') ?? '',
    numberField(payload, 'aheadCount') ?? 0,
    numberField(payload, 'behindCount') ?? 0,
    numberField(payload, 'workingDiffFileCount') ?? 0,
    numberField(payload, 'committedDiffFileCount') ?? 0,
    numberField(payload, 'stagedCount') ?? 0,
    numberField(payload, 'unstagedCount') ?? 0,
    numberField(payload, 'untrackedCount') ?? 0,
    numberField(payload, 'conflictedCount') ?? 0
  ].join(':');
}

function reviewStartedEvidence(payload: Record<string, unknown>): TaskActivityEvidence | undefined {
  const head = shortSha(stringField(payload, 'reviewedHeadSha'));
  return head
    ? evidence('Review is tied to stored Git evidence.', [{ label: 'Reviewed head', value: head }])
    : undefined;
}

function commitEvidence(payload: Record<string, unknown>): TaskActivityEvidence | undefined {
  const head = shortSha(stringField(payload, 'headSha'));
  const ahead = numberField(payload, 'aheadCount');
  const committed = numberField(payload, 'committedDiffFileCount');
  const rows: TaskActivityEvidenceRow[] = [];
  if (head) {
    rows.push({ label: 'HEAD', value: head });
  }
  if (ahead && ahead > 0) {
    rows.push({ label: 'Remote status', value: `${pluralize(ahead, 'commit')} ahead` });
  }
  if (committed && committed > 0) {
    rows.push({ label: 'Changed files', value: pluralize(committed, 'file') });
  }
  return rows.length ? evidence('Local Git evidence is ready for delivery.', rows) : undefined;
}

function gitCountEvidenceRows(payload: Record<string, unknown>): TaskActivityEvidenceRow[] | undefined {
  const rows: TaskActivityEvidenceRow[] = [];
  const conflicted = numberField(payload, 'conflictedCount') ?? 0;
  const working = numberField(payload, 'workingDiffFileCount');
  if (conflicted > 0) {
    rows.push({ label: 'Conflicts', value: pluralize(conflicted, 'file') });
  }
  if (working && working > 0 && working !== conflicted) {
    rows.push({ label: 'Working changes', value: pluralize(working, 'file') });
  }
  return rows.length ? rows : undefined;
}

function branchDivergenceRows(payload: Record<string, unknown>): TaskActivityEvidenceRow[] | undefined {
  const rows: TaskActivityEvidenceRow[] = [];
  const ahead = numberField(payload, 'aheadCount') ?? 0;
  const behind = numberField(payload, 'behindCount') ?? 0;
  if (ahead > 0) {
    rows.push({ label: 'Local branch', value: `${pluralize(ahead, 'commit')} ahead` });
  }
  if (behind > 0) {
    rows.push({ label: 'Remote branch', value: `${pluralize(behind, 'commit')} ahead` });
  }
  return rows.length ? rows : undefined;
}

function prEvidenceRows(payload: Record<string, unknown>): TaskActivityEvidenceRow[] | undefined {
  const rows: TaskActivityEvidenceRow[] = [];
  const number = numberField(payload, 'number') ?? numberField(payload, 'pullRequestNumber');
  const url = stringField(payload, 'url');
  const head = shortSha(stringField(payload, 'headSha') ?? stringField(payload, 'headRefOid'));
  if (number || url) {
    rows.push({ label: number ? `PR #${number}` : 'Pull request', href: url });
  }
  if (head) {
    rows.push({ label: 'Head', value: head });
  }
  return rows.length ? rows : undefined;
}

function ciRollupSignature(
  payload: Record<string, unknown>,
  status: CiChecksStatus | undefined
): string {
  return [
    ciRollupCoreSignature(payload, status),
    actionableCheckDetailsSignature(payload, status)
  ].join(':');
}

function ciRollupCoreSignature(
  payload: Record<string, unknown>,
  status: CiChecksStatus | undefined
): string {
  return [
    numberField(payload, 'pullRequestNumber') ?? '',
    stringField(payload, 'headSha') ?? '',
    status ?? '',
    numberField(payload, 'pendingCount') ?? 0,
    numberField(payload, 'passingCount') ?? 0,
    numberField(payload, 'failingCount') ?? 0,
    numberField(payload, 'canceledCount') ?? 0
  ].join(':');
}

function actionableCheckDetailsSignature(
  payload: Record<string, unknown>,
  status: CiChecksStatus | undefined
): string {
  const detailStatus =
    status === 'CANCELED' ? 'canceled' : status === 'FAILING' || status === 'BLOCKED' ? 'failed' : undefined;
  if (!detailStatus) {
    return '';
  }
  return checkDetails(payload)
    .filter((check) => stringField(check, 'status') === detailStatus)
    .map((check) =>
      [
        stringField(check, 'workflow') ?? '',
        stringField(check, 'name') ?? '',
        stringField(check, 'link') ?? '',
        stringField(check, 'state') ?? ''
      ].join('|')
    )
    .sort()
    .join(';');
}

function failedCheckEvidence(
  payload: Record<string, unknown>,
  status: CiChecksStatus
): TaskActivityEvidence {
  const rows = checkEvidenceRows(payload, 'failed', 'Blocks PR readiness') ?? [];
  const failedCount = Math.max(rows.length, numberField(payload, 'failingCount') ?? 0);
  if (status === 'BLOCKED' && failedCount === 0) {
    return evidence('Check execution is blocked; PR readiness is blocked.');
  }
  if (failedCount === 0) {
    return evidence('GitHub reports failing checks; PR readiness is blocked.');
  }
  return evidence(
    `${pluralize(failedCount, 'failed check')} ${failedCount === 1 ? 'blocks' : 'block'} PR readiness.`,
    rows
  );
}

function canceledCheckEvidence(payload: Record<string, unknown>): TaskActivityEvidence {
  const rows = checkEvidenceRows(payload, 'canceled', 'Needs rerun before PR readiness') ?? [];
  const canceledCount = Math.max(rows.length, numberField(payload, 'canceledCount') ?? 0);
  if (canceledCount === 0) {
    return evidence('GitHub checks were canceled; PR readiness is not current.');
  }
  return evidence(
    `${pluralize(canceledCount, 'canceled check')} ${
      canceledCount === 1 ? 'needs' : 'need'
    } rerun before PR readiness.`,
    rows
  );
}

function checkEvidenceRows(
  payload: Record<string, unknown>,
  status: string,
  decision: string
): TaskActivityEvidenceRow[] | undefined {
  const rows = checkDetails(payload)
    .filter((check) => stringField(check, 'status') === status)
    .map((check) => {
      const name = stringField(check, 'name') ?? 'Unnamed check';
      const workflow = stringField(check, 'workflow');
      const label = workflow && workflow !== name ? `${workflow} / ${name}` : name;
      return {
        label,
        value: decision,
        href: stringField(check, 'link')
      };
    });
  return rows.length ? rows : undefined;
}

function checkDetails(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = payload.checkDetails;
  return Array.isArray(value) ? value.map(objectPayload) : [];
}

function transitionBlockedEvidence(payload: Record<string, unknown>): TaskActivityEvidence {
  const phase = phaseLabel(payload);
  const summary =
    phase === 'Done'
      ? 'Blocks marking the task done.'
      : phase
        ? `Blocks moving to ${phase}.`
        : 'Blocks the requested workflow transition.';
  return evidence(summary, evidenceRows(stringField(payload, 'reason')));
}

function phaseLabel(payload: Record<string, unknown>): string | undefined {
  const phase = stringField(payload, 'toPhase');
  return phase ? humanizeEnum(phase) : undefined;
}

function terminalPrReplaceKey(payload: Record<string, unknown>, status: PullRequestStatus | MergeStatus): string {
  const number = numberField(payload, 'number') ?? numberField(payload, 'pullRequestNumber');
  return ['pr-terminal', status, number ?? stringField(payload, 'url') ?? ''].join(':');
}

function isTaskCreatedItem(item: TaskActivityItem): boolean {
  return item.title === 'Task created';
}

function isOverviewActivityItem(item: TaskActivityItem): boolean {
  return !isTaskCreatedItem(item);
}

function emptyView(): TaskActivityViewModel {
  return { items: [], hiddenCount: 0, totalCount: 0 };
}

function stripOrder(item: BuiltTaskActivityItem): TaskActivityItem {
  const { order: _order, replaceKey: _replaceKey, ...rest } = item;
  return rest;
}

function compareTimeAscending(a: string, b: string): number {
  return timeValue(a) - timeValue(b);
}

function timeValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

function booleanField(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function shortSha(value: string | undefined): string | undefined {
  return value ? value.slice(0, 7) : undefined;
}

function pluralize(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function humanizeEnum(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
