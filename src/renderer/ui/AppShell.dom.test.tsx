import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NavItem } from './AppNavigation';
import { BoardEditorModal, DesignExternalLinkModal } from './AppOverlays';

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

  it('shows only the external host and starts one approval', async () => {
    let finishApproval: ((opened: boolean) => void) | undefined;
    const onCancel = vi.fn();
    const onConfirm = vi.fn(
      () => new Promise<boolean>((resolve) => {
        finishApproval = resolve;
      })
    );
    const fallbackReturnFocusRef = createRef<HTMLElement>();
    render(
      <DesignExternalLinkModal
        destinationHost="example.com"
        onCancel={onCancel}
        onConfirm={onConfirm}
        fallbackReturnFocusRef={fallbackReturnFocusRef}
      />
    );

    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBe(document.activeElement);
    const confirm = screen.getByRole('button', { name: 'Open site' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();

    finishApproval?.(true);
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });

  it('marks an expired external-link request as terminal', async () => {
    const onCancel = vi.fn();
    const fallbackReturnFocusRef = createRef<HTMLElement>();
    render(
      <DesignExternalLinkModal
        destinationHost="expired.example"
        onCancel={onCancel}
        onConfirm={async () => false}
        fallbackReturnFocusRef={fallbackReturnFocusRef}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open site' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This link request expired.'
    );
    expect((screen.getByRole('button', { name: 'Open site' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps the external-link dialog open after an approval error', async () => {
    const fallbackReturnFocusRef = createRef<HTMLElement>();
    render(
      <DesignExternalLinkModal
        destinationHost="example.com"
        onCancel={vi.fn()}
        onConfirm={async () => {
          throw new Error('Could not reach the desktop bridge.');
        }}
        fallbackReturnFocusRef={fallbackReturnFocusRef}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open site' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Task Monki could not open this site.'
    );
    expect((screen.getByRole('button', { name: 'Open site' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });
});
