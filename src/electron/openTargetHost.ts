import { app, shell } from 'electron';
import {
  createNodeOpenTargetHost,
  type OpenTargetHost
} from '../core/open/OpenTargetService';

export function createElectronOpenTargetHost(): OpenTargetHost {
  const host = createNodeOpenTargetHost();
  return {
    ...host,
    async openDefault(filePath) {
      const error = await shell.openPath(filePath);
      if (error) {
        throw new Error(error);
      }
    },
    async reveal(filePath) {
      shell.showItemInFolder(filePath);
    },
    async getFileIconDataUrl(filePath) {
      try {
        const icon = await app.getFileIcon(filePath, { size: 'small' });
        if (!icon.isEmpty()) {
          return icon.toDataURL();
        }
      } catch {
        // Fall back to the shared Node host below.
      }
      return await host.getFileIconDataUrl?.(filePath);
    }
  };
}
