#!/usr/bin/env node
// Renderer copy and components follow DESIGN.md §5 (Words) and §10 (Components):
// no em-dash, emoji, banned word or separator glyph in interface copy, no
// ellipsis in a placeholder, no spinner, and one agent mark. Copy the model layer
// builds reaches the same screens, so it keeps the separator rule too. Native
// titles on buttons are a ratchet: their count is recorded in
// tools/design-baseline.json and may only go down. Lower the number there when a
// change removes some; never raise it.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(here, '../src/renderer/ui');
const modelDirectory = resolve(here, '../src/renderer/model');
const baseline = JSON.parse(readFileSync(resolve(here, 'design-baseline.json'), 'utf8'));

// A string literal, template or JSX text that carries the pattern.
const inCopy = (inner) => new RegExp(`[\`'">][^\`'"<\\n]*${inner}`, 'gu');
const separatorRule = { pattern: inCopy('\\s[·•]\\s'), message: 'middle dot or bullet joining facts in copy; give each fact its own span or words (DESIGN.md §5)' };
const rules = [
  separatorRule,
  { pattern: inCopy('\\w\\s—\\s\\w'), message: 'em-dash in interface copy (DESIGN.md §5)' },
  { pattern: /\p{Extended_Pictographic}/gu, message: 'emoji in interface copy (DESIGN.md §5)' },
  { pattern: />[^<{]*\b(?:Click|Please|successfully|Oops|Simply|Tip:|Note:)\b[^<]*</g, message: 'banned word in interface copy (DESIGN.md §5)' },
  { pattern: /placeholder=["'{`][^"'}`]*(?:…|\.\.\.)["'}`]/g, message: 'placeholder ending in an ellipsis (DESIGN.md §5)' },
  { pattern: /\b(?:Loader2?|LoaderCircle|LoaderPinwheel)\b/g, message: 'spinner icon; work in flight is the still StatusGlyph and a shimmer (DESIGN.md §6.6)' },
  { pattern: /import[^;]*\bBot\w*\b[^;]*from\s+['"]lucide-react['"]/g, message: 'robot icon; every agent is AgentMark (DESIGN.md §8.3)' }
];
const ratchets = {
  'native-title-on-button': { pattern: /<button\b[^>]*\btitle=/g, message: 'native title on a button; name it with Tooltip and state a disabled reason beside the actions (DESIGN.md §4, §10)' }
};

// Comments are blanked, so a rule explained in a comment never trips its own check.
const blankComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (match, lead) => lead + match.slice(lead.length).replace(/[^\n]/g, ' '));
const sourceFiles = (directory, extension) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? sourceFiles(resolve(directory, entry.name), extension)
    : entry.name.endsWith(extension) && !entry.name.includes('.test.') ? [resolve(directory, entry.name)] : []);

const failures = [];
const ratchetHits = Object.fromEntries(Object.keys(ratchets).map((name) => [name, []]));
for (const file of sourceFiles(modelDirectory, '.ts')) {
  const source = blankComments(readFileSync(file, 'utf8'));
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  for (const match of source.matchAll(separatorRule.pattern)) {
    failures.push(`model/${file.slice(modelDirectory.length + 1)}:${lineOf(match.index)} ${separatorRule.message}: ${match[0].trim().slice(0, 60)}`);
  }
}
for (const file of sourceFiles(uiDirectory, '.tsx')) {
  const source = blankComments(readFileSync(file, 'utf8'));
  const name = file.slice(uiDirectory.length + 1);
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  for (const { pattern, message } of rules) {
    for (const match of source.matchAll(pattern)) failures.push(`${name}:${lineOf(match.index)} ${message}: ${match[0].trim().slice(0, 60)}`);
  }
  for (const [rule, { pattern }] of Object.entries(ratchets)) {
    for (const match of source.matchAll(pattern)) ratchetHits[rule].push(`${name}:${lineOf(match.index)}`);
  }
}

const report = [];
for (const [rule, hits] of Object.entries(ratchetHits)) {
  const allowed = baseline.renderer?.[rule];
  if (allowed === undefined) throw new Error(`tools/design-baseline.json has no renderer.${rule}`);
  if (hits.length > allowed) {
    failures.push(`${ratchets[rule].message}: ${hits.length} now, ${allowed} allowed. Latest: ${hits.slice(-Math.min(5, hits.length - allowed)).join(', ')}`);
  } else if (hits.length < allowed) {
    report.push(`${rule}: ${hits.length} (baseline ${allowed}; lower renderer.${rule} in tools/design-baseline.json)`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
if (report.length > 0) console.log(report.join('\n'));
console.log('Renderer copy has no em-dash, emoji, banned word, separator glyph or ellipsis placeholder, and components use no spinner and one agent mark.');
