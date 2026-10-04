import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import type { DiscourseDefaultPolicy } from '../../shared/discourse';
import { DiscourseModeMenu } from './DiscourseModeMenu';

function ComposerMode() {
  const [mode, setMode] = useState<DiscourseDefaultPolicy>('CHAT');
  return <DiscourseModeMenu value={mode} disabled={false} onChange={setMode} />;
}

it('changes composer mode by keyboard and returns focus when dismissed', async () => {
  render(<ComposerMode />);
  const trigger = screen.getByRole('button', { name: 'Conversation: Chat' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const notes = await screen.findByRole('menuitemradio', { name: 'Notes' });
  notes.focus();
  fireEvent.keyDown(notes, { key: 'Enter' });
  const updated = await screen.findByRole('button', { name: 'Conversation: Notes' });
  await waitFor(() => expect(document.activeElement).toBe(updated));
  fireEvent.keyDown(updated, { key: 'ArrowDown' });
  const chat = await screen.findByRole('menuitemradio', { name: 'Chat' });
  fireEvent.keyDown(chat, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(document.activeElement).toBe(updated);
});
