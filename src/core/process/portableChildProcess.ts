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

export interface PreparedProcessCommand {
  executable: string;
  argv: string[];
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

  const commandLine = [
    quoteWindowsCommandArgument(executable),
    ...argv.map(quoteWindowsCommandArgument)
  ].join(' ');
  return {
    executable: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    argv: ['/d', '/s', '/c', `call ${commandLine}`]
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
  return spawn(command.executable, command.argv, options);
}

export function execFilePortable(
  executable: string,
  argv: string[],
  options: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  const command = prepareProcessCommand(executable, argv, process.platform, options.env);
  return execFileAsync(command.executable, command.argv, options) as Promise<{
    stdout: string;
    stderr: string;
  }>;
}

function isWindowsBatchFile(executable: string): boolean {
  const extension = path.win32.extname(executable).toLowerCase();
  return extension === '.cmd' || extension === '.bat';
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}
