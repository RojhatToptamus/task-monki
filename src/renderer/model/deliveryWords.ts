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
