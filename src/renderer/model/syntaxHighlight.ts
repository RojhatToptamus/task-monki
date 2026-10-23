import { diffLineCode, type DiffLine } from './diffEvidence';

/**
 * Syntax colour for code, as the renderer shows it. Plain identifiers and
 * punctuation carry no kind: they keep the row's own ink.
 */
export type SyntaxKind = 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type' | 'tag' | 'attribute';

/** One coloured run of a line, by UTF-16 column, end exclusive. */
export interface SyntaxToken {
  from: number;
  to: number;
  kind: SyntaxKind;
}

/** A line's coloured runs in order; the text between them is plain. */
export type TokenLine = readonly SyntaxToken[];

export type SyntaxLanguage = 'typescript' | 'tsx' | 'javascript' | 'css' | 'json' | 'markdown' | 'python' | 'shell' | 'yaml';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SyntaxLanguage>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  css: 'css',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyi: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml'
};

/** A side longer than this stays plain: tokenizing it would cost more than its colour gives. */
export const MAX_SYNTAX_LENGTH = 512 * 1024;

/** The grammar a file takes, by its extension; none for a type without one. */
export function syntaxLanguage(path: string): SyntaxLanguage | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? undefined : LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

/** One file side to tokenize, keyed by its language and content so equal sides share one result. */
export interface SyntaxJob {
  language: SyntaxLanguage;
  text: string;
  key: string;
}

/**
 * The job for a file side's lines, or none when the side stays plain. Read
 * once per array and path: each windowed run and each Guide excerpt of a block
 * asks for the same sides again.
 */
export function syntaxJob(path: string, lines: readonly string[]): SyntaxJob | undefined {
  const known = jobsByLines.get(lines);
  if (known?.path === path) return known.job;
  const job = sideJob(path, lines);
  jobsByLines.set(lines, { path, job });
  return job;
}

const jobsByLines = new WeakMap<readonly string[], { path: string; job: SyntaxJob | undefined }>();

function sideJob(path: string, lines: readonly string[]): SyntaxJob | undefined {
  const language = syntaxLanguage(path);
  if (!language || lines.length === 0) return undefined;
  // Measured before it is joined, so a side too long to colour is never copied.
  let length = lines.length - 1;
  for (const line of lines) {
    length += line.length;
    if (length > MAX_SYNTAX_LENGTH) return undefined;
  }
  const text = lines.join('\n');
  return { language, text, key: `${language}:${text.length}:${contentHash(text)}` };
}

/** A 53-bit hash of the text (cyrb53), so a memo key never holds the text itself. */
function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A diff block read as its two file sides, each in order, and where each block line sits on its side. */
export interface DiffSides {
  /** Unchanged and removed lines. */
  oldLines: string[];
  /** Unchanged and added lines, including any filled from the checkout. */
  newLines: string[];
  /** Each block line's index on the old side when removed, on the new side otherwise; -1 for a hunk header or a note. */
  index: number[];
}

/**
 * The sides a block's lines belong to. An unchanged line is on both, so each
 * side carries the state a comment or a string opened above it leaves; the
 * gaps a capture leaves between hunks are the only lines either side lacks.
 */
export function diffSides(lines: readonly DiffLine[]): DiffSides {
  let sides = sidesByLines.get(lines);
  if (!sides) {
    sides = blockSides(lines);
    sidesByLines.set(lines, sides);
  }
  return sides;
}

/** Each block's sides, read once per set of lines. */
const sidesByLines = new WeakMap<readonly DiffLine[], DiffSides>();

function blockSides(lines: readonly DiffLine[]): DiffSides {
  const sides: DiffSides = { oldLines: [], newLines: [], index: [] };
  for (const line of lines) {
    if (line.kind === 'deletion') {
      sides.index.push(sides.oldLines.length);
      sides.oldLines.push(diffLineCode(line));
    } else if (line.kind === 'addition' || line.kind === 'context') {
      sides.index.push(sides.newLines.length);
      sides.newLines.push(diffLineCode(line));
      if (line.kind === 'context') sides.oldLines.push(diffLineCode(line));
    } else {
      sides.index.push(-1);
    }
  }
  return sides;
}
