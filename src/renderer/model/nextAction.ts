import type { CodexReviewGateStatus, Task } from '../../shared/contracts';
import type { FinishEvidenceState, FinishRequirement } from '../ui/taskView';

/**
 * The single "what should I do next?" answer for a task's Overview. The audit
 * (§04) found this scattered across the header, two card footers, and the rail;
 * this selector centralizes it so one rail panel can render a status sentence
 * plus exactly one recommended (filled) action, with escape hatches demoted to
 * quiet buttons. It decides *which* action leads and *what to say* — the UI owns
 * the click handlers and disabled reasons.
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
  /** One sentence answering "where is this task and what's the ask?". */
  sentence: string;
  /** The recommended action — the page's only filled button (undefined while busy/idle). */
  primary?: NextActionChoice;
  /** Escape hatches — quiet buttons offered alongside the primary. */
  secondaries: NextActionChoice[];
}

export interface NextActionInput {
  task: Task;
  reviewStatus: CodexReviewGateStatus;
  finishEvidence: FinishEvidenceState;
  requirements: FinishRequirement[];
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
}

const REQUEST_CHANGES: NextActionChoice = { id: 'request-changes', label: 'Request changes' };
const RUN_REVIEW: NextActionChoice = { id: 'run-review', label: 'Run review' };
const RUN_REVIEW_AGAIN: NextActionChoice = { id: 'run-review-again', label: 'Run review again' };
const COMMIT: NextActionChoice = { id: 'commit', label: 'Commit' };
const MOVE_TO_REVIEW: NextActionChoice = { id: 'move-to-review', label: 'Move to review' };

function markDone(withIssues: boolean): NextActionChoice {
  return withIssues
    ? { id: 'mark-done-anyway', label: 'Mark done anyway' }
    : { id: 'mark-done', label: 'Mark done' };
}

/** The first unresolved requirement's phrase, e.g. "Tree 3 dirty". */
function firstUnresolved(requirements: FinishRequirement[]): string | undefined {
  const unresolved = requirements.find((requirement) => requirement.unresolved);
  return unresolved ? `${unresolved.label} ${unresolved.detail}` : undefined;
}

function countActionableFindings(task: Task): number {
  return task.projection.codexReview?.result?.findings?.length ?? 0;
}

export function selectNextAction(input: NextActionInput): NextActionModel {
  const {
    task,
    reviewStatus,
    finishEvidence,
    requirements,
    hasReviewSource,
    reviewHasActionableFindings,
    canCommit,
    awaitingMoveToReview,
    runInFlight
  } = input;

  if (task.workflowPhase === 'DONE') {
    return { sentence: 'This task is done.', secondaries: [] };
  }

  // While something is running, the run surface carries the live state and the
  // Stop control — Next action just names what we're waiting for.
  if (runInFlight || reviewStatus === 'RUNNING') {
    return {
      sentence:
        reviewStatus === 'RUNNING'
          ? 'Reviewing the current diff.'
          : 'The agent is working — follow progress above.',
      secondaries: []
    };
  }

  if (awaitingMoveToReview) {
    return {
      sentence: 'Implementation finished. Move it to review to run the quality gate.',
      primary: MOVE_TO_REVIEW,
      secondaries: []
    };
  }

  switch (reviewStatus) {
    case 'NOT_RUN':
      return {
        sentence: hasReviewSource
          ? 'Ready for review — run a review against the current diff.'
          : 'Run an implementation before reviewing.',
        primary: hasReviewSource ? RUN_REVIEW : undefined,
        secondaries: []
      };
    case 'NEEDS_CHANGES':
    case 'INCONCLUSIVE': {
      const count = countActionableFindings(task);
      const sentence =
        count > 0
          ? `Review found ${count} finding${count === 1 ? '' : 's'} — fix before delivery.`
          : 'Review requested changes — address them before delivery.';
      return {
        sentence,
        primary: reviewHasActionableFindings ? REQUEST_CHANGES : RUN_REVIEW_AGAIN,
        secondaries: reviewHasActionableFindings ? [RUN_REVIEW_AGAIN] : []
      };
    }
    case 'FAILED':
    case 'CANCELED':
    case 'STALE': {
      const staleNote =
        reviewStatus === 'STALE'
          ? 'The diff changed since the last review — re-run it before finishing cleanly.'
          : `The last review is ${reviewStatus.toLowerCase()} — run it again.`;
      const secondaries = reviewHasActionableFindings ? [REQUEST_CHANGES] : [];
      return { sentence: staleNote, primary: RUN_REVIEW_AGAIN, secondaries };
    }
    case 'PASSED':
      break;
  }

  // Review passed (or is not gating): the task is toward delivery. Lead with the
  // first thing still standing between the task and done.
  const gate = firstUnresolved(requirements);
  if (finishEvidence.mode === 'blocked') {
    return {
      sentence: gate
        ? `Blocked from finishing: ${gate}.`
        : 'This task cannot be marked done yet.',
      secondaries: canCommit ? [COMMIT] : []
    };
  }

  if (finishEvidence.mode === 'override') {
    return {
      sentence: gate
        ? `Review passed. ${gate} — commit it or mark done anyway.`
        : 'Review passed with unresolved checks — commit or mark done anyway.',
      primary: canCommit ? COMMIT : markDone(true),
      secondaries: canCommit ? [markDone(true)] : []
    };
  }

  return {
    sentence: 'Review passed and the tree is clean — mark the task done.',
    primary: markDone(false),
    secondaries: canCommit ? [COMMIT] : []
  };
}
