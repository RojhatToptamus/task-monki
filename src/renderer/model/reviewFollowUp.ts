import { REVIEW_RESPONSE_BLOCK, type AgentReviewFinding, type ReviewComment, type ReviewFindingDismissReason, type ReviewRequestRecord, type TaskReviewDraft } from '../../shared/contracts';
import { formatFindingLocation } from './findings';
import { humanizeEnum } from './formatting';
import type { ReviewFindingView } from './reviewWorkspace';

/** Blocker and Major findings go in the request by default; the gate says they must change. */
export function isBlockingFinding(finding: Pick<AgentReviewFinding, 'severity'>): boolean {
  return finding.severity === 'BLOCKER' || finding.severity === 'MAJOR';
}

/** What happens to each finding of the current review when the person requests changes. */
export interface ReviewRequestPlan {
  /** Open Blocker and Major findings, and the Minor and Nit findings the person added. */
  send: ReviewFindingView[];
  /** Open Minor and Nit findings not added: not sent. */
  suggestions: ReviewFindingView[];
  /** Dismissed and withdrawn findings. */
  settled: ReviewFindingView[];
}

export function planReviewRequest(
  findings: readonly ReviewFindingView[],
  draft: Pick<TaskReviewDraft, 'includedFindingIds' | 'reviewRunId'>,
  reviewRunId: string | undefined
): ReviewRequestPlan {
  // Inclusions belong to the review they were made in; a new review starts without them.
  const included = new Set(draft.reviewRunId === reviewRunId ? draft.includedFindingIds : []);
  const plan: ReviewRequestPlan = { send: [], suggestions: [], settled: [] };
  for (const finding of findings) {
    if (finding.state !== 'OPEN') plan.settled.push(finding);
    else if (isBlockingFinding(finding) || included.has(finding.id)) plan.send.push(finding);
    else plan.suggestions.push(finding);
  }
  return plan;
}

/** Where a comment points, as the agent reads it. */
export function formatCommentLocation(comment: Pick<ReviewComment, 'path' | 'side' | 'line' | 'endLine'>): string {
  if (!comment.line) return `${comment.path} (whole file)`;
  const lines = comment.endLine && comment.endLine > comment.line ? `${comment.line}-${comment.endLine}` : `${comment.line}`;
  return comment.side === 'OLD'
    ? `${comment.path} (removed line${comment.endLine && comment.endLine > comment.line ? 's' : ''} ${lines})`
    : `${comment.path}:${lines}`;
}

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
  /** The person's own comments on lines, ranges and files of the diff. */
  comments: readonly ReviewComment[];
  note?: string;
  /** The review's raw output, used only when it produced no structured findings. */
  reviewOutput?: string;
}

/**
 * The request item by item, numbered as the agent reads them: the findings to fix,
 * then the person's comments. Absent when nothing is itemised, such as a request
 * made of the review's raw output alone.
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
  const comments = input.comments.map((comment, index) => ({
    number: findings.length + index + 1,
    kind: 'COMMENT' as const,
    path: comment.path,
    side: comment.side,
    ...(comment.line ? { line: comment.line } : {}),
    ...(comment.line && comment.endLine && comment.endLine >= comment.line ? { endLine: comment.endLine } : {}),
    text: comment.text.trim()
  }));
  const items = [...findings, ...comments];
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
  } else if (input.reviewOutput?.trim() && input.comments.length === 0) {
    lines.push('', 'Review output:', input.reviewOutput.trim());
  }
  if (input.comments.length > 0) {
    lines.push('', 'Comments from the person reviewing:');
    input.comments.forEach((comment, index) => {
      lines.push(`${input.findings.length + index + 1}. ${formatCommentLocation(comment)}: ${comment.text.trim()}`);
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
  if (input.findings.length + input.comments.length > 0) {
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
