import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cubicBezier } from './expandMotion';
import { isTraveling, planTravel, travel, travelPosition } from './travel';

const ease = cubicBezier(0.77, 0, 0.175, 1);
const plan = (from: number, to: number, options: Partial<Parameters<typeof planTravel>[0]> = {}) =>
  planTravel({ from, to, viewport: 600, max: 10_000, duration: 200, instant: false, ...options });

describe('planning a travel', () => {
  it('moves a short way as it is, and a far one from one viewport short of its target, inside the scroll range', () => {
    expect(plan(1000, 1400)).toEqual({ start: 1000, to: 1400, duration: 200 });
    expect(plan(1000, 5000)).toEqual({ start: 4400, to: 5000, duration: 200 });
    expect(plan(5000, 100)).toEqual({ start: 700, to: 100, duration: 200 });
    expect(plan(9800, 20_000).to).toBe(10_000);
    expect(plan(300, -40).to).toBe(0);
  });

  it('eases from its start to its target and rests there', () => {
    const far = plan(0, 2000);
    const positions = [0, 50, 100, 150, 200, 260].map((elapsed) => travelPosition(far, elapsed, ease));
    expect(positions[0]).toBe(1400);
    expect(positions.at(-2)).toBe(2000);
    expect(positions.at(-1)).toBe(2000);
    expect(positions.every((position, index) => index === 0 || position >= positions[index - 1]!)).toBe(true);
  });

  it('takes over from where an earlier travel is, never from where that one started', () => {
    const first = plan(0, 2000);
    const midway = travelPosition(first, 100, ease);
    expect(midway).toBeGreaterThan(1400);
    expect(midway).toBeLessThan(2000);
    const next = plan(midway, 1500);
    expect(next.start).toBe(midway);
    expect(travelPosition(next, 0, ease)).toBe(midway);
    expect(travelPosition(next, 200, ease)).toBe(1500);
  });

  it('arrives at once when asked to, without a motion token, or when it is already there', () => {
    expect(plan(0, 5000, { instant: true })).toEqual({ start: 5000, to: 5000, duration: 0 });
    expect(plan(0, 300, { duration: 0 })).toEqual({ start: 300, to: 300, duration: 0 });
    expect(plan(300.4, 300)).toEqual({ start: 300, to: 300, duration: 0 });
  });
});

describe('travel', () => {
  let clock = 0;
  let reducedMotion = false;
  let frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const runFrame = (at: number) => {
    clock = at;
    const due = [...frames.values()];
    frames.clear();
    due.forEach((callback) => callback(at));
  };

  beforeEach(() => {
    clock = 0;
    reducedMotion = false;
    frames = new Map();
    const tokens: Record<string, string> = { '--motion-move': ' 200ms', '--ease-in-out': ' cubic-bezier(0.77, 0, 0.175, 1)', '--review-sticky-top': '36px' };
    vi.stubGlobal('window', { matchMedia: () => ({ matches: reducedMotion }) });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => tokens[name] ?? '' }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(nextFrame, callback); return nextFrame++; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A scroller 600 tall over 10600 of content, its top at the window's. */
  function scroller(scrollTop: number) {
    const listeners = new Map<string, () => void>();
    return Object.assign({
      scrollTop,
      clientHeight: 600,
      scrollHeight: 10_600,
      clientTop: 0,
      getBoundingClientRect: () => ({ top: 0 }),
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type)
    }, { emit: (type: string) => listeners.get(type)?.() }) as unknown as HTMLElement & { emit(type: string): void };
  }

  it('eases a far travel in from one viewport short, and ends a frame after its last step so that step reads as its own', () => {
    const element = scroller(1000);
    travel(element, 5000);
    expect(element.scrollTop).toBe(4400);
    runFrame(100);
    expect(element.scrollTop).toBeGreaterThan(4400);
    expect(element.scrollTop).toBeLessThan(5000);
    runFrame(200);
    expect(element.scrollTop).toBe(5000);
    expect(isTraveling(element)).toBe(true);
    runFrame(216);
    expect(isTraveling(element)).toBe(false);
  });

  it('lands an element under the sticky line, with the room asked for above it', () => {
    const element = scroller(1000);
    travel(element, { getBoundingClientRect: () => ({ top: 400 }) } as Element, { instant: true, margin: 120 });
    expect(element.scrollTop).toBe(1000 + 400 - 36 - 120);
  });

  it('hands the scroller back when the person scrolls, and a new travel takes over from where the last one is', () => {
    const element = scroller(0);
    travel(element, 2000);
    runFrame(100);
    const reached = element.scrollTop;
    element.emit('wheel');
    expect(isTraveling(element)).toBe(false);
    runFrame(150);
    expect(element.scrollTop).toBe(reached);

    travel(element, reached + 300);
    expect(element.scrollTop).toBe(reached);
    runFrame(400);
    expect(element.scrollTop).toBe(Math.round(reached + 300));
  });

  it('arrives at once for a held key, and always under reduced motion', () => {
    const element = scroller(0);
    travel(element, 5000, { instant: true });
    expect(element.scrollTop).toBe(5000);
    runFrame(16);
    expect(isTraveling(element)).toBe(false);

    reducedMotion = true;
    travel(element, 100);
    expect(element.scrollTop).toBe(100);
  });
});
