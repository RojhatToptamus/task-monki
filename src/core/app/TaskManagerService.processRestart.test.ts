import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('TaskManagerService real process restart', () => {
  it('reclaims the crashed store owner and adopts Git-completed work without duplicating the worktree', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-real-restart-')
    );
    const fixture = path.join(
      process.cwd(),
      'src/testSupport/taskManagerRestartProcess.ts'
    );
    const runner = path.join(process.cwd(), 'node_modules/.bin/vite-node');
    const first = spawn(runner, ['--script', fixture, 'prepare', root], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
      const prepared = await readJsonLine<{
        ready: true;
        taskId: string;
        worktreeId: string;
        headSha: string;
      }>(first);
      process.kill(first.pid!, 'SIGKILL');
      await waitForClose(first);

      const recoveredProcess = spawn(
        runner,
        ['--script', fixture, 'recover', root],
        {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
      const recovered = await readJsonLine<{
        taskId: string;
        worktreeId: string;
        worktreeStatus: string;
        headSha: string;
        registeredPaths: string[];
      }>(recoveredProcess);
      await expectProcessSuccess(recoveredProcess);

      expect(recovered).toMatchObject({
        taskId: prepared.taskId,
        worktreeId: prepared.worktreeId,
        worktreeStatus: 'PRESENT',
        headSha: prepared.headSha
      });
      expect(
        recovered.registeredPaths.filter((candidate) =>
          candidate.includes(prepared.taskId)
        )
      ).toHaveLength(1);
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        process.kill(first.pid!, 'SIGKILL');
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function readJsonLine<T>(child: ReturnType<typeof spawn>): Promise<T> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const line = stdout.match(/^([^\r\n]+)[\r\n]/u)?.[1];
      if (!line) return;
      try {
        resolve(JSON.parse(line) as T);
      } catch (error) {
        reject(error);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (!stdout.includes('\n')) {
        reject(
          new Error(
            `Restart fixture exited before output: ${code ?? signal}\n${stderr}`
          )
        );
      }
    });
  });
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('close', () => resolve()));
}

function expectProcessSuccess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(
          new Error(`Restart fixture failed: ${child.exitCode ?? child.signalCode}`)
        );
  }
  return new Promise((resolve, reject) => {
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Restart fixture failed: ${code ?? signal}`));
    });
  });
}
