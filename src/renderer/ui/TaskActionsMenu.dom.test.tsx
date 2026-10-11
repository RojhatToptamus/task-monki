import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenTargetInspection } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { NotifyProvider } from './NotifyContext';
import { TaskActionsMenu } from './TaskActionsMenu';

const inspection: OpenTargetInspection = {
  target: { type: 'repository', kind: 'directory' },
  apps: [{ id: 'vscode', label: 'VS Code' }, { id: 'cursor', label: 'Cursor' }, { id: 'default', label: 'Default app' }],
  preferredAppId: 'vscode',
  revealLabel: 'Reveal in Finder',
  canOpen: true,
  canReveal: true,
  canOpenTerminal: true,
  canCopyFileContents: false
};

afterEach(() => vi.restoreAllMocks());

function renderMenu() {
  const onArchive = vi.fn();
  const notify = vi.fn();
  render(
    <NotifyProvider value={notify}>
      <TaskActionsMenu
        taskId="task-1"
        title="Example task"
        archived={false}
        openTarget={{ type: 'repository', repositoryId: 'repository-1' }}
        onArchive={onArchive}
        onRequestDelete={vi.fn()}
      />
    </NotifyProvider>
  );
  return { trigger: screen.getByRole('button', { name: 'Task options for Example task' }), onArchive, notify };
}

function openMenu(trigger: HTMLElement) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  return screen.getByRole('menu', { name: 'Task options for Example task' });
}

describe('Task actions menu', () => {
  it('keeps the same rows while the path is inspected, and task actions work meanwhile', async () => {
    vi.spyOn(taskManagerApi, 'inspectOpenTarget').mockReturnValue(new Promise(() => undefined));
    const { trigger, onArchive } = renderMenu();
    const menu = openMenu(trigger);

    expect(within(menu).getByRole('menuitem', { name: 'Open' }).getAttribute('data-disabled')).toBe('');
    expect(within(menu).getByRole('menuitem', { name: 'Open with' }).getAttribute('data-disabled')).toBe('');
    expect(within(menu).queryByRole('img')).toBeNull();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledWith('task-1');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('opens in the preferred editor and lists every editor under Open with', async () => {
    vi.spyOn(taskManagerApi, 'inspectOpenTarget').mockResolvedValue(inspection);
    const execute = vi.spyOn(taskManagerApi, 'executeOpenTargetAction').mockResolvedValue({ ok: true });
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);

    const open = await within(menu).findByRole('menuitem', { name: 'Open' });
    await waitFor(() => expect(open.getAttribute('data-disabled')).toBeNull());
    expect(open.textContent).toContain('VS Code');

    const openWith = within(menu).getByRole('menuitem', { name: 'Open with' });
    openWith.focus();
    fireEvent.keyDown(openWith, { key: 'ArrowRight' });
    const cursor = await screen.findByRole('menuitem', { name: 'Cursor' });
    expect(cursor.closest('[role="menu"]')).not.toBe(menu);
    expect(screen.getByRole('menuitem', { name: 'VS Code' }).textContent).toContain('Default');
    expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeTruthy();

    fireEvent.click(cursor);
    await waitFor(() => expect(execute).toHaveBeenCalledWith({
      target: { type: 'repository', repositoryId: 'repository-1' }, action: 'open', appId: 'cursor'
    }));
  });

  it('reports a failed action through the app notification', async () => {
    vi.spyOn(taskManagerApi, 'inspectOpenTarget').mockResolvedValue(inspection);
    vi.spyOn(taskManagerApi, 'executeOpenTargetAction').mockResolvedValue({ ok: false, message: 'VS Code is not installed.' });
    const { trigger, notify } = renderMenu();
    const menu = openMenu(trigger);
    const open = await within(menu).findByRole('menuitem', { name: 'Open' });
    await waitFor(() => expect(open.getAttribute('data-disabled')).toBeNull());

    fireEvent.click(open);
    await waitFor(() => expect(notify).toHaveBeenCalledWith('VS Code is not installed.', 'error'));
  });
});
