import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseConversationSummary } from '../../shared/discourse';
import { DiscourseConversationRail } from './DiscourseConversationRail';

describe('DiscourseConversationRail', () => {
  it('uses the page heading as its label and keeps unread counts beside message time', () => {
    const conversation = {
      id: 'conversation-1',
      title: 'Review provider routing',
      status: 'OPEN',
      defaultPolicy: 'TEAM',
      participantIds: [],
      latestOrdinal: 4,
      readOrdinal: 2,
      unreadCount: 2,
      needsAttention: true,
      activeWaveCount: 1,
      createdAt: '2026-07-20T08:00:00.000Z',
      updatedAt: '2026-07-20T09:00:00.000Z',
      lastMessageAt: '2026-07-20T09:00:00.000Z'
    } satisfies DiscourseConversationSummary;
    const html = renderToStaticMarkup(
      <DiscourseConversationRail
        archived={false}
        conversations={[conversation]}
        modalOpen={false}
        newConversation={false}
        query=""
        railRef={createRef<HTMLElement>()}
        searchRef={createRef<HTMLInputElement>()}
        selectedConversationId={conversation.id}
        sending={false}
        onArchivedChange={vi.fn()}
        onClose={vi.fn()}
        onNewConversation={vi.fn()}
        onQueryChange={vi.fn()}
        onSelectConversation={vi.fn()}
      />
    );

    expect(html).toContain('aria-labelledby="discourse-rail-title"');
    expect(html).toContain('<h2 id="discourse-rail-title">Discourse</h2>');
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="2 unread"');
    expect(html).toContain('<time dateTime="2026-07-20T09:00:00.000Z">');
    expect(html).toContain('aria-current="page"');
  });
});
