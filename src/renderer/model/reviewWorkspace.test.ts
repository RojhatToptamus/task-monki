import { describe, expect, it } from 'vitest';
import type { DiffFile } from './diffEvidence';
import {
  anchorReviewFindings,
  buildReviewDiffRows,
  buildReviewIndex,
  filesChangedSinceReview,
  lineAnchorKey,
  sideLines,
  type ReviewFindingView
} from './reviewWorkspace';

function file(path: string, blocks: DiffFile['blocks']): DiffFile {
  return { id: `file:${path}`, path, status: 'modified', additions: 1, deletions: 0, blocks };
}

const rateLimit = file('src/middleware/rateLimit.ts', [
  {
    id: 'committed', label: 'Committed', source: 'committed', lines: [
      { kind: 'hunk', content: '@@ -38,2 +38,4 @@ export function rateLimit(options) {' },
      { kind: 'context', oldLine: 38, newLine: 38, content: '     if (!key) return next();' },
      { kind: 'addition', newLine: 39, content: '+    const now = Date.now();' },
      { kind: 'addition', newLine: 40, content: '+    buckets.set(key, refill(bucket));' },
      { kind: 'context', oldLine: 39, newLine: 41, content: '     next();' }
    ]
  },
  {
    id: 'unstaged', label: 'Unstaged', source: 'unstaged', lines: [
      { kind: 'hunk', content: '@@ -75,1 +75,2 @@' },
      { kind: 'addition', newLine: 76, content: "+    res.setHeader('Retry-After', retryAfter);" }
    ]
  }
]);

function finding(id: string, extra: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return { id, severity: 'MAJOR', title: id, explanation: 'Why.', state: 'OPEN', ...extra };
}

describe('anchorReviewFindings', () => {
  it('anchors a range after its last displayed line and keeps findings outside the diff visible', () => {
    const anchored = anchorReviewFindings([rateLimit], [
      finding('range', { path: './src/middleware/rateLimit.ts', line: 39, endLine: 40 }),
      finding('latest-block', { path: 'src/middleware/rateLimit.ts', line: 76 }),
      finding('outside-diff', { path: 'src/middleware/rateLimit.ts', line: 400 }),
      finding('other-file', { path: 'src/server.ts', line: 3 }),
      finding('no-location')
    ]);

    const key = (blockId: string, index: number) => lineAnchorKey(rateLimit.id, blockId, rateLimit.blocks.find((block) => block.id === blockId)!.lines[index]!, index);
    expect(anchored.byLine.get(key('committed', 3))?.map((item) => item.id)).toEqual(['range']);
    expect(anchored.byLine.get(key('unstaged', 1))?.map((item) => item.id)).toEqual(['latest-block']);
    expect(anchored.byFile.get(rateLimit.id)?.map((item) => item.id)).toEqual(['outside-diff']);
    expect(anchored.general.map((item) => item.id)).toEqual(['other-file', 'no-location']);
    expect(buildReviewIndex([rateLimit], anchored)[0]?.findings.map((item) => item.id)).toEqual(['outside-diff', 'range', 'latest-block']);
  });

  it('finds a review\'s lines on the old side of the changes since that review', () => {
    // Lines added above since the review shift the new side; the old side is the code the review read.
    const sinceReview = file('src/app.js', [{
      id: 'changes', label: 'Local diff', source: 'unstaged', lines: [
        { kind: 'hunk', content: '@@ -10,2 +10,7 @@' },
        ...[10, 11, 12, 13, 14].map((newLine) => ({ kind: 'addition' as const, newLine, content: '+added' })),
        { kind: 'context', oldLine: 10, newLine: 15, content: ' kept' },
        { kind: 'deletion', oldLine: 11, content: '-reviewed' }
      ]
    }]);
    const reviewed = [finding('reviewed', { path: 'src/app.js', line: 10, endLine: 11 })];
    const key = (index: number) => lineAnchorKey(sinceReview.id, 'changes', sinceReview.blocks[0]!.lines[index]!, index);

    expect(anchorReviewFindings([sinceReview], reviewed, 'REVIEWED').byLine.get(key(7))?.map((item) => item.id)).toEqual(['reviewed']);
    expect(anchorReviewFindings([sinceReview], reviewed).byLine.get(key(2))?.map((item) => item.id)).toEqual(['reviewed']);
  });
});

describe('buildReviewDiffRows', () => {
  it('turns hunk headers into gap rows that count the unchanged lines they skip', () => {
    const rows = buildReviewDiffRows(rateLimit.blocks[0]!.lines);
    expect(rows[0]).toEqual({ kind: 'gap', hidden: 37, heading: 'export function rateLimit(options) {', raw: rateLimit.blocks[0]!.lines[0]!.content });
    expect(rows.filter((row) => row.kind === 'line')).toHaveLength(4);
  });
});

describe('filesChangedSinceReview', () => {
  it('reports files whose change differs, appeared, or disappeared after the review', () => {
    const unchanged = file('README.md', [{ id: 'c', label: 'Committed', source: 'committed', lines: [{ kind: 'addition', newLine: 1, content: '+Hello' }] }]);
    const edited = file('src/a.ts', [{ id: 'c', label: 'Committed', source: 'committed', lines: [{ kind: 'addition', newLine: 1, content: '+a' }] }]);
    const editedAfter = file('src/a.ts', [{ id: 'c', label: 'Committed', source: 'committed', lines: [{ kind: 'addition', newLine: 1, content: '+b' }] }]);
    const removed = file('src/gone.ts', edited.blocks);
    const added = file('src/new.ts', edited.blocks);

    expect([...filesChangedSinceReview([unchanged, edited, removed], [unchanged, editedAfter, added])].sort())
      .toEqual(['src/a.ts', 'src/gone.ts', 'src/new.ts']);
  });
});

describe('sideLines', () => {
  it('reads the code a suggestion replaces without the diff marks, and nothing when a line is not in the diff', () => {
    const greet = file('src/greet.js', [{ id: 'committed', label: 'Committed', source: 'committed', lines: [
      { kind: 'hunk', content: '@@ -9,2 +9,2 @@' },
      { kind: 'deletion', oldLine: 9, content: '-  return prefix;' },
      { kind: 'addition', newLine: 9, content: '+  const prefix = pick(locale);' },
      { kind: 'context', oldLine: 10, newLine: 10, content: '   return prefix;' }
    ] }]);
    expect(sideLines(greet, 'NEW', 9, 10)).toEqual(['  const prefix = pick(locale);', '  return prefix;']);
    expect(sideLines(greet, 'OLD', 9, 9)).toEqual(['  return prefix;']);
    expect(sideLines(greet, 'NEW', 9, 11)).toBeUndefined();
  });
});
