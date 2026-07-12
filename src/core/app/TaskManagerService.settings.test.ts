import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_MONKI_CODEX_BIN_ENV } from '../agent/codex/CodexRuntimeResolver';
import { getGitExecutablePath, configureGitExecutablePath } from '../git/gitCli';
import { MemoryAppSettingsStore } from '../settings/AppSettingsStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';
import {
  writeNodeExecutable,
  writeOutputExecutable
} from '../../testSupport/fakeExecutable';

describe('TaskManagerService settings', () => {
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
    await expect(service.getExternalToolStatus()).resolves.toMatchObject({
      tools: {
        git: {
          status: 'ok',
          version: 'git version service-test'
        }
      }
    });
  });

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
  });

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
      expect(snapshot.agentServers[0]?.argv).toEqual([
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
  });

  it('forces external tools off and rejects enabling them in browser development', async () => {
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
      expect(snapshot.agentServers[0]?.argv).toEqual([
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
  });

  it('keeps deterministic seed hosts inert without starting Codex', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-inert-seed-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const reason = 'Codex is disabled while deterministic seed scenarios are loaded.';
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: 'codex-not-used',
      appSettingsStore: new MemoryAppSettingsStore(),
      agentProviderStartupDisabledReason: reason
    });

    await service.init();
    try {
      expect((await service.getAgentProviderState()).preflight).toMatchObject({
        ready: false,
        problems: [reason]
      });
      expect((await store.snapshot()).agentServers).toHaveLength(0);
      await expect(
        service.refinePrompt({ repositoryPath: dir, input: 'Refine me.' })
      ).rejects.toThrow(reason);
    } finally {
      await service.shutdown();
    }
  });

  it('defers provider restart while a run requires recovery', async () => {
    delete process.env[TASK_MONKI_CODEX_BIN_ENV];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-recovery-'));
    const executable = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '9.9.9'
    });
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: executable,
      appSettingsStore: new MemoryAppSettingsStore(),
      worktreeRoot: path.join(dir, 'worktrees')
    });
    await service.init();
    try {
      const task = await store.createTask({
        title: 'Recovery settings guard',
        prompt: 'Keep recovery state stable.',
        repositoryPath: dir
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
        provider: 'codex'
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
      expect(snapshot.agentServers).toHaveLength(1);
      expect((await service.getAgentProviderState()).preflight.warnings).toContain(
        'Codex executable or tool settings changed and will apply after active runs finish or the app restarts.'
      );
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
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: executable,
      appSettingsStore: new MemoryAppSettingsStore(),
      worktreeRoot: path.join(dir, 'worktrees')
    });

    await service.init();
    try {
      await service.updateAppSettings({
        externalExecutables: {
          gitExecutablePath: fakeGit
        }
      });

      const snapshot = await waitForAgentServerSnapshot(store);
      expect(snapshot.agentServers).toHaveLength(1);
      expect(snapshot.agentServers[0]?.executable).toBe(executable);
      expect(getGitExecutablePath()).toBe(fakeGit);
      expect((await service.getAgentProviderState()).preflight.warnings).not.toContain(
        'Codex executable or tool settings changed and will apply after active runs finish or the app restarts.'
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
      resolvedPath: codex,
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
        resolvedPath: staleCodex,
        version: 'codex-cli 0.22.0'
      });
      expect(snapshot.agentServers[0]?.executable).toBe(compatibleCodex);
      expect(snapshot.agentServers[0]?.runtimeResolution?.selectedExecutable).toBe(
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

      expect(snapshot.agentServers[0]?.executable).toBe(customCodex);
      expect(snapshot.agentServers[0]?.runtimeResolution?.selectedSource).toBe('config');
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
      expect(snapshot.agentServers[0]?.executable).toBe(envCodex);
      expect(snapshot.agentServers[0]?.runtimeResolution?.selectedSource).toBe('config');
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
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function withPath(...entries: string[]): string {
  return [...entries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
}

async function waitForAgentServerSnapshot(
  store: FileTaskStore
): Promise<Awaited<ReturnType<FileTaskStore['snapshot']>>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const snapshot = await store.snapshot();
    if (snapshot.agentServers.length > 0) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Codex App Server startup.');
}

async function writeFakeCodex(
  directory: string,
  name: string,
  options: {
    version?: string;
    appServer?: 'stdio' | 'none';
  } = {}
): Promise<string> {
  return writeNodeExecutable(directory, name, fakeCodexScript(options));
}

function fakeCodexScript({
  version = '0.141.0',
  appServer = 'stdio'
}: {
  version?: string;
  appServer?: 'stdio' | 'none';
}): string {
  return `#!/usr/bin/env node
const appServer = ${JSON.stringify(appServer)};

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli ${version}\\n');
  process.exit(0);
}

if (process.argv[2] === 'mcp' && process.argv[3] === 'list' && process.argv.includes('--json')) {
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
