import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type {
  ExistingWorktreeOption,
  Repository,
  WorktreeComparison,
  WorktreeImportInspection
} from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { buildRepositoryOptions } from '../model/repositories';
import { RepositorySelect } from './RepositoryPicker';
import { useDialogFocusBoundary } from './dialogFocus';
import { PanelResizeHandle } from './PanelResizeHandle';
import {
  clampNewTaskPanelWidth,
  DEFAULT_NEW_TASK_PANEL_WIDTH,
  getNewTaskPanelWidthBounds,
  MAX_NEW_TASK_PANEL_WIDTH
} from '../model/newTaskPanel';

export interface ImportTaskPanelProps {
  repositories: Repository[];
  initialRepositoryId?: string;
  onClose(): void;
  /** Open the task and close the panel through the parent workspace. */
  onImported(taskId: string): Promise<void> | void;
  /** Register the picked checkout and update the parent's repository list. */
  onAddRepository?(path: string): Promise<Repository>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackReturnFocusRef?: RefObject<HTMLElement | null>;
  onResize?(): void;
}

export function ImportTaskPanel({
  repositories,
  initialRepositoryId,
  onClose,
  onImported,
  onAddRepository,
  returnFocusRef,
  fallbackReturnFocusRef,
  onResize
}: ImportTaskPanelProps) {
  const id = useId();
  const panelRef = useRef<HTMLFormElement>(null);
  const slideoverRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const returnFocusAfterClose = useRef(true);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? MAX_NEW_TASK_PANEL_WIDTH : window.innerWidth
  );
  const [requestedWidth, setRequestedWidth] = useState(DEFAULT_NEW_TASK_PANEL_WIDTH);
  const panelWidth = clampNewTaskPanelWidth(requestedWidth, viewportWidth);
  const panelWidthBounds = getNewTaskPanelWidthBounds(viewportWidth);
  const [repositoryId, setRepositoryId] = useState(() =>
    repositories.find((repository) => repository.id === initialRepositoryId &&
      repository.kind === 'USER_REGISTERED')?.id ??
    repositories.find((repository) => repository.kind === 'USER_REGISTERED' &&
      repository.status === 'AVAILABLE')?.id ?? ''
  );
  // A picker result remains usable while the parent reloads its repository list.
  const [addedRepository, setAddedRepository] = useState<Repository>();
  const [selection, setSelection] = useState<{ path: string; comparison?: WorktreeComparison }>({ path: '' });
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [readyForReview, setReadyForReview] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [checkoutResult, setCheckoutResult] = useState<{
    key: string;
    options: ExistingWorktreeOption[];
    error?: string;
  }>();
  const [inspectionResult, setInspectionResult] = useState<{
    key: string;
    inspection?: WorktreeImportInspection;
    error?: string;
  }>();
  const [error, setError] = useState<string>();
  const [importedTask, setImportedTask] = useState<ExistingWorktreeOption['existingTask']>();
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [closed, setClosed] = useState(false);
  const lifecycle = useRef(0);
  const pending = useRef(false);
  const creation = useRef<{ key: string; token: string } | undefined>(undefined);

  const availableRepositories = (addedRepository &&
    !repositories.some((repository) => repository.id === addedRepository.id)
    ? [...repositories, addedRepository] : repositories
  ).filter((repository) => repository.kind === 'USER_REGISTERED');
  const repository = availableRepositories.find((candidate) => candidate.id === repositoryId);
  const repositoryPath = repository?.path;
  const repositoryBranch = repository?.branch;
  const repositoryAvailable = repository?.status === 'AVAILABLE';
  const checkoutKey = JSON.stringify([repositoryId, repositoryPath, repositoryBranch, repositoryAvailable, refresh]);
  const currentCheckouts = checkoutResult?.key === checkoutKey ? checkoutResult : undefined;
  const options = currentCheckouts?.options ?? [];
  const checkout = options.find((candidate) => candidate.worktreePath === selection.path);
  const worktreePath = checkout?.worktreePath ?? '';
  const branchName = checkout?.branchName ?? '';
  const comparison = selection.comparison ?? suggestedComparison(repository, checkout);
  const comparisonRef = comparison.ref.trim();
  const comparisonType = comparison.type;
  const duplicate = importedTask ?? checkout?.existingTask;
  const selectionError = !repositoryAvailable
    ? repository?.error ?? 'Choose an available registered repository.'
    : currentCheckouts?.error
      ? currentCheckouts.error
      : !currentCheckouts
        ? 'Loading existing checkouts…'
        : !checkout
          ? selection.path ? 'The selected folder is not in this repository’s checkout list.' : 'No existing checkouts found.'
          : checkout.unavailableReason ?? (!branchName || !checkout.headSha
            ? 'Select a checkout on a named branch with a committed HEAD.' : undefined);
  const canInspect = !closed && !selectionError && !duplicate && Boolean(comparisonRef);
  const inspectionKey = JSON.stringify([checkoutKey, worktreePath, branchName, comparisonType, comparisonRef]);
  const currentInspection = canInspect && inspectionResult?.key === inspectionKey ? inspectionResult : undefined;
  const locked = picking || submitting || closed;
  const disabledReason = locked
    ? picking ? 'Choosing a checkout…' : submitting ? 'Opening task…' : 'Panel closed.'
    : duplicate ? undefined : selectionError ?? (!title.trim()
      ? 'Enter a task title.' : !comparisonRef ? 'Enter a comparison branch or commit.' : undefined);

  useEffect(() => {
    lifecycle.current += 1;
    return () => { lifecycle.current += 1; };
  }, []);

  useEffect(() => {
    const resizeForViewport = () => {
      setViewportWidth(window.innerWidth);
      onResize?.();
    };
    window.addEventListener('resize', resizeForViewport);
    return () => window.removeEventListener('resize', resizeForViewport);
  }, [onResize]);

  useLayoutEffect(() => {
    slideoverRef.current?.style.setProperty('--slideover-width', `${panelWidth}px`);
  }, [panelWidth]);

  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: titleInputRef,
    fallbackReturnFocusRef,
    busy: submitting,
    trapFocus: false,
    onClose: close,
    returnFocus: returnFocusRef?.current,
    shouldReturnFocus: () => returnFocusAfterClose.current
  });

  useEffect(() => {
    if (!repositoryAvailable || closed) return;
    let active = true;
    const generation = lifecycle.current;
    void taskManagerApi.listExistingWorktrees(repositoryId).then(
      (nextOptions) => {
        if (active && generation === lifecycle.current) {
          setCheckoutResult({ key: checkoutKey, options: nextOptions });
          setSelection((current) => {
            const selected = current.path
              ? nextOptions.find((candidate) => candidate.worktreePath === current.path)
              : nextOptions.find((candidate) => !candidate.unavailableReason && candidate.branchName && candidate.headSha) ?? nextOptions[0];
            return selected && !current.comparison
              ? { path: selected.worktreePath, comparison: suggestedComparison({ branch: repositoryBranch }, selected) }
              : current;
          });
        }
      },
      (caught: unknown) => {
        if (active && generation === lifecycle.current) {
          setCheckoutResult({ key: checkoutKey, options: [], error: errorMessage(caught) });
        }
      }
    );
    return () => { active = false; };
  }, [checkoutKey, repositoryId, repositoryBranch, repositoryAvailable, closed]);

  useEffect(() => {
    if (!canInspect) return;
    let active = true;
    const generation = lifecycle.current;
    // Wait for comparison edits to settle before asking Git to inspect again.
    const timer = window.setTimeout(() => {
      void taskManagerApi.inspectWorktreeImport({
        repositoryId, worktreePath, branchName,
        comparison: { type: comparisonType, ref: comparisonRef }
      }).then(
        (inspection) => {
          if (active && generation === lifecycle.current) {
            setInspectionResult({ key: inspectionKey, inspection });
          }
        },
        (caught: unknown) => {
          if (active && generation === lifecycle.current) {
            setInspectionResult({ key: inspectionKey, error: errorMessage(caught) });
          }
        }
      );
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [canInspect, inspectionKey, repositoryId, worktreePath, branchName, comparisonType, comparisonRef]);

  function edited() {
    creation.current = undefined;
    setImportedTask(undefined);
    setError(undefined);
  }

  function selectRepository(id: string, path = '') {
    if (id === repositoryId && !path) return;
    edited();
    setRepositoryId(id);
    setSelection({ path });
    if (id === repositoryId) setRefresh((value) => value + 1);
  }

  function close() {
    if (closed || submitting) return;
    lifecycle.current += 1;
    setClosed(true);
    onClose();
  }

  async function chooseFolder() {
    if (pending.current || closed) return;
    pending.current = true;
    setPicking(true);
    setError(undefined);
    const generation = lifecycle.current;
    try {
      const path = await taskManagerApi.chooseRepositoryFolder();
      if (!path || generation !== lifecycle.current) return;
      const knownCheckout = options.find((candidate) => candidate.worktreePath === path);
      const knownRepository = availableRepositories.find((candidate) => candidate.path === path);
      if (knownCheckout) {
        selectRepository(repositoryId, path);
      } else if (knownRepository) {
        selectRepository(knownRepository.id, path);
      } else {
        const added = await (onAddRepository ?? taskManagerApi.addRepository)(path);
        if (generation !== lifecycle.current) return;
        setAddedRepository(added);
        selectRepository(added.id, added.path);
      }
    } catch (caught) {
      if (generation === lifecycle.current) setError(`Could not select the checkout. ${errorMessage(caught)}`);
    } finally {
      if (generation === lifecycle.current) {
        pending.current = false;
        setPicking(false);
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || disabledReason) return;
    pending.current = true;
    setSubmitting(true);
    setError(undefined);
    const generation = lifecycle.current;
    let taskToOpen = duplicate;
    try {
      if (!taskToOpen) {
        const input = {
          repositoryId, worktreePath, branchName,
          comparison: { type: comparisonType, ref: comparisonRef },
          title: title.trim(), prompt: prompt.trim() || undefined, readyForReview
        };
        const key = JSON.stringify(input);
        if (creation.current?.key !== key) creation.current = { key, token: crypto.randomUUID() };
        const result = await taskManagerApi.importTask({ ...input, creationToken: creation.current.token });
        if (generation !== lifecycle.current) return;
        taskToOpen = result.task;
        setImportedTask(taskToOpen);
      }
      returnFocusAfterClose.current = false;
      await onImported(taskToOpen.id);
    } catch (caught) {
      if (generation === lifecycle.current) {
        returnFocusAfterClose.current = true;
        setError(`${taskToOpen ? 'Could not open the task.' : 'Could not import the checkout.'} ${errorMessage(caught)}`);
      }
    } finally {
      if (generation === lifecycle.current) {
        pending.current = false;
        setSubmitting(false);
      }
    }
  }

  return (
    <div ref={slideoverRef} className={`slideover${closed ? ' slideover--closing' : ''}`}>
      <form
        ref={panelRef}
        id="import-task-panel-content"
        className="slideover__panel"
        aria-label="Import existing work"
        tabIndex={-1}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!disabledReason) event.currentTarget.requestSubmit();
          }
        }}
      >
        <PanelResizeHandle
          className="slideover__resize"
          label="Resize import task panel"
          value={panelWidth}
          min={panelWidthBounds.min}
          max={panelWidthBounds.max}
          defaultValue={DEFAULT_NEW_TASK_PANEL_WIDTH}
          direction={-1}
          controls="import-task-panel-content"
          onChange={(width) => {
            setRequestedWidth(clampNewTaskPanelWidth(width, viewportWidth));
            onResize?.();
          }}
        />
        <header className="slideover__header">
          <div className="slideover__heading"><strong>Import existing work</strong></div>
          <button type="button" className="slideover__close" aria-label="Close" title="Close" disabled={submitting} onClick={close}>
            <X aria-hidden="true" size={16} strokeWidth={1.5} />
          </button>
        </header>
        <div className="slideover__body">
          <section className="newtask-section" aria-label="Existing checkout">
            <fieldset className="field tm-newtask-repository">
              <legend>Repository</legend>
              <RepositorySelect
                options={buildRepositoryOptions({ repositories: availableRepositories, tasks: [] })}
                selectedId={repositoryId}
                ariaLabel="Import repository"
                disabled={locked}
                onChange={(id) => selectRepository(id)}
              />
            </fieldset>
            <button type="button" className="outline-button" disabled={locked} aria-busy={picking} onClick={() => void chooseFolder()}>
              <FolderOpen aria-hidden="true" size={16} strokeWidth={1.5} />
              {picking ? 'Choosing folder…' : 'Choose checkout folder'}
            </button>
            <label className="field">
              <span>Existing checkout</span>
              <select
                aria-label="Existing checkout"
                aria-describedby={checkout ? `${id}-checkout-path` : undefined}
                value={worktreePath}
                disabled={locked || !repositoryAvailable || !options.length}
                title={selectionError}
                onChange={(event) => {
                  edited();
                  const selected = options.find((candidate) => candidate.worktreePath === event.target.value);
                  setSelection({ path: event.target.value, comparison: suggestedComparison(repository, selected) });
                }}
              >
                {!checkout ? <option value="">Select an existing checkout</option> : null}
                {options.map((option) => (
                  <option key={option.worktreePath} value={option.worktreePath}>
                    {option.branchName ?? 'No named branch'} · {option.worktreePath}{option.unavailableReason ? ' · Unavailable' : ''}
                  </option>
                ))}
              </select>
              {checkout ? <small id={`${id}-checkout-path`} title={worktreePath}>{branchName || 'No named branch'} · {worktreePath}</small> : null}
            </label>
            {selectionError ? <p className="form-warning" role="status">{selectionError}</p> : null}
            {repositoryAvailable ? (
              <button type="button" className="outline-button" disabled={locked || !currentCheckouts} onClick={() => setRefresh((value) => value + 1)}>
                Refresh checkouts
              </button>
            ) : null}
          </section>
          {duplicate ? (
            <div className="field" role="status">
              <strong>{duplicate.title}</strong>
              <small>{duplicate.workflowPhase === 'ARCHIVED'
                ? 'This task is archived. Open it to restore it.' : 'This checkout is already attached to a task.'}</small>
            </div>
          ) : (
            <section className="newtask-section" aria-label="Import details">
              <label className="field">
                <span>Title</span>
                <input ref={titleInputRef} value={title} disabled={locked} placeholder="Short task summary" onChange={(event) => { edited(); setTitle(event.target.value); }} />
              </label>
              <label className="field">
                <span>Context (optional)</span>
                <textarea value={prompt} disabled={locked} placeholder="What is this work about?" onChange={(event) => { edited(); setPrompt(event.target.value); }} />
              </label>
              <div className="field-grid field-grid--two">
                <label className="field">
                  <span>Comparison</span>
                  <select value={comparisonType} disabled={locked || !checkout} onChange={(event) => {
                    edited();
                    const type = event.target.value as WorktreeComparison['type'];
                    setSelection({ ...selection, comparison: { type, ref: type === 'COMMIT' ? checkout?.headSha ?? '' : repository?.branch !== branchName ? repository?.branch ?? '' : '' } });
                  }}>
                    <option value="MERGE_BASE">Base branch</option>
                    <option value="COMMIT">Selected commit</option>
                  </select>
                </label>
                <label className="field">
                  <span>{comparisonType === 'MERGE_BASE' ? 'Base branch' : 'Comparison commit'}</span>
                  <input value={comparison.ref} disabled={locked || !checkout} maxLength={1024} spellCheck={false} onChange={(event) => {
                    edited(); setSelection({ ...selection, comparison: { type: comparisonType, ref: event.target.value } });
                  }} />
                </label>
              </div>
              <div className="field"><small>{comparisonType === 'COMMIT'
                ? 'Changes since the selected commit, including saved uncommitted files.'
                : 'Changes since the shared ancestor with the base branch, including saved uncommitted files.'}</small></div>
              {canInspect ? (
                <div className="field" role="status" aria-label="Checkout inspection" aria-busy={!currentInspection}>
                  {currentInspection?.inspection ? <>
                    <small>{currentInspection.inspection.stagedCount} staged · {currentInspection.inspection.unstagedCount} unstaged · {currentInspection.inspection.untrackedCount} untracked · {currentInspection.inspection.conflictedCount} conflicted</small>
                    <small>HEAD {currentInspection.inspection.headSha.slice(0, 8)} · Base {currentInspection.inspection.baseSha.slice(0, 8)}</small>
                    {currentInspection.inspection.pullRequest ? <small>
                      <a href={currentInspection.inspection.pullRequest.url} target="_blank" rel="noreferrer">
                        PR #{currentInspection.inspection.pullRequest.number}
                      </a>
                      {' · '}{currentInspection.inspection.pullRequest.baseRefName}
                    </small> : null}
                    {currentInspection.inspection.gitHubError ? <small title={currentInspection.inspection.gitHubError}>GitHub status unavailable.</small> : null}
                    {currentInspection.inspection.operationInProgress ? <small>{currentInspection.inspection.operationInProgress} in progress.</small> : null}
                  </> : currentInspection?.error ? <>
                    <p className="form-warning">Could not inspect current changes. You can retry or import; the checkout will be checked again.</p>
                    <small>{currentInspection.error}</small>
                    <button type="button" className="outline-button" disabled={locked} onClick={() => setRefresh((value) => value + 1)}>Retry inspection</button>
                  </> : <small>Inspecting current changes…</small>}
                </div>
              ) : null}
              <label className="field">
                <span>Initial status</span>
                <select aria-label="Initial status" aria-describedby={`${id}-status-help`} value={readyForReview ? 'REVIEW' : 'IN_PROGRESS'} disabled={locked} onChange={(event) => { edited(); setReadyForReview(event.target.value === 'REVIEW'); }}>
                  <option value="IN_PROGRESS">In Progress</option>
                  <option value="REVIEW">Ready for review</option>
                </select>
                <small id={`${id}-status-help`}>Import keeps the existing checkout and does not start an agent.</small>
              </label>
            </section>
          )}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
        <footer className="slideover__footer">
          <div className="slideover__footer-actions">
            <button type="button" className="outline-button" disabled={submitting} onClick={close}>Cancel</button>
            <button type="submit" className="primary-button" disabled={Boolean(disabledReason)} title={disabledReason} aria-busy={submitting} aria-keyshortcuts="Meta+Enter Control+Enter">
              {submitting ? duplicate ? 'Opening…' : 'Importing…' : duplicate ? 'Open task' : 'Import task'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function suggestedComparison(repository: Pick<Repository, 'branch'> | undefined, checkout: ExistingWorktreeOption | undefined): WorktreeComparison {
  return repository?.branch && repository.branch !== checkout?.branchName
    ? { type: 'MERGE_BASE', ref: repository.branch }
    : { type: 'COMMIT', ref: checkout?.headSha ?? '' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
