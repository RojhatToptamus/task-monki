import { describe, expect, it } from 'vitest';
import { inspectGitDiffEvidence, parseGitDiffEvidenceForScope } from './diffEvidence';

const parseAll = (text: string) => parseGitDiffEvidenceForScope(text, 'all');

describe('diff evidence parser', () => {
  it('parses Git evidence sections into files with line stats', () => {
    const files = parseAll(`# Git diff evidence

## Diff stat
 src/App.tsx | 2 +-

## Committed diff
No committed diff.

## Staged diff
diff --git a/src/App.tsx b/src/App.tsx
index 1111111..2222222 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,3 +1,3 @@
 import React from 'react';
-const label = 'Old';
+const label = 'New';
 export default label;

## Unstaged diff
diff --git a/src/model/task.ts b/src/model/task.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/model/task.ts
@@ -0,0 +1,2 @@
+export const task = true;
+export const status = 'ready';
`);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      path: 'src/App.tsx',
      status: 'modified',
      additions: 1,
      deletions: 1
    });
    expect(files[0].blocks[0].label).toBe('Staged diff');
    expect(files[0].blocks[0].lines.some((line) => line.kind === 'hunk')).toBe(true);
    expect(files[1]).toMatchObject({
      path: 'src/model/task.ts',
      status: 'added',
      additions: 2,
      deletions: 0
    });
  });

  it('distinguishes complete, incomplete, truncated, and uninterpretable evidence', () => {
    const completeEmptyEvidence = `# Git diff evidence

## Committed diff

No committed diff.

## Staged diff

No staged diff.

## Unstaged diff

No unstaged diff.
`;

    expect(inspectGitDiffEvidence(completeEmptyEvidence).completeness).toBe('COMPLETE');
    expect(
      inspectGitDiffEvidence(
        '# Git diff evidence\n\n## Committed diff unavailable\n\ngit failed'
      ).completeness
    ).toBe('INCOMPLETE');
    expect(
      inspectGitDiffEvidence(
        '[Task Monki truncated diff after 33554432 retained bytes.]'
      ).completeness
    ).toBe('INCOMPLETE');
    expect(
      inspectGitDiffEvidence('diff --git malformed evidence without a parsed file').completeness
    ).toBe('UNINTERPRETABLE');
    expect(inspectGitDiffEvidence('').completeness).toBe('UNINTERPRETABLE');
    expect(
      inspectGitDiffEvidence('# Git diff evidence\n\n## Committed diff\n\nNo committed diff.')
        .completeness
    ).toBe('INCOMPLETE');
  });

  it('marks a mixed parsed and unparsed diff as incomplete instead of omitting a path', () => {
    const evidence = `diff --git a/src/parsed.ts b/src/parsed.ts
--- a/src/parsed.ts
+++ b/src/parsed.ts
@@ -1 +1 @@
-old
+new
diff --git "a/src/quoted name.ts" "b/src/quoted name.ts"
--- "a/src/quoted name.ts"
+++ "b/src/quoted name.ts"
@@ -1 +1 @@
-old
+new
`;

    const inspected = inspectGitDiffEvidence(evidence);

    expect(inspected.files.map((file) => file.path)).toEqual(['src/parsed.ts']);
    expect(inspected.completeness).toBe('INCOMPLETE');
  });

  it('keeps trailing patch text out of a file once its hunk counts are used up', () => {
    // Git ends every patch with a newline and evidence sections are separated by
    // blank lines; neither may become a context row with invented line numbers.
    const files = parseAll([
      '## Committed diff',
      'diff --git a/scenarios/review-passed.txt b/scenarios/review-passed.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/scenarios/review-passed.txt',
      '@@ -0,0 +1 @@',
      '+Committed seed change.',
      '',
      '',
      '## Unstaged diff',
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' ',
      '-old',
      '+new',
      ''
    ].join('\n'));

    const rows = (path: string) => files
      .find((file) => file.path === path)!
      .blocks.flatMap((block) => block.lines)
      .filter((line) => line.kind !== 'meta');
    expect(rows('scenarios/review-passed.txt')).toEqual([
      { kind: 'hunk', content: '@@ -0,0 +1 @@' },
      { kind: 'addition', newLine: 1, content: '+Committed seed change.' }
    ]);
    // A real blank context line keeps its single-space prefix and its numbers.
    expect(rows('a.txt').map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['hunk', undefined, undefined],
      ['context', 1, 1],
      ['deletion', 2, undefined],
      ['addition', undefined, 2]
    ]);
  });

  it('reads hunk lines by their prefix, not by what their text looks like', () => {
    const files = parseAll([
      'diff --git a/db/schema.sql b/db/schema.sql',
      '--- a/db/schema.sql',
      '+++ b/db/schema.sql',
      '@@ -1,2 +1,2 @@',
      // Removed and added lines whose text starts with "-- " and "++ ".
      '--- legacy index',
      ' CREATE TABLE tasks (id TEXT);',
      '\\ No newline at end of file',
      '+++ counter',
      '@@ -10 +10 @@',
      '-old',
      '+new',
      'diff --git a/notes.txt b/notes.txt',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,5 +1,5 @@',
      ' kept',
      '[Task Monki truncated unstaged diff after 4096 retained bytes.]',
      ''
    ].join('\n'));

    const schema = files.find((file) => file.path === 'db/schema.sql');
    expect(files.map((file) => file.path)).toEqual(['db/schema.sql', 'notes.txt']);
    expect(schema?.oldPath).toBeUndefined();
    expect(schema?.deletions).toBe(2);
    expect(schema?.additions).toBe(2);
    // A truncated hunk stops at the marker; neither it nor the trailing blank gets numbers.
    const notes = files.find((file) => file.path === 'notes.txt')!
      .blocks.flatMap((block) => block.lines)
      .filter((line) => line.kind !== 'meta' && line.kind !== 'hunk');
    expect(notes).toEqual([{ kind: 'context', oldLine: 1, newLine: 1, content: ' kept' }]);
  });

  it('parses synthetic empty added-file diffs without hunks', () => {
    const files = parseAll(`# Git diff evidence

## Unstaged diff
diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..0000000
--- /dev/null
+++ b/empty.txt
`);

    expect(files).toEqual([
      expect.objectContaining({
        path: 'empty.txt',
        status: 'added',
        additions: 0,
        deletions: 0
      })
    ]);
    expect(files[0].blocks[0]?.source).toBe('unstaged');
  });

  it('flags a file only when its added lines hide characters that change how the code reads', () => {
    const files = parseAll(`diff --git a/bidi.ts b/bidi.ts
--- a/bidi.ts
+++ b/bidi.ts
@@ -3 +3 @@
-const access = 'user';
+const access = 'user‮ ⁦// admin⁩';
diff --git a/emoji.ts b/emoji.ts
--- a/emoji.ts
+++ b/emoji.ts
@@ -1 +1 @@
-const family = '';
+const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
diff --git a/opening-mark.ts b/opening-mark.ts
new file mode 100644
--- /dev/null
+++ b/opening-mark.ts
@@ -0,0 +1,2 @@
+﻿export const a = 1;
+export const b = 2;
diff --git a/inner-mark.ts b/inner-mark.ts
--- a/inner-mark.ts
+++ b/inner-mark.ts
@@ -4 +4 @@
-const x = 1;
+const x = ﻿1;
diff --git a/removed.ts b/removed.ts
--- a/removed.ts
+++ b/removed.ts
@@ -1 +1 @@
-const hidden = 'a​b';
+const hidden = 'ab';
`);

    // Direction controls and a mark inside a file hide; joiners in an emoji, a
    // mark that opens a file, and what a change removes do not.
    expect(files.filter((file) => file.invisibleCharacters).map((file) => file.path)).toEqual(['bidi.ts', 'inner-mark.ts']);
  });

  it('separates committed and uncommitted evidence scopes', () => {
    const text = `# Git diff evidence

## Committed diff
diff --git a/src/committed.ts b/src/committed.ts
--- a/src/committed.ts
+++ b/src/committed.ts
@@ -1 +1,2 @@
 const oldValue = true;
+const committed = true;

## Staged diff
diff --git a/src/staged.ts b/src/staged.ts
new file mode 100644
--- /dev/null
+++ b/src/staged.ts
@@ -0,0 +1 @@
+export const staged = true;

## Unstaged diff
diff --git a/src/local.ts b/src/local.ts
--- a/src/local.ts
+++ b/src/local.ts
@@ -1 +1 @@
-old
+local
`;

    expect(parseGitDiffEvidenceForScope(text, 'all').map((file) => file.path)).toEqual([
      'src/committed.ts',
      'src/local.ts',
      'src/staged.ts'
    ]);
    expect(parseGitDiffEvidenceForScope(text, 'committed').map((file) => file.path)).toEqual([
      'src/committed.ts'
    ]);
    expect(parseGitDiffEvidenceForScope(text, 'uncommitted').map((file) => file.path)).toEqual([
      'src/local.ts',
      'src/staged.ts'
    ]);
    expect(parseGitDiffEvidenceForScope(text, 'uncommitted')[0].blocks[0].source).toBe(
      'unstaged'
    );
  });
});
