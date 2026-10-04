import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesignProjectMenu, DesignReadyMenu } from './DesignActionsMenu';
import { ActionMenu } from './ActionMenu';
import { DiscourseModeMenu } from './DiscourseModeMenu';
import { RepositorySwitcher } from './RepositorySwitcher';

describe('Menu trigger dismissal', () => {
  it.each([
    ['Design options', () => <DesignProjectMenu title="Example" canOpenInFinder canDuplicate canArchive canDelete
      onOpenInFinder={vi.fn()} onDuplicate={vi.fn()} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />],
    ['Ready version options', () => <DesignReadyMenu ordinal={1} isCurrent={false} canRestore canDuplicate
      onRestore={vi.fn()} onDuplicate={vi.fn()} />],
    ['Conversation actions', () => <ActionMenu className="tm-action-menu" label="Conversation actions"
      trigger="Options" items={[{ label: 'Archive', onSelect: vi.fn() }]} />],
    ['Conversation mode', () => <DiscourseModeMenu value="CHAT" disabled={false} onChange={vi.fn()} />],
    ['Repository selection', () => <RepositorySwitcher activeRepositoryId="" options={[]} collapsed={false} adding={false}
      onSelect={vi.fn()} onAddRepository={vi.fn()} onRefreshRepository={vi.fn()}
      onReconnectRepository={vi.fn()} onDisconnectRepository={vi.fn()} />]
  ] as const)('%s closes when its trigger is clicked from the focused menu', async (_name, content) => {
    render(content());
    const trigger = screen.getByRole('button');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    act(() => menu.focus());

    fireEvent(trigger, new MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }));
    act(() => trigger.focus());
    fireEvent.click(trigger);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('focuses the selected delivery choice, navigates with arrow keys, and returns focus on Escape', async () => {
    const onSelect = vi.fn();
    render(<ActionMenu label="Instruction delivery" selection="single" trigger="After run" items={[
      { label: 'Queue after run', pressed: true, onSelect },
      { label: 'Send now', pressed: false, onSelect }
    ]} />);
    const trigger = screen.getByRole('button', { name: 'Instruction delivery' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Queue after run' })));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Send now' })));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(onSelect).not.toHaveBeenCalled();
  });

});
