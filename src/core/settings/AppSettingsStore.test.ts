import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
} from '../../shared/agent';
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
      themePreset: 'umber',
      sidebarCollapsed: false,
      showMascot: true,
      autoInstallUpdatesOnQuit: true,
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

  it('preserves explicit mascot visibility in the current schema', async () => {
    expect(normalizeAppSettings(currentSettings()).showMascot).toBe(true);
    expect(normalizeAppSettings(currentSettings({ showMascot: false })).showMascot).toBe(false);

    const store = new MemoryAppSettingsStore({ showMascot: true });

    await expect(store.update({ showMascot: false })).resolves.toMatchObject({
      showMascot: false
    });
  });

  it('migrates schema 10 settings and enables install-on-quit by default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-v10-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const legacy = currentSettings() as Record<string, unknown>;
    legacy.schemaVersion = 10;
    delete legacy.autoInstallUpdatesOnQuit;
    await fs.writeFile(settingsPath, `${JSON.stringify(legacy)}\n`, 'utf8');

    await expect(new AppSettingsStore(settingsPath).get()).resolves.toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
      autoInstallUpdatesOnQuit: true
    });
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toContain(
      '"autoInstallUpdatesOnQuit": true'
    );
  });

  it('migrates schema 11 settings without inventing a Preview generation choice', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-v11-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const previous = currentSettings() as Record<string, unknown>;
    previous.schemaVersion = 11;
    await fs.writeFile(settingsPath, `${JSON.stringify(previous)}\n`, 'utf8');

    const settings = await new AppSettingsStore(settingsPath).get();

    expect(settings).toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
    });
    expect(settings.previewRecipeGenerationRuntimeId).toBeUndefined();
    expect(settings.previewRecipeGenerationModel).toBeUndefined();
    expect(settings.previewRecipeGenerationModelProvider).toBeUndefined();
  });

  it('stores the dedicated Preview recipe generation selection', async () => {
    const store = new MemoryAppSettingsStore();

    await expect(
      store.update({
        previewRecipeGenerationRuntimeId: 'opencode',
        previewRecipeGenerationModel: 'openai/gpt-5',
        previewRecipeGenerationModelProvider: 'openai'
      })
    ).resolves.toMatchObject({
      previewRecipeGenerationRuntimeId: 'opencode',
      previewRecipeGenerationModel: 'openai/gpt-5',
      previewRecipeGenerationModelProvider: 'openai'
    });
  });

  it('stores repository selection as an ID-only UI preference', async () => {
    const store = new MemoryAppSettingsStore();

    const settings = await store.update({
      selectedRepositoryId: 'repository-1'
    });

    expect(settings.firstLaunchSetupCompleted).toBe(false);
    expect(settings.selectedRepositoryId).toBe('repository-1');
  });

  it.each([3, 9])('rejects unsupported settings schema %s', (schemaVersion) => {
    expect(() => normalizeAppSettings({ schemaVersion })).toThrow(
      `Unsupported Task Monki app settings schema ${schemaVersion}`
    );
  });

  it('persists only supported theme presets', async () => {
    const store = new MemoryAppSettingsStore();

    await expect(store.update({ themePreset: 'nocturne' })).resolves.toMatchObject({
      themePreset: 'nocturne'
    });
    await expect(
      store.update({ themePreset: 'unknown' as 'graphite' })
    ).rejects.toThrow('Theme preset is not supported.');
  });

  it('rejects incomplete current-schema settings instead of filling defaults', () => {
    expect(() =>
      normalizeAppSettings({ schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION })
    ).toThrow(`Task Monki app settings schema ${TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION} is invalid`);
  });

  it('normalizes empty executable path updates as auto-detect', async () => {
    const store = new MemoryAppSettingsStore({
      externalExecutables: {
        gitExecutablePath: '/usr/bin/git',
        codexExecutablePath: '/opt/bin/codex',
        ghExecutablePath: '/usr/bin/gh'
      }
    });

    await expect(
      store.update({
        externalExecutables: {
          gitExecutablePath: '',
          codexExecutablePath: '  ',
          ghExecutablePath: null
        }
      })
    ).resolves.toMatchObject({
      externalExecutables: {
        gitExecutablePath: null,
        codexExecutablePath: null,
        ghExecutablePath: null
      }
    });
  });

  it('stores only valid preview gateway ports', async () => {
    const store = new MemoryAppSettingsStore();
    await expect(store.update({ previewGateway: { port: 41_234 } })).resolves.toMatchObject({
      previewGateway: { port: 41_234 }
    });
    await expect(store.update({ previewGateway: { port: 9_999 } })).rejects.toThrow(
      'Preview gateway port must be null or an integer from 10000 to 65535.'
    );
  });

  it('fails closed on invalid JSON without replacing user data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-invalid-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    await fs.writeFile(settingsPath, '{not valid json', 'utf8');
    const store = new AppSettingsStore(settingsPath);

    await expect(store.get()).rejects.toThrow();
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe('{not valid json');
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

function currentSettings(
  overrides: Partial<typeof DEFAULT_TASK_MANAGER_APP_SETTINGS> = {}
) {
  return { ...structuredClone(DEFAULT_TASK_MANAGER_APP_SETTINGS), ...overrides };
}
