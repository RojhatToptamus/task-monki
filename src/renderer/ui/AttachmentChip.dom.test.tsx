import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AttachmentDescriptor } from '../../shared/attachments';
import { StoredAttachmentChip } from './AttachmentChip';

it('allows selecting a filename without opening its preview, then restores focus after preview', async () => {
  const attachment = { id: 'file', displayName: 'requirements.txt', kind: 'text', byteCount: 5 } as AttachmentDescriptor;
  const onRead = vi.fn().mockResolvedValue({ ...attachment, bytes: new TextEncoder().encode('Hello').buffer });
  render(<ul><StoredAttachmentChip attachment={attachment} onRead={onRead} /></ul>);
  const name = screen.getByRole('button', { name: attachment.displayName });
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(name);
  selection.addRange(range);
  fireEvent.click(name, { detail: 1 });
  expect(onRead).not.toHaveBeenCalled();
  expect(selection.toString()).toBe(attachment.displayName);
  selection.removeAllRanges();
  name.focus();
  fireEvent.click(name, { detail: 0 });
  expect(await screen.findByText('Hello')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(name));
});
