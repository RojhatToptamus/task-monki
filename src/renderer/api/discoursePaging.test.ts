import { describe, expect, it, vi } from 'vitest';
import { listDiscourseConversationSnapshot } from './discoursePaging';

describe('listDiscourseConversationSnapshot', () => {
  it('follows cursors and preserves the requested status filter', async () => {
    const listDiscourseConversations = vi
      .fn()
      .mockResolvedValueOnce({
        conversations: [{ id: 'conversation-1' }],
        nextCursor: 'page-2'
      })
      .mockResolvedValueOnce({ conversations: [{ id: 'conversation-2' }] });

    const result = await listDiscourseConversationSnapshot(
      { listDiscourseConversations } as never,
      'OPEN'
    );

    expect(result.map((conversation) => conversation.id)).toEqual([
      'conversation-1',
      'conversation-2'
    ]);
    expect(listDiscourseConversations).toHaveBeenNthCalledWith(1, {
      status: 'OPEN',
      limit: 100
    });
    expect(listDiscourseConversations).toHaveBeenNthCalledWith(2, {
      status: 'OPEN',
      cursor: 'page-2',
      limit: 100
    });
  });
});
