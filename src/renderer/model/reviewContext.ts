import type { DiffBlock, DiffFile, DiffLine } from './diffEvidence';
import { reviewFileRole } from './reviewOrder';
import type { GapReveal } from './reviewWorkspace';

/**
 * The unchanged lines around a captured change, read from the checkout.
 *
 * A captured diff holds only its hunks. When the checkout still holds the
 * version a block's new side shows, its other lines fill the block's gaps:
 * before the first hunk, between hunks and after the last. They are placed once,
 * hidden, so revealing some never moves the rows that findings, comments and a
 * line selection point at; revealing only marks them shown.
 */

/** Lines one step reveals, as GitHub and GitLab step. */
export const GAP_STEP = 20;

/** At most this many files of one capture are read for their unchanged lines. */
export const MAX_CONTEXT_FILES = 150;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: [0-7]+)?$/;

interface HunkRange { oldStart: number; oldCount: number; newStart: number; newCount: number }

/** A hunk header's ranges; with a zero count, Git names the line before the hunk, so the start moves past it. */
function hunkRange(content: string): HunkRange | undefined {
  const match = HUNK_HEADER.exec(content);
  if (!match) return undefined;
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  return {
    oldStart: Number(match[1]) + (oldCount === 0 ? 1 : 0),
    oldCount,
    newStart: Number(match[3]) + (newCount === 0 ? 1 : 0),
    newCount
  };
}

/** A file's lines as Git counts them: a final newline ends the last line rather than starting another. */
export function splitCheckoutLines(text: string): string[] {
  // The capture is read with CRLF folded to LF, so the file is compared the same way.
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** A diff line's text without its "+", "-" or " " prefix. */
function lineText(line: DiffLine): string {
  return line.content.length > 0 ? line.content.slice(1) : '';
}

/** The new side's blob Git recorded for the block ("index <old>..<new>"), when it recorded one. */
function recordedNewBlob(block: DiffBlock): string | undefined {
  for (const line of block.lines) {
    if (line.kind === 'hunk') return undefined;
    const match = line.kind === 'meta' ? INDEX_LINE.exec(line.content) : null;
    if (match) return match[2];
  }
  return undefined;
}

/**
 * Whether the checkout's file is the block's new side, so its lines can fill the
 * block's gaps. The blob Git recorded for that side, when it recorded one, must be
 * the file's (so a file changed since the capture, or an earlier Git layer of a
 * file with later changes, never qualifies), and every new-side line of every
 * hunk must read the same in the file. A deleted file, a binary change and a
 * block without hunks never qualify.
 */
export function checkoutMatchesBlock(block: DiffBlock, lines: readonly string[], blobSha1: string): boolean {
  const blob = recordedNewBlob(block);
  if (blob !== undefined && (/^0+$/.test(blob) || !blobSha1.startsWith(blob))) return false;
  let hunks = 0;
  for (const line of block.lines) {
    if (line.kind === 'hunk') hunks += 1;
    else if (line.kind === 'meta' && line.content === '+++ /dev/null') return false;
    else if ((line.kind === 'context' || line.kind === 'addition') && line.newLine !== undefined && lines[line.newLine - 1] !== lineText(line)) return false;
  }
  return hunks > 0;
}

/**
 * The block with the file's other lines placed, hidden, in its gaps. Each run sits
 * before the hunk header that follows it, so the hunk's own lines keep their
 * order. A run's old-side numbers follow from the offset between the two sides,
 * which unchanged lines keep: the offset entering the next hunk, or after the last
 * hunk for the lines that follow it.
 */
export function fillBlockGaps(block: DiffBlock, lines: readonly string[]): DiffBlock {
  const filled: DiffLine[] = [];
  let next = 1;
  const fill = (until: number, offset: number) => {
    for (let newLine = next; newLine < until && newLine <= lines.length; newLine += 1) {
      filled.push({ kind: 'context', newLine, oldLine: newLine + offset, content: ` ${lines[newLine - 1]}`, expansion: 'hidden' });
    }
    next = Math.max(next, until);
  };
  let trailingOffset = 0;
  for (const line of block.lines) {
    const range = line.kind === 'hunk' ? hunkRange(line.content) : undefined;
    if (range) {
      fill(range.newStart, range.oldStart - range.newStart);
      next = range.newStart + range.newCount;
      trailingOffset = range.oldStart + range.oldCount - (range.newStart + range.newCount);
    }
    filled.push(line);
  }
  fill(lines.length + 1, trailingOffset);
  return { ...block, lines: filled };
}

/** The block with the given new-side lines shown; the rest stay as they are. */
export function revealLines(block: DiffBlock, revealed: ReadonlySet<number> | undefined): DiffBlock {
  if (!revealed?.size) return block;
  return {
    ...block,
    lines: block.lines.map((line) => (line.expansion === 'hidden' && line.newLine !== undefined && revealed.has(line.newLine)
      ? { ...line, expansion: 'shown' as const }
      : line))
  };
}

/**
 * The lines each step of a gap reveals. Up opens the lines just above the change
 * below the gap, down the lines just below the change above it. A gap of one step
 * or less opens only whole, and the file's first and last gaps open one way.
 */
export function gapSteps({ from, to, edge }: GapReveal): { up?: [number, number]; down?: [number, number] } {
  if (to - from + 1 <= GAP_STEP) return {};
  return {
    ...(edge !== 'end' ? { up: [to - GAP_STEP + 1, to] as [number, number] } : {}),
    ...(edge !== 'start' ? { down: [from, from + GAP_STEP - 1] as [number, number] } : {})
  };
}

/** Every filled line of the block, by new-side number: what "Show whole file" reveals. */
export function fillableLines(block: DiffBlock): number[] {
  return block.lines.flatMap((line) => (line.expansion && line.newLine !== undefined ? [line.newLine] : []));
}

/**
 * Files worth reading for their unchanged lines: a change with hunks to a file
 * that still exists, in reading order, never a generated file (it opens
 * collapsed and its context tells a reviewer nothing), and at most
 * MAX_CONTEXT_FILES of them.
 */
export function contextCandidates(files: readonly DiffFile[]): string[] {
  return files
    .filter((file) => file.status !== 'added' && file.status !== 'deleted' && reviewFileRole(file.path) !== 'generated' &&
      file.blocks.some((block) => block.lines.some((line) => line.kind === 'hunk')))
    .slice(0, MAX_CONTEXT_FILES)
    .map((file) => file.path);
}

/** The checkout's answer for one file: its text, or why there is none. */
export type CheckoutRead =
  | { status: 'TEXT'; text: string; blobSha1: string }
  | { status: 'MISSING' | 'NOT_FILE' | 'BINARY' | 'TOO_LARGE' | 'FAILED' };

/** A file with its gaps filled where the checkout matches, and what reading it whole can offer. */
export interface FilledFile {
  file: DiffFile;
  /**
   * `lines` when some block was filled with unchanged lines; `differs` when the
   * checkout no longer holds any block's version; `too-large` when the file is
   * too large to read; `none` otherwise (no read yet, no text, nothing hidden).
   */
  offer: 'lines' | 'differs' | 'too-large' | 'none';
}

export function fillFileGaps(file: DiffFile, read: CheckoutRead | undefined): FilledFile {
  if (!read || read.status !== 'TEXT') {
    return { file, offer: read?.status === 'TOO_LARGE' ? 'too-large' : read?.status === 'MISSING' ? 'differs' : 'none' };
  }
  const lines = splitCheckoutLines(read.text);
  let matched = false;
  const blocks = file.blocks.map((block) => {
    if (!checkoutMatchesBlock(block, lines, read.blobSha1)) return block;
    matched = true;
    return fillBlockGaps(block, lines);
  });
  if (!matched) return { file, offer: 'differs' };
  return {
    file: { ...file, blocks },
    offer: blocks.some((block) => block.lines.some((line) => line.expansion)) ? 'lines' : 'none'
  };
}

/** What the file's menu offers for reading it whole. */
export type WholeFileState =
  | { kind: 'none' }
  /** Offered, but not possible, for this reason. */
  | { kind: 'unavailable'; reason: string }
  /** Some unchanged lines are hidden. */
  | { kind: 'partial' }
  /** Every line is shown, some because the person revealed them. */
  | { kind: 'whole' };

/** Reading a filled and revealed file whole, given its offer; reasons in the fewest words. */
export function wholeFileState(file: DiffFile, offer: FilledFile['offer']): WholeFileState {
  switch (offer) {
    case 'too-large': return { kind: 'unavailable', reason: 'Too large to show' };
    case 'differs': return { kind: 'unavailable', reason: 'Differs from the checkout' };
    case 'none': return { kind: 'none' };
    case 'lines': return file.blocks.some((block) => block.lines.some((line) => line.expansion === 'hidden'))
      ? { kind: 'partial' }
      : { kind: 'whole' };
  }
}
