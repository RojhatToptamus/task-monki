import type { TaskManagerApi } from '../shared/contracts';
import type { TaskManagerShellApi } from '../shared/shell';
import type { DesignCanvasApi } from '../shared/designCanvas';

declare global {
  interface Window {
    taskManager: TaskManagerApi;
    previewSecrets?: import('../shared/applicationPreview').PreviewSecretsApi;
    taskManagerShell?: TaskManagerShellApi;
    designCanvas?: DesignCanvasApi;
  }
}

export {};
