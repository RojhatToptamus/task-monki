import type { RepositoryPreflight } from '../../shared/contracts';
import fs from 'node:fs/promises';
import { git } from '../git/gitCli';

export async function validateRepositoryPath(repositoryPath: string): Promise<RepositoryPreflight> {
  const checkedAt = new Date().toISOString();

  try {
    const stat = await fs.stat(repositoryPath);
    if (!stat.isDirectory()) {
      return {
        path: repositoryPath,
        status: 'INVALID',
        remotes: [],
        error: 'Repository path is not a directory.',
        checkedAt
      };
    }
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
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      path: repositoryPath,
      status: missing ? 'MISSING' : 'INVALID',
      remotes: [],
      error: error instanceof Error ? error.message : 'Unknown repository validation error.',
      checkedAt
    };
  }
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
