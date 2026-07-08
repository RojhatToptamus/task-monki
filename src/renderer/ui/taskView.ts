import type {
  CodexReviewGateStatus,
  MergeStatus,
  Task,
  VerifiedChecksEvidence,
  WorkflowPhase
} from '../../shared/contracts';
import {
  completionPolicyRequiresMerge,
  completionPolicyRequiresPassingChecks,
  verifiedChecksMatchMergeHead
} from '../../shared/contracts';
import {
  canCreateDeliveryCommit,
  formatShortId
} from '../model/selectors';
import { buildBoardDeliveryLine } from '../model/prStatus';
import { describeTaskAttention, isAttentionTask, isInFlightTask } from './BoardView';
import { humanizeEnum } from './display';

/**
 * Tone palette shared by the standard status pill. Each maps to a semantic
 * `--<tone>` CSS variable and the `.status-pill--<tone>` class.
 */
export type Tone = 'neutral' | 'info' | 'action' | 'success' | 'error';

export interface CardEvidenceItem {
  label: string;
  tone?: Tone;
}

export interface TaskCardVM {
  id: string;
  num: string;
  title: string;
  meta: string;
  repositoryPath: string;
  stateLabel: string;
  stateTone: Tone;
  archived: boolean;
  hasDecision: boolean;
  evidence: CardEvidenceItem[];
}

export interface FinishEvidenceWarning {
  title: string;
  detail: string;
}

export interface FinishEvidenceState {
  mode: 'clean' | 'override' | 'blocked';
  warnings: FinishEvidenceWarning[];
}

export interface FinishRequirement {
  label: string;
  detail: string;
  tone: Tone;
  unresolved: boolean;
}

export interface FinishPanelAction {
  id: 'commit' | 'mark-done';
  label: string;
  kind: 'primary' | 'outline';
  disabled: boolean;
  withIssues?: boolean;
}

export interface MarkDoneModalCopy {
  title: string;
  body: string;
  fallbackWarningTitle: string;
  fallbackWarningDetail: string;
  confirmLabel: string;
}

export interface MarkDoneModalContext {
  hasPullRequest?: boolean;
}

/** Human label + tone for a task's most salient run/phase state. */
export function describeTaskState(task: Task): { label: string; tone: Tone } {
  if (task.workflowPhase === 'DONE') {
    return { label: 'Done', tone: 'success' };
  }
  if (task.workflowPhase === 'CANCELED' || task.workflowPhase === 'ARCHIVED') {
    return { label: humanizeEnum(task.workflowPhase), tone: 'neutral' };
  }

  const attention = describeTaskAttention(task);
  if (attention && reviewAttentionShouldWin(task.projection.agentRun)) {
    return {
      label: attention.label,
      tone: attention.tone === 'error' ? 'error' : 'action'
    };
  }

  const review = codexReviewGate(task);
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
  if (attention && reviewAttentionShouldWin(task.projection.agentRun)) {
    return {
      label: attention.label,
      tone: attention.tone === 'error' ? 'error' : 'action'
    };
  }

  const run = task.projection.agentRun;
  if (run === 'QUEUED' || run === 'STARTING' || run === 'RUNNING') {
    return { label: humanizeEnum(run), tone: 'info' };
  }
  if (run === 'INTERRUPTING' || run === 'INTERRUPTED') {
    return { label: humanizeEnum(run), tone: 'action' };
  }
  if (run === 'FAILED' || run === 'RECOVERY_REQUIRED' || run === 'LOST') {
    return { label: attention?.label ?? humanizeEnum(run), tone: 'error' };
  }

  if (task.workflowPhase === 'REVIEW' || task.workflowPhase === 'IN_REVIEW') {
    return { label: 'In review', tone: 'info' };
  }
  if (task.workflowPhase === 'IN_PROGRESS') {
    return { label: 'In progress', tone: 'info' };
  }

  return { label: humanizeEnum(task.workflowPhase), tone: 'neutral' };
}

export function codexReviewGate(task: Task): NonNullable<Task['projection']['codexReview']> {
  return task.projection.codexReview ?? { status: 'NOT_RUN' };
}

export function canRequestCodexReviewChanges(
  review: NonNullable<Task['projection']['codexReview']>,
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

export function getFinishEvidenceState(
  task: Task,
  reviewStatus: CodexReviewGateStatus = codexReviewGate(task).status,
  dirtyFileCount?: number,
  mergeStatus: MergeStatus = task.projection.merge,
  ciStatus: Task['projection']['ciChecks'] = task.projection.ciChecks,
  verifiedChecksEvidence?: VerifiedChecksEvidence
): FinishEvidenceState {
  const warnings = [
    reviewFinishWarning(reviewStatus),
    gitFinishWarning(task, dirtyFileCount)
  ].filter((warning): warning is FinishEvidenceWarning => Boolean(warning));
  const blockers = [
    mergeFinishBlocker(task, mergeStatus),
    verificationFinishBlocker(task, ciStatus, verifiedChecksEvidence)
  ].filter((warning): warning is FinishEvidenceWarning => Boolean(warning));

  if (blockers.length > 0) {
    return {
      mode: 'blocked',
      warnings: [...warnings, ...blockers]
    };
  }

  return {
    mode: warnings.length === 0 ? 'clean' : 'override',
    warnings
  };
}

export function finishRequirementsForTask(
  task: Task,
  reviewStatus: CodexReviewGateStatus = codexReviewGate(task).status,
  dirtyFileCount?: number,
  mergeStatus: MergeStatus = task.projection.merge,
  ciStatus: Task['projection']['ciChecks'] = task.projection.ciChecks,
  verifiedChecksEvidence?: VerifiedChecksEvidence
): FinishRequirement[] {
  const requirements = [
    reviewRequirement(reviewStatus),
    treeRequirement(task.projection.git, dirtyFileCount)
  ];
  if (completionPolicyRequiresMerge(task.completionPolicy)) {
    requirements.push(mergeRequirement(mergeStatus));
  }
  if (completionPolicyRequiresPassingChecks(task.completionPolicy)) {
    requirements.push(checksRequirement(ciStatus, verifiedChecksEvidence));
  }
  return requirements;
}

export function finishActionsForTask(input: {
  task: Task;
  reviewStatus: CodexReviewGateStatus;
  finishEvidence: FinishEvidenceState;
  actionBusy?: boolean;
  actionsPaused?: boolean;
}): FinishPanelAction[] {
  if (input.task.workflowPhase === 'DONE') {
    return [];
  }

  const reviewRunning = input.reviewStatus === 'RUNNING';
  const busyOrPaused = Boolean(input.actionBusy || input.actionsPaused || reviewRunning);
  const actions: FinishPanelAction[] = [];

  if (!reviewRunning) {
    actions.push({
      id: 'commit',
      label: 'Commit',
      kind: 'outline',
      disabled: !canCreateDeliveryCommit(input.task) || busyOrPaused
    });
  }

  actions.push({
    id: 'mark-done',
    label: input.finishEvidence.mode === 'override' ? 'Mark done anyway' : 'Mark done',
    kind: reviewRunning || actions.length > 0 ? 'outline' : 'primary',
    disabled: busyOrPaused || input.finishEvidence.mode === 'blocked',
    withIssues: input.finishEvidence.mode === 'override'
  });

  return actions;
}

export function markDoneModalCopy(
  withIssues: boolean,
  busy: boolean,
  context: MarkDoneModalContext = {}
): MarkDoneModalCopy {
  const hasPullRequest = Boolean(context.hasPullRequest);
  return {
    title: withIssues ? 'Mark done anyway' : 'Mark done',
    body: markDoneModalBody(withIssues, hasPullRequest),
    fallbackWarningTitle: 'Evidence is not fully passing.',
    fallbackWarningDetail: 'You are explicitly marking the current local result done.',
    confirmLabel: busy ? 'Marking done...' : withIssues ? 'Mark done anyway' : 'Mark done'
  };
}

function markDoneModalBody(withIssues: boolean, hasPullRequest: boolean): string {
  if (withIssues) {
    return hasPullRequest
      ? 'Records this task as done in Task Monki. The existing PR is left unchanged, and these checks stay unresolved:'
      : 'Records the current local result as done. No commit or PR is created, and these checks stay unresolved:';
  }
  return hasPullRequest
    ? 'Records this task as done in Task Monki. The existing PR is left unchanged; no new commit or PR is created.'
    : 'Records the current local result as done without creating a commit or PR.';
}

const REVIEW_FEEDBACK_RUNS = new Set<Task['projection']['agentRun']>([
  'QUEUED',
  'STARTING',
  'RUNNING'
]);

function isFixingReviewFeedback(task: Task): boolean {
  const review = codexReviewGate(task);
  return (
    task.workflowPhase === 'IN_PROGRESS' &&
    REVIEW_FEEDBACK_RUNS.has(task.projection.agentRun) &&
    review.status === 'STALE' &&
    Boolean(review.runId || review.result)
  );
}

function reviewFinishWarning(
  status: CodexReviewGateStatus
): FinishEvidenceWarning | undefined {
  if (status === 'PASSED') {
    return undefined;
  }
  if (status === 'STALE') {
    return {
      title: 'Codex review is stale.',
      detail: 'Run review again before marking done cleanly, or mark done anyway.'
    };
  }
  if (status === 'NEEDS_CHANGES') {
    return {
      title: 'Codex review requested changes.',
      detail: 'Request changes or mark the current result done as an owner override.'
    };
  }
  if (status === 'RUNNING') {
    return {
      title: 'Codex review is running.',
      detail: 'Wait for the review to finish before marking done cleanly.'
    };
  }
  if (status === 'FAILED' || status === 'INCONCLUSIVE' || status === 'CANCELED') {
    return {
      title: `Codex review is ${humanizeEnum(status).toLowerCase()}.`,
      detail: 'Run review again before marking done cleanly, or mark done anyway.'
    };
  }
  return {
    title: 'No passing Codex review is recorded.',
    detail: 'Run Codex review before marking done cleanly, or mark done anyway.'
  };
}

function gitFinishWarning(
  task: Task,
  dirtyFileCount?: number
): FinishEvidenceWarning | undefined {
  switch (task.projection.git) {
    case 'CLEAN':
    case 'COMMITTED_UNPUSHED':
    case 'PUSHED':
      return undefined;
    case 'DIRTY':
      return {
        title: 'Working tree is dirty.',
        detail:
          dirtyFileCount && dirtyFileCount > 0
            ? `${dirtyFileCount} uncommitted file${dirtyFileCount === 1 ? '' : 's'} remain. Commit or open a PR to share the work.`
            : 'Uncommitted changes remain. Commit or open a PR to share the work.'
      };
    case 'NOT_INSPECTED':
      return {
        title: 'Git evidence has not been inspected.',
        detail: 'Refresh evidence before marking done cleanly, or mark done anyway.'
      };
    case 'CONFLICTED':
    case 'DIVERGED':
    case 'UNAVAILABLE':
    case 'UNKNOWN':
      return {
        title: `Git state is ${humanizeEnum(task.projection.git).toLowerCase()}.`,
        detail: 'Resolve or refresh Git evidence before marking done cleanly, or mark done anyway.'
      };
  }
}

function mergeFinishBlocker(
  task: Task,
  mergeStatus: MergeStatus
): FinishEvidenceWarning | undefined {
  if (!completionPolicyRequiresMerge(task.completionPolicy) || mergeStatus === 'MERGED') {
    return undefined;
  }

  return {
    title: 'Pull request is not merged.',
    detail: 'This task requires a merged PR before it can be marked done.'
  };
}

function verificationFinishBlocker(
  task: Task,
  ciStatus: Task['projection']['ciChecks'],
  evidence?: VerifiedChecksEvidence
): FinishEvidenceWarning | undefined {
  if (!completionPolicyRequiresPassingChecks(task.completionPolicy)) {
    return undefined;
  }
  if (
    verifiedChecksMatchMergeHead({
      ...evidence,
      ciStatus
    })
  ) {
    return undefined;
  }

  return ciStatus === 'PASSING'
    ? {
        title: 'GitHub checks are not current.',
        detail:
          'This task requires passing GitHub checks for the merged PR head before it can be marked done.'
      }
    : {
        title: 'GitHub checks are not passing.',
        detail:
          'This task requires passing GitHub checks for the merged PR head before it can be marked done.'
      };
}

function reviewAttentionShouldWin(agentRun: Task['projection']['agentRun']): boolean {
  return ['AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'RECOVERY_REQUIRED', 'LOST'].includes(
    agentRun
  );
}

export function evidenceLineForTask(task: Task): CardEvidenceItem[] {
  return [{ label: buildBoardDeliveryLine(task), tone: deliveryLineTone(task) }];
}

function deliveryLineTone(task: Task): Tone {
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

export function taskMeta(task: Task): string {
  return repositoryName(task.repositoryPath);
}

export function buildTaskCardVM(task: Task): TaskCardVM {
  const state = describeTaskState(task);
  const hasDecision = ['AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(
    task.projection.agentRun
  );
  return {
    id: task.id,
    num: `#${formatShortId(task.id)}`,
    title: task.title,
    meta: taskMeta(task),
    repositoryPath: task.repositoryPath,
    stateLabel: state.label,
    stateTone: state.tone,
    archived: task.workflowPhase === 'ARCHIVED',
    hasDecision,
    evidence: evidenceLineForTask(task)
  };
}

function reviewRequirement(status: CodexReviewGateStatus): FinishRequirement {
  switch (status) {
    case 'PASSED':
      return { label: 'Review', detail: 'passed', tone: 'success', unresolved: false };
    case 'NEEDS_CHANGES':
      return { label: 'Review', detail: 'needs changes', tone: 'error', unresolved: true };
    case 'RUNNING':
      return { label: 'Review', detail: 'running', tone: 'info', unresolved: true };
    case 'STALE':
      return { label: 'Review', detail: 'stale', tone: 'action', unresolved: true };
    case 'INCONCLUSIVE':
      return { label: 'Review', detail: 'inconclusive', tone: 'action', unresolved: true };
    case 'FAILED':
      return { label: 'Review', detail: 'failed', tone: 'error', unresolved: true };
    case 'CANCELED':
      return { label: 'Review', detail: 'stopped', tone: 'action', unresolved: true };
    case 'NOT_RUN':
      return { label: 'Review', detail: 'not run', tone: 'action', unresolved: true };
  }
}

function treeRequirement(
  status: Task['projection']['git'],
  dirtyFileCount?: number
): FinishRequirement {
  switch (status) {
    case 'CLEAN':
      return { label: 'Tree', detail: 'clean', tone: 'success', unresolved: false };
    case 'PUSHED':
      return { label: 'Tree', detail: 'pushed', tone: 'success', unresolved: false };
    case 'COMMITTED_UNPUSHED':
      return { label: 'Tree', detail: 'committed', tone: 'info', unresolved: false };
    case 'DIRTY':
      return {
        label: 'Tree',
        detail:
          dirtyFileCount && dirtyFileCount > 0
            ? `${dirtyFileCount} dirty`
            : 'dirty',
        tone: 'action',
        unresolved: true
      };
    case 'CONFLICTED':
    case 'DIVERGED':
    case 'UNAVAILABLE':
      return {
        label: 'Tree',
        detail: humanizeEnum(status).toLowerCase(),
        tone: 'error',
        unresolved: true
      };
    case 'NOT_INSPECTED':
    case 'UNKNOWN':
      return {
        label: 'Tree',
        detail: humanizeEnum(status).toLowerCase(),
        tone: 'action',
        unresolved: true
      };
  }
}

function mergeRequirement(status: MergeStatus): FinishRequirement {
  switch (status) {
    case 'MERGED':
      return { label: 'Merge', detail: 'merged', tone: 'success', unresolved: false };
    case 'MERGEABLE':
      return { label: 'Merge', detail: 'ready, not merged', tone: 'action', unresolved: true };
    case 'COMPUTING':
      return { label: 'Merge', detail: 'checking', tone: 'info', unresolved: true };
    case 'QUEUED':
      return { label: 'Merge', detail: 'queued', tone: 'info', unresolved: true };
    case 'BLOCKED':
      return { label: 'Merge', detail: 'blocked', tone: 'error', unresolved: true };
    case 'CLOSED_UNMERGED':
      return { label: 'Merge', detail: 'closed unmerged', tone: 'error', unresolved: true };
    case 'NOT_APPLICABLE':
    case 'NOT_MERGED':
    case 'UNKNOWN':
      return {
        label: 'Merge',
        detail: humanizeEnum(status).toLowerCase(),
        tone: 'action',
        unresolved: true
      };
  }
}

function checksRequirement(
  status: Task['projection']['ciChecks'],
  evidence?: VerifiedChecksEvidence
): FinishRequirement {
  if (verifiedChecksMatchMergeHead({ ...evidence, ciStatus: status })) {
    return { label: 'Checks', detail: 'passing', tone: 'success', unresolved: false };
  }
  if (status === 'PASSING') {
    return { label: 'Checks', detail: 'not current', tone: 'action', unresolved: true };
  }
  if (status === 'FAILING' || status === 'BLOCKED') {
    return {
      label: 'Checks',
      detail: humanizeEnum(status).toLowerCase(),
      tone: 'error',
      unresolved: true
    };
  }
  if (status === 'PENDING') {
    return { label: 'Checks', detail: 'pending', tone: 'info', unresolved: true };
  }
  return {
    label: 'Checks',
    detail: humanizeEnum(status).toLowerCase(),
    tone: 'action',
    unresolved: true
  };
}

export function repositoryName(repositoryPath: string): string {
  const parts = repositoryPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? repositoryPath;
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

export function computeNavCounts(tasks: Task[]): NavCounts {
  return {
    inbox: tasks.filter(isAttentionTask).length,
    active: tasks.filter(isInFlightTask).length,
    review: tasks.filter(isReviewQueueTask).length,
    done: tasks.filter((task) => DONE_PHASES.includes(task.workflowPhase)).length
  };
}

/** Tasks for a card-grid view (active / review / done). */
export function tasksForView(tasks: Task[], view: NavView): Task[] {
  const sorted = (list: Task[]) =>
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

export function columnTasks(tasks: Task[], column: BoardColumnDef): Task[] {
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

function isReviewQueueTask(task: Task): boolean {
  return REVIEW_PHASES.includes(task.workflowPhase) || codexReviewGate(task).status === 'RUNNING';
}
