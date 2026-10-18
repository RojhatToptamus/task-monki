import {
  effectiveReviewGateStatus,
  getImplementationRetryReason,
  type BoardTaskSummary,
  type Task
} from '../../shared/contracts';
import { isImplementationOutcomeBlocked } from './nextAction';
import { deliveryProvider, deliveryWords } from './deliveryWords';
import { hasPullRequest, isClosedPhase, isMerged } from './taskPhase';
import { pullRequestFeedbackLine } from './pullRequestFeedback';

export type TaskAttentionSource = Task | BoardTaskSummary;

/** A board summary names its platform only through its recorded pull request. */
function attentionDeliverySource(task: TaskAttentionSource): Parameters<typeof deliveryProvider>[0] {
  return { remoteSource: 'remoteSource' in task ? task.remoteSource : undefined, projection: task.projection };
}

export type TaskAttentionTone = 'warning' | 'error' | 'info';

/** What the user is asked for, so a surface can mark it with one glyph. */
export type TaskAttentionKind = 'approval' | 'question' | 'retry' | 'failure' | 'checkout' | 'git' | 'review' | 'delivery' | 'finish';

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

  const gitAttention = describeGitAttention(task);
  if (gitAttention) {
    return gitAttention;
  }

  const reviewAttention = describeReviewAttention(task);
  if (reviewAttention) {
    return reviewAttention;
  }

  const deliveryAttention = describeDeliveryAttention(task);
  if (deliveryAttention) {
    return deliveryAttention;
  }

  if (task.projection.health === 'ERROR') {
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

function describeGitAttention(
  task: TaskAttentionSource
): TaskAttentionDescriptor | undefined {
  switch (task.projection.git) {
    case 'CONFLICTED':
      return { label: 'Git conflicts', kind: 'git', tone: 'error' };
    case 'UNAVAILABLE':
      return { label: 'Git unavailable', kind: 'git', tone: 'error' };
  }
  return undefined;
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
    return { label: deliveryWords('PR closed without merge', deliveryProvider(attentionDeliverySource(task))), kind: 'delivery', tone: 'error' };
  }
  // While the agent works on the pull request's asks, what they ask waits on it, not the person.
  if (IN_FLIGHT_RUNS.has(projection.agentRun)) {
    return undefined;
  }
  // A board summary carries the facts behind the word, which the Inbox states beneath it.
  const facts = 'delivery' in task ? task.delivery : undefined;
  const detail = (value: string | undefined) => value ? { detail: deliveryWords(value, deliveryProvider(attentionDeliverySource(task))) } : {};
  // Fixes waiting in the worktree come before what they answer: pushing them is the next step.
  const unpushed = hasPullRequest(projection) && (projection.git === 'DIRTY' || projection.git === 'COMMITTED_UNPUSHED');
  if (projection.ciChecks === 'FAILING' || projection.ciChecks === 'BLOCKED') {
    return { label: unpushed ? 'Changes not pushed' : 'Checks failed', kind: 'delivery', tone: unpushed ? 'warning' : 'error', ...detail(failedChecksLine(facts?.failingChecks)) };
  }
  // Once the person answered, the review waits on its reviewers: nothing asks here until one of them writes.
  if (projection.reviews === 'CHANGES_REQUESTED' && facts?.turn !== 'REVIEWERS') {
    return { label: unpushed ? 'Changes not pushed' : 'Changes requested', kind: 'delivery', tone: 'warning', ...detail(facts?.feedback ? pullRequestFeedbackLine(facts.feedback) : undefined) };
  }
  if (projection.merge === 'BLOCKED') {
    const moved = facts?.baseMoved;
    return { label: 'Merge blocked', kind: 'delivery', tone: 'error',
      ...detail(moved ? `${moved.reason === 'CONFLICTS' ? 'Conflicts with' : 'Behind'} ${moved.base}` : undefined) };
  }
  const hasDeliveryEvidence =
    hasPullRequest(projection) ||
    projection.ciChecks !== 'NOT_APPLICABLE' ||
    projection.reviews !== 'NOT_APPLICABLE' ||
    projection.merge !== 'NOT_APPLICABLE';
  if (projection.health === 'ERROR' && hasDeliveryEvidence) {
    // A push the remote refused is the usual cause, and the one word that says what failed;
    // one that may have landed is unconfirmed until a retry checks the remote.
    if (projection.branchPublication === 'FAILED' || projection.branchPublication === 'AMBIGUOUS') {
      return { label: projection.branchPublication === 'FAILED' ? 'Push failed' : 'Push unconfirmed', kind: 'delivery', tone: 'error', ...detail(facts?.pushError) };
    }
    // The summary here can carry raw GitHub states; the label is the fact.
    return { label: 'Delivery needs attention', kind: 'delivery', tone: 'error' };
  }
  return undefined;
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
