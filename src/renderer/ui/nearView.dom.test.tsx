import { act, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NearBox, NearView, NearViewContext } from './nearView';

/*
 * Windowing in a laid-out document: the scroller's view is 0 to 500, and box i
 * spans i * 1000 to i * 1000 + 1000 less the scroll, so a box is near while it
 * lies within a viewport of the view. Rendered content is 640 tall.
 */
const CONTENT = Array.from({ length: 8 }, (_, index) => ({ index }));
let scrollTop = 0;
let observer: { report(index: number, near: boolean): void } | undefined;
let resized: (() => void) | undefined;

function Boxes({ keep, hiddenFrom }: { keep?: number; hiddenFrom?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [view] = useState(() => new NearView());
  useLayoutEffect(() => (rootRef.current ? view.connect(rootRef.current) : undefined), [view]);
  return (
    <div ref={rootRef} data-testid="scroller">
      <NearViewContext.Provider value={view}>
        {CONTENT.map((content) => (
          <section key={content.index} data-box={content.index} hidden={hiddenFrom !== undefined && content.index >= hiddenFrom}>
            <NearBox className="box" content={content} keep={keep === content.index} estimate={() => 100}>
              {() => <p data-height="640">Rows of box {content.index}</p>}
            </NearBox>
          </section>
        ))}
      </NearViewContext.Provider>
    </div>
  );
}

const rows = () => screen.queryAllByText(/^Rows of box/).map((row) => row.textContent);
const box = (index: number) => document.querySelector<HTMLElement>(`[data-box="${index}"] > .box`)!;

beforeEach(() => {
  scrollTop = 0;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const index = this.closest('[data-box]')?.getAttribute('data-box');
    const [top, bottom] = this.getAttribute('data-testid') === 'scroller' ? [0, 500]
      : index === undefined || index === null ? [0, 0] : [Number(index) * 1000 - scrollTop, Number(index) * 1000 + 1000 - scrollTop];
    return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
  });
  // What is not displayed has no boxes, as under a hidden file.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.closest('[hidden]') ? [] : [this.getBoundingClientRect()]) as unknown as DOMRectList;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Number(this.querySelector('[data-height]')?.getAttribute('data-height') ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => scrollTop);
  vi.stubGlobal('IntersectionObserver', class {
    private readonly targets = new Map<number, Element>();
    constructor(private readonly callback: IntersectionObserverCallback) {
      observer = { report: (index, near) => this.callback([{ target: this.targets.get(index)!, isIntersecting: near } as IntersectionObserverEntry], this as never) };
    }
    observe(element: Element) { this.targets.set(Number(element.closest('[data-box]')!.getAttribute('data-box')), element); }
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { const previous = resized; resized = () => { previous?.(); callback([], this as never); }; }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  resized = undefined;
  observer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('boxes near the view', () => {
  it('hold their content only near the view or when kept, and an empty box keeps the height its content last had', () => {
    render(<Boxes keep={5} />);
    expect(rows()).toEqual(['Rows of box 0', 'Rows of box 1', 'Rows of box 5']);
    // Before it has rendered once, a box holds its estimate.
    expect(box(3).style.height).toBe('100px');

    act(() => resized?.());
    act(() => observer?.report(0, false));
    expect(rows()).toEqual(['Rows of box 1', 'Rows of box 5']);
    expect(box(0).style.height).toBe('640px');
  });

  it('settles a jump past the observer\'s margin before the frame paints, so the view never shows an empty box', () => {
    render(<Boxes />);
    scrollTop = 5000;
    fireEvent.scroll(screen.getByTestId('scroller'));
    // No observer report came: the scroll itself put the rows there, and took those it left.
    expect(rows()).toEqual(['Rows of box 4', 'Rows of box 5', 'Rows of box 6']);
  });

  it('never counts a box under a hidden file as near, nor keeps its height as nothing', () => {
    const { rerender } = render(<Boxes />);
    act(() => resized?.());
    // Another file shown alone hides this one; its rows go, and it comes back at the height it had.
    rerender(<Boxes hiddenFrom={0} />);
    scrollTop = 3000;
    fireEvent.scroll(screen.getByTestId('scroller'));
    act(() => resized?.());
    expect(rows()).toEqual([]);
    scrollTop = 0;
    rerender(<Boxes />);
    fireEvent.scroll(screen.getByTestId('scroller'));
    expect(box(0).style.height).toBe('');
    expect(rows()).toEqual(['Rows of box 0', 'Rows of box 1']);
  });
});
