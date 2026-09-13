import { useEffect, useMemo, useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import type {
  ArtifactRecord,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import {
  buildCompletedChangeSummary,
  hasNewerGitEvidence,
  selectCompletedRunChangeSnapshot,
  type CompletedChangeFile,
  type CompletedChangeSummary
} from '../model/completedChangeSummary';
import { inspectGitDiffEvidence } from '../model/diffEvidence';
import { DisclosureChevron } from './DisclosureChevron';

interface CompletedChangeSummaryPanelProps {
  run?: RunRecord;
  capturePending?: boolean;
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

type DiffArtifactLoadState =
  | { status: 'IDLE' }
  | { status: 'LOADING'; artifactId: string }
  | { status: 'LOADED'; artifactId: string; text: string }
  | { status: 'FAILED'; artifactId: string };

export function CompletedChangeSummaryPanel({
  run,
  capturePending = false,
  gitSnapshots,
  artifacts,
  onViewDiff
}: CompletedChangeSummaryPanelProps) {
  const snapshot = useMemo(
    () => selectCompletedRunChangeSnapshot(run, gitSnapshots),
    [run, gitSnapshots]
  );
  const diffArtifact = snapshot?.diffArtifactId
    ? artifacts.find((artifact) => artifact.id === snapshot.diffArtifactId)
    : undefined;
  const [artifactLoad, setArtifactLoad] = useState<DiffArtifactLoadState>({
    status: 'IDLE'
  });

  useEffect(() => {
    let canceled = false;

    if (!diffArtifact) {
      setArtifactLoad({ status: 'IDLE' });
      return () => {
        canceled = true;
      };
    }

    setArtifactLoad({ status: 'LOADING', artifactId: diffArtifact.id });
    void taskManagerApi
      .readArtifact({ artifactId: diffArtifact.id })
      .then((text) => {
        if (!canceled) {
          setArtifactLoad({ status: 'LOADED', artifactId: diffArtifact.id, text });
        }
      })
      .catch(() => {
        if (!canceled) {
          setArtifactLoad({ status: 'FAILED', artifactId: diffArtifact.id });
        }
      });

    return () => {
      canceled = true;
    };
  }, [diffArtifact?.id, diffArtifact?.byteCount, diffArtifact?.updatedAt]);

  const artifactText =
    artifactLoad.status === 'LOADED' && artifactLoad.artifactId === diffArtifact?.id
      ? artifactLoad.text
      : undefined;
  const capturedDiff = useMemo(
    () => (artifactText === undefined ? undefined : inspectGitDiffEvidence(artifactText)),
    [artifactText]
  );
  const summary = useMemo(
    () =>
      capturedDiff === undefined ? undefined : buildCompletedChangeSummary(capturedDiff.files),
    [capturedDiff]
  );
  const completeness = capturedDiff?.completeness;

  if (!run || run.status !== 'COMPLETED') {
    return null;
  }

  let captureStatus: CaptureStatus = 'LOADING';
  if (!snapshot && capturePending) {
    captureStatus = 'CAPTURE_PENDING';
  } else if (!snapshot) {
    captureStatus = 'NOT_CAPTURED';
  } else if (!diffArtifact) {
    captureStatus = 'DIFF_UNAVAILABLE';
  } else if (
    artifactLoad.status === 'FAILED' &&
    artifactLoad.artifactId === diffArtifact.id
  ) {
    captureStatus = 'READ_FAILED';
  } else if (completeness === 'UNINTERPRETABLE') {
    captureStatus = 'UNINTERPRETABLE';
  } else if (summary) {
    captureStatus = 'CAPTURED';
  } else if (artifactText !== undefined) {
    captureStatus = 'NO_CHANGES';
  }

  return (
    <CompletedChangeSummaryCard
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
  summary,
  captureStatus,
  snapshot,
  incomplete = false,
  historical = false,
  onViewDiff
}: {
  summary?: CompletedChangeSummary;
  captureStatus: CaptureStatus;
  snapshot?: GitSnapshotRecord;
  incomplete?: boolean;
  historical?: boolean;
  onViewDiff?(): void;
}) {
  const title =
    incomplete && summary
      ? `Incomplete captured diff · ${summary.fileCount} observed ${plural(summary.fileCount, 'file')}`
      : summary?.title ?? 'Captured Git changes';

  return (
    <section className="tm-change-summary" aria-label="Captured Git changes">
      <div className="tm-change-summary__head">
        <span className="tm-change-summary__icon" aria-hidden="true">
          <FilePlus2 absoluteStrokeWidth size={16} strokeWidth={1.5} />
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
          <span aria-hidden="true">·</span>
          <time dateTime={snapshot.capturedAt}>{formatCaptureTime(snapshot.capturedAt)}</time>
        </p>
      ) : null}
      {historical ? (
        <p className="tm-change-summary__notice">
          Historical capture — the worktree changed later.
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

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tm-diffstat">
      <span>+{additions}</span>
      <span>-{deletions}</span>
    </span>
  );
}

function formatCaptureTime(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
