import type {
  AgentRunStatus,
  AgentReviewGateStatus,
  RunRecord,
  Task
} from '../../shared/contracts';
import {
  getImplementationRetryReason,
  isImplementationRunMode
} from '../../shared/contracts';
import type { FinishEvidenceState } from './taskFinish';

/**
 * The single "what should I do next?" answer for a task: a short factual title
 * for the step, one recommended action, and the other choices as quiet buttons.
 * The buttons carry the ask, so the title states what is true rather than
 * repeating it. The UI owns click handlers and disabled reasons.
 */

export type NextActionId =
  | 'run-review'
  | 'run-review-again'
  | 'request-changes'
  | 'commit'
  | 'mark-done'
  | 'mark-done-anyway'
  | 'move-to-review';

export interface NextActionChoice {
  id: NextActionId;
  label: string;
}

export interface NextActionModel {
  /** What is true at this step, e.g. "Ready for review". Never an instruction. */
  title: string;
  /** The recommended action (undefined while busy or idle). */
  primary?: NextActionChoice;
  /** Escape hatches — quiet buttons offered alongside the primary. */
  secondaries: NextActionChoice[];
}

export interface NextActionInput {
  task: Task;
  reviewStatus: AgentReviewGateStatus;
  finishEvidence: FinishEvidenceState;
  /** A completed non-review run exists to review / attach findings to. */
  hasReviewSource: boolean;
  /** Findings the current review recorded (drives request-changes availability). */
  reviewHasActionableFindings: boolean;
  /** Delivery commit is possible from the current tree. */
  canCommit: boolean;
  /** Implementation finished but the task has not entered the review phase yet. */
  awaitingMoveToReview: boolean;
  /** An implementation/review run is currently in flight. */
  runInFlight: boolean;
  /** Current implementation-side run status, used to keep recovery ahead of review. */
  implementationRunStatus?: AgentRunStatus;
  /** Provider completed, but Task Monki blocked review after independent evidence checks. */
  implementationRetryRequired?: boolean;
}

const REQUEST_CHANGES: NextActionChoice = { id: 'request-changes', label: 'Request changes' };
const RUN_REVIEW: NextActionChoice = { id: 'run-review', label: 'Run agent review' };
const RUN_REVIEW_AGAIN: NextActionChoice = { id: 'run-review-again', label: 'Run review again' };
const COMMIT: NextActionChoice = { id: 'commit', label: 'Commit' };
const MOVE_TO_REVIEW: NextActionChoice = { id: 'move-to-review', label: 'Move to review' };

function markDone(withIssues: boolean): NextActionChoice {
  return withIssues
    ? { id: 'mark-done-anyway', label: 'Mark done anyway' }
    : { id: 'mark-done', label: 'Mark done' };
}

/**
 * The agent review is a detached gate, so finishing never waits on it: with no
 * run or review in flight, the owner can commit or mark the current result
 * done as an explicit override (PRODUCT_WORKFLOW, Review). A completion policy
 * that still needs merge evidence blocks Mark done; Commit stays available.
 */
function finishOverrides(input: NextActionInput): NextActionChoice[] {
  if (!input.hasReviewSource || !inReviewPhase(input.task)) {
    return [];
  }
  return [
    ...(input.canCommit ? [COMMIT] : []),
    ...(input.finishEvidence.mode === 'blocked'
      ? []
      : [markDone(input.finishEvidence.mode !== 'clean')])
  ];
}

/** Finishing belongs to the Review phases; In Progress work is not finished. */
function inReviewPhase(task: Task): boolean {
  return task.workflowPhase === 'REVIEW' || task.workflowPhase === 'IN_REVIEW';
}

function isMerged(task: Task): boolean {
  return task.projection.merge === 'MERGED' || task.projection.githubPullRequest === 'MERGED';
}

export function isActiveNonReviewRun(
  run: Pick<RunRecord, 'mode' | 'status'>
): boolean {
  return (
    run.mode !== 'REVIEW' &&
    [
      'QUEUED',
      'STARTING',
      'RUNNING',
      'AWAITING_APPROVAL',
      'AWAITING_USER_INPUT',
      'INTERRUPTING'
    ].includes(run.status)
  );
}

export function isCompletedCurrentImplementationRun(
  task: Pick<Task, 'currentRunId'>,
  run: Pick<RunRecord, 'id' | 'mode' | 'status'> | undefined
): boolean {
  return Boolean(
    run &&
      run.id === task.currentRunId &&
      run.status === 'COMPLETED' &&
      isImplementationRunMode(run.mode)
  );
}

export function findCompletedCurrentImplementationRun(
  task: Pick<Task, 'currentRunId'>,
  runs: readonly RunRecord[]
): RunRecord | undefined {
  return runs.find((run) => isCompletedCurrentImplementationRun(task, run));
}

export function isImplementationRetryRequired(
  task: Pick<Task, 'currentRunId' | 'workflowPhase' | 'projection'>,
  run: Pick<RunRecord, 'id' | 'mode' | 'status'> | undefined
): boolean {
  return (
    isCompletedCurrentImplementationRun(task, run) &&
    isImplementationOutcomeBlocked(task)
  );
}

export function isImplementationOutcomeBlocked(
  task: Parameters<typeof getImplementationRetryReason>[0]
): boolean {
  return Boolean(getImplementationRetryReason(task));
}

export function selectNextAction(input: NextActionInput): NextActionModel {
  const {
    task,
    reviewStatus,
    finishEvidence,
    hasReviewSource,
    reviewHasActionableFindings,
    canCommit,
    awaitingMoveToReview,
    runInFlight,
    implementationRunStatus,
    implementationRetryRequired
  } = input;

  if (task.workflowPhase === 'DONE') {
    return { title: 'Done', secondaries: [] };
  }

  // While something is running, the run surface carries the live state and the
  // Stop control — Next action just names what we're waiting for.
  if (runInFlight || reviewStatus === 'RUNNING') {
    return {
      title: reviewStatus === 'RUNNING' ? 'Reviewing' : 'Running',
      secondaries: []
    };
  }

  if (
    implementationRetryRequired ||
    (implementationRunStatus &&
      ['FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
        implementationRunStatus
      ))
  ) {
    return {
      title: implementationRetryRequired
        ? 'Needs retry'
        : implementationRunStatus === 'FAILED'
          ? 'Run failed'
          : implementationRunStatus === 'LOST'
            ? 'Runtime lost'
            : implementationRunStatus === 'RECOVERY_REQUIRED'
              ? 'Recovery required'
              : 'Interrupted',
      secondaries: []
    };
  }

  if (awaitingMoveToReview) {
    return {
      title: 'Completed',
      primary: MOVE_TO_REVIEW,
      secondaries: []
    };
  }

  // A merged pull request has delivered the work. The review gate no longer
  // leads; what remains is finishing under the task's completion policy.
  // Marking done despite open evidence is an owner override, never the
  // recommended step, so it is offered but never leads.
  if (isMerged(task)) {
    return finishEvidence.mode === 'clean'
      ? { title: 'Merged', primary: markDone(false), secondaries: [] }
      : { title: 'Merged', secondaries: finishEvidence.mode === 'override' ? [markDone(true)] : [] };
  }

  switch (reviewStatus) {
    case 'NOT_RUN': {
      return {
        // Outside the Review phases, a review source with nothing completed is imported work.
        title: !hasReviewSource ? 'No completed implementation' : inReviewPhase(task) ? 'Ready for review' : 'No agent run yet',
        primary: hasReviewSource ? RUN_REVIEW : undefined,
        secondaries: finishOverrides(input)
      };
    }
    case 'NEEDS_CHANGES':
    case 'INCONCLUSIVE': {
      if (!hasReviewSource) {
        return { title: 'Review is from an earlier run', secondaries: [] };
      }
      const title = reviewStatus === 'INCONCLUSIVE' ? 'Review inconclusive' : 'Needs changes';
      return {
        title,
        primary: reviewHasActionableFindings ? REQUEST_CHANGES : RUN_REVIEW_AGAIN,
        secondaries: [
          ...(reviewHasActionableFindings ? [RUN_REVIEW_AGAIN] : []),
          ...finishOverrides(input)
        ]
      };
    }
    case 'FAILED':
    case 'CANCELED':
    case 'STALE': {
      if (!hasReviewSource) {
        return { title: 'Review is from an earlier run', secondaries: [] };
      }
      const title =
        reviewStatus === 'STALE'
          ? 'Needs re-review'
          : reviewStatus === 'FAILED'
            ? 'Review failed'
            : 'Review stopped';
      const secondaries = [
        ...(reviewHasActionableFindings ? [REQUEST_CHANGES] : []),
        ...finishOverrides(input)
      ];
      return { title, primary: RUN_REVIEW_AGAIN, secondaries };
    }
    case 'PASSED':
      break;
  }

  // Review passed: the task is toward delivery. What still stands between it
  // and done is listed beside the actions, not folded into the title.
  if (finishEvidence.mode === 'blocked') {
    return {
      title: 'Review passed',
      secondaries: canCommit ? [COMMIT] : []
    };
  }

  if (finishEvidence.mode === 'override') {
    return {
      title: 'Review passed',
      primary: canCommit ? COMMIT : undefined,
      secondaries: [markDone(true)]
    };
  }

  return {
    title: 'Review passed',
    primary: markDone(false),
    secondaries: canCommit ? [COMMIT] : []
  };
}
