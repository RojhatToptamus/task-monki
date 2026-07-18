import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentServerInstance } from '../../../shared/agent';
import {
  redactProcessDiagnostic,
  sanitizeEnvironment
} from '../../process/ProcessSupervisor';
import {
  isPortableProcessTreeRunning,
  spawnPortable,
  terminatePortableProcessTree,
  waitForPortableProcessTreeExit
} from '../../process/portableChildProcess';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import { sensitiveEnvironmentValues } from '../ProviderEnvironmentPolicy';
import {
  ACP_CLIENT_CAPABILITIES,
  ACP_PROTOCOL_VERSION,
  ACP_SCHEMA_ARTIFACT_VERSION,
  parseInitializeModelExtension,
  parseInitializeResponse,
  type AcpInitializeResponse,
  type AcpSessionModelState
} from './AcpProtocol';
import { AcpRpcClient } from './AcpRpcClient';
import type { AcpRuntimeProfile } from './AcpRuntimeProfiles';
import type { ResolvedAcpRuntime } from './AcpRuntimeResolver';
import {
  hasSafeAcpModelIdentifiers,
  normalizeAcpOperationalModelState,
  sanitizeAcpInitializeResponse
} from './AcpNativeRedaction';

const MAX_DIAGNOSTIC_TAIL_BYTES = 64 * 1024;
interface AcpSupervisorEvents {
  client: [client: AcpRpcClient];
  ready: [server: AgentServerInstance, initialize: AcpInitializeResponse];
  exit: [server: AgentServerInstance, unexpected: boolean];
  protocolError: [error: Error];
}

interface ManagedCloseHandling {
  promise: Promise<void>;
  resolve(): void;
  reject(cause: unknown): void;
}

export interface AcpStdioSupervisorOptions {
  profile: AcpRuntimeProfile;
  runtime: ResolvedAcpRuntime;
  cwd: string;
  appVersion?: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawnPortable;
  shutdownGraceTimeoutMs?: number;
  shutdownKillTimeoutMs?: number;
  closeHandlingTimeoutMs?: number;
  /** Runs after the prior close is finalized and before a replacement is spawned. */
  beforeClientReplacementStart?(priorServerInstanceId: string): Promise<void>;
}

export interface RunningAcpAgent {
  server: AgentServerInstance;
  client: AcpRpcClient;
  initialize: AcpInitializeResponse;
  profileModelState?: AcpSessionModelState;
}

export class AcpStdioSupervisor {
  readonly events = new EventEmitter<AcpSupervisorEvents>();

  private child?: ChildProcessWithoutNullStreams;
  private client?: AcpRpcClient;
  private server?: AgentServerInstance;
  private initializeResponse?: AcpInitializeResponse;
  private profileModelState?: AcpSessionModelState;
  private startPromise?: Promise<RunningAcpAgent>;
  private readonly closeHandlings = new WeakMap<
    ChildProcessWithoutNullStreams,
    ManagedCloseHandling
  >();
  private readonly closeListeners = new WeakMap<
    ChildProcessWithoutNullStreams,
    (exitCode: number | null, signal: NodeJS.Signals | null) => void
  >();
  private readonly diagnosticListeners = new WeakMap<
    ChildProcessWithoutNullStreams,
    (chunk: Buffer) => void
  >();
  private readonly rawDiagnosticTails = new WeakMap<ChildProcessWithoutNullStreams, string>();
  private readonly exitEmittedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private safetyFence?: {
    child: ChildProcessWithoutNullStreams;
    reason: string;
  };
  private shuttingDown = false;

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

  /**
   * A safety fence is permanent for this supervisor instance. Reusing a
   * supervisor after an unconfirmed termination or protocol violation could
   * overlap a replacement with a still-live provider process.
   */
  get safetyFenceReason(): string | undefined {
    return this.safetyFence?.reason;
  }

  start(): Promise<RunningAcpAgent> {
    if (this.safetyFence) {
      return Promise.reject(
        new Error(`ACP supervisor is safety-fenced until app restart. ${this.safetyFence.reason}`)
      );
    }
    if (this.shuttingDown) {
      return Promise.reject(new Error('ACP supervisor has been shut down.'));
    }
    if (
      this.client &&
      this.server &&
      this.initializeResponse &&
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      return Promise.resolve({
        client: this.client,
        server: this.server,
        initialize: this.initializeResponse,
        profileModelState: this.profileModelState
      });
    }
    if (!this.startPromise) {
      const priorChild = this.child;
      const priorServerInstanceId = this.server?.id;
      this.startPromise = (priorChild
        ? this.waitForHandledClose(priorChild).then((handled) => {
            if (!handled) throw new Error('Timed out finalizing the prior ACP process exit.');
          })
        : Promise.resolve()
      )
        .then(async () => {
          if (priorServerInstanceId) {
            await this.options.beforeClientReplacementStart?.(priorServerInstanceId);
          }
          return this.startInternal();
        })
        .finally(() => {
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
    const failures: unknown[] = [];
    const starting = this.startPromise;
    const childAtShutdown = this.child;
    try {
      if (this.server && ['READY', 'RUNNING', 'DEGRADED'].includes(this.server.status)) {
        this.server = await this.store.updateAgentServer(this.server.id, {
          status: 'STOPPING'
        });
      }
    } catch (cause) {
      failures.push(cause);
    }
    try {
      if (childAtShutdown) {
        await terminateAndConfirm(
          childAtShutdown,
          this.options.shutdownGraceTimeoutMs ?? 3_000,
          this.options.shutdownKillTimeoutMs ?? 2_000
        );
      }
    } catch (cause) {
      failures.push(cause);
      if (childAtShutdown) {
        try {
          await this.fenceUnconfirmedProcess(childAtShutdown, cause);
        } catch (cleanupCause) {
          failures.push(cleanupCause);
        }
      }
    }
    await starting?.catch(() => undefined);
    const lateChild = this.child;
    try {
      if (lateChild && lateChild !== childAtShutdown) {
        await terminateAndConfirm(
          lateChild,
          this.options.shutdownGraceTimeoutMs ?? 3_000,
          this.options.shutdownKillTimeoutMs ?? 2_000
        );
      }
    } catch (cause) {
      failures.push(cause);
      if (lateChild && lateChild !== childAtShutdown) {
        try {
          await this.fenceUnconfirmedProcess(lateChild, cause);
        } catch (cleanupCause) {
          failures.push(cleanupCause);
        }
      }
    }
    for (const child of new Set([childAtShutdown, lateChild].filter(Boolean))) {
      try {
        if (!(await this.waitForHandledClose(child as ChildProcessWithoutNullStreams))) {
          failures.push(new Error('Timed out finalizing the ACP process exit.'));
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'ACP runtime shutdown was incomplete.');
    }
  }

  private async startInternal(): Promise<RunningAcpAgent> {
    const profile = this.options.profile;
    const argv = [...profile.argv];
    const environment = this.options.environment ?? process.env;
    const sensitiveValues = sensitiveEnvironmentValues(
      profile.environmentPolicy,
      environment
    );
    let server: AgentServerInstance | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: AcpRpcClient | undefined;
    try {
      this.assertStartupActive();
      server = await this.store.createAgentServer({
        runtimeId: profile.descriptor.id,
        runtimeKind: 'ACP_AGENT',
        transport: 'STDIO',
        executable: this.options.runtime.executable,
        argv,
        runtimeVersion: this.options.runtime.version,
        schemaVersion: ACP_SCHEMA_ARTIFACT_VERSION,
        runtimeResolution: this.options.runtime.diagnostics
      });
      this.server = server;
      this.assertStartupActive();

      child = (this.options.spawnProcess ?? spawnPortable)(
        this.options.runtime.executable,
        argv,
        {
          cwd: this.options.cwd,
          env: sanitizeEnvironment(environment, profile.environmentPolicy.allowedKeys),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true
        }
      ) as ChildProcessWithoutNullStreams;
      this.child = child;
      this.rawDiagnosticTails.set(child, '');
      const onDiagnostic = (chunk: Buffer) => {
        this.rawDiagnosticTails.set(
          child!,
          boundedTail(
            `${this.rawDiagnosticTails.get(child!) ?? ''}${chunk.toString('utf8')}`,
            MAX_DIAGNOSTIC_TAIL_BYTES
          )
        );
      };
      this.diagnosticListeners.set(child, onDiagnostic);
      child.stderr.on('data', onDiagnostic);
      let settleResolve!: () => void;
      let settleReject!: (cause: unknown) => void;
      let settled = false;
      const promise = new Promise<void>((resolve, reject) => {
        settleResolve = resolve;
        settleReject = reject;
      });
      const closeHandling: ManagedCloseHandling = {
        promise,
        resolve: () => {
          if (settled) return;
          settled = true;
          settleResolve();
        },
        reject: (cause) => {
          if (settled) return;
          settled = true;
          settleReject(cause);
        }
      };
      this.closeHandlings.set(child, closeHandling);
      void promise.catch(() => undefined);
      const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        void this.handleProcessClose(child!, client, server!, exitCode, signal).then(
          closeHandling.resolve,
          closeHandling.reject
        );
      };
      this.closeListeners.set(child, onClose);
      child.once('close', onClose);

      this.assertStartupActive();
      await waitForSpawn(child);
      this.assertStartupActive();
      const starting = await this.store.updateAgentServer(server.id, { pid: child.pid });
      if (this.server?.id === server.id) this.server = starting;
      this.assertStartupActive();
      client = new AcpRpcClient(
        child.stdin,
        child.stdout,
        (direction, raw, metadata) =>
          this.store.appendProtocolMessage(server!.id, direction, raw, metadata),
        server.id,
        this.options.requestTimeoutMs,
        sensitiveValues
      );
      this.client = client;
      client.events.on('protocolError', (error) => {
        if (!this.isCurrentGeneration(child!, client!, server!.id)) return;
        const safeError = new Error(this.redactDiagnostic(error.message));
        this.events.emit('protocolError', safeError);
        void this.terminateProtocolViolation(safeError, child!, client!, server!.id);
      });
      // The adapter must subscribe before initialize because providers may send
      // extension notifications in the same stdout batch as the response.
      this.events.emit('client', client);

      const initialized = await client.request<unknown>('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
        clientInfo: {
          name: 'task-monki',
          title: 'Task Monki',
          version: this.options.appVersion ?? '0.1.0'
        }
      });
      // A provider may place extension notifications immediately after the
      // initialize response in the same stdout batch. Dispatch that complete
      // batch into the adapter's bounded startup buffer before publishing the
      // initial catalog so callers cannot observe an already-stale response.
      await client.drainInbound();
      this.assertStartupActive();
      const extension = profile.sessionModelExtension;
      const profileModelState = extension?.initializeResponseMetaField
        ? normalizeAcpOperationalModelState(
            parseInitializeModelExtension(
              initialized.result,
              extension.initializeResponseMetaField
            )
          ) ?? undefined
        : undefined;
      if (extension?.initializeResponseMetaField && !profileModelState) {
        throw new Error(
          `${profile.descriptor.displayName} did not provide the required ${extension.contractId} initialize catalog.`
        );
      }
      if (
        profileModelState &&
        !hasSafeAcpModelIdentifiers(profileModelState, sensitiveValues)
      ) {
        throw new Error(
          'ACP provider initialize catalog contained an identifier matching a runtime credential.'
        );
      }
      const initialize = sanitizeAcpInitializeResponse(
        parseInitializeResponse(initialized.result),
        sensitiveValues
      );
      if (initialize.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(
          `ACP protocol negotiation selected ${initialize.protocolVersion}; Task Monki supports stable protocol ${ACP_PROTOCOL_VERSION}.`
        );
      }
      this.initializeResponse = initialize;
      this.profileModelState = profileModelState;
      const ready = await this.store.updateAgentServer(server.id, {
        status: 'READY',
        runtimeVersion: initialize.agentInfo?.version ?? this.options.runtime.version,
        initializedAt: new Date().toISOString(),
        lastHealthAt: new Date().toISOString()
      });
      this.assertStartupActive();
      this.server = ready;
      this.events.emit('ready', ready, initialize);
      return { client, server: ready, initialize, profileModelState };
    } catch (cause) {
      const message = this.redactDiagnostic(
        startupFailure(cause, child ? this.redactedDiagnosticTail(child) : '')
      );
      const failure = new Error(message, { cause });
      const cleanupFailures: unknown[] = [];
      let terminationUnconfirmed = false;
      client?.close(`ACP startup failed: ${message}`);
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          await terminateAndConfirm(
            child,
            this.options.shutdownGraceTimeoutMs ?? 1_000,
            this.options.shutdownKillTimeoutMs ?? 2_000
          );
        } catch (cleanupCause) {
          terminationUnconfirmed = true;
          cleanupFailures.push(cleanupCause);
          try {
            await this.fenceUnconfirmedProcess(child, cleanupCause);
          } catch (fenceCause) {
            cleanupFailures.push(fenceCause);
          }
        }
      }
      if (child && !terminationUnconfirmed) {
        try {
          if (!(await this.waitForHandledClose(child))) {
            cleanupFailures.push(new Error('Timed out finalizing the ACP startup process exit.'));
          }
        } catch (cleanupCause) {
          cleanupFailures.push(cleanupCause);
        }
      }
      if (!terminationUnconfirmed) {
        if (this.client === client) this.client = undefined;
        if (this.child === child) this.child = undefined;
      }
      if (server) {
        try {
          const stored = await this.store.getAgentServer(server.id);
          if (stored && !['EXITED', 'FAILED', 'LOST'].includes(stored.status)) {
            const terminal = await this.store.updateAgentServer(server.id, {
              status: this.shuttingDown ? 'EXITED' : 'FAILED',
              exitedAt: new Date().toISOString(),
              exitReason: this.shuttingDown ? 'ACP startup was canceled.' : message
            });
            if (this.server?.id === server.id) this.server = terminal;
          }
        } catch (cleanupCause) {
          cleanupFailures.push(cleanupCause);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [failure, ...cleanupFailures],
          'ACP startup failed and cleanup was incomplete.'
        );
      }
      throw failure;
    }
  }

  private async terminateProtocolViolation(
    error: Error,
    child: ChildProcessWithoutNullStreams,
    client: AcpRpcClient,
    serverId: string
  ): Promise<void> {
    if (
      !this.isCurrentGeneration(child, client, serverId) ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) return;
    const message = this.redactDiagnostic(error.message);
    this.latchSafetyFence(
      child,
      `ACP protocol violation invalidated the process: ${message}`
    );
    client.close(`ACP protocol violation: ${message}`);
    try {
      await terminateAndConfirm(
        child,
        this.options.shutdownGraceTimeoutMs ?? 1_000,
        this.options.shutdownKillTimeoutMs ?? 2_000
      );
    } catch (cause) {
      // This method is launched from an EventEmitter callback. Handle every
      // failure here so there is no unhandled rejection, while retaining the
      // child and a permanent fence for all subsequent start attempts.
      await this.fenceUnconfirmedProcess(child, cause).catch(() => undefined);
    }
  }

  private async handleClose(
    child: ChildProcessWithoutNullStreams,
    client: AcpRpcClient | undefined,
    server: AgentServerInstance,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const wasCurrent = this.child === child && this.server?.id === server.id;
    let inboundFailure: unknown;
    if (client) {
      try {
        await client.drainInbound();
      } catch (cause) {
        inboundFailure = cause;
      }
    }
    const inboundFailureReason = inboundFailure === undefined
      ? undefined
      : this.redactDiagnostic(
          `ACP inbound dispatch failed while the process was closing: ${errorMessage(inboundFailure)}`
        );
    if (inboundFailureReason) {
      this.latchSafetyFence(child, inboundFailureReason);
      this.events.emit('protocolError', new Error(inboundFailureReason, { cause: inboundFailure }));
    }
    client?.close(inboundFailureReason ?? 'ACP agent process exited.');
    const unexpected = wasCurrent && (!this.shuttingDown || inboundFailure !== undefined);
    const diagnosticTail = this.redactedDiagnosticTail(child);
    let emittedServer = server;
    let storageFailure: unknown;
    try {
      const latest = await this.store.getAgentServer(server.id);
      emittedServer = latest ?? server;
      if (!['EXITED', 'FAILED', 'LOST'].includes(emittedServer.status)) {
        emittedServer = await this.store.updateAgentServer(emittedServer.id, {
          status: unexpected ? 'LOST' : 'EXITED',
          disconnectedAt: unexpected ? new Date().toISOString() : undefined,
          exitedAt: new Date().toISOString(),
          exitCode,
          signal,
          exitReason: unexpected
            ? `${inboundFailureReason ?? 'ACP agent exited unexpectedly.'}${diagnosticTail ? ` Diagnostics: ${diagnosticTail}` : ''}`
            : undefined
        });
      }
    } catch (cause) {
      storageFailure = cause;
    } finally {
      if (this.client === client) this.client = undefined;
      if (this.child === child) this.child = undefined;
      this.detachManagedChildListeners(child);
      if (wasCurrent && this.server?.id === server.id) {
        this.server = emittedServer;
        this.initializeResponse = undefined;
        this.profileModelState = undefined;
        if (!this.exitEmittedChildren.has(child)) {
          this.exitEmittedChildren.add(child);
          this.events.emit('exit', emittedServer, unexpected);
        }
      }
    }
    if (storageFailure && inboundFailure) {
      throw new AggregateError(
        [inboundFailure, storageFailure],
        'ACP process close could not be finalized safely.'
      );
    }
    if (inboundFailure) throw inboundFailure;
    if (storageFailure) throw storageFailure;
  }

  private async handleProcessClose(
    child: ChildProcessWithoutNullStreams,
    client: AcpRpcClient | undefined,
    server: AgentServerInstance,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    try {
      // `close` observes the stdio leader, not necessarily every descendant in
      // the detached process group. Do not release this generation for reuse
      // until the owned tree has been reaped.
      if (isPortableProcessTreeRunning(child)) {
        await terminateAndConfirm(
          child,
          this.options.shutdownGraceTimeoutMs ?? 3_000,
          this.options.shutdownKillTimeoutMs ?? 2_000
        );
      }
    } catch (cause) {
      await this.fenceUnconfirmedProcess(child, cause);
      return;
    }
    await this.handleClose(child, client, server, exitCode, signal);
  }

  /**
   * A process that ignores both termination signals remains owned until its
   * exit is observed. Forgetting it would allow a replacement to overlap a
   * possibly-live process with the same workspace and provider credentials.
   * The safety fence is intentionally irreversible until app restart.
   */
  private async fenceUnconfirmedProcess(
    child: ChildProcessWithoutNullStreams,
    cause: unknown
  ): Promise<void> {
    if (this.child !== child) return;
    const client = this.client;
    const server = this.server;
    const reason = this.redactDiagnostic(
      `ACP process termination could not be confirmed: ${errorMessage(cause)}`
    );

    this.latchSafetyFence(child, reason);
    client?.close(reason);
    this.initializeResponse = undefined;
    this.profileModelState = undefined;

    let emittedServer = server;
    let storageFailure: unknown;
    try {
      if (server && !['EXITED', 'FAILED', 'LOST'].includes(server.status)) {
        emittedServer = await this.store.updateAgentServer(server.id, {
          status: 'LOST',
          disconnectedAt: new Date().toISOString(),
          exitReason: reason
        });
      }
    } catch (persistenceCause) {
      storageFailure = persistenceCause;
    } finally {
      if (server && emittedServer && this.server?.id === server.id) {
        this.server = emittedServer;
        if (!this.exitEmittedChildren.has(child)) {
          this.exitEmittedChildren.add(child);
          this.events.emit('exit', emittedServer, true);
        }
      }
    }
    if (storageFailure) throw storageFailure;
  }

  private latchSafetyFence(
    child: ChildProcessWithoutNullStreams,
    reason: string
  ): void {
    if (this.safetyFence) return;
    this.safetyFence = {
      child,
      reason: this.redactDiagnostic(reason)
    };
  }

  private detachManagedChildListeners(child: ChildProcessWithoutNullStreams): void {
    const onClose = this.closeListeners.get(child);
    if (onClose) child.off('close', onClose);
    this.closeListeners.delete(child);
    const onDiagnostic = this.diagnosticListeners.get(child);
    if (onDiagnostic) child.stderr.off('data', onDiagnostic);
    this.diagnosticListeners.delete(child);
    this.rawDiagnosticTails.delete(child);
  }

  private redactDiagnostic(value: string): string {
    const environment = this.options.environment ?? process.env;
    return redactProcessDiagnostic(
      value,
      sensitiveEnvironmentValues(this.options.profile.environmentPolicy, environment)
    );
  }

  private redactedDiagnosticTail(child: ChildProcessWithoutNullStreams): string {
    return boundedTail(
      this.redactDiagnostic(this.rawDiagnosticTails.get(child) ?? ''),
      MAX_DIAGNOSTIC_TAIL_BYTES
    );
  }

  private assertStartupActive(): void {
    if (this.safetyFence) {
      throw new Error(`ACP startup was safety-fenced. ${this.safetyFence.reason}`);
    }
    if (this.shuttingDown) throw new Error('ACP startup was canceled.');
  }

  private isCurrentGeneration(
    child: ChildProcessWithoutNullStreams,
    client: AcpRpcClient,
    serverId: string
  ): boolean {
    return this.child === child && this.client === client && this.server?.id === serverId;
  }

  private waitForHandledClose(
    child: ChildProcessWithoutNullStreams,
    timeoutMs = this.options.closeHandlingTimeoutMs ?? 3_000
  ): Promise<boolean> {
    const handling = this.closeHandlings.get(child);
    return handling ? waitForPromise(handling.promise, timeoutMs) : Promise.resolve(true);
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
    throw new Error(`ACP agent process tree ${child.pid ?? '<unknown>'} did not exit after SIGKILL.`);
  }
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
