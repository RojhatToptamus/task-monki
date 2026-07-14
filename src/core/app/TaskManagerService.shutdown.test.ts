import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_MANAGER_APP_SETTINGS } from '../../shared/contracts';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService shutdown coordination', () => {
  it('begins provider shutdown before waiting for preview cleanup', async () => {
    const events: string[] = [];
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
    const service = Object.create(TaskManagerService.prototype) as TaskManagerService;
    const internals = service as unknown as {
      lifecycleState: string;
      taskActionLocks: Map<string, unknown>;
      activeControlActions: Set<Promise<unknown>>;
      previewEnabled: boolean;
      store: { close(): Promise<void> };
      agents: { shutdown(): Promise<void> };
      previews: { shutdown(): Promise<void> };
    };
    internals.lifecycleState = 'READY';
    internals.taskActionLocks = new Map();
    internals.activeControlActions = new Set();
    internals.previewEnabled = true;
    internals.store = { close: () => Promise.resolve() };
    internals.agents = {
      async shutdown() {
        events.push('agent-started');
      }
    };
    internals.previews = {
      async shutdown() {
        events.push('preview-started');
        await previewGate;
        events.push('preview-finished');
      }
    };

    const shutdown = service.shutdown();
    await Promise.resolve();
    expect(events).toEqual(['agent-started', 'preview-started']);
    releasePreview();
    await shutdown;
    expect(events).toEqual([
      'agent-started',
      'preview-started',
      'preview-finished',
      'agent-started',
      'preview-started',
      'preview-finished'
    ]);
  });

  it('makes initialization single-flight and lets shutdown cancel later startup stages', async () => {
    let releaseStoreInit!: () => void;
    const storeInitGate = new Promise<void>((resolve) => { releaseStoreInit = resolve; });
    let markStoreInitStarted!: () => void;
    const storeInitStarted = new Promise<void>((resolve) => { markStoreInitStarted = resolve; });
    const calls: string[] = [];
    const service = Object.create(TaskManagerService.prototype) as TaskManagerService;
    const internals = service as unknown as {
      lifecycleState: string;
      taskActionLocks: Map<string, unknown>;
      activeControlActions: Set<Promise<unknown>>;
      previewEnabled: boolean;
      store: { init(): Promise<void>; close(): Promise<void> };
      appSettingsStore: { get(): Promise<never> };
      agents: { shutdown(): Promise<void> };
      previews: { shutdown(): Promise<void> };
    };
    internals.lifecycleState = 'NEW';
    internals.taskActionLocks = new Map();
    internals.activeControlActions = new Set();
    internals.previewEnabled = true;
    internals.store = {
      async init() {
        calls.push('store-init');
        markStoreInitStarted();
        await storeInitGate;
      },
      close: () => Promise.resolve()
    };
    internals.appSettingsStore = {
      async get(): Promise<never> {
        calls.push('settings-read');
        throw new Error('Settings must not load after shutdown begins.');
      }
    };
    internals.agents = {
      async shutdown() {
        calls.push('agent-shutdown');
      }
    };
    internals.previews = {
      async shutdown() {
        calls.push('preview-shutdown');
      }
    };

    const firstInit = service.init();
    const secondInit = service.init();
    expect(secondInit).toBe(firstInit);
    await storeInitStarted;

    const shutdown = service.shutdown();
    expect(calls).toEqual(['store-init', 'agent-shutdown', 'preview-shutdown']);
    releaseStoreInit();

    await expect(firstInit).rejects.toThrow('Task Manager is shutting down.');
    await shutdown;
    expect(calls).not.toContain('settings-read');
    expect(internals.lifecycleState).toBe('STOPPED');
    await expect(service.init()).rejects.toThrow('Task Manager is shutting down.');
  });

  it('joins active task actions and rejects actions submitted after shutdown begins', async () => {
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    let markActionStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => { markActionStarted = resolve; });
    const service = Object.create(TaskManagerService.prototype) as TaskManagerService;
    const internals = service as unknown as {
      lifecycleState: string;
      taskActionLocks: Map<string, unknown>;
      activeControlActions: Set<Promise<unknown>>;
      previewEnabled: boolean;
      store: { close(): Promise<void> };
      agents: { shutdown(): Promise<void> };
      previews: { shutdown(): Promise<void> };
      withTaskAction<T>(
        taskId: string,
        label: string,
        action: () => Promise<T>
      ): Promise<T>;
    };
    internals.lifecycleState = 'READY';
    internals.taskActionLocks = new Map();
    internals.activeControlActions = new Set();
    internals.previewEnabled = true;
    internals.store = { close: () => Promise.resolve() };
    internals.agents = { shutdown: () => Promise.resolve() };
    internals.previews = { shutdown: () => Promise.resolve() };

    const action = internals.withTaskAction('task-1', 'Preview startup', async () => {
      markActionStarted();
      await actionGate;
      return 'finished';
    });
    await actionStarted;

    let shutdownSettled = false;
    const shutdown = service.shutdown().then(() => { shutdownSettled = true; });
    expect(service.shutdown()).toBe(service.shutdown());
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    await expect(
      internals.withTaskAction('task-2', 'Agent run', async () => undefined)
    ).rejects.toThrow('Task Manager is shutting down.');

    releaseAction();
    await expect(action).resolves.toBe('finished');
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(internals.taskActionLocks.size).toBe(0);
    expect(internals.lifecycleState).toBe('STOPPED');
  });

  it('joins an admitted settings restart and performs a final runtime shutdown sweep', async () => {
    let releaseSettingsRestart!: () => void;
    const settingsRestartGate = new Promise<void>((resolve) => {
      releaseSettingsRestart = resolve;
    });
    let markSettingsRestartStarted!: () => void;
    const settingsRestartStarted = new Promise<void>((resolve) => {
      markSettingsRestartStarted = resolve;
    });
    const events: string[] = [];
    const service = Object.create(TaskManagerService.prototype) as TaskManagerService;
    const internals = service as unknown as {
      lifecycleState: string;
      taskActionLocks: Map<string, unknown>;
      activeControlActions: Set<Promise<unknown>>;
      previewEnabled: boolean;
      store: { close(): Promise<void> };
      browserDevAgentBoundary: boolean;
      appSettings: typeof DEFAULT_TASK_MANAGER_APP_SETTINGS;
      appSettingsStore: {
        update(input: unknown): Promise<typeof DEFAULT_TASK_MANAGER_APP_SETTINGS>;
      };
      hasActiveAgentRun(): Promise<boolean>;
      applyRuntimeSettings(input: unknown): Promise<unknown>;
      agents: {
        shutdown(): Promise<void>;
        getProviderState(): Promise<unknown>;
      };
      previews: { shutdown(): Promise<void> };
      events: { emit(event: unknown): void };
    };
    internals.lifecycleState = 'READY';
    internals.taskActionLocks = new Map();
    internals.activeControlActions = new Set();
    internals.previewEnabled = true;
    internals.store = { close: () => Promise.resolve() };
    internals.browserDevAgentBoundary = false;
    internals.appSettings = structuredClone(DEFAULT_TASK_MANAGER_APP_SETTINGS);
    internals.appSettingsStore = {
      async update() {
        return {
          ...structuredClone(DEFAULT_TASK_MANAGER_APP_SETTINGS),
          codexExternalTools: {
            webSearchMode: 'cached',
            mcpServers: 'disabled',
            apps: 'disabled'
          }
        };
      }
    };
    internals.hasActiveAgentRun = () => Promise.resolve(false);
    internals.applyRuntimeSettings = async () => {
      events.push('settings-restart-started');
      markSettingsRestartStarted();
      await settingsRestartGate;
      events.push('settings-restart-finished');
      return {};
    };
    let shutdownCount = 0;
    internals.agents = {
      async shutdown() {
        shutdownCount += 1;
        events.push(`agent-shutdown-${shutdownCount}`);
      },
      async getProviderState() {
        return {};
      }
    };
    internals.previews = {
      async shutdown() {
        events.push(`preview-shutdown-${shutdownCount}`);
      }
    };
    internals.events = { emit() {} };

    const update = service.updateAppSettings({
      codexExternalTools: { webSearchMode: 'cached' }
    });
    await settingsRestartStarted;
    let shutdownSettled = false;
    const shutdown = service.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(events).toEqual([
      'settings-restart-started',
      'agent-shutdown-1',
      'preview-shutdown-1'
    ]);
    expect(shutdownSettled).toBe(false);
    releaseSettingsRestart();
    await update;
    await shutdown;

    expect(events).toEqual([
      'settings-restart-started',
      'agent-shutdown-1',
      'preview-shutdown-1',
      'settings-restart-finished',
      'agent-shutdown-2',
      'preview-shutdown-2'
    ]);
    expect(internals.activeControlActions.size).toBe(0);
    expect(internals.lifecycleState).toBe('STOPPED');
    expect(() => service.updateAppSettings({ theme: 'dark' })).toThrow(
      'Task Manager is shutting down.'
    );
  });
});
