import { describe, expect, it } from 'vitest';
import { reviewDraftProblem } from './reviewDraft';

describe('the review draft', () => {
  it('keeps the discussions the person added, and refuses a malformed list', () => {
    const draft = { comments: [], includedFindingIds: [], note: '' };
    expect(reviewDraftProblem({ ...draft, includedDiscussionIds: ['PRRT_1'] })).toBeUndefined();
    expect(reviewDraftProblem(draft)).toBeUndefined();
    expect(reviewDraftProblem({ ...draft, includedDiscussionIds: [''] })).toBe('The included discussions are malformed.');
    expect(reviewDraftProblem({ ...draft, includedDiscussionIds: 'PRRT_1' })).toBe('The included discussions are malformed.');
  });
});
