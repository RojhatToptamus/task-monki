import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseAgentJobRecord, DiscourseMessageRecord } from '../../shared/discourse';
import { DiscourseMessage } from './DiscourseMessage';

describe('DiscourseMessage actions', () => {
  it('labels a saved author response from its comparison, not an earlier answer in the targets', () => {
    const message = { id: 'reply', author: { kind: 'AGENT', displayNameSnapshot: 'A' }, body: 'Saved response',
      status: 'VISIBLE', createdAt: '2026-09-14T10:00:00Z' } as DiscourseMessageRecord;
    const answer = { result: { kind: 'CONTRIBUTION', outputMessageId: 'answer' } } as DiscourseAgentJobRecord;
    const comparison = { result: { kind: 'CONTRIBUTION', outputMessageId: 'comparison', team: {
      kind: 'COMPARISON', points: [{ id: 'limit', question: 'Is the limit shared across workers?' }]
    } } } as DiscourseAgentJobRecord;
    const job = { role: 'RESPOND', assignment: { displayNameSnapshot: 'A' }, targetMessageIds: ['answer', 'comparison'],
      result: { kind: 'CONTRIBUTION', outputMessageId: message.id, team: { kind: 'RESPONSE', newIssues: [],
        responses: [{ pointId: 'limit', stance: 'REVISE', answer: 'Use one shared counter.', reason: 'Workers run concurrently.', evidence: [] }] } }
    } as unknown as DiscourseAgentJobRecord;
    const html = renderToStaticMarkup(<DiscourseMessage message={message} job={job} relatedJobs={[answer, comparison]} context={[]}
      onNavigate={vi.fn()} onReply={vi.fn()} onCorrect={vi.fn()} onDelete={vi.fn()} onAskAuthor={vi.fn()}
      onAskOthers={vi.fn()} selectedAsSource={false} onToggleSource={vi.fn()} />);
    expect(html).toContain('Is the limit shared across workers?');
    expect(html).toContain('Use one shared counter.');
  });

  it('keeps an exact peer request expandable without presenting it as another answer', () => {
    const message = { id: 'request', author: { kind: 'USER' }, body: 'Check the cancellation assumption.',
      status: 'VISIBLE', createdAt: '2026-09-14T10:00:00Z' } as DiscourseMessageRecord;
    const html = renderToStaticMarkup(<DiscourseMessage message={message} context={[]} peerRequestName="Sol"
      onNavigate={vi.fn()} onReply={vi.fn()} onCorrect={vi.fn()} onDelete={vi.fn()} onAskAuthor={vi.fn()}
      onAskOthers={vi.fn()} selectedAsSource={false} onToggleSource={vi.fn()} />);
    expect(html).toContain('You asked <strong>Sol</strong> to check this answer');
    expect(html).toContain('Check the cancellation assumption.');
    expect(html).not.toContain('<details open');
    expect(html).not.toContain('Ask Sol</button>');
  });

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
