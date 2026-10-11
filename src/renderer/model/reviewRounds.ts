import type { ReviewRequestItem, ReviewRequestRecord, ReviewResponseAnswer, ReviewResponseOutcome } from '../../shared/contracts';
import type { SessionTurn } from './agentSession';
import { formatCommentLocation } from './reviewFollowUp';

export const REVIEW_OUTCOME_LABELS: Record<ReviewResponseOutcome, string> = {
  FIXED: 'Fixed',
  NOT_CHANGED: 'Not changed',
  NEEDS_DECISION: 'Needs your decision'
};

/** What a request item says: the finding's title, or the person's comment. */
export function requestItemText(item: ReviewRequestItem): string {
  return item.kind === 'FINDING' ? item.title : item.text;
}

/** Where a request item points, or nothing for a finding without a place. */
export function requestItemLocation(item: ReviewRequestItem): string | undefined {
  if (item.kind === 'COMMENT') return formatCommentLocation(item);
  if (!item.path) return undefined;
  if (!item.line) return item.path;
  return `${item.path}:${item.line}${item.endLine && item.endLine > item.line ? `-${item.endLine}` : ''}`;
}

/** A finished turn that answered a review request: the request and the agent's answers, if it gave them. */
export function answeredReviewRound(turn: SessionTurn | undefined): { key: string; request: ReviewRequestRecord; answers: ReviewResponseAnswer[] } | undefined {
  if (turn?.state !== 'completed' || turn.opener?.kind !== 'prompt' || !turn.opener.reviewRequest) return undefined;
  const reply = [...turn.entries].reverse().find((entry) => entry.kind === 'message' && entry.answers);
  return { key: turn.opener.key, request: turn.opener.reviewRequest, answers: reply?.kind === 'message' ? reply.answers ?? [] : [] };
}
