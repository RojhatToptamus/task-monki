import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, argv: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await execFileAsync('git', argv, {
    cwd,
    timeout,
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout;
}

export async function gitResult(
  cwd: string,
  argv: string[],
  timeout = 15_000
): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync('git', argv, {
    cwd,
    timeout,
    maxBuffer: 20 * 1024 * 1024
  });
  return { stdout, stderr };
}

export async function gitSucceeds(cwd: string, argv: string[], timeout = 15_000): Promise<boolean> {
  try {
    await git(cwd, argv, timeout);
    return true;
  } catch {
    return false;
  }
}
