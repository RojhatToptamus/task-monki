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

  it('merges runtime-owned executable paths without resetting other runtimes', async () => {
    const store = new MemoryAppSettingsStore({
      runtimeExecutablePaths: {
        opencode: '/opt/opencode',
        antigravity: '/opt/agy'
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
      antigravity: '/opt/agy',
      'grok-acp': '/opt/grok'
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

  it('scopes legacy refinement and review models to Codex instead of a later default runtime', () => {
    expect(
      normalizeAppSettings({
        defaultRuntimeId: 'opencode',
        promptRefinementModel: 'gpt-refine',
        reviewModel: 'gpt-review'
      })
    ).toMatchObject({
      defaultRuntimeId: 'opencode',
      promptRefinementRuntimeId: 'codex',
      promptRefinementModel: 'gpt-refine',
      reviewRuntimeId: 'codex',
      reviewModel: 'gpt-review'
    });
  });

  it('migrates Gemini ACP selections without treating Antigravity as protocol-compatible', () => {
    expect(
      normalizeAppSettings({
        schemaVersion: 5,
        defaultRuntimeId: 'gemini-acp',
        defaultModel: 'gemini-default',
        defaultModelProvider: 'google',
        defaultReasoningEffort: 'high',
        promptRefinementRuntimeId: 'gemini-acp',
        promptRefinementModel: 'gemini-refine',
        promptRefinementModelProvider: 'google',
        reviewRuntimeId: 'gemini-acp',
        reviewModel: 'gemini-review',
        reviewModelProvider: 'google',
        reviewReasoningEffort: 'high',
        runtimeExecutablePaths: {
          'gemini-acp': '/opt/gemini',
          opencode: '/opt/opencode'
        }
      })
    ).toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
      defaultRuntimeId: 'antigravity',
      defaultModel: undefined,
      defaultModelProvider: undefined,
      defaultReasoningEffort: undefined,
      promptRefinementRuntimeId: 'codex',
      promptRefinementModel: undefined,
      promptRefinementModelProvider: undefined,
      reviewRuntimeId: 'codex',
      reviewModel: undefined,
      reviewModelProvider: undefined,
      reviewReasoningEffort: undefined,
      runtimeExecutablePaths: { opencode: '/opt/opencode' }
    });
  });

  it('persists the Gemini ACP migration during the first successful load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-migration-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        schemaVersion: 5,
        defaultRuntimeId: 'gemini-acp',
        defaultModel: 'gemini-default',
        runtimeExecutablePaths: {
          'gemini-acp': '/opt/gemini',
          opencode: '/opt/opencode'
        }
      }),
      'utf8'
    );

    const loaded = await new AppSettingsStore(settingsPath).get();
    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<
      string,
      unknown
    >;

    expect(loaded).toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
      defaultRuntimeId: 'antigravity',
      defaultModel: undefined,
      runtimeExecutablePaths: { opencode: '/opt/opencode' }
    });
    expect(persisted).toMatchObject({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
      defaultRuntimeId: 'antigravity',
      runtimeExecutablePaths: { opencode: '/opt/opencode' }
    });
    expect(JSON.stringify(persisted)).not.toContain('gemini-acp');
  });

  it('rejects and preserves settings written by a newer application schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-future-'));
    const settingsPath = path.join(dir, 'app-settings.json');
    const raw = `${JSON.stringify({
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION + 1,
      defaultRuntimeId: 'future-runtime',
      futureProviderSettings: { retained: true }
    }, null, 2)}\n`;
    await fs.writeFile(settingsPath, raw, 'utf8');

    await expect(new AppSettingsStore(settingsPath).get()).rejects.toThrow(
      'newer than supported'
    );
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe(raw);
    await expect(fs.readdir(dir)).resolves.toEqual(['app-settings.json']);
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
});
