import type { Board, WorkflowPhase } from '../../shared/contracts';

export function selectBoardTasks<T extends {
  repositoryId: string;
  workflowPhase: WorkflowPhase;
}>(
  tasks: readonly T[],
  board: Board | undefined
): T[] {
  if (!board) return [...tasks];
  const repositoryIds = new Set(board.repositoryIds);
  const workflowPhases = new Set(board.workflowPhases);
  return tasks.filter(
    (task) =>
      (repositoryIds.size === 0 || repositoryIds.has(task.repositoryId)) &&
      (workflowPhases.size === 0 || workflowPhases.has(task.workflowPhase))
  );
}

export function shouldShowTaskRepository(board: Board | undefined): boolean {
  return board?.repositoryIds.length !== 1;
}
