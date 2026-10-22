import {
  formatRemoteWorkNumber,
  formatTaskRemoteReference,
  remoteProviderName,
  sameRemoteRepository,
  selectRemoteRepositories,
  type RemoteProvider,
  type RemoteWorkKind,
  type Repository,
  type Task
} from '../../shared/contracts';

/** The platform of a checkout's default remote, from its recorded remotes. */
export function defaultRemoteProvider(repository: Pick<Repository, 'remotes'> | undefined): RemoteProvider | undefined {
  return repository ? selectRemoteRepositories(repository.remotes)[0]?.provider : undefined;
}

export interface RemoteSourceView {
  /** `#12` (`!12` on GitLab) in its own repository; `acme/widgets#12` from another. */
  reference: string;
  url: string;
  title: string;
  providerName: string;
  kind: RemoteWorkKind;
}

/** The issue or pull request a task was opened from, for display. */
export function remoteSourceView(
  task: Pick<Task, 'remoteSource'>,
  repository?: Pick<Repository, 'remotes'>
): RemoteSourceView | undefined {
  const source = task.remoteSource;
  if (!source) return undefined;
  // In its own repository a number names it, as the platform writes it there.
  const own = Boolean(repository) && selectRemoteRepositories(repository!.remotes).some((remote) =>
    sameRemoteRepository(remote, { provider: source.provider, host: source.host, path: source.repositoryPath }));
  return {
    reference: own ? formatRemoteWorkNumber(source.provider, source.kind, source.number) : formatTaskRemoteReference(source),
    url: source.url,
    title: source.title,
    providerName: remoteProviderName(source.provider),
    kind: source.kind
  };
}

/** How an issue task's first turn begins when the person wrote no request: `Started from issue #42`. */
export function issueOpener(task: Pick<Task, 'remoteSource'>): string | undefined {
  const source = task.remoteSource;
  return source?.kind === 'ISSUE' ? `Started from issue ${formatRemoteWorkNumber(source.provider, 'ISSUE', source.number)}` : undefined;
}
