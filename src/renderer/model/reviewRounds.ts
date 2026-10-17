import type { AgentItemRecord, ReviewRequestItem, ReviewRequestRecord, ReviewResponseAnswer, ReviewResponseOutcome, RunRecord, TaskInstruction } from '../../shared/contracts';
import { sessionTurn, type SessionTurn } from './agentSession';
import type { ReviewRequestRound } from './pullRequestFeedback';
import { discussionSummary, formatDiscussionLocation } from './pullRequestFeedback';
import { formatCommentLocation } from './reviewFollowUp';

export const REVIEW_OUTCOME_LABELS: Record<ReviewResponseOutcome, string> = {
  FIXED: 'Fixed',
  NOT_CHANGED: 'Not changed',
  NEEDS_DECISION: 'Needs your decision'
};

/** What a request item says: the finding's title, the person's comment, or a discussion's first line. */
export function requestItemText(item: ReviewRequestItem): string {
  if (item.kind === 'FINDING') return item.title;
  if (item.kind === 'COMMENT') return item.text;
  return discussionSummary({ comments: [{ body: item.text, truncated: false }] });
}

/** Where a request item points, or nothing for an item without a place. */
export function requestItemLocation(item: ReviewRequestItem): string | undefined {
  if (item.kind === 'COMMENT') return formatCommentLocation(item);
  if (item.kind === 'DISCUSSION') return formatDiscussionLocation(item);
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

/** A request that reached the agent, or is on its way; a failed or held one did not. */
const SENT_STATUSES = new Set<TaskInstruction['status']>(['SENDING', 'SUBMITTED', 'UNCERTAIN']);

/**
 * Every request sent from the Review tab, with the agent's answers once its turn
 * finished. A turn still running has none yet; a finished one is read once per
 * change to its run, through `cache`.
 */
export function reviewRequestRounds(
  instructions: readonly TaskInstruction[],
  runs: readonly RunRecord[],
  items: AgentItemRecord[],
  cache: Map<string, { fingerprint: string; answers: ReviewResponseAnswer[] }> = new Map()
): ReviewRequestRound[] {
  const all = [...instructions];
  return instructions.flatMap((instruction) => {
    if (!instruction.reviewRequest || !SENT_STATUSES.has(instruction.status)) return [];
    const run = instruction.runId ? runs.find((candidate) => candidate.id === instruction.runId) : undefined;
    let answers: ReviewResponseAnswer[] = [];
    if (run?.status === 'COMPLETED') {
      const fingerprint = `${run.endedAt}:${run.lastEventAt}:${run.eventCount}:${instruction.updatedAt}`;
      const cached = cache.get(instruction.id);
      answers = cached?.fingerprint === fingerprint ? cached.answers
        : answeredReviewRound(sessionTurn(run, items, all))?.answers ?? [];
      cache.set(instruction.id, { fingerprint, answers });
    }
    return [{ at: instruction.createdAt, request: instruction.reviewRequest, answers }];
  });
}
