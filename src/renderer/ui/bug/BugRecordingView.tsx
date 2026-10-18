import { useLayoutEffect, useRef } from 'react';

/** One counter for every show and hide, so a remounted view never sends an older request. */
let viewRequest = 0;

/**
 * Where the native recording view sits. The element reserves the space; the desktop app places
 * the page over it and hides it when the element goes away, hides itself, or gets too small.
 * Only bounds and identities cross the bridge.
 */
export function BugRecordingView({
  taskId,
  sessionId,
  hidden,
  width,
  height
}: {
  taskId: string;
  sessionId: string;
  /** A modal, a floating panel or a menu covers the view's place. */
  hidden: boolean;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bridge = window.bugRecordingView;
    const element = ref.current;
    if (!bridge || !element) return;
    let frame = 0;
    const hide = () => {
      viewRequest += 1;
      void bridge.hide({ taskId, sessionId, requestId: viewRequest }).catch(() => undefined);
    };
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        if (hidden || rect.width < 160 || rect.height < 100) {
          hide();
          return;
        }
        viewRequest += 1;
        void bridge.show({
          taskId,
          sessionId,
          requestId: viewRequest,
          bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        }).catch(() => undefined);
      });
    };
    place();
    // The slot can move without changing size (the capture panel opening beside a page already at
    // its full size), so the space around it is watched too.
    const observer = new ResizeObserver(place);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    const workspace = element.closest('.tm-bugrecord');
    if (workspace) observer.observe(workspace);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      hide();
    };
  }, [taskId, sessionId, hidden, width, height]);
  return (
    <div
      ref={ref}
      className="tm-bugview"
      style={{ width, height }}
      role="img"
      aria-label="The app being recorded"
    />
  );
}
