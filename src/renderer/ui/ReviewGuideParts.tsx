import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { GuideAttention, GuideInline, GuideRun, GuideSpan } from '../model/reviewWalkthrough';
import { severityLabel } from './ReviewFindingThread';
import { Tooltip } from './Tooltip';
import { AgentMark } from './UiIcons';
import { useClampOverflow } from './useClampOverflow';
import type { ReviewActions } from './useReviewModel';

/** The walkthrough's words with their code spans. */
export function GuideInlines({ parts }: { parts: readonly GuideInline[] }) {
  return <>{parts.map((part, index) => (part.kind === 'code' ? <code key={index}>{part.text}</code> : part.text))}</>;
}

/** "Walkthrough by" and the agent that wrote it, said once for the whole Guide. */
export function GuideByline({ author, children }: { author?: string; children?: ReactNode }) {
  return (
    <p className="tm-review-guide__byline">
      <AgentMark />
      <span>Walkthrough{author ? <> by <b>{author}</b></> : null}</span>
      {children}
    </p>
  );
}

/**
 * A stage's explanation: its words, and its terms tied to the lines that
 * implement them. Stacked, it keeps three lines until asked for in full.
 */
export function GuideExplanation({ spans, actions }: { spans: readonly GuideSpan[]; actions: ReviewActions }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const overflowing = useClampOverflow(ref, expanded, spans);
  return (
    <>
      <p ref={ref} className={`tm-review-guide__explanation${expanded ? '' : ' tm-review-guide__explanation--clamped'}`}>
        {spans.map((span, index) => (span.kind === 'term'
          ? <GuideTerm key={span.id} term={span} actions={actions} />
          : <GuideInlines key={index} parts={span.inlines} />))}
      </p>
      {overflowing || expanded ? (
        <button type="button" className="tm-review-guide__more-words" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}

/**
 * A term: a phrase of the explanation tied to the lines that implement it.
 * Under the pointer or the keys its lines light where they are in view, without
 * rendering a row, and after a moment it names them; pressed, it opens whatever
 * hides them, moves there and keeps them chosen until the next move. It reads
 * inside the sentence, so it wraps as the words around it do.
 */
function GuideTerm({ term, actions }: { term: Extract<GuideSpan, { kind: 'term' }>; actions: ReviewActions }) {
  const { fileId, anchors, label } = term.target;
  const light = () => actions.lightLines(fileId, anchors);
  const clear = () => actions.lightLines();
  const go = () => actions.showLines(fileId, anchors, { mark: true });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    go();
  };
  return (
    <Tooltip label={label} side="top">
      <span role="button" tabIndex={0} className="tm-review-guide__term" onPointerEnter={light} onPointerLeave={clear} onFocus={light} onBlur={clear}
        onClick={go} onKeyDown={onKeyDown}>
        <GuideInlines parts={term.inlines} />
      </span>
    </Tooltip>
  );
}

/**
 * What deserves attention: each fact, and under one that lands on a finding,
 * the finding's file and line. A finding's fact leads with its severity. A fact
 * that lands on a file already names it.
 */
export function GuideAttentionList({ items, actions }: { items: readonly GuideAttention[]; actions: ReviewActions }) {
  const go = (item: GuideAttention) => {
    if (item.target?.kind === 'finding') actions.showFinding(item.target.findingId);
    else if (item.target?.kind === 'file') actions.showFile(item.target.fileId, { open: true });
    else actions.showStage(item.stage);
  };
  return (
    <section className="tm-review-guide__attention" aria-label="Attention">
      <h3 className="tm-review-guide__label">Attention</h3>
      <ol>
        {items.map((item, index) => (
          <li key={index}>
            <button type="button" className="tm-review-guide__fact" onClick={() => go(item)}>
              <span className="tm-review-guide__fact-text">
                {item.target?.kind === 'finding' ? (
                  <><span className="tm-review__severity" data-severity={item.target.severity}>{severityLabel(item.target)}</span>{' '}</>
                ) : null}
                <GuideInlines parts={item.text} />
              </span>
              {item.target?.kind === 'finding' ? <span className="tm-review-guide__place">{item.target.place}</span> : null}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * What a run of a file's rows is: a key change under the walkthrough's caption
 * and the symbol it sits in, or, for the rest of a file, where the run is, as a
 * gap row says it.
 */
export function GuideRunLabel({ label }: { label: GuideRun['label'] }) {
  if (label.kind === 'place') {
    return (
      <div className="tm-review-gap">
        <span>{label.lines}</span>
        {label.heading ? <code>{label.heading}</code> : null}
      </div>
    );
  }
  if (!label.caption && !label.symbol) return null;
  return (
    <div className="tm-review-guide__caption">
      {label.caption ? <span>{label.caption}</span> : null}
      {label.symbol ? <code>{label.symbol}</code> : null}
    </div>
  );
}
