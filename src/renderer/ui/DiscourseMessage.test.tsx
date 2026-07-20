import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseMessageRecord } from '../../shared/discourse';
import { DiscourseMessage } from './DiscourseMessage';

describe('DiscourseMessage actions', () => {
  it('uses quiet, named icon actions while preserving textual overflow choices', () => {
    const message = {
      id: 'message-1',
      conversationId: 'conversation-1',
      ordinal: 1,
      author: { kind: 'USER' },
      body: 'A concise decision.',
      status: 'VISIBLE',
      createdAt: '2026-07-20T10:00:00.000Z'
    } as DiscourseMessageRecord;
    const html = renderToStaticMarkup(
      <DiscourseMessage
        message={message}
        context={[]}
        onNavigate={vi.fn()}
        onReply={vi.fn()}
        onCorrect={vi.fn()}
        onDelete={vi.fn()}
        onAskAuthor={vi.fn()}
        onAskOthers={vi.fn()}
        selectedAsSource={false}
        onToggleSource={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="Reply" title="Reply"');
    expect(html).toContain('aria-label="Copy" title="Copy"');
    expect(html).toContain('aria-label="More actions for You"');
    expect(html).not.toContain('>Reply</button>');
    expect(html).not.toContain('>Copy</button>');
    expect(html).not.toContain('>More</button>');
  });
});
