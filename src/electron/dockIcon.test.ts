import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMacDockIconPath } from './dockIcon';

describe('getMacDockIconPath', () => {
  it('does not replace the bundle icon on packaged app launches', () => {
    expect(
      getMacDockIconPath({
        appPath: '/Applications/Task Monki.app/Contents/Resources/app.asar',
        isPackaged: true
      })
    ).toBeUndefined();
  });

  it('uses the repository build icon while running unpackaged', () => {
    expect(
      getMacDockIconPath({
        appPath: '/repo/task-manager',
        isPackaged: false
      })
    ).toBe(path.join('/repo/task-manager', 'build', 'icon.png'));
  });
});
