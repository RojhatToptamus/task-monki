import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentRuntimeResolutionDiagnostics,
  AgentServerInstance,
  CodexExternalToolSettings
} from '../../../shared/agent';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import {
  spawnPortable,
  terminatePortableProcessTree
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
import { CODEX_PROTOCOL_RUNTIME_VERSION, CODEX_PROTOCOL_SCHEMA_HASH } from './protocol/metadata';

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
  exit: [server: AgentServerInstance, unexpected: boolean];
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
  private closePromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private shuttingDown = false;
  private diagnosticTail = '';
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
    if (this.shuttingDown) {
      return Promise.reject(new Error('Codex App Server is shutting down.'));
    }
    if (this.client && this.child && !this.child.killed) {
      return Promise.resolve(this.client);
    }
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    const work = this.shutdownInternal().finally(() => {
      if (this.shutdownPromise === work) this.shutdownPromise = undefined;
    });
    this.shutdownPromise = work;
    return work;
  }

  resumeAfterShutdown(): void {
    if (!this.shuttingDown) return;
    if (
      this.shutdownPromise ||
      this.startPromise ||
      this.closePromise ||
      this.hasLiveChild()
    ) {
      throw new Error('Codex App Server shutdown has not finished.');
    }
    this.shuttingDown = false;
  }

  private async shutdownInternal(): Promise<void> {
    const pendingStart = this.startPromise;
    await this.stopCurrentChild('Codex App Server shut down.');
    await pendingStart?.catch(() => undefined);
    await this.stopCurrentChild('Codex App Server shut down.');
  }

  private async stopCurrentChild(reason: string): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.closeClient(reason);
      await this.closePromise;
      await this.disposeCurrentClient();
      return;
    }

    if (this.server) {
      const stored = await this.store.getAgentServer(this.server.id);
      if (stored) {
        this.server = stored;
      }
      if (
        this.server.status !== 'STARTING' &&
        !['EXITED', 'FAILED', 'LOST'].includes(this.server.status)
      ) {
        this.server = await this.store.updateAgentServer(this.server.id, {
          status: 'STOPPING'
        });
      }
    }
    this.closeClient(reason);
    await terminatePortableProcessTree(child, 'SIGTERM');
    if (!(await waitForClose(child, 3_000))) {
      await terminatePortableProcessTree(child, 'SIGKILL');
      await waitForClose(child, 2_000);
    }
    await this.closePromise;
    await this.disposeCurrentClient();
  }

  /**
   * Security-boundary failures must stop the child before waiting on storage.
   * The ordinary graceful shutdown records STOPPING first, which is the right
   * lifecycle order for normal exits but leaves a permissions violation live
   * while that write is pending.
   */
  async terminateForSecurityBoundary(reason: string): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    this.closeClient(reason);
    if (child && child.exitCode === null && child.signalCode === null) {
      await terminatePortableProcessTree(child, 'SIGTERM');
    }

    if (this.server) {
      const stored = await this.store.getAgentServer(this.server.id).catch(() => undefined);
      if (stored) {
        this.server = stored;
      }
      if (!['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
        await this.store
          .updateAgentServer(this.server.id, { status: 'STOPPING', exitReason: reason })
          .catch(() => undefined);
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      if (!(await waitForClose(child, 1_000))) {
        await terminatePortableProcessTree(child, 'SIGKILL');
        await waitForClose(child, 2_000);
      }
    }
    await this.closePromise;
    await this.disposeCurrentClient();
  }

  async terminateUnresponsive(reason: string): Promise<void> {
    const child = this.child;
    if (this.server && !['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
      this.server = await this.store.updateAgentServer(this.server.id, {
        status: 'LOST',
        disconnectedAt: new Date().toISOString(),
        exitReason: reason
      });
    }
    this.closeClient(reason);
    if (child && child.exitCode === null && child.signalCode === null) {
      await terminatePortableProcessTree(child, 'SIGTERM');
      if (!(await waitForClose(child, 1_000))) {
        await terminatePortableProcessTree(child, 'SIGKILL');
        await waitForClose(child, 2_000);
      }
      await this.closePromise;
    }
    await this.disposeCurrentClient();
  }

  private async startInternal(): Promise<CodexRpcClient> {
    let runtime: ResolvedCodexRuntime;
    try {
      runtime = await resolveCodexRuntime({
        executable: this.options.executable,
        cwd: this.options.cwd,
        environment: this.options.environment,
        requestTimeoutMs: this.options.requestTimeoutMs
      });
    } catch (error) {
      this.assertStartupAllowed();
      throw error;
    }
    const executable = runtime.executable;
    const runtimeVersion = runtime.version;
    this.runtimeDiagnostics = runtime.diagnostics;
    this.assertStartupAllowed();
    this.diagnosticTail = '';
    const argv = await resolveCodexAppServerArgv({
      executable,
      cwd: this.options.cwd,
      environment: this.options.environment,
      toolSettings: this.options.toolSettings,
      failClosedMcpDiscovery: this.options.failClosedMcpDiscovery,
      launch: runtime.compatibility.launch
    });
    this.assertStartupAllowed();

    const server = await this.store.createAgentServer({
      provider: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable,
      argv,
      runtimeVersion,
      schemaVersion: CODEX_PROTOCOL_RUNTIME_VERSION,
      schemaHash: CODEX_PROTOCOL_SCHEMA_HASH,
      runtimeResolution: codexRuntimeResolutionDiagnostics(runtime)
    });
    this.server = server;

    try {
      this.assertStartupAllowed();
      const child = spawnPortable(executable, argv, {
        cwd: this.options.cwd,
        env: sanitizeEnvironment(this.options.environment ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      }) as ChildProcessWithoutNullStreams;
      this.child = child;

      await waitForSpawn(child);
      this.assertStartupAllowed();
      await this.store.updateAgentServer(server.id, {
        status: 'RUNNING',
        pid: child.pid
      });
      this.assertStartupAllowed();

      const client = new CodexRpcClient(
        child.stdin,
        child.stdout,
        this.store,
        server.id,
        this.options.requestTimeoutMs
      );
      this.client = client;
      client.events.on('protocolError', (error) => {
        this.events.emit('protocolError', error);
        void this.failProtocol(error);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.diagnosticTail = `${this.diagnosticTail}${text}`.slice(-32_768);
        this.events.emit('diagnostic', text);
      });
      child.once('close', (exitCode, signal) => {
        const work = this.handleClose(child, server, exitCode, signal).finally(() => {
          if (this.closePromise === work) this.closePromise = undefined;
        });
        this.closePromise = work;
      });
      child.once('error', (error) => {
        this.events.emit('diagnostic', error.message);
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
      this.assertStartupAllowed();
      await client.notify('initialized', {});
      this.assertStartupAllowed();

      const ready = await this.store.updateAgentServer(server.id, {
        status: 'READY',
        initializedAt: new Date().toISOString(),
        lastHealthAt: new Date().toISOString()
      });
      this.assertStartupAllowed();
      this.server = ready;
      this.events.emit('ready', ready);
      return client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finalizeFailedStart(server.id, message);
      this.closeClient(message);
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        await terminatePortableProcessTree(child, 'SIGTERM');
        if (!(await waitForClose(child, 1_000))) {
          await terminatePortableProcessTree(child, 'SIGKILL');
          await waitForClose(child, 2_000);
        }
      }
      await this.closePromise;
      await this.disposeCurrentClient();
      if (this.child === child) this.child = undefined;
      throw error;
    }
  }

  private assertStartupAllowed(): void {
    if (this.shuttingDown) {
      throw new Error('Codex App Server is shutting down.');
    }
  }

  private async finalizeFailedStart(serverId: string, message: string): Promise<void> {
    try {
      const stored = await this.store.getAgentServer(serverId);
      if (!stored || isTerminalServerStatus(stored.status)) return;
      this.server = await this.store.updateAgentServer(serverId, {
        status: this.shuttingDown ? 'EXITED' : 'FAILED',
        exitedAt: new Date().toISOString(),
        exitReason: message
      });
    } catch {
      // Process close may have finalized the same server record concurrently.
    }
  }

  private async failProtocol(error: Error): Promise<void> {
    // Once an intentional shutdown owns the lifecycle, EOF or a final partial
    // frame must not race the close handler and reclassify that exit as a
    // protocol failure.
    if (this.shuttingDown) return;
    if (this.server) {
      const stored = await this.store.getAgentServer(this.server.id);
      if (stored) {
        this.server = stored;
      }
    }
    if (this.server && !isTerminalServerStatus(this.server.status)) {
      this.server = await this.store.updateAgentServer(this.server.id, {
        status: 'FAILED',
        exitReason: `Protocol error: ${error.message}`
      });
    }
    this.closeClient(`Protocol error: ${error.message}`);
    if (this.child) {
      await terminatePortableProcessTree(this.child, 'SIGTERM');
    }
  }

  private async handleClose(
    child: ChildProcessWithoutNullStreams,
    server: AgentServerInstance,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const unexpected = !this.shuttingDown;
    this.closeClient(
      unexpected ? 'Codex App Server exited unexpectedly.' : 'Codex App Server stopped.'
    );
    await this.disposeCurrentClient();
    if (this.child === child) this.child = undefined;

    const terminalStatus = unexpected && exitCode !== 0 ? 'FAILED' : 'EXITED';
    try {
      const stored = await this.store.updateAgentServer(server.id, {
        status: terminalStatus,
        exitedAt: new Date().toISOString(),
        exitCode,
        signal,
        exitReason: this.diagnosticTail.trim() || undefined
      });
      this.server = stored;
      this.events.emit('exit', stored, unexpected);
    } catch {
      // A protocol failure may have already finalized the same server record.
      this.events.emit('exit', server, unexpected);
    }
  }

  private hasLiveChild(): boolean {
    return Boolean(
      this.child && this.child.exitCode === null && this.child.signalCode === null
    );
  }

  private closeClient(reason: string): void {
    const client = this.client;
    if (!client) return;
    client.close(reason);
  }

  private async disposeCurrentClient(): Promise<void> {
    const client = this.client;
    if (!client) return;
    await client.drain();
    client.events.removeAllListeners();
    if (this.client === client) this.client = undefined;
  }
}

function isTerminalServerStatus(status: AgentServerInstance['status']): boolean {
  return status === 'FAILED' || status === 'EXITED' || status === 'LOST';
}

function codexRuntimeResolutionDiagnostics(
  runtime: ResolvedCodexRuntime
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
      detail: probe.detail
    }))
  };
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
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
