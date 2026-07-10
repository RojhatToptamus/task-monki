import type { TaskManagerApi } from '../shared/contracts';
import type { TaskManagerShellApi } from '../shared/shell';

declare global {
  interface Window {
    taskManager: TaskManagerApi;
    taskManagerShell?: TaskManagerShellApi;
  }
}

export {};
