import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('task detail layout styles', () => {
  it('centers the bounded task canvas with the established column balance', async () => {
    const css = await readStyles();
    const rule = css.match(/\.tm-overview\s*\{(?<body>[^}]*)\}/);
    const body = rule?.groups?.body ?? '';

    expect(body).toContain('max-width: 1180px');
    expect(body).toContain('margin: 0 auto');
    expect(body).toContain('grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr)');
    expect(body).toContain('gap: 16px');
  });

  it('stacks the centered columns at the existing responsive breakpoint', async () => {
    const css = await readStyles();
    const rule = css.match(
      /@media \(max-width: 1080px\)\s*\{\s*\.tm-overview\s*\{(?<body>[^}]*)\}/
    );

    expect(rule?.groups?.body).toContain('grid-template-columns: 1fr');
  });
});

function readStyles(): Promise<string> {
  return readFile(new URL('../styles.css', import.meta.url), 'utf8');
}
