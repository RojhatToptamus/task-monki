import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  isPortableProcessTreeRunning,
  spawnPortable,
  terminatePortableProcessTree,
  waitForPortableProcessTreeExit
} from './portableChildProcess';

export interface ProcessSpec {
  executable: string;
  argv: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** Runtime-owned environment keys that are safe to forward to this child. */
  allowedEnvironmentKeys?: readonly string[];
}

export interface ProcessStarted {
  pid: number;
}

export interface ProcessTerminal {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessTerminationUnconfirmed {
  error: Error;
  leaderExit: ProcessTerminal;
}

export interface SupervisedProcess {
  pid?: number;
  events: EventEmitter<{
    started: [ProcessStarted];
    stdout: [Buffer];
    stderr: [Buffer];
    close: [ProcessTerminal];
    error: [Error];
    terminationUnconfirmed: [ProcessTerminationUnconfirmed];
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
      terminationUnconfirmed: [ProcessTerminationUnconfirmed];
    }>();

    const child = spawnPortable(spec.executable, spec.argv, {
      cwd: spec.cwd,
      env: sanitizeEnvironment(spec.env ?? process.env, spec.allowedEnvironmentKeys),
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
    let treeExit: Promise<void> | undefined;
    const ensureTreeExit = () => {
      treeExit ??= cancelProcess(child);
      return treeExit;
    };
    let resolveTerminal!: () => void;
    let rejectTerminal!: (cause: unknown) => void;
    const terminal = new Promise<void>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    void terminal.catch(() => undefined);
    child.once('close', (exitCode, signal) => {
      // A detached POSIX leader can exit while descendants continue running in
      // its process group. Reap that owned tree before publishing the terminal
      // event that allows runtime supervisors to launch a replacement.
      void ensureTreeExit().then(
        () => {
          resolveTerminal();
          events.emit('close', { exitCode, signal });
        },
        (error: unknown) => {
          const failure = toError(error);
          rejectTerminal(failure);
          events.emit('terminationUnconfirmed', {
            error: failure,
            leaderExit: { exitCode, signal }
          });
        }
      );
    });

    return {
      get pid() {
        return child.pid;
      },
      events,
      cancel: async () => {
        await ensureTreeExit();
        await terminal;
      }
    };
  }
}

async function cancelProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!isPortableProcessTreeRunning(child)) return;

  await signalChild(child, 'SIGINT');
  if (await waitForPortableProcessTreeExit(child, 3000)) {
    return;
  }

  await signalChild(child, 'SIGTERM');
  if (await waitForPortableProcessTreeExit(child, 3000)) {
    return;
  }

  await signalChild(child, 'SIGKILL');
  if (!(await waitForPortableProcessTreeExit(child, 3000))) {
    throw new Error(
      `Process tree ${child.pid ?? '<unknown>'} did not exit after SIGINT, SIGTERM, and SIGKILL.`
    );
  }
}

async function signalChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): Promise<void> {
  try {
    await terminatePortableProcessTree(child, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function sanitizeEnvironment(
  source: NodeJS.ProcessEnv,
  additionalAllowedKeys: readonly string[] = []
): NodeJS.ProcessEnv {
  const allowedKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL'
  ];

  const next: NodeJS.ProcessEnv = {};
  for (const key of new Set([...allowedKeys, ...additionalAllowedKeys])) {
    if (!key || key.includes('=') || key.includes('\0')) {
      throw new Error(`Invalid environment allowlist key: ${JSON.stringify(key)}`);
    }
    if (source[key] !== undefined) {
      next[key] = source[key];
    }
  }

  return next;
}

/**
 * Redacts exact runtime credentials plus common credential-shaped diagnostics
 * before a child-process tail can enter durable or renderer-visible state.
 */
export function redactProcessDiagnostic(
  value: string,
  sensitiveValues: readonly string[] = []
): string {
  let redacted = value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(
      /\b([a-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|client[_-]?secret|session[_-]?secret|token|secret|cookie))\b(["']?\s*[:=]\s*)(["']?)[^"'\s,;]+\3/giu,
      '$1$2$3[REDACTED]$3'
    )
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[oprsu]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
      '[REDACTED]'
    )
    .replace(
      /(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^/?#\s@]+)@/giu,
      '$1$2[REDACTED]@'
    );
  const exactValues = [...new Set(sensitiveValues)]
    .filter((sensitive) => sensitive.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const sensitive of exactValues) {
    redacted = redacted.split(sensitive).join('[REDACTED]');
  }
  return redacted;
}
