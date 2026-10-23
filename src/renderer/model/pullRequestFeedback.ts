import {
  discussionCommentText,
  discussionSummary,
  discussionTranscript,
  isOpenDiscussion,
  type DomainEvent,
  type PullRequestDiscussion,
  type PullRequestFeedback,
  type PullRequestFeedbackSummary,
  type PullRequestReviewer,
  type RemoteProvider,
  type ReviewRequestRecord,
  type ReviewResponseAnswer,
  type ReviewResponseOutcome
} from '../../shared/contracts';
import { INVISIBLE_CHARACTERS } from '../../shared/remoteWork';
import type { DiffFile } from './diffEvidence';
import { formatCommentLocation, listNames } from './formatting';
import { normalizeReviewPath } from './reviewWorkspace';

/** A discussion's summary, a comment's text and its transcript sit with the feedback contract; the Review tab reads them from here. */
export { discussionCommentText, discussionSummary, discussionTranscript };

/** What became of a discussion the person sent to the agent. */
interface DiscussionSent {
  at: string;
  /** The review the request followed. */
  reviewRunId?: string;
  /** Its latest comment when sent, in the platform's clock. */
  seenAt?: string;
  /** The agent's answer, once its reply gave one, and when the reply finished. */
  outcome?: ReviewResponseOutcome;
  note?: string;
  answeredAt?: string;
}

/** A pull request discussion as the Review tab shows it. */
export interface DiscussionView extends PullRequestDiscussion {
  provider: RemoteProvider;
  /** It still asks for something: an unresolved thread, or a review requesting changes. */
  open: boolean;
  /** Sent in a request with nothing new said on it since, except by the person. */
  sent?: DiscussionSent;
  /** The person wrote its latest comment: it waits on the other side. */
  replied?: boolean;
}

/** A request the person sent and the agent's answers to it. */
export interface ReviewRequestRound {
  /** The message that carried it. */
  instructionId: string;
  at: string;
  request: ReviewRequestRecord;
  answers: readonly ReviewResponseAnswer[];
  /** When the agent's reply finished; absent while it runs. */
  answeredAt?: string;
}

/** The discussions each request sent; a later request supersedes an earlier one. */
export function sentDiscussions(rounds: readonly Omit<ReviewRequestRound, 'instructionId'>[]): Map<string, DiscussionSent> {
  const sent = new Map<string, DiscussionSent>();
  for (const round of [...rounds].sort((left, right) => time(left.at) - time(right.at))) {
    const answers = new Map(round.answers.map((answer) => [answer.item, answer]));
    for (const item of round.request.items) {
      if (item.kind !== 'DISCUSSION') continue;
      const answer = answers.get(item.number);
      sent.set(item.discussionId, {
        at: round.at,
        ...(round.request.reviewRunId ? { reviewRunId: round.request.reviewRunId } : {}),
        ...(item.seenAt ? { seenAt: item.seenAt } : {}),
        ...(answer ? {
          outcome: answer.outcome,
          ...(answer.note ? { note: answer.note } : {}),
          ...(round.answeredAt ? { answeredAt: round.answeredAt } : {})
        } : {})
      });
    }
  }
  return sent;
}

/** Every pull request without feedback reads this one list, so what is derived from it keeps its identity. */
const NO_DISCUSSION_VIEWS = Object.freeze<DiscussionView[]>([]) as DiscussionView[];

/**
 * The feedback's discussions with what the person did about them. A comment
 * someone else wrote after the request was sent asks again, so the discussion
 * reads as unsent; the person's own replies, written as the account that read
 * the feedback, do not.
 */
export function buildDiscussionViews(
  feedback: PullRequestFeedback | undefined,
  sent: ReadonlyMap<string, DiscussionSent>,
  /** A merged or closed pull request asks nothing more; its discussions are its history. */
  pullRequestOpen = true
): DiscussionView[] {
  if (!feedback) return NO_DISCUSSION_VIEWS;
  // The person's own comments on the conversation, such as replies posted from here, ask nothing of them.
  const own = (discussion: PullRequestDiscussion) =>
    discussion.kind === 'COMMENT' && Boolean(feedback.viewer) && discussion.comments[0]?.author === feedback.viewer;
  return feedback.discussions.filter((discussion) => !own(discussion)).map((discussion) => {
    const request = sent.get(discussion.id);
    // Compared in the platform's clock when the request recorded it, so a skewed local clock misjudges nothing.
    const answeredSince = request && discussion.comments.some((comment) =>
      comment.author !== feedback.viewer && time(comment.createdAt) > time(request.seenAt ?? request.at));
    const replied = Boolean(feedback.viewer) && discussion.comments.length > 1 && discussion.comments.at(-1)?.author === feedback.viewer;
    return {
      ...discussion,
      provider: feedback.provider,
      open: pullRequestOpen && isOpenDiscussion(discussion),
      ...(request && !answeredSince ? { sent: request } : {}),
      ...(replied ? { replied: true } : {})
    };
  });
}

/** A discussion the agent answered, for the person to reply to where the discussion lives. */
export interface ReplyDraft {
  discussionId: string;
  kind: PullRequestDiscussion['kind'];
  author?: string;
  /** The discussion's first line, so the person sees what the reply answers. */
  summary: string;
  location?: string;
  outcome: 'FIXED' | 'NOT_CHANGED';
  /** The agent's note on its answer, and when it answered: shown to the person, never posted. */
  note?: string;
  answeredAt?: string;
  /**
   * Where the person's reply starts: the fact "Changed in <head>." when the agent
   * answered Fixed and the discussion's file changed since the review, otherwise
   * nothing. The person writes the rest before anything is posted.
   */
  body: string;
  /** A thread the reply can resolve. */
  resolvable: boolean;
}

/** The files changed since a review, by normalized path: what the replies to its request may say changed. */
export interface ChangedSinceReview {
  reviewRunId: string;
  paths: ReadonlySet<string>;
}

/** The paths a diff changes, normalized; a renamed file under both its names. */
export function changedPaths(files: readonly Pick<DiffFile, 'path' | 'oldPath'>[]): Set<string> {
  return new Set(files.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])].map(normalizeReviewPath)));
}

/**
 * When the person last answered each discussion from Task Monki. A review's
 * answer is a comment of its own on the pull request, never one of the
 * review's comments, so only these records say it was answered.
 */
export function repliedDiscussions(events: readonly DomainEvent[]): Map<string, string> {
  const replied = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'PR_REPLIES_POSTED') continue;
    const ids = (event.payload as { replied?: unknown } | undefined)?.replied;
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id === 'string' && time(event.occurredAt) > time(replied.get(id) ?? '')) replied.set(id, event.occurredAt);
    }
  }
  return replied;
}

/**
 * Discussions the agent answered that no one has replied to on the platform
 * since: each is a reply for the person to write. A public reply never repeats
 * the agent: it starts from the one fact Task Monki observed, that a file the
 * agent said it fixed changed since the review, named by the head that holds
 * it. A decision the agent left to the person is the person's to answer.
 */
export function buildReplyDrafts(
  discussions: readonly DiscussionView[],
  viewer: string | undefined,
  headSha: string | undefined,
  /** When the person answered each discussion from Task Monki, in this clock. */
  replied: ReadonlyMap<string, string> = new Map(),
  changed?: ChangedSinceReview
): ReplyDraft[] {
  return discussions.flatMap((discussion): ReplyDraft[] => {
    const sent = discussion.sent;
    if (!discussion.open || (sent?.outcome !== 'FIXED' && sent?.outcome !== 'NOT_CHANGED')) return [];
    // Answered from here after the request went out: a later request sends it again.
    if (time(replied.get(discussion.id) ?? '') > time(sent.at)) return [];
    const since = time(sent.seenAt ?? sent.at);
    if (viewer && discussion.comments.some((comment) => comment.author === viewer && time(comment.createdAt) > since)) return [];
    const fileChanged = Boolean(discussion.path && changed && sent.reviewRunId === changed.reviewRunId &&
      changed.paths.has(normalizeReviewPath(discussion.path)));
    const location = formatDiscussionLocation(discussion);
    const author = discussionAuthor(discussion);
    return [{
      discussionId: discussion.id,
      kind: discussion.kind,
      ...(author ? { author } : {}),
      summary: discussionSummary(discussion),
      ...(location ? { location } : {}),
      outcome: sent.outcome,
      ...(sent.note ? { note: sent.note } : {}),
      ...(sent.answeredAt ? { answeredAt: sent.answeredAt } : {}),
      body: sent.outcome === 'FIXED' && fileChanged && headSha ? `Changed in ${headSha.slice(0, 7)}.` : '',
      resolvable: discussion.resolvable && !discussion.resolved
    }];
  });
}

/**
 * Discussions that still ask for something and were not sent since: what
 * Address comments adds. One the person answered last waits on its reviewer,
 * sent or not.
 */
export function unaddressedDiscussions(discussions: readonly DiscussionView[]): DiscussionView[] {
  return discussions.filter((discussion) => discussion.open && !discussion.sent && !discussion.replied);
}

/** Who started a discussion. */
export function discussionAuthor(discussion: Pick<PullRequestDiscussion, 'comments'>): string | undefined {
  return discussion.comments[0]?.author;
}

/** A comment's prose, and each change it suggests with the lines around its own that it also replaces. */
type CommentPart =
  | { kind: 'text'; text: string }
  | { kind: 'suggestion'; lines: string[]; above: number; below: number };

/**
 * A comment in order: its prose and its suggested changes, the platforms'
 * ```suggestion blocks. GitLab's `suggestion:-1+2` also replaces one line above
 * the comment's and two below; an empty suggestion removes the lines.
 */
export function commentParts(text: string): CommentPart[] {
  const parts: CommentPart[] = [];
  const pattern = /^```suggestion(?::-(\d+)\+(\d+))?[ \t]*\n([\s\S]*?)^```[ \t]*$/gmu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(last, match.index).trim();
    if (before) parts.push({ kind: 'text', text: before });
    const content = (match[3] ?? '').replace(/\n$/u, '');
    parts.push({ kind: 'suggestion', lines: content ? content.split('\n') : [], above: Number(match[1] ?? 0), below: Number(match[2] ?? 0) });
    last = (match.index ?? 0) + match[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) parts.push({ kind: 'text', text: rest });
  return parts.length ? parts : [{ kind: 'text', text }];
}

/**
 * Where a discussion points; a review or a comment on the whole pull request
 * points at no file. GitHub places a thread on the old side for any line of the
 * old file, unchanged ones included, so that side names the old file's line,
 * never a removed one. The path is the platform's text: characters no reader
 * sees are dropped, so the agent reads the path the person sees.
 */
export function formatDiscussionLocation(discussion: Pick<PullRequestDiscussion, 'path' | 'side' | 'line' | 'endLine'>): string | undefined {
  const path = discussion.path?.replace(INVISIBLE_CHARACTERS, '');
  return path ? formatCommentLocation({ ...discussion, path }, 'old') : undefined;
}

/** A review's verdict as a reviewer's action. */
export function reviewVerdictWords(state: PullRequestDiscussion['reviewState']): string | undefined {
  switch (state) {
    case 'CHANGES_REQUESTED': return 'requested changes';
    case 'APPROVED': return 'approved';
    default: return undefined;
  }
}

/**
 * What the pull request's people ask of it, as one fact: who requested changes,
 * who it waits on, and how many threads are unresolved. Approvals are left to
 * the review state, which already says them. Names keep the platform's case.
 */
export function pullRequestFeedbackLine(summary: Pick<PullRequestFeedbackSummary, 'reviewers' | 'unresolvedCount'>): string | undefined {
  const named = (state: PullRequestReviewer['state']) => summary.reviewers.filter((reviewer) => reviewer.state === state).map((reviewer) => reviewer.name);
  // Once someone asked for changes, that request is the blocker; who else is asked is the record's.
  const requested = named('CHANGES_REQUESTED');
  const parts = [
    joinNames(requested, 'requested changes'),
    !requested.length && named('REQUESTED').length ? `waiting on ${listNames(named('REQUESTED'))}` : undefined,
    summary.unresolvedCount > 0 ? `${summary.unresolvedCount} unresolved ${summary.unresolvedCount === 1 ? 'thread' : 'threads'}` : undefined
  ].filter((part): part is string => Boolean(part));
  if (!parts.length) return undefined;
  const line = parts.join(', ');
  return line.startsWith('waiting') ? `W${line.slice(1)}` : line;
}

/** Who an answered review waits on: whoever asked for changes, and whoever is asked to review. */
export function reviewWaitingLine(summary: Pick<PullRequestFeedbackSummary, 'reviewers'>): string | undefined {
  const names = summary.reviewers
    .filter((reviewer) => reviewer.state === 'CHANGES_REQUESTED' || reviewer.state === 'REQUESTED')
    .map((reviewer) => reviewer.name);
  return names.length ? `Waiting on ${listNames(names)}` : undefined;
}

function joinNames(names: readonly string[], verb: string): string | undefined {
  return names.length ? `${listNames(names)} ${verb}` : undefined;
}

function time(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
