import { scrollTopFor } from './travel';

/**
 * Places in the Review tab's scroller: where a move lands, the rows of a line,
 * and the place being read, which a mode switch keeps.
 */

/** About six lines of the code a band is about stay above it when it is moved to. */
const BAND_CONTEXT = 120;
/** Lines moved to keep three lines above them. */
const LINE_CONTEXT = 60;

/** An attribute value inside a selector's quotes. */
export function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * Where travel to an element leaves it: a file's head at the sticky line; a
 * stage just past its seam, so the seam never doubles the bar's line; a band or
 * lines under their file's stuck head, with code above them, never above the
 * file's own head.
 */
export function landing(scroller: HTMLElement, element: HTMLElement): number {
  if (element.hasAttribute('data-stage')) return scrollTopFor(scroller, element) + 1;
  const file = element.closest<HTMLElement>('[data-file-id]');
  if (file === element) return scrollTopFor(scroller, element);
  const context = element.hasAttribute('data-line-anchor') ? LINE_CONTEXT : BAND_CONTEXT;
  if (!file) return scrollTopFor(scroller, element, context);
  const head = file.querySelector('.tm-review-file__head')?.getBoundingClientRect().height ?? 0;
  return Math.max(scrollTopFor(scroller, file), scrollTopFor(scroller, element, head + context));
}

/** Rows of a file by their place (`lineAnchor`): every block's, latest last. */
export function linesOf(scope: ParentNode, anchors: readonly string[]): HTMLElement[] {
  return anchors.flatMap((anchor) => [...scope.querySelectorAll<HTMLElement>(`[data-line-anchor=${quoted(anchor)}]`)]);
}

/**
 * The place being read in a scroller: the file under way, and the first of its
 * lines under its head, with how far from the scroller's top it is; a mode
 * switch puts the same line at the same height. Above the files, such as on
 * the overview or the brief, no file is under way, whichever was read last.
 */
export function readPlace(scroller: HTMLElement, fileId: string | undefined): { fileId: string; lineAnchor?: string; offset: number } | undefined {
  const file = fileId ? [...scroller.querySelectorAll<HTMLElement>(`[data-file-id=${quoted(fileId)}]`)].find((element) => !element.hidden) : undefined;
  if (!fileId || !file) return undefined;
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  const bottom = top + scroller.clientHeight;
  const line = Math.max(top, file.querySelector('.tm-review-file__head')?.getBoundingClientRect().bottom ?? top);
  const row = [...file.querySelectorAll<HTMLElement>('[data-line-anchor]')].find((candidate) => {
    const box = candidate.getBoundingClientRect();
    return box.bottom > line + 1 && box.top < bottom;
  });
  if (row?.dataset.lineAnchor) return { fileId, lineAnchor: row.dataset.lineAnchor, offset: row.getBoundingClientRect().top - top };
  const box = file.getBoundingClientRect();
  return box.bottom > top && box.top < bottom ? { fileId, offset: Math.max(0, box.top - top) } : undefined;
}
