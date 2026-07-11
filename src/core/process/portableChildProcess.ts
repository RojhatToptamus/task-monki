import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptions,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio
} from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const windowsCmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/g;

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
  const commandLine = [
    escapeWindowsCommand(executable),
    ...argv.map(escapeWindowsCommandArgument)
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
  return execFileAsync(
    command.executable,
    command.argv,
    withPreparedProcessOptions(command, options)
  ) as Promise<{
    stdout: string;
    stderr: string;
  }>;
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

function escapeWindowsCommand(value: string): string {
  return value.replace(windowsCmdMetaCharacters, '^$1');
}

function escapeWindowsCommandArgument(value: string): string {
  let argument = value;
  argument = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  argument = argument.replace(/(?=(\\+?)?)\1$/, '$1$1');
  argument = `"${argument}"`;
  return argument.replace(windowsCmdMetaCharacters, '^$1');
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
