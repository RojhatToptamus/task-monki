import { describe, expect, it } from 'vitest';
import type { BugElementBox } from '../../shared/bugReplay';
import { boxUnion, containRegion, focusRegion } from './bugShot';

const PAGE = { width: 1280, height: 800 };

function inside(inner: BugElementBox, outer: BugElementBox): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

describe('Framing a screenshot on the checked element', () => {
  it('keeps the element and its surroundings in a frame of the right shape that never shows past the page', () => {
    const page = { x: 0, y: 0, ...PAGE };
    const total = { x: 600, y: 380, width: 80, height: 20 };
    const centred = focusRegion(total, PAGE, 2);
    expect(inside(total, centred)).toBe(true);
    expect(centred.width / centred.height).toBeCloseTo(2);
    // Enough of the page to recognise where the element sits.
    expect(centred.width).toBeGreaterThanOrEqual(400);

    // An element in a corner moves the frame, not past the page's edge.
    const corner = { x: 1220, y: 770, width: 50, height: 20 };
    const cornered = focusRegion(corner, PAGE, 2);
    expect(inside(corner, cornered)).toBe(true);
    expect(inside(cornered, page)).toBe(true);

    // An element taller than the frame would be widens it until it fits.
    const sidebar = { x: 40, y: 100, width: 200, height: 500 };
    const tall = focusRegion(sidebar, PAGE, 2);
    expect(inside(sidebar, tall)).toBe(true);
    expect(inside(tall, page)).toBe(true);

    // Several outlined elements share one frame, and none is left outside it.
    const discount = { x: 120, y: 300, width: 90, height: 20 };
    const both = focusRegion(boxUnion([total, discount]), PAGE, 2);
    expect(inside(total, both) && inside(discount, both)).toBe(true);

    expect(focusRegion(undefined, PAGE, 2)).toEqual(page);
  });

  it('shows a whole page of another shape centred, with the frame’s fill beside it', () => {
    expect(containRegion(PAGE, 2)).toEqual({ x: -160, y: 0, width: 1600, height: 800 });
    expect(containRegion({ width: 800, height: 800 }, 0.5)).toEqual({ x: 0, y: -400, width: 800, height: 1600 });
  });
});
