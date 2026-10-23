import { describe, expect, it } from 'vitest';
import { appendToDraft, askSubjectLabel, discussionSubjectName, sideQuestionFollowUp, sideQuestionSnapshotNote } from './sideQuestions';

describe('what a question is about', () => {
  it('names an intent by its title and a discussion by its author and first line, and says when either is gone', () => {
    const names = {
      findings: new Map<string, string>(),
      walkthrough: { reviewRunId: 'review-2', titles: ['Start tasks from issues', 'Answer review threads'] },
      discussions: new Map([['d1', discussionSubjectName({ comments: [{ author: 'alice', body: '**Return** seconds here.\nAnd more.', truncated: false }] })]])
    };
    expect(askSubjectLabel({ kind: 'STAGE', reviewRunId: 'review-2', section: 1 }, names)).toBe('Answer review threads');
    // A question asked about an earlier walkthrough keeps a line, not another review's title.
    expect(askSubjectLabel({ kind: 'STAGE', reviewRunId: 'review-1', section: 1 }, names)).toBe('An intent of an earlier walkthrough');
    expect(askSubjectLabel({ kind: 'THREAD', discussionId: 'd1' }, names)).toBe('alice: Return seconds here.');
    expect(askSubjectLabel({ kind: 'THREAD', discussionId: 'gone' }, names)).toBe('A discussion on the pull request');
  });
});

describe('side question follow-up', () => {
  it('introduces the answer with the question it answers, on one line', () => {
    expect(sideQuestionFollowUp({
      opener: { kind: 'prompt', key: 'q', text: 'Why does the limiter\nuse a Map?', at: '2026-10-10T10:00:00.000Z' },
      answer: '  Buckets are per process.  '
    })).toBe('From a side question, “Why does the limiter use a Map?”:\n\nBuckets are per process.');
  });

  it('offers nothing until there is an answer', () => {
    expect(sideQuestionFollowUp({ opener: { kind: 'prompt', key: 'q', text: 'Why?', at: '' }, answer: '  ' })).toBeUndefined();
  });

  it('adds to the draft a blank line apart and never pads an empty one', () => {
    expect(appendToDraft('Fix the limiter.\n', 'Context')).toBe('Fix the limiter.\n\nContext');
    expect(appendToDraft('', 'Context')).toBe('Context');
  });
});

describe('side question snapshot note', () => {
  it('says how fresh a snapshot answer is and what it left out', () => {
    const note = sideQuestionSnapshotNote({ snapshotTakenAt: '2026-10-10T14:02:00.000Z', snapshotOmittedFileCount: 2 });
    expect(note).toMatch(/^Read a snapshot from .+, without 2 large untracked files$/);
    expect(sideQuestionSnapshotNote({ snapshotTakenAt: undefined })).toBeUndefined();
  });
});
