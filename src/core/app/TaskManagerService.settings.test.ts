import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentModel, AgentRuntimeId } from '../../shared/agent';
import type { AgentRuntimeAdapter } from '../agent/AgentRuntimeAdapter';
import { createRuntimeReadiness } from '../agent/AgentRuntimeReadiness';
import { acpCapabilities } from '../agent/acp/AcpRuntimeProfiles';
import { CodexAppServerAdapter } from '../agent/codex/CodexAppServerAdapter';
import { TASK_MONKI_CODEX_BIN_ENV } from '../agent/codex/CodexRuntimeResolver';
import { getGitExecutablePath, configureGitExecutablePath, git } from '../git/gitCli';
import { AppEventBus } from '../runner/AppEventBus';
import { MemoryAppSettingsStore } from '../settings/AppSettingsStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import {
  writeNodeExecutable,
  writeOutputExecutable
} from '../../testSupport/fakeExecutable';
import { ScriptedAgentRuntimeAdapter } from '../../testSupport/taskMonkiScenario';
import { TEST_ACP_PROFILE } from '../../testSupport/acpRuntimeProfile';

const SERVICE_INTEGRATION_TIMEOUT_MS = 20_000;

describe('TaskManagerService settings', { timeout: SERVICE_INTEGRATION_TIMEOUT_MS }, () => {
  const originalGitPath = process.env.TASK_MANAGER_GIT_PATH;
  const originalCodexBin = process.env[TASK_MONKI_CODEX_BIN_ENV];
  const originalPath = process.env.PATH;

  afterEach(() => {
    restoreEnv('TASK_MANAGER_GIT_PATH', originalGitPath);
    restoreEnv(TASK_MONKI_CODEX_BIN_ENV, originalCodexBin);
    restoreEnv('PATH', originalPath);
    configureGitExecutablePath(undefined);
  });

  it('applies external executable settings to Git operations', async () => {
    delete process.env.TASK_MANAGER_GIT_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-service-settings-'));
    const fakeGit = await writeOutputExecutable(dir, 'fake-git', 'git version service-test');
    const fakeCodex = await writeOutputExecutable(dir, 'fake-codex', 'codex-cli test');
    const fakeGh = await writeOutputExecutable(dir, 'fake-gh', 'gh version test');
    const service = new TaskManagerService(
      new FileTaskStore(path.join(dir, 'store')),
      dir,
      undefined,
      {
        appSettingsStore: new MemoryAppSettingsStore(),
        codexPath: fakeCodex,
        ghPath: fakeGh
      }
    );

    await service.updateAppSettings({
      externalExecutables: {
        gitExecutablePath: fakeGit
      }
    });

    expect(getGitExecutablePath()).toBe(fakeGit);
    await expect(service.getExternalToolStatus()).resolves.toMatchObject({
      tools: {
        git: {
          status: 'ok',
          version: 'git version service-test'
        }
      }
    });
  }, 15_000);

  it('uses the normalized Git executable instead of rereading raw env overrides', async () => {
    process.env.TASK_MANAGER_GIT_PATH = '   ';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-service-git-env-'));
    const fakeGit = await writeOutputExecutable(dir, 'fake-git', 'git version normalized-env');
    const service = new TaskManagerService(
      new FileTaskStore(path.join(dir, 'store')),
      dir,
      undefined,
      {
        appSettingsStore: new MemoryAppSettingsStore(),
        codexPath: 'codex-not-used'
      }
    );

    await service.updateAppSettings({
      externalExecutables: {
        gitExecutablePath: fakeGit
      }
    });

    expect(getGitExecutablePath()).toBe(fakeGit);
  }, 15_000);

  it('uses persisted Codex external tool settings before provider startup', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-service-'));
    const executable = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '9.9.9'
    });
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: executable,
      appSettingsStore: new MemoryAppSettingsStore({
        codexExternalTools: {
          webSearchMode: 'cached',
          mcpServers: 'all',
          apps: 'enabled'
        }
      }),
      worktreeRoot: path.join(dir, 'worktrees')
    });

    await service.init();
    try {
      const snapshot = await waitForAgentServerSnapshot(store);
      expect(codexServers(snapshot)[0]?.argv).toEqual([
        'app-server',
        '--stdio',
        '-c',
        'features.apps=true',
        '-c',
        'web_search="cached"'
      ]);
    } finally {
      await service.shutdown();
    }
  }, 20_000);

  it('forces Codex external tools off and rejects enabling them in browser development', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-browser-tools-'));
    const executable = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '9.9.9'
    });
    const settingsStore = new MemoryAppSettingsStore({
      codexExternalTools: {
        webSearchMode: 'live',
        mcpServers: 'all',
        apps: 'enabled'
      }
    });
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: executable,
      appSettingsStore: settingsStore,
      worktreeRoot: path.join(dir, 'worktrees'),
      allowAgentNetworkAccess: false
    });

    await service.init();
    try {
      expect((await service.getAppSettings()).codexExternalTools).toEqual({
        webSearchMode: 'disabled',
        mcpServers: 'disabled',
        apps: 'disabled'
      });
      const snapshot = await waitForAgentServerSnapshot(store);
      expect(codexServers(snapshot)[0]?.argv).toEqual([
        'app-server',
        '--stdio',
        '-c',
        'features.apps=false',
        '-c',
        'web_search="disabled"',
        '-c',
        'mcp_servers.docs={enabled=false, command="docs-mcp"}'
      ]);
      await expect(
        service.updateAppSettings({
          codexExternalTools: { apps: 'enabled' }
        })
      ).rejects.toThrow('disabled in the browser development server');
      expect((await settingsStore.get()).codexExternalTools).toEqual({
        webSearchMode: 'disabled',
        mcpServers: 'disabled',
        apps: 'disabled'
      });
    } finally {
      await service.shutdown();
    }
  }, 20_000);

  it('aborts browser-dev startup when MCP disable discovery cannot be proven', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-browser-mcp-fail-'));
    const executable = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '9.9.9',
      mcpList: 'fail'
    });
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: executable,
      appSettingsStore: new MemoryAppSettingsStore(),
      worktreeRoot: path.join(dir, 'worktrees'),
      allowAgentNetworkAccess: false
    });

    await expect(service.init()).rejects.toThrow(
      'MCP configuration could not be completely inspected and disabled'
    );
    expect((await store.snapshot()).agentServers).toHaveLength(0);
    await service.shutdown();
  });

  it('keeps deterministic seed hosts inert without starting Codex', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-inert-seed-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const repository = await addTestRepository(store, dir);
    const reason = 'Codex is disabled while deterministic seed scenarios are loaded.';
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: 'codex-not-used',
      appSettingsStore: new MemoryAppSettingsStore(),
      agentProviderStartupDisabledReason: reason
    });

    await service.init();
    try {
      expect((await service.getAgentRuntimeCatalog()).runtimes[0]?.preflight.readiness).toMatchObject({
        status: 'DISABLED',
        canStart: false,
        detail: reason
      });
      expect((await store.snapshot()).agentServers).toHaveLength(0);
      await expect(
        service.refinePrompt({ repositoryId: repository.id, input: 'Refine me.' })
      ).rejects.toThrow(reason);
    } finally {
      await service.shutdown();
    }
  });

  it('applies deferred Codex settings after the last Codex run terminalizes', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-recovery-'));
    const executable = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '9.9.9'
    });
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const service = createCodexSettingsTestService({
      store,
      repositoryPath: dir,
      executable,
      events
    });
    await service.init();
    try {
      const task = await store.createTask({
        title: 'Recovery settings guard',
        prompt: 'Keep recovery state stable.',
        repositoryId: (await addTestRepository(store, dir)).id
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: 'codex/recovery-settings-guard',
        worktreePath: path.join(dir, 'worktree'),
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        runtimeId: 'codex'
      });
      const run = await store.createRun({
        task,
        session,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt
      });
      await store.updateRun(run.id, { status: 'RECOVERY_REQUIRED' });

      await service.updateAppSettings({
        codexExternalTools: {
          webSearchMode: 'live',
          mcpServers: 'all',
          apps: 'enabled'
        }
      });

      const snapshot = await waitForAgentServerSnapshot(store);
      expect(codexServers(snapshot)).toHaveLength(1);
      expect(
        (await service.getAgentRuntimeCatalog()).runtimes[0]?.preflight.readiness.diagnostics
      ).toContainEqual(
        expect.objectContaining({ code: 'RUNTIME_RESTART_REQUIRED' })
      );

      await store.updateRun(run.id, { status: 'FAILED' });
      events.emit({
        type: 'run.terminal',
        taskId: task.id,
        iterationId: iteration.id,
        runId: run.id,
        worktreeId: worktree.id,
        payload: { status: 'FAILED' },
        at: new Date().toISOString()
      });

      const restarted = await waitForAgentServerSnapshot(store, 2, true);
      expect(codexServers(restarted).map((server) => server.status).sort()).toEqual([
        'EXITED',
        'READY'
      ]);
      expect(
        (await service.getAgentRuntimeCatalog()).runtimes[0]?.preflight.readiness.diagnostics
      ).not.toContainEqual(
        expect.objectContaining({ code: 'RUNTIME_RESTART_REQUIRED' })
      );
    } finally {
      await service.shutdown();
    }
  });

  it('restarts idle Codex while another provider owns active work', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-other-run-'));
    const executable = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '9.9.9'
    });
    const store = new FileTaskStore(path.join(dir, 'store'));
    const opencode = createLifecycleRuntime(store, 'opencode', 'OpenCode');
    const service = createCodexSettingsTestService({
      store,
      repositoryPath: dir,
      executable,
      additionalAdapters: [opencode]
    });
    await service.init();
    try {
      const task = await store.createTask({
        title: 'Other provider stays active',
        prompt: 'Keep OpenCode active.',
        repositoryId: (await addTestRepository(store, dir)).id,
        runtimeId: 'opencode',
        agentSettings: { runtimeId: 'opencode' }
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: 'codex/other-provider-active',
        worktreePath: path.join(dir, 'other-worktree'),
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        runtimeId: 'opencode'
      });
      const run = await store.createRun({
        task,
        session,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt
      });
      await store.updateRun(run.id, { status: 'RUNNING' });

      await service.updateAppSettings({
        codexExternalTools: { webSearchMode: 'cached' }
      });

      const restarted = await waitForAgentServerSnapshot(store, 2, true);
      expect(codexServers(restarted).map((server) => server.status).sort()).toEqual([
        'EXITED',
        'READY'
      ]);
      expect(await store.getRun(run.id)).toMatchObject({ status: 'RUNNING' });
    } finally {
      await service.shutdown();
    }
  });

  it('does not restart Codex when only the Git executable path changes', async () => {
    delete process.env.TASK_MANAGER_GIT_PATH;
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-git-only-settings-'));
    const executable = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '9.9.9'
    });
    const fakeGit = await writeOutputExecutable(dir, 'fake-git', 'git version git-only');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = createCodexSettingsTestService({
      store,
      repositoryPath: dir,
      executable
    });

    await service.init();
    try {
      await service.updateAppSettings({
        externalExecutables: {
          gitExecutablePath: fakeGit
        }
      });

      const snapshot = await waitForAgentServerSnapshot(store);
      expect(codexServers(snapshot)).toHaveLength(1);
      expect(codexServers(snapshot)[0]?.executable).toBe(executable);
      expect(getGitExecutablePath()).toBe(fakeGit);
      expect(
        (await service.getAgentRuntimeCatalog()).runtimes[0]?.preflight.readiness.diagnostics
      ).not.toContainEqual(
        expect.objectContaining({ code: 'RUNTIME_RESTART_REQUIRED' })
      );
    } finally {
      await service.shutdown();
    }
  });

  it('shows an auto-detected Codex path without persisting it', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-status-'));
    const codex = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '9.9.9'
    });
    process.env.PATH = withPath(path.dirname(codex));
    const settingsStore = new MemoryAppSettingsStore();
    const service = new TaskManagerService(
      new FileTaskStore(path.join(dir, 'store')),
      dir,
      undefined,
      {
        appSettingsStore: settingsStore
      }
    );

    const status = await service.getExternalToolStatus();
    const settings = await service.getAppSettings();

    expect(status.tools.codex).toMatchObject({
      source: 'auto',
      executable: 'codex',
      resolvedPath: await expectedDiscoveredPath(codex),
      status: 'ok',
      version: 'codex-cli 9.9.9'
    });
    expect(settings.externalExecutables.codexExecutablePath).toBeNull();
  });

  it('leaves Auto App Server launch unpinned so compatibility resolution can skip stale PATH binaries', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-auto-runtime-'));
    const staleCodex = await writeFakeCodex(path.join(dir, 'stale'), 'codex', {
      version: '0.22.0',
      appServer: 'none'
    });
    const compatibleCodex = await writeFakeCodex(path.join(dir, 'compatible'), 'codex', {
      version: '9.9.9'
    });
    process.env.PATH = withPath(path.dirname(staleCodex), path.dirname(compatibleCodex));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      worktreeRoot: path.join(dir, 'worktrees')
    });

    await service.init();
    try {
      const status = await service.getExternalToolStatus();
      const snapshot = await waitForAgentServerSnapshot(store);

      expect(status.tools.codex).toMatchObject({
        source: 'auto',
        resolvedPath: await expectedDiscoveredPath(staleCodex),
        version: 'codex-cli 0.22.0'
      });
      expect(codexServers(snapshot)[0]?.executable).toBe(compatibleCodex);
      expect(codexServers(snapshot)[0]?.runtimeResolution?.selectedExecutable).toBe(
        compatibleCodex
      );
    } finally {
      await service.shutdown();
    }
  });

  it('passes a custom Codex executable path explicitly to App Server launch', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-custom-runtime-'));
    const customCodex = await writeFakeCodex(path.join(dir, 'custom'), 'codex-custom', {
      version: '9.9.9'
    });
    process.env.PATH = withPath(path.dirname(customCodex));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore({
        externalExecutables: {
          gitExecutablePath: null,
          codexExecutablePath: customCodex,
          ghExecutablePath: null
        }
      }),
      worktreeRoot: path.join(dir, 'worktrees')
    });

    await service.init();
    try {
      const snapshot = await waitForAgentServerSnapshot(store);

      expect(codexServers(snapshot)[0]?.executable).toBe(customCodex);
      expect(codexServers(snapshot)[0]?.runtimeResolution?.selectedSource).toBe('config');
    } finally {
      await service.shutdown();
    }
  });

  it('reports TASK_MONKI_CODEX_BIN as env and passes it explicitly to App Server launch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-env-runtime-'));
    const envCodex = await writeFakeCodex(path.join(dir, 'env'), 'codex-env', {
      version: '9.9.9'
    });
    const pathCodex = await writeFakeCodex(path.join(dir, 'path'), 'codex', {
      version: '9.8.0'
    });
    process.env[TASK_MONKI_CODEX_BIN_ENV] = envCodex;
    process.env.PATH = withPath(path.dirname(pathCodex));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      worktreeRoot: path.join(dir, 'worktrees')
    });

    await service.init();
    try {
      const status = await service.getExternalToolStatus();
      const snapshot = await waitForAgentServerSnapshot(store);

      expect(status.tools.codex).toMatchObject({
        source: 'env',
        configuredPath: envCodex,
        executable: envCodex,
        resolvedPath: envCodex,
        status: 'ok'
      });
      expect(codexServers(snapshot)[0]?.executable).toBe(envCodex);
      expect(codexServers(snapshot)[0]?.runtimeResolution?.selectedSource).toBe('config');
    } finally {
      await service.shutdown();
    }
  });

  it('keeps the Settings row Auto test on env override precedence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-auto-test-'));
    const envCodex = await writeOutputExecutable(dir, 'codex-env', 'codex-cli env-test');
    const pathCodex = await writeOutputExecutable(dir, 'codex', 'codex-cli path-test');
    process.env[TASK_MONKI_CODEX_BIN_ENV] = envCodex;
    process.env.PATH = withPath(path.dirname(pathCodex));
    const service = new TaskManagerService(
      new FileTaskStore(path.join(dir, 'store')),
      dir,
      undefined,
      {
        appSettingsStore: new MemoryAppSettingsStore()
      }
    );

    const result = await service.testExternalTool({
      tool: 'codex',
      executablePath: null
    });

    expect(result).toMatchObject({
      source: 'env',
      executable: envCodex,
      resolvedPath: envCodex,
      status: 'ok',
      version: 'codex-cli env-test'
    });
  });

  it('persists provider disablement and rejects disabled defaults and task creation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-disable-'));
    const settingsStore = new MemoryAppSettingsStore();
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: settingsStore,
      worktreeRoot: path.join(dir, 'worktrees')
    });
    await store.init();

    await expect(
      service.updateAppSettings({ disabledRuntimeIds: ['opencode'] })
    ).resolves.toMatchObject({ disabledRuntimeIds: ['opencode'] });
    await expect(
      service.updateAppSettings({ defaultRuntimeId: 'opencode' })
    ).rejects.toThrow('cannot be disabled while it is the default task runtime');
    await expect(
      service.createTask({
        title: 'Disabled provider task',
        prompt: 'Do not create this task.',
        repositoryId: (await addTestRepository(store, dir)).id,
        runtimeId: 'opencode'
      })
    ).rejects.toThrow('OpenCode is disabled');

    expect((await settingsStore.get()).defaultRuntimeId).toBe('codex');
    await service.shutdown();
  });

  it('does not disable a runtime that owns active or recovery-required work', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-active-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      worktreeRoot: path.join(dir, 'worktrees')
    });
    await store.init();
    const task = await store.createTask({
      title: 'Active provider task',
      prompt: 'Keep this runtime enabled.',
      repositoryId: (await addTestRepository(store, dir)).id,
      runtimeId: 'cursor-agent-acp',
      agentSettings: { runtimeId: 'cursor-agent-acp' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/runtime-active',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'cursor-agent-acp'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.updateRun(run.id, { status: 'RECOVERY_REQUIRED' });

    await expect(
      service.updateAppSettings({ disabledRuntimeIds: ['cursor-agent-acp'] })
    ).rejects.toThrow('active or requires recovery');
    await expect(service.getAppSettings()).resolves.toMatchObject({
      disabledRuntimeIds: []
    });
    await service.shutdown();
  });

  it('keeps disabled runtimes stopped and initializes them when re-enabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-toggle-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const codex = createLifecycleRuntime(store, 'codex', 'Codex');
    const opencode = createLifecycleRuntime(store, 'opencode', 'OpenCode');
    const configureRuntime = vi.fn().mockResolvedValue(undefined);
    (opencode as AgentRuntimeAdapter).configureRuntime = configureRuntime;
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      agentRuntimeAdapters: [codex, opencode],
      defaultAgentRuntimeId: 'codex'
    });

    await service.init();
    await opencode.initialize();
    await service.updateAppSettings({ disabledRuntimeIds: ['opencode'] });
    expect(opencode.shutdown).toHaveBeenCalledOnce();

    await service.updateAppSettings({
      runtimeExecutablePaths: { opencode: '/opt/task-monki/opencode' }
    });
    expect(configureRuntime).toHaveBeenLastCalledWith({
      executable: '/opt/task-monki/opencode',
      restart: false
    });
    expect(opencode.initialize).toHaveBeenCalledOnce();

    await service.updateAppSettings({ disabledRuntimeIds: [] });
    expect(opencode.initialize).toHaveBeenCalledTimes(2);
    const catalog = await service.getAgentRuntimeCatalog();
    expect(
      catalog.runtimes.find((runtime) => runtime.preflight.runtime.id === 'opencode')
        ?.preflight.readiness.status
    ).toBe('READY');
    await service.shutdown();
  });

  it('serializes runtime disablement behind a provider start', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-race-'));
    const repositoryPath = path.join(root, 'repo');
    await fs.mkdir(repositoryPath);
    await initializeRepository(repositoryPath);
    const store = new FileTaskStore(path.join(root, 'store'));
    const codex = createLifecycleRuntime(store, 'codex', 'Codex');
    const opencode = createLifecycleRuntime(store, 'opencode', 'OpenCode');
    const service = new TaskManagerService(store, repositoryPath, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      agentRuntimeAdapters: [codex, opencode],
      defaultAgentRuntimeId: 'codex',
      worktreeRoot: path.join(root, 'worktrees')
    });
    await service.init();
    const task = await service.createTask({
      title: 'Runtime lifecycle race',
      prompt: 'Exercise provider startup.',
      repositoryId: (await addTestRepository(store, repositoryPath)).id,
      runtimeId: 'opencode',
      agentSettings: { runtimeId: 'opencode', model: 'scenario-model' }
    });
    const resolvedModel = (await opencode.listModels())[0]!;
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    let markResolveEntered!: () => void;
    const resolveEntered = new Promise<void>((resolve) => {
      markResolveEntered = resolve;
    });
    vi.mocked(opencode.resolveExecution).mockImplementation(async (input) => {
      markResolveEntered();
      await resolveGate;
      return {
        settings: {
          ...input.settings,
          runtimeId: 'opencode',
          model: resolvedModel.model,
          modelProvider: resolvedModel.modelProvider
        },
        model: resolvedModel
      };
    });

    const starting = service.startRun({ taskId: task.id });
    await resolveEntered;
    const disabling = service.updateAppSettings({ disabledRuntimeIds: ['opencode'] });
    let disableSettled = false;
    void disabling.then(
      () => { disableSettled = true; },
      () => { disableSettled = true; }
    );
    await Promise.resolve();
    expect(disableSettled).toBe(false);

    releaseResolve();
    await expect(starting).resolves.toMatchObject({ status: 'RUNNING' });
    await expect(disabling).rejects.toThrow('active or requires recovery');
    expect(opencode.shutdown).not.toHaveBeenCalled();
    await expect(service.getAppSettings()).resolves.toMatchObject({
      disabledRuntimeIds: []
    });
    await service.shutdown();
  });

  it('serializes live catalog discovery before runtime disablement', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-catalog-disable-race-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const codex = createLifecycleRuntime(store, 'codex', 'Codex');
    const opencode = createLifecycleRuntime(store, 'opencode', 'OpenCode');
    const models = await opencode.listModels();
    vi.mocked(opencode.listModels).mockClear();
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let markCatalogEntered!: () => void;
    const catalogEntered = new Promise<void>((resolve) => {
      markCatalogEntered = resolve;
    });
    vi.mocked(opencode.listModels).mockImplementation(async () => {
      markCatalogEntered();
      await catalogGate;
      return models;
    });
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      agentRuntimeAdapters: [codex, opencode],
      defaultAgentRuntimeId: 'codex'
    });
    await service.init();

    const catalog = service.getAgentRuntimeCatalog();
    await catalogEntered;
    const disabling = service.updateAppSettings({ disabledRuntimeIds: ['opencode'] });
    await Promise.resolve();
    expect(opencode.shutdown).not.toHaveBeenCalled();

    releaseCatalog();
    const beforeDisable = await catalog;
    expect(
      beforeDisable.runtimes.find(
        (runtime) => runtime.preflight.runtime.id === 'opencode'
      )?.preflight.readiness.status
    ).toBe('READY');
    await expect(disabling).resolves.toMatchObject({
      disabledRuntimeIds: ['opencode']
    });
    expect(opencode.shutdown).toHaveBeenCalledOnce();
    const afterDisable = await service.getAgentRuntimeCatalog();
    expect(
      afterDisable.runtimes.find(
        (runtime) => runtime.preflight.runtime.id === 'opencode'
      )?.preflight.readiness.status
    ).toBe('DISABLED');
    expect(opencode.listModels).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it('allows active-run controls while unrelated catalog discovery is pending', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-control-catalog-'));
    const repositoryPath = path.join(root, 'repo');
    await fs.mkdir(repositoryPath);
    await initializeRepository(repositoryPath);
    const store = new FileTaskStore(path.join(root, 'store'));
    const runtime = createLifecycleRuntime(store, 'codex', 'Codex');
    const capabilities = await runtime.capabilities();
    vi.mocked(runtime.capabilities).mockResolvedValue({
      ...capabilities,
      activeTurnSteering: {
        maturity: 'stable',
        detail: 'Lifecycle test runtime accepts active-turn steering.'
      }
    });
    const service = new TaskManagerService(store, repositoryPath, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      agentRuntimeAdapters: [runtime],
      worktreeRoot: path.join(root, 'worktrees')
    });
    await service.init();
    const task = await service.createTask({
      title: 'Runtime control remains responsive',
      prompt: 'Exercise provider controls.',
      repositoryId: (await addTestRepository(store, repositoryPath)).id,
      runtimeId: 'codex',
      agentSettings: { runtimeId: 'codex', model: 'scenario-model' }
    });
    const run = await service.startRun({ taskId: task.id });
    const models = await runtime.listModels();
    vi.mocked(runtime.listModels).mockClear();
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let markCatalogEntered!: () => void;
    const catalogEntered = new Promise<void>((resolve) => {
      markCatalogEntered = resolve;
    });
    vi.mocked(runtime.listModels).mockImplementation(async () => {
      markCatalogEntered();
      await catalogGate;
      return models;
    });
    const steerTurn = vi.spyOn(runtime, 'steerTurn');
    const interruptTurn = vi.spyOn(runtime, 'interruptTurn');

    const catalog = service.getAgentRuntimeCatalog();
    await catalogEntered;
    await expect(
      service.steerRun({ taskId: task.id, runId: run.id, instruction: 'Continue safely.' })
    ).resolves.toBeUndefined();
    await expect(service.cancelRun({ runId: run.id })).resolves.toBeUndefined();
    expect(steerTurn).toHaveBeenCalledOnce();
    expect(interruptTurn).toHaveBeenCalledOnce();

    releaseCatalog();
    await expect(catalog).resolves.toBeDefined();
    await service.shutdown();
  });

  it('settles interrupted initialization before provider shutdown and store closure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-init-shutdown-race-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const closeStore = vi.spyOn(store, 'close');
    const runtime = createLifecycleRuntime(store, 'codex', 'Codex');
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    let markInitializationEntered!: () => void;
    const initializationEntered = new Promise<void>((resolve) => {
      markInitializationEntered = resolve;
    });
    vi.mocked(runtime.initialize).mockImplementation(async () => {
      markInitializationEntered();
      await initializationGate;
    });
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      agentRuntimeAdapters: [runtime]
    });

    const initializing = service.init();
    await initializationEntered;
    const shutdown = service.shutdown();
    await Promise.resolve();
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();

    releaseInitialization();
    await expect(initializing).rejects.toThrow('shutting down');
    await expect(shutdown).resolves.toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('queues shutdown behind provider lifecycle work and rejects later starts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-shutdown-race-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const closeStore = vi.spyOn(store, 'close');
    const runtime = createLifecycleRuntime(store, 'codex', 'Codex');
    const models = await runtime.listModels();
    vi.mocked(runtime.listModels).mockClear();
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let markCatalogEntered!: () => void;
    const catalogEntered = new Promise<void>((resolve) => {
      markCatalogEntered = resolve;
    });
    vi.mocked(runtime.listModels).mockImplementation(async () => {
      markCatalogEntered();
      await catalogGate;
      return models;
    });
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      agentRuntimeAdapters: [runtime]
    });
    await service.init();

    const catalog = service.getAgentRuntimeCatalog();
    await catalogEntered;
    const shutdown = service.shutdown();
    await expect(service.getAgentRuntimeCatalog()).rejects.toThrow('shutting down');
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();

    releaseCatalog();
    await expect(catalog).resolves.toBeDefined();
    await expect(shutdown).resolves.toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('serializes task runtime release before provider disablement', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-release-disable-race-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const codex = createLifecycleRuntime(store, 'codex', 'Codex');
    const opencode = createLifecycleRuntime(store, 'opencode', 'OpenCode');
    let releaseTask!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    let markReleaseEntered!: () => void;
    const releaseEntered = new Promise<void>((resolve) => {
      markReleaseEntered = resolve;
    });
    const releaseRuntimeTask = vi.fn(async () => {
      markReleaseEntered();
      await releaseGate;
    });
    (opencode as AgentRuntimeAdapter).releaseTask = releaseRuntimeTask;
    const service = new TaskManagerService(store, dir, undefined, {
      appSettingsStore: new MemoryAppSettingsStore(),
      agentRuntimeAdapters: [codex, opencode],
      defaultAgentRuntimeId: 'codex'
    });
    await service.init();
    const task = await service.createTask({
      title: 'Release runtime before disabling',
      prompt: 'Delete this inactive provider task.',
      repositoryId: (await addTestRepository(store, dir)).id,
      runtimeId: 'opencode',
      agentSettings: { runtimeId: 'opencode' }
    });

    const deletion = service.deleteTask({ taskId: task.id });
    const disabling = service.updateAppSettings({ disabledRuntimeIds: ['opencode'] });
    await releaseEntered;
    await Promise.resolve();
    expect(opencode.shutdown).not.toHaveBeenCalled();

    releaseTask();
    await expect(deletion).resolves.toEqual({
      taskId: task.id,
      removedWorktree: false
    });
    await expect(disabling).resolves.toMatchObject({
      disabledRuntimeIds: ['opencode']
    });
    expect(releaseRuntimeTask).toHaveBeenCalledWith(task.id);
    expect(opencode.shutdown).toHaveBeenCalledOnce();
    await service.shutdown();
  });
});

function createLifecycleRuntime(
  store: FileTaskStore,
  runtimeId: AgentRuntimeId,
  displayName: string
): ScriptedAgentRuntimeAdapter {
  const adapter = new ScriptedAgentRuntimeAdapter(store);
  const descriptor = {
    ...TEST_ACP_PROFILE.descriptor,
    id: runtimeId,
    displayName
  };
  Object.defineProperty(adapter, 'descriptor', { value: descriptor });
  const profile = { ...TEST_ACP_PROFILE, descriptor };
  const capabilities = {
    ...acpCapabilities(profile),
    sessionControls: {
      maturity: 'unsupported' as const,
      detail: 'Lifecycle test runtime has no native session controls.'
    }
  };
  const model: AgentModel = {
    id: `${runtimeId}:test/scenario-model`,
    runtimeId,
    modelProvider: 'test',
    model: 'scenario-model',
    displayName: 'Scenario model',
    hidden: false,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities: ['text'],
    isDefault: true
  };
  vi.spyOn(adapter, 'initialize');
  vi.spyOn(adapter, 'shutdown');
  vi.spyOn(adapter, 'capabilities').mockResolvedValue(capabilities);
  vi.spyOn(adapter, 'preflight').mockResolvedValue({
    runtime: descriptor,
    readiness: createRuntimeReadiness('READY', `${displayName} is ready.`),
    capabilities
  });
  vi.spyOn(adapter, 'listModels').mockResolvedValue([model]);
  vi.spyOn(adapter, 'resolveExecution').mockImplementation(async (input) => ({
    settings: {
      ...input.settings,
      runtimeId,
      model: model.model,
      modelProvider: model.modelProvider
    },
    model
  }));
  return adapter;
}

async function initializeRepository(repositoryPath: string): Promise<void> {
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Runtime test\n', 'utf8');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial commit']);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function expectedDiscoveredPath(candidate: string): Promise<string> {
  return process.platform === 'win32' ? fs.realpath(candidate) : candidate;
}

function withPath(...entries: string[]): string {
  return [...entries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
}

function createCodexSettingsTestService(input: {
  store: FileTaskStore;
  repositoryPath: string;
  executable: string;
  events?: AppEventBus;
  additionalAdapters?: readonly AgentRuntimeAdapter[];
}): TaskManagerService {
  const events = input.events ?? new AppEventBus();
  const codex = new CodexAppServerAdapter(input.store, events, {
    cwd: input.repositoryPath,
    executable: input.executable,
    requestTimeoutMs: 2_000,
    restartDelaysMs: []
  });
  return new TaskManagerService(input.store, input.repositoryPath, events, {
    codexPath: input.executable,
    appSettingsStore: new MemoryAppSettingsStore(),
    worktreeRoot: path.join(input.repositoryPath, 'worktrees'),
    agentRuntimeAdapters: [codex, ...(input.additionalAdapters ?? [])]
  });
}

async function waitForAgentServerSnapshot(
  store: FileTaskStore,
  minimumCodexServers = 1,
  requireReady = false
): Promise<Awaited<ReturnType<FileTaskStore['snapshot']>>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const snapshot = await store.snapshot();
    const servers = codexServers(snapshot);
    if (
      servers.length >= minimumCodexServers &&
      (!requireReady || servers.some((server) => server.status === 'READY'))
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Codex App Server startup.');
}

function codexServers(
  snapshot: Awaited<ReturnType<FileTaskStore['snapshot']>>
) {
  return snapshot.agentServers.filter((server) => server.runtimeId === 'codex');
}

async function writeFakeCodex(
  directory: string,
  name: string,
  options: {
    version?: string;
    appServer?: 'stdio' | 'none';
    mcpList?: 'valid' | 'fail' | 'malformed';
  } = {}
): Promise<string> {
  return writeNodeExecutable(directory, name, fakeCodexScript(options));
}

function fakeCodexScript({
  version = '0.141.0',
  appServer = 'stdio',
  mcpList = 'valid'
}: {
  version?: string;
  appServer?: 'stdio' | 'none';
  mcpList?: 'valid' | 'fail' | 'malformed';
}): string {
  return `#!/usr/bin/env node
const appServer = ${JSON.stringify(appServer)};
const mcpList = ${JSON.stringify(mcpList)};

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli ${version}\\n');
  process.exit(0);
}

if (process.argv[2] === 'mcp' && process.argv[3] === 'list' && process.argv.includes('--json')) {
  if (mcpList === 'fail') {
    process.stderr.write('mcp discovery failed\\n');
    process.exit(2);
  }
  if (mcpList === 'malformed') {
    process.stdout.write('{"unexpected":true}\\n');
    process.exit(0);
  }
  process.stdout.write('[{"name":"docs","enabled":true,"transport":{"type":"stdio","command":"docs-mcp"}}]\\n');
  process.exit(0);
}

if (process.argv[2] === 'app-server' && process.argv.includes('--help')) {
  if (appServer === 'none') {
    process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\\n');
  } else {
    process.stdout.write('Usage: codex app-server [OPTIONS]\\n  --stdio\\n  --listen <URL>\\n');
  }
  process.exit(0);
}

if (process.argv[2] !== 'app-server' || !process.argv.includes('--stdio')) {
  process.stderr.write('unsupported command\\n');
  process.exit(2);
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.id || !message.method) return;
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {
        userAgent: 'fake-codex/${version}',
        codexHome: process.env.CODEX_HOME || process.cwd(),
        platformFamily: 'unix',
        platformOs: 'macos'
      } });
      break;
    case 'account/read':
      send({ id: message.id, result: {
        account: { type: 'apiKey' },
        requiresOpenaiAuth: false
      } });
      break;
    case 'model/list':
      send({ id: message.id, result: {
        data: [{
          id: 'fake-model',
          model: 'fake-model',
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: 'Fake Model',
          description: 'Test model',
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Low' },
            { reasoningEffort: 'high', description: 'High' }
          ],
          defaultReasoningEffort: 'high',
          inputModalities: ['text'],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: true
        }],
        nextCursor: null
      } });
      break;
    case 'thread/start':
      send({ id: message.id, result: {
        activePermissionProfile: {
          id: message.params.config.default_permissions,
          extends: null
        },
        runtimeWorkspaceRoots: [message.params.cwd]
      } });
      break;
    case 'thread/resume':
    case 'thread/fork':
    case 'thread/read':
    case 'thread/goal/get':
    case 'thread/goal/set':
    case 'turn/start':
    case 'turn/steer':
    case 'turn/interrupt':
    case 'review/start':
      send({ id: message.id, error: { code: -32602, message: 'probe-only fake method' } });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported ' + message.method } });
  }
});
`;
}
