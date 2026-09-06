import { describe, expect, it } from 'vitest';
import { makeGitSnapshotRecord, makeRunRecord, makeTaskRecord, TEST_NOW } from '../../testSupport/rendererRecords';
import type { WorktreeRecord } from '../../shared/contracts';
import { hasCurrentReviewEvidence, shouldShowMoveToReviewHeaderAction } from './taskReviewActions';
import { canCreateDeliveryCommit, canPrepareWorktree, selectActiveRun } from './selectors';

describe('shouldShowMoveToReviewHeaderAction', () => {
  const worktree: WorktreeRecord = {
    id: 'worktree-1', taskId: 'task-1', iterationId: 'iteration-1', repositoryId: 'repository-1',
    ownership: 'EXTERNAL', worktreePath: '/tmp/external', branchName: 'feature', baseSha: 'base',
    status: 'PRESENT', createdAt: TEST_NOW, updatedAt: TEST_NOW
  };

  it('allows explicit run-free readiness without turning detached review history into a primary run', () => {
    const task = makeTaskRecord({ workflowPhase: 'IN_PROGRESS', projection: { worktree: 'PRESENT', git: 'DIRTY' } });
    const review = makeRunRecord({ mode: 'REVIEW', status: 'COMPLETED' });
    expect(shouldShowMoveToReviewHeaderAction(task, undefined, worktree)).toBe(true);
    expect(selectActiveRun(task, [review])).toBeUndefined();
    expect(selectActiveRun({ ...task, currentRunId: review.id }, [review])).toBeUndefined();
    expect(canCreateDeliveryCommit(task, worktree)).toBe(false);
    expect(canPrepareWorktree(task, { ...worktree, status: 'MISSING' })).toBe(false);
  });

  it('requires current review ownership and both Git observations before deriving follow-up work', () => {
    const task = makeTaskRecord({ currentIterationId: 'iteration-1', currentWorktreeId: worktree.id, projection: { agentReview: { status: 'NEEDS_CHANGES', runId: 'review-1' } } });
    const review = makeRunRecord({ id: 'review-1', mode: 'REVIEW', beforeGitSnapshotId: 'before', afterGitSnapshotId: 'after' });
    const snapshots = [makeGitSnapshotRecord({ id: 'before' }), makeGitSnapshotRecord({ id: 'after' })];
    expect(hasCurrentReviewEvidence(task, review, snapshots)).toBe(true);
    expect(hasCurrentReviewEvidence(task, review, snapshots.slice(0, 1))).toBe(false);
    expect(hasCurrentReviewEvidence(task, { ...review, id: 'old-review' }, snapshots)).toBe(false);
    expect(hasCurrentReviewEvidence({ ...task, projection: { ...task.projection, agentReview: { status: 'STALE', runId: review.id } } }, review, snapshots)).toBe(false);
  });

  it.each([
    ['ANALYSIS', false],
    ['COMPACTION', false],
    ['IMPLEMENTATION', true]
  ] as const)('returns %s completion eligibility as %s', (mode, expected) => {
    const task = makeTaskRecord({
      currentRunId: 'current-run',
      workflowPhase: 'IN_PROGRESS'
    });
    const run = makeRunRecord({
      id: 'current-run',
      mode,
      status: 'COMPLETED'
    });

    expect(shouldShowMoveToReviewHeaderAction(task, run)).toBe(expected);
  });

  it('hides the action when local evidence requires another implementation pass', () => {
    const task = makeTaskRecord({
      currentRunId: 'current-run',
      workflowPhase: 'IN_PROGRESS',
      projection: {
        requestedAction: 'FAILED',
        agentRun: 'COMPLETED',
        implementationRetry: {
          runId: 'current-run',
          reason: 'Retry before review.'
        }
      }
    });
    const run = makeRunRecord({ id: 'current-run', status: 'COMPLETED' });

    expect(shouldShowMoveToReviewHeaderAction(task, run)).toBe(false);
  });
});
