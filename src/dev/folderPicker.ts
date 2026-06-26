import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type ExecFileAsync = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as ExecFileAsync;

export async function chooseRepositoryFolder(
  platform: NodeJS.Platform = process.platform,
  execFileFn: ExecFileAsync = execFileAsync
): Promise<string | undefined> {
  if (platform !== 'darwin') {
    throw new Error('Folder picker is available in the desktop app on this platform.');
  }

  try {
    const { stdout } = await execFileFn(
      'osascript',
      ['-e', 'POSIX path of (choose folder with prompt "Choose a repository folder")'],
      { timeout: 120_000 }
    );
    return parseAppleScriptFolderPath(stdout);
  } catch (error) {
    if (isAppleScriptCancel(error)) {
      return undefined;
    }
    throw error;
  }
}

export function parseAppleScriptFolderPath(stdout: string): string | undefined {
  const selectedPath = stdout.trim();
  return selectedPath || undefined;
}

function isAppleScriptCancel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = getErrorText(error, 'stderr');
  return /User canceled|-128/.test(`${message}\n${stderr}`);
}

function getErrorText(error: unknown, key: string): string {
  if (!error || typeof error !== 'object' || !(key in error)) {
    return '';
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}
