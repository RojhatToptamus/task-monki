import { useLayoutEffect, useRef } from 'react';
import { afterLeavingLayers } from '../presence';

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
    const placeNow = () => {
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
    };
    // A new size or place, or a cover coming, moves the page in the same frame as its slot; a
    // cover going is still drawn while it leaves, so the page returns once it has gone, and
    // nothing places it before then (the observers below report once as they start).
    let settled = hidden;
    // Scrolls and resizes arrive many times a frame; the page follows once per frame.
    const place = () => {
      if (!settled) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(placeNow);
    };
    const settle = hidden ? undefined : afterLeavingLayers(() => {
      settled = true;
      placeNow();
    });
    if (hidden) placeNow();
    // The slot can move without changing size (the capture panel opening beside a page already at
    // its full size), so the space around it is watched too.
    const observer = new ResizeObserver(place);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    const workspace = element.closest('.tm-bugrecord');
    if (workspace) observer.observe(workspace);
    // A notice under the head moves the stage down without resizing the page's frame.
    const stage = element.closest('.tm-bugrecord__stage');
    if (stage) observer.observe(stage);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      settle?.();
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
