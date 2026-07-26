import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
  SpawnOptionsWithoutStdio
} from 'node:child_process';
import path from 'node:path';
import {
  prepareProcessLaunch,
  registerPortableProcessGroup,
  spawnPortable,
  terminatePortableProcessTree,
  waitForPortableProcessTreeExit
} from './portableChildProcess';

export interface OwnedProcessLauncherConfig {
  launcherPath: string;
  launcherExecutable?: string;
  launcherEnvironment?: NodeJS.ProcessEnv;
}

export function resolveOwnedProcessLauncherPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'owned-process-launcher.mjs')
    : path.join(input.appPath, 'src/core/process/owned-process-launcher.mjs');
}

let configuredLauncher: OwnedProcessLauncherConfig | undefined;

export function configureOwnedProcessLauncher(
  config: OwnedProcessLauncherConfig
): void {
  configuredLauncher = {
    launcherPath: config.launcherPath,
    launcherExecutable: config.launcherExecutable,
    launcherEnvironment: config.launcherEnvironment
      ? { ...config.launcherEnvironment }
      : undefined
  };
}

export function spawnOwnedPortable(
  executable: string,
  argv: string[],
  options: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams;
export function spawnOwnedPortable(
  executable: string,
  argv: string[],
  options: SpawnOptions
): ChildProcess;
export function spawnOwnedPortable(
  executable: string,
  argv: string[],
  options: SpawnOptions
): ChildProcess {
  const launcher = configuredLauncher ?? defaultLauncherConfig();
  const target = prepareProcessLaunch(
    executable,
    argv,
    process.platform,
    options.env ?? process.env
  );
  const child = spawnPortable(
    launcher.launcherExecutable ?? process.execPath,
    [launcher.launcherPath],
    {
      cwd: options.cwd,
      env: { ...launcher.launcherEnvironment },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
      windowsHide: true
    }
  );
  child.on('message', (message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'target-spawned'
    ) {
      const pid = (message as { pid?: unknown }).pid;
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
        registerPortableProcessGroup(child, pid);
      }
      return;
    }
    if (
      typeof message !== 'object' ||
      message === null ||
      (message as { type?: unknown }).type !== 'target-error'
    ) {
      return;
    }
    const detail = (message as {
      error?: {
        message?: unknown;
        code?: unknown;
        path?: unknown;
        syscall?: unknown;
      };
    }).error;
    const error = Object.assign(
      new Error(
        typeof detail?.message === 'string'
          ? detail.message
          : `Could not start owned process: ${executable}`
      ),
      {
        code: detail?.code,
        path: detail?.path,
        syscall: detail?.syscall
      }
    );
    child.emit('error', error);
  });
  child.once('spawn', () => {
    child.send?.({
      type: 'configure',
      command: {
        executable: target.executable,
        argv: target.argv,
        cwd: String(options.cwd ?? process.cwd()),
        env: target.env,
        windowsVerbatimArguments: target.windowsVerbatimArguments
      }
    });
  });
  return child;
}

export async function execFileOwnedPortable(
  executable: string,
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
  },
  stdin?: string | Buffer
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) {
    throw abortFailure(options.signal);
  }
  const child = spawnOwnedPortable(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  }) as ChildProcessWithoutNullStreams;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let forcedError: Error | undefined;
  let timer: NodeJS.Timeout | undefined;
  let termination: Promise<void> | undefined;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;

  const terminate = async () => {
    termination ??= (async () => {
      await terminatePortableProcessTree(child, 'SIGTERM').catch(() => undefined);
      if (!(await waitForPortableProcessTreeExit(child, 1_000))) {
        await terminatePortableProcessTree(child, 'SIGKILL').catch(() => undefined);
      }
    })();
    await termination;
  };
  const forceFailure = (error: Error) => {
    if (forcedError) return;
    forcedError = error;
    void terminate();
  };
  const onAbort = () => forceFailure(abortFailure(options.signal!));
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  };
  const capture = (
    chunks: Buffer[],
    chunk: Buffer,
    currentBytes: number,
    stream: 'stdout' | 'stderr'
  ) => {
    const nextBytes = currentBytes + chunk.byteLength;
    if (nextBytes > maxBuffer && !forcedError) {
      forceFailure(
        new Error(`${stream} exceeded the configured ${maxBuffer}-byte buffer.`)
      );
      return currentBytes;
    }
    chunks.push(chunk);
    return nextBytes;
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes = capture(stdout, chunk, stdoutBytes, 'stdout');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes = capture(stderr, chunk, stderrBytes, 'stderr');
  });

  const result = new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (code, signal) => {
        cleanup();
        const output = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8')
        };
        if (forcedError || code !== 0) {
          const failure =
            forcedError ??
            new Error(
              `Command failed with ${
                signal ? `signal ${signal}` : `exit code ${code}`
              }: ${executable}${output.stderr ? `\n${output.stderr}` : ''}`
            );
          reject(
            forcedError
              ? Object.assign(failure, { signal, ...output })
              : Object.assign(failure, { code, signal, ...output })
          );
          return;
        }
        resolve(output);
      });
    }
  );
  if (options.timeout && options.timeout > 0) {
    timer = setTimeout(() => {
      forceFailure(
        Object.assign(
          new Error(`Command timed out after ${options.timeout}ms: ${executable}`),
          { code: 'ETIMEDOUT' }
        )
      );
    }, options.timeout);
    timer.unref();
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  child.stdin.end(stdin);
  return result;
}

function defaultLauncherConfig(): OwnedProcessLauncherConfig {
  return {
    launcherPath: path.join(
      process.cwd(),
      'src/core/process/owned-process-launcher.mjs'
    )
  };
}

function abortFailure(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return Object.assign(new Error('Command was aborted.'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  });
}
