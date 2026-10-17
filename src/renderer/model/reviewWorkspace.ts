import type { EffectiveReviewFinding } from '../../shared/agentReviewFindings';
import type { ReviewComment } from '../../shared/reviewDraft';
import { parseHunkHeader, type DiffFile, type DiffLine } from './diffEvidence';

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

/** A line's identity within its block: its side and number, else its position. */
export function diffLineId(line: Pick<DiffLine, 'kind' | 'oldLine' | 'newLine'>, index: number): string {
  return line.kind === 'deletion' && line.oldLine !== undefined ? `o${line.oldLine}`
    : line.newLine !== undefined ? `n${line.newLine}` : `i${index}`;
}

export function normalizeReviewPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[ab]\//, '');
}

/**
 * Anchors each finding to the diff the user is reading. A finding attaches
 * after the last displayed line of its range on the new side, preferring the
 * latest block (unstaged over staged over committed), because that is the code
 * the review read. In a diff from the reviewed code to the worktree now, the
 * reviewed code is the old side, so `side: 'REVIEWED'` finds the range there,
 * on unchanged and removed lines alike. A line outside the diff falls back to
 * the file's top.
 */
export function anchorReviewFindings(
  files: readonly DiffFile[],
  findings: readonly ReviewFindingView[],
  side: 'NEW' | 'REVIEWED' = 'NEW'
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
    const file = finding.path ? filesByPath.get(normalizeReviewPath(finding.path)) : undefined;
    if (!file) {
      general.push(finding);
      continue;
    }
    const anchor = finding.line ? findRowAnchor(file, side, finding.line, finding.endLine) : undefined;
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
 * shows, or one on the whole file, sits under the file's header. Each comment
 * anchors once, so a file shown in several blocks never repeats it.
 */
export function anchorReviewComments(files: readonly DiffFile[], comments: readonly ReviewComment[]): AnchoredComments {
  const byLine = new Map<string, ReviewComment[]>();
  const byFile = new Map<string, ReviewComment[]>();
  const filesByPath = new Map(files.map((file) => [normalizeReviewPath(file.path), file]));
  for (const comment of comments) {
    const file = filesByPath.get(normalizeReviewPath(comment.path));
    if (!file) continue;
    const anchor = comment.line ? findRowAnchor(file, comment.side, comment.line, comment.endLine) : undefined;
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

export interface ReviewIndexFile {
  file: DiffFile;
  findings: ReviewFindingView[];
}

/** The rail: files in diff order, each with the findings anchored anywhere in it. */
export function buildReviewIndex(files: readonly DiffFile[], anchored: AnchoredFindings): ReviewIndexFile[] {
  return files.map((file) => {
    const findings = [...(anchored.byFile.get(file.id) ?? [])];
    for (const block of file.blocks) {
      block.lines.forEach((line, index) => {
        findings.push(...(anchored.byLine.get(lineAnchorKey(file.id, block.id, line, index)) ?? []));
      });
    }
    return { file, findings };
  });
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


export function buildReviewDiffRows(lines: readonly DiffLine[]): ReviewDiffRow[] {
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
