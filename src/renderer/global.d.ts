import type { TaskManagerApi } from '../shared/contracts';
import type { TaskManagerShellApi } from '../shared/shell';
import type { PreviewPrivateInputApi } from '../shared/preview';

declare global {
  interface Window {
    taskManager: TaskManagerApi;
    taskManagerShell?: TaskManagerShellApi;
    previewPrivateInputs?: PreviewPrivateInputApi;
  }
}

export {};
