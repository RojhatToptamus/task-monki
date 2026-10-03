import { useRef, useState, type FormEvent } from 'react';
import type { DesignDetailSnapshot } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { PreviewWorkspace } from './PreviewPanel';
import { DisclosureChevron } from './DisclosureChevron';

/** Repository selection belongs to creation; application setup belongs to Preview. */
export function DesignRepositorySetup({ project, onUpdate, onOpenLocation, onModalOpenChange }: {
  project: DesignDetailSnapshot;
  onUpdate(detail: DesignDetailSnapshot): void;
  onOpenLocation(): Promise<void>;
  onModalOpenChange(open: boolean): void;
}) {
  const root = useRef<HTMLElement>(null);
  const modalRoot = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const setup = project.repositorySetup;
  const state = setup?.state;
  const resolution = setup?.preview;
  const plan = resolution?.status === 'PLAN' ? resolution.plan : undefined;
  const active = Boolean(project.currentRun && ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING', 'RECOVERY_REQUIRED'].includes(project.currentRun.status));
  const refresh = async () => onUpdate(await taskManagerApi.getDesign(project.task.id));
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try { await action(); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Preview setup failed.'); }
    finally { setBusy(false); }
  };
  const selectTarget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await run(() => taskManagerApi.updateDesignPreviewTarget({ designId: project.task.id, target: {
      routeId: String(values.get('routeId')), entryPath: String(values.get('entryPath')),
      scenarioId: String(values.get('scenarioId'))
    } }));
  };
  if (!state || project.task.workflowPhase === 'ARCHIVED') return null;
  return (
    <section ref={root} className="tm-design-repository-setup" aria-label="Preview configuration" tabIndex={-1}>
      {setup?.blocker && (!resolution || (resolution.status === 'PLAN' && resolution.approval && resolution.executionReadiness.status === 'READY')) ? (
        <div className="tm-design-repository-setup__notice">
          <p role="status">{setup.blocker}</p>
          <div className="tm-design-repository-setup__actions">
            {project.currentWorktree?.status === 'PRESENT' ? (
              <button type="button" className="outline-button" disabled={busy} onClick={() => void run(onOpenLocation)}>Open workspace</button>
            ) : null}
            {project.currentWorktree && ['MISSING', 'ERROR'].includes(project.currentWorktree.status) ? (
              <button type="button" className="outline-button" disabled={busy || active} onClick={() => void run(() => taskManagerApi.prepareWorktree({ taskId: project.task.id, intent: 'RECOVER' }))}>Recover workspace</button>
            ) : null}
            {setup.workspaceChanged ? (
              <button type="button" className="outline-button" disabled={busy || active} onClick={() => void run(() => taskManagerApi.startDesign({ designId: project.task.id, acceptWorkspaceSnapshotId: setup.workspaceSnapshotId }))}>Continue with these changes</button>
            ) : null}
          </div>
        </div>
      ) : null}
      {plan ? (
        <section className="tm-design-repository-setup__application" aria-labelledby="design-application-title">
          <h3 id="design-application-title" className="tm-preview-surface__title">Application</h3>
          <form key={`${plan.id}:${JSON.stringify(project.task.designPreviewTarget)}`} className="field-grid tm-design-repository-fields" onSubmit={(event) => void selectTarget(event)}>
            <label className="field">
              <span>Application route</span>
              <select name="routeId" defaultValue={project.task.designPreviewTarget?.routeId ?? plan.executionPlan.routes.find((route) => route.primary)?.id ?? plan.executionPlan.routes[0]?.id} disabled={busy || active}>
                {plan.executionPlan.routes.map((route) => <option key={route.id} value={route.id}>{route.id}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Entry path</span>
              <input name="entryPath" defaultValue={project.task.designPreviewTarget?.entryPath ?? '/'} required disabled={busy || active} />
            </label>
            <label className="field">
              <span>Scenario</span>
              <select name="scenarioId" defaultValue={project.task.designPreviewTarget?.scenarioId ?? plan.executionPlan.selectedScenarioId} disabled={busy || active}>
                {plan.executionPlan.scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.id}</option>)}
              </select>
            </label>
            <button type="submit" className="outline-button" disabled={busy || active}>Select application</button>
          </form>
          {active ? <p className="field-hint">Application settings are unavailable while this Design is running.</p> : null}
        </section>
      ) : null}
      <PreviewWorkspace
        task={project.task} worktree={project.currentWorktree}
        plans={state.previewPlans} approvals={state.previewApprovals} generations={state.previewGenerations}
        generationAttachments={state.previewGenerationAttachments} attempts={state.previewNodeAttempts}
        managedResources={state.previewManagedResources} composeProjects={state.previewComposeProjects}
        localBindings={state.previewLocalBindings} taskRouteOptions={state.previewTaskRoutes} runtimeResources={state.previewResources}
        resolution={resolution} executionReadiness={resolution?.status === 'PLAN' ? resolution.executionReadiness : undefined}
        recipeGenerationDisabledReason={active ? 'Wait for the Design turn before changing Preview setup.' : undefined}
        onResolve={async () => { await run(refresh); }}
        onSetLocalBinding={async (taskId, attachmentId, target) => { await run(() => taskManagerApi.setPreviewLocalAttachmentBinding({ taskId, attachmentId, target })); }}
        onGetRecipeGeneration={(taskId) => taskManagerApi.getPreviewRecipeGeneration({ taskId })}
        onGenerateRecipe={(taskId) => taskManagerApi.generatePreviewRecipe({ taskId })}
        onValidateRecipeDraft={(taskId, draftId, yaml) => taskManagerApi.validatePreviewRecipeDraft({ taskId, draftId, yaml })}
        onAcceptRecipeDraft={async (taskId, draftId, yaml) => { const result = await taskManagerApi.acceptPreviewRecipeDraft({ taskId, draftId, yaml }); await refresh(); return result; }}
        onDiscardRecipeDraft={(taskId) => taskManagerApi.discardPreviewRecipeDraft({ taskId })}
        onWriteRecipeManually={onOpenLocation}
        onApprove={async (taskId, planId, executionDigest) => { await run(() => taskManagerApi.approvePreviewPlan({ taskId, planId, executionDigest })); }}
        onStart={async () => { await run(() => taskManagerApi.startDesign({ designId: project.task.id })); }}
        onOpen={async (taskId, generationId, routeId) => { await taskManagerApi.openPreview({ taskId, generationId, routeId }); }}
        onStop={async (taskId, generationId) => { await run(() => taskManagerApi.stopPreview({ taskId, generationId })); }}
        onResetData={async (taskId, generationId, resourceId, scenarioId) => { await run(() => taskManagerApi.resetPreviewData({ taskId, generationId, resourceId, scenarioId })); }}
        onRetrySetup={async (taskId, generationId, scenarioId) => { await run(() => taskManagerApi.retryPreviewSetup({ taskId, generationId, scenarioId })); }}
        onReadLog={(taskId, artifactId, offset, maxBytes) => taskManagerApi.readPreviewLog({ taskId, artifactId, offset, maxBytes })}
        fallbackReturnFocusRef={root} modalRootRef={modalRoot} onModalOpenChange={onModalOpenChange}
      />
      {error ? <p className="tm-error" role="alert">{error}</p> : null}
      {project.turns.some((turn) => !turn.runId && !turn.outcome) ? (
        <button type="button" className="primary-button" disabled={busy || active || Boolean(setup?.blocker)} title={setup?.blocker} onClick={() => void run(() => taskManagerApi.startDesign({ designId: project.task.id }))}>Start Design</button>
      ) : null}
      {project.currentWorktree ? <details className="tm-preview-disclosure tm-design-repository-setup__workspace">
        <summary><DisclosureChevron /><span>Workspace details</span></summary>
        <dl className="tm-preview-keyvalues">
          <div><dt>Repository</dt><dd>{project.repository.name}</dd></div>
          <div><dt>Base</dt><dd><code>{project.currentWorktree.baseRef ?? project.currentWorktree.baseSha.slice(0, 8)}</code></dd></div>
          <div><dt>Branch</dt><dd><code>{project.currentWorktree.branchName}</code></dd></div>
        </dl>
        {project.currentWorktree.status === 'PRESENT' ? <button type="button" className="outline-button" disabled={busy} onClick={() => void run(onOpenLocation)}>Open workspace</button> : null}
      </details> : null}
      <div ref={modalRoot} />
    </section>
  );
}
