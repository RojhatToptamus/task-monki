import { useEffect, useState } from 'react';
import type {
  ArtifactRecord,
  GitSnapshotRecord,
  RunRecord,
  TestRunRecord,
  WorktreeRecord
} from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { StatusBadge } from './StatusBadge';

interface EvidencePanelProps {
  run?: RunRecord;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  testRun?: TestRunRecord;
  artifacts: ArtifactRecord[];
}

export function EvidencePanel({ run, worktree, gitSnapshot, testRun, artifacts }: EvidencePanelProps) {
  const [artifactText, setArtifactText] = useState('');
  const [artifactError, setArtifactError] = useState<string | undefined>();

  const finalArtifact = run?.finalArtifactId
    ? artifacts.find((artifact) => artifact.id === run.finalArtifactId)
    : undefined;
  const stderrArtifact = run
    ? artifacts.find((artifact) => artifact.id === run.stderrArtifactId)
    : undefined;
  const diffArtifact = gitSnapshot?.diffArtifactId
    ? artifacts.find((artifact) => artifact.id === gitSnapshot.diffArtifactId)
    : undefined;
  const testStdoutArtifact = testRun
    ? artifacts.find((artifact) => artifact.id === testRun.stdoutArtifactId)
    : undefined;

  useEffect(() => {
    let canceled = false;

    async function loadArtifact() {
      setArtifactError(undefined);
      setArtifactText('');

      const artifactId = finalArtifact?.id ?? diffArtifact?.id ?? testStdoutArtifact?.id ?? stderrArtifact?.id;
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
  }, [diffArtifact?.id, finalArtifact?.id, stderrArtifact?.id, testStdoutArtifact?.id]);

  return (
    <section className="panel panel--evidence">
      <div className="panel__header">
        <h3>Evidence</h3>
        {run ? <span>Run {run.id.slice(0, 8)}</span> : <span>No run</span>}
      </div>

      {run || worktree || gitSnapshot || testRun ? (
        <div className="evidence-stack">
          <div className="evidence-grid">
            {worktree ? <StatusBadge label="Worktree" value={worktree.status} /> : null}
            {gitSnapshot ? <StatusBadge label="Git" value={gitSnapshot.status} /> : null}
            {testRun ? <StatusBadge label="Tests" value={testRun.status} /> : null}
            {run ? <StatusBadge label="Process" value={run.processStatus} /> : null}
            {run ? <StatusBadge label="Codex" value={run.status} /> : null}
            {run ? <StatusBadge label="Events" value={String(run.eventCount)} /> : null}
            {run ? (
              <StatusBadge label="Exit" value={run.exitCode === undefined ? '—' : String(run.exitCode)} />
            ) : null}
          </div>
          {gitSnapshot ? (
            <div className="metadata-grid metadata-grid--compact">
              <span>Head</span>
              <strong>{gitSnapshot.headSha?.slice(0, 12) ?? 'unknown'}</strong>
              <span>Dirty fingerprint</span>
              <strong>{gitSnapshot.dirtyFingerprint.slice(0, 12)}</strong>
              <span>Changed files</span>
              <strong>
                committed {gitSnapshot.committedDiffFileCount}, working {gitSnapshot.workingDiffFileCount}
              </strong>
              <span>Counts</span>
              <strong>
                staged {gitSnapshot.stagedCount}, unstaged {gitSnapshot.unstagedCount}, untracked{' '}
                {gitSnapshot.untrackedCount}
              </strong>
            </div>
          ) : null}
          {testRun ? (
            <div className="metadata-grid metadata-grid--compact">
              <span>Test command</span>
              <strong>{testRun.command}</strong>
              <span>Tested head</span>
              <strong>{testRun.testedHeadSha?.slice(0, 12) ?? 'unknown'}</strong>
              <span>Tested fingerprint</span>
              <strong>{testRun.testedDirtyFingerprint?.slice(0, 12) ?? 'unknown'}</strong>
              <span>Exit</span>
              <strong>{testRun.exitCode === undefined ? '—' : String(testRun.exitCode)}</strong>
            </div>
          ) : null}
          <div className="artifact-box">
            <div className="artifact-box__header">
              <strong>{artifactLabel({ finalArtifact, diffArtifact, testStdoutArtifact })}</strong>
              <span>
                {finalArtifact?.byteCount ??
                  diffArtifact?.byteCount ??
                  testStdoutArtifact?.byteCount ??
                  stderrArtifact?.byteCount ??
                  0}{' '}
                bytes
              </span>
            </div>
            {artifactError ? <p className="form-error">{artifactError}</p> : null}
            <pre>{artifactText || 'No artifact content yet.'}</pre>
          </div>
        </div>
      ) : (
        <p className="muted">Prepare a worktree to capture Git, Codex, diff, and test evidence.</p>
      )}
    </section>
  );
}

function artifactLabel(input: {
  finalArtifact?: ArtifactRecord;
  diffArtifact?: ArtifactRecord;
  testStdoutArtifact?: ArtifactRecord;
}): string {
  if (input.finalArtifact) {
    return 'Codex final artifact';
  }
  if (input.diffArtifact) {
    return 'Git diff artifact';
  }
  if (input.testStdoutArtifact) {
    return 'Test stdout artifact';
  }
  return 'stderr / diagnostics';
}
