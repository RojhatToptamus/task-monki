import { useRef } from 'react';

/**
 * Which items of a live list arrived after it first showed: those fade in once as they mount
 * (DESIGN.md §12, arrivals), while the list makes room at once. Nothing fades on the list's
 * first render, when it remounts, when it re-sorts, or when text grows inside an item.
 */
export function useArrivals(keys: readonly string[], ready = true): (key: string) => boolean {
  forgetFinishedArrivals();
  const first = useRef<ReadonlySet<string>>(undefined);
  if (ready && !first.current) first.current = new Set(keys);
  const seen = first.current;
  return (key) => Boolean(seen && !seen.has(key));
}

let forgetting = false;

/**
 * An arrival fades once: when its fade ends the mark goes, so a row hidden and shown again (a
 * disclosure reopened, a panel that steps aside) never fades a second time. One listener for the
 * app's lifetime, installed by the first list that tracks arrivals.
 */
function forgetFinishedArrivals(): void {
  if (forgetting || typeof document === 'undefined') return;
  forgetting = true;
  document.addEventListener('animationend', (event) => {
    const target = event.target;
    if (target instanceof Element && target.hasAttribute('data-arrived')) target.removeAttribute('data-arrived');
  });
}
