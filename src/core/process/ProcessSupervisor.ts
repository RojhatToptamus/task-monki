import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface ProcessSpec {
  executable: string;
  argv: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessStarted {
  pid: number;
}

export interface ProcessTerminal {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface SupervisedProcess {
  pid?: number;
  events: EventEmitter<{
    started: [ProcessStarted];
    stdout: [Buffer];
    stderr: [Buffer];
    close: [ProcessTerminal];
    error: [Error];
  }>;
  cancel(): Promise<void>;
}

export class ProcessSupervisor {
  start(spec: ProcessSpec): SupervisedProcess {
    const events = new EventEmitter<{
      started: [ProcessStarted];
      stdout: [Buffer];
      stderr: [Buffer];
      close: [ProcessTerminal];
      error: [Error];
    }>();

    const child = spawn(spec.executable, spec.argv, {
      cwd: spec.cwd,
      env: sanitizeEnvironment(spec.env ?? process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    }) as ChildProcessWithoutNullStreams;

    child.once('spawn', () => {
      events.emit('started', { pid: child.pid ?? -1 });
      if (spec.stdin !== undefined) {
        child.stdin.write(spec.stdin);
      }
      child.stdin.end();
    });

    child.stdout.on('data', (chunk: Buffer) => events.emit('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => events.emit('stderr', chunk));
    child.once('error', (error) => events.emit('error', error));
    child.once('close', (exitCode, signal) => events.emit('close', { exitCode, signal }));

    return {
      get pid() {
        return child.pid;
      },
      events,
      cancel: () => cancelProcess(child)
    };
  }
}

async function cancelProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalChild(child, 'SIGINT');
  if (await waitForExit(child, 3000)) {
    return;
  }

  signalChild(child, 'SIGTERM');
  if (await waitForExit(child, 3000)) {
    return;
  }

  signalChild(child, 'SIGKILL');
}

function signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onClose = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.off('close', onClose);
    };

    child.once('close', onClose);
  });
}

function sanitizeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowedKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'CODEX_HOME'
  ];

  const next: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (source[key] !== undefined) {
      next[key] = source[key];
    }
  }

  return next;
}
