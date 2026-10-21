import { useMemo } from 'react';
import { FilePlus2 } from 'lucide-react';
import type {
  ArtifactRecord,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import {
  buildCompletedChangeSummary,
  hasNewerGitEvidence,
  runChangedNothing,
  selectCompletedRunChangeSnapshot,
  type CompletedChangeFile,
  type CompletedChangeSummary
} from '../model/completedChangeSummary';
import { DiffStat } from './DiffStat';
import { DisclosureChevron } from './DisclosureChevron';
import { useDiffArtifact } from './useDiffArtifact';
import { plural, pluralize } from '../model/formatting';

interface CompletedChangeSummaryPanelProps {
  run?: RunRecord;
  capturePending?: boolean;
  compact?: boolean;
  gitSnapshots: GitSnapshotRecord[];
  artifacts: ArtifactRecord[];
  onViewDiff(snapshotId: string): void;
}

type CaptureStatus =
  | 'LOADING'
  | 'CAPTURE_PENDING'
  | 'NOT_CAPTURED'
  | 'DIFF_UNAVAILABLE'
  | 'READ_FAILED'
  | 'NO_CHANGES'
  | 'UNINTERPRETABLE'
  | 'CAPTURED';

export function CompletedChangeSummaryPanel({
  run,
  capturePending = false,
  compact = false,
  gitSnapshots,
  artifacts,
  onViewDiff
}: CompletedChangeSummaryPanelProps) {
  const snapshot = useMemo(
    () => selectCompletedRunChangeSnapshot(run, gitSnapshots),
    [run, gitSnapshots]
  );
  const diff = useDiffArtifact(snapshot?.diffArtifactId, artifacts);
  const loaded = !diff.missing && !diff.loading && !diff.error;
  const summary = useMemo(
    () => (loaded ? buildCompletedChangeSummary(diff.inspection.files) : undefined),
    [loaded, diff.inspection.files]
  );
  const completeness = loaded ? diff.inspection.completeness : undefined;

  if (!run || run.status !== 'COMPLETED') {
    return null;
  }

  let captureStatus: CaptureStatus = 'LOADING';
  // A run that changed nothing says so, rather than listing the work that was there before it.
  if (snapshot && runChangedNothing(run, gitSnapshots)) {
    captureStatus = 'NO_CHANGES';
  } else if (!snapshot && capturePending) {
    captureStatus = 'CAPTURE_PENDING';
  } else if (!snapshot) {
    captureStatus = 'NOT_CAPTURED';
  } else if (diff.missing) {
    captureStatus = 'DIFF_UNAVAILABLE';
  } else if (diff.error) {
    captureStatus = 'READ_FAILED';
  } else if (completeness === 'UNINTERPRETABLE') {
    captureStatus = 'UNINTERPRETABLE';
  } else if (summary) {
    captureStatus = 'CAPTURED';
  } else if (loaded) {
    captureStatus = 'NO_CHANGES';
  }

  return (
    <CompletedChangeSummaryCard
      compact={compact}
      summary={summary}
      captureStatus={captureStatus}
      snapshot={snapshot}
      incomplete={completeness === 'INCOMPLETE'}
      historical={snapshot ? hasNewerGitEvidence(snapshot, gitSnapshots) : false}
      onViewDiff={snapshot ? () => onViewDiff(snapshot.id) : undefined}
    />
  );
}

export function CompletedChangeSummaryCard({
  compact = false,
  summary,
  captureStatus,
  snapshot,
  incomplete = false,
  historical = false,
  onViewDiff
}: {
  compact?: boolean;
  summary?: CompletedChangeSummary;
  captureStatus: CaptureStatus;
  snapshot?: GitSnapshotRecord;
  incomplete?: boolean;
  historical?: boolean;
  onViewDiff?(): void;
}) {
  if (compact) {
    if (captureStatus === 'NOT_CAPTURED') return null;
    // A finished run that changed nothing is worth saying, not an empty list.
    if (captureStatus === 'NO_CHANGES') return <p className="tm-changes__none">No file changes</p>;
    if (!summary) return <CaptureStatusMessage status={captureStatus} incomplete={incomplete} />;
    const note = [
      historical ? 'Earlier snapshot' : undefined,
      incomplete ? 'Incomplete' : undefined
    ].filter(Boolean).join(', ');
    return <section className="tm-changes" aria-label="Changed files">
      <header className="tm-changes__head">
        <FilePlus2 size={13} aria-hidden="true" />
        <span className="tm-changes__title">{pluralize(summary.fileCount, 'file')} changed</span>
        {/* One file's row already carries its counts. */}
        {summary.fileCount > 1 ? <DiffStat additions={summary.additions} deletions={summary.deletions} /> : null}
        {note ? <span className="tm-changes__note" title={historical
          ? `Captured ${snapshot ? formatCaptureTime(snapshot.capturedAt) : ''}; the worktree changed later.`.replace(' ;', ';')
          : undefined}>{note}</span> : null}
        {onViewDiff ? <button type="button" className="tm-osection__link tm-changes__action" onClick={onViewDiff}>View diff</button> : null}
      </header>
      <div className="tm-changes__files">
        {summary.previewFiles.map((file) => <ChangeFileRow key={file.path} file={file} />)}
        {summary.hiddenFileCount > 0 ? <details className="tm-changes__more">
          <summary>Show {summary.hiddenFileCount} more {plural(summary.hiddenFileCount, 'file')}<DisclosureChevron /></summary>
          {summary.hiddenFiles.map((file) => <ChangeFileRow key={file.path} file={file} />)}
        </details> : null}
      </div>
    </section>;
  }
  const title =
    incomplete && summary
      ? `Incomplete captured diff, ${pluralize(summary.fileCount, 'file')} observed`
      : summary?.title ?? 'Captured Git changes';

  return (
    <section className="tm-change-summary" aria-label="Captured Git changes">
      <div className="tm-change-summary__head">
        <span className="tm-change-summary__icon" aria-hidden="true">
          <FilePlus2 size={16} />
        </span>
        <div className="tm-change-summary__title">
          <h3>{title}</h3>
          {summary ? (
            <DiffStat additions={summary.additions} deletions={summary.deletions} />
          ) : null}
        </div>
        {onViewDiff ? (
          <button type="button" className="outline-button" onClick={onViewDiff}>
            View diff
          </button>
        ) : null}
      </div>
      {snapshot ? (
        <p className="tm-change-summary__capture">
          <span title={snapshot.headSha ?? 'HEAD was not observed'}>
            {snapshot.headSha ? `Head ${snapshot.headSha.slice(0, 12)}` : 'Head Unknown'}
          </span>
          <time dateTime={snapshot.capturedAt}>{formatCaptureTime(snapshot.capturedAt)}</time>
        </p>
      ) : null}
      {historical ? (
        <p className="tm-change-summary__notice">
          Earlier snapshot. The worktree has changed since.
        </p>
      ) : null}
      {incomplete ? (
        <p className="tm-change-summary__notice">
          Incomplete capture. Other files or changes may be missing.
        </p>
      ) : null}
      {summary ? (
        <div className="tm-change-summary__files">
          {summary.previewFiles.map((file) => (
            <ChangeFileRow key={file.path} file={file} />
          ))}
          {summary.hiddenFileCount > 0 ? (
            <details className="tm-change-summary__more">
              <summary>
                Show {summary.hiddenFileCount} more {plural(summary.hiddenFileCount, 'file')}
                <DisclosureChevron className="tm-change-summary__chevron" />
              </summary>
              <div>
                {summary.hiddenFiles.map((file) => (
                  <ChangeFileRow key={file.path} file={file} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <CaptureStatusMessage status={captureStatus} incomplete={incomplete} />
      )}
    </section>
  );
}

function CaptureStatusMessage({
  status,
  incomplete
}: {
  status: CaptureStatus;
  incomplete: boolean;
}) {
  let message = 'No file changes were captured.';
  if (incomplete) {
    message = 'No files could be read from this incomplete capture.';
  } else if (status === 'LOADING') {
    message = 'Loading captured Git changes…';
  } else if (status === 'CAPTURE_PENDING') {
    message = 'Capturing Git changes…';
  } else if (status === 'NOT_CAPTURED') {
    message = 'No post-run Git capture. Changes are unknown.';
  } else if (status === 'DIFF_UNAVAILABLE') {
    message =
      'Capture recorded, but its diff is unavailable.';
  } else if (status === 'READ_FAILED') {
    message = 'Could not read the captured diff. Changes are unknown.';
  } else if (status === 'UNINTERPRETABLE') {
    message = 'Could not interpret the captured diff. Changes are unknown.';
  }

  return (
    <p className="tm-change-summary__empty" role="status" aria-live="polite">
      {message}
    </p>
  );
}

function ChangeFileRow({ file }: { file: CompletedChangeFile }) {
  const slash = file.path.lastIndexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <div className="tm-change-summary__file" title={file.path}>
      <span
        className="tm-change-summary__status"
        aria-label={file.status}
      >
        {file.status[0].toUpperCase()}
      </span>
      <span className="tm-change-summary__path">
        {dir ? <span className="tm-change-summary__dir">{dir}</span> : null}
        <span className="tm-change-summary__base">{base}</span>
      </span>
      <DiffStat additions={file.additions} deletions={file.deletions} />
    </div>
  );
}

/** Lines added and removed; a side with nothing to count is left out. */
function formatCaptureTime(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}
