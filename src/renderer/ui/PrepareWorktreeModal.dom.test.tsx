import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WorktreePreparationCreateInspection } from '../../shared/contracts';
import { PrepareWorktreeModal } from './AppOverlays';

const inspection: WorktreePreparationCreateInspection = {
  mode: 'CREATE', taskId: 'task-1', repositoryName: 'Backend',
  bases: [
    { refName: 'refs/heads/main', displayName: 'main', sha: 'a'.repeat(40), current: true },
    { refName: 'refs/heads/feature', displayName: 'feature', sha: 'b'.repeat(40), current: false }
  ]
};

describe('Worktree preparation confirmation', () => {
  it('focuses the base choice, shows the chosen commit, and requires an explicit submit', async () => {
    const onConfirm = vi.fn();
    const onSelectBase = vi.fn();
    const props = {
      inspection, taskTitle: 'Backend changes', selectedBaseRef: 'refs/heads/main', busy: false,
      onConfirm, onSelectBase, onCancel: vi.fn(), fallbackReturnFocusRef: createRef<HTMLElement>()
    };
    const view = render(<PrepareWorktreeModal {...props} />);
    const select = screen.getByRole('combobox', { name: 'Base branch' });
    await waitFor(() => expect(document.activeElement).toBe(select));
    fireEvent.change(select, { target: { value: 'refs/heads/feature' } });
    expect(onSelectBase).toHaveBeenCalledWith('refs/heads/feature');
    expect(onConfirm).not.toHaveBeenCalled();
    view.rerender(<PrepareWorktreeModal {...props} selectedBaseRef="refs/heads/feature" />);
    expect(screen.getByText('b'.repeat(40))).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare worktree' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('blocks dismissal and repeated submission during preparation, then permits retry with the failure visible', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const props = {
      inspection, taskTitle: 'Backend changes', selectedBaseRef: 'refs/heads/main', busy: true,
      onConfirm, onCancel, onSelectBase: vi.fn(), fallbackReturnFocusRef: createRef<HTMLElement>()
    };
    const view = render(<PrepareWorktreeModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preparing…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    view.rerender(<PrepareWorktreeModal {...props} busy={false} error="Selected branch moved. Review the new commit." />);
    expect(screen.getByRole('alert').textContent).toContain('Selected branch moved');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare worktree' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
