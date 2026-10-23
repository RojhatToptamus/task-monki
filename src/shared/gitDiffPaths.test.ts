import { describe, expect, it } from 'vitest';
import { diffHeaderPaths, diffSidePath, gitPath } from './gitDiffPaths';

describe('paths as a Git diff writes them', () => {
  it('reads a path that holds a space, a quote, a tab or a byte past ASCII as the file is named', () => {
    // A path with a space ends with a tab on its --- and +++ lines.
    expect(diffSidePath('b/my file.ts\t', 'b/')).toBe('my file.ts');
    expect(diffSidePath('"b/quo\\"te.ts"', 'b/')).toBe('quo"te.ts');
    expect(diffSidePath('"b/tab\\tname.ts"', 'b/')).toBe('tab\tname.ts');
    // With core.quotePath on, bytes past ASCII are octal escapes of their UTF-8.
    expect(diffSidePath('"b/caf\\303\\251.md"', 'b/')).toBe('café.md');
    expect(diffSidePath('/dev/null', 'a/')).toBeUndefined();
    expect(gitPath('"not \\q quoted"')).toBe('"not \\q quoted"');
  });

  it('reads both paths of a diff header, quoted or not, and a kept name that holds " b/" itself', () => {
    expect(diffHeaderPaths('diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"')).toEqual({ oldPath: 'café.md', newPath: 'café.md' });
    expect(diffHeaderPaths('diff --git a/empty file.txt b/empty file.txt')).toEqual({ oldPath: 'empty file.txt', newPath: 'empty file.txt' });
    expect(diffHeaderPaths('diff --git a/my file.ts b/their file.ts')).toEqual({ oldPath: 'my file.ts', newPath: 'their file.ts' });
    expect(diffHeaderPaths('diff --git a/x b/y.ts b/x b/y.ts')).toEqual({ oldPath: 'x b/y.ts', newPath: 'x b/y.ts' });
    expect(diffHeaderPaths('diff --git a/plain.ts "b/quo\\"te.ts"')).toEqual({ oldPath: 'plain.ts', newPath: 'quo"te.ts' });
    expect(diffHeaderPaths('diff --cc both.ts')).toBeUndefined();
  });
});
