import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_MANAGER_APP_SETTINGS } from '../../shared/contracts';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService shutdown coordination', () => {
  it('shuts runtime owners down once and waits for preview cleanup', async () => {
    const events: string[] = [];
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
    let markPreviewStarted!: () => void;
    const previewStarted = new Promise<void>((resolve) => { markPreviewStarted = resolve; });
    const service = Object.create(TaskManagerService.prototype) as TaskManagerService;
    initializeRuntimeLifecycle(service);
    const internals = service as unknown as {
      lifecycleState: string;
      taskActionLocks: Map<string, unknown>;
      activeControlActions: Set<Promise<unknown>>;
      previewEnabled: boolean;
      store: { close(): Promise<void> };
      agents: { shutdown(): Promise<void> };
      previews: { shutdown(): Promise<void> };
      previewRecipeGenerator: { shutdown(): Promise<void> };
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
        markPreviewStarted();
        await previewGate;
        events.push('preview-finished');
      }
    };
    internals.previewRecipeGenerator = { shutdown: () => Promise.resolve() };

    const shutdown = service.shutdown();
    await previewStarted;
    expect(events).toEqual(['agent-started', 'preview-started']);
    releasePreview();
    await shutdown;
    expect(events).toEqual([
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
    initializeRuntimeLifecycle(service);
    const internals = service as unknown as {
      lifecycleState: string;
      taskActionLocks: Map<string, unknown>;
      activeControlActions: Set<Promise<unknown>>;
      previewEnabled: boolean;
      store: { init(): Promise<void>; close(): Promise<void> };
      appSettingsStore: { get(): Promise<never> };
      agents: { shutdown(): Promise<void> };
      previews: { shutdown(): Promise<void> };
      previewRecipeGenerator: { shutdown(): Promise<void> };
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
    internals.previewRecipeGenerator = { shutdown: () => Promise.resolve() };

    const firstInit = service.init();
    const secondInit = service.init();
    expect(secondInit).toBe(firstInit);
    await storeInitStarted;

    const shutdown = service.shutdown();
    expect(calls).toEqual(['store-init']);
    releaseStoreInit();

    await expect(firstInit).rejects.toThrow('Task Manager is shutting down.');
    await shutdown;
    expect(calls).toEqual(['store-init', 'agent-shutdown', 'preview-shutdown']);
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
    initializeRuntimeLifecycle(service);
    const internals = service as unknown as {
      lifecycleState: string;
      taskActionLocks: Map<string, unknown>;
      activeControlActions: Set<Promise<unknown>>;
      previewEnabled: boolean;
      store: { close(): Promise<void> };
      agents: { shutdown(): Promise<void> };
      previews: { shutdown(): Promise<void> };
      previewRecipeGenerator: { shutdown(): Promise<void> };
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
    internals.previewRecipeGenerator = { shutdown: () => Promise.resolve() };

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

  it('joins an admitted settings restart before shutting runtime owners down once', async () => {
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
    initializeRuntimeLifecycle(service);
    const internals = service as unknown as {
      lifecycleState: string;
      taskActionLocks: Map<string, unknown>;
      activeControlActions: Set<Promise<unknown>>;
      previewEnabled: boolean;
      store: { close(): Promise<void>; snapshot(): Promise<{ runs: [] }> };
      browserDevAgentBoundary: boolean;
      runtimeRegistry: {
        require(runtimeId: string): { descriptor: { displayName: string }; shutdown(): Promise<void> };
        initialize(runtimeIds: readonly string[]): Promise<[]>;
      };
      appSettings: typeof DEFAULT_TASK_MANAGER_APP_SETTINGS;
      appSettingsStore: {
        get(): Promise<typeof DEFAULT_TASK_MANAGER_APP_SETTINGS>;
        update(input: unknown): Promise<typeof DEFAULT_TASK_MANAGER_APP_SETTINGS>;
      };
      hasActiveAgentRun(): Promise<boolean>;
      applyRuntimeSettings(input: unknown): Promise<unknown>;
      agents: {
        shutdown(): Promise<void>;
        getRuntimeCatalog(): Promise<unknown>;
      };
      previews: { shutdown(): Promise<void> };
      previewRecipeGenerator: { shutdown(): Promise<void> };
      events: { emit(event: unknown): void };
    };
    internals.lifecycleState = 'READY';
    internals.taskActionLocks = new Map();
    internals.activeControlActions = new Set();
    internals.previewEnabled = true;
    internals.store = {
      close: () => Promise.resolve(),
      snapshot: () => Promise.resolve({ runs: [] })
    };
    internals.browserDevAgentBoundary = false;
    internals.runtimeRegistry = {
      require: () => ({
        descriptor: { displayName: 'Codex' },
        shutdown: () => Promise.resolve()
      }),
      initialize: () => Promise.resolve([])
    };
    internals.appSettings = structuredClone(DEFAULT_TASK_MANAGER_APP_SETTINGS);
    internals.appSettingsStore = {
      async get() {
        return structuredClone(DEFAULT_TASK_MANAGER_APP_SETTINGS);
      },
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
      async getRuntimeCatalog() {
        return {};
      }
    };
    internals.previews = {
      async shutdown() {
        events.push(`preview-shutdown-${shutdownCount}`);
      }
    };
    internals.previewRecipeGenerator = { shutdown: () => Promise.resolve() };
    internals.events = { emit() {} };

    const update = service.updateAppSettings({
      codexExternalTools: { webSearchMode: 'cached' }
    });
    await Promise.race([
      settingsRestartStarted,
      update.then(
        () => Promise.reject(new Error('Settings update finished before restarting the runtime.')),
        (error) => Promise.reject(error)
      )
    ]);
    let shutdownSettled = false;
    const shutdown = service.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(events).toEqual(['settings-restart-started']);
    expect(shutdownSettled).toBe(false);
    releaseSettingsRestart();
    await update;
    await shutdown;

    expect(events).toEqual([
      'settings-restart-started',
      'settings-restart-finished',
      'agent-shutdown-1',
      'preview-shutdown-1'
    ]);
    expect(internals.activeControlActions.size).toBe(0);
    expect(internals.lifecycleState).toBe('STOPPED');
    expect(() => service.updateAppSettings({ theme: 'dark' })).toThrow(
      'Task Manager is shutting down.'
    );
  });
});

function initializeRuntimeLifecycle(service: TaskManagerService): void {
  Object.assign(service as unknown as Record<string, unknown>, {
    runtimeLifecycleTail: Promise.resolve(),
    activeRuntimeOperations: new Set<Promise<void>>(),
    runtimeLifecycleClosing: false,
    postRunEvidenceTasks: new Map<string, Promise<void>>(),
    disposeAgentEventListener: () => undefined
  });
}
