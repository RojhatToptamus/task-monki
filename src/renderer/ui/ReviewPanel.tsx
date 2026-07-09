import type {
  CodexReviewFinding,
  CodexReviewGateProjection,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import type { ReviewActivityViewModel } from '../model/reviewActivity';
import { ActionButtonTitle } from './ActionButtonTitle';
import {
  FINDING_LEVELS,
  FindingRow,
  findingLevel,
  shortFindingRef
} from './Findings';
import { RunHeader } from './RunHeader';
import { Chip, dotStyle } from './StatusBadge';
import {
  describeGitSnapshot,
  describeReviewedDiff
} from './gitSnapshotCopy';
import type { Tone } from './taskView';

export type ReviewActionPauseReason =
  | 'review-starting'
  | 'review-running'
  | 'implementation-running'
  | 'delivery-running';

export function ReviewPanel({
  reviewGate,
  reviewRun,
  sourceRun,
  gitSnapshot,
  reviewActivity,
  actionBusy,
  reviewPending,
  actionsPaused,
  actionsPausedReason,
  onRunReview,
  onStopReview
}: {
  reviewGate: CodexReviewGateProjection;
  reviewRun?: RunRecord;
  sourceRun?: RunRecord;
  gitSnapshot?: GitSnapshotRecord;
  reviewActivity?: ReviewActivityViewModel;
  actionBusy: boolean;
  reviewPending: boolean;
  actionsPaused: boolean;
  actionsPausedReason?: ReviewActionPauseReason;
  onRunReview(sourceRunId: string): void;
  onStopReview(reviewRunId: string): void;
}) {
  const effectiveStatus = reviewPending ? 'RUNNING' : reviewGate.status;
  const ui = reviewGateUi(effectiveStatus);
  const canStopReview = Boolean(reviewRun && effectiveStatus === 'RUNNING' && !reviewPending);
  const hasReviewOutput = Boolean(reviewGate.result) || Boolean(reviewRun?.finalMessage?.trim());
  const canRunAgain = Boolean(sourceRun) && !actionsPaused;
  const sourceRunId = sourceRun?.id;
  const currentDiff = describeGitSnapshot(gitSnapshot);
  const reviewedDiff = reviewPending ? currentDiff : describeReviewedDiff(reviewGate, gitSnapshot);
  const reviewIsRunning = effectiveStatus === 'RUNNING';
  const staleContextNote =
    effectiveStatus === 'STALE' && hasReviewOutput
      ? 'Previous review output is shown for context only. Re-run the review before acting on the current diff.'
      : undefined;

  const reviewActionPauseTitle = (): string | undefined => {
    switch (actionsPausedReason) {
      case 'delivery-running':
        return 'Review actions pause during GitHub actions.';
      case 'implementation-running':
        return 'Review actions pause while the agent is running.';
      case 'review-starting':
        return 'Review is starting.';
      case 'review-running':
        return 'Review is already running.';
      default:
        return undefined;
    }
  };
  const runReviewDisabledTitle = (canRun: boolean): string | undefined => {
    if (actionsPaused) {
      return reviewActionPauseTitle();
    }
    if (actionBusy) {
      return 'Review action is in progress.';
    }
    if (!sourceRunId) {
      return 'No completed implementation run is available to review.';
    }
    if (!canRun) {
      return 'Review cannot start from the current task state.';
    }
    return undefined;
  };
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
  const reviewCardUtilities: Array<{
    key: string;
    label: string;
    disabled: boolean;
    title?: string;
    onClick(): void;
  }> = [];

  if (
    !reviewIsRunning &&
    !actionsPaused &&
    effectiveStatus !== 'NOT_RUN' &&
    ['PASSED', 'NEEDS_CHANGES', 'INCONCLUSIVE', 'FAILED', 'CANCELED', 'STALE'].includes(
      effectiveStatus
    )
  ) {
    reviewCardUtilities.push({
      key: 'run-again',
      label: 'Run review again',
      disabled: !canRunAgain || actionBusy || !sourceRunId,
      title: runReviewDisabledTitle(canRunAgain),
      onClick: () => sourceRunId && onRunReview(sourceRunId)
    });
  }

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
          <span className="tm-reviewcard__dot" style={dotStyle(ui.tone)} />
          <div>
            <h3 className="tm-panel__title" style={{ margin: 0 }}>
              Review
            </h3>
          </div>
          <span className="tm-reviewcard__spacer" />
          <Chip tone={ui.tone} label={ui.label} />
        </div>
      )}

      <div className="tm-reviewcard__body">
        {reviewIsRunning ? (
          <div className="tm-reviewcard__runningstate">
            <div className="tm-reviewcard__activity" aria-live="polite">
              <span className="tm-reviewcard__activity-k">Current activity</span>
              <div className="tm-reviewcard__activity-row">
                <span className="tm-reviewcard__activity-dot" />
                <span className="tm-reviewcard__activity-text">
                  {reviewActivity?.label ?? 'Preparing review context.'}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="tm-reviewcard__summary">
            <p>{reviewBody(reviewGate, reviewRun)}</p>
            {effectiveStatus === 'NOT_RUN' ? (
              <div className="tm-reviewcard__meta tm-reviewcard__meta--box">
                <span>Will review</span>
                <strong>{currentDiff}</strong>
                <span>Last result</span>
                <strong>none</strong>
              </div>
            ) : (
              <div className="tm-reviewcard__meta">
                <span>Last reviewed</span>
                <strong>{formatReviewTime(reviewGate.updatedAt)}</strong>
                <span>Reviewed diff</span>
                <strong>{reviewedDiff}</strong>
              </div>
            )}
            {staleContextNote ? (
              <p className="tm-reviewcard__contextnote">{staleContextNote}</p>
            ) : null}
            <ReviewFindingsList findings={reviewGate.result?.findings ?? []} />
            {reviewRun?.finalMessage ? (
              <details className="tm-raw tm-reviewcard__raw">
                <summary>Raw review output</summary>
                <pre>{reviewRun.finalMessage}</pre>
              </details>
            ) : null}
          </div>
        )}
      </div>

      {reviewCardUtilities.length > 0 ? (
        <div className="tm-reviewcard__actions">
          <div className="tm-reviewcard__buttons">
            {reviewCardUtilities.map((utility) => (
              <ActionButtonTitle
                key={utility.key}
                disabled={utility.disabled}
                title={utility.title}
              >
                <button
                  type="button"
                  className="outline-button"
                  disabled={utility.disabled}
                  onClick={utility.onClick}
                >
                  {utility.label}
                </button>
              </ActionButtonTitle>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ReviewFindingsList({ findings }: { findings: CodexReviewFinding[] }) {
  if (findings.length === 0) {
    return null;
  }
  const sortedFindings = [...findings].sort(
    (a, b) => findingLevel(a.severity).rank - findingLevel(b.severity).rank
  );
  return (
    <div className="tm-reviewfindings">
      <SeverityDistribution findings={findings} />
      <div className="tm-reviewfindings__list">
        {sortedFindings.map((finding, index) => {
          const level = findingLevel(finding.severity);
          return (
            <FindingRow
              key={finding.id}
              tone={level.tone}
              severityLabel={level.label}
              title={finding.title}
              reference={shortFindingRef(finding)}
              open={index === 0}
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
    </div>
  );
}

function SeverityDistribution({ findings }: { findings: CodexReviewFinding[] }) {
  const counts = FINDING_LEVELS.map((level) => ({
    ...level,
    count: findings.filter((finding) => finding.severity === level.severity).length
  }));
  return (
    <div className="tm-reviewfindings__distribution">
      <div className="tm-reviewfindings__counts" aria-label="Review finding severity counts">
        {counts.map((level) => (
          <span
            key={level.severity}
            className={`tm-reviewfindings__count tm-reviewfindings__count--${level.tone}${
              level.count > 0 ? '' : ' tm-reviewfindings__count--empty'
            }`}
          >
            <span className="tm-reviewfindings__count-dot" />
            <strong>{level.count}</strong>
            {level.label}
          </span>
        ))}
      </div>
    </div>
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

function reviewGateUi(status: CodexReviewGateProjection['status']): {
  label: string;
  tone: Tone;
} {
  switch (status) {
    case 'RUNNING':
      return { label: 'Reviewing...', tone: 'info' };
    case 'PASSED':
      return { label: 'Passed', tone: 'success' };
    case 'NEEDS_CHANGES':
      return { label: 'Needs changes', tone: 'error' };
    case 'INCONCLUSIVE':
      return { label: 'Inconclusive', tone: 'action' };
    case 'FAILED':
      return { label: 'Failed', tone: 'error' };
    case 'CANCELED':
      return { label: 'Stopped', tone: 'action' };
    case 'STALE':
      return { label: 'Stale', tone: 'action' };
    case 'NOT_RUN':
      return { label: 'Not run', tone: 'neutral' };
  }
}

function reviewBody(
  reviewGate: CodexReviewGateProjection,
  reviewRun?: RunRecord
): string {
  if (reviewRun?.terminalReason) {
    return reviewRun.terminalReason;
  }
  if (reviewGate.summary) {
    return reviewGate.summary;
  }
  switch (reviewGate.status) {
    case 'NOT_RUN':
      return 'Run a review before marking done or shipping this diff.';
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
    case 'STALE':
      return 'The diff changed after the last review.';
    case 'RUNNING':
      return 'Reviewing the current diff.';
  }
}
