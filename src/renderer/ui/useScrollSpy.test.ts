import { describe, expect, it } from 'vitest';
import { topmostInBand } from './useScrollSpy';

describe('the scroll spy', () => {
  // Four files down the scroller, 10px apart.
  const boxes = [{ top: -400, bottom: -10 }, { top: 0, bottom: 300 }, { top: 310, bottom: 900 }, { top: 910, bottom: 1500 }];
  const read = (top: number, bottom: number) => topmostInBand(boxes.length, (index) => boxes[index]!, top, bottom);

  it('reads the topmost file in the reading band, while any of it is left at the top', () => {
    expect(read(0, 180)).toBe(1);
    expect(read(250, 430)).toBe(1);
    // The band's top in the gap between two files: the next one is read.
    expect(read(305, 485)).toBe(2);
    expect(read(1400, 1580)).toBe(3);
  });

  it('reads none while what stands above the files fills the band, or past the last one', () => {
    expect(read(-1000, -800)).toBeUndefined();
    expect(read(1600, 1780)).toBeUndefined();
    expect(topmostInBand(0, () => ({ top: 0, bottom: 0 }), 0, 180)).toBeUndefined();
  });
});
