import type { AgentReviewFinding, RunRecord, Task } from '../../shared/contracts';
import { formatFindingLocation } from './findings';
import { humanizeEnum } from './formatting';

export function buildReviewFollowUpInstruction(
  task: Task,
  reviewGate: NonNullable<Task['projection']['agentReview']>,
  reviewRun: RunRecord | undefined,
  selectedFindingIds: string[],
  note = ''
): string {
  const selectedFindings = (reviewGate.result?.findings ?? []).filter((finding) =>
    selectedFindingIds.includes(finding.id)
  );
  const lines = [
    `Address the review result for "${task.title}".`,
    '',
    `Review status: ${humanizeEnum(reviewGate.status)}.`
  ];
  if (reviewGate.result?.summary) {
    lines.push('', `Review summary: ${reviewGate.result.summary}`);
  } else if (reviewGate.summary) {
    lines.push('', `Review summary: ${reviewGate.summary}`);
  }
  if (selectedFindings.length > 0) {
    lines.push('', 'Selected findings to fix:');
    for (const [index, finding] of selectedFindings.entries()) {
      lines.push(
        '',
        `${index + 1}. [${humanizeEnum(finding.severity)}] ${finding.title}`,
        `   Location: ${formatFindingLocation(finding)}`,
        `   Explanation: ${finding.explanation}`
      );
      if (finding.recommendation) lines.push(`   Recommendation: ${finding.recommendation}`);
    }
  } else if (reviewRun?.finalMessage) {
    lines.push('', 'Review output:', reviewRun.finalMessage.trim());
  }
  if (note.trim()) lines.push('', 'Additional note:', note.trim());
  lines.push(
    '',
    [
      'Fix only the selected findings or review output above unless the root cause requires a scoped adjacent change.',
      'Preserve the existing task intent and stop when the follow-up is ready for review again.'
    ].join(' ')
  );
  return lines.join('\n');
}

export function defaultSelectedFindingIds(findings: AgentReviewFinding[]): string[] {
  const blocking = findings.filter(
    (finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR'
  );
  return (blocking.length > 0 ? blocking : findings).map((finding) => finding.id);
}
