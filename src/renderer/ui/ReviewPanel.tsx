import type {
  AgentReviewGateProjection,
  ClientTextExcerpt,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import { effectiveReviewFindings, type EffectiveReviewFinding } from '../../shared/agentReviewFindings';
import type { ReviewActivityViewModel } from '../model/reviewActivity';
import { FINDING_LEVELS } from '../model/findings';
import { formatTaskActivityTimestamp } from './TaskActivityPanel';
import { RunHeader } from './RunHeader';
import { StatusGlyph, type StatusGlyphKind } from './StatusBadge';
import { DisclosureChevron } from './DisclosureChevron';
import {
  describeGitSnapshot,
  describeReviewedDiff
} from './gitSnapshotCopy';
import type { Tone } from '../model/viewTypes';

export type ReviewActionPauseReason =
  | 'review-starting'
  | 'review-running'
  | 'implementation-running'
  | 'delivery-running';

export function ReviewPanel({
  reviewGate,
  reviewRun,
  gitSnapshot,
  reviewActivity,
  actionBusy,
  reviewPending,
  textExcerpt,
  loadedReviewOutput,
  reviewOutputLoading = false,
  reviewOutputError,
  onLoadReviewOutput = () => undefined,
  onStopReview,
  showVerdict = true,
  reviewerName = 'Reviewer',
  onOpenReview
}: {
  reviewGate: AgentReviewGateProjection;
  reviewRun?: RunRecord;
  gitSnapshot?: GitSnapshotRecord;
  reviewActivity?: ReviewActivityViewModel;
  actionBusy: boolean;
  reviewPending: boolean;
  textExcerpt?: ClientTextExcerpt;
  loadedReviewOutput?: string;
  reviewOutputLoading?: boolean;
  reviewOutputError?: string;
  onLoadReviewOutput?(): void;
  onStopReview(reviewRunId: string): void;
  /** False when the Now panel already states this verdict as the task's step. */
  showVerdict?: boolean;
  /** The reviewing runtime's name, so its summary is never read as Task Monki's verdict. */
  reviewerName?: string;
  /** Opens the Review tab, where the findings sit on the code. */
  onOpenReview?(): void;
}) {
  const effectiveStatus = reviewPending ? 'RUNNING' : reviewGate.status;
  const ui = reviewGateUi(effectiveStatus);
  const canStopReview = Boolean(reviewRun && effectiveStatus === 'RUNNING' && !reviewPending);
  const currentDiff = describeGitSnapshot(gitSnapshot);
  const reviewedDiff = reviewPending ? currentDiff : describeReviewedDiff(reviewGate, gitSnapshot);
  const reviewedHead = (reviewGate.reviewedHeadSha ?? gitSnapshot?.headSha)?.slice(0, 7);
  const reviewIsRunning = effectiveStatus === 'RUNNING';
  const body = reviewBody(reviewGate, reviewRun);
  const findings = effectiveReviewFindings(reviewGate.result, reviewGate.findingDecisions ?? []);
  const hasRawReviewOutput = Boolean(reviewRun?.finalMessage || loadedReviewOutput);
  const stopReviewDisabledTitle = (): string | undefined => {
    if (actionBusy) {
      return 'Review action is in progress.';
    }
    if (reviewPending) {
      return 'Review is starting.';
    }
    if (!reviewRun) {
      return 'No running review is available.';
    }
    if (!canStopReview) {
      return 'The current review cannot be stopped.';
    }
    return undefined;
  };
  return (
    <section className={`tm-reviewcard tm-reviewcard--${ui.tone}`}>
      {reviewIsRunning ? (
        <div className="tm-reviewcard__head tm-reviewcard__head--run">
          <RunHeader
            running
            tone="info"
            operationName="Agent review"
            scope={reviewedDiff}
            startedAt={reviewRun?.startedAt}
            onStop={() => reviewRun && onStopReview(reviewRun.id)}
            stopDisabled={!canStopReview || actionBusy || !reviewRun}
            stopTitle={stopReviewDisabledTitle()}
          />
        </div>
      ) : (
        <div className="tm-reviewcard__head">
          {ui.mark !== 'idle' ? (
            <StatusGlyph className="tm-reviewcard__glyph" kind={ui.mark} />
          ) : null}
          <div>
            <h3 className="tm-panel__title tm-panel__title--flush">
              Agent review
            </h3>
          </div>
          <span className="tm-reviewcard__spacer" />
          {showVerdict ? (
            <span className={`tm-reviewcard__status tm-reviewcard__status--${ui.tone}`}>{ui.label}</span>
          ) : null}
          {onOpenReview && findings.length > 0 ? (
            <button type="button" className="tm-osection__link" onClick={onOpenReview}>Open review</button>
          ) : null}
        </div>
      )}

      <div className="tm-reviewcard__body">
        {reviewIsRunning ? (
          <div className="tm-reviewcard__runningstate">
            <div className="tm-reviewcard__activity" aria-live="polite">
              <span className="tm-reviewcard__activity-k">Reviewer reported</span>
              <div className="tm-reviewcard__activity-row">
                <span className="tm-reviewcard__activity-text">
                  {reviewActivity?.label ?? 'Preparing review context.'}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="tm-reviewcard__summary">
            {body?.source === 'reviewer' ? (
              <figure className="tm-oresult__report">
                <figcaption>{reviewerName}</figcaption>
                <blockquote>{body.text}</blockquote>
              </figure>
            ) : body ? (
              <p>{body.text}</p>
            ) : null}
            {effectiveStatus === 'NOT_RUN' ? (
              reviewedHead ? <p className="tm-reviewcard__meta">Will review <code>{reviewedHead}</code></p> : null
            ) : (
              <p className="tm-reviewcard__meta">
                Reviewed {reviewedHead ? <><code>{reviewedHead}</code>, </> : null}
                {formatReviewTime(reviewGate.updatedAt)}
              </p>
            )}
            {findings.length > 0 ? (
              <p className="tm-reviewcard__findings">
                <SeverityDistribution findings={findings} earlier={effectiveStatus === 'STALE'} />
              </p>
            ) : hasRawReviewOutput ? (
                <RawReviewOutput
                  textExcerpt={textExcerpt}
                  loadedReviewOutput={loadedReviewOutput}
                  fallbackOutput={reviewRun?.finalMessage}
                  loading={reviewOutputLoading}
                  error={reviewOutputError}
                  onLoad={onLoadReviewOutput}
                />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function RawReviewOutput({
  textExcerpt,
  loadedReviewOutput,
  fallbackOutput,
  loading,
  error,
  onLoad
}: {
  textExcerpt?: ClientTextExcerpt;
  loadedReviewOutput?: string;
  fallbackOutput?: string;
  loading: boolean;
  error?: string;
  onLoad(): void;
}) {
  return (
    <details className="tm-raw tm-reviewcard__raw">
      <summary>
        <span className="tm-disclosure__label">
          <DisclosureChevron />
          {textExcerpt
            ? loadedReviewOutput === undefined
              ? 'Raw review output excerpt'
              : 'Retained review artifact'
            : 'Raw review output'}
        </span>
      </summary>
      <pre>{loadedReviewOutput ?? fallbackOutput}</pre>
      {textExcerpt ? (
        <div>
          <p>
            Displayed {textExcerpt.displayedByteCount.toLocaleString()} of{' '}
            {textExcerpt.originalByteCount.toLocaleString()} bytes.
          </p>
          {textExcerpt.availableContent.kind === 'BOUNDED_ARTIFACT' &&
          loadedReviewOutput === undefined ? (
            <button
              type="button"
              className="outline-button"
              disabled={loading}
              onClick={onLoad}
            >
              {loading ? 'Loading review artifact…' : 'Load available review artifact'}
            </button>
          ) : textExcerpt.availableContent.kind === 'NOT_AVAILABLE' ? (
            <p>Additional content is not available from retained evidence.</p>
          ) : null}
          {error ? <div className="tm-error">{error}</div> : null}
        </div>
      ) : null}
    </details>
  );
}

/**
 * "1 major, 2 minor · 1 closed": the open findings by severity, then how many
 * were dismissed or withdrawn. Earlier findings carry no tone.
 */
function SeverityDistribution({ findings, earlier }: { findings: EffectiveReviewFinding[]; earlier: boolean }) {
  const open = findings.filter((finding) => finding.state === 'OPEN');
  const closed = findings.length - open.length;
  const counts = FINDING_LEVELS.map((level) => ({
    ...level,
    count: open.filter((finding) => finding.severity === level.severity).length
  })).filter((level) => level.count > 0);
  return (
    <span className="tm-reviewcard__counts" data-earlier={earlier || undefined}>
      {earlier ? 'Earlier: ' : null}
      {counts.length === 0 ? 'No open findings' : counts.map((level, index) => (
        <span key={level.severity} data-severity={level.severity}>
          {index > 0 ? ', ' : null}{level.count} {level.label.toLowerCase()}
        </span>
      ))}
      {closed > 0 ? <span className="tm-reviewcard__closed"> · {closed} closed</span> : null}
    </span>
  );
}

/** The same absolute time the History beside it uses. */
function formatReviewTime(value: string | undefined): string {
  return value ? formatTaskActivityTimestamp(value).label : 'at an unknown time';
}

function reviewGateUi(
  status: AgentReviewGateProjection['status']
): {
  label: string;
  tone: Tone;
  mark: StatusGlyphKind;
} {
  switch (status) {
    case 'RUNNING':
      return { label: 'Reviewing', tone: 'info', mark: 'working' };
    case 'PASSED':
      return { label: 'Passed', tone: 'success', mark: 'idle' };
    case 'NEEDS_CHANGES':
      return { label: 'Needs changes', tone: 'action', mark: 'waiting' };
    case 'INCONCLUSIVE':
      return { label: 'Inconclusive', tone: 'action', mark: 'waiting' };
    case 'FAILED':
      return { label: 'Failed', tone: 'error', mark: 'blocked' };
    case 'CANCELED':
      return { label: 'Stopped', tone: 'action', mark: 'idle' };
    // A stale review has one state word; its old verdict is context in the body.
    case 'STALE':
      return { label: 'Needs re-review', tone: 'neutral', mark: 'idle' };
    case 'NOT_RUN':
      return { label: 'Not run', tone: 'neutral', mark: 'idle' };
  }
}

/** What the review said: the reviewer's own words when it gave them, else Task Monki's account. */
function reviewBody(
  reviewGate: AgentReviewGateProjection,
  reviewRun?: RunRecord
): { text: string; source: 'reviewer' | 'task-monki' } | undefined {
  const own = (text: string | undefined) => (text ? { text, source: 'task-monki' as const } : undefined);
  if (reviewGate.status === 'STALE') {
    const verdict = reviewGate.result?.verdict;
    const earlier =
      verdict === 'PASSED' ? 'passed'
        : verdict === 'NEEDS_CHANGES' ? 'asked for changes'
          : verdict === 'INCONCLUSIVE' ? 'was inconclusive'
            : undefined;
    return own(earlier
      ? `The diff changed after this review, which ${earlier} on the earlier version.`
      : 'The diff changed after this review.');
  }
  if (reviewRun?.terminalReason) {
    return own(reviewRun.terminalReason);
  }
  if (reviewGate.summary) {
    return { text: reviewGate.summary, source: 'reviewer' };
  }
  switch (reviewGate.status) {
    case 'NOT_RUN':
    case 'NEEDS_CHANGES':
      return undefined;
    case 'PASSED':
      return own('No blocking issues in the reviewed diff.');
    case 'INCONCLUSIVE':
      return own('The review finished without a clear verdict.');
    case 'FAILED':
      return own('The review did not complete.');
    case 'CANCELED':
      return own('The partial review result was discarded.');
    case 'RUNNING':
      return own('Reviewing the current diff.');
  }
}
