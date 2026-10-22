import { effectiveReviewGateStatus, openReviewFindings } from '../../shared/agentReviewFindings';
import { deliveryProvider } from './deliveryWords';
import type {
  AgentReviewFinding,
  AgentReviewGateStatus,
  BoardDeliveryFacts,
  BoardTaskSummary,
  DomainEvent,
  Repository,
  RunRecord,
  Task,
  WorkflowPhase
} from '../../shared/contracts';
import {
  completionPolicyRequiresMerge,
  formatRemoteWorkNumber,
  getImplementationRetryReason,
  remoteWorkLabel
} from '../../shared/contracts';
import { isImplementationOutcomeBlocked } from './nextAction';
import {
  describeAttentionStatus,
  describeOutOfStep,
  describeTaskAttention,
  isAttentionTask,
  isInFlightTask
} from './taskAttention';
import { humanizeEnum } from './formatting';
import { hasPullRequest, isClosedPhase, isMerged, isReviewPhase } from './taskPhase';
import type { Tone } from './viewTypes';

/** A task's pull request as a board card shows it: GitHub's number and state. */
export interface TaskCardPullRequest {
  /** The number as its platform writes it, `#82` or `!82`, or the platform's word while it has none. */
  label: string;
  state: 'draft' | 'open' | 'merged' | 'closed';
  /** Delivery progress the card's status word does not already say, e.g. "checks pending". */
  note?: string;
}

export interface TaskCardVM {
  id: string;
  title: string;
  meta?: string;
  /** Lineage cue for a forked task, e.g. "Fork of Add rate limiting"; undefined otherwise. */
  lineage?: string;
  repositoryId: string;
  stateLabel: string;
  stateTone: Tone;
  /** An agent run or the agent review is working; the only state that moves. */
  stateInFlight: boolean;
  showState: boolean;
  archived: boolean;
  pullRequest?: TaskCardPullRequest;
  /** Review findings by severity, e.g. "1 blocker, 2 major"; the Review queue's triage signal. */
  findings?: string;
}

export interface RunFailureBannerViewModel {
  status: 'FAILED' | 'LOST' | 'RECOVERY_REQUIRED' | 'NEEDS_RETRY';
  title: string;
  /** A fact that changes the decision; the recovery actions already say what to do. */
  detail?: string;
  /** What the run itself recorded, shown as reported context, never as Task Monki's verdict. */
  reportedReason?: string;
}

export interface TaskCompletionEvidenceViewModel {
  label: 'Marked done' | 'Merged' | 'Completion unknown';
  /** How the task came to be done, when the label alone does not say it. */
  detail?: string;
}

export function describeTaskCompletionEvidence(
  task: Pick<Task, 'id' | 'workflowPhase' | 'completionPolicy' | 'projection'>,
  events: readonly DomainEvent[]
): TaskCompletionEvidenceViewModel | undefined {
  if (task.workflowPhase !== 'DONE') {
    return undefined;
  }
  const latestTransition = events
    .filter((event) => event.taskId === task.id && event.type === 'TRANSITION_COMPLETED')
    .reduce<DomainEvent | undefined>(
      (latest, event) => !latest || event.receivedAt > latest.receivedAt ? event : latest,
      undefined
    );
  const markedDone = Boolean(
    latestTransition?.source === 'ui' &&
    typeof latestTransition.payload === 'object' &&
    latestTransition.payload !== null &&
    (latestTransition.payload as Record<string, unknown>).toPhase === 'DONE'
  );
  if (markedDone) {
    return {
      label: 'Marked done',
      detail: 'Accepted in Task Monki, not independently verified.'
    };
  }
  if (
    completionPolicyRequiresMerge(task.completionPolicy) &&
    isMerged(task.projection)
  ) {
    // The merge is how it ended; its date and method are the pull request's record.
    return { label: 'Merged' };
  }
  return {
    label: 'Completion unknown',
    detail: 'Task Monki cannot tell how this task reached Done.'
  };
}

export interface TaskClosureViewModel {
  label: string;
  detail?: string;
  /** When the task reached its closed phase, if recorded. */
  at?: string;
}

/** How and when a closed task ended: Done, Canceled or Archived. */
export function describeTaskClosure(
  task: Pick<Task, 'id' | 'workflowPhase' | 'completionPolicy' | 'projection'>,
  events: readonly DomainEvent[]
): TaskClosureViewModel | undefined {
  if (!isClosedPhase(task.workflowPhase)) {
    return undefined;
  }
  const closing = events
    .filter((event) =>
      event.taskId === task.id &&
      event.type === 'TRANSITION_COMPLETED' &&
      (event.payload as Record<string, unknown> | null)?.toPhase === task.workflowPhase
    )
    .reduce<DomainEvent | undefined>(
      (latest, event) => !latest || event.receivedAt > latest.receivedAt ? event : latest,
      undefined
    );
  const at = closing?.receivedAt;
  if (task.workflowPhase === 'DONE') {
    const evidence = describeTaskCompletionEvidence(task, events);
    return { label: evidence?.label ?? 'Done', detail: evidence?.detail, ...(at ? { at } : {}) };
  }
  const reason = (closing?.payload as Record<string, unknown> | null)?.reason;
  return {
    label: humanizeEnum(task.workflowPhase),
    ...(typeof reason === 'string' && reason.trim() ? { detail: asSentence(reason) } : {}),
    ...(at ? { at } : {})
  };
}

/**
 * Explains an unsuccessful implementation outcome. Task Monki's own explanation
 * leads; the current run's recorded terminal reason — a provider or transport
 * message — is kept as reported context. The task projection summary is never
 * used here: it describes the latest task event, which can be unrelated (for
 * example a later worktree verification).
 */
export function describeRunFailureBanner(
  task: Task,
  currentRun?: Pick<RunRecord, 'id' | 'terminalReason'>
): RunFailureBannerViewModel | undefined {
  if (isImplementationOutcomeBlocked(task)) {
    return {
      status: 'NEEDS_RETRY',
      title: 'Needs retry',
      ...(getImplementationRetryReason(task) ? { detail: getImplementationRetryReason(task) } : {})
    };
  }
  const recordedReason =
    currentRun && currentRun.id === task.currentRunId
      ? currentRun.terminalReason?.trim() || undefined
      : undefined;
  switch (task.projection.agentRun) {
    case 'FAILED':
      return {
        status: 'FAILED',
        title: 'Run failed',
        ...(recordedReason ? { reportedReason: asSentence(recordedReason) } : {})
      };
    case 'LOST':
    case 'RECOVERY_REQUIRED':
      return {
        status: task.projection.agentRun,
        title: task.projection.agentRun === 'LOST' ? 'Runtime lost' : 'Recovery required',
        detail: 'Task Monki could not confirm how the run ended and will not resubmit it on its own.',
        ...(recordedReason ? { reportedReason: asSentence(recordedReason) } : {})
      };
    default:
      return undefined;
  }
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface TaskCardOptions {
  /** Show the repository name; false collapses it when all cards share one repo. */
  showRepo?: boolean;
  /**
   * The board column the card sits in, if any. Lets a card suppress a status
   * pill that only restates its column (e.g. "Ready" inside Backlog / Ready).
   */
  columnKey?: string;
  /**
   * Show the review finding-count triage line ("1 blocker · 2 major") — used by
   * the Review queue where that count is the signal engineers scan for.
   */
  showReviewCount?: boolean;
  repositoryName?: string;
  /** Titles of other tasks, so a fork names the task it came from. */
  taskTitles?: ReadonlyMap<string, string>;
}

export interface TaskCardRepositoryIdentity {
  showRepo: boolean;
  repositoryName: string;
}

/**
 * A task as the status function reads it. A full task can carry the facts a
 * board summary derives from its records, so both read the same word.
 */
export type TaskCardSource = Task | BoardTaskSummary | (Task & Partial<Pick<BoardTaskSummary, 'pullRequestRewritten' | 'delivery'>>);

/**
 * The one status word for a task. The board card, the task header and Active
 * runs all show it, so one state never has two names. Ordered by the UI
 * priority in PRODUCT_WORKFLOW: a decision the user owes, then recovery, then
 * work in flight, then verified local and delivery evidence, then the agent
 * review gate, then the phase.
 */
export function describeTaskStatus(task: TaskCardSource): { label: string; tone: Tone } {
  if (task.workflowPhase === 'DONE') {
    return { label: 'Done', tone: 'success' };
  }
  if (task.workflowPhase === 'CANCELED' || task.workflowPhase === 'ARCHIVED') {
    return { label: humanizeEnum(task.workflowPhase), tone: 'neutral' };
  }

  // A decision the user owes, a broken checkout and recovery come first, in the
  // order the attention model gives them; an interrupted run is recovery too.
  const attention = describeTaskAttention(task);
  if (
    attention &&
    (USER_OR_RECOVERY_RUNS.has(task.projection.agentRun) ||
      CHECKOUT_PROBLEMS.has(task.projection.worktree) ||
      isImplementationOutcomeBlocked(task))
  ) {
    return describeAttentionStatus(attention);
  }
  if (task.projection.agentRun === 'INTERRUPTED') {
    return { label: 'Interrupted', tone: 'action' };
  }

  const review = taskCardReview(task);
  if (review.status === 'RUNNING') {
    return { label: 'Reviewing', tone: 'info' };
  }
  if (isFixingReviewFeedback(task)) {
    return { label: 'Fixing review feedback', tone: 'info' };
  }
  const run = task.projection.agentRun;
  if (run === 'QUEUED' || run === 'STARTING' || run === 'RUNNING' || run === 'INTERRUPTING') {
    return { label: humanizeEnum(run), tone: 'info' };
  }

  if (attention) {
    return describeAttentionStatus(attention);
  }
  if (isReviewPhase(task.workflowPhase)) {
    const status = cardReviewStatus(task);
    return describeDeliveryProgress(task, status) ?? describeReviewGateStatus(task, status);
  }
  // Between turns, an open pull request's own progress is the task's state in any
  // phase, such as a pull request opened as a task before its first turn.
  const delivery = describeDeliveryProgress(task, cardReviewStatus(task));
  if (delivery) {
    return delivery;
  }
  if (run === 'COMPLETED') {
    return { label: 'Completed', tone: 'success' };
  }
  return task.workflowPhase === 'IN_PROGRESS'
    ? { label: 'In progress', tone: 'info' }
    : { label: humanizeEnum(task.workflowPhase), tone: 'neutral' };
}

const CHECKOUT_PROBLEMS = new Set<Task['projection']['worktree']>(['MISSING', 'PRUNABLE', 'ERROR']);

const USER_OR_RECOVERY_RUNS = new Set<Task['projection']['agentRun']>([
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'FAILED',
  'RECOVERY_REQUIRED',
  'LOST'
]);



/**
 * A pull request's own progress, when it asks something of the user or ends
 * the review: a merged PR awaiting completion, or an open PR whose branch
 * diverged, has unpushed changes, or carries stale checks. An agent review
 * verdict that needs action still leads.
 */
function describeDeliveryProgress(
  task: TaskCardSource,
  status: AgentReviewGateStatus
): { label: string; tone: Tone } | undefined {
  const projection = task.projection;
  if (isMerged(projection)) {
    return { label: 'Merged', tone: 'neutral' };
  }
  const open = projection.githubPullRequest === 'OPEN_DRAFT' || projection.githubPullRequest === 'OPEN_READY';
  if (!open || (status !== 'NOT_RUN' && status !== 'PASSED')) {
    return undefined;
  }
  // The same word the attention model gives a worktree out of step while a blocker stands.
  const outOfStep = describeOutOfStep(task);
  if (outOfStep) {
    return describeAttentionStatus(outOfStep);
  }
  if (projection.ciChecks === 'STALE') {
    return { label: 'Checks stale', tone: 'action' };
  }
  return undefined;
}

/**
 * The agent review is a detached gate. Once a pull request carries delivery,
 * an absent or passed agent review is not the task's state; the phase is.
 */
function describeReviewGateStatus(
  task: TaskCardSource,
  status: AgentReviewGateStatus
): { label: string; tone: Tone } {
  const delivering = task.workflowPhase === 'IN_REVIEW' || hasPullRequest(task.projection);
  switch (status) {
    case 'PASSED':
      return delivering
        ? { label: 'In review', tone: 'neutral' }
        : { label: 'Review passed', tone: 'success' };
    case 'NEEDS_CHANGES':
      // The user owes the next step, so it carries the waiting tone, not the failure one.
      return { label: 'Needs changes', tone: 'action' };
    case 'INCONCLUSIVE':
      return { label: 'Inconclusive', tone: 'action' };
    case 'FAILED':
      return { label: 'Review failed', tone: 'error' };
    case 'CANCELED':
      return { label: 'Review stopped', tone: 'action' };
    case 'STALE':
      return { label: 'Needs re-review', tone: 'action' };
    case 'RUNNING':
      return { label: 'Reviewing', tone: 'info' };
    case 'NOT_RUN':
      return delivering
        ? { label: 'In review', tone: 'neutral' }
        : { label: 'Ready for review', tone: 'action' };
  }
}

/**
 * Whether the review gives the implementation agent something to act on. A
 * review that asks for changes does, including one whose notes are only prose.
 * An inconclusive or failed review does only through open findings: its prose
 * explains why the review could not finish ("Git metadata is inaccessible"),
 * which is not work for the agent, so the next step is to run it again.
 */
export function canRequestReviewChanges(review: NonNullable<Task['projection']['agentReview']>): boolean {
  const effectiveStatus = effectiveReviewGateStatus(review);
  if (effectiveStatus === 'NEEDS_CHANGES') return true;
  return (effectiveStatus === 'INCONCLUSIVE' || effectiveStatus === 'FAILED') &&
    openReviewFindings(review.result, review.findingDecisions ?? []).length > 0;
}

const REVIEW_FEEDBACK_RUNS = new Set<Task['projection']['agentRun']>([
  'QUEUED',
  'STARTING',
  'RUNNING'
]);

/** The agent review gate's own word for the task, as the board card would say it. */
export function describeReviewGateWord(task: TaskCardSource): { label: string; tone: Tone } {
  return describeReviewGateStatus(task, cardReviewStatus(task));
}

const IN_FLIGHT_RUNS = new Set<Task['projection']['agentRun']>([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'INTERRUPTING'
]);

/** An agent run or the agent review is actually working, not merely open. */
export function isTaskWorkInFlight(task: TaskCardSource): boolean {
  return IN_FLIGHT_RUNS.has(task.projection.agentRun) || taskCardReview(task).status === 'RUNNING';
}

function isFixingReviewFeedback(task: TaskCardSource): boolean {
  const review = taskCardReview(task);
  return (
    task.workflowPhase === 'IN_PROGRESS' &&
    REVIEW_FEEDBACK_RUNS.has(task.projection.agentRun) &&
    // A turn after a finished review; the review goes stale only once the diff changes.
    review.status !== 'NOT_RUN' &&
    review.status !== 'RUNNING' &&
    Boolean(review.runId || reviewHasResult(review))
  );
}

/**
 * The pull request a card names. Its state is the icon; words appear only for
 * delivery progress the card's status word does not already state, so "Checks
 * failed" never sits beside "checks failing". No pull request, no footer.
 */
export function cardPullRequestForTask(
  task: TaskCardSource,
  stateLabel = describeTaskStatus(task).label
): TaskCardPullRequest | undefined {
  const projection = task.projection;
  if (!hasPullRequest(projection)) {
    return undefined;
  }
  const state = cardPullRequestState(projection);
  if (!state) {
    return undefined;
  }
  const note = state === 'draft' || state === 'open'
    ? cardPullRequestNote(projection, 'delivery' in task ? task.delivery : undefined)
    : undefined;
  const provider = deliveryProvider(task);
  return {
    label: projection.githubPullRequestNumber
      ? formatRemoteWorkNumber(provider, 'PULL_REQUEST', projection.githubPullRequestNumber)
      : remoteWorkLabel(provider, 'PULL_REQUEST'),
    state,
    ...(note && !CARD_NOTE_STATED_BY[note]?.includes(stateLabel) ? { note } : {})
  };
}

function cardPullRequestState(
  projection: TaskCardSource['projection']
): TaskCardPullRequest['state'] | undefined {
  if (isMerged(projection)) return 'merged';
  if (projection.merge === 'CLOSED_UNMERGED' || projection.githubPullRequest === 'CLOSED_UNMERGED') return 'closed';
  if (projection.githubPullRequest === 'OPEN_DRAFT') return 'draft';
  if (projection.githubPullRequest === 'OPEN_READY') return 'open';
  return undefined;
}

function cardPullRequestNote(
  projection: TaskCardSource['projection'],
  delivery: BoardDeliveryFacts | undefined
): string | undefined {
  if (projection.ciChecks === 'FAILING' || projection.ciChecks === 'BLOCKED') return 'checks failing';
  if (projection.ciChecks === 'PENDING') return 'checks pending';
  if (projection.ciChecks === 'CANCELED') return 'checks canceled';
  // Once the person answered, the review waits on its reviewers, as PR Status says.
  if (projection.reviews === 'CHANGES_REQUESTED') return delivery?.turn === 'REVIEWERS' ? 'review waiting' : 'changes requested';
  if (projection.reviews === 'REQUESTED' || projection.reviews === 'PENDING') return 'review waiting';
  // Scalars alone never claim ready to merge; that needs evidence for the current head.
  // A draft is never mergeable, whatever Git says of its conflicts.
  if (projection.ciChecks === 'PASSING') {
    return projection.merge === 'MERGEABLE' && projection.githubPullRequest === 'OPEN_READY' ? 'checks passing, mergeable' : 'checks passing';
  }
  return undefined;
}

/** Status words that already carry a delivery note, so the card says it once, on either platform. */
const CARD_NOTE_STATED_BY: Record<string, string[]> = {
  'checks failing': ['Checks failed'],
  'changes requested': ['Changes requested']
};

const FINDING_SEVERITY_LABELS: Array<{
  severity: AgentReviewFinding['severity'];
  singular: string;
}> = [
  { severity: 'BLOCKER', singular: 'blocker' },
  { severity: 'MAJOR', singular: 'major' },
  { severity: 'MINOR', singular: 'minor' },
  { severity: 'NIT', singular: 'nit' }
];

/**
 * The triage signal an engineer scans a review queue for: a compact count of
 * findings by severity, e.g. "1 blocker, 2 major".
 * Returns undefined when there is no recorded review result with findings.
 */
export function reviewFindingCountLabel(task: TaskCardSource): string | undefined {
  const counts = reviewFindingCounts(task);
  if (Object.values(counts).every((count) => !count)) {
    return undefined;
  }
  const parts = FINDING_SEVERITY_LABELS.map(({ severity, singular }) => {
    const count = counts[severity] ?? 0;
    return count > 0 ? `${count} ${singular}` : undefined;
  }).filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function buildTaskCardVM(
  task: TaskCardSource,
  options: TaskCardOptions = {}
): TaskCardVM {
  const { showRepo = true, columnKey, showReviewCount = false } = options;
  const state = describeTaskStatus(task);
  return {
    id: task.id,
    title: task.title,
    meta: showRepo ? options.repositoryName : undefined,
    lineage: task.forkedFromTaskId
      ? options.taskTitles?.has(task.forkedFromTaskId) ? `Fork of ${options.taskTitles.get(task.forkedFromTaskId)}` : 'Fork'
      : undefined,
    repositoryId: task.repositoryId,
    stateLabel: state.label,
    stateTone: state.tone,
    stateInFlight: isTaskWorkInFlight(task),
    showState: !stateRestatesColumn(state.label, columnKey),
    archived: task.workflowPhase === 'ARCHIVED',
    pullRequest: cardPullRequestForTask(task, state.label),
    findings: showReviewCount ? reviewFindingCountLabel(task) : undefined
  };
}

/**
 * True when a card's status word merely repeats the column it sits in, e.g.
 * "Ready" inside Backlog / Ready or "Done" inside Done. The word stays where it
 * refines the column ("Needs changes" within Review).
 */
export function stateRestatesColumn(stateLabel: string, columnKey: string | undefined): boolean {
  if (columnKey === 'ready') {
    return stateLabel === 'Ready' || stateLabel === 'Backlog';
  }
  if (columnKey === 'done') {
    return stateLabel === 'Done';
  }
  if (columnKey === 'progress') {
    return stateLabel === 'In progress';
  }
  if (columnKey === 'review') {
    return stateLabel === 'In review';
  }
  return false;
}

/** Whether a set of tasks spans more than one repository. */
export function tasksSpanMultipleRepositories(tasks: TaskCardSource[]): boolean {
  const seen = new Set<string>();
  for (const task of tasks) {
    seen.add(task.repositoryId);
    if (seen.size > 1) {
      return true;
    }
  }
  return false;
}

/** Resolve repository card copy per task so an orphaned repository is never silently hidden. */
export function selectTaskCardRepositoryIdentity(
  repositoryId: string,
  repositories: ReadonlyMap<string, Pick<Repository, 'name' | 'status'>>,
  showRepositoryForView: boolean
): TaskCardRepositoryIdentity {
  const repository = repositories.get(repositoryId);
  return {
    showRepo: showRepositoryForView || repository?.status !== 'AVAILABLE',
    repositoryName: repository?.name ?? 'Missing repository'
  };
}

/** Inbox rows need repository identity only when it distinguishes a task or its repository is missing. */
export function shouldShowInboxRepository(
  tasks: TaskCardSource[],
  repositories: Pick<Repository, 'id' | 'status'>[]
): boolean {
  const repositoryStatuses = new Map(
    repositories.map((repository) => [repository.id, repository.status])
  );
  return (
    tasksSpanMultipleRepositories(tasks) ||
    tasks.some((task) => repositoryStatuses.get(task.repositoryId) !== 'AVAILABLE')
  );
}

export type NavView = 'inbox' | 'board' | 'active' | 'review' | 'done' | 'settings';
/** The Tasks page's built-in views: the board and three filtered lists. Saved views are boards. */
export type TasksView = 'board' | 'active' | 'review' | 'done';

export function isTasksView(view: string): view is TasksView {
  return view === 'board' || view === 'active' || view === 'review' || view === 'done';
}

export interface NavCounts {
  inbox: number;
  active: number;
  review: number;
  done: number;
}

export function computeNavCounts(tasks: TaskCardSource[]): NavCounts {
  return {
    inbox: tasks.filter(isAttentionTask).length,
    active: tasks.filter(isInFlightTask).length,
    review: tasks.filter(isReviewQueueTask).length,
    done: tasks.filter((task) => isClosedPhase(task.workflowPhase)).length
  };
}

/** Tasks for a card-grid view (active / review / done). */
export function tasksForView(
  tasks: TaskCardSource[],
  view: NavView
): TaskCardSource[] {
  const sorted = (list: TaskCardSource[]) =>
    [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  switch (view) {
    case 'active':
      return sorted(tasks.filter((task) => isInFlightTask(task) && !isReviewQueueTask(task)));
    case 'review':
      return sorted(tasks.filter(isReviewQueueTask));
    case 'done':
      return sorted(tasks.filter((task) => isClosedPhase(task.workflowPhase)));
    default:
      return sorted(tasks);
  }
}

export interface BoardColumnDef {
  key: string;
  label: string;
  tone: Tone;
  phases: WorkflowPhase[];
}

/** Kanban columns mirroring the artifact's COLS, mapped to real phases. */
export const BOARD_COLUMNS: BoardColumnDef[] = [
  { key: 'ready', label: 'Backlog / Ready', tone: 'neutral', phases: ['BACKLOG', 'READY'] },
  { key: 'progress', label: 'In progress', tone: 'info', phases: ['IN_PROGRESS', 'BLOCKED'] },
  { key: 'review', label: 'Review', tone: 'action', phases: ['REVIEW', 'IN_REVIEW'] },
  { key: 'done', label: 'Done', tone: 'success', phases: ['DONE', 'CANCELED', 'ARCHIVED'] }
];

export function columnTasks(
  tasks: TaskCardSource[],
  column: BoardColumnDef
): TaskCardSource[] {
  return [...tasks]
    .filter((task) =>
      column.key === 'review'
        ? isReviewQueueTask(task)
        : column.key === 'progress'
          ? column.phases.includes(task.workflowPhase) && !isReviewQueueTask(task)
          : column.phases.includes(task.workflowPhase)
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isReviewQueueTask(task: TaskCardSource): boolean {
  return isReviewPhase(task.workflowPhase) || taskCardReview(task).status === 'RUNNING';
}

function taskCardReview(task: TaskCardSource) {
  return task.projection.agentReview ?? {
    status: 'NOT_RUN' as const,
    effectiveStatus: 'NOT_RUN' as const,
    hasResult: false,
    findingCounts: {}
  };
}

/**
 * The review status a task's word reflects: the gate rule once every finding
 * decision applies. The board's summary carries it; a full projection is asked directly.
 */
function cardReviewStatus(task: TaskCardSource): AgentReviewGateStatus {
  const review = taskCardReview(task);
  return 'findingCounts' in review ? review.effectiveStatus : effectiveReviewGateStatus(review);
}

function reviewHasResult(review: ReturnType<typeof taskCardReview>): boolean {
  return 'hasResult' in review ? review.hasResult : Boolean(review.result);
}

function reviewFindingCounts(
  task: TaskCardSource
): Partial<Record<AgentReviewFinding['severity'], number>> {
  const review = taskCardReview(task);
  if ('findingCounts' in review) return review.findingCounts;
  const counts: Partial<Record<AgentReviewFinding['severity'], number>> = {};
  for (const finding of openReviewFindings(review.result, review.findingDecisions ?? [])) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}
