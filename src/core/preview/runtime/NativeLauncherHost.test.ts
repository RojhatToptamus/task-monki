import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeLauncherHost, readNativeLauncherReceipt } from './NativeLauncherHost';

const describeMac = process.platform === 'darwin' ? describe : describe.skip;
const launcherPath = path.join(
  process.cwd(),
  'src/core/preview/runtime/native-preview-launcher.mjs'
);
const fixtureRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describeMac('NativeLauncherHost macOS ownership integration', () => {
  it('persists PREPARED identity before committing a job and captures bounded output', async () => {
    const fixture = await createFixture();
    let preparedPersisted = false;
    const owned = await fixture.host.launch({
      ...fixture.input,
      executable: process.execPath,
      argv: ['-e', `process.stdout.write('x'.repeat(16 * 1024 * 1024)); process.stderr.write('error');`],
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

  it('redacts runtime credentials from logs even when a secret crosses output chunks', async () => {
    const fixture = await createFixture();
    const password = 'credential-that-must-never-be-persisted';
    const url = `redis://:${password}@127.0.0.1:41000/0`;
    const owned = await fixture.host.launch({
      ...fixture.input,
      env: { ...fixture.input.env, PREVIEW_PASSWORD: password, PREVIEW_URL: url },
      executable: process.execPath,
      argv: ['-e', [
        'const value = process.env.PREVIEW_PASSWORD;',
        'process.stdout.write(value.slice(0, 12));',
        'setTimeout(() => { process.stdout.write(value.slice(12) + "\\n" + process.env.PREVIEW_URL); }, 10);'
      ].join(' ')],
      redactions: [url, password, encodeURIComponent(password)],
      async persistPrepared() {}
    });
    await expect(owned.completion).resolves.toMatchObject({ state: 'EXITED', exitCode: 0 });
    const output = await fs.readFile(fixture.stdoutPath, 'utf8');
    expect(output).not.toContain(password);
    expect(output).not.toContain(url);
    expect(output).toBe('[REDACTED]\n[REDACTED]');
    expect(JSON.stringify(await readNativeLauncherReceipt(fixture.receiptPath))).not.toContain(password);
  });

  it('keeps the host environment and launch contract out of the launcher environment', async () => {
    const fixture = await createFixture();
    const hostSecretKey = `TASK_MONKI_HOST_SECRET_${Date.now()}`;
    const hostSecret = 'host-secret-that-the-preview-must-not-inherit';
    const unrelatedCredential = 'credential-for-a-different-preview-recipient';
    const launcherEnvironmentPath = path.join(fixture.root, 'launcher-environment.txt');
    process.env[hostSecretKey] = hostSecret;
    try {
      const script = [
        `const { execFileSync } = require('node:child_process');`,
        `const fs = require('node:fs');`,
        `const output = execFileSync('/bin/ps', ['eww', '-p', String(process.ppid)], { encoding: 'utf8' });`,
        `fs.writeFileSync(${JSON.stringify(launcherEnvironmentPath)}, output);`
      ].join(' ');
      const owned = await fixture.host.launch({
        ...fixture.input,
        executable: process.execPath,
        argv: ['-e', script],
        redactions: [unrelatedCredential],
        async persistPrepared() {}
      });
      await expect(owned.completion).resolves.toMatchObject({ state: 'EXITED', exitCode: 0 });
    } finally {
      delete process.env[hostSecretKey];
    }

    const launcherEnvironment = await fs.readFile(launcherEnvironmentPath, 'utf8');
    expect(launcherEnvironment).not.toContain(hostSecretKey);
    expect(launcherEnvironment).not.toContain(hostSecret);
    expect(launcherEnvironment).not.toContain(unrelatedCredential);
    expect(launcherEnvironment).not.toContain('TASK_MONKI_PREVIEW_COMMAND');
  });

  it('fails the owned launch cleanly when bounded log capture cannot write', async () => {
    const fixture = await createFixture();
    const owned = await fixture.host.launch({
      ...fixture.input,
      stdoutPath: fixture.root,
      executable: process.execPath,
      argv: ['-e', `process.stdout.write('output'); setTimeout(() => {}, 1000);`],
      async persistPrepared() {}
    });
    await expect(owned.completion).resolves.toMatchObject({
      state: 'FAILED',
      error: expect.stringContaining('Could not capture stdout')
    });
  });

  it('accepts a successful target that exits before its process identity can be inspected', async () => {
    const fixture = await createFixture();
    const owned = await fixture.host.launch({
      ...fixture.input,
      executable: '/usr/bin/printf',
      argv: ['fast-exit'],
      async persistPrepared() {}
    });
    await expect(owned.completion).resolves.toMatchObject({ state: 'EXITED', exitCode: 0 });
    await expect(fs.readFile(fixture.stdoutPath, 'utf8')).resolves.toBe('fast-exit');
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

  it('cleans the remaining target group when its leader exits normally', async () => {
    const fixture = await createFixture();
    const childPidPath = path.join(fixture.root, 'normal-exit-child.pid');
    const script = [
      `const { spawn } = require('node:child_process');`,
      `const fs = require('node:fs');`,
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      `child.unref();`
    ].join(' ');
    const owned = await fixture.host.launch({
      ...fixture.input,
      executable: process.execPath,
      argv: ['-e', script],
      async persistPrepared() {}
    });
    await waitForFile(childPidPath);
    const childPid = Number(await fs.readFile(childPidPath, 'utf8'));
    await expect(owned.completion).resolves.toMatchObject({ state: 'EXITED', exitCode: 0 });
    await expectProcessMissing(childPid);
  }, 15_000);

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

  it('refuses to signal a surviving recorded group when its target leader identity is gone', async () => {
    const fixture = await createFixture();
    const childPidPath = path.join(fixture.root, 'recovery-child.pid');
    const leader = spawn(
      process.execPath,
      [
        '-e',
        [
          `const { spawn } = require('node:child_process');`,
          `const fs = require('node:fs');`,
          `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
          `child.unref();`
        ].join(' ')
      ],
      { detached: true, stdio: 'ignore' }
    );
    const groupId = leader.pid!;
    let childPid: number | undefined;
    leader.unref();
    try {
      await waitForFile(childPidPath);
      childPid = Number(await fs.readFile(childPidPath, 'utf8'));
      await expectProcessMissing(groupId);
      const expected = {
        receiptPath: fixture.receiptPath,
        ownershipToken: 'recovery-token',
        commandDigest: 'recovery-digest',
        launcher: {
          pid: 999_999_991,
          processGroupId: 999_999_991,
          startedAt: 'missing',
          command: 'missing recovery-token'
        },
        target: {
          pid: groupId,
          processGroupId: groupId,
          startedAt: 'gone',
          command: 'gone'
        }
      };
      await fs.mkdir(path.dirname(fixture.receiptPath), { recursive: true });
      await fs.writeFile(
        fixture.receiptPath,
        JSON.stringify({
          version: 1,
          state: 'RUNNING',
          ownershipToken: expected.ownershipToken,
          launcherPid: expected.launcher.pid,
          targetPid: groupId,
          targetProcessGroupId: groupId,
          commandDigest: expected.commandDigest
        })
      );
      await expect(fixture.host.stopVerified(expected)).resolves.toBe('REFUSED');
      expectProcessPresent(childPid);
    } finally {
      try {
        process.kill(-groupId, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      if (childPid) await expectProcessMissing(childPid);
    }
  }, 10_000);

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
  fixtureRoots.push(root);
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
