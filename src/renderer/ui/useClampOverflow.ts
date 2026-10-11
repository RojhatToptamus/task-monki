import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Whether a line-clamped element hides any of its text. That depends on the
 * width the text gets, so it is measured again when the element resizes. An
 * expanded element is not clamped, so its last measurement stands.
 */
export function useClampOverflow(ref: RefObject<HTMLElement | null>, expanded: boolean, content: unknown): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, expanded, content]);
  return overflowing;
}
