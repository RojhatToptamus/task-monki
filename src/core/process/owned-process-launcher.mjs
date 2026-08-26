import { spawn } from 'node:child_process';

const CONFIGURE_TIMEOUT_MS = 5_000;
const STOP_TIMEOUTS_MS = [0, 750, 2_000];
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL'];

let target;
let stopping = false;
let configured = false;
let targetClosed = false;
const stopTimers = new Set();

const configureTimer = setTimeout(() => {
  process.stderr.write('Owned process launcher did not receive a launch contract.\n');
  process.exit(2);
}, CONFIGURE_TIMEOUT_MS);
configureTimer.unref();

process.on('message', (message) => {
  if (configured || message?.type !== 'configure') return;
  const command = message.command;
  if (
    !command ||
    typeof command.executable !== 'string' ||
    !Array.isArray(command.argv) ||
    typeof command.cwd !== 'string' ||
    !command.env ||
    typeof command.env !== 'object' ||
    (command.windowsVerbatimArguments !== undefined &&
      command.windowsVerbatimArguments !== true)
  ) {
    process.stderr.write('Owned process launcher received an invalid launch contract.\n');
    process.exit(2);
    return;
  }
  configured = true;
  clearTimeout(configureTimer);
  launch(command);
});

process.on('disconnect', () => void stopTarget());
process.on('SIGINT', () => void stopTarget());
process.on('SIGTERM', () => void stopTarget());

function launch(command) {
  target = spawn(command.executable, command.argv, {
    cwd: command.cwd,
    env: command.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments === true
  });
  process.stdin.pipe(target.stdin);
  target.stdout.pipe(process.stdout);
  target.stderr.pipe(process.stderr);
  target.once('spawn', () => {
    process.send?.({ type: 'target-spawned', pid: target.pid });
  });
  target.once('error', (error) => {
    process.send?.({
      type: 'target-error',
      error: {
        message: error.message,
        code: error.code,
        path: error.path,
        syscall: error.syscall
      }
    });
    process.stderr.write(`${error.message}\n`);
  });
  target.once('close', (exitCode, signal) => {
    targetClosed = true;
    void finishTarget(exitCode, signal);
  });
}

async function stopTarget() {
  if (stopping) return;
  stopping = true;
  clearTimeout(configureTimer);
  if (!target) {
    process.exit(0);
    return;
  }
  if (targetClosed || target.exitCode !== null || target.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    await terminateWindowsTree(target.pid);
    return;
  }
  for (let index = 0; index < STOP_SIGNALS.length; index += 1) {
    const timer = setTimeout(
      () => signalTargetGroup(STOP_SIGNALS[index]),
      STOP_TIMEOUTS_MS[index]
    );
    timer.unref();
    stopTimers.add(timer);
  }
}

async function finishTarget(exitCode, signal) {
  clearStopTimers();
  if (process.platform !== 'win32' && target?.pid) {
    const groupClean = await cleanupTargetGroup(target.pid);
    if (!groupClean) {
      process.stderr.write('Owned target process group remained alive after cleanup.\n');
      process.exit(3);
      return;
    }
  }
  if (stopping) {
    process.exit(0);
    return;
  }
  if (signal && typeof signal === 'string') {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(exitCode ?? 1);
}

async function cleanupTargetGroup(groupId) {
  if (!processGroupExists(groupId)) return true;
  signalTargetGroup('SIGINT');
  if (await waitForGroupExit(groupId, 750)) return true;
  signalTargetGroup('SIGTERM');
  if (await waitForGroupExit(groupId, 750)) return true;
  signalTargetGroup('SIGKILL');
  return waitForGroupExit(groupId, 1_500);
}

function signalTargetGroup(signal) {
  if (!target?.pid) return;
  try {
    process.kill(-target.pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    if (error?.code === 'EPERM') {
      target.kill(signal);
      return;
    }
    throw error;
  }
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

async function terminateWindowsTree(pid) {
  if (!pid) {
    process.exit(0);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const taskkill = `${systemRoot}\\System32\\taskkill.exe`;
  const killer = spawn(taskkill, ['/pid', String(pid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true
  });
  const timer = setTimeout(() => {
    target?.kill('SIGKILL');
  }, 2_000);
  timer.unref();
  killer.once('close', () => {
    clearTimeout(timer);
    if (!targetClosed) target?.kill('SIGKILL');
  });
  killer.once('error', () => {
    clearTimeout(timer);
    target?.kill('SIGKILL');
  });
}

function clearStopTimers() {
  for (const timer of stopTimers) clearTimeout(timer);
  stopTimers.clear();
}
