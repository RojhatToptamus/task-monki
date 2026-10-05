import { applicationPreviewStatus } from '../../model/applicationPreviewStatus';
import { Chip } from '../StatusBadge';
import { Ellipsis } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ApplicationPreviewSnapshot } from '../../../shared/applicationPreview';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import { AccessibleTab } from '../AccessibleTabs';
import { ActionMenu } from '../ActionMenu';
import {
  message,
  expected,
  PreviewDialog,
  ConfigurationDefinitions
} from './previewPresentation';
import { ApplicationLogs } from './ApplicationLogs';
import { ApplicationActivity } from './ApplicationActivity';
import { ApplicationConfiguration } from './ApplicationConfiguration';

function useApplicationPreview(taskId: string) {
  const [snapshot, setSnapshot] = useState<ApplicationPreviewSnapshot>();
  const [error, setError] = useState<string>();
  const readNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    let disposed = false;
    let reading = false;
    let refreshPending = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      if (disposed || document.visibilityState !== 'visible') return;
      if (reading) {
        refreshPending = true;
        return;
      }
      clearTimeout(timer);
      reading = true;
      try {
        const value = await api.getApplicationPreview({ taskId });
        if (!disposed) {
          setSnapshot(value);
          setError(undefined);
        }
      } catch (cause) {
        if (!disposed) setError(message(cause));
      }
      reading = false;
      if (!disposed)
        timer = setTimeout(() => void read(), refreshPending ? 0 : 1000);
      refreshPending = false;
    }
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') void read();
    };
    readNow.current = () => void read();
    void read();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      readNow.current = () => undefined;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [taskId]);
  return { snapshot, error, refresh: () => readNow.current() };
}

export function ApplicationPreviewOverview({
  taskId,
  onOpen
}: {
  taskId: string;
  onOpen(): void;
}) {
  const { snapshot, error } = useApplicationPreview(taskId);
  if (!snapshot?.status && !error) return null;
  return (
    <section className="tm-panel tm-preview-card" aria-label="Preview summary">
      <div className="tm-preview-card__head">
        <h3 className="tm-panel__title">Preview</h3>
        <span>
          {error
            ? 'Unavailable'
            : applicationPreviewStatus(snapshot?.status, !!snapshot?.approval)
                .label}
        </span>
      </div>
      <button className="outline-button" onClick={onOpen}>
        View Preview
      </button>
    </section>
  );
}

export function ApplicationPreviewPanel({
  taskId,
  projectName,
  setup,
  onOpenSecrets,
  onModalOpenChange
}: {
  taskId: string;
  projectName?: string;
  setup?: React.ReactNode;
  onOpenSecrets?(references: string[]): void;
  onModalOpenChange?(open: boolean): void;
}) {
  const { snapshot, error: readError, refresh } = useApplicationPreview(taskId);
  const [section, setSection] = useState<'Activity' | 'Logs' | 'Configuration'>(
    'Activity'
  );
  const root = useRef<HTMLElement>(null);
  function selectSection(value: 'Activity' | 'Logs' | 'Configuration') {
    setSection(value);
    root.current
      ?.querySelector<HTMLButtonElement>(`#preview-tab-${value}`)
      ?.focus();
  }
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [logSelection, setLogSelection] = useState<{
    attemptId: string;
    source?: string;
  }>();
  const [confirmData, setConfirmData] = useState(false);
  const status = snapshot?.status;
  const serving = status?.active;
  const latest = status?.candidate ?? status?.latest;
  const initialConfiguration = !!snapshot && !serving && !latest;
  const configurationEntry =
    initialConfiguration &&
    section === 'Configuration' &&
    (snapshot.hasConfigurationFile || !!setup);
  const presentation = applicationPreviewStatus(status, !!snapshot?.approval);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const showLogs = (attemptId: string, source?: string) => {
    setLogSelection({ attemptId, source });
    selectSection('Logs');
  };
  const start = () =>
    void run(() =>
      api.startApplicationPreview({
        taskId,
        source:
          status?.latest &&
          !snapshot?.designAttempts?.includes(status.latest.id)
            ? 'retained'
            : 'file'
      })
    );
  return (
    <section
      ref={root}
      className="tm-preview-workspace tm-application-preview"
      aria-label="Application preview"
    >
      <header className="tm-preview-workspace__head">
        <div className="tm-preview-workspace__decision">
          <div className="tm-preview-statusline">
            <strong>{projectName ?? 'Application'}</strong>
            <span role="status">
              <Chip
                tone={readError ? 'error' : presentation.tone}
                label={
                  readError
                    ? 'Unavailable'
                    : snapshot
                      ? presentation.label
                      : 'Loading…'
                }
              />
            </span>
          </div>
          {status?.url && serving ? (
            <code className="tm-application-preview__url">{status.url}</code>
          ) : null}
        </div>
        <div className="tm-preview-workspace__actions">
          {serving ? (
            <button
              className="primary-button"
              disabled={busy || !!readError}
              onClick={() =>
                void run(() =>
                  api.openApplicationPreview({ taskId, attemptId: serving.id })
                )
              }
            >
              Open app
            </button>
          ) : null}
          {status?.candidate ? (
            <button
              className="outline-button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api.cancelApplicationPreview({
                    taskId,
                    attemptId: status.candidate!.id
                  })
                )
              }
            >
              Cancel
            </button>
          ) : serving || status?.cleanup?.length || status?.data?.cleanup ? (
            <button
              className="outline-button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api.stopApplicationPreview({
                    taskId,
                    expected: expected(status)
                  })
                ).then(() =>
                  root.current
                    ?.querySelector<HTMLElement>(
                      '[role="tab"][aria-selected="true"]'
                    )
                    ?.focus()
                )
              }
            >
              {status.cleanup?.length || status.data?.cleanup
                ? 'Retry cleanup'
                : 'Stop'}
            </button>
          ) : !configurationEntry ? (
            <button
              className="primary-button"
              disabled={busy || !snapshot || status?.busy}
              onClick={() =>
                !status?.latest && !snapshot?.hasConfigurationFile
                  ? selectSection('Configuration')
                  : start()
              }
            >
              {!status?.latest && !snapshot?.hasConfigurationFile
                ? 'Configure'
                : 'Start'}
            </button>
          ) : null}
          <ActionMenu
            label="More preview actions"
            trigger={<Ellipsis size={16} aria-hidden="true" />}
            items={[
              {
                label: serving
                  ? 'Update from preview.yaml'
                  : 'Load preview.yaml',
                disabled:
                  busy ||
                  status?.busy ||
                  !!status?.candidate ||
                  (!!serving &&
                    !!snapshot?.designAttempts?.includes(serving.id)),
                disabledReason:
                  serving && snapshot?.designAttempts?.includes(serving.id)
                    ? 'Stop the Design preview before loading workspace configuration.'
                    : 'Wait for the current preview operation to finish.',
                onSelect: () =>
                  void run(() =>
                    api.startApplicationPreview({ taskId, source: 'file' })
                  )
              },
              ...(status?.data
                ? [
                    {
                      label: 'Delete data…',
                      danger: true,
                      disabled:
                        busy || !!serving || !!status.candidate || status.busy,
                      disabledReason:
                        'Stop the preview before deleting retained data.',
                      onSelect: () => setConfirmData(true)
                    }
                  ]
                : []),
              ...(status?.url
                ? [
                    {
                      label: 'Copy URL',
                      onSelect: () =>
                        void run(() =>
                          navigator.clipboard.writeText(status.url!)
                        )
                    }
                  ]
                : [])
            ]}
          />
        </div>
      </header>
      {serving && latest?.id !== serving.id && latest?.state === 'failed' ? (
        <p className="tm-application-preview__notice">
          The previous app is still serving. Source edits and database writes
          are not rolled back.
        </p>
      ) : null}
      {readError || (error && !snapshot?.approval && !confirmData) ? (
        <p className="tm-application-preview__error" role="alert">
          {error ?? readError}
        </p>
      ) : null}
      {status?.cleanup?.map((item) => (
        <p className="tm-application-preview__error" key={item.attemptId}>
          {item.error.message}
        </p>
      ))}
      <nav className="tm-tabs" role="tablist" aria-label="Preview sections">
        {(['Activity', 'Logs', 'Configuration'] as const).map((value) => (
          <AccessibleTab
            key={value}
            id={`preview-tab-${value}`}
            panelId={`preview-panel-${value}`}
            label={value}
            selected={section === value}
            onSelect={() => {
              if (value === 'Logs' && !logSelection && (serving ?? latest))
                setLogSelection({ attemptId: (serving ?? latest)!.id });
              setSection(value);
            }}
          />
        ))}
      </nav>
      <div
        role="tabpanel"
        id="preview-panel-Activity"
        aria-labelledby="preview-tab-Activity"
        hidden={section !== 'Activity'}
      >
        <ApplicationActivity
          taskId={taskId}
          status={status}
          busy={busy}
          onLogs={showLogs}
          onOpenSecrets={onOpenSecrets}
          onConfigure={() => selectSection('Configuration')}
          onRerun={(attemptId, job) =>
            void run(() =>
              api.rerunApplicationPreviewJob({ taskId, attemptId, job })
            )
          }
        />
      </div>
      <div
        role="tabpanel"
        id="preview-panel-Logs"
        aria-labelledby="preview-tab-Logs"
        hidden={section !== 'Logs'}
      >
        <ApplicationLogs
          taskId={taskId}
          status={status}
          selection={logSelection}
          onSelect={setLogSelection}
          active={section === 'Logs'}
        />
      </div>
      <div
        role="tabpanel"
        id="preview-panel-Configuration"
        aria-labelledby="preview-tab-Configuration"
        hidden={section !== 'Configuration'}
      >
        {initialConfiguration ? (
          snapshot.hasConfigurationFile ? (
            <div className="tm-application-preview__empty">
              <h3>Configuration ready</h3>
              <p>Review preview.yaml to start this application.</p>
              <button
                className="primary-button"
                disabled={busy || status?.busy}
                onClick={start}
              >
                Review and start
              </button>
            </div>
          ) : (
            setup
          )
        ) : (
          <ApplicationConfiguration
            designAttempts={snapshot?.designAttempts}
            onOpenSecrets={onOpenSecrets}
            taskId={taskId}
            status={status}
            onChanged={refresh}
            onModalOpenChange={onModalOpenChange}
          />
        )}
      </div>
      {snapshot?.approval ? (
        <PreviewDialog
          onOpenChange={onModalOpenChange}
          size="review"
          returnFocus={root.current?.querySelector<HTMLElement>(
            '[role="tab"][aria-selected="true"]'
          )}
          title={serving ? 'Review update' : 'Review and start'}
          busy={busy}
          onClose={() =>
            void run(() =>
              api.cancelApplicationPreview({
                taskId,
                attemptId: snapshot.approval!.attemptId
              })
            )
          }
          footer={
            <>
              <button
                className="outline-button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api.cancelApplicationPreview({
                      taskId,
                      attemptId: snapshot.approval!.attemptId
                    })
                  )
                }
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api.approveApplicationPreview({
                      taskId,
                      attemptId: snapshot.approval!.attemptId
                    })
                  )
                }
              >
                {serving ? 'Approve update' : 'Approve and start'}
              </button>
            </>
          }
        >
          <p>
            Allow these services to run with the listed source access and secret
            references.
          </p>
          <ConfigurationDefinitions
            description={snapshot.approval.description}
          />
          {snapshot.approval.description.spec.type === 'compose' && serving ? (
            <p>
              The current app stops before this update starts. Retained data and
              writes are not rolled back.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
      {confirmData && status?.data ? (
        <PreviewDialog
          onOpenChange={onModalOpenChange}
          size="compact"
          title="Delete retained data?"
          returnFocus={root.current?.querySelector<HTMLElement>(
            '[role="tab"][aria-selected="true"]'
          )}
          busy={busy}
          onClose={() => setConfirmData(false)}
          footer={
            <>
              <button
                className="outline-button"
                disabled={busy}
                onClick={() => setConfirmData(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.deleteApplicationPreviewData({
                      taskId,
                      expected: {
                        attemptId: status.latest?.id ?? null,
                        resources: status.data!.resources
                      }
                    });
                    setConfirmData(false);
                  })
                }
              >
                Delete data
              </button>
            </>
          }
        >
          <p>
            This permanently deletes{' '}
            {status.data.resources.map((value) => value.name).join(', ')} for
            this worktree. Source files and secret references remain.
          </p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
    </section>
  );
}
