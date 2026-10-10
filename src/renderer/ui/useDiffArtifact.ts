import { useEffect, useMemo, useState } from 'react';
import type { ArtifactRecord } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { inspectGitDiffEvidence, parseGitDiffEvidenceForScope, type DiffEvidenceScope, type GitDiffEvidenceInspection, type DiffFile } from '../model/diffEvidence';

type LoadState =
  | { status: 'IDLE' }
  | { status: 'LOADING'; artifactId: string }
  | { status: 'LOADED'; artifactId: string; text: string }
  | { status: 'FAILED'; artifactId: string; error: string };

export interface DiffArtifactView {
  loading: boolean;
  error?: string;
  /** No artifact to read: the capture has not happened or was not kept. */
  missing: boolean;
  inspection: GitDiffEvidenceInspection;
  filesByScope: Record<DiffEvidenceScope, DiffFile[]>;
}

const EMPTY_INSPECTION: GitDiffEvidenceInspection = { files: [], completeness: 'COMPLETE' };

/** Reads and parses one captured diff artifact; stale responses for another artifact are ignored. */
export function useDiffArtifact(artifactId: string | undefined, artifacts: readonly ArtifactRecord[]): DiffArtifactView {
  const artifact = artifactId ? artifacts.find((candidate) => candidate.id === artifactId) : undefined;
  const [load, setLoad] = useState<LoadState>({ status: 'IDLE' });

  useEffect(() => {
    let canceled = false;
    if (!artifact) {
      setLoad({ status: 'IDLE' });
      return () => { canceled = true; };
    }
    setLoad({ status: 'LOADING', artifactId: artifact.id });
    void taskManagerApi.readArtifact({ artifactId: artifact.id })
      .then((text) => { if (!canceled) setLoad({ status: 'LOADED', artifactId: artifact.id, text }); })
      .catch((error: unknown) => {
        if (!canceled) setLoad({ status: 'FAILED', artifactId: artifact.id, error: error instanceof Error ? error.message : 'Could not read the diff.' });
      });
    return () => { canceled = true; };
  }, [artifact?.id, artifact?.byteCount, artifact?.updatedAt]);

  const text = load.status === 'LOADED' && load.artifactId === artifact?.id ? load.text : '';
  const inspection = useMemo(() => (text ? inspectGitDiffEvidence(text) : EMPTY_INSPECTION), [text]);
  const filesByScope = useMemo(() => ({
    all: inspection.files,
    committed: text ? parseGitDiffEvidenceForScope(text, 'committed') : [],
    uncommitted: text ? parseGitDiffEvidenceForScope(text, 'uncommitted') : []
  }), [inspection.files, text]);

  return {
    loading: Boolean(artifact) && !((load.status === 'LOADED' || load.status === 'FAILED') && load.artifactId === artifact?.id),
    error: load.status === 'FAILED' && load.artifactId === artifact?.id ? load.error : undefined,
    missing: !artifact,
    inspection,
    filesByScope
  };
}
