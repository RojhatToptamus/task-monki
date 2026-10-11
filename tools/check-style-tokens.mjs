#!/usr/bin/env node
// Renderer styles take type sizes, weights, corner radii and layers from the
// token scales in DESIGN.md §8.2 and §9. A literal is a value the system already
// answers. A desktop app keeps the arrow cursor on controls, enabled or not; code
// is set in the app's mono, never the browser's generic one; facts are never
// strung together with separator glyphs; and motion uses the motion tokens.
//
// Rules with known debt are ratchets: their count is recorded in
// tools/design-baseline.json and may only go down. Lower the number there when a
// change removes violations; never raise it.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRatchets } from './design-baseline.mjs';

const stylesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles');

// Each pattern is matched against a declaration source with comments blanked.
const rules = [
  // Relative em sizes (inline code set against its prose) are deliberate.
  { pattern: /font-size:\s*[\d.]+(?:px|rem)\b/g, message: 'literal font-size; use a --t-* token' },
  { pattern: /font:\s*(?:\d{3}\s+)?[\d.]+(?:px|rem)\b/g, message: 'literal size in font shorthand; use a --t-* token' },
  { pattern: /border-radius:[^;}]*(?<![\w-])[1-9][\d.]*px/g, message: 'literal border-radius; use a --r-* token' },
  { pattern: /border-radius:\s*50%/g, message: 'percentage radius; a circle or pill is --r-pill' },
  { pattern: /cursor:\s*(?:pointer|not-allowed)/g, message: 'pointer or not-allowed cursor; controls keep the arrow, enabled or not' },
  { pattern: /font-weight:\s*\d{3}\b/g, message: 'literal font-weight; use --w-regular, --w-medium or --w-title' },
  { pattern: /font:\s*\d{3}\s/g, message: 'literal weight in font shorthand; use a --w-* token' },
  { pattern: /font-family:\s*(?!\s)(?!var\(--font-(?:ui|mono)\)|inherit)[^;}]+/g, message: 'font-family that is not --font-ui, --font-mono or inherit' },
  { pattern: /z-index:\s*-?\d+/g, message: 'literal z-index; use a --layer-* token' },
  { pattern: /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|oklch|lab|lch)a?\(/gi, message: 'colour literal; every colour is a token (DESIGN.md §7.1)' },
  { pattern: /text-transform:\s*uppercase|letter-spacing:\s*(?:0?\.\d+|[1-9][\d.]*)(?:em|px)/g, message: 'capitals or added tracking; labels are sentence case (DESIGN.md §8.2)' },
  { pattern: /content:\s*["'][^"']*(?:·|\s[•—–]\s)[^"']*["']/g, message: 'separator glyph in generated content; separate facts with space or layout (DESIGN.md §5)' },
  { pattern: /transition:\s*all\b/g, message: 'transition: all; name the properties that move' },
  // Durations and curves are motion tokens; 0s, the shimmer's loop and the
  // reduced-motion collapse (0.01ms) are the exceptions.
  { pattern: /(?:transition|animation)(?:-duration|-delay)?:[^;{}]*?(?<![\w-])(?!0s\b)\d+(?:\.\d+)?m?s\b/g, message: 'literal duration; use a --motion-* token (DESIGN.md §12)', allow: /tm-shimmer|0\.01ms/ },
  { pattern: /(?:transition|animation)(?:-timing-function)?:[^;{}]*?(?<![\w-])(?:ease-in(?!-out)|ease(?![-\w])|cubic-bezier\()/g, message: 'literal easing; use --ease-out, --ease-in-out or --ease-drawer (DESIGN.md §12)' }
];

// Rules read per rule block: the selector and its declarations.
const blockRules = [
  { test: (selector, body) => /:disabled|\[aria-disabled|--disabled\b/.test(selector) && /opacity:\s*0?\.\d/.test(body), message: 'disabled as opacity; a disabled control is a fill and an ink (DESIGN.md §7.3)' },
  { test: (selector) => /(?:textarea|\.tm-composer|\[contenteditable[^\]]*\]):hover/.test(selector), message: 'hover on a multi-line text surface (DESIGN.md §7.3)' },
  { test: (selector, body) => /:hover/.test(selector) && /--shadow-(?:pop|modal)/.test(body), message: 'hover crossing shadow tiers (DESIGN.md §7.5)' }
];

// Ratchets: counted, compared with the baseline, never allowed to grow.
const ratchets = {
  'line-height-literal': { pattern: /line-height:\s*(?!\s)(?!var\(--lh-|1\s*[;}]|normal|inherit)[^;}]+|font:[^;{}]*var\(--t-[\w-]+\)\s*\/\s*(?!var\()[^;\s]+/g, message: 'literal line-height; use --lh-meta, --lh-ui, --lh-body, --lh-title or --lh-prose' },
  'height-literal': { pattern: /(?:^|[;{\s])(?:min-|max-)?height:\s*(?:20|24|28|32|36|40|44|48)px/gm, message: 'literal height on the control or row scale; use an --h-* token (DESIGN.md §3)' },
  'hover-background-shorthand': { block: (selector, body) => /:hover|:active|\[data-state=['"]open['"]\]|\[aria-expanded=['"]true['"]\]/.test(selector) && /(?:^|;)\s*background\s*:/.test(body), message: 'hover or press sets the background shorthand; set background-color so the press overlay survives' }
};

const failures = [];
const ratchetHits = Object.fromEntries(Object.keys(ratchets).map((name) => [name, []]));

for (const filename of readdirSync(stylesDirectory).filter((name) => name.endsWith('.css'))) {
  const source = readFileSync(resolve(stylesDirectory, filename), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  for (const { pattern, message, allow } of rules) {
    for (const match of source.matchAll(pattern)) {
      if (allow && allow.test(match[0])) continue;
      failures.push(`${filename}:${lineOf(match.index)} ${message}: ${match[0].trim()}`);
    }
  }
  for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [selector, body] = [block[1], block[2]];
    for (const { test, message } of blockRules) {
      if (test(selector, body)) failures.push(`${filename}:${lineOf(block.index + selector.length)} ${message}: ${selector.trim().split('\n').pop()}`);
    }
    for (const [name, rule] of Object.entries(ratchets)) {
      if (rule.block && rule.block(selector, body)) ratchetHits[name].push(`${filename}:${lineOf(block.index + selector.length)}`);
    }
  }
  for (const [name, rule] of Object.entries(ratchets)) {
    if (!rule.pattern) continue;
    for (const match of source.matchAll(rule.pattern)) ratchetHits[name].push(`${filename}:${lineOf(match.index)}`);
  }
}

const compared = compareRatchets('styles', ratchetHits, Object.fromEntries(Object.entries(ratchets).map(([name, rule]) => [name, rule.message])));
failures.push(...compared.failures);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
if (compared.report.length > 0) console.log(compared.report.join('\n'));
console.log('Renderer styles use the type, weight, radius, layer, colour and motion tokens, the arrow cursor, the app mono and no separator glyphs.');
