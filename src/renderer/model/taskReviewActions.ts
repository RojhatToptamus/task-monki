import type { RunRecord, Task, WorkflowPhase } from '../../shared/contracts';
import {
  isCompletedCurrentImplementationRun,
  isImplementationRetryRequired
} from './nextAction';

export function isReviewPhase(phase: WorkflowPhase): boolean {
  return phase === 'REVIEW' || phase === 'IN_REVIEW';
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
