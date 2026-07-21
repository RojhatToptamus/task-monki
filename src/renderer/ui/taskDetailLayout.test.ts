import { describe, expect, it } from 'vitest';
import { readRendererStyles } from '../../testSupport/rendererStyles';

describe('task detail layout styles', () => {
  it('centers the bounded task canvas with the established column balance', async () => {
    const css = await readRendererStyles();
    const rule = css.match(/\.tm-overview\s*\{(?<body>[^}]*)\}/);
    const body = rule?.groups?.body ?? '';

    expect(body).toContain('max-width: 1180px');
    expect(body).toContain('margin: 0 auto');
    expect(body).toContain('grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr)');
    expect(body).toContain('gap: 16px');
  });

  it('stacks the centered columns at the existing responsive breakpoint', async () => {
    const css = await readRendererStyles();
    const rule = css.match(
      /@media \(max-width: 1080px\)\s*\{\s*\.tm-overview\s*\{(?<body>[^}]*)\}/
    );

    expect(rule?.groups?.body).toContain('grid-template-columns: 1fr');
  });

  it('reflows progress metadata and completed-change actions at the 400px checkpoint', async () => {
    const css = await readRendererStyles();
    const narrow = css.slice(css.lastIndexOf('@media (max-width: 520px)'));

    expect(narrow).toMatch(
      /\.tm-runheader\s*\{[^}]*grid-template-columns: 9px minmax\(0, 1fr\) auto auto/
    );
    expect(narrow).toMatch(
      /\.tm-runheader__scope,[\s\S]*?\.tm-runheader__trailing\s*\{[^}]*white-space: normal/
    );
    expect(narrow).toMatch(
      /\.tm-change-summary__head > \.outline-button\s*\{[^}]*grid-column: 2/
    );
  });
});
