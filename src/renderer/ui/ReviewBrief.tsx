import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

export interface ReviewBriefContent {
  /** The task as asked. */
  asked?: string;
  /** What the implementation agent reported: a claim, quoted. */
  report?: { author: string; text: string };
  /** The reviewer's summary, quoted; the author names the runtime and model. */
  reviewer?: { author: string; summary?: string };
}

/**
 * The facts before the diff: what was asked, what the agent says it did, and
 * only then the reviewer's opinion, so the person forms a view before reading the
 * verdict. Folded, it is the request's first line.
 */
export function ReviewBrief({ content, folded, onFoldedChange }: {
  content: ReviewBriefContent;
  folded: boolean;
  onFoldedChange(folded: boolean): void;
}) {
  const bodyId = useId();
  const { asked, report, reviewer } = content;
  return (
    <section className="tm-review-brief" aria-label="Brief" data-folded={folded ? '' : undefined}>
      <button
        type="button"
        className="tm-review-brief__toggle"
        aria-expanded={!folded}
        aria-controls={bodyId}
        aria-label={folded ? 'Show the brief' : 'Fold the brief'}
        onClick={() => onFoldedChange(!folded)}
      >
        <ChevronRight size={13} aria-hidden="true" />
        {folded ? <span className="tm-review-brief__line">{asked ?? report?.text ?? reviewer?.summary}</span> : null}
      </button>
      {folded ? null : (
        <div id={bodyId} className="tm-review-brief__grid">
          {asked ? (
            <BriefBlock label="Request">
              <ClampedText lines={2} className="tm-review-brief__text">{asked}</ClampedText>
            </BriefBlock>
          ) : null}
          {report ? (
            <BriefBlock label={report.author}>
              <ClampedText lines={3} className="tm-review-brief__quote">{report.text}</ClampedText>
            </BriefBlock>
          ) : null}
          {reviewer?.summary ? (
            <BriefBlock label="Review" meta={reviewer.author}>
              <ClampedText lines={2} className="tm-review-brief__quote">{reviewer.summary}</ClampedText>
            </BriefBlock>
          ) : null}
        </div>
      )}
    </section>
  );
}

function BriefBlock({ label, meta, children }: { label: string; meta?: string; children: ReactNode }) {
  return (
    <div className="tm-review-brief__block">
      <h3 className="tm-review-brief__label">{label}{meta ? <span>{meta}</span> : null}</h3>
      {children}
    </div>
  );
}

/** Text clamped to a few lines; a click on it shows the rest when the clamp hides anything. */
function ClampedText({ lines, className, children }: { lines: 2 | 3; className: string; children: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  // Whether the clamp hides anything depends on the column's width, so it is measured again on resize.
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, expanded]);
  const clampable = overflowing || expanded;
  return (
    <p
      ref={text}
      className={`${className}${expanded ? '' : ` tm-review-brief__clamped--${lines}`}${clampable ? ' tm-review-brief__clampable' : ''}`}
      role={clampable ? 'button' : undefined}
      tabIndex={clampable ? 0 : undefined}
      aria-expanded={clampable ? expanded : undefined}
      onClick={clampable ? () => setExpanded((value) => !value) : undefined}
      onKeyDown={clampable ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded((value) => !value); } } : undefined}
    >
      {children}
    </p>
  );
}
