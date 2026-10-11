import { describe, expect, it } from 'vitest';
import { assertReviewRequestRecord, parseReviewResponse, type ReviewRequestRecord } from './reviewRounds';

const request: ReviewRequestRecord = {
  reviewRunId: 'review-1',
  items: [
    { number: 1, kind: 'FINDING', findingId: 'leak', severity: 'MAJOR', title: 'Listener leaks', path: 'feature.ts', line: 2 },
    { number: 2, kind: 'COMMENT', path: 'feature.ts', side: 'NEW', line: 9, text: 'Use a Map.' }
  ]
};

describe('parseReviewResponse', () => {
  it('splits the reply into prose and one answer per requested item', () => {
    const reply = [
      'Fixed the leak and kept the array.',
      '',
      '```task-monki-review-response',
      JSON.stringify([
        { item: 1, outcome: 'fixed', note: ' Removed the listener on close. ' },
        { item: 2, outcome: 'NOT_CHANGED', note: 'Order matters here.' },
        { item: 2, outcome: 'FIXED' },
        { item: 7, outcome: 'FIXED' },
        { item: 1, outcome: 'MAYBE' }
      ]),
      '```'
    ].join('\n');

    expect(parseReviewResponse(reply, request)).toEqual({
      prose: 'Fixed the leak and kept the array.',
      answers: [
        { item: 1, outcome: 'FIXED', note: 'Removed the listener on close.' },
        { item: 2, outcome: 'NOT_CHANGED', note: 'Order matters here.' }
      ]
    });
  });

  it('keeps a reply without the block as prose, and hides a block that has not finished streaming', () => {
    expect(parseReviewResponse('All done.', request)).toEqual({ prose: 'All done.', answers: [] });
    expect(parseReviewResponse('All done.\n```task-monki-review-response\n[{"item": 1, "outc', request))
      .toEqual({ prose: 'All done.', answers: [] });
    expect(parseReviewResponse('All done.\n```task-monki-review-response\nnot json\n```', request))
      .toEqual({ prose: 'All done.', answers: [] });
  });
});

describe('assertReviewRequestRecord', () => {
  it('accepts numbered findings and comments, and refuses anything else', () => {
    expect(() => assertReviewRequestRecord(request)).not.toThrow();
    expect(() => assertReviewRequestRecord({ items: [] })).toThrow('The review request is not valid.');
    expect(() => assertReviewRequestRecord({ items: [{ ...request.items[1], number: 2 }] })).toThrow();
    expect(() => assertReviewRequestRecord({ items: [{ ...request.items[0], severity: 'HUGE' }] })).toThrow();
    expect(() => assertReviewRequestRecord({ items: [{ ...request.items[1], number: 1, line: 9, endLine: 3 }] })).toThrow();
    expect(() => assertReviewRequestRecord({ ...request, extra: true })).toThrow();
  });
});
