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

  it('keeps first-launch setup incomplete when a fresh config selects a repository', async () => {
    const store = new MemoryAppSettingsStore();

    const settings = await store.setSelectedRepositoryId('repository-current');

    expect(settings.firstLaunchSetupCompleted).toBe(false);
    expect(settings.repositories).toEqual({
      selectedRepositoryId: 'repository-current'
    });
  });

  it('infers first-launch setup as completed for current configs that already have a selection', () => {
    expect(
      normalizeAppSettings({
        repositories: {
          selectedRepositoryId: 'repository-current'
        }
      }).firstLaunchSetupCompleted
    ).toBe(true);
  });

  it('infers first-launch setup for memory stores initialized with a selection', async () => {
    const store = new MemoryAppSettingsStore({
      repositories: {
        selectedRepositoryId: 'repository-current'
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
          selectedRepositoryId: 'repository-current'
        }
      }).firstLaunchSetupCompleted
    ).toBe(false);
  });

  it('migrates legacy repository paths through the registry before publishing schema v4', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-v3-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const legacyRaw = `${JSON.stringify({
      schemaVersion: 3,
      theme: 'dark',
      repositories: {
        knownPaths: ['/repos/one', '/repos/two'],
        selectedPath: '/repos/two'
      }
    }, null, 2)}\n`;
    await fs.writeFile(settingsPath, legacyRaw, 'utf8');
    const store = new AppSettingsStore(settingsPath);
    let registryWasUpdated = false;

    await store.initializeRepositories(async (legacy) => {
      expect(legacy).toEqual({
        knownPaths: ['/repos/one', '/repos/two'],
        selectedPath: '/repos/two'
      });
      registryWasUpdated = true;
      await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe(legacyRaw);
      return { selectedRepositoryId: 'repository-two' };
    });

    expect(registryWasUpdated).toBe(true);
    await expect(store.get()).resolves.toMatchObject({
      schemaVersion: 4,
      theme: 'dark',
      firstLaunchSetupCompleted: true,
      repositories: { selectedRepositoryId: 'repository-two' }
    });
    await expect(fs.readFile(`${settingsPath}.pre-v4-backup`, 'utf8')).resolves.toBe(
      legacyRaw
    );
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.not.toContain('knownPaths');
  });

  it('does not mutate legacy settings when registry migration fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-v3-fail-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const raw = JSON.stringify({
      schemaVersion: 3,
      repositories: { knownPaths: ['/repos/one'], selectedPath: '/repos/one' }
    });
    await fs.writeFile(settingsPath, raw, 'utf8');
    const store = new AppSettingsStore(settingsPath);

    await expect(
      store.initializeRepositories(async () => {
        throw new Error('registry unavailable');
      })
    ).rejects.toThrow('registry unavailable');
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe(raw);
    await expect(fs.readFile(`${settingsPath}.pre-v4-backup`, 'utf8')).resolves.toBe(raw);
  });

  it('refuses to load legacy settings without a registry migration', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-v3-gate-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({ schemaVersion: 3 }), 'utf8');

    await expect(new AppSettingsStore(settingsPath).get()).rejects.toThrow(
      'require repository-registry migration'
    );
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

  it('refuses a newer schema without rewriting or moving the settings file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-newer-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const raw = JSON.stringify({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION + 1,
      futureSetting: true
    });
    await fs.writeFile(settingsPath, raw, 'utf8');
    const store = new AppSettingsStore(settingsPath);

    await expect(store.get()).rejects.toThrow('newer than this app supports');
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe(raw);
    expect(await fs.readdir(dir)).toEqual(['app-settings.json']);
  });
});
