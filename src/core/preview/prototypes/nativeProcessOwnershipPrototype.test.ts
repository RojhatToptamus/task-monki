import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectPrototypeProcessIdentity,
  launchPrototypeOwnedProcess,
  readPrototypeOwnershipReceipt,
  stopPrototypeProcessFromReceipt
} from './nativeProcessOwnershipPrototype';

const macIt = process.platform === 'darwin' ? it : it.skip;

describe('Phase 0 native process ownership prototype', () => {
  macIt('reconciles a crash after durable intent but before launcher spawn as no process', async () => {
    const receiptPath = await newReceiptPath();
    await fs.writeFile(
      receiptPath,
      `${JSON.stringify({
        version: 1,
        state: 'INTENT',
        ownershipToken: 'intent-only-token',
        commandDigest: 'intent-only-command'
      })}\n`,
      { mode: 0o600 }
    );

    await expect(
      stopPrototypeProcessFromReceipt(receiptPath, {
        pid: 999_999,
        processGroupId: 999_999,
        startedAt: 'never',
        command: 'never'
      })
    ).resolves.toBe('ALREADY_EXITED');
  });

  macIt('aborts before target spawn when persistence fails after launcher spawn', async () => {
    const receiptPath = await newReceiptPath();
    await expect(
      launchPrototypeOwnedProcess({
        receiptPath,
        executable: process.execPath,
        argv: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        persistPrepared() {
          throw new Error('Injected persistence failure after launcher spawn.');
        }
      })
    ).rejects.toThrow('Injected persistence failure');

    const receipt = await readPrototypeOwnershipReceipt(receiptPath);
    expect(receipt.state).toBe('ABORTED');
    expect(receipt.targetPid).toBeUndefined();
    if (receipt.launcherPid) {
      await expect(inspectPrototypeProcessIdentity(receipt.launcherPid)).rejects.toThrow();
    }
  });

  macIt('owner disconnect after commit makes the launcher stop the target group', async () => {
    const receiptPath = await newReceiptPath();
    const owned = await launchPrototypeOwnedProcess({
      receiptPath,
      executable: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd()
    });

    await expect(inspectPrototypeProcessIdentity(owned.targetPid)).resolves.toMatchObject({
      pid: owned.targetPid
    });
    await owned.disconnectOwner();
    await expect(waitUntilProcessMissing(owned.targetPid)).resolves.toBeUndefined();
    expect((await readPrototypeOwnershipReceipt(receiptPath)).state).toBe('STOPPED');
  });

  macIt('refuses a deliberately substituted process identity and accepts the exact receipt owner', async () => {
    const receiptPath = await newReceiptPath();
    const owned = await launchPrototypeOwnedProcess({
      receiptPath,
      executable: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd()
    });
    const substituted = {
      ...owned.launcherIdentity,
      startedAt: 'Thu Jan  1 00:00:00 1970'
    };

    await expect(stopPrototypeProcessFromReceipt(receiptPath, substituted)).resolves.toBe('REFUSED');
    await expect(inspectPrototypeProcessIdentity(owned.targetPid)).resolves.toBeTruthy();

    await expect(
      stopPrototypeProcessFromReceipt(receiptPath, owned.launcherIdentity)
    ).resolves.toBe('STOPPED');
    await expect(waitUntilProcessMissing(owned.targetPid)).resolves.toBeUndefined();
  });

  macIt('runs the launcher through the bundled Electron binary in Node mode', async () => {
    const electronExecutable = require('electron') as string;
    const receiptPath = await newReceiptPath();
    const owned = await launchPrototypeOwnedProcess({
      receiptPath,
      executable: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      launcherExecPath: electronExecutable,
      launcherEnv: { ELECTRON_RUN_AS_NODE: '1' }
    });

    expect(owned.launcherIdentity.command).toContain('Electron');
    await owned.stop();
    await expect(waitUntilProcessMissing(owned.targetPid)).resolves.toBeUndefined();
  });
});

async function newReceiptPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-owned-process-'));
  return path.join(root, 'ownership.json');
}

async function waitUntilProcessMissing(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
  }
  throw new Error(`Process ${pid} remained alive.`);
}
