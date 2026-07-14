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
