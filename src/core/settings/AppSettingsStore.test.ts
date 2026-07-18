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
      disabledRuntimeIds: [],
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
    await fs.mkdir(`${settingsPath}.tmp`);

    await expect(store.update({ theme: 'dark' })).rejects.toThrow();

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
});
