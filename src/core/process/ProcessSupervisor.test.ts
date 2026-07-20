import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import * as portableChildProcess from './portableChildProcess';
import {
  ProcessSupervisor,
  redactProcessDiagnostic,
  sanitizeEnvironment
} from './ProcessSupervisor';

describe('ProcessSupervisor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('only forwards explicitly named runtime environment keys', () => {
    expect(
      sanitizeEnvironment(
        {
          PATH: '/bin',
          CODEX_HOME: '/codex/provider-state',
          OPENCODE_SERVER_PASSWORD: 'runtime-secret',
          UNRELATED_API_KEY: 'must-not-pass'
        },
        ['OPENCODE_SERVER_PASSWORD']
      )
    ).toEqual({
      PATH: '/bin',
      OPENCODE_SERVER_PASSWORD: 'runtime-secret'
    });
  });

  it('keeps Codex state out of the portable base unless a runtime explicitly opts in', () => {
    const source = { PATH: '/bin', CODEX_HOME: '/codex/provider-state' };

    expect(sanitizeEnvironment(source)).toEqual({ PATH: '/bin' });
    expect(sanitizeEnvironment(source, ['CODEX_HOME'])).toEqual(source);
  });

  it('rejects malformed runtime environment allowlist keys', () => {
    expect(() => sanitizeEnvironment({}, ['BAD=KEY'])).toThrow(
      'Invalid environment allowlist key'
    );
  });

  it('redacts exact and credential-shaped process diagnostics', () => {
    const diagnostic = redactProcessDiagnostic(
      'token=oauth-value Bearer abc.def-123 password=hunter2 ' +
        'OPENAI_API_KEY=openai-value "refresh_token":"refresh-value" ' +
        'sk-ant-abcdefghijklmnop postgres://user:secret@localhost/db ' +
        'opaque=abcdefgh pin=q',
      ['oauth-value', 'abcd', 'abcdefgh', 'q']
    );

    expect(diagnostic).not.toContain('oauth-value');
    expect(diagnostic).not.toContain('abc.def-123');
    expect(diagnostic).not.toContain('hunter2');
    expect(diagnostic).not.toContain('openai-value');
    expect(diagnostic).not.toContain('refresh-value');
    expect(diagnostic).not.toContain('sk-ant-abcdefghijklmnop');
    expect(diagnostic).not.toContain('user:secret@');
    expect(diagnostic).not.toContain('[REDACTED]ef');
    expect(diagnostic).toContain('pin=[REDACTED]');
    expect(diagnostic).toContain('"refresh_token":"[REDACTED]"');
    expect(diagnostic.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(9);
  });

  it('redacts URI userinfo in linear time while preserving ordinary URLs', () => {
    const benignPrefix = 'v'.repeat(128 * 1024);
    const input =
      `${benignPrefix}\n` +
      'remote=(https://user:password@example.test/path) ' +
      'public=https://example.test/docs';
    const startedAt = performance.now();

    const diagnostic = redactProcessDiagnostic(input);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(diagnostic).toBe(
      `${benignPrefix}\n` +
        'remote=(https://[REDACTED]@example.test/path) ' +
        'public=https://example.test/docs'
    );
  });

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

  it.runIf(process.platform !== 'win32')(
    'does not publish close until descendants are reaped after the leader exits',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-process-leader-exit-')
      );
      const signalFile = path.join(directory, 'descendant-signal.txt');
      const readyFile = path.join(directory, 'descendant-ready');
      const descendantScript = [
        "const fs = require('node:fs');",
        `const readyFile = ${JSON.stringify(readyFile)};`,
        `const signalFile = ${JSON.stringify(signalFile)};`,
        "const leaderPid = Number(process.env.TASK_MONKI_TEST_LEADER_PID);",
        "process.on('SIGINT', () => {",
        "  let leaderState = 'alive';",
        "  try { process.kill(leaderPid, 0); } catch (error) {",
        "    if (error.code !== 'ESRCH') throw error;",
        "    leaderState = 'exited';",
        '  }',
        "  fs.writeFileSync(signalFile, leaderState);",
        '  process.exit(0);',
        '});',
        "fs.writeFileSync(readyFile, 'ready');",
        'setInterval(() => undefined, 30_000);'
      ].join('\n');
      const leaderScript = [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        `const readyFile = ${JSON.stringify(readyFile)};`,
        `const descendantScript = ${JSON.stringify(descendantScript)};`,
        'const descendant = spawn(process.execPath, [\'-e\', descendantScript], {',
        "  stdio: 'ignore',",
        '  env: { ...process.env, TASK_MONKI_TEST_LEADER_PID: String(process.pid) }',
        '});',
        'const ready = setInterval(() => {',
        '  if (!fs.existsSync(readyFile)) return;',
        '  clearInterval(ready);',
        "  process.stdout.write(String(descendant.pid) + '\\n');",
        '  process.exit(0);',
        '}, 5);'
      ].join('\n');
      const supervisor = new ProcessSupervisor();
      const child = supervisor.start({
        executable: process.execPath,
        argv: ['-e', leaderScript],
        cwd: directory
      });

      try {
        const terminal = collect(child);
        const descendantPid = Number(await readFirstStdoutLine(child));
        await terminal;

        expect(await fs.readFile(signalFile, 'utf8')).toBe('exited');
        await expectProcessToExit(descendantPid);
      } finally {
        await child.cancel().catch(() => undefined);
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'publishes a distinct terminal failure when descendant termination cannot be confirmed',
    async () => {
      vi.spyOn(portableChildProcess, 'waitForPortableProcessTreeExit').mockResolvedValue(false);
      const leaderScript = [
        "const { spawn } = require('node:child_process');",
        "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 30000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(descendant.pid) + '\\n');",
        'setTimeout(() => process.exit(0), 20);'
      ].join('\n');
      const child = new ProcessSupervisor().start({
        executable: process.execPath,
        argv: ['-e', leaderScript],
        cwd: process.cwd()
      });
      const onError = vi.fn();
      const onClose = vi.fn();
      child.events.on('error', onError);
      child.events.on('close', onClose);
      const termination = new Promise<{
        error: Error;
        leaderExit: { exitCode: number | null; signal: NodeJS.Signals | null };
      }>((resolve) => child.events.once('terminationUnconfirmed', resolve));

      const descendantPid = Number(await readFirstStdoutLine(child));
      try {
        const failure = await termination;

        expect(failure.error).toBeInstanceOf(Error);
        expect(failure.error.message).not.toBe('');
        expect(failure.leaderExit).toEqual({ exitCode: 0, signal: null });
        expect(onError).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        await expect(child.cancel()).rejects.toBe(failure.error);
      } finally {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  );

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
  throw new Error(`Descendant process ${pid} is still running.`);
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
