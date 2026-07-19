import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  CodexAppsMode,
  CodexMcpServersMode,
  CodexWebSearchMode
} from '../../../shared/agent';
import {
  CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS,
  CodexAppServerSupervisor,
  codexAppServerArgv,
  resolveCodexAppServerArgv
} from './CodexAppServerSupervisor';
import {
  codexExternalToolConfigOverrides,
  parseDisabledCodexMcpServerConfigOverrides,
  parseEnabledCodexMcpServerNames
} from './CodexToolConfig';
import { FileTaskStore } from '../../storage/FileTaskStore';

const WEB_SEARCH_MODES: CodexWebSearchMode[] = ['disabled', 'cached', 'live'];
const MCP_SERVER_MODES: CodexMcpServersMode[] = ['disabled', 'all'];
const APP_MODES: CodexAppsMode[] = ['disabled', 'enabled'];
const SAMPLE_MCP_DISABLE_OVERRIDE =
  'mcp_servers.docs={enabled=false, command="docs-mcp", args=["--stdio"]}';

describe('Codex App Server launch configuration', () => {
  it('starts the embedded app-server with minimal built-in tool configuration overrides', () => {
    expect(codexAppServerArgv()).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="disabled"'
    ]);
  });

  it('starts the embedded app-server with discovered MCP disable overrides', () => {
    expect(
      codexAppServerArgv({
        mcpServerConfigOverrides: [
          'mcp_servers.next-devtools={enabled=false, command="npx", args=["next-devtools-mcp@latest"]}'
        ]
      })
    ).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="disabled"',
      '-c',
      'mcp_servers.next-devtools={enabled=false, command="npx", args=["next-devtools-mcp@latest"]}'
    ]);
  });

  it('uses documented Codex config overrides for opt-in external tools', () => {
    expect(
      codexAppServerArgv({
        toolSettings: {
          webSearchMode: 'live',
          mcpServers: 'all',
          apps: 'enabled'
        }
      })
    ).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'features.apps=true',
      '-c',
      'web_search="live"'
    ]);
  });

  it('can build argv for a runtime that only exposes default stdio app-server launch', () => {
    expect(
      codexAppServerArgv({
        appServerArgv: ['app-server'],
        toolSettings: {
          webSearchMode: 'disabled',
          mcpServers: 'disabled',
          apps: 'disabled'
        }
      })
    ).toEqual([
      'app-server',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="disabled"'
    ]);
  });

  it('does not inspect MCP configuration when all MCP servers are allowed', async () => {
    await expect(
      resolveCodexAppServerArgv({
        executable: '/definitely/not/codex',
        cwd: process.cwd(),
        toolSettings: {
          webSearchMode: 'cached',
          mcpServers: 'all',
          apps: 'disabled'
        }
      })
    ).resolves.toEqual([
      'app-server',
      '--stdio',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="cached"'
    ]);
  });

  it('projects every external tool config variation into App Server argv', () => {
    for (const webSearchMode of WEB_SEARCH_MODES) {
      for (const mcpServers of MCP_SERVER_MODES) {
        for (const apps of APP_MODES) {
          expect(
            codexAppServerArgv({
              toolSettings: {
                webSearchMode,
                mcpServers,
                apps
              },
              mcpServerConfigOverrides:
                mcpServers === 'disabled' ? [SAMPLE_MCP_DISABLE_OVERRIDE] : []
            })
          ).toEqual([
            'app-server',
            '--stdio',
            '-c',
            `features.apps=${apps === 'enabled' ? 'true' : 'false'}`,
            '-c',
            `web_search="${webSearchMode}"`,
            ...(mcpServers === 'disabled' ? ['-c', SAMPLE_MCP_DISABLE_OVERRIDE] : [])
          ]);
        }
      }
    }
  });

  it('normalizes malformed launch settings back to local-only', () => {
    expect(codexExternalToolConfigOverrides(undefined)).toEqual([
      'features.apps=false',
      'web_search="disabled"'
    ]);
  });

  it('builds transport-shaped MCP disable overrides without keeping env data', () => {
    const json = JSON.stringify([
      {
        name: 'next-devtools',
        enabled: true,
        transport: { type: 'stdio', command: 'npx', args: ['next-devtools-mcp@latest'] }
      },
      {
        name: 'openaiDeveloperDocs',
        enabled: true,
        transport: { type: 'streamable_http', url: 'https://developers.openai.com/mcp' }
      },
      {
        name: 'ask-starknet',
        enabled: false,
        transport: { type: 'stdio', command: 'npx', env: { KEY: 'secret' } }
      },
      {
        name: 'unsafe.server',
        enabled: true,
        transport: { type: 'stdio', command: 'node' }
      }
    ]);

    expect(parseDisabledCodexMcpServerConfigOverrides(json)).toEqual([
      'mcp_servers.next-devtools={enabled=false, command="npx", args=["next-devtools-mcp@latest"]}',
      'mcp_servers.openaiDeveloperDocs={enabled=false, url="https://developers.openai.com/mcp"}'
    ]);
    expect(parseEnabledCodexMcpServerNames(json)).toEqual([
      'next-devtools',
      'openaiDeveloperDocs'
    ]);
  });

  it('opts out of high-volume notifications that are not Task Monki evidence', () => {
    expect(CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS).toEqual(
      expect.arrayContaining([
        'item/agentMessage/delta',
        'item/commandExecution/outputDelta',
        'item/reasoning/summaryTextDelta',
        'turn/diff/updated'
      ])
    );
  });

  it('does not spawn or leave STARTING state when shutdown wins a durable-start race', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-supervisor-'));
    const store = new FileTaskStore(path.join(directory, 'store'));
    const originalCreate = store.createAgentServer.bind(store);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createdResolve!: () => void;
    const created = new Promise<void>((resolve) => {
      createdResolve = resolve;
    });
    store.createAgentServer = async (input) => {
      const record = await originalCreate(input);
      createdResolve();
      await createGate;
      return record;
    };
    const spawnProcess = vi.fn();
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: directory,
      appVersion: 'test',
      runtimeResolver: async () => resolvedCodexRuntime(),
      argvResolver: async () => ['app-server', '--stdio'],
      spawnProcess
    });

    const starting = supervisor.start();
    await created;
    const stopping = supervisor.shutdown();
    releaseCreate();

    await expect(starting).rejects.toThrow('canceled');
    await stopping;
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await store.snapshot()).agentServers).toEqual([
      expect.objectContaining({ status: 'EXITED' })
    ]);
    await expect(supervisor.start()).rejects.toThrow('shut down');
    store.createAgentServer = originalCreate;
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('persists and emits only redacted argv and process diagnostics', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-supervisor-'));
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeCodexChild();
    const diagnostics: string[] = [];
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
    let detached: boolean | undefined;
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: directory,
      appVersion: 'test',
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: path.join(directory, 'codex-home'),
        OPENAI_API_KEY: 'codex-environment-secret'
      },
      runtimeResolver: async () => resolvedCodexRuntime(),
      argvResolver: async () => [
        'app-server',
        '--stdio',
        '--token',
        'codex-argv-secret',
        '-c',
        'mcp_servers.remote={url="https://user:codex-url-secret@example.test/rpc?token=codex-query-secret"}'
      ],
      spawnProcess: (_executable, _argv, options) => {
        spawnedEnvironment = options.env;
        detached = options.detached;
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }
    });
    supervisor.events.on('diagnostic', (value) => diagnostics.push(value));

    await supervisor.start();
    child.stderr.write('OPENAI_API_KEY=codex-environment-');
    child.stderr.write('secret Authorization: Bearer codex-bearer-secret\n');
    await supervisor.shutdown();

    const server = (await store.snapshot()).agentServers[0]!;
    const durable = JSON.stringify(server);
    expect(spawnedEnvironment).toEqual({
      PATH: process.env.PATH,
      CODEX_HOME: path.join(directory, 'codex-home')
    });
    expect(detached).toBe(process.platform !== 'win32');
    expect(durable).toContain('[REDACTED]');
    for (const secret of [
      'codex-environment-secret',
      'codex-argv-secret',
      'codex-url-secret',
      'codex-query-secret',
      'codex-bearer-secret'
    ]) {
      expect(durable).not.toContain(secret);
      expect(diagnostics.join('\n')).not.toContain(secret);
    }
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('delivers journaled notifications before emitting process exit', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-drain-'));
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeCodexChild();
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: directory,
      appVersion: 'test',
      runtimeResolver: async () => resolvedCodexRuntime(),
      argvResolver: async () => ['app-server', '--stdio'],
      spawnProcess: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }
    });
    const client = await supervisor.start();
    const appendProtocolMessage = store.appendProtocolMessage.bind(store);
    let releaseNotificationAppend!: () => void;
    let markNotificationAppendStarted!: () => void;
    const notificationAppendGate = new Promise<void>((resolve) => {
      releaseNotificationAppend = resolve;
    });
    const notificationAppendStarted = new Promise<void>((resolve) => {
      markNotificationAppendStarted = resolve;
    });
    vi.spyOn(store, 'appendProtocolMessage').mockImplementation(
      async (serverId, direction, raw, metadata) => {
        if (direction === 'INBOUND' && raw.includes('thread/closed')) {
          markNotificationAppendStarted();
          await notificationAppendGate;
        }
        return appendProtocolMessage(serverId, direction, raw, metadata);
      }
    );
    const lifecycleOrder: string[] = [];
    client.events.on('notification', () => lifecycleOrder.push('notification'));
    const exited = new Promise<void>((resolve) => {
      supervisor.events.once('exit', () => {
        lifecycleOrder.push('exit');
        resolve();
      });
    });

    (child.stdout as PassThrough).write(
      `${JSON.stringify({
        method: 'thread/closed',
        params: { threadId: 'thread-1' }
      })}\n`
    );
    await notificationAppendStarted;
    child.emit('close', 17, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lifecycleOrder).toEqual([]);

    releaseNotificationAppend();
    await exited;
    expect(lifecycleOrder).toEqual(['notification', 'exit']);

    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('fences replacement startup when inbound delivery cannot be drained', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-drain-'));
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeCodexChild();
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: directory,
      appVersion: 'test',
      runtimeResolver: async () => resolvedCodexRuntime(),
      argvResolver: async () => ['app-server', '--stdio'],
      spawnProcess: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }
    });
    const client = await supervisor.start();
    vi.spyOn(client, 'drainInbound').mockRejectedValue(
      new Error('injected inbound drain failure')
    );
    const exited = new Promise<void>((resolve) => {
      supervisor.events.once('exit', () => resolve());
    });

    child.emit('close', 17, null);
    await exited;

    await expect(supervisor.start()).rejects.toThrow('lifecycle is fenced');
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('terminates and fences the client even when exit persistence fails', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-codex-termination-store-failure-')
    );
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeCodexChild();
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: directory,
      appVersion: 'test',
      runtimeResolver: async () => resolvedCodexRuntime(),
      argvResolver: async () => ['app-server', '--stdio'],
      spawnProcess: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      shutdownGraceTimeoutMs: 10,
      shutdownKillTimeoutMs: 10,
      closeHandlingTimeoutMs: 1_000
    });

    const client = await supervisor.start();
    const close = vi.spyOn(client, 'close');
    const updateAgentServer = store.updateAgentServer.bind(store);
    vi.spyOn(store, 'updateAgentServer').mockImplementation(async (serverId, patch) => {
      if (
        patch.status === 'EXITED' ||
        patch.status === 'FAILED' ||
        patch.status === 'LOST'
      ) {
        throw new Error('injected termination persistence failure');
      }
      return updateAgentServer(serverId, patch);
    });

    await expect(
      supervisor.terminateUnresponsive('acknowledgement persistence failed')
    ).rejects.toThrow('could not be fully confirmed and persisted');
    expect(close).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.signalCode).toBe('SIGTERM');
    expect(supervisor.currentClient).toBeUndefined();
    await expect(supervisor.start()).rejects.toThrow('lifecycle is fenced');

    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('hard-fences an unresponsive process when TERM and KILL cannot confirm exit', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-stubborn-'));
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeCodexChild({ closeOnKill: false });
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: directory,
      appVersion: 'test',
      runtimeResolver: async () => resolvedCodexRuntime(),
      argvResolver: async () => ['app-server', '--stdio'],
      spawnProcess: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      shutdownGraceTimeoutMs: 10,
      shutdownKillTimeoutMs: 10,
      closeHandlingTimeoutMs: 10
    });

    await supervisor.start();
    await expect(supervisor.terminateUnresponsive('health check failed')).rejects.toThrow(
      'did not exit after SIGKILL'
    );
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await expect(supervisor.start()).rejects.toThrow('lifecycle is fenced');
    expect(supervisor.currentServer).toMatchObject({ status: 'LOST' });

    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('coalesces safety-fence and close-handler process-tree termination', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-fence-'));
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeCodexChild({ closeBeforeExitConfirmation: true });
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: directory,
      appVersion: 'test',
      runtimeResolver: async () => resolvedCodexRuntime(),
      argvResolver: async () => ['app-server', '--stdio'],
      spawnProcess: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }
    });

    await supervisor.start();
    await supervisor.terminateAndFence('unsafe provider settings');

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(supervisor.currentServer).toMatchObject({ status: 'EXITED' });
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('refuses a replacement generation when prior exit cleanup cannot confirm termination', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-prior-tree-'));
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeCodexChild({ closeOnKill: false });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: directory,
      appVersion: 'test',
      runtimeResolver: async () => resolvedCodexRuntime(),
      argvResolver: async () => ['app-server', '--stdio'],
      spawnProcess,
      shutdownGraceTimeoutMs: 10,
      shutdownKillTimeoutMs: 10,
      closeHandlingTimeoutMs: 50
    });

    await supervisor.start();
    child.emit('close', 0, null);

    await expect(supervisor.start()).rejects.toThrow(
      /Timed out finalizing the prior Codex App Server exit|did not exit|lifecycle is fenced/
    );
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
});

function resolvedCodexRuntime() {
  return {
    executable: '/fake/codex',
    source: 'config' as const,
    version: '0.144.2',
    compatibility: {
      launch: {
        argv: ['app-server', '--stdio'],
        transport: 'STDIO' as const,
        form: 'stdio-flag' as const
      },
      requiredMethods: []
    },
    diagnostics: []
  };
}

function fakeCodexChild(
  options: { closeOnKill?: boolean; closeBeforeExitConfirmation?: boolean } = {}
): ChildProcessWithoutNullStreams & {
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { stderr: PassThrough };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let signalCode: NodeJS.Signals | null = null;
  let killed = false;
  const kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    killed = true;
    if (options.closeOnKill !== false) {
      if (options.closeBeforeExitConfirmation) {
        queueMicrotask(() => {
          child.emit('close', null, signal);
          setImmediate(() => {
            signalCode = signal;
          });
        });
      } else {
        signalCode = signal;
        queueMicrotask(() => child.emit('close', null, signal));
      }
    }
    return true;
  });
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 7676,
    exitCode: null,
    kill
  });
  Object.defineProperties(child, {
    signalCode: { get: () => signalCode },
    killed: { get: () => killed }
  });
  let input = '';
  stdin.on('data', (chunk) => {
    input += chunk.toString('utf8');
    for (;;) {
      const newline = input.indexOf('\n');
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.method === 'initialize' && message.id !== undefined) {
        stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
    }
  });
  return child as ChildProcessWithoutNullStreams & {
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
}
