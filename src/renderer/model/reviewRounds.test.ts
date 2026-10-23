import { describe, expect, it } from 'vitest';
import type { ReviewRequestItemDecision, ReviewRequestRecord, TaskInstruction } from '../../shared/contracts';
import { currentReviewRound, requestItemQuote } from './reviewRounds';

const request = (reviewRunId: string): ReviewRequestRecord => ({ reviewRunId, items: [
  { number: 1, kind: 'FINDING', findingId: 'leak', severity: 'MAJOR', title: 'Listener leaks', path: 'feature.ts', line: 1 },
  { number: 2, kind: 'COMMENT', path: 'feature.ts', side: 'NEW', line: 1, text: 'Name the handler?\nIt reads as x.' }
] });
const message = (id: string, order: number, status: TaskInstruction['status'] = 'SUBMITTED', reviewRunId = 'review-1') =>
  ({ id, order, status, reviewRequest: request(reviewRunId) });
const round = (instructionId: string, answeredAt?: string) => ({
  instructionId, at: '2026-10-10T10:00:00.000Z', request: request('review-1'),
  answers: [{ item: 1, outcome: 'FIXED' as const }, { item: 2, outcome: 'NOT_CHANGED' as const }],
  ...(answeredAt ? { answeredAt } : {})
});
const decision = (instructionId: string, item: number, kind: 'ACCEPT' | 'REOPEN'): ReviewRequestItemDecision =>
  ({ id: `${instructionId}:${item}:${kind}`, reviewRunId: 'review-1', instructionId, item, kind, createdAt: '2026-10-10T11:00:00.000Z' });

describe('the round the Review tab shows answers for', () => {
  it('is the latest request sent after the gate\'s review, once its reply finished, with the items the person accepted there', () => {
    // A request that failed to send was never a round, however late.
    const messages = [message('first', 1), message('second', 2), message('failed', 3, 'FAILED')];
    const rounds = [round('first', '2026-10-10T10:10:00.000Z'), round('second', '2026-10-10T10:20:00.000Z')];
    const decisions = [decision('second', 1, 'ACCEPT'), decision('first', 2, 'ACCEPT'), decision('second', 2, 'ACCEPT'), decision('second', 2, 'REOPEN')];

    const view = currentReviewRound(messages, rounds, { runId: 'review-1', requestItemDecisions: decisions });
    expect(view).toMatchObject({ instructionId: 'second', reviewRunId: 'review-1', answeredAt: '2026-10-10T10:20:00.000Z' });
    expect(view?.accepted).toEqual(new Set([1]));

    // While the latest reply runs, no earlier request stands in for it; another review has none of these.
    expect(currentReviewRound(messages, [round('first', '2026-10-10T10:10:00.000Z'), round('second')], { runId: 'review-1' })).toBeUndefined();
    expect(currentReviewRound(messages, rounds, { runId: 'review-2' })).toBeUndefined();
  });

  it('sends an answered item again starting from the first line of what it said', () => {
    expect(requestItemQuote(request('review-1').items[0]!)).toBe('> Listener leaks');
    expect(requestItemQuote(request('review-1').items[1]!)).toBe('> Name the handler?');
  });
});
