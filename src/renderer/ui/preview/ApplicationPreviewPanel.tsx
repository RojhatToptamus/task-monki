import { isActiveRunStatus } from '../../model/agentSession';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Ellipsis, MessageSquare } from 'lucide-react';
import type { AttemptSummary } from 'previewhost';
import type { ApplicationPreviewSnapshot, PreviewConfigurationFile } from '../../../shared/applicationPreview';
import type { WorktreeRecord } from '../../../shared/contracts';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import {
  previewBlockerCount,
  previewStatusRow,
  type PreviewPrimaryAction,
  type PreviewSecondaryAction,
  type PreviewWorktreeAvailability
} from '../../model/applicationPreviewPanel';
import { applicationPreviewStatus } from '../../model/applicationPreviewStatus';
import { previewRunRows } from '../../model/applicationPreviewRuns';
import { DRAFT_REQUEST, investigationRequest } from '../../model/previewAgentRequests';
import { initialPreviewAgentSelection, previewAgentUnavailableReason, type PreviewAgentSelection } from '../../model/previewAgentSelection';
import { previewConfigurationChanges, type PreviewConfigurationChange } from '../../model/previewConfigurationChanges';
import { AccessibleTab } from '../AccessibleTabs';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu';
import { DecisionBlock } from '../DecisionBlock';
import { Chip } from '../StatusBadge';
import { ApplicationActivity } from './ApplicationActivity';
import { ApplicationConfiguration, type ConfigurationView, type PreviewEditorDraft } from './ApplicationConfiguration';
import { ApplicationLogs } from './ApplicationLogs';
import { PreviewAgentPanel } from './PreviewAgentPanel';
import type { PreviewAgentConversation, PreviewProposalActions } from './PreviewAgentProps';
import { PreviewAttemptConfiguration } from './PreviewAttemptConfiguration';
import { PreviewDiagnosisBlock, PreviewProjectFacts, PreviewRequirementsBlock, PreviewRunApprovalBlock, PreviewWorktreeBlock } from './PreviewDecisionBlocks';
import { expected, message, PreviewDialog } from './previewPresentation';

/** Below this width the Preview agent becomes a tab instead of a 340px column beside the tabs. */
const SPLIT_MIN_WIDTH = 900;
const STATIC_DRAFT = '# Describe the services this project needs.\nname: application\ntype: static\ndirectory: .\n';

function useApplicationPreview(taskId: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<ApplicationPreviewSnapshot>();
  const [error, setError] = useState<string>();
  const readNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!enabled) return;
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
      if (!disposed) timer = setTimeout(() => void read(), refreshPending ? 0 : 1000);
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
  }, [taskId, enabled]);
  return { snapshot, error, refresh: () => readNow.current() };
}

/** Whether the surface is wide enough for the agent column; zero means not laid out yet, which is not narrow. */
function useNarrow(ref: RefObject<HTMLElement | null>, threshold: number) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const width = node.getBoundingClientRect().width;
      setNarrow(width > 0 && width < threshold);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return narrow;
}

export function worktreeAvailability(worktree: WorktreeRecord | undefined, pending: boolean): PreviewWorktreeAvailability {
  if (!worktree) return { state: 'absent', pending };
  const external = worktree.ownership === 'EXTERNAL';
  if (['MISSING', 'PRUNABLE', 'REMOVED'].includes(worktree.status)) return { state: 'missing', external, pending };
  if (worktree.status === 'ERROR') return { state: 'failed', external, pending };
  return { state: 'available' };
}

export function ApplicationPreviewOverview({ taskId, onOpen }: { taskId: string; onOpen(): void }) {
  const { snapshot, error } = useApplicationPreview(taskId, true);
  if (!snapshot?.status && !error) return null;
  return (
    <section className="tm-panel tm-preview-card" aria-label="Preview summary">
      <div className="tm-preview-card__head">
        <h3 className="tm-panel__title">Preview</h3>
        <span>{error ? 'Unavailable' : applicationPreviewStatus(snapshot?.status, !!snapshot?.approval).label}</span>
      </div>
      <button className="outline-button" onClick={onOpen}>View Preview</button>
    </section>
  );
}

type Section = 'Activity' | 'Configuration' | 'Logs' | 'Preview agent';

export function ApplicationPreviewPanel({
  taskId,
  projectName,
  worktree,
  worktreePending = false,
  agent,
  proposals,
  onTaskAgent,
  onRestoreWorktree,
  onPrepareWorktree,
  onReconnectCheckout,
  onModalOpenChange
}: {
  taskId: string;
  projectName?: string;
  /** The task worktree: the folder commands run in, and the state that decides whether Preview can run at all. */
  worktree?: WorktreeRecord;
  worktreePending?: boolean;
  /** The task's Preview conversation; absent when this task cannot converse, such as a Design. */
  agent?: PreviewAgentConversation;
  /** The agent's proposal under review and the actions that settle it. */
  proposals?: PreviewProposalActions;
  onTaskAgent?(text: string): void | Promise<void>;
  onRestoreWorktree?(): void | Promise<void>;
  onPrepareWorktree?(): void | Promise<void>;
  onReconnectCheckout?(): void;
  onModalOpenChange?(open: boolean): void;
}) {
  const availability = worktreeAvailability(worktree, worktreePending);
  const { snapshot, error: readError, refresh } = useApplicationPreview(taskId, !!worktree);
  const projectDirectory = snapshot?.projectDirectory ?? worktree?.worktreePath;
  const root = useRef<HTMLElement>(null);
  const narrow = useNarrow(root, SPLIT_MIN_WIDTH);
  const [section, setSection] = useState<Section>('Activity');
  const [view, setView] = useState<ConfigurationView>('Configuration');
  const [draft, setDraft] = useState<PreviewEditorDraft>();
  const [previous, setPrevious] = useState<PreviewConfigurationFile>();
  const [reconciliation, setReconciliation] = useState<{ text: string; changes: string[]; concealedKeys: string[] }>();
  const [conflicts, setConflicts] = useState<PreviewConfigurationFile[]>();
  const [asRun, setAsRun] = useState<AttemptSummary>();
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentSelection, setAgentSelection] = useState<PreviewAgentSelection>();
  const [agentDraft, setAgentDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; state: string }>();
  const [dismissed, setDismissed] = useState<string>();
  const [logSelection, setLogSelection] = useState<{ attemptId: string; source?: string; failure?: boolean }>();
  const [secretReferences, setSecretReferences] = useState<string[]>();
  const [confirmData, setConfirmData] = useState(false);
  const [restartChanges, setRestartChanges] = useState<{ id: string; changes?: PreviewConfigurationChange[] }>();
  const loadedProposal = useRef<string | undefined>(undefined);

  const proposal = proposals?.state?.draft;
  const selection = agent ? agentSelection ?? initialPreviewAgentSelection(agent.runs, agent.defaults) : undefined;
  const agentDisabledReason = agent && selection
    ? agent.disabledReason ?? previewAgentUnavailableReason(selection, agent.runtimes)
    : 'The Preview agent is not available here.';
  const questionPending = agent?.interactions.find((item) => item.status === 'PENDING');
  const status = snapshot?.status;
  const serving = status?.active;
  const latest = status?.candidate ?? status?.latest;
  const review = snapshot?.approval ?? snapshot?.restartReview;
  const reviewId = snapshot?.approval?.attemptId ?? snapshot?.restartReview?.id;
  const requirements = snapshot?.requirements
    ? { ...snapshot.requirements, secrets: snapshot.approval?.secrets ?? snapshot.requirements.secrets }
    : undefined;
  const blockers = previewBlockerCount(requirements);
  const dirty = !!draft && (!!draft.draftId || draft.text !== draft.original?.text);
  const diagnosis = snapshot?.diagnosis?.attemptId !== dismissed ? snapshot?.diagnosis : undefined;
  const agentWorking = !!agent?.runs.some((run) => isActiveRunStatus(run.status));
  const waitingForAgent = !!draft?.draftId && agentWorking;
  const editable = (!serving || !snapshot?.designAttempts?.includes(serving.id)) && !waitingForAgent;
  const available = availability.state === 'available';
  const row = previewStatusRow({
    snapshot,
    unavailable: !!readError,
    worktree: availability,
    agentDisabledReason,
    agentWorking,
    dirty,
    proposal: !!draft?.draftId,
    blockers,
    busy
  });
  // An action error stays visible until the runtime state it described moves on.
  const stateKey = [status?.active?.id, status?.candidate?.id, status?.latest?.id, status?.latest?.state, !!snapshot?.approval, !!snapshot?.restartReview].join('|');
  const error = actionError && actionError.state === stateKey ? actionError.message : undefined;
  const setError = (value: string | undefined) => setActionError(value ? { message: value, state: stateKey } : undefined);

  // A question opens the conversation where it is answered, once per question.
  const [seenQuestionId, setSeenQuestionId] = useState<string>();
  if (questionPending?.id !== seenQuestionId) {
    setSeenQuestionId(questionPending?.id);
    if (questionPending) openAgent();
  }

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
  async function loadFile(nextView: ConfigurationView = 'Configuration', createWhenMissing = false) {
    const value = await api.readApplicationPreviewFile({ taskId });
    setDraft(value.file ? { original: value.file, text: value.file.text } : createWhenMissing ? { text: STATIC_DRAFT } : undefined);
    setPrevious(value.previous);
    setReconciliation(value.reconciliation);
    setConflicts(value.files);
    setView(nextView);
    setAsRun(undefined);
    setSection(value.file || createWhenMissing ? 'Configuration' : 'Activity');
  }
  useEffect(() => {
    if (!proposal || proposal.id === loadedProposal.current) return;
    let disposed = false;
    void api.readApplicationPreviewFile({ taskId, draftId: proposal.id }).then(
      (value) => {
        if (disposed) return;
        loadedProposal.current = proposal.id;
        setDraft({ original: value.original, text: proposal.yaml, draftId: proposal.id });
        setAsRun(undefined);
        setSection('Configuration');
        setView('Changes');
      },
      (cause) => {
        if (!disposed) setError(message(cause));
      }
    );
    return () => {
      disposed = true;
    };
  }, [taskId, proposal]);
  // The restart review compares the serving run's text with the file once per review.
  useEffect(() => {
    const id = snapshot?.restartReview?.id;
    if (!id || restartChanges?.id === id) return;
    let disposed = false;
    void api.readApplicationPreviewFile({ taskId }).then(
      (value) => {
        if (disposed) return;
        setRestartChanges({ id, changes: value.previous && value.file ? previewConfigurationChanges(value.previous.text, value.file.text) : undefined });
      },
      () => {
        if (!disposed) setRestartChanges({ id });
      }
    );
    return () => {
      disposed = true;
    };
  }, [taskId, snapshot?.restartReview?.id, restartChanges?.id]);

  /** Sends one message to the Preview agent from outside its panel and shows the conversation. */
  async function requestAgent(text: string) {
    if (!agent || !selection) return;
    const value = await api.readApplicationPreviewFile({ taskId });
    if (value.files) {
      setConflicts(value.files);
      setSection('Configuration');
      return;
    }
    openAgent();
    await agent.send(text, crypto.randomUUID(), selection);
  }
  async function discardProposal() {
    if (proposals && proposal) await proposals.discard(taskId);
  }
  async function save(startAfter: boolean) {
    if (!draft) return;
    if (draft.draftId && proposals) {
      const validation = await proposals.validate(taskId, draft.draftId, draft.text);
      if (validation.status !== 'VALID') throw new Error(validation.issues.map((issue) => issue.message).join('\n'));
      await proposals.accept(taskId, draft.draftId, draft.text);
    } else await api.saveApplicationPreviewFile({ taskId, original: draft.original, text: draft.text });
    const saved = await api.readApplicationPreviewFile({ taskId });
    setDraft(saved.file ? { original: saved.file, text: saved.file.text } : undefined);
    setPrevious(saved.previous);
    if (startAfter) {
      setSection('Activity');
      await api.startApplicationPreview({ taskId });
    }
    root.current?.querySelector<HTMLButtonElement>('[data-preview-primary]')?.focus();
  }
  async function cancel() {
    if (reviewId) await api.cancelApplicationPreview({ taskId, attemptId: reviewId });
    else if (status?.candidate) await api.cancelApplicationPreview({ taskId, attemptId: status.candidate.id });
  }
  const start = () => run(() => api.startApplicationPreview({ taskId }));
  const stop = () => run(() => api.stopApplicationPreview({ taskId, expected: expected(status) }));
  function showLogs(attemptId: string, source?: string, failure = false) {
    setLogSelection({ attemptId, source, failure });
    setSection('Logs');
  }
  function openAgent() {
    setAgentOpen(true);
    if (narrow) setSection('Preview agent');
  }
  function closeAgent() {
    setAgentOpen(false);
    if (section === 'Preview agent') setSection('Activity');
  }
  function sendToTaskAgent(text: string) {
    void run(async () => {
      await onTaskAgent?.(text);
    });
  }
  function handoff() {
    sendToTaskAgent(
      diagnosis
        ? `Investigate this Preview failure before proposing changes.\n${diagnosis.service ?? 'Application'}: ${diagnosis.observed}\n${diagnosis.excerpt ?? ''}\n${diagnosis.unknown}\nInspect preview.yaml and the relevant project code. Explain the proposed fix before executing it.`
        : 'Inspect preview.yaml and the project requirements. Explain the proposed changes before executing them. Keep secret values concealed.'
    );
  }
  const investigate = () => void run(() => requestAgent(investigationRequest(diagnosis!)));
  /** The diagnosis names the fix; this is the control that performs it. */
  function recommended() {
    if (!diagnosis) return;
    switch (diagnosis.action) {
      case 'task-agent':
        return onTaskAgent ? handoff() : investigate();
      case 'logs':
        return showLogs(diagnosis.attemptId, diagnosis.service, true);
      case 'docker':
        return void start();
      case 'image':
        return diagnosis.command ? void navigator.clipboard.writeText(diagnosis.command) : undefined;
      case 'cleanup':
        return void stop();
      case 'secrets':
        return setSecretReferences(requirements?.secrets.map((item) => item.id) ?? []);
      case 'source':
        return setSection('Activity');
      case 'readiness':
        return void run(() => loadFile());
      default:
        return investigate();
    }
  }
  const agentDisabled = !agent || !!agent.disabledReason;
  const investigateItem = { label: 'Investigate with Preview agent', disabled: agentDisabled || busy, disabledReason: agent?.disabledReason, onSelect: investigate };
  const agentToggleTitle = !agent ? 'The Preview agent is not available here.' : agentOpen ? 'Hide the Preview agent' : 'Ask the Preview agent to check the setup, inspect logs or draft configuration';
  /** Diagnoses whose recommended fix is the agent's reading show one investigate control instead of two. */
  const diagnosisInvestigates =
    !!diagnosis && (['agent', 'install', 'command'].includes(diagnosis.action) || (diagnosis.action === 'task-agent' && !onTaskAgent));
  const actions: Record<PreviewPrimaryAction | PreviewSecondaryAction, () => void> = {
    'restore-worktree': () => void onRestoreWorktree?.(),
    'reconnect-checkout': () => onReconnectCheckout?.(),
    'prepare-worktree': () => void onPrepareWorktree?.(),
    draft: () => void run(() => requestAgent(DRAFT_REQUEST)),
    write: () => void run(() => loadFile('YAML', true)),
    'start-retained': () => void run(() => api.startRetainedApplicationPreview({ taskId })),
    'save-and-review': () => void run(() => save(true)),
    approve: () =>
      void run(async () => {
        await api.approveApplicationPreview({ taskId, attemptId: reviewId! });
        root.current?.querySelector<HTMLElement>('[role="status"]')?.focus();
      }),
    open: () => void run(() => api.openApplicationPreview({ taskId, attemptId: serving!.id })),
    start: () => void start(),
    cancel: () => void run(cancel),
    stop: () => void stop(),
    discard: () =>
      void run(async () => {
        await discardProposal();
        await loadFile();
      }),
    save: () => void run(() => save(false))
  };
  const menu: ActionMenuItem[] = !available
    ? [
        ...(latest ? [{ label: 'Open in Logs', onSelect: () => showLogs(latest.id) }] : []),
        ...(status?.data ? [{ label: 'Delete data…', danger: true, disabled: busy || !!serving || !!status.candidate, onSelect: () => setConfirmData(true) }] : [])
      ]
    : [
        ...(onTaskAgent ? [{ label: 'Send to task agent', disabled: busy, onSelect: handoff }] : []),
        {
          label: snapshot?.hasConfigurationFile ? 'Edit configuration' : 'Write it myself',
          disabled: busy || !editable,
          onSelect: () => void run(() => loadFile('YAML', true))
        },
        ...(requirements?.secrets.length
          ? [{ label: 'Manage required secrets', disabled: busy, onSelect: () => setSecretReferences(requirements.secrets.map((secret) => secret.id)) }]
          : []),
        ...(latest ? [{ label: 'Open in Logs', onSelect: () => showLogs(latest.id) }] : []),
        ...(latest
          ? Object.entries(latest.services ?? {})
              .filter(([, service]) => service.type === 'job' && ['failed', 'canceled'].includes(service.state))
              .map(([job]) => ({
                label: `Run ${job} again`,
                disabled: busy || !!serving || !!status?.candidate || !!status?.busy,
                disabledReason: 'Stop the preview before rerunning a step. It can change retained data.',
                onSelect: () => void run(() => api.rerunApplicationPreviewJob({ taskId, attemptId: latest.id, job }))
              }))
          : []),
        { label: 'Reload configuration', disabled: dirty, disabledReason: 'Save or discard your edits first.', onSelect: () => void run(() => loadFile()) },
        ...(snapshot?.canRestore
          ? [
              {
                label: 'Edit last run’s configuration',
                disabled: busy,
                onSelect: () =>
                  void run(async () => {
                    const value = await api.readApplicationPreviewFile({ taskId });
                    if (!value.previous) throw new Error('The original file is no longer available.');
                    setDraft({ original: value.file, text: value.previous.text });
                    setAsRun(undefined);
                    setSection('Configuration');
                    setView('Changes');
                  })
              }
            ]
          : []),
        ...(snapshot?.hasConfigurationFile && serving ? [{ label: 'Review update', disabled: !editable || busy || !!status?.candidate, onSelect: () => void start() }] : []),
        ...(snapshot && !snapshot.hasConfigurationFile
          ? [
              {
                label: 'Check for a plain static site',
                disabled: busy,
                onSelect: () =>
                  void run(async () => {
                    const setup = await api.inspectApplicationPreviewSetup({ taskId });
                    const choice = setup.recommendations[0];
                    if (!choice) throw new Error('No folder with an index.html and no package manifest was found. Describe the services instead.');
                    setDraft({ text: `name: application\ntype: static\ndirectory: ${JSON.stringify(choice.directory)}\n` });
                    setAsRun(undefined);
                    setSection('Configuration');
                    setView('YAML');
                  })
              }
            ]
          : []),
        ...(status?.data
          ? [{ label: 'Delete data…', danger: true, disabled: busy || !!serving || !!status.candidate, disabledReason: 'Stop Preview before deleting its data.', onSelect: () => setConfirmData(true) }]
          : [])
      ];
  const needsRequirements = blockers > 0 && (!serving || !!review || snapshot?.configurationChanged);
  const empty = !!snapshot && available && !snapshot.hasConfigurationFile && !latest && !draft && !asRun;
  const tabs: Section[] = [
    ...(snapshot?.hasConfigurationFile || latest || draft || asRun ? (['Activity', ...(available ? ['Configuration' as const] : []), 'Logs'] as Section[]) : []),
    ...(narrow && agentOpen ? (['Preview agent'] as Section[]) : [])
  ];
  const agentPanel = agent && selection && agentOpen ? (
    <PreviewAgentPanel
      agent={agent}
      selection={selection}
      onSelectionChange={setAgentSelection}
      proposal={proposal}
      worktreePath={projectDirectory}
      draft={agentDraft}
      onDraftChange={setAgentDraft}
      onReviewProposal={() => {
        setAsRun(undefined);
        setSection('Configuration');
        setView('Changes');
      }}
      onClose={closeAgent}
    />
  ) : null;
  const latestMeta = `${serving && latest?.id !== serving.id ? 'update' : 'this run'}${latest?.startedAt ? ` · ${previewRunRows(status, false).find((run) => run.attempt.id === latest.id)?.time ?? ''}` : ''}`;
  return (
    <section
      ref={root}
      className={`tm-application-preview${agentPanel && !narrow ? ' tm-application-preview--split' : ''}`}
      aria-label="Application preview"
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          !reviewId ||
          busy ||
          (event.target as HTMLElement).closest('input, textarea, [role="menu"], .tm-side-conversation')
        )
          return;
        event.preventDefault();
        void run(async () => {
          await api.cancelApplicationPreview({ taskId, attemptId: reviewId });
          root.current?.querySelector<HTMLButtonElement>('[data-preview-primary]')?.focus();
        });
      }}
    >
      <div className="tm-application-preview__main">
        <div className="tm-preview-workspace">
          <header className="tm-preview-workspace__head">
            <div className="tm-preview-statusline">
              <strong>{projectName ?? 'Application'}</strong>
              <span role="status" tabIndex={-1}>
                <Chip tone={row.chip.tone} label={row.chip.label} />
              </span>
              {row.url ? <code className="tm-application-preview__url">{row.url}</code> : null}
            </div>
            <div className="tm-preview-workspace__actions">
              {row.secondary.map((item) => (
                <button key={item.action} className={item.action === 'discard' ? 'ghost-button' : 'outline-button'} disabled={busy || (item.action === 'save' && !editable) || (item.action === 'draft' && agentWorking)} onClick={actions[item.action]}>
                  {item.label}
                </button>
              ))}
              {row.reason ? <span className="tm-preview-reason">{row.reason}</span> : null}
              {row.primary ? (
                <button
                  data-preview-primary
                  className="primary-button"
                  disabled={row.primary.disabled || (row.primary.action === 'save-and-review' && !editable)}
                  title={waitingForAgent ? 'Wait for the Preview agent to finish before saving its proposal.' : row.primary.disabledReason}
                  onClick={actions[row.primary.action]}
                >
                  {row.primary.label}
                </button>
              ) : null}
              <button
                type="button"
                className="tm-iconbtn tm-preview-agent-toggle"
                aria-pressed={agentOpen}
                aria-label="Preview agent"
                title={agentToggleTitle}
                disabled={!agent}
                onClick={() => (agentOpen ? closeAgent() : openAgent())}
              >
                <MessageSquare size={16} strokeWidth={1.5} aria-hidden="true" />
                {questionPending && !agentOpen ? <span className="tm-preview-agent-toggle__dot" aria-label="questions waiting" /> : null}
              </button>
              {menu.length ? <ActionMenu label="More preview actions" trigger={<Ellipsis size={16} aria-hidden="true" />} items={menu} /> : null}
            </div>
          </header>
          {readError || error ? <p role="alert" className="form-error">{error ?? readError}</p> : null}
          {availability.state !== 'available' ? (
            <PreviewWorktreeBlock worktree={worktree} availability={availability} />
          ) : (needsRequirements || secretReferences) && requirements ? (
            <PreviewRequirementsBlock
              taskId={taskId}
              requirements={requirements}
              status={status}
              busy={busy}
              run={run}
              onEditFile={() => void run(() => loadFile())}
              secretReferences={secretReferences}
              onSecretReferences={setSecretReferences}
              refresh={refresh}
            />
          ) : review ? (
            <PreviewRunApprovalBlock
              review={review}
              restart={!!snapshot?.restartReview}
              projectDirectory={projectDirectory}
              busy={busy}
              changes={restartChanges?.id === snapshot?.restartReview?.id ? restartChanges?.changes : undefined}
              onViewChanges={() => void run(() => loadFile('Changes'))}
            />
          ) : snapshot?.configurationError ? (
            <DecisionBlock
              kind="Configuration needs attention"
              tone="error"
              summary={snapshot.configurationError}
              actions={<button className="outline-button" onClick={() => void run(() => loadFile('YAML'))}>Review configuration</button>}
            />
          ) : diagnosis && !dirty ? (
            <PreviewDiagnosisBlock
              diagnosis={diagnosis}
              meta={latestMeta}
              primary={
                diagnosisInvestigates
                  ? investigateItem
                  : { label: diagnosis.actionLabel, disabled: busy, onSelect: recommended }
              }
              secondary={diagnosisInvestigates ? undefined : investigateItem}
              more={[
                ...(onTaskAgent && diagnosis.action !== 'task-agent' ? [{ label: 'Send to task agent', disabled: busy, onSelect: handoff }] : []),
                { label: 'Edit configuration', onSelect: () => void run(() => loadFile()) },
                { label: 'Open in Logs', onSelect: () => showLogs(diagnosis.attemptId, diagnosis.service, true) },
                ...(serving ? [{ label: 'Dismiss', onSelect: () => setDismissed(diagnosis.attemptId) }] : [])
              ]}
              onOpenLogs={() => showLogs(diagnosis.attemptId, diagnosis.service, true)}
            />
          ) : snapshot && !snapshot.hasConfigurationFile && latest && !dirty ? (
            <DecisionBlock
              kind="Configuration file missing"
              summary="preview.yaml is not in this worktree. The configuration of the last run is retained and can run again; saving a file replaces it."
              actions={
                <button
                  className="ghost-button"
                  onClick={() => {
                    setAsRun(latest);
                    setSection('Configuration');
                  }}
                >
                  View last run’s configuration
                </button>
              }
            />
          ) : snapshot?.configurationChanged && serving ? (
            <DecisionBlock
              kind="Configuration changed since this run started"
              summary="preview.yaml differs from the running configuration. Applying it restarts the app."
              actions={
                <>
                  <button className="outline-button" disabled={busy || !editable} onClick={() => void start()}>Restart with changes</button>
                  <button className="ghost-button" onClick={() => void run(() => loadFile('Changes'))}>View changes</button>
                </>
              }
            />
          ) : null}
          {empty ? (
            <PreviewProjectFacts
              taskId={taskId}
              lead={
                agentDisabled
                  ? `No preview configuration in this worktree. Write preview.yaml to describe what runs; nothing runs until you approve it.${agent?.disabledReason ? ` ${agent.disabledReason}` : ''}`
                  : 'No preview configuration in this worktree. The agent reads the project and proposes preview.yaml for your review; nothing runs until you approve it.'
              }
            />
          ) : null}
          {tabs.length ? (
            <>
              <nav className="tm-tabs" role="tablist" aria-label="Preview sections">
                {tabs.map((item) => (
                  <AccessibleTab
                    key={item}
                    id={`preview-tab-${item.replace(' ', '-')}`}
                    panelId={`preview-panel-${item.replace(' ', '-')}`}
                    label={item}
                    selected={section === item}
                    badge={item === 'Preview agent' && questionPending ? '•' : undefined}
                    badgeAccessibleLabel={item === 'Preview agent' && questionPending ? 'questions waiting' : undefined}
                    onSelect={() => {
                      if (item === 'Configuration' && !draft && !asRun) void run(() => loadFile());
                      else setSection(item);
                    }}
                  />
                ))}
              </nav>
              <div role="tabpanel" id="preview-panel-Activity" aria-labelledby="preview-tab-Activity" hidden={section !== 'Activity'}>
                <ApplicationActivity
                  status={status}
                  restoredRun={snapshot?.restoredRun}
                  onLogs={showLogs}
                  onAsRun={(attempt) => {
                    setAsRun(attempt);
                    setSection('Configuration');
                  }}
                />
              </div>
              {available ? (
                <div role="tabpanel" id="preview-panel-Configuration" aria-labelledby="preview-tab-Configuration" hidden={section !== 'Configuration'}>
                  {asRun ? (
                    <PreviewAttemptConfiguration
                      taskId={taskId}
                      attempt={asRun}
                      status={status}
                      projectDirectory={projectDirectory}
                      onBack={() => {
                        setAsRun(undefined);
                        if (!draft) void run(() => loadFile());
                      }}
                    />
                  ) : null}
                  {!asRun && conflicts ? (
                    <div className="tm-preview-file-conflict">
                      <p>Both default files exist. Compare them and choose one. The other is kept with a .unused suffix.</p>
                      {conflicts.map((file) => (
                        <section key={file.name}>
                          <h3>{file.name}</h3>
                          <pre>{file.text}</pre>
                          <button
                            className="outline-button"
                            onClick={() =>
                              void run(async () => {
                                await api.chooseApplicationPreviewFile({ taskId, keep: file.name, files: conflicts });
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
                  {!asRun && reconciliation ? (
                    <div className="tm-preview-reconciliation">
                      <p>The last run used settings that differ from this file: {reconciliation.changes.join(', ') || 'concealed environment values'}.</p>
                      {reconciliation.concealedKeys.length ? (
                        <p>Values for {reconciliation.concealedKeys.join(', ')} cannot be restored. Enter a secret reference or confirm the nonsecret value.</p>
                      ) : null}
                      {reconciliation.changes.length ? (
                        <button
                          className="outline-button"
                          onClick={() => {
                            if (draft) setDraft({ ...draft, text: reconciliation.text });
                            setReconciliation(undefined);
                            setView('Changes');
                          }}
                        >
                          Review settings from last run
                        </button>
                      ) : null}
                      <button className="ghost-button" onClick={() => setReconciliation(undefined)}>Not now</button>
                    </div>
                  ) : null}
                  {!asRun && draft && !conflicts ? (
                    <ApplicationConfiguration
                      draft={draft}
                      previous={previous}
                      view={view}
                      onView={setView}
                      onChange={(text) => setDraft({ ...draft, text })}
                      onSave={() => void run(() => save(false))}
                      busy={busy || !editable}
                    />
                  ) : null}
                </div>
              ) : null}
              <div role="tabpanel" id="preview-panel-Logs" aria-labelledby="preview-tab-Logs" hidden={section !== 'Logs'}>
                <ApplicationLogs
                  taskId={taskId}
                  status={status}
                  selection={logSelection}
                  onSelect={setLogSelection}
                  active={section === 'Logs'}
                  onTaskAgent={onTaskAgent ? sendToTaskAgent : undefined}
                />
              </div>
              {narrow && agentPanel ? (
                <div role="tabpanel" id="preview-panel-Preview-agent" aria-labelledby="preview-tab-Preview-agent" hidden={section !== 'Preview agent'}>
                  {agentPanel}
                </div>
              ) : null}
            </>
          ) : narrow && agentPanel ? (
            agentPanel
          ) : null}
        </div>
      </div>
      {!narrow ? agentPanel : null}
      {confirmData && status?.data ? (
        <PreviewDialog
          title="Delete retained data?"
          busy={busy}
          onClose={() => setConfirmData(false)}
          onOpenChange={onModalOpenChange}
          footer={
            <>
              <button className="outline-button" disabled={busy} onClick={() => setConfirmData(false)}>Cancel</button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.deleteApplicationPreviewData({ taskId, expected: { attemptId: status.latest?.id ?? null, resources: status.data!.resources } });
                    setConfirmData(false);
                  })
                }
              >
                Delete data
              </button>
            </>
          }
        >
          <p>This deletes {status.data.resources.map((resource) => resource.name).join(', ')} for this worktree.</p>
          {error ? <p className="form-error">{error}</p> : null}
        </PreviewDialog>
      ) : null}
    </section>
  );
}
