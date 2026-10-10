import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation, useConversationScroll } from './Conversation';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion'),
    addEventListener() {},
    removeEventListener() {}
  }));
});

function History() {
  const scroller = useConversationScroll({ startAtBottom: false });
  return (
    <Conversation instance={scroller} label="Session history" header={<h1>Task title</h1>}>
      <p>Long history</p>
    </Conversation>
  );
}

function scrollTo(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  fireEvent.scroll(viewport);
}

describe('Conversation header', () => {
  it('stays visible when the view moves without the reader scrolling', () => {
    render(<History />);
    const viewport = screen.getByLabelText('Session history');
    const header = screen.getByRole('heading', { name: 'Task title' }).parentElement!;

    // Following output or restoring a position moves the view programmatically.
    scrollTo(viewport, 400);
    expect(header.dataset.visible).toBe('true');
  });

  it('hides when the reader scrolls down and returns when they scroll back up', () => {
    render(<History />);
    const viewport = screen.getByLabelText('Session history');
    const header = screen.getByRole('heading', { name: 'Task title' }).parentElement!;

    fireEvent.wheel(viewport, { deltaY: 120 });
    scrollTo(viewport, 200);
    expect(header.dataset.visible).toBe('false');

    fireEvent.wheel(viewport, { deltaY: -60 });
    scrollTo(viewport, 150);
    expect(header.dataset.visible).toBe('true');
  });

  it('treats keyboard scrolling in the history as the reader scrolling', () => {
    render(<History />);
    const viewport = screen.getByLabelText('Session history');
    const header = screen.getByRole('heading', { name: 'Task title' }).parentElement!;

    fireEvent.keyDown(viewport, { key: 'PageDown' });
    scrollTo(viewport, 300);
    expect(header.dataset.visible).toBe('false');

    fireEvent.keyDown(viewport, { key: 'Home' });
    scrollTo(viewport, 0);
    expect(header.dataset.visible).toBe('true');
  });
});
