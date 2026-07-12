import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION } from '../../shared/agent';
import {
  AppSettingsStore,
  MemoryAppSettingsStore,
  normalizeAppSettings
} from './AppSettingsStore';

describe('AppSettingsStore', () => {
  it('initializes a missing settings file with normalized defaults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const store = new AppSettingsStore(settingsPath);

    const settings = await store.get();

    expect(settings).toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
      theme: 'device',
      sidebarCollapsed: false,
      showMascot: true,
      firstLaunchSetupCompleted: false,
      externalExecutables: {
        gitExecutablePath: null,
        codexExecutablePath: null,
        ghExecutablePath: null
      }
    });
    await expect(fs.stat(settingsPath)).resolves.toBeTruthy();
    if (process.platform !== 'win32') {
      expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it('merges nested patches without resetting sibling settings', async () => {
    const store = new MemoryAppSettingsStore({
      codexExternalTools: {
        webSearchMode: 'cached',
        mcpServers: 'all',
        apps: 'disabled'
      },
      externalExecutables: {
        gitExecutablePath: '/usr/bin/git',
        codexExecutablePath: '/opt/bin/codex',
        ghExecutablePath: null
      }
    });

    const settings = await store.update({
      codexExternalTools: { apps: 'enabled' },
      externalExecutables: { ghExecutablePath: '/usr/bin/gh' }
    });

    expect(settings.codexExternalTools).toEqual({
      webSearchMode: 'cached',
      mcpServers: 'all',
      apps: 'enabled'
    });
    expect(settings.externalExecutables).toEqual({
      gitExecutablePath: '/usr/bin/git',
      codexExecutablePath: '/opt/bin/codex',
      ghExecutablePath: '/usr/bin/gh'
    });
  });

  it('preserves explicit mascot visibility and defaults legacy settings to enabled', async () => {
    expect(normalizeAppSettings({}).showMascot).toBe(true);
    expect(normalizeAppSettings({ showMascot: false }).showMascot).toBe(false);

    const store = new MemoryAppSettingsStore({ showMascot: true });

    await expect(store.update({ showMascot: false })).resolves.toMatchObject({
      showMascot: false
    });
  });

  it('keeps first-launch setup incomplete when a fresh config adds a repository', async () => {
    const store = new MemoryAppSettingsStore();

    const settings = await store.update({
      repositories: {
        knownPaths: ['/repos/current'],
        selectedPath: '/repos/current'
      }
    });

    expect(settings.firstLaunchSetupCompleted).toBe(false);
    expect(settings.repositories).toEqual({
      knownPaths: ['/repos/current'],
      selectedPath: '/repos/current'
    });
  });

  it('infers first-launch setup as completed for legacy configs that already have repositories', () => {
    expect(
      normalizeAppSettings({
        repositories: {
          knownPaths: ['/repos/current'],
          selectedPath: '/repos/current'
        }
      }).firstLaunchSetupCompleted
    ).toBe(true);
  });

  it('infers first-launch setup for memory stores initialized with legacy repositories', async () => {
    const store = new MemoryAppSettingsStore({
      repositories: {
        knownPaths: ['/repos/current'],
        selectedPath: '/repos/current'
      }
    });

    await expect(store.get()).resolves.toMatchObject({
      firstLaunchSetupCompleted: true
    });
  });

  it('preserves an explicit incomplete first-launch flag with repositories', () => {
    expect(
      normalizeAppSettings({
        firstLaunchSetupCompleted: false,
        repositories: {
          knownPaths: ['/repos/current'],
          selectedPath: '/repos/current'
        }
      }).firstLaunchSetupCompleted
    ).toBe(false);
  });

  it('normalizes empty executable paths as auto-detect', () => {
    expect(
      normalizeAppSettings({
        externalExecutables: {
          gitExecutablePath: '',
          codexExecutablePath: '  ',
          ghExecutablePath: null
        }
      }).externalExecutables
    ).toEqual({
      gitExecutablePath: null,
      codexExecutablePath: null,
      ghExecutablePath: null
    });
  });

  it('persists only a valid high preview gateway port', async () => {
    expect(normalizeAppSettings({ previewGateway: { port: 9999 } }).previewGateway.port).toBeNull();
    expect(normalizeAppSettings({ previewGateway: { port: 31337 } }).previewGateway.port).toBe(31337);
    const store = new MemoryAppSettingsStore();
    await expect(store.update({ previewGateway: { port: 41234 } })).resolves.toMatchObject({
      previewGateway: { port: 41234 }
    });
  });

  it('moves invalid JSON aside and recreates normalized defaults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-invalid-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    await fs.writeFile(settingsPath, '{not valid json', 'utf8');
    const store = new AppSettingsStore(settingsPath);

    await expect(store.get()).resolves.toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
      externalExecutables: {
        gitExecutablePath: null,
        codexExecutablePath: null,
        ghExecutablePath: null
      }
    });
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toContain(
      `"schemaVersion": ${TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION}`
    );
    const files = await fs.readdir(dir);
    expect(files.some((file) => file.startsWith('app-settings.json.invalid-'))).toBe(true);
  });

  it('does not reuse or remove an untrusted legacy settings temporary path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-temp-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const legacyTemporaryPath = `${settingsPath}.tmp`;
    await fs.mkdir(legacyTemporaryPath);
    await fs.writeFile(path.join(legacyTemporaryPath, 'marker'), 'keep');

    await new AppSettingsStore(settingsPath).get();

    await expect(fs.stat(settingsPath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(
      fs.readFile(path.join(legacyTemporaryPath, 'marker'), 'utf8')
    ).resolves.toBe('keep');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a symlinked settings file without reading or replacing its target',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-link-'));
      const settingsPath = path.join(dir, 'app-settings.json');
      const outsidePath = path.join(dir, 'outside.json');
      const outsideContents = JSON.stringify({ theme: 'dark' });
      await fs.writeFile(outsidePath, outsideContents, { mode: 0o600 });
      await fs.symlink(outsidePath, settingsPath);

      await expect(new AppSettingsStore(settingsPath).get()).rejects.toBeTruthy();
      await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe(outsideContents);
      expect((await fs.lstat(settingsPath)).isSymbolicLink()).toBe(true);
    }
  );
});
