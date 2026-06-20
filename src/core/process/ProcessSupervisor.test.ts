import { describe, expect, it } from 'vitest';
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
    expect(result.signal).toBeTruthy();
  });
});

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
