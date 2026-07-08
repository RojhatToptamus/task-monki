import type { TaskManagerApi } from '../shared/contracts';
import type { WindowChromePlatform } from '../shared/shell';

declare global {
  interface Window {
    taskManager: TaskManagerApi;
    taskManagerShell?: {
      windowChromePlatform: WindowChromePlatform;
    };
  }
}

export {};
