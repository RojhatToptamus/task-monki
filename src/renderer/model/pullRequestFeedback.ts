import {
  isOpenDiscussion,
  type DomainEvent,
  type PullRequestComment,
  type PullRequestDiscussion,
  type PullRequestFeedback,
  type PullRequestFeedbackSummary,
  type PullRequestReviewer,
  type RemoteProvider,
  type ReviewRequestRecord,
  type ReviewResponseAnswer,
  type ReviewResponseOutcome
} from '../../shared/contracts';

/** What became of a discussion the person sent to the agent. */
export interface DiscussionSent {
  at: string;
  /** Its latest comment when sent, in the platform's clock. */
  seenAt?: string;
  /** The agent's answer, once its reply gave one. */
  outcome?: ReviewResponseOutcome;
  note?: string;
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
  at: string;
  request: ReviewRequestRecord;
  answers: readonly ReviewResponseAnswer[];
}

/** The discussions each request sent; a later request supersedes an earlier one. */
export function sentDiscussions(rounds: readonly ReviewRequestRound[]): Map<string, DiscussionSent> {
  const sent = new Map<string, DiscussionSent>();
  for (const round of [...rounds].sort((left, right) => time(left.at) - time(right.at))) {
    const answers = new Map(round.answers.map((answer) => [answer.item, answer]));
    for (const item of round.request.items) {
      if (item.kind !== 'DISCUSSION') continue;
      const answer = answers.get(item.number);
      sent.set(item.discussionId, {
        at: round.at,
        ...(item.seenAt ? { seenAt: item.seenAt } : {}),
        ...(answer ? { outcome: answer.outcome, ...(answer.note ? { note: answer.note } : {}) } : {})
      });
    }
  }
  return sent;
}

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
  if (!feedback) return [];
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

/** An answer to a discussion, ready for the person to post where the discussion lives. */
export interface ReplyDraft {
  discussionId: string;
  kind: PullRequestDiscussion['kind'];
  author?: string;
  /** The discussion's first line, so the person sees what the reply answers. */
  summary: string;
  location?: string;
  outcome: 'FIXED' | 'NOT_CHANGED';
  /** Written from the agent's answer; the person edits it before anything is posted. */
  body: string;
  /** A thread the reply can resolve. */
  resolvable: boolean;
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
 * since: each answer becomes a reply the person can post. A fix names the head
 * it is in; a decision the agent left to the person is the person's to answer.
 */
export function buildReplyDrafts(
  discussions: readonly DiscussionView[],
  viewer: string | undefined,
  headSha: string | undefined,
  /** When the person answered each discussion from Task Monki, in this clock. */
  replied: ReadonlyMap<string, string> = new Map()
): ReplyDraft[] {
  return discussions.flatMap((discussion): ReplyDraft[] => {
    const sent = discussion.sent;
    if (!discussion.open || (sent?.outcome !== 'FIXED' && sent?.outcome !== 'NOT_CHANGED')) return [];
    // Answered from here after the request went out: a later request sends it again.
    if (time(replied.get(discussion.id) ?? '') > time(sent.at)) return [];
    const since = time(sent.seenAt ?? sent.at);
    if (viewer && discussion.comments.some((comment) => comment.author === viewer && time(comment.createdAt) > since)) return [];
    const note = sent.note?.trim();
    const body = sent.outcome === 'FIXED'
      ? [headSha ? `Fixed in ${headSha.slice(0, 7)}.` : 'Fixed.', note].filter(Boolean).join(' ')
      : note ? `Not changed. ${note}` : 'Not changed.';
    const location = formatDiscussionLocation(discussion);
    const author = discussionAuthor(discussion);
    return [{
      discussionId: discussion.id,
      kind: discussion.kind,
      ...(author ? { author } : {}),
      summary: discussionSummary(discussion),
      ...(location ? { location } : {}),
      outcome: sent.outcome,
      body,
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

/** HTML GitHub and GitLab render; a tag outside this set, such as `List<String>` in prose, stays text. */
const PLATFORM_TAG = /<\/?(details|summary|blockquote|p|div|span|br|hr|sub|sup|b|i|u|strong|em|ins|del|s|kbd|a|img|picture|source|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|h[1-6]|dl|dt|dd|center|code|pre)\b[^>]*>/giu;
const BLOCK_TAG = /^(details|summary|blockquote|p|div|br|hr|table|thead|tbody|tfoot|tr|ul|ol|li|h[1-6]|dl|dt|dd|center|pre)$/iu;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * A comment as the Review tab renders it. The platforms render HTML, which the
 * app's markdown would show as tags, so the tags give way to their text: a
 * collapsed `<details>` reads as its summary and its contents. Code, fenced or
 * inline, keeps every character.
 */
export function displayPlatformText(body: string): string {
  return body.split(/(```[\s\S]*?```)/u).map((part, fence) => fence % 2 === 1 ? part
    : part.split(/(`[^`\n]+`)/u).map((piece, code) => code % 2 === 1 ? piece
      : piece
        .replace(PLATFORM_TAG, (_tag, name: string) => (BLOCK_TAG.test(name) ? '\n' : ''))
        .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/gu, (entity) => ENTITIES[entity] ?? entity)).join('')).join('')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** A comment as the person reads it in Task Monki, and so as an agent is sent it; never empty. */
export function discussionCommentText(body: string): string {
  return displayPlatformText(body) || '(No text: an image or other content only.)';
}

/** A comment's prose, and each change it suggests with the lines around its own that it also replaces. */
export type CommentPart =
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

/** The first line of a discussion's first comment as plain text, for a one-line row. */
export function discussionSummary(discussion: Pick<PullRequestDiscussion, 'comments'>): string {
  const text = displayPlatformText(discussion.comments[0]?.body ?? '');
  const line = text.split('\n')
    .map((value) => value.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|```\S*)/u, '').trim())
    .find(Boolean) ?? '';
  const plain = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/(\*\*|__)(.+?)\1/gu, '$2')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/gu, '$1$2')
    .replace(/`([^`]+)`/gu, '$1')
    .trim();
  return plain.length > 160 ? `${plain.slice(0, 159)}…` : plain;
}

/** Where a discussion points, as the rail and the request read it. */
export function formatDiscussionLocation(discussion: Pick<PullRequestDiscussion, 'path' | 'side' | 'line' | 'endLine'>): string | undefined {
  if (!discussion.path) return undefined;
  if (!discussion.line) return discussion.path;
  const lines = discussion.endLine && discussion.endLine > discussion.line ? `${discussion.line}-${discussion.endLine}` : `${discussion.line}`;
  return discussion.side === 'OLD' ? `${discussion.path} (removed line${discussion.endLine ? 's' : ''} ${lines})` : `${discussion.path}:${lines}`;
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
  const parts = [
    joinNames(named('CHANGES_REQUESTED'), 'requested changes'),
    named('REQUESTED').length ? `waiting on ${listNames(named('REQUESTED'))}` : undefined,
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

function listNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const INSTRUCTION_DISCUSSION_LIMIT = 4_000;

/**
 * A discussion as the agent reads it: who said what, oldest first, bounded.
 * Every comment is attributed; none is Task Monki's or the person's word.
 */
export function discussionTranscript(
  discussion: Pick<PullRequestDiscussion, 'comments' | 'commentCount'>,
  /** The signed-in account: the person who sends the request. */
  viewer?: string
): string[] {
  const lines: string[] = [];
  let budget = INSTRUCTION_DISCUSSION_LIMIT;
  discussion.comments.forEach((comment: PullRequestComment, index) => {
    if (budget <= 0) return;
    const shown = discussionCommentText(comment.body);
    const body = shown.slice(0, budget);
    budget -= body.length;
    const cut = body.length < shown.length || comment.truncated;
    const who = `@${comment.author ?? 'unknown'}${viewer && comment.author === viewer ? ', the person sending this request' : ''}`;
    lines.push(`   ${index === 0 ? '' : 'Reply from '}${who}:`);
    for (const line of body.split('\n')) lines.push(`   ${line}`);
    if (cut) lines.push('   (The comment continues on the platform.)');
    // The replies between the first comment and the latest ones were not read.
    if (index === 0 && discussion.commentCount > discussion.comments.length) {
      lines.push(`   (${discussion.commentCount - discussion.comments.length} replies in between are on the platform.)`);
    }
  });
  return lines;
}

function time(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
