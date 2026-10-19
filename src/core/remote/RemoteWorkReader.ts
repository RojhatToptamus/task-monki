import {
  REMOTE_WORK_LIMITS,
  REMOTE_WORK_SNAPSHOT_SCHEMA,
  boundRemoteText,
  visibleRemoteText,
  type RemoteProvider,
  type RemoteRepositoryRef,
  type RemoteWorkComment,
  type RemoteWorkKind,
  type RemoteWorkRef,
  type RemoteWorkSnapshot,
  type RemoteWorkSummary
} from '../../shared/remoteWork';

/** A pull or merge request as its platform reports it, read for opening. */
export interface RemotePullRequest {
  summary: RemoteWorkSummary;
  snapshot: RemoteWorkSnapshot;
  headRefName: string;
  headSha: string;
  /** Absent when the head repository was deleted. */
  headRepositoryPath?: string;
  crossRepository: boolean;
  baseRefName: string;
  /**
   * GitHub reports the target branch tip, and Task Monki computes the merge
   * base; GitLab reports the merge base itself.
   */
  baseSha: string;
  baseIsMergeBase: boolean;
  /** The ref in the target repository that holds the head, forks included. */
  headFetchRef: string;
}

/** Reads one platform's issues and pull requests. Platform text is untrusted. */
export interface RemoteWorkReader {
  readonly provider: RemoteProvider;
  setExecutable(executable: string | undefined): void;
  list(repository: RemoteRepositoryRef, kind: RemoteWorkKind, text: string | undefined, cwd: string): Promise<RemoteWorkSummary[]>;
  readIssue(ref: RemoteWorkRef, cwd: string): Promise<{ summary: RemoteWorkSummary; snapshot: RemoteWorkSnapshot }>;
  readPullRequest(ref: RemoteWorkRef, cwd: string): Promise<RemotePullRequest>;
}

/** The bounded text a task keeps: the body and the most recent comments. */
export function buildRemoteWorkSnapshot(input: {
  ref: RemoteWorkRef;
  url: string;
  title: string;
  state: string;
  author?: string;
  labels: readonly string[];
  body?: string;
  comments: ReadonlyArray<{ author?: string; createdAt?: string; body?: string }>;
  commentCount: number;
  capturedAt: string;
}): RemoteWorkSnapshot {
  const body = boundRemoteText(visibleRemoteText(input.body).trim(), REMOTE_WORK_LIMITS.body);
  const comments: RemoteWorkComment[] = input.comments
    .map((comment) => ({ ...comment, body: visibleRemoteText(comment.body).trim() }))
    // A comment that holds only hidden text says nothing a reader sees.
    .filter((comment) => comment.body)
    .slice(-REMOTE_WORK_LIMITS.comments)
    .map((comment) => {
      const text = boundRemoteText(comment.body, REMOTE_WORK_LIMITS.comment);
      return {
        ...(comment.author ? { author: comment.author } : {}),
        ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
        body: text.text,
        truncated: text.truncated
      };
    });
  return {
    schema: REMOTE_WORK_SNAPSHOT_SCHEMA,
    provider: input.ref.repository.provider,
    host: input.ref.repository.host,
    repositoryPath: input.ref.repository.path,
    kind: input.ref.kind,
    number: input.ref.number,
    url: input.url,
    // Display text is trimmed here: the store keeps no surrounding whitespace.
    title: boundRemoteText(visibleRemoteText(input.title), REMOTE_WORK_LIMITS.title).text.trim() || 'Untitled',
    state: input.state,
    ...(input.author ? { author: input.author } : {}),
    labels: input.labels.slice(0, REMOTE_WORK_LIMITS.labels).map((label) => boundRemoteText(visibleRemoteText(label), 100).text.trim()).filter(Boolean),
    body: body.text,
    bodyTruncated: body.truncated,
    comments,
    commentCount: Math.max(input.commentCount, comments.length),
    capturedAt: input.capturedAt
  };
}
