#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stylesDirectory = resolve(here, '../src/renderer/styles');
const failures = [];

for (const filename of readdirSync(stylesDirectory).filter((name) => name.endsWith('.css'))) {
  const source = readFileSync(resolve(stylesDirectory, filename), 'utf8');
  const openings = [];

  for (const deprecatedAlias of ['--field-focus-line', '--field-focus-ring']) {
    if (source.includes(`var(${deprecatedAlias})`)) {
      failures.push(`${filename} still uses deprecated focus alias ${deprecatedAlias}`);
    }
  }

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '{') {
      openings.push(index + 1);
      continue;
    }
    if (source[index] !== '}') continue;

    const start = openings.pop();
    if (start === undefined) continue;
    const declarations = source.slice(start, index);
    if (declarations.includes('{')) {
      continue;
    }

    const selectorStart = Math.max(source.lastIndexOf('}', start - 2), source.lastIndexOf('{', start - 2));
    const selector = source.slice(selectorStart + 1, start - 1);
    if (
      /:focus(?:-visible|-within)?/u.test(selector) &&
      /\b(?:box-shadow|border(?:-[a-z-]+)?|outline)\s*:[^;{}]*var\(--accent\)/u.test(declarations)
    ) {
      const line = source.slice(0, start).split('\n').length;
      failures.push(`${filename}:${line} uses the accent hue on a focused control boundary`);
    }

    if (!/box-shadow\s*:[^;{}]*var\(--field-edge(?:-focus)?\)/u.test(declarations)) continue;

    const borders = [...declarations.matchAll(
      /\b(border(?:-(?:top|right|bottom|left)(?:-(?:width|style))?|-(?:width|style))?)\s*:\s*([^;{}]+)/gu
    )];
    const realBorder = borders.find((border) => {
      const property = border[1];
      const value = border[2].trim();
      if (property.endsWith('style')) return !/^(?:none|hidden)(?:\s|$)/u.test(value);
      return !/^(?:0(?:[a-z%]+)?|none)(?:\s|$)/u.test(value);
    });
    if (realBorder) {
      const line = source.slice(0, start).split('\n').length;
      failures.push(`${filename}:${line} carries both ${realBorder[0].trim()} and a --field-edge rim`);
    }
  }
}

if (failures.length) {
  console.error('Theme control rim check failed:\n' + failures.map((failure) => `  ${failure}`).join('\n'));
  process.exit(1);
}

console.log('Theme controls use neutral inset field rims without duplicate borders or accent focus edges.');
