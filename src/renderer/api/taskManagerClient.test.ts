import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateEvent } from '../../shared/contracts';
import { createBrowserTaskManagerApi, TaskManagerApiError } from './taskManagerClient';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<(message: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (message: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, message: MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(message);
    }
  }
}

describe('createBrowserTaskManagerApi updates', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it('polls for updates when EventSource is unavailable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', undefined);
    const api = createBrowserTaskManagerApi('');
    const events: AppUpdateEvent[] = [];

    const unsubscribe = api.onUpdate((event) => events.push(event));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'projection.updated',
      scope: { kind: 'APP' }
    });

    unsubscribe();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toHaveLength(1);
  });

  it('delivers server-sent update events when EventSource is available', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const api = createBrowserTaskManagerApi('');
    const events: AppUpdateEvent[] = [];

    const unsubscribe = api.onUpdate((event) => events.push(event));
    const event: AppUpdateEvent = {
      type: 'run.output',
      scope: { kind: 'TASK', taskId: 'task-1' },
      taskId: 'task-1',
      payload: { stream: 'stdout' },
      at: '2026-06-29T00:00:00.000Z'
    };
    FakeEventSource.instances[0]?.emit('update', {
      data: JSON.stringify(event)
    } as MessageEvent);

    expect(FakeEventSource.instances[0]?.url).toBe('/api/events');
    expect(events).toEqual([event]);

    unsubscribe();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});

describe('createBrowserTaskManagerApi settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and updates core app settings through the browser API', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const stored = {
      codexExternalTools: {
        webSearchMode: 'live',
        mcpServers: 'all',
        apps: 'enabled'
      }
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => stored
        } as Response;
      })
    );

    const api = createBrowserTaskManagerApi('');
    await expect(api.getAppSettings()).resolves.toEqual(stored);
    await expect(
      api.updateAppSettings({
        codexExternalTools: {
          webSearchMode: 'live',
          mcpServers: 'all',
          apps: 'enabled'
        }
      })
    ).resolves.toEqual(stored);

    expect(calls[0]).toMatchObject({
      url: '/api/settings'
    });
    expect(calls[1]?.url).toBe('/api/settings');
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      codexExternalTools: {
        webSearchMode: 'live',
        mcpServers: 'all',
        apps: 'enabled'
      }
    });
  });

  it('preserves structured server error details for actionable UI handling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: false,
          status: 413,
          json: async () => ({
            error: {
              code: 'REQUEST_BODY_TOO_LARGE',
              message: 'The request is too large.',
              retryable: false,
              requestId: 'request-1'
            }
          })
        }) as Response
      )
    );

    const api = createBrowserTaskManagerApi('');
    const error = await api.getAppSettings().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskManagerApiError);
    expect(error).toMatchObject({
      message: 'The request is too large.',
      status: 413,
      code: 'REQUEST_BODY_TOO_LARGE',
      retryable: false,
      requestId: 'request-1'
    });
  });
});

describe('createBrowserTaskManagerApi repository catalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses opaque ids and never submits repository paths', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const catalog = {
      revision: 1,
      defaultRepositoryId: 'repository-1',
      selectedRepositoryId: 'repository-1',
      repositories: [],
      taskAssociations: []
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, json: async () => catalog } as Response;
      })
    );
    const api = createBrowserTaskManagerApi('');

    await api.getRepositoryCatalog();
    await api.selectRepository({ repositoryId: 'repository-1' });
    await api.addRepository({ clientMutationId: 'add-repository-0001' });
    await api.removeRepository({
      repositoryId: 'repository-1',
      clientMutationId: 'remove-repository-01'
    });
    await api.relinkRepository({
      repositoryId: 'repository-1',
      clientMutationId: 'relink-repository-01'
    });

    expect(calls.map((call) => call.url)).toEqual([
      '/api/repositories',
      '/api/repositories/select',
      '/api/repositories/add',
      '/api/repositories/remove',
      '/api/repositories/relink'
    ]);
    expect(calls.slice(1).map((call) => String(call.init?.body))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('/Users/')])
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      repositoryId: 'repository-1'
    });
  });
});

describe('createBrowserTaskManagerApi discourse', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps pagination in query parameters and context authority in opaque ids', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ conversations: [], messages: [] }) } as Response;
    }));
    const api = createBrowserTaskManagerApi('');

    await api.listDiscourseConversations({ status: 'OPEN', cursor: 'cursor-1', limit: 40 });
    await api.listDiscourseMessages({
      conversationId: 'conversation-1',
      beforeCursor: 'cursor-2',
      limit: 25
    });
    await api.previewDiscourseContext({
      conversationId: 'conversation-1',
      messageContext: [{ entityKind: 'REPOSITORY', entityId: 'repository-1' }]
    });
    await api.sendDiscourseMessage({
      conversationId: 'conversation-1',
      body: 'Review this.',
      context: [],
      clientMessageId: 'message-1',
      policy: 'TEAM',
      agentProfileIds: ['builtin.lead', 'builtin.skeptic', 'builtin.verifier'],
      previewFingerprint: 'preview-1'
    });
    await api.stopDiscourseWave({
      conversationId: 'conversation-1',
      waveId: 'wave-1',
      clientOperationId: 'stop-1',
      reason: 'User stopped.'
    });
    await api.confirmDiscourseWaveContext({
      conversationId: 'conversation-1',
      waveId: 'wave-1',
      previewFingerprint: 'preview-2',
      expectedWaveRevision: 1,
      clientOperationId: 'confirm-1'
    });

    expect(calls[0]?.url).toBe('/api/discourse/conversations?status=OPEN&cursor=cursor-1&limit=40');
    expect(calls[1]?.url).toBe('/api/discourse/messages?conversationId=conversation-1&beforeCursor=cursor-2&limit=25');
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      conversationId: 'conversation-1',
      messageContext: [{ entityKind: 'REPOSITORY', entityId: 'repository-1' }]
    });
    expect(String(calls[2]?.init?.body)).not.toContain('/Users/');
    expect(calls.slice(3).map((call) => call.url)).toEqual([
      '/api/discourse/messages/send',
      '/api/discourse/waves/stop',
      '/api/discourse/waves/confirm-context'
    ]);
  });
});
