import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscourseConversationAggregateRecord, DiscourseDefaults, DiscourseMentionCatalogSnapshot, DiscourseMessageRecord } from '../../shared/discourse';
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
  getAttachmentDraft: vi.fn(),
  stageTaskAttachmentBatch: vi.fn(),
  discardTaskAttachmentDraft: vi.fn().mockResolvedValue(undefined),
  sendDiscourseMessage: vi.fn(),
  deleteDiscourseDraft: vi.fn().mockResolvedValue(undefined),
  setDiscourseConversationRead: vi.fn().mockResolvedValue(undefined),
  getDiscourseMessageByClientId: vi.fn().mockResolvedValue(undefined),
  readTaskAttachment: vi.fn(),
  onUpdate: vi.fn(() => () => undefined)
} }));

describe('Discourse conversation loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(taskManagerApi.listDiscourseMessages).mockResolvedValue({ messages: [] });
  });

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
    await screen.findByRole('button', { name: 'Conversation: Chat' });
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
    await screen.findByRole('button', { name: 'Conversation: Chat' });
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

  it.each([
    { policy: 'DIRECT' as const, imageCapable: true, enabled: true },
    { policy: 'DIRECT' as const, imageCapable: false, enabled: false },
    { policy: 'NONE' as const, imageCapable: false, enabled: true }
  ])('restores image drafts with $policy and image capability $imageCapable', async ({ policy, imageCapable, enabled }) => {
    const catalog = settingsCatalog();
    if (imageCapable) catalog.runtimeCatalog.models[0]!.inputModalities = ['text', 'image'];
    vi.mocked(taskManagerApi.listDiscourseConversations).mockResolvedValue({ conversations: [] });
    vi.mocked(taskManagerApi.getDiscourseMentionCatalog).mockResolvedValue(catalog);
    const draft = { id: 'message-draft', recordRevision: 1, body: 'Describe this image.',
      policy, attachmentDraftId: 'image-draft', sourceMessageIds: [], tokens: [],
      agentSelections: [{ agentProfileId: 'builtin.lead' as const, runtimeId: 'codex', modelId: 'exact-model' }],
      updatedAt: '2026-09-13T10:00:00Z' };
    vi.mocked(taskManagerApi.listDiscourseDrafts).mockResolvedValueOnce([draft]);
    vi.mocked(taskManagerApi.getAttachmentDraft).mockResolvedValue({ id: 'image-draft',
      attachments: [{ id: 'image-file', draftId: 'image-draft', ordinal: 0, displayName: 'reference.png',
        kind: 'image', mediaType: 'image/png', byteCount: 3, sha256: 'a'.repeat(64), createdAt: draft.updatedAt }],
      createdAt: draft.updatedAt, updatedAt: draft.updatedAt });
    vi.mocked(taskManagerApi.readTaskAttachment).mockResolvedValue({ attachmentId: 'image-file',
      displayName: 'reference.png', kind: 'image', mediaType: 'image/png', byteCount: 3,
      bytes: new Uint8Array([1, 2, 3]).buffer });
    vi.mocked(taskManagerApi.saveDiscourseDraft).mockResolvedValue(draft);
    render(<DiscourseWorkspace onNotify={vi.fn()} onError={vi.fn()} />);
    await screen.findByRole('button', { name: 'reference.png' });
    const send = screen.getByRole('button', { name: policy === 'NONE' ? 'Save' : 'Send' }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(!enabled));
    if (enabled) expect(screen.queryByText(/image-capable|does not support image/)).toBeNull();
    else expect(screen.getByRole('alert').textContent).toMatch(/does not support image/);
  });

  it('clears adopted files after a send is recovered and sends the next message without them', async () => {
    const conversation = {
      id: 'conversation', title: 'File notes', status: 'OPEN' as const,
      defaultPolicy: 'NONE' as const, participantIds: [], latestOrdinal: 0, readOrdinal: 0,
      recordRevision: 1, createdAt: '2026-09-13T10:00:00Z', updatedAt: '2026-09-13T10:00:00Z'
    };
    const messages: DiscourseMessageRecord[] = [];
    const aggregate = (): DiscourseConversationAggregateRecord => ({
      conversation: { ...conversation, latestOrdinal: messages.length, readOrdinal: messages.length },
      participants: [], participantRevisions: [], acceptedSends: [], contextLinks: [],
      contextRevisions: [], contextSnapshots: [], waves: [], jobs: [], concerns: [], summaries: [], drafts: [], latestEventSequence: 0
    });
    vi.mocked(taskManagerApi.listDiscourseConversations).mockResolvedValue({
      conversations: [{ ...conversation, unreadCount: 0, needsAttention: false, activeWaveCount: 0 }]
    });
    vi.mocked(taskManagerApi.getDiscourseMentionCatalog).mockResolvedValue(settingsCatalog());
    vi.mocked(taskManagerApi.getDiscourseConversation).mockImplementation(async () => aggregate());
    vi.mocked(taskManagerApi.listDiscourseMessages).mockImplementation(async () => ({ messages: [...messages] }));
    vi.mocked(taskManagerApi.saveDiscourseDraft).mockImplementation(async (input) => ({
      ...input, id: 'note-draft', recordRevision: (input.expectedRevision ?? 0) + 1,
      sourceMessageIds: [], agentSelections: input.agentSelections ?? [],
      tokens: input.tokens.map((token) => ({ ...token, id: token.entityId })), updatedAt: conversation.updatedAt
    }));
    vi.mocked(taskManagerApi.stageTaskAttachmentBatch).mockResolvedValue({
      id: 'file-draft', attachments: [], createdAt: conversation.createdAt, updatedAt: conversation.updatedAt
    });
    vi.mocked(taskManagerApi.sendDiscourseMessage).mockImplementation(async (input) => {
      messages.push({
        id: `message-${messages.length + 1}`, conversationId: conversation.id, ordinal: messages.length + 1,
        clientMessageId: input.clientMessageId, author: { kind: 'USER' }, status: 'VISIBLE',
        body: input.body, createdAt: conversation.createdAt, sourceMessageIds: []
      });
      if (messages.length === 1) throw new Error('Reply was lost after acceptance');
      return { message: messages.at(-1)!, jobs: [] };
    });
    render(<DiscourseWorkspace onNotify={vi.fn()} onError={vi.fn()} />);
    const input = await screen.findByRole('combobox', { name: 'Message' });
    await waitFor(() => expect(input).toHaveProperty('disabled', false));
    fireEvent.change(input, { target: { value: 'Keep these notes.' } });
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('notes').buffer });
    fireEvent.paste(input, { clipboardData: { getData: () => '', items: [{ kind: 'file', getAsFile: () => file }] } });
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Message' })).toHaveProperty('value', ''));
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull();
    expect(messages).toHaveLength(1);
    fireEvent.change(screen.getByRole('combobox', { name: 'Message' }), { target: { value: 'A separate note.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(messages).toHaveLength(2));
    expect(taskManagerApi.sendDiscourseMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      body: 'A separate note.', attachmentDraftId: undefined
    }));
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
