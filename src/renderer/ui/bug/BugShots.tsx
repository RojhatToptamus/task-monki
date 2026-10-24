import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BugShotView } from '../../../shared/bugReplay';
import { boxUnion, containRegion, focusRegion, outlineStyle, regionStyle } from '../../model/bugShot';
import { formatShortAge } from '../../model/timeAgo';
import { useDialogFocusBoundary } from '../dialogFocus';
import { ModalFrame } from '../ModalFrame';
import { useOpenReport } from '../presence';
import { useBugImage } from './BugImage';

/**
 * A kept screenshot framed on the elements its expectations read, each outlined and none left
 * outside the frame; `whole` draws the full page instead. A screenshot without outlines is
 * drawn whole.
 */
export function BugPicture({
  taskId,
  shot,
  viewport,
  aspect,
  whole = false,
  label
}: {
  taskId: string;
  shot: BugShotView;
  viewport: { width: number; height: number };
  /** The frame's width over its height. */
  aspect: number;
  whole?: boolean;
  label: string;
}) {
  const image = useBugImage(taskId, shot.fileId);
  // Without an outline to frame, the whole page sits inside the frame instead of filling it.
  const focus = whole ? undefined : boxUnion(shot.boxes.map((item) => item.box));
  const region = focus ? focusRegion(focus, viewport, aspect) : containRegion(viewport, aspect);
  return (
    <span className="tm-bugpic" style={{ aspectRatio: `${aspect}` }} role="img" aria-label={label}>
      {image.url ? (
        <>
          <img className="tm-bugpic__image" src={image.url} alt="" draggable={false} style={regionStyle(region, viewport)} />
          {shot.boxes.map(({ checkId, box }) => (
            <span key={checkId} className="tm-bugpic__outline" style={outlineStyle(box, region)} aria-hidden="true" />
          ))}
        </>
      ) : image.failed ? (
        <span className="tm-bugpic__missing">Screenshot unavailable</span>
      ) : null}
    </span>
  );
}

export type BugShotSide = 'before' | 'after';

/** The words under a screenshot: which side it is, and when it was taken. */
export function shotCaption(side: BugShotSide, shot: BugShotView): { name: string; at: string } {
  return { name: side === 'after' ? 'After' : shot.runId ? 'Before' : 'Recorded', at: shot.at };
}

/**
 * Before and after, one at a time in the same place, so the eye sees what changed: the
 * segmented control or the arrow keys switch sides and the outlines stay where they are.
 */
export function BugCompareDialog({
  taskId,
  title,
  shots,
  viewport,
  initial,
  onOpenChange,
  onClose
}: {
  taskId: string;
  /** The bug's name: the switch says which side is shown. */
  title: string;
  shots: { before?: BugShotView; after?: BugShotView };
  viewport: { width: number; height: number };
  initial: BugShotSide;
  /** Told while the dialog is open, so the page behind it is inert. */
  onOpenChange?(open: boolean): void;
  onClose(): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const switchRefs = useRef(new Map<BugShotSide, HTMLButtonElement>());
  const openedOn = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const sides = (['before', 'after'] as const).filter((side) => shots[side]);
  const [side, setSide] = useState<BugShotSide>(shots[initial] ? initial : sides[0] ?? 'before');
  // The pictures are read, not filled in: focus starts on the side shown, where the arrow keys
  // switch sides; with one side, on Close. No tooltip opens to take the first Escape.
  useDialogFocusBoundary({ dialogRef: panelRef, initialFocusRef: openedOn, busy: false, onClose });
  useOpenReport(onOpenChange);
  useEffect(() => {
    if (sides.length < 2) return;
    const onKey = (event: KeyboardEvent) => {
      const next = event.key === 'ArrowLeft' ? 'before' : event.key === 'ArrowRight' ? 'after' : undefined;
      if (!next) return;
      setSide(next);
      // On the switch, focus follows the side shown, as in any segmented control.
      if ([...switchRefs.current.values()].some((button) => button === document.activeElement)) switchRefs.current.get(next)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sides.length]);
  const shot = shots[side];
  if (!shot) return null;
  const caption = shotCaption(side, shot);
  return createPortal(
    <ModalFrame labelledBy={titleId} onDismiss={onClose}>
      <div ref={panelRef} className="tm-modal__panel tm-bugcompare" tabIndex={-1}>
        <div className="tm-bugcompare__head">
          <h3 id={titleId} title={title}>{title}</h3>
          <time className="tm-bugcompare__time" dateTime={caption.at} title={new Date(caption.at).toLocaleString()}>{formatShortAge(caption.at)}</time>
          {sides.length < 2 ? <span className="tm-bugcompare__side-name">{caption.name}</span> : null}
          {sides.length > 1 ? (
            <div className="segmented segmented--compact tm-bugcompare__switch" role="group" aria-label="Screenshot">
              {sides.map((option) => (
                <button key={option} ref={(element) => {
                  if (element) switchRefs.current.set(option, element);
                  else switchRefs.current.delete(option);
                  if (option === side && element && !openedOn.current) openedOn.current = element;
                }}
                type="button" className="segmented__btn" aria-pressed={side === option} onClick={() => setSide(option)}>
                  {shotCaption(option, shots[option]!).name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {/* Both sides are drawn in one place and only one is visible, so switching is the only change. */}
        <div className="tm-bugcompare__stack">
          {sides.map((option) => (
            <div key={option} className="tm-bugcompare__side" hidden={option !== side}>
              <BugPicture taskId={taskId} shot={shots[option]!} viewport={viewport} aspect={viewport.width / viewport.height} whole
                label={`${shotCaption(option, shots[option]!).name}: the page`} />
            </div>
          ))}
        </div>
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </ModalFrame>,
    document.body
  );
}
