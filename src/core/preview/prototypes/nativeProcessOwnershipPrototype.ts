/**
 * Phase 0 prototype only. This tests a pre-commit launcher handshake and is not
 * wired into the production process supervisor.
 */
import { createHash, randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFilePortable } from '../../process/portableChildProcess';

export interface PrototypeProcessIdentity {
  pid: number;
  processGroupId: number;
  startedAt: string;
  command: string;
}

export interface PrototypeOwnershipReceipt {
  version: 1;
  state: 'INTENT' | 'PREPARED' | 'RUNNING' | 'STOPPED' | 'EXITED' | 'FAILED' | 'ABORTED';
  ownershipToken: string;
  launcherPid?: number;
  targetPid?: number;
  targetProcessGroupId?: number;
  commandDigest: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface PrototypeOwnedProcess {
  launcher: ChildProcess;
  receiptPath: string;
  ownershipToken: string;
  launcherIdentity: PrototypeProcessIdentity;
  targetPid: number;
  disconnectOwner(): Promise<void>;
  stop(): Promise<void>;
}

export interface LaunchPrototypeOwnedProcessOptions {
  receiptPath: string;
  executable: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  launcherExecPath?: string;
  launcherEnv?: NodeJS.ProcessEnv;
  persistPrepared?(identity: PrototypeProcessIdentity): Promise<void> | void;
}

export async function launchPrototypeOwnedProcess(
  options: LaunchPrototypeOwnedProcessOptions
): Promise<PrototypeOwnedProcess> {
  const ownershipToken = randomBytes(24).toString('hex');
  const commandDigest = createHash('sha256')
    .update(JSON.stringify({
      executable: options.executable,
      argv: options.argv,
      cwd: options.cwd
    }))
    .digest('hex');
  await writeReceipt(options.receiptPath, {
    version: 1,
    state: 'INTENT',
    ownershipToken,
    commandDigest
  });

  const launcher = fork(
    path.join(__dirname, 'nativeOwnedLauncherPrototype.mjs'),
    [options.receiptPath, ownershipToken],
    {
      detached: process.platform !== 'win32',
      silent: true,
      execPath: options.launcherExecPath,
      env: {
        ...process.env,
        ...options.launcherEnv,
        TASK_MONKI_PROTOTYPE_COMMAND: JSON.stringify({
          executable: options.executable,
          argv: options.argv,
          cwd: options.cwd,
          env: options.env ?? process.env,
          digest: commandDigest
        })
      }
    }
  );

  try {
    const prepared = await waitForMessage(launcher, 'prepared');
    const launcherIdentity = await inspectPrototypeProcessIdentity(prepared.launcherPid);
    if (!launcherIdentity.command.includes(ownershipToken)) {
      throw new Error('Launcher command does not contain the ownership token.');
    }
    await options.persistPrepared?.(launcherIdentity);
    launcher.send?.({ type: 'commit' });
    const started = await waitForMessage(launcher, 'started');

    return {
      launcher,
      receiptPath: options.receiptPath,
      ownershipToken,
      launcherIdentity,
      targetPid: started.targetPid,
      async disconnectOwner() {
        launcher.disconnect();
        await waitForExit(launcher);
      },
      async stop() {
        if (launcher.connected) {
          launcher.send?.({ type: 'stop' });
        }
        await waitForExit(launcher);
      }
    };
  } catch (error) {
    launcher.disconnect();
    await waitForExit(launcher).catch(() => undefined);
    throw error;
  }
}

export async function stopPrototypeProcessFromReceipt(
  receiptPath: string,
  expectedLauncher: PrototypeProcessIdentity
): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
  const receipt = await readReceipt(receiptPath);
  if (!receipt.launcherPid) {
    return 'ALREADY_EXITED';
  }
  const actual = await inspectPrototypeProcessIdentity(receipt.launcherPid).catch(() => undefined);
  if (!actual) {
    return 'ALREADY_EXITED';
  }
  if (
    !sameIdentity(actual, expectedLauncher) ||
    !actual.command.includes(receipt.ownershipToken)
  ) {
    return 'REFUSED';
  }

  if (receipt.targetProcessGroupId) {
    signalGroup(receipt.targetProcessGroupId, 'SIGTERM');
  }
  signalProcess(receipt.launcherPid, 'SIGTERM');
  await waitUntilMissing(receipt.launcherPid, 2000);
  if (receipt.targetPid) {
    await waitUntilMissing(receipt.targetPid, 2000);
  }
  return 'STOPPED';
}

export async function inspectPrototypeProcessIdentity(
  pid: number
): Promise<PrototypeProcessIdentity> {
  if (process.platform !== 'darwin') {
    throw new Error('Phase 0 process identity prototype currently supports macOS only.');
  }
  const { stdout } = await execFilePortable(
    '/bin/ps',
    ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='],
    { timeout: 2000, maxBuffer: 64 * 1024 }
  );
  const fields = stdout.trim().split(/\s+/);
  if (fields.length < 8) {
    throw new Error(`Process not found: ${pid}`);
  }
  return {
    pid: Number(fields[0]),
    processGroupId: Number(fields[1]),
    startedAt: fields.slice(2, 7).join(' '),
    command: fields.slice(7).join(' ')
  };
}

export async function readPrototypeOwnershipReceipt(
  receiptPath: string
): Promise<PrototypeOwnershipReceipt> {
  return readReceipt(receiptPath);
}

function sameIdentity(
  actual: PrototypeProcessIdentity,
  expected: PrototypeProcessIdentity
): boolean {
  return (
    actual.pid === expected.pid &&
    actual.processGroupId === expected.processGroupId &&
    actual.startedAt === expected.startedAt &&
    actual.command === expected.command
  );
}

async function writeReceipt(
  receiptPath: string,
  receipt: PrototypeOwnershipReceipt
): Promise<void> {
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.rename(temporary, receiptPath);
}

async function readReceipt(receiptPath: string): Promise<PrototypeOwnershipReceipt> {
  return JSON.parse(await fs.readFile(receiptPath, 'utf8')) as PrototypeOwnershipReceipt;
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
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}.`)), 5000);
    const onMessage = (message: Record<string, any>) => {
      if (message?.type === type) {
        finish(undefined, message);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Launcher exited before ${type}: ${code ?? signal}`));
    };
    const finish = (error?: Error, value?: Record<string, any>) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value ?? {});
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', () => resolve()));
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
