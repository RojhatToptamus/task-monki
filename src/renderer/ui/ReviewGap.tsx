import type { MouseEvent as ReactMouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { ArrowDownFromLine, ArrowUpFromLine } from 'lucide-react';
import { gapSteps } from '../model/reviewContext';
import type { ReviewDiffRow } from '../model/reviewWorkspace';
import { Tooltip } from './Tooltip';
import { pluralize } from '../model/formatting';
import { keepInView } from './travel';
import { useReviewActions } from './useReviewModel';

type GapRow = Extract<ReviewDiffRow, { kind: 'gap' }>;

/**
 * The unchanged lines between two hunks, as one dense row. When the checkout
 * still holds the captured file, the row is the control: its label shows every
 * hidden line, and a gap longer than one step also opens 20 lines at a time from
 * the gutter, up from the change below or down from the change above. Revealed
 * lines become ordinary rows and the gap shrinks, or goes when none are left.
 */
export function ReviewGap({ row, onReveal }: { row: GapRow; onReveal?(from: number, to: number): void }) {
  const actions = useReviewActions();
  const words = pluralize(row.hidden, 'unchanged line');
  const heading = row.heading ? <code>{row.heading}</code> : null;
  if (!row.reveal || !onReveal) {
    return (
      <div className="tm-review-gap">
        {row.hidden > 0 ? <span>{words}</span> : null}
        {heading}
      </div>
    );
  }
  const steps = gapSteps(row.reveal);
  const reveal = (range: readonly [number, number]) => (event: ReactMouseEvent<HTMLElement>) =>
    revealInPlace(actions.scroller(), event, () => onReveal(range[0], range[1]));
  return (
    <div className="tm-review-gap tm-review-gap--open">
      {/* Fixed slots in the gutter, so each step sits in one place on every gap row. */}
      <span className="tm-review-gap__steps">
        {steps.up ? (
          <Tooltip label="Expand up">
            <button type="button" className="tm-iconbtn tm-review__mini tm-review-gap__step" aria-label="Expand up" onClick={reveal(steps.up)}>
              <ArrowUpFromLine size={13} aria-hidden="true" />
            </button>
          </Tooltip>
        ) : null}
        {steps.down ? (
          <Tooltip label="Expand down">
            <button type="button" className="tm-iconbtn tm-review__mini tm-review-gap__step tm-review-gap__step--down" aria-label="Expand down" onClick={reveal(steps.down)}>
              <ArrowDownFromLine size={13} aria-hidden="true" />
            </button>
          </Tooltip>
        ) : null}
      </span>
      <button type="button" className="tm-review-gap__all" aria-label={`Expand ${words}`} onClick={reveal([row.reveal.from, row.reveal.to])}>
        <span>{words}</span>
        {heading}
      </button>
    </div>
  );
}

/**
 * Reveals lines so that nothing above the gap moves: the file grows downward
 * from it, as it reads. The browser's scroll anchoring would otherwise pick a
 * row below and shift the page by part of the new height. A step whose button
 * goes (the gap is down to one step) hands focus to the gap's label, and a step
 * taken from the keyboard keeps its control in view, wherever the gap moved to.
 */
function revealInPlace(scroller: HTMLElement | null, event: ReactMouseEvent<HTMLElement>, reveal: () => void) {
  const control = event.currentTarget;
  const row = control.closest('.tm-review-gap');
  const top = scroller?.scrollTop;
  flushSync(reveal);
  if (scroller && top !== undefined) scroller.scrollTop = top;
  const focused = control.isConnected ? control : row?.isConnected ? row.querySelector<HTMLElement>('.tm-review-gap__all') : null;
  if (focused !== control) focused?.focus({ preventScroll: true });
  if (event.detail === 0 && scroller && focused) keepInView(scroller, focused);
}
