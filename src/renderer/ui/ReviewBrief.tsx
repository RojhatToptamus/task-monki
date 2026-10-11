import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DisclosureChevron } from './DisclosureChevron';

export interface ReviewBriefContent {
  /** The task as asked. */
  asked?: string;
  /** What the implementation agent reported: a claim, quoted. */
  report?: { author: string; text: string };
  /** The reviewer's summary, quoted, and its findings counted in words. */
  reviewer?: { author: string; summary?: string; counts?: string; status?: string };
  /** The change's size. */
  scope?: { files: number; additions: number; deletions: number };
}

/**
 * The facts before the diff: what was asked, what the agent says it did, the
 * scope, and only then the reviewer's opinion, so the person forms a view
 * before reading the verdict. Folded, it is one line.
 */
export function ReviewBrief({ content, folded, onFoldedChange }: {
  content: ReviewBriefContent;
  folded: boolean;
  onFoldedChange(folded: boolean): void;
}) {
  const bodyId = useId();
  const { asked, report, reviewer, scope } = content;
  const line = [
    asked ? 'Asked' : '',
    report ? `${report.author} reported` : '',
    reviewer ? (reviewer.status ?? 'Reviewer') + (reviewer.counts ? `: ${reviewer.counts}` : '') : ''
  ].filter(Boolean).join(' · ');
  return (
    <section className="tm-review-brief" aria-label="Brief">
      <button
        type="button"
        className="tm-review-brief__head"
        aria-expanded={!folded}
        aria-controls={bodyId}
        onClick={() => onFoldedChange(!folded)}
      >
        <DisclosureChevron />
        <span className="tm-review-brief__label">Brief</span>
        {folded ? <span className="tm-review-brief__line">{line}</span> : null}
      </button>
      {folded ? null : (
        <div id={bodyId} className="tm-review-brief__body">
          <div className="tm-review-brief__grid">
            {asked ? (
              <BriefBlock label="Asked">
                <ClampedText lines={2} className="tm-review-brief__text">{asked}</ClampedText>
              </BriefBlock>
            ) : null}
            {report ? (
              <BriefBlock label={`${report.author} reported`}>
                <ClampedText lines={3} className="tm-review-brief__quote">{report.text}</ClampedText>
              </BriefBlock>
            ) : null}
            {reviewer ? (
              <BriefBlock label="Reviewer" meta={reviewer.author}>
                {reviewer.summary ? <ClampedText lines={2} className="tm-review-brief__quote">{reviewer.summary}</ClampedText> : null}
                {reviewer.counts ? <p className="tm-review-brief__counts">{reviewer.counts}</p> : null}
              </BriefBlock>
            ) : null}
          </div>
          {scope ? (
            <p className="tm-review-brief__scope">
              <span className="tm-review-brief__scope-label">Scope</span>
              <span>{scope.files} file{scope.files === 1 ? '' : 's'}</span>
              <span className="tm-review-stat">
                {scope.additions ? <span className="tm-review-stat__add">+{scope.additions}</span> : null}
                {scope.deletions ? <span className="tm-review-stat__del">−{scope.deletions}</span> : null}
              </span>
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function BriefBlock({ label, meta, children }: { label: string; meta?: string; children: ReactNode }) {
  return (
    <div className="tm-review-brief__block">
      <h3 className="tm-review-brief__block-label">{label}{meta ? <span>{meta}</span> : null}</h3>
      {children}
    </div>
  );
}

/** Text clamped to a few lines, with More when the clamp hides anything. */
function ClampedText({ lines, className, children }: { lines: 2 | 3; className: string; children: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textId = useId();
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
  return (
    <div className="tm-review-brief__clamp">
      <p ref={text} id={textId} className={`${className}${expanded ? '' : ` tm-review-brief__clamped--${lines}`}`}>{children}</p>
      {overflowing || expanded ? (
        <button type="button" className="tm-osection__link" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Less' : 'More'}
        </button>
      ) : null}
    </div>
  );
}
