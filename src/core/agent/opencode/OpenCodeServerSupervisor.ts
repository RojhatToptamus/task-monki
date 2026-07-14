import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentServerInstance } from '../../../shared/agent';
import {
  ProcessSupervisor,
  redactProcessDiagnostic,
  type SupervisedProcess
} from '../../process/ProcessSupervisor';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import { OpenCodeHttpClient, type OpenCodeClientTransport } from './OpenCodeHttpClient';
import {
  parseOpenCodeHealth,
  parseOpenCodePermissions,
  parseOpenCodeProviderCatalog,
  parseOpenCodeQuestions
} from './OpenCodeProtocol';
import type { ResolvedOpenCodeRuntime } from './OpenCodeRuntimeResolver';
import { isCompatibleOpenCodeVersion, OPENCODE_RUNTIME_ID } from './OpenCodeRuntimeResolver';

const OPENCODE_SERVER_USERNAME = 'task-monki';
const STARTUP_URL_PATTERN = /opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))/iu;
const MAX_DIAGNOSTIC_TAIL_BYTES = 64 * 1024;

export interface OpenCodeSupervisorEvents {
  exit: [server: AgentServerInstance, unexpected: boolean];
}

export interface OpenCodeServerSupervisorOptions {
  runtime: ResolvedOpenCodeRuntime;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  minimumVersion?: string;
  maximumMajor?: number;
  processSupervisor?: ProcessSupervisor;
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
  private server?: AgentServerInstance;
  private client?: OpenCodeHttpClient;
  private startPromise?: Promise<RunningOpenCodeServer>;
  private shuttingDown = false;
  private rawDiagnosticTail = '';
  private sensitiveValues: string[] = [];

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
    if (this.client && this.server && this.process) {
      return Promise.resolve({ client: this.client, server: this.server });
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
    if (this.server && !['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
      this.server = await this.store.updateAgentServer(this.server.id, { status: 'STOPPING' });
    }
    const child = this.process;
    if (child) await child.cancel();
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
    this.shuttingDown = false;
    this.rawDiagnosticTail = '';
    const argv = ['serve', '--hostname', '127.0.0.1', '--port', '0'];
    this.server = await this.store.createAgentServer({
      runtimeId: OPENCODE_RUNTIME_ID,
      runtimeKind: 'HTTP_AGENT',
      transport: 'HTTP_SSE',
      executable: this.options.runtime.executable,
      argv,
      runtimeVersion: this.options.runtime.version,
      schemaVersion: 'native-http-v1',
      runtimeResolution: this.options.runtime.diagnostics
    });

    const password = randomBytes(32).toString('base64url');
    this.sensitiveValues = [
      password,
      ...providerCredentialEnvironmentKeys(this.options.environment ?? process.env)
        .map((key) => (this.options.environment ?? process.env)[key])
        .filter((value): value is string => Boolean(value))
    ];
    const processSupervisor = this.options.processSupervisor ?? new ProcessSupervisor();
    const child = processSupervisor.start({
      executable: this.options.runtime.executable,
      argv,
      cwd: this.options.cwd,
      env: {
        ...(this.options.environment ?? process.env),
        OPENCODE_SERVER_USERNAME,
        OPENCODE_SERVER_PASSWORD: password
      },
      allowedEnvironmentKeys: [
        'OPENCODE_SERVER_USERNAME',
        'OPENCODE_SERVER_PASSWORD',
        // Provider credentials are intentionally inherited by OpenCode only
        // when the host included them in the supplied runtime environment.
        ...providerEnvironmentKeys(this.options.environment ?? process.env)
      ]
    });
    this.process = child;
    child.events.once('started', ({ pid }) => {
      void this.updateServer({ pid }).catch(() => undefined);
    });
    child.events.on('stderr', (chunk) => this.appendDiagnostic(chunk));
    child.events.once('error', (error) => this.appendDiagnostic(Buffer.from(error.message)));
    child.events.once('close', ({ exitCode, signal }) => {
      void this.handleClose(exitCode, signal);
    });

    let baseUrl: string;
    try {
      baseUrl = await this.waitForStartupUrl(child);
      const client = new OpenCodeHttpClient({
        baseUrl,
        username: OPENCODE_SERVER_USERNAME,
        password,
        directory: this.options.cwd,
        requestTimeoutMs: this.options.requestTimeoutMs,
        journal: (direction, raw, metadata) =>
          this.store.appendProtocolMessage(this.server!.id, direction, raw, metadata)
      });
      await this.probeProtocol(client);
      this.client = client;
      this.server = await this.store.updateAgentServer(this.server.id, {
        status: 'READY',
        runtimeVersion: this.options.runtime.version,
        initializedAt: new Date().toISOString(),
        lastHealthAt: new Date().toISOString()
      });
      return { client, server: this.server };
    } catch (cause) {
      const diagnosticTail = this.redactedDiagnosticTail();
      if (this.server && !['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
        this.server = await this.store.updateAgentServer(this.server.id, {
          status: 'FAILED',
          exitedAt: new Date().toISOString(),
          exitReason: redactProcessDiagnostic(
            `${errorMessage(cause)}${diagnosticTail ? ` OpenCode diagnostics: ${diagnosticTail}` : ''}`,
            this.sensitiveValues
          )
        });
      }
      this.shuttingDown = true;
      await child.cancel().catch(() => undefined);
      throw cause;
    }
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
  }

  private waitForStartupUrl(child: SupervisedProcess): Promise<string> {
    const timeoutMs = this.options.startupTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for the OpenCode loopback server.'));
      }, timeoutMs);
      timer.unref();
      const onStdout = (chunk: Buffer) => {
        stdout = boundedTail(stdout + chunk.toString('utf8'), MAX_DIAGNOSTIC_TAIL_BYTES);
        const match = stdout.match(STARTUP_URL_PATTERN);
        if (match) {
          cleanup();
          resolve(match[1]);
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('OpenCode exited before publishing its loopback address.'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.events.off('stdout', onStdout);
        child.events.off('error', onError);
        child.events.off('close', onClose);
      };
      child.events.on('stdout', onStdout);
      child.events.once('error', onError);
      child.events.once('close', onClose);
    });
  }

  private async handleClose(
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const server = this.server;
    this.client = undefined;
    this.process = undefined;
    if (!server) return;
    const stored = await this.store.getAgentServer(server.id);
    if (stored) this.server = stored;
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
        ? `OpenCode exited unexpectedly.${diagnosticTail ? ` Diagnostics: ${diagnosticTail}` : ''}`
        : 'OpenCode runtime shut down.'
    });
    this.events.emit('exit', this.server, unexpected);
  }

  private appendDiagnostic(chunk: Buffer): void {
    // The generated password is never written to argv or Task Monki logs.
    // Keep a bounded raw stderr tail in memory so credentials split across
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

  private async updateServer(update: Parameters<FileTaskStore['updateAgentServer']>[1]): Promise<void> {
    if (this.server) this.server = await this.store.updateAgentServer(this.server.id, update);
  }
}

function providerEnvironmentKeys(environment: NodeJS.ProcessEnv): string[] {
  // OpenCode owns provider authentication. Forward only conventional provider
  // credentials already present in the explicitly supplied host environment;
  // arbitrary application secrets stay stripped by ProcessSupervisor.
  const exact = new Set([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GEMINI_API_KEY',
    'XAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION'
  ]);
  return [...exact].filter((key) => environment[key] !== undefined);
}

function providerCredentialEnvironmentKeys(environment: NodeJS.ProcessEnv): string[] {
  return providerEnvironmentKeys(environment).filter(
    (key) => key !== 'AWS_REGION' && key !== 'AWS_DEFAULT_REGION'
  );
}

function boundedTail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  return buffer.byteLength <= maxBytes
    ? value
    : buffer.subarray(buffer.byteLength - maxBytes).toString('utf8');
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
