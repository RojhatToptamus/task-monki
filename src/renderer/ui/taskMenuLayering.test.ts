import { describe, expect, it } from 'vitest';
import { readRendererStyles } from '../../testSupport/rendererStyles';

describe('task menu layering styles', () => {
  it('raises a task card while its menu is open', async () => {
    const css = await readRendererStyles();
    const rule = css.match(/\.tm-card:has\(\.tm-taskmenu__menu\)\s*\{(?<body>[^}]*)\}/);
    const zIndex = rule?.groups?.body.match(/z-index:\s*(?<value>\d+)/)?.groups?.value;

    expect(Number(zIndex)).toBeGreaterThan(0);
  });

  it('gives embedded open-target menus enough width for app rows', async () => {
    const css = await readRendererStyles();
    const rule = css.match(
      /\.tm-taskmenu__menu:has\(\.tm-pathmenu__item\)\s*\{(?<body>[^}]*)\}/
    );
    const minWidth = rule?.groups?.body.match(/min-width:\s*(?<value>\d+)px/)?.groups?.value;

    expect(Number(minWidth)).toBeGreaterThanOrEqual(214);
  });
});
