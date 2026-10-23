import {
  REVIEW_WALKTHROUGH_SCHEMA,
  type ReviewWalkthrough,
  type ReviewWalkthroughAttention,
  type ReviewWalkthroughExcerpt,
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
  | { status: 'VALID'; walkthrough: ReviewWalkthrough }
  | { status: 'UNAVAILABLE'; reason: 'NOT_WRITTEN' | 'NO_SECTIONS' };

/** The prompt's counts, held: its own sections, each one's excerpts and terms, and the attention pointers. */
const SECTION_LIMIT = 9;
const EXCERPT_LIMIT = 3;
const TERM_LIMIT = 3;
const ATTENTION_LIMIT = 3;
/** Words past these lengths are cut; a term, an exact phrase, past its own is left out. */
const SUMMARY_LIMIT = 800;
const TITLE_LIMIT = 120;
const EXPLANATION_LIMIT = 600;
const CAPTION_LIMIT = 120;
const ATTENTION_TEXT_LIMIT = 300;
const TERM_TEXT_LIMIT = 120;

/**
 * Checks the walkthrough a review wrote against the change it read and the
 * findings it wrote with it, keeping what holds:
 * - a file sits in the first section that claims it, and a path the change
 *   does not hold is left out;
 * - a section keeps its title, its explanation and at least one file, or is
 *   left out, its files with it;
 * - an excerpt or a term lies inside one hunk of a file of its own section, on
 *   the base side only for a deleted file, and an excerpt is kept once;
 * - a term is an exact phrase of its explanation, never part of a code span;
 * - an attention pointer names a section that holds, and the finding or the
 *   file it names is the review's own, of that section;
 * - files no section claims join a last Other changes section;
 * - the counts the prompt asks for are held and long words are cut.
 * Without a section that holds, nothing is kept.
 */
export function checkReviewWalkthrough(value: unknown, change: ReviewedChange, findingIds: ReadonlySet<string>): ReviewWalkthroughCheck {
  if (value === undefined || value === null) return { status: 'UNAVAILABLE', reason: 'NOT_WRITTEN' };
  if (!isRecord(value) || !Array.isArray(value.sections)) return { status: 'UNAVAILABLE', reason: 'NO_SECTIONS' };
  const files = new Map(change.files.map((file) => [file.path, file]));
  const claimed = new Set<string>();
  // The agent numbers its sections from 1; a kept section's index in the walkthrough.
  const kept = new Map<number, number>();
  const sections: ReviewWalkthroughSection[] = [];
  value.sections.forEach((entry: unknown, position) => {
    const section = sections.length < SECTION_LIMIT ? checkSection(entry, files, claimed) : undefined;
    if (!section) return;
    kept.set(position + 1, sections.length);
    sections.push(section);
  });
  if (sections.length === 0) return { status: 'UNAVAILABLE', reason: 'NO_SECTIONS' };

  const unclaimed = change.files.filter((file) => !claimed.has(file.path));
  if (unclaimed.length > 0) {
    sections.push({ title: 'Other changes', explanation: '', files: unclaimed.map((file) => file.path), excerpts: [], terms: [] });
  }
  const attention: ReviewWalkthroughAttention[] = [];
  for (const entry of list(value.attention)) {
    const text = isRecord(entry) ? bounded(entry.text, ATTENTION_TEXT_LIMIT) : undefined;
    const section = isRecord(entry) && typeof entry.section === 'number' ? kept.get(entry.section) : undefined;
    if (!isRecord(entry) || !text || section === undefined || attention.length >= ATTENTION_LIMIT) continue;
    // What it names beyond its section must be the review's own: a finding it wrote, a file of the section.
    const finding = trimmed(entry.finding);
    const path = filePath(entry.path);
    const named = {
      ...(finding && findingIds.has(finding) ? { finding } : {}),
      ...(path && sections[section]!.files.includes(path) ? { path } : {})
    };
    attention.push({ text, section, ...named });
  }
  return {
    status: 'VALID',
    walkthrough: {
      schema: REVIEW_WALKTHROUGH_SCHEMA,
      reviewRunId: change.reviewRunId,
      base: change.base,
      tree: change.tree,
      summary: bounded(value.summary, SUMMARY_LIMIT) ?? '',
      attention,
      sections
    }
  };
}

/** A section that holds, with what holds of its parts; nothing when the section itself fails. */
function checkSection(
  value: unknown,
  change: ReadonlyMap<string, ReviewedDiffFile>,
  claimed: Set<string>
): ReviewWalkthroughSection | undefined {
  if (!isRecord(value)) return undefined;
  const title = bounded(value.title, TITLE_LIMIT);
  if (!title || typeof value.explanation !== 'string') return undefined;
  const explanation = bounded(value.explanation, EXPLANATION_LIMIT) ?? '';
  const own = new Map<string, ReviewedDiffFile>();
  for (const entry of list(value.files)) {
    // A file is named by its path, or by an object that carries it.
    const path = filePath(isRecord(entry) ? entry.path : entry);
    const file = path ? change.get(path) : undefined;
    if (!file || claimed.has(file.path) || own.has(file.path)) continue;
    own.set(file.path, file);
  }
  if (own.size === 0) return undefined;
  for (const path of own.keys()) claimed.add(path);

  const excerpts: ReviewWalkthroughExcerpt[] = [];
  for (const entry of list(value.excerpts)) {
    const lines = checkLines(entry, own);
    if (!lines || excerpts.length >= EXCERPT_LIMIT || excerpts.some((excerpt) => sameLines(excerpt, lines))) continue;
    const caption = isRecord(entry) ? bounded(entry.caption, CAPTION_LIMIT) : undefined;
    excerpts.push({ ...lines, ...(caption ? { caption } : {}) });
  }
  const terms: ReviewWalkthroughTerm[] = [];
  for (const entry of list(value.terms)) {
    const text = isRecord(entry) ? trimmed(entry.text) : undefined;
    const lines = checkLines(entry, own);
    if (!text || !lines || text.length > TERM_TEXT_LIMIT || terms.length >= TERM_LIMIT ||
      terms.some((term) => term.text === text) || !isPhraseOf(text, explanation)) continue;
    terms.push({ text, ...lines });
  }
  return { title, explanation, files: [...own.keys()], excerpts, terms };
}

/**
 * Lines of a file of the section, inside one hunk of the change: at the head,
 * or at the base for a deleted file, whose lines exist only there.
 */
function checkLines(value: unknown, files: ReadonlyMap<string, ReviewedDiffFile>): ReviewWalkthroughLines | undefined {
  if (!isRecord(value)) return undefined;
  const path = filePath(value.path);
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

function sameLines(left: ReviewWalkthroughLines, right: ReviewWalkthroughLines): boolean {
  return left.path === right.path && left.side === right.side && left.line === right.line && left.endLine === right.endLine;
}

/** An exact phrase of the explanation, made of plain words or whole code spans. */
function isPhraseOf(text: string, explanation: string): boolean {
  const at = explanation.indexOf(text);
  return at >= 0 && backticks(text) % 2 === 0 && backticks(explanation.slice(0, at)) % 2 === 0;
}

function backticks(text: string): number {
  return text.split('`').length - 1;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A path as the agent wrote it; the change index quotes one that holds a space, and the agent may keep the quotes. */
function filePath(value: unknown): string | undefined {
  const path = trimmed(value);
  return path && /^".*"$/u.test(path) ? trimmed(path.slice(1, -1)) : path;
}

/** Trimmed words, cut at `limit` characters with an ellipsis. */
function bounded(value: unknown, limit: number): string | undefined {
  const text = trimmed(value);
  return text && text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
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
