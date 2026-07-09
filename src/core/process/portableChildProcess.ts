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
  env: NodeJS.ProcessEnv = process.env
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
    executable: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${commandLine}"`],
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
