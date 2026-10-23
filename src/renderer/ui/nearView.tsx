import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

/**
 * Which boxes of the Review scroller are near enough to the view to render
 * their content. A change of a hundred files is thousands of rows; only those
 * within a viewport of the view are in the document, and a box further away
 * keeps the height its content last had, so the scroll never jumps. One
 * IntersectionObserver serves every box. Boxes are told where they stand when
 * the scroller connects and whenever that changes, before the frame paints.
 * Without an IntersectionObserver (a test document), every box is near.
 */
export class NearView {
  private observer?: IntersectionObserver;
  private root?: HTMLElement;
  private everywhere = false;
  private readonly boxes = new Map<Element, (near: boolean) => void>();
  /** Each content's last height, by what it shows and which part of it. */
  private readonly heights = new WeakMap<object, Map<number, number>>();

  /**
   * Watches the boxes within a viewport above and below `root`'s view. The
   * observer reports after a frame paints, so a jump further than that margin,
   * such as a move to another file, settles the boxes at once instead, and the
   * view never shows a box still empty.
   */
  connect(root: HTMLElement): () => void {
    if (typeof IntersectionObserver === 'undefined') {
      this.everywhere = true;
      for (const tell of this.boxes.values()) tell(true);
      return () => { this.everywhere = false; };
    }
    this.root = root;
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) this.boxes.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: '100% 0px' });
    this.settle();
    for (const element of this.boxes.keys()) this.observer.observe(element);
    let lastTop = root.scrollTop;
    const onScroll = () => {
      const jumped = Math.abs(root.scrollTop - lastTop) > root.clientHeight;
      lastTop = root.scrollTop;
      if (jumped) flushSync(() => this.settle());
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      this.observer?.disconnect();
      this.observer = undefined;
      this.root = undefined;
    };
  }

  /** Follows whether `element` is near the view. A box observed before the scroller connects learns it then. */
  observe(element: Element, tell: (near: boolean) => void): () => void {
    this.boxes.set(element, tell);
    if (this.everywhere) tell(true);
    else if (this.observer && this.root) {
      tell(isNear(element, this.root.getBoundingClientRect()));
      this.observer.observe(element);
    }
    return () => {
      this.boxes.delete(element);
      this.observer?.unobserve(element);
    };
  }

  height(content: object, part: number): number | undefined {
    return this.heights.get(content)?.get(part);
  }

  record(content: object, part: number, height: number): void {
    const parts = this.heights.get(content) ?? new Map<number, number>();
    parts.set(part, height);
    this.heights.set(content, parts);
  }

  /** Tells every box where it stands now. */
  private settle(): void {
    if (!this.root) return;
    const view = this.root.getBoundingClientRect();
    for (const [element, tell] of this.boxes) tell(isNear(element, view));
  }
}

/** Within a viewport above or below `view`, as the observer's margin reads it; never while not displayed, as under a hidden file. */
function isNear(element: Element, view: DOMRect): boolean {
  if (!isDisplayed(element)) return false;
  const box = element.getBoundingClientRect();
  return box.bottom >= view.top - view.height && box.top <= view.bottom + view.height;
}

/** A box laid out at all; one not displayed measures nothing, so its kept height and its place mean nothing. */
function isDisplayed(element: Element): boolean {
  return element.getClientRects().length > 0;
}

export const NearViewContext = createContext<NearView | undefined>(undefined);

/**
 * A box that holds its content while near the view, kept, or holding the
 * focus; elsewhere it is empty at the height the content last had, or at
 * `estimate()` before the content has rendered once. Outside a Review
 * scroller it always holds its content.
 */
export function NearBox({ className, keep = false, content, part = 0, estimate, children }: {
  className: string;
  /** The content stays wherever the box is, such as the place a move landed. */
  keep?: boolean;
  /** What the box shows, by which its height is kept: an object, and which part of it. */
  content: object;
  part?: number;
  estimate(): number;
  children(): ReactNode;
}) {
  const view = useContext(NearViewContext);
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(!view);
  const [holdsFocus, setHoldsFocus] = useState(false);
  useLayoutEffect(() => (view && ref.current ? view.observe(ref.current, setNear) : undefined), [view]);
  const shown = near || keep || holdsFocus;
  useLayoutEffect(() => {
    const box = ref.current;
    if (!shown || !view || !box || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => { if (isDisplayed(box)) view.record(content, part, box.offsetHeight); });
    observer.observe(box);
    return () => observer.disconnect();
  }, [content, part, shown, view]);
  return (
    <div
      ref={ref}
      className={className}
      style={shown ? undefined : { height: view?.height(content, part) ?? estimate() }}
      aria-hidden={shown ? undefined : true}
      onFocus={() => setHoldsFocus(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHoldsFocus(false); }}
    >
      {shown ? children() : null}
    </div>
  );
}
