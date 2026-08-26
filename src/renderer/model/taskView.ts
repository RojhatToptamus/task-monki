import type {
  AgentReviewFinding,
  AgentReviewGateStatus,
  BoardTaskSummary,
  Repository,
  Task,
  WorkflowPhase
} from '../../shared/contracts';
import {
  getImplementationRetryReason
} from '../../shared/contracts';
import { isImplementationOutcomeBlocked } from './nextAction';
import { formatShortId } from './selectors';
import { buildBoardDeliveryParts } from './prStatus';
import { describeTaskAttention, isAttentionTask, isInFlightTask } from './taskAttention';
import { humanizeEnum } from './formatting';
import type { Tone } from './viewTypes';

/**
 * Tone palette shared by the standard status pill. Each maps to a semantic
 * `--<tone>` CSS variable and the `.status-pill--<tone>` class.
 */
export interface CardEvidenceItem {
  /** Mono value part (e.g. a PR reference), rendered before the label. */
  value?: string;
  /** Sans status words describing the delivery state. */
  label: string;
  tone?: Tone;
}

export interface TaskCardVM {
  id: string;
  title: string;
  meta?: string;
  /** Lineage cue for a forked task, e.g. "fork of #task-rev"; undefined otherwise. */
  lineage?: string;
  repositoryId: string;
  stateLabel: string;
  stateTone: Tone;
  showState: boolean;
  archived: boolean;
  evidence: CardEvidenceItem[];
}

export interface RunFailureBannerViewModel {
  status: 'FAILED' | 'LOST' | 'RECOVERY_REQUIRED' | 'NEEDS_RETRY';
  title: string;
  detail: string;
}

export function describeRunFailureBanner(
  task: Task
): RunFailureBannerViewModel | undefined {
  if (isImplementationOutcomeBlocked(task)) {
    return {
      status: 'NEEDS_RETRY',
      title: 'Implementation needs another pass',
      detail:
        getImplementationRetryReason(task) ??
        'Retry the implementation or continue unfinished work before review.'
    };
  }
  switch (task.projection.agentRun) {
    case 'FAILED':
      return {
        status: 'FAILED',
        title: 'The agent run failed',
        detail: `${task.projection.summary} Retry the implementation or continue unfinished work from the current state.`
      };
    case 'LOST':
    case 'RECOVERY_REQUIRED':
      return {
        status: task.projection.agentRun,
        title: 'Task Monki cannot prove the final provider state',
        detail: task.projection.summary
      };
    default:
      return undefined;
  }
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
  /** Use the lifecycle vocabulary that scans cleanly in the Active runs view. */
  statusContext?: 'active';
  repositoryName?: string;
}

export interface TaskCardRepositoryIdentity {
  showRepo: boolean;
  repositoryName: string;
}

export type TaskCardSource = Task | BoardTaskSummary;

/** Human label + tone for a task's most salient run/phase state. */
export function describeTaskState(task: TaskCardSource): { label: string; tone: Tone } {
  if (task.workflowPhase === 'DONE') {
    return { label: 'Done', tone: 'success' };
  }
  if (task.workflowPhase === 'CANCELED' || task.workflowPhase === 'ARCHIVED') {
    return { label: humanizeEnum(task.workflowPhase), tone: 'neutral' };
  }

  const attention = describeTaskAttention(task);
  if (
    attention &&
    (reviewAttentionShouldWin(task.projection.agentRun) ||
      isImplementationOutcomeBlocked(task))
  ) {
    return {
      label: ['Needs approval', 'Needs input'].includes(attention.label)
        ? 'Needs you'
        : attention.label,
      tone: attention.tone === 'error' ? 'error' : 'action'
    };
  }

  const review = taskCardReview(task);
  if (REVIEW_PHASES.includes(task.workflowPhase) || review.status === 'RUNNING') {
    switch (review.status) {
      case 'RUNNING':
        return { label: 'Reviewing...', tone: 'info' };
      case 'PASSED':
        return { label: 'Review passed', tone: 'success' };
      case 'NEEDS_CHANGES':
        return { label: 'Needs changes', tone: 'error' };
      case 'INCONCLUSIVE':
        return { label: 'Inconclusive', tone: 'action' };
      case 'FAILED':
        return { label: 'Review failed', tone: 'error' };
      case 'CANCELED':
        return { label: 'Review stopped', tone: 'action' };
      case 'STALE':
        return { label: 'Needs re-review', tone: 'action' };
      case 'NOT_RUN':
        return { label: 'Ready for review', tone: 'action' };
    }
  }

  if (attention) {
    return {
      label: attention.label,
      tone: attention.tone === 'error' ? 'error' : 'action'
    };
  }

  if (isFixingReviewFeedback(task)) {
    return { label: 'Fixing review feedback', tone: 'info' };
  }

  const run = task.projection.agentRun;
  if (run === 'RUNNING' || run === 'STARTING' || run === 'QUEUED') {
    return { label: humanizeEnum(run), tone: 'info' };
  }
  if (run === 'COMPLETED') {
    return { label: 'Completed', tone: 'success' };
  }
  if (run === 'INTERRUPTED' || run === 'INTERRUPTING') {
    return { label: humanizeEnum(run), tone: 'action' };
  }

  switch (task.workflowPhase) {
    case 'IN_PROGRESS':
      return { label: 'In progress', tone: 'info' };
    default:
      return { label: humanizeEnum(task.workflowPhase), tone: 'neutral' };
  }
}

/** Header state should describe task/workflow context, not review verdict detail. */
export function describeTaskHeaderState(task: Task): { label: string; tone: Tone } {
  if (task.workflowPhase === 'DONE') {
    return { label: 'Done', tone: 'success' };
  }
  if (task.workflowPhase === 'CANCELED' || task.workflowPhase === 'ARCHIVED') {
    return { label: humanizeEnum(task.workflowPhase), tone: 'neutral' };
  }

  const attention = describeTaskAttention(task);
  if (
    attention &&
    (reviewAttentionShouldWin(task.projection.agentRun) ||
      isImplementationOutcomeBlocked(task))
  ) {
    return {
      label: attention.label,
      tone: attention.tone === 'error' ? 'error' : 'action'
    };
  }

  const run = task.projection.agentRun;
  if (run === 'QUEUED' || run === 'STARTING' || run === 'RUNNING') {
    return {
      label: task.projection.agentReview?.status === 'RUNNING' ? 'Reviewing' : 'Implementing',
      tone: 'info'
    };
  }
  if (run === 'INTERRUPTING' || run === 'INTERRUPTED') {
    return { label: humanizeEnum(run), tone: 'action' };
  }
  if (run === 'FAILED' || run === 'RECOVERY_REQUIRED' || run === 'LOST') {
    return { label: attention?.label ?? humanizeEnum(run), tone: 'error' };
  }

  if (task.projection.agentReview?.status === 'STALE') {
    return { label: 'Re-verify', tone: 'action' };
  }

  if (task.workflowPhase === 'REVIEW' || task.workflowPhase === 'IN_REVIEW') {
    return { label: 'Reviewing', tone: 'neutral' };
  }
  if (task.workflowPhase === 'IN_PROGRESS') {
    return { label: 'Implementing', tone: 'info' };
  }

  return { label: humanizeEnum(task.workflowPhase), tone: 'neutral' };
}

export function canRequestReviewChanges(
  review: NonNullable<Task['projection']['agentReview']>,
  effectiveStatus = review.status,
  hasReviewOutput = Boolean(review.result)
): boolean {
  if (effectiveStatus === 'NEEDS_CHANGES' || effectiveStatus === 'INCONCLUSIVE') {
    return true;
  }
  return (
    effectiveStatus === 'FAILED' &&
    hasReviewOutput
  );
}

const REVIEW_FEEDBACK_RUNS = new Set<Task['projection']['agentRun']>([
  'QUEUED',
  'STARTING',
  'RUNNING'
]);

function isFixingReviewFeedback(task: TaskCardSource): boolean {
  const review = taskCardReview(task);
  return (
    task.workflowPhase === 'IN_PROGRESS' &&
    REVIEW_FEEDBACK_RUNS.has(task.projection.agentRun) &&
    review.status === 'STALE' &&
    Boolean(review.runId || reviewHasResult(review))
  );
}

function reviewAttentionShouldWin(agentRun: Task['projection']['agentRun']): boolean {
  return [
    'AWAITING_APPROVAL',
    'AWAITING_USER_INPUT',
    'FAILED',
    'RECOVERY_REQUIRED',
    'LOST'
  ].includes(agentRun);
}

export function evidenceLineForTask(task: TaskCardSource): CardEvidenceItem[] {
  const { ref, status } = buildBoardDeliveryParts(task);
  // "No PR" is the absence of delivery state, not information — reserve the
  // footer for cards that actually carry a PR/check/merge signal (DESIGN.md §6).
  if (ref === 'No PR' || !status) {
    return [];
  }
  // Mono for the PR reference (a value); sans for the status words.
  return [{ value: ref, label: status, tone: deliveryLineTone(task) }];
}

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
 * findings by severity, e.g. "1 blocker · 2 major" (audit §03 Review queue).
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
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The most salient severity tone across a task's review findings. */
export function reviewFindingTone(task: TaskCardSource): Tone {
  const counts = reviewFindingCounts(task);
  if (counts.BLOCKER) {
    return 'error';
  }
  if (counts.MAJOR) {
    return 'action';
  }
  return 'info';
}

function deliveryLineTone(task: TaskCardSource): Tone {
  if (
    task.projection.githubPullRequest === 'CLOSED_UNMERGED' ||
    task.projection.ciChecks === 'FAILING' ||
    task.projection.ciChecks === 'BLOCKED' ||
    task.projection.reviews === 'CHANGES_REQUESTED'
  ) {
    return 'error';
  }
  if (
    task.projection.ciChecks === 'PENDING' ||
    task.projection.ciChecks === 'CANCELED' ||
    task.projection.ciChecks === 'STALE' ||
    task.projection.reviews === 'REQUESTED' ||
    task.projection.reviews === 'PENDING'
  ) {
    return 'action';
  }
  if (
    task.projection.githubPullRequest === 'MERGED' ||
    task.projection.merge === 'MERGED' ||
    (task.projection.ciChecks === 'PASSING' && task.projection.merge === 'MERGEABLE')
  ) {
    return 'success';
  }
  return 'neutral';
}

export function buildTaskCardVM(
  task: TaskCardSource,
  options: TaskCardOptions = {}
): TaskCardVM {
  const { showRepo = true, columnKey, showReviewCount = false } = options;
  const state = options.statusContext === 'active'
    ? describeActiveTaskState(task)
    : describeTaskState(task);
  const evidence = evidenceLineForTask(task);
  if (showReviewCount) {
    const findingLabel = reviewFindingCountLabel(task);
    if (findingLabel) {
      // Lead with the triage signal engineers scan the review queue for.
      evidence.unshift({ label: findingLabel, tone: reviewFindingTone(task) });
    }
  }
  return {
    id: task.id,
    title: task.title,
    meta: showRepo ? options.repositoryName : undefined,
    lineage: task.forkedFromTaskId
      ? `fork of #${formatShortId(task.forkedFromTaskId)}`
      : undefined,
    repositoryId: task.repositoryId,
    stateLabel: state.label,
    stateTone: state.tone,
    showState: !stateRestatesColumn(state.label, columnKey),
    archived: task.workflowPhase === 'ARCHIVED',
    evidence
  };
}

function describeActiveTaskState(task: TaskCardSource): { label: string; tone: Tone } {
  if (task.projection.agentRun === 'AWAITING_APPROVAL' || task.projection.agentRun === 'AWAITING_USER_INPUT') {
    return { label: 'Needs you', tone: 'action' };
  }
  if (task.projection.agentReview?.status === 'RUNNING') {
    return { label: 'Reviewing', tone: 'info' };
  }
  if (['QUEUED', 'STARTING', 'RUNNING', 'INTERRUPTING'].includes(task.projection.agentRun)) {
    return { label: 'Implementing', tone: 'info' };
  }
  return describeTaskState(task);
}

/**
 * True when a card's state pill merely repeats the column it sits in — e.g.
 * "Ready" inside Backlog / Ready or "Done" inside Done. Pills are kept where
 * they refine the column (e.g. "Needs changes" within Review).
 */
function stateRestatesColumn(stateLabel: string, columnKey: string | undefined): boolean {
  if (columnKey === 'ready') {
    return stateLabel === 'Ready' || stateLabel === 'Backlog';
  }
  if (columnKey === 'done') {
    return stateLabel === 'Done';
  }
  if (columnKey === 'progress') {
    return stateLabel === 'In progress';
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

const REVIEW_PHASES: WorkflowPhase[] = ['REVIEW', 'IN_REVIEW'];
const DONE_PHASES: WorkflowPhase[] = ['DONE', 'CANCELED', 'ARCHIVED'];

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
    done: tasks.filter((task) => DONE_PHASES.includes(task.workflowPhase)).length
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
      return sorted(tasks.filter((task) => DONE_PHASES.includes(task.workflowPhase)));
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
  return REVIEW_PHASES.includes(task.workflowPhase) || taskCardReview(task).status === 'RUNNING';
}

function taskCardReview(task: TaskCardSource) {
  return task.projection.agentReview ?? {
    status: 'NOT_RUN' as const,
    hasResult: false,
    findingCounts: {}
  };
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
  for (const finding of review.result?.findings ?? []) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}
