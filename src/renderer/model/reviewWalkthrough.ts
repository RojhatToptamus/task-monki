import type { AgentReviewFindingSeverity } from '../../shared/agentReviewFindings';
import type { ReviewChangesResult } from '../../shared/reviewRounds';
import type { ReviewWalkthrough, ReviewWalkthroughExcerpt, ReviewWalkthroughLines, ReviewWalkthroughUnavailableReason } from '../../shared/reviewWalkthrough';
import { diffLineCode, type DiffBlock, type DiffFile, type DiffLine } from './diffEvidence';
import { pluralize } from './formatting';
import {
  buildReviewDiffRows,
  diffLineId,
  lineAnchor,
  lineAnchorKey,
  normalizeReviewPath,
  type AnchoredComments,
  type AnchoredDiscussions,
  type AnchoredFindings,
  type ReviewDiffRow
} from './reviewWorkspace';

/**
 * The Guide: the walkthrough the review wrote, read as stages, one per intent,
 * over the code it describes (the diff from the review's base to the code it
 * read). A stage shows the files that hold its key change or open feedback, and
 * keeps the rest of its files behind "N more files". A shown file leads with
 * its key changes under their captions, then the lines open feedback is about,
 * and keeps everything else behind one row. Terms and attention lines point at
 * places the Guide opens and travels to. Where feedback sits comes from its
 * position in the files, never from the agent.
 */

/** Plain words or a code span of the walkthrough's prose. */
export interface GuideInline { kind: 'text' | 'code'; text: string }

/** A stretch of an explanation: words, or a term tied to the lines that implement it. */
export type GuideSpan =
  | { kind: 'text'; inlines: GuideInline[] }
  | { kind: 'term'; id: string; inlines: GuideInline[]; target: GuideTarget };

/** Lines of a file the Guide opens and travels to. */
export interface GuideTarget {
  fileId: string;
  /** The lines in order, by `lineAnchor`. */
  anchors: string[];
  /** Where they are, in words: "RemoteWorkService.ts, lines 188–192". */
  label: string;
}

/** A run of one block's rows shown on its own, by line identity (`diffLineId`). */
export interface GuideRun {
  blockId: string;
  start: string;
  end: string;
  /** A key change: the walkthrough's caption and the symbol it sits in. Otherwise where in the file the run is. */
  label: { kind: 'key'; caption?: string; symbol?: string } | { kind: 'place'; lines: string; heading?: string };
}

export interface GuideFile {
  file: DiffFile;
  /** Its stage's code shows it: it holds a key change or open feedback. Otherwise it is among "N more files". */
  shown: boolean;
  /** The key changes in the walkthrough's order, then the lines open feedback is about, in file order. */
  runs: GuideRun[];
  /** Everything else that changed, in file order: what `more` opens. */
  rest: GuideRun[];
  /** The row that opens `rest`: "3 more changes", or "211 more lines" for a new or deleted file. */
  more?: string;
  /** The lines `rest` holds, by `lineAnchor`: a place among them opens `rest` first. */
  restAnchors: ReadonlySet<string>;
}

export interface GuideAttention {
  /** The agent's fact, without the words the finding's own severity word stands for. */
  text: GuideInline[];
  /** Its section. */
  stage: number;
  /** Where it lands beyond its stage: the open finding it names, with the finding's file and line, or a file it names. */
  target?:
    | { kind: 'finding'; findingId: string; severity: AgentReviewFindingSeverity; fileId: string; place: string }
    | { kind: 'file'; fileId: string };
}

export interface GuideStage {
  /** Its section's index in the walkthrough. */
  section: number;
  title: string;
  /** Empty for Other changes. */
  explanation: GuideSpan[];
  /** The explanation's first sentence, for the map. */
  lead: GuideInline[];
  attention: GuideAttention[];
  /** The section's files, in the walkthrough's order. */
  files: GuideFile[];
  /** Ids of the files its code shows, in order. */
  shown: string[];
  /** Ids of the files among "N more files", in order. */
  folded: string[];
}

export interface GuideModel {
  reviewRunId: string;
  summary: GuideInline[];
  /** At most three, in the walkthrough's order. */
  attention: GuideAttention[];
  stages: GuideStage[];
  /** Every file by id, with its stage. */
  files: ReadonlyMap<string, { stage: number; file: GuideFile }>;
}

/** What has a place in the Guide's files: `anchorReview*` over them. */
export interface GuideAnchors {
  findings: AnchoredFindings;
  discussions: AnchoredDiscussions<{ id: string; open: boolean }>;
  comments: AnchoredComments;
}

/** Feedback no key change holds shows with the lines a reader needs to see what it is about. */
const FEEDBACK_ABOVE = 7;
const FEEDBACK_BELOW = 3;

export function buildGuide(walkthrough: ReviewWalkthrough, files: readonly DiffFile[], anchors: GuideAnchors): GuideModel {
  const byPath = new Map(files.map((file) => [normalizeReviewPath(file.path), file]));
  const fileOf = (path: string) => byPath.get(normalizeReviewPath(path));
  const index = new Map<string, { stage: number; file: GuideFile }>();
  const stages = walkthrough.sections.map((section, sectionIndex): GuideStage => {
    const sectionFiles = section.files.map((entry) => fileOf(entry.path)).filter((file): file is DiffFile => Boolean(file));
    const terms = section.terms.flatMap((term, termIndex) => {
      const file = fileOf(term.path);
      return file && sectionFiles.includes(file) ? [{ id: `${sectionIndex}:${termIndex}`, text: term.text, target: lineTarget(file, term) }] : [];
    });
    const guideFiles = sectionFiles.map((file) => {
      const guideFile = guideFileOf(
        file,
        section.excerpts.filter((excerpt) => fileOf(excerpt.path) === file),
        anchors,
        // Lines a term points at stay among what the file can open.
        new Set(terms.filter((term) => term.target.fileId === file.id).flatMap((term) => term.target.anchors))
      );
      index.set(file.id, { stage: sectionIndex, file: guideFile });
      return guideFile;
    });
    return {
      section: sectionIndex,
      title: section.title,
      explanation: explanationSpans(section.explanation, terms),
      lead: inlines(firstSentence(section.explanation)),
      attention: [],
      files: guideFiles,
      shown: guideFiles.filter((file) => file.shown).map((file) => file.file.id),
      folded: guideFiles.filter((file) => !file.shown).map((file) => file.file.id)
    };
  });
  const attention = walkthrough.attention.flatMap((fact) => {
    const stage = stages[fact.section];
    if (!stage) return [];
    const item = attentionItem(fact.text, stage, anchors);
    stage.attention.push(item);
    return [item];
  });
  return { reviewRunId: walkthrough.reviewRunId, summary: inlines(walkthrough.summary), attention, stages, files: index };
}

/** A stage's files viewed, of all its files: "4/29" in the map and the stage menu. */
export function stageProgress(stage: Pick<GuideStage, 'files'>, viewed: ReadonlySet<string>): { viewed: number; total: number } {
  return { viewed: stage.files.filter((file) => viewed.has(file.file.id)).length, total: stage.files.length };
}

/** The files J and K step through: each stage's shown files, then its other files while they are open. */
export function guideReadingOrder(guide: GuideModel, openGroups: ReadonlySet<number>): string[] {
  return guide.stages.flatMap((stage) => [...stage.shown, ...(openGroups.has(stage.section) ? stage.folded : [])]);
}

/**
 * What must open for a place in the Guide to show: its stage's other files when
 * the file is among them, or the file's other changes when the line is there.
 * Nothing for a file the walkthrough does not hold.
 */
export function guideReveal(guide: GuideModel, fileId: string, anchor?: string): { group?: number; more?: string } | undefined {
  const entry = guide.files.get(fileId);
  if (!entry) return undefined;
  if (!entry.file.shown) return { group: entry.stage };
  return anchor && entry.file.restAnchors.has(anchor) ? { more: fileId } : {};
}

/**
 * Why the Guide has no walkthrough to show, in a few words: the gate's reason,
 * the reason the code the review read cannot be read now, or a stored
 * walkthrough that no longer parses.
 */
export function walkthroughUnavailableWords(
  reason: ReviewWalkthroughUnavailableReason | Extract<ReviewChangesResult, { status: 'UNAVAILABLE' }>['reason'] | 'UNPARSED'
): string {
  switch (reason) {
    case 'NOT_WRITTEN': return 'The review wrote no walkthrough';
    case 'NO_SECTIONS': return 'No part of the walkthrough matched the change';
    case 'NOT_RECORDED': return 'The code the review read was not kept';
    case 'TOO_LARGE': return 'The change is too large for a walkthrough';
    case 'UNREADABLE': return 'The code the review read can no longer be read';
    case 'UNPARSED': return 'The walkthrough could not be read';
  }
}

/** The change's files by folder, folders and files in path order: the Guide's account of a change before a walkthrough. */
export function filesByFolder(files: readonly DiffFile[]): Array<{ folder: string; fileIds: string[] }> {
  const folders = new Map<string, string[]>();
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    const ids = folders.get(folder);
    if (ids) ids.push(file.id);
    else folders.set(folder, [file.id]);
  }
  return [...folders].sort(([left], [right]) => left.localeCompare(right)).map(([folder, fileIds]) => ({ folder, fileIds }));
}

/** Prose with its code spans: the walkthrough marks code with backticks. */
export function inlines(text: string): GuideInline[] {
  return text.split('`').flatMap((part, position): GuideInline[] => (part ? [{ kind: position % 2 ? 'code' : 'text', text: part }] : []));
}

/** The first sentence, never cut inside a code span. */
export function firstSentence(text: string): string {
  let code = false;
  for (let position = 0; position < text.length; position += 1) {
    const character = text[position]!;
    if (character === '`') code = !code;
    else if (!code && /[.!?]/u.test(character) && (position + 1 === text.length || /\s/u.test(text[position + 1]!))) return text.slice(0, position + 1);
  }
  return text;
}

/**
 * The explanation as words and terms, each term at its first place. The check
 * kept only terms that are exact phrases of it made of whole code spans, so a
 * term never splits a code span.
 */
function explanationSpans(text: string, terms: ReadonlyArray<{ id: string; text: string; target: GuideTarget }>): GuideSpan[] {
  const found = terms
    .map((term) => ({ term, at: text.indexOf(term.text) }))
    .filter((entry) => entry.at >= 0)
    .sort((left, right) => left.at - right.at);
  const spans: GuideSpan[] = [];
  let position = 0;
  for (const { term, at } of found) {
    if (at < position) continue;
    if (at > position) spans.push({ kind: 'text', inlines: inlines(text.slice(position, at)) });
    spans.push({ kind: 'term', id: term.id, inlines: inlines(term.text), target: term.target });
    position = at + term.text.length;
  }
  if (position < text.length) spans.push({ kind: 'text', inlines: inlines(text.slice(position)) });
  return spans;
}

function lineTarget(file: DiffFile, lines: ReviewWalkthroughLines): GuideTarget {
  const last = lines.endLine ?? lines.line;
  const anchors: string[] = [];
  for (let line = lines.line; line <= last; line += 1) anchors.push(lineAnchor(file.path, lines.side, line));
  return { fileId: file.id, anchors, label: `${baseName(file.path)}, ${last > lines.line ? `lines ${lines.line}–${last}` : `line ${lines.line}`}` };
}

// ---------------------------------------------------------------- a file's runs

interface Span { from: number; to: number }

function guideFileOf(file: DiffFile, excerpts: readonly ReviewWalkthroughExcerpt[], anchors: GuideAnchors, targets: ReadonlySet<string>): GuideFile {
  const fileFeedbackOpen = Boolean(
    anchors.findings.byFile.get(file.id)?.some((finding) => finding.state === 'OPEN') ||
    anchors.discussions.byFile.get(file.id)?.some((discussion) => discussion.open) ||
    anchors.comments.byFile.get(file.id)?.length
  );
  // The code a review read holds each file as one block.
  const block = file.blocks[0];
  if (!block) return { file, shown: fileFeedbackOpen, runs: [], rest: [], restAnchors: new Set() };
  const rows = buildReviewDiffRows(block.lines);
  const taken = new Set<number>();
  const take = (span: Span) => { for (let position = span.from; position <= span.to; position += 1) taken.add(position); };

  const keys: GuideRun[] = [];
  for (const excerpt of excerpts) {
    const range = excerptRange(rows, excerpt);
    // Two excerpts never show a row twice: a later one keeps the rows not shown yet.
    const free = range ? freeAround(range, firstFree(range, taken), taken) : undefined;
    if (!free) continue;
    take(free);
    keys.push(runOf(block, rows, free, {
      kind: 'key',
      ...(excerpt.caption ? { caption: excerpt.caption } : {}),
      ...optional('symbol', enclosingSymbol(rows, free.from, excerpt.side))
    }));
  }

  // Rows with something said about them; those still asking for something show around it.
  const banded = new Set<number>();
  const asking: number[] = [];
  rows.forEach((row, position) => {
    if (row.kind !== 'line') return;
    const key = lineAnchorKey(file.id, block.id, row.line, row.index);
    const findings = anchors.findings.byLine.get(key);
    const discussions = anchors.discussions.byLine.get(key);
    const comments = anchors.comments.byLine.get(key);
    if (!findings && !discussions && !comments) return;
    banded.add(position);
    if (findings?.some((finding) => finding.state === 'OPEN') || discussions?.some((discussion) => discussion.open) || comments?.length) asking.push(position);
  });
  const feedback: Span[] = [];
  for (const position of asking) {
    const span = freeAround(hunkSpan(rows, position), position, taken);
    if (!span) continue;
    take(span);
    const last = feedback.at(-1);
    if (last && span.from === last.to + 1) last.to = span.to;
    else feedback.push(span);
  }
  if (!keys.length && !asking.length && !fileFeedbackOpen) return { file, shown: false, runs: [], rest: [], restAnchors: new Set() };

  // Everything else that changed, cut at hunk boundaries. A stretch with no change drops,
  // unless something is said about it or a term points into it.
  const rest: Span[] = [];
  let stretch: (Span & { keep: boolean }) | undefined;
  const close = () => {
    if (stretch?.keep) rest.push({ from: stretch.from, to: stretch.to });
    stretch = undefined;
  };
  rows.forEach((row, position) => {
    if (row.kind === 'gap' || taken.has(position)) { close(); return; }
    const keep = row.line.kind === 'addition' || row.line.kind === 'deletion' || banded.has(position) || targets.has(anchorOf(file, row.line));
    if (stretch) {
      stretch.to = position;
      stretch.keep ||= keep;
    } else stretch = { from: position, to: position, keep };
  });
  close();

  const restRows = rest.flatMap((span) => rows.slice(span.from, span.to + 1)).flatMap((row) => (row.kind === 'line' ? [row.line] : []));
  const changed = restRows.filter((line) => line.kind === 'addition' || line.kind === 'deletion').length;
  const whole = file.status === 'added' || file.status === 'deleted';
  return {
    file,
    shown: true,
    runs: [...keys, ...feedback.map((span) => runOf(block, rows, span, placeLabel(rows, span)))],
    rest: rest.map((span) => runOf(block, rows, span, placeLabel(rows, span))),
    ...(rest.length ? { more: whole ? pluralize(changed, 'more line') : pluralize(rest.length, 'more change') } : {}),
    restAnchors: new Set(restRows.map((line) => anchorOf(file, line)))
  };
}

/** The rows an excerpt names, on its side, with lines removed just before the first one it adds. */
function excerptRange(rows: readonly ReviewDiffRow[], excerpt: ReviewWalkthroughLines): Span | undefined {
  const last = excerpt.endLine ?? excerpt.line;
  const named = (row: ReviewDiffRow) => {
    if (row.kind !== 'line') return false;
    const number = excerpt.side === 'OLD'
      ? (row.line.kind === 'addition' ? undefined : row.line.oldLine)
      : (row.line.kind === 'deletion' ? undefined : row.line.newLine);
    return number !== undefined && number >= excerpt.line && number <= last;
  };
  let from = rows.findIndex(named);
  if (from < 0) return undefined;
  let to = from;
  rows.forEach((row, position) => { if (named(row)) to = position; });
  const first = rows[from];
  if (excerpt.side === 'NEW' && first?.kind === 'line' && first.line.kind === 'addition') {
    while (from > 0) {
      const previous = rows[from - 1];
      if (previous?.kind !== 'line' || previous.line.kind !== 'deletion') break;
      from -= 1;
    }
  }
  return { from, to };
}

/** The rows around one, inside its hunk. */
function hunkSpan(rows: readonly ReviewDiffRow[], position: number): Span {
  let from = position;
  while (from > 0 && from > position - FEEDBACK_ABOVE && rows[from - 1]?.kind === 'line') from -= 1;
  let to = position;
  while (to < rows.length - 1 && to < position + FEEDBACK_BELOW && rows[to + 1]?.kind === 'line') to += 1;
  return { from, to };
}

function firstFree(span: Span, taken: ReadonlySet<number>): number {
  let position = span.from;
  while (position <= span.to && taken.has(position)) position += 1;
  return position;
}

/** The stretch of a span around a row that no other run shows; nothing when that row is shown already. */
function freeAround(span: Span, position: number, taken: ReadonlySet<number>): Span | undefined {
  if (position > span.to || taken.has(position)) return undefined;
  let from = position;
  while (from > span.from && !taken.has(from - 1)) from -= 1;
  let to = position;
  while (to < span.to && !taken.has(to + 1)) to += 1;
  return { from, to };
}

function runOf(block: DiffBlock, rows: readonly ReviewDiffRow[], span: Span, label: GuideRun['label']): GuideRun {
  const first = rows[span.from] as Extract<ReviewDiffRow, { kind: 'line' }>;
  const last = rows[span.to] as Extract<ReviewDiffRow, { kind: 'line' }>;
  return { blockId: block.id, start: diffLineId(first.line, first.index), end: diffLineId(last.line, last.index), label };
}

/** Where a run sits: its lines (the new side's, or the old side's for lines only removed), and its hunk's heading. */
function placeLabel(rows: readonly ReviewDiffRow[], span: Span): GuideRun['label'] {
  const lines = rows.slice(span.from, span.to + 1).flatMap((row) => (row.kind === 'line' ? [row.line] : []));
  const kept = lines.flatMap((line) => (line.kind !== 'deletion' && line.newLine !== undefined ? [line.newLine] : []));
  const numbers = kept.length ? kept : lines.flatMap((line) => (line.oldLine !== undefined ? [line.oldLine] : []));
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  let heading: string | undefined;
  for (let position = span.from; position >= 0; position -= 1) {
    const row = rows[position];
    if (row?.kind === 'gap') { heading = row.heading; break; }
  }
  return { kind: 'place', lines: last > first ? `Lines ${first}–${last}` : `Line ${first}`, ...optional('heading', heading) };
}

function anchorOf(file: DiffFile, line: DiffLine): string {
  return line.kind === 'deletion' ? lineAnchor(file.path, 'OLD', line.oldLine ?? 0) : lineAnchor(file.path, 'NEW', line.newLine ?? 0);
}

/**
 * The symbol a run of rows sits in, as a reader names it: `fetchRevisions()`,
 * `RemoteWorkService`, a test's title. It is the nearest declaration above the
 * run that encloses it by indentation, inside the run's hunk; past the hunk's
 * start, the heading Git gives the hunk. Nothing for a run at the top level, or
 * when what encloses it declares nothing.
 */
export function enclosingSymbol(rows: readonly ReviewDiffRow[], from: number, side: 'NEW' | 'OLD' = 'NEW'): string | undefined {
  const onSide = (line: DiffLine) => (side === 'NEW' ? line.kind !== 'deletion' : line.kind !== 'addition');
  const firstText = rows.slice(from).flatMap((row) => (row.kind === 'line' && onSide(row.line) ? [diffLineCode(row.line)] : [])).find((text) => text.trim());
  if (firstText === undefined) return undefined;
  let indent = indentation(firstText);
  if (indent === 0) return undefined;
  // A line that closes a signature ("}) {") ends one that began above at its own indentation.
  let continued = false;
  for (let position = from - 1; position >= 0; position -= 1) {
    const row = rows[position]!;
    if (row.kind === 'gap') return declaredName(row.heading ?? '');
    if (!onSide(row.line)) continue;
    const text = diffLineCode(row.line);
    if (!text.trim()) continue;
    const depth = indentation(text);
    if (depth > indent || (depth === indent && !continued)) continue;
    const name = declaredName(text);
    if (name) return name;
    continued = /^\s*[})\]]/u.test(text);
    indent = depth;
    if (depth === 0 && !continued) return undefined;
  }
  return undefined;
}

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'throw', 'else', 'do', 'try', 'new', 'case', 'typeof', 'void', 'yield', 'super', 'with']);

/** The name a line declares, as a reader names it; nothing for a line that declares nothing. */
export function declaredName(text: string): string | undefined {
  const test = /^\s*(?:it|test|describe)(?:\.\w+)?\(\s*(['"`])(.+?)\1/u.exec(text);
  if (test) return test[2];
  const type = /\b(?:class|interface|enum|struct|trait|impl|module|namespace|type)\s+([A-Za-z_$][\w$]*)/u.exec(text);
  if (type) return type[1];
  const fn = /\b(?:function\*?|def|fn|func)\s+\*?\s*([A-Za-z_$][\w$]*)/u.exec(text);
  if (fn) return `${fn[1]}()`;
  const bound = /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/u.exec(text);
  if (bound) return bound[1];
  const method = /^\s*(?:(?:export|default|public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/u.exec(text);
  if (method && !CONTROL_WORDS.has(method[1]!)) return `${method[1]}()`;
  return undefined;
}

function indentation(text: string): number {
  return text.length - text.trimStart().length;
}

// ---------------------------------------------------------------- attention

const SEVERITY_WORDS: Record<string, AgentReviewFindingSeverity> = { blocker: 'BLOCKER', major: 'MAJOR', minor: 'MINOR', nit: 'NIT' };
/** "A Major finding: ", "Major: ": what the finding's own severity word says. */
const SEVERITY_LEAD = /^\s*(?:an?\s+)?(?:blocker|major|minor|nit)(?:\s+finding)?\s*[:,]\s*/iu;
const COMMON_WORDS = new Set([
  'that', 'this', 'with', 'from', 'when', 'into', 'than', 'then', 'they', 'their', 'there', 'have', 'does', 'only', 'each', 'every',
  'which', 'while', 'without', 'still', 'finding', 'blocker', 'major', 'minor'
]);

/**
 * Where an attention fact lands. A fact that names one of its stage's open
 * findings, by most of its title's words or by its severity when the stage has
 * one such finding, lands on that finding; one that names a file of the stage
 * by its name lands on the file; any other on its stage.
 */
function attentionItem(text: string, stage: GuideStage, anchors: GuideAnchors): GuideAttention {
  const open = stage.files.flatMap(({ file }) => openFindingsOf(file, anchors).map((finding) => ({ finding, file })));
  const named = /\b(blocker|major|minor|nit)\b/iu.exec(text)?.[1]?.toLowerCase();
  const severity = named ? SEVERITY_WORDS[named] : undefined;
  const candidates = severity ? open.filter((entry) => entry.finding.severity === severity) : open;
  const words = new Set(significantWords(text));
  const scored = candidates
    .map((entry) => ({ entry, score: significantWords(entry.finding.title).filter((word) => words.has(word)).length }))
    .sort((left, right) => right.score - left.score);
  const [best, next] = scored;
  const chosen = best && best.score > (next?.score ?? -1) && (best.score >= 2 || (severity && candidates.length === 1 && best.score >= 1))
    ? best.entry : undefined;
  if (chosen) {
    const rest = text.replace(SEVERITY_LEAD, '');
    return {
      text: inlines(rest === text ? text : rest.charAt(0).toUpperCase() + rest.slice(1)),
      stage: stage.section,
      target: {
        kind: 'finding',
        findingId: chosen.finding.id,
        severity: chosen.finding.severity,
        fileId: chosen.file.id,
        place: chosen.finding.line ? `${baseName(chosen.file.path)} ${chosen.finding.line}` : baseName(chosen.file.path)
      }
    };
  }
  const file = stage.files.find(({ file: candidate }) => new RegExp(`(^|[^\\w./-])${escapeRegExp(baseName(candidate.path))}(?![\\w-])`, 'u').test(text));
  return {
    text: inlines(text),
    stage: stage.section,
    ...(file ? { target: { kind: 'file' as const, fileId: file.file.id } } : {})
  };
}

function openFindingsOf(file: DiffFile, anchors: GuideAnchors) {
  const found = [...(anchors.findings.byFile.get(file.id) ?? [])];
  for (const block of file.blocks) {
    block.lines.forEach((line, index) => found.push(...(anchors.findings.byLine.get(lineAnchorKey(file.id, block.id, line, index)) ?? [])));
  }
  return found.filter((finding) => finding.state === 'OPEN');
}

function significantWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length >= 4 && !COMMON_WORDS.has(word));
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
