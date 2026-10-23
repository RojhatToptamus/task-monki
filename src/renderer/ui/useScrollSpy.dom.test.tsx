import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScrollSpy } from './useScrollSpy';

const BAND = () => 200;

function Spy({ itemsKey }: { itemsKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useScrollSpy(ref, 'data-item', BAND, itemsKey);
  return (
    <div ref={ref} data-testid="scroller">
      <div data-item="a" />
      <div data-item="b" />
      <output>{current ?? 'none'}</output>
      <button type="button" onClick={() => setCurrent('b')}>Go to b</button>
    </div>
  );
}

/** Where each item is on screen; the scroller spans 0 to 600. */
let layout: Record<string, [number, number]> = {};

afterEach(() => vi.restoreAllMocks());

describe('the item being read', () => {
  it('is none once the person scrolls above every item, and a new set of items keeps what a navigation chose', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const [top, bottom] = this.getAttribute('data-testid') === 'scroller' ? [0, 600] : layout[this.getAttribute('data-item') ?? ''] ?? [0, 0];
      return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
    });
    layout = { a: [0, 300], b: [300, 900] };
    const { rerender } = render(<Spy itemsKey="one" />);
    expect(screen.getByRole('status').textContent).toBe('a');

    // Scrolled back up to what sits above the items, such as an overview: nothing is being read, so J starts at the first.
    layout = { a: [700, 900], b: [900, 1200] };
    fireEvent.scroll(screen.getByTestId('scroller'));
    expect(screen.getByRole('status').textContent).toBe('none');

    // A navigation chooses; the items changing under it, with none in the band, does not take the choice back.
    fireEvent.click(screen.getByRole('button', { name: 'Go to b' }));
    rerender(<Spy itemsKey="two" />);
    expect(screen.getByRole('status').textContent).toBe('b');
  });
});
