import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationPanel } from './ConversationPanel';
import { DockedSidePanel, FloatingSidePanel } from './TaskSidePanel';

function Ask({ onClose, docked }: { onClose(): void; docked: boolean }) {
  const [draft, setDraft] = useState('');
  return (
    <ConversationPanel title="Ask" label="Ask" onClose={onClose} docked={docked}
      composer={{ placeholder: 'Ask about the work', hint: '', draft, onDraftChange: setDraft, onSubmit: async () => undefined }}>
      <p>An answer</p>
    </ConversationPanel>
  );
}

/** The task page and its side sheet, as the canvas lays them out. */
function Page({ open = true, floating = false, onClose }: { open?: boolean; floating?: boolean; onClose(): void }) {
  const panel = <Ask onClose={onClose} docked={!floating} />;
  return (
    <div className="tm-canvas__content">
      <main className="tm-detail">
        <button type="button">Page action</button>
        {open && floating ? <FloatingSidePanel>{panel}</FloatingSidePanel> : null}
      </main>
      {open && !floating ? <DockedSidePanel width={380} maxWidth={560} onWidthChange={() => undefined} label="Ask">{panel}</DockedSidePanel> : null}
    </div>
  );
}

describe('an expanded side conversation', () => {
  it('takes the page from its head, gives it back on Escape before closing, and starts collapsed when reopened', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Page onClose={onClose} />);
    const panel = screen.getByRole('complementary', { name: 'Ask' });

    const expand = screen.getByRole('button', { name: 'Expand Ask' });
    expand.focus();
    fireEvent.click(expand);
    const collapse = screen.getByRole('button', { name: 'Collapse Ask' });
    // The sheet, which lays the page out, carries the state; a sheet over the page is not resized.
    expect(panel.closest('.tm-side-sheet')?.hasAttribute('data-expanded')).toBe(true);
    expect(screen.queryByRole('separator', { name: 'Resize Ask' })).toBeNull();
    expect(document.activeElement).toBe(collapse);

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Ask about the work' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Expand Ask' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize Ask' })).toBeTruthy();

    // The chord works from the composer while typing, both ways.
    const field = screen.getByRole('textbox', { name: 'Ask about the work' });
    fireEvent.keyDown(field, { key: 'F', metaKey: true, shiftKey: true });
    expect(screen.getByRole('button', { name: 'Collapse Ask' })).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Ask' }));
    rerender(<Page open={false} onClose={onClose} />);
    rerender(<Page onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Expand Ask' })).toBeTruthy();
  });

  it('floating over a narrow page, collapses on Escape from anywhere before it closes', () => {
    const onClose = vi.fn();
    render(<Page floating onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Ask' }));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Expand Ask' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers no expand control outside a side sheet, where it would have nothing to cover', () => {
    render(<Ask onClose={() => undefined} docked />);
    expect(screen.getByRole('button', { name: 'Close Ask' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Expand Ask' })).toBeNull();
  });
});
