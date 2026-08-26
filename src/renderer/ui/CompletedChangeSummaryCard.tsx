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
  selectCompletedRunChangeSnapshot,
  type CompletedChangeFile,
  type CompletedChangeSummary
} from '../model/completedChangeSummary';
import { parseGitDiffEvidence } from '../model/diffEvidence';
import { DisclosureChevron } from './DisclosureChevron';

interface CompletedChangeSummaryPanelProps {
  run?: RunRecord;
  gitSnapshots: GitSnapshotRecord[];
  artifacts: ArtifactRecord[];
  onViewDiff(snapshotId: string): void;
}

export function CompletedChangeSummaryPanel({
  run,
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
      onViewDiff={() => onViewDiff(snapshot.id)}
    />
  );
}

export function CompletedChangeSummaryCard({
  summary,
  onViewDiff
}: {
  summary: CompletedChangeSummary;
  onViewDiff(): void;
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
        <button type="button" className="outline-button" onClick={onViewDiff}>
          View diff
        </button>
      </div>
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
  return <FilePlus2 aria-hidden="true" absoluteStrokeWidth size={16} strokeWidth={1.5} />;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
