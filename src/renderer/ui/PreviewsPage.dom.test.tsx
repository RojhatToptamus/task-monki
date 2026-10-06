import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApplicationPreviewInstance } from '../../shared/applicationPreview';
import { PreviewsPage, type PreviewsPageState } from './PreviewsPage';

const api = vi.hoisted(() => ({ listApplicationPreviews: vi.fn(), openApplicationPreview: vi.fn() }));
vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: api }));
const open = vi.fn();
function Workspace() {
  const [state, setState] = useState<PreviewsPageState>({ query: '', filter: 'all' });
  const scrollPosition = useRef(0);
  return <PreviewsPage state={state} onStateChange={setState} scrollPosition={scrollPosition} onOpen={open} onBrowseTasks={vi.fn()} />;
}
const active: ApplicationPreviewInstance = {
  taskId: 'inventory-task', worktreeId: 'inventory-worktree', isCurrentWorktree: true, title: 'Stock alerts', kind: 'task', repositoryName: 'Inventory', branch: 'feature/alerts',
  projectDirectory: '/worktrees/inventory', approvalPending: false,
  status: { name: 'inventory', url: 'http://inventory.localhost', busy: false,
    active: { id: 'serving', type: 'command', state: 'ready', startedAt: '', sources: [] },
    latest: { id: 'failed-update', type: 'command', state: 'failed', startedAt: '', sources: [] } }
};
const stopped: ApplicationPreviewInstance = {
  ...active, taskId: 'design-task', worktreeId: 'design-worktree', title: 'Editor toolbar', kind: 'design', repositoryName: 'Fieldnotes', branch: 'design/toolbar',
  status: { name: 'fieldnotes', busy: false, latest: { id: 'stopped', type: 'static', state: 'stopped', startedAt: '', sources: [] } }
};
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

it('filters real instances, opens the serving attempt after a failed update, and retains the list through a refresh failure', async () => {
  api.listApplicationPreviews.mockResolvedValue([active, stopped]);
  api.openApplicationPreview.mockResolvedValue({ opened: true, url: active.status.url });
  render(<Workspace />);
  await screen.findByRole('button', { name: 'Open preview: Stock alerts' });
  expect(screen.getByText('Update failed')).toBeTruthy();
  expect(screen.getByText('Previous attempt serving')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
  await waitFor(() => expect(api.openApplicationPreview).toHaveBeenCalledWith({ taskId: 'inventory-task', worktreeId: 'inventory-worktree', attemptId: 'serving' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Active' }));
  expect(screen.queryByRole('button', { name: 'Open Design: Editor toolbar' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Active' }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'Inactive' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Open Design: Editor toolbar' }));
  expect(open.mock.calls.at(-1)?.[0]).toEqual(stopped);
  fireEvent.click(screen.getByRole('tab', { name: 'All' }));
  const search = screen.getByRole('searchbox', { name: 'Search previews' });
  fireEvent.change(search, { target: { value: 'missing-preview' } });
  const clear = screen.getByRole('button', { name: 'Clear filters' });
  clear.focus();
  fireEvent.click(clear);
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole('button', { name: 'Open Design: Editor toolbar' })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'feature/alerts' } });
  expect(screen.queryByText('Fieldnotes')).toBeNull();
  api.listApplicationPreviews.mockRejectedValueOnce(new Error('Runtime disconnected'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh previews' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Showing last known status');
  expect(screen.getByText('Inventory')).toBeTruthy();
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('does not start another read after the page closes with a request pending', async () => {
  vi.useFakeTimers();
  let resolve: (value: ApplicationPreviewInstance[]) => void = () => undefined;
  api.listApplicationPreviews.mockReturnValue(new Promise<ApplicationPreviewInstance[]>(done => { resolve = done; }));
  const view = render(<Workspace />);
  expect(api.listApplicationPreviews).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { resolve([active]); await vi.advanceTimersByTimeAsync(10_000); });
  expect(api.listApplicationPreviews).toHaveBeenCalledTimes(1);
});

it('opens the selected earlier worktree without substituting the task’s current preview', async () => {
  const earlier: ApplicationPreviewInstance = {
    ...active, worktreeId: 'earlier-worktree', isCurrentWorktree: false, branch: 'earlier/alerts',
    status: { ...active.status, active: { ...active.status.active!, id: 'earlier-serving' } }
  };
  api.listApplicationPreviews.mockResolvedValue([active, earlier]);
  api.openApplicationPreview.mockResolvedValue({ opened: true, url: earlier.status.url });
  render(<Workspace />);
  const identity = await screen.findByRole('button', { name: 'Open task: Stock alerts (earlier/alerts)' });
  fireEvent.click(within(identity.closest('tr')!).getByRole('button', { name: 'Open app' }));
  await waitFor(() => expect(api.openApplicationPreview).toHaveBeenCalledWith({
    taskId: 'inventory-task', worktreeId: 'earlier-worktree', attemptId: 'earlier-serving'
  }));
  fireEvent.click(identity);
  expect(open.mock.calls.at(-1)?.[0]).toEqual(earlier);
});


it('restores the exact row after returning to a delayed inventory without stealing focus from another control', async () => {
  const earlier: ApplicationPreviewInstance = {
    ...active, worktreeId: 'earlier-worktree', isCurrentWorktree: false, branch: 'earlier/alerts'
  };
  const instances = [active, earlier];
  let finishRead: (value: ApplicationPreviewInstance[]) => void = () => undefined;
  api.listApplicationPreviews.mockResolvedValueOnce(instances).mockImplementation(
    () => new Promise<ApplicationPreviewInstance[]>(resolve => { finishRead = resolve; })
  );
  function NavigableWorkspace() {
    const [state, setState] = useState<PreviewsPageState>({ query: '', filter: 'all' });
    const [detail, setDetail] = useState(false);
    const scrollPosition = useRef(0);
    const root = useRef<HTMLDivElement>(null);
    return <div className="app-shell" ref={root} tabIndex={-1}>
      {detail ? <button onClick={() => { setDetail(false); root.current?.focus(); }}>Back</button>
        : <PreviewsPage state={state} onStateChange={setState} scrollPosition={scrollPosition}
          onOpen={() => setDetail(true)} onBrowseTasks={vi.fn()} />}
    </div>;
  }
  render(<NavigableWorkspace />);
  const name = 'Open task: Stock alerts (earlier/alerts)';
  fireEvent.click(await screen.findByRole('button', { name }));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.queryByRole('button', { name })).toBeNull();
  await act(async () => finishRead(instances));
  expect(document.activeElement).toBe(screen.getByRole('button', { name }));

  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  const search = screen.getByRole('searchbox', { name: 'Search previews' });
  search.focus();
  await act(async () => finishRead(instances));
  expect(document.activeElement).toBe(search);
});
