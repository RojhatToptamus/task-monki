import {
  isOpenDiscussion,
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
  return feedback.discussions.map((discussion) => {
    const request = sent.get(discussion.id);
    // Compared in the platform's clock when the request recorded it, so a skewed local clock misjudges nothing.
    const answeredSince = request && discussion.comments.some((comment) =>
      comment.author !== feedback.viewer && time(comment.createdAt) > time(request.seenAt ?? request.at));
    return {
      ...discussion,
      provider: feedback.provider,
      open: pullRequestOpen && isOpenDiscussion(discussion),
      ...(request && !answeredSince ? { sent: request } : {})
    };
  });
}

/** Discussions that still ask for something and were not sent since: what Address comments adds. */
export function unaddressedDiscussions(discussions: readonly DiscussionView[]): DiscussionView[] {
  return discussions.filter((discussion) => discussion.open && !discussion.sent);
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
