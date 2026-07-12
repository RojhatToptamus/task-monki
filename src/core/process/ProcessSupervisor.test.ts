import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import { ProcessSupervisor } from './ProcessSupervisor';

describe('ProcessSupervisor', () => {
  it('captures stdout, stderr, and exit codes separately', async () => {
    const supervisor = new ProcessSupervisor();
    const child = supervisor.start({
      executable: process.execPath,
      argv: ['-e', 'console.log("out"); console.error("err"); process.exit(7);'],
      cwd: process.cwd()
    });

    const result = await collect(child);

    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBe(null);
  });

  it('can cancel a long-running child process', async () => {
    const supervisor = new ProcessSupervisor();
    const child = supervisor.start({
      executable: process.execPath,
      argv: ['-e', 'setTimeout(() => {}, 30000);'],
      cwd: process.cwd()
    });

    const closed = collect(child);
    await new Promise((resolve) => child.events.once('started', resolve));
    await child.cancel();

    const result = await closed;
    expect(result.exitCode !== null || result.signal !== null).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'cancels the real descendant launched by a Windows cmd shim',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-process-tree-')
      );
      const executable = await writeNodeExecutable(
        directory,
        'long-running-child',
        "console.log(process.pid); setInterval(() => {}, 30_000);\n"
      );
      const supervisor = new ProcessSupervisor();
      const child = supervisor.start({ executable, argv: [], cwd: directory });
      const terminal = collect(child);
      const descendantPid = await readFirstStdoutLine(child);

      await child.cancel();
      await terminal;

      await expectProcessToExit(Number(descendantPid));
    }
  );
});

function readFirstStdoutLine(
  child: ReturnType<ProcessSupervisor['start']>
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    child.events.on('stdout', (chunk) => {
      stdout += chunk.toString('utf8');
      const line = stdout.match(/^([^\r\n]+)[\r\n]/u)?.[1];
      if (line) resolve(line);
    });
  });
}

async function expectProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Windows descendant process ${pid} is still running.`);
}

function collect(child: ReturnType<ProcessSupervisor['start']>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  let stdout = '';
  let stderr = '';
  child.events.on('stdout', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.events.on('stderr', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  return new Promise((resolve, reject) => {
    child.events.once('error', reject);
    child.events.once('close', ({ exitCode, signal }) => resolve({ stdout, stderr, exitCode, signal }));
  });
}
