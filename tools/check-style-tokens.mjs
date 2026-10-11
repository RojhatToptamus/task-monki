#!/usr/bin/env node
// Renderer styles take type sizes and corner radii from the token scales in
// DESIGN.md §3.2 and §4. A literal is a value the system already answers. A
// desktop app keeps the arrow cursor on controls, so the pointer hand is refused.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stylesDirectory = resolve(here, '../src/renderer/styles');
const rules = [
  // Relative em sizes (inline code set against its prose) are deliberate.
  { pattern: /font-size:\s*[\d.]+(?:px|rem)\b/g, message: 'literal font-size; use a --t-* token' },
  { pattern: /font:\s*(?:\d{3}\s+)?[\d.]+(?:px|rem)\b/g, message: 'literal size in font shorthand; use a --t-* token' },
  { pattern: /border-radius:[^;}]*(?<![\w-])[1-9][\d.]*px/g, message: 'literal border-radius; use a --r-* token' },
  { pattern: /var\(--(?:working|working-ink|working-bg|ctx-bg|amber-bg|error-bg)\)/g, message: 'removed alias; use the canonical token' },
  { pattern: /cursor:\s*pointer/g, message: 'pointer cursor; desktop controls keep the arrow' }
];
const failures = [];

for (const filename of readdirSync(stylesDirectory).filter((name) => name.endsWith('.css'))) {
  const source = readFileSync(resolve(stylesDirectory, filename), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  for (const { pattern, message } of rules) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      failures.push(`${filename}:${line} ${message}: ${match[0].trim()}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Renderer styles use type and radius tokens, and no pointer cursor.');
