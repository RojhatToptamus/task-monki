import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  spawnPortable,
  terminatePortableProcessTree
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

  await signalChild(child, 'SIGINT');
  if (await waitForExit(child, 3000)) {
    return;
  }

  await signalChild(child, 'SIGTERM');
  if (await waitForExit(child, 3000)) {
    return;
  }

  await signalChild(child, 'SIGKILL');
  await waitForExit(child, 3000);
}

async function signalChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): Promise<void> {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    await terminatePortableProcessTree(child, signal);
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
    'LC_ALL',
    'CODEX_HOME'
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
      /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/giu,
      '$1[REDACTED]@'
    );
  const exactValues = [...new Set(sensitiveValues)]
    .filter((sensitive) => sensitive.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const sensitive of exactValues) {
    redacted = redacted.split(sensitive).join('[REDACTED]');
  }
  return redacted;
}
