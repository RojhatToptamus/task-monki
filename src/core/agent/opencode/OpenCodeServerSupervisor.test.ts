import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProcessSupervisor,
  type ProcessSpec,
  type SupervisedProcess
} from '../../process/ProcessSupervisor';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { OpenCodeServerSupervisor } from './OpenCodeServerSupervisor';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('OpenCodeServerSupervisor', () => {
  it('redacts split and JSON-formatted credentials from bounded persisted stderr', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    const providerSecret = 'openai-provider-secret-value';
    const processSupervisor = new DiagnosticProcessSupervisor(providerSecret);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: {
        executable: '/fake/opencode',
        version: '1.17.20',
        source: 'config',
        diagnostics: {
          selectedExecutable: '/fake/opencode',
          selectedSource: 'config',
          selectedVersion: '1.17.20',
          selectedLaunchArgv: [
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            '<allocated-loopback-port>'
          ],
          requiredCapabilities: ['GET /global/health'],
          probes: []
        }
      },
      cwd: directory,
      environment: { PATH: process.env.PATH, OPENAI_API_KEY: providerSecret },
      requestTimeoutMs: 200,
      startupTimeoutMs: 1_000,
      processSupervisor,
      portAllocator: async () => 45200
    });

    try {
      await expect(supervisor.start()).rejects.toThrow();
      const server = (await store.snapshot()).agentServers[0];
      const exitReason = server?.exitReason ?? '';

      expect(server?.status).toBe('FAILED');
      expect(server?.argv).toEqual([
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '45200'
      ]);
      expect(server?.argv[4]).not.toBe('0');
      expect(processSupervisor.generatedPassword.length).toBeGreaterThan(0);
      expect(processSupervisor.launchArgv).not.toContain(processSupervisor.generatedPassword);
      expect(exitReason).toContain('[REDACTED]');
      expect(exitReason).not.toContain(providerSecret);
      expect(exitReason).not.toContain(processSupervisor.generatedPassword);
      expect(exitReason).not.toContain('json-shaped-value');
      expect(exitReason).not.toContain('bearer-shaped-value');
      expect(exitReason).not.toContain('OLD_DIAGNOSTIC_MARKER');
      const persistedTail = exitReason.split('OpenCode diagnostics: ')[1] ?? '';
      expect(Buffer.byteLength(persistedTail, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    } finally {
      await supervisor.shutdown();
      await store.close();
    }
  });

  it('keeps multibyte diagnostic heads and tails within their exact UTF-8 byte budgets', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: resolvedRuntime(),
      cwd: directory,
      environment: { PATH: process.env.PATH },
      startupTimeoutMs: 1_000,
      processSupervisor: new MultibyteFailureProcessSupervisor(),
      portAllocator: async () => 45206
    });

    try {
      await expect(supervisor.start()).rejects.toThrow();
      const exitReason = (await store.snapshot()).agentServers[0]?.exitReason ?? '';
      const separator = ' OpenCode diagnostics: ';
      const separatorAt = exitReason.indexOf(separator);
      expect(separatorAt).toBeGreaterThan(0);
      const head = exitReason.slice(0, separatorAt);
      const tail = exitReason.slice(separatorAt + separator.length);
      const availableTailBytes =
        64 * 1024 - Buffer.byteLength(head + separator, 'utf8');

      expect(Buffer.byteLength(head, 'utf8')).toBe(4 * 1024);
      expect(Buffer.byteLength(tail, 'utf8')).toBe(
        Math.floor(availableTailBytes / Buffer.byteLength('🧪', 'utf8')) *
          Buffer.byteLength('🧪', 'utf8')
      );
      expect(Buffer.byteLength(exitReason, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      expect(exitReason).not.toContain('\uFFFD');
    } finally {
      await supervisor.shutdown();
      await store.close();
    }
  });

  it('records an explicit launch port and verifies the OpenCode 1.17.20 SSE contract', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    let eventConnections = 0;
    const fetchMock: typeof fetch = async (input) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      const pathname = url.pathname;
      if (pathname === '/event') {
        eventConnections += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"server.connected","properties":{}}\n\n'
                )
              );
            }
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      const responseBody: Record<string, unknown> | unknown[] | undefined = {
        '/global/health': { healthy: true, version: '1.17.20' },
        '/provider': { all: [], connected: [], default: {} },
        '/permission': [],
        '/question': [],
        '/session/status': {}
      }[pathname];
      if (responseBody === undefined) {
        return new Response('', { status: 404 });
      }
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    vi.stubGlobal('fetch', fetchMock);
    const port = 45201;
    const processSupervisor = new ListeningProcessSupervisor();
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: resolvedRuntime(),
      cwd: directory,
      environment: { PATH: process.env.PATH },
      requestTimeoutMs: 500,
      startupTimeoutMs: 1_000,
      eventProbeTimeoutMs: 500,
      processSupervisor,
      portAllocator: async () => port
    });

    try {
      const running = await supervisor.start();

      expect(running.server.status).toBe('READY');
      expect(running.server.argv).toEqual([
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port)
      ]);
      expect(processSupervisor.launchArgv).toEqual(running.server.argv);
      expect(processSupervisor.launchArgv).not.toContain(
        processSupervisor.generatedPassword
      );
      expect(eventConnections).toBe(1);
    } finally {
      await supervisor.shutdown();
      await store.close();
    }
  });

  it('bounds early-exit retries and redacts every persisted attempt', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    const processSupervisor = new EarlyExitProcessSupervisor();
    const ports = [45101, 45102, 45103];
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: resolvedRuntime(),
      cwd: directory,
      environment: { PATH: process.env.PATH },
      startupTimeoutMs: 1_000,
      processSupervisor,
      portAllocator: async () => {
        const port = ports.shift();
        if (!port) throw new Error('Unexpected additional port allocation.');
        return port;
      }
    });

    try {
      let failure: Error | undefined;
      try {
        await supervisor.start();
      } catch (cause) {
        failure = cause as Error;
      }
      const servers = (await store.snapshot()).agentServers;

      expect(failure?.message).toContain('[REDACTED]');
      expect(failure?.message).not.toContain(processSupervisor.generatedPassword);
      expect(processSupervisor.launchSpecs).toHaveLength(3);
      expect(servers).toHaveLength(3);
      expect(servers.every((server) => server.status === 'FAILED')).toBe(true);
      expect(servers.map((server) => server.argv[4]).sort()).toEqual([
        '45101',
        '45102',
        '45103'
      ]);
      for (const spec of processSupervisor.launchSpecs) {
        expect(spec.argv).not.toContain(processSupervisor.generatedPassword);
      }
      for (const server of servers) {
        expect(server.exitReason).toContain('[REDACTED]');
        expect(server.exitReason).not.toContain(processSupervisor.generatedPassword);
        expect(Buffer.byteLength(server.exitReason ?? '', 'utf8')).toBeLessThanOrEqual(
          64 * 1024
        );
      }
    } finally {
      await supervisor.shutdown();
      await store.close();
    }
  });

  it('cancels an in-flight startup and never publishes a ready process after shutdown', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    const processSupervisor = new GatedStartupProcessSupervisor();
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: resolvedRuntime(),
      cwd: directory,
      environment: { PATH: process.env.PATH },
      startupTimeoutMs: 2_000,
      processSupervisor,
      portAllocator: async () => 45202
    });

    const starting = supervisor.start();
    await processSupervisor.waitUntilStarted();
    const stopping = supervisor.shutdown();

    await expect(starting).rejects.toThrow('canceled');
    await stopping;
    expect(processSupervisor.cancelCount).toBe(1);
    expect(supervisor.currentClient).toBeUndefined();
    expect((await store.snapshot()).agentServers).toEqual([
      expect.objectContaining({ status: 'EXITED' })
    ]);
    await expect(supervisor.start()).rejects.toThrow('shut down');
    await store.close();
  });

  it('retains startup process ownership when cancellation fails and prevents replacement', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    const processSupervisor = new FailOnceCancelStartupProcessSupervisor();
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: resolvedRuntime(),
      cwd: directory,
      environment: { PATH: process.env.PATH },
      startupTimeoutMs: 30,
      processSupervisor,
      portAllocator: async () => 45205
    });

    const starting = supervisor.start();
    await processSupervisor.waitUntilStarted();
    await expect(starting).rejects.toThrow('cleanup was incomplete');
    expect(processSupervisor.startCount).toBe(1);
    expect(processSupervisor.cancelCount).toBe(1);
    expect((await store.snapshot()).agentServers).toEqual([
      expect.objectContaining({ status: 'LOST' })
    ]);

    await expect(supervisor.start()).rejects.toThrow(
      'termination of the previous process is unconfirmed'
    );
    expect(processSupervisor.startCount).toBe(1);

    await supervisor.shutdown();
    expect(processSupervisor.cancelCount).toBe(2);
    await expect(supervisor.start()).rejects.toThrow('shut down');
    await store.close();
  });

  it('terminalizes a server created concurrently with shutdown before any child is spawned', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    const processSupervisor = new GatedStartupProcessSupervisor();
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
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: resolvedRuntime(),
      cwd: directory,
      environment: { PATH: process.env.PATH },
      startupTimeoutMs: 2_000,
      processSupervisor,
      portAllocator: async () => 45204
    });

    const starting = supervisor.start();
    await created;
    const stopping = supervisor.shutdown();
    releaseCreate();

    await expect(starting).rejects.toThrow('canceled');
    await stopping;
    expect(processSupervisor.cancelCount).toBe(0);
    expect((await store.snapshot()).agentServers).toEqual([
      expect.objectContaining({ status: 'EXITED' })
    ]);
    store.createAgentServer = originalCreate;
    await store.close();
  });

  it('still terminates the child when persisting STOPPING fails', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    const fetchMock: typeof fetch = async (input) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      if (url.pathname === '/event') {
        return new Response('data: {"type":"server.connected","properties":{}}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }
      const responseBody: Record<string, unknown> | unknown[] = {
        '/global/health': { healthy: true, version: '1.17.20' },
        '/provider': { all: [], connected: [], default: {} },
        '/permission': [],
        '/question': [],
        '/session/status': {}
      }[url.pathname] ?? [];
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    vi.stubGlobal('fetch', fetchMock);
    const processSupervisor = new ListeningProcessSupervisor();
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: resolvedRuntime(),
      cwd: directory,
      environment: { PATH: process.env.PATH },
      startupTimeoutMs: 1_000,
      eventProbeTimeoutMs: 500,
      processSupervisor,
      portAllocator: async () => 45203
    });
    await supervisor.start();
    const originalUpdate = store.updateAgentServer.bind(store);
    let failedStoppingWrite = false;
    store.updateAgentServer = async (serverId, update) => {
      if (update.status === 'STOPPING' && !failedStoppingWrite) {
        failedStoppingWrite = true;
        throw new Error('simulated STOPPING persistence failure');
      }
      return originalUpdate(serverId, update);
    };

    await expect(supervisor.shutdown()).rejects.toThrow('shutdown was incomplete');
    expect(processSupervisor.cancelCount).toBe(1);
    expect((await store.snapshot()).agentServers[0]).toEqual(
      expect.objectContaining({ status: 'EXITED' })
    );
    store.updateAgentServer = originalUpdate;
    await store.close();
  });
});

class DiagnosticProcessSupervisor extends ProcessSupervisor {
  generatedPassword = '';
  launchArgv: string[] = [];

  constructor(private readonly providerSecret: string) {
    super();
  }

  override start(spec: ProcessSpec): SupervisedProcess {
    const events = new EventEmitter() as SupervisedProcess['events'];
    this.generatedPassword = spec.env?.OPENCODE_SERVER_PASSWORD ?? '';
    this.launchArgv = [...spec.argv];
    const port = launchPort(spec);
    let closed = false;

    queueMicrotask(() => {
      const passwordSplit = Math.floor(this.generatedPassword.length / 2);
      const providerSplit = Math.floor(this.providerSecret.length / 2);
      events.emit(
        'stderr',
        Buffer.from(`OLD_DIAGNOSTIC_MARKER${'x'.repeat(70 * 1024)}`)
      );
      events.emit(
        'stderr',
        Buffer.from(`generated=${this.generatedPassword.slice(0, passwordSplit)}`)
      );
      events.emit(
        'stderr',
        Buffer.from(
          `${this.generatedPassword.slice(passwordSplit)} {"OPENAI_API_KEY":"${this.providerSecret.slice(0, providerSplit)}`
        )
      );
      events.emit(
        'stderr',
        Buffer.from(
          `${this.providerSecret.slice(providerSplit)}","CUSTOM_API_KEY":"json-shaped-value"} Bearer bearer-shaped-value`
        )
      );
      events.emit(
        'stdout',
        Buffer.from(`opencode server listening on http://127.0.0.1:${port}\n`)
      );
    });

    return {
      pid: 4242,
      events,
      cancel: async () => {
        if (closed) return;
        closed = true;
        events.emit('close', { exitCode: null, signal: 'SIGTERM' });
      }
    };
  }
}

class MultibyteFailureProcessSupervisor extends ProcessSupervisor {
  override start(_spec: ProcessSpec): SupervisedProcess {
    const events = new EventEmitter() as SupervisedProcess['events'];
    let closed = false;
    queueMicrotask(() => {
      events.emit('started', { pid: 4243 });
      events.emit('error', new Error('🧪'.repeat(20_000)));
    });
    return {
      pid: 4243,
      events,
      cancel: async () => {
        if (closed) return;
        closed = true;
        events.emit('close', { exitCode: null, signal: 'SIGTERM' });
      }
    };
  }
}

class ListeningProcessSupervisor extends ProcessSupervisor {
  generatedPassword = '';
  launchArgv: string[] = [];
  cancelCount = 0;

  override start(spec: ProcessSpec): SupervisedProcess {
    const events = new EventEmitter() as SupervisedProcess['events'];
    this.generatedPassword = spec.env?.OPENCODE_SERVER_PASSWORD ?? '';
    this.launchArgv = [...spec.argv];
    const port = launchPort(spec);
    let closed = false;
    queueMicrotask(() => {
      events.emit('started', { pid: 4343 });
      events.emit(
        'stdout',
        Buffer.from(`opencode server listening on http://127.0.0.1:${port}\n`)
      );
    });
    return {
      pid: 4343,
      events,
      cancel: async () => {
        if (closed) return;
        this.cancelCount += 1;
        closed = true;
        events.emit('close', { exitCode: null, signal: 'SIGTERM' });
      }
    };
  }
}

class GatedStartupProcessSupervisor extends ProcessSupervisor {
  cancelCount = 0;
  private startedResolve!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  waitUntilStarted(): Promise<void> {
    return this.started;
  }

  override start(_spec: ProcessSpec): SupervisedProcess {
    const events = new EventEmitter() as SupervisedProcess['events'];
    let closed = false;
    queueMicrotask(() => {
      events.emit('started', { pid: 4545 });
      this.startedResolve();
    });
    return {
      pid: 4545,
      events,
      cancel: async () => {
        if (closed) return;
        this.cancelCount += 1;
        closed = true;
        events.emit('close', { exitCode: null, signal: 'SIGTERM' });
      }
    };
  }
}

class FailOnceCancelStartupProcessSupervisor extends ProcessSupervisor {
  startCount = 0;
  cancelCount = 0;
  private startedResolve!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  waitUntilStarted(): Promise<void> {
    return this.started;
  }

  override start(_spec: ProcessSpec): SupervisedProcess {
    this.startCount += 1;
    const events = new EventEmitter() as SupervisedProcess['events'];
    let closed = false;
    queueMicrotask(() => {
      events.emit('started', { pid: 4646 });
      this.startedResolve();
    });
    return {
      pid: 4646,
      events,
      cancel: async () => {
        this.cancelCount += 1;
        if (this.cancelCount === 1) {
          throw new Error('simulated process termination failure');
        }
        if (closed) return;
        closed = true;
        events.emit('close', { exitCode: null, signal: 'SIGKILL' });
      }
    };
  }
}

class EarlyExitProcessSupervisor extends ProcessSupervisor {
  generatedPassword = '';
  launchSpecs: ProcessSpec[] = [];

  override start(spec: ProcessSpec): SupervisedProcess {
    const events = new EventEmitter() as SupervisedProcess['events'];
    this.generatedPassword = spec.env?.OPENCODE_SERVER_PASSWORD ?? '';
    this.launchSpecs.push({ ...spec, argv: [...spec.argv] });
    let closed = false;
    queueMicrotask(() => {
      events.emit('started', { pid: 4444 + this.launchSpecs.length });
      events.emit(
        'stderr',
        Buffer.from(`password=${this.generatedPassword} EADDRINUSE: address already in use\n`)
      );
      closed = true;
      events.emit('close', { exitCode: 1, signal: null });
    });
    return {
      pid: 4444 + this.launchSpecs.length,
      events,
      cancel: async () => {
        if (closed) return;
        closed = true;
        events.emit('close', { exitCode: null, signal: 'SIGTERM' });
      }
    };
  }
}

function resolvedRuntime() {
  return {
    executable: '/fake/opencode',
    version: '1.17.20',
    source: 'config' as const,
    diagnostics: {
      selectedExecutable: '/fake/opencode',
      selectedSource: 'config',
      selectedVersion: '1.17.20',
      selectedLaunchArgv: [
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '<allocated-loopback-port>'
      ],
      requiredCapabilities: ['GET /global/health', 'GET /event (SSE)'],
      probes: []
    }
  };
}

function launchPort(spec: ProcessSpec): number {
  const portIndex = spec.argv.indexOf('--port');
  const port = Number(spec.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid explicit OpenCode launch port: ${spec.argv[portIndex + 1]}`);
  }
  return port;
}
