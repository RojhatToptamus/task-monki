import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentRuntimeResolutionDiagnostics,
  AgentServerInstance,
  CodexExternalToolSettings
} from '../../../shared/agent';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
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
}): Promise<string[]> {
  const configOverrides = await resolveCodexExternalToolConfigOverrides({
    executable: input.executable,
    cwd: input.cwd,
    environment: input.environment,
    settings: input.toolSettings
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

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.client?.close('Codex App Server shut down.');
      return;
    }

    if (this.server) {
      const stored = await this.store.getAgentServer(this.server.id);
      if (stored) {
        this.server = stored;
      }
      if (!['EXITED', 'FAILED', 'LOST'].includes(this.server.status)) {
        await this.store.updateAgentServer(this.server.id, { status: 'STOPPING' });
      }
    }
    child.kill('SIGTERM');
    if (!(await waitForClose(child, 3_000))) {
      child.kill('SIGKILL');
      await waitForClose(child, 2_000);
    }
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
    this.client?.close(reason);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!(await waitForClose(child, 1_000))) {
        child.kill('SIGKILL');
      }
    }
  }

  private async startInternal(): Promise<CodexRpcClient> {
    const runtime = await resolveCodexRuntime({
      executable: this.options.executable,
      cwd: this.options.cwd,
      environment: this.options.environment,
      requestTimeoutMs: this.options.requestTimeoutMs
    });
    const executable = runtime.executable;
    const runtimeVersion = runtime.version;
    this.runtimeDiagnostics = runtime.diagnostics;
    this.shuttingDown = false;
    this.diagnosticTail = '';
    const argv = await resolveCodexAppServerArgv({
      executable,
      cwd: this.options.cwd,
      environment: this.options.environment,
      toolSettings: this.options.toolSettings,
      launch: runtime.compatibility.launch
    });

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
      const child = spawn(executable, argv, {
        cwd: this.options.cwd,
        env: sanitizeEnvironment(this.options.environment ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      }) as ChildProcessWithoutNullStreams;
      this.child = child;

      await waitForSpawn(child);
      await this.store.updateAgentServer(server.id, {
        status: 'RUNNING',
        pid: child.pid
      });

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
        void this.handleClose(exitCode, signal);
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
      await client.notify('initialized', {});

      const ready = await this.store.updateAgentServer(server.id, {
        status: 'READY',
        initializedAt: new Date().toISOString(),
        lastHealthAt: new Date().toISOString()
      });
      this.server = ready;
      this.events.emit('ready', ready);
      return client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.updateAgentServer(server.id, {
        status: 'FAILED',
        exitedAt: new Date().toISOString(),
        exitReason: message
      });
      this.client?.close(message);
      this.child?.kill('SIGTERM');
      throw error;
    }
  }

  private async failProtocol(error: Error): Promise<void> {
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
    this.client?.close(`Protocol error: ${error.message}`);
    this.child?.kill('SIGTERM');
  }

  private async handleClose(
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const server = this.server;
    const unexpected = !this.shuttingDown;
    this.client?.close(
      unexpected ? 'Codex App Server exited unexpectedly.' : 'Codex App Server stopped.'
    );
    this.client = undefined;
    this.child = undefined;

    if (!server) {
      return;
    }
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
    child.once('spawn', resolve);
    child.once('error', reject);
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
