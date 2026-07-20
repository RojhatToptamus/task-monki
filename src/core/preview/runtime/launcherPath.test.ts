import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNativePreviewLauncherPath } from './launcherPath';

describe('resolveNativePreviewLauncherPath', () => {
  it('uses the extra resource in packaged builds and source only in development', () => {
    expect(
      resolveNativePreviewLauncherPath({ isPackaged: true, resourcesPath: '/app/Contents/Resources', appPath: '/app' })
    ).toBe(path.join('/app/Contents/Resources', 'native-preview-launcher.mjs'));
    expect(
      resolveNativePreviewLauncherPath({ isPackaged: false, resourcesPath: '/resources', appPath: '/project' })
    ).toBe(path.join('/project', 'src/core/preview/runtime/native-preview-launcher.mjs'));
  });
});
