import { readFile } from 'node:fs/promises';

/** Loads the renderer stylesheet exactly as CSS imports compose it in source order. */
export function readRendererStyles(): Promise<string> {
  return readCssGraph(new URL('../renderer/styles.css', import.meta.url), new Set());
}

async function readCssGraph(url: URL, active: Set<string>): Promise<string> {
  if (active.has(url.href)) {
    throw new Error(`Renderer stylesheet import cycle: ${url.href}`);
  }
  const source = await readFile(url, 'utf8');
  const nextActive = new Set(active).add(url.href);
  const imports = [...source.matchAll(/^@import\s+['"](?<path>[^'"]+)['"];\s*$/gmu)];
  if (imports.length === 0) return source;

  let result = '';
  let offset = 0;
  for (const match of imports) {
    result += source.slice(offset, match.index);
    result += await readCssGraph(new URL(match.groups!.path, url), nextActive);
    offset = match.index! + match[0].length;
  }
  return result + source.slice(offset);
}
