import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const [receiptPath, ownershipToken] = process.argv.slice(2);
const command = JSON.parse(process.env.TASK_MONKI_PREVIEW_COMMAND ?? '{}');
if (!receiptPath || !ownershipToken || !command.executable || !Array.isArray(command.argv)) {
  throw new Error('Native preview launcher received an invalid launch contract.');
}

let target;
let committed = false;
let stopping = false;
let terminalWritten = false;
let finalizing;
const logCounts = { stdout: 0, stderr: 0 };
const logWrites = { stdout: Promise.resolve(), stderr: Promise.resolve() };
const stopTimers = new Set();

await writeReceipt({
  version: 1,
  state: 'PREPARED',
  ownershipToken,
  launcherPid: process.pid,
  commandDigest: command.digest
});
process.send?.({ type: 'prepared', launcherPid: process.pid });

process.on('message', (message) => {
  if (message?.type === 'commit' && !committed) void commitLaunch();
  if (message?.type === 'stop') void stopTarget();
});
process.on('disconnect', () => void stopTarget());
process.on('SIGINT', () => void stopTarget());
process.on('SIGTERM', () => void stopTarget());

const commitTimer = setTimeout(async () => {
  if (committed) return;
  await writeTerminal({
    state: 'ABORTED',
    error: 'Owner did not commit launch before timeout.'
  });
  process.exit(2);
}, 5_000);
commitTimer.unref();

async function commitLaunch() {
  committed = true;
  clearTimeout(commitTimer);
  target = spawn(command.executable, command.argv, {
    cwd: command.cwd,
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  target.stdout?.on('data', (chunk) => void appendBounded('stdout', chunk));
  target.stderr?.on('data', (chunk) => void appendBounded('stderr', chunk));
  target.once('spawn', async () => {
    await writeReceipt(baseReceipt('RUNNING'));
    process.send?.({ type: 'started', targetPid: target.pid });
  });
  target.once('close', async (exitCode, signal) => {
    await finalizeTarget(exitCode, signal);
  });
  target.once('error', async (error) => {
    clearStopTimers();
    await Promise.allSettled(Object.values(logWrites));
    await writeTerminal({ state: 'FAILED', error: bounded(error.message) });
    process.send?.({ type: 'failed', error: bounded(error.message) });
    process.exit(1);
  });
}

async function stopTarget() {
  if (stopping) return;
  stopping = true;
  clearTimeout(commitTimer);
  if (!target) {
    await writeTerminal({ state: committed ? 'STOPPED' : 'ABORTED' });
    process.exit(0);
    return;
  }
  if (target.exitCode !== null || target.signalCode !== null) return;
  signalTarget('SIGINT');
  scheduleSignal('SIGTERM', 500);
  scheduleSignal('SIGKILL', 1_500);
  const forceExit = setTimeout(() => process.exit(3), 3_000);
  forceExit.unref();
  stopTimers.add(forceExit);
}

async function finalizeTarget(exitCode, signal) {
  if (finalizing) return finalizing;
  finalizing = (async () => {
    clearStopTimers();
    await Promise.allSettled(Object.values(logWrites));
    const groupClean = await cleanupRemainingTargetGroup();
    if (!groupClean) {
      await writeTerminal({
        state: 'FAILED',
        exitCode,
        signal,
        error: 'Target process group remained alive after bounded cleanup.'
      });
      process.send?.({ type: 'failed', error: 'Target process group cleanup failed.' });
      process.exit(1);
      return;
    }
    await writeTerminal({
      state: stopping ? 'STOPPED' : 'EXITED',
      exitCode,
      signal
    });
    process.send?.({ type: 'exited', exitCode, signal, stopped: stopping });
    process.exit(0);
  })();
  return finalizing;
}

async function cleanupRemainingTargetGroup() {
  if (process.platform === 'win32' || !target?.pid || !processGroupExists(target.pid)) return true;
  signalTarget('SIGTERM');
  if (await waitForGroupExit(target.pid, 750)) return true;
  signalTarget('SIGKILL');
  return waitForGroupExit(target.pid, 1_500);
}

function processGroupExists(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForGroupExit(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(groupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupExists(groupId);
}

function scheduleSignal(signal, delay) {
  const timer = setTimeout(() => signalTarget(signal), delay);
  timer.unref();
  stopTimers.add(timer);
}

function signalTarget(signal) {
  try {
    if (process.platform !== 'win32' && target?.pid) process.kill(-target.pid, signal);
    else target?.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function clearStopTimers() {
  for (const timer of stopTimers) clearTimeout(timer);
  stopTimers.clear();
}

async function appendBounded(stream, chunk) {
  logWrites[stream] = logWrites[stream].then(() => appendBoundedNow(stream, chunk));
  return logWrites[stream];
}

async function appendBoundedNow(stream, chunk) {
  const outputPath = stream === 'stdout' ? command.stdoutPath : command.stderrPath;
  if (!outputPath) return;
  const maxBytes = Number(command.maxLogBytes) || 262_144;
  if (logCounts[stream] >= maxBytes) return;
  const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = maxBytes - logCounts[stream];
  const marker = Buffer.from('\n[Task Monki preview log truncated]\n');
  const truncated = input.length > remaining;
  const output = truncated
    ? Buffer.concat([
        input.subarray(0, Math.max(0, remaining - marker.length)),
        marker.subarray(0, Math.min(marker.length, remaining))
      ])
    : input;
  logCounts[stream] += output.length;
  await fs.appendFile(outputPath, output, { mode: 0o600 });
}

function baseReceipt(state) {
  return {
    version: 1,
    state,
    ownershipToken,
    launcherPid: process.pid,
    targetPid: target?.pid,
    targetProcessGroupId: process.platform === 'win32' ? undefined : target?.pid,
    commandDigest: command.digest,
    targetCommand: [command.executable, ...command.argv]
  };
}

async function writeTerminal(extra) {
  if (terminalWritten) return;
  terminalWritten = true;
  await writeReceipt({ ...baseReceipt(extra.state), ...extra });
}

async function writeReceipt(value) {
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, receiptPath);
}

function bounded(value) {
  return String(value).slice(0, 512);
}
