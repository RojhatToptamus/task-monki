import type { CodexReviewGateStatus, Task, TestStatus, WorkflowPhase } from '../../shared/contracts';
import {
  canCreateDeliveryCommit,
  canCreatePullRequest,
  formatShortId
} from '../model/selectors';
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
  stateLabel: string;
  stateTone: Tone;
  archived: boolean;
  hasDecision: boolean;
  decisionLabel: string;
  evidence: CardEvidenceItem[];
}

export interface FinishEvidenceWarning {
  title: string;
  detail: string;
}

export interface FinishEvidenceState {
  mode: 'clean' | 'override';
  warnings: FinishEvidenceWarning[];
}

export interface FinishRequirement {
  label: string;
  detail: string;
  tone: Tone;
  unresolved: boolean;
}

export interface FinishPanelAction {
  id: 'create-draft-pr' | 'commit' | 'mark-done';
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
  dirtyFileCount?: number
): FinishEvidenceState {
  const warnings = [
    reviewFinishWarning(reviewStatus),
    testFinishWarning(task.projection.tests),
    gitFinishWarning(task, dirtyFileCount)
  ].filter((warning): warning is FinishEvidenceWarning => Boolean(warning));

  return {
    mode: warnings.length === 0 ? 'clean' : 'override',
    warnings
  };
}

export function finishRequirementsForTask(
  task: Task,
  reviewStatus: CodexReviewGateStatus = codexReviewGate(task).status,
  dirtyFileCount?: number
): FinishRequirement[] {
  return [
    reviewRequirement(reviewStatus),
    testsRequirement(task.projection.tests),
    treeRequirement(task.projection.git, dirtyFileCount)
  ];
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
      id: 'create-draft-pr',
      label: 'Create draft PR',
      kind: 'primary',
      disabled: !canCreatePullRequest(input.task) || busyOrPaused
    });
    actions.push({
      id: 'commit',
      label: 'Commit',
      kind: 'outline',
      disabled: !canCreateDeliveryCommit(input.task) || busyOrPaused
    });
  }

  actions.push({
    id: 'mark-done',
    label: input.finishEvidence.mode === 'clean' ? 'Mark done' : 'Mark done anyway',
    kind: reviewRunning || actions.length > 0 ? 'outline' : 'primary',
    disabled: busyOrPaused,
    withIssues: input.finishEvidence.mode !== 'clean'
  });

  return actions;
}

export function markDoneModalCopy(withIssues: boolean, busy: boolean): MarkDoneModalCopy {
  return {
    title: withIssues ? 'Mark done anyway' : 'Mark done',
    body: withIssues
      ? 'Records the current local result as done. No commit or PR is created, and these checks stay unresolved:'
      : 'Records the current local result as done without creating a commit or PR.',
    fallbackWarningTitle: 'Evidence is not fully passing.',
    fallbackWarningDetail: 'You are explicitly marking the current local result done.',
    confirmLabel: busy ? 'Marking done...' : withIssues ? 'Mark done anyway' : 'Mark done'
  };
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

function testFinishWarning(status: TestStatus): FinishEvidenceWarning | undefined {
  switch (status) {
    case 'PASSED':
      return undefined;
    case 'FAILED':
    case 'ERROR':
      return {
        title: `Local tests are ${humanizeEnum(status).toLowerCase()}.`,
        detail: 'Fix or rerun tests before marking done cleanly, or mark done anyway.'
      };
    case 'STALE':
      return {
        title: 'Local test evidence is stale.',
        detail: 'Rerun tests for the current Git state before marking done cleanly.'
      };
    case 'NOT_RUN':
      return {
        title: 'No local test run is recorded.',
        detail: 'Run tests before marking done cleanly, or mark done anyway.'
      };
    case 'NOT_CONFIGURED':
      return {
        title: 'No local test command is configured.',
        detail: 'Configure or run verification before marking done cleanly, or mark done anyway.'
      };
    case 'QUEUED':
    case 'RUNNING':
      return {
        title: 'Local tests are still running.',
        detail: 'Wait for tests to finish before marking done cleanly.'
      };
    case 'CANCELED':
      return {
        title: 'Local test run was canceled.',
        detail: 'Rerun tests before marking done cleanly, or mark done anyway.'
      };
    case 'UNKNOWN':
      return {
        title: 'Local test state is unknown.',
        detail: 'Refresh or rerun tests before marking done cleanly, or mark done anyway.'
      };
  }
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

function reviewAttentionShouldWin(agentRun: Task['projection']['agentRun']): boolean {
  return ['AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'RECOVERY_REQUIRED', 'LOST'].includes(
    agentRun
  );
}

function gitEvidence(task: Task): CardEvidenceItem {
  switch (task.projection.git) {
    case 'CLEAN':
      return { label: 'git clean' };
    case 'DIRTY':
      return { label: 'git dirty', tone: 'action' };
    case 'COMMITTED_UNPUSHED':
      return { label: 'committed', tone: 'info' };
    case 'PUSHED':
      return { label: 'pushed' };
    case 'CONFLICTED':
    case 'DIVERGED':
    case 'UNAVAILABLE':
      return { label: humanizeEnum(task.projection.git).toLowerCase(), tone: 'error' };
    case 'NOT_INSPECTED':
    case 'UNKNOWN':
      return { label: humanizeEnum(task.projection.git).toLowerCase(), tone: 'action' };
    default:
      return { label: humanizeEnum(task.projection.git).toLowerCase() };
  }
}

function testsEvidence(task: Task): CardEvidenceItem {
  switch (task.projection.tests) {
    case 'PASSED':
      return { label: 'tests pass' };
    case 'FAILED':
    case 'ERROR':
      return { label: 'tests fail', tone: 'error' };
    case 'RUNNING':
    case 'QUEUED':
      return { label: 'tests running', tone: 'info' };
    case 'STALE':
      return { label: 'tests stale', tone: 'action' };
    case 'NOT_RUN':
    case 'NOT_CONFIGURED':
    case 'CANCELED':
    case 'UNKNOWN':
      return { label: humanizeEnum(task.projection.tests).toLowerCase(), tone: 'action' };
    default:
      return { label: humanizeEnum(task.projection.tests).toLowerCase() };
  }
}

function prEvidence(task: Task): CardEvidenceItem | undefined {
  switch (task.projection.githubPullRequest) {
    case 'OPEN_DRAFT':
      return { label: 'PR draft' };
    case 'OPEN_READY':
      return { label: 'PR open' };
    case 'MERGED':
      return { label: 'merged' };
    case 'CLOSED_UNMERGED':
      return { label: 'PR closed', tone: 'error' };
    case 'NOT_CREATED':
    case 'UNLINKED':
      return { label: 'no PR' };
    default:
      return { label: humanizeEnum(task.projection.githubPullRequest).toLowerCase(), tone: 'action' };
  }
}

function ciEvidence(task: Task): CardEvidenceItem | undefined {
  switch (task.projection.ciChecks) {
    case 'NOT_APPLICABLE':
      return undefined;
    case 'PASSING':
      return { label: 'CI passing' };
    case 'FAILING':
    case 'BLOCKED':
      return { label: `CI ${task.projection.ciChecks.toLowerCase()}`, tone: 'error' };
    case 'PENDING':
    case 'STALE':
      return { label: `CI ${task.projection.ciChecks.toLowerCase()}`, tone: 'action' };
    default:
      return { label: `CI ${humanizeEnum(task.projection.ciChecks).toLowerCase()}` };
  }
}

export function evidenceLineForTask(task: Task): CardEvidenceItem[] {
  return [
    gitEvidence(task),
    testsEvidence(task),
    prEvidence(task),
    ciEvidence(task)
  ].filter((item): item is CardEvidenceItem => Boolean(item));
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
    stateLabel: state.label,
    stateTone: state.tone,
    archived: task.workflowPhase === 'ARCHIVED',
    hasDecision,
    decisionLabel: hasDecision ? 'Needs you' : '',
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

function testsRequirement(status: TestStatus): FinishRequirement {
  switch (status) {
    case 'PASSED':
      return { label: 'Tests', detail: 'pass', tone: 'success', unresolved: false };
    case 'FAILED':
    case 'ERROR':
      return { label: 'Tests', detail: status.toLowerCase(), tone: 'error', unresolved: true };
    case 'RUNNING':
    case 'QUEUED':
      return { label: 'Tests', detail: status.toLowerCase(), tone: 'info', unresolved: true };
    case 'STALE':
      return { label: 'Tests', detail: 'stale', tone: 'action', unresolved: true };
    case 'NOT_RUN':
      return { label: 'Tests', detail: 'not run', tone: 'action', unresolved: true };
    case 'NOT_CONFIGURED':
      return { label: 'Tests', detail: 'not configured', tone: 'action', unresolved: true };
    case 'CANCELED':
      return { label: 'Tests', detail: 'canceled', tone: 'action', unresolved: true };
    case 'UNKNOWN':
      return { label: 'Tests', detail: 'unknown', tone: 'action', unresolved: true };
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
