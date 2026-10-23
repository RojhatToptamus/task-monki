import { describe, expect, it } from 'vitest';
import { parseReviewedDiff, reviewedDiffExcerpt } from './ReviewedDiff';

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
