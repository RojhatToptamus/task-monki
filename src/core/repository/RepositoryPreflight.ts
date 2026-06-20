import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepositoryPreflight } from '../../shared/contracts';

const execFileAsync = promisify(execFile);

export async function validateRepositoryPath(repositoryPath: string): Promise<RepositoryPreflight> {
  const checkedAt = new Date().toISOString();

  try {
    const [root, headSha, branch, remoteOutput] = await Promise.all([
      git(repositoryPath, ['rev-parse', '--show-toplevel']),
      git(repositoryPath, ['rev-parse', 'HEAD']),
      git(repositoryPath, ['branch', '--show-current']),
      git(repositoryPath, ['remote', '-v'])
    ]);

    return {
      path: repositoryPath,
      status: 'VALID',
      root: root.trim(),
      headSha: headSha.trim(),
      branch: branch.trim() || undefined,
      remotes: parseRemotes(remoteOutput),
      checkedAt
    };
  } catch (error) {
    return {
      path: repositoryPath,
      status: 'INVALID',
      remotes: [],
      error: error instanceof Error ? error.message : 'Unknown repository validation error.',
      checkedAt
    };
  }
}

async function git(cwd: string, argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', argv, {
    cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

function parseRemotes(output: string): RepositoryPreflight['remotes'] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(?<name>\S+)\s+(?<url>\S+)\s+\((?<direction>fetch|push)\)$/.exec(line);
      if (!match?.groups) {
        return [];
      }
      return [
        {
          name: match.groups.name,
          url: match.groups.url,
          direction: match.groups.direction as 'fetch' | 'push'
        }
      ];
    });
}
