import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReplyToReviewersModal } from './PullRequestDialogs';

describe('ReplyToReviewersModal', () => {
  it('keeps a reply that landed in view when only resolving its thread failed, and never posts it again', async () => {
    const drafts = [{ discussionId: 'PRRT_1', kind: 'THREAD' as const, author: 'alice', summary: 'Handle a null layout.', location: 'save.js:2',
      outcome: 'FIXED' as const, body: 'Fixed in 1a2b3c4.', resolvable: true }];
    const onSubmit = vi.fn(async () => ({ posted: 1, resolved: 0, requested: [],
      failed: [{ discussionId: 'PRRT_1', replied: true, error: 'Replied, but the thread was not resolved: GitHub refused.' }] }));
    const modal = (current: typeof drafts) => (
      <ReplyToReviewersModal platform="GitHub" drafts={current} reviewers={[]} onSubmit={onSubmit} onCancel={vi.fn()} fallbackReturnFocusRef={{ current: null }} />
    );
    const mounted = render(modal(drafts));
    const dialog = screen.getByRole('dialog', { name: 'Reply on GitHub' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1 reply' }));
    expect(await within(dialog).findByText('Replied, but the thread was not resolved: GitHub refused.')).toBeDefined();
    // The refresh that follows answers the discussion, so its draft leaves; what became of the reply stays in view.
    mounted.rerender(modal([]));
    expect(within(dialog).getByText('Replied, but the thread was not resolved: GitHub refused.')).toBeDefined();
    expect(within(dialog).queryByRole('textbox', { name: 'Reply to @alice' })).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Post replies' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDefined();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('posts only the replies the person kept, as they edited them, with the resolving they chose', async () => {
    const drafts = [
      { discussionId: 'PRRT_1', kind: 'THREAD' as const, author: 'alice', summary: 'Handle a null layout.', location: 'save.js:2',
        outcome: 'FIXED' as const, body: 'Fixed in 1a2b3c4. Null returns undefined.', resolvable: true },
      { discussionId: 'PRR_1', kind: 'REVIEW' as const, author: 'bob', summary: 'Keep the export name.',
        outcome: 'NOT_CHANGED' as const, body: 'Not changed. Other packages import it.', resolvable: false }
    ];
    const onSubmit = vi.fn(async () => ({ posted: 1, resolved: 0, requested: [], failed: [{ discussionId: 'PRR_1', error: 'GitHub refused the comment.' }] }));
    const onCancel = vi.fn();
    render(<ReplyToReviewersModal platform="GitHub" drafts={drafts} reviewers={['alice']} onSubmit={onSubmit} onCancel={onCancel}
      fallbackReturnFocusRef={{ current: null }} />);
    const dialog = screen.getByRole('dialog', { name: 'Reply on GitHub' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reply to @alice' }), { target: { value: 'Fixed: null now returns undefined.' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Resolve thread' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Ask @alice to review again' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 2 replies' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([
      { discussionId: 'PRRT_1', body: 'Fixed: null now returns undefined.', resolve: false },
      { discussionId: 'PRR_1', body: 'Not changed. Other packages import it.', resolve: false }
    ], []));
    // What landed leaves the list; what was refused stays with its reason, for another try.
    expect(await within(dialog).findByText('GitHub refused the comment.')).toBeDefined();
    expect(within(dialog).queryByRole('textbox', { name: 'Reply to @alice' })).toBeNull();
    expect(within(dialog).getByRole('textbox', { name: 'Reply to @bob' })).toBeDefined();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
