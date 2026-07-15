import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTaskStore } from '../../storage/FileTaskStore';
import {
  AcpStdioSupervisor,
  type AcpStdioSupervisorOptions
} from './AcpStdioSupervisor';
import type { AcpRuntimeProfile } from './AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('AcpStdioSupervisor', () => {
  it('negotiates stable v1 with boolean config support and no client fs or terminal tools', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-supervisor-'));
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    await fs.writeFile(
      agentScript,
      [
        "const readline = require('node:readline');",
        "if (process.env.GEMINI_API_KEY !== 'allowed-provider-secret') process.exit(11);",
        "if (process.env.TASK_MONKI_UNRELATED_SECRET !== undefined) process.exit(12);",
        "if (process.env.CODEX_HOME !== undefined) process.exit(13);",
        "const input = readline.createInterface({ input: process.stdin });",
        "input.on('line', (line) => {",
        '  const message = JSON.parse(line);',
        "  if (message.method === 'initialize') {",
        '    process.stdout.write(JSON.stringify({',
        "      jsonrpc: '2.0',",
        '      id: message.id,',
        '      result: {',
        '        protocolVersion: 1,',
        '        agentCapabilities: {',
        '          promptCapabilities: { image: true },',
        '          sessionCapabilities: { resume: {} }',
        '        },',
        "        agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '9.1.0' }",
        '      }',
        "    }) + '\\n');",
        '  }',
        '});'
      ].join('\n'),
      { mode: 0o600 }
    );

    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: 'test-acp' },
      executableCandidates: [process.execPath],
      argv: [agentScript],
      environmentPolicy: {
        contractId: 'task-monki/test-acp-environment@v1',
        allowedKeys: ['GEMINI_API_KEY'],
        sensitiveKeys: ['GEMINI_API_KEY']
      }
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new AcpStdioSupervisor(store, {
      profile,
      runtime: {
        executable: process.execPath,
        version: process.version,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedVersion: process.version,
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      },
      cwd: directory,
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: '/must-not-pass/codex-home',
        GEMINI_API_KEY: 'allowed-provider-secret',
        TASK_MONKI_UNRELATED_SECRET: 'must-not-pass'
      },
      requestTimeoutMs: 2_000
    });

    try {
      const running = await supervisor.start();
      expect(running.initialize).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: 'fake-acp', version: '9.1.0' },
        agentCapabilities: { sessionCapabilities: { resume: {} } }
      });
      expect(running.server).toMatchObject({
        runtimeId: 'test-acp',
        runtimeKind: 'ACP_AGENT',
        transport: 'STDIO',
        status: 'READY',
        schemaVersion: '1.19.0',
        runtimeVersion: '9.1.0'
      });
      const journal = await fs.readFile(running.server.protocolJournalPath, 'utf8');
      const entries = journal.trim().split('\n').map((line) => JSON.parse(line) as {
        direction: string;
        raw: string;
      });
      const outboundInitialize = entries.find((entry) => entry.direction === 'OUTBOUND');
      const initialize = JSON.parse(outboundInitialize!.raw) as {
        params: { clientCapabilities: unknown };
      };
      expect(initialize.params.clientCapabilities).toEqual({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: { configOptions: { boolean: {} } }
      });
    } finally {
      await supervisor.shutdown();
    }
    const server = (await store.snapshot()).agentServers[0];
    expect(server?.status).toBe('EXITED');
  });

  it('redacts provider credentials from persisted stderr diagnostics', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-redaction-'));
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    await fs.writeFile(
      agentScript,
      [
        "const readline = require('node:readline');",
        "const input = readline.createInterface({ input: process.stdin });",
        "input.on('line', (line) => {",
        '  const message = JSON.parse(line);',
        "  process.stderr.write('OLD_DIAGNOSTIC_MARKER' + 'x'.repeat(70 * 1024));",
        "  process.stderr.write('{\"GEMINI_API_KEY\":\"TOPSE');",
        '  setTimeout(() => {',
        "    process.stderr.write('CRET123\",\"authorization\":\"Bearer TOPSECRET123\"}\\n');",
        "    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 2 } }) + '\\n'), 20);",
        '  }, 20);',
        '});'
      ].join('\n'),
      { mode: 0o600 }
    );
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: 'test-acp-redaction' },
      executableCandidates: [process.execPath],
      argv: [agentScript]
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new AcpStdioSupervisor(store, {
      profile,
      runtime: {
        executable: process.execPath,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      },
      cwd: directory,
      environment: { ...process.env, GEMINI_API_KEY: 'TOPSECRET123' },
      requestTimeoutMs: 2_000
    });
    await expect(supervisor.start()).rejects.toThrow('supports stable protocol 1');
    const server = (await store.snapshot()).agentServers[0];
    expect(server?.exitReason).toContain('[REDACTED]');
    expect(server?.exitReason).not.toContain('TOPSECRET123');
    expect(server?.exitReason).not.toContain('OLD_DIAGNOSTIC_MARKER');
    const persistedTail = server?.exitReason?.split(' Diagnostics: ')[1] ?? '';
    expect(Buffer.byteLength(persistedTail, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('does not spawn or leave STARTING state when shutdown wins server creation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-supervisor-'));
    temporaryDirectories.push(directory);
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
    const supervisor = new AcpStdioSupervisor(store, {
      profile: TEST_ACP_PROFILE,
      runtime: {
        executable: '/fake/gemini',
        version: '0.50.0',
        diagnostics: {
          selectedExecutable: '/fake/gemini',
          selectedSource: 'test',
          selectedVersion: '0.50.0',
          selectedLaunchArgv: ['--experimental-acp'],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      },
      cwd: directory,
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
  });

  it('fails promptly and permanently fences a child that ignores TERM and KILL', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-stubborn-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeAcpChild({ closeOnKill: false });
    const supervisor = new AcpStdioSupervisor(store, {
      profile: testProfile('test-acp-stubborn'),
      runtime: testRuntime(),
      cwd: directory,
      spawnProcess: fakeSpawn(child),
      requestTimeoutMs: 500,
      shutdownGraceTimeoutMs: 10,
      shutdownKillTimeoutMs: 10,
      closeHandlingTimeoutMs: 10
    });
    const exit = vi.fn();
    supervisor.events.on('exit', exit);

    await supervisor.start();
    const startedAt = Date.now();
    const failure = await supervisor.shutdown().catch((cause: unknown) => cause);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('did not exit after SIGKILL') })
      ])
    );
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(supervisor.currentClient).toBeDefined();
    expect(supervisor.negotiatedInitialize).toBeUndefined();
    expect(supervisor.safetyFenceReason).toContain('termination could not be confirmed');
    expect(supervisor.currentServer).toEqual(
      expect.objectContaining({ status: 'LOST', disconnectedAt: expect.any(String) })
    );
    expect((await store.snapshot()).agentServers[0]).toEqual(
      expect.objectContaining({ status: 'LOST', disconnectedAt: expect.any(String) })
    );
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(expect.objectContaining({ status: 'LOST' }), true);
    await expect(supervisor.start()).rejects.toThrow('safety-fenced until app restart');
    expect(child.listenerCount('close')).toBe(1);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(1);
  });

  it('retains a hard fence when startup cleanup cannot confirm process exit', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-start-fence-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeAcpChild({ closeOnKill: false, protocolVersion: 2 });
    const spawnProcess = vi.fn(fakeSpawn(child)) as unknown as NonNullable<
      AcpStdioSupervisorOptions['spawnProcess']
    >;
    const supervisor = new AcpStdioSupervisor(store, {
      profile: testProfile('test-acp-start-fence'),
      runtime: testRuntime(),
      cwd: directory,
      spawnProcess,
      requestTimeoutMs: 500,
      shutdownGraceTimeoutMs: 10,
      shutdownKillTimeoutMs: 10,
      closeHandlingTimeoutMs: 10
    });

    const failure = await supervisor.start().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('did not exit after SIGKILL') })
      ])
    );
    expect(supervisor.safetyFenceReason).toContain('termination could not be confirmed');
    expect(supervisor.currentClient).toBeDefined();
    expect(supervisor.currentServer).toEqual(expect.objectContaining({ status: 'LOST' }));
    await expect(supervisor.start()).rejects.toThrow('safety-fenced until app restart');
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it('permanently fences a process after a protocol violation even when termination is unconfirmed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-protocol-fence-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeAcpChild({ closeOnKill: false });
    const supervisor = new AcpStdioSupervisor(store, {
      profile: testProfile('test-acp-protocol-fence'),
      runtime: testRuntime(),
      cwd: directory,
      spawnProcess: fakeSpawn(child),
      requestTimeoutMs: 500,
      shutdownGraceTimeoutMs: 10,
      shutdownKillTimeoutMs: 10,
      closeHandlingTimeoutMs: 10
    });

    await supervisor.start();
    (child.stdout as PassThrough).write('{invalid-json}\n');

    await waitForCondition(
      () => (child.kill as ReturnType<typeof vi.fn>).mock.calls.length >= 2
    );
    await waitForCondition(() => supervisor.currentServer?.status === 'LOST');
    expect(supervisor.safetyFenceReason).toContain('protocol violation');
    await expect(supervisor.start()).rejects.toThrow('safety-fenced until app restart');
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('keeps the protocol-violation fence after process exit is confirmed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-protocol-exit-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeAcpChild({ closeOnKill: true });
    const supervisor = new AcpStdioSupervisor(store, {
      profile: testProfile('test-acp-protocol-exit'),
      runtime: testRuntime(),
      cwd: directory,
      spawnProcess: fakeSpawn(child),
      requestTimeoutMs: 500,
      shutdownGraceTimeoutMs: 10,
      shutdownKillTimeoutMs: 10,
      closeHandlingTimeoutMs: 100
    });

    await supervisor.start();
    (child.stdout as PassThrough).write('{invalid-json}\n');

    await waitForCondition(() => supervisor.currentServer?.status === 'LOST');
    expect(supervisor.currentClient).toBeUndefined();
    expect(supervisor.safetyFenceReason).toContain('protocol violation');
    await expect(supervisor.start()).rejects.toThrow('safety-fenced until app restart');
  });

  it('completes close cleanup and surfaces a terminal persistence failure', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-close-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeAcpChild({ closeOnKill: true });
    const supervisor = new AcpStdioSupervisor(store, {
      profile: testProfile('test-acp-close-failure'),
      runtime: testRuntime(),
      cwd: directory,
      spawnProcess: fakeSpawn(child),
      requestTimeoutMs: 500,
      closeHandlingTimeoutMs: 100
    });
    const exit = vi.fn();
    supervisor.events.on('exit', exit);
    await supervisor.start();

    const originalUpdate = store.updateAgentServer.bind(store);
    store.updateAgentServer = async (serverId, update) => {
      if (update.status === 'EXITED') {
        throw new Error('simulated ACP terminal persistence failure');
      }
      return originalUpdate(serverId, update);
    };

    const failure = await supervisor.shutdown().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'simulated ACP terminal persistence failure' })
      ])
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.currentClient).toBeUndefined();
    expect(supervisor.negotiatedInitialize).toBeUndefined();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(expect.any(Object), false);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect((await store.snapshot()).agentServers[0]).toEqual(
      expect.objectContaining({ status: 'STOPPING' })
    );
    store.updateAgentServer = originalUpdate;
  });
});

function testProfile(runtimeId: string): AcpRuntimeProfile {
  return {
    ...TEST_ACP_PROFILE,
    descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
    executableCandidates: ['/fake/acp'],
    argv: ['--acp']
  };
}

function testRuntime(): AcpStdioSupervisorOptions['runtime'] {
  return {
    executable: '/fake/acp',
    version: '1.0.0',
    diagnostics: {
      selectedExecutable: '/fake/acp',
      selectedSource: 'test',
      selectedVersion: '1.0.0',
      selectedLaunchArgv: ['--acp'],
      requiredCapabilities: ['ACP protocolVersion=1'],
      probes: []
    }
  };
}

function fakeSpawn(
  child: ChildProcessWithoutNullStreams
): NonNullable<AcpStdioSupervisorOptions['spawnProcess']> {
  return (() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }) as NonNullable<AcpStdioSupervisorOptions['spawnProcess']>;
}

function fakeAcpChild(options: {
  closeOnKill: boolean;
  protocolVersion?: number;
}): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 42_424;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    if (options.closeOnKill && child.exitCode === null && child.signalCode === null) {
      child.signalCode = signal;
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', null, signal);
      });
    }
    return true;
  });

  let inbound = '';
  child.stdin.on('data', (chunk: Buffer) => {
    inbound += chunk.toString('utf8');
    let newline: number;
    while ((newline = inbound.indexOf('\n')) >= 0) {
      const line = inbound.slice(0, newline);
      inbound = inbound.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as { id?: string | number; method?: string };
      if (request.method !== 'initialize') continue;
      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: options.protocolVersion ?? 1,
              agentCapabilities: {},
              agentInfo: { name: 'fake-acp', version: '1.0.0' }
            }
          })}\n`
        );
      });
    }
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function waitForCondition(read: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for ACP supervisor test state.');
}
