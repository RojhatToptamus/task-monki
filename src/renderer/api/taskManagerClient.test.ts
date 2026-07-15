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
      taskId: '__browser_poll__'
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

describe('createBrowserTaskManagerApi provider-native session configuration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the narrow typed native-session endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = {
      taskId: 'task-1',
      sessionId: 'session-1',
      runtimeId: 'gemini-acp',
      native: { modes: { currentModeId: 'plan' } },
      controls: {
        localSessionId: 'session-1',
        providerSessionId: 'provider-session-1',
        revision: 'revision-2',
        controls: []
      }
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, json: async () => result } as Response;
      })
    );

    const api = createBrowserTaskManagerApi('');
    await expect(
      api.updateAgentNativeSession({
        taskId: 'task-1',
        sessionId: 'session-1',
        runtimeId: 'gemini-acp',
        controlId: 'mode',
        value: 'plan',
        revision: 'revision-1'
      })
    ).resolves.toEqual(result);
    expect(calls).toEqual([
      {
        url: '/api/agent/session/native',
        init: expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            taskId: 'task-1',
            sessionId: 'session-1',
            runtimeId: 'gemini-acp',
            controlId: 'mode',
            value: 'plan',
            revision: 'revision-1'
          })
        })
      }
    ]);
  });
});
