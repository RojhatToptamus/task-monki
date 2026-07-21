import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NavItem } from './AppNavigation';
import { BoardEditorModal } from './AppOverlays';

describe('mounted application shell behavior', () => {
  it('dispatches navigation without duplicating its count in the accessible name', () => {
    const onClick = vi.fn();
    render(
      <NavItem
        label="Inbox"
        icon={<span aria-hidden="true">icon</span>}
        count={2}
        countNoun="decision"
        urgent
        active={false}
        collapsed
        onClick={onClick}
      />
    );

    const item = screen.getByRole('button', { name: 'Inbox' });
    fireEvent.click(item);

    expect(onClick).toHaveBeenCalledOnce();
    expect(item.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('2 decisions')).toBeTruthy();
  });

  it('focuses the saved-view name and closes the modal on Escape', () => {
    const onCancel = vi.fn();
    const fallbackReturnFocusRef = createRef<HTMLElement>();
    render(
      <BoardEditorModal
        repositories={[]}
        onCancel={onCancel}
        onSave={async () => undefined}
        onDelete={async () => undefined}
        fallbackReturnFocusRef={fallbackReturnFocusRef}
      />
    );

    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(document.activeElement);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
