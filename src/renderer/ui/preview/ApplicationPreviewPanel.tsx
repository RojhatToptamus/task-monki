import { useEffect, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import type {
  ApplicationPreviewSnapshot,
  PreviewConfigurationFile
} from '../../../shared/applicationPreview';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import { applicationPreviewStatus } from '../../model/applicationPreviewStatus';
import { Chip } from '../StatusBadge';
import { AccessibleTab } from '../AccessibleTabs';
import { ActionMenu } from '../ActionMenu';
import { DecisionBlock } from '../DecisionBlock';
import { DisclosureChevron } from '../DisclosureChevron';
import {
  message,
  expected,
  PreviewDialog,
  ConfigurationDefinitions,
  PreviewRunReview
} from './previewPresentation';
import { ApplicationLogs } from './ApplicationLogs';
import { ApplicationActivity } from './ApplicationActivity';
import { PreviewSecretDialog } from './PreviewSecretDialog';
import {
  ApplicationConfiguration,
  type PreviewEditorDraft,
  type ConfigurationView
} from './ApplicationConfiguration';
import type { PreviewAgentActions } from './PreviewAgentActions';
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
  agent,
  onTaskAgent,
  onModalOpenChange
}: {
  taskId: string;
  projectName?: string;
  agent?: PreviewAgentActions;
  onTaskAgent?(text: string): void | Promise<void>;
  onModalOpenChange?(open: boolean): void;
}) {
  const { snapshot, error: readError, refresh } = useApplicationPreview(taskId);
  const root = useRef<HTMLElement>(null);
  const [section, setSection] = useState<'Activity' | 'Configuration' | 'Logs'>(
    'Activity'
  );
  const [view, setView] = useState<ConfigurationView>('Configuration');
  const [draft, setDraft] = useState<PreviewEditorDraft>();
  const [previous, setPrevious] = useState<PreviewConfigurationFile>();
  const [reconciliation, setReconciliation] = useState<{
    text: string;
    changes: string[];
    concealedKeys: string[];
  }>();
  const [conflicts, setConflicts] = useState<PreviewConfigurationFile[]>();
  const [clarification, setClarification] = useState('');
  const [showAgent, setShowAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dismissed, setDismissed] = useState<string>();
  const [logSelection, setLogSelection] = useState<{
    attemptId: string;
    source?: string;
    failure?: boolean;
  }>();
  const [secretReferences, setSecretReferences] = useState<string[]>();
  const [confirmData, setConfirmData] = useState(false);
  const [chosenFolders, setChosenFolders] = useState<Record<string, string>>(
    {}
  );
  const generation = agent?.state;
  const generating = generation?.status === 'GENERATING';
  const loadedProposal = useRef<string | undefined>(undefined);
  const status = snapshot?.status;
  const serving = status?.active;
  const latest = status?.candidate ?? status?.latest;
  const approval = snapshot?.approval;
  const restart = snapshot?.restartReview;
  const secrets = approval?.secrets ?? snapshot?.requirements?.secrets ?? [];
  const sources = snapshot?.requirements?.sources ?? [];
  const folderRequirements = new Map<
    string,
    { source: (typeof sources)[number]; services: string[] }
  >();
  for (const source of sources) {
    if (source.connected) continue;
    const key = `${source.declaration}\0${source.directory}`;
    const group = folderRequirements.get(key);
    if (group) group.services.push(source.service);
    else folderRequirements.set(key, { source, services: [source.service] });
  }
  const storage = snapshot?.requirements?.storage;
  const blockers =
    (storage && storage.state !== 'unlocked' ? 1 : 0) +
    folderRequirements.size +
    secrets.filter((secret) => secret.availability !== 'available').length +
    (snapshot?.requirements?.connections.length ?? 0) +
    (snapshot?.requirements?.description?.prerequisites?.filter(
      (item) => item.status === 'missing'
    ).length ?? 0);
  const dirty =
    !!draft && (!!draft.draftId || draft.text !== draft.original?.text);
  const diagnosis =
    snapshot?.diagnosis?.attemptId !== dismissed
      ? snapshot?.diagnosis
      : undefined;
  const presentation = applicationPreviewStatus(
    status,
    !!approval || !!restart
  );
  const editable = !serving || !snapshot?.designAttempts?.includes(serving.id);
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
  async function loadFile(nextView: ConfigurationView = 'Configuration') {
    const value = await api.readApplicationPreviewFile({ taskId });
    setDraft({
      original: value.file,
      text:
        value.file?.text ??
        '# Describe the services this project needs.\nname: application\ntype: static\ndirectory: .\n'
    });
    setPrevious(value.previous);
    setReconciliation(value.reconciliation);
    setConflicts(value.files);
    setView(nextView);
    setSection('Configuration');
  }
  useEffect(() => {
    if (generation?.status === 'NEEDS_INPUT') {
      setSection('Configuration');
      setShowAgent(true);
    }
    const proposal = generation?.draft;
    if (!proposal || proposal.id === loadedProposal.current) return;
    let disposed = false;
    void api.readApplicationPreviewFile({ taskId, draftId: proposal.id }).then(
      (value) => {
        if (disposed) return;
        loadedProposal.current = proposal.id;
        setDraft({
          original: value.original,
          text: proposal.yaml,
          draftId: proposal.id
        });
        setSection('Configuration');
        setView('Changes');
        setShowAgent(false);
      },
      (cause) => {
        if (!disposed) setError(message(cause));
      }
    );
    return () => {
      disposed = true;
    };
  }, [taskId, generation?.draft, generation?.status]);
  async function generate(request?: string) {
    if (!agent) return;
    const value = await api.readApplicationPreviewFile({ taskId });
    if (value.files) {
      setConflicts(value.files);
      setSection('Configuration');
      return;
    }
    setSection('Configuration');
    setShowAgent(true);
    await agent.generate(
      taskId,
      request ?? (clarification.trim() || undefined)
    );
  }
  async function save(review: boolean) {
    if (!draft) return;
    if (draft.draftId && agent) {
      const validation = await agent.validate(
        taskId,
        draft.draftId,
        draft.text
      );
      if (validation.status !== 'VALID')
        throw new Error(
          validation.issues.map((issue) => issue.message).join('\n')
        );
      await agent.accept(taskId, draft.draftId, draft.text);
    } else
      await api.saveApplicationPreviewFile({
        taskId,
        original: draft.original,
        text: draft.text
      });
    const saved = await api.readApplicationPreviewFile({ taskId });
    setDraft(
      saved.file ? { original: saved.file, text: saved.file.text } : undefined
    );
    setPrevious(saved.previous);
    setShowAgent(false);
    if (review) {
      setSection('Activity');
      await api.startApplicationPreview({ taskId });
    }
    root.current
      ?.querySelector<HTMLButtonElement>('[data-preview-primary]')
      ?.focus();
  }
  const start = () => run(() => api.startApplicationPreview({ taskId }));
  const stop = () =>
    run(() =>
      api.stopApplicationPreview({ taskId, expected: expected(status) })
    );
  function showLogs(attemptId: string, source?: string, failure = false) {
    setLogSelection({ attemptId, source, failure });
    setSection('Logs');
  }
  function sendToTaskAgent(text: string) {
    void run(async () => { await onTaskAgent?.(text); });
  }
  function handoff() {
    sendToTaskAgent(
      diagnosis
        ? `Investigate this Preview failure before proposing changes.\n${diagnosis.service ?? 'Application'}: ${diagnosis.observed}\n${diagnosis.excerpt ?? ''}\n${diagnosis.unknown}\nInspect preview.yaml and the relevant project code. Explain the proposed fix before executing it.`
        : 'Inspect preview.yaml and the project requirements. Explain the proposed changes before executing them. Keep secret values concealed.'
    );
  }
  function repair() {
    if (!diagnosis) return;
    if (diagnosis.action === 'task-agent' && onTaskAgent) {
      handoff();
      return;
    }
    if (diagnosis.action === 'logs') {
      showLogs(diagnosis.attemptId, diagnosis.service, true);
      return;
    }
    if (diagnosis.action === 'docker') {
      void start();
      return;
    }
    if (diagnosis.action === 'image' && diagnosis.command) {
      void navigator.clipboard.writeText(diagnosis.command);
      return;
    }
    if (diagnosis.action === 'cleanup') {
      void stop();
      return;
    }
    if (diagnosis.action === 'secrets') {
      setSecretReferences(secrets.map((item) => item.id));
      return;
    }
    if (diagnosis.action === 'source') {
      setSection('Activity');
      return;
    }
    if (diagnosis.action === 'readiness') {
      void run(() => loadFile());
      return;
    }
    void run(() =>
      generate(
        `Investigate ${diagnosis.service ?? 'Application'}: ${diagnosis.observed}. ${diagnosis.command ? `Recommended command: ${diagnosis.command}.` : ''} ${diagnosis.action === 'install' ? 'Propose the evidenced dependency install step and dependency ordering.' : ''} Return a configuration proposal for review; execute nothing.`
      )
    );
  }
  const review = approval?.description ?? restart?.description;
  const reviewId = approval?.attemptId ?? restart?.id;
  const needsRequirements =
    blockers > 0 && (!serving || !!review || snapshot?.configurationChanged);
  const nextLabel =
    status?.candidate && !reviewId
      ? 'Starting preview…'
      : generating
        ? 'Drafting configuration…'
        : dirty
          ? 'Save and review startup'
          : reviewId
            ? restart
              ? 'Approve restart'
              : 'Approve and start'
            : serving
              ? 'Open app'
              : snapshot?.hasConfigurationFile
                ? 'Start preview'
                : 'Draft configuration with agent';
  const primaryDisabled =
    (!!status?.candidate && !reviewId) ||
    busy ||
    generating ||
    !!readError ||
    !snapshot ||
    (!dirty && !!reviewId && blockers > 0) ||
    (!dirty &&
      !serving &&
      snapshot.hasConfigurationFile &&
      (blockers > 0 || !!snapshot.configurationError)) ||
    (!snapshot?.hasConfigurationFile &&
      !dirty &&
      (!agent || !!agent.disabledReason)) ||
    (!editable && dirty);
  async function next() {
    if (dirty) await save(true);
    else if (reviewId) {
      await api.approveApplicationPreview({ taskId, attemptId: reviewId });
      root.current?.querySelector<HTMLElement>('[role="status"]')?.focus();
    } else if (serving)
      await api.openApplicationPreview({ taskId, attemptId: serving.id });
    else if (snapshot?.hasConfigurationFile)
      await api.startApplicationPreview({ taskId });
    else await generate();
  }
  return (
    <section
      ref={root}
      className="tm-preview-workspace tm-application-preview"
      aria-label="Application preview"
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          !reviewId ||
          busy ||
          (event.target as HTMLElement).closest(
            'input, textarea, [role="menu"]'
          )
        )
          return;
        event.preventDefault();
        void run(async () => {
          await api.cancelApplicationPreview({ taskId, attemptId: reviewId });
          root.current
            ?.querySelector<HTMLButtonElement>('[data-preview-primary]')
            ?.focus();
        });
      }}
    >
      <header className="tm-preview-workspace__head">
        <div className="tm-preview-statusline">
          <strong>{projectName ?? 'Application'}</strong>
          <span role="status" tabIndex={-1}>
            <Chip
              tone={readError ? 'error' : presentation.tone}
              label={
                readError
                  ? 'Unavailable'
                  : generating
                    ? 'Drafting configuration'
                    : !snapshot
                      ? 'Checking preview…'
                      : !snapshot.hasConfigurationFile && !latest
                        ? 'No configuration'
                        : restart
                          ? 'Restart review'
                          : presentation.label
              }
            />
          </span>
          {serving && status?.url ? (
            <code className="tm-application-preview__url">{status.url}</code>
          ) : null}
        </div>
        <div className="tm-preview-workspace__actions">
          {generating ? (
            <button
              className="outline-button"
              onClick={() => void run(() => agent!.discard(taskId))}
            >
              Cancel drafting
            </button>
          ) : dirty ? (
            <button
              className="ghost-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (draft?.draftId) await agent?.discard(taskId);
                  await loadFile();
                })
              }
            >
              Discard
            </button>
          ) : reviewId || status?.candidate ? (
            <button
              className="outline-button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api.cancelApplicationPreview({
                    taskId,
                    attemptId: reviewId ?? status!.candidate!.id
                  })
                )
              }
            >
              Cancel
            </button>
          ) : serving ? (
            <button
              className="outline-button"
              disabled={busy}
              onClick={() => void stop()}
            >
              Stop
            </button>
          ) : null}
          <button
            data-preview-primary
            className={
              !reviewId &&
              !dirty &&
              !needsRequirements &&
              (diagnosis ||
                snapshot?.configurationError ||
                (snapshot?.configurationChanged && serving))
                ? 'outline-button'
                : 'primary-button'
            }
            disabled={primaryDisabled}
            title={
              primaryDisabled
                ? blockers
                  ? `Resolve ${blockers === 1 ? 'this requirement' : `${blockers} requirements`} before starting.`
                  : (snapshot?.configurationError ??
                    (nextLabel === 'Draft configuration with agent'
                      ? agent?.disabledReason
                      : undefined) ??
                    'Wait for the current operation.')
                : undefined
            }
            onClick={() => void run(next)}
          >
            {nextLabel}
          </button>
          <ActionMenu
            label="More preview actions"
            trigger={<Ellipsis size={16} aria-hidden="true" />}
            items={[
              {
                label: 'Ask Preview agent',
                disabled:
                  !agent || busy || generating || !!agent.disabledReason,
                disabledReason: agent?.disabledReason,
                onSelect: () => {
                  setSection('Configuration');
                  setShowAgent(true);
                }
              },
              ...(onTaskAgent
                ? [
                    {
                      label: 'Send to task agent',
                      disabled: busy,
                      onSelect: handoff
                    }
                  ]
                : []),
              {
                label: snapshot?.hasConfigurationFile
                  ? 'Edit configuration'
                  : 'Write it myself',
                disabled: busy || !editable,
                onSelect: () => void run(() => loadFile('YAML'))
              },
              ...(secrets.length
                ? [
                    {
                      label: 'Manage required secrets',
                      disabled: busy,
                      onSelect: () =>
                        setSecretReferences(secrets.map((secret) => secret.id))
                    }
                  ]
                : []),
              ...(latest
                ? [
                    {
                      label: 'Open in Logs',
                      onSelect: () => showLogs(latest.id)
                    }
                  ]
                : []),
              ...(latest
                ? Object.entries(latest.services ?? {})
                    .filter(
                      ([, service]) =>
                        service.type === 'job' &&
                        ['failed', 'canceled'].includes(service.state)
                    )
                    .map(([job]) => ({
                      label: `Run ${job} again`,
                      disabled:
                        busy ||
                        !!serving ||
                        !!status?.candidate ||
                        !!status?.busy,
                      disabledReason:
                        'Stop the preview before rerunning a step. It can change retained data.',
                      onSelect: () =>
                        void run(() =>
                          api.rerunApplicationPreviewJob({
                            taskId,
                            attemptId: latest.id,
                            job
                          })
                        )
                    }))
                : []),
              ...(dirty
                ? [
                    {
                      label: 'Save configuration',
                      onSelect: () => void run(() => save(false))
                    }
                  ]
                : []),
              {
                label: 'Reload configuration',
                disabled: dirty,
                disabledReason: 'Save or discard your edits first.',
                onSelect: () => void run(() => loadFile())
              },
              ...(snapshot?.canRestore
                ? [
                    {
                      label: 'Restore running configuration',
                      disabled: busy,
                      onSelect: () =>
                        void run(async () => {
                          const value = await api.readApplicationPreviewFile({
                            taskId
                          });
                          if (!value.previous)
                            throw new Error(
                              'The original file is no longer available.'
                            );
                          setDraft({
                            original: value.file,
                            text: value.previous.text
                          });
                          setSection('Configuration');
                          setView('Changes');
                        })
                    }
                  ]
                : []),
              ...(snapshot?.hasConfigurationFile && serving
                ? [
                    {
                      label: 'Review update',
                      disabled: !editable || busy || !!status?.candidate,
                      onSelect: () => void start()
                    }
                  ]
                : []),
              ...(!snapshot?.hasConfigurationFile && latest
                ? [
                    {
                      label: 'Start from last run’s configuration',
                      onSelect: () =>
                        void run(() =>
                          api.startRetainedApplicationPreview({ taskId })
                        )
                    }
                  ]
                : []),
              ...(status?.data
                ? [
                    {
                      label: 'Delete data…',
                      danger: true,
                      disabled: busy || !!serving || !!status.candidate,
                      disabledReason: 'Stop Preview before deleting its data.',
                      onSelect: () => setConfirmData(true)
                    }
                  ]
                : [])
            ]}
          />
        </div>
      </header>
      {readError || error ? (
        <p role="alert" className="form-error">
          {error ?? readError}
        </p>
      ) : null}
      {needsRequirements || secretReferences ? (
        <DecisionBlock
          kind="Before this runs"
          tone="action"
          summary={
            blockers
              ? `${blockers} ${blockers === 1 ? 'requirement needs' : 'requirements need'} attention`
              : 'Review secret storage'
          }
        >
          {[...folderRequirements.values()].map(({ source, services }) => {
            const key = `${source.service}:${source.declaration}`;
            const directory = chosenFolders[key] ?? source.directory;
            return (
              <div className="tm-preview-requirement" key={key}>
                <strong>{services.join(', ')}</strong>
                <div>
                  <code>{source.declaration}</code>
                  <p>
                    {source.missing && !chosenFolders[key]
                      ? 'Folder not found: '
                      : ''}
                    <code>{directory}</code>
                  </p>
                </div>
                {source.missing && !chosenFolders[key] ? (
                  <button
                    className="outline-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const selected = await api.chooseRepositoryFolder();
                        if (selected)
                          setChosenFolders((value) => ({
                            ...value,
                            [key]: selected
                          }));
                      })
                    }
                  >
                    Choose folder
                  </button>
                ) : (
                  <button
                    className="outline-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api.connectApplicationPreviewSource({
                          taskId,
                          service: source.service,
                          directory,
                          expected: expected(status)
                        })
                      )
                    }
                  >
                    Connect
                  </button>
                )}
              </div>
            );
          })}
          {sources.some((source) => !source.connected) ? (
            <p className="tm-preview-help">
              Connect lets these services use this folder for this app session.
              Commands can read or change files your account can access.
            </p>
          ) : null}
          {storage && storage.state !== 'unlocked' ? (
            <div className="tm-preview-requirement">
              <strong>Database credentials</strong>
              <span>Used by {storage.services.join(', ')}</span>
              <button
                className="outline-button"
                onClick={() => setSecretReferences([])}
              >
                {storage.state === 'new' ? 'Set up storage' : 'Unlock storage'}
              </button>
            </div>
          ) : null}
          {secrets
            .filter((secret) => secret.availability !== 'available')
            .map((secret) => (
              <div className="tm-preview-requirement" key={secret.id}>
                <code title={secret.id}>{secret.id}</code>
                <span>
                  Used by{' '}
                  {secret.bindings
                    .map(
                      (binding) =>
                        `${binding.service ?? 'Application'} → ${binding.key}`
                    )
                    .join(', ')}
                </span>
                <button
                  className="outline-button"
                  onClick={() => setSecretReferences([secret.id])}
                >
                  {secret.availability === 'missing'
                    ? 'Add value'
                    : secret.availability === 'locked'
                      ? 'Unlock storage'
                      : 'Set up storage'}
                </button>
              </div>
            ))}
          {secretReferences ? (
            <PreviewSecretDialog
              inline
              references={secretReferences}
              recipients={Object.fromEntries(
                secrets.map((secret) => [
                  secret.id,
                  secret.bindings.map(
                    (binding) =>
                      `${binding.service ?? 'Application'} → ${binding.key}`
                  )
                ])
              )}
              onClose={() => {
                setSecretReferences(undefined);
                refresh();
              }}
              onSaved={() => {
                setSecretReferences(undefined);
                refresh();
              }}
            />
          ) : null}

          {snapshot?.requirements?.connections.map((service) => (
            <div className="tm-preview-requirement" key={service}>
              <strong>{service}</strong>
              <span>Connection address required</span>
              <button
                className="outline-button"
                onClick={() => void run(() => loadFile())}
              >
                Set address
              </button>
            </div>
          ))}
          {snapshot?.requirements?.description?.prerequisites
            ?.filter((item) => item.status === 'missing')
            .map((item, i) => (
              <p key={i}>
                {item.service ? `${item.service}: ` : ''}
                {item.message}
              </p>
            ))}
          <details className="tm-preview-disclosure">
            <summary>
              <DisclosureChevron />
              Other checks
            </summary>
            {snapshot?.requirements?.description ? (
              <ConfigurationDefinitions
                description={snapshot.requirements.description}
                showSecrets={false}
              />
            ) : (
              <p>
                Command requirements are inspected after the source folders are
                connected.
              </p>
            )}
          </details>
        </DecisionBlock>
      ) : review ? (
        <DecisionBlock
          kind={restart ? 'Restart review' : 'Approve this run'}
          tone="action"
          summary={
            restart
              ? 'Approving stops the running preview first. The app is unavailable until the new version is ready.'
              : 'Review the commands and access for this run.'
          }
        >
          {(restart?.affected ?? snapshot?.approval?.affected)?.map((row) => (
            <p key={row.job}>
              <strong>{row.job}</strong> runs in <code>{row.directory}</code>,
              shared by {row.previews.join(', ')}. It may change files or
              interrupt those previews.
            </p>
          ))}
          <PreviewRunReview description={review} />
          <p className="tm-preview-help">
            Commands can read or change files your account can access. Saving or
            connecting never approves a run.
          </p>
        </DecisionBlock>
      ) : snapshot?.configurationError ? (
        <DecisionBlock
          kind="Configuration needs attention"
          tone="error"
          summary={snapshot.configurationError}
          actions={
            <button
              className="primary-button"
              onClick={() => void run(() => loadFile('YAML'))}
            >
              Review configuration
            </button>
          }
        />
      ) : diagnosis && !dirty ? (
        <DecisionBlock
          kind={
            serving
              ? 'Update failed · previous preview reported serving'
              : `${diagnosis.service ?? 'Application'} failed`
          }
          tone="error"
          title={diagnosis.title}
          summary={diagnosis.summary}
          actions={
            <>
              <button
                className="primary-button"
                disabled={busy || generating}
                onClick={repair}
              >
                {diagnosis.actionLabel}
              </button>
              <ActionMenu
                label="More recovery actions"
                trigger="More"
                items={[
                  {
                    label: 'Investigate with Preview agent',
                    disabled: !!agent?.disabledReason,
                    disabledReason: agent?.disabledReason,
                    onSelect: () => void run(() => generate())
                  },
                  {
                    label: 'Send to task agent',
                    disabled: !onTaskAgent,
                    onSelect: handoff
                  },
                  {
                    label: 'Edit configuration',
                    onSelect: () => void run(() => loadFile())
                  },
                  {
                    label: 'Open in Logs',
                    onSelect: () =>
                      showLogs(diagnosis.attemptId, diagnosis.service, true)
                  },
                  { label: 'Start again', onSelect: () => void start() },
                  ...(serving
                    ? [
                        {
                          label: 'Dismiss',
                          onSelect: () => setDismissed(diagnosis.attemptId)
                        }
                      ]
                    : [])
                ]}
              />
            </>
          }
          details={
            <>
              <p>{diagnosis.observed}</p>
              <p>{diagnosis.unknown}</p>
              <p>{diagnosis.guarantee}</p>
              <button
                className="ghost-button"
                onClick={() =>
                  showLogs(diagnosis.attemptId, diagnosis.service, true)
                }
              >
                Open in Logs
              </button>
            </>
          }
        >
          {diagnosis.excerpt ? (
            <div className="tm-preview-failure-excerpt">
              <pre>{diagnosis.excerpt}</pre>
              <button
                className="ghost-button"
                onClick={() =>
                  showLogs(diagnosis.attemptId, diagnosis.service, true)
                }
              >
                Open in Logs
              </button>
            </div>
          ) : null}
        </DecisionBlock>
      ) : snapshot?.configurationChanged && serving ? (
        <DecisionBlock
          kind="Configuration changed"
          summary="preview.yaml differs from the running configuration."
          actions={
            <>
              <button
                className="primary-button"
                disabled={busy || !editable}
                onClick={() => void start()}
              >
                Review changes and restart
              </button>
              <button
                className="ghost-button"
                onClick={() => void run(() => loadFile('Changes'))}
              >
                View changes
              </button>
            </>
          }
        />
      ) : null}
      {!snapshot?.hasConfigurationFile &&
      !latest &&
      !draft &&
      !generating &&
      !showAgent ? (
        <div className="tm-application-preview__empty">
          <p>
            Draft a configuration from this project’s dependencies, frontend,
            backend, and connection requirements.
          </p>
          <p>Nothing runs until you review and approve it.</p>
          {agent?.disabledReason ? (
            <p>
              {agent.disabledReason} Use Write it myself from the menu, or
              configure a Preview agent in Settings.
            </p>
          ) : null}
          <button
            className="ghost-button"
            onClick={() =>
              void run(async () => {
                const setup = await api.inspectApplicationPreviewSetup({
                  taskId
                });
                if (!setup.recommendations.length)
                  throw new Error(
                    'This project needs agent-assisted setup or a complete configuration written manually.'
                  );
                const choice = setup.recommendations[0]!;
                setDraft({
                  text: `name: application\ntype: static\ndirectory: ${JSON.stringify(choice.directory)}\n`
                });
                setSection('Configuration');
                setView('YAML');
              })
            }
          >
            Check for a plain static site
          </button>
        </div>
      ) : null}
      {snapshot?.hasConfigurationFile ||
      latest ||
      draft ||
      showAgent ||
      generation?.status === 'NEEDS_INPUT' ||
      generating ? (
        <>
          <nav className="tm-tabs" role="tablist" aria-label="Preview sections">
            {(['Activity', 'Configuration', 'Logs'] as const).map((item) => (
              <AccessibleTab
                key={item}
                id={`preview-tab-${item}`}
                panelId={`preview-panel-${item}`}
                label={item}
                selected={section === item}
                onSelect={() => {
                  if (item === 'Configuration' && !draft)
                    void run(() => loadFile());
                  else setSection(item);
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
              restoredRun={snapshot?.restoredRun}
              onLogs={showLogs}
            />
          </div>
          <div
            role="tabpanel"
            id="preview-panel-Configuration"
            aria-labelledby="preview-tab-Configuration"
            hidden={section !== 'Configuration'}
          >
            {generating ? (
              <p role="status">
                The Preview agent is inspecting project requirements and
                drafting the configuration…
              </p>
            ) : null}
            {generation?.status === 'FAILED' ? (
              <p role="alert" className="form-error">
                {generation.message}
              </p>
            ) : null}
            {showAgent || generation?.status === 'NEEDS_INPUT' ? (
              <form
                className="tm-preview-agent-request"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => generate());
                }}
              >
                {(generation?.report?.unresolvedDecisions ?? []).map(
                  (question, i) => (
                    <p key={i}>{question}</p>
                  )
                )}
                <label className="field">
                  <span>What should the Preview agent inspect or change?</span>
                  <textarea
                    aria-label="What should the Preview agent inspect or change?"
                    value={clarification}
                    rows={3}
                    maxLength={4000}
                    disabled={generating}
                    onChange={(event) => setClarification(event.target.value)}
                  />
                  <small>
                    Use secret reference names here. Enter values only in secret
                    storage.
                  </small>
                </label>
                <button
                  className="outline-button"
                  disabled={
                    generating ||
                    busy ||
                    !agent ||
                    !!agent.disabledReason ||
                    (generation?.status === 'NEEDS_INPUT' &&
                      !clarification.trim())
                  }
                >
                  Draft configuration
                </button>
              </form>
            ) : null}
            {conflicts ? (
              <div className="tm-preview-file-conflict">
                <p>
                  Both default files exist. Compare them and choose one. The
                  other is kept with a .unused suffix.
                </p>
                {conflicts.map((file) => (
                  <section key={file.name}>
                    <h3>{file.name}</h3>
                    <pre>{file.text}</pre>
                    <button
                      className="outline-button"
                      onClick={() =>
                        void run(async () => {
                          await api.chooseApplicationPreviewFile({
                            taskId,
                            keep: file.name,
                            files: conflicts
                          });
                          await loadFile();
                        })
                      }
                    >
                      Keep {file.name}
                    </button>
                  </section>
                ))}
              </div>
            ) : null}
            {reconciliation ? (
              <div className="tm-preview-reconciliation">
                <p>
                  The last run used settings that differ from this file:{' '}
                  {reconciliation.changes.join(', ') ||
                    'concealed environment values'}
                  .
                </p>
                {reconciliation.concealedKeys.length ? (
                  <p>
                    Values for {reconciliation.concealedKeys.join(', ')} cannot
                    be restored. Enter a secret reference or confirm the
                    nonsecret value.
                  </p>
                ) : null}
                {reconciliation.changes.length ? (
                  <button
                    className="outline-button"
                    onClick={() => {
                      if (draft)
                        setDraft({ ...draft, text: reconciliation.text });
                      setReconciliation(undefined);
                      setView('Changes');
                    }}
                  >
                    Review settings from last run
                  </button>
                ) : null}
                <button
                  className="ghost-button"
                  onClick={() => setReconciliation(undefined)}
                >
                  Not now
                </button>
              </div>
            ) : null}
            {draft && !conflicts ? (
              <ApplicationConfiguration
                draft={draft}
                previous={previous}
                view={view}
                onView={setView}
                onChange={(text) => setDraft({ ...draft, text })}
                onSave={() => void run(() => save(false))}
                busy={busy || generating || !editable}
                generation={generation}
              />
            ) : null}
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
              onTaskAgent={onTaskAgent ? sendToTaskAgent : undefined}
            />
          </div>
        </>
      ) : null}
      {confirmData && status?.data ? (
        <PreviewDialog
          title="Delete retained data?"
          busy={busy}
          onClose={() => setConfirmData(false)}
          onOpenChange={onModalOpenChange}
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
                className="danger-button"
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
            This deletes{' '}
            {status.data.resources.map((resource) => resource.name).join(', ')}{' '}
            for this worktree.
          </p>
          {error ? <p className="form-error">{error}</p> : null}
        </PreviewDialog>
      ) : null}
    </section>
  );
}
