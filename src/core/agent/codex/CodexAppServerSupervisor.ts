import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentServerInstance } from '../../../shared/agent';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import { CodexRpcClient } from './CodexRpcClient';
import {
  CODEX_PROTOCOL_MAXIMUM_TESTED_RUNTIME_VERSION,
  CODEX_PROTOCOL_RUNTIME_VERSION,
  CODEX_PROTOCOL_SCHEMA_HASH
} from './protocol/metadata';

const execFileAsync = promisify(execFile);

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
}

export class CodexAppServerSupervisor {
  readonly events = new EventEmitter<SupervisorEvents>();

  private child?: ChildProcessWithoutNullStreams;
  private client?: CodexRpcClient;
  private server?: AgentServerInstance;
  private startPromise?: Promise<CodexRpcClient>;
  private shuttingDown = false;
  private diagnosticTail = '';
  private compatibilityWarning?: string;

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

  get runtimeCompatibilityWarning(): string | undefined {
    return this.compatibilityWarning;
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
    const executable = this.options.executable ?? 'codex';
    const runtimeVersion = await probeCodexVersion(executable, this.options.cwd);
    this.compatibilityWarning = validateRuntimeVersion(runtimeVersion);
    this.shuttingDown = false;
    this.diagnosticTail = '';

    const server = await this.store.createAgentServer({
      provider: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable,
      argv: ['app-server', '--stdio'],
      runtimeVersion,
      schemaVersion: CODEX_PROTOCOL_RUNTIME_VERSION,
      schemaHash: CODEX_PROTOCOL_SCHEMA_HASH
    });
    this.server = server;

    try {
      const child = spawn(executable, ['app-server', '--stdio'], {
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
        capabilities: null
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

export async function probeCodexVersion(executable: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(executable, ['--version'], {
    cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  const match = CODEX_VERSION_OUTPUT_PATTERN.exec(stdout);
  if (!match) {
    throw new Error(`Could not parse Codex runtime version from: ${stdout.trim()}`);
  }
  return match[1];
}

export function validateRuntimeVersion(runtimeVersion: string): string | undefined {
  const comparison = compareVersions(runtimeVersion, CODEX_PROTOCOL_RUNTIME_VERSION);
  if (comparison < 0) {
    throw new Error(
      `Codex ${runtimeVersion} is unsupported. Install ${CODEX_PROTOCOL_RUNTIME_VERSION} or newer.`
    );
  }
  const testedComparison = compareVersions(
    runtimeVersion,
    CODEX_PROTOCOL_MAXIMUM_TESTED_RUNTIME_VERSION
  );
  if (testedComparison > 0) {
    return (
      `Codex ${runtimeVersion} is newer than Task Monki's maximum tested runtime ` +
      `${CODEX_PROTOCOL_MAXIMUM_TESTED_RUNTIME_VERSION}; Task Monki will use ` +
      `stable compatibility mode with generated protocol ${CODEX_PROTOCOL_RUNTIME_VERSION}.`
    );
  }
  return undefined;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_VERSION_SOURCE =
  '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)' +
  '(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?' +
  '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';

const CODEX_VERSION_OUTPUT_PATTERN = new RegExp(
  `codex(?:-cli)?\\s+(${SEMVER_VERSION_SOURCE})(?:\\s|$)`
);

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    const difference = a[key] - b[key];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function parseSemver(version: string): ParsedSemver {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(
      `Invalid Codex runtime version "${version}". Expected semantic version ` +
        'major.minor.patch with optional prerelease/build metadata.'
    );
  }
  const prerelease = match[4]?.split('.') ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(
        `Invalid Codex runtime version "${version}". Prerelease numeric ` +
          'identifiers must not contain leading zeroes.'
      );
    }
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    if (a === b) {
      continue;
    }
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      return Math.sign(Number.parseInt(a, 10) - Number.parseInt(b, 10));
    }
    if (aNumeric) {
      return -1;
    }
    if (bNumeric) {
      return 1;
    }
    return a < b ? -1 : 1;
  }
  return 0;
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
