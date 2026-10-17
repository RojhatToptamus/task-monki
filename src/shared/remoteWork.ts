/**
 * Identity of the GitHub and GitLab repositories, issues and pull requests a
 * task can start from. Pure and transport-safe: no credentials and no I/O.
 * The platforms stay authoritative for these records; Task Monki keeps only
 * what a task was opened from.
 */

export type RemoteProvider = 'GITHUB' | 'GITLAB';
/** An issue, or a pull request (a merge request on GitLab). */
export type RemoteWorkKind = 'ISSUE' | 'PULL_REQUEST';

/**
 * The hosts Task Monki supports. GitHub Enterprise and self-managed GitLab are
 * not supported yet: their hosts cannot be told apart from a URL alone.
 */
const PROVIDER_HOSTS: Readonly<Record<string, RemoteProvider>> = {
  'github.com': 'GITHUB',
  'ssh.github.com': 'GITHUB',
  'gitlab.com': 'GITLAB',
  'altssh.gitlab.com': 'GITLAB'
};

const CANONICAL_HOSTS: Readonly<Record<RemoteProvider, string>> = {
  GITHUB: 'github.com',
  GITLAB: 'gitlab.com'
};

export interface RemoteRepositoryRef {
  provider: RemoteProvider;
  /** The platform's web host, lowercase: `github.com` or `gitlab.com`. */
  host: string;
  /** `owner/repo` on GitHub, `group/subgroup/project` on GitLab. */
  path: string;
}

export interface RemoteWorkRef {
  repository: RemoteRepositoryRef;
  kind: RemoteWorkKind;
  number: number;
}

/** A remote repository a registered checkout reaches through one of its Git remotes. */
export interface RemoteRepositoryOption extends RemoteRepositoryRef {
  remoteName: string;
}

export interface RemoteWorkSummary {
  ref: RemoteWorkRef;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  author?: string;
  updatedAt?: string;
  /** Pull requests only. */
  draft?: boolean;
  headRefName?: string;
  /** The pull request's branch lives in another repository, usually a fork. */
  crossRepository?: boolean;
  headRepositoryPath?: string;
  /** The task already opened from this item, or that delivered this pull request. */
  existingTaskId?: string;
  existingTaskTitle?: string;
  existingTaskPhase?: string;
}

export interface ListRemoteWorkRequest {
  repositoryId: string;
  kind: RemoteWorkKind;
  /** The remote repository to read; the checkout's default when absent. */
  remote?: RemoteRepositoryRef;
  /** Search words, a number such as `12` or `#12`, or a link. */
  query?: string;
}

export type RemoteWorkUnavailableCode =
  | 'NO_REMOTE'
  | 'UNSUPPORTED_REMOTE'
  | 'CLI_MISSING'
  | 'SIGNED_OUT'
  | 'NOT_FOUND'
  | 'WRONG_KIND'
  | 'OTHER_REPOSITORY'
  | 'FAILED';

export interface RemoteWorkUnavailable {
  code: RemoteWorkUnavailableCode;
  message: string;
}

export interface RemoteWorkListing {
  /** Every supported remote repository of the checkout, default first. */
  repositories: RemoteRepositoryOption[];
  /** The repository the items come from. */
  remote?: RemoteRepositoryOption;
  items: RemoteWorkSummary[];
  /** The query named one item exactly: a link or a number. */
  exact: boolean;
  unavailable?: RemoteWorkUnavailable;
}

export interface OpenPullRequestRequest {
  repositoryId: string;
  pullRequest: RemoteWorkRef;
  title?: string;
  runtimeId?: import('./agent').AgentRuntimeId;
  agentSettings?: import('./agent').AgentExecutionSettings;
}

export interface SyncPullRequestRequest {
  taskId: string;
}

/** What a task was opened from: immutable after creation. */
export interface TaskRemoteSource {
  provider: RemoteProvider;
  host: string;
  repositoryPath: string;
  kind: RemoteWorkKind;
  number: number;
  url: string;
  title: string;
  /** The captured text agents read, an immutable `remote-source` artifact of this task. */
  snapshotArtifactId: string;
  capturedAt: string;
  /** A pull or merge request: the exact revisions that were opened. */
  pullRequest?: TaskRemotePullRequest;
}

export interface TaskRemotePullRequest {
  headRefName: string;
  /** Absent when the head repository was deleted. */
  headRepositoryPath?: string;
  crossRepository: boolean;
  baseRefName: string;
  headSha: string;
  /** The merge base of the head and the target branch: the platform's diff base. */
  mergeBaseSha: string;
}

export const REMOTE_WORK_SNAPSHOT_SCHEMA = 'task-monki/remote-work-snapshot/v1';
export const REMOTE_WORK_LIMITS = {
  title: 512,
  body: 16_000,
  comment: 4_000,
  comments: 10,
  labels: 20,
  listItems: 30,
  query: 256
} as const;

/** The remote text a task captured, as stored in its `remote-source` artifact. */
export interface RemoteWorkSnapshot {
  schema: typeof REMOTE_WORK_SNAPSHOT_SCHEMA;
  provider: RemoteProvider;
  host: string;
  repositoryPath: string;
  kind: RemoteWorkKind;
  number: number;
  url: string;
  title: string;
  state: string;
  author?: string;
  labels: string[];
  body: string;
  bodyTruncated: boolean;
  /** The most recent comments, oldest first. */
  comments: RemoteWorkComment[];
  commentCount: number;
  capturedAt: string;
}

export interface RemoteWorkComment {
  author?: string;
  createdAt?: string;
  body: string;
  truncated: boolean;
}

export function remoteProviderForHost(host: string): RemoteProvider | undefined {
  return PROVIDER_HOSTS[host.toLowerCase()];
}

export function remoteProviderName(provider: RemoteProvider): string {
  return provider === 'GITHUB' ? 'GitHub' : 'GitLab';
}

/** What the platform calls the item: an issue, a pull request or a merge request. */
export function remoteWorkNoun(provider: RemoteProvider, kind: RemoteWorkKind): string {
  return kind === 'ISSUE' ? 'issue' : provider === 'GITLAB' ? 'merge request' : 'pull request';
}

/** `#12`, or `!12` for a GitLab merge request. */
export function formatRemoteWorkNumber(provider: RemoteProvider, kind: RemoteWorkKind, number: number): string {
  return `${provider === 'GITLAB' && kind === 'PULL_REQUEST' ? '!' : '#'}${number}`;
}

/** `owner/repo#12`, or `#12` when it is in `relativeTo`. */
export function formatRemoteWorkReference(ref: RemoteWorkRef, relativeTo?: RemoteRepositoryRef): string {
  const number = formatRemoteWorkNumber(ref.repository.provider, ref.kind, ref.number);
  return relativeTo && sameRemoteRepository(ref.repository, relativeTo) ? number : `${ref.repository.path}${number}`;
}

export function remoteRepositoryWebUrl(repository: RemoteRepositoryRef): string {
  return `https://${repository.host}/${repository.path}`;
}

export function sameRemoteRepository(left: RemoteRepositoryRef, right: RemoteRepositoryRef): boolean {
  return left.provider === right.provider && left.host === right.host &&
    left.path.toLowerCase() === right.path.toLowerCase();
}

/** One key per remote item across hosts and repositories; repository paths are case-insensitive on both platforms. */
export function remoteWorkKey(ref: RemoteWorkRef): string {
  return `${ref.repository.provider}:${ref.repository.host}/${ref.repository.path.toLowerCase()}:${ref.kind}:${ref.number}`;
}

export function taskRemoteSourceRef(source: Pick<TaskRemoteSource, 'provider' | 'host' | 'repositoryPath' | 'kind' | 'number'>): RemoteWorkRef {
  return {
    repository: { provider: source.provider, host: source.host, path: source.repositoryPath },
    kind: source.kind,
    number: source.number
  };
}

/**
 * The repository a Git remote URL names, or undefined for anything else.
 * Accepts `https://`, `ssh://` and `user@host:path` forms. Credentials in the
 * URL are never kept, and a path segment that could be read as a command-line
 * option is refused.
 */
export function parseRemoteRepositoryUrl(url: string): RemoteRepositoryRef | undefined {
  const value = url.trim();
  let host: string | undefined;
  let rawPath: string | undefined;
  const scheme = /^(https|ssh):\/\/(?:[^@/?#]*@)?([^/:?#]+)(?::\d{1,5})?\/([^?#]*)$/iu.exec(value);
  if (scheme) {
    host = scheme[2];
    rawPath = scheme[3];
  } else {
    const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^?#]*)$/u.exec(value);
    if (scp) {
      host = scp[1];
      rawPath = scp[2];
    }
  }
  if (!host || rawPath === undefined) return undefined;
  const provider = remoteProviderForHost(host);
  if (!provider) return undefined;
  const path = normalizeRepositoryPath(provider, rawPath.replace(/\/+$/u, '').replace(/\.git$/iu, ''));
  return path ? { provider, host: CANONICAL_HOSTS[provider], path } : undefined;
}

/** A repository path the platform could serve, or undefined. */
export function normalizeRepositoryPath(provider: RemoteProvider, value: string): string | undefined {
  const segments = value.split('/');
  if (provider === 'GITHUB' ? segments.length !== 2 : segments.length < 2 || segments.length > 20) return undefined;
  return segments.every(isRepositorySegment) ? segments.join('/') : undefined;
}

function isRepositorySegment(segment: string): boolean {
  return /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/u.test(segment) && segment !== '.' && segment !== '..';
}

export interface ParsedRemoteWorkReference {
  /** Absent for a bare number, which names an item in the selected repository. */
  repository?: RemoteRepositoryRef;
  /** Absent when the reference does not say: a GitHub `#12` can be either. */
  kind?: RemoteWorkKind;
  number: number;
}

/**
 * Reads a pasted link or a short reference: `12`, `#12`, `!12` (a GitLab merge
 * request), `owner/repo#12`, or an issue, pull request or merge request URL.
 */
export function parseRemoteWorkReference(input: string): ParsedRemoteWorkReference | undefined {
  const value = input.trim();
  const bare = /^([#!]?)(\d{1,9})$/u.exec(value);
  if (bare) {
    return { ...(bare[1] === '!' ? { kind: 'PULL_REQUEST' as const } : {}), number: Number(bare[2]) };
  }
  const short = /^([A-Za-z0-9_.][A-Za-z0-9_./-]*)([#!])(\d{1,9})$/u.exec(value);
  if (short) {
    const segments = short[1]!.split('/');
    const provider: RemoteProvider = short[2] === '!' || segments.length > 2 ? 'GITLAB' : 'GITHUB';
    const path = normalizeRepositoryPath(provider, short[1]!);
    return path ? {
      repository: { provider, host: CANONICAL_HOSTS[provider], path },
      ...(short[2] === '!' ? { kind: 'PULL_REQUEST' as const } : {}),
      number: Number(short[3])
    } : undefined;
  }
  const link = /^https:\/\/([^/?#@]+)\/([^?#]+?)\/?(?:[?#].*)?$/iu.exec(value);
  if (!link) return undefined;
  const provider = remoteProviderForHost(link[1]!);
  if (!provider) return undefined;
  const segments = link[2]!.split('/');
  const host = CANONICAL_HOSTS[provider];
  if (provider === 'GITHUB') {
    const [owner, repo, kind, number] = segments;
    const path = owner && repo ? normalizeRepositoryPath(provider, `${owner}/${repo}`) : undefined;
    if (!path || !number || !/^\d{1,9}$/u.test(number)) return undefined;
    if (kind === 'issues') return { repository: { provider, host, path }, kind: 'ISSUE', number: Number(number) };
    if (kind === 'pull') return { repository: { provider, host, path }, kind: 'PULL_REQUEST', number: Number(number) };
    return undefined;
  }
  const marker = segments.indexOf('-');
  if (marker < 2) return undefined;
  const path = normalizeRepositoryPath(provider, segments.slice(0, marker).join('/'));
  const kind = segments[marker + 1];
  const number = segments[marker + 2];
  if (!path || !number || !/^\d{1,9}$/u.test(number)) return undefined;
  if (kind === 'issues' || kind === 'work_items') return { repository: { provider, host, path }, kind: 'ISSUE', number: Number(number) };
  if (kind === 'merge_requests') return { repository: { provider, host, path }, kind: 'PULL_REQUEST', number: Number(number) };
  return undefined;
}

/** The checkout's remote repositories, default first: `upstream`, then `origin`, then by name. */
export function selectRemoteRepositories(
  remotes: ReadonlyArray<{ name: string; url: string; direction: 'fetch' | 'push' }>
): RemoteRepositoryOption[] {
  const rank = (name: string) => (name === 'upstream' ? 0 : name === 'origin' ? 1 : 2);
  const options: RemoteRepositoryOption[] = [];
  for (const remote of [...remotes]
    .filter((candidate) => candidate.direction === 'fetch')
    .sort((left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name))) {
    const repository = parseRemoteRepositoryUrl(remote.url);
    if (repository && !options.some((option) => sameRemoteRepository(option, repository))) {
      options.push({ ...repository, remoteName: remote.name });
    }
  }
  return options;
}

/** Bounded text, cut at a character boundary. */
/**
 * Heads a worktree may move off when its pull request is rewritten: the ones
 * the platform reported, never one this task pushed, which holds its own commits.
 */
export function leavablePullRequestHeads(
  openedHead: string | undefined,
  pullRequests: readonly { headRefOid?: string }[],
  publications: readonly { headSha?: string }[]
): string[] {
  const pushed = new Set(publications.flatMap((record) => record.headSha ? [record.headSha] : []));
  return [...new Set([openedHead, ...pullRequests.map((record) => record.headRefOid)])]
    .filter((head): head is string => Boolean(head) && !pushed.has(head!));
}

export function boundRemoteText(value: string | undefined, limit: number): { text: string; truncated: boolean } {
  const text = (value ?? '').replace(/\r\n?/gu, '\n');
  if (text.length <= limit) return { text, truncated: false };
  const characters = Array.from(text);
  return characters.length <= limit
    ? { text, truncated: false }
    : { text: characters.slice(0, limit).join(''), truncated: true };
}
