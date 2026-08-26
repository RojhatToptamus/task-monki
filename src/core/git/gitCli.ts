import { execFileOwnedPortable } from '../process/ownedProcess';
import { execFilePortable } from '../process/portableChildProcess';

let configuredGitExecutable: string | undefined;

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitExecutionOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
}

export function configureGitExecutablePath(executable: string | undefined): void {
  configuredGitExecutable = executable?.trim() || undefined;
}

export function getGitExecutablePath(): string {
  return configuredGitExecutable ?? 'git';
}

export async function git(
  cwd: string,
  argv: string[],
  timeoutOrOptions: number | GitExecutionOptions = 15_000
): Promise<string> {
  const { stdout } = await executeGit(cwd, argv, normalizeOptions(timeoutOrOptions));
  return stdout;
}

async function executeGit(
  cwd: string,
  argv: string[],
  options: Required<Pick<GitExecutionOptions, 'timeout'>> &
    Omit<GitExecutionOptions, 'timeout'>
): Promise<GitResult> {
  const execute = requiresCrashOwnership(argv)
    ? execFileOwnedPortable
    : execFilePortable;
  return execute(
    getGitExecutablePath(),
    argv,
    {
      cwd,
      timeout: options.timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: options.env ? { ...process.env, ...options.env } : process.env
    },
    options.stdin
  );
}

export async function gitResult(
  cwd: string,
  argv: string[],
  timeoutOrOptions: number | GitExecutionOptions = 15_000
): Promise<GitResult> {
  return executeGit(cwd, argv, normalizeOptions(timeoutOrOptions));
}

export async function gitSucceeds(cwd: string, argv: string[], timeout = 15_000): Promise<boolean> {
  try {
    await git(cwd, argv, { timeout });
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
  'commit-tree',
  'config',
  'fetch',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'remote',
  'read-tree',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'symbolic-ref',
  'tag',
  'update-ref',
  'write-tree'
]);

function normalizeOptions(
  value: number | GitExecutionOptions
): Required<Pick<GitExecutionOptions, 'timeout'>> & Omit<GitExecutionOptions, 'timeout'> {
  return typeof value === 'number'
    ? { timeout: value }
    : { ...value, timeout: value.timeout ?? 15_000 };
}

function requiresCrashOwnership(argv: string[]): boolean {
  const command = argv[0];
  if (!command) return false;
  if (MUTATING_GIT_COMMANDS.has(command) || command === 'ls-remote') {
    return true;
  }
  if (command !== 'worktree') return false;
  return argv[1] !== 'list';
}
