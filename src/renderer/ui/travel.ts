import { cubicBezier, parseCubicBezier, parseDuration, prefersReducedMotion } from './expandMotion';

/**
 * The one travel that moves code (DESIGN.md §12): the scroller eases to its
 * target on `--motion-move` and `--ease-in-out`, read from the tokens. A target
 * more than a viewport away is jumped to from one viewport short of it, so every
 * travel is short. A new travel takes over from wherever the last one is; a held
 * key repeating, and reduced motion, arrive at once. Wheel, touch, a press or a
 * key in the scroller hands it back to the person.
 */

export interface TravelPlan {
  /** Where the scroller is put at once: one viewport short of a far target, or the target itself when instant. */
  start: number;
  /** Where it comes to rest. */
  to: number;
  /** How long the eased part takes, in ms; 0 is instant. */
  duration: number;
}

/** The plan for one travel from where the scroller is, its target kept inside the scroll range. */
export function planTravel({ from, to, viewport, max, duration, instant }: {
  from: number;
  to: number;
  viewport: number;
  max: number;
  duration: number;
  instant: boolean;
}): TravelPlan {
  const target = Math.round(Math.min(Math.max(to, 0), Math.max(max, 0)));
  if (instant || duration <= 0 || Math.abs(target - from) < 1) return { start: target, to: target, duration: 0 };
  const start = Math.abs(target - from) > viewport ? target - Math.sign(target - from) * viewport : from;
  return { start, to: target, duration };
}

/** Where a plan has the scroller `elapsed` ms in, along `ease`. */
export function travelPosition(plan: TravelPlan, elapsed: number, ease: (progress: number) => number): number {
  if (elapsed >= plan.duration) return plan.to;
  return plan.start + (plan.to - plan.start) * ease(Math.max(0, elapsed) / plan.duration);
}

export interface TravelOptions {
  /** Arrive at once, as a held key repeating does. Reduced motion always does. */
  instant?: boolean;
  /** For an element: room kept above it, under the sticky line. */
  margin?: number;
}

interface Flight { frame: number; release(): void }

const flights = new WeakMap<HTMLElement, Flight>();
/** What the person does in the scroller that takes it back from a travel. */
const TAKEOVER = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Moves `scroller` to `target`: a scroll position, or an element whose top
 * comes to rest `margin` under the sticky line.
 */
export function travel(scroller: HTMLElement, target: number | Element, { instant = false, margin = 0 }: TravelOptions = {}): void {
  const to = typeof target === 'number' ? target : scrollTopFor(scroller, target, margin);
  stopTravel(scroller);
  const style = getComputedStyle(scroller);
  const curve = parseCubicBezier(style.getPropertyValue('--ease-in-out'));
  const plan = planTravel({
    from: scroller.scrollTop,
    to,
    viewport: scroller.clientHeight,
    max: scroller.scrollHeight - scroller.clientHeight,
    duration: curve ? parseDuration(style.getPropertyValue('--motion-move')) ?? 0 : 0,
    instant: instant || prefersReducedMotion()
  });
  const ease = curve ? cubicBezier(...curve) : (progress: number) => progress;
  const began = performance.now();
  const stop = () => stopTravel(scroller);
  const flight: Flight = {
    frame: 0,
    release: () => TAKEOVER.forEach((type) => scroller.removeEventListener(type, stop))
  };
  TAKEOVER.forEach((type) => scroller.addEventListener(type, stop, { passive: true }));
  flights.set(scroller, flight);
  scroller.scrollTop = plan.start;
  // A step's scroll event arrives in the next frame, before its callbacks, so the
  // travel ends a frame after its last step: its own scrolling never reads as the person's.
  const step = (now: number) => {
    const elapsed = now - began;
    scroller.scrollTop = travelPosition(plan, elapsed, ease);
    flight.frame = requestAnimationFrame(elapsed >= plan.duration ? stop : step);
  };
  flight.frame = requestAnimationFrame(plan.duration ? step : stop);
}

/** Ends the travel in progress on `scroller`, leaving it where it is. */
export function stopTravel(scroller: HTMLElement): void {
  const flight = flights.get(scroller);
  if (!flight) return;
  flights.delete(scroller);
  cancelAnimationFrame(flight.frame);
  flight.release();
}

/** Whether `scroller` is moving, or just came to rest, by a travel rather than by the person. */
export function isTraveling(scroller: HTMLElement): boolean {
  return flights.has(scroller);
}

/** Scrolls the least that shows all of `element` under the sticky line, at once: for a control the keys moved. */
export function keepInView(scroller: HTMLElement, element: Element): void {
  const box = element.getBoundingClientRect();
  const top = stickyLine(scroller, element);
  const bottom = scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight;
  if (box.bottom > bottom) travel(scroller, scroller.scrollTop + box.bottom - bottom, { instant: true });
  else if (box.top < top) travel(scroller, scroller.scrollTop - (top - box.top), { instant: true });
}

/** The scroll position that puts `element`'s top `margin` under the sticky line. */
export function scrollTopFor(scroller: HTMLElement, element: Element, margin = 0): number {
  return scroller.scrollTop + element.getBoundingClientRect().top - stickyLine(scroller, element) - margin;
}

/**
 * Where sticky heads rest on screen above `element`: the scroller's top, past
 * what sticks there (`--review-sticky-top`), as the element's place sets it, so a
 * part of the scroller that pins a line of its own lands what it holds below it.
 */
function stickyLine(scroller: HTMLElement, element: Element): number {
  const stickyTop = Number.parseFloat(getComputedStyle(element).getPropertyValue('--review-sticky-top')) || 0;
  return scroller.getBoundingClientRect().top + scroller.clientTop + stickyTop;
}
