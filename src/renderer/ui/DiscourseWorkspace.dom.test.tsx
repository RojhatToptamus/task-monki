import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseConversationAggregateRecord } from '../../shared/discourse';
import { taskManagerApi } from '../api/taskManagerClient';
import { DiscourseWorkspace } from './DiscourseWorkspace';

vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: {
  listDiscourseConversations: vi.fn(),
  getDiscourseMentionCatalog: vi.fn(),
  listDiscourseDrafts: vi.fn().mockResolvedValue([]),
  getDiscourseConversation: vi.fn(),
  listDiscourseMessages: vi.fn().mockResolvedValue({ messages: [] }),
  onUpdate: vi.fn(() => () => undefined)
} }));

describe('Discourse conversation loading', () => {
  it('keeps the pending load when the user selects the already selected conversation', async () => {
    const conversation = {
      id: 'conversation', title: 'A pending conversation', status: 'OPEN' as const,
      defaultPolicy: 'NONE' as const, participantIds: [], latestOrdinal: 0, readOrdinal: 0,
      recordRevision: 1, createdAt: '2026-09-13T10:00:00Z', updatedAt: '2026-09-13T10:00:00Z'
    };
    vi.mocked(taskManagerApi.listDiscourseConversations).mockResolvedValue({
      conversations: [{ ...conversation, unreadCount: 0, needsAttention: false, activeWaveCount: 0 }]
    });
    vi.mocked(taskManagerApi.getDiscourseMentionCatalog).mockResolvedValue({
      agents: [], tasks: [], repositories: [], runtimeCatalog: { defaultRuntimeId: 'codex', runtimes: [], models: [], refreshedAt: conversation.updatedAt },
      refreshedAt: conversation.updatedAt
    });
    let resolve!: (aggregate: DiscourseConversationAggregateRecord) => void;
    vi.mocked(taskManagerApi.getDiscourseConversation).mockReturnValue(new Promise((done) => { resolve = done; }));
    const onError = vi.fn();
    render(<DiscourseWorkspace onNotify={vi.fn()} onError={onError} />);
    await screen.findByRole('heading', { name: 'Loading conversation…' });
    fireEvent.click(screen.getAllByText('A pending conversation')[0]!);
    await act(async () => resolve({
      conversation, participants: [], participantRevisions: [], acceptedSends: [], contextLinks: [],
      contextRevisions: [], contextSnapshots: [], waves: [], jobs: [], concerns: [], summaries: [], drafts: [], latestEventSequence: 0
    }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Loading conversation…' })).toBeNull());
    expect(taskManagerApi.getDiscourseConversation).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    // Selecting it again must not clear the loaded transcript either.
    fireEvent.click(screen.getAllByText('A pending conversation')[0]!);
    expect(screen.queryByRole('heading', { name: 'Loading conversation…' })).toBeNull();
  });
});
