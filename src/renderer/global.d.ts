import type { TaskManagerApi } from '../shared/contracts';

declare global {
  interface Window {
    taskManager: TaskManagerApi;
  }
}

export {};
