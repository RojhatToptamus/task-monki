import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseConversationAggregateRecord, DiscourseDefaults, DiscourseMentionCatalogSnapshot } from '../../shared/discourse';
import { AgentProfileCatalog } from '../../core/discourse/AgentProfileCatalog';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import { CODEX_RUNTIME_DESCRIPTOR, codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import { taskManagerApi } from '../api/taskManagerClient';
import { DiscourseWorkspace } from './DiscourseWorkspace';

vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: {
  listDiscourseConversations: vi.fn(),
  getDiscourseMentionCatalog: vi.fn(),
  listDiscourseDrafts: vi.fn().mockResolvedValue([]),
  getDiscourseConversation: vi.fn(),
  listDiscourseMessages: vi.fn().mockResolvedValue({ messages: [] }),
  saveDiscourseDraft: vi.fn(),
  onUpdate: vi.fn(() => () => undefined)
} }));

describe('Discourse conversation loading', () => {
  it('restores exact settings in a non-modal sidebar and saves changes without rewriting other agents', async () => {
    const catalog = settingsCatalog();
    vi.mocked(taskManagerApi.listDiscourseConversations).mockResolvedValue({ conversations: [] });
    vi.mocked(taskManagerApi.getDiscourseMentionCatalog).mockResolvedValue(catalog);
    const defaults: DiscourseDefaults = {
      policy: 'TEAM', responderProfileIds: ['builtin.lead'],
      agents: catalog.agents.map((entry) => ({ agentProfileId: entry.profile.id, runtimeId: 'codex', modelId: 'exact-model', reasoningEffort: 'high' }))
    };
    const onDefaultsChange = vi.fn().mockResolvedValue(undefined);
    const view = render(<DiscourseWorkspace defaults={defaults} onDefaultsChange={onDefaultsChange} onNotify={vi.fn()} onError={vi.fn()} />);
    await screen.findByRole('button', { name: 'Response mode: Team' });
    const sidebar = screen.getByRole('complementary', { name: 'Conversation settings' });
    expect(within(sidebar).getByRole('region', { name: 'Agent settings' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    const reasoning = within(sidebar).getByRole('group', { name: 'A provider and model reasoning' });
    expect(within(reasoning).getByRole('button', { name: 'High reasoning' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(reasoning).getByRole('button', { name: 'Low reasoning' }));
    const saved: DiscourseDefaults = onDefaultsChange.mock.lastCall![0];
    expect(saved.agents.map((agent) => agent.reasoningEffort)).toEqual(['low', 'high', 'high']);
    view.unmount();
    render(<DiscourseWorkspace defaults={saved} onDefaultsChange={onDefaultsChange} onNotify={vi.fn()} onError={vi.fn()} />);
    await screen.findByRole('button', { name: 'Response mode: Team' });
    const reopened = screen.getByRole('group', { name: 'A provider and model reasoning' });
    expect(within(reopened).getByRole('button', { name: 'Low reasoning' }).getAttribute('aria-pressed')).toBe('true');
    expect(onDefaultsChange).toHaveBeenCalledOnce();
  });

  it('keeps an unavailable saved model visible and blocks sending instead of substituting the catalog default', async () => {
    const catalog = settingsCatalog();
    vi.mocked(taskManagerApi.listDiscourseConversations).mockResolvedValue({ conversations: [] });
    vi.mocked(taskManagerApi.getDiscourseMentionCatalog).mockResolvedValue(catalog);
    const onDefaultsChange = vi.fn();
    render(<DiscourseWorkspace defaults={{ policy: 'DIRECT', responderProfileIds: ['builtin.lead'],
      agents: [{ agentProfileId: 'builtin.lead', runtimeId: 'codex', modelId: 'removed-exact-model', reasoningEffort: 'high' }] }}
      onDefaultsChange={onDefaultsChange} onNotify={vi.fn()} onError={vi.fn()} />);
    await screen.findByRole('button', { name: /A provider and model:.*removed-exact-model/ });
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(onDefaultsChange).not.toHaveBeenCalled();
  });

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

function settingsCatalog(): DiscourseMentionCatalogSnapshot {
  const model = { id: 'exact-model', runtimeId: 'codex', model: 'exact-model', displayName: 'Exact model',
    hidden: false, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', serviceTiers: [],
    inputModalities: ['text' as const], isDefault: true };
  const runtimeCatalog = { defaultRuntimeId: 'codex', refreshedAt: '2026-09-13T10:00:00Z', models: [model],
    runtimes: [{ preflight: { runtime: CODEX_RUNTIME_DESCRIPTOR, readiness: createRuntimeReadiness('READY', 'Ready'), capabilities: codexCapabilities() }, models: [model], refreshedAt: '2026-09-13T10:00:00Z' }] };
  return { agents: new AgentProfileCatalog().list(runtimeCatalog).profiles, runtimeCatalog, tasks: [], repositories: [], refreshedAt: runtimeCatalog.refreshedAt };
}
