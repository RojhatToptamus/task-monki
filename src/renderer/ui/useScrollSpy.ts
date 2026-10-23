import { useEffect, useState, type RefObject } from 'react';
import { isTraveling } from './travel';

/**
 * The item being read in a scroller: of the elements carrying `attribute` (and
 * not hidden), the topmost one in the reading band, from the scroller's top down
 * to `offset(scroller)`. It returns that element's `attribute` value, and a setter
 * for a navigation that decides it. It follows the person's own scrolling: a
 * travel's scrolling is never read back, so a navigation's choice holds until the
 * person scrolls, and once they scroll above every item (an overview, a brief),
 * none is being read. It reads again when `itemsKey` names a new set of items,
 * keeping what a navigation chose when no item is in the band, or while a travel
 * is under way: the move decides what it lands on.
 *
 * `offset` must keep its identity between renders.
 */
export function useScrollSpy(
  scrollerRef: RefObject<HTMLElement | null>,
  attribute: string,
  offset: (scroller: HTMLElement) => number,
  itemsKey: string
): [string | undefined, (value: string | undefined) => void] {
  const [current, setCurrent] = useState<string>();

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    let scheduled = false;
    const read = (scrolled: boolean) => {
      const items = scroller.querySelectorAll(`[${attribute}]:not([hidden])`);
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      const index = topmostInBand(items.length, (position) => items[position]!.getBoundingClientRect(), top, top + offset(scroller));
      const value = index === undefined ? undefined : items[index]!.getAttribute(attribute) ?? undefined;
      if (value !== undefined || scrolled) setCurrent(value);
    };
    // One read a frame, however many scroll events it brings.
    const onScroll = () => {
      if (scheduled || isTraveling(scroller)) return;
      scheduled = true;
      frame = requestAnimationFrame(() => { scheduled = false; read(true); });
    };
    if (!isTraveling(scroller)) read(false);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(onScroll);
    resize.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollerRef, attribute, offset, itemsKey]);

  return [current, setCurrent];
}

/**
 * Of `count` boxes running down in document order, the topmost one in the band
 * from `top` to `bottom`: the first that reaches below `top`, when it starts
 * above `bottom`. Boxes stay in order, so the search halves and reads few of them.
 */
export function topmostInBand(count: number, box: (index: number) => { top: number; bottom: number }, top: number, bottom: number): number | undefined {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (box(middle).bottom > top) high = middle;
    else low = middle + 1;
  }
  return low < count && box(low).top < bottom ? low : undefined;
}
