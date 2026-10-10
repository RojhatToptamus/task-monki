import {
  REVIEW_REVISIONS_FENCE_TAG,
  splitReviewerReply,
  type EffectiveReviewFinding,
  type ReviewFindingDecision
} from '../../shared/agentReviewFindings';
import type { TaskInstruction } from '../../shared/contracts';
import { findingLevel } from './findings';

/**
 * What the person reads of a reviewer's answer: the prose, without the
 * revision block that ends it. A block still streaming is hidden from its
 * opening fence, so no half-written JSON ever shows.
 */
export function reviewerProse(text: string): string {
  const { prose } = splitReviewerReply(text);
  const opening = prose.lastIndexOf('```' + REVIEW_REVISIONS_FENCE_TAG);
  return opening >= 0 ? prose.slice(0, opening).trimEnd() : prose;
}

/** The questions asked about one review, in the order they were asked. */
export function reviewQuestions(instructions: readonly TaskInstruction[], reviewRunId: string | undefined): TaskInstruction[] {
  if (!reviewRunId) return [];
  return instructions
    .filter((instruction) => instruction.role === 'REVIEW' && instruction.reviewRunId === reviewRunId)
    .sort((a, b) => a.order - b.order);
}

/** One line per change the reviewer's answer made to the findings: what it did, and to which finding. */
export function reviewerRevisionLines(
  decisions: readonly ReviewFindingDecision[],
  findings: readonly EffectiveReviewFinding[],
  questionRunId: string
): Array<{ id: string; action: string; title: string }> {
  const titles = new Map(findings.map((finding) => [finding.id, finding.title]));
  return decisions
    .filter((decision) => decision.actor === 'REVIEWER' && decision.questionRunId === questionRunId)
    .map((decision) => ({
      id: decision.id,
      action: revisionAction(decision),
      title: decision.finding?.title ?? titles.get(decision.findingId) ?? 'A finding'
    }));
}

function revisionAction(decision: ReviewFindingDecision): string {
  switch (decision.kind) {
    case 'WITHDRAW': return 'Withdrew';
    case 'CHANGE_SEVERITY': return decision.severity ? `Changed to ${findingLevel(decision.severity).label}` : 'Changed severity';
    case 'ADD': return 'Added';
    default: return 'Updated';
  }
}
