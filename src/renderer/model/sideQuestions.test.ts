import { describe, expect, it } from 'vitest';
import { appendToDraft, sideQuestionFollowUp, sideQuestionSnapshotNote } from './sideQuestions';

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
