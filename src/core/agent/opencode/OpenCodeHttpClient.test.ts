import { describe, expect, it, vi } from 'vitest';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import {
  OpenCodeAmbiguousMutationError,
  OpenCodeHttpClient,
  OpenCodeSseParser
} from './OpenCodeHttpClient';

describe('OpenCodeHttpClient', () => {
  it('uses basic auth without writing credentials to the protocol journal', async () => {
    const journalRows: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
      return new Response(JSON.stringify({ healthy: true, version: '1.4.1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const client = createClient(fetchMock, journalRows);

    await client.get('/global/health');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(journalRows.join('\n')).not.toContain('top-secret');
    expect(journalRows[0]).toContain('GET');
  });

  it('redacts provider credentials from HTTP failure diagnostics', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        'Authorization: Bearer opencode-provider-secret OPENAI_API_KEY=opencode-body-secret',
        { status: 401 }
      )
    );
    const client = createClient(fetchMock, []);

    let failure: Error | undefined;
    try {
      await client.get('/provider');
    } catch (cause) {
      failure = cause as Error;
    }

    expect(failure?.message).toContain('[REDACTED]');
    expect(failure?.message).not.toContain('opencode-provider-secret');
    expect(failure?.message).not.toContain('opencode-body-secret');
  });

  it('preserves opaque operational values while redacting their journal copies', async () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const rows: string[] = [];
    const client = new OpenCodeHttpClient({
      baseUrl: 'http://127.0.0.1:4096',
      username: 'task-monki',
      password: 'secret',
      directory: '/repo',
      sensitiveValues: [opaque],
      fetch: vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ message: `provider echoed ${opaque}` }), {
          status: 200
        })
      ),
      journal: async (_direction, raw) => {
        rows.push(raw);
        return reference(rows.length, raw);
      }
    });

    await expect(client.get<{ message: string }>('/provider')).resolves.toMatchObject({
      data: { message: `provider echoed ${opaque}` }
    });
    expect(rows.join('\n')).not.toContain(opaque);
  });

  it('preserves opaque SSE routing IDs while redacting the journal event', async () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const rows: string[] = [];
    const client = new OpenCodeHttpClient({
      baseUrl: 'http://127.0.0.1:4096',
      username: 'task-monki',
      password: 'secret',
      directory: '/repo',
      sensitiveValues: [opaque],
      fetch: vi.fn<typeof fetch>(async () =>
        new Response(
          `data: ${JSON.stringify({
            type: 'session.status',
            properties: { sessionID: opaque, status: { type: 'busy' } }
          })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      ),
      journal: async (_direction, raw) => {
        rows.push(raw);
        return reference(rows.length, raw);
      }
    });
    let stream: { stop(): void } | undefined;
    const event = new Promise<unknown>((resolve) => {
      stream = client.startEventStream({
        onEvent: async (value) => {
          resolve(value);
          stream?.stop();
        },
        onDisconnect: async () => undefined,
        onReconnect: async () => undefined
      });
    });

    await expect(event).resolves.toMatchObject({
      properties: { sessionID: opaque }
    });
    expect(rows.join('\n')).not.toContain(opaque);
  });

  it('never retries an ambiguously delivered mutation', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('connection reset');
    });
    const client = createClient(fetchMock, []);

    await expect(client.post('/session/ses_1/prompt_async', { parts: [] })).rejects.toBeInstanceOf(
      OpenCodeAmbiguousMutationError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats every post-send acknowledgement failure as ambiguous', async () => {
    const brokenBodyFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('body reset'));
          }
        }),
        { status: 200 }
      )
    );
    await expect(
      createClient(brokenBodyFetch, []).post('/session/ses_1/prompt_async', {})
    ).rejects.toBeInstanceOf(OpenCodeAmbiguousMutationError);

    const invalidJsonFetch = vi.fn<typeof fetch>(async () =>
      new Response('not-json', { status: 200 })
    );
    await expect(
      createClient(invalidJsonFetch, []).post('/session/ses_1/prompt_async', {})
    ).rejects.toBeInstanceOf(OpenCodeAmbiguousMutationError);

    const journalFailureClient = new OpenCodeHttpClient({
      baseUrl: 'http://127.0.0.1:4096',
      username: 'task-monki',
      password: 'secret',
      directory: '/repo',
      fetch: vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 })),
      journal: async (direction) => {
        if (direction === 'INBOUND') throw new Error('disk full');
        return reference();
      }
    });
    await expect(
      journalFailureClient.post('/session/ses_1/prompt_async', {})
    ).rejects.toBeInstanceOf(OpenCodeAmbiguousMutationError);

    expect(brokenBodyFetch).toHaveBeenCalledTimes(1);
    expect(invalidJsonFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the mutation timeout active while the acknowledgement body is streaming', async () => {
    const stalledBodyFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        new ReadableStream({
          start() {
            // Headers arrive, but the response body never produces data or EOF.
          }
        }),
        { status: 200 }
      )
    );
    const client = new OpenCodeHttpClient({
      baseUrl: 'http://127.0.0.1:4096',
      username: 'task-monki',
      password: 'secret',
      directory: '/repo',
      requestTimeoutMs: 20,
      fetch: stalledBodyFetch,
      journal: async () => reference()
    });

    await expect(
      client.post('/session/ses_1/prompt_async', {})
    ).rejects.toBeInstanceOf(OpenCodeAmbiguousMutationError);
    expect(stalledBodyFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired caller deadline before journaling or submitting a request', async () => {
    const rows: string[] = [];
    const fetchMock = vi.fn<typeof fetch>();
    const client = createClient(fetchMock, rows);

    await expect(
      client.get('/session/status', { deadlineAt: Date.now() - 1 })
    ).rejects.toThrow('exceeded its caller deadline before it was sent');
    expect(rows).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes outbound journal persistence and HTTP response time in the caller deadline', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        );
      })
    );
    const journalNeverSettles = new OpenCodeHttpClient({
      baseUrl: 'http://127.0.0.1:4096',
      username: 'task-monki',
      password: 'secret',
      directory: '/repo',
      fetch: fetchMock,
      journal: async () => new Promise<AgentProtocolMessageReference>(() => undefined)
    });
    const journalStartedAt = Date.now();
    await expect(
      journalNeverSettles.get('/session/status', { deadlineAt: Date.now() + 25 })
    ).rejects.toThrow('timed out before its outbound journal entry was persisted');
    expect(Date.now() - journalStartedAt).toBeLessThan(500);
    expect(fetchMock).not.toHaveBeenCalled();

    const stalledFetch = vi.fn<typeof fetch>(async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        );
      })
    );
    const responseNeverSettles = createClient(stalledFetch, []);
    const requestStartedAt = Date.now();
    await expect(
      responseNeverSettles.get('/session/status', { deadlineAt: Date.now() + 25 })
    ).rejects.toThrow('did not produce an authoritative HTTP response');
    expect(Date.now() - requestStartedAt).toBeLessThan(500);
    expect(stalledFetch).toHaveBeenCalledTimes(1);
  });

  it('parses fragmented, multiline SSE events and ignores heartbeats', async () => {
    const events: string[] = [];
    const parser = new OpenCodeSseParser(async (data) => {
      events.push(data);
    });
    await parser.push(new TextEncoder().encode(': keepalive\r\ndata: {"type":"session.'));
    await parser.push(new TextEncoder().encode('status",\r\ndata: "properties":{}}\r\n\r\n'));
    await parser.finish();

    expect(events).toEqual(['{"type":"session.status",\n"properties":{}}']);
  });

  it('keeps reconnecting when a disconnect callback fails', async () => {
    vi.useFakeTimers();
    try {
      let connection = 0;
      const fetchMock = vi.fn<typeof fetch>(async () => {
        connection += 1;
        return new Response(
          `data: {"type":"server.connected","properties":{"connection":${connection}}}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        );
      });
      const client = createClient(fetchMock, []);
      const events: unknown[] = [];
      let disconnects = 0;
      let reconnects = 0;
      const stream = client.startEventStream({
        onEvent: async (value) => {
          events.push(value);
        },
        onDisconnect: async () => {
          disconnects += 1;
          throw new Error('simulated telemetry persistence failure');
        },
        onReconnect: async () => {
          reconnects += 1;
        }
      });

      await vi.waitFor(() => expect(events).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(events).toHaveLength(2));
      stream.stop();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(disconnects).toBeGreaterThanOrEqual(1);
      expect(reconnects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createClient(fetchImplementation: typeof fetch, rows: string[]): OpenCodeHttpClient {
  let sequence = 0;
  return new OpenCodeHttpClient({
    baseUrl: 'http://127.0.0.1:4096',
    username: 'task-monki',
    password: 'top-secret',
    directory: '/repo',
    fetch: fetchImplementation,
    journal: async (_direction, raw): Promise<AgentProtocolMessageReference> => {
      rows.push(raw);
      sequence += 1;
      return reference(sequence, raw);
    }
  });
}

function reference(sequence = 1, raw = '{}'): AgentProtocolMessageReference {
  return {
    serverInstanceId: 'server-1',
    sequence,
    direction: 'OUTBOUND',
    recordedAt: new Date().toISOString(),
    byteOffset: 0,
    byteLength: Buffer.byteLength(raw),
    sha256: '0'.repeat(64)
  };
}
