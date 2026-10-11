import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cubicBezier, expandFrames, parseCubicBezier, parseDuration, type Box, type ExpandFrame } from './expandMotion';

const drawer = cubicBezier(0.32, 0.72, 0, 1);

/** Where a frame draws the box and a child on screen, composing the two transforms as CSS does. */
function onScreen(frame: ExpandFrame, to: Box, child?: Box, index = 0) {
  const box = { left: to.left + frame.box.x, top: to.top + frame.box.y, width: to.width * frame.box.scaleX, height: to.height * frame.box.scaleY };
  if (!child) return { box };
  const own = frame.children[index]!;
  return {
    box,
    child: {
      left: box.left + frame.box.scaleX * (child.left + own.x),
      top: box.top + frame.box.scaleY * (child.top + own.y),
      width: child.width * frame.box.scaleX * own.scaleX,
      height: child.height * frame.box.scaleY * own.scaleY
    }
  };
}

describe('the expand motion', () => {
  // A docked side sheet growing over the page, and the New task modal growing in both directions.
  it.each([
    { name: 'a side sheet growing leftward', from: { left: 700, top: 52, width: 380, height: 660 }, to: { left: 64, top: 52, width: 1016, height: 660 } },
    { name: 'a modal growing in both directions', from: { left: 400, top: 90, width: 640, height: 520 }, to: { left: 280, top: 90, width: 880, height: 760 } },
    { name: 'either one collapsing again', from: { left: 64, top: 52, width: 1016, height: 660 }, to: { left: 700, top: 52, width: 380, height: 660 } }
  ])('never stretches what is inside while $name, and keeps the head on its corner and the foot on its edge', ({ from, to }) => {
    const head = { left: 0, top: 0, width: to.width, height: 48 };
    const body = { left: 16, top: 48, width: to.width - 32, height: to.height - 108 };
    const foot = { left: 0, top: to.height - 60, width: to.width, height: 60 };
    const frames = expandFrames({ from, to, fromRadius: 12, toRadius: 12, children: [head, body, foot], ease: drawer, scale: true });

    const first = onScreen(frames[0]!, to).box;
    const last = onScreen(frames.at(-1)!, to).box;
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      expect(first[key]).toBeCloseTo(from[key], 1);
      expect(last[key]).toBeCloseTo(to[key], 1);
    }
    for (const frame of frames) {
      [head, body, foot].forEach((child, index) => {
        const { box, child: drawn } = onScreen(frame, to, child, index);
        expect(drawn!.width).toBeCloseTo(child.width, 3);
        expect(drawn!.height).toBeCloseTo(child.height, 3);
        // Pinned to the inline end, where the expand control sits.
        expect(box.left + box.width - (drawn!.left + drawn!.width)).toBeCloseTo(to.width - (child.left + child.width), 3);
        if (child === foot) expect(box.top + box.height - (drawn!.top + drawn!.height)).toBeCloseTo(0, 3);
        else expect(drawn!.top - box.top).toBeCloseTo(child.top, 3);
      });
      // The corner keeps its radius on screen while the box scales.
      expect(frame.radius!.x * frame.box.scaleX).toBeCloseTo(12, 3);
      expect(frame.radius!.y * frame.box.scaleY).toBeCloseTo(12, 3);
    }
    // Between keyframes the browser interpolates the box and the head each in a straight line; the head stays within a pixel.
    frames.slice(1).forEach((frame, index) => {
      const before = frames[index]!;
      const scaleX = (before.box.scaleX + frame.box.scaleX) / 2 * (before.children[0]!.scaleX + frame.children[0]!.scaleX) / 2;
      const scaleY = (before.box.scaleY + frame.box.scaleY) / 2 * (before.children[0]!.scaleY + frame.children[0]!.scaleY) / 2;
      expect(Math.abs(scaleX - 1) * head.width).toBeLessThan(1);
      expect(Math.abs(scaleY - 1) * head.height).toBeLessThan(1);
    });
  });

  it('only moves a box whose size does not change, along the curve', () => {
    const from = { left: 264, top: 600, width: 800, height: 400 };
    const to = { left: 264, top: 102, width: 800, height: 400 };
    const frames = expandFrames({ from, to, fromRadius: 8, toRadius: 8, children: [], ease: drawer, scale: false });

    expect(frames.every((frame) => frame.box.scaleX === 1 && frame.box.scaleY === 1 && !frame.radius)).toBe(true);
    expect(onScreen(frames[0]!, to).box.top).toBeCloseTo(600, 3);
    expect(onScreen(frames.at(-1)!, to).box.top).toBeCloseTo(102, 3);
    const tops = frames.map((frame) => onScreen(frame, to).box.top);
    expect(tops.every((top, index) => index === 0 || top <= tops[index - 1]!)).toBe(true);
  });

  // The motion reads its timing from the tokens; one it cannot read leaves the change instant, silently.
  it('reads the motion tokens the expand motion uses as they are written', () => {
    const foundation = readFileSync(resolve(__dirname, '../styles/foundation.css'), 'utf8');
    const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(foundation)?.[1] ?? '';
    expect(parseDuration(token('--motion-slow'))).toBeGreaterThan(0);
    expect(parseDuration(token('--motion-move'))).toBeGreaterThan(0);
    const curves = ['--ease-drawer', '--ease-in-out'].map((name) => parseCubicBezier(token(name)));
    expect(curves.every(Boolean)).toBe(true);
    for (const curve of curves) {
      const ease = cubicBezier(...curve!);
      const samples = Array.from({ length: 41 }, (_, index) => ease(index / 40));
      expect(samples[0]).toBe(0);
      expect(samples.at(-1)).toBe(1);
      expect(samples.every((value, index) => index === 0 || value >= samples[index - 1]! - 1e-9)).toBe(true);
    }
  });
});
