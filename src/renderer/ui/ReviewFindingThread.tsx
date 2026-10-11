import { useId, useState } from 'react';
import { Check, Undo2, X } from 'lucide-react';
import type { ReviewFindingDismissReason } from '../../shared/contracts';
import { findingLevel, formatFindingLocation } from '../model/findings';
import { isBlockingFinding } from '../model/reviewFollowUp';
import type { ReviewFindingView } from '../model/reviewWorkspace';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { Tooltip } from './Tooltip';
import { AgentMark } from './UiIcons';

/** Why a finding is dismissed: the reviewer is wrong, the code is so on purpose, or it waits. */
export const DISMISS_REASON_LABELS: Record<ReviewFindingDismissReason, string> = {
  NOT_A_PROBLEM: 'Incorrect',
  ACCEPTED: 'Intentional',
  DEFERRED: 'Won’t fix now'
};

const SETTLED_LABELS: Record<ReviewFindingDismissReason, string> = {
  NOT_A_PROBLEM: 'Marked incorrect',
  ACCEPTED: 'Marked intentional',
  DEFERRED: 'Won’t fix now'
};

export function severityLabel(finding: Pick<ReviewFindingView, 'severity'>): string {
  return findingLevel(finding.severity).label;
}

/** How a settled finding reads: dismissed with its reason and note, or withdrawn by the reviewer. */
export function settledLabel(finding: ReviewFindingView): string {
  if (finding.state === 'WITHDRAWN') return `Withdrawn by the reviewer${finding.revision?.reason ? `: ${finding.revision.reason}` : ''}`;
  const label = finding.dismissal?.reason ? SETTLED_LABELS[finding.dismissal.reason] : 'Dismissed';
  return finding.dismissal?.note ? `${label}: ${finding.dismissal.note}` : label;
}

/**
 * One finding under the line it is about: the reasoning, and Ask and Dismiss on
 * its title line, always visible. Blocker and Major go in the request; a Minor or
 * Nit is added from its title line. Dismissing asks why (incorrect, intentional,
 * or not now), optionally with a note; the next review honours the reason. A
 * dismissed or withdrawn finding folds to a line that keeps the reason.
 */
export function ReviewFindingThread({
  finding, round, focused, actionable, inRequest, dismissing, onDismissingChange, onFocus, onDismiss, onRestore, onAsk, onToggleInclude
}: {
  finding: ReviewFindingView;
  /** In a re-review: an earlier finding still open, or one the earlier review did not raise. */
  round?: 'STILL_OPEN' | 'NEW';
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
  const dismissItems: ActionMenuItem[] = [
    ...(Object.keys(DISMISS_REASON_LABELS) as ReviewFindingDismissReason[]).map((value) => ({
      id: value, label: DISMISS_REASON_LABELS[value], onSelect: () => { if (onDismiss) void run(() => onDismiss(finding.id, value)); }
    })),
    { id: 'note', label: 'With a note…', separated: true, onSelect: () => onDismissingChange(true) }
  ];
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
        {round ? <span className="tm-review-thread__round">{round === 'STILL_OPEN' ? 'Still open' : 'New'}</span> : null}
        <strong>{finding.title}</strong>
        {actionable ? (
          <span className="tm-review-thread__actions">
            {/* Blocker and Major are in the request already; a suggestion is added here. */}
            {!blocking && onToggleInclude ? (
              <Tooltip label={inRequest ? 'Take out of the request' : 'Add to the request'} shortcut="F">
                <button type="button" className="ghost-button tm-review-thread__include" aria-pressed={inRequest} onClick={() => onToggleInclude(finding.id)}>
                  {inRequest ? <><Check size={13} aria-hidden="true" />In request</> : 'Add to request'}
                </button>
              </Tooltip>
            ) : null}
            {onAsk ? (
              <Tooltip label="Ask about this finding" shortcut="A">
                <button type="button" className="tm-iconbtn tm-review__mini tm-review-thread__ask" aria-label="Ask about this finding" onClick={() => onAsk(finding.id)}>
                  <AgentMark />
                </button>
              </Tooltip>
            ) : null}
            {onDismiss ? (
              <ActionMenu
                className="tm-review-thread__dismiss-menu"
                label="Dismiss this finding"
                tooltip="Dismiss"
                side="bottom"
                trigger={<X size={13} aria-hidden="true" />}
                items={dismissItems}
              />
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
