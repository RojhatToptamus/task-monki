import { useId, useState } from 'react';
import { Check, Undo2, X } from 'lucide-react';
import type { ReviewFindingDismissReason } from '../../shared/contracts';
import { findingLevel, formatFindingLocation } from '../model/findings';
import { isBlockingFinding } from '../model/reviewFollowUp';
import type { ReviewFindingView } from '../model/reviewWorkspace';
import { Tooltip } from './Tooltip';
import { AgentMark } from './UiIcons';

export const DISMISS_REASON_LABELS: Record<ReviewFindingDismissReason, string> = {
  NOT_A_PROBLEM: 'Not a problem',
  ACCEPTED: 'Acceptable as is'
};

export function severityLabel(finding: Pick<ReviewFindingView, 'severity'>): string {
  return findingLevel(finding.severity).label;
}

/** How a settled finding reads: dismissed with its reason and note, or withdrawn by the reviewer. */
export function settledLabel(finding: ReviewFindingView): string {
  if (finding.state === 'WITHDRAWN') return `Withdrawn by the reviewer${finding.revision?.reason ? `: ${finding.revision.reason}` : ''}`;
  const reason = finding.dismissal?.reason ? DISMISS_REASON_LABELS[finding.dismissal.reason].toLowerCase() : '';
  const why = [reason, finding.dismissal?.note ?? ''].filter(Boolean).join(': ');
  return `Dismissed${why ? `: ${why}` : ''}`;
}

/**
 * One finding under the line it is about. An open finding shows the reasoning,
 * whether it is in the request, and Ask and Dismiss, always visible. Dismissing
 * asks why: the reviewer was wrong, or it is acceptable as is. A dismissed or
 * withdrawn finding folds to a line that keeps the reason.
 */
export function ReviewFindingThread({
  finding, focused, actionable, inRequest, dismissing, onDismissingChange, onFocus, onDismiss, onRestore, onAsk, onToggleInclude
}: {
  finding: ReviewFindingView;
  focused: boolean;
  actionable: boolean;
  inRequest: boolean;
  dismissing: boolean;
  onDismissingChange(open: boolean): void;
  onFocus(): void;
  onDismiss?(findingId: string, reason: ReviewFindingDismissReason, note?: string): Promise<void>;
  onRestore?(findingId: string): Promise<void>;
  onAsk?(findingId: string): void;
  onToggleInclude?(findingId: string): void;
}) {
  const [reason, setReason] = useState<ReviewFindingDismissReason>('NOT_A_PROBLEM');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteId = useId();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      onDismissingChange(false);
      setNote('');
    } catch {
      // The shell reports the error; the thread keeps its input for a retry.
    } finally {
      setBusy(false);
    }
  };

  if (finding.state !== 'OPEN') {
    return (
      <div className="tm-review-thread tm-review-thread--folded" data-finding-id={finding.id} tabIndex={-1}>
        <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
        <span className="tm-review-thread__struck">{finding.title}</span>
        <span>{settledLabel(finding)}</span>
        {finding.state === 'DISMISSED' && actionable && onRestore ? (
          <button type="button" className="ghost-button tm-review-thread__undo" disabled={busy} onClick={() => void run(() => onRestore(finding.id))}>
            <Undo2 size={13} aria-hidden="true" />Restore
          </button>
        ) : null}
      </div>
    );
  }

  const blocking = isBlockingFinding(finding);
  return (
    <article
      className={`tm-review-thread${focused ? ' tm-review-thread--focused' : ''}${actionable ? '' : ' tm-review-thread--earlier'}`}
      data-finding-id={finding.id}
      tabIndex={-1}
      onFocus={onFocus}
      aria-label={`${severityLabel(finding)} finding: ${finding.title}`}
    >
      <header className="tm-review-thread__head">
        <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
        <strong>{finding.title}</strong>
        {actionable && (onAsk || onDismiss) ? (
          <span className="tm-review-thread__actions">
            {onAsk ? (
              <Tooltip label="Ask the reviewer" shortcut="A">
                <button type="button" className="tm-iconbtn tm-review-thread__ask" aria-label="Ask the reviewer about this finding" onClick={() => onAsk(finding.id)}>
                  <AgentMark />
                </button>
              </Tooltip>
            ) : null}
            {onDismiss ? (
              <Tooltip label="Dismiss" shortcut="D">
                <button type="button" className="tm-iconbtn" aria-label="Dismiss this finding" aria-expanded={dismissing} onClick={() => onDismissingChange(!dismissing)}>
                  <X size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
          </span>
        ) : null}
      </header>
      {finding.path && !finding.line ? <span className="tm-review-thread__location">{formatFindingLocation(finding)}</span> : null}
      <p className="tm-review-thread__why">{finding.explanation}</p>
      {finding.recommendation ? <p className="tm-review-thread__fix">{finding.recommendation}</p> : null}
      {finding.revision ? (
        <p className="tm-review-thread__revision">
          {finding.revision.kind === 'ADD' ? 'Added by the reviewer' : `Reviewer changed this from ${findingLevel(finding.originalSeverity ?? finding.severity).label}`}: {finding.revision.reason}
        </p>
      ) : null}
      {!actionable ? <p className="tm-review-thread__earlier">From the earlier review</p> : null}
      {actionable && !dismissing ? (
        <footer className="tm-review-thread__request">
          {blocking ? (
            <><span className="tm-review-thread__included"><Check size={12} aria-hidden="true" />In the request</span><span>Blocks finishing</span></>
          ) : inRequest ? (
            <>
              <span className="tm-review-thread__included"><Check size={12} aria-hidden="true" />In the request</span>
              {onToggleInclude ? <button type="button" className="ghost-button" onClick={() => onToggleInclude(finding.id)}>Take out</button> : null}
            </>
          ) : (
            <>
              {onToggleInclude ? <button type="button" className="outline-button button--sm" onClick={() => onToggleInclude(finding.id)}>Add to request</button> : null}
              <span>A suggestion: not sent unless you add it.</span>
            </>
          )}
        </footer>
      ) : null}
      {dismissing && onDismiss ? (
        <form className="tm-review-thread__dismiss" onSubmit={(event) => { event.preventDefault(); void run(() => onDismiss(finding.id, reason, note.trim() || undefined)); }}>
          <div className="segmented" role="group" aria-label="Why dismiss it">
            {(Object.keys(DISMISS_REASON_LABELS) as ReviewFindingDismissReason[]).map((value) => (
              <button key={value} type="button" className="segmented__btn" aria-pressed={reason === value} onClick={() => setReason(value)}>
                {DISMISS_REASON_LABELS[value]}
              </button>
            ))}
          </div>
          <label className="tm-visually-hidden" htmlFor={noteId}>A note for the next review (optional)</label>
          <input
            id={noteId}
            autoFocus
            type="text"
            maxLength={500}
            value={note}
            placeholder="Add a note"
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onDismissingChange(false); } }}
          />
          <button type="button" className="ghost-button" onClick={() => onDismissingChange(false)}>Cancel</button>
          <button type="submit" className="outline-button button--sm" disabled={busy}>Dismiss</button>
        </form>
      ) : null}
    </article>
  );
}
