import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateEvent } from '../../shared/contracts';
import { createBrowserTaskManagerApi } from './taskManagerClient';

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
    const api = createBrowserTaskManagerApi('http://127.0.0.1:3099');
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
    const api = createBrowserTaskManagerApi('http://127.0.0.1:3099');
    const events: AppUpdateEvent[] = [];

    const unsubscribe = api.onUpdate((event) => events.push(event));
    const event: AppUpdateEvent = {
      type: 'test.output',
      taskId: 'task-1',
      payload: { stream: 'stdout' },
      at: '2026-06-29T00:00:00.000Z'
    };
    FakeEventSource.instances[0]?.emit('update', {
      data: JSON.stringify(event)
    } as MessageEvent);

    expect(FakeEventSource.instances[0]?.url).toBe('http://127.0.0.1:3099/api/events');
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

    const api = createBrowserTaskManagerApi('http://127.0.0.1:3099');
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
      url: 'http://127.0.0.1:3099/api/settings'
    });
    expect(calls[1]?.url).toBe('http://127.0.0.1:3099/api/settings');
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
});
