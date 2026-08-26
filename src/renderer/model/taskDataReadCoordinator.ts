import type {
  BoardSnapshot,
  TaskDetailSnapshot
} from '../../shared/contracts';

export interface TaskDataReadCoordinator {
  refreshBoard(): Promise<void>;
  openTask(taskId: string): Promise<void>;
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

  const refreshBoard = async () => {
    const generation = ++boardGeneration;
    try {
      const snapshot = await input.readBoard();
      if (generation === boardGeneration) input.applyBoard(snapshot);
    } catch (error) {
      if (generation === boardGeneration) input.reportBoardError(error);
    }
  };

  const readActiveTask = async (taskId: string, generation: number) => {
    try {
      const detail = await input.readTaskDetail(taskId);
      if (
        generation === detailGeneration &&
        taskId === activeTaskId
      ) {
        input.applyTaskDetail(detail);
      }
    } catch (error) {
      if (
        generation === detailGeneration &&
        taskId === activeTaskId
      ) {
        input.reportTaskDetailError(taskId, error);
      }
    }
  };

  return {
    refreshBoard,
    openTask(taskId) {
      activeTaskId = taskId;
      const generation = ++detailGeneration;
      return readActiveTask(taskId, generation);
    },
    refreshSelectedTask() {
      if (!activeTaskId) return Promise.resolve();
      const generation = ++detailGeneration;
      return readActiveTask(activeTaskId, generation);
    },
    closeTask() {
      activeTaskId = undefined;
      detailGeneration += 1;
    },
    selectedTaskId() {
      return activeTaskId;
    }
  };
}
