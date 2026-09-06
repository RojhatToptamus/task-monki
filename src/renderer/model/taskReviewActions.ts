import type { GitSnapshotRecord, RunRecord, Task, WorkflowPhase, WorktreeRecord } from '../../shared/contracts';
import {
  isCompletedCurrentImplementationRun,
  isImplementationRetryRequired
} from './nextAction';

export function isReviewPhase(phase: WorkflowPhase): boolean {
  return phase === 'REVIEW' || phase === 'IN_REVIEW';
}

export function shouldShowMoveToReviewHeaderAction(
  task: Pick<Task, 'currentRunId' | 'workflowPhase' | 'projection'>,
  run: Pick<RunRecord, 'id' | 'mode' | 'status'> | undefined,
  worktree?: WorktreeRecord
): boolean {
  return (
    (isCompletedCurrentImplementationRun(task, run) || isRunFreeAttachedTask(task, worktree)) &&
    !isImplementationRetryRequired(task, run) &&
    !['REVIEW', 'IN_REVIEW', 'DONE', 'CANCELED', 'ARCHIVED'].includes(
      task.workflowPhase
    )
  );
}

export function isRunFreeAttachedTask(
  task: Pick<Task, 'currentRunId'>,
  worktree: WorktreeRecord | undefined
): boolean {
  return !task.currentRunId && worktree?.ownership === 'EXTERNAL';
}

export function hasCurrentReviewEvidence(
  task: Task,
  reviewRun: RunRecord | undefined,
  gitSnapshots: readonly GitSnapshotRecord[]
): boolean {
  const gate = task.projection.agentReview;
  if (
    !gate || ['NOT_RUN', 'RUNNING', 'STALE'].includes(gate.status) ||
    !reviewRun || reviewRun.mode !== 'REVIEW' || gate.runId !== reviewRun.id ||
    reviewRun.taskId !== task.id || reviewRun.iterationId !== task.currentIterationId ||
    reviewRun.worktreeId !== task.currentWorktreeId || task.projection.git === 'UNAVAILABLE'
  ) return false;
  return [reviewRun.beforeGitSnapshotId, reviewRun.afterGitSnapshotId].every((id) =>
    Boolean(id && gitSnapshots.some((snapshot) =>
      snapshot.id === id && snapshot.taskId === task.id &&
      snapshot.iterationId === reviewRun.iterationId && snapshot.worktreeId === reviewRun.worktreeId
    ))
  );
}
