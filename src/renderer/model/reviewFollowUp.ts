import type { AgentReviewFinding, ReviewComment, ReviewFindingDismissReason, TaskReviewDraft } from '../../shared/contracts';
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
  NOT_A_PROBLEM: 'not a problem',
  ACCEPTED: 'accepted as is'
};

export interface ReviewRequestInput {
  taskTitle: string;
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
 * The follow-up instruction "Request changes" sends to the implementation
 * agent: the findings to fix and every comment, the dismissed findings as
 * context not to act on, and the person's note. Suggestions the person did not
 * add are not mentioned.
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
    for (const comment of input.comments) {
      lines.push(`- ${formatCommentLocation(comment)}: ${comment.text.trim()}`);
    }
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
  return lines.join('\n');
}
