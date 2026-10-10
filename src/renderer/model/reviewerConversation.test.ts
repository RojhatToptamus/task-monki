import { describe, expect, it } from 'vitest';
import type { ReviewFindingDecision } from '../../shared/agentReviewFindings';
import { reviewerProse, reviewerRevisionLines } from './reviewerConversation';

describe('reviewerProse', () => {
  it('shows only the prose, hiding a finished or still-streaming revision block', () => {
    const block = '```task-monki-revisions\n[{"finding":"f2","action":"withdraw","reason":"Seconds already."}]\n```';
    expect(reviewerProse(`You're right; it divides by 1000.\n\n${block}`)).toBe("You're right; it divides by 1000.");
    expect(reviewerProse('You are right.\n\n```task-monki-revisions\n[{"finding":"f2","act')).toBe('You are right.');
    expect(reviewerProse('No change needed.')).toBe('No change needed.');
  });
});

describe('reviewerRevisionLines', () => {
  it('describes each change one answer made, by the finding it changed', () => {
    const decision = (kind: ReviewFindingDecision['kind'], extra: Partial<ReviewFindingDecision> = {}): ReviewFindingDecision => ({
      id: `${kind}-1`, reviewRunId: 'review-1', findingId: 'f1', kind, actor: 'REVIEWER', reason: 'Because.', questionRunId: 'ask-1', createdAt: '2026-10-10T00:00:00.000Z', ...extra
    });
    const findings = [{ id: 'f1', severity: 'MAJOR' as const, title: 'Limiter state is per process', explanation: 'x', state: 'OPEN' as const, addedByReviewer: false }];
    expect(reviewerRevisionLines([
      decision('WITHDRAW'),
      decision('CHANGE_SEVERITY', { id: 'c', severity: 'MINOR' }),
      decision('ADD', { id: 'a', findingId: 'added-1', finding: { id: 'added-1', severity: 'MINOR', title: 'No test for a missing key', explanation: 'y' } }),
      decision('WITHDRAW', { id: 'other', questionRunId: 'ask-2' })
    ], findings, 'ask-1').map(({ action, title }) => [action, title])).toEqual([
      ['Withdrew', 'Limiter state is per process'],
      ['Changed to Minor', 'Limiter state is per process'],
      ['Added', 'No test for a missing key']
    ]);
  });
});
