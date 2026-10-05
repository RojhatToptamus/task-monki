import { ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ApplicationPreviewInstance } from '../../shared/applicationPreview';
import { taskManagerApi } from '../api/taskManagerClient';
import { applicationPreviewStatus } from '../model/applicationPreviewStatus';
import { visiblePreviewInstances, type PreviewInstanceFilter } from '../model/previewInstances';
import { AccessibleTab } from './AccessibleTabs';
import { Chip } from './StatusBadge';
import { message } from './preview/previewPresentation';

const filters = [
  ['all', 'All'], ['active', 'Active'], ['attention', 'Needs attention'], ['inactive', 'Inactive']
] as const;

export interface PreviewsPageState {
  query: string;
  filter: PreviewInstanceFilter;
  selectedWorktreeId?: string;
}

export function PreviewsPage({ state, onStateChange, scrollPosition, onOpen, onBrowseTasks }: {
  state: PreviewsPageState;
  onStateChange(state: PreviewsPageState): void;
  scrollPosition: RefObject<number>;
  onOpen(instance: ApplicationPreviewInstance, trigger: HTMLElement): void;
  onBrowseTasks(): void;
}) {
  const [instances, setInstances] = useState<ApplicationPreviewInstance[]>();
  const [readError, setReadError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [openingId, setOpeningId] = useState<string>();
  const [actionError, setActionError] = useState<{ worktreeId: string; message: string }>();
  const scroll = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const returnWorktreeId = useRef(state.selectedWorktreeId);
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      if (disposed || inFlight || document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      inFlight = true;
      setReading(true);
      try {
        const result = await taskManagerApi.listApplicationPreviews();
        if (!disposed) {
          setInstances(result);
          setReadError(undefined);
        }
      } catch (error) {
        if (!disposed) setReadError(message(error));
      } finally {
        inFlight = false;
        if (!disposed) {
          setReading(false);
          timer = setTimeout(() => void read(), 2000);
        }
      }
    }
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') void read();
    };
    refresh.current = () => void read();
    void read();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      refresh.current = () => undefined;
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  const loaded = instances !== undefined;
  useLayoutEffect(() => {
    if (!loaded || !scroll.current) return;
    scroll.current.scrollTop = scrollPosition.current;
    const focused = document.activeElement;
    const appRoot = scroll.current.closest('.app-shell');
    if (focused !== document.body && focused !== appRoot) return;
    const target = Array.from(scroll.current.querySelectorAll<HTMLButtonElement>('[data-worktree-id]'))
      .find(button => button.dataset.worktreeId === returnWorktreeId.current);
    target?.focus({ preventScroll: true });
  }, [loaded, scrollPosition]);
  function openOwner(instance: ApplicationPreviewInstance, trigger: HTMLElement) {
    onStateChange({ ...state, selectedWorktreeId: instance.worktreeId });
    onOpen(instance, trigger);
  }
  async function openApp(instance: ApplicationPreviewInstance) {
    if (!instance.status.active || openingId) return;
    setOpeningId(instance.worktreeId);
    setActionError(undefined);
    try {
      await taskManagerApi.openApplicationPreview({ taskId: instance.taskId, worktreeId: instance.worktreeId, attemptId: instance.status.active.id });
    } catch (error) {
      setActionError({ worktreeId: instance.worktreeId, message: message(error) });
    } finally {
      setOpeningId(undefined);
    }
  }
  const visible = visiblePreviewInstances(instances ?? [], state.query, state.filter);
  return (
    <main className="tm-main tm-previews">
      <header className="tm-main__head">
        <div className="tm-main__head-copy">
          <h1 className="tm-main__title">Previews</h1>
          <span className="tm-main__subtitle">Applications across tasks and Designs</span>
        </div>
        <button type="button" className="tm-preview-icon-button" aria-label="Refresh previews" title="Refresh previews"
          disabled={reading} onClick={() => refresh.current()}>
          <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>
      <div className="tm-previews__toolbar">
        <div className="tm-tabs" role="tablist" aria-label="Filter previews">
          {filters.map(([value, label]) => <AccessibleTab key={value} id={`previews-${value}`}
            panelId="previews-list" label={label} selected={state.filter === value}
            onSelect={() => onStateChange({ ...state, filter: value })} />)}
        </div>
        <label className="field field--search">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <input ref={search} type="search" aria-label="Search previews" placeholder="Search previews…"
            value={state.query} onChange={(event) => onStateChange({ ...state, query: event.target.value })} />
        </label>
      </div>
      {readError ? <div className="tm-previews__error" role="alert">
        <span>{readError}{instances?.length ? ' Showing last known status.' : ''}</span>
        <button type="button" className="outline-button" disabled={reading} onClick={() => refresh.current()}>Retry</button>
      </div> : null}
      <div ref={scroll} className="tm-previews__list" id="previews-list" role="tabpanel"
        aria-labelledby={`previews-${state.filter}`}
        onScroll={(event) => { scrollPosition.current = event.currentTarget.scrollTop; }}>
        {!loaded && !readError ? <p className="tm-previews__empty" role="status">Loading previews…</p>
          : !instances?.length && !readError ? <div className="tm-previews__empty">
            <p>Start an application from a task’s Preview tab or a Design.</p>
            <button type="button" className="outline-button" onClick={onBrowseTasks}>View tasks</button>
          </div> : !visible.length && loaded ? <div className="tm-previews__empty">
            <p>No previews match these filters.</p>
            <button type="button" className="outline-button" onClick={() => { onStateChange({ ...state, query: '', filter: 'all' }); search.current?.focus(); }}>Clear filters</button>
          </div> : visible.length ? <table className="tm-previews__table">
            <thead><tr><th scope="col">Project / worktree</th><th scope="col">Status</th><th scope="col"><span className="tm-visually-hidden">Actions</span></th></tr></thead>
            <tbody>{visible.map((instance) => {
              const status = applicationPreviewStatus(instance.status, instance.approvalPending);
              const owner = instance.kind === 'design' ? 'Design' : instance.isCurrentWorktree ? 'preview' : 'task';
              const context = `${instance.title}${instance.isCurrentWorktree ? '' : ` (${instance.branch})`}`;
              return <tr key={instance.worktreeId}>
                <td><button type="button" className="tm-previews__identity" data-task-id={instance.taskId} data-worktree-id={instance.worktreeId}
                  aria-label={`Open ${owner}: ${context}`}
                  title={instance.projectDirectory} onClick={(event) => openOwner(instance, event.currentTarget)}>
                  <span className="tm-previews__project"><span title={instance.repositoryName}>{instance.repositoryName}</span><span className="tm-previews__kind">{!instance.isCurrentWorktree ? 'Earlier worktree' : instance.kind === 'design' ? 'Design' : null}</span></span>
                  <span className="tm-previews__context"><code title={instance.branch}>{instance.branch}</code><span title={instance.title}>{instance.title}</span></span>
                </button></td>
                <td><div className="tm-previews__status"><Chip label={status.label} tone={status.tone} showDot={false} />
                  {status.note ? <span>{status.note}</span> : null}</div></td>
                <td><div className="tm-previews__actions">
                  {instance.status.active && instance.status.url ? <button type="button" className="outline-button"
                    disabled={Boolean(openingId)} onClick={() => void openApp(instance)}>Open app</button> : null}
                  <button type="button" className="tm-preview-icon-button" aria-label={`View ${owner}: ${context}`} title={`View ${owner}`}
                    onClick={(event) => openOwner(instance, event.currentTarget)}><ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" /></button>
                </div>{actionError?.worktreeId === instance.worktreeId ? <p className="form-error" role="alert">{actionError.message}</p> : null}</td>
              </tr>;
            })}</tbody>
          </table> : null}
      </div>
    </main>
  );
}
