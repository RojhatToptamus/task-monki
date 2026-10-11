import type { RunRecord, Task, WorktreeRecord } from '../../shared/contracts';
import {
  isCompletedCurrentImplementationRun,
  isImplementationRetryRequired
} from './nextAction';
import { isClosedPhase, isReviewPhase } from './taskPhase';

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
    !isReviewPhase(task.workflowPhase) &&
    !isClosedPhase(task.workflowPhase)
  );
}
