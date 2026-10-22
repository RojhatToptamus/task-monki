import {
  REMOTE_WORK_LIMITS,
  formatRemoteWorkNumber,
  normalizeRepositoryPath,
  type RemoteRepositoryRef,
  type RemoteWorkKind,
  type RemoteWorkRef,
  type RemoteWorkSummary
} from '../../shared/remoteWork';
import { isGitObjectId } from '../git/gitCli';
import { RemoteWorkError } from '../remote/RemoteWorkError';
import { buildRemoteWorkSnapshot, type RemotePullRequest, type RemoteWorkReader } from '../remote/RemoteWorkReader';
import type { GitHubCli } from './GitHubCli';

const LIST_ISSUE_FIELDS = 'number title url state updatedAt author { login }';
// The review and checks a pull request row shows, read the same way for a listing and for one item.
const PULL_STATE_FIELDS = 'reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';
const LIST_PULL_FIELDS = `${LIST_ISSUE_FIELDS} isDraft headRefName isCrossRepository headRepository { nameWithOwner } ${PULL_STATE_FIELDS}`;
const COMMENTS = `comments(last: ${REMOTE_WORK_LIMITS.comments}) { totalCount nodes { author { login } body createdAt } }`;
const LABELS = `labels(first: ${REMOTE_WORK_LIMITS.labels}) { nodes { name } }`;
const ISSUE_FIELDS = `number title url state body updatedAt author { login } ${LABELS} ${COMMENTS}`;
const PULL_FIELDS = `${ISSUE_FIELDS} isDraft merged headRefName headRefOid baseRefName baseRefOid isCrossRepository headRepository { nameWithOwner }
  ${PULL_STATE_FIELDS}`;

interface GitHubNode {
  __typename?: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  body?: string;
  updatedAt?: string;
  author?: { login?: string } | null;
  labels?: { nodes?: Array<{ name?: string } | null> };
  comments?: { totalCount?: number; nodes?: Array<{ author?: { login?: string } | null; body?: string; createdAt?: string } | null> };
  isDraft?: boolean;
  merged?: boolean;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  isCrossRepository?: boolean;
  headRepository?: { nameWithOwner?: string } | null;
  repository?: { nameWithOwner?: string };
  reviewDecision?: string | null;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } | null } | null> };
}

const LIST_REVIEWS: Record<string, NonNullable<RemoteWorkSummary['review']>> = {
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  APPROVED: 'APPROVED'
};
const LIST_CHECKS: Record<string, NonNullable<RemoteWorkSummary['checks']>> = {
  FAILURE: 'FAILING',
  ERROR: 'FAILING',
  PENDING: 'PENDING',
  EXPECTED: 'PENDING',
  SUCCESS: 'PASSING'
};

/** GitHub issues and pull requests through the signed-in GitHub CLI. */
export class GitHubRemoteWork implements RemoteWorkReader {
  constructor(private readonly cli: GitHubCli) {}

  async list(repository: RemoteRepositoryRef, kind: RemoteWorkKind, words: string | undefined, cwd: string): Promise<RemoteWorkSummary[]> {
    const [owner, name] = repository.path.split('/') as [string, string];
    const fields = kind === 'ISSUE' ? LIST_ISSUE_FIELDS : LIST_PULL_FIELDS;
    // The service passes the search words trimmed and bounded.
    if (words) {
      // Search qualifiers in the words can widen the query, so results are filtered to this repository.
      const data = await this.graphql<{ search?: { nodes?: Array<GitHubNode | null> } }>(repository, cwd,
        `query($q: String!) { search(query: $q, type: ISSUE, first: ${REMOTE_WORK_LIMITS.listItems}) { nodes { __typename ... on ${kind === 'ISSUE' ? 'Issue' : 'PullRequest'} { ${fields} repository { nameWithOwner } } } } }`,
        { q: `repo:${repository.path} is:${kind === 'ISSUE' ? 'issue' : 'pr'} is:open ${words} sort:updated-desc` });
      return (data.search?.nodes ?? [])
        .filter((node): node is GitHubNode => Boolean(node) &&
          node!.__typename === (kind === 'ISSUE' ? 'Issue' : 'PullRequest') &&
          node!.repository?.nameWithOwner?.toLowerCase() === repository.path.toLowerCase())
        .map((node) => summary(repository, kind, node));
    }
    const connection = kind === 'ISSUE' ? 'issues' : 'pullRequests';
    const data = await this.graphql<{ repository?: Record<string, { nodes?: Array<GitHubNode | null> } | null> | null }>(repository, cwd,
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${connection}(first: ${REMOTE_WORK_LIMITS.listItems}, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${fields} } } } }`,
      { owner, name });
    if (!data.repository) throw notFound(repository);
    return (data.repository[connection]?.nodes ?? [])
      .filter((node): node is GitHubNode => Boolean(node))
      .map((node) => summary(repository, kind, node));
  }

  async readIssue(ref: RemoteWorkRef, cwd: string) {
    const node = await this.readItem(ref, cwd, ISSUE_FIELDS);
    return { summary: summary(ref.repository, 'ISSUE', node), snapshot: snapshot(ref, node, node.state ?? 'UNKNOWN') };
  }

  async readPullRequest(ref: RemoteWorkRef, cwd: string): Promise<RemotePullRequest> {
    const node = await this.readItem(ref, cwd, PULL_FIELDS);
    const headSha = node.headRefOid;
    const baseSha = node.baseRefOid;
    if (!node.headRefName || !node.baseRefName || !isGitObjectId(headSha) || !isGitObjectId(baseSha) ||
        typeof node.isCrossRepository !== 'boolean') {
      throw new RemoteWorkError('FAILED', 'GitHub did not report the pull request’s branches.');
    }
    const headRepositoryPath = node.headRepository?.nameWithOwner
      ? normalizeRepositoryPath('GITHUB', node.headRepository.nameWithOwner) : undefined;
    return {
      summary: summary(ref.repository, 'PULL_REQUEST', node),
      snapshot: snapshot(ref, node, pullState(node)),
      headRefName: node.headRefName,
      headSha,
      ...(headRepositoryPath ? { headRepositoryPath } : {}),
      crossRepository: node.isCrossRepository,
      baseRefName: node.baseRefName,
      baseSha,
      baseIsMergeBase: false
    };
  }

  private async readItem(ref: RemoteWorkRef, cwd: string, fields: string): Promise<GitHubNode> {
    const [owner, name] = ref.repository.path.split('/') as [string, string];
    const data = await this.graphql<{ repository?: { issueOrPullRequest?: GitHubNode | null } | null }>(ref.repository, cwd,
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename ... on ${ref.kind === 'ISSUE' ? 'Issue' : 'PullRequest'} { ${fields} } } } }`,
      { owner, name }, { number: ref.number });
    if (!data.repository) throw notFound(ref.repository);
    const node = data.repository.issueOrPullRequest;
    const number = formatRemoteWorkNumber('GITHUB', ref.kind, ref.number);
    if (!node) throw new RemoteWorkError('NOT_FOUND', `${ref.repository.path}${number} does not exist.`);
    const expected = ref.kind === 'ISSUE' ? 'Issue' : 'PullRequest';
    if (node.__typename !== expected) {
      throw new RemoteWorkError('WRONG_KIND', `${number} is ${expected === 'Issue' ? 'a pull request' : 'an issue'}.`);
    }
    return node;
  }

  private graphql<T>(
    repository: RemoteRepositoryRef,
    cwd: string,
    query: string,
    strings: Record<string, string>,
    integers: Record<string, number> = {}
  ): Promise<T> {
    return this.cli.graphql<T>({ host: repository.host, cwd, query, strings, integers, subject: repository.path });
  }
}

function summary(repository: RemoteRepositoryRef, kind: RemoteWorkKind, node: GitHubNode): RemoteWorkSummary {
  if (typeof node.number !== 'number' || !node.url) {
    throw new RemoteWorkError('FAILED', 'GitHub did not report the item’s identity.');
  }
  const headRepositoryPath = node.headRepository?.nameWithOwner;
  const review = node.reviewDecision ? LIST_REVIEWS[node.reviewDecision] : undefined;
  const checkState = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const checks = checkState ? LIST_CHECKS[checkState] : undefined;
  return {
    ref: { repository, kind, number: node.number },
    url: node.url,
    title: (node.title ?? '').trim(),
    state: kind === 'PULL_REQUEST' ? pullState(node) as RemoteWorkSummary['state'] : node.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    ...(node.author?.login ? { author: node.author.login } : {}),
    ...(node.updatedAt ? { updatedAt: node.updatedAt } : {}),
    ...(kind === 'PULL_REQUEST' ? {
      draft: Boolean(node.isDraft),
      ...(node.headRefName ? { headRefName: node.headRefName } : {}),
      crossRepository: Boolean(node.isCrossRepository),
      ...(headRepositoryPath ? { headRepositoryPath } : {}),
      ...(review ? { review } : {}),
      ...(checks ? { checks } : {})
    } : {})
  };
}

function pullState(node: GitHubNode): string {
  return node.merged || node.state === 'MERGED' ? 'MERGED' : node.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

/** The captured text of an issue or a pull request: they differ only in the state read. */
function snapshot(ref: RemoteWorkRef, node: GitHubNode, state: string) {
  return buildRemoteWorkSnapshot({
    ref, url: requireUrl(ref, node), title: node.title ?? '', state,
    author: node.author?.login, labels: labels(node), body: node.body,
    comments: comments(node), commentCount: node.comments?.totalCount ?? 0, capturedAt: new Date().toISOString()
  });
}

function requireUrl(ref: RemoteWorkRef, node: GitHubNode): string {
  const expected = `https://${ref.repository.host}/${ref.repository.path}/${ref.kind === 'ISSUE' ? 'issues' : 'pull'}/${ref.number}`;
  if (node.number !== ref.number || node.url?.toLowerCase() !== expected.toLowerCase()) {
    throw new RemoteWorkError('FAILED', 'GitHub returned a different item than requested.');
  }
  return node.url;
}

function labels(node: GitHubNode): string[] {
  return (node.labels?.nodes ?? []).flatMap((label) => (label?.name ? [label.name] : []));
}

function comments(node: GitHubNode) {
  return (node.comments?.nodes ?? []).flatMap((comment) => comment ? [{
    author: comment.author?.login,
    createdAt: comment.createdAt,
    body: comment.body
  }] : []);
}


function notFound(repository: RemoteRepositoryRef): RemoteWorkError {
  return new RemoteWorkError('NOT_FOUND', `${repository.path} is not available on ${repository.host}.`);
}
