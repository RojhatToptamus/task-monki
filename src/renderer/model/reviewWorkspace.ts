import type { EffectiveReviewFinding } from '../../shared/agentReviewFindings';
import type { ReviewComment } from '../../shared/reviewDraft';
import { diffLineCode, parseHunkHeader, type DiffBlock, type DiffFile, type DiffLine } from './diffEvidence';

/** A finding as the Review tab shows it: the review's finding with the person's and reviewer's decisions applied. */
export type ReviewFindingView = EffectiveReviewFinding;

/** Where each finding sits in the diff: after a line, at the top of its file, or in General. */
export interface AnchoredFindings {
  /** Findings shown under a diff line, keyed by `lineAnchorKey`. */
  byLine: Map<string, ReviewFindingView[]>;
  /** Findings about a file whose line is not in the diff, shown at the file's top. */
  byFile: Map<string, ReviewFindingView[]>;
  /** Findings without a location, or about a file the diff does not contain. */
  general: ReviewFindingView[];
}

/**
 * Where a diff line sits, by its side and number, so a key survives unchanged
 * lines opening above it; a line without a number falls back to its position.
 */
export function lineAnchorKey(fileId: string, blockId: string, line: Pick<DiffLine, 'kind' | 'oldLine' | 'newLine'>, index: number): string {
  return `${fileId}\u0000${blockId}\u0000${diffLineId(line, index)}`;
}

/** The files whose rows the line keys (`lineAnchorKey`) of these maps name: only those need reading row by row. */
export function lineKeyedFiles(...maps: ReadonlyMap<string, unknown>[]): Set<string> {
  const files = new Set<string>();
  for (const map of maps) for (const key of map.keys()) files.add(key.slice(0, key.indexOf('\u0000')));
  return files;
}

/** A line's identity within its block: its side and number, else its position. */
export function diffLineId(line: Pick<DiffLine, 'kind' | 'oldLine' | 'newLine'>, index: number): string {
  return line.kind === 'deletion' && line.oldLine !== undefined ? `o${line.oldLine}`
    : line.newLine !== undefined ? `n${line.newLine}` : `i${index}`;
}

/**
 * Where lines chosen by identity (`diffLineId`) sit in a block as it is now, so a
 * choice holds while unchanged lines open around it; the anchor is where it began.
 */
export function selectionRange(block: Pick<DiffBlock, 'lines'>, chosen: { start: string; end: string; anchor: string }): { start: number; end: number; anchor: number } | undefined {
  let indexes = lineIndexes.get(block.lines);
  if (!indexes) {
    indexes = new Map(block.lines.map((line, index) => [diffLineId(line, index), index]));
    lineIndexes.set(block.lines, indexes);
  }
  const [start, end, anchor] = [indexes.get(chosen.start), indexes.get(chosen.end), indexes.get(chosen.anchor)];
  return start === undefined || end === undefined || anchor === undefined ? undefined : { start: Math.min(start, end), end: Math.max(start, end), anchor };
}

/** Each line's position in its block, by `diffLineId`, read once per set of lines: a drag reads it at every row. */
const lineIndexes = new WeakMap<readonly DiffLine[], ReadonlyMap<string, number>>();

/**
 * A line's place by its file, side and number, the same in every mode, scope and Git
 * layer: what a term, an excerpt and G point at. A row carries its own as
 * `data-line-anchor`: a removed line its old number, any other its new one.
 */
export function lineAnchor(path: string, side: 'NEW' | 'OLD', line: number): string {
  return fileLineAnchor(path)(side, line);
}

/** `lineAnchor` for the lines of one file, its path read once. */
export function fileLineAnchor(path: string): (side: 'NEW' | 'OLD', line: number) => string {
  const prefix = `${normalizeReviewPath(path)}:`;
  return (side, line) => `${prefix}${side === 'OLD' ? 'o' : 'n'}${line}`;
}

/** A row's own place (`lineAnchor`, through `fileLineAnchor`): a removed line by its old number, any other by its new one. */
export function linePlace(anchorOf: ReturnType<typeof fileLineAnchor>, line: Pick<DiffLine, 'kind' | 'oldLine' | 'newLine'>): string | undefined {
  const removed = line.kind === 'deletion';
  const number = removed ? line.oldLine : line.newLine;
  return number === undefined ? undefined : anchorOf(removed ? 'OLD' : 'NEW', number);
}

/**
 * Whether a place (`lineAnchor`) names one line of the code as the worktree
 * holds it, in a file of the whole change: the file is one block, or the place
 * is a new-side line only its last block shows. That block's new side is the
 * worktree's; an earlier layer numbers lines as its commit or the index did.
 */
export function placeIsWorktreeLine(file: DiffFile, place: string): boolean {
  if (file.blocks.length === 1) return true;
  const anchorOf = fileLineAnchor(file.path);
  const shows = (block: DiffBlock, side: 'any' | 'new') => block.lines.some((line) =>
    line.expansion !== 'hidden' && (side === 'any' || line.kind !== 'deletion') && linePlace(anchorOf, line) === place);
  const last = file.blocks.at(-1);
  return Boolean(last && shows(last, 'new') && !file.blocks.slice(0, -1).some((block) => shows(block, 'any')));
}

/** The row (`lineAnchorKey`) a move to a place lands on: the last row showing it, in the latest block that does. */
export function placeRow(file: DiffFile, place: string): string | undefined {
  const anchorOf = fileLineAnchor(file.path);
  for (let blockIndex = file.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = file.blocks[blockIndex]!;
    for (let index = block.lines.length - 1; index >= 0; index -= 1) {
      const line = block.lines[index]!;
      if (line.expansion !== 'hidden' && linePlace(anchorOf, line) === place) return lineAnchorKey(file.id, block.id, line, index);
    }
  }
  return undefined;
}

/** A path as the diff writes it, whichever separators and leading "./" it came with. */
export function normalizeReviewPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * What `lookup` finds for a path the agent or a person wrote: by the path, else
 * by it read as a diff header names it ("b/src/a.ts"), so a real directory
 * named a or b wins over that reading.
 */
export function byReviewPath<T>(path: string, lookup: (path: string) => T | undefined): T | undefined {
  const normalized = normalizeReviewPath(path);
  return lookup(normalized) ?? lookup(normalized.replace(/^[ab]\//u, ''));
}

/**
 * Anchors each finding to the diff the user is reading. A finding attaches
 * after the last displayed line of its range on the new side, preferring the
 * latest block (unstaged over staged over committed), because that is the code
 * the review read. In a diff from the reviewed code to the worktree now, the
 * reviewed code is the old side, so `side: 'REVIEWED'` finds the range there,
 * on unchanged and removed lines alike. A line outside the diff falls back to
 * the file's top, as every finding does while the lines shown are not the code
 * the review read (`onLines` off), such as a commit's.
 */
export function anchorReviewFindings(
  files: readonly DiffFile[],
  findings: readonly ReviewFindingView[],
  side: 'NEW' | 'REVIEWED' = 'NEW',
  onLines = true
): AnchoredFindings {
  const byLine = new Map<string, ReviewFindingView[]>();
  const byFile = new Map<string, ReviewFindingView[]>();
  const general: ReviewFindingView[] = [];
  const filesByPath = new Map(files.map((file) => [normalizeReviewPath(file.path), file]));
  const push = <K>(map: Map<K, ReviewFindingView[]>, key: K, finding: ReviewFindingView) => {
    const current = map.get(key);
    if (current) current.push(finding);
    else map.set(key, [finding]);
  };

  for (const finding of findings) {
    const file = finding.path ? byReviewPath(finding.path, (path) => filesByPath.get(path)) : undefined;
    if (!file) {
      general.push(finding);
      continue;
    }
    const anchor = onLines && finding.line ? findRowAnchor(file, side, finding.line, finding.endLine) : undefined;
    if (anchor) push(byLine, anchor, finding);
    else push(byFile, file.id, finding);
  }
  return { byLine, byFile, general };
}

/** Where each of the person's comments sits: under its last line, or under its file's header. */
export interface AnchoredComments {
  byLine: Map<string, ReviewComment[]>;
  byFile: Map<string, ReviewComment[]>;
}

/**
 * Anchors comments the same way as findings, on the side each was written on: a
 * removed line is found on the old side. A comment whose lines the diff no longer
 * shows, or one on the whole file, sits under the file's header, as every one
 * does while the lines shown are not the code it was written on (`onLines`
 * off). Each comment anchors once, so a file shown in several blocks never
 * repeats it.
 */
export function anchorReviewComments(
  files: readonly DiffFile[],
  comments: readonly ReviewComment[],
  /** The side a comment's numbers are on: its own, or the code a review read (`REVIEWED`), as `anchorReviewFindings` takes it. */
  sideOf: (comment: ReviewComment) => ReviewComment['side'] | 'REVIEWED' = (comment) => comment.side,
  onLines = true
): AnchoredComments {
  const byLine = new Map<string, ReviewComment[]>();
  const byFile = new Map<string, ReviewComment[]>();
  const filesByPath = new Map(files.map((file) => [normalizeReviewPath(file.path), file]));
  for (const comment of comments) {
    const file = filesByPath.get(normalizeReviewPath(comment.path));
    if (!file) continue;
    const anchor = onLines && comment.line ? findRowAnchor(file, sideOf(comment), comment.line, comment.endLine) : undefined;
    const map = anchor ? byLine : byFile;
    const key = anchor ?? file.id;
    map.set(key, [...(map.get(key) ?? []), comment]);
  }
  return { byLine, byFile };
}

/** Where each pull request discussion sits: under its last line, at its file's top, or above the files. */
export interface AnchoredDiscussions<T> {
  byLine: Map<string, T[]>;
  byFile: Map<string, T[]>;
  general: T[];
}

/**
 * Anchors pull request discussions like comments. A discussion's lines are the
 * pull request's, so it sits on them only while the diff shown is the head the
 * platform reported (`onLines`); otherwise, or once its code has changed since it
 * was written, it sits at its file's top. One about the whole change, or about a
 * file the diff does not hold, sits above the files.
 */
export function anchorReviewDiscussions<T extends { path?: string; side?: 'NEW' | 'OLD'; line?: number; endLine?: number; outdated: boolean }>(
  files: readonly DiffFile[],
  discussions: readonly T[],
  onLines: boolean
): AnchoredDiscussions<T> {
  const byLine = new Map<string, T[]>();
  const byFile = new Map<string, T[]>();
  const general: T[] = [];
  const filesByPath = new Map(files.map((file) => [normalizeReviewPath(file.path), file]));
  for (const discussion of discussions) {
    const file = discussion.path ? filesByPath.get(normalizeReviewPath(discussion.path)) : undefined;
    if (!file) {
      general.push(discussion);
      continue;
    }
    // A platform's old side is the base file, unchanged lines included, not only removed ones.
    const anchor = onLines && !discussion.outdated && discussion.line && discussion.side
      ? findRowAnchor(file, discussion.side === 'OLD' ? 'REVIEWED' : 'NEW', discussion.line, discussion.endLine)
      : undefined;
    const map = anchor ? byLine : byFile;
    const key = anchor ?? file.id;
    map.set(key, [...(map.get(key) ?? []), discussion]);
  }
  return { byLine, byFile, general };
}

/** The code of lines start to end on one side of a file, when the diff holds every one of them. */
export function sideLines(file: DiffFile, side: 'NEW' | 'OLD', start: number, end: number): string[] | undefined {
  if (start < 1 || end < start) return undefined;
  const byNumber = new Map<number, string>();
  for (const block of file.blocks) {
    for (const line of block.lines) {
      const number = side === 'NEW' ? (line.kind === 'deletion' ? undefined : line.newLine) : (line.kind === 'addition' ? undefined : line.oldLine);
      if (number !== undefined && number >= start && number <= end) byNumber.set(number, diffLineCode(line));
    }
  }
  const lines: string[] = [];
  for (let number = start; number <= end; number += 1) {
    const content = byNumber.get(number);
    if (content === undefined) return undefined;
    lines.push(content);
  }
  return lines;
}

/**
 * The last displayed row of a line range on one side, preferring the latest
 * block. Hidden unchanged lines are not displayed. A comment's old side is its
 * removed lines; the reviewed side is every line the old code had.
 */
function findRowAnchor(file: DiffFile, side: ReviewComment['side'] | 'REVIEWED', line: number, endLine?: number): string | undefined {
  const last = endLine && endLine >= line ? endLine : line;
  for (let blockIndex = file.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = file.blocks[blockIndex]!;
    let anchor: number | undefined;
    block.lines.forEach((candidate, index) => {
      if (candidate.expansion === 'hidden') return;
      const number = side === 'REVIEWED'
        ? (candidate.kind === 'addition' ? undefined : candidate.oldLine)
        : side === 'OLD' ? (candidate.kind === 'deletion' ? candidate.oldLine : undefined) : candidate.newLine;
      if (number !== undefined && number >= line && number <= last) anchor = index;
    });
    if (anchor !== undefined) return lineAnchorKey(file.id, block.id, block.lines[anchor]!, anchor);
  }
  return undefined;
}

/**
 * What is anchored anywhere in each file: at its top, then under its lines in
 * line order. Only a file a line key names is read line by line, so a change of
 * thousands of lines costs the lines of the files something sits on.
 */
export function anchoredByFile<T>(files: readonly DiffFile[], anchored: { byLine: ReadonlyMap<string, T[]>; byFile: ReadonlyMap<string, T[]> }): Map<string, T[]> {
  const lined = lineKeyedFiles(anchored.byLine);
  return new Map(files.map((file) => {
    const items = [...(anchored.byFile.get(file.id) ?? [])];
    if (lined.has(file.id)) {
      for (const block of file.blocks) {
        block.lines.forEach((line, index) => {
          items.push(...(anchored.byLine.get(lineAnchorKey(file.id, block.id, line, index)) ?? []));
        });
      }
    }
    return [file.id, items];
  }));
}

/**
 * The review's one gutter, in px: wide enough for the largest line number it shows and
 * the comment "+" beside it, so code starts on one column in every file. While the
 * checkout can fill files (`fillable`), their unchanged lines can run to a file's end,
 * known only once read, so the gutter holds four digits from the start: neither their
 * arrival nor revealing them widens it.
 */
export function reviewGutterWidth(files: readonly DiffFile[], fillable: boolean): number {
  let largest = fillable ? 9999 : 0;
  for (const file of files) {
    for (const block of file.blocks) {
      for (const line of block.lines) largest = Math.max(largest, line.newLine ?? 0, line.oldLine ?? 0);
    }
  }
  return Math.max(44, 32 + String(largest).length * 7);
}

/** A stable signature of a file's captured change, so "viewed" resets when the file changes and never when context is revealed. */
export function diffFileSignature(file: DiffFile): string {
  let hash = 2166136261;
  for (const block of file.blocks) {
    for (const line of block.lines) {
      if (line.expansion) continue;
      const text = `${line.kind}:${line.content}\n`;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
  }
  return `${file.additions}.${file.deletions}.${(hash >>> 0).toString(36)}`;
}

/**
 * Files whose change differs between the reviewed capture and the current one:
 * what a re-review must read. A file that appeared or disappeared counts.
 */
export function filesChangedSinceReview(reviewed: readonly DiffFile[], current: readonly DiffFile[]): Set<string> {
  const reviewedSignatures = new Map(reviewed.map((file) => [normalizeReviewPath(file.path), diffFileSignature(file)]));
  const changed = new Set<string>();
  for (const file of current) {
    const path = normalizeReviewPath(file.path);
    if (reviewedSignatures.get(path) !== diffFileSignature(file)) changed.add(path);
    reviewedSignatures.delete(path);
  }
  for (const path of reviewedSignatures.keys()) changed.add(path);
  return changed;
}

/**
 * The rows of one diff block as the Review tab draws them. A hunk header
 * becomes a quiet gap row that says how many unchanged lines it skips and keeps
 * the enclosing symbol Git reports; changed and context lines keep their index
 * so findings and comments can anchor to them.
 *
 * In a block filled from the checkout (`reviewContext.ts`), each run of hidden
 * unchanged lines is the gap row instead, carrying which lines it holds so it
 * can reveal them; revealed lines are context rows, and a gap revealed in full
 * leaves no row.
 */
export type ReviewDiffRow =
  | { kind: 'gap'; hidden: number; heading?: string; raw: string; reveal?: GapReveal }
  | { kind: 'line'; line: DiffLine; index: number };

/**
 * The hidden lines a gap row holds, by new-side number. A gap at the start of the
 * file opens only up from the change below it, one at the end only down from the
 * change above it.
 */
export interface GapReveal { from: number; to: number; edge: 'start' | 'middle' | 'end' }

/** Rows are built once per version of a block's lines, which are never changed in place. */
const rowsByLines = new WeakMap<readonly DiffLine[], readonly ReviewDiffRow[]>();

export function buildReviewDiffRows(lines: readonly DiffLine[]): readonly ReviewDiffRow[] {
  let rows = rowsByLines.get(lines);
  if (!rows) {
    rows = diffRows(lines);
    rowsByLines.set(lines, rows);
  }
  return rows;
}

/**
 * Where the rows from line `start` to line `end` (by `diffLineId`) sit among a block's
 * rows, gaps between them included: a run a caller shows on its own, such as a key
 * change first. Undefined when either line is not a row.
 */
export function reviewRowRange(rows: readonly ReviewDiffRow[], start: string, end: string): { from: number; to: number } | undefined {
  let positions = rowPositions.get(rows);
  if (!positions) {
    positions = new Map(rows.flatMap((row, position): Array<[string, number]> => (row.kind === 'line' ? [[diffLineId(row.line, row.index), position]] : [])));
    rowPositions.set(rows, positions);
  }
  const from = positions.get(start);
  const to = positions.get(end);
  return from === undefined || to === undefined || to < from ? undefined : { from, to };
}

/** Each line row's place among a block's rows, by `diffLineId`, read once per set of rows. */
const rowPositions = new WeakMap<readonly ReviewDiffRow[], ReadonlyMap<string, number>>();

function diffRows(lines: readonly DiffLine[]): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = [];
  const filled = lines.some((line) => line.expansion);
  let lastNewLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.kind === 'meta') continue;
    if (line.expansion === 'hidden') {
      let end = index;
      while (lines[end + 1]?.expansion === 'hidden') end += 1;
      // The hunk the run leads into, past lines already revealed above it.
      let next = end + 1;
      while (lines[next]?.expansion === 'shown') next += 1;
      const header = lines[next]?.kind === 'hunk' ? lines[next]! : undefined;
      const parsed = header ? parseHunkHeader(header.content) : undefined;
      const from = line.newLine ?? 0;
      rows.push({
        kind: 'gap',
        hidden: end - index + 1,
        heading: parsed?.heading,
        raw: header?.content ?? '',
        reveal: { from, to: lines[end]!.newLine ?? from, edge: from === 1 ? 'start' : header ? 'middle' : 'end' }
      });
      index = end;
      continue;
    }
    if (line.kind === 'hunk') {
      if (filled) continue;
      const parsed = parseHunkHeader(line.content);
      const hidden = parsed ? Math.max(0, parsed.newStart - lastNewLine - 1) : 0;
      rows.push({ kind: 'gap', hidden, heading: parsed?.heading, raw: line.content });
      continue;
    }
    if (line.newLine !== undefined) lastNewLine = line.newLine;
    rows.push({ kind: 'line', line, index });
  }
  return rows;
}
