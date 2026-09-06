import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExistingWorktreeOption,
  ImportTaskResult,
  Repository,
  TaskManagerApi,
  WorktreeImportInspection
} from '../../shared/contracts';
import { makeTaskRecord } from '../../testSupport/rendererRecords';
import { ImportTaskPanel, type ImportTaskPanelProps } from './ImportTaskPanel';

const api = vi.hoisted(() => ({
  listExistingWorktrees: vi.fn<TaskManagerApi['listExistingWorktrees']>(),
  inspectWorktreeImport: vi.fn<TaskManagerApi['inspectWorktreeImport']>(),
  importTask: vi.fn<TaskManagerApi['importTask']>(),
  chooseRepositoryFolder: vi.fn<TaskManagerApi['chooseRepositoryFolder']>(),
  addRepository: vi.fn<TaskManagerApi['addRepository']>()
}));

vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: api }));

const repository: Repository = {
  id: 'repo-1', kind: 'USER_REGISTERED', name: 'Project', path: '/tmp/project',
  branch: 'main', status: 'AVAILABLE', remotes: [],
  createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z'
};
const feature: ExistingWorktreeOption = {
  worktreePath: '/tmp/external-feature', branchName: 'feature', headSha: 'a'.repeat(40)
};
const primary: ExistingWorktreeOption = {
  worktreePath: repository.path, branchName: 'main', headSha: 'b'.repeat(40)
};
const inspection: WorktreeImportInspection = {
  worktreePath: feature.worktreePath, branchName: feature.branchName!, headSha: feature.headSha!,
  baseRef: 'main', baseSha: 'c'.repeat(40),
  stagedCount: 1, unstagedCount: 2, untrackedCount: 3, conflictedCount: 0
};
const imported: ImportTaskResult = {
  task: makeTaskRecord({ id: 'imported-task', title: 'Existing work', workflowPhase: 'IN_PROGRESS' }),
  existing: false
};

beforeEach(() => {
  vi.resetAllMocks();
  api.listExistingWorktrees.mockResolvedValue([feature, primary]);
  api.inspectWorktreeImport.mockResolvedValue(inspection);
  api.importTask.mockResolvedValue(imported);
  api.chooseRepositoryFolder.mockResolvedValue(undefined);
  api.addRepository.mockResolvedValue(repository);
});

describe('mounted ImportTaskPanel', () => {
  it('imports the selected existing checkout and explicit readiness with its observed dirty counts and PR', async () => {
    api.inspectWorktreeImport.mockResolvedValue({
      ...inspection, pullRequest: { number: 42, url: 'https://github.com/example/project/pull/42', baseRefName: 'release' }
    });
    const { onImported } = renderPanel();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Title' }));
    await checkoutsLoaded();
    expect(screen.getByRole('option', { name: /feature · \/tmp\/external-feature/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Initial status' }).getAttribute('disabled')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Initial status' }) as HTMLSelectElement).value).toBe('IN_PROGRESS');
    expect(await screen.findByText('1 staged · 2 unstaged · 3 untracked · 0 conflicted')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'PR #42' }).getAttribute('href')).toBe('https://github.com/example/project/pull/42');
    expect((screen.getByRole('textbox', { name: 'Base branch' }) as HTMLInputElement).value).toBe('main');
    change('Title', '  Existing work  ');
    change('Context (optional)', '  Continue the external implementation.  ');
    select('Initial status', 'REVIEW');
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(imported.task.id));
    expect(api.importTask).toHaveBeenCalledExactlyOnceWith({
      repositoryId: repository.id, worktreePath: feature.worktreePath, branchName: 'feature',
      comparison: { type: 'MERGE_BASE', ref: 'main' }, title: 'Existing work',
      prompt: 'Continue the external implementation.', readyForReview: true,
      creationToken: expect.stringMatching(/^[0-9a-f-]{36}$/u)
    });
  });

  it('anchors default-branch work to the selected HEAD and keeps an edited comparison when inspection finishes', async () => {
    api.listExistingWorktrees.mockResolvedValue([primary]);
    const pendingInspection = deferred<WorktreeImportInspection>();
    api.inspectWorktreeImport.mockReturnValue(pendingInspection.promise);
    renderPanel();
    await checkoutsLoaded(primary.worktreePath);
    expect((screen.getByRole('textbox', { name: 'Comparison commit' }) as HTMLInputElement).value).toBe(primary.headSha);
    change('Comparison commit', 'release~2');
    await waitFor(() => expect(api.inspectWorktreeImport).toHaveBeenCalledWith(expect.objectContaining({ comparison: { type: 'COMMIT', ref: 'release~2' } })));
    await act(async () => pendingInspection.resolve({
      ...inspection, worktreePath: primary.worktreePath, branchName: 'main',
      pullRequest: { number: 7, url: 'https://github.com/example/project/pull/7', baseRefName: 'release' }
    }));
    expect((screen.getByRole('textbox', { name: 'Comparison commit' }) as HTMLInputElement).value).toBe('release~2');
    change('Title', 'Unfinished main work');
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await waitFor(() => expect(api.importTask).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: primary.worktreePath, branchName: 'main', readyForReview: false,
      comparison: { type: 'COMMIT', ref: 'release~2' }, prompt: undefined
    })));
  });

  it('reuses the creation token after an ambiguous failure, prevents concurrent submits, and replaces it after edits', async () => {
    const first = deferred<ImportTaskResult>();
    api.importTask.mockReturnValueOnce(first.promise).mockRejectedValue(new Error('Connection lost'));
    renderPanel();
    await checkoutsLoaded();
    change('Title', 'Existing work');
    fireEvent.submit(screen.getByRole('form', { name: 'Import existing work' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Import existing work' }));
    expect(api.importTask).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Importing…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).disabled).toBe(true);
    await act(async () => first.reject(new Error('Connection lost')));
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await screen.findByRole('alert');
    expect(api.importTask.mock.calls[1]![0]).toEqual(api.importTask.mock.calls[0]![0]);
    change('Title', 'Changed work');
    change('Title', 'Existing work');
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await screen.findByRole('alert');
    expect(api.importTask.mock.calls[2]![0].creationToken).not.toBe(api.importTask.mock.calls[0]![0].creationToken);
    select('Existing checkout', primary.worktreePath);
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await screen.findByRole('alert');
    expect(api.importTask.mock.calls[3]![0]).toEqual(expect.objectContaining({
      worktreePath: primary.worktreePath, comparison: { type: 'COMMIT', ref: primary.headSha }
    }));
    expect(api.importTask.mock.calls[3]![0].creationToken).not.toBe(api.importTask.mock.calls[2]![0].creationToken);
  });

  it('preserves the selected checkout, commit anchor, and unchanged retry when refresh observes a new HEAD and ordering', async () => {
    api.listExistingWorktrees.mockResolvedValueOnce([primary, feature]).mockResolvedValue([feature, { ...primary, headSha: 'd'.repeat(40) }]);
    api.importTask.mockRejectedValue(new Error('Connection lost'));
    renderPanel();
    await checkoutsLoaded(primary.worktreePath);
    change('Title', 'Existing work');
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh checkouts' }));
    await checkoutsLoaded(primary.worktreePath);
    expect((screen.getByRole('textbox', { name: 'Comparison commit' }) as HTMLInputElement).value).toBe(primary.headSha);
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await waitFor(() => expect(api.importTask).toHaveBeenCalledTimes(2));
    expect(api.importTask.mock.calls[1]![0]).toEqual(api.importTask.mock.calls[0]![0]);
  });

  it.each(['IN_PROGRESS', 'ARCHIVED'] as const)('opens a known %s duplicate without importing or requiring a title', async (workflowPhase) => {
    api.listExistingWorktrees.mockResolvedValue([{ ...feature, existingTask: { id: 'existing-task', title: 'Earlier work', workflowPhase } }]);
    const { onImported } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Open task' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('existing-task'));
    expect(api.importTask).not.toHaveBeenCalled();
    expect(api.inspectWorktreeImport).not.toHaveBeenCalled();
    if (workflowPhase === 'ARCHIVED') expect(screen.getByText('This task is archived. Open it to restore it.')).toBeTruthy();
  });

  it('retains an acknowledged import when opening fails, so retry only opens the task', async () => {
    api.importTask.mockResolvedValue({ ...imported, existing: true });
    const onImported = vi.fn().mockRejectedValueOnce(new Error('Detail reload failed')).mockResolvedValue(undefined);
    renderPanel({ onImported });
    await checkoutsLoaded();
    change('Title', 'Existing work');
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not open the task.');
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(2));
    expect(onImported).toHaveBeenLastCalledWith(imported.task.id);
    expect(api.importTask).toHaveBeenCalledOnce();
  });

  it('discards late repository and checkout inspections after selection changes, including StrictMode cleanup', async () => {
    const firstList = deferred<ExistingWorktreeOption[]>();
    const oldInspection = deferred<WorktreeImportInspection>();
    const otherRepository = { ...repository, id: 'repo-2', name: 'Second', path: '/tmp/second' };
    api.listExistingWorktrees.mockImplementation((id) => id === repository.id ? firstList.promise : Promise.resolve([feature, primary]));
    api.inspectWorktreeImport.mockReturnValueOnce(oldInspection.promise).mockResolvedValue({ ...inspection, stagedCount: 8 });
    const props = panelProps({ repositories: [repository, otherRepository] });
    render(<StrictMode><ImportTaskPanel {...props} /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: /^Import repository:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Second, /tmp/second' }));
    await checkoutsLoaded();
    await waitFor(() => expect(api.inspectWorktreeImport).toHaveBeenCalledOnce());
    select('Existing checkout', primary.worktreePath);
    expect(screen.queryByText('1 staged · 2 unstaged · 3 untracked · 0 conflicted')).toBeNull();
    await screen.findByText('8 staged · 2 unstaged · 3 untracked · 0 conflicted');
    await act(async () => {
      firstList.resolve([{ ...primary, worktreePath: '/tmp/obsolete' }]);
      oldInspection.resolve({ ...inspection, stagedCount: 99 });
    });
    expect((screen.getByRole('combobox', { name: 'Existing checkout' }) as HTMLSelectElement).value).toBe(primary.worktreePath);
    expect(screen.queryByRole('option', { name: /obsolete/ })).toBeNull();
    expect(screen.queryByText(/99 staged/)).toBeNull();
    change('Title', 'Selected checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await waitFor(() => expect(api.importTask).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: 'repo-2', worktreePath: primary.worktreePath })));
  });

  it('shows list errors and unavailable identity reasons, and never substitutes another checkout when a chosen path disappears', async () => {
    api.listExistingWorktrees.mockRejectedValueOnce(new Error('Repository temporarily missing'))
      .mockResolvedValueOnce([{ ...feature, unavailableReason: 'Checkout branch changed.' }, primary])
      .mockResolvedValueOnce([primary]);
    renderPanel();
    change('Title', 'Existing work');
    await screen.findByText('Repository temporarily missing');
    expect((screen.getByRole('button', { name: 'Import task' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh checkouts' }));
    await checkoutsLoaded(primary.worktreePath);
    select('Existing checkout', feature.worktreePath);
    expect(screen.getByText('Checkout branch changed.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Import task' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Import existing work' }));
    expect(api.importTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh checkouts' }));
    await screen.findByText('The selected folder is not in this repository’s checkout list.');
    expect((screen.getByRole('combobox', { name: 'Existing checkout' }) as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Import task' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['inspection', 'github'] as const)('keeps local import available when %s observation fails', async (failure) => {
    if (failure === 'inspection') api.inspectWorktreeImport.mockRejectedValue(new Error('Source changed during inspection'));
    else api.inspectWorktreeImport.mockResolvedValue({ ...inspection, gitHubError: 'GitHub authentication required' });
    const { onImported } = renderPanel();
    await checkoutsLoaded();
    change('Title', 'Work still in progress');
    if (failure === 'inspection') await screen.findByText('Source changed during inspection');
    else await screen.findByText('GitHub status unavailable.');
    expect((screen.getByRole('button', { name: 'Import task' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(imported.task.id));
  });

  it('registers a picked folder through the callback and selects its canonical checkout, even before parent refresh', async () => {
    const pickedRepository = { ...repository, id: 'picked', path: '/tmp/picked', branch: 'chosen' };
    const pickedCheckout = { ...feature, worktreePath: pickedRepository.path, branchName: 'chosen' };
    api.chooseRepositoryFolder.mockResolvedValue('/tmp/picked-alias');
    const onAddRepository = vi.fn(async () => pickedRepository);
    api.listExistingWorktrees.mockImplementation(async (id) => id === 'picked' ? [primary, pickedCheckout] : [feature]);
    renderPanel({ onAddRepository });
    await checkoutsLoaded();
    change('Title', 'Preserved title');
    fireEvent.click(screen.getByRole('button', { name: 'Choose checkout folder' }));
    await checkoutsLoaded(pickedRepository.path);
    expect(onAddRepository).toHaveBeenCalledExactlyOnceWith('/tmp/picked-alias');
    expect(api.addRepository).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Preserved title');
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await waitFor(() => expect(api.importTask).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'picked', worktreePath: '/tmp/picked', branchName: 'chosen',
      comparison: { type: 'COMMIT', ref: pickedCheckout.headSha }
    })));
  });

  it('supports an empty repository list through the API fallback and preserves the form when the picker is canceled', async () => {
    const props = panelProps({ repositories: [] });
    render(<ImportTaskPanel {...props} />);
    expect(screen.getByText('Choose an available registered repository.')).toBeTruthy();
    change('Title', 'Unregistered work');
    fireEvent.click(screen.getByRole('button', { name: 'Choose checkout folder' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Choose checkout folder' }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.addRepository).not.toHaveBeenCalled();
    api.chooseRepositoryFolder.mockResolvedValue(primary.worktreePath);
    fireEvent.click(screen.getByRole('button', { name: 'Choose checkout folder' }));
    await checkoutsLoaded(primary.worktreePath);
    expect(api.addRepository).toHaveBeenCalledExactlyOnceWith(primary.worktreePath);
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Unregistered work');
  });

  it('ignores a late picker result after Escape closes the panel, without registering a repository', async () => {
    const picker = deferred<string | undefined>();
    api.chooseRepositoryFolder.mockReturnValue(picker.promise);
    const { onClose, onAddRepository } = renderPanel({ onAddRepository: vi.fn(async () => repository) });
    fireEvent.click(screen.getByRole('button', { name: 'Choose checkout folder' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => picker.resolve('/tmp/new-checkout'));
    expect(onAddRepository).not.toHaveBeenCalled();
    expect(api.addRepository).not.toHaveBeenCalled();
  });

  it('returns focus to the entry point on close and exposes the shared keyboard resize contract', async () => {
    const entryRef = createRef<HTMLButtonElement>();
    const fallbackRef = createRef<HTMLDivElement>();
    const onResize = vi.fn();
    const onClose = vi.fn();
    const props = panelProps({ onClose, onResize, returnFocusRef: entryRef, fallbackReturnFocusRef: fallbackRef });
    const view = render(<>
      <button ref={entryRef}>Import entry point</button>
      <div ref={fallbackRef} tabIndex={-1}>Workspace</div>
      <ImportTaskPanel {...props} />
    </>);
    const handle = screen.getByRole('separator', { name: 'Resize import task panel' });
    expect(handle.getAttribute('aria-valuenow')).toBe('520');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('536');
    expect(onResize).toHaveBeenCalledOnce();
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuenow')).toBe(handle.getAttribute('aria-valuemax'));
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<><button ref={entryRef}>Import entry point</button><div ref={fallbackRef} tabIndex={-1}>Workspace</div></>);
    await waitFor(() => expect(document.activeElement).toBe(entryRef.current));
  });

  it('uses the fallback when the entry point disappears and preserves task focus after successful import', async () => {
    const detachedEntry = document.createElement('button');
    const fallbackRef = createRef<HTMLButtonElement>();
    const props = panelProps({ returnFocusRef: { current: detachedEntry }, fallbackReturnFocusRef: fallbackRef });
    const view = render(<><button ref={fallbackRef}>Workspace</button><ImportTaskPanel {...props} /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    view.rerender(<button ref={fallbackRef}>Workspace</button>);
    await waitFor(() => expect(document.activeElement).toBe(fallbackRef.current));
    const detailRef = createRef<HTMLButtonElement>();
    const onImported = vi.fn(() => { detailRef.current?.focus(); });
    view.rerender(<>
      <button ref={fallbackRef}>Workspace</button><button ref={detailRef}>Task detail</button>
      <ImportTaskPanel {...props} onImported={onImported} />
    </>);
    await checkoutsLoaded();
    change('Title', 'Existing work');
    fireEvent.click(screen.getByRole('button', { name: 'Import task' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    view.rerender(<><button ref={fallbackRef}>Workspace</button><button ref={detailRef}>Task detail</button></>);
    await act(async () => {});
    expect(document.activeElement).toBe(detailRef.current);
  });

  it('submits from the keyboard, respects composition and the repository popup, and ignores completion after unmount', async () => {
    const result = deferred<ImportTaskResult>();
    api.importTask.mockReturnValue(result.promise);
    const { onClose, onImported, unmount } = renderPanel();
    await checkoutsLoaded();
    const repositoryTrigger = screen.getByRole('button', { name: /^Import repository:/ });
    fireEvent.click(repositoryTrigger);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(repositoryTrigger);
    change('Title', 'Keyboard import');
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(api.importTask).not.toHaveBeenCalled();
    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true });
    expect(api.importTask).toHaveBeenCalledOnce();
    unmount();
    await act(async () => result.resolve(imported));
    expect(onImported).not.toHaveBeenCalled();
  });
});

function panelProps(overrides: Partial<ImportTaskPanelProps> = {}): ImportTaskPanelProps {
  return { repositories: [repository], initialRepositoryId: repository.id, onClose: vi.fn(), onImported: vi.fn(), ...overrides };
}

function renderPanel(overrides: Partial<ImportTaskPanelProps> = {}) {
  const props = panelProps(overrides);
  return { ...render(<ImportTaskPanel {...props} />), ...props };
}

async function checkoutsLoaded(path = feature.worktreePath) {
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Existing checkout' }) as HTMLSelectElement).value).toBe(path));
}

function change(name: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
}

function select(name: string, value: string) {
  fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
