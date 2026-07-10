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
});
