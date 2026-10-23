import { memo, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Check, MessageSquare } from 'lucide-react';
import type { DiffFile } from '../model/diffEvidence';
import { DiffStat } from './DiffStat';

/**
 * Files as navigator rows, with one `--sel` plane under the current row. When
 * the current file changes, the plane slides to its row (`--motion-move`,
 * `--ease-in-out`); when the rows move under it, or it first appears, it is
 * already there.
 */
export function ReviewFileList({ current, children }: {
  /** The current file's id; its row carries `aria-current`. */
  current?: string;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLSpanElement>(null);
  const placed = useRef<{ id?: string; top: number; height: number }>(undefined);
  // After every render: rows can move without the current file changing. The
  // plane spans the list's width, as every row does, so only its line is placed.
  useLayoutEffect(() => {
    const plane = planeRef.current;
    if (!plane) return;
    const row = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!row) {
      plane.hidden = true;
      placed.current = undefined;
      return;
    }
    const last = placed.current;
    const line = { id: current, top: row.offsetTop, height: row.offsetHeight };
    placed.current = line;
    if (last && last.top === line.top && last.height === line.height) return;
    const slide = last !== undefined && last.id !== current;
    if (!slide) plane.style.transition = 'none';
    plane.hidden = false;
    plane.style.transform = `translateY(${line.top}px)`;
    plane.style.height = `${line.height}px`;
    if (!slide) {
      // The plane takes its place before its transition is back.
      void plane.offsetWidth;
      plane.style.removeProperty('transition');
    }
  });
  return (
    <div ref={listRef} className="tm-review-files">
      <span ref={planeRef} className="tm-review-files__sel" aria-hidden="true" hidden />
      {children}
    </div>
  );
}

/**
 * A file in a navigator: its name in mono and its folder muted, a count of
 * what is said about it when anything is, then its counts or the viewed check.
 */
export const ReviewFileRow = memo(function ReviewFileRow({ file, current, viewed, feedback, blocking, onSelect }: {
  file: DiffFile;
  current: boolean;
  viewed: boolean;
  /** Open findings, open discussions and the person's comments on the file. */
  feedback: number;
  /** An open finding in it blocks the change. */
  blocking: boolean;
  onSelect(fileId: string): void;
}) {
  const parts = file.path.split('/');
  const name = parts.pop() ?? file.path;
  return (
    <button
      type="button"
      className={`tm-review__index-file${viewed ? ' tm-review__index-file--viewed' : ''}`}
      aria-current={current ? 'true' : undefined}
      onClick={() => onSelect(file.id)}
    >
      <span className="tm-review__index-path">
        <span className="tm-review__index-name">{name}</span>
        {parts.length ? <span className="tm-review__index-dir">{parts.join('/')}</span> : null}
      </span>
      {feedback ? (
        <span className="tm-review__index-feedback" data-tone={blocking ? 'blocked' : undefined}>
          <MessageSquare size={13} aria-hidden="true" />{feedback}
          <span className="tm-visually-hidden"> {feedback === 1 ? 'note' : 'notes'}</span>
        </span>
      ) : null}
      {viewed ? <Check size={13} className="tm-review__index-viewed" aria-label="Viewed" /> : <DiffStat additions={file.additions} deletions={file.deletions} />}
    </button>
  );
});
