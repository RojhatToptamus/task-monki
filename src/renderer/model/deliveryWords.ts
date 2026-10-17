import {
  remoteProviderForHost,
  selectRemoteRepositories,
  type RemoteProvider,
  type Repository,
  type Task
} from '../../shared/contracts';

/**
 * The platform that delivers a task, decided as core decides it: the one the
 * task was opened from, the host of its recorded pull request, else a checkout
 * whose only platform remotes are on GitLab. GitHub otherwise.
 */
export function deliveryProvider(
  task: Pick<Task, 'remoteSource'> & { projection: Pick<Task['projection'], 'githubPullRequestUrl'> },
  repository?: Pick<Repository, 'remotes'>
): RemoteProvider {
  if (task.remoteSource) return task.remoteSource.provider;
  const recorded = task.projection.githubPullRequestUrl;
  if (recorded) {
    try {
      const provider = remoteProviderForHost(new URL(recorded).host);
      if (provider) return provider;
    } catch {
      // An unreadable URL says nothing about the platform.
    }
  }
  const providers = new Set(repository ? selectRemoteRepositories(repository.remotes).map((remote) => remote.provider) : []);
  return providers.has('GITLAB') && !providers.has('GITHUB') ? 'GITLAB' : 'GITHUB';
}

/** What the platform calls its pull request, short: PR on GitHub, MR on GitLab. */
export function deliveryNoun(provider: RemoteProvider): 'PR' | 'MR' {
  return provider === 'GITLAB' ? 'MR' : 'PR';
}

/** Delivery copy in GitLab's words; GitHub copy is returned unchanged. */
export function deliveryWords<T extends string | undefined>(text: T, provider: RemoteProvider): T {
  if (provider !== 'GITLAB' || !text) return text;
  return text
    // GitLab writes a merge request's number with `!`.
    .replace(/\bPR #(\d+)/gu, 'MR !$1')
    .replace(/\b([Pp])ull request #(\d+)/gu, (_match, initial: string, number: string) => `${initial === 'P' ? 'M' : 'm'}erge request !${number}`)
    .replace(/\bGitHub\b/gu, 'GitLab')
    .replace(/\bPRs\b/gu, 'MRs')
    .replace(/\bPR\b/gu, 'MR')
    .replace(/\bpull requests\b/gu, 'merge requests')
    .replace(/\bpull request\b/gu, 'merge request')
    .replace(/\bPull requests\b/gu, 'Merge requests')
    .replace(/\bPull request\b/gu, 'Merge request') as T;
}

/** A pull or merge request's number as its platform writes it: `#82` or `!82`. */
export function deliveryNumber(provider: RemoteProvider, number: number): string {
  return `${provider === 'GITLAB' ? '!' : '#'}${number}`;
}
