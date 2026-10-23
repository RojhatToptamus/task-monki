import {
  acceptedRequestItems,
  discussionSummary,
  latestReviewRequest,
  reviewRequestSent,
  type AgentItemRecord,
  type AgentReviewGateProjection,
  type ReviewComment,
  type ReviewRequestItem,
  type ReviewResponseAnswer,
  type ReviewResponseOutcome,
  type RunRecord,
  type TaskInstruction
} from '../../shared/contracts';
import { sessionTurn, type SessionTurn } from './agentSession';
import { formatCommentLocation } from './formatting';
import { formatDiscussionLocation, type DiscussionView, type ReviewRequestRound } from './pullRequestFeedback';

export const REVIEW_OUTCOME_LABELS: Record<ReviewResponseOutcome, string> = {
  FIXED: 'Fixed',
  NOT_CHANGED: 'Not changed',
  NEEDS_DECISION: 'Needs your decision'
};

/** A discussion's state in one word, or none: what happened on the platform or to the request. */
export function discussionStateWord(discussion: Pick<DiscussionView, 'resolved' | 'sent' | 'outdated' | 'replied'>): string | undefined {
  if (discussion.resolved) return 'Resolved';
  // The person answered on the platform last: the discussion waits on its other side.
  if (discussion.replied) return 'Replied';
  if (discussion.sent) return discussion.sent.outcome ? REVIEW_OUTCOME_LABELS[discussion.sent.outcome] : 'Sent';
  return discussion.outdated ? 'Outdated' : undefined;
}

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

/** The lines of code an item is about, as a comment on them sits; nothing for an item about the whole change. */
export function requestItemPlace(item: ReviewRequestItem): Omit<ReviewComment, 'id' | 'text'> | undefined {
  if (!item.path) return undefined;
  return {
    path: item.path,
    // A finding is about the code the review read, on the new side.
    side: item.kind === 'FINDING' ? 'NEW' : item.side ?? 'NEW',
    ...(item.line ? { line: item.line } : {}),
    ...(item.line && item.endLine && item.endLine > item.line ? { endLine: item.endLine } : {})
  };
}

/** An answered item the person sends again starts their words with what it said, quoted, so the agent knows which one. */
export function requestItemQuote(item: ReviewRequestItem): string {
  const line = requestItemText(item).split('\n').map((value) => value.trim()).find(Boolean) ?? '';
  return `> ${line.length > 160 ? `${line.slice(0, 159)}…` : line}`;
}

/** The agent's answers in a finished turn that answered a review request; none while it runs. */
function turnAnswers(turn: SessionTurn): ReviewResponseAnswer[] {
  if (turn.state !== 'completed' || turn.opener?.kind !== 'prompt' || !turn.opener.reviewRequest) return [];
  const reply = [...turn.entries].reverse().find((entry) => entry.kind === 'message' && entry.answers);
  return reply?.kind === 'message' ? reply.answers ?? [] : [];
}

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
  return instructions.flatMap((instruction): ReviewRequestRound[] => {
    if (!instruction.reviewRequest || !reviewRequestSent(instruction)) return [];
    const run = instruction.runId ? runs.find((candidate) => candidate.id === instruction.runId) : undefined;
    if (run?.status !== 'COMPLETED') {
      return [{ instructionId: instruction.id, at: instruction.createdAt, request: instruction.reviewRequest, answers: [] }];
    }
    const fingerprint = `${run.endedAt}:${run.lastEventAt}:${run.eventCount}:${instruction.updatedAt}`;
    const cached = cache.get(instruction.id);
    const answers = cached?.fingerprint === fingerprint ? cached.answers : turnAnswers(sessionTurn(run, items, all));
    cache.set(instruction.id, { fingerprint, answers });
    return [{
      instructionId: instruction.id,
      at: instruction.createdAt,
      request: instruction.reviewRequest,
      answers,
      answeredAt: run.endedAt ?? run.lastEventAt ?? run.startedAt
    }];
  });
}

/**
 * The person's latest request after the gate's review, once the agent's reply to
 * it finished: the round the brief and the bands show answers for, and the items
 * whose answer the person accepted. An earlier request, or one whose reply still
 * runs, takes no decisions, so it has none.
 */
export interface ReviewRoundView extends ReviewRequestRound {
  reviewRunId: string;
  answeredAt: string;
  accepted: ReadonlySet<number>;
}

export function currentReviewRound(
  messages: readonly Pick<TaskInstruction, 'id' | 'reviewRequest' | 'status' | 'order'>[],
  rounds: readonly ReviewRequestRound[],
  gate: Pick<AgentReviewGateProjection, 'runId' | 'requestItemDecisions'> | undefined
): ReviewRoundView | undefined {
  if (!gate?.runId) return undefined;
  const latest = latestReviewRequest(messages, gate.runId);
  const round = latest ? rounds.find((candidate) => candidate.instructionId === latest.id) : undefined;
  if (!round?.answeredAt) return undefined;
  return {
    ...round,
    reviewRunId: gate.runId,
    answeredAt: round.answeredAt,
    accepted: acceptedRequestItems(gate.requestItemDecisions ?? [], round.instructionId)
  };
}

/** The agent's answer to one item, on the item's band, and whether the person accepted it. */
export interface BandAnswer {
  item: ReviewRequestItem;
  outcome: ReviewResponseOutcome;
  note?: string;
  accepted: boolean;
}

/**
 * The current round's answered items by what they are about. The person's own
 * comments left the draft when the request went, so each comes back as the
 * comment it was, to sit where it was written.
 */
export interface ReviewBandAnswers {
  answeredAt: string;
  findings: ReadonlyMap<string, BandAnswer>;
  discussions: ReadonlyMap<string, BandAnswer>;
  comments: ReadonlyMap<string, BandAnswer & { comment: ReviewComment }>;
}

export function reviewBandAnswers(round: ReviewRoundView): ReviewBandAnswers {
  const answers = new Map(round.answers.map((answer) => [answer.item, answer]));
  const findings = new Map<string, BandAnswer>();
  const discussions = new Map<string, BandAnswer>();
  const comments = new Map<string, BandAnswer & { comment: ReviewComment }>();
  for (const item of round.request.items) {
    const answer = answers.get(item.number);
    if (!answer) continue;
    const band: BandAnswer = { item, outcome: answer.outcome, ...(answer.note ? { note: answer.note } : {}), accepted: round.accepted.has(item.number) };
    if (item.kind === 'FINDING') findings.set(item.findingId, band);
    else if (item.kind === 'DISCUSSION') discussions.set(item.discussionId, band);
    else {
      const id = `request:${round.instructionId}:${item.number}`;
      comments.set(id, { ...band, comment: { id, ...requestItemPlace(item)!, text: item.text } });
    }
  }
  return { answeredAt: round.answeredAt, findings, discussions, comments };
}
