import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
      disabledRuntimeIds: [],
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

  it('merges runtime-owned executable paths without resetting other runtimes', async () => {
    const store = new MemoryAppSettingsStore({
      runtimeExecutablePaths: {
        opencode: '/opt/opencode',
        'cursor-agent-acp': '/opt/cursor-agent'
      }
    });

    const settings = await store.update({
      runtimeExecutablePaths: {
        opencode: null,
        'grok-acp': '/opt/grok'
      }
    });

    expect(settings.runtimeExecutablePaths).toEqual({
      opencode: null,
      'cursor-agent-acp': '/opt/cursor-agent',
      'grok-acp': '/opt/grok'
    });
  });

  it('normalizes disabled runtime identities as a unique ordered set', async () => {
    const store = new MemoryAppSettingsStore();

    const settings = await store.update({
      disabledRuntimeIds: [' grok-acp ', 'cursor-agent-acp', 'grok-acp', '']
    });

    expect(settings.disabledRuntimeIds).toEqual(['grok-acp', 'cursor-agent-acp']);
  });

  it('publishes settings in memory only after the durable write succeeds', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-write-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const store = new AppSettingsStore(settingsPath);
    const before = await store.get();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === settingsPath) {
        throw new Error('Injected settings publication failure.');
      }
      return originalRename(source, destination);
    });

    try {
      await expect(store.update({ theme: 'dark' })).rejects.toThrow(
        'settings publication failure'
      );
    } finally {
      rename.mockRestore();
    }

    await expect(store.get()).resolves.toEqual(before);
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(before, null, 2)}\n`
    );
  });

  it('serializes concurrent updates without losing either patch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-queue-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const store = new AppSettingsStore(settingsPath);
    await store.get();

    await Promise.all([
      store.update({ theme: 'dark' }),
      store.update({ disabledRuntimeIds: ['opencode'] })
    ]);

    await expect(store.get()).resolves.toMatchObject({
      theme: 'dark',
      disabledRuntimeIds: ['opencode']
    });
  });

  it('preserves explicit mascot visibility and defaults it to enabled', async () => {
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

  it.each([4, 7])('upgrades the immediate schema %s predecessor', async (schemaVersion) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-upgrade-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify({
        schemaVersion,
        theme: 'dark',
        repositories: { knownPaths: ['/repo'], selectedPath: '/repo' }
      }, null, 2)}\n`,
      'utf8'
    );

    await expect(new AppSettingsStore(settingsPath).get()).resolves.toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
      theme: 'dark',
      repositories: { knownPaths: ['/repo'], selectedPath: '/repo' }
    });
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toContain(
      `"schemaVersion": ${TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION}`
    );
  });

  it.each([5, TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION + 1])(
    'rejects and preserves unsupported app settings schema %s',
    async (schemaVersion) => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-settings-future-')
      );
      const settingsPath = path.join(dir, 'app-settings.json');
      const raw = `${JSON.stringify({
        schemaVersion,
        defaultRuntimeId: 'future-runtime',
        futureProviderSettings: { retained: true }
      }, null, 2)}\n`;
      await fs.writeFile(settingsPath, raw, 'utf8');

      await expect(new AppSettingsStore(settingsPath).get()).rejects.toThrow(
        'accepts only schema'
      );
      await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe(raw);
      await expect(fs.readdir(dir)).resolves.toEqual(['app-settings.json']);
    }
  );

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
