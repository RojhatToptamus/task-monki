import {
  parseRemoteRepositoryUrl,
  sameRemoteRepository,
  selectRemoteRepositories,
  type RemoteRepositoryOption,
  type RemoteRepositoryRef
} from '../../shared/remoteWork';
import { git, gitSucceeds } from '../git/gitCli';
import { RemoteWorkError, cliExitCode, safeCliMessage } from './RemoteWorkError';

/** The supported repositories a checkout's remotes reach, default first. */
export async function listCheckoutRemoteRepositories(repositoryPath: string): Promise<RemoteRepositoryOption[]> {
  const output = await git(repositoryPath, ['remote', '-v']);
  return selectRemoteRepositories(output.split('\n').flatMap((line) => {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/u.exec(line.trim());
    return match ? [{ name: match[1]!, url: match[2]!, direction: match[3] as 'fetch' | 'push' }] : [];
  }));
}

export function requireCheckoutRemote(
  options: readonly RemoteRepositoryOption[],
  repository: RemoteRepositoryRef
): RemoteRepositoryOption {
  const match = options.find((option) => sameRemoteRepository(option, repository));
  if (!match) {
    throw new RemoteWorkError('OTHER_REPOSITORY', `${repository.path} is not a remote of this checkout.`);
  }
  return match;
}

/**
 * Fetches the objects behind `refs` from the remote without creating or moving
 * any ref, remote-tracking branch or FETCH_HEAD in the checkout.
 */
export async function fetchRemoteObjects(
  repositoryPath: string,
  remote: RemoteRepositoryOption,
  refs: readonly string[]
): Promise<void> {
  const url = await remoteFetchUrl(repositoryPath, remote);
  try {
    await git(repositoryPath, [
      'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--quiet', '--', url, ...refs
    ], { timeout: 120_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  } catch (error) {
    throw new RemoteWorkError('FAILED', `Could not fetch from ${remote.path}: ${safeCliMessage(error)}`);
  }
}

/**
 * The repository a remote pushes to. `git push` uses the remote's push URLs,
 * which can name another repository or several; only exactly one counts.
 */
export async function singlePushRepository(repositoryPath: string, remoteName: string): Promise<{ url: string; repository: RemoteRepositoryRef } | undefined> {
  const urls = (await git(repositoryPath, ['remote', 'get-url', '--push', '--all', '--', remoteName]))
    .split('\n').map((line) => line.trim()).filter(Boolean);
  const repository = urls.length === 1 ? parseRemoteRepositoryUrl(urls[0]!) : undefined;
  return repository ? { url: urls[0]!, repository } : undefined;
}

/**
 * The target branch named for an external checkout's new pull request, as a
 * branch name: without `refs/heads/` or the remote's prefix, and not this branch.
 */
export async function externalTargetBranch(
  worktree: { worktreePath: string; branchName: string },
  requested: string | undefined,
  remoteName: string,
  noun: string
): Promise<string> {
  let branch = requested?.trim() ?? '';
  if (!branch) throw new Error(`Choose a target branch for the new ${noun}.`);
  if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
  if (branch.startsWith(`${remoteName}/`)) branch = branch.slice(remoteName.length + 1);
  if (branch === 'HEAD' || branch === worktree.branchName) throw new Error('Choose a named target branch other than this checkout branch.');
  await git(worktree.worktreePath, ['check-ref-format', '--branch', branch]);
  return branch;
}

/** The remote's current fetch URL, which must still name the same repository. */
export async function remoteFetchUrl(repositoryPath: string, remote: RemoteRepositoryOption): Promise<string> {
  const url = (await git(repositoryPath, ['remote', 'get-url', '--', remote.remoteName])).trim();
  const named = parseRemoteRepositoryUrl(url);
  if (!named || !sameRemoteRepository(named, remote)) {
    throw new RemoteWorkError('FAILED', `The ${remote.remoteName} remote no longer points at ${remote.path}.`);
  }
  return url;
}

export function hasCommit(repositoryPath: string, sha: string): Promise<boolean> {
  return gitSucceeds(repositoryPath, ['cat-file', '-e', `${sha}^{commit}`]);
}

/** The best common ancestor of two commits; undefined when they share no history. */
export async function mergeBase(repositoryPath: string, left: string, right: string): Promise<string | undefined> {
  try {
    return (await git(repositoryPath, ['merge-base', left, right])).trim();
  } catch (error) {
    // `git merge-base` exits 1 when there is no common ancestor; any other failure is Git's.
    if (cliExitCode(error) === 1) return undefined;
    throw error;
  }
}

export function isAncestor(repositoryPath: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitSucceeds(repositoryPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
}
