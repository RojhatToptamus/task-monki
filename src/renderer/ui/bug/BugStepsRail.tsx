import { useLayoutEffect, useRef } from 'react';
import type { BugRecordingTimeline } from '../../../shared/bugReplay';
import { useArrivals } from '../arrivals';
import { BugStepIcon } from './BugStepIcon';

/**
 * What the recording has captured, as it happens: each step a replay will take, inputs it can't
 * replay, and what the page did that a person looks for when a bug shows (a failed or refused
 * request, an uncaught error). The newest row is at the bottom and stays in view unless the
 * person scrolled up to read.
 */
export function BugStepsRail({ timeline }: { timeline: BugRecordingTimeline | undefined }) {
  const listRef = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  const entries = timeline?.entries ?? [];
  const newest = entries[entries.length - 1]?.id;
  const arrived = useArrivals(entries.map((entry) => entry.id), entries.length > 0);

  // Follows the newest row while the person reads the bottom; a scroll up stops it.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && pinned.current) list.scrollTop = list.scrollHeight;
  }, [newest, entries.length]);

  return (
    <aside className="tm-bugrail" aria-label="Recorded steps">
      <header className="tm-bugrail__head">
        <h3 className="tm-bugrail__title">Steps</h3>
        <span className="tm-bugrail__count">{timeline?.steps ?? 0}</span>
      </header>
      {entries.length === 0 ? (
        <p className="tm-bugrail__empty">No steps yet</p>
      ) : (
        <ol
          ref={listRef}
          className="tm-bugrail__list"
          onScroll={(event) => {
            const list = event.currentTarget;
            pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
          }}
        >
          {timeline && timeline.omitted > 0 ? <li className="tm-bugrail__omitted">{timeline.omitted} earlier</li> : null}
          {entries.map((entry) => (
            <li key={entry.id} className="tm-bugstep" data-kind={entry.kind} data-tone={entry.tone} data-newest={entry.id === newest ? '' : undefined}
              data-arrived={arrived(entry.id) ? '' : undefined}>
              <span className="tm-bugstep__number" aria-hidden="true">{entry.step ?? ''}</span>
              <BugStepIcon kind={entry.kind} />
              <span className="tm-bugstep__text" title={entry.text}>{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
