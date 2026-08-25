import type {
  AgentReviewFinding,
  AgentReviewGateProjection,
  ClientTextExcerpt,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import type { ReactNode } from 'react';
import type { ReviewActivityViewModel } from '../model/reviewActivity';
import { FINDING_LEVELS, findingLevel, shortFindingRef } from '../model/findings';
import { FindingRow } from './Findings';
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
  onReviewAgain,
  reviewAgainDisabled = false,
  reviewAgainTitle,
  action,
  onStopReview
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
  onReviewAgain?(): void;
  reviewAgainDisabled?: boolean;
  reviewAgainTitle?: string;
  action?: ReactNode;
  onStopReview(reviewRunId: string): void;
}) {
  const effectiveStatus = reviewPending ? 'RUNNING' : reviewGate.status;
  const ui = reviewGateUi(effectiveStatus, reviewGate);
  const canStopReview = Boolean(reviewRun && effectiveStatus === 'RUNNING' && !reviewPending);
  const currentDiff = describeGitSnapshot(gitSnapshot);
  const reviewedDiff = reviewPending ? currentDiff : describeReviewedDiff(reviewGate, gitSnapshot);
  const reviewIsRunning = effectiveStatus === 'RUNNING';
  const body = reviewBody(reviewGate, reviewRun);
  const findings = reviewGate.result?.findings ?? [];
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
            operationName="Reviewing"
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
              Review
            </h3>
          </div>
          <span className="tm-reviewcard__spacer" />
          <span className="tm-reviewcard__status">{ui.label}</span>
        </div>
      )}

      {effectiveStatus === 'STALE' ? (
        <div className="tm-reviewcard__stale">
          <span>Diff changed since this review.</span>
          {onReviewAgain ? (
            <button
              type="button"
              disabled={reviewAgainDisabled}
              title={reviewAgainTitle}
              onClick={onReviewAgain}
            >
              Re-review
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="tm-reviewcard__body">
        {reviewIsRunning ? (
          <div className="tm-reviewcard__runningstate">
            <div className="tm-reviewcard__activity" aria-live="polite">
              <span className="tm-reviewcard__activity-k">Current activity</span>
              <div className="tm-reviewcard__activity-row">
                <span className="tm-reviewcard__activity-text">
                  {reviewActivity?.label ?? 'Preparing review context.'}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="tm-reviewcard__summary">
            {body ? <p>{body}</p> : null}
            {effectiveStatus === 'NOT_RUN' ? (
              <div className="tm-reviewcard__meta">
                <span>Will review</span>
                <strong>{currentDiff}</strong>
              </div>
            ) : (
              <div className="tm-reviewcard__meta">
                <span>Last reviewed</span>
                <strong>{formatReviewTime(reviewGate.updatedAt)}</strong>
                <span>Reviewed diff</span>
                <strong>{reviewedDiff}</strong>
              </div>
            )}
            {effectiveStatus === 'STALE' ? null : action}
            <ReviewFindingsList
              findings={findings}
              rawOutput={hasRawReviewOutput ? (
                <RawReviewOutput
                  textExcerpt={textExcerpt}
                  loadedReviewOutput={loadedReviewOutput}
                  fallbackOutput={reviewRun?.finalMessage}
                  loading={reviewOutputLoading}
                  error={reviewOutputError}
                  onLoad={onLoadReviewOutput}
                />
              ) : undefined}
            />
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

function ReviewFindingsList({
  findings,
  rawOutput
}: {
  findings: AgentReviewFinding[];
  rawOutput?: ReactNode;
}) {
  if (findings.length === 0) {
    return rawOutput ?? null;
  }
  const sortedFindings = [...findings].sort(
    (a, b) => findingLevel(a.severity).rank - findingLevel(b.severity).rank
  );
  return (
    <details className="tm-reviewfindings">
      <summary>
        <span className="tm-disclosure__label">
          <DisclosureChevron />
          Findings
        </span>
        <SeverityDistribution findings={findings} hasRawOutput={Boolean(rawOutput)} />
      </summary>
      <div className="tm-reviewfindings__list">
        {sortedFindings.map((finding) => {
          const level = findingLevel(finding.severity);
          return (
            <FindingRow
              key={finding.id}
              tone={level.tone}
              severityLabel={level.label}
              title={finding.title}
              reference={shortFindingRef(finding)}
              detail={
                <>
                  <p>{finding.explanation}</p>
                  {finding.recommendation ? <p>{finding.recommendation}</p> : null}
                </>
              }
            />
          );
        })}
      </div>
      {rawOutput}
    </details>
  );
}

function SeverityDistribution({
  findings,
  hasRawOutput
}: {
  findings: AgentReviewFinding[];
  hasRawOutput: boolean;
}) {
  const counts = FINDING_LEVELS.map((level) => ({
    ...level,
    count: findings.filter((finding) => finding.severity === level.severity).length
  })).filter((level) => level.count > 0);
  if (counts.length === 0) {
    return null;
  }
  return (
    <span className="tm-reviewfindings__distribution">
      <span className="tm-reviewfindings__counts" aria-label="Review finding severity counts">
        {counts.map((level) => (
          <span
            key={level.severity}
            className={`tm-reviewfindings__count tm-reviewfindings__count--${level.tone}`}
          >
            <strong>{level.count}</strong>
            {level.label}
          </span>
        ))}
        {hasRawOutput ? <span className="tm-reviewfindings__rawref">· raw output</span> : null}
      </span>
    </span>
  );
}

function formatReviewTime(value: string | undefined): string {
  if (!value) {
    return 'unknown';
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return 'unknown';
  }
  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs >= 0 && elapsedMs < 60_000) {
    return 'just now';
  }
  if (elapsedMs >= 0 && elapsedMs < 60 * 60_000) {
    const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
    return `${minutes}m ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function reviewGateUi(
  status: AgentReviewGateProjection['status'],
  reviewGate: AgentReviewGateProjection
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
    case 'STALE': {
      switch (reviewGate.result?.verdict) {
        case 'PASSED': return { label: 'Passed', tone: 'success', mark: 'idle' };
        case 'NEEDS_CHANGES': return { label: 'Needs changes', tone: 'error', mark: 'idle' };
        case 'INCONCLUSIVE': return { label: 'Inconclusive', tone: 'action', mark: 'idle' };
        default: return { label: 'Needs re-review', tone: 'action', mark: 'idle' };
      }
    }
    case 'NOT_RUN':
      return { label: 'Not run', tone: 'neutral', mark: 'idle' };
  }
}

function reviewBody(
  reviewGate: AgentReviewGateProjection,
  reviewRun?: RunRecord
): string | undefined {
  if (reviewRun?.terminalReason) {
    return reviewRun.terminalReason;
  }
  if (reviewGate.status === 'STALE') {
    return 'Reviewed diff no longer matches the worktree.';
  }
  if (reviewGate.summary) {
    return reviewGate.summary;
  }
  switch (reviewGate.status) {
    case 'NOT_RUN':
      return undefined;
    case 'PASSED':
      return 'No blocking issues were reported for the reviewed diff.';
    case 'NEEDS_CHANGES':
      return 'Send the findings back to the agent, then re-review.';
    case 'INCONCLUSIVE':
      return 'The review finished without a clear pass or fail verdict. Read the output, then request changes or mark done explicitly.';
    case 'FAILED':
      return 'The review did not complete. Re-run it or inspect Debug.';
    case 'CANCELED':
      return 'The partial review result was discarded.';
    case 'RUNNING':
      return 'Reviewing the current diff.';
  }
}
