import type { AgentReviewFindingSeverity } from '../../shared/agentReviewFindings';
import type { ReviewChangesResult } from '../../shared/reviewRounds';
import type {
  ReviewWalkthrough,
  ReviewWalkthroughAttention,
  ReviewWalkthroughExcerpt,
  ReviewWalkthroughLines,
  ReviewWalkthroughUnavailableReason
} from '../../shared/reviewWalkthrough';
import { diffLineCode, type DiffBlock, type DiffFile, type DiffLine } from './diffEvidence';
import { pluralize } from './formatting';
import type { ReviewAnchors } from './reviewReading';
import {
  buildReviewDiffRows,
  diffLineId,
  fileLineAnchor,
  lineAnchorKey,
  type AnchoredDiscussions,
  type ReviewDiffRow,
  type ReviewFindingView
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
  /** The agent's fact. */
  text: GuideInline[];
  /** Its section. */
  stage: number;
  /** Where it lands beyond its stage: the open finding it names, with the finding's file and line, or the file it names. */
  target?:
    | { kind: 'finding'; findingId: string; severity: AgentReviewFindingSeverity; place: string }
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

/** What the layout reads of the feedback `anchorReview*` placed in the files: of a discussion, only whether it is open. */
type GuideAnchors = Omit<ReviewAnchors, 'discussions'> & { discussions: AnchoredDiscussions<{ open: boolean }> };

/** Feedback no key change holds shows with the lines a reader needs to see what it is about. */
const FEEDBACK_ABOVE = 7;
const FEEDBACK_BELOW = 3;

/**
 * The Guide of a walkthrough over the files of the diff it was checked against,
 * laid out by what `anchors` places in them. The check kept that diff's own
 * paths, so a path names its file exactly.
 */
export function buildGuide(walkthrough: ReviewWalkthrough, files: readonly DiffFile[], anchors: GuideAnchors): GuideModel {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const index = new Map<string, { stage: number; file: GuideFile }>();
  // The open findings the files hold, by id: what an attention pointer lands on.
  const openFindings = new Map<string, { finding: ReviewFindingView; file: DiffFile }>();
  const stages = walkthrough.sections.map((section, sectionIndex): GuideStage => {
    const sectionFiles = section.files.flatMap((path) => byPath.get(path) ?? []);
    const terms = section.terms.flatMap((term, termIndex) => {
      const file = byPath.get(term.path);
      return file ? [{ id: `${sectionIndex}:${termIndex}`, text: term.text, target: lineTarget(file, term) }] : [];
    });
    const guideFiles = sectionFiles.map((file) => {
      const { guideFile, open } = guideFileOf(
        file,
        section.excerpts.filter((excerpt) => excerpt.path === file.path),
        anchors,
        // Lines a term points at stay among what the file can open.
        new Set(terms.filter((term) => term.target.fileId === file.id).flatMap((term) => term.target.anchors))
      );
      for (const finding of open) openFindings.set(finding.id, { finding, file });
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
    const item = attentionItem(fact, openFindings, byPath);
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
function inlines(text: string): GuideInline[] {
  return text.split('`').flatMap((part, position): GuideInline[] => (part ? [{ kind: position % 2 ? 'code' : 'text', text: part }] : []));
}

/** The first sentence, never cut inside a code span. */
function firstSentence(text: string): string {
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
  const anchorAt = fileLineAnchor(file.path);
  const anchors: string[] = [];
  for (let line = lines.line; line <= last; line += 1) anchors.push(anchorAt(lines.side, line));
  return { fileId: file.id, anchors, label: `${baseName(file.path)}, ${last > lines.line ? `lines ${lines.line}–${last}` : `line ${lines.line}`}` };
}

/**
 * Where an attention pointer lands: on the finding it names while the files
 * hold it open, else on the file it names, else on its stage.
 */
function attentionItem(
  fact: ReviewWalkthroughAttention,
  openFindings: ReadonlyMap<string, { finding: ReviewFindingView; file: DiffFile }>,
  byPath: ReadonlyMap<string, DiffFile>
): GuideAttention {
  const text = inlines(fact.text);
  const named = fact.finding === undefined ? undefined : openFindings.get(fact.finding);
  if (named) {
    const { finding, file } = named;
    const lines = finding.line ? `:${finding.line}${finding.endLine && finding.endLine > finding.line ? `–${finding.endLine}` : ''}` : '';
    return {
      text,
      stage: fact.section,
      target: { kind: 'finding', findingId: finding.id, severity: finding.severity, place: `${baseName(file.path)}${lines}` }
    };
  }
  const file = fact.path === undefined ? undefined : byPath.get(fact.path);
  return { text, stage: fact.section, ...(file ? { target: { kind: 'file' as const, fileId: file.id } } : {}) };
}

// ---------------------------------------------------------------- a file's runs

interface Span { from: number; to: number }

/** A file of a stage, laid out, with the open findings it holds. */
function guideFileOf(
  file: DiffFile,
  excerpts: readonly ReviewWalkthroughExcerpt[],
  anchors: GuideAnchors,
  targets: ReadonlySet<string>
): { guideFile: GuideFile; open: ReviewFindingView[] } {
  const open = (anchors.findings.byFile.get(file.id) ?? []).filter((finding) => finding.state === 'OPEN');
  const fileFeedbackOpen = Boolean(
    open.length ||
    anchors.discussions.byFile.get(file.id)?.some((discussion) => discussion.open) ||
    anchors.comments.byFile.get(file.id)?.length
  );
  const unshown = (shown: boolean) => ({ guideFile: { file, shown, runs: [], rest: [], restAnchors: new Set<string>() }, open });
  // The code a review read is one diff, so each file is one block.
  const block = file.blocks[0];
  if (!block) return unshown(fileFeedbackOpen);
  const rows = buildReviewDiffRows(block.lines);
  const anchorAt = fileLineAnchor(file.path);
  const anchorOf = (line: DiffLine) => (line.kind === 'deletion' ? anchorAt('OLD', line.oldLine ?? 0) : anchorAt('NEW', line.newLine ?? 0));
  const taken = new Set<number>();
  const take = (span: Span) => { for (let position = span.from; position <= span.to; position += 1) taken.add(position); };

  // Excerpts that share rows read as one key change, under the first one's caption.
  const keyed: Array<Span & { caption?: string; side: 'NEW' | 'OLD' }> = [];
  for (const excerpt of excerpts) {
    const range = excerptRange(rows, excerpt);
    if (!range) continue;
    const shared = keyed.filter((key) => key.from <= range.to && range.from <= key.to);
    const first = shared[0];
    if (!first) {
      keyed.push({ ...range, ...optional('caption', excerpt.caption), side: excerpt.side });
      continue;
    }
    for (const key of [...shared, range]) {
      first.from = Math.min(first.from, key.from);
      first.to = Math.max(first.to, key.to);
    }
    for (const key of shared.slice(1)) keyed.splice(keyed.indexOf(key), 1);
  }
  keyed.forEach(take);
  const keys = keyed.map((key) => runOf(block, rows, key, {
    kind: 'key',
    ...optional('caption', key.caption),
    ...optional('symbol', enclosingSymbol(rows, key.from, key.side))
  }));

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
    const openHere = findings?.filter((finding) => finding.state === 'OPEN') ?? [];
    open.push(...openHere);
    if (openHere.length || discussions?.some((discussion) => discussion.open) || comments?.length) asking.push(position);
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
  if (!keys.length && !asking.length && !fileFeedbackOpen) return unshown(false);

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
    const keep = row.line.kind === 'addition' || row.line.kind === 'deletion' || banded.has(position) || targets.has(anchorOf(row.line));
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
    guideFile: {
      file,
      shown: true,
      runs: [...keys, ...feedback.map((span) => runOf(block, rows, span, placeLabel(rows, span)))],
      rest: rest.map((span) => runOf(block, rows, span, placeLabel(rows, span))),
      ...(rest.length ? { more: whole ? pluralize(changed, 'more line') : pluralize(rest.length, 'more change') } : {}),
      restAnchors: new Set(restRows.map(anchorOf))
    },
    open
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

/**
 * Where a run sits: its lines, the new side's or, for lines only removed, the
 * old side's, which run in order within a block; and its hunk's heading.
 */
function placeLabel(rows: readonly ReviewDiffRow[], span: Span): GuideRun['label'] {
  const numberAt = (position: number, side: 'NEW' | 'OLD') => {
    const row = rows[position];
    if (row?.kind !== 'line') return undefined;
    return side === 'NEW' ? (row.line.kind === 'deletion' ? undefined : row.line.newLine) : row.line.oldLine;
  };
  const edge = (side: 'NEW' | 'OLD', from: number, step: 1 | -1) => {
    for (let position = from; position >= span.from && position <= span.to; position += step) {
      const number = numberAt(position, side);
      if (number !== undefined) return number;
    }
    return undefined;
  };
  const side = edge('NEW', span.from, 1) === undefined ? 'OLD' : 'NEW';
  const first = edge(side, span.from, 1) ?? 0;
  const last = edge(side, span.to, -1) ?? first;
  let heading: string | undefined;
  for (let position = span.from; position >= 0; position -= 1) {
    const row = rows[position];
    if (row?.kind === 'gap') { heading = row.heading; break; }
  }
  return { kind: 'place', lines: last > first ? `Lines ${first}–${last}` : `Line ${first}`, ...optional('heading', heading) };
}

/**
 * The symbol a run of rows sits in, as a reader names it: `fetchRevisions()`,
 * `RemoteWorkService`, a test's title. It is the nearest declaration above the
 * run that encloses it by indentation, inside the run's hunk; past the hunk's
 * start, the heading Git gives the hunk. Nothing for a run at the top level, or
 * when what encloses it declares nothing.
 */
function enclosingSymbol(rows: readonly ReviewDiffRow[], from: number, side: 'NEW' | 'OLD' = 'NEW'): string | undefined {
  const onSide = (line: DiffLine) => (side === 'NEW' ? line.kind !== 'deletion' : line.kind !== 'addition');
  let indent: number | undefined;
  for (let position = from; position < rows.length && indent === undefined; position += 1) {
    const row = rows[position]!;
    if (row.kind !== 'line' || !onSide(row.line)) continue;
    const text = diffLineCode(row.line);
    if (text.trim()) indent = indentation(text);
  }
  if (!indent) return undefined;
  // A line that closes a signature ("}) {") ends one that began above at its own indentation.
  let continued = false;
  for (let position = from - 1; position >= 0; position -= 1) {
    const row = rows[position]!;
    if (row.kind === 'gap') return declaredName(row.heading ?? '');
    if (!onSide(row.line)) continue;
    const text = diffLineCode(row.line);
    if (!text.trim() || COMMENT_LINE.test(text)) continue;
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

/** A line that only comments, whatever words it holds. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#|--)/u;
/** Words a statement opens with, which a call-like line never declares. */
const CONTROL_WORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'do', 'switch', 'case', 'match', 'try', 'catch', 'except', 'finally', 'with',
  'return', 'await', 'throw', 'yield', 'assert', 'new', 'typeof', 'void', 'super', 'func', 'function'
]);
/** Words that may come before what a line declares: `export default async`, `pub(crate) unsafe`, `public static`. */
const MODIFIERS = String.raw`(?:[A-Za-z_$][\w$]*(?:\([^)]*\))?\s+)*?`;
const TEST = /^\s*(?:it|test|describe)(?:\.\w+)?\(\s*(['"`])(.+?)\1/u;
const TYPE = new RegExp(String.raw`^\s*${MODIFIERS}(?:class|interface|enum|struct|trait|impl|module|namespace|type)\s+(?:<[^>]*>\s*)?([A-Za-z_$][\w$]*)`, 'u');
/** A function by keyword; Go's methods name their receiver first. */
const FUNCTION = new RegExp(String.raw`^\s*${MODIFIERS}(?:function\*?|def|fn|fun|func)\s+(?:\([^)]*\)\s*)?\*?\s*([A-Za-z_$][\w$]*)`, 'u');
const BOUND = /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/u;
const METHOD = /^\s*(?:(?:export|default|public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/u;

/** The name a line declares, as a reader names it; nothing for a line that declares nothing. */
function declaredName(text: string): string | undefined {
  if (COMMENT_LINE.test(text)) return undefined;
  const test = TEST.exec(text);
  if (test) return test[2];
  const type = TYPE.exec(text);
  if (type) return type[1];
  const fn = FUNCTION.exec(text);
  if (fn) return `${fn[1]}()`;
  const bound = BOUND.exec(text);
  if (bound) return bound[1];
  // A call ends its statement; a method opens a body.
  const method = METHOD.exec(text);
  if (method && !CONTROL_WORDS.has(method[1]!) && !/;\s*$/u.test(text)) return `${method[1]}()`;
  return undefined;
}

function indentation(text: string): number {
  return text.length - text.trimStart().length;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
