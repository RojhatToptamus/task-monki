import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenTargetInspection } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { TaskActionsMenu } from './TaskActionsMenu';

const inspection: OpenTargetInspection = {
  target: { type: 'repository', kind: 'directory' },
  apps: [{ id: 'vscode', label: 'VS Code' }, { id: 'default', label: 'Default app' }],
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
  render(
    <div className="app-shell" data-input-modality="keyboard">
      <div role="region" aria-label="Task column">
        <TaskActionsMenu
          taskId="task-1"
          title="Example task"
          archived={false}
          openTarget={{ type: 'repository', repositoryId: 'repository-1' }}
          onArchive={onArchive}
          onRequestDelete={vi.fn()}
        />
      </div>
      <button type="button">Outside</button>
    </div>
  );
  return { trigger: screen.getByRole('button', { name: 'Task options for Example task' }), onArchive };
}

describe('Task actions menu', () => {
  it('opens immediately and keeps task actions usable while path inspection is pending', () => {
    vi.spyOn(taskManagerApi, 'inspectOpenTarget').mockReturnValue(new Promise(() => undefined));
    const { trigger, onArchive } = renderMenu();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Loading...')).toBeTruthy();
    expect(document.activeElement).toBe(menu);

    const archive = within(menu).getByRole('menuitem', { name: 'Archive' });
    fireEvent.pointerDown(archive);
    expect(screen.getByRole('menu')).toBe(menu);
    fireEvent.click(archive);
    expect(onArchive).toHaveBeenCalledWith('task-1');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the keyboard selection visible when path items arrive and restores focus on Escape', async () => {
    let resolve!: (result: OpenTargetInspection) => void;
    vi.spyOn(taskManagerApi, 'inspectOpenTarget').mockReturnValue(new Promise(done => { resolve = done; }));
    const { trigger } = renderMenu();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    const lastItem = screen.getByRole('menuitem', { name: 'Delete...' });
    const menu = screen.getByRole('menu');
    Object.defineProperties(menu, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 }
    });
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(lastItem, 'getBoundingClientRect').mockReturnValue({ top: 370, bottom: 400 } as DOMRect);
    expect(document.activeElement).toBe(lastItem);
    await act(async () => resolve(inspection));
    expect(screen.getByRole('menuitem', { name: 'Open in VS Code' })).toBeTruthy();
    expect(document.activeElement).toBe(lastItem);
    expect(menu.scrollTop).toBe(200);
    fireEvent.keyDown(lastItem, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('dismisses on anchor scroll and resize but allows scrolling the menu itself', async () => {
    vi.spyOn(taskManagerApi, 'inspectOpenTarget').mockResolvedValue(inspection);
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    await screen.findByRole('menuitem', { name: 'Open in VS Code' });
    fireEvent.scroll(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.scroll(screen.getByRole('region', { name: 'Task column' }));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    await screen.findByRole('menuitem', { name: 'Open in VS Code' });
    fireEvent.resize(window);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('reveals keyboard-selected items inside a short menu without scrolling the task column', async () => {
    vi.spyOn(taskManagerApi, 'inspectOpenTarget').mockResolvedValue(inspection);
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    const firstItem = await screen.findByRole('menuitem', { name: 'Open in VS Code' });
    const lastItem = screen.getByRole('menuitem', { name: 'Delete...' });
    const menu = screen.getByRole('menu');
    const column = screen.getByRole('region', { name: 'Task column' });
    column.scrollTop = 25;
    Object.defineProperties(menu, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 }
    });
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(firstItem, 'getBoundingClientRect').mockImplementation(() => ({
      top: 100 - menu.scrollTop, bottom: 130 - menu.scrollTop
    } as DOMRect));
    vi.spyOn(lastItem, 'getBoundingClientRect').mockImplementation(() => ({
      top: 370 - menu.scrollTop, bottom: 400 - menu.scrollTop
    } as DOMRect));

    fireEvent.keyDown(firstItem, { key: 'End' });
    expect(document.activeElement).toBe(lastItem);
    expect(menu.scrollTop).toBe(200);
    fireEvent.keyDown(lastItem, { key: 'Home' });
    expect(document.activeElement).toBe(firstItem);
    expect(menu.scrollTop).toBe(0);
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(lastItem);
    expect(menu.scrollTop).toBe(200);
    expect(column.scrollTop).toBe(25);
    expect(screen.getByRole('menu')).toBe(menu);
  });

  it('toggles closed from the focused menu and dismisses an outside pointer click', async () => {
    vi.spyOn(taskManagerApi, 'inspectOpenTarget').mockResolvedValue(inspection);
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    const firstItem = await screen.findByRole('menuitem', { name: 'Open in VS Code' });
    expect(document.activeElement).toBe(firstItem);

    fireEvent.pointerDown(trigger);
    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    await screen.findByRole('menuitem', { name: 'Open in VS Code' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
