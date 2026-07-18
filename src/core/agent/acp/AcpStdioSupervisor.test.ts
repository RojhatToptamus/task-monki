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
import { spawnPortable } from '../../process/portableChildProcess';

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
        "        agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: process.env.GEMINI_API_KEY }",
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
        agentInfo: { name: 'fake-acp', version: '[REDACTED]' },
        agentCapabilities: { sessionCapabilities: { resume: {} } }
      });
      expect(running.server).toMatchObject({
        runtimeId: 'test-acp',
        runtimeKind: 'ACP_AGENT',
        transport: 'STDIO',
        status: 'READY',
        schemaVersion: '1.19.0',
        runtimeVersion: '[REDACTED]'
      });
      expect(JSON.stringify(await store.snapshot())).not.toContain(
        'allowed-provider-secret'
      );
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

  it('drains an accepted terminal response before publishing process loss', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-close-drain-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeAcpChild({ closeOnKill: true });
    const supervisor = new AcpStdioSupervisor(store, {
      profile: testProfile('test-acp-close-drain'),
      runtime: testRuntime(),
      cwd: directory,
      spawnProcess: fakeSpawn(child),
      requestTimeoutMs: 500,
      closeHandlingTimeoutMs: 500
    });
    const running = await supervisor.start();
    const originalAppend = store.appendProtocolMessage.bind(store);
    let releaseJournal!: () => void;
    const journalGate = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    let acceptedResolve!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptedResolve = resolve;
    });
    store.appendProtocolMessage = async (serverId, direction, raw, metadata) => {
      if (direction === 'INBOUND' && raw.includes('accepted-before-close')) {
        acceptedResolve();
        await journalGate;
      }
      return originalAppend(serverId, direction, raw, metadata);
    };
    const exit = vi.fn();
    supervisor.events.on('exit', exit);
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString('utf8').trim()) as {
        id: string | number;
        method: string;
      };
      if (request.method !== 'session/test') return;
      (child.stdout as PassThrough).write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { terminal: 'accepted-before-close' }
        })}\n`
      );
      (child as unknown as { exitCode: number | null }).exitCode = 0;
      (child.stdout as PassThrough).end();
      (child.stderr as PassThrough).end();
      child.emit('close', 0, null);
    });

    const response = running.client.request<{ terminal: string }>('session/test', {});
    await accepted;
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    releaseJournal();

    await expect(response).resolves.toMatchObject({
      result: { terminal: 'accepted-before-close' }
    });
    await waitForCondition(() => exit.mock.calls.length === 1);
    expect(exit).toHaveBeenCalledWith(expect.objectContaining({ status: 'LOST' }), true);
    expect(supervisor.currentClient).toBeUndefined();
    store.appendProtocolMessage = originalAppend;
  });

  it('safety-fences the runtime when accepted inbound dispatch cannot drain', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-drain-failure-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const child = fakeAcpChild({ closeOnKill: true });
    const supervisor = new AcpStdioSupervisor(store, {
      profile: testProfile('test-acp-drain-failure'),
      runtime: testRuntime(),
      cwd: directory,
      spawnProcess: fakeSpawn(child),
      requestTimeoutMs: 500,
      closeHandlingTimeoutMs: 500
    });
    const running = await supervisor.start();
    let notificationCount = 0;
    running.client.events.on('notification', () => {
      notificationCount += 1;
      if (notificationCount === 1) {
        throw new Error('simulated inbound materialization failure');
      }
    });
    const protocolError = vi.fn();
    supervisor.events.on('protocolError', protocolError);

    (child.stdout as PassThrough).write(
      [1, 2]
        .map((sequence) =>
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'session-1',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: `command-${sequence}` }]
              }
            }
          })
        )
        .join('\n') + '\n'
    );
    (child as unknown as { exitCode: number | null }).exitCode = 0;
    (child.stdout as PassThrough).end();
    (child.stderr as PassThrough).end();
    child.emit('close', 0, null);

    await waitForCondition(() => supervisor.currentServer?.status === 'LOST');
    expect(notificationCount).toBe(2);
    expect(supervisor.safetyFenceReason).toContain('simulated inbound materialization failure');
    expect(protocolError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('inbound dispatch failed') })
    );
    await expect(supervisor.start()).rejects.toThrow('safety-fenced until app restart');
  });

  it.runIf(process.platform !== 'win32')(
    'waits for descendants after leader exit before starting a replacement',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-acp-leader-exit-')
      );
      temporaryDirectories.push(directory);
      const agentScript = path.join(directory, 'agent.cjs');
      const descendantPidFile = path.join(directory, 'descendant.pid');
      const descendantReadyFile = path.join(directory, 'descendant.ready');
      const descendantSignalFile = path.join(directory, 'descendant.signal');
      const descendantScript = [
        "const fs = require('node:fs');",
        `const readyFile = ${JSON.stringify(descendantReadyFile)};`,
        `const signalFile = ${JSON.stringify(descendantSignalFile)};`,
        "const leaderPid = Number(process.env.TASK_MONKI_TEST_LEADER_PID);",
        'let stopping = false;',
        "process.on('SIGTERM', () => {",
        '  if (stopping) return;',
        '  stopping = true;',
        "  let leaderState = 'alive';",
        "  try { process.kill(leaderPid, 0); } catch (error) {",
        "    if (error.code !== 'ESRCH') throw error;",
        "    leaderState = 'exited';",
        '  }',
        "  fs.writeFileSync(signalFile, leaderState);",
        '  setTimeout(() => process.exit(0), 75);',
        '});',
        "fs.writeFileSync(readyFile, 'ready');",
        'setInterval(() => undefined, 30_000);'
      ].join('\n');
      await fs.writeFile(
        agentScript,
        [
          "const fs = require('node:fs');",
          "const readline = require('node:readline');",
          "const { spawn } = require('node:child_process');",
          `const descendantCode = ${JSON.stringify(descendantScript)};`,
          `const descendantPidFile = ${JSON.stringify(descendantPidFile)};`,
          `const descendantReadyFile = ${JSON.stringify(descendantReadyFile)};`,
          'const input = readline.createInterface({ input: process.stdin });',
          "input.on('line', (line) => {",
          '  const message = JSON.parse(line);',
          "  if (message.method !== 'initialize') return;",
          '  fs.rmSync(descendantReadyFile, { force: true });',
          '  const descendant = spawn(process.execPath, [\'-e\', descendantCode], {',
          "    stdio: 'ignore',",
          '    env: { ...process.env, TASK_MONKI_TEST_LEADER_PID: String(process.pid) }',
          '  });',
          '  fs.writeFileSync(descendantPidFile, String(descendant.pid));',
          '  const ready = setInterval(() => {',
          '    if (!fs.existsSync(descendantReadyFile)) return;',
          '    clearInterval(ready);',
          '    process.stdout.write(JSON.stringify({',
          "      jsonrpc: '2.0',",
          '      id: message.id,',
          '      result: {',
          '        protocolVersion: 1,',
          '        agentCapabilities: {},',
          "        agentInfo: { name: 'fake-acp', version: '1.0.0' }",
          '      }',
          "    }) + '\\n');",
          '    setTimeout(() => process.exit(0), 50);',
          '  }, 5);',
          '});'
        ].join('\n'),
        { mode: 0o600 }
      );

      let firstChild: ChildProcessWithoutNullStreams | undefined;
      let firstDescendantPid: number | undefined;
      let spawnCount = 0;
      let replacementOverlapped = false;
      const spawnProcess: NonNullable<AcpStdioSupervisorOptions['spawnProcess']> = (
        executable,
        argv,
        options
      ) => {
        spawnCount += 1;
        if (spawnCount === 2 && firstDescendantPid !== undefined) {
          replacementOverlapped = isProcessRunning(firstDescendantPid);
        }
        const child = spawnPortable(executable, argv, options) as ChildProcessWithoutNullStreams;
        if (spawnCount === 1) firstChild = child;
        return child;
      };
      const store = new FileTaskStore(path.join(directory, 'store'));
      const supervisor = new AcpStdioSupervisor(store, {
        profile: {
          ...testProfile('test-acp-leader-exit'),
          executableCandidates: [process.execPath],
          argv: [agentScript]
        },
        runtime: {
          ...testRuntime(),
          executable: process.execPath,
          diagnostics: {
            ...testRuntime().diagnostics,
            selectedExecutable: process.execPath,
            selectedLaunchArgv: [agentScript]
          }
        },
        cwd: directory,
        spawnProcess,
        requestTimeoutMs: 1_000,
        shutdownGraceTimeoutMs: 1_000,
        shutdownKillTimeoutMs: 1_000,
        closeHandlingTimeoutMs: 2_000
      });

      try {
        const first = await supervisor.start();
        firstDescendantPid = Number(await fs.readFile(descendantPidFile, 'utf8'));
        await waitForCondition(
          () => firstChild?.exitCode !== null && firstChild?.exitCode !== undefined,
          2_000
        );

        const replacement = await supervisor.start();

        expect(replacement.server.id).not.toBe(first.server.id);
        expect(spawnCount).toBe(2);
        expect(replacementOverlapped).toBe(false);
        expect(await fs.readFile(descendantSignalFile, 'utf8')).toBe('exited');
        expect(isProcessRunning(firstDescendantPid)).toBe(false);
      } finally {
        await supervisor.shutdown();
      }
    }
  );

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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
