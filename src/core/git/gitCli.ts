import { execFileOwnedPortable } from '../process/ownedProcess';
import { execFilePortable } from '../process/portableChildProcess';

let configuredGitExecutable: string | undefined;

export interface GitResult {
  stdout: string;
  stderr: string;
}

export function configureGitExecutablePath(executable: string | undefined): void {
  configuredGitExecutable = executable?.trim() || undefined;
}

export function getGitExecutablePath(): string {
  return configuredGitExecutable ?? 'git';
}

export async function git(cwd: string, argv: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await executeGit(cwd, argv, timeout);
  return stdout;
}

async function executeGit(
  cwd: string,
  argv: string[],
  timeout: number
): Promise<GitResult> {
  const execute = requiresCrashOwnership(argv)
    ? execFileOwnedPortable
    : execFilePortable;
  return execute(getGitExecutablePath(), argv, {
    cwd,
    timeout,
    maxBuffer: 20 * 1024 * 1024
  });
}

export async function gitResult(
  cwd: string,
  argv: string[],
  timeout = 15_000
): Promise<GitResult> {
  return executeGit(cwd, argv, timeout);
}

export async function gitSucceeds(cwd: string, argv: string[], timeout = 15_000): Promise<boolean> {
  try {
    await git(cwd, argv, timeout);
    return true;
  } catch {
    return false;
  }
}

const MUTATING_GIT_COMMANDS = new Set([
  'add',
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'config',
  'fetch',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'remote',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'symbolic-ref',
  'tag',
  'update-ref'
]);

function requiresCrashOwnership(argv: string[]): boolean {
  const command = argv[0];
  if (!command) return false;
  if (MUTATING_GIT_COMMANDS.has(command) || command === 'ls-remote') {
    return true;
  }
  if (command !== 'worktree') return false;
  return argv[1] !== 'list';
}
