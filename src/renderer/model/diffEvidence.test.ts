import { describe, expect, it } from 'vitest';
import {
  buildDiffFileTree,
  filterDiffFiles,
  groupDiffFiles,
  parseGitDiffEvidence,
  parseGitDiffEvidenceForScope
} from './diffEvidence';

describe('diff evidence parser', () => {
  it('parses Git evidence sections into files with line stats', () => {
    const files = parseGitDiffEvidence(`# Git diff evidence

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

  it('groups files by directory with root files first', () => {
    const groups = groupDiffFiles(
      parseGitDiffEvidence(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
diff --git a/src/ui/Task.tsx b/src/ui/Task.tsx
--- a/src/ui/Task.tsx
+++ b/src/ui/Task.tsx
@@ -1 +1 @@
-old
+new
`)
    );

    expect(groups.map((group) => group.directory)).toEqual(['Root', 'src/ui']);
    expect(groups[1].files[0].path).toBe('src/ui/Task.tsx');
  });

  it('builds a changed-file tree with aggregate counts', () => {
    const files = parseGitDiffEvidence(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
diff --git a/src/core/workflow/reducer.ts b/src/core/workflow/reducer.ts
--- a/src/core/workflow/reducer.ts
+++ b/src/core/workflow/reducer.ts
@@ -1 +1,2 @@
 const current = true;
+const next = true;
diff --git a/src/renderer/ui/TaskDetail.tsx b/src/renderer/ui/TaskDetail.tsx
--- a/src/renderer/ui/TaskDetail.tsx
+++ b/src/renderer/ui/TaskDetail.tsx
@@ -1 +1 @@
-old
+new
`);

    const tree = buildDiffFileTree(files);

    expect(tree.fileCount).toBe(3);
    expect(tree.additions).toBe(3);
    expect(tree.deletions).toBe(2);
    expect(tree.children.map((node) => node.name)).toEqual(['src', 'README.md']);

    const src = tree.children[0];
    expect(src).toMatchObject({
      type: 'directory',
      name: 'src',
      fileCount: 2
    });
    if (src.type !== 'directory') {
      throw new Error('expected src directory');
    }
    expect(src.children.map((node) => node.name)).toEqual(['core', 'renderer']);
  });

  it('filters changed files by path and status before tree rendering', () => {
    const files = parseGitDiffEvidence(`diff --git a/src/App.tsx b/src/App.tsx
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1 +1 @@
-old
+new
diff --git a/src/model/newTask.ts b/src/model/newTask.ts
new file mode 100644
--- /dev/null
+++ b/src/model/newTask.ts
@@ -0,0 +1 @@
+export const task = true;
diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
--- a/docs/old.md
+++ /dev/null
@@ -1 +0,0 @@
-removed
`);

    expect(filterDiffFiles(files, { query: 'model', status: 'all' })).toHaveLength(1);
    expect(filterDiffFiles(files, { status: 'added' }).map((file) => file.path)).toEqual([
      'src/model/newTask.ts'
    ]);
    expect(filterDiffFiles(files, { query: 'src', status: 'deleted' })).toHaveLength(0);
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
