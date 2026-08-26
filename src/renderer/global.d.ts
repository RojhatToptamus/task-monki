import type { TaskManagerApi } from '../shared/contracts';
import type { TaskManagerShellApi } from '../shared/shell';
import type { PreviewPrivateInputApi } from '../shared/preview';
import type { DesignCanvasApi } from '../shared/designCanvas';

declare global {
  interface Window {
    taskManager: TaskManagerApi;
    taskManagerShell?: TaskManagerShellApi;
    previewPrivateInputs?: PreviewPrivateInputApi;
    designCanvas?: DesignCanvasApi;
  }
}

export {};
