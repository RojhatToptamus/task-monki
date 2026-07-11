import { shell } from 'electron';
import type { PreviewUrlHost } from '../core/preview/runtime/PreviewOpenService';

export function createElectronPreviewUrlHost(): PreviewUrlHost {
  return {
    async openExternal(url: string) {
      await shell.openExternal(url);
    }
  };
}
