import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type {
  PreviewApprovalRecord,
  PreviewComposeProjectRecord,
  PreviewGenerationAttachmentRecord,
  PreviewGenerationRecord,
  PreviewLocalAttachmentBindingRecord,
  PreviewManagedResourceRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation,
  PreviewResourceRecord,
  PreviewRouteRecord,
  ReadPreviewLogResult,
  ResolvePreviewResult,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import type {
  PreviewAttachmentPlan,
  PreviewExecutionBlocker,
  PreviewExecutionReadiness,
  PreviewPrivateInputOperationResult,
  PreviewResolvedAttachmentTarget
} from '../../shared/preview';
import {
  buildPreviewPlanGroups,
  buildPreviewViewModel,
  selectPreviewActionGeneration,
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
  executionReadiness?: PreviewExecutionReadiness;
  resolution?: ResolvePreviewResult;
  recipeGeneration?: PreviewRecipeGenerationSnapshot;
  onResolve(taskId: string, scenarioId?: string): Promise<void>;
  onGetRecipeGeneration(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onGenerateRecipe(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onValidateRecipeDraft(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<PreviewRecipeValidation>;
  onAcceptRecipeDraft(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<import('../../shared/contracts').AcceptPreviewRecipeDraftResult>;
  onDiscardRecipeDraft(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onWriteRecipeManually(taskId: string, worktreeId: string): Promise<void>;
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
  impacts?: Array<{
    tone: 'deleted' | 'kept' | 'untouched';
    label: string;
    detail: string;
  }>;
  requireText?: string;
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
  const secondaryAction = projection.secondaryAction;
  const tone = previewTone(controller.view);
  const hasPrivateInputs = Boolean(controller.view.plan?.executionPlan.inputs?.length);
  const privateInputsNeedCheck = (candidate?: PreviewActionModel) => Boolean(
    candidate?.id === 'START' &&
    hasPrivateInputs &&
    props.executionReadiness?.status !== 'READY'
  );
  const overviewStatus = controller.view.status === 'Ready to start' && privateInputsNeedCheck(action)
    ? props.executionReadiness?.status === 'BLOCKED'
      ? 'Configuration required'
      : 'Inputs unchecked'
    : controller.view.status;
  const overviewTone = overviewStatus === 'Configuration required' || overviewStatus === 'Inputs unchecked'
    ? 'action'
    : tone;
  const overviewSummary = overviewStatus === 'Configuration required'
    ? describeExecutionBlockers(props.executionReadiness?.blockers ?? [])
    : overviewStatus === 'Inputs unchecked'
      ? 'Required private inputs must be checked before startup.'
      : projection.summary;
  const actionLabel = (candidate: PreviewActionModel) => privateInputsNeedCheck(candidate)
    ? props.executionReadiness?.status === 'BLOCKED'
      ? 'Configure inputs'
      : 'Check inputs'
    : overviewActionLabel(candidate, controller.view);

  return (
    <section className="tm-panel tm-preview-card" aria-label="Preview summary">
      <div className="tm-preview-card__head">
        <h3 className="tm-panel__title">Preview</h3>
        <Chip label={overviewStatus} tone={overviewTone} />
      </div>
      <p className="tm-preview-card__summary">{overviewSummary}</p>
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
            onClick={action.id === 'APPROVE' || privateInputsNeedCheck(action)
              ? props.onShowDetails
              : () => void controller.runAction(action.id)}
          >
            {controller.busy.has(action.id)
              ? 'Working…'
              : actionLabel(action)}
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={props.onShowDetails}>
            View Preview
          </button>
        )}
        {secondaryAction ? (
          <button
            type="button"
            className="outline-button"
            disabled={isActionDisabled(controller, secondaryAction.id)}
            onClick={privateInputsNeedCheck(secondaryAction)
              ? props.onShowDetails
              : () => void controller.runAction(secondaryAction.id)}
          >
            {controller.busy.has(secondaryAction.id)
              ? 'Working…'
              : actionLabel(secondaryAction)}
          </button>
        ) : null}
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
  const readinessRequestRef = useRef<string | undefined>(undefined);
  const [requestedInputId, setRequestedInputId] = useState<string>();
  const [readinessCheckFailed, setReadinessCheckFailed] = useState(false);
  const projection = selectPreviewOverviewProjection(controller.view);
  const workspaceActions = selectWorkspaceActions(controller.view, projection.recommendedAction);
  const primaryAction = workspaceActions.primary;
  const secondaryAction = workspaceActions.secondary;
  const plan = controller.view.plan;
  const approvalRequired = controller.view.status === 'Approval required';
  const readyToStart = controller.view.status === 'Ready to start';
  const readinessPending = readyToStart && Boolean(plan?.executionPlan.inputs?.length) &&
    !props.executionReadiness;
  const configurationRequired = readyToStart &&
    props.executionReadiness?.status === 'BLOCKED';
  const presentation = workspacePresentation(
    controller.view,
    props.executionReadiness,
    readinessPending,
    readinessCheckFailed
  );
  const relevantLogGenerationIds = new Set(uniqueGenerations([
    controller.view.activeGeneration,
    controller.view.replacementGeneration,
    controller.view.failedReplacementGeneration,
    controller.view.recoveryGeneration,
    controller.view.generation
  ]).map((generation) => generation.id));
  const diagnosticAttempts = props.attempts
    .filter((attempt) => relevantLogGenerationIds.has(attempt.generationId))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
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
  const showHeaderLogs = Boolean(controller.view.latestAttempt) && (
    controller.view.status === 'Failed' ||
    controller.view.status === 'Recovery required' ||
    controller.view.status === 'Cleanup incomplete' ||
    Boolean(controller.view.failedReplacementGeneration)
  );

  useEffect(() => {
    if (!readinessPending || !plan) return;
    const requestKey = `${props.task.id}:${plan.id}:${plan.executionPlan.selectedScenarioId}`;
    if (readinessRequestRef.current === requestKey) return;
    readinessRequestRef.current = requestKey;
    setReadinessCheckFailed(false);
    void props.onResolve(props.task.id, plan.executionPlan.selectedScenarioId)
      .catch(() => setReadinessCheckFailed(true));
  }, [plan, props.onResolve, props.task.id, readinessPending]);

  if (
    !plan &&
    props.resolution?.status === 'UNAVAILABLE' &&
    props.resolution.reasonCode === 'RECIPE_MISSING'
  ) {
    return <PreviewMissingRecipeSetup {...props} />;
  }

  return (
    <section className="tm-preview-workspace" aria-label="Preview">
      <header className="tm-preview-workspace__head">
        <div className="tm-preview-workspace__decision">
          <div className={`tm-preview-statusline tm-preview-statusline--${presentation.tone}`}>
            <span aria-hidden="true" />
            <strong>{presentation.status}</strong>
            {presentation.meta ? <small>{presentation.meta}</small> : null}
            {plan?.executionPlan.adapter === 'COMPOSE' ? (
              <span className="tm-preview-adapter">Docker Compose</span>
            ) : null}
          </div>
          {presentation.detail ? <p>{presentation.detail}</p> : null}
        </div>
        <div className="tm-preview-workspace__actions">
          {plan && plan.executionPlan.scenarios.length > 1 ? (
            <label className="tm-preview-scenario-control">
              <span>Scenario</span>
              <select
                aria-label="Preview data scenario"
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
          {configurationRequired ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => setRequestedInputId(
                props.executionReadiness?.blockers[0]?.inputId ??
                plan?.executionPlan.inputs?.[0]?.id
              )}
            >
              Configure inputs
            </button>
          ) : null}
          {readinessPending && readinessCheckFailed && plan ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                const requestKey = `${props.task.id}:${plan.id}:${plan.executionPlan.selectedScenarioId}`;
                readinessRequestRef.current = requestKey;
                setReadinessCheckFailed(false);
                void props.onResolve(props.task.id, plan.executionPlan.selectedScenarioId)
                  .catch(() => setReadinessCheckFailed(true));
              }}
            >
              Retry check
            </button>
          ) : null}
          {primaryAction ? (
            <button
              type="button"
              className={primaryAction.id === 'STOP' ? 'outline-button' : 'primary-button'}
              disabled={isActionDisabled(controller, primaryAction.id) || (
                (configurationRequired || readinessPending) && primaryAction.id === 'START'
              )}
              title={(configurationRequired || readinessPending) && primaryAction.id === 'START'
                ? readinessPending && !readinessCheckFailed
                  ? 'Checking required private inputs.'
                  : readinessCheckFailed
                    ? 'The private-input check failed. Retry it before starting.'
                    : describeExecutionBlockers(props.executionReadiness?.blockers ?? [])
                : undefined}
              onClick={() => void controller.runAction(primaryAction.id)}
            >
              {controller.busy.has(primaryAction.id)
                ? 'Working…'
                : workspaceActionLabel(primaryAction, controller.view)}
            </button>
          ) : null}
          {secondaryAction ? (
            <button
              type="button"
              className="outline-button"
              disabled={isActionDisabled(controller, secondaryAction.id)}
              onClick={() => void controller.runAction(secondaryAction.id)}
            >
              {controller.busy.has(secondaryAction.id)
                ? 'Working…'
                : workspaceActionLabel(secondaryAction, controller.view)}
            </button>
          ) : null}
          {showHeaderLogs ? (
            <button type="button" className="tm-preview-workspace__quiet" onClick={logs.open}>
              View logs
            </button>
          ) : null}
          <PreviewActionMenu
            actions={controller.view.actions.filter(
              (action) =>
                action.id !== primaryAction?.id &&
                action.id !== secondaryAction?.id &&
                action.id !== 'OPEN'
            )}
            resetResources={controller.resettableResources}
            isActionDisabled={(action) => isActionDisabled(controller, action.id)}
            resetDisabled={controller.busy.size > 0 || Boolean(controller.resetBusy)}
            onAction={controller.requestAction}
            onReset={controller.requestReset}
          />
        </div>
      </header>

      {plan && approvalRequired ? (
        <PreviewPlanAuthority plan={plan} approval={controller.view.approval} />
      ) : null}

      {plan && configurationRequired ? (
        <PreviewConfigurationRequired
          taskId={props.task.id}
          plan={plan}
          approval={controller.view.approval}
          readiness={props.executionReadiness!}
          localBindings={props.localBindings}
          requestedInputId={requestedInputId}
          onInputRequestHandled={() => setRequestedInputId(undefined)}
          onChanged={() => props.onResolve(
            props.task.id,
            plan.executionPlan.selectedScenarioId
          )}
        />
      ) : plan && !approvalRequired ? <div className="tm-preview-workspace__columns">
        <div className="tm-preview-workspace__column">
          {showOperationalEvidence ? (
            <PreviewApplicationSection
              plan={plan}
              view={controller.view}
              attempts={props.attempts}
              composeProjects={props.composeProjects}
              onOpenLog={logs.openAttempt}
            />
          ) : null}
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
          <PreviewPlanAuthority plan={plan} approval={controller.view.approval} />
        </div>

        <div className="tm-preview-workspace__column tm-preview-workspace__column--side">
          {showOperationalEvidence ? (
            <PreviewRoutesSection
              view={controller.view}
              onOpen={(generation, route) =>
                props.onOpen(props.task.id, generation.id, route.id)
              }
            />
          ) : null}
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
            <PreviewPrivateInputsSection
              taskId={props.task.id}
              plan={plan}
              readiness={props.executionReadiness}
              onChanged={() => props.onResolve(
                props.task.id,
                plan.executionPlan.selectedScenarioId
              )}
            />
          ) : null}
          {controller.view.generation && !approvalRequired ? (
            <PreviewTechnicalDetails
              view={controller.view}
              generations={props.generations}
              runtimeResources={props.runtimeResources}
            />
          ) : null}
        </div>
      </div> : null}

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

function PreviewMissingRecipeSetup(props: PreviewPanelProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [localGeneration, setLocalGeneration] = useState(props.recipeGeneration);
  const returnFocusRef = useRef<HTMLElement | undefined>(undefined);

  useEffect(() => {
    if (props.recipeGeneration) setLocalGeneration(props.recipeGeneration);
  }, [props.recipeGeneration]);

  const generate = async () => {
    setLocalGeneration((current) => ({
      taskId: props.task.id,
      status: 'GENERATING',
      stage: 'PREPARING_EVIDENCE',
      draft: current?.draft,
      startedAt: new Date().toISOString()
    }));
    try {
      setLocalGeneration(await props.onGenerateRecipe(props.task.id));
    } catch {
      setLocalGeneration((current) => ({
        taskId: props.task.id,
        status: 'FAILED',
        draft: current?.draft,
        failureCode: 'AGENT_UNAVAILABLE',
        message: 'The Preview recipe agent could not produce a draft.'
      }));
    }
  };

  const openGenerator = async (returnFocus: HTMLElement) => {
    returnFocusRef.current = returnFocus;
    setModalOpen(true);
    try {
      const current = await props.onGetRecipeGeneration(props.task.id);
      setLocalGeneration(current);
      if (current.status === 'EMPTY') await generate();
    } catch {
      setLocalGeneration({
        taskId: props.task.id,
        status: 'FAILED',
        failureCode: 'AGENT_UNAVAILABLE',
        message: 'The Preview recipe agent could not be opened.'
      });
    }
  };

  const discard = async () => {
    setLocalGeneration(await props.onDiscardRecipeDraft(props.task.id));
    setModalOpen(false);
  };

  return (
    <section className="tm-preview-workspace" aria-label="Preview">
      <header className="tm-preview-workspace__head tm-preview-setup__head">
        <div className="tm-preview-workspace__decision">
          <div className="tm-preview-statusline tm-preview-statusline--action">
            <span aria-hidden="true" />
            <strong>Preview setup</strong>
            <small>Recipe required</small>
          </div>
          <p>
            This worktree does not contain <code>.taskmonki/preview.yaml</code>. Generate a
            reviewable draft or create the recipe yourself.
          </p>
        </div>
        <div className="tm-preview-workspace__actions">
          <button
            type="button"
            className="primary-button"
            onClick={(event) => void openGenerator(event.currentTarget)}
          >
            Generate with agent
          </button>
          <button
            type="button"
            className="outline-button"
            onClick={() => props.worktree && void props.onWriteRecipeManually(
              props.task.id,
              props.worktree.id
            )}
          >
            Write manually
          </button>
        </div>
      </header>

      <div className="tm-preview-setup">
        <div className="tm-preview-setup__path" aria-label="Preview recipe path">
          <span>Repository recipe</span>
          <code>.taskmonki/preview.yaml</code>
        </div>
        <div className="tm-preview-setup__rules">
          <p>
            The agent inspects a bounded read-only evidence bundle and cannot write the
            repository. You review the complete YAML before accepting it.
          </p>
          <p>
            Acceptance creates only the Preview recipe, then checks it through the normal
            parser. Approval and Start remain separate actions.
          </p>
        </div>
      </div>

      {modalOpen ? (
        <PreviewRecipeGenerationModal
          taskId={props.task.id}
          state={localGeneration ?? { taskId: props.task.id, status: 'EMPTY' }}
          returnFocus={returnFocusRef.current}
          onClose={() => setModalOpen(false)}
          onRegenerate={generate}
          onValidate={props.onValidateRecipeDraft}
          onAccept={props.onAcceptRecipeDraft}
          onDiscard={discard}
        />
      ) : null}
    </section>
  );
}

export function PreviewRecipeGenerationModal({
  taskId,
  state,
  returnFocus,
  onClose,
  onRegenerate,
  onValidate,
  onAccept,
  onDiscard
}: {
  taskId: string;
  state: PreviewRecipeGenerationSnapshot;
  returnFocus?: HTMLElement;
  onClose(): void;
  onRegenerate(): Promise<void>;
  onValidate(taskId: string, draftId: string, yaml: string): Promise<PreviewRecipeValidation>;
  onAccept(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<import('../../shared/contracts').AcceptPreviewRecipeDraftResult>;
  onDiscard(): Promise<void>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [yaml, setYaml] = useState(state.draft?.yaml ?? '');
  const [loadedDraftId, setLoadedDraftId] = useState(state.draft?.id);
  const [edited, setEdited] = useState(false);
  const [validation, setValidation] = useState<PreviewRecipeValidation>();
  const [accepting, setAccepting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [regenerateArmed, setRegenerateArmed] = useState(false);
  const busy = accepting || discarding;
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  busyRef.current = busy;
  closeRef.current = onClose;
  const generating = state.status === 'GENERATING';
  const report = state.report ?? state.draft?.report;

  useEffect(() => {
    if (state.draft && state.draft.id !== loadedDraftId) {
      setYaml(state.draft.yaml);
      setLoadedDraftId(state.draft.id);
      setEdited(false);
      setValidation(state.draft.validation);
      setRegenerateArmed(false);
    }
  }, [loadedDraftId, state.draft]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ) ?? [])];
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
      returnFocus?.focus();
    };
  }, [returnFocus]);

  const validateAndAccept = async () => {
    const draft = state.draft;
    if (!draft || accepting || generating) return;
    setAccepting(true);
    try {
      const nextValidation = await onValidate(taskId, draft.id, yaml);
      setValidation(nextValidation);
      if (nextValidation.status !== 'VALID') return;
      await onAccept(taskId, draft.id, yaml);
      onClose();
    } finally {
      setAccepting(false);
    }
  };

  const regenerate = async () => {
    if (generating) return;
    if (edited && !regenerateArmed) {
      setRegenerateArmed(true);
      return;
    }
    setValidation(undefined);
    setRegenerateArmed(false);
    await onRegenerate();
  };

  const discard = async () => {
    setDiscarding(true);
    try {
      await onDiscard();
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div
      className="tm-modal tm-preview-recipe-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-recipe-generation-title"
    >
      <div className="tm-modal__scrim" onClick={busy ? undefined : onClose} />
      <div
        ref={panelRef}
        className="tm-modal__panel tm-preview-recipe-review"
        tabIndex={-1}
      >
        <header className="tm-preview-recipe-review__head">
          <div>
            <span className="tm-preview-recipe-review__eyebrow">Agent draft</span>
            <h3 id="preview-recipe-generation-title">Review Preview configuration</h3>
            <p>
              Nothing is written until you accept. Approval and Start remain separate.
            </p>
          </div>
          <button
            type="button"
            className="tm-preview-recipe-review__close"
            disabled={busy}
            aria-label="Close Preview recipe review"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {generating ? (
          <div className="tm-preview-recipe-progress" role="status" aria-live="polite">
            <span className="tm-preview-recipe-progress__dot" aria-hidden="true" />
            <div>
              <strong>{generationStageLabel(state.stage)}</strong>
              <p>{generationStageDetail(state.stage)}</p>
            </div>
          </div>
        ) : null}

        {state.status === 'FAILED' || state.status === 'NEEDS_INPUT' ? (
          <div className="tm-preview-recipe-message" role="status">
            <strong>{state.status === 'NEEDS_INPUT' ? 'More evidence is needed' : 'Draft not generated'}</strong>
            <p>{state.message}</p>
          </div>
        ) : null}

        {state.draft ? (
          <div className="tm-preview-recipe-review__body">
            <section className="tm-preview-recipe-editor" aria-label="Generated Preview YAML">
              <div className="tm-preview-recipe-editor__head">
                <div>
                  <strong>Complete YAML</strong>
                  <span>{edited ? 'Edited' : 'Generated'} · {yaml.split('\n').length} lines</span>
                </div>
                <code>.taskmonki/preview.yaml</code>
              </div>
              <textarea
                aria-label="Preview recipe YAML"
                value={yaml}
                disabled={generating || busy}
                spellCheck={false}
                onChange={(event) => {
                  setYaml(event.target.value);
                  setEdited(event.target.value !== state.draft?.yaml);
                  setValidation(undefined);
                  setRegenerateArmed(false);
                }}
              />
              {validation?.status === 'INVALID' ? (
                <div className="tm-preview-recipe-validation" role="alert">
                  {validation.issues.map((issue) => (
                    <p key={issue.code}>{issue.message}</p>
                  ))}
                </div>
              ) : null}
            </section>
            {report ? (
              <PreviewRecipeGenerationReportView report={report} originalDraftOnly={edited} />
            ) : null}
          </div>
        ) : report ? (
          <PreviewRecipeGenerationReportView report={report} />
        ) : null}

        <footer className="tm-preview-recipe-review__footer">
          <div className="tm-preview-recipe-review__secondary">
            <button type="button" className="outline-button" disabled={busy} onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="tm-preview-recipe-review__discard"
              disabled={busy}
              onClick={() => void discard()}
            >
              {discarding ? 'Discarding…' : 'Discard'}
            </button>
          </div>
          <div className="tm-preview-recipe-review__primary">
            {regenerateArmed ? <span>Your edits will be replaced.</span> : null}
            <button
              type="button"
              className="outline-button"
              disabled={busy || generating}
              onClick={() => void regenerate()}
            >
              {regenerateArmed ? 'Replace draft' : 'Regenerate'}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!state.draft || busy || generating}
              onClick={() => void validateAndAccept()}
            >
              {accepting ? 'Checking…' : 'Accept & save recipe'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function PreviewRecipeGenerationReportView({
  report,
  originalDraftOnly = false
}: {
  report: import('../../shared/contracts').PreviewRecipeGenerationReport;
  originalDraftOnly?: boolean;
}) {
  const sections = [
    ['Evidence', report.evidence.map((item) => `${item.path} — ${item.finding}`)],
    ['Assumptions', report.assumptions],
    ['Omissions', report.omissions],
    ['Unresolved', report.unresolvedDecisions]
  ] as const;
  return (
    <aside className="tm-preview-recipe-report" aria-label="Generation report">
      <div>
        <span>{originalDraftOnly ? 'Generation report · original draft' : 'Generation report'}</span>
        <strong>{report.summary}</strong>
      </div>
      {sections.map(([label, items]) => items.length ? (
        <section key={label}>
          <h4>{label}</h4>
          <ul>
            {items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}
          </ul>
        </section>
      ) : null)}
    </aside>
  );
}

function generationStageLabel(stage?: PreviewRecipeGenerationSnapshot['stage']): string {
  if (stage === 'GENERATING_DRAFT') return 'Agent is drafting the recipe';
  if (stage === 'VALIDATING_DRAFT') return 'Validating against Preview';
  return 'Preparing safe repository evidence';
}

function generationStageDetail(stage?: PreviewRecipeGenerationSnapshot['stage']): string {
  if (stage === 'GENERATING_DRAFT') {
    return 'Reading only the bounded evidence bundle and mapping proven commands, ports, and readiness.';
  }
  if (stage === 'VALIDATING_DRAFT') {
    return 'The existing Preview parser is checking the complete generated YAML.';
  }
  return 'Likely secret-bearing, binary, generated, and oversized files are excluded before inspection.';
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
    const managedResourceIds = view.plan?.executionPlan.resources.map((resource) => resource.id) ?? [];
    const hasManagedData = managedResourceIds.length > 0;
    const managedResourceSummary = managedResourceIds.join(', ');
    const body = destructive
      ? adapter === 'COMPOSE'
        ? 'Stops the stable Compose preview and permanently deletes every active or retained Task Monki-owned volume. External resources, images, and build cache are not changed.'
        : hasManagedData
          ? `Stops this preview and permanently deletes Task Monki-managed data for ${managedResourceSummary}. Attached dependencies are never changed.`
          : 'Stops this preview and permanently removes its Task Monki-owned runtime. This plan has no managed database or cache data.'
      : action.label === 'Cancel replacement'
        ? 'Stops and verifies only the candidate generation. The current active preview stays available and its managed data is preserved.'
        : 'Cancels startup and runs the recorded exact cleanup path. Preview-owned runtime and managed data covered by this generation may be deleted.';
    setConfirmation(() => ({
      title: destructive ? 'Stop preview & delete data?' : action.label,
      body,
      confirmLabel: destructive ? 'Stop & delete' : action.label,
      danger: destructive || action.label !== 'Cancel replacement',
      impacts: destructive ? [
        {
          tone: 'deleted',
          label: 'Deleted',
          detail: adapter === 'COMPOSE'
            ? 'Task-scoped project containers, owned networks, owned volumes, and their data'
            : hasManagedData
              ? `Preview runtime plus managed data for ${managedResourceSummary}`
              : 'Preview processes, routes, ports, and captured workspace'
        },
        {
          tone: 'kept',
          label: 'Kept',
          detail: 'Worktree, branch, approved plan, public bindings, and retained evidence'
        },
        {
          tone: 'untouched',
          label: 'Never touched',
          detail: 'Attached dependencies and resources owned outside this preview'
        }
      ] : undefined,
      requireText: destructive ? 'delete' : undefined,
      returnFocus,
      run: () => runAction('STOP')
    }));
  };

  const requestReset = (resourceId: string, returnFocus?: HTMLElement) => {
    setConfirmation(() => ({
      title: `Reset ${resourceId}?`,
      body: `Stops the complete preview, permanently deletes only ${resourceId}'s Task Monki-managed data, and cannot restore it if recreation or setup fails. Attached dependencies are never changed.`,
      confirmLabel: `Reset ${resourceId}`,
      danger: true,
      impacts: [
        { tone: 'deleted', label: 'Deleted', detail: `${resourceId} managed data` },
        { tone: 'kept', label: 'Kept', detail: 'Other managed data, worktree, stable route identities, and approval' },
        { tone: 'untouched', label: 'Never touched', detail: 'Attached dependencies' }
      ],
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
    openAttempt: (attemptId: string) => {
      setSelectedAttemptId(attemptId);
      setSelectedStream('stdout');
      setValue('');
    },
    close: () => setValue(undefined)
  };
}

function PreviewPlanAuthority({
  plan,
  approval
}: {
  plan: PreviewPlanRecord;
  approval?: PreviewApprovalRecord;
}) {
  const groups = buildPreviewPlanGroups(plan);
  const topology = buildPlanTopology(plan);
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
      <section className="tm-preview-approved-plan" aria-label="Approved plan">
        <details className="tm-preview-disclosure">
          <summary>Approved plan details</summary>
          {exactDetails}
          <PlanWarnings warnings={warnings} />
        </details>
      </section>
    );
  }

  return (
    <div className="tm-preview-approval" aria-labelledby="preview-plan-authority">
      <section className="tm-preview-surface tm-preview-plan-topology">
        <h3 id="preview-plan-authority" className="tm-preview-surface__title">Execution plan</h3>
        {topology.map((group) => (
          <div key={group.id} className="tm-preview-topology-group">
            <div className="tm-preview-topology-group__head">
              <span>{group.label}</span>
              {group.summary ? <small>{group.summary}</small> : null}
            </div>
            <div className="tm-preview-topology-group__rows">
              {group.rows.map((row) => <PlanTopologyRow key={`${group.id}-${row.id}`} {...row} />)}
            </div>
          </div>
        ))}
        <details className="tm-preview-disclosure tm-preview-plan-topology__exact">
          <summary>Exact commands, recipients, readiness, and cleanup</summary>
          {exactDetails}
        </details>
      </section>
      <aside className="tm-preview-approval__side" aria-label="Plan authority and advisories">
        <PlanAuthorityCard plan={plan} />
        {warnings.length > 0 ? <PlanAdvisories warnings={warnings} /> : null}
        <PlanCleanupCard plan={plan} />
      </aside>
    </div>
  );
}

interface PlanTopologyRowModel {
  id: string;
  title: string;
  value: string;
  meta?: string;
}

interface PlanTopologyGroupModel {
  id: string;
  label: string;
  summary?: string;
  rows: PlanTopologyRowModel[];
}

function buildPlanTopology(plan: PreviewPlanRecord): PlanTopologyGroupModel[] {
  const execution = plan.executionPlan;
  const result: PlanTopologyGroupModel[] = [];
  if (execution.adapter === 'COMPOSE') {
    const services = execution.compose?.inspection?.services ?? [];
    if (services.length > 0) {
      result.push({
        id: 'application',
        label: 'Compose services',
        summary: `${services.length} ${services.length === 1 ? 'service' : 'services'}`,
        rows: services.map((service) => ({
          id: service.id,
          title: service.id,
          value: service.image ?? 'Local build',
          meta: service.dependsOn.length > 0 ? `${service.dependsOn.length} dependencies` : 'root service'
        }))
      });
    }
  } else {
    const application = [
      ...execution.services.map((node) => ({
        id: `service-${node.id}`,
        title: node.label ?? node.id,
        value: formatPlanCommand(node.command),
        meta: execution.routes.some((route) => route.service === node.id) ? 'service · routed' : 'service'
      })),
      ...execution.workers.map((node) => ({
        id: `worker-${node.id}`,
        title: node.label ?? node.id,
        value: formatPlanCommand(node.command),
        meta: node.overlap === 'exclusive' ? 'worker · exclusive' : 'worker · overlap safe'
      }))
    ];
    if (application.length > 0) {
      result.push({
        id: 'application',
        label: 'Application',
        summary: [
          execution.services.length > 0 ? `${execution.services.length} ${execution.services.length === 1 ? 'service' : 'services'}` : undefined,
          execution.workers.length > 0 ? `${execution.workers.length} ${execution.workers.length === 1 ? 'worker' : 'workers'}` : undefined
        ].filter(Boolean).join(' · '),
        rows: application
      });
    }
    const scenario = execution.scenarios.find((candidate) => candidate.id === execution.selectedScenarioId);
    const activeJobs = execution.jobs.filter(
      (job) => job.role === 'generic' || scenario?.jobs.includes(job.id)
    );
    if (activeJobs.length > 0) {
      result.push({
        id: 'setup',
        label: 'Setup jobs',
        summary: 'First start only',
        rows: activeJobs.map((job) => ({
          id: job.id,
          title: job.label ?? job.id,
          value: formatPlanCommand(job.command),
          meta: `${humanize(job.role)} · ${job.retrySafe ? 'retry-safe' : 'not retry-safe'}`
        }))
      });
    }
  }
  if (execution.routes.length > 0) {
    result.push({
      id: 'routes',
      label: 'Routes',
      summary: 'Stable across replacements',
      rows: execution.routes.map((route) => ({
        id: route.id,
        title: route.id,
        value: `→ ${route.service}.${route.port}`,
        meta: route.primary ? 'primary' : undefined
      }))
    });
  }
  if (execution.adapter === 'COMPOSE') {
    const volumes = execution.compose?.inspection?.volumes.filter((volume) => !volume.external) ?? [];
    if (volumes.length > 0) {
      result.push({
        id: 'data',
        label: 'Managed data',
        summary: 'Project-owned · persistent',
        rows: volumes.map((volume) => ({
          id: volume.name,
          title: volume.name,
          value: 'Compose volume',
          meta: 'owned by this preview'
        }))
      });
    }
  } else {
    const scenario = execution.scenarios.find((candidate) => candidate.id === execution.selectedScenarioId);
    const resources = execution.resources.filter((resource) => scenario?.resources.includes(resource.id));
    if (resources.length > 0) {
      result.push({
        id: 'data',
        label: 'Managed data',
        summary: 'Preview-owned · persistent',
        rows: resources.map((resource) => ({
          id: resource.id,
          title: resource.id,
          value: `${resource.type === 'postgres' ? 'PostgreSQL' : 'Redis'} · ${resource.image}`,
          meta: 'generated credentials'
        }))
      });
    }
  }
  if (execution.inputs?.length) {
    result.push({
      id: 'inputs',
      label: 'Private inputs',
      summary: 'Values excluded from approval',
      rows: execution.inputs.map((input) => ({
        id: input.id,
        title: input.label ?? input.id,
        value: input.id,
        meta: 'encrypted · recipient-scoped'
      }))
    });
  }
  if (execution.attachments?.length) {
    result.push({
      id: 'attachments',
      label: 'Attached dependencies',
      summary: 'External · never managed',
      rows: execution.attachments.map((attachment) => ({
        id: attachment.id,
        title: attachment.label ?? attachment.id,
        value: formatAttachmentTarget(attachment),
        meta: `${attachment.type.toUpperCase()} · non-owned`
      }))
    });
  }
  return result;
}

function PlanTopologyRow({ title, value, meta }: PlanTopologyRowModel) {
  return (
    <div className="tm-preview-topology-row">
      <span aria-hidden="true">›</span>
      <code>{title}</code>
      <code>{value}</code>
      {meta ? <small>{meta}</small> : <span />}
    </div>
  );
}

function PlanAuthorityCard({ plan }: { plan: PreviewPlanRecord }) {
  const identity = plan.ociCapability?.identity;
  const rows = plan.executionPlan.adapter === 'COMPOSE'
    ? [
        { label: 'Engine', value: identity ? `${identity.contextName} · ${identity.operatingSystem}/${identity.architecture}` : 'Selected local OCI engine' },
        { label: 'Configuration', value: plan.executionPlan.compose?.files.join(', ') ?? 'compose.yaml' },
        { label: 'Project', value: 'One task-scoped serialized project' },
        { label: 'Environment', value: 'Repository Compose configuration · approved as inspected' }
      ]
    : [
        { label: 'Engine', value: identity ? `${identity.contextName} · ${identity.operatingSystem}/${identity.architecture}` : 'Native host' },
        { label: 'Runs as', value: 'Your local user · not sandboxed' },
        { label: 'Network', value: 'Unrestricted for launched processes' },
        { label: 'Environment', value: 'Repository literals + generated and private bindings' }
      ];
  return (
    <section className="tm-preview-surface tm-preview-authority-card">
      <h3 className="tm-preview-surface__title">Authority</h3>
      <div className="tm-preview-authority-card__rows">
        {rows.map((row) => <AuthorityRow key={row.label} {...row} />)}
      </div>
    </section>
  );
}

function PlanAdvisories({ warnings }: { warnings: string[] }) {
  return (
    <section className="tm-preview-surface tm-preview-advisories">
      <h3 className="tm-preview-surface__title">Advisories</h3>
      <div className="tm-preview-advisories__list">
        {warnings.map((warning) => (
          <p key={warning}><span aria-hidden="true" />{warning}</p>
        ))}
      </div>
    </section>
  );
}

function PlanCleanupCard({ plan }: { plan: PreviewPlanRecord }) {
  const managedResourceIds = plan.executionPlan.resources.map((resource) => resource.id);
  const rows = [
    {
      label: 'Stop preview',
      value: plan.executionPlan.adapter === 'COMPOSE'
        ? 'Deletes the exact task-scoped project and its owned volumes'
        : managedResourceIds.length > 0
          ? `Deletes exact preview runtime and managed data for ${managedResourceIds.join(', ')}`
          : 'Deletes exact preview runtime; this plan has no managed data'
    },
    ...(plan.executionPlan.resources.length > 0
      ? [{ label: 'Reset', value: 'Deletes one selected managed resource and preserves the rest' }]
      : []),
    {
      label: 'Replace',
      value: plan.executionPlan.adapter === 'COMPOSE'
        ? 'Serializes project activation after build and inspection'
        : managedResourceIds.length > 0
          ? `Keeps managed data for ${managedResourceIds.join(', ')} and cuts routes over only after readiness`
          : 'Cuts routes over only after readiness; no managed data is involved'
    },
    { label: 'Attached', value: 'Never stopped, reset, deleted, or otherwise managed' }
  ];
  return (
    <section className="tm-preview-surface tm-preview-authority-card">
      <h3 className="tm-preview-surface__title">Cleanup contract</h3>
      <div className="tm-preview-authority-card__rows">
        {rows.map((row) => <AuthorityRow key={row.label} {...row} />)}
      </div>
    </section>
  );
}

function AuthorityRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><p>{value}</p></div>;
}

function formatPlanCommand(argv: string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(' ');
}

function PreviewApplicationSection({
  plan,
  view,
  attempts,
  composeProjects,
  onOpenLog
}: {
  plan: PreviewPlanRecord;
  view: PreviewViewModel;
  attempts: PreviewNodeAttemptRecord[];
  composeProjects: PreviewComposeProjectRecord[];
  onOpenLog(attemptId: string): void;
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
    ...plan.executionPlan.services.map((node) => ({ ...node, kind: 'Service', group: 'application' as const })),
    ...plan.executionPlan.workers.map((node) => ({ ...node, kind: 'Worker', group: 'application' as const })),
    ...plan.executionPlan.jobs.map((node) => ({ ...node, kind: 'Job', group: 'setup' as const }))
  ];
  const composeServices = plan.executionPlan.compose?.inspection?.services ?? [];
  const composeProject = [...composeProjects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const includeQueuedNodes = view.status === 'Starting' || view.status === 'Replacing';
  const visibleNativeNodes = nativeNodes.flatMap((node) => {
    const attempt = latestByNode.get(node.id);
    return attempt || includeQueuedNodes ? [{ node, attempt }] : [];
  });
  const observedComposeServices = composeProject && composeProject.state !== 'STOPPED'
    ? composeServices
    : [];
  const activeAttempts = view.activeGeneration && view.activeGeneration.id !== diagnosticGeneration?.id
    ? latestAttemptsByNode(attempts.filter((attempt) => attempt.generationId === view.activeGeneration?.id))
    : [];
  const applicationNodes = visibleNativeNodes.filter(({ node }) => node.group === 'application');
  const setupNodes = visibleNativeNodes.filter(({ node }) => node.group === 'setup');

  if (visibleNativeNodes.length === 0 && observedComposeServices.length === 0 && activeAttempts.length === 0) {
    return null;
  }

  return (
    <div className="tm-preview-application-stack">
      <section className="tm-preview-surface" aria-labelledby="preview-application">
        {plan.executionPlan.adapter === 'COMPOSE' ? (
          <PreviewOperationalGroup
            id="preview-application"
            title="Compose services"
            summary={`${observedComposeServices.length} ${observedComposeServices.length === 1 ? 'service' : 'services'} · task-scoped project`}
          >
            {observedComposeServices.map((service) => (
              <OperationalRow
                key={service.id}
                title={service.id}
                kind={service.image ? `Compose service · ${service.image}` : 'Compose service · local build'}
                state={composeProject?.state ?? 'STARTING'}
              />
            ))}
          </PreviewOperationalGroup>
        ) : (
          <>
            {applicationNodes.length > 0 ? (
              <PreviewOperationalGroup
                id="preview-application"
                title={view.activeGeneration && diagnosticGeneration?.id !== view.activeGeneration.id
                  ? `Candidate · ${shortId(diagnosticGeneration?.id ?? '')}`
                  : 'Application'}
                summary={view.activeGeneration && diagnosticGeneration?.id !== view.activeGeneration.id
                  ? 'Routes stay on the active generation until readiness'
                  : `${applicationNodes.length} ${applicationNodes.length === 1 ? 'node' : 'nodes'}`}
              >
                {applicationNodes.map(({ node, attempt }) => (
                  <OperationalRow
                    key={`${node.kind}-${node.id}`}
                    title={node.label ?? node.id}
                    kind={attempt ? node.kind : `${node.kind} · waiting for dependencies`}
                    state={attempt?.state ?? 'QUEUED'}
                    onLogs={attempt ? () => onOpenLog(attempt.id) : undefined}
                  />
                ))}
              </PreviewOperationalGroup>
            ) : null}
            {setupNodes.length > 0 ? (
              <PreviewOperationalGroup
                id="preview-setup-jobs"
                title="Setup jobs"
                summary="First start only · replacements do not rerun completed setup"
              >
                {setupNodes.map(({ node, attempt }) => (
                  <OperationalRow
                    key={`${node.kind}-${node.id}`}
                    title={node.label ?? node.id}
                    kind={attempt ? node.kind : `${node.kind} · waiting for dependencies`}
                    state={attempt?.state ?? 'QUEUED'}
                    onLogs={attempt ? () => onOpenLog(attempt.id) : undefined}
                  />
                ))}
              </PreviewOperationalGroup>
            ) : null}
          </>
        )}
      </section>
      {view.activeGeneration && diagnosticGeneration?.id !== view.activeGeneration.id ? (
        <section className="tm-preview-surface tm-preview-active-generation" aria-label="Active generation">
          <PreviewOperationalGroup
            id="preview-active-generation"
            title={`Active · ${shortId(view.activeGeneration.id)}`}
            summary="Keeps serving until the candidate is ready"
          >
            {activeAttempts.length > 0 ? activeAttempts.map((attempt) => (
              <OperationalRow
                key={attempt.id}
                title={attempt.nodeId}
                kind={humanize(attempt.kind)}
                state={attempt.state}
                onLogs={() => onOpenLog(attempt.id)}
              />
            )) : (
              <OperationalRow
                title="Current application"
                kind="Routes remain attached"
                state="READY"
              />
            )}
          </PreviewOperationalGroup>
        </section>
      ) : null}
    </div>
  );
}

function PreviewOperationalGroup({
  id,
  title,
  summary,
  children
}: {
  id: string;
  title: string;
  summary?: string;
  children: ReactNode;
}) {
  return (
    <div className="tm-preview-operational-group">
      <div className="tm-preview-operational-group__head">
        <h3 id={id}>{title}</h3>
        {summary ? <span>{summary}</span> : null}
      </div>
      <div className="tm-preview-rows">{children}</div>
    </div>
  );
}

function latestAttemptsByNode(attempts: PreviewNodeAttemptRecord[]): PreviewNodeAttemptRecord[] {
  const byNode = new Map<string, PreviewNodeAttemptRecord>();
  for (const attempt of [...attempts].sort((a, b) => b.attempt - a.attempt)) {
    if (!byNode.has(attempt.nodeId)) byNode.set(attempt.nodeId, attempt);
  }
  return [...byNode.values()];
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
    <section className="tm-preview-surface" aria-labelledby="preview-routes">
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
            <button
              type="button"
              className="tm-preview-icon-button"
              aria-label={`Open ${route.id} route`}
              title={`Open ${route.hostname}`}
              onClick={() => void onOpen(generation, route)}
            >
              <OpenIcon />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function PreviewTechnicalDetails({
  view,
  generations,
  runtimeResources
}: {
  view: PreviewViewModel;
  generations: PreviewGenerationRecord[];
  runtimeResources: PreviewResourceRecord[];
}) {
  const current = view.replacementGeneration ?? view.failedReplacementGeneration ?? view.generation;
  const history = [...generations]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);
  const currentRuntime = runtimeResources
    .filter((resource) => resource.generationId === current?.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!current) return null;
  return (
    <details className="tm-preview-surface tm-preview-disclosure tm-preview-technical-details">
      <summary>Technical details</summary>
      <div className="tm-preview-technical-details__body">
        <p>Captured {formatDate(current.createdAt)}.</p>
        <dl className="tm-preview-keyvalues">
          <div><dt>Generation</dt><dd><code>{shortId(current.id)}</code></dd></div>
          <div><dt>State</dt><dd>{humanize(current.state)}</dd></div>
          <div><dt>Source</dt><dd><code>{shortId(current.sourceHeadSha)}</code></dd></div>
          <div><dt>Routing</dt><dd>{humanize(current.routingState)}</dd></div>
        </dl>
        {currentRuntime.length > 0 ? (
          <details className="tm-preview-disclosure">
            <summary>Runtime ownership · {currentRuntime.length}</summary>
            <div className="tm-preview-rows">
              {currentRuntime.map((resource) => (
                <OperationalRow
                  key={resource.id}
                  title={resource.logicalNodeId}
                  kind="Verified native process group"
                  state={resource.state}
                />
              ))}
            </div>
          </details>
        ) : null}
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
    <section className="tm-preview-surface" aria-labelledby="preview-data">
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
  readiness,
  startupPending = false
}: {
  plan: PreviewPlanRecord;
  localBindings: PreviewLocalAttachmentBindingRecord[];
  readiness: NonNullable<PreviewGenerationRecord['attachmentReadiness']>;
  startupPending?: boolean;
}) {
  const attachments = plan.executionPlan.attachments ?? [];
  if (attachments.length === 0) return null;
  const readinessById = new Map(readiness.map((evidence) => [evidence.attachmentId, evidence]));
  return (
    <section className="tm-preview-surface" aria-labelledby="preview-bindings">
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
                : attachment.check
                  ? startupPending ? 'Checks once at startup' : 'Not checked this generation'
                  : 'No check declared'}
            />
          );
        })}
      </div>
    </section>
  );
}

function PreviewConfigurationRequired({
  taskId,
  plan,
  approval,
  readiness,
  localBindings,
  requestedInputId,
  onInputRequestHandled,
  onChanged
}: {
  taskId: string;
  plan: PreviewPlanRecord;
  approval?: PreviewApprovalRecord;
  readiness: PreviewExecutionReadiness;
  localBindings: PreviewLocalAttachmentBindingRecord[];
  requestedInputId?: string;
  onInputRequestHandled(): void;
  onChanged(): Promise<void>;
}) {
  return (
    <div className="tm-preview-workspace__columns tm-preview-configuration">
      <div className="tm-preview-workspace__column">
        <PreviewPrivateInputsSection
          taskId={taskId}
          plan={plan}
          readiness={readiness}
          wide
          requestedInputId={requestedInputId}
          onInputRequestHandled={onInputRequestHandled}
          onChanged={onChanged}
        />
        <PreviewBindingsSection
          plan={plan}
          localBindings={localBindings}
          readiness={[]}
          startupPending
        />
        <PreviewPlanAuthority plan={plan} approval={approval} />
      </div>
      <aside className="tm-preview-workspace__column tm-preview-workspace__column--side">
        <PreviewStartBlockers blockers={readiness.blockers} />
        <PreviewOwnershipCard plan={plan} />
      </aside>
    </div>
  );
}

function PreviewPrivateInputsSection({
  taskId,
  plan,
  readiness,
  wide = false,
  requestedInputId,
  onInputRequestHandled,
  onChanged
}: {
  taskId: string;
  plan: PreviewPlanRecord;
  readiness?: PreviewExecutionReadiness;
  wide?: boolean;
  requestedInputId?: string;
  onInputRequestHandled?(): void;
  onChanged(): Promise<void>;
}) {
  const inputs = plan.executionPlan.inputs ?? [];
  const blockers = new Map(
    (readiness?.blockers ?? []).map((blocker) => [blocker.inputId, blocker])
  );
  if (inputs.length === 0) return null;
  return (
    <section
      className={`tm-preview-surface tm-preview-private-inputs${wide ? ' tm-preview-private-inputs--wide' : ''}`}
      aria-labelledby="preview-private-inputs"
    >
      <SectionHeading
        id="preview-private-inputs"
        title={wide ? 'Inputs' : 'Private inputs'}
        detail="Values stay encrypted on this Mac and are never shown after entry."
      />
      <div className="tm-preview-inputs">
        {inputs.map((input) => (
          <PrivateInputControl
            key={input.id}
            taskId={taskId}
            inputId={input.id}
            label={input.label ?? input.id}
            blocker={blockers.get(input.id)}
            recipients={privateInputRecipients(plan, input.id)}
            wide={wide}
            openRequested={requestedInputId === input.id}
            onOpenHandled={onInputRequestHandled}
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
  );
}

function PreviewStartBlockers({ blockers }: { blockers: PreviewExecutionBlocker[] }) {
  return (
    <section className="tm-preview-surface tm-preview-blockers">
      <h3 className="tm-preview-surface__title">Blocking start</h3>
      <div className="tm-preview-advisories__list">
        {blockers.map((blocker) => (
          <p key={`${blocker.kind}-${blocker.inputId}`}>
            <span aria-hidden="true" />
            <span><code>{blocker.inputId}</code> {executionBlockerDescription(blocker)} — required</span>
          </p>
        ))}
      </div>
    </section>
  );
}

function PreviewOwnershipCard({ plan }: { plan: PreviewPlanRecord }) {
  const attachments = plan.executionPlan.attachments ?? [];
  const managed = plan.executionPlan.adapter === 'COMPOSE'
    ? plan.executionPlan.compose?.inspection?.volumes.filter((volume) => !volume.external).map((volume) => volume.name) ?? []
    : plan.executionPlan.resources.map((resource) => resource.id);
  const crossTask = attachments.filter(
    (attachment) => attachment.target.type === 'task-preview-route'
  ).map((attachment) => attachment.id);
  const rows = [
    {
      label: 'Managed',
      value: managed.length > 0
        ? `${managed.join(', ')} — created, reset, and deleted only by this preview`
        : 'None in this plan'
    },
    {
      label: 'Attached',
      value: attachments.length > 0
        ? `${attachments.map((attachment) => attachment.id).join(', ')} — checked or used, never managed`
        : 'None in this plan'
    },
    ...(crossTask.length > 0 ? [{
      label: 'Cross-task',
      value: `${crossTask.join(', ')} — remains owned by its producer task`
    }] : [])
  ];
  return (
    <section className="tm-preview-surface tm-preview-authority-card">
      <h3 className="tm-preview-surface__title">Ownership</h3>
      <div className="tm-preview-authority-card__rows">
        {rows.map((row) => <AuthorityRow key={row.label} {...row} />)}
      </div>
    </section>
  );
}

function PrivateInputControl(props: {
  taskId: string;
  inputId: string;
  label: string;
  blocker?: PreviewExecutionBlocker;
  recipients: string[];
  wide?: boolean;
  openRequested?: boolean;
  onOpenHandled?(): void;
  onChanged(): Promise<void>;
}) {
  const valueRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
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
  useEffect(() => {
    if (!props.openRequested) return;
    setFeedback(undefined);
    setEditorOpen(true);
    props.onOpenHandled?.();
  }, [props.openRequested, props.onOpenHandled]);
  const inputStatus = props.blocker
    ? `private · ${executionBlockerDescription(props.blocker)}${
        props.recipients.length > 0 ? ` — required by ${props.recipients.join(', ')}` : ''
      }`
    : `private · configured${
        props.recipients.length > 0 ? ` for ${props.recipients.join(', ')}` : ''
      } · value hidden`;
  return (
    <div className={`tm-preview-private-input${props.wide ? ' tm-preview-private-input--wide' : ''}`}>
      <span
        className={`tm-preview-private-input__dot tm-preview-private-input__dot--${
          props.blocker ? blockerTone(props.blocker) : 'success'
        }`}
        aria-hidden="true"
      />
      <code className="tm-preview-private-input__id">{props.inputId}</code>
      <span className="tm-preview-private-input__status" title={props.label}>{inputStatus}</span>
      <div className="tm-preview-private-input__actions">
        <button
          data-preview-input-trigger
          type="button"
          className="outline-button"
          disabled={busy}
          onClick={() => {
            setFeedback(undefined);
            setEditorOpen(true);
          }}
        >
          {props.blocker?.kind === 'PRIVATE_INPUT_MISSING' ? 'Set value…' : 'Replace…'}
        </button>
        {props.blocker?.kind === 'PRIVATE_INPUT_MISSING' ? null : <div className="tm-taskmenu" ref={menuRef}>
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
        </div>}
      </div>
      {feedback && !editorOpen ? (
        <p
          className={`tm-preview-input__feedback tm-preview-input__feedback--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}
      {editorOpen ? (
        <PreviewPrivateInputEditorModal
          label={props.label}
          inputId={props.inputId}
          valueRef={valueRef}
          keyRef={keyRef}
          busy={busy}
          feedback={feedback}
          onCancel={() => setEditorOpen(false)}
          onSave={() => void (async () => {
            const saved = await run(async () => {
              const api = window.previewPrivateInputs;
              if (!api) throw new Error('Private input API unavailable.');
              return api.set({
                taskId: props.taskId,
                inputId: props.inputId,
                value: valueRef.current?.value ?? ''
              });
            });
            if (saved) setEditorOpen(false);
          })()}
          onImport={() => void (async () => {
            const imported = await run(async () => {
              const api = window.previewPrivateInputs;
              if (!api) throw new Error('Private input API unavailable.');
              return api.import({
                taskId: props.taskId,
                inputId: props.inputId,
                key: keyRef.current?.value ?? ''
              });
            });
            if (imported) setEditorOpen(false);
          })()}
        />
      ) : null}
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

function PreviewPrivateInputEditorModal({
  label,
  inputId,
  valueRef,
  keyRef,
  busy,
  feedback,
  onCancel,
  onSave,
  onImport
}: {
  label: string;
  inputId: string;
  valueRef: RefObject<HTMLInputElement | null>;
  keyRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  feedback?: { tone: 'success' | 'error' | 'neutral'; message: string };
  onCancel(): void;
  onSave(): void;
  onImport(): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const cancelRef = useRef(onCancel);
  busyRef.current = busy;
  cancelRef.current = onCancel;
  useEffect(() => {
    valueRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) cancelRef.current();
      if (event.key !== 'Tab') return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ) ?? [])];
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
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [valueRef]);
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="preview-private-input-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div ref={panelRef} className="tm-modal__panel tm-preview-private-editor">
        <div>
          <h3 id="preview-private-input-title">Set {label}</h3>
          <p>
            Encrypted on this Mac and delivered only to declared recipients. The value cannot be viewed again—only replaced or deleted.
          </p>
        </div>
        <label className="tm-field">
          <span>Private value</span>
          <input ref={valueRef} type="password" autoComplete="off" disabled={busy} />
        </label>
        {feedback?.tone === 'error' ? (
          <p className="tm-preview-input__feedback tm-preview-input__feedback--error" role="alert">
            {feedback.message}
          </p>
        ) : null}
        <details className="tm-preview-disclosure tm-preview-private-editor__import">
          <summary>Import one .env key</summary>
          <div className="tm-preview-input__entry">
            <label className="tm-field">
              <span>Selected key</span>
              <input ref={keyRef} type="text" autoComplete="off" disabled={busy} />
            </label>
            <button type="button" className="outline-button" disabled={busy} onClick={onImport}>
              Choose file and import
            </button>
          </div>
          <p className="tm-preview-private-editor__note">
            Only the explicitly named key is imported for <code>{inputId}</code>. File contents and paths never return to this window.
          </p>
        </details>
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="primary-button" disabled={busy} onClick={onSave}>
            {busy ? 'Saving…' : 'Save encrypted value'}
          </button>
        </div>
      </div>
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
  const [confirmationText, setConfirmationText] = useState('');
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  busyRef.current = busy;
  onCancelRef.current = onCancel;
  useEffect(() => setConfirmationText(''), [confirmation.requireText]);
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
        {confirmation.impacts?.length ? (
          <div className="tm-preview-confirmation__impacts">
            {confirmation.impacts.map((impact) => (
              <div key={impact.label}>
                <span className={`tm-preview-confirmation__dot tm-preview-confirmation__dot--${impact.tone}`} aria-hidden="true" />
                <strong>{impact.label}</strong>
                <p>{impact.detail}</p>
              </div>
            ))}
          </div>
        ) : null}
        {confirmation.requireText ? (
          <label className="tm-field tm-preview-confirmation__phrase">
            <span>Type <code>{confirmation.requireText}</code> to confirm</span>
            <input
              type="text"
              autoComplete="off"
              value={confirmationText}
              disabled={busy}
              onChange={(event) => setConfirmationText(event.target.value)}
            />
          </label>
        ) : null}
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" autoFocus disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={confirmation.danger ? 'danger-button' : 'primary-button'}
            disabled={busy || Boolean(
              confirmation.requireText && confirmationText !== confirmation.requireText
            )}
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
        <div className="tm-preview-logdock__controls">
          <select
            className="tm-preview-logdock__attempt"
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
            className="tm-preview-logdock__stream"
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
  state,
  onLogs
}: {
  title: string;
  kind: string;
  detail?: string;
  state: string;
  onLogs?: () => void;
}) {
  return (
    <div className="tm-preview-row">
      <span
        className={`tm-preview-row__dot tm-preview-row__dot--${toneForRecordState(state)}`}
        aria-hidden="true"
      />
      <div className="tm-preview-row__copy">
        <strong>{title}</strong>
        <span>{kind}</span>
        {detail ? <code>{detail}</code> : null}
      </div>
      <span className="tm-preview-row__state">{humanize(state)}</span>
      {onLogs ? (
        <button
          type="button"
          className="tm-preview-icon-button"
          aria-label={`${title} logs`}
          title={`Open ${title} logs`}
          onClick={onLogs}
        >
          <TerminalIcon />
        </button>
      ) : null}
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

function OpenIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4 10 10 4M5.5 4H10v4.5" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="m2.5 4.5 3 2.5-3 2.5M7 10.5h4.5" />
    </svg>
  );
}

function previewTone(view: PreviewViewModel): 'neutral' | 'info' | 'action' | 'success' | 'error' {
  if (view.status === 'Starting' || view.status === 'Replacing') return 'info';
  return view.tone === 'warning' ? 'action' : view.tone;
}

function workspacePresentation(
  view: PreviewViewModel,
  executionReadiness?: PreviewExecutionReadiness,
  readinessPending = false,
  readinessCheckFailed = false
): {
  status: string;
  tone: 'neutral' | 'info' | 'action' | 'success' | 'error';
  meta?: string;
  detail?: string;
} {
  const activeId = view.activeGeneration ? shortId(view.activeGeneration.id) : undefined;
  const candidate = view.replacementGeneration ?? view.failedReplacementGeneration;
  const candidateId = candidate ? shortId(candidate.id) : undefined;
  if (view.status === 'Ready to start' && readinessPending && readinessCheckFailed) {
    return {
      status: 'Configuration check failed',
      tone: 'error',
      detail: 'Required private inputs could not be verified. Retry the check before starting.'
    };
  }
  if (view.status === 'Ready to start' && readinessPending) {
    return {
      status: 'Checking configuration',
      tone: 'info',
      detail: 'Verifying required private inputs before Start becomes available.'
    };
  }
  if (view.status === 'Ready to start' && executionReadiness?.status === 'BLOCKED') {
    const count = executionReadiness.blockers.length;
    return {
      status: 'Configuration required',
      tone: 'action',
      meta: `· ${count} private ${count === 1 ? 'input' : 'inputs'} unavailable`,
      detail: 'Start is blocked until every required private input resolves.'
    };
  }
  if (view.failedReplacementGeneration && view.activeGeneration) {
    const readinessFailure = view.latestAttempt?.readiness?.status === 'FAILED'
      ? `${view.latestAttempt.nodeId} did not pass its readiness check. `
      : '';
    return {
      status: 'Replacement failed',
      tone: 'error',
      meta: candidateId ? `· candidate ${candidateId}` : undefined,
      detail: `${readinessFailure}${activeId ?? 'The current preview'} is still serving; stable routes never moved.`
    };
  }
  if (view.status === 'Replacing') {
    return {
      status: 'Replacing',
      tone: 'info',
      meta: candidateId ? `· candidate ${candidateId}` : undefined,
      detail: `${activeId ?? 'The current preview'} stays routed until the full candidate reaches readiness.`
    };
  }
  if (view.status === 'Running' || view.status === 'Running · stale') {
    return {
      status: 'Running',
      tone: 'success',
      meta: activeId ? `· serving ${activeId}` : undefined,
      detail: view.status === 'Running · stale'
        ? 'Source changed after capture. The running preview still serves its captured code.'
        : 'Source current · stable routes attached'
    };
  }
  if (view.status === 'Starting') {
    return {
      status: 'Starting',
      tone: 'info',
      meta: view.latestAttempt ? `· running ${view.latestAttempt.nodeId}` : undefined,
      detail: 'Captured source is moving through the approved startup graph.'
    };
  }
  return {
    status: view.status,
    tone: previewTone(view),
    detail: view.summary
  };
}

function selectWorkspaceActions(
  view: PreviewViewModel,
  recommendedAction?: PreviewActionModel
): { primary?: PreviewActionModel; secondary?: PreviewActionModel } {
  const open = view.actions.find((action) => action.id === 'OPEN');
  const start = view.actions.find((action) => action.id === 'START');
  const stop = view.actions.find((action) => action.id === 'STOP');
  if (view.status === 'Starting') {
    return { primary: stop };
  }
  if (view.status === 'Cleanup incomplete') {
    return {
      primary: view.actions.find((action) => action.id === 'STOP' && action.label === 'Retry cleanup')
    };
  }
  if (view.status === 'Replacing') {
    return { primary: open, secondary: stop };
  }
  if (view.failedReplacementGeneration && view.activeGeneration) {
    return { primary: open, secondary: start };
  }
  if (view.status === 'Running · stale') {
    return { primary: open, secondary: start };
  }
  return { primary: recommendedAction };
}

function overviewActionLabel(action: PreviewActionModel, view: PreviewViewModel): string {
  if (action.id === 'APPROVE') return 'Review & approve';
  if (action.id === 'START' && view.failedReplacementGeneration) return 'Retry replace';
  return action.label;
}

function workspaceActionLabel(action: PreviewActionModel, view: PreviewViewModel): string {
  if (action.id === 'APPROVE') return 'Approve plan';
  if (action.id === 'STOP' && view.status === 'Starting') return 'Cancel start';
  if (action.id === 'STOP' && view.status === 'Replacing') return 'Cancel replace';
  if (action.id === 'START' && view.failedReplacementGeneration) return 'Retry replace';
  return action.label;
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

function privateInputRecipients(plan: PreviewPlanRecord, inputId: string): string[] {
  const recipients = new Set<string>();
  for (const job of plan.executionPlan.jobs) {
    if (environmentUsesPrivateInput(job.env, inputId)) recipients.add(job.id);
  }
  for (const node of [...plan.executionPlan.services, ...plan.executionPlan.workers]) {
    const readinessEnv = node.ready.type === 'argv' ? node.ready.env : undefined;
    const livenessEnv = node.liveness?.probe.type === 'argv'
      ? node.liveness.probe.env
      : undefined;
    if (
      environmentUsesPrivateInput(node.env, inputId) ||
      environmentUsesPrivateInput(readinessEnv, inputId) ||
      environmentUsesPrivateInput(livenessEnv, inputId)
    ) recipients.add(node.id);
  }
  for (const attachment of plan.executionPlan.attachments ?? []) {
    if ('passwordInput' in attachment && attachment.passwordInput === inputId) {
      recipients.add(`${attachment.id} check`);
    }
  }
  return [...recipients];
}

function environmentUsesPrivateInput(
  environment: Record<string, unknown> | undefined,
  inputId: string
): boolean {
  return Object.values(environment ?? {}).some((value) => (
    typeof value === 'object' && value !== null &&
    'type' in value && value.type === 'private-input' &&
    'input' in value && value.input === inputId
  ));
}

function executionBlockerDescription(blocker: PreviewExecutionBlocker): string {
  if (blocker.kind === 'PRIVATE_INPUT_MISSING') return 'missing';
  if (blocker.kind === 'PRIVATE_INPUT_LOCKED') return 'locked in Keychain';
  if (blocker.kind === 'PRIVATE_INPUT_CORRUPT') return 'encrypted value unavailable';
  return 'secure encryption unavailable';
}

function blockerTone(blocker: PreviewExecutionBlocker): 'action' | 'error' {
  return blocker.kind === 'PRIVATE_INPUT_MISSING' || blocker.kind === 'PRIVATE_INPUT_LOCKED'
    ? 'action'
    : 'error';
}

function describeExecutionBlockers(blockers: PreviewExecutionBlocker[]): string {
  if (blockers.length === 0) return 'Required private inputs are unavailable.';
  return blockers.map(
    (blocker) => `${blocker.inputId} is ${executionBlockerDescription(blocker)}.`
  ).join(' ');
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
