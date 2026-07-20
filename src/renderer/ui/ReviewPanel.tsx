import type {
  AgentReviewFinding,
  AgentReviewGateProjection,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import type { ReviewActivityViewModel } from '../model/reviewActivity';
import {
  FINDING_LEVELS,
  FindingRow,
  findingLevel,
  shortFindingRef
} from './Findings';
import { RunHeader } from './RunHeader';
import { dotStyle } from './StatusBadge';
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
  gitSnapshot,
  reviewActivity,
  actionBusy,
  reviewPending,
  onStopReview
}: {
  reviewGate: AgentReviewGateProjection;
  reviewRun?: RunRecord;
  gitSnapshot?: GitSnapshotRecord;
  reviewActivity?: ReviewActivityViewModel;
  actionBusy: boolean;
  reviewPending: boolean;
  onStopReview(reviewRunId: string): void;
}) {
  const effectiveStatus = reviewPending ? 'RUNNING' : reviewGate.status;
  const ui = reviewGateUi(effectiveStatus);
  const canStopReview = Boolean(reviewRun && effectiveStatus === 'RUNNING' && !reviewPending);
  const currentDiff = describeGitSnapshot(gitSnapshot);
  const reviewedDiff = reviewPending ? currentDiff : describeReviewedDiff(reviewGate, gitSnapshot);
  const reviewIsRunning = effectiveStatus === 'RUNNING';
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
          <span className="tm-reviewcard__dot" style={dotStyle(ui.tone)} />
          <div>
            <h3 className="tm-panel__title" style={{ margin: 0 }}>
              Review
            </h3>
          </div>
          <span className="tm-reviewcard__spacer" />
          <span className="tm-reviewcard__status">{ui.label}</span>
        </div>
      )}

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
            <p>{reviewBody(reviewGate, reviewRun)}</p>
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
    </section>
  );
}

function ReviewFindingsList({ findings }: { findings: AgentReviewFinding[] }) {
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

function SeverityDistribution({ findings }: { findings: AgentReviewFinding[] }) {
  const counts = FINDING_LEVELS.map((level) => ({
    ...level,
    count: findings.filter((finding) => finding.severity === level.severity).length
  })).filter((level) => level.count > 0);
  if (counts.length === 0) {
    return null;
  }
  return (
    <div className="tm-reviewfindings__distribution">
      <div className="tm-reviewfindings__counts" aria-label="Review finding severity counts">
        {counts.map((level) => (
          <span
            key={level.severity}
            className={`tm-reviewfindings__count tm-reviewfindings__count--${level.tone}`}
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

function reviewGateUi(status: AgentReviewGateProjection['status']): {
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
  reviewGate: AgentReviewGateProjection,
  reviewRun?: RunRecord
): string {
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
    case 'RUNNING':
      return 'Reviewing the current diff.';
  }
}
