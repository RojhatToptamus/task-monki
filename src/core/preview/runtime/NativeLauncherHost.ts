import { createHash, randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  PreviewNativeProcessIdentity,
  PreviewProcessIdentity
} from '../../../shared/contracts';
import { execFilePortable } from '../../process/portableChildProcess';

export interface NativeLauncherReceipt {
  version: 1;
  state: 'INTENT' | 'PREPARED' | 'RUNNING' | 'STOPPED' | 'EXITED' | 'FAILED' | 'ABORTED';
  ownershipToken: string;
  launcherPid?: number;
  targetPid?: number;
  targetProcessGroupId?: number;
  commandDigest: string;
  targetCommand?: string[];
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}

export interface NativeOwnedProcess {
  identity: PreviewNativeProcessIdentity;
  completion: Promise<NativeLauncherReceipt>;
  stop(): Promise<NativeLauncherReceipt>;
  disconnectOwner(): Promise<NativeLauncherReceipt>;
}

export interface NativeLaunchInput {
  receiptPath: string;
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  maxLogBytes?: number;
  redactions?: string[];
  persistPrepared(identity: PreviewNativeProcessIdentity): Promise<void>;
  persistStarted?(identity: PreviewNativeProcessIdentity): Promise<void>;
}

interface NativeLaunchContract {
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  maxLogBytes: number;
  redactions: string[];
  digest: string;
}

export interface ProcessIdentityInspector {
  inspect(pid: number): Promise<PreviewProcessIdentity>;
}

export class MacProcessIdentityInspector implements ProcessIdentityInspector {
  async inspect(pid: number): Promise<PreviewProcessIdentity> {
    if (process.platform !== 'darwin') {
      throw new Error('Native preview process ownership is supported on macOS only.');
    }
    const { stdout } = await execFilePortable(
      '/bin/ps',
      ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='],
      { timeout: 2_000, maxBuffer: 64 * 1024 }
    );
    const fields = stdout.trim().split(/\s+/);
    if (fields.length < 8) throw new Error(`Process not found: ${pid}`);
    return {
      pid: Number(fields[0]),
      processGroupId: Number(fields[1]),
      startedAt: fields.slice(2, 7).join(' '),
      command: fields.slice(7).join(' ')
    };
  }
}

export class NativeLauncherHost {
  constructor(
    private readonly launcherPath: string,
    private readonly launcherExecPath = process.execPath,
    private readonly launcherEnv: NodeJS.ProcessEnv = {},
    private readonly inspector: ProcessIdentityInspector = new MacProcessIdentityInspector()
  ) {}

  async launch(input: NativeLaunchInput): Promise<NativeOwnedProcess> {
    const ownershipToken = randomBytes(24).toString('hex');
    const commandDigest = digestCommand(input.executable, input.argv, input.cwd);
    await writeReceipt(input.receiptPath, {
      version: 1,
      state: 'INTENT',
      ownershipToken,
      commandDigest
    });

    const launcher = fork(this.launcherPath, [input.receiptPath, ownershipToken], {
      detached: process.platform !== 'win32',
      silent: true,
      execPath: this.launcherExecPath,
      env: { ...this.launcherEnv }
    });
    launcher.stdout?.resume();
    launcher.stderr?.resume();
    const completion = completionReceipt(launcher, input.receiptPath);

    try {
      const [prepared] = await Promise.all([
        waitForMessage(launcher, 'prepared'),
        sendMessage(launcher, {
          type: 'configure',
          ownershipToken,
          command: {
            executable: input.executable,
            argv: input.argv,
            cwd: input.cwd,
            env: input.env,
            stdoutPath: input.stdoutPath,
            stderrPath: input.stderrPath,
            maxLogBytes: input.maxLogBytes ?? 256 * 1024,
            redactions: input.redactions ?? [],
            digest: commandDigest
          } satisfies NativeLaunchContract
        })
      ]);
      const launcherIdentity = await this.inspector.inspect(prepared.launcherPid);
      if (!launcherIdentity.command.includes(ownershipToken)) {
        throw new Error('Native launcher identity does not contain its ownership token.');
      }
      let identity: PreviewNativeProcessIdentity = {
        receiptPath: input.receiptPath,
        ownershipToken,
        commandDigest,
        launcher: launcherIdentity
      };
      await input.persistPrepared(identity);
      launcher.send?.({ type: 'commit' });
      const started = await waitForMessage(launcher, 'started');
      const target = await this.inspector.inspect(started.targetPid).catch(async (error) => {
        const receipt = await completion;
        if (['EXITED', 'STOPPED', 'FAILED'].includes(receipt.state)) return undefined;
        throw error;
      });
      if (target) {
        identity = { ...identity, target };
        await input.persistStarted?.(identity);
      }

      const ensureStopped = async (receipt: NativeLauncherReceipt) => {
        if (!['STOPPED', 'ABORTED', 'EXITED'].includes(receipt.state)) {
          throw new Error(`Native launcher did not confirm target shutdown: ${receipt.state}.`);
        }
        if (identity.target) await waitUntilMissing(identity.target.pid, 4_000);
        return receipt;
      };

      return {
        identity,
        completion,
        async stop() {
          if (launcher.connected) launcher.send?.({ type: 'stop' });
          return ensureStopped(await completion);
        },
        async disconnectOwner() {
          if (launcher.connected) launcher.disconnect();
          return ensureStopped(await completion);
        }
      };
    } catch (error) {
      if (launcher.connected) launcher.disconnect();
      await completion.catch(() => undefined);
      throw error;
    }
  }

  async stopVerified(
    expected: PreviewNativeProcessIdentity
  ): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    const receipt = await readReceipt(expected.receiptPath);
    if (
      receipt.version !== 1 ||
      receipt.ownershipToken !== expected.ownershipToken ||
      receipt.commandDigest !== expected.commandDigest ||
      receipt.launcherPid !== expected.launcher.pid
    ) {
      return 'REFUSED';
    }

    const launcherActual = await this.inspector.inspect(expected.launcher.pid).catch(() => undefined);
    if (launcherActual) {
      if (
        !sameIdentity(launcherActual, expected.launcher) ||
        !launcherActual.command.includes(expected.ownershipToken)
      ) {
        return 'REFUSED';
      }
      signalProcess(expected.launcher.pid, 'SIGTERM');
      await waitUntilMissing(expected.launcher.pid, 4_000);
      if (expected.target) await waitUntilMissing(expected.target.pid, 4_000);
      return 'STOPPED';
    }

    if (!expected.target) return 'ALREADY_EXITED';
    const targetActual = await this.inspector.inspect(expected.target.pid).catch(() => undefined);
    if (!targetActual) {
      return processGroupExists(expected.target.processGroupId) ? 'REFUSED' : 'ALREADY_EXITED';
    }
    if (
      receipt.targetPid !== expected.target.pid ||
      receipt.targetProcessGroupId !== expected.target.processGroupId ||
      !sameIdentity(targetActual, expected.target)
    ) {
      return 'REFUSED';
    }
    signalGroup(expected.target.processGroupId, 'SIGTERM');
    await waitUntilGroupMissing(expected.target.processGroupId, 4_000);
    return 'STOPPED';
  }

  async inspectUnverifiedReceipt(
    receiptPath: string
  ): Promise<'NO_PROCESS_OBSERVED' | 'AMBIGUOUS_PROCESS'> {
    let receipt: NativeLauncherReceipt;
    try {
      receipt = await readReceipt(receiptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'NO_PROCESS_OBSERVED';
      return 'AMBIGUOUS_PROCESS';
    }
    const pids = [receipt.launcherPid, receipt.targetPid].filter(
      (pid): pid is number => typeof pid === 'number'
    );
    for (const pid of pids) {
      if (await this.inspector.inspect(pid).then(() => true).catch(() => false)) {
        return 'AMBIGUOUS_PROCESS';
      }
    }
    return 'NO_PROCESS_OBSERVED';
  }
}

export function digestCommand(executable: string, argv: string[], cwd: string): string {
  return createHash('sha256').update(JSON.stringify({ executable, argv, cwd })).digest('hex');
}

export async function readNativeLauncherReceipt(receiptPath: string): Promise<NativeLauncherReceipt> {
  return readReceipt(receiptPath);
}

function sameIdentity(actual: PreviewProcessIdentity, expected: PreviewProcessIdentity): boolean {
  return (
    actual.pid === expected.pid &&
    actual.processGroupId === expected.processGroupId &&
    actual.startedAt === expected.startedAt &&
    actual.command === expected.command
  );
}

function sendMessage(child: ChildProcess, message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.send) {
      reject(new Error('Native launcher owner IPC is unavailable.'));
      return;
    }
    child.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForMessage(
  child: ChildProcess,
  type: 'prepared'
): Promise<{ type: 'prepared'; launcherPid: number }>;
function waitForMessage(
  child: ChildProcess,
  type: 'started'
): Promise<{ type: 'started'; targetPid: number }>;
function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}.`)), 8_000);
    const onMessage = (message: Record<string, any>) => {
      if (message?.type === type) finish(undefined, message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Native launcher exited before ${type}: ${code ?? signal}`));
    };
    const onError = (error: Error) => finish(error);
    function finish(error?: Error, value?: Record<string, any>) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(value ?? {});
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function completionReceipt(child: ChildProcess, receiptPath: string): Promise<NativeLauncherReceipt> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', async () => {
      try {
        resolve(await readReceipt(receiptPath));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function writeReceipt(receiptPath: string, receipt: NativeLauncherReceipt): Promise<void> {
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, receiptPath);
}

async function readReceipt(receiptPath: string): Promise<NativeLauncherReceipt> {
  return JSON.parse(await fs.readFile(receiptPath, 'utf8')) as NativeLauncherReceipt;
}

function signalGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitUntilMissing(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms.`);
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function waitUntilGroupMissing(groupId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(groupId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process group ${groupId} did not exit within ${timeoutMs}ms.`);
}
