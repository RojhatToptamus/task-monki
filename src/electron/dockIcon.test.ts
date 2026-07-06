import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMacDockIconPath } from './dockIcon';

describe('getMacDockIconPath', () => {
  it('uses the packaged resources icon on macOS app bundles', () => {
    expect(
      getMacDockIconPath({
        appPath: '/Applications/Task Monki.app/Contents/Resources/app.asar',
        isPackaged: true,
        resourcesPath: '/Applications/Task Monki.app/Contents/Resources'
      })
    ).toBe(path.join('/Applications/Task Monki.app/Contents/Resources', 'icon.png'));
  });

  it('uses the repository build icon while running unpackaged', () => {
    expect(
      getMacDockIconPath({
        appPath: '/repo/task-manager',
        isPackaged: false,
        resourcesPath: '/Applications/Electron.app/Contents/Resources'
      })
    ).toBe(path.join('/repo/task-manager', 'build', 'icon.png'));
  });
});
