import { useRef, useState, type FormEvent } from 'react';
import type { DesignDetailSnapshot,PreviewRecipeGenerationSnapshot } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { ApplicationPreviewPanel } from './preview/ApplicationPreviewPanel';
import { ApplicationPreviewSetup } from './preview/ApplicationPreviewSetup';
import { DisclosureChevron } from './DisclosureChevron';

/** Repository selection belongs to creation; application setup belongs to Preview. */
export function DesignRepositorySetup({ project, onUpdate, onOpenLocation, onModalOpenChange }: {
  project: DesignDetailSnapshot;
  onUpdate(detail: DesignDetailSnapshot): void;
  onOpenLocation(): Promise<void>;
  onModalOpenChange(open: boolean): void;
}) {
  const root = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recipe, setRecipe] = useState<PreviewRecipeGenerationSnapshot>();
  const setup = project.repositorySetup;
  const spec = setup?.description?.spec;
  const services = spec?.type === 'environment' ? Object.entries(spec.services).filter(([, value]) => ['static', 'command', 'attach', 'preview'].includes(value.type)).map(([id]) => id)
    : spec?.type === 'compose' ? spec.services.filter(value => Object.keys(value.ports).length).map(value => value.id) : [];
  const active = Boolean(project.currentRun && ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING', 'RECOVERY_REQUIRED'].includes(project.currentRun.status));
  const refresh = async () => onUpdate(await taskManagerApi.getDesign(project.task.id));
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await action(); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Preview setup failed.'); }
    finally { setBusy(false); }
  };
  const selectTarget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await run(() => taskManagerApi.updateDesignPreviewTarget({ designId: project.task.id, target: {
      routeId: String(values.get('routeId')), entryPath: String(values.get('entryPath'))
    } }));
  };
  if (project.task.workflowPhase === 'ARCHIVED') return null;
  return <section ref={root} className="tm-design-repository-setup" aria-label="Preview configuration" tabIndex={-1}>
    {setup?.workspaceChanged || project.currentWorktree?.status !== 'PRESENT' ? <div className="tm-design-repository-setup__notice">
      <p role="status">{setup?.blocker}</p>
      <div className="tm-design-repository-setup__actions">
        {project.currentWorktree && ['MISSING', 'ERROR'].includes(project.currentWorktree.status) ? <button className="outline-button" disabled={busy || active} onClick={() => void run(() => taskManagerApi.prepareWorktree({ taskId: project.task.id, intent: 'RECOVER' }))}>Recover workspace</button> : null}
        {setup?.workspaceChanged ? <button className="outline-button" disabled={busy || active} onClick={() => void run(() => taskManagerApi.startDesign({ designId: project.task.id, acceptWorkspaceSnapshotId: setup.workspaceSnapshotId }))}>Continue with these changes</button> : null}
      </div>
    </div> : null}
    {project.currentWorktree?.status === 'PRESENT' ? <ApplicationPreviewPanel taskId={project.task.id} projectName={project.repository.name} onModalOpenChange={onModalOpenChange}
      setup={<ApplicationPreviewSetup taskId={project.task.id} worktreeId={project.currentWorktree.id} state={recipe}
        disabledReason={active ? 'Wait for the Design turn to finish.' : undefined} fallbackReturnFocusRef={root} onModalOpenChange={onModalOpenChange}
        get={async taskId => { const state = await taskManagerApi.getPreviewRecipeGeneration({ taskId }); setRecipe(state); return state; }}
        generate={async taskId => { const state = await taskManagerApi.generatePreviewRecipe({ taskId }); setRecipe(state); return state; }}
        validate={(taskId, draftId, yaml) => taskManagerApi.validatePreviewRecipeDraft({ taskId, draftId, yaml })}
        accept={async (taskId, draftId, yaml) => { const result = await taskManagerApi.acceptPreviewRecipeDraft({ taskId, draftId, yaml }); await refresh(); return result; }}
        discard={async taskId => { const state = await taskManagerApi.discardPreviewRecipeDraft({ taskId }); setRecipe(state); return state; }}
        writeManually={onOpenLocation} />} /> : null}
    {spec ? <section className="tm-design-repository-setup__application" aria-labelledby="design-application-title">
      <h3 id="design-application-title" className="tm-panel__title">Design target</h3>
      <form key={JSON.stringify(project.task.designPreviewTarget)} className="field-grid tm-design-repository-fields" onSubmit={event => void selectTarget(event)}>
        <label className="field"><span>Application</span><select name="routeId" defaultValue={project.task.designPreviewTarget?.routeId ?? 'app'} disabled={busy || active}>
          <option value="app">Primary application</option>{services.filter(id => id !== 'app').map(id => <option key={id}>{id}</option>)}
        </select></label>
        <label className="field"><span>Entry path</span><input name="entryPath" defaultValue={project.task.designPreviewTarget?.entryPath ?? '/'} required disabled={busy || active} /></label>
        <button className="outline-button" disabled={busy || active}>Select application</button>
      </form>
    </section> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {project.turns.some(turn => !turn.runId && !turn.outcome) ? <div>
      {setup?.blocker && !setup.workspaceChanged ? <p className="tm-application-preview__notice">{setup.blocker}</p> : null}
      <button className="primary-button" disabled={busy || active || Boolean(setup?.blocker)} title={setup?.blocker} onClick={() => void run(() => taskManagerApi.startDesign({ designId: project.task.id }))}>Start Design</button>
    </div> : null}
    {project.currentWorktree ? <details className="tm-preview-disclosure tm-design-repository-setup__workspace">
      <summary><DisclosureChevron /><span>Workspace details</span></summary>
      <dl className="tm-preview-keyvalues"><div><dt>Repository</dt><dd>{project.repository.name}</dd></div><div><dt>Base</dt><dd><code>{project.currentWorktree.baseRef ?? project.currentWorktree.baseSha.slice(0, 8)}</code></dd></div><div><dt>Branch</dt><dd><code>{project.currentWorktree.branchName}</code></dd></div></dl>
      {project.currentWorktree.status === 'PRESENT' ? <button className="outline-button" disabled={busy} onClick={() => void run(onOpenLocation)}>Open workspace</button> : null}
    </details> : null}
  </section>;
}
