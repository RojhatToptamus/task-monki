import {
  REMOTE_WORK_LIMITS,
  formatRemoteWorkNumber,
  parseRemoteWorkReference,
  remoteWorkKey,
  remoteWorkNoun,
  remoteProviderName,
  type ListRemoteWorkRequest,
  type RemoteProvider,
  type RemoteRepositoryOption,
  type RemoteWorkListing,
  type RemoteWorkRef,
  type RemoteWorkSummary,
  type TaskRemoteSource
} from '../../shared/remoteWork';
import type { Repository, Task } from '../../shared/contracts';
import {
  fetchRemoteObjects,
  hasCommit,
  isAncestor,
  listCheckoutRemoteRepositories,
  mergeBase,
  requireCheckoutRemote
} from './RemoteCheckout';
import { RemoteWorkError, remoteWorkUnavailable } from './RemoteWorkError';
import type { RemotePullRequest, RemoteWorkReader } from './RemoteWorkReader';

/** A remote item read for a new task: the identity to keep and the text agents read. */
export interface CapturedRemoteWork {
  source: Omit<TaskRemoteSource, 'snapshotArtifactId'>;
  snapshot: string;
}

/** A pull request whose exact head and merge base are present in the checkout. */
export interface FetchedPullRequest extends CapturedRemoteWork {
  pullRequest: RemotePullRequest;
  remote: RemoteRepositoryOption;
  mergeBaseSha: string;
}

/**
 * Reads GitHub and GitLab work for a registered checkout and brings pull
 * request revisions into it. It never writes to the platforms, never changes
 * a ref of the checkout, and never runs repository code.
 */
export class RemoteWorkService {
  private readonly readers: ReadonlyMap<RemoteProvider, RemoteWorkReader>;

  constructor(readers: readonly RemoteWorkReader[]) {
    this.readers = new Map(readers.map((reader) => [reader.provider, reader]));
  }

  reader(provider: RemoteProvider): RemoteWorkReader {
    const reader = this.readers.get(provider);
    if (!reader) throw new RemoteWorkError('UNSUPPORTED_REMOTE', `${remoteProviderName(provider)} is not supported.`);
    return reader;
  }

  remoteRepositories(repository: Repository): Promise<RemoteRepositoryOption[]> {
    return listCheckoutRemoteRepositories(repository.path);
  }

  async list(
    repository: Repository,
    input: ListRemoteWorkRequest,
    findTasks: (refs: readonly RemoteWorkRef[]) => Promise<ReadonlyMap<string, Task>>
  ): Promise<RemoteWorkListing> {
    const repositories = await this.remoteRepositories(repository);
    if (repositories.length === 0) {
      return { repositories, items: [], exact: false, unavailable: { code: 'NO_REMOTE', message: 'This checkout has no GitHub or GitLab remote.' } };
    }
    let remote = repositories[0]!;
    try {
      if (input.remote) remote = requireCheckoutRemote(repositories, input.remote);
      const query = input.query?.trim().slice(0, REMOTE_WORK_LIMITS.query) ?? '';
      const reference = query ? parseRemoteWorkReference(query) : undefined;
      if (reference) {
        if (reference.repository) {
          // `group/project#12` names no host: it means the checkout's own repository of that path.
          const linked = /^https:\/\//iu.test(query);
          remote = requireCheckoutRemote(repositories, linked ? reference.repository
            : repositories.find((candidate) => candidate.path.toLowerCase() === reference.repository!.path.toLowerCase()) ?? reference.repository);
        }
        // On GitLab `#12` is an issue and `!12` a merge request; GitHub numbers both with `#`.
        const kind = reference.kind ?? (remote.provider === 'GITLAB' && query.includes('#') ? 'ISSUE' : input.kind);
        const ref: RemoteWorkRef = { repository: remote, kind: input.kind, number: reference.number };
        if (kind !== input.kind) {
          throw new RemoteWorkError('WRONG_KIND',
            `${formatRemoteWorkNumber(remote.provider, kind, reference.number)} is ${kind === 'ISSUE' ? 'an' : 'a'} ${remoteWorkNoun(remote.provider, kind)}.`);
        }
        const reader = this.reader(remote.provider);
        const item = input.kind === 'ISSUE'
          ? (await reader.readIssue(ref, repository.path)).summary
          : (await reader.readPullRequest(ref, repository.path)).summary;
        return { repositories, remote, items: await annotate([item], findTasks), exact: true };
      }
      const items = await this.reader(remote.provider).list(remote, input.kind, query || undefined, repository.path);
      return { repositories, remote, items: await annotate(items, findTasks), exact: false };
    } catch (error) {
      return { repositories, remote, items: [], exact: false, unavailable: remoteWorkUnavailable(error) };
    }
  }

  /** Reads an issue of one of the checkout's remote repositories for a new task. */
  async captureIssue(repository: Repository, ref: RemoteWorkRef): Promise<CapturedRemoteWork> {
    if (ref.kind !== 'ISSUE') throw new RemoteWorkError('WRONG_KIND', 'Choose an issue.');
    const remote = requireCheckoutRemote(await this.remoteRepositories(repository), ref.repository);
    const { snapshot } = await this.reader(remote.provider).readIssue({ ...ref, repository: remote }, repository.path);
    if (snapshot.state !== 'OPEN') {
      throw new RemoteWorkError('NOT_FOUND', `${formatRemoteWorkNumber(remote.provider, 'ISSUE', ref.number)} is closed.`);
    }
    return {
      source: {
        provider: remote.provider,
        host: remote.host,
        repositoryPath: remote.path,
        kind: 'ISSUE',
        number: ref.number,
        url: snapshot.url,
        title: snapshot.title,
        capturedAt: snapshot.capturedAt
      },
      snapshot: JSON.stringify(snapshot)
    };
  }

  /**
   * Reads an open pull request and fetches its exact head and its target into
   * the checkout's object store, then finds the merge base the platform diffs
   * against. No branch, remote-tracking ref or FETCH_HEAD changes.
   */
  async fetchPullRequest(repository: Repository, ref: RemoteWorkRef): Promise<FetchedPullRequest> {
    if (ref.kind !== 'PULL_REQUEST') throw new RemoteWorkError('WRONG_KIND', 'Choose a pull request.');
    const remote = requireCheckoutRemote(await this.remoteRepositories(repository), ref.repository);
    const pullRequest = await this.reader(remote.provider).readPullRequest({ ...ref, repository: remote }, repository.path);
    const noun = remoteWorkNoun(remote.provider, 'PULL_REQUEST');
    if (pullRequest.snapshot.state !== 'OPEN') {
      throw new RemoteWorkError('NOT_FOUND', `This ${noun} is ${pullRequest.snapshot.state === 'MERGED' ? 'merged' : 'closed'}.`);
    }
    // Branch names are identities, so they are kept exactly or not at all.
    if (![pullRequest.headRefName, pullRequest.baseRefName].every((name) => name && name.trim() === name)) {
      throw new RemoteWorkError('FAILED', `Task Monki cannot open this ${noun}: a branch name begins or ends with a space.`);
    }
    const mergeBaseSha = await this.fetchRevisions(repository.path, remote, pullRequest);
    return {
      pullRequest,
      remote,
      mergeBaseSha,
      source: {
        provider: remote.provider,
        host: remote.host,
        repositoryPath: remote.path,
        kind: 'PULL_REQUEST',
        number: ref.number,
        url: pullRequest.snapshot.url,
        title: pullRequest.snapshot.title,
        capturedAt: pullRequest.snapshot.capturedAt,
        pullRequest: {
          headRefName: pullRequest.headRefName,
          ...(pullRequest.headRepositoryPath ? { headRepositoryPath: pullRequest.headRepositoryPath } : {}),
          crossRepository: pullRequest.crossRepository,
          baseRefName: pullRequest.baseRefName,
          headSha: pullRequest.headSha,
          mergeBaseSha
        }
      },
      snapshot: JSON.stringify(pullRequest.snapshot)
    };
  }

  /** Reads the pull request again and fetches its current head, for refresh and sync. */
  async refetchPullRequest(repository: Repository, source: TaskRemoteSource): Promise<{ pullRequest: RemotePullRequest; mergeBaseSha: string }> {
    const remote = requireCheckoutRemote(await this.remoteRepositories(repository), {
      provider: source.provider, host: source.host, path: source.repositoryPath
    });
    const pullRequest = await this.reader(remote.provider).readPullRequest(
      { repository: remote, kind: 'PULL_REQUEST', number: source.number }, repository.path);
    // A deleted or renamed fork changes only the name shown: the head is read from
    // the pull request itself, and pushes go to its own branch under a lease.
    if (pullRequest.snapshot.state !== 'OPEN') return { pullRequest, mergeBaseSha: source.pullRequest?.mergeBaseSha ?? pullRequest.baseSha };
    return { pullRequest, mergeBaseSha: await this.fetchRevisions(repository.path, remote, pullRequest) };
  }

  private async fetchRevisions(repositoryPath: string, remote: RemoteRepositoryOption, pullRequest: RemotePullRequest): Promise<string> {
    await fetchRemoteObjects(repositoryPath, remote, pullRequest.baseIsMergeBase
      ? [pullRequest.headFetchRef]
      : [pullRequest.headFetchRef, `refs/heads/${pullRequest.baseRefName}`]);
    const noun = remoteWorkNoun(remote.provider, 'PULL_REQUEST');
    if (!await hasCommit(repositoryPath, pullRequest.headSha) || !await hasCommit(repositoryPath, pullRequest.baseSha)) {
      throw new RemoteWorkError('FAILED', `The ${noun} changed while it was being read. Try again.`);
    }
    const base = pullRequest.baseIsMergeBase
      ? pullRequest.baseSha
      : await mergeBase(repositoryPath, pullRequest.baseSha, pullRequest.headSha);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(base) || !await isAncestor(repositoryPath, base, pullRequest.headSha)) {
      throw new RemoteWorkError('FAILED', `The ${noun} has no common history with its target branch.`);
    }
    return base;
  }
}

async function annotate(
  items: readonly RemoteWorkSummary[],
  findTasks: (refs: readonly RemoteWorkRef[]) => Promise<ReadonlyMap<string, Task>>
): Promise<RemoteWorkSummary[]> {
  const tasks = await findTasks(items.map((item) => item.ref));
  return items.map((item) => {
    const task = tasks.get(remoteWorkKey(item.ref));
    return task
      ? { ...item, existingTaskId: task.id, existingTaskTitle: task.title, existingTaskPhase: task.workflowPhase }
      : item;
  });
}

export function pullRequestHeadRef(provider: RemoteProvider, number: number): string {
  return provider === 'GITLAB' ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`;
}

