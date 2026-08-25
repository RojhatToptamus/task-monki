import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('renderer icon foundation', () => {
  it('uses the shared Lucide outline set instead of hand-drawn SVG markup', async () => {
    const source = await readSourceTree(path.resolve('src/renderer/ui'), ['.ts', '.tsx']);

    expect(source).toContain('lucide-react');
    expect(source).not.toMatch(/<(?:svg|path|circle|rect|polyline|line)\b/u);

    const disclosureSummaries = [...source.matchAll(/<summary\b[\s\S]*?<\/summary>/gu)]
      .map((match) => match[0]);
    expect(disclosureSummaries.length).toBeGreaterThan(0);
    expect(disclosureSummaries.every((summary) => summary.includes('DisclosureChevron'))).toBe(true);
  });

  it('does not redraw disclosure chevrons with CSS pseudo-elements', async () => {
    const styles = await readSourceTree(path.resolve('src/renderer/styles'), ['.css']);

    expect(styles).not.toMatch(/summary::(?:before|after)/u);
    expect(styles).not.toContain('prompt-disclosure__chevron');
    expect(styles).not.toMatch(/border-(?:right|bottom):\s*1\.5px solid currentColor/u);
  });

  it('keeps typography on the documented 400, 500, and 600 weights', async () => {
    const styles = await readSourceTree(path.resolve('src/renderer/styles'), ['.css']);

    expect(styles).not.toMatch(/font-weight:\s*(?:300|700)\b/u);
    expect(styles).not.toMatch(/font:\s*(?:300|700)\b/u);
  });
});

async function readSourceTree(root: string, extensions: string[]): Promise<string> {
  const files = await collectFiles(root, extensions);
  return (await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).join('\n');
}

async function collectFiles(root: string, extensions: string[]): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return collectFiles(target, extensions);
    const isTest = entry.name.includes('.test.') || entry.name.includes('.spec.');
    return !isTest && extensions.some((extension) => entry.name.endsWith(extension)) ? [target] : [];
  }));
  return files.flat();
}
