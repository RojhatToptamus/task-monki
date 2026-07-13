import { useEffect, useRef, useState } from 'react';
import type {
  PreviewApprovalRecord,
  PreviewComposeProjectRecord,
  PreviewGenerationAttachmentRecord,
  PreviewGenerationRecord,
  PreviewLocalAttachmentBindingRecord,
  PreviewManagedResourceRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  PreviewResourceRecord,
  PreviewRouteRecord,
  ReadPreviewLogResult,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import type {
  PreviewAttachmentPlan,
  PreviewPrivateInputOperationResult,
  PreviewResolvedAttachmentTarget
} from '../../shared/preview';
import {
  buildPreviewPlanGroups,
  buildPreviewViewModel,
  selectPreviewActionGeneration,
  selectPreviewDiagnosticAttempts,
  selectPreviewOverviewProjection,
  selectPreviewResetResources,
  type PreviewActionId,
  type PreviewActionModel,
  type PreviewViewModel
} from '../model/preview';
import { Chip } from './StatusBadge';

export interface PreviewPanelProps {
  task: Task;
  worktree?: WorktreeRecord;
  plans: PreviewPlanRecord[];
  approvals: PreviewApprovalRecord[];
  generations: PreviewGenerationRecord[];
  generationAttachments: PreviewGenerationAttachmentRecord[];
  attempts: PreviewNodeAttemptRecord[];
  managedResources: PreviewManagedResourceRecord[];
  composeProjects: PreviewComposeProjectRecord[];
  localBindings: PreviewLocalAttachmentBindingRecord[];
  runtimeResources: PreviewResourceRecord[];
  onResolve(taskId: string, scenarioId?: string): Promise<void>;
  onApprove(taskId: string, planId: string, executionDigest: string): Promise<void>;
  onStart(taskId: string, scenarioId?: string): Promise<void>;
  onOpen(taskId: string, generationId: string, routeId: string): Promise<void>;
  onStop(taskId: string, generationId: string): Promise<void>;
  onResetData(taskId: string, generationId: string, resourceId: string, scenarioId: string): Promise<void>;
  onRetrySetup(taskId: string, generationId: string, scenarioId: string): Promise<void>;
  onReadLog(taskId: string, artifactId: string, offset: number, maxBytes: number): Promise<ReadPreviewLogResult>;
}

interface PreviewConfirmation {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  returnFocus?: HTMLElement;
  run(): Promise<void>;
}

interface PreviewController {
  view: PreviewViewModel;
  busy: Set<PreviewActionId>;
  resetBusy?: string;
  resettableResources: PreviewPlanRecord['executionPlan']['resources'];
  confirmation?: PreviewConfirmation;
  confirmationBusy: boolean;
  runAction(action: PreviewActionId): Promise<void>;
  requestAction(action: PreviewActionModel, returnFocus?: HTMLElement): void;
  requestReset(resourceId: string, returnFocus?: HTMLElement): void;
  closeConfirmation(): void;
  confirm(): Promise<void>;
}

export function PreviewOverviewCard(
  props: PreviewPanelProps & { onShowDetails(): void }
) {
  const controller = usePreviewController(props);
  const projection = selectPreviewOverviewProjection(controller.view);
  const action = projection.recommendedAction;
  const tone = previewTone(controller.view);

  return (
    <section className="tm-panel tm-preview-card" aria-label="Preview summary">
      <div className="tm-preview-card__head">
        <h3 className="tm-panel__title">Preview</h3>
        <Chip label={controller.view.status} tone={tone} />
      </div>
      <p className="tm-preview-card__summary">{controller.view.summary}</p>
      {projection.primaryRoute ? (
        action?.id === 'OPEN' ? (
          <code className="tm-preview-card__route">{projection.primaryRoute.route.hostname}</code>
        ) : (
          <button
            type="button"
            className="tm-preview-card__route tm-preview-card__route-button"
            onClick={() => void props.onOpen(
              props.task.id,
              projection.primaryRoute!.generation.id,
              projection.primaryRoute!.route.id
            )}
          >
            <code>{projection.primaryRoute.route.hostname}</code>
            <span>Open current</span>
          </button>
        )
      ) : null}
      <div className="tm-preview-card__actions">
        {action ? (
          <button
            type="button"
            className="primary-button"
            disabled={isActionDisabled(controller, action.id)}
            onClick={action.id === 'APPROVE'
              ? props.onShowDetails
              : () => void controller.runAction(action.id)}
          >
            {controller.busy.has(action.id)
              ? 'Working…'
              : action.id === 'APPROVE' ? 'Review plan' : action.label}
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={props.onShowDetails}>
            View Preview
          </button>
        )}
        {action ? (
          <button type="button" className="tm-preview-card__details" onClick={props.onShowDetails}>
            Details
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function PreviewWorkspace(props: PreviewPanelProps) {
  const controller = usePreviewController(props);
  const logs = usePreviewLogs(props, controller.view);
  const projection = selectPreviewOverviewProjection(controller.view);
  const primaryAction = selectWorkspacePrimaryAction(controller.view, projection.recommendedAction);
  const openAction = controller.view.actions.find((action) => action.id === 'OPEN');
  const plan = controller.view.plan;
  const diagnosticAttempts = selectPreviewDiagnosticAttempts(props.attempts, controller.view);
  const approvalRequired = controller.view.status === 'Approval required';
  const readyToStart = controller.view.status === 'Ready to start';
  const showOperationalEvidence = Boolean(plan) && !approvalRequired && !readyToStart &&
    controller.view.status !== 'Stopped';
  const attachmentReadiness = (
    controller.view.replacementGeneration ??
    controller.view.failedReplacementGeneration ??
    controller.view.generation
  )?.attachmentReadiness ?? [];
  const showLiveBindings = showOperationalEvidence && (
    ['Starting', 'Replacing', 'Running', 'Running · stale'].includes(controller.view.status) ||
    attachmentReadiness.length > 0
  );

  return (
    <section className="tm-preview-workspace" aria-label="Preview">
      <header className="tm-preview-workspace__head">
        <div className="tm-preview-workspace__decision">
          <Chip label={controller.view.status} tone={previewTone(controller.view)} />
          <p>{controller.view.summary}</p>
        </div>
        <div className="tm-preview-workspace__actions">
          {primaryAction ? (
            <button
              type="button"
              className={primaryAction.id === 'STOP' ? 'outline-button' : 'primary-button'}
              disabled={isActionDisabled(controller, primaryAction.id)}
              onClick={() => void controller.runAction(primaryAction.id)}
            >
              {controller.busy.has(primaryAction.id) ? 'Working…' : primaryAction.label}
            </button>
          ) : null}
          {openAction && primaryAction?.id !== 'OPEN' ? (
            <button
              type="button"
              className="outline-button"
              disabled={isActionDisabled(controller, 'OPEN')}
              onClick={() => void controller.runAction('OPEN')}
            >
              {openAction.label}
            </button>
          ) : null}
          {controller.view.latestAttempt ? (
            <button type="button" className="tm-preview-workspace__quiet" onClick={logs.open}>
              View logs
            </button>
          ) : null}
          <PreviewActionMenu
            actions={controller.view.actions.filter(
              (action) => action.id !== primaryAction?.id && action.id !== 'OPEN'
            )}
            resetResources={controller.resettableResources}
            isActionDisabled={(action) => isActionDisabled(controller, action.id)}
            resetDisabled={controller.busy.size > 0 || Boolean(controller.resetBusy)}
            onAction={controller.requestAction}
            onReset={controller.requestReset}
          />
        </div>
      </header>

      {plan && plan.executionPlan.scenarios.length > 1 ? (
        <label className="tm-field tm-preview-workspace__scenario">
          <span>Data scenario</span>
          <select
            value={plan.executionPlan.selectedScenarioId}
            disabled={controller.busy.size > 0 || Boolean(controller.resetBusy)}
            onChange={(event) => void props.onResolve(props.task.id, event.target.value)}
          >
            {plan.executionPlan.scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>{scenario.label ?? scenario.id}</option>
            ))}
          </select>
        </label>
      ) : null}

      {controller.view.activeGeneration && (
        controller.view.replacementGeneration ||
        controller.view.failedReplacementGeneration ||
        controller.view.recoveryGeneration
      ) ? (
        <PreviewGenerationComparison view={controller.view} />
      ) : null}

      {plan ? <div className="tm-preview-workspace__columns">
        <div className="tm-preview-workspace__column">
          {approvalRequired ? (
            <PreviewPlanAuthority plan={plan} approval={controller.view.approval} />
          ) : null}
          {showOperationalEvidence ? (
            <PreviewApplicationSection
              plan={plan}
              view={controller.view}
              attempts={props.attempts}
              runtimeResources={props.runtimeResources}
              composeProjects={props.composeProjects}
            />
          ) : null}
          {showOperationalEvidence ? (
            <PreviewRoutesSection
              view={controller.view}
              onOpen={(generation, route) =>
                props.onOpen(props.task.id, generation.id, route.id)
              }
            />
          ) : null}
          {!approvalRequired ? (
            <PreviewPlanAuthority plan={plan} approval={controller.view.approval} />
          ) : null}
        </div>

        <div className="tm-preview-workspace__column tm-preview-workspace__column--side">
          {showOperationalEvidence ? (
            <PreviewDataSection
              view={controller.view}
              managedResources={props.managedResources}
              composeProjects={props.composeProjects}
              generationAttachments={props.generationAttachments}
            />
          ) : null}
          {showLiveBindings ? (
            <PreviewBindingsSection
              plan={plan}
              localBindings={props.localBindings}
              readiness={attachmentReadiness}
            />
          ) : null}
          {controller.view.approval && plan.executionPlan.inputs?.length ? (
            <section className="tm-preview-workspace__section" aria-labelledby="preview-private-inputs">
              <SectionHeading
                id="preview-private-inputs"
                title="Private inputs"
                detail="Encrypted local values are delivered only to declared recipients."
              />
              <div className="tm-preview-inputs">
                {plan.executionPlan.inputs.map((input) => (
                  <PrivateInputControl
                    key={input.id}
                    taskId={props.task.id}
                    inputId={input.id}
                    label={input.label ?? input.id}
                    onChanged={() => props.onResolve(
                      props.task.id,
                      plan.executionPlan.selectedScenarioId
                    )}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {controller.view.generation && !approvalRequired ? (
            <PreviewTechnicalDetails view={controller.view} generations={props.generations} />
          ) : null}
        </div>
      </div> : null}

      {logs.value !== undefined ? (
        <PreviewLogDock
          attempts={diagnosticAttempts}
          selectedAttempt={logs.selectedAttempt}
          selectedStream={logs.selectedStream}
          value={logs.value}
          onAttemptChange={logs.setSelectedAttemptId}
          onStreamChange={logs.setSelectedStream}
          onClose={logs.close}
        />
      ) : null}

      {controller.confirmation ? (
        <PreviewConfirmationModal
          confirmation={controller.confirmation}
          busy={controller.confirmationBusy}
          onCancel={controller.closeConfirmation}
          onConfirm={() => void controller.confirm()}
        />
      ) : null}
    </section>
  );
}

function usePreviewController(props: PreviewPanelProps): PreviewController {
  const [busy, setBusy] = useState<Set<PreviewActionId>>(() => new Set());
  const [resetBusy, setResetBusy] = useState<string>();
  const [confirmation, setConfirmation] = useState<PreviewConfirmation>();
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const view = buildPreviewViewModel(props);
  const resetGeneration = view.recoveryGeneration ?? view.activeGeneration ?? view.generation;
  const resettableResources = selectPreviewResetResources(props, view);

  const runAction = async (action: PreviewActionId) => {
    if (
      busy.has(action) ||
      (busy.size > 0 && !(['OPEN', 'STOP'].includes(action) && busy.has('START')))
    ) return;
    setBusy((current) => new Set(current).add(action));
    try {
      if (action === 'RESOLVE') await props.onResolve(props.task.id);
      if (action === 'APPROVE' && view.plan) {
        await props.onApprove(props.task.id, view.plan.id, view.plan.executionDigest);
      }
      if (action === 'START') {
        await props.onStart(props.task.id, view.plan?.executionPlan.selectedScenarioId);
      }
      const retryGeneration = view.recoveryGeneration ?? view.generation;
      if (action === 'RETRY_SETUP' && retryGeneration && view.plan) {
        await props.onRetrySetup(
          props.task.id,
          retryGeneration.id,
          view.plan.executionPlan.selectedScenarioId
        );
      }
      const openGeneration = selectPreviewActionGeneration(view, 'OPEN');
      if (action === 'OPEN' && openGeneration) {
        const route = openGeneration.routes.find((candidate) => candidate.state === 'ATTACHED');
        if (route) await props.onOpen(props.task.id, openGeneration.id, route.id);
      }
      const stopGeneration = selectPreviewActionGeneration(view, 'STOP');
      if (action === 'STOP' && stopGeneration) {
        await props.onStop(props.task.id, stopGeneration.id);
      }
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(action);
        return next;
      });
    }
  };

  const runReset = async (resourceId: string) => {
    const generation = resetGeneration;
    const scenarioId = view.plan?.executionPlan.selectedScenarioId;
    if (!generation || !scenarioId || resetBusy) return;
    setResetBusy(resourceId);
    try {
      await props.onResetData(props.task.id, generation.id, resourceId, scenarioId);
    } finally {
      setResetBusy(undefined);
    }
  };

  const requestAction = (action: PreviewActionModel, returnFocus?: HTMLElement) => {
    if (action.id !== 'STOP' || action.label === 'Retry cleanup') {
      void runAction(action.id);
      return;
    }
    const destructive = action.label.includes('Delete Data');
    const adapter = view.plan?.executionPlan.adapter;
    const body = destructive
      ? adapter === 'COMPOSE'
        ? 'Stops the stable Compose preview and permanently deletes every active or retained Task Monki-owned volume. External resources, images, and build cache are not changed.'
        : 'Stops this preview and permanently deletes its Task Monki-managed PostgreSQL or Redis data. Attached dependencies are never changed.'
      : action.label === 'Cancel replacement'
        ? 'Stops and verifies only the candidate generation. The current active preview stays available and its managed data is preserved.'
        : 'Cancels startup and runs the recorded exact cleanup path. Preview-owned runtime and managed data covered by this generation may be deleted.';
    setConfirmation(() => ({
      title: action.label,
      body,
      confirmLabel: action.label,
      danger: destructive || action.label !== 'Cancel replacement',
      returnFocus,
      run: () => runAction('STOP')
    }));
  };

  const requestReset = (resourceId: string, returnFocus?: HTMLElement) => {
    setConfirmation(() => ({
      title: `Reset ${resourceId} data`,
      body: `Stops the complete preview, permanently deletes only ${resourceId}'s Task Monki-managed data, and cannot restore it if recreation or setup fails. Attached dependencies are never changed.`,
      confirmLabel: `Reset ${resourceId}`,
      danger: true,
      returnFocus,
      run: () => runReset(resourceId)
    }));
  };

  const closeConfirmation = () => {
    if (!confirmationBusy) setConfirmation(undefined);
  };
  const confirm = async () => {
    if (!confirmation || confirmationBusy) return;
    setConfirmationBusy(true);
    try {
      await confirmation.run();
      setConfirmation(undefined);
    } finally {
      setConfirmationBusy(false);
    }
  };

  return {
    view,
    busy,
    resetBusy,
    resettableResources,
    confirmation,
    confirmationBusy,
    runAction,
    requestAction,
    requestReset,
    closeConfirmation,
    confirm
  };
}

function usePreviewLogs(props: PreviewPanelProps, view: PreviewViewModel) {
  const [value, setValue] = useState<string>();
  const [selectedAttemptId, setSelectedAttemptId] = useState<string>();
  const [selectedStream, setSelectedStream] = useState<'stdout' | 'stderr'>('stdout');
  const selectedAttempt = props.attempts.find(
    (attempt) => attempt.id === (selectedAttemptId ?? view.latestAttempt?.id)
  );
  const selectedArtifactId = selectedAttempt
    ? selectedStream === 'stdout'
      ? selectedAttempt.stdoutArtifactId
      : selectedAttempt.stderrArtifactId
    : undefined;
  const selectedAttemptTerminal = selectedAttempt
    ? ['SUCCEEDED', 'FAILED', 'STOPPED', 'RECOVERY_REQUIRED'].includes(selectedAttempt.state)
    : true;
  const terminalRef = useRef(selectedAttemptTerminal);
  terminalRef.current = selectedAttemptTerminal;

  useEffect(() => {
    if (value === undefined || !selectedArtifactId) return;
    let canceled = false;
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setValue('');
    const poll = async () => {
      let continuePolling = true;
      try {
        const result = await props.onReadLog(props.task.id, selectedArtifactId, offset, 64 * 1024);
        if (canceled) return;
        offset = result.nextOffset;
        if (result.chunk) setValue((current) => `${current ?? ''}${result.chunk}`);
        if (result.endOfFile && terminalRef.current) continuePolling = false;
      } catch {
        continuePolling = false;
      } finally {
        if (!canceled && continuePolling) timer = setTimeout(() => void poll(), 750);
      }
    };
    void poll();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
    // The selected artifact owns this polling lifecycle; callback identity is intentionally irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArtifactId, value === undefined, props.task.id]);

  return {
    value,
    selectedAttempt,
    selectedStream,
    setSelectedAttemptId,
    setSelectedStream,
    open: () => {
      if (!view.latestAttempt) return;
      setSelectedAttemptId(view.latestAttempt.id);
      setSelectedStream('stdout');
      setValue('');
    },
    close: () => setValue(undefined)
  };
}

function PreviewGenerationComparison({ view }: { view: PreviewViewModel }) {
  const candidate = view.replacementGeneration ?? view.failedReplacementGeneration ?? view.recoveryGeneration;
  if (!view.activeGeneration || !candidate) return null;
  return (
    <section className="tm-preview-generations" aria-label="Active and candidate generations">
      <GenerationSummary generation={view.activeGeneration} label="Active" />
      <span className="tm-preview-generations__arrow" aria-hidden="true">→</span>
      <GenerationSummary generation={candidate} label="Candidate" />
    </section>
  );
}

function GenerationSummary({ generation, label }: { generation: PreviewGenerationRecord; label: string }) {
  return (
    <div className="tm-preview-generation">
      <div className="tm-preview-generation__head">
        <strong>{label}</strong>
        <span className={`tm-preview-state tm-preview-state--${toneForRecordState(generation.state)}`}>
          {humanize(generation.state)}
        </span>
      </div>
      <code>{shortId(generation.id)}</code>
      <span>{generation.freshness === 'STALE' ? 'Captured source is stale' : 'Captured source is current'}</span>
    </div>
  );
}

function PreviewPlanAuthority({
  plan,
  approval
}: {
  plan: PreviewPlanRecord;
  approval?: PreviewApprovalRecord;
}) {
  const groups = buildPreviewPlanGroups(plan);
  const composeServiceCount = plan.executionPlan.compose?.inspection?.services.length ?? 0;
  const applicationSummary = plan.executionPlan.adapter === 'COMPOSE'
    ? composeServiceCount > 0
      ? `${composeServiceCount} Compose ${composeServiceCount === 1 ? 'service' : 'services'}`
      : undefined
    : [
        plan.executionPlan.services.length > 0
          ? `${plan.executionPlan.services.length} ${plan.executionPlan.services.length === 1 ? 'service' : 'services'}`
          : undefined,
        plan.executionPlan.workers.length > 0
          ? `${plan.executionPlan.workers.length} ${plan.executionPlan.workers.length === 1 ? 'worker' : 'workers'}`
          : undefined
      ].filter(Boolean).join(' · ') || undefined;
  const setupCount = groups.find((group) => group.id === 'setup')?.lines.filter(
    (line) => line.label.startsWith('Job ·')
  ).length ?? 0;
  const managedDataCount = plan.executionPlan.adapter === 'COMPOSE'
    ? plan.executionPlan.compose?.inspection?.volumes.filter((volume) => !volume.external).length ?? 0
    : groups.find((group) => group.id === 'data')?.lines.filter(
        (line) => line.label.startsWith('Resource ·')
      ).length ?? 0;
  const summaries = [
    applicationSummary
      ? { label: 'Application', value: applicationSummary }
      : undefined,
    setupCount > 0
      ? { label: 'Setup', value: `${setupCount} ${setupCount === 1 ? 'job' : 'jobs'}` }
      : undefined,
    managedDataCount > 0
      ? { label: 'Managed data', value: `${managedDataCount} owned ${managedDataCount === 1 ? 'resource' : 'resources'}` }
      : undefined,
    plan.executionPlan.routes.length > 0
      ? { label: 'Routes', value: `${plan.executionPlan.routes.length} stable ${plan.executionPlan.routes.length === 1 ? 'route' : 'routes'}` }
      : undefined,
    plan.executionPlan.inputs?.length
      ? { label: 'Private inputs', value: `${plan.executionPlan.inputs.length} ${plan.executionPlan.inputs.length === 1 ? 'input' : 'inputs'} · recipient-scoped` }
      : undefined,
    plan.executionPlan.attachments?.length
      ? { label: 'Attachments', value: `${plan.executionPlan.attachments.length} non-owned ${plan.executionPlan.attachments.length === 1 ? 'dependency' : 'dependencies'}` }
      : undefined,
    {
      label: 'Cleanup',
      value: plan.executionPlan.adapter === 'COMPOSE'
        ? 'Stops the task-scoped project and deletes only its owned volumes'
        : 'Stops preview processes and deletes only preview-managed data'
    }
  ].filter((summary): summary is { label: string; value: string } => Boolean(summary));
  const warnings = plan.executionPlan.adapter === 'COMPOSE'
    ? plan.warnings.filter((warning) => !warning.startsWith('Native preview commands run'))
    : plan.warnings;
  const exactDetails = (
    <div className="tm-preview-authority__groups">
      {groups.map((group) => (
        <section key={group.id} className="tm-preview-authority__group">
          <h4>{group.label}</h4>
          <div className="tm-preview-authority__rows">
            {group.lines.map((line, index) => (
              <PlanLine key={`${line.label}-${index}`} label={line.label} value={line.value} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );

  if (approval) {
    return (
      <section className="tm-preview-workspace__section" aria-label="Approved plan">
        <details className="tm-preview-disclosure">
          <summary>Approved plan details</summary>
          {exactDetails}
          <PlanWarnings warnings={warnings} />
        </details>
      </section>
    );
  }

  return (
    <section className="tm-preview-workspace__section" aria-labelledby="preview-plan-authority">
      <SectionHeading
        id="preview-plan-authority"
        title="Review execution plan"
      />
      <div className="tm-preview-plan-summary">
        {summaries.map((summary) => (
          <PlanSummaryRow key={summary.label} label={summary.label} value={summary.value} />
        ))}
      </div>
      {warnings.length > 0 ? (
        <p className="tm-preview-authority__warning-summary">
          {plan.executionPlan.adapter === 'COMPOSE'
            ? 'Compose may build or pull images on the selected local engine.'
            : 'Native commands run unsandboxed and may access the network.'}
        </p>
      ) : null}
      <PlanWarnings warnings={warnings} />
      <details className="tm-preview-disclosure">
        <summary>Exact commands, recipients, and cleanup details</summary>
        {exactDetails}
      </details>
    </section>
  );
}

function PreviewApplicationSection({
  plan,
  view,
  attempts,
  runtimeResources,
  composeProjects
}: {
  plan: PreviewPlanRecord;
  view: PreviewViewModel;
  attempts: PreviewNodeAttemptRecord[];
  runtimeResources: PreviewResourceRecord[];
  composeProjects: PreviewComposeProjectRecord[];
}) {
  const diagnosticGeneration = view.replacementGeneration ??
    view.failedReplacementGeneration ?? view.generation;
  const generationAttempts = attempts.filter(
    (attempt) => attempt.generationId === diagnosticGeneration?.id
  );
  const latestByNode = new Map<string, PreviewNodeAttemptRecord>();
  for (const attempt of [...generationAttempts].sort((a, b) => b.attempt - a.attempt)) {
    if (!latestByNode.has(attempt.nodeId)) latestByNode.set(attempt.nodeId, attempt);
  }
  const nativeNodes = [
    ...plan.executionPlan.jobs.map((node) => ({ ...node, kind: 'Job' })),
    ...plan.executionPlan.services.map((node) => ({ ...node, kind: 'Service' })),
    ...plan.executionPlan.workers.map((node) => ({ ...node, kind: 'Worker' }))
  ];
  const composeServices = plan.executionPlan.compose?.inspection?.services ?? [];
  const composeProject = [...composeProjects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const observedNativeNodes = nativeNodes.flatMap((node) => {
    const attempt = latestByNode.get(node.id);
    return attempt ? [{ node, attempt }] : [];
  });
  const observedComposeServices = composeProject && composeProject.state !== 'STOPPED'
    ? composeServices
    : [];
  const currentRuntime = runtimeResources
    .filter((resource) => resource.generationId === diagnosticGeneration?.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (observedNativeNodes.length === 0 && observedComposeServices.length === 0 && currentRuntime.length === 0) {
    return null;
  }

  return (
    <section className="tm-preview-workspace__section" aria-labelledby="preview-application">
      <SectionHeading
        id="preview-application"
        title="Application"
        detail={plan.executionPlan.adapter === 'COMPOSE'
          ? `Task-scoped Compose project · ${humanize(composeProject?.state ?? 'Starting')}.`
          : undefined}
      />
      <div className="tm-preview-rows">
        {plan.executionPlan.adapter === 'COMPOSE'
          ? observedComposeServices.map((service) => (
              <OperationalRow
                key={service.id}
                title={service.id}
                kind="Compose service"
                state={composeProject?.state ?? 'STARTING'}
              />
            ))
          : observedNativeNodes.map(({ node, attempt }) => (
                <OperationalRow
                  key={`${node.kind}-${node.id}`}
                  title={node.label ?? node.id}
                  kind={node.kind}
                  state={attempt.state}
                />
              ))}
      </div>
      {currentRuntime.length > 0 ? (
        <details className="tm-preview-disclosure">
          <summary>Runtime ownership records · {currentRuntime.length}</summary>
          <div className="tm-preview-rows">
            {currentRuntime.map((resource) => (
              <OperationalRow
                key={resource.id}
                title={resource.logicalNodeId}
                kind="Native process"
                detail="Verified preview-owned runtime"
                state={resource.state}
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function PreviewRoutesSection({
  view,
  onOpen
}: {
  view: PreviewViewModel;
  onOpen(generation: PreviewGenerationRecord, route: PreviewRouteRecord): Promise<void>;
}) {
  const generations = uniqueGenerations([
    view.activeGeneration,
    view.replacementGeneration,
    view.failedReplacementGeneration,
    view.generation
  ]);
  const routes = generations.flatMap((generation) =>
    generation.routes
      .filter((route) => route.state === 'ATTACHED')
      .map((route) => ({ generation, route }))
  );
  if (routes.length === 0) return null;
  return (
    <section className="tm-preview-workspace__section" aria-labelledby="preview-routes">
      <SectionHeading
        id="preview-routes"
        title="Routes"
        detail="Stable Task Monki hostnames point only to the active generation."
      />
      <div className="tm-preview-routes">
        {routes.map(({ generation, route }) => (
          <div key={`${generation.id}-${route.id}`} className="tm-preview-route">
            <div>
              <strong>{route.id}</strong>
              <code>{route.url}</code>
              <span>{generation.routingState.toLowerCase()} generation</span>
            </div>
            <button type="button" className="tm-preview-workspace__quiet" onClick={() => void onOpen(generation, route)}>
              Open
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function PreviewTechnicalDetails({
  view,
  generations
}: {
  view: PreviewViewModel;
  generations: PreviewGenerationRecord[];
}) {
  const current = view.replacementGeneration ?? view.failedReplacementGeneration ?? view.generation;
  const history = [...generations]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);
  if (!current) return null;
  return (
    <details className="tm-preview-disclosure tm-preview-technical-details">
      <summary>Technical details</summary>
      <div className="tm-preview-technical-details__body">
        <p>Captured {formatDate(current.createdAt)}.</p>
        <dl className="tm-preview-keyvalues">
          <div><dt>Generation</dt><dd><code>{shortId(current.id)}</code></dd></div>
          <div><dt>State</dt><dd>{humanize(current.state)}</dd></div>
          <div><dt>Source</dt><dd><code>{shortId(current.sourceHeadSha)}</code></dd></div>
          <div><dt>Routing</dt><dd>{humanize(current.routingState)}</dd></div>
        </dl>
        {history.length > 1 ? (
          <details className="tm-preview-disclosure">
            <summary>Generation history · {history.length}</summary>
            <div className="tm-preview-rows">
              {history.map((generation) => (
                <OperationalRow
                  key={generation.id}
                  title={shortId(generation.id)}
                  kind={humanize(generation.routingState)}
                  detail={formatDate(generation.updatedAt)}
                  state={generation.state}
                />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}

function PreviewDataSection({
  view,
  managedResources,
  composeProjects,
  generationAttachments
}: {
  view: PreviewViewModel;
  managedResources: PreviewManagedResourceRecord[];
  composeProjects: PreviewComposeProjectRecord[];
  generationAttachments: PreviewGenerationAttachmentRecord[];
}) {
  const relevantGenerationIds = new Set(uniqueGenerations([
    view.activeGeneration,
    view.replacementGeneration,
    view.failedReplacementGeneration,
    view.recoveryGeneration,
    view.generation
  ]).map((generation) => generation.id));
  const attachedManagedIds = new Set(
    generationAttachments
      .filter((attachment) => relevantGenerationIds.has(attachment.generationId))
      .map((attachment) => attachment.managedResourceId)
  );
  const resources = [...managedResources]
    .filter((resource) => attachedManagedIds.has(resource.id) || !resource.stoppedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);
  const composeProject = [...composeProjects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const ownedComposeVolumes = composeProject?.volumes.filter((volume) => !volume.external) ?? [];
  if (resources.length === 0 && ownedComposeVolumes.length === 0) return null;

  return (
    <section className="tm-preview-workspace__section" aria-labelledby="preview-data">
      <SectionHeading
        id="preview-data"
        title="Managed data"
        detail="Only records explicitly owned by this task appear here. Attached dependencies are excluded."
      />
      <div className="tm-preview-rows">
        {resources.map((resource) => (
          <OperationalRow
            key={resource.id}
            title={resource.logicalResourceId}
            kind={resource.type === 'postgres' ? 'PostgreSQL' : 'Redis'}
            detail="Task Monki-owned persistent volume"
            state={resource.state}
          />
        ))}
        {ownedComposeVolumes.map((volume) => (
          <OperationalRow
            key={`compose-${volume.logicalName}`}
            title={volume.logicalName}
            kind="Compose volume"
            detail="Task Monki-owned data"
            state={volume.state}
          />
        ))}
      </div>
    </section>
  );
}

function PreviewBindingsSection({
  plan,
  localBindings,
  readiness
}: {
  plan: PreviewPlanRecord;
  localBindings: PreviewLocalAttachmentBindingRecord[];
  readiness: NonNullable<PreviewGenerationRecord['attachmentReadiness']>;
}) {
  const attachments = plan.executionPlan.attachments ?? [];
  if (attachments.length === 0) return null;
  const readinessById = new Map(readiness.map((evidence) => [evidence.attachmentId, evidence]));
  return (
    <section className="tm-preview-workspace__section" aria-labelledby="preview-bindings">
      <SectionHeading
        id="preview-bindings"
        title="Attached dependencies"
        detail="Public targets are resolved or checked once at startup and are never owned or mutated."
      />
      <div className="tm-preview-rows">
        {attachments.map((attachment) => {
          const localBinding = localBindings.find((binding) => binding.attachmentId === attachment.id);
          const evidence = readinessById.get(attachment.id);
          return (
            <OperationalRow
              key={attachment.id}
              title={attachment.label ?? attachment.id}
              kind={attachment.type.toUpperCase()}
              detail={formatAttachmentTarget(attachment, localBinding?.target)}
              state={evidence
                ? evidence.status === 'PASSED' ? 'Startup check passed' : humanize(evidence.failureCode ?? 'Check failed')
                : attachment.check ? 'Not checked this generation' : 'No check declared'}
            />
          );
        })}
      </div>
    </section>
  );
}

function PrivateInputControl(props: {
  taskId: string;
  inputId: string;
  label: string;
  onChanged(): Promise<void>;
}) {
  const valueRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error' | 'neutral'; message: string }>();
  const run = async (action: () => Promise<PreviewPrivateInputOperationResult>) => {
    if (busy) return false;
    setBusy(true);
    setFeedback(undefined);
    try {
      const result = await action();
      if (result.status === 'FAILED') {
        setFeedback({ tone: 'error', message: privateInputFailureMessage(result.code) });
        return false;
      }
      if (result.status === 'CANCELED') {
        setFeedback({ tone: 'neutral', message: 'Import canceled.' });
        return false;
      }
      await props.onChanged();
      setFeedback({
        tone: 'success',
        message: result.status === 'IMPORTED'
          ? 'Selected key imported.'
          : result.status === 'DELETED' ? 'Encrypted value deleted.' : 'Encrypted value saved.'
      });
      return true;
    } catch {
      setFeedback({ tone: 'error', message: 'Private input operation failed safely.' });
      return false;
    } finally {
      if (valueRef.current) valueRef.current.value = '';
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);
  return (
    <div className="tm-preview-input">
      <div className="tm-preview-input__head">
        <div><strong>{props.label}</strong><code>{props.inputId}</code></div>
        <div className="tm-taskmenu" ref={menuRef}>
          <button
            ref={triggerRef}
            type="button"
            className="tm-taskmenu__trigger"
            aria-label={`Private input options for ${props.label}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <KebabIcon />
          </button>
          {menuOpen ? (
            <div className="tm-taskmenu__menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="tm-taskmenu__item tm-taskmenu__item--danger"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
              >
                Delete value…
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="tm-preview-input__entry">
        <label className="tm-field">
          <span>New value</span>
          <input ref={valueRef} type="password" autoComplete="off" disabled={busy} />
        </label>
        <button type="button" className="outline-button" disabled={busy} onClick={() => void run(async () => {
          const api = window.previewPrivateInputs;
          if (!api) throw new Error('Private input API unavailable.');
          return api.set({
            taskId: props.taskId,
            inputId: props.inputId,
            value: valueRef.current?.value ?? ''
          });
        })}>
          {busy ? 'Saving…' : 'Save value'}
        </button>
      </div>
      {feedback ? (
        <p
          className={`tm-preview-input__feedback tm-preview-input__feedback--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}
      <details className="tm-preview-disclosure tm-preview-input__import">
        <summary>Import one .env key</summary>
        <div className="tm-preview-input__entry">
          <label className="tm-field">
            <span>Selected key</span>
            <input ref={keyRef} type="text" autoComplete="off" disabled={busy} />
          </label>
          <button type="button" className="outline-button" disabled={busy} onClick={() => void run(async () => {
            const api = window.previewPrivateInputs;
            if (!api) throw new Error('Private input API unavailable.');
            return api.import({
              taskId: props.taskId,
              inputId: props.inputId,
              key: keyRef.current?.value ?? ''
            });
          })}>
            Choose file and import
          </button>
        </div>
      </details>
      {confirmDelete ? (
        <PreviewConfirmationModal
          confirmation={{
            title: `Delete ${props.label}`,
            body: 'Deletes the current encrypted value. Existing live generations retain their exact encrypted revision until verified cleanup; approval is unchanged.',
            confirmLabel: 'Delete value',
            danger: true,
            returnFocus: triggerRef.current ?? undefined,
            run: async () => {}
          }}
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void (async () => {
            await run(() => window.previewPrivateInputs?.delete({
              taskId: props.taskId,
              inputId: props.inputId
            }) ?? Promise.reject(new Error('Private input API unavailable.')));
            setConfirmDelete(false);
          })()}
        />
      ) : null}
    </div>
  );
}

function PreviewActionMenu({
  actions,
  resetResources,
  isActionDisabled,
  resetDisabled,
  onAction,
  onReset
}: {
  actions: PreviewActionModel[];
  resetResources: PreviewPlanRecord['executionPlan']['resources'];
  isActionDisabled(action: PreviewActionModel): boolean;
  resetDisabled: boolean;
  onAction(action: PreviewActionModel, returnFocus?: HTMLElement): void;
  onReset(resourceId: string, returnFocus?: HTMLElement): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (actions.length === 0 && resetResources.length === 0) return null;
  return (
    <div className="tm-taskmenu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tm-taskmenu__trigger"
        aria-label="Preview options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <KebabIcon />
      </button>
      {open ? (
        <div className="tm-taskmenu__menu tm-preview-actionmenu" role="menu">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={`tm-taskmenu__item ${action.label.includes('Delete Data') ? 'tm-taskmenu__item--danger' : ''}`}
              disabled={isActionDisabled(action)}
              onClick={() => {
                setOpen(false);
                onAction(action, triggerRef.current ?? undefined);
              }}
            >
              {action.label}
            </button>
          ))}
          {actions.length > 0 && resetResources.length > 0 ? <div className="tm-pathmenu__separator" /> : null}
          {resetResources.map((resource) => (
            <button
              key={resource.id}
              type="button"
              role="menuitem"
              className="tm-taskmenu__item tm-taskmenu__item--danger"
              disabled={resetDisabled}
              onClick={() => {
                setOpen(false);
                onReset(resource.id, triggerRef.current ?? undefined);
              }}
            >
              Reset {resource.id} data…
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PreviewConfirmationModal({
  confirmation,
  busy,
  onCancel,
  onConfirm
}: {
  confirmation: PreviewConfirmation;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  busyRef.current = busy;
  onCancelRef.current = onCancel;
  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCancelRef.current();
      if (event.key !== 'Tab') return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      confirmation.returnFocus?.focus();
    };
  }, [confirmation.returnFocus]);
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="preview-confirmation-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div ref={panelRef} className="tm-modal__panel tm-preview-confirmation">
        <h3 id="preview-confirmation-title">{confirmation.title}</h3>
        <p>{confirmation.body}</p>
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" autoFocus disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={confirmation.danger ? 'danger-button' : 'primary-button'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmation.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewLogDock({
  attempts,
  selectedAttempt,
  selectedStream,
  value,
  onAttemptChange,
  onStreamChange,
  onClose
}: {
  attempts: PreviewNodeAttemptRecord[];
  selectedAttempt?: PreviewNodeAttemptRecord;
  selectedStream: 'stdout' | 'stderr';
  value: string;
  onAttemptChange(value: string): void;
  onStreamChange(value: 'stdout' | 'stderr'): void;
  onClose(): void;
}) {
  return (
    <section className="tm-preview-logdock" aria-label="Preview logs">
      <div className="tm-preview-logdock__head">
        <strong>Generation logs</strong>
        <div className="tm-preview-logdock__controls">
          <select
            aria-label="Preview node attempt"
            value={selectedAttempt?.id ?? ''}
            onChange={(event) => onAttemptChange(event.target.value)}
          >
            {attempts.map((attempt) => (
              <option key={attempt.id} value={attempt.id}>
                {attempt.nodeId} · attempt {attempt.attempt} · {humanize(attempt.state)}
              </option>
            ))}
          </select>
          <select
            aria-label="Preview log stream"
            value={selectedStream}
            onChange={(event) => onStreamChange(event.target.value as 'stdout' | 'stderr')}
          >
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </select>
          <button type="button" className="tm-preview-workspace__quiet" onClick={onClose}>Close</button>
        </div>
      </div>
      <pre>{value || 'No output recorded yet.'}</pre>
    </section>
  );
}

function SectionHeading({ id, title, detail }: { id: string; title: string; detail?: string }) {
  return (
    <div className="tm-preview-workspace__sectionhead">
      <h3 id={id}>{title}</h3>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}

function PlanSummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="tm-preview-plan-summary__row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PlanWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <details className="tm-preview-disclosure tm-preview-authority__warning-disclosure">
      <summary>Plan warnings · {warnings.length}</summary>
      <div className="tm-preview-authority__warnings">
        {warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div>
    </details>
  );
}

function OperationalRow({
  title,
  kind,
  detail,
  state
}: {
  title: string;
  kind: string;
  detail?: string;
  state: string;
}) {
  return (
    <div className="tm-preview-row">
      <div className="tm-preview-row__copy">
        <strong>{title}</strong>
        <span>{kind}</span>
        {detail ? <code>{detail}</code> : null}
      </div>
      <span className={`tm-preview-state tm-preview-state--${toneForRecordState(state)}`}>
        {humanize(state)}
      </span>
    </div>
  );
}

function PlanLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="tm-preview-planline">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function KebabIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}

function previewTone(view: PreviewViewModel): 'neutral' | 'info' | 'action' | 'success' | 'error' {
  if (view.status === 'Starting' || view.status === 'Replacing') return 'info';
  return view.tone === 'warning' ? 'action' : view.tone;
}

function selectWorkspacePrimaryAction(
  view: PreviewViewModel,
  recommendedAction?: PreviewActionModel
): PreviewActionModel | undefined {
  if (view.status === 'Starting') {
    return view.actions.find((action) => action.id === 'STOP');
  }
  if (view.status === 'Cleanup incomplete') {
    return view.actions.find((action) => action.id === 'STOP' && action.label === 'Retry cleanup');
  }
  return recommendedAction;
}

function isActionDisabled(controller: PreviewController, action: PreviewActionId): boolean {
  return controller.busy.has(action) || (
    controller.busy.size > 0 && !(
      ['OPEN', 'STOP'].includes(action) && controller.busy.has('START')
    )
  );
}

function formatAttachmentTarget(
  attachment: PreviewAttachmentPlan,
  localTarget?: PreviewResolvedAttachmentTarget
): string {
  const target = localTarget ?? (attachment.target.type === 'local' ? undefined : attachment.target);
  const prefix = localTarget ? 'Local binding · ' : '';
  if (!target) return 'Local public target required';
  if (target.type === 'task-preview-route') {
    return `${prefix}Task ${target.targetTaskId} · route ${target.routeId}`;
  }
  if (target.type === 'endpoint') {
    if (
      'scheme' in target && typeof target.scheme === 'string' &&
      'basePath' in target && typeof target.basePath === 'string'
    ) {
      return `${prefix}${target.scheme}://${target.host}:${target.port}${target.basePath}`;
    }
    const database = 'database' in target ? `/${target.database}` : '';
    return `${prefix}${target.host}:${target.port}${database}`;
  }
  return 'Local public target required';
}

function uniqueGenerations(
  generations: Array<PreviewGenerationRecord | undefined>
): PreviewGenerationRecord[] {
  const seen = new Set<string>();
  return generations.filter((generation): generation is PreviewGenerationRecord => {
    if (!generation || seen.has(generation.id)) return false;
    seen.add(generation.id);
    return true;
  });
}

function toneForRecordState(state: string): 'success' | 'action' | 'error' | 'neutral' {
  if (['READY', 'RUNNING', 'ATTACHED', 'PASSED', 'SUCCEEDED', 'ACTIVE'].includes(state)) return 'success';
  if (['FAILED', 'RECOVERY_REQUIRED', 'CLEANUP_INCOMPLETE', 'SETUP_FAILED'].includes(state)) return 'error';
  if (['STARTING', 'PREPARING_SOURCE', 'RUNNING_GRAPH', 'WAITING_READY', 'UPDATING', 'PENDING'].includes(state)) return 'action';
  return 'neutral';
}

function humanize(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function privateInputFailureMessage(
  code: Extract<PreviewPrivateInputOperationResult, { status: 'FAILED' }>['code']
): string {
  if (code === 'PROTECTION_UNAVAILABLE') return 'Secure local protection is unavailable.';
  if (code === 'INVALID_VALUE') return 'Enter a nonempty value no larger than 8 KiB.';
  if (code === 'INVALID_KEY') return 'Enter one valid .env key before choosing a file.';
  if (code === 'KEY_MISSING') return 'The selected key was not found.';
  if (code === 'KEY_DUPLICATE') return 'The selected key appears more than once.';
  if (code === 'UNSAFE_IMPORT_FILE') return 'The selected file could not be imported safely.';
  if (code === 'VAULT_RECOVERY_REQUIRED') return 'Encrypted storage requires recovery.';
  return 'This private input is not declared by the current plan.';
}
