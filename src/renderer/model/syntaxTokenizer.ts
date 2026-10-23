import type { Parser } from '@lezer/common';
import { highlightTree, tagHighlighter, tags as t, type Highlighter, type Tag } from '@lezer/highlight';
import { parser as cssParser } from '@lezer/css';
import { parser as javascriptParser } from '@lezer/javascript';
import { parser as jsonParser } from '@lezer/json';
import { GFM, parseCode, parser as markdownParser } from '@lezer/markdown';
import { parser as pythonParser } from '@lezer/python';
import { parser as yamlParser } from '@lezer/yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { StringStream } from '@codemirror/streamparser';
import { syntaxLanguage, type SyntaxKind, type SyntaxLanguage, type SyntaxToken, type TokenLine } from './syntaxHighlight';

/*
 * The tokenizer: Lezer's grammars, which parse rather than guess, and the shell
 * stream mode for the one language Lezer has no grammar for. Pure JavaScript,
 * since the renderer allows no WebAssembly. It runs in the syntax worker
 * (`ui/useSyntaxLines.ts`), so none of it loads with the app.
 */

type Rule = { tag: Tag | readonly Tag[]; class: SyntaxKind };

/** Grammar tags by kind. A tag not listed (a name, a property, an operator, punctuation) stays plain. */
const CODE_RULES: readonly Rule[] = [
  { tag: [t.keyword, t.modifier, t.self, t.atom], class: 'keyword' },
  { tag: [t.string, t.regexp, t.escape, t.character, t.attributeValue, t.url, t.monospace], class: 'string' },
  { tag: [t.number, t.unit, t.color, t.bool, t.null], class: 'number' },
  { tag: t.comment, class: 'comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'function' },
  { tag: [t.typeName, t.className, t.namespace], class: 'type' },
  { tag: [t.tagName, t.heading], class: 'tag' },
  { tag: [t.attributeName, t.labelName], class: 'attribute' }
];

/* In JSON, YAML and CSS a property is the key of a declaration, the structure
   itself, so it takes the attribute colour, and a CSS value name is a value. */
const DECLARATION_RULES: readonly Rule[] = [
  ...CODE_RULES,
  { tag: [t.propertyName, t.variableName], class: 'attribute' },
  { tag: t.atom, class: 'string' }
];

const codeStyle = tagHighlighter(CODE_RULES);
const declarationStyle = tagHighlighter(DECLARATION_RULES);

const GRAMMARS: Readonly<Record<Exclude<SyntaxLanguage, 'shell'>, { parser: Parser; style: Highlighter }>> = {
  typescript: { parser: javascriptParser.configure({ dialect: 'ts' }), style: codeStyle },
  tsx: { parser: javascriptParser.configure({ dialect: 'ts jsx' }), style: codeStyle },
  javascript: { parser: javascriptParser.configure({ dialect: 'jsx' }), style: codeStyle },
  css: { parser: cssParser, style: declarationStyle },
  json: { parser: jsonParser, style: declarationStyle },
  markdown: { parser: markdownParser.configure([GFM, parseCode({ codeParser: fencedParser })]), style: codeStyle },
  python: { parser: pythonParser, style: codeStyle },
  yaml: { parser: yamlParser, style: declarationStyle }
};

/** A fenced block in Markdown is parsed in the language its info names, by extension, when that has a grammar. */
function fencedParser(info: string): Parser | null {
  const language = syntaxLanguage(`.${info.trim().split(/\s/u)[0]}`);
  return language && language !== 'shell' && language !== 'markdown' ? GRAMMARS[language].parser : null;
}

/** The shell mode's styles by kind; a variable and an operator stay plain. */
const SHELL_KINDS: Readonly<Record<string, SyntaxKind>> = {
  keyword: 'keyword',
  atom: 'number',
  builtin: 'function',
  string: 'string',
  'string.special': 'string',
  quote: 'string',
  number: 'number',
  comment: 'comment',
  meta: 'comment',
  attribute: 'attribute'
};

/**
 * The coloured runs of each line of a file side, its lines joined by "\n". What
 * a line leaves open, a comment or a string, carries into the lines after it.
 */
export function highlightText(language: SyntaxLanguage, text: string): TokenLine[] {
  const runs = new LineRuns(text);
  if (language === 'shell') {
    shellRuns(text, runs);
  } else {
    const { parser, style } = GRAMMARS[language];
    highlightTree(parser.parse(text), style, (from, to, classes) => {
      // A nested style lists the outer kind first; the innermost names the run.
      runs.add(from, to, classes.slice(classes.lastIndexOf(' ') + 1) as SyntaxKind);
    });
  }
  return runs.lines;
}

/** Shell through its stream mode, line by line, with the mode's state carried across lines. */
function shellRuns(text: string, runs: LineRuns): void {
  const state = shell.startState?.(2);
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      const style = shell.token(stream, state);
      // A mode that reads nothing would loop for ever; step past the character.
      if (stream.pos === stream.start) stream.next();
      const kind = style ? SHELL_KINDS[style] : undefined;
      if (kind) runs.add(lineStart + stream.start, lineStart + stream.pos, kind);
      stream.start = stream.pos;
    }
    lineStart += line.length + 1;
  }
}

/** Cuts document ranges, which arrive in order, into runs per line, joining touching runs of one kind. */
class LineRuns {
  readonly lines: SyntaxToken[][];
  private line = 0;
  private lineStart = 0;
  private lineEnd: number;

  constructor(private readonly text: string) {
    let count = 1;
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1;
    this.lines = Array.from({ length: count }, () => []);
    this.lineEnd = this.lineBreak(0);
  }

  add(from: number, to: number, kind: SyntaxKind): void {
    while (from > this.lineEnd) this.nextLine();
    for (;;) {
      const end = Math.min(to, this.lineEnd);
      if (end > from) this.push(from - this.lineStart, end - this.lineStart, kind);
      if (to <= this.lineEnd) return;
      this.nextLine();
      from = this.lineStart;
    }
  }

  private push(from: number, to: number, kind: SyntaxKind): void {
    const runs = this.lines[this.line];
    const last = runs.at(-1);
    if (last?.kind === kind && last.to === from) last.to = to;
    else runs.push({ from, to, kind });
  }

  private nextLine(): void {
    this.line += 1;
    this.lineStart = this.lineEnd + 1;
    this.lineEnd = this.lineBreak(this.lineStart);
  }

  private lineBreak(from: number): number {
    const index = this.text.indexOf('\n', from);
    return index === -1 ? this.text.length : index;
  }
}
