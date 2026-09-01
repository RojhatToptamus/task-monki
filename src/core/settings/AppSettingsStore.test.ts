import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
} from '../../shared/agent';
import { AppDatabase } from '../storage/sqlite/AppDatabase';
import {
  AppSettingsStore,
  MemoryAppSettingsStore,
  normalizeAppSettings
} from './AppSettingsStore';

const databases: AppDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('AppSettingsStore', () => {
  it('initializes normalized defaults in the application database', async () => {
    const { database } = await createDatabase();
    const store = new AppSettingsStore(database);

    await expect(store.get()).resolves.toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
      theme: 'dark',
      themePreset: 'graphite',
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
    await expect(
      database.read((reader) =>
        reader.get<{ record_revision: number; settings_json: string }>(
          'SELECT record_revision, settings_json FROM app_settings WHERE singleton_id = 1'
        )
      )
    ).resolves.toEqual({
      record_revision: 0,
      settings_json: JSON.stringify(DEFAULT_TASK_MANAGER_APP_SETTINGS)
    });
  });

  it('persists settings across database reopen', async () => {
    const { database, databasePath } = await createDatabase();
    const store = new AppSettingsStore(database);
    await store.update({ theme: 'dark', selectedRepositoryId: 'repository-1' });
    await closeDatabase(database);

    const reopened = await AppDatabase.open(databasePath);
    databases.push(reopened);

    await expect(new AppSettingsStore(reopened).get()).resolves.toMatchObject({
      theme: 'dark',
      selectedRepositoryId: 'repository-1'
    });
  });

  it('does not publish settings from a rolled-back outer transaction', async () => {
    const { database } = await createDatabase();
    const store = new AppSettingsStore(database);
    await store.get();

    await expect(
      database.write(async () => {
        await store.update({ theme: 'light' });
        expect((await store.get()).theme).toBe('light');
        throw new Error('abort transaction');
      })
    ).rejects.toThrow('abort transaction');

    expect((await store.get()).theme).toBe('dark');
    const stored = await database.read((reader) =>
      reader.get<{ settings_json: string }>(
        'SELECT settings_json FROM app_settings WHERE singleton_id = 1'
      )
    );
    expect(JSON.parse(stored!.settings_json)).toMatchObject({ theme: 'dark' });
  });

  it('rejects first initialization inside an outer transaction', async () => {
    const { database } = await createDatabase();
    const store = new AppSettingsStore(database);

    await expect(
      database.write(() => store.update({ theme: 'light' }))
    ).rejects.toThrow('must be initialized before joining an outer database transaction');

    await expect(store.get()).resolves.toMatchObject({ theme: 'dark' });
  });

  it('fails closed on invalid current settings without rewriting them', async () => {
    const { database } = await createDatabase();
    const invalidSettings = JSON.stringify({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
    });
    await database.write((transaction) => {
      transaction.run(
        `INSERT INTO app_settings (
           singleton_id, record_revision, settings_json, updated_at
         ) VALUES (1, 4, ?, ?)`,
        [invalidSettings, '2026-08-29T10:00:00.000Z']
      );
    });

    await expect(new AppSettingsStore(database).get()).rejects.toThrow('is invalid');
    await expect(
      database.read((reader) =>
        reader.get<{ settings_json: string }>(
          'SELECT settings_json FROM app_settings WHERE singleton_id = 1'
        )
      )
    ).resolves.toEqual({ settings_json: invalidSettings });
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

    const settings = await store.update({ selectedRepositoryId: 'repository-1' });

    expect(settings.firstLaunchSetupCompleted).toBe(false);
    expect(settings.selectedRepositoryId).toBe('repository-1');
  });

  it.each([3, 9, 10])('rejects unsupported settings schema %s', (schemaVersion) => {
    expect(() => normalizeAppSettings({ schemaVersion })).toThrow(
      `Unsupported Task Monki app settings schema ${schemaVersion}`
    );
  });

  it('persists only supported theme presets', async () => {
    const store = new MemoryAppSettingsStore();

    await expect(store.update({ themePreset: 'nocturne' })).resolves.toMatchObject({
      themePreset: 'nocturne'
    });
    await expect(store.update({ themePreset: 'unknown' as 'graphite' })).rejects.toThrow(
      'Theme preset is not supported.'
    );
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
});

async function createDatabase(): Promise<{ database: AppDatabase; databasePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-'));
  roots.push(root);
  const databasePath = path.join(root, 'task-monki.sqlite3');
  const database = await AppDatabase.open(databasePath);
  databases.push(database);
  return { database, databasePath };
}

async function closeDatabase(database: AppDatabase): Promise<void> {
  await database.close();
  databases.splice(databases.indexOf(database), 1);
}

function currentSettings(
  overrides: Partial<typeof DEFAULT_TASK_MANAGER_APP_SETTINGS> = {}
) {
  return { ...structuredClone(DEFAULT_TASK_MANAGER_APP_SETTINGS), ...overrides };
}
