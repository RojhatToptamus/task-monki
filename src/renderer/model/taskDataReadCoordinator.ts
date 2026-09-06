import type {
  BoardSnapshot,
  TaskDetailSnapshot
} from '../../shared/contracts';

export type TaskOpenResult = 'opened' | 'failed' | 'superseded';

export interface TaskDataReadCoordinator {
  refreshBoard(): Promise<void>;
  openTask(taskId: string): Promise<TaskOpenResult>;
  refreshSelectedTask(): Promise<void>;
  closeTask(): void;
  selectedTaskId(): string | undefined;
}

export function createTaskDataReadCoordinator(input: {
  readBoard(): Promise<BoardSnapshot>;
  readTaskDetail(taskId: string): Promise<TaskDetailSnapshot>;
  applyBoard(snapshot: BoardSnapshot): void;
  applyTaskDetail(detail: TaskDetailSnapshot): void;
  reportBoardError(error: unknown): void;
  reportTaskDetailError(taskId: string, error: unknown): void;
}): TaskDataReadCoordinator {
  let boardGeneration = 0;
  let detailGeneration = 0;
  let activeTaskId: string | undefined;
  let activeDetailRead: Promise<TaskOpenResult> | undefined;

  const refreshBoard = async () => {
    const generation = ++boardGeneration;
    try {
      const snapshot = await input.readBoard();
      if (generation === boardGeneration) input.applyBoard(snapshot);
    } catch (error) {
      if (generation === boardGeneration) input.reportBoardError(error);
    }
  };

  const readActiveTask = async (taskId: string, generation: number): Promise<TaskOpenResult> => {
    try {
      const detail = await input.readTaskDetail(taskId);
      if (
        generation === detailGeneration &&
        taskId === activeTaskId
      ) {
        input.applyTaskDetail(detail);
        return 'opened';
      }
    } catch (error) {
      if (
        generation === detailGeneration &&
        taskId === activeTaskId
      ) {
        input.reportTaskDetailError(taskId, error);
        return 'failed';
      }
    }
    // A refresh of this same task may overtake its opening read. Navigation
    // follows that read's result; switching to a different task is not an error.
    return taskId === activeTaskId && activeDetailRead
      ? activeDetailRead : 'superseded';
  };

  return {
    refreshBoard,
    openTask(taskId) {
      activeTaskId = taskId;
      const generation = ++detailGeneration;
      activeDetailRead = readActiveTask(taskId, generation);
      return activeDetailRead;
    },
    async refreshSelectedTask() {
      if (!activeTaskId) return;
      const generation = ++detailGeneration;
      activeDetailRead = readActiveTask(activeTaskId, generation);
      await activeDetailRead;
    },
    closeTask() {
      activeTaskId = undefined;
      activeDetailRead = undefined;
      detailGeneration += 1;
    },
    selectedTaskId() {
      return activeTaskId;
    }
  };
}
