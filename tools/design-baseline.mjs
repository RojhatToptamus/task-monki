import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'design-baseline.json'), 'utf8'));

/**
 * Compares a checker's ratchet hits with tools/design-baseline.json: a count above
 * its baseline fails, one below it is reported so the baseline can be lowered.
 */
export function compareRatchets(section, hits, messages) {
  const failures = [];
  const report = [];
  for (const [name, found] of Object.entries(hits)) {
    const allowed = baseline[section]?.[name];
    if (allowed === undefined) throw new Error(`tools/design-baseline.json has no ${section}.${name}`);
    if (found.length > allowed) {
      failures.push(`${messages[name]}: ${found.length} now, ${allowed} allowed. Latest: ${found.slice(-Math.min(5, found.length - allowed)).join(', ')}`);
    } else if (found.length < allowed) {
      report.push(`${name}: ${found.length} (baseline ${allowed}; lower ${section}.${name} in tools/design-baseline.json)`);
    }
  }
  return { failures, report };
}
