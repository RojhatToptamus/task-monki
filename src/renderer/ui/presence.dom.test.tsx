import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDialogFocusBoundary } from './dialogFocus';
import { ModalFrame } from './ModalFrame';
import { Presence } from './presence';

/**
 * The document has no CSS animations here, so a closed layer's exit is stood in for: a closed
 * layer reports one running exit, which the test ends when it chooses.
 */
function holdExits() {
  let end: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    end = resolve;
  });
  const exit = { finished, effect: { getComputedTiming: () => ({ endTime: 120 }) } } as unknown as Animation;
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value(this: Element) {
      return this.matches('[data-state="closed"]') ? [exit] : [];
    }
  });
  return { end: () => end() };
}

function RenameDialog({ onClose }: { onClose(): void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  useDialogFocusBoundary({ dialogRef: panelRef, busy: false, onClose });
  return (
    <ModalFrame labelledBy="rename-title" onDismiss={onClose}>
      <div ref={panelRef} className="tm-modal__panel" tabIndex={-1}>
        <h3 id="rename-title">Rename</h3>
        <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </ModalFrame>
  );
}

function RenameFlow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Rename…</button>
      <Presence>{open ? <RenameDialog onClose={() => setOpen(false)} /> : null}</Presence>
    </>
  );
}

const layer = () => document.querySelector<HTMLElement>('.tm-modal');

describe('A closing layer leaves before it unmounts', () => {
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).getAnimations;
  });

  it('stays on screen, inert, until its exit ends, with focus already back on its trigger', async () => {
    const exits = holdExits();
    render(<RenameFlow />);
    const trigger = screen.getByRole('button', { name: 'Rename…' });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' })));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(layer()?.dataset.state).toBe('closed');
    expect(layer()?.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    // The dialog on its way out no longer traps focus: Tab from the trigger stays on the page.
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(document.activeElement).toBe(trigger);
    expect(layer()).not.toBeNull();

    exits.end();
    await waitFor(() => expect(layer()).toBeNull());
  });

  it('opens a fresh layer when it is opened again while the last one leaves', async () => {
    holdExits();
    render(<RenameFlow />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Half-typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(layer()?.dataset.state).toBe('closed');

    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));

    expect(document.querySelectorAll('.tm-modal')).toHaveLength(1);
    expect(layer()?.dataset.state).toBe('open');
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('');
  });
});
