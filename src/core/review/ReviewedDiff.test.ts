import { describe, expect, it } from 'vitest';
import { changeIndexText, parseReviewedDiff, reviewedDiffExcerpt } from './ReviewedDiff';

const DIFF = [
  '# Git diff evidence',
  '',
  '## Diff stat',
  '',
  ' src/a.ts | 2 +-',
  '',
  '## Committed diff',
  '',
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '',
  '## Staged diff',
  '',
  'No staged diff.',
  '',
  '## Unstaged diff',
  '',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..0000000',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export const added = true;',
  ''
].join('\n');

describe('reviewed diff evidence', () => {
  it('reads every changed path, including untracked files, once', () => {
    expect(parseReviewedDiff(DIFF).map(({ path, hunks }) => [path, hunks.length])).toEqual([['src/a.ts', 1], ['src/new.ts', 1]]);
  });

  it('lists the change one line per file, quoting a path that holds a space so it never reads as a field', () => {
    const files = parseReviewedDiff([
      'diff --git a/docs/User Guide.md b/docs/User Guide.md', '--- a/docs/User Guide.md', '+++ b/docs/User Guide.md',
      '@@ -2 +2,2 @@', '-old', '+new', '+more',
      'diff --git a/src/a.ts b/src/a.ts', 'deleted file mode 100644', '--- a/src/a.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c', ''
    ].join('\n'));
    expect(changeIndexText(files).split('\n')).toEqual([
      '"docs/User Guide.md" modified +2 -1 head 2-3',
      'src/a.ts deleted +0 -3 base 1-3'
    ]);
  });

  it('prints one file’s hunks as an excerpt', () => {
    const file = parseReviewedDiff(DIFF).find((candidate) => candidate.path === 'src/a.ts')!;
    expect(reviewedDiffExcerpt(file, 2)).toBe([
      '--- src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;'
    ].join('\n'));
  });
});
