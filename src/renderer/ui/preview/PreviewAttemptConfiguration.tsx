import { useEffect, useState } from 'react';
import type { AttemptSummary, ConfigurationBindingsInspection, PreviewStatus } from 'previewhost';
import type { OpenTargetRef } from '../../../shared/contracts';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import { previewRunRows } from '../../model/applicationPreviewRuns';
import { message, PreviewRunReview } from './previewPresentation';

/** The configuration one run started with, read-only, in the same rows as the file view. */
export function PreviewAttemptConfiguration({ taskId, attempt, status, projectDirectory, onBack }: {
  taskId: string;
  attempt: AttemptSummary;
  status?: PreviewStatus;
  projectDirectory?: string;
  onBack(): void;
}) {
  const [inspection, setInspection] = useState<ConfigurationBindingsInspection>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    setInspection(undefined);
    setError(undefined);
    api.inspectApplicationPreviewConfiguration({ taskId, attemptId: attempt.id, changes: [] }).then(
      (value) => {
        if (!disposed) setInspection(value);
      },
      (cause) => {
        if (!disposed) setError(message(cause));
      }
    );
    return () => {
      disposed = true;
    };
  }, [taskId, attempt.id]);
  const run = previewRunRows(status, false).find((row) => row.attempt.id === attempt.id);
  const sourceTargets = Object.fromEntries(
    attempt.sources.map((source, sourceIndex): [string, OpenTargetRef] => [source, { type: 'previewSource', taskId, attemptId: attempt.id, sourceIndex }])
  );
  return (
    <div className="tm-preview-configuration" aria-label="Configuration used for this run">
      <div className="tm-preview-configuration__toolbar">
        <span className="tm-preview-configuration__file">
          <strong>Run configuration</strong>
          {run ? ` · ${run.time} · ${run.outcome.toLowerCase()}` : ''} · read-only
        </span>
        <button type="button" className="ghost-button" onClick={onBack}>Back to preview.yaml</button>
      </div>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      {!inspection && !error ? <p className="tm-preview-help" role="status">Reading the run’s configuration…</p> : null}
      {inspection ? (
        <PreviewRunReview
          heading="What ran"
          description={inspection.description}
          projectDirectory={projectDirectory}
          outcomes={attempt.services}
          sourceTargets={sourceTargets}
        />
      ) : null}
    </div>
  );
}
