import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { useStickToBottom, type StickToBottomInstance } from 'use-stick-to-bottom';

/**
 * Scroll state for a conversation log. It follows new output only while the
 * reader is at the bottom; `startAtBottom: false` keeps a restored position.
 */
export function useConversationScroll({ startAtBottom = true }: { startAtBottom?: boolean } = {}): StickToBottomInstance {
  const [motion] = useState(() => reducedMotion() ? 'instant' as const : undefined);
  const instance = useStickToBottom({ initial: startAtBottom ? 'instant' : false, resize: motion });
  const { scrollRef, scrollToBottom, state } = instance;
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    // Content observation alone misses window and composer height changes.
    const observer = new ResizeObserver(() => {
      if (state.isAtBottom) void scrollToBottom({ animation: 'instant', preserveScrollPosition: true });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scrollRef, scrollToBottom, state]);
  return { ...instance, scrollToBottom: (options) => instance.scrollToBottom(options ?? motion) };
}

const READER_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const READER_INTENT_MS = 600;

/**
 * A conversation log with an unobtrusive jump back to the latest output (AI
 * Elements Conversation). Opening a disclosure is reading, so it releases the
 * lock instead of pulling the view back to the end.
 */
export function Conversation({ instance, label, className = '', header, children, onScroll }: {
  instance: StickToBottomInstance;
  label: string;
  className?: string;
  header?: ReactNode;
  children: ReactNode;
  onScroll?(scroller: HTMLElement): void;
}) {
  const [headerVisible, setHeaderVisible] = useState(true);
  const scrollDirection = useRef({ top: 0, direction: 0, distance: 0 });
  // Only the reader's own scrolling moves the header. Following new output,
  // restoring a reading position and Jump to latest are programmatic.
  const readerIntent = useRef({ until: 0, dragging: false });
  const noteReaderScroll = () => { readerIntent.current.until = performance.now() + READER_INTENT_MS; };
  const trackScroll = (viewport: HTMLElement) => {
    if (header) {
      const top = Math.max(0, viewport.scrollTop);
      const previous = scrollDirection.current;
      const delta = top - previous.top;
      if (delta) {
        const direction = Math.sign(delta);
        const distance = direction === previous.direction ? previous.distance + Math.abs(delta) : Math.abs(delta);
        scrollDirection.current = { top, direction, distance };
        const byReader = readerIntent.current.dragging || performance.now() < readerIntent.current.until;
        if (top < 16) setHeaderVisible(true);
        else if (byReader && distance >= 12) setHeaderVisible(direction < 0);
      }
    }
    onScroll?.(viewport);
  };
  return <div className={`tm-conversation ${className}`.trim()}>
    <div ref={instance.scrollRef} className="tm-conversation__viewport" tabIndex={0} aria-label={label}
      onScroll={(event) => trackScroll(event.currentTarget)}
      onWheel={noteReaderScroll}
      onTouchMove={noteReaderScroll}
      onKeyDown={(event) => { if (READER_SCROLL_KEYS.has(event.key)) noteReaderScroll(); }}
      onPointerDown={(event) => { if (event.target === event.currentTarget) readerIntent.current.dragging = true; }}
      onPointerUp={() => { readerIntent.current.dragging = false; }}
      onPointerCancel={() => { readerIntent.current.dragging = false; }}
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest('[data-disclosure]')) instance.stopScroll();
      }}>
      <div ref={instance.contentRef} className="tm-conversation__content">
        {header ? <div className="tm-conversation__header" data-visible={headerVisible}>{header}</div> : null}
        {children}
      </div>
    </div>
    {instance.isAtBottom ? null : <button type="button" className="tm-conversation__latest" aria-label="Jump to latest" title="Jump to latest"
      onClick={(event) => {
        // The button hides itself once the view reaches the end. When it was
        // pressed from the keyboard (a click with no pointer detail), keep focus
        // in the conversation instead of letting it fall to the page.
        if (event.detail === 0 && event.currentTarget === document.activeElement) {
          instance.scrollRef.current?.focus({ preventScroll: true });
        }
        void instance.scrollToBottom();
      }}>
      <ArrowDown size={16} aria-hidden="true" />
    </button>}
  </div>;
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}
