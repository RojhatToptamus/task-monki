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

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '{') {
      openings.push(index + 1);
      continue;
    }
    if (source[index] !== '}') continue;

    const start = openings.pop();
    if (start === undefined) continue;
    const declarations = source.slice(start, index);
    if (declarations.includes('{') || !/box-shadow\s*:[^;{}]*var\(--field-edge\)/u.test(declarations)) {
      continue;
    }

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

console.log('Theme controls use inset --field-edge rims without real borders.');
