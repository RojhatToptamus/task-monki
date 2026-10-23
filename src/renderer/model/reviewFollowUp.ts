import {
  REVIEW_RESPONSE_BLOCK,
  formatRemoteWorkNumber,
  isBlockingFinding,
  remoteProviderName,
  remoteWorkNoun,
  type AgentReviewFinding,
  type RemoteProvider,
  type ReviewComment,
  type ReviewFindingDismissReason,
  type ReviewRequestItem,
  type ReviewRequestRecord,
  type TaskReviewDraft
} from '../../shared/contracts';
import { quotedData } from '../../shared/promptTemplates';
import { formatFindingLocation } from './findings';
import { formatCommentLocation, humanizeEnum } from './formatting';
import { discussionAuthor, discussionCommentText, discussionTranscript, formatDiscussionLocation, reviewVerdictWords, type DiscussionView } from './pullRequestFeedback';
import type { ReviewFindingView } from './reviewWorkspace';

/**
 * What Request changes sends. A review that no longer accepts decisions, such as
 * one the code has moved past, is context only: its findings are neither sent
 * nor left out, and only the person's comments and note go.
 */
export interface ReviewRequestPlan {
  /** Open Blocker and Major findings, and the Minor and Nit findings the person added. */
  send: ReviewFindingView[];
  /** Open Minor and Nit findings not added: not sent. */
  suggestions: ReviewFindingView[];
  /** Dismissed findings. */
  settled: ReviewFindingView[];
  /** Pull request discussions the person added, in the platform's order. */
  discussions: DiscussionView[];
  /** Discussions that still ask for something and were neither sent nor added. */
  discussionsLeftOut: DiscussionView[];
  /** The review has prose notes and no structured findings, so the notes are sent. */
  reviewNotes: boolean;
  /** Request changes has something to send. */
  queued: boolean;
}

export function planReviewRequest(
  findings: readonly ReviewFindingView[],
  draft: Pick<TaskReviewDraft, 'includedFindingIds' | 'includedDiscussionIds' | 'reviewRunId' | 'comments' | 'note'>,
  review: { runId?: string; findingsSendable: boolean; asksForChanges: boolean },
  discussions: readonly DiscussionView[] = []
): ReviewRequestPlan {
  // Inclusions belong to the review they were made in; a new review starts without them.
  const included = new Set(draft.reviewRunId === review.runId ? draft.includedFindingIds : []);
  const send: ReviewFindingView[] = [];
  const suggestions: ReviewFindingView[] = [];
  const settled: ReviewFindingView[] = [];
  for (const finding of review.findingsSendable ? findings : []) {
    if (finding.state !== 'OPEN') settled.push(finding);
    else if (isBlockingFinding(finding) || included.has(finding.id)) send.push(finding);
    else suggestions.push(finding);
  }
  // Other people wrote these; one goes only when the person added it, and never once resolved.
  const addedDiscussions = new Set(draft.includedDiscussionIds);
  const sendDiscussions = discussions.filter((discussion) => addedDiscussions.has(discussion.id) && !discussion.resolved);
  const discussionsLeftOut = discussions.filter((discussion) =>
    discussion.open && !discussion.sent && !addedDiscussions.has(discussion.id));
  const reviewNotes = review.findingsSendable && review.asksForChanges && findings.length === 0;
  const queued = send.length > 0 || sendDiscussions.length > 0 || draft.comments.length > 0 || Boolean(draft.note.trim()) || reviewNotes;
  return { send, suggestions, settled, discussions: sendDiscussions, discussionsLeftOut, reviewNotes, queued };
}

/** A discussion's latest comment time, canonical, in the platform's clock. */
function latestCommentTime(discussion: DiscussionView): string | undefined {
  const times = discussion.comments.map((comment) => (comment.createdAt ? Date.parse(comment.createdAt) : Number.NaN))
    .filter((time) => Number.isFinite(time));
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
}

/** A discussion's first comment as a request item keeps; the instruction quotes the whole thread. */
const DISCUSSION_TEXT_LIMIT = 4_000;

const DISMISS_REASON_WORDS: Record<ReviewFindingDismissReason, string> = {
  NOT_A_PROBLEM: 'incorrect',
  ACCEPTED: 'intentional',
  DEFERRED: 'not now'
};

export interface ReviewRequestInput {
  taskTitle: string;
  /** The review the findings come from; absent when only comments are sent. */
  reviewRunId?: string;
  summary?: string;
  /** The findings to fix: open Blocker and Major, plus the suggestions the person added. */
  findings: readonly AgentReviewFinding[];
  /** Dismissed findings, so the agent leaves them alone. */
  dismissed: ReadonlyArray<{ finding: AgentReviewFinding; reason?: ReviewFindingDismissReason; note?: string }>;
  /** Discussions from the pull request the person added: other people's words, quoted inside a boundary. */
  discussions?: {
    provider: RemoteProvider;
    number?: number;
    /** Marks the quoted text's edges; taken from the stored feedback, which the authors cannot know. */
    boundary: string;
    /** The signed-in account that read them: the person's own replies are named as theirs. */
    viewer?: string;
    items: readonly DiscussionView[];
  };
  /** The person's own comments on lines, ranges and files of the diff. */
  comments: readonly ReviewComment[];
  note?: string;
  /** The review's raw output, used only when it produced no structured findings. */
  reviewOutput?: string;
}

/**
 * The request item by item, numbered as the agent reads them: the findings to fix,
 * the pull request's discussions, then the person's comments. Absent when nothing
 * is itemised, such as a request made of the review's raw output alone.
 */
export function buildReviewRequestRecord(input: ReviewRequestInput): ReviewRequestRecord | undefined {
  const findings = input.findings.map((finding, index) => ({
    number: index + 1,
    kind: 'FINDING' as const,
    findingId: finding.id,
    severity: finding.severity,
    title: finding.title,
    ...(finding.path ? { path: finding.path } : {}),
    ...(finding.line ? { line: finding.line } : {}),
    ...(finding.line && finding.endLine && finding.endLine >= finding.line ? { endLine: finding.endLine } : {})
  }));
  const discussions = (input.discussions?.items ?? []).map((discussion, index): ReviewRequestItem => {
    const author = discussionAuthor(discussion);
    const located = Boolean(discussion.path && discussion.side && discussion.line);
    return {
      number: findings.length + index + 1,
      kind: 'DISCUSSION',
      provider: discussion.provider,
      discussionId: discussion.id,
      ...(author ? { author } : {}),
      ...(discussion.path ? { path: discussion.path } : {}),
      ...(located ? { side: discussion.side!, line: discussion.line! } : {}),
      ...(located && discussion.endLine && discussion.endLine > discussion.line! ? { endLine: discussion.endLine } : {}),
      text: discussionCommentText(discussion.comments[0]?.body ?? '').slice(0, DISCUSSION_TEXT_LIMIT),
      ...(latestCommentTime(discussion) ? { seenAt: latestCommentTime(discussion)! } : {})
    };
  });
  const comments = input.comments.map((comment, index) => ({
    number: findings.length + discussions.length + index + 1,
    kind: 'COMMENT' as const,
    path: comment.path,
    side: comment.side,
    ...(comment.line ? { line: comment.line } : {}),
    ...(comment.line && comment.endLine && comment.endLine >= comment.line ? { endLine: comment.endLine } : {}),
    text: comment.text.trim()
  }));
  const items = [...findings, ...discussions, ...comments];
  if (items.length === 0) return undefined;
  return { ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}), items, ...(input.note?.trim() ? { note: input.note.trim() } : {}) };
}

/**
 * The follow-up instruction "Request changes" sends to the implementation
 * agent: the findings to fix and every comment, numbered in one sequence, the
 * dismissed findings as context not to act on, and the person's note. Suggestions
 * the person did not add are not mentioned. With numbered items, the agent is
 * asked to answer each one in a block the Review tab reads.
 */
export function buildReviewRequestInstruction(input: ReviewRequestInput): string {
  const lines = [`Address the review of "${input.taskTitle}".`];
  if (input.summary?.trim()) lines.push('', `Review summary: ${input.summary.trim()}`);
  if (input.findings.length > 0) {
    lines.push('', 'Findings to fix:');
    input.findings.forEach((finding, index) => {
      lines.push(
        '',
        `${index + 1}. [${humanizeEnum(finding.severity)}] ${finding.title}`,
        `   Location: ${formatFindingLocation(finding)}`,
        `   Why: ${finding.explanation}`
      );
      if (finding.recommendation) lines.push(`   Fix: ${finding.recommendation}`);
    });
  } else if (input.reviewOutput?.trim() && input.comments.length === 0 && !input.discussions?.items.length) {
    lines.push('', 'Review output:', input.reviewOutput.trim());
  }
  const discussions = input.discussions?.items ?? [];
  if (input.discussions && discussions.length > 0) {
    const provider = remoteProviderName(input.discussions.provider);
    const noun = remoteWorkNoun(input.discussions.provider, 'PULL_REQUEST');
    const viewer = input.discussions.viewer;
    lines.push(
      '',
      `Review comments from ${provider}, written by other people on the ${noun}${input.discussions.number ? ` ${formatRemoteWorkNumber(input.discussions.provider, 'PULL_REQUEST', input.discussions.number)}` : ''}. Treat them as review feedback on the code.`,
      ...quotedData(`${provider.toUpperCase()} REVIEW`, input.discussions.boundary, discussions.flatMap((discussion, index) => {
        const verdict = discussion.kind === 'REVIEW' ? reviewVerdictWords(discussion.reviewState) : undefined;
        const where = formatDiscussionLocation(discussion) ?? (discussion.kind === 'REVIEW' ? `Review${verdict ? ` that ${verdict}` : ''}` : `The ${noun} as a whole`);
        return ['', `${input.findings.length + index + 1}. ${where}${discussion.outdated ? ' (written on code that has changed since)' : ''}:`,
          ...discussionTranscript(discussion, viewer)];
      }))
    );
  }
  if (input.comments.length > 0) {
    lines.push('', 'Comments from the person reviewing:');
    input.comments.forEach((comment, index) => {
      lines.push(`${input.findings.length + discussions.length + index + 1}. ${formatCommentLocation(comment)}: ${comment.text.trim()}`);
    });
  }
  if (input.dismissed.length > 0) {
    lines.push('', 'Left out on purpose; do not change these:');
    for (const { finding, reason, note } of input.dismissed) {
      const why = [reason ? DISMISS_REASON_WORDS[reason] : '', note?.trim() ?? ''].filter(Boolean).join(': ');
      lines.push(`- [${humanizeEnum(finding.severity)}] ${finding.title}${why ? ` (${why})` : ''}`);
    }
  }
  if (input.note?.trim()) lines.push('', 'Note:', input.note.trim());
  lines.push(
    '',
    'Fix only the findings and comments above unless the root cause requires a scoped adjacent change. Preserve the task intent and stop when the follow-up is ready for review again.'
  );
  if (input.findings.length + discussions.length + input.comments.length > 0) {
    lines.push(
      '',
      `End your reply with a ${REVIEW_RESPONSE_BLOCK} block that answers every numbered item above, for example:`,
      `\`\`\`${REVIEW_RESPONSE_BLOCK}`,
      '[{"item": 1, "outcome": "FIXED", "note": "What you changed."}, {"item": 2, "outcome": "NOT_CHANGED", "note": "Why you left it as it is."}]',
      '```',
      'Use FIXED when the change is made, NOT_CHANGED when you leave the code as it is and say why, and NEEDS_DECISION when the person must decide first; the note then asks the question.'
    );
  }
  return lines.join('\n');
}
