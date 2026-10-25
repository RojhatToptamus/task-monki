import type { BugElementBox } from '../../shared/bugReplay';

/**
 * Where a screenshot is framed so the checked element reads at a glance: a region of the page
 * around the element, at the frame's aspect ratio, never past the page's edges, and never
 * narrower than the context a person needs to recognise where the element sits.
 */
export function focusRegion(
  box: BugElementBox | undefined,
  viewport: { width: number; height: number },
  aspect: number,
  context = { minWidth: 400, margin: 96 }
): BugElementBox {
  const whole = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (!box || aspect <= 0) return whole;
  let width = Math.min(viewport.width, Math.max(context.minWidth, box.width + context.margin * 2));
  let height = width / aspect;
  // A tall element widens the region until it fits with a margin above and below.
  const needed = box.height + context.margin / 2;
  if (height < needed) {
    height = Math.min(viewport.height, needed);
    width = Math.min(viewport.width, height * aspect);
    height = width / aspect;
  }
  if (height > viewport.height) {
    height = viewport.height;
    width = height * aspect;
  }
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const x = Math.min(Math.max(0, centerX - width / 2), Math.max(0, viewport.width - width));
  const y = Math.min(Math.max(0, centerY - height / 2), Math.max(0, viewport.height - height));
  return { x, y, width, height };
}

/** The smallest box around every outlined element, so a frame on it leaves none outside. */
export function boxUnion(boxes: readonly BugElementBox[]): BugElementBox | undefined {
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The whole page inside a frame of another aspect ratio, centred, with the frame's fill beside it. */
export function containRegion(viewport: { width: number; height: number }, aspect: number): BugElementBox {
  const pageAspect = viewport.width / viewport.height;
  if (aspect >= pageAspect) {
    const width = viewport.height * aspect;
    return { x: -(width - viewport.width) / 2, y: 0, width, height: viewport.height };
  }
  const height = viewport.width / aspect;
  return { x: 0, y: -(height - viewport.height) / 2, width: viewport.width, height };
}

/** CSS percentages that place a full-viewport image so `region` fills its frame. */
export function regionStyle(region: BugElementBox, viewport: { width: number; height: number }): { width: string; left: string; top: string } {
  return {
    width: `${(viewport.width / region.width) * 100}%`,
    left: `${(-region.x / region.width) * 100}%`,
    top: `${(-region.y / region.height) * 100}%`
  };
}

/** CSS percentages that outline `box` inside a frame showing `region`. */
export function outlineStyle(box: BugElementBox, region: BugElementBox): { left: string; top: string; width: string; height: string } {
  return {
    left: `${((box.x - region.x) / region.width) * 100}%`,
    top: `${((box.y - region.y) / region.height) * 100}%`,
    width: `${(box.width / region.width) * 100}%`,
    height: `${(box.height / region.height) * 100}%`
  };
}
