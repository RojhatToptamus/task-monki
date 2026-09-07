import type { RunRecord, Task, WorkflowPhase, WorktreeRecord } from '../../shared/contracts';
import {
  isCompletedCurrentImplementationRun,
  isImplementationRetryRequired
} from './nextAction';

export function isReviewPhase(phase: WorkflowPhase): boolean {
  return phase === 'REVIEW' || phase === 'IN_REVIEW';
}

export function canReviewExistingWork(task: Task, worktree?: WorktreeRecord): boolean {
  return worktree?.ownership === 'EXTERNAL' && !task.currentRunId &&
    task.projection.worktree === 'PRESENT' &&
    !['CONFLICTED', 'UNAVAILABLE', 'UNKNOWN'].includes(task.projection.git);
}

export function shouldShowMoveToReviewHeaderAction(
  task: Pick<Task, 'currentRunId' | 'workflowPhase' | 'projection'>,
  run: Pick<RunRecord, 'id' | 'mode' | 'status'> | undefined
): boolean {
  return (
    isCompletedCurrentImplementationRun(task, run) &&
    !isImplementationRetryRequired(task, run) &&
    !['REVIEW', 'IN_REVIEW', 'DONE', 'CANCELED', 'ARCHIVED'].includes(
      task.workflowPhase
    )
  );
}
