import { describe, expect, it } from 'vitest';
import type { ReviewedDiffFile } from './ReviewedDiff';
import { checkReviewWalkthrough, type ReviewedChange } from './ReviewWalkthrough';

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number) => ({
  header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, oldStart, oldCount, newStart, newCount, lines: []
});

/** Files as Git orders them; src/upload.ts has hunks at the head lines 10-24 and 40-46. */
const FILES: ReviewedDiffFile[] = [
  { path: 'docs/upload.md', status: 'renamed', oldPath: 'docs/old.md', additions: 2, deletions: 1, hunks: [hunk(3, 2, 3, 3)] },
  { path: 'src/legacy.ts', status: 'deleted', additions: 0, deletions: 12, hunks: [hunk(1, 12, 0, 0)] },
  { path: 'src/retry.ts', status: 'added', additions: 30, deletions: 0, hunks: [hunk(0, 0, 1, 30)] },
  { path: 'src/upload.test.ts', status: 'modified', additions: 4, deletions: 0, hunks: [hunk(5, 1, 5, 5)] },
  { path: 'src/upload.ts', status: 'modified', additions: 12, deletions: 4, hunks: [hunk(10, 11, 10, 15), hunk(36, 7, 40, 7)] }
];
const CHANGE: ReviewedChange = { reviewRunId: 'review-1', base: 'b'.repeat(40), tree: 'c'.repeat(40), files: FILES };

function valid(value: unknown, findingIds: ReadonlySet<string> = new Set(), change = CHANGE) {
  const check = checkReviewWalkthrough(value, change, findingIds);
  if (check.status !== 'VALID') throw new Error(`Expected a walkthrough, got ${check.reason}.`);
  return check;
}

const section = (title: string, files: unknown[], rest: object = {}) => ({ title, explanation: `${title}.`, files, ...rest });

describe('checkReviewWalkthrough', () => {
  it('places every changed file once: the first claim wins and files no section claims join Other changes', () => {
    const { walkthrough } = valid({
      summary: ' Uploads retry. ',
      sections: [
        section('Retry failed uploads', ['src/retry.ts', 'src/upload.ts', 'src/missing.ts']),
        section('Test the retry', [{ path: 'src/upload.ts' }, 'src/upload.test.ts'])
      ]
    });

    expect(walkthrough.summary).toBe('Uploads retry.');
    expect(walkthrough.sections.map(({ title, files }) => [title, files])).toEqual([
      ['Retry failed uploads', ['src/retry.ts', 'src/upload.ts']],
      ['Test the retry', ['src/upload.test.ts']],
      ['Other changes', ['docs/upload.md', 'src/legacy.ts']]
    ]);
    // The unknown path and the second claim.
  });

  it('drops a section without a title or a file of its own, so its claims and the attention on it fall away', () => {
    const { walkthrough } = valid({
      summary: 'Uploads retry.',
      attention: [
        { text: 'The legacy upload path is deleted', section: 4 },
        { text: 'Points at a dropped section', section: 2 },
        { text: 'Points nowhere', section: 9 },
        { text: '', section: 1 }
      ],
      sections: [
        section('Retry failed uploads', ['src/upload.ts']),
        section('Retry again', ['src/upload.ts']),
        { title: '', explanation: 'No title.', files: ['src/retry.ts'] },
        section('Remove the legacy path', ['src/legacy.ts', 'src/retry.ts'])
      ]
    });

    expect(walkthrough.sections.map(({ title, files }) => [title, files])).toEqual([
      ['Retry failed uploads', ['src/upload.ts']],
      ['Remove the legacy path', ['src/legacy.ts', 'src/retry.ts']],
      ['Other changes', ['docs/upload.md', 'src/upload.test.ts']]
    ]);
    // The pointer follows its section to its new place.
    expect(walkthrough.attention).toEqual([{ text: 'The legacy upload path is deleted', section: 1 }]);
  });

  it('keeps what an attention pointer names only when it is the review\'s own: one of its findings, or a file of its section', () => {
    const { walkthrough } = valid({
      attention: [
        { text: 'Retries never stop', section: 1, finding: 'endless-retry', path: '"src/upload.ts"' },
        { text: 'A finding the review did not write', section: 1, finding: 'made-up' },
        { text: 'A file of another section', section: 1, path: 'src/legacy.ts' }
      ],
      sections: [section('Retry failed uploads', ['src/upload.ts', 'src/retry.ts']), section('Remove the legacy path', ['src/legacy.ts'])]
    }, new Set(['endless-retry']));

    expect(walkthrough.attention).toEqual([
      { text: 'Retries never stop', section: 0, finding: 'endless-retry', path: 'src/upload.ts' },
      { text: 'A finding the review did not write', section: 0 },
      { text: 'A file of another section', section: 0 }
    ]);
  });

  it('keeps an excerpt only inside one hunk of a file of its own section, at the base only for a deleted file', () => {
    const { walkthrough } = valid({
      sections: [
        section('Retry failed uploads', ['src/upload.ts', 'src/legacy.ts'], {
          excerpts: [
            { path: 'src/upload.ts', side: 'head', line: 12, endLine: 20, caption: ' Retry until the server answers ' },
            { path: 'src/upload.ts', line: 40 },
            { path: 'src/upload.ts', side: 'head', line: 20, endLine: 42 },
            { path: 'src/upload.ts', side: 'head', line: 25, endLine: 30 },
            { path: 'src/upload.ts', side: 'head', line: 14, endLine: 12 },
            { path: 'src/upload.ts', side: 'base', line: 10, endLine: 12 },
            { path: 'src/legacy.ts', side: 'base', line: 2, endLine: 6 },
            { path: 'src/legacy.ts', side: 'head', line: 2, endLine: 6 },
            { path: 'src/retry.ts', side: 'head', line: 1, endLine: 5 }
          ]
        }),
        section('Add the retry module', ['src/retry.ts'])
      ]
    });

    expect(walkthrough.sections[0]!.excerpts).toEqual([
      { path: 'src/upload.ts', side: 'NEW', line: 12, endLine: 20, caption: 'Retry until the server answers' },
      { path: 'src/upload.ts', side: 'NEW', line: 40 },
      { path: 'src/legacy.ts', side: 'OLD', line: 2, endLine: 6 }
    ]);
  });

  it('keeps a term that is an exact phrase of its explanation, whole code spans only, tied to changed lines of its section', () => {
    const { walkthrough } = valid({
      sections: [
        {
          title: 'Retry failed uploads',
          explanation: 'Failed uploads now retry with `backoff()` until the server answers.',
          files: ['src/upload.ts', 'src/retry.ts'],
          terms: [
            { text: 'Failed uploads', path: 'src/upload.ts', line: 10, endLine: 12 },
            { text: '`backoff()`', path: 'src/retry.ts', side: 'head', line: 3 },
            { text: 'backoff', path: 'src/retry.ts', line: 3 },
            { text: 'retry later', path: 'src/upload.ts', line: 10 },
            { text: 'Failed uploads', path: 'src/upload.ts', line: 41 },
            { text: 'the server answers', path: 'src/upload.ts', line: 30 },
            { text: 'the server', path: 'src/legacy.ts', side: 'base', line: 2 }
          ]
        },
        section('Remove the legacy path', ['src/legacy.ts'])
      ]
    });

    expect(walkthrough.sections[0]!.terms).toEqual([
      { text: 'Failed uploads', path: 'src/upload.ts', side: 'NEW', line: 10, endLine: 12 },
      { text: '`backoff()`', path: 'src/retry.ts', side: 'NEW', line: 3 }
    ]);
  });

  it('holds the counts the prompt asks for, keeps an excerpt once and cuts long words', () => {
    const { walkthrough } = valid({
      summary: 'x'.repeat(900),
      attention: [1, 2, 3, 4].map((count) => ({ text: `Fact ${count}`, section: 1 })),
      sections: [
        {
          title: 'T'.repeat(130),
          explanation: 'One two three four.',
          files: ['src/upload.ts'],
          excerpts: [10, 10, 11, 12, 13].map((line) => ({ path: 'src/upload.ts', line })),
          terms: ['One', 'two', 'three', 'four'].map((text) => ({ text, path: 'src/upload.ts', line: 10 }))
        }
      ]
    });

    expect(walkthrough.summary).toBe(`${'x'.repeat(799)}…`);
    expect(walkthrough.sections[0]!.title).toBe(`${'T'.repeat(119)}…`);
    expect(walkthrough.sections[0]!.excerpts.map((excerpt) => excerpt.line)).toEqual([10, 11, 12]);
    expect(walkthrough.sections[0]!.terms.map((term) => term.text)).toEqual(['One', 'two', 'three']);
    expect(walkthrough.attention.map((fact) => fact.text)).toEqual(['Fact 1', 'Fact 2', 'Fact 3']);
    // The repeated excerpt, the fourth excerpt, the fourth term and the fourth pointer.

    // Past nine sections, the files of the rest join Other changes.
    const many: ReviewedChange = {
      ...CHANGE,
      files: Array.from({ length: 11 }, (_, index) => ({ path: `src/part${index}.ts`, status: 'modified' as const, additions: 1, deletions: 0, hunks: [hunk(1, 1, 1, 1)] }))
    };
    const crowded = valid({ sections: many.files.map((file) => section(`Change ${file.path}`, [file.path])) }, new Set(), many);
    expect(crowded.walkthrough.sections).toHaveLength(10);
    expect(crowded.walkthrough.sections.at(-1)).toMatchObject({ title: 'Other changes', files: ['src/part9.ts', 'src/part10.ts'] });
  });

  it('keeps nothing when the review wrote no walkthrough or no section holds a changed file', () => {
    const none = new Set<string>();
    expect(checkReviewWalkthrough(undefined, CHANGE, none)).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_WRITTEN' });
    expect(checkReviewWalkthrough({ summary: 'Uploads retry.', sections: 'all of them' }, CHANGE, none))
      .toEqual({ status: 'UNAVAILABLE', reason: 'NO_SECTIONS' });
    expect(checkReviewWalkthrough({ sections: [section('Retry failed uploads', ['src/elsewhere.ts'])] }, CHANGE, none))
      .toEqual({ status: 'UNAVAILABLE', reason: 'NO_SECTIONS' });
  });

  it('reads a path the agent kept quoted, as the change index quotes one that holds a space', () => {
    const spaced: ReviewedChange = { ...CHANGE, files: [{ path: 'docs/User Guide.md', status: 'modified', additions: 1, deletions: 0, hunks: [hunk(2, 1, 2, 2)] }] };
    const check = checkReviewWalkthrough({ sections: [section('Document retries', ['"docs/User Guide.md"'])] }, spaced, new Set());
    expect(check).toMatchObject({ status: 'VALID', walkthrough: { sections: [{ files: ['docs/User Guide.md'] }] } });
  });
});
