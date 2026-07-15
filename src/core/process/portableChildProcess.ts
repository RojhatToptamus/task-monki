import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptions,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio
} from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const windowsCmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_BATCH_INSPECTION_BYTES = 64 * 1024;
const WINDOWS_PROCESS_TREE_TIMEOUT_MS = 10_000;

export interface PreparedProcessCommand {
  executable: string;
  argv: string[];
  windowsVerbatimArguments?: true;
}

export function prepareProcessCommand(
  executable: string,
  argv: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  hostEnv: NodeJS.ProcessEnv = process.env
): PreparedProcessCommand {
  if (platform !== 'win32' || !isWindowsBatchFile(executable)) {
    return { executable, argv };
  }

  // Batch launchers must run through cmd.exe, and this string is already escaped for cmd.
  const forwardsAllArguments = windowsBatchForwardsAllArguments(executable);
  const commandLine = [
    escapeWindowsCommand(executable),
    ...argv.map((argument) =>
      escapeWindowsCommandArgument(argument, forwardsAllArguments)
    )
  ].join(' ');
  return {
    executable: resolveWindowsCommandProcessor(env, hostEnv),
    argv: ['/d', '/s', '/v:off', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

export function spawnPortable(
  executable: string,
  argv: string[],
  options: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams;
export function spawnPortable(executable: string, argv: string[], options: SpawnOptions): ChildProcess;
export function spawnPortable(
  executable: string,
  argv: string[],
  options: SpawnOptions
): ChildProcess {
  const command = prepareProcessCommand(executable, argv, process.platform, options.env);
  return spawn(command.executable, command.argv, withPreparedProcessOptions(command, options));
}

export function execFilePortable(
  executable: string,
  argv: string[],
  options: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  const command = prepareProcessCommand(executable, argv, process.platform, options.env);
  return new Promise((resolve, reject) => {
    const child = execFile(
      command.executable,
      command.argv,
      withPreparedProcessOptions(command, options),
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as Error & {
            stdout?: string | Buffer;
            stderr?: string | Buffer;
          };
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
    // execFile is used for complete noninteractive commands. Explicit EOF is
    // part of that contract: some CLIs wait for piped stdin before exiting,
    // even for discovery subcommands that never consume input.
    child.stdin?.end();
  });
}

/**
 * Windows does not propagate ChildProcess.kill() through a cmd.exe process
 * tree. taskkill /T provides the process-tree boundary that batch launchers
 * need; other platforms retain their ordinary signal behavior.
 */
export async function terminatePortableProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32' && child.pid) {
    try {
      await execFileAsync(
        resolveWindowsSystemExecutable('taskkill.exe', process.env),
        ['/pid', String(child.pid), '/t', '/f'],
        {
          timeout: WINDOWS_PROCESS_TREE_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        }
      );
      return;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Fall back to Node's direct termination if taskkill is unavailable.
    }
  }

  child.kill(signal);
}

function withPreparedProcessOptions<T extends SpawnOptions | ExecFileOptions>(
  command: PreparedProcessCommand,
  options: T
): T {
  if (!command.windowsVerbatimArguments) {
    return options;
  }
  return {
    ...options,
    env: windowsLauncherEnvironment(
      options.env,
      process.env,
      command.executable
    ),
    windowsVerbatimArguments: true
  };
}

function isWindowsBatchFile(executable: string): boolean {
  const extension = path.win32.extname(executable).toLowerCase();
  return extension === '.cmd' || extension === '.bat';
}

function windowsBatchForwardsAllArguments(executable: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(executable, 'r');
    const buffer = Buffer.allocUnsafe(WINDOWS_BATCH_INSPECTION_BYTES);
    const bytesRead = readSync(
      descriptor,
      buffer,
      0,
      buffer.byteLength,
      0
    );
    return buffer.subarray(0, bytesRead).includes(Buffer.from('%*'));
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function escapeWindowsCommand(value: string): string {
  return value.replace(windowsCmdMetaCharacters, '^$1');
}

function escapeWindowsCommandArgument(
  value: string,
  doubleEscapeMetaCharacters: boolean
): string {
  let argument = value;
  argument = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  argument = argument.replace(/(?=(\\+?)?)\1$/, '$1$1');
  argument = `"${argument}"`;
  argument = argument.replace(windowsCmdMetaCharacters, '^$1');
  return doubleEscapeMetaCharacters
    ? argument.replace(windowsCmdMetaCharacters, '^$1')
    : argument;
}

function resolveWindowsCommandProcessor(
  childEnv: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv
): string {
  for (const env of [hostEnv, childEnv]) {
    const comSpec = environmentValue(env, 'ComSpec');
    if (
      comSpec &&
      path.win32.isAbsolute(comSpec) &&
      path.win32.basename(comSpec).toLowerCase() === 'cmd.exe'
    ) {
      return comSpec;
    }
    const systemRoot = environmentValue(env, 'SystemRoot');
    if (systemRoot && path.win32.isAbsolute(systemRoot)) {
      return path.win32.join(systemRoot, 'System32', 'cmd.exe');
    }
  }
  return 'cmd.exe';
}

function resolveWindowsSystemExecutable(
  executable: string,
  hostEnv: NodeJS.ProcessEnv
): string {
  const comSpec = environmentValue(hostEnv, 'ComSpec');
  if (
    comSpec &&
    path.win32.isAbsolute(comSpec) &&
    path.win32.basename(comSpec).toLowerCase() === 'cmd.exe'
  ) {
    return path.win32.join(path.win32.dirname(comSpec), executable);
  }
  const systemRoot = environmentValue(hostEnv, 'SystemRoot');
  if (systemRoot && path.win32.isAbsolute(systemRoot)) {
    return path.win32.join(systemRoot, 'System32', executable);
  }
  return executable;
}

function windowsLauncherEnvironment(
  childEnv: NodeJS.ProcessEnv | undefined,
  hostEnv: NodeJS.ProcessEnv,
  commandProcessor: string
): NodeJS.ProcessEnv {
  const prepared = { ...(childEnv ?? hostEnv) };
  for (const name of ['ComSpec', 'SystemRoot']) {
    if (environmentValue(prepared, name) !== undefined) continue;
    const source = environmentEntry(hostEnv, name);
    if (source) prepared[source[0]] = source[1];
  }
  if (
    path.win32.isAbsolute(commandProcessor) &&
    path.win32.basename(commandProcessor).toLowerCase() === 'cmd.exe'
  ) {
    setEnvironmentValue(prepared, 'ComSpec', commandProcessor);
  }
  return prepared;
}

function setEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string
): void {
  const existing = environmentEntry(env, name);
  env[existing?.[0] ?? name] = value;
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  return environmentEntry(env, name)?.[1];
}

function environmentEntry(
  env: NodeJS.ProcessEnv,
  name: string
): [string, string] | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === normalized && value) return [key, value];
  }
  return undefined;
}
