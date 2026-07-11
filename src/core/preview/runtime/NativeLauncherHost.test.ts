import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeLauncherHost, readNativeLauncherReceipt } from './NativeLauncherHost';

const describeMac = process.platform === 'darwin' ? describe : describe.skip;
const launcherPath = path.join(
  process.cwd(),
  'src/core/preview/runtime/native-preview-launcher.mjs'
);

describeMac('NativeLauncherHost macOS ownership integration', () => {
  it('persists PREPARED identity before committing a job and captures bounded output', async () => {
    const fixture = await createFixture();
    let preparedPersisted = false;
    const owned = await fixture.host.launch({
      ...fixture.input,
      executable: process.execPath,
      argv: ['-e', `process.stdout.write('x'.repeat(4096)); process.stderr.write('error');`],
      maxLogBytes: 256,
      async persistPrepared(identity) {
        const receipt = await readNativeLauncherReceipt(identity.receiptPath);
        expect(receipt.state).toBe('PREPARED');
        expect(receipt.launcherPid).toBe(identity.launcher.pid);
        preparedPersisted = true;
      }
    });
    const receipt = await owned.completion;
    expect(preparedPersisted).toBe(true);
    expect(receipt).toMatchObject({ state: 'EXITED', exitCode: 0 });
    const stdout = await fs.readFile(fixture.stdoutPath, 'utf8');
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(256);
    expect(stdout).toContain('preview log truncated');
    await expect(fs.readFile(fixture.stderrPath, 'utf8')).resolves.toBe('error');
  });

  it('aborts before target spawn when durable PREPARED persistence fails', async () => {
    const fixture = await createFixture();
    const targetMarker = path.join(fixture.root, 'target-started');
    await expect(
      fixture.host.launch({
        ...fixture.input,
        executable: process.execPath,
        argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(targetMarker)}, 'yes')`],
        async persistPrepared() {
          throw new Error('Injected durable store failure.');
        }
      })
    ).rejects.toThrow('Injected durable store failure');
    await expect(fs.access(targetMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readNativeLauncherReceipt(fixture.receiptPath)).resolves.toMatchObject({
      state: 'ABORTED'
    });
  });

  it('uses owner IPC loss as a stop lease for the complete target process group', async () => {
    const fixture = await createFixture();
    const childPidPath = path.join(fixture.root, 'child.pid');
    const script = [
      `const { spawn } = require('node:child_process');`,
      `const fs = require('node:fs');`,
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);`,
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      `setInterval(() => {}, 1000);`
    ].join(' ');
    const owned = await fixture.host.launch({
      ...fixture.input,
      executable: process.execPath,
      argv: ['-e', script],
      async persistPrepared() {}
    });
    await waitForFile(childPidPath);
    const targetPid = owned.identity.target?.pid;
    const childPid = Number(await fs.readFile(childPidPath, 'utf8'));
    expect(targetPid).toBeTypeOf('number');

    const receipt = await owned.disconnectOwner();
    expect(receipt.state).toBe('STOPPED');
    await expectProcessMissing(targetPid!);
    await expectProcessMissing(childPid);
  });

  it('refuses substituted process identity and stops only the exact recorded owner', async () => {
    const fixture = await createFixture();
    const owned = await fixture.host.launch({
      ...fixture.input,
      executable: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      async persistPrepared() {}
    });
    const substituted = {
      ...owned.identity,
      launcher: { ...owned.identity.launcher, startedAt: 'substituted start identity' }
    };
    await expect(fixture.host.stopVerified(substituted)).resolves.toBe('REFUSED');
    expectProcessPresent(owned.identity.launcher.pid);
    await expect(fixture.host.stopVerified(owned.identity)).resolves.toBe('STOPPED');
  });

  it('runs the same launcher through the installed Electron binary in Node mode', async () => {
    const electronExec = path.join(
      process.cwd(),
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    );
    await fs.access(electronExec);
    const fixture = await createFixture(
      new NativeLauncherHost(launcherPath, electronExec, { ELECTRON_RUN_AS_NODE: '1' })
    );
    const owned = await fixture.host.launch({
      ...fixture.input,
      executable: process.execPath,
      argv: ['-e', 'process.stdout.write("electron-node-launcher")'],
      async persistPrepared() {}
    });
    await expect(owned.completion).resolves.toMatchObject({ state: 'EXITED', exitCode: 0 });
    await expect(fs.readFile(fixture.stdoutPath, 'utf8')).resolves.toBe('electron-node-launcher');
  });
});

async function createFixture(host = new NativeLauncherHost(launcherPath)) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-native-launcher-'));
  const receiptPath = path.join(root, 'runtime', 'ownership.json');
  const stdoutPath = path.join(root, 'stdout.log');
  const stderrPath = path.join(root, 'stderr.log');
  await fs.writeFile(stdoutPath, '', { mode: 0o600 });
  await fs.writeFile(stderrPath, '', { mode: 0o600 });
  return {
    root,
    host,
    receiptPath,
    stdoutPath,
    stderrPath,
    input: {
      receiptPath,
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdoutPath,
      stderrPath,
      persistPrepared: async () => {}
    }
  };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

function expectProcessPresent(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow();
}

async function expectProcessMissing(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
  }
  throw new Error(`Process ${pid} remained alive.`);
}
