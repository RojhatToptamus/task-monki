import { useLayoutEffect, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { useStickToBottom, type StickToBottomInstance } from 'use-stick-to-bottom';
import { Tooltip } from './Tooltip';

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

/**
 * A conversation log with an unobtrusive jump back to the latest output (AI
 * Elements Conversation). Opening a disclosure is reading, so it releases the
 * lock instead of pulling the view back to the end.
 */
export function Conversation({ instance, label, className = '', header, children, onScroll }: {
  instance: StickToBottomInstance;
  label: string;
  className?: string;
  /** Stays at the top of the view while the history scrolls beneath it (the task's tabs). */
  header?: ReactNode;
  children: ReactNode;
  onScroll?(scroller: HTMLElement): void;
}) {
  return <div className={`tm-conversation ${className}`.trim()}>
    <div ref={instance.scrollRef} className="tm-conversation__viewport" tabIndex={0} aria-label={label}
      onScroll={onScroll ? (event) => onScroll(event.currentTarget) : undefined}
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest('[data-disclosure]')) instance.stopScroll();
      }}>
      <div ref={instance.contentRef} className="tm-conversation__content">
        {header ? <div className="tm-conversation__header">{header}</div> : null}
        {children}
      </div>
    </div>
    {/* Always mounted so it can fade in and out; hidden, it is inert and out
        of the accessibility tree. */}
    <Tooltip label="Jump to latest" side="top">
      <button type="button" className="tm-conversation__latest" aria-label="Jump to latest"
        data-visible={!instance.isAtBottom}
        aria-hidden={instance.isAtBottom ? true : undefined}
        inert={instance.isAtBottom ? true : undefined}
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
      </button>
    </Tooltip>
  </div>;
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}
