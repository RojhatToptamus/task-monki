import { describe, expect, it } from 'vitest';
import { inspectGitDiffEvidence, type DiffFile } from './diffEvidence';
import {
  checkoutMatchesBlock,
  contextCandidates,
  fillableLines,
  fillBlockGaps,
  fillFileGaps,
  gapSteps,
  revealLines,
  splitCheckoutLines,
  wholeFileState
} from './reviewContext';
import { anchorReviewFindings, buildReviewDiffRows, diffFileSignature, lineAnchorKey, type ReviewFindingView } from './reviewWorkspace';

// The checkout's file: 61 lines, line 10 changed and line 41 added since the base.
const checkout = Array.from({ length: 61 }, (_, index) => {
  const line = index + 1;
  if (line === 10) return "const v10 = 'ten';";
  if (line === 41) return 'const extra = true;';
  return `const v${line > 41 ? line - 1 : line} = ${line > 41 ? line - 1 : line};`;
});
const checkoutText = `${checkout.join('\n')}\n`;
const BLOB = 'abcdef0123456789abcdef0123456789abcdef01';

function capture(path = 'src/values.ts', index = `index 1111111..${BLOB.slice(0, 7)} 100644`): DiffFile {
  const at = (line: number) => checkout[line - 1];
  const patch = [
    `diff --git a/${path} b/${path}`,
    index,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -7,7 +7,7 @@ export const values = {',
    ` ${at(7)}`, ` ${at(8)}`, ` ${at(9)}`, '-const v10 = 10;', `+${at(10)}`, ` ${at(11)}`, ` ${at(12)}`, ` ${at(13)}`,
    '@@ -38,6 +38,7 @@ export function more() {',
    ` ${at(38)}`, ` ${at(39)}`, ` ${at(40)}`, `+${at(41)}`, ` ${at(42)}`, ` ${at(43)}`, ` ${at(44)}`
  ].join('\n');
  const text = `# Git diff evidence\n\n## Committed diff\n\nNo committed diff.\n\n## Staged diff\n\nNo staged diff.\n\n## Unstaged diff\n\n${patch}\n`;
  return inspectGitDiffEvidence(text).files[0]!;
}

function gaps(lines: DiffFile['blocks'][number]['lines']) {
  return buildReviewDiffRows(lines).flatMap((row) => (row.kind === 'gap' ? [{ hidden: row.hidden, heading: row.heading, reveal: row.reveal }] : []));
}

describe('checkoutMatchesBlock', () => {
  const block = capture().blocks[0]!;

  it('accepts the checkout when it is the captured new side', () => {
    expect(checkoutMatchesBlock(block, splitCheckoutLines(checkoutText), BLOB)).toBe(true);
    // Line endings do not make a file different: the capture is read with CRLF folded too.
    expect(checkoutMatchesBlock(block, splitCheckoutLines(checkoutText.replace(/\n/g, '\r\n')), BLOB)).toBe(true);
  });

  it('refuses a file that changed since the capture, even where the hunks still read the same', () => {
    const edited = [...checkout];
    edited[24] = 'const v25 = "edited inside the gap";';
    expect(checkoutMatchesBlock(block, edited, 'fedcba9876543210fedcba9876543210fedcba98')).toBe(false);
  });

  it('checks every hunk line when the capture recorded no blob', () => {
    const unrecorded = capture('src/values.ts', 'similarity index 90%').blocks[0]!;
    expect(checkoutMatchesBlock(unrecorded, checkout, 'any')).toBe(true);
    const shifted = ['// a new first line', ...checkout];
    expect(checkoutMatchesBlock(unrecorded, shifted, 'any')).toBe(false);
  });

  it('never fills a deleted file', () => {
    const deleted = capture('src/values.ts', 'index 1111111..0000000').blocks[0]!;
    expect(checkoutMatchesBlock(deleted, checkout, '0000000000000000000000000000000000000000')).toBe(false);
  });
});

describe('filled gaps', () => {
  const file = capture();
  const filled = fillBlockGaps(file.blocks[0]!, checkout);

  it('turns each run of the file outside the hunks into a gap that knows its lines and which way it opens', () => {
    expect(gaps(filled.lines)).toEqual([
      { hidden: 6, heading: 'export const values = {', reveal: { from: 1, to: 6, edge: 'start' } },
      { hidden: 24, heading: 'export function more() {', reveal: { from: 14, to: 37, edge: 'middle' } },
      { hidden: 17, heading: undefined, reveal: { from: 45, to: 61, edge: 'end' } }
    ]);
    // The captured rows are the same rows, in the same order.
    const captured = (lines: typeof filled.lines) => buildReviewDiffRows(lines).flatMap((row) => (row.kind === 'line' ? [row.line.content] : []));
    expect(captured(filled.lines)).toEqual(captured(file.blocks[0]!.lines));
  });

  it('shows revealed lines as context rows with old-side numbers taken from the offset', () => {
    const revealed = revealLines(filled, new Set([14, 15, 45]));
    const rows = buildReviewDiffRows(revealed.lines).flatMap((row) => (row.kind === 'line' && row.line.expansion ? [row.line] : []));
    // Line 10 was changed in place, so the middle gap keeps old = new; one line was added above the end gap.
    expect(rows.map(({ kind, oldLine, newLine, content }) => ({ kind, oldLine, newLine, content }))).toEqual([
      { kind: 'context', oldLine: 14, newLine: 14, content: ` ${checkout[13]}` },
      { kind: 'context', oldLine: 15, newLine: 15, content: ` ${checkout[14]}` },
      { kind: 'context', oldLine: 44, newLine: 45, content: ` ${checkout[44]}` }
    ]);
    expect(gaps(revealed.lines).map((gap) => gap.reveal)).toEqual([
      { from: 1, to: 6, edge: 'start' },
      { from: 16, to: 37, edge: 'middle' },
      { from: 46, to: 61, edge: 'end' }
    ]);
  });

  it('keeps every row where it was as lines are revealed, so anchors and selections stay put', () => {
    const added = `+${checkout[40]}`;
    const indexOfAdded = (lines: typeof filled.lines) =>
      buildReviewDiffRows(lines).flatMap((row) => (row.kind === 'line' && row.line.content === added ? [row.index] : []));
    expect(indexOfAdded(filled.lines)).toHaveLength(1);
    expect(indexOfAdded(revealLines(filled, new Set(fillableLines(filled))).lines)).toEqual(indexOfAdded(filled.lines));
  });

  it('leaves no gap once every line is revealed', () => {
    expect(gaps(revealLines(filled, new Set(fillableLines(filled))).lines)).toEqual([]);
  });

  it('never changes what was viewed, and anchors a finding to an unchanged line once it shows', () => {
    const filledFile = { ...file, blocks: [filled] };
    const revealedFile = { ...file, blocks: [revealLines(filled, new Set([20]))] };
    expect(diffFileSignature(filledFile)).toBe(diffFileSignature(file));
    expect(diffFileSignature(revealedFile)).toBe(diffFileSignature(file));

    const finding: ReviewFindingView = { id: 'f', severity: 'MINOR', title: 'Unchanged but wrong', explanation: 'Why.', path: file.path, line: 20, state: 'OPEN' };
    expect(anchorReviewFindings([filledFile], [finding]).byFile.get(file.id)?.map((item) => item.id)).toEqual(['f']);
    const index = revealedFile.blocks[0]!.lines.findIndex((line) => line.newLine === 20);
    expect(anchorReviewFindings([revealedFile], [finding]).byLine.get(lineAnchorKey(file.id, filled.id, revealedFile.blocks[0]!.lines[index]!, index))?.map((item) => item.id)).toEqual(['f']);
  });
});

describe('gapSteps', () => {
  it('steps 20 lines from the change on each side, one way at the file’s ends, and not at all for a short gap', () => {
    expect(gapSteps({ from: 14, to: 37, edge: 'middle' })).toEqual({ up: [18, 37], down: [14, 33] });
    expect(gapSteps({ from: 1, to: 30, edge: 'start' })).toEqual({ up: [11, 30] });
    expect(gapSteps({ from: 45, to: 80, edge: 'end' })).toEqual({ down: [45, 64] });
    expect(gapSteps({ from: 45, to: 64, edge: 'end' })).toEqual({});
  });
});

describe('fillFileGaps and wholeFileState', () => {
  const file = capture();

  it('offers the whole file while lines are hidden, and changes only once all are shown', () => {
    const { file: filled, offer } = fillFileGaps(file, { status: 'TEXT', text: checkoutText, blobSha1: BLOB });
    expect(offer).toBe('lines');
    expect(wholeFileState(filled, offer)).toEqual({ kind: 'partial' });
    const whole = { ...filled, blocks: filled.blocks.map((block) => revealLines(block, new Set(fillableLines(block)))) };
    expect(wholeFileState(whole, offer)).toEqual({ kind: 'whole' });
  });

  it('says in the fewest words why a file cannot be shown whole', () => {
    const changed = fillFileGaps(file, { status: 'TEXT', text: checkoutText, blobSha1: 'fedcba9876543210fedcba9876543210fedcba98' });
    expect(changed.file).toBe(file);
    expect(wholeFileState(changed.file, changed.offer)).toEqual({ kind: 'unavailable', reason: 'Differs from the checkout' });
    expect(wholeFileState(file, fillFileGaps(file, { status: 'MISSING' }).offer)).toEqual({ kind: 'unavailable', reason: 'Differs from the checkout' });
    expect(wholeFileState(file, fillFileGaps(file, { status: 'TOO_LARGE' }).offer)).toEqual({ kind: 'unavailable', reason: 'Too large to show' });
    expect(wholeFileState(file, fillFileGaps(file, { status: 'BINARY' }).offer)).toEqual({ kind: 'none' });
    expect(wholeFileState(file, fillFileGaps(file, undefined).offer)).toEqual({ kind: 'none' });
  });
});

describe('contextCandidates', () => {
  it('reads changed files that still exist, never generated ones or changes without hunks', () => {
    const base = capture();
    const files: DiffFile[] = [
      base,
      { ...base, id: 'new', path: 'src/new.ts', status: 'added' },
      { ...base, id: 'gone', path: 'src/gone.ts', status: 'deleted' },
      { ...base, id: 'lock', path: 'package-lock.json' },
      { ...base, id: 'moved', path: 'src/moved.ts', status: 'renamed', blocks: [{ ...base.blocks[0]!, lines: base.blocks[0]!.lines.filter((line) => line.kind === 'meta') }] }
    ];
    expect(contextCandidates(files)).toEqual(['src/values.ts']);
  });
});
