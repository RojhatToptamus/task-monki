import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesignProjectMenu, DesignReadyMenu } from './DesignActionsMenu';
import { DiscourseActionMenu } from './DiscourseActionMenu';
import { DiscourseModeMenu } from './DiscourseModeMenu';
import { RepositorySwitcher } from './RepositorySwitcher';

describe('Menu trigger dismissal', () => {
  it.each([
    ['Design options', () => <DesignProjectMenu title="Example" canOpenInFinder canDuplicate canArchive canDelete
      onOpenInFinder={vi.fn()} onDuplicate={vi.fn()} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />],
    ['Ready version options', () => <DesignReadyMenu ordinal={1} isCurrent={false} canRestore canDuplicate
      onRestore={vi.fn()} onDuplicate={vi.fn()} />],
    ['Conversation actions', () => <DiscourseActionMenu className="tm-discourse-menu" label="Conversation actions"
      trigger="Options" items={[{ label: 'Archive', onSelect: vi.fn() }]} />],
    ['Conversation mode', () => <DiscourseModeMenu value="CHAT" disabled={false} onChange={vi.fn()} />],
    ['Repository selection', () => <RepositorySwitcher activeRepositoryId="" options={[]} collapsed={false} adding={false}
      onSelect={vi.fn()} onAddRepository={vi.fn()} onRefreshRepository={vi.fn()}
      onReconnectRepository={vi.fn()} onDisconnectRepository={vi.fn()} />]
  ] as const)('%s closes when its trigger is clicked from the focused menu', async (_name, content) => {
    render(content());
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    act(() => menu.focus());

    fireEvent.pointerDown(trigger);
    act(() => trigger.focus());
    fireEvent.click(trigger);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});
