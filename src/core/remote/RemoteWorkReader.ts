import {
  REMOTE_WORK_LIMITS,
  REMOTE_WORK_SNAPSHOT_SCHEMA,
  boundRemoteText,
  visibleRemoteText,
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
}

/** Reads one platform's issues and pull requests. Platform text is untrusted. */
export interface RemoteWorkReader {
  list(repository: RemoteRepositoryRef, kind: RemoteWorkKind, text: string | undefined, cwd: string): Promise<RemoteWorkSummary[]>;
  readIssue(ref: RemoteWorkRef, cwd: string): Promise<{ summary: RemoteWorkSummary; snapshot: RemoteWorkSnapshot }>;
  readPullRequest(ref: RemoteWorkRef, cwd: string): Promise<RemotePullRequest>;
}

/**
 * An item's title as a reader sees it, the same in a list as in a snapshot:
 * bounded and trimmed, since the store keeps no surrounding whitespace, and
 * `Untitled` when nothing visible remains.
 */
export function visibleRemoteTitle(title: string | undefined): string {
  return boundRemoteText(visibleRemoteText(title), REMOTE_WORK_LIMITS.title).text.trim() || 'Untitled';
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
    number: input.ref.number,
    url: input.url,
    title: visibleRemoteTitle(input.title),
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
