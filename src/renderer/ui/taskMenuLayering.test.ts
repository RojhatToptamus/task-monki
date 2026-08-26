import { describe, expect, it } from 'vitest';
import { readRendererStyles } from '../../testSupport/rendererStyles';
import { taskMenuGeometry } from './TaskActionsMenu';

describe('task menu layering styles', () => {
  it('raises a task card while its menu is open', async () => {
    const css = await readRendererStyles();
    const rule = css.match(/\.tm-card:has\(\.tm-taskmenu__menu\)\s*\{(?<body>[^}]*)\}/);
    const layer = rule?.groups?.body.match(/z-index:\s*var\(--(?<name>[^)]+)\)/)?.groups?.name;
    const zIndex = css.match(
      new RegExp(`--${layer?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(?<value>\\d+)`)
    )?.groups?.value;

    expect(layer).toBe('layer-menu');
    expect(Number(zIndex)).toBeGreaterThanOrEqual(100);
  });

  it('gives embedded open-target menus enough width for app rows', async () => {
    const css = await readRendererStyles();
    const rule = css.match(
      /\.tm-taskmenu__menu:has\(\.tm-pathmenu__item\)\s*\{(?<body>[^}]*)\}/
    );
    const minWidth = rule?.groups?.body.match(/min-width:\s*(?<value>\d+)px/)?.groups?.value;

    expect(Number(minWidth)).toBeGreaterThanOrEqual(214);
  });

  it('keeps menus inside the viewport above and below their trigger', () => {
    expect(taskMenuGeometry({ top: 180, bottom: 208 }, 720)).toEqual({
      placement: 'bottom',
      maxHeight: 420
    });
    expect(taskMenuGeometry({ top: 560, bottom: 588 }, 720)).toEqual({
      placement: 'top',
      maxHeight: 420
    });
  });
});
