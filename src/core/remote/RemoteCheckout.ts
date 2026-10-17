import os from 'node:os';
import {
  parseRemoteRepositoryUrl,
  sameRemoteRepository,
  selectRemoteRepositories,
  type RemoteRepositoryOption,
  type RemoteRepositoryRef
} from '../../shared/remoteWork';
import { git, gitSucceeds } from '../git/gitCli';
import { RemoteWorkError, safeCliMessage } from './RemoteWorkError';

/**
 * Checking out or moving to pull request code must not run it. Repository
 * hooks can live in the checked-out tree (`core.hooksPath`), so they are off.
 */
export const UNTRUSTED_CHECKOUT_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: os.devNull,
  // A pull request's `.lfsconfig` could point LFS downloads anywhere; files stay pointers.
  GIT_LFS_SKIP_SMUDGE: '1'
};

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

export async function mergeBase(repositoryPath: string, left: string, right: string): Promise<string> {
  return (await git(repositoryPath, ['merge-base', left, right])).trim();
}

export function isAncestor(repositoryPath: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitSucceeds(repositoryPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
}
