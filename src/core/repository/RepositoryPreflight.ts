import type { RepositoryPreflight, WorktreeBaseOption } from '../../shared/contracts';
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

export async function inspectRepositoryWorktreePreparation(
  repositoryPath: string
): Promise<WorktreeBaseOption[]> {
  const preflight = await validateRepositoryPath(repositoryPath);
  if (preflight.status !== 'VALID' || !preflight.root) {
    throw new Error(preflight.error ?? 'Repository preflight failed.');
  }

  const root = preflight.root;
  const [headOutput, currentRef, branchOutput] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
    readCurrentBranchRef(root),
    git(root, [
      'for-each-ref',
      '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(objecttype)',
      'refs/heads'
    ])
  ]);
  const headSha = requireFullObjectId(headOutput.trim());
  const branchOptions = parseLocalBranchOptions(branchOutput, currentRef);
  const bases = currentRef
    ? branchOptions
    : [
        {
          displayName: 'Detached HEAD',
          sha: headSha,
          current: true
        },
        ...branchOptions
      ];
  if (bases.length === 0) {
    throw new Error('The repository has no local branch that points to a commit.');
  }

  return bases;
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

async function readCurrentBranchRef(repositoryPath: string): Promise<string | undefined> {
  try {
    const refName = (
      await git(repositoryPath, ['symbolic-ref', '--quiet', 'HEAD'])
    ).trim();
    return refName || undefined;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) {
      return undefined;
    }
    throw error;
  }
}

function parseLocalBranchOptions(
  output: string,
  currentRef: string | undefined
): WorktreeBaseOption[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const [refName, displayName, rawSha, objectType] = line.split('\0');
      if (
        !refName?.startsWith('refs/heads/') ||
        !displayName ||
        !rawSha ||
        objectType !== 'commit'
      ) {
        return [];
      }
      return [
        {
          refName,
          displayName,
          sha: requireFullObjectId(rawSha),
          current: refName === currentRef
        }
      ];
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function requireFullObjectId(value: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error('Git returned an invalid commit object ID.');
  }
  return value;
}
