import type { AgentReviewFinding } from '../../shared/contracts';
import { formatFindingLocation } from './findings';
import { humanizeEnum } from './formatting';
import type { ReviewLineComment } from './reviewWorkspace';

export interface ReviewRequestInput {
  taskTitle: string;
  summary?: string;
  /** Open findings: everything the user did not dismiss. */
  findings: readonly AgentReviewFinding[];
  /** Dismissed findings, so the agent leaves them alone. */
  dismissed: ReadonlyArray<{ finding: AgentReviewFinding; note?: string }>;
  /** The user's own comments on lines of the diff. */
  comments: readonly ReviewLineComment[];
  note?: string;
  /** The review's raw output, used only when it produced no structured findings. */
  reviewOutput?: string;
}

/**
 * The follow-up instruction "Request changes" sends to the implementation
 * agent: every open finding and every comment, the dismissed findings as
 * context not to act on, and the user's note.
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
      const location = comment.line ? `${comment.path}:${comment.line}` : comment.path;
      lines.push(`- ${location}: ${comment.text.trim()}`);
    }
  }
  if (input.dismissed.length > 0) {
    lines.push('', 'Left out on purpose; do not change these:');
    for (const { finding, note } of input.dismissed) {
      lines.push(`- [${humanizeEnum(finding.severity)}] ${finding.title}${note?.trim() ? ` (${note.trim()})` : ''}`);
    }
  }
  if (input.note?.trim()) lines.push('', 'Note:', input.note.trim());
  lines.push(
    '',
    'Fix only the findings and comments above unless the root cause requires a scoped adjacent change. Preserve the task intent and stop when the follow-up is ready for review again.'
  );
  return lines.join('\n');
}
