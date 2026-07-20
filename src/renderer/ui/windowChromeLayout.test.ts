import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TITLEBAR_HEIGHT } from '../../electron/windowChrome';

describe('window chrome layout styles', () => {
  it('keeps app controls centered in the titlebar height used by native chrome', async () => {
    const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    const rule = css.match(/\.tm-titlebar\s*\{(?<body>[^}]*)\}/);
    const body = rule?.groups?.body ?? '';

    expect(body).toContain(`height: ${TITLEBAR_HEIGHT}px`);
    expect(body).toContain('align-items: center');
  });

  it('gives the New Task canvas a full-height header and bounded content row', async () => {
    const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    const panelHeader =
      css.match(/\.slideover__header\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';
    const workspace =
      css.match(/\.tm-canvas__workspace\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';
    const workspaceContent =
      css.match(/\.tm-canvas__content\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';

    expect(panelHeader).toContain(`height: ${TITLEBAR_HEIGHT}px`);
    expect(workspace).toContain('flex-direction: column');
    expect(workspaceContent).toContain('flex: 1');
    expect(workspaceContent).toContain('min-height: 0');
    expect(workspaceContent).toContain('overflow: hidden');
  });
});
