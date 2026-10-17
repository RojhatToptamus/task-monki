import {
  boundPullRequestFeedback,
  type PullRequestFeedback,
  type PullRequestReviewer,
  type PullRequestReviewerState,
  type RawPullRequestDiscussion
} from '../../shared/pullRequestFeedback';

interface GitLabLinePosition {
  new_line?: number | null;
  old_line?: number | null;
}

export interface GitLabDiscussionNote {
  id?: number;
  type?: string | null;
  body?: string;
  author?: { username?: string } | null;
  created_at?: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: (GitLabLinePosition & {
    new_path?: string;
    old_path?: string;
    head_sha?: string;
    position_type?: string;
    line_range?: { start?: GitLabLinePosition | null; end?: GitLabLinePosition | null } | null;
  }) | null;
}

export interface GitLabDiscussion {
  id?: string;
  individual_note?: boolean;
  notes?: GitLabDiscussionNote[];
}

export interface GitLabReviewer {
  user?: { username?: string } | null;
  state?: string;
}

/** A merge request reviewer's state in Task Monki's words; GitLab adds states, and an unknown one reads as asked. */
function reviewerState(state: string | undefined): PullRequestReviewerState {
  switch (state) {
    case 'requested_changes': return 'CHANGES_REQUESTED';
    case 'approved': return 'APPROVED';
    case 'reviewed': return 'COMMENTED';
    default: return 'REQUESTED';
  }
}

/** Reviewers and approvers, one entry each; an approval stands for anyone it names. */
export function gitLabReviewers(
  reviewers: readonly GitLabReviewer[] | undefined,
  approvedBy: ReadonlyArray<{ user?: { username?: string } | null }> | undefined
): PullRequestReviewer[] {
  const states = new Map<string, PullRequestReviewerState>();
  for (const reviewer of reviewers ?? []) {
    const name = reviewer.user?.username;
    if (name) states.set(name, reviewerState(reviewer.state));
  }
  for (const approval of approvedBy ?? []) {
    const name = approval.user?.username;
    if (name && states.get(name) !== 'CHANGES_REQUESTED') states.set(name, 'APPROVED');
  }
  return [...states].map(([name, state]) => ({ name, state }));
}

/**
 * A merge request's discussions as Task Monki keeps them. System notes are
 * the platform's own record and are left out. A diff note whose position is on
 * an earlier head than the merge request's now was written on lines that have
 * changed: GitLab moves a note to the new diff while its line is unchanged.
 */
export function parseGitLabMergeRequestFeedback(input: {
  number: number;
  webUrl?: string;
  headSha?: string;
  discussions: readonly GitLabDiscussion[];
  reviewers: PullRequestReviewer[];
  capturedAt: string;
  /** The signed-in account. */
  viewer?: string;
  /** The last page read was full, so there may be more. */
  more: boolean;
}): PullRequestFeedback {
  const discussions = input.discussions.flatMap((discussion): RawPullRequestDiscussion[] => {
    const notes = (discussion.notes ?? []).filter((note) => !note.system && note.body?.trim());
    const first = notes[0];
    if (!discussion.id || !first) return [];
    const resolvableNotes = notes.filter((note) => note.resolvable);
    const position = first.type === 'DiffNote' ? first.position ?? undefined : undefined;
    const location = position ? diffLocation(position) : undefined;
    return [{
      id: discussion.id,
      kind: discussion.individual_note ? 'COMMENT' : 'THREAD',
      ...(location ?? {}),
      resolvable: resolvableNotes.length > 0,
      resolved: resolvableNotes.length > 0 && resolvableNotes.every((note) => note.resolved),
      outdated: Boolean(position?.head_sha && input.headSha && position.head_sha !== input.headSha),
      ...(input.webUrl && /^https:\/\//u.test(input.webUrl) && typeof first.id === 'number' ? { url: `${input.webUrl}#note_${first.id}` } : {}),
      comments: notes.map((note) => ({
        ...(note.author?.username ? { author: note.author.username } : {}),
        ...(note.created_at ? { createdAt: note.created_at } : {}),
        body: note.body ?? ''
      })),
      commentCount: notes.length
    }];
  });
  return boundPullRequestFeedback({
    provider: 'GITLAB',
    number: input.number,
    ...(input.headSha ? { headSha: input.headSha } : {}),
    capturedAt: input.capturedAt,
    ...(input.viewer ? { viewer: input.viewer } : {}),
    reviewers: input.reviewers,
    discussions,
    truncated: input.more
  });
}

function diffLocation(position: NonNullable<GitLabDiscussionNote['position']>): Pick<RawPullRequestDiscussion, 'path' | 'side' | 'line' | 'endLine'> | undefined {
  const side = typeof position.new_line === 'number' ? 'NEW' as const : typeof position.old_line === 'number' ? 'OLD' as const : undefined;
  const path = side === 'OLD' ? position.old_path ?? position.new_path : position.new_path ?? position.old_path;
  if (!path) return undefined;
  // A comment on the whole file has a path and no line.
  if (!side || position.position_type === 'file') return { path };
  const end = side === 'NEW' ? position.new_line! : position.old_line!;
  const startPosition = position.line_range?.start;
  const start = side === 'NEW' ? startPosition?.new_line : startPosition?.old_line;
  const range = typeof start === 'number' && start >= 1 && start < end;
  return { path, side, line: range ? start : end, ...(range ? { endLine: end } : {}) };
}

/** GitLab's largest page; a full page may not be every discussion. */
export const GITLAB_DISCUSSION_PAGE = 100;
/** Discussions are read a page at a time, up to this many pages. */
export const GITLAB_DISCUSSION_PAGES = 5;
