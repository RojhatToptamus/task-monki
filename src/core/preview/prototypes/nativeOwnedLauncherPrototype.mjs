// Phase 0 prototype helper. It is not included in the production preview runtime.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const [receiptPath, ownershipToken] = process.argv.slice(2);
const command = JSON.parse(process.env.TASK_MONKI_PROTOTYPE_COMMAND ?? '{}');
let target;
let committed = false;
let stopping = false;

await writeReceipt({
  version: 1,
  state: 'PREPARED',
  ownershipToken,
  launcherPid: process.pid,
  commandDigest: command.digest
});
process.send?.({ type: 'prepared', launcherPid: process.pid });

process.on('message', async (message) => {
  if (message?.type === 'commit' && !committed) {
    committed = true;
    target = spawn(command.executable, command.argv, {
      cwd: command.cwd,
      env: command.env,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32'
    });
    target.once('spawn', async () => {
      await writeReceipt({
        version: 1,
        state: 'RUNNING',
        ownershipToken,
        launcherPid: process.pid,
        targetPid: target.pid,
        targetProcessGroupId: process.platform === 'win32' ? undefined : target.pid,
        commandDigest: command.digest
      });
      process.send?.({ type: 'started', targetPid: target.pid });
    });
    target.once('close', async (exitCode, signal) => {
      await writeReceipt({
        version: 1,
        state: stopping ? 'STOPPED' : 'EXITED',
        ownershipToken,
        launcherPid: process.pid,
        targetPid: target.pid,
        targetProcessGroupId: process.platform === 'win32' ? undefined : target.pid,
        commandDigest: command.digest,
        exitCode,
        signal
      });
      process.exit(0);
    });
    target.once('error', async (error) => {
      await writeReceipt({
        version: 1,
        state: 'FAILED',
        ownershipToken,
        launcherPid: process.pid,
        commandDigest: command.digest,
        error: error.message
      });
      process.exit(1);
    });
  }
  if (message?.type === 'stop') {
    await stopTarget();
  }
});

process.on('disconnect', () => {
  void stopTarget();
});

setTimeout(async () => {
  if (!committed) {
    await writeReceipt({
      version: 1,
      state: 'ABORTED',
      ownershipToken,
      launcherPid: process.pid,
      commandDigest: command.digest,
      error: 'Owner did not commit launch before timeout.'
    });
    process.exit(2);
  }
}, 5000).unref();

async function stopTarget() {
  if (stopping) return;
  stopping = true;
  if (!target || target.exitCode !== null || target.signalCode !== null) {
    await writeReceipt({
      version: 1,
      state: 'ABORTED',
      ownershipToken,
      launcherPid: process.pid,
      commandDigest: command.digest
    });
    process.exit(0);
    return;
  }
  signalTarget('SIGTERM');
  setTimeout(() => signalTarget('SIGKILL'), 750).unref();
}

function signalTarget(signal) {
  try {
    if (process.platform !== 'win32' && target?.pid) {
      process.kill(-target.pid, signal);
    } else {
      target?.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function writeReceipt(value) {
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.rename(temporary, receiptPath);
}

