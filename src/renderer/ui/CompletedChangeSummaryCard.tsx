import { useEffect, useMemo, useState } from 'react';
import type {
  ArtifactRecord,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import {
  buildCompletedChangeSummary,
  selectCompletedRunChangeSnapshot,
  type CompletedChangeFile,
  type CompletedChangeSummary
} from '../model/completedChangeSummary';
import { parseGitDiffEvidence } from '../model/diffEvidence';

interface CompletedChangeSummaryPanelProps {
  run?: RunRecord;
  gitSnapshots: GitSnapshotRecord[];
  artifacts: ArtifactRecord[];
  onReviewChanges(snapshotId: string): void;
}

export function CompletedChangeSummaryPanel({
  run,
  gitSnapshots,
  artifacts,
  onReviewChanges
}: CompletedChangeSummaryPanelProps) {
  const snapshot = useMemo(
    () => selectCompletedRunChangeSnapshot(run, gitSnapshots),
    [run, gitSnapshots]
  );
  const diffArtifact = snapshot?.diffArtifactId
    ? artifacts.find((artifact) => artifact.id === snapshot.diffArtifactId)
    : undefined;
  const [artifactText, setArtifactText] = useState('');

  useEffect(() => {
    let canceled = false;
    setArtifactText('');

    if (!diffArtifact) {
      return () => {
        canceled = true;
      };
    }

    void taskManagerApi
      .readArtifact({ artifactId: diffArtifact.id })
      .then((text) => {
        if (!canceled) {
          setArtifactText(text);
        }
      })
      .catch(() => {
        if (!canceled) {
          setArtifactText('');
        }
      });

    return () => {
      canceled = true;
    };
  }, [diffArtifact?.id, diffArtifact?.byteCount, diffArtifact?.updatedAt]);

  const summary = useMemo(
    () => buildCompletedChangeSummary(parseGitDiffEvidence(artifactText)),
    [artifactText]
  );

  if (!snapshot || !diffArtifact || !summary) {
    return null;
  }

  return (
    <CompletedChangeSummaryCard
      summary={summary}
      onReviewChanges={() => onReviewChanges(snapshot.id)}
    />
  );
}

export function CompletedChangeSummaryCard({
  summary,
  onReviewChanges
}: {
  summary: CompletedChangeSummary;
  onReviewChanges(): void;
}) {
  return (
    <section className="tm-change-summary" aria-label="Completed change summary">
      <div className="tm-change-summary__head">
        <span className="tm-change-summary__icon" aria-hidden="true">
          <ChangeSummaryIcon />
        </span>
        <div className="tm-change-summary__title">
          <h3>{summary.title}</h3>
          <DiffStat additions={summary.additions} deletions={summary.deletions} />
        </div>
        <button type="button" className="outline-button" onClick={onReviewChanges}>
          Review changes
        </button>
      </div>
      <div className="tm-change-summary__files">
        {summary.previewFiles.map((file) => (
          <ChangeFileRow key={file.path} file={file} />
        ))}
        {summary.hiddenFileCount > 0 ? (
          <details className="tm-change-summary__more">
            <summary>Show {summary.hiddenFileCount} more {plural(summary.hiddenFileCount, 'file')}</summary>
            <div>
              {summary.hiddenFiles.map((file) => (
                <ChangeFileRow key={file.path} file={file} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function ChangeFileRow({ file }: { file: CompletedChangeFile }) {
  const slash = file.path.lastIndexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <div className="tm-change-summary__file" title={file.path}>
      {/* Dimmed directory + bright basename so the eye scans on filenames
          (spec §Completed: "directories dimmed so basenames scan"). */}
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

function ChangeSummaryIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M3.25 2.75h7.25l2.25 2.25v8.25h-9.5z" />
      <path d="M10.5 2.75V5h2.25" />
      <path d="M8 6.25v4.5M5.75 8.5h4.5" />
    </svg>
  );
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
