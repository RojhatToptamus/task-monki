import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import {
  execFileOwnedPortable,
  resolveOwnedProcessLauncherPath
} from './ownedProcess';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('owned provider process crash recovery', () => {
  it('stops the exact target process group when its Task Monki owner is killed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-owner-crash-'));
    const pidFile = path.join(root, 'owned-pids.json');
    const launcherPath = path.join(
      process.cwd(),
      'src/core/process/owned-process-launcher.mjs'
    );
    const fixturePath = path.join(
      process.cwd(),
      'src/testSupport/ownedProcessCrashParent.mjs'
    );
    const owner = spawn(process.execPath, [fixturePath, launcherPath, pidFile], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let launcherPid: number | undefined;
    let ownedPids: { target: number; descendant: number } | undefined;

    try {
      launcherPid = await readLauncherPid(owner);
      ownedPids = await readOwnedPids(pidFile);
      expectProcessPresent(launcherPid);
      expectProcessPresent(ownedPids.target);
      expectProcessPresent(ownedPids.descendant);

      process.kill(owner.pid!, 'SIGKILL');
      await waitForExit(owner.pid!);
      await waitForExit(launcherPid);
      await waitForExit(ownedPids.target);
      await waitForExit(ownedPids.descendant);
    } finally {
      for (const pid of [
        owner.pid,
        launcherPid,
        ownedPids?.target,
        ownedPids?.descendant
      ]) {
        if (!pid) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('resolveOwnedProcessLauncherPath', () => {
  it('uses the packaged resource and the source launcher in development', () => {
    expect(
      resolveOwnedProcessLauncherPath({
        isPackaged: true,
        resourcesPath: '/app/Contents/Resources',
        appPath: '/app'
      })
    ).toBe(path.join('/app/Contents/Resources', 'owned-process-launcher.mjs'));
    expect(
      resolveOwnedProcessLauncherPath({
        isPackaged: false,
        resourcesPath: '/resources',
        appPath: '/project'
      })
    ).toBe(path.join('/project', 'src/core/process/owned-process-launcher.mjs'));
  });
});

describe('execFileOwnedPortable', () => {
  it.runIf(process.platform === 'win32')(
    'executes generated Windows cmd launchers through the owner process',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task monki owned cmd ')
      );
      const executable = await writeNodeExecutable(
        directory,
        'fake-owned-codex',
        "process.stdout.write(process.argv.slice(2).join('|') + '\\n');\n"
      );

      const { stdout } = await execFileOwnedPortable(
        executable,
        ['app-server', 'space arg'],
        {
          cwd: directory,
          env: { PATH: directory },
          timeout: 10_000
        }
      );

      expect(stdout.trim()).toBe('app-server|space arg');
    }
  );

  it('preserves missing-executable identity and failed-command diagnostics', async () => {
    await expect(
      execFileOwnedPortable(
        path.join(os.tmpdir(), 'task-monki-definitely-missing-executable'),
        [],
        {}
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const failure = await execFileOwnedPortable(
      process.execPath,
      ['-e', "process.stderr.write('owned diagnostic'); process.exit(9)"],
      {}
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('owned diagnostic');
    expect(failure).toMatchObject({
      code: 9,
      stderr: 'owned diagnostic'
    });
  });

  it('stops the owned target when an execution is aborted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-owned-abort-'));
    const pidFile = path.join(root, 'pid');
    const controller = new AbortController();
    const pending = execFileOwnedPortable(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 30000);`
      ],
      { signal: controller.signal }
    );

    try {
      const pid = await readPid(pidFile);
      controller.abort(new Error('Injected cancellation.'));
      await expect(pending).rejects.toThrow('Injected cancellation.');
      await waitForExit(pid);
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'force-kills the exact target group when it ignores graceful signals',
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-owned-force-kill-')
      );
      const pidFile = path.join(root, 'owned-pids.json');
      const controller = new AbortController();
      const pending = execFileOwnedPortable(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            "process.on('SIGINT', () => {});",
            "process.on('SIGTERM', () => {});",
            "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 30000);\"], { stdio: 'ignore' });",
            `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ target: process.pid, descendant: descendant.pid }));`,
            'setInterval(() => {}, 30000);'
          ].join('\n')
        ],
        { signal: controller.signal }
      );

      try {
        const pids = await readOwnedPids(pidFile);
        controller.abort(new Error('Injected forced cancellation.'));
        await expect(pending).rejects.toThrow('Injected forced cancellation.');
        await waitForExit(pids.target);
        await waitForExit(pids.descendant);
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    10_000
  );
});

function readLauncherPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const line = output.match(/^([^\r\n]+)[\r\n]/u)?.[1];
      if (!line) return;
      resolve((JSON.parse(line) as { launcher: number }).launcher);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      reject(new Error(chunk.toString('utf8')));
    });
    child.once('error', reject);
  });
}

async function readOwnedPids(
  pidFile: string
): Promise<{ target: number; descendant: number }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(pidFile, 'utf8');
      if (text.trim()) {
        return JSON.parse(text) as { target: number; descendant: number };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for owned process identities.');
}

function expectProcessPresent(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow();
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} remained alive after owner loss.`);
}

async function readPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return Number(await fs.readFile(pidFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the owned process PID.');
}
