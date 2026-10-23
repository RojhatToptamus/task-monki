import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReplyToReviewersModal } from './PullRequestDialogs';

describe('ReplyToReviewersModal', () => {
  it('keeps a reply that landed in view when only resolving its thread failed, and never posts it again', async () => {
    const drafts = [{ discussionId: 'PRRT_1', kind: 'THREAD' as const, author: 'alice', summary: 'Handle a null layout.', location: 'save.js:2',
      outcome: 'FIXED' as const, body: 'Changed in 1a2b3c4.', resolvable: true }];
    const onSubmit = vi.fn(async () => ({ posted: 1, resolved: 0, requested: [],
      failed: [{ discussionId: 'PRRT_1', replied: true, error: 'Replied, but the thread was not resolved: GitHub refused.' }] }));
    const modal = (current: typeof drafts) => (
      <ReplyToReviewersModal platform="GitHub" agent="Codex" drafts={current} reviewers={[]} onSubmit={onSubmit} onCancel={vi.fn()} fallbackReturnFocusRef={{ current: null }} />
    );
    const mounted = render(modal(drafts));
    const dialog = screen.getByRole('dialog', { name: 'Reply on GitHub' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1 reply' }));
    expect(await within(dialog).findByText('Replied, but the thread was not resolved: GitHub refused.')).toBeDefined();
    // The refresh that follows answers the discussion, so its draft leaves; what became of the reply stays in view.
    mounted.rerender(modal([]));
    expect(within(dialog).getByText('Replied, but the thread was not resolved: GitHub refused.')).toBeDefined();
    expect(within(dialog).queryByRole('textbox', { name: 'Reply to @alice' })).toBeNull();
    // Nothing is left to post, so Close is the one action.
    expect(within(dialog).queryByRole('button', { name: /^Post/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDefined();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('says why posting waits beside a disabled Post', () => {
    const drafts = [{ discussionId: 'PRRT_1', kind: 'THREAD' as const, author: 'alice', summary: 'Handle a null layout.', location: 'save.js:2',
      outcome: 'FIXED' as const, body: 'Changed in 1a2b3c4.', resolvable: true }];
    render(<ReplyToReviewersModal platform="GitHub" agent="Codex" drafts={drafts} reviewers={[]} onSubmit={vi.fn()} onCancel={vi.fn()}
      fallbackReturnFocusRef={{ current: null }} />);
    const dialog = screen.getByRole('dialog', { name: 'Reply on GitHub' });
    const description = (element: HTMLElement) => (element.getAttribute('aria-describedby') ?? '').split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reply to @alice' }), { target: { value: ' ' } });
    const post = within(dialog).getByRole('button', { name: 'Post 1 reply' }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    expect(description(post)).toBe('Write each reply first');

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /@alice/ }));
    const none = within(dialog).getByRole('button', { name: 'Post replies' }) as HTMLButtonElement;
    expect(none.disabled).toBe(true);
    expect(description(none)).toBe('Choose a reply first');
  });

  it('quotes the agent for the person alone and posts only what they kept and wrote, resolving only what they chose', async () => {
    const drafts = [
      { discussionId: 'PRRT_1', kind: 'THREAD' as const, author: 'alice', summary: 'Handle a null layout.', location: 'save.js:2',
        outcome: 'FIXED' as const, note: 'Null returns undefined.', answeredAt: '2026-10-10T12:14:00.000Z', body: 'Changed in 1a2b3c4.', resolvable: true },
      { discussionId: 'PRR_1', kind: 'REVIEW' as const, author: 'bob', summary: 'Keep the export name.',
        outcome: 'NOT_CHANGED' as const, note: 'Other packages import it.', body: '', resolvable: false }
    ];
    const onSubmit = vi.fn(async () => ({ posted: 1, resolved: 1, requested: [], failed: [{ discussionId: 'PRR_1', error: 'GitHub refused the comment.' }] }));
    const onCancel = vi.fn();
    render(<ReplyToReviewersModal platform="GitHub" agent="Codex" drafts={drafts} reviewers={['alice']} onSubmit={onSubmit} onCancel={onCancel}
      fallbackReturnFocusRef={{ current: null }} />);
    const dialog = screen.getByRole('dialog', { name: 'Reply on GitHub' });
    // The agent's words are quoted above each reply, under its name, and never written into it.
    expect(within(dialog).getByText('Null returns undefined.').closest('figure')?.textContent).toContain('Codex');
    expect((within(dialog).getByRole('textbox', { name: 'Reply to @alice' }) as HTMLTextAreaElement).value).toBe('Changed in 1a2b3c4.');
    const bob = within(dialog).getByRole('textbox', { name: 'Reply to @bob' }) as HTMLTextAreaElement;
    expect(bob.value).toBe('');
    // Resolving is the person's call, even on Fixed.
    const resolve = within(dialog).getByRole('checkbox', { name: 'Resolve thread' }) as HTMLInputElement;
    expect(resolve.checked).toBe(false);
    fireEvent.click(resolve);
    fireEvent.change(bob, { target: { value: 'Kept: other packages import it.' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Ask @alice to review again' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 2 replies' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([
      { discussionId: 'PRRT_1', body: 'Changed in 1a2b3c4.', resolve: true },
      { discussionId: 'PRR_1', body: 'Kept: other packages import it.', resolve: false }
    ], []));
    // What landed leaves the list; what was refused stays with its reason, for another try.
    expect(await within(dialog).findByText('GitHub refused the comment.')).toBeDefined();
    expect(within(dialog).queryByRole('textbox', { name: 'Reply to @alice' })).toBeNull();
    expect(within(dialog).getByRole('textbox', { name: 'Reply to @bob' })).toBeDefined();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
