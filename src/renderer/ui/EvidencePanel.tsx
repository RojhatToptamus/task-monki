import { useEffect, useState } from 'react';
import type { ArtifactRecord, RunRecord } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { StatusBadge } from './StatusBadge';

interface EvidencePanelProps {
  run?: RunRecord;
  artifacts: ArtifactRecord[];
}

export function EvidencePanel({ run, artifacts }: EvidencePanelProps) {
  const [artifactText, setArtifactText] = useState('');
  const [artifactError, setArtifactError] = useState<string | undefined>();

  const finalArtifact = run?.finalArtifactId
    ? artifacts.find((artifact) => artifact.id === run.finalArtifactId)
    : undefined;
  const stderrArtifact = run
    ? artifacts.find((artifact) => artifact.id === run.stderrArtifactId)
    : undefined;

  useEffect(() => {
    let canceled = false;

    async function loadArtifact() {
      setArtifactError(undefined);
      setArtifactText('');

      const artifactId = finalArtifact?.id ?? stderrArtifact?.id;
      if (!artifactId) {
        return;
      }

      try {
        const text = await taskManagerApi.readArtifact({ artifactId });
        if (!canceled) {
          setArtifactText(text);
        }
      } catch (error) {
        if (!canceled) {
          setArtifactError(error instanceof Error ? error.message : 'Could not read artifact.');
        }
      }
    }

    void loadArtifact();
    return () => {
      canceled = true;
    };
  }, [finalArtifact?.id, stderrArtifact?.id]);

  return (
    <section className="panel panel--evidence">
      <div className="panel__header">
        <h3>Evidence</h3>
        {run ? <span>Run {run.id.slice(0, 8)}</span> : <span>No run</span>}
      </div>

      {run ? (
        <>
          <div className="evidence-grid">
            <StatusBadge label="Process" value={run.processStatus} />
            <StatusBadge label="Codex" value={run.status} />
            <StatusBadge label="Events" value={String(run.eventCount)} />
            <StatusBadge label="Exit" value={run.exitCode === undefined ? '—' : String(run.exitCode)} />
          </div>
          <div className="artifact-box">
            <div className="artifact-box__header">
              <strong>{finalArtifact ? 'Final artifact' : 'stderr / diagnostics'}</strong>
              <span>{finalArtifact?.byteCount ?? stderrArtifact?.byteCount ?? 0} bytes</span>
            </div>
            {artifactError ? <p className="form-error">{artifactError}</p> : null}
            <pre>{artifactText || 'No artifact content yet.'}</pre>
          </div>
        </>
      ) : (
        <p className="muted">Start a read-only Codex run to capture process and JSONL evidence.</p>
      )}
    </section>
  );
}
