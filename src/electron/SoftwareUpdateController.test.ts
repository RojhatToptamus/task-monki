import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  SoftwareUpdateController,
  type SoftwareUpdater
} from './SoftwareUpdateController';

class FakeUpdater extends EventEmitter implements SoftwareUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = true;
  allowPrerelease = true;
  disableWebInstaller = false;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
}

describe('SoftwareUpdateController', () => {
  it('configures explicit downloads and stable releases', () => {
    const updater = new FakeUpdater();
    const controller = new SoftwareUpdateController(updater, true, '0.2.0', () => undefined);

    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      disableWebInstaller: true
    });
    controller.dispose();
  });

  it('checks, downloads, and reports progress without exposing updater errors', async () => {
    const updater = new FakeUpdater();
    const published: string[] = [];
    const controller = new SoftwareUpdateController(
      updater,
      true,
      '0.2.0',
      (state) => published.push(state.status),
      () => new Date('2026-08-26T12:00:00.000Z')
    );
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('update-available', { version: '0.2.1' });
    });

    await controller.checkForUpdates();
    expect(controller.getState()).toMatchObject({
      status: 'available',
      currentVersion: '0.2.0',
      availableVersion: '0.2.1',
      lastCheckedAt: '2026-08-26T12:00:00.000Z'
    });

    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('download-progress', {
        percent: 37.4,
        transferred: 374,
        total: 1_000,
        bytesPerSecond: 100
      });
      updater.emit('update-downloaded', { version: '0.2.1' });
    });
    await controller.downloadUpdate();

    expect(controller.getState()).toMatchObject({
      status: 'downloaded',
      availableVersion: '0.2.1',
      progress: null
    });
    expect(published).toContain('downloading');
    controller.dispose();
  });

  it('keeps the known version so a failed download can be retried', async () => {
    const updater = new FakeUpdater();
    const controller = new SoftwareUpdateController(updater, true, '0.2.0', () => undefined);
    updater.emit('update-available', { version: '0.2.1' });
    updater.downloadUpdate.mockRejectedValueOnce(new Error('private network detail'));

    await controller.downloadUpdate();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      availableVersion: '0.2.1',
      errorMessage: 'Could not download the update.'
    });
    controller.dispose();
  });

  it('installs only after a download and controls relaunch behavior', () => {
    const updater = new FakeUpdater();
    const controller = new SoftwareUpdateController(updater, true, '0.2.0', () => undefined);

    expect(() => controller.installUpdate(true)).toThrow('No downloaded update');
    updater.emit('update-downloaded', { version: '0.2.1' });
    controller.installUpdate(false);

    expect(updater.autoRunAppAfterInstall).toBe(false);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, false);
    controller.dispose();
  });

  it('stays unavailable when the current package cannot self-update', async () => {
    const updater = new FakeUpdater();
    const controller = new SoftwareUpdateController(updater, false, '0.2.0', () => undefined);

    await controller.checkForUpdates();
    expect(controller.getState().status).toBe('unavailable');
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
