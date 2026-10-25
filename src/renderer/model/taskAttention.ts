import {
  effectiveReviewGateStatus,
  getImplementationRetryReason,
  type BoardTaskSummary,
  type Task
} from '../../shared/contracts';
import { isImplementationOutcomeBlocked } from './nextAction';
import { bugGateOf, describeBugAttention } from './bugReplay';
import { hasPullRequest, isClosedPhase, isMerged } from './taskPhase';
import { baseMovedLine } from './formatting';
import { deliveryNoun, deliveryProvider } from './deliveryWords';
import { pullRequestFeedbackLine } from './pullRequestFeedback';

export type TaskAttentionSource = Task | BoardTaskSummary;

export type TaskAttentionTone = 'warning' | 'error' | 'info';

/** What the user is asked for, so a surface can mark it with one glyph. */
export type TaskAttentionKind = 'approval' | 'question' | 'retry' | 'failure' | 'checkout' | 'git' | 'bug' | 'review' | 'delivery' | 'finish';

export interface TaskAttentionDescriptor {
  label: string;
  kind: TaskAttentionKind;
  /**
   * A recorded fact the label does not already say: a retry reason or Task
   * Monki's own summary of a blocked task. Never an instruction; the task's
   * actions say what to do.
   */
  detail?: string;
  tone: TaskAttentionTone;
}

const IN_FLIGHT_RUNS = new Set<Task['projection']['agentRun']>([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
]);

const REVIEW_ATTENTION_PHASES = new Set<TaskAttentionSource['workflowPhase']>(['IN_PROGRESS', 'REVIEW', 'IN_REVIEW']);

/**
 * The most urgent child state for a task, used to drive the "Needs you" inbox,
 * decision banners, and card chips. Returns undefined when nothing is blocked.
 */
export function describeTaskAttention(
  task: TaskAttentionSource
): TaskAttentionDescriptor | undefined {
  if (isClosedPhase(task.workflowPhase)) {
    return undefined;
  }
  switch (task.projection.agentRun) {
    case 'AWAITING_APPROVAL':
      return { label: 'Needs approval', kind: 'approval', tone: 'warning' };
    case 'AWAITING_USER_INPUT':
      return { label: 'Needs input', kind: 'question', tone: 'warning' };
  }
  // Retry and Continue run in the checkout, so a broken one comes first.
  const checkoutAttention = describeCheckoutAttention(task);
  if (checkoutAttention) {
    return checkoutAttention;
  }
  if (isImplementationOutcomeBlocked(task)) {
    return {
      label: 'Needs retry',
      kind: 'retry',
      detail: getImplementationRetryReason(task),
      tone: 'warning'
    };
  }
  switch (task.projection.agentRun) {
    case 'RECOVERY_REQUIRED':
      return { label: 'Recovery required', kind: 'failure', tone: 'error' };
    case 'LOST':
      return { label: 'Runtime lost', kind: 'failure', tone: 'error' };
    case 'FAILED':
      return { label: 'Run failed', kind: 'failure', tone: 'error' };
  }

  if (task.workflowPhase === 'BLOCKED' || task.projection.health === 'BLOCKED') {
    return {
      label: 'Blocked',
      kind: 'failure',
      detail: task.projection.summary,
      tone: 'error'
    };
  }

  // Conflicts an agent turn is resolving, as after a merge Git stopped on, wait on it, not the person.
  const resolvingConflicts = IN_FLIGHT_RUNS.has(task.projection.agentRun) &&
    (task.projection.git === 'CONFLICTED' || isMergeInProgress(task));
  const gitAttention = resolvingConflicts ? undefined : describeGitAttention(task);
  if (gitAttention) {
    return gitAttention;
  }

  // A recorded bug is local evidence Task Monki observed; it leads the agent review gate.
  const bugAttention = describeBugAttention(bugGateOf(task.projection.bugReplay), IN_FLIGHT_RUNS.has(task.projection.agentRun));
  if (bugAttention) {
    return { ...bugAttention, kind: 'bug' };
  }

  const reviewAttention = describeReviewAttention(task);
  if (reviewAttention) {
    return reviewAttention;
  }

  const deliveryAttention = describeDeliveryAttention(task);
  if (deliveryAttention) {
    return deliveryAttention;
  }

  // A merged pull request asks nothing more, whatever its last checks left in the task's health,
  // and conflicts being resolved leave the health in error without asking anything yet.
  if (task.projection.health === 'ERROR' && !isMerged(task.projection) && !resolvingConflicts) {
    return {
      label: 'Needs attention',
      kind: 'failure',
      detail: task.projection.summary,
      tone: 'error'
    };
  }

  return undefined;
}

/** Worktree and Git problems belong to the task's checkout, not to GitHub delivery. */
function describeCheckoutAttention(
  task: TaskAttentionSource
): TaskAttentionDescriptor | undefined {
  switch (task.projection.worktree) {
    case 'ERROR':
      return { label: 'Worktree setup failed', kind: 'checkout', tone: 'error' };
    case 'MISSING':
    case 'PRUNABLE':
      // A task worktree and an imported checkout both read as the checkout.
      return { label: 'Checkout missing', kind: 'checkout', tone: 'error' };
  }
  return undefined;
}

/**
 * The worktree's Git state. A merge in progress in the task's own worktree is
 * Push update's to finish, and reads as PR Status leads with it: Git counts each
 * file it stopped on as conflicted until the merge is committed, resolved or
 * not, and Push update names any file that still holds a conflict marker.
 * Conflicts with no such merge are the person's own.
 */
function describeGitAttention(
  task: TaskAttentionSource
): TaskAttentionDescriptor | undefined {
  if (isMergeInProgress(task)) {
    return { label: 'Changes not pushed', kind: 'delivery', detail: 'Merge in progress', tone: 'warning' };
  }
  switch (task.projection.git) {
    case 'CONFLICTED':
      return { label: 'Git conflicts', kind: 'git', tone: 'error' };
    case 'UNAVAILABLE':
      return { label: 'Git unavailable', kind: 'git', tone: 'error' };
  }
  return undefined;
}

/** A merge in progress beside an open pull request, which Push update finishes (`BoardDeliveryFacts.mergeInProgress`). */
function isMergeInProgress(task: TaskAttentionSource): boolean {
  return 'delivery' in task && Boolean(task.delivery?.mergeInProgress);
}

/**
 * A finished review the person acts on: the agent's question about a request, a
 * failed review, fixes to review again, or findings to decide. Auto re-review is
 * off, so each waits on the person; a review or run in flight waits on nobody,
 * and neither does a merged pull request.
 */
function describeReviewAttention(
  task: TaskAttentionSource
): TaskAttentionDescriptor | undefined {
  if (!REVIEW_ATTENTION_PHASES.has(task.workflowPhase) || isMerged(task.projection) || IN_FLIGHT_RUNS.has(task.projection.agentRun)) {
    return undefined;
  }
  const review = task.projection.agentReview;
  if (!review || review.status === 'NOT_RUN' || review.status === 'RUNNING') {
    return undefined;
  }
  // A board summary carries the review's facts; a full task carries the gate they come from.
  const board = 'findingCounts' in review;
  const answered = board
    ? review.requestAnswered
    : review.requestAnswer;
  if (answered?.awaitingDecision) {
    return { label: 'Agent asked a question', kind: 'question', tone: 'warning' };
  }
  if (review.status === 'FAILED') {
    return { label: 'Review failed', kind: 'failure', tone: 'error' };
  }
  if (answered && review.status === 'STALE') {
    return { label: 'Fixes ready for review', kind: 'review', tone: 'info' };
  }
  const effective = board ? review.effectiveStatus : effectiveReviewGateStatus(review);
  if (effective === 'NEEDS_CHANGES') {
    return { label: 'Needs changes', kind: 'review', tone: 'warning' };
  }
  return undefined;
}

function describeDeliveryAttention(
  task: TaskAttentionSource
): TaskAttentionDescriptor | undefined {
  const projection = task.projection;
  if (
    task.completionPolicy === 'MANUAL' &&
    projection.merge === 'MERGED' &&
    task.workflowPhase !== 'DONE'
  ) {
    return { label: 'Ready to mark done', kind: 'finish', tone: 'info' };
  }
  // A merged pull request asks nothing more: its last review decision or check
  // run stays on the platform, but delivery is over.
  if (isMerged(projection)) {
    return undefined;
  }
  if (
    projection.githubPullRequest === 'CLOSED_UNMERGED' ||
    projection.merge === 'CLOSED_UNMERGED'
  ) {
    return { label: 'Closed without merge', kind: 'delivery', tone: 'error' };
  }
  // While the agent works on the pull request's asks, what they ask waits on it, not the person.
  if (IN_FLIGHT_RUNS.has(projection.agentRun)) {
    return undefined;
  }
  // A board summary carries the facts behind the word, which the Inbox states beneath it.
  const facts = 'delivery' in task ? task.delivery : undefined;
  // Check names, reviewers, branches and push errors are the platform's own text, shown as written.
  const detail = (value: string | undefined) => value ? { detail: value } : {};
  // The word follows the step's order: a push that failed, a worktree out of step with the pull
  // request, then a base that moved, then failed checks, then requested changes. What ran or was
  // asked describes commits the merge would not hold until the step before it is taken. The
  // publication record alone says a push failed, as PR Status reads it; later readings reset health.
  if (projection.branchPublication === 'FAILED' || projection.branchPublication === 'AMBIGUOUS') {
    return { label: projection.branchPublication === 'FAILED' ? 'Push failed' : 'Push unconfirmed', kind: 'delivery', tone: 'error', ...detail(facts?.pushError) };
  }
  const checksFailed = projection.ciChecks === 'FAILING' || projection.ciChecks === 'BLOCKED';
  // Once the person answered, the review waits on its reviewers: nothing asks here until one of them writes.
  const changesRequested = projection.reviews === 'CHANGES_REQUESTED' && facts?.turn !== 'REVIEWERS';
  const moved = facts?.baseMoved;
  // Fixes waiting in the worktree, or a branch that moved beside the pull request, come before what
  // stands on it: pushing them, or bringing in what moved, is the next step.
  const outOfStep = hasPullRequest(projection) && (checksFailed || changesRequested || moved || projection.merge === 'BLOCKED')
    ? describeOutOfStep(task)
    : undefined;
  if (outOfStep) {
    return outOfStep;
  }
  if (moved) {
    return { label: 'Merge blocked', kind: 'delivery', tone: 'error', ...detail(baseMovedLine(moved.reason, moved.base)) };
  }
  if (checksFailed) {
    return { label: 'Checks failed', kind: 'delivery', tone: 'error', ...detail(failedChecksLine(facts?.failingChecks)) };
  }
  if (changesRequested) {
    return { label: 'Changes requested', kind: 'delivery', tone: 'warning', ...detail(facts?.feedback ? pullRequestFeedbackLine(facts.feedback) : undefined) };
  }
  if (projection.merge === 'BLOCKED') {
    return { label: 'Merge blocked', kind: 'delivery', tone: 'error' };
  }
  const hasDeliveryEvidence =
    hasPullRequest(projection) ||
    projection.ciChecks !== 'NOT_APPLICABLE' ||
    projection.reviews !== 'NOT_APPLICABLE' ||
    projection.merge !== 'NOT_APPLICABLE';
  if (projection.health === 'ERROR' && hasDeliveryEvidence) {
    // The summary here can carry raw GitHub states; the label is the fact.
    return { label: 'Delivery needs attention', kind: 'delivery', tone: 'error' };
  }
  return undefined;
}

/**
 * A worktree out of step with its pull request, named as PR Status names it: a
 * branch that diverged from it, or, under a worktree with nothing of its own, a
 * pull request rewritten; else work the pull request does not hold yet.
 */
export function describeOutOfStep(task: TaskAttentionSource): TaskAttentionDescriptor | undefined {
  switch (task.projection.git) {
    case 'DIVERGED':
      // A pull request rewritten under a worktree with nothing of its own is news, not a conflict.
      return 'pullRequestRewritten' in task && task.pullRequestRewritten
        ? { label: `${deliveryNoun(deliveryProvider(task))} rewritten`, kind: 'delivery', tone: 'warning' }
        : { label: 'Branch diverged', kind: 'delivery', tone: 'error' };
    case 'DIRTY':
    case 'COMMITTED_UNPUSHED':
      return { label: 'Changes not pushed', kind: 'delivery', tone: 'warning' };
    default:
      return undefined;
  }
}

/** The failed checks by name: "unit and lint failed", or "unit, lint and 3 more failed". */
function failedChecksLine(failed: { names: readonly string[]; count: number } | undefined): string | undefined {
  if (!failed?.names.length) return undefined;
  const { names, count } = failed;
  if (count > names.length) return `${names.slice(0, 2).join(', ')} and ${count - Math.min(2, names.length)} more failed`;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} failed`;
}

/**
 * The status word for an attention state, as the board card, the task header
 * and the Inbox all show it: failures in error ink, everything else the user
 * owes in action ink.
 */
export function describeAttentionStatus(
  attention: TaskAttentionDescriptor
): { label: string; tone: 'action' | 'error' } {
  return { label: attention.label, tone: attention.tone === 'error' ? 'error' : 'action' };
}

export function isAttentionTask(task: TaskAttentionSource): boolean {
  return Boolean(describeTaskAttention(task));
}

export function isInFlightTask(task: TaskAttentionSource): boolean {
  return IN_FLIGHT_RUNS.has(task.projection.agentRun);
}
