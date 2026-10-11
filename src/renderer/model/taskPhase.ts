import type { StatusProjection, WorkflowPhase } from '../../shared/contracts';

/**
 * Plain task-state checks shared across the model. This module imports nothing
 * else from the model, so any model file can use it without an import cycle.
 */

/** Done, Canceled and Archived: the task's work is over. */
export function isClosedPhase(phase: WorkflowPhase): boolean {
  return phase === 'DONE' || phase === 'CANCELED' || phase === 'ARCHIVED';
}

/** Review and In review: the work is reviewed, then delivered. */
export function isReviewPhase(phase: WorkflowPhase): boolean {
  return phase === 'REVIEW' || phase === 'IN_REVIEW';
}

/** Merged, by Task Monki's merge record or by GitHub. */
export function isMerged(projection: Pick<StatusProjection, 'merge' | 'githubPullRequest'>): boolean {
  return projection.merge === 'MERGED' || projection.githubPullRequest === 'MERGED';
}

/** A pull request exists or existed. UNLINKED is every task's initial value. */
export function hasPullRequest(projection: Pick<StatusProjection, 'githubPullRequest'>): boolean {
  return projection.githubPullRequest !== 'UNLINKED' && projection.githubPullRequest !== 'NOT_CREATED';
}
