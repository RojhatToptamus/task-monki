import { describe, expect, it } from 'vitest';
import type { DiffLine } from './diffEvidence';
import { MAX_SYNTAX_LENGTH, diffSides, syntaxJob, syntaxLanguage } from './syntaxHighlight';

describe('syntax language', () => {
  it('takes the grammar from the last extension, in any case, and none for a type without one', () => {
    expect(syntaxLanguage('src/shared/contracts.d.ts')).toBe('typescript');
    expect(syntaxLanguage('src/renderer/ui/ReviewLine.tsx')).toBe('tsx');
    expect(syntaxLanguage('scripts/check-architecture.mjs')).toBe('javascript');
    expect(syntaxLanguage('docs/README.MD')).toBe('markdown');
    expect(syntaxLanguage('.github/workflows/ci.yml')).toBe('yaml');
    expect(syntaxLanguage('scripts/sign.sh')).toBe('shell');
    expect(syntaxLanguage('Makefile')).toBeUndefined();
    expect(syntaxLanguage('yarn.lock')).toBeUndefined();
    expect(syntaxLanguage('src.d/LICENSE')).toBeUndefined();
  });
});

describe('syntax job', () => {
  it('keys a side by its language and content, so equal sides share one result', () => {
    const lines = ['const a = 1;', 'export default a;'];
    expect(syntaxJob('a.ts', lines)?.key).toBe(syntaxJob('b.ts', [...lines])?.key);
    expect(syntaxJob('a.ts', lines)?.key).not.toBe(syntaxJob('a.js', lines)?.key);
    expect(syntaxJob('a.ts', lines)?.key).not.toBe(syntaxJob('a.ts', ['const a = 2;', 'export default a;'])?.key);
  });

  it('leaves a side plain with no grammar, no lines, or more text than is worth colouring', () => {
    expect(syntaxJob('notes.txt', ['plain'])).toBeUndefined();
    expect(syntaxJob('a.ts', [])).toBeUndefined();
    expect(syntaxJob('a.ts', ['x'.repeat(MAX_SYNTAX_LENGTH + 1)])).toBeUndefined();
  });
});

describe('diff sides', () => {
  it('reads a block as its two sides, a removed line on the old side and any other on the new', () => {
    const lines: DiffLine[] = [
      { kind: 'meta', content: 'index 1111111..2222222 100644' },
      { kind: 'hunk', content: '@@ -1,3 +1,3 @@' },
      { kind: 'context', content: ' /* opens', oldLine: 1, newLine: 1 },
      { kind: 'deletion', content: '-   old */', oldLine: 2 },
      { kind: 'addition', content: '+   new */', newLine: 2 },
      { kind: 'context', content: ' done();', oldLine: 3, newLine: 3, expansion: 'hidden' }
    ];
    expect(diffSides(lines)).toEqual({
      oldLines: ['/* opens', '   old */', 'done();'],
      newLines: ['/* opens', '   new */', 'done();'],
      index: [-1, -1, 0, 1, 1, 2]
    });
  });
});
