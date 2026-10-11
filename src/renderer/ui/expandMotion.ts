import { flushSync } from 'react-dom';

/**
 * The expand motion (DESIGN.md §12): a FLIP transform. The surface takes its new
 * layout at once; its box is then drawn from where it was to where it is, and
 * each child is held at its own size, pinned to the corner that carries the
 * control, so text never stretches while the box grows. Only `transform` moves
 * (the corner radius is corrected beside it); the duration and the curve are
 * read from the motion tokens, and reduced motion leaves the change instant.
 */
export interface ExpandMotion {
  /** The token for the duration, such as `--motion-slow`. */
  duration: `--motion-${string}`;
  /** The token for the curve, such as `--ease-drawer`. */
  easing: `--ease-${string}`;
  /** A change of size: the box scales and its children keep theirs. Without it the box only moves. */
  scale?: boolean;
}

export interface Box { left: number; top: number; width: number; height: number }
export interface ExpandOrigin { box: Box; radius: number }

/** A 2D transform as a translation then a scale, both about the element's top-left corner. */
export interface FrameTransform { x: number; y: number; scaleX: number; scaleY: number }
export interface ExpandFrame {
  offset: number;
  box: FrameTransform;
  /** The box's corner as written on it, so the corner on screen keeps its radius while the box scales. */
  radius?: { x: number; y: number };
  children: FrameTransform[];
}

/**
 * Keyframes are even in time, so the curve keeps its timing, and even in
 * progress, so where the box changes fastest the box and the counter-scaled
 * children, each interpolated in a straight line, stay within a pixel of each other.
 */
const TIME_STEPS = 24;
const PROGRESS_STEPS = 48;
const running = new WeakMap<HTMLElement, Animation[]>();

/**
 * Applies `change` and draws `element` from its old box to its new one. Call it
 * from an event handler: the change is committed synchronously so the new box
 * can be measured before the next frame. `settle` runs between the two, for
 * anything that must be in place first, such as a scroll position.
 */
export function changeWithMotion(
  element: HTMLElement | null | undefined,
  change: () => void,
  motion: ExpandMotion,
  settle?: () => void
): void {
  const origin = element && motionAllowed(element) ? captureExpandOrigin(element) : undefined;
  flushSync(change);
  settle?.();
  if (origin && element?.isConnected) playExpandMotion(element, origin, motion);
}

export function captureExpandOrigin(element: HTMLElement): ExpandOrigin {
  return { box: toBox(element.getBoundingClientRect()), radius: cornerRadius(element) };
}

export function playExpandMotion(element: HTMLElement, origin: ExpandOrigin, motion: ExpandMotion): void {
  if (!motionAllowed(element)) return;
  running.get(element)?.forEach((animation) => animation.cancel());
  running.delete(element);
  const style = getComputedStyle(element);
  const duration = parseDuration(style.getPropertyValue(motion.duration));
  const curve = parseCubicBezier(style.getPropertyValue(motion.easing));
  if (!duration || !curve) return;
  const to = toBox(element.getBoundingClientRect());
  const unchanged = Math.abs(to.left - origin.box.left) < 0.5 && Math.abs(to.top - origin.box.top) < 0.5 &&
    Math.abs(to.width - origin.box.width) < 0.5 && Math.abs(to.height - origin.box.height) < 0.5;
  if (unchanged || [to, origin.box].some((box) => box.width < 1 || box.height < 1)) return;
  const children = motion.scale ? motionChildren(element) : [];
  const frames = expandFrames({
    from: origin.box,
    to,
    fromRadius: origin.radius,
    toRadius: cornerRadius(element),
    children: children.map((child) => relativeBox(child.getBoundingClientRect(), to)),
    ease: cubicBezier(...curve),
    scale: Boolean(motion.scale)
  });
  const timing: KeyframeAnimationOptions = { duration, easing: 'linear' };
  const keyframes = (pick: (frame: ExpandFrame) => FrameTransform) =>
    frames.map((frame) => ({ offset: frame.offset, transformOrigin: '0 0', transform: transformCss(pick(frame)) }));
  // While it moves it sits above its neighbours, and whatever it covers stays in view (the stylesheets read this).
  element.dataset.expandMotion = '';
  const animations = [
    element.animate(keyframes((frame) => frame.box), timing),
    ...(frames[0]?.radius ? [element.animate(frames.map((frame) => ({
      offset: frame.offset,
      borderRadius: `${round(frame.radius!.x)}px / ${round(frame.radius!.y)}px`
    })), timing)] : []),
    ...children.map((child, index) => child.animate(keyframes((frame) => frame.children[index]!), timing))
  ];
  // One start for the box and everything it holds, or a child would be counter-scaled a frame out of step.
  const start = document.timeline?.currentTime;
  if (typeof start === 'number') animations.forEach((animation) => { animation.startTime = start; });
  running.set(element, animations);
  void Promise.all(animations.map((animation) => animation.finished)).then(() => {
    if (running.get(element) !== animations) return;
    running.delete(element);
    delete element.dataset.expandMotion;
  }, () => undefined);
}

/**
 * The frames of one motion, in the final box's coordinates. The box goes from
 * `from` to `to` along the eased progress; each child (given relative to `to`)
 * is counter-scaled so it keeps its size on screen, pinned to the box's inline
 * end, and to its block end when it sits on that edge alone (a foot).
 */
export function expandFrames({ from, to, fromRadius, toRadius, children, ease, scale }: {
  from: Box;
  to: Box;
  fromRadius: number;
  toRadius: number;
  children: Box[];
  ease(progress: number): number;
  scale: boolean;
}): ExpandFrame[] {
  const frames: ExpandFrame[] = [];
  for (const offset of keyframeOffsets(ease)) {
    const eased = ease(offset);
    const width = scale ? lerp(from.width, to.width, eased) : to.width;
    const height = scale ? lerp(from.height, to.height, eased) : to.height;
    const left = lerp(from.left, to.left, eased);
    const top = lerp(from.top, to.top, eased);
    const scaleX = width / to.width;
    const scaleY = height / to.height;
    const radius = lerp(fromRadius, toRadius, eased);
    frames.push({
      offset,
      box: { x: left - to.left, y: top - to.top, scaleX, scaleY },
      radius: scale && (fromRadius > 0 || toRadius > 0) ? { x: radius / scaleX, y: radius / scaleY } : undefined,
      children: children.map((child) => {
        const pinnedToEnd = Math.abs(child.top + child.height - to.height) < 1 && child.top > 1;
        return {
          x: (width - to.width + child.left) / scaleX - child.left,
          y: (pinnedToEnd ? height - to.height + child.top : child.top) / scaleY - child.top,
          scaleX: 1 / scaleX,
          scaleY: 1 / scaleY
        };
      })
    });
  }
  return frames;
}

function keyframeOffsets(ease: (time: number) => number): number[] {
  const inner = Array.from({ length: TIME_STEPS - 1 }, (_, step) => (step + 1) / TIME_STEPS);
  for (let step = 1; step < PROGRESS_STEPS; step += 1) {
    // The time at which the curve reaches this progress; the curves the app uses only rise.
    const target = step / PROGRESS_STEPS;
    let low = 0;
    let high = 1;
    while (high - low > 1e-5) {
      const middle = (low + high) / 2;
      if (ease(middle) < target) low = middle;
      else high = middle;
    }
    inner.push((low + high) / 2);
  }
  const offsets = [0];
  for (const offset of inner.sort((a, b) => a - b)) {
    if (offset - offsets.at(-1)! > 1e-4 && offset < 1 - 1e-4) offsets.push(offset);
  }
  offsets.push(1);
  return offsets;
}

/** A CSS `cubic-bezier()` as a function of time to progress. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (time: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (time) => {
    if (time <= 0) return 0;
    if (time >= 1) return 1;
    let t = time;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const error = sampleX(t) - time;
      if (Math.abs(error) < 1e-6) return sampleY(t);
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let low = 0;
    let high = 1;
    t = time;
    while (high - low > 1e-6) {
      if (sampleX(t) < time) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return sampleY(t);
  };
}

export function parseCubicBezier(value: string): [number, number, number, number] | undefined {
  const match = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/u.exec(value);
  if (!match) return undefined;
  const points = match.slice(1).map(Number) as [number, number, number, number];
  return points.every(Number.isFinite) ? points : undefined;
}

export function parseDuration(value: string): number | undefined {
  const match = /^\s*([\d.]+)(ms|s)\s*$/u.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function motionAllowed(element: HTMLElement): boolean {
  return typeof element.animate === 'function' &&
    !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** The element's children, looking through boxes that do not render one (a portal slot). */
function motionChildren(element: HTMLElement): HTMLElement[] {
  return [...element.children].flatMap((child) =>
    !(child instanceof HTMLElement) ? []
      : getComputedStyle(child).display === 'contents' ? motionChildren(child)
        : [child]);
}

function cornerRadius(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
}

function toBox(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function relativeBox(rect: DOMRect, to: Box): Box {
  return { left: rect.left - to.left, top: rect.top - to.top, width: rect.width, height: rect.height };
}

function transformCss({ x, y, scaleX, scaleY }: FrameTransform): string {
  return `translate(${round(x)}px, ${round(y)}px) scale(${round(scaleX, 5)}, ${round(scaleY, 5)})`;
}

/** Never exponent notation, which CSS does not read. */
function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}
