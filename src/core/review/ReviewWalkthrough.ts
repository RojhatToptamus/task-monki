import {
  REVIEW_WALKTHROUGH_SCHEMA,
  type ReviewWalkthrough,
  type ReviewWalkthroughAttention,
  type ReviewWalkthroughExcerpt,
  type ReviewWalkthroughFile,
  type ReviewWalkthroughLines,
  type ReviewWalkthroughSection,
  type ReviewWalkthroughTerm
} from '../../shared/reviewWalkthrough';
import type { ReviewedDiffFile } from './ReviewedDiff';

/** The change a walkthrough must describe: its review, base and tree, and its files with their hunks. */
export interface ReviewedChange {
  reviewRunId: string;
  base: string;
  tree: string;
  files: readonly ReviewedDiffFile[];
}

export type ReviewWalkthroughCheck =
  | { status: 'VALID'; walkthrough: ReviewWalkthrough; droppedCount: number }
  | { status: 'UNAVAILABLE'; reason: 'NOT_WRITTEN' | 'NO_SECTIONS' };

/**
 * Checks the walkthrough a review wrote against the change it read, keeping
 * what holds:
 * - a file sits in the first section that claims it, and a path the change
 *   does not hold is left out;
 * - a section keeps its title, its explanation and at least one file, or is
 *   left out, its files with it;
 * - an excerpt or a term lies inside one hunk of a file of its own section, on
 *   the base side only for a deleted file;
 * - a term is an exact phrase of its explanation, never part of a code span;
 * - an attention pointer names a section that holds;
 * - files no section claims join a last Other changes section, and every file
 *   carries the change's own status and line counts.
 * Each part left out is counted. Word and count limits are the prompt's and
 * are not checked here. Without a section that holds, nothing is kept.
 */
export function checkReviewWalkthrough(value: unknown, change: ReviewedChange): ReviewWalkthroughCheck {
  if (value === undefined || value === null) return { status: 'UNAVAILABLE', reason: 'NOT_WRITTEN' };
  if (!isRecord(value) || !Array.isArray(value.sections)) return { status: 'UNAVAILABLE', reason: 'NO_SECTIONS' };
  const files = new Map(change.files.map((file) => [file.path, file]));
  const claimed = new Set<string>();
  // The agent numbers its sections from 1; a kept section's index in the walkthrough.
  const kept = new Map<number, number>();
  const sections: ReviewWalkthroughSection[] = [];
  let dropped = 0;
  value.sections.forEach((entry: unknown, position) => {
    const checked = checkSection(entry, files, claimed);
    if (!checked) {
      dropped += 1;
      return;
    }
    dropped += checked.dropped;
    kept.set(position + 1, sections.length);
    sections.push(checked.section);
  });
  if (sections.length === 0) return { status: 'UNAVAILABLE', reason: 'NO_SECTIONS' };

  const unclaimed = change.files.filter((file) => !claimed.has(file.path));
  if (unclaimed.length > 0) {
    sections.push({ title: 'Other changes', explanation: '', files: unclaimed.map(walkthroughFile), excerpts: [], terms: [] });
  }
  const attention = list(value.attention).flatMap((entry): ReviewWalkthroughAttention[] => {
    const text = isRecord(entry) ? trimmed(entry.text) : undefined;
    const section = isRecord(entry) && typeof entry.section === 'number' ? kept.get(entry.section) : undefined;
    if (!text || section === undefined) {
      dropped += 1;
      return [];
    }
    return [{ text, section }];
  });
  if (value.summary !== undefined && typeof value.summary !== 'string') dropped += 1;
  return {
    status: 'VALID',
    walkthrough: {
      schema: REVIEW_WALKTHROUGH_SCHEMA,
      reviewRunId: change.reviewRunId,
      base: change.base,
      tree: change.tree,
      summary: typeof value.summary === 'string' ? value.summary.trim() : '',
      attention,
      sections
    },
    droppedCount: dropped
  };
}

/** A section that holds, with the count of its parts left out; nothing when the section itself fails. */
function checkSection(
  value: unknown,
  change: ReadonlyMap<string, ReviewedDiffFile>,
  claimed: Set<string>
): { section: ReviewWalkthroughSection; dropped: number } | undefined {
  if (!isRecord(value)) return undefined;
  const title = trimmed(value.title);
  if (!title || typeof value.explanation !== 'string') return undefined;
  const explanation = value.explanation.trim();
  let dropped = 0;
  const own = new Map<string, ReviewedDiffFile>();
  for (const entry of list(value.files)) {
    // A file is named by its path, or by an object that carries it.
    const path = trimmed(isRecord(entry) ? entry.path : entry);
    const file = path ? change.get(path) : undefined;
    if (!file || claimed.has(file.path) || own.has(file.path)) {
      dropped += 1;
      continue;
    }
    own.set(file.path, file);
  }
  if (own.size === 0) return undefined;
  for (const path of own.keys()) claimed.add(path);

  const excerpts = list(value.excerpts).flatMap((entry): ReviewWalkthroughExcerpt[] => {
    const lines = checkLines(entry, own);
    if (!lines) {
      dropped += 1;
      return [];
    }
    const caption = isRecord(entry) ? trimmed(entry.caption) : undefined;
    return [{ ...lines, ...(caption ? { caption } : {}) }];
  });
  const phrases = new Set<string>();
  const terms = list(value.terms).flatMap((entry): ReviewWalkthroughTerm[] => {
    const text = isRecord(entry) ? trimmed(entry.text) : undefined;
    const lines = checkLines(entry, own);
    if (!text || !lines || phrases.has(text) || !isPhraseOf(text, explanation)) {
      dropped += 1;
      return [];
    }
    phrases.add(text);
    return [{ text, ...lines }];
  });
  return { section: { title, explanation, files: [...own.values()].map(walkthroughFile), excerpts, terms }, dropped };
}

/**
 * Lines of a file of the section, inside one hunk of the change: at the head,
 * or at the base for a deleted file, whose lines exist only there.
 */
function checkLines(value: unknown, files: ReadonlyMap<string, ReviewedDiffFile>): ReviewWalkthroughLines | undefined {
  if (!isRecord(value)) return undefined;
  const path = trimmed(value.path);
  const file = path ? files.get(path) : undefined;
  const side = value.side ?? 'head';
  if (!file || (side !== 'head' && side !== 'base') || (side === 'base') !== (file.status === 'deleted')) return undefined;
  const line = value.line;
  const endLine = value.endLine ?? line;
  if (!isLineNumber(line) || !isLineNumber(endLine) || endLine < line) return undefined;
  const inside = file.hunks.some((hunk) => {
    const [start, count] = side === 'base' ? [hunk.oldStart, hunk.oldCount] : [hunk.newStart, hunk.newCount];
    return count > 0 && start <= line && endLine <= start + count - 1;
  });
  if (!inside) return undefined;
  return { path: file.path, side: side === 'base' ? 'OLD' : 'NEW', line, ...(endLine > line ? { endLine } : {}) };
}

/** An exact phrase of the explanation, made of plain words or whole code spans. */
function isPhraseOf(text: string, explanation: string): boolean {
  const at = explanation.indexOf(text);
  return at >= 0 && backticks(text) % 2 === 0 && backticks(explanation.slice(0, at)) % 2 === 0;
}

function backticks(text: string): number {
  return text.split('`').length - 1;
}

function walkthroughFile(file: ReviewedDiffFile): ReviewWalkthroughFile {
  return {
    path: file.path,
    status: file.status,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    additions: file.additions,
    deletions: file.deletions
  };
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
