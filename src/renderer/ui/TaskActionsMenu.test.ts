import { describe, expect, it } from 'vitest';
import { taskMenuGeometry } from './TaskActionsMenu';

describe('taskMenuGeometry', () => {
  it('places the menu in the available viewport space', () => {
    expect(taskMenuGeometry({ top: 180, bottom: 208, left: 440, right: 468 }, {
      width: 1280, height: 720
    })).toEqual({
      left: 254,
      top: 214,
      width: 214,
      maxHeight: 420
    });
    expect(taskMenuGeometry({ top: 560, bottom: 588, left: 440, right: 468 }, {
      width: 1280, height: 720
    })).toEqual({
      left: 254,
      bottom: 166,
      width: 214,
      maxHeight: 420
    });
  });

  it('keeps menus within both horizontal edges and the available short viewport', () => {
    const viewport = { width: 200, height: 160 };
    for (const left of [0, 172]) {
      for (const align of ['start', 'end'] as const) {
        const menu = taskMenuGeometry(
          { left, right: left + 28, top: 80, bottom: 108 }, viewport, 214, align
        );
        expect(menu.left).toBeGreaterThanOrEqual(12);
        expect(menu.left + menu.width).toBeLessThanOrEqual(viewport.width - 12);
        expect(menu.bottom).toBe(86);
        expect(menu.maxHeight).toBe(62);
      }
    }
  });

  it('preserves start alignment for task detail and the smaller menu without a path', () => {
    const trigger = { left: 440, right: 468, top: 180, bottom: 208 };
    const viewport = { width: 1280, height: 720 };
    expect(taskMenuGeometry(trigger, viewport, 214, 'start').left).toBe(trigger.left);
    expect(taskMenuGeometry(trigger, viewport, 152)).toMatchObject({ left: 316, width: 152 });
  });
});
