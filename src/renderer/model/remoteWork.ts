import {
  formatRemoteWorkNumber,
  remoteProviderName,
  selectRemoteRepositories,
  type RemoteProvider,
  type RemoteWorkKind,
  type Repository,
  type Task
} from '../../shared/contracts';
import { formatShortAge } from './timeAgo';

/** What the platform calls the item, as a label: Issue, Pull request or Merge request. */
export function remoteWorkLabel(provider: RemoteProvider, kind: RemoteWorkKind): string {
  return kind === 'ISSUE' ? 'Issue' : provider === 'GITLAB' ? 'Merge request' : 'Pull request';
}

export function formatRemoteWorkDate(iso: string): string | undefined {
  return formatShortAge(iso);
}

/** The platform of a checkout's default remote, from its recorded remotes. */
export function defaultRemoteProvider(repository: Pick<Repository, 'remotes'> | undefined): RemoteProvider | undefined {
  return repository ? selectRemoteRepositories(repository.remotes)[0]?.provider : undefined;
}

export interface RemoteSourceView {
  /** `acme/widgets#12`, or `!12` on GitLab. */
  reference: string;
  url: string;
  title: string;
  providerName: string;
  kind: RemoteWorkKind;
}

/** The issue or pull request a task was opened from, for display. */
export function remoteSourceView(task: Pick<Task, 'remoteSource'>): RemoteSourceView | undefined {
  const source = task.remoteSource;
  if (!source) return undefined;
  return {
    reference: `${source.repositoryPath}${formatRemoteWorkNumber(source.provider, source.kind, source.number)}`,
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
