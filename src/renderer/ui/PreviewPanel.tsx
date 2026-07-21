import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import type {
  PreviewApprovalRecord,
  PreviewComposeProjectRecord,
  PreviewGenerationAttachmentRecord,
  PreviewGenerationRecord,
  PreviewLocalAttachmentBindingRecord,
  PreviewManagedResourceRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  PreviewResolvedAttachmentTarget,
  PreviewResourceRecord,
  PreviewRouteRecord
} from '../../shared/contracts';
import type {
  PreviewExecutionBlocker,
  PreviewExecutionReadiness,
  PreviewLocalAttachmentRequirement,
  PreviewPrivateInputOperationResult
} from '../../shared/preview';
import {
  selectPreviewOverviewProjection,
  shouldShowPreviewOverview,
  type PreviewActionId,
  type PreviewActionModel,
  type PreviewViewModel
} from '../model/preview';
import {
  createPreviewAttachmentBindingDraft,
  materializePreviewAttachmentTarget,
  type PreviewAttachmentBindingDraft,
  type PreviewTaskRouteOption
} from '../model/previewBindings';
import { Chip } from './StatusBadge';
import {
  focusMenuItem,
  handleMenuBlur,
  handleMenuKeyDown,
  menuTriggerFocusTarget
} from './menuKeyboard';
import { useDialogFocusBoundary } from './dialogFocus';
import { ImpactList } from './ImpactList';
import type {
  PreviewConfirmation,
  PreviewController,
  PreviewPanelProps
} from './preview/types';
import { usePreviewController } from './preview/usePreviewController';
import { usePreviewLogs } from './preview/usePreviewLogs';
import {
  AuthorityRow,
  PreviewPlanAuthority
} from './preview/PreviewPlanAuthority';
import { PreviewRecipeGenerationModal } from './preview/PreviewRecipeGenerationModal';
import { humanizeEnum } from '../model/formatting';
import { formatPreviewAttachmentTarget } from '../model/previewPresentation';

export type { PreviewPanelProps } from './preview/types';

export function PreviewOverviewCard(
  props: PreviewPanelProps & { onShowDetails(): void }
) {
  const controller = usePreviewController(props);
  if (!shouldShowPreviewOverview(controller.view)) {
    return null;
  }
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
  const localConfiguration = props.resolution?.status === 'CONFIGURATION_REQUIRED'
    ? props.resolution
    : undefined;
  const focusedWorkspace = !localConfiguration && !configurationRequired && (
    !plan ||
    ['Ready to start', 'Stopped', 'Failed', 'Recovery required', 'Cleanup incomplete']
      .includes(controller.view.status)
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
    <section
      className={`tm-preview-workspace${focusedWorkspace ? ' tm-preview-workspace--focused' : ''}`}
      aria-label="Preview"
    >
      <header className="tm-preview-workspace__head">
        <div className="tm-preview-workspace__decision">
          <div className={`tm-preview-statusline tm-preview-statusline--${presentation.tone}`}>
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
              className={
                primaryAction.id === 'STOP' && controller.view.status !== 'Cleanup incomplete'
                  ? 'outline-button'
                  : 'primary-button'
              }
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

      {localConfiguration ? (
        <PreviewLocalAttachmentConfiguration
          taskId={props.task.id}
          selectedScenarioId={localConfiguration.selectedScenarioId}
          requirements={localConfiguration.requirements}
          routeOptions={props.taskRouteOptions}
          onSave={props.onSetLocalBinding}
        />
      ) : plan && approvalRequired ? (
        <PreviewPlanAuthority plan={plan} approval={controller.view.approval} />
      ) : null}

      {!localConfiguration && plan && configurationRequired ? (
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
          fallbackReturnFocusRef={props.fallbackReturnFocusRef}
          modalRootRef={props.modalRootRef}
          onModalOpenChange={props.onModalOpenChange}
        />
      ) : !localConfiguration && plan && !approvalRequired ? <div
        className={`tm-preview-workspace__columns${
          focusedWorkspace ? ' tm-preview-workspace__columns--focused' : ''
        }`}
      >
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
              fallbackReturnFocusRef={props.fallbackReturnFocusRef}
              modalRootRef={props.modalRootRef}
              onModalOpenChange={props.onModalOpenChange}
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
          fallbackReturnFocusRef={props.fallbackReturnFocusRef}
          modalRootRef={props.modalRootRef}
          onModalOpenChange={props.onModalOpenChange}
        />
      ) : null}
    </section>
  );
}

function PreviewLocalAttachmentConfiguration({
  taskId,
  selectedScenarioId,
  requirements,
  routeOptions,
  onSave
}: {
  taskId: string;
  selectedScenarioId: string;
  requirements: PreviewLocalAttachmentRequirement[];
  routeOptions: PreviewTaskRouteOption[];
  onSave(
    taskId: string,
    attachmentId: string,
    target: PreviewResolvedAttachmentTarget,
    scenarioId: string
  ): Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(requirements[0]?.attachmentId ?? '');
  const requirement = requirements.find((candidate) => candidate.attachmentId === selectedId) ??
    requirements[0];
  const [draft, setDraft] = useState<PreviewAttachmentBindingDraft>(() =>
    requirement
      ? createPreviewAttachmentBindingDraft(requirement)
      : createPreviewAttachmentBindingDraft({
          attachmentId: 'unknown', attachmentType: 'http', allowedTargetTypes: ['endpoint'], usages: []
        })
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!requirement) return;
    setDraft(createPreviewAttachmentBindingDraft(requirement));
    setError(undefined);
  }, [requirement?.attachmentId]);

  if (!requirement) return null;
  const taskRouteAllowed = requirement.allowedTargetTypes.includes('task-preview-route');
  const selectedRouteValue = draft.targetTaskId && draft.routeId
    ? `${draft.targetTaskId}\u0000${draft.routeId}`
    : '';
  const update = (fields: Partial<PreviewAttachmentBindingDraft>) => {
    setDraft((current) => ({ ...current, ...fields }));
    setError(undefined);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      const target = materializePreviewAttachmentTarget(requirement, draft);
      setBusy(true);
      await onSave(taskId, requirement.attachmentId, target, selectedScenarioId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this target.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tm-preview-workspace__columns tm-preview-configuration">
      <section className="tm-preview-surface tm-preview-binding-editor" aria-labelledby="preview-public-targets">
        <SectionHeading
          id="preview-public-targets"
          title="Public targets"
          detail="Configure public connection details for this scenario. Task Monki never owns or mutates attached targets."
        />
        {requirements.length > 1 ? (
          <label className="tm-field">
            <span>Attachment</span>
            <select value={requirement.attachmentId} onChange={(event) => setSelectedId(event.target.value)}>
              {requirements.map((candidate) => (
                <option key={candidate.attachmentId} value={candidate.attachmentId}>
                  {candidate.label ?? candidate.attachmentId} · {candidate.attachmentType}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <form onSubmit={(event) => void submit(event)}>
          <div className="tm-preview-binding-editor__identity">
            <strong>{requirement.label ?? requirement.attachmentId}</strong>
            <span>{requirement.attachmentType.toUpperCase()}</span>
          </div>
          {taskRouteAllowed ? (
            <label className="tm-field">
              <span>Target source</span>
              <select
                value={draft.mode}
                onChange={(event) => update({ mode: event.target.value as PreviewAttachmentBindingDraft['mode'] })}
              >
                <option value="endpoint">Public endpoint</option>
                <option value="task-preview-route">Another task’s Preview route</option>
              </select>
            </label>
          ) : null}
          {draft.mode === 'task-preview-route' ? (
            <>
              <label className="tm-field">
                <span>Preview route</span>
                <select
                  value={selectedRouteValue}
                  disabled={routeOptions.length === 0}
                  onChange={(event) => {
                    const [targetTaskId, routeId] = event.target.value.split('\u0000');
                    update({ targetTaskId, routeId });
                  }}
                >
                  <option value="" disabled>
                    {routeOptions.length === 0 ? 'No routes available' : 'Select a Preview route'}
                  </option>
                  {routeOptions.map((option) => (
                    <option key={`${option.taskId}:${option.routeId}`} value={`${option.taskId}\u0000${option.routeId}`}>
                      {option.taskTitle} · {option.routeId}{option.available ? ' · running' : ' · stopped'}
                    </option>
                  ))}
                </select>
              </label>
              <TextBindingField label="Base path" value={draft.basePath} onChange={(basePath) => update({ basePath })} />
              <p className="tm-preview-binding-editor__note">
                A stopped producer can still be selected. Availability is checked only when the recipe explicitly requires attachment readiness.
              </p>
            </>
          ) : (
            <PreviewEndpointFields requirement={requirement} draft={draft} update={update} />
          )}
          {error ? <p className="tm-preview-input__feedback tm-preview-input__feedback--error" role="alert">{error}</p> : null}
          <div className="tm-preview-binding-editor__actions">
            <button
              type="submit"
              className="primary-button"
              disabled={
                busy ||
                (draft.mode === 'task-preview-route' &&
                  (routeOptions.length === 0 || !draft.targetTaskId || !draft.routeId))
              }
            >
              {busy ? 'Saving…' : 'Save target'}
            </button>
          </div>
        </form>
      </section>
      <aside className="tm-preview-surface tm-preview-binding-usage" aria-labelledby="preview-target-recipients">
        <SectionHeading
          id="preview-target-recipients"
          title="Recipient scope"
          detail="Saving the target re-resolves this same scenario. Approval will cover the exact public target and recipients."
        />
        <div className="tm-preview-rows">
          {requirement.usages.map((usage, index) => (
            <OperationalRow
              key={`${usage.kind}:${usage.nodeId}:${index}`}
              title={`${humanizeEnum(usage.nodeKind)} · ${usage.nodeId}`}
              kind={usage.kind === 'READINESS_DEPENDENCY' ? 'STARTUP CHECK' : humanizeEnum(usage.recipient)}
              detail={usage.kind === 'ENVIRONMENT'
                ? usage.environmentKeys.join(', ')
                : 'Must pass the declared one-shot attachment check'}
              state="Declared by recipe"
            />
          ))}
        </div>
      </aside>
    </div>
  );
}

function PreviewEndpointFields({
  requirement,
  draft,
  update
}: {
  requirement: PreviewLocalAttachmentRequirement;
  draft: PreviewAttachmentBindingDraft;
  update(fields: Partial<PreviewAttachmentBindingDraft>): void;
}) {
  return (
    <>
      {requirement.attachmentType === 'http' ? (
        <label className="tm-field">
          <span>Scheme</span>
          <select value={draft.scheme} onChange={(event) => update({ scheme: event.target.value as PreviewAttachmentBindingDraft['scheme'] })}>
            <option value="" disabled>Select scheme</option>
            <option value="http">http</option>
            <option value="https">https</option>
          </select>
        </label>
      ) : null}
      <div className="tm-preview-binding-editor__pair">
        <TextBindingField label="Host" value={draft.host} onChange={(host) => update({ host })} />
        <TextBindingField label="Port" value={draft.port} inputMode="numeric" onChange={(port) => update({ port })} />
      </div>
      {requirement.attachmentType === 'http' ? (
        <TextBindingField label="Base path" value={draft.basePath} onChange={(basePath) => update({ basePath })} />
      ) : null}
      {requirement.attachmentType === 'postgres' || requirement.attachmentType === 'redis' ? (
        <>
          <TextBindingField
            label={requirement.attachmentType === 'redis' ? 'Database number' : 'Database'}
            value={draft.database}
            inputMode={requirement.attachmentType === 'redis' ? 'numeric' : undefined}
            onChange={(database) => update({ database })}
          />
          <TextBindingField
            label={requirement.attachmentType === 'redis' ? 'Username (optional)' : 'Username'}
            value={draft.username}
            onChange={(username) => update({ username })}
          />
          <label className="tm-field">
            <span>TLS</span>
            <select value={draft.tls} onChange={(event) => update({ tls: event.target.value as PreviewAttachmentBindingDraft['tls'] })}>
              <option value="" disabled>Select TLS mode</option>
              <option value="disabled">Disabled</option>
              <option value="system-verified">System verified</option>
            </select>
          </label>
        </>
      ) : null}
    </>
  );
}

function TextBindingField({
  label,
  value,
  inputMode,
  onChange
}: {
  label: string;
  value: string;
  inputMode?: 'numeric';
  onChange(value: string): void;
}) {
  return (
    <label className="tm-field">
      <span>{label}</span>
      <input value={value} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} />
    </label>
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
    <section className="tm-preview-workspace tm-preview-workspace--focused" aria-label="Preview">
      <header className="tm-preview-workspace__head tm-preview-setup__head">
        <div className="tm-preview-workspace__decision">
          <div className="tm-preview-statusline tm-preview-statusline--action">
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
          fallbackReturnFocusRef={props.fallbackReturnFocusRef}
          modalRootRef={props.modalRootRef}
          onModalOpenChange={props.onModalOpenChange}
        />
      ) : null}
    </section>
  );
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
                kind={humanizeEnum(attempt.kind)}
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
          <div><dt>State</dt><dd>{humanizeEnum(current.state)}</dd></div>
          <div><dt>Source</dt><dd><code>{shortId(current.sourceHeadSha)}</code></dd></div>
          <div><dt>Routing</dt><dd>{humanizeEnum(current.routingState)}</dd></div>
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
                  kind={humanizeEnum(generation.routingState)}
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
              detail={formatPreviewAttachmentTarget(
                attachment,
                attachment.target.type === 'local' ? localBinding?.target : undefined
              )}
              state={evidence
                ? evidence.status === 'PASSED' ? 'Startup check passed' : humanizeEnum(evidence.failureCode ?? 'Check failed')
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
  onChanged,
  fallbackReturnFocusRef,
  modalRootRef,
  onModalOpenChange
}: {
  taskId: string;
  plan: PreviewPlanRecord;
  approval?: PreviewApprovalRecord;
  readiness: PreviewExecutionReadiness;
  localBindings: PreviewLocalAttachmentBindingRecord[];
  requestedInputId?: string;
  onInputRequestHandled(): void;
  onChanged(): Promise<void>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  modalRootRef: RefObject<HTMLElement | null>;
  onModalOpenChange(open: boolean): void;
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
          fallbackReturnFocusRef={fallbackReturnFocusRef}
          modalRootRef={modalRootRef}
          onModalOpenChange={onModalOpenChange}
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
  onChanged,
  fallbackReturnFocusRef,
  modalRootRef,
  onModalOpenChange
}: {
  taskId: string;
  plan: PreviewPlanRecord;
  readiness?: PreviewExecutionReadiness;
  wide?: boolean;
  requestedInputId?: string;
  onInputRequestHandled?(): void;
  onChanged(): Promise<void>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  modalRootRef: RefObject<HTMLElement | null>;
  onModalOpenChange(open: boolean): void;
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
            fallbackReturnFocusRef={fallbackReturnFocusRef}
            modalRootRef={modalRootRef}
            onModalOpenChange={onModalOpenChange}
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
      <ul className="tm-preview-advisories__list">
        {blockers.map((blocker) => (
          <li key={`${blocker.kind}-${blocker.inputId}`}>
            <code>{blocker.inputId}</code> {executionBlockerDescription(blocker)} — required
          </li>
        ))}
      </ul>
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
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  modalRootRef: RefObject<HTMLElement | null>;
  onModalOpenChange(open: boolean): void;
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
    const frame = window.requestAnimationFrame(() => focusMenuItem(menuRef.current));
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onPointerDown);
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
            onKeyDown={(event) => {
              const target = menuTriggerFocusTarget(event.key);
              if (!target) return;
              event.preventDefault();
              if (menuOpen) focusMenuItem(menuRef.current, target);
              else setMenuOpen(true);
            }}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <KebabIcon />
          </button>
          {menuOpen ? (
            <div
              className="tm-taskmenu__menu"
              role="menu"
              tabIndex={-1}
              aria-label={`Private input options for ${props.label}`}
              onKeyDown={(event) =>
                handleMenuKeyDown(event, {
                  onClose: () => setMenuOpen(false),
                  returnFocus: triggerRef.current
                })
              }
              onBlur={(event) => handleMenuBlur(event, () => setMenuOpen(false))}
            >
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
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
          fallbackReturnFocusRef={props.fallbackReturnFocusRef}
          modalRootRef={props.modalRootRef}
          onModalOpenChange={props.onModalOpenChange}
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
          fallbackReturnFocusRef={props.fallbackReturnFocusRef}
          modalRootRef={props.modalRootRef}
          onModalOpenChange={props.onModalOpenChange}
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
  onImport,
  fallbackReturnFocusRef,
  modalRootRef,
  onModalOpenChange
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
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  modalRootRef: RefObject<HTMLElement | null>;
  onModalOpenChange(open: boolean): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: valueRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  useLayoutEffect(() => {
    onModalOpenChange(true);
    return () => onModalOpenChange(false);
  }, [onModalOpenChange]);
  const dialog = (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="preview-private-input-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div
        ref={panelRef}
        className="tm-modal__panel tm-preview-private-editor"
        tabIndex={-1}
      >
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
  return modalRootRef.current ? createPortal(dialog, modalRootRef.current) : dialog;
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
    const frame = window.requestAnimationFrame(() => focusMenuItem(rootRef.current));
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onPointerDown);
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
        onKeyDown={(event) => {
          const target = menuTriggerFocusTarget(event.key);
          if (!target) return;
          event.preventDefault();
          if (open) focusMenuItem(rootRef.current, target);
          else setOpen(true);
        }}
        onClick={() => setOpen((current) => !current)}
      >
        <KebabIcon />
      </button>
      {open ? (
        <div
          className="tm-taskmenu__menu tm-preview-actionmenu"
          role="menu"
          tabIndex={-1}
          aria-label="Preview options"
          onKeyDown={(event) =>
            handleMenuKeyDown(event, {
              onClose: () => setOpen(false),
              returnFocus: triggerRef.current
            })
          }
          onBlur={(event) => handleMenuBlur(event, () => setOpen(false))}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
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
          {actions.length > 0 && resetResources.length > 0 ? (
            <div className="tm-pathmenu__separator" role="separator" />
          ) : null}
          {resetResources.map((resource) => (
            <button
              key={resource.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
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
  onConfirm,
  fallbackReturnFocusRef,
  modalRootRef,
  onModalOpenChange
}: {
  confirmation: PreviewConfirmation;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  modalRootRef: RefObject<HTMLElement | null>;
  onModalOpenChange(open: boolean): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmationText, setConfirmationText] = useState('');
  useEffect(() => setConfirmationText(''), [confirmation.requireText]);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: cancelButtonRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel,
    returnFocus: confirmation.returnFocus
  });
  useLayoutEffect(() => {
    onModalOpenChange(true);
    return () => onModalOpenChange(false);
  }, [onModalOpenChange]);
  const dialog = (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="preview-confirmation-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div
        ref={panelRef}
        className="tm-modal__panel tm-preview-confirmation"
        tabIndex={-1}
      >
        <h3 id="preview-confirmation-title">{confirmation.title}</h3>
        <p>{confirmation.body}</p>
        {confirmation.impacts?.length ? (
          <ImpactList
            ariaLabel="Preview action impact"
            groups={confirmation.impacts.map((impact) => ({
              kind: impact.tone,
              items: [impact.detail]
            }))}
          />
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
          <button
            ref={cancelButtonRef}
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={onCancel}
          >
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
  return modalRootRef.current ? createPortal(dialog, modalRootRef.current) : dialog;
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
                {attempt.nodeId} · attempt {attempt.attempt} · {humanizeEnum(attempt.state)}
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
      <div className="tm-preview-row__copy">
        <strong>{title}</strong>
        <span>{kind}</span>
        {detail ? <code>{detail}</code> : null}
      </div>
      <span className="tm-preview-row__state">{humanizeEnum(state)}</span>
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
