import { useEffect, useMemo, useState } from 'react';
import type { AttemptSummary, ConfigurationBindingsInspection, PreviewStatus } from 'previewhost';
import type { OpenTargetRef } from '../../../shared/contracts';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import { previewRunRows } from '../../model/applicationPreviewRuns';
import { configurationOverview, describedEntries, describedSecrets } from '../../model/previewConfigurationModel';
import { ConfigurationGroups, EntryRow } from './ApplicationConfiguration';
import { message, StateWord } from './previewPresentation';
import { SourceFolderActions } from './PreviewSourceFolder';

/** The configuration one run started with, read-only, in the same groups and rows as the file view. */
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
  const overview = useMemo(
    () => (inspection ? configurationOverview(describedEntries(inspection.description), describedSecrets(inspection.description)) : undefined),
    [inspection]
  );
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
        <div className="tm-preview-configuration__views">
          <button type="button" className="ghost-button" onClick={onBack}>Back to preview.yaml</button>
        </div>
      </div>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      {!inspection && !error ? <p className="tm-preview-help" role="status">Reading the run’s configuration…</p> : null}
      {overview ? (
        <ConfigurationGroups
          overview={overview}
          projectDirectory={projectDirectory}
          entry={(entry) => {
            const outcome = attempt.services?.[entry.id];
            return <EntryRow entry={entry} projectDirectory={projectDirectory} end={outcome ? <StateWord service={outcome} /> : undefined} />;
          }}
          folderEnd={(path) => (sourceTargets[path] ? <SourceFolderActions source={path} target={sourceTargets[path]!} /> : null)}
        />
      ) : null}
    </div>
  );
}
