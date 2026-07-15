import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { AgentServerInstance } from '../../../shared/agent';
import {
  ProcessSupervisor,
  redactProcessDiagnostic,
  type SupervisedProcess
} from '../../process/ProcessSupervisor';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import { OpenCodeHttpClient, type OpenCodeClientTransport } from './OpenCodeHttpClient';
import {
  normalizeOpenCodeEvent,
  parseOpenCodeHealth,
  parseOpenCodePermissions,
  parseOpenCodeProviderCatalog,
  parseOpenCodeQuestions
} from './OpenCodeProtocol';
import type { ResolvedOpenCodeRuntime } from './OpenCodeRuntimeResolver';
import { isCompatibleOpenCodeVersion, OPENCODE_RUNTIME_ID } from './OpenCodeRuntimeResolver';
import {
  openCodeEnvironmentKeys,
  openCodeSensitiveEnvironmentValues
} from './OpenCodeEnvironmentPolicy';

const OPENCODE_SERVER_USERNAME = 'task-monki';
const STARTUP_URL_PATTERN = /opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))/iu;
const MAX_DIAGNOSTIC_TAIL_BYTES = 64 * 1024;
const MAX_START_ATTEMPTS = 3;
const DEFAULT_EVENT_PROBE_TIMEOUT_MS = 5_000;

export interface OpenCodeSupervisorEvents {
  exit: [server: AgentServerInstance, unexpected: boolean];
}

export interface OpenCodeServerSupervisorOptions {
  runtime: ResolvedOpenCodeRuntime;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  eventProbeTimeoutMs?: number;
  minimumVersion?: string;
  maximumMajor?: number;
  processSupervisor?: ProcessSupervisor;
  portAllocator?: () => Promise<number>;
}

export interface RunningOpenCodeServer {
  server: AgentServerInstance;
  client: OpenCodeClientTransport;
}

export interface OpenCodeSessionSupervisor {
  readonly events: EventEmitter<OpenCodeSupervisorEvents>;
  readonly currentServer: AgentServerInstance | undefined;
  readonly currentClient: OpenCodeClientTransport | undefined;
  start(): Promise<RunningOpenCodeServer>;
  shutdown(): Promise<void>;
  markRunning(): Promise<void>;
  markDegraded(reason: string): Promise<void>;
}

export class OpenCodeServerSupervisor implements OpenCodeSessionSupervisor {
  readonly events = new EventEmitter<OpenCodeSupervisorEvents>();

  private process?: SupervisedProcess;
  private readyProcess?: SupervisedProcess;
  private server?: AgentServerInstance;
  private client?: OpenCodeHttpClient;
  private startPromise?: Promise<RunningOpenCodeServer>;
  private shuttingDown = false;
  private closePromise?: Promise<void>;
  private rawDiagnosticTail = '';
  private sensitiveValues: string[] = [];
  private readonly closedProcesses = new WeakSet<SupervisedProcess>();
  private readonly startingProcesses = new WeakSet<SupervisedProcess>();

  constructor(
    private readonly store: FileTaskStore,
    private readonly options: OpenCodeServerSupervisorOptions
  ) {}

  get currentServer(): AgentServerInstance | undefined {
    return this.server;
  }

  get currentClient(): OpenCodeHttpClient | undefined {
    return this.client;
  }

  start(): Promise<RunningOpenCodeServer> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('OpenCode supervisor has been shut down.'));
    }
    if (this.client && this.server && this.process) {
      return Promise.resolve({ client: this.client, server: this.server });
    }
    if (this.process) {
      return Promise.reject(
        new Error(
          'OpenCode cannot start a replacement process because termination of the previous process is unconfirmed.'
        )
      );
    }
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const failures: unknown[] = [];
    if (this.server && ['READY', 'RUNNING', 'DEGRADED'].includes(this.server.status)) {
      try {
        this.server = await this.store.updateAgentServer(this.server.id, { status: 'STOPPING' });
      } catch (cause) {
        failures.push(cause);
      }
    }
    const starting = this.startPromise;
    const childAtShutdown = this.process;
    if (childAtShutdown) {
      try {
        await childAtShutdown.cancel();
        if (!this.closedProcesses.has(childAtShutdown)) {
          failures.push(
            new Error('OpenCode process cancellation returned before a terminal close event.')
          );
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    await starting?.catch(() => undefined);
    const lateChild = this.process;
    if (lateChild && lateChild !== childAtShutdown) {
      try {
        await lateChild.cancel();
        if (!this.closedProcesses.has(lateChild)) {
          failures.push(
            new Error('OpenCode process cancellation returned before a terminal close event.')
          );
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      await this.closePromise;
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'OpenCode runtime shutdown was incomplete.');
    }
  }

  async markRunning(): Promise<void> {
    if (this.server && ['READY', 'DEGRADED'].includes(this.server.status)) {
      this.server = await this.store.updateAgentServer(this.server.id, {
        status: 'RUNNING',
        lastHealthAt: new Date().toISOString(),
        disconnectedAt: undefined,
        exitReason: undefined
      });
    }
  }

  async markDegraded(reason: string): Promise<void> {
    if (this.server && ['READY', 'RUNNING'].includes(this.server.status)) {
      this.server = await this.store.updateAgentServer(this.server.id, {
        status: 'DEGRADED',
        disconnectedAt: new Date().toISOString(),
        exitReason: reason
      });
    }
  }

  private async startInternal(): Promise<RunningOpenCodeServer> {
    this.assertStartupActive();
    const password = randomBytes(32).toString('base64url');
    const runtimeEnvironment = this.options.environment ?? process.env;
    this.sensitiveValues = [
      password,
      ...openCodeSensitiveEnvironmentValues(runtimeEnvironment)
    ];
    const processSupervisor = this.options.processSupervisor ?? new ProcessSupervisor();
    const deadlineAt = Date.now() + (this.options.startupTimeoutMs ?? 15_000);
    let lastFailure: Error | undefined;

    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      if (this.shuttingDown) throw new Error('OpenCode startup was canceled.');
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      const port = await (this.options.portAllocator ?? allocateEphemeralLoopbackPort)();
      this.assertStartupActive();
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`OpenCode loopback port allocator returned an invalid port: ${port}.`);
      }
      try {
        return await this.startAttempt(
          processSupervisor,
          password,
          port,
          remainingMs,
          runtimeEnvironment
        );
      } catch (cause) {
        const failure = toError(cause);
        lastFailure = failure;
        if (
          !(failure instanceof RetryableOpenCodeStartupError) ||
          this.shuttingDown ||
          attempt === MAX_START_ATTEMPTS ||
          Date.now() >= deadlineAt
        ) {
          throw failure;
        }
      }
    }

    throw lastFailure ?? new Error('Timed out starting the OpenCode loopback server.');
  }

  private async startAttempt(
    processSupervisor: ProcessSupervisor,
    password: string,
    port: number,
    startupTimeoutMs: number,
    runtimeEnvironment: NodeJS.ProcessEnv
  ): Promise<RunningOpenCodeServer> {
    this.rawDiagnosticTail = '';
    const argv = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
    const server = await this.store.createAgentServer({
      runtimeId: OPENCODE_RUNTIME_ID,
      runtimeKind: 'HTTP_AGENT',
      transport: 'HTTP_SSE',
      executable: this.options.runtime.executable,
      argv,
      runtimeVersion: this.options.runtime.version,
      schemaVersion: 'native-http-v1',
      runtimeResolution: this.options.runtime.diagnostics
    });
    this.server = server;
    if (this.shuttingDown) {
      this.server = await this.store.updateAgentServer(server.id, {
        status: 'EXITED',
        exitedAt: new Date().toISOString(),
        exitReason: 'OpenCode startup was canceled.'
      });
      throw new Error('OpenCode startup was canceled.');
    }

    const child = processSupervisor.start({
      executable: this.options.runtime.executable,
      argv,
      cwd: this.options.cwd,
      env: {
        ...runtimeEnvironment,
        OPENCODE_SERVER_USERNAME,
        OPENCODE_SERVER_PASSWORD: password
      },
      allowedEnvironmentKeys: [
        'OPENCODE_SERVER_USERNAME',
        'OPENCODE_SERVER_PASSWORD',
        ...openCodeEnvironmentKeys(runtimeEnvironment)
      ]
    });
    this.process = child;
    this.startingProcesses.add(child);
    child.events.once('started', ({ pid }) => {
      void this.updateServerById(server.id, { pid }).catch(() => undefined);
    });
    child.events.on('stdout', (chunk) => this.appendDiagnostic(chunk));
    child.events.on('stderr', (chunk) => this.appendDiagnostic(chunk));
    child.events.once('error', (error) => this.appendDiagnostic(Buffer.from(error.message)));
    child.events.once('close', ({ exitCode, signal }) => {
      this.closedProcesses.add(child);
      if (this.startingProcesses.has(child)) return;
      const closing = this.handleClose(child, server.id, exitCode, signal);
      this.closePromise = closing;
      void closing.catch(() => undefined);
    });

    try {
      this.assertStartupActive();
      const baseUrl = await this.waitForStartupUrl(child, port, startupTimeoutMs);
      this.assertStartupActive();
      const client = new OpenCodeHttpClient({
        baseUrl,
        username: OPENCODE_SERVER_USERNAME,
        password,
        directory: this.options.cwd,
        requestTimeoutMs: this.options.requestTimeoutMs,
        sensitiveValues: this.sensitiveValues,
        journal: (direction, raw, metadata) =>
          this.store.appendProtocolMessage(server.id, direction, raw, metadata)
      });
      await this.probeProtocol(client);
      this.assertStartupActive();
      const readyServer = await this.store.updateAgentServer(server.id, {
        status: 'READY',
        runtimeVersion: this.options.runtime.version,
        initializedAt: new Date().toISOString(),
        lastHealthAt: new Date().toISOString()
      });
      this.assertStartupActive();
      if (this.closedProcesses.has(child)) {
        throw new RetryableOpenCodeStartupError(
          'OpenCode exited while its loopback protocol was being verified.'
        );
      }
      this.server = readyServer;
      this.client = client;
      this.readyProcess = child;
      if (this.closedProcesses.has(child)) {
        this.client = undefined;
        this.readyProcess = undefined;
        throw new RetryableOpenCodeStartupError(
          'OpenCode exited while its loopback protocol was being verified.'
        );
      }
      this.startingProcesses.delete(child);
      return { client, server: readyServer };
    } catch (cause) {
      const failure = this.shuttingDown
        ? new Error('OpenCode startup was canceled.')
        : this.startupFailure(cause);
      let cancellationFailure: unknown;
      try {
        await child.cancel();
      } catch (cancelCause) {
        cancellationFailure = cancelCause;
      }
      this.startingProcesses.delete(child);
      const terminationUnconfirmed =
        cancellationFailure !== undefined && !this.closedProcesses.has(child);
      if (this.process === child && !terminationUnconfirmed) this.process = undefined;
      if (this.readyProcess === child) this.readyProcess = undefined;
      if (this.client && this.server?.id === server.id) this.client = undefined;
      let persistenceFailure: unknown;
      try {
        const stored = await this.store.getAgentServer(server.id);
        if (stored && !['EXITED', 'FAILED', 'LOST'].includes(stored.status)) {
          const failed = await this.store.updateAgentServer(server.id, {
            status: terminationUnconfirmed
              ? 'LOST'
              : this.shuttingDown
                ? 'EXITED'
                : 'FAILED',
            disconnectedAt: terminationUnconfirmed ? new Date().toISOString() : undefined,
            exitedAt: terminationUnconfirmed ? undefined : new Date().toISOString(),
            exitReason: terminationUnconfirmed
              ? `OpenCode startup failed and process termination is unconfirmed. ${failure.message}`
              : this.shuttingDown
                ? 'OpenCode startup was canceled.'
                : failure.message
          });
          if (this.server?.id === server.id) this.server = failed;
        }
      } catch (storeCause) {
        persistenceFailure = storeCause;
      }
      if (cancellationFailure || persistenceFailure) {
        throw new AggregateError(
          [failure, cancellationFailure, persistenceFailure].filter(Boolean),
          'OpenCode startup failed and cleanup was incomplete.'
        );
      }
      throw failure;
    }
  }

  private assertStartupActive(): void {
    if (this.shuttingDown) throw new Error('OpenCode startup was canceled.');
  }

  private async probeProtocol(client: OpenCodeHttpClient): Promise<void> {
    const health = parseOpenCodeHealth((await client.get<unknown>('/global/health')).data);
    if (
      health.version !== this.options.runtime.version ||
      !isCompatibleOpenCodeVersion(
        health.version,
        this.options.minimumVersion,
        this.options.maximumMajor
      )
    ) {
      throw new Error(
        `OpenCode server version ${health.version} does not match the compatible executable ${this.options.runtime.version}.`
      );
    }
    parseOpenCodeProviderCatalog((await client.get<unknown>('/provider')).data);
    parseOpenCodePermissions((await client.get<unknown>('/permission')).data);
    parseOpenCodeQuestions((await client.get<unknown>('/question')).data);
    const status = (await client.get<unknown>('/session/status')).data;
    if (!status || typeof status !== 'object' || Array.isArray(status)) {
      throw new Error('OpenCode session status endpoint is incompatible.');
    }
    await this.probeEventStream(client);
  }

  private probeEventStream(client: OpenCodeHttpClient): Promise<void> {
    const timeoutMs = this.options.eventProbeTimeoutMs ?? DEFAULT_EVENT_PROBE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stream: ReturnType<OpenCodeHttpClient['startEventStream']> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream?.stop();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error('Timed out waiting for the first OpenCode SSE event.'));
      }, timeoutMs);
      timer.unref();
      stream = client.startEventStream({
        onEvent: async (value) => {
          normalizeOpenCodeEvent(value);
          finish();
        },
        onDisconnect: async (error) => finish(error),
        onReconnect: async () => undefined
      });
    });
  }

  private waitForStartupUrl(
    child: SupervisedProcess,
    expectedPort: number,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new RetryableOpenCodeStartupError(
            'Timed out waiting for the OpenCode loopback server.'
          )
        );
      }, timeoutMs);
      timer.unref();
      const onOutput = (chunk: Buffer) => {
        output = boundedTail(output + chunk.toString('utf8'), MAX_DIAGNOSTIC_TAIL_BYTES);
        const match = output.match(STARTUP_URL_PATTERN);
        if (match) {
          cleanup();
          if (Number(match[2]) !== expectedPort) {
            reject(
              new Error(
                `OpenCode published loopback port ${match[2]} instead of the allocated port ${expectedPort}.`
              )
            );
            return;
          }
          resolve(match[1]);
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = ({
        exitCode,
        signal
      }: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }) => {
        cleanup();
        reject(
          new RetryableOpenCodeStartupError(
            `OpenCode exited before publishing its loopback address (${terminalDescription(exitCode, signal)}).`
          )
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.events.off('stdout', onOutput);
        child.events.off('stderr', onOutput);
        child.events.off('error', onError);
        child.events.off('close', onClose);
      };
      child.events.on('stdout', onOutput);
      child.events.on('stderr', onOutput);
      child.events.once('error', onError);
      child.events.once('close', onClose);
    });
  }

  private async handleClose(
    child: SupervisedProcess,
    serverId: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const wasReadyProcess = this.readyProcess === child;
    if (this.process === child) this.process = undefined;
    if (!wasReadyProcess) return;
    this.readyProcess = undefined;
    this.client = undefined;
    const stored = await this.store.getAgentServer(serverId);
    if (!stored || ['EXITED', 'FAILED', 'LOST'].includes(stored.status)) return;
    const unexpected = !this.shuttingDown;
    const diagnosticTail = this.redactedDiagnosticTail();
    const updated = await this.store.updateAgentServer(serverId, {
      status: unexpected ? 'LOST' : 'EXITED',
      disconnectedAt: unexpected ? new Date().toISOString() : undefined,
      exitedAt: new Date().toISOString(),
      exitCode,
      signal,
      exitReason: unexpected
        ? boundedDiagnostic('OpenCode exited unexpectedly.', diagnosticTail)
        : 'OpenCode runtime shut down.'
    });
    if (this.server?.id === serverId) this.server = updated;
    this.events.emit('exit', updated, unexpected);
  }

  private appendDiagnostic(chunk: Buffer): void {
    // The generated password is never written to argv or Task Monki logs.
    // Keep a bounded raw process-output tail in memory so credentials split across
    // chunks can be recognized before the tail enters durable state.
    this.rawDiagnosticTail = boundedTail(
      `${this.rawDiagnosticTail}${chunk.toString('utf8')}`.replace(/[\r\n\t]+/gu, ' '),
      MAX_DIAGNOSTIC_TAIL_BYTES
    );
  }

  private redactedDiagnosticTail(): string {
    return boundedTail(
      redactProcessDiagnostic(this.rawDiagnosticTail, this.sensitiveValues),
      MAX_DIAGNOSTIC_TAIL_BYTES
    );
  }

  private startupFailure(cause: unknown): Error {
    const message = boundedDiagnostic(
      redactProcessDiagnostic(errorMessage(cause), this.sensitiveValues),
      this.redactedDiagnosticTail()
    );
    return cause instanceof RetryableOpenCodeStartupError
      ? new RetryableOpenCodeStartupError(message)
      : new Error(message);
  }

  private async updateServerById(
    serverId: string,
    update: Parameters<FileTaskStore['updateAgentServer']>[1]
  ): Promise<void> {
    const updated = await this.store.updateAgentServer(serverId, update);
    if (this.server?.id === serverId) this.server = updated;
  }
}

function boundedTail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  if (maxBytes <= 0) return '';
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && isUtf8ContinuationByte(buffer[start]!)) {
    start += 1;
  }
  return buffer.subarray(start).toString('utf8');
}

function boundedDiagnostic(message: string, diagnosticTail: string): string {
  const separator = diagnosticTail ? ' OpenCode diagnostics: ' : '';
  const prefix = boundedHead(message, 4 * 1024);
  const availableTailBytes = Math.max(
    0,
    MAX_DIAGNOSTIC_TAIL_BYTES - Buffer.byteLength(prefix + separator, 'utf8')
  );
  return `${prefix}${separator}${boundedTail(diagnosticTail, availableTailBytes)}`;
}

function boundedHead(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  if (maxBytes <= 0) return '';
  let end = maxBytes;
  while (end > 0 && isUtf8ContinuationByte(buffer[end]!)) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

async function allocateEphemeralLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.unref();
    const onError = (error: Error) => {
      reject(error);
    };
    reservation.once('error', onError);
    reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      reservation.off('error', onError);
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close(() => reject(new Error('Could not allocate an OpenCode loopback port.')));
        return;
      }
      const port = address.port;
      reservation.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function terminalDescription(
  exitCode: number | null,
  signal: NodeJS.Signals | null
): string {
  if (exitCode !== null) return `exit code ${exitCode}`;
  if (signal) return `signal ${signal}`;
  return 'unknown process status';
}

class RetryableOpenCodeStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableOpenCodeStartupError';
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
