import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentServerInstance } from '../../../shared/agent';
import {
  redactProcessDiagnostic,
  sanitizeEnvironment
} from '../../process/ProcessSupervisor';
import {
  spawnPortable,
  terminatePortableProcessTree
} from '../../process/portableChildProcess';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import {
  ACP_PROTOCOL_VERSION,
  ACP_SCHEMA_ARTIFACT_VERSION,
  parseInitializeResponse,
  type AcpInitializeResponse
} from './AcpProtocol';
import { AcpRpcClient } from './AcpRpcClient';
import type { AcpRuntimeProfile } from './AcpRuntimeProfiles';
import type { ResolvedAcpRuntime } from './AcpRuntimeResolver';
import { sanitizeAcpInitializeResponse } from './AcpNativeRedaction';

const MAX_DIAGNOSTIC_TAIL_BYTES = 64 * 1024;
const NON_SENSITIVE_RUNTIME_ENVIRONMENT_KEYS = new Set([
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION'
]);

interface AcpSupervisorEvents {
  ready: [server: AgentServerInstance, initialize: AcpInitializeResponse];
  exit: [server: AgentServerInstance, unexpected: boolean];
  protocolError: [error: Error];
}

export interface AcpStdioSupervisorOptions {
  profile: AcpRuntimeProfile;
  runtime: ResolvedAcpRuntime;
  cwd: string;
  appVersion?: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface RunningAcpAgent {
  server: AgentServerInstance;
  client: AcpRpcClient;
  initialize: AcpInitializeResponse;
}

export class AcpStdioSupervisor {
  readonly events = new EventEmitter<AcpSupervisorEvents>();

  private child?: ChildProcessWithoutNullStreams;
  private client?: AcpRpcClient;
  private server?: AgentServerInstance;
  private initializeResponse?: AcpInitializeResponse;
  private startPromise?: Promise<RunningAcpAgent>;
  private closeHandling?: Promise<void>;
  private shuttingDown = false;
  private rawDiagnosticTail = '';

  constructor(
    private readonly store: FileTaskStore,
    private readonly options: AcpStdioSupervisorOptions
  ) {}

  get currentClient(): AcpRpcClient | undefined {
    return this.client;
  }

  get currentServer(): AgentServerInstance | undefined {
    return this.server;
  }

  get negotiatedInitialize(): AcpInitializeResponse | undefined {
    return this.initializeResponse;
  }

  start(): Promise<RunningAcpAgent> {
    if (this.client && this.server && this.initializeResponse && this.child) {
      return Promise.resolve({
        client: this.client,
        server: this.server,
        initialize: this.initializeResponse
      });
    }
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  async markRunning(): Promise<void> {
    if (this.server && ['READY', 'DEGRADED'].includes(this.server.status)) {
      this.server = await this.store.updateAgentServer(this.server.id, {
        status: 'RUNNING',
        lastHealthAt: new Date().toISOString()
      });
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    this.client?.close('Task Monki is shutting down the ACP runtime.');
    if (!child) return;
    if (this.server && !['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
      this.server = await this.store.updateAgentServer(this.server.id, { status: 'STOPPING' });
    }
    if (child.exitCode === null && child.signalCode === null) {
      await terminatePortableProcessTree(child, 'SIGTERM');
      if (!(await waitForClose(child, 3_000))) {
        await terminatePortableProcessTree(child, 'SIGKILL');
        await waitForClose(child, 2_000);
      }
    }
    await this.closeHandling;
  }

  private async startInternal(): Promise<RunningAcpAgent> {
    this.shuttingDown = false;
    this.rawDiagnosticTail = '';
    const profile = this.options.profile;
    const argv = [...profile.argv];
    this.server = await this.store.createAgentServer({
      runtimeId: profile.descriptor.id,
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: this.options.runtime.executable,
      argv,
      runtimeVersion: this.options.runtime.version,
      schemaVersion: ACP_SCHEMA_ARTIFACT_VERSION,
      runtimeResolution: this.options.runtime.diagnostics
    });

    const environment = this.options.environment ?? process.env;
    const child = spawnPortable(this.options.runtime.executable, argv, {
      cwd: this.options.cwd,
      env: sanitizeEnvironment(environment, profile.allowedEnvironmentKeys),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => {
      this.rawDiagnosticTail = boundedTail(
        this.rawDiagnosticTail + chunk.toString('utf8'),
        MAX_DIAGNOSTIC_TAIL_BYTES
      );
    });
    child.once('close', (exitCode, signal) => {
      const handling = this.handleClose(child, exitCode, signal);
      this.closeHandling = handling;
      void handling.finally(() => {
        if (this.closeHandling === handling) this.closeHandling = undefined;
      });
    });

    try {
      await waitForSpawn(child);
      this.server = await this.store.updateAgentServer(this.server.id, { pid: child.pid });
      const client = new AcpRpcClient(
        child.stdin,
        child.stdout,
        (direction, raw, metadata) =>
          this.store.appendProtocolMessage(this.server!.id, direction, raw, metadata),
        this.server.id,
        this.options.requestTimeoutMs
      );
      this.client = client;
      client.events.on('protocolError', (error) => {
        this.events.emit('protocolError', error);
        void this.terminateProtocolViolation(error);
      });

      const initialized = await client.request<unknown>('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: {
          name: 'task-monki',
          title: 'Task Monki',
          version: this.options.appVersion ?? '0.1.0'
        }
      });
      const initialize = sanitizeAcpInitializeResponse(
        parseInitializeResponse(initialized.result)
      );
      if (initialize.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(
          `ACP protocol negotiation selected ${initialize.protocolVersion}; Task Monki supports stable protocol ${ACP_PROTOCOL_VERSION}.`
        );
      }
      this.initializeResponse = initialize;
      this.server = await this.store.updateAgentServer(this.server.id, {
        status: 'READY',
        runtimeVersion: initialize.agentInfo?.version ?? this.options.runtime.version,
        initializedAt: new Date().toISOString(),
        lastHealthAt: new Date().toISOString()
      });
      this.events.emit('ready', this.server, initialize);
      return { client, server: this.server, initialize };
    } catch (cause) {
      this.client?.close(`ACP startup failed: ${errorMessage(cause)}`);
      if (child.exitCode === null && child.signalCode === null) {
        await terminatePortableProcessTree(child, 'SIGTERM').catch(() => undefined);
      }
      if (this.server && !['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
        this.server = await this.store.updateAgentServer(this.server.id, {
          status: 'FAILED',
          exitedAt: new Date().toISOString(),
          exitReason: this.redactDiagnostic(
            startupFailure(cause, this.redactedDiagnosticTail())
          )
        });
      }
      throw cause;
    }
  }

  private async terminateProtocolViolation(error: Error): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.client?.close(`ACP protocol violation: ${error.message}`);
    await terminatePortableProcessTree(child, 'SIGTERM').catch(() => undefined);
  }

  private async handleClose(
    child: ChildProcessWithoutNullStreams,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    if (this.child !== child) return;
    const server = this.server;
    this.client?.close('ACP agent process exited.');
    this.client = undefined;
    this.child = undefined;
    this.initializeResponse = undefined;
    if (!server) return;
    const latest = await this.store.getAgentServer(server.id).catch(() => undefined);
    if (latest) this.server = latest;
    if (!this.server || ['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) return;
    const unexpected = !this.shuttingDown;
    const diagnosticTail = this.redactedDiagnosticTail();
    this.server = await this.store.updateAgentServer(this.server.id, {
      status: unexpected ? 'LOST' : 'EXITED',
      disconnectedAt: unexpected ? new Date().toISOString() : undefined,
      exitedAt: new Date().toISOString(),
      exitCode,
      signal,
      exitReason: unexpected
        ? `ACP agent exited unexpectedly.${diagnosticTail ? ` Diagnostics: ${diagnosticTail}` : ''}`
        : undefined
    });
    this.events.emit('exit', this.server, unexpected);
  }

  private redactDiagnostic(value: string): string {
    const environment = this.options.environment ?? process.env;
    return redactProcessDiagnostic(
      value,
      this.options.profile.allowedEnvironmentKeys.flatMap((key) =>
        !NON_SENSITIVE_RUNTIME_ENVIRONMENT_KEYS.has(key) && environment[key]
          ? [environment[key]!]
          : []
      )
    );
  }

  private redactedDiagnosticTail(): string {
    return boundedTail(
      this.redactDiagnostic(this.rawDiagnosticTail),
      MAX_DIAGNOSTIC_TAIL_BYTES
    );
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

function boundedTail(value: string, bytes: number): string {
  const buffer = Buffer.from(value);
  return buffer.byteLength <= bytes ? value : buffer.subarray(buffer.byteLength - bytes).toString('utf8');
}

function startupFailure(cause: unknown, diagnostics: string): string {
  return `${errorMessage(cause)}${diagnostics ? ` Diagnostics: ${diagnostics}` : ''}`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
