import { visibleRemoteText, type RemoteProvider } from './remoteWork';

/**
 * What people said on a pull or merge request: review threads on lines and
 * files, review summaries, and comments on the conversation. Task Monki reads
 * it at each refresh and keeps each observation as an artifact of the task;
 * the platform stays authoritative, and nothing is written back.
 */

export const PULL_REQUEST_FEEDBACK_SCHEMA = 'task-monki/pull-request-feedback/v1';

export const PULL_REQUEST_FEEDBACK_LIMITS = {
  discussions: 100,
  /** Per discussion: its first comment and the most recent replies. */
  comments: 10,
  reviewers: 20,
  body: 4_000,
  /** Every kept body together, in characters; past it, a body keeps only its start. */
  totalText: 200_000,
  excerpt: 280,
  path: 1_000,
  name: 100,
  /** The stored document; feedback that does not fit is not stored, and the last reading stands. */
  bytes: 2 * 1024 * 1024
} as const;

export const PULL_REQUEST_REVIEWER_STATES = ['REQUESTED', 'COMMENTED', 'CHANGES_REQUESTED', 'APPROVED'] as const;
/** Where a reviewer stands: asked and not yet answered, or their latest verdict. */
export type PullRequestReviewerState = (typeof PULL_REQUEST_REVIEWER_STATES)[number];

export interface PullRequestReviewer {
  name: string;
  state: PullRequestReviewerState;
  /** An app, not a person: it reviews on its own and cannot be asked to review again. */
  bot?: boolean;
}

export const PULL_REQUEST_DISCUSSION_KINDS = ['THREAD', 'REVIEW', 'COMMENT'] as const;
/**
 * A thread on lines, a file or the whole change, which the platform can
 * resolve; a review's summary; or a comment on the conversation.
 */
export type PullRequestDiscussionKind = (typeof PULL_REQUEST_DISCUSSION_KINDS)[number];

export interface PullRequestComment {
  author?: string;
  createdAt?: string;
  body: string;
  /** The body continues on the platform. */
  truncated: boolean;
}

export interface PullRequestDiscussion {
  /** The platform's identity: a GitHub node id, or a GitLab discussion id. */
  id: string;
  kind: PullRequestDiscussionKind;
  /** The file it is about; absent for the whole change. */
  path?: string;
  /** NEW for added and unchanged lines, OLD for removed ones. */
  side?: 'NEW' | 'OLD';
  /** The first line; absent for a whole file. On an outdated thread, the line it was written on. */
  line?: number;
  /** The last line of a range. */
  endLine?: number;
  resolvable: boolean;
  resolved: boolean;
  /** The lines it was written on changed after it was written. */
  outdated: boolean;
  /** A review's verdict. */
  reviewState?: 'CHANGES_REQUESTED' | 'APPROVED' | 'COMMENTED';
  /** Where it opens on the platform. */
  url?: string;
  /** Oldest first: the first comment, then the most recent replies. */
  comments: PullRequestComment[];
  /** Every comment the platform holds, including those not kept. */
  commentCount: number;
}

export interface PullRequestFeedback {
  schema: typeof PULL_REQUEST_FEEDBACK_SCHEMA;
  provider: RemoteProvider;
  number: number;
  /** The head the platform reported with this feedback. */
  headSha?: string;
  capturedAt: string;
  /** The signed-in account that read it: the person's own comments carry this name. */
  viewer?: string;
  reviewers: PullRequestReviewer[];
  /** In the order the platform lists them. */
  discussions: PullRequestDiscussion[];
  /** The platform holds more discussions than were read. */
  truncated: boolean;
}

/**
 * What a review observation keeps of its feedback, so a card can say it
 * without reading the artifact.
 */
export interface PullRequestFeedbackSummary {
  /** The task's `pull-request-feedback` artifact. */
  artifactId: string;
  /** Unchanged feedback keeps its artifact; the digest says when it changed. */
  digest: string;
  capturedAt: string;
  /** Threads the platform can resolve that are not resolved. */
  unresolvedCount: number;
  discussionCount: number;
  reviewers: PullRequestReviewer[];
  /** The account that read the feedback: the person, whose own request for changes is theirs to answer. */
  viewer?: string;
  /** The latest comment by the account that read the feedback, and by anyone else, in the platform's clock. */
  lastViewerCommentAt?: string;
  lastOtherCommentAt?: string;
}

/**
 * When the person last wrote on the pull request and when anyone else did:
 * whose move it is turns on which came last.
 */
export function feedbackTurnFacts(feedback: Pick<PullRequestFeedback, 'viewer' | 'discussions'>): Pick<PullRequestFeedbackSummary, 'viewer' | 'lastViewerCommentAt' | 'lastOtherCommentAt'> {
  let viewer = 0;
  let other = 0;
  for (const discussion of feedback.discussions) {
    for (const comment of discussion.comments) {
      const at = comment.createdAt ? Date.parse(comment.createdAt) : Number.NaN;
      if (!Number.isFinite(at)) continue;
      if (feedback.viewer && comment.author === feedback.viewer) viewer = Math.max(viewer, at);
      else other = Math.max(other, at);
    }
  }
  return {
    ...(feedback.viewer ? { viewer: feedback.viewer } : {}),
    ...(viewer ? { lastViewerCommentAt: new Date(viewer).toISOString() } : {}),
    ...(other ? { lastOtherCommentAt: new Date(other).toISOString() } : {})
  };
}

/**
 * Whose move a pull request whose review requested changes waits on. It is the
 * person's while a reviewer's request or thread stands unanswered; it is the
 * reviewers' once the person wrote after everyone else, or asked again every
 * reviewer who requested changes.
 */
export function reviewTurn(
  summary: Pick<PullRequestFeedbackSummary, 'reviewers' | 'viewer' | 'lastViewerCommentAt' | 'lastOtherCommentAt'>
): 'AUTHOR' | 'REVIEWERS' {
  const asking = summary.reviewers.filter((reviewer) => reviewer.state === 'CHANGES_REQUESTED');
  // The person's own request for changes, on a pull request they took on, stands until they make them.
  if (summary.viewer && asking.some((reviewer) => reviewer.name === summary.viewer)) return 'AUTHOR';
  const viewer = summary.lastViewerCommentAt ? Date.parse(summary.lastViewerCommentAt) : 0;
  const other = summary.lastOtherCommentAt ? Date.parse(summary.lastOtherCommentAt) : 0;
  if (viewer > other) return 'REVIEWERS';
  // A reviewer asked again reads as requested on the platform, its verdict standing until they review.
  if (!asking.length && summary.reviewers.some((reviewer) => reviewer.state === 'REQUESTED')) return 'REVIEWERS';
  return 'AUTHOR';
}

/** A discussion that still asks for something: an unresolved thread, or a review requesting changes. */
export function isOpenDiscussion(discussion: Pick<PullRequestDiscussion, 'kind' | 'resolvable' | 'resolved' | 'reviewState'>): boolean {
  return discussion.resolvable ? !discussion.resolved : discussion.kind === 'REVIEW' && discussion.reviewState === 'CHANGES_REQUESTED';
}

export function unresolvedDiscussionCount(discussions: readonly Pick<PullRequestDiscussion, 'resolvable' | 'resolved'>[]): number {
  return discussions.filter((discussion) => discussion.resolvable && !discussion.resolved).length;
}

/** A platform discussion as a reader produced it, before bounding. */
export interface RawPullRequestDiscussion extends Omit<PullRequestDiscussion, 'comments' | 'commentCount'> {
  comments: Array<{ author?: string; createdAt?: string; body: string }>;
  commentCount?: number;
}

/**
 * Feedback within bounds: a discussion keeps its first comment and its most
 * recent replies, each body is cut at a character boundary, and once every
 * kept body reaches the shared budget, the rest keep only their start. Open
 * discussions are bounded first, so a long resolved thread never crowds out
 * one that still asks for something. Comments without text are dropped, and
 * so is a discussion left with none.
 */
export function boundPullRequestFeedback(input: {
  provider: RemoteProvider;
  number: number;
  headSha?: string;
  capturedAt: string;
  viewer?: string;
  reviewers: readonly PullRequestReviewer[];
  discussions: readonly RawPullRequestDiscussion[];
  truncated: boolean;
}): PullRequestFeedback {
  const limits = PULL_REQUEST_FEEDBACK_LIMITS;
  let budget = limits.totalText;
  const bound = (text: string) => {
    const limit = Math.min(limits.body, Math.max(limits.excerpt, budget));
    const characters = Array.from(text);
    budget -= Math.min(characters.length, limit);
    return characters.length > limit
      ? { body: characters.slice(0, limit).join(''), truncated: true }
      : { body: text, truncated: false };
  };
  // Past the bound, what still asks for something is kept first, then the most recent.
  const kept = new Set([...input.discussions.keys()]
    .sort((left, right) => Number(isOpenDiscussion(input.discussions[right]!)) - Number(isOpenDiscussion(input.discussions[left]!)) ||
      latestComment(input.discussions[right]!) - latestComment(input.discussions[left]!))
    .slice(0, limits.discussions));
  const listed = input.discussions.filter((_discussion, index) => kept.has(index));
  const order = [...listed.keys()].sort((left, right) =>
    Number(isOpenDiscussion(listed[right]!)) - Number(isOpenDiscussion(listed[left]!)));
  const bounded = new Map<number, PullRequestDiscussion>();
  for (const index of order) {
    const discussion = listed[index]!;
    if (!shortText(discussion.id)) continue;
    const written = discussion.comments
      .map((comment) => ({ ...comment, body: visibleText(comment.body) }))
      .filter((comment) => comment.body);
    if (written.length === 0) continue;
    const kept = written.length > limits.comments
      ? [written[0]!, ...written.slice(written.length - (limits.comments - 1))]
      : written;
    const { comments: _comments, commentCount, path, ...rest } = discussion;
    const trimmedPath = path?.trim();
    bounded.set(index, {
      ...rest,
      ...(trimmedPath ? { path: trimmedPath.slice(0, limits.path).trim() } : {}),
      comments: kept.map((comment) => ({
        ...(comment.author?.trim() ? { author: comment.author.trim().slice(0, limits.name).trim() } : {}),
        ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
        ...bound(comment.body)
      })),
      commentCount: Math.max(commentCount ?? written.length, written.length)
    });
  }
  return {
    schema: PULL_REQUEST_FEEDBACK_SCHEMA,
    provider: input.provider,
    number: input.number,
    ...(input.headSha ? { headSha: input.headSha } : {}),
    capturedAt: input.capturedAt,
    ...(input.viewer?.trim() ? { viewer: input.viewer.trim().slice(0, limits.name).trim() } : {}),
    reviewers: input.reviewers.map((reviewer) => ({
      name: reviewer.name.trim().slice(0, limits.name).trim(),
      state: reviewer.state,
      ...(reviewer.bot ? { bot: true } : {})
    })).filter((reviewer) => reviewer.name).slice(0, limits.reviewers),
    discussions: [...listed.keys()].flatMap((index) => bounded.get(index) ?? []),
    truncated: input.truncated || input.discussions.length > limits.discussions
  };
}

/**
 * Reads a stored feedback artifact. Anything malformed is left out rather
 * than shown: a discussion without an identity or text, a reviewer without a
 * name. A document of another schema or number reads as nothing.
 */
export function parsePullRequestFeedback(text: string, number?: number): PullRequestFeedback | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.schema !== PULL_REQUEST_FEEDBACK_SCHEMA) return undefined;
  if (value.provider !== 'GITHUB' && value.provider !== 'GITLAB') return undefined;
  if (!positiveInteger(value.number) || (number !== undefined && value.number !== number)) return undefined;
  if (typeof value.capturedAt !== 'string' || !Array.isArray(value.discussions) || !Array.isArray(value.reviewers)) return undefined;
  const discussions = value.discussions.flatMap((entry): PullRequestDiscussion[] => {
    if (!isRecord(entry) || !shortText(entry.id) || !(PULL_REQUEST_DISCUSSION_KINDS as readonly unknown[]).includes(entry.kind)) return [];
    const comments = Array.isArray(entry.comments) ? entry.comments.flatMap((comment): PullRequestComment[] =>
      isRecord(comment) && typeof comment.body === 'string' && comment.body.trim() ? [{
        ...(shortText(comment.author) ? { author: comment.author } : {}),
        ...(typeof comment.createdAt === 'string' ? { createdAt: comment.createdAt } : {}),
        body: comment.body,
        truncated: comment.truncated === true
      }] : []) : [];
    if (comments.length === 0) return [];
    const line = positiveInteger(entry.line) ? entry.line : undefined;
    return [{
      id: entry.id,
      kind: entry.kind as PullRequestDiscussionKind,
      ...(typeof entry.path === 'string' && entry.path.trim() ? { path: entry.path } : {}),
      ...(entry.side === 'NEW' || entry.side === 'OLD' ? { side: entry.side } : {}),
      ...(line ? { line } : {}),
      ...(line && positiveInteger(entry.endLine) && entry.endLine > line ? { endLine: entry.endLine } : {}),
      resolvable: entry.resolvable === true,
      resolved: entry.resolved === true,
      outdated: entry.outdated === true,
      ...(entry.reviewState === 'CHANGES_REQUESTED' || entry.reviewState === 'APPROVED' || entry.reviewState === 'COMMENTED'
        ? { reviewState: entry.reviewState } : {}),
      ...(typeof entry.url === 'string' && /^https:\/\//u.test(entry.url) ? { url: entry.url } : {}),
      comments,
      commentCount: positiveInteger(entry.commentCount) ? Math.max(entry.commentCount, comments.length) : comments.length
    }];
  });
  return {
    schema: PULL_REQUEST_FEEDBACK_SCHEMA,
    provider: value.provider,
    number: value.number,
    ...(typeof value.headSha === 'string' ? { headSha: value.headSha } : {}),
    capturedAt: value.capturedAt,
    ...(shortText(value.viewer) ? { viewer: value.viewer } : {}),
    reviewers: value.reviewers.flatMap((reviewer): PullRequestReviewer[] =>
      isRecord(reviewer) && shortText(reviewer.name) && (PULL_REQUEST_REVIEWER_STATES as readonly unknown[]).includes(reviewer.state)
        ? [{ name: reviewer.name, state: reviewer.state as PullRequestReviewerState, ...(reviewer.bot === true ? { bot: true } : {}) }] : []),
    discussions,
    truncated: value.truncated === true
  };
}

/** The text a reader sees on the platform, trimmed. */
function visibleText(body: string): string {
  return visibleRemoteText(body).trim();
}

function latestComment(discussion: RawPullRequestDiscussion): number {
  return Math.max(0, ...discussion.comments.map((comment) => {
    const time = comment.createdAt ? Date.parse(comment.createdAt) : Number.NaN;
    return Number.isFinite(time) ? time : 0;
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
