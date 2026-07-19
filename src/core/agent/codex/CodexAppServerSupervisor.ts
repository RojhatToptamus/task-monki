import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentRuntimeResolutionDiagnostics,
  AgentServerInstance,
  CodexExternalToolSettings
} from '../../../shared/agent';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import {
  isPortableProcessTreeRunning,
  spawnPortable,
  terminatePortableProcessTree,
  waitForPortableProcessTreeExit
} from '../../process/portableChildProcess';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import { CodexRpcClient } from './CodexRpcClient';
import {
  resolveCodexRuntime,
  type CodexAppServerLaunch,
  type CodexRuntimeProbeResult,
  type ResolvedCodexRuntime
} from './CodexRuntimeResolver';
import {
  codexExternalToolConfigOverrides,
  normalizeCodexExternalToolSettings,
  resolveCodexExternalToolConfigOverrides
} from './CodexToolConfig';
import { CODEX_ENVIRONMENT_POLICY } from './CodexEnvironmentPolicy';
import { CODEX_PROTOCOL_RUNTIME_VERSION, CODEX_PROTOCOL_SCHEMA_HASH } from './protocol/metadata';
import {
  REDACTED_CREDENTIAL,
  isSensitiveCredentialFieldName,
  redactCredentialText
} from '../AgentCredentialRedaction';

export const CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS = [
  'command/exec/outputDelta',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/mcpToolCall/progress',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'process/outputDelta',
  'turn/diff/updated'
] as const;

interface SupervisorEvents {
  ready: [server: AgentServerInstance];
  exit: [
    server: AgentServerInstance,
    unexpected: boolean,
    processTreeExited: boolean
  ];
  protocolError: [error: Error];
  diagnostic: [text: string];
}

export interface CodexAppServerSupervisorOptions {
  executable?: string;
  cwd: string;
  appVersion: string;
  requestTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  toolSettings?: CodexExternalToolSettings;
  failClosedMcpDiscovery?: boolean;
  runtimeResolver?: typeof resolveCodexRuntime;
  argvResolver?: typeof resolveCodexAppServerArgv;
  spawnProcess?: typeof spawnPortable;
  shutdownGraceTimeoutMs?: number;
  shutdownKillTimeoutMs?: number;
  closeHandlingTimeoutMs?: number;
}

export interface CodexAppServerLaunchConfig {
  toolSettings?: CodexExternalToolSettings;
  mcpServerConfigOverrides?: readonly string[];
  appServerArgv?: readonly string[];
}

export function codexAppServerArgv(
  input: CodexAppServerLaunchConfig | readonly string[] = {}
): string[] {
  const launchConfig: CodexAppServerLaunchConfig = Array.isArray(input)
    ? { mcpServerConfigOverrides: input }
    : (input as CodexAppServerLaunchConfig);
  const configOverrides = [
    ...codexExternalToolConfigOverrides(launchConfig.toolSettings),
    ...(launchConfig.mcpServerConfigOverrides ?? [])
  ];
  return codexAppServerArgvWithLaunch(
    launchConfig.appServerArgv ?? ['app-server', '--stdio'],
    configOverrides
  );
}

function codexAppServerArgvWithLaunch(
  launchArgv: readonly string[],
  configOverrides: readonly string[]
): string[] {
  return [
    ...launchArgv,
    ...configOverrides.flatMap((override) => ['-c', override])
  ];
}

export async function resolveCodexAppServerArgv(input: {
  executable: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  toolSettings?: CodexExternalToolSettings;
  launch?: CodexAppServerLaunch;
  failClosedMcpDiscovery?: boolean;
}): Promise<string[]> {
  const configOverrides = await resolveCodexExternalToolConfigOverrides({
    executable: input.executable,
    cwd: input.cwd,
    environment: input.environment,
    settings: input.toolSettings,
    failClosedMcpDiscovery: input.failClosedMcpDiscovery
  });
  return codexAppServerArgvWithLaunch(
    input.launch?.argv ?? ['app-server', '--stdio'],
    configOverrides
  );
}

export class CodexAppServerSupervisor {
  readonly events = new EventEmitter<SupervisorEvents>();

  private child?: ChildProcessWithoutNullStreams;
  private client?: CodexRpcClient;
  private server?: AgentServerInstance;
  private startPromise?: Promise<CodexRpcClient>;
  private readonly closeHandlings = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
  private readonly processTreeTerminations = new WeakMap<
    ChildProcessWithoutNullStreams,
    Promise<void>
  >();
  private readonly closingChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly diagnosticTails = new WeakMap<ChildProcessWithoutNullStreams, string>();
  private readonly diagnosticLineBuffers = new WeakMap<ChildProcessWithoutNullStreams, string>();
  private readonly terminationReasons = new WeakMap<ChildProcessWithoutNullStreams, string>();
  private shuttingDown = false;
  private lifecycleFailure?: Error;
  private runtimeDiagnostics: CodexRuntimeProbeResult[] = [];

  constructor(
    private readonly store: FileTaskStore,
    private readonly options: CodexAppServerSupervisorOptions
  ) {}

  get currentServer(): AgentServerInstance | undefined {
    return this.server;
  }

  get currentClient(): CodexRpcClient | undefined {
    return this.client;
  }

  get processTreeRunning(): boolean {
    return this.child ? isPortableProcessTreeRunning(this.child) : false;
  }

  get lastRuntimeDiagnostics(): readonly CodexRuntimeProbeResult[] {
    return this.runtimeDiagnostics;
  }

  setExecutable(executable: string | undefined): void {
    this.options.executable = executable;
  }

  setToolSettings(settings: CodexExternalToolSettings): void {
    this.options.toolSettings = normalizeCodexExternalToolSettings(settings);
  }

  start(): Promise<CodexRpcClient> {
    if (this.lifecycleFailure) {
      return Promise.reject(
        new Error(
          `Codex App Server lifecycle is fenced after an unpersisted process exit: ${this.lifecycleFailure.message}`,
          { cause: this.lifecycleFailure }
        )
      );
    }
    if (this.shuttingDown) {
      return Promise.reject(new Error('Codex App Server supervisor has been shut down.'));
    }
    if (
      this.client &&
      this.child &&
      !this.closingChildren.has(this.child) &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      isPortableProcessTreeRunning(this.child)
    ) {
      return Promise.resolve(this.client);
    }
    if (!this.startPromise) {
      const priorChild = this.child;
      this.startPromise = (priorChild
        ? this.waitForHandledClose(
            priorChild,
            this.options.closeHandlingTimeoutMs ?? 3_000
          ).then((handled) => {
            if (!handled) {
              throw new Error('Timed out finalizing the prior Codex App Server exit.');
            }
            if (isPortableProcessTreeRunning(priorChild)) {
              throw new Error(
                `Refusing to start Codex App Server while prior process tree ${priorChild.pid ?? '<unknown>'} may still be alive.`
              );
            }
          })
        : Promise.resolve()
      ).then(() => this.startInternal()).finally(() => {
          this.startPromise = undefined;
        });
    }
    return this.startPromise;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const failures: unknown[] = [];
    const starting = this.startPromise;
    const childAtShutdown = this.child;
    this.client?.close('Codex App Server shut down.');
    if (this.server && ['READY', 'RUNNING', 'DEGRADED'].includes(this.server.status)) {
      try {
        const stored = await this.store.getAgentServer(this.server.id);
        if (stored) this.server = stored;
        if (this.server && ['READY', 'RUNNING', 'DEGRADED'].includes(this.server.status)) {
          this.server = await this.store.updateAgentServer(this.server.id, { status: 'STOPPING' });
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (childAtShutdown) {
      try {
        await this.ensureProcessTreeExit(
          childAtShutdown,
          this.options.shutdownGraceTimeoutMs ?? 3_000,
          this.options.shutdownKillTimeoutMs ?? 2_000
        );
      } catch (cause) {
        failures.push(cause);
      }
    }
    await starting?.catch(() => undefined);
    const lateChild = this.child;
    if (lateChild && lateChild !== childAtShutdown) {
      try {
        await this.ensureProcessTreeExit(
          lateChild,
          this.options.shutdownGraceTimeoutMs ?? 3_000,
          this.options.shutdownKillTimeoutMs ?? 2_000
        );
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const child of new Set([childAtShutdown, lateChild].filter(Boolean))) {
      try {
        if (!(await this.waitForHandledClose(
          child as ChildProcessWithoutNullStreams,
          this.options.closeHandlingTimeoutMs ?? 3_000
        ))) {
          failures.push(new Error('Timed out finalizing the Codex App Server exit.'));
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Codex App Server shutdown was incomplete.');
    }
  }

  /**
   * Safety-boundary failures must stop the child before waiting on storage.
   * The ordinary graceful shutdown records STOPPING first, which is the right
   * lifecycle order for normal exits but can leave an unsafe or unrecoverable
   * provider generation live while that write is pending.
   *
   * This fence is intentionally one-way. Recovery requires a new supervisor;
   * the stopped generation can never be restarted or reused.
   */
  async terminateAndFence(reason: string): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    const safeReason = this.redactDiagnostic(reason);
    const handledClose = child ? this.closeHandlings.get(child) : undefined;
    if (child) this.terminationReasons.set(child, safeReason);
    this.client?.close(safeReason);
    if (child && isPortableProcessTreeRunning(child)) {
      await this.ensureProcessTreeExit(
        child,
        this.options.shutdownGraceTimeoutMs ?? 1_000,
        this.options.shutdownKillTimeoutMs ?? 2_000
      );
    }

    if (this.server) {
      const stored = await this.store.getAgentServer(this.server.id).catch(() => undefined);
      if (stored) {
        this.server = stored;
      }
      if (!['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
        await this.store
          .updateAgentServer(this.server.id, { status: 'STOPPING', exitReason: safeReason })
          .catch(() => undefined);
      }
    }
    if (handledClose) {
      if (!(await waitForPromise(
        handledClose,
        this.options.closeHandlingTimeoutMs ?? 3_000
      ))) {
        throw new Error('Timed out finalizing the fenced Codex App Server shutdown.');
      }
    }
  }

  async terminateUnresponsive(reason: string): Promise<void> {
    const safeReason = this.redactDiagnostic(reason);
    const child = this.child;
    const failures: unknown[] = [];
    if (child) this.terminationReasons.set(child, safeReason);
    // Closing and terminating the process is the safety boundary. It must not
    // depend on a diagnostic store write succeeding.
    this.client?.close(safeReason);
    if (child && isPortableProcessTreeRunning(child)) {
      try {
        await this.ensureProcessTreeExit(
          child,
          this.options.shutdownGraceTimeoutMs ?? 1_000,
          this.options.shutdownKillTimeoutMs ?? 2_000
        );
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (child) {
      try {
        if (!(await this.waitForHandledClose(
          child,
          this.options.closeHandlingTimeoutMs ?? 3_000
        ))) {
          failures.push(
            new Error('Timed out finalizing the unresponsive Codex App Server exit.')
          );
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      if (this.server && !['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
        this.server = await this.store.updateAgentServer(this.server.id, {
          status: 'LOST',
          disconnectedAt: new Date().toISOString(),
          exitReason: safeReason
        });
      }
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length > 0) {
      const failure = new AggregateError(
        failures,
        `Codex App Server termination could not be fully confirmed and persisted: ${failures
          .map((cause) => this.redactDiagnostic(errorMessage(cause)))
          .join('; ')}`
      );
      this.lifecycleFailure = failure;
      throw failure;
    }
  }

  private async startInternal(): Promise<CodexRpcClient> {
    let server: AgentServerInstance | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: CodexRpcClient | undefined;
    try {
      this.assertStartupActive();
      const runtime = await (this.options.runtimeResolver ?? resolveCodexRuntime)({
        executable: this.options.executable,
        cwd: this.options.cwd,
        environment: this.options.environment,
        requestTimeoutMs: this.options.requestTimeoutMs
      });
      this.assertStartupActive();
      const executable = runtime.executable;
      const runtimeVersion = runtime.version;
      this.runtimeDiagnostics = runtime.diagnostics.map((probe) => ({
        ...probe,
        detail: probe.detail ? this.redactDiagnostic(probe.detail) : probe.detail
      }));
      const argv = await (this.options.argvResolver ?? resolveCodexAppServerArgv)({
        executable,
        cwd: this.options.cwd,
        environment: this.options.environment,
        toolSettings: this.options.toolSettings,
        failClosedMcpDiscovery: this.options.failClosedMcpDiscovery,
        launch: runtime.compatibility.launch
      });
      this.assertStartupActive();

      server = await this.store.createAgentServer({
        runtimeId: 'codex',
        runtimeKind: 'APP_SERVER',
        transport: 'STDIO',
        executable,
        argv: redactCodexArgv(argv),
        runtimeVersion,
        schemaVersion: CODEX_PROTOCOL_RUNTIME_VERSION,
        schemaHash: CODEX_PROTOCOL_SCHEMA_HASH,
        runtimeResolution: codexRuntimeResolutionDiagnostics(runtime, (value) =>
          this.redactDiagnostic(value)
        )
      });
      this.server = server;
      this.assertStartupActive();

      child = (this.options.spawnProcess ?? spawnPortable)(executable, argv, {
        cwd: this.options.cwd,
        env: sanitizeEnvironment(
          this.options.environment ?? process.env,
          CODEX_ENVIRONMENT_POLICY.allowedKeys
        ),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      this.diagnosticTails.set(child, '');
      this.diagnosticLineBuffers.set(child, '');

      let resolveHandledClose!: () => void;
      let rejectHandledClose!: (cause: unknown) => void;
      const handledClose = new Promise<void>((resolve, reject) => {
        resolveHandledClose = resolve;
        rejectHandledClose = reject;
      });
      this.closeHandlings.set(child, handledClose);
      void handledClose.catch(() => undefined);
      child.once('close', (exitCode, signal) => {
        this.closingChildren.add(child!);
        void this.handleClose(child!, client, server!, exitCode, signal).then(
          resolveHandledClose,
          rejectHandledClose
        );
      });
      child.stderr.on('data', (chunk: Buffer) => this.appendDiagnostic(child!, chunk));
      child.once('error', (error) => {
        this.appendDiagnostic(child!, Buffer.from(`${error.message}\n`));
      });

      this.assertStartupActive();
      await waitForSpawn(child);
      this.assertStartupActive();
      const running = await this.store.updateAgentServer(server.id, {
        status: 'RUNNING',
        pid: child.pid
      });
      if (this.server?.id === server.id) this.server = running;
      this.assertStartupActive();

      client = new CodexRpcClient(
        child.stdin,
        child.stdout,
        this.store,
        server.id,
        this.options.requestTimeoutMs,
        codexSensitiveEnvironmentValues(this.options.environment ?? process.env)
      );
      this.client = client;
      client.events.on('protocolError', (error) => {
        if (!this.isCurrentGeneration(child!, client!, server!.id)) return;
        const safeError = new Error(this.redactDiagnostic(error.message, child));
        this.events.emit('protocolError', safeError);
        void this.failProtocol(safeError, child!, client!, server!.id).catch(
          (cause: unknown) => {
            this.lifecycleFailure =
              cause instanceof Error ? cause : new Error(String(cause));
          }
        );
      });

      await client.request('initialize', {
        clientInfo: {
          name: 'task_monki',
          title: 'Task Monki',
          version: this.options.appVersion
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [...CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS]
        }
      });
      this.assertStartupActive();
      await client.notify('initialized', {});
      this.assertStartupActive();

      const ready = await this.store.updateAgentServer(server.id, {
        status: 'READY',
        initializedAt: new Date().toISOString(),
        lastHealthAt: new Date().toISOString()
      });
      this.assertStartupActive();
      this.server = ready;
      this.events.emit('ready', ready);
      return client;
    } catch (cause) {
      const message = this.redactDiagnostic(errorMessage(cause), child);
      const failure = new Error(message, { cause });
      const cleanupFailures: unknown[] = [];
      client?.close(message);
      if (this.client === client) this.client = undefined;
      if (child && isPortableProcessTreeRunning(child)) {
        try {
          await this.ensureProcessTreeExit(
            child,
            this.options.shutdownGraceTimeoutMs ?? 1_000,
            this.options.shutdownKillTimeoutMs ?? 2_000
          );
        } catch (cleanupCause) {
          cleanupFailures.push(cleanupCause);
        }
      }
      if (child) {
        try {
          if (!(await this.waitForHandledClose(
            child,
            this.options.closeHandlingTimeoutMs ?? 3_000
          ))) {
            cleanupFailures.push(
              new Error('Timed out finalizing the failed Codex App Server startup.')
            );
          }
        } catch (cleanupCause) {
          cleanupFailures.push(cleanupCause);
        }
      }
      if (
        cleanupFailures.length === 0 &&
        this.child === child &&
        child &&
        !isPortableProcessTreeRunning(child)
      ) {
        this.child = undefined;
      }
      if (server) {
        try {
          const stored = await this.store.getAgentServer(server.id);
          if (stored && !isTerminalServerStatus(stored.status)) {
            const terminal = await this.store.updateAgentServer(server.id, {
              status: this.shuttingDown ? 'EXITED' : 'FAILED',
              exitedAt: new Date().toISOString(),
              exitReason: this.shuttingDown ? 'Codex App Server startup was canceled.' : message
            });
            if (this.server?.id === server.id) this.server = terminal;
          }
        } catch (cleanupCause) {
          cleanupFailures.push(cleanupCause);
        }
      }
      if (cleanupFailures.length > 0) {
        const cleanupFailure = new AggregateError(
          [failure, ...cleanupFailures],
          'Codex App Server startup failed and cleanup was incomplete.'
        );
        this.lifecycleFailure = cleanupFailure;
        throw cleanupFailure;
      }
      throw failure;
    }
  }

  private async failProtocol(
    error: Error,
    child: ChildProcessWithoutNullStreams,
    client: CodexRpcClient,
    serverId: string
  ): Promise<void> {
    // Once an intentional shutdown owns the lifecycle, EOF or a final partial
    // frame must not race the close handler and reclassify that exit as a
    // protocol failure.
    if (this.shuttingDown || !this.isCurrentGeneration(child, client, serverId)) return;
    const safeMessage = this.redactDiagnostic(error.message, child);
    client.close(`Protocol error: ${safeMessage}`);
    const termination =
      isPortableProcessTreeRunning(child)
        ? this.ensureProcessTreeExit(
            child,
            this.options.shutdownGraceTimeoutMs ?? 1_000,
            this.options.shutdownKillTimeoutMs ?? 2_000
          )
        : Promise.resolve();
    const failures: unknown[] = [];
    try {
      const stored = await this.store.getAgentServer(serverId);
      if (stored && !isTerminalServerStatus(stored.status)) {
        const failed = await this.store.updateAgentServer(serverId, {
          status: 'FAILED',
          exitReason: `Protocol error: ${safeMessage}`
        });
        if (this.server?.id === serverId) this.server = failed;
      }
    } catch (cause) {
      failures.push(cause);
    }
    try {
      await termination;
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length > 0) {
      const failure = new AggregateError(
        failures,
        `Codex App Server protocol-failure cleanup was incomplete: ${safeMessage}`
      );
      this.lifecycleFailure = failure;
      throw failure;
    }
  }

  private ensureProcessTreeExit(
    child: ChildProcessWithoutNullStreams,
    gracefulTimeoutMs: number,
    killTimeoutMs: number
  ): Promise<void> {
    const existing = this.processTreeTerminations.get(child);
    if (existing) return existing;
    const termination = terminateAndConfirm(child, gracefulTimeoutMs, killTimeoutMs);
    this.processTreeTerminations.set(child, termination);
    return termination;
  }

  private async waitForHandledClose(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number
  ): Promise<boolean> {
    const handledClose = this.closeHandlings.get(child);
    return handledClose ? waitForPromise(handledClose, timeoutMs) : true;
  }

  private async handleClose(
    child: ChildProcessWithoutNullStreams,
    client: CodexRpcClient | undefined,
    server: AgentServerInstance,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    this.flushDiagnosticBuffer(child);
    const wasCurrent = this.child === child && this.server?.id === server.id;
    const unexpected = wasCurrent && !this.shuttingDown;
    let inboundDrainFailure: unknown;
    try {
      await client?.drainInbound();
    } catch (cause) {
      inboundDrainFailure = cause;
      this.lifecycleFailure =
        cause instanceof Error ? cause : new Error(String(cause));
    }
    client?.close(
      unexpected ? 'Codex App Server exited unexpectedly.' : 'Codex App Server stopped.'
    );
    let processTreeFailure: unknown;
    if (isPortableProcessTreeRunning(child)) {
      try {
        await this.ensureProcessTreeExit(
          child,
          this.options.shutdownGraceTimeoutMs ?? 1_000,
          this.options.shutdownKillTimeoutMs ?? 2_000
        );
      } catch (cause) {
        processTreeFailure = cause;
        this.lifecycleFailure = cause instanceof Error ? cause : new Error(String(cause));
      }
    }
    const processTreeExited = !isPortableProcessTreeRunning(child);
    const terminalStatus = !processTreeExited
      ? 'LOST'
      : unexpected && exitCode !== 0
        ? 'FAILED'
        : 'EXITED';
    let emittedServer = server;
    let storageFailure: unknown;
    try {
      const current = await this.store.getAgentServer(server.id);
      const stored = current && !isTerminalServerStatus(current.status)
        ? await this.store.updateAgentServer(server.id, {
            status: terminalStatus,
            exitedAt: new Date().toISOString(),
            exitCode,
            signal,
            exitReason:
              this.redactedDiagnosticTail(child) ||
              this.terminationReasons.get(child) ||
              undefined
          })
        : current ?? server;
      emittedServer = stored;
    } catch (cause) {
      storageFailure = cause;
      this.lifecycleFailure = cause instanceof Error ? cause : new Error(String(cause));
    } finally {
      if (this.client === client) this.client = undefined;
      if (this.child === child && processTreeExited) this.child = undefined;
      if (wasCurrent && this.server?.id === server.id) this.server = emittedServer;
    }
    if (wasCurrent) {
      this.events.emit('exit', emittedServer, unexpected, processTreeExited);
    }
    const failures: unknown[] = [];
    if (inboundDrainFailure !== undefined) failures.push(inboundDrainFailure);
    if (processTreeFailure !== undefined) failures.push(processTreeFailure);
    if (storageFailure !== undefined) failures.push(storageFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Codex App Server exit cleanup was incomplete.');
    }
  }

  private assertStartupActive(): void {
    if (this.shuttingDown) throw new Error('Codex App Server startup was canceled.');
  }

  private isCurrentGeneration(
    child: ChildProcessWithoutNullStreams,
    client: CodexRpcClient,
    serverId: string
  ): boolean {
    return this.child === child && this.client === client && this.server?.id === serverId;
  }

  private appendDiagnostic(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    const text = chunk.toString('utf8');
    this.diagnosticTails.set(
      child,
      boundedTail(`${this.diagnosticTails.get(child) ?? ''}${text}`, 32_768)
    );
    const combined = boundedTail(
      `${this.diagnosticLineBuffers.get(child) ?? ''}${text}`,
      32_768
    );
    const lines = combined.split(/(?<=\n)/u);
    const remainder = lines.at(-1)?.endsWith('\n') ? '' : lines.pop() ?? '';
    this.diagnosticLineBuffers.set(child, remainder);
    if (this.child !== child) return;
    for (const line of lines) {
      const diagnostic = this.redactDiagnostic(line, child);
      if (diagnostic) this.events.emit('diagnostic', diagnostic);
    }
  }

  private flushDiagnosticBuffer(child: ChildProcessWithoutNullStreams): void {
    const remainder = this.diagnosticLineBuffers.get(child) ?? '';
    this.diagnosticLineBuffers.delete(child);
    if (remainder && this.child === child) {
      this.events.emit('diagnostic', this.redactDiagnostic(remainder, child));
    }
  }

  private redactedDiagnosticTail(child: ChildProcessWithoutNullStreams): string {
    return this.redactDiagnostic(this.diagnosticTails.get(child) ?? '', child).trim();
  }

  private redactDiagnostic(
    value: string,
    _child?: ChildProcessWithoutNullStreams
  ): string {
    let redacted = redactCredentialText(value);
    for (const sensitive of codexSensitiveEnvironmentValues(
      this.options.environment ?? process.env
    )) {
      redacted = redacted.split(sensitive).join(REDACTED_CREDENTIAL);
    }
    return redacted;
  }
}

function isTerminalServerStatus(status: AgentServerInstance['status']): boolean {
  return status === 'FAILED' || status === 'EXITED' || status === 'LOST';
}

function codexRuntimeResolutionDiagnostics(
  runtime: ResolvedCodexRuntime,
  redact: (value: string) => string = (value) => value
): AgentRuntimeResolutionDiagnostics {
  return {
    selectedExecutable: runtime.executable,
    selectedSource: runtime.source,
    selectedVersion: runtime.version,
    selectedLaunchArgv: [...runtime.compatibility.launch.argv],
    requiredCapabilities: [...runtime.compatibility.requiredMethods],
    probes: runtime.diagnostics.map((probe) => ({
      executable: probe.candidate.executable,
      source: probe.candidate.source,
      explicit: probe.candidate.explicit,
      compatible: probe.compatible,
      version: probe.version,
      launchArgv: probe.launch ? [...probe.launch.argv] : undefined,
      launchForm: probe.launch?.form,
      missingCapabilities: probe.missingMethods ? [...probe.missingMethods] : undefined,
      detail: probe.detail ? redact(probe.detail) : probe.detail
    }))
  };
}

function redactCodexArgv(argv: readonly string[]): string[] {
  return argv.map((argument, index) => {
    const previous = argv[index - 1];
    if (previous && /^(?:--?|\/)(?:api[-_]?key|auth[-_]?token|token|password|secret)$/iu.test(previous)) {
      return REDACTED_CREDENTIAL;
    }
    return redactCredentialText(argument);
  });
}

export function codexSensitiveEnvironmentValues(
  environment: NodeJS.ProcessEnv
): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => Boolean(value) && isSensitiveCredentialFieldName(key))
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
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

async function terminateAndConfirm(
  child: ChildProcessWithoutNullStreams,
  gracefulTimeoutMs: number,
  killTimeoutMs: number
): Promise<void> {
  if (!isPortableProcessTreeRunning(child)) return;
  await terminatePortableProcessTree(child, 'SIGTERM');
  if (await waitForPortableProcessTreeExit(child, gracefulTimeoutMs)) return;
  await terminatePortableProcessTree(child, 'SIGKILL');
  if (!(await waitForPortableProcessTreeExit(child, killTimeoutMs))) {
    throw new Error(`Codex App Server process ${child.pid ?? '<unknown>'} did not exit after SIGKILL.`);
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      }
    );
  });
}
