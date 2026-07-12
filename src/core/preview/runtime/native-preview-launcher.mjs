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
let logError;
const logCounts = { stdout: 0, stderr: 0 };
const logWrites = { stdout: Promise.resolve(), stderr: Promise.resolve() };
const logCarry = { stdout: '', stderr: '' };
const redactions = Array.isArray(command.redactions)
  ? [...new Set(command.redactions.filter((value) => typeof value === 'string' && value.length > 0))]
      .sort((left, right) => right.length - left.length)
  : [];
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
  captureBoundedLog('stdout', target.stdout);
  captureBoundedLog('stderr', target.stderr);
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
    const reason = logError ?? bounded(error.message);
    await writeTerminal({ state: 'FAILED', error: reason });
    process.send?.({ type: 'failed', error: reason });
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
    if (logError) {
      await writeTerminal({ state: 'FAILED', exitCode, signal, error: logError });
      process.send?.({ type: 'failed', error: logError });
      process.exit(1);
      return;
    }
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

async function appendBounded(stream, chunk, final = false) {
  logWrites[stream] = logWrites[stream].then(() => appendBoundedNow(stream, chunk, final));
  return logWrites[stream];
}

function captureBoundedLog(stream, readable) {
  if (!readable) return;
  const onData = (chunk) => {
    readable.pause();
    void appendBounded(stream, chunk).then(
      () => {
        if (logCounts[stream] >= (Number(command.maxLogBytes) || 262_144)) {
          readable.off('data', onData);
        }
        readable.resume();
      },
      (error) => {
        logError = `Could not capture ${stream}: ${bounded(error?.message ?? error)}`;
        readable.off('data', onData);
        readable.resume();
        void stopTarget();
      }
    );
  };
  readable.on('data', onData);
  readable.once('end', () => {
    void appendBounded(stream, Buffer.alloc(0), true).catch((error) => {
      logError ??= `Could not finalize ${stream}: ${bounded(error?.message ?? error)}`;
    });
  });
}

async function appendBoundedNow(stream, chunk, final) {
  const outputPath = stream === 'stdout' ? command.stdoutPath : command.stderrPath;
  if (!outputPath) return;
  const maxBytes = Number(command.maxLogBytes) || 262_144;
  if (logCounts[stream] >= maxBytes) return;
  const input = redactLogChunk(stream, chunk, final);
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

function redactLogChunk(stream, chunk, final) {
  if (redactions.length === 0) return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const combined = logCarry[stream] + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  let carryLength = 0;
  if (!final) {
    for (const secret of redactions) {
      for (let length = Math.min(secret.length - 1, combined.length); length > carryLength; length -= 1) {
        if (combined.endsWith(secret.slice(0, length))) {
          carryLength = length;
          break;
        }
      }
    }
  }
  const ready = carryLength > 0 ? combined.slice(0, -carryLength) : combined;
  logCarry[stream] = carryLength > 0 ? combined.slice(-carryLength) : '';
  let redacted = ready;
  for (const secret of redactions) redacted = redacted.split(secret).join('[REDACTED]');
  return Buffer.from(redacted);
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
