import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskManagerService } from '../core/app/TaskManagerService';
import { AppEventBus } from '../core/runner/AppEventBus';
import {
  DEV_API_TOKEN_HEADER,
  devRendererOrigin,
  type DevApiSecurityConfig
} from './devApiSecurity';
import {
  createDevEventStreamFrame,
  createDevHttpServer,
  type DevHttpServer,
  type DevHttpServerOptions
} from './devHttpServer';

interface RunningServer {
  devServer: DevHttpServer;
  baseUrl: string;
  headers: Record<string, string>;
  service: TaskManagerService;
  events: AppEventBus;
}

const runningServers: RunningServer[] = [];

describe('development HTTP server', () => {
  afterEach(async () => {
    await Promise.all(runningServers.splice(0).map(stopServer));
  });

  it('requires proxy authentication and emits no permissive CORS headers', async () => {
    const running = await startServer();

    const unauthenticated = await fetch(`${running.baseUrl}/api/defaultRepositoryPath`);
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHORIZED', retryable: false }
    });

    const authenticated = await fetch(`${running.baseUrl}/api/defaultRepositoryPath`, {
      headers: running.headers
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('access-control-allow-origin')).toBeNull();
    expect(authenticated.headers.get('cache-control')).toBe('no-store');
    await expect(authenticated.json()).resolves.toBe('/trusted/repository');
  });

  it('returns a retryable 503 during the listen-to-token startup window', async () => {
    const running = await startServer({}, undefined, undefined, '');
    const response = await fetch(`${running.baseUrl}/api/defaultRepositoryPath`, {
      headers: running.headers
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'DEV_API_STARTING', retryable: true }
    });
  });

  it('rejects hostile Host, Origin, and Fetch Metadata with the proxy token', async () => {
    const running = await startServer();

    const hostileHost = await requestWithExplicitHost(
      `${running.baseUrl}/api/defaultRepositoryPath`,
      { ...running.headers, host: 'evil.test' }
    );
    expect(hostileHost.statusCode).toBe(403);
    expect(JSON.parse(hostileHost.body)).toMatchObject({
      error: { code: 'INVALID_HOST' }
    });

    const hostileOrigin = await fetch(`${running.baseUrl}/api/defaultRepositoryPath`, {
      headers: { ...running.headers, origin: 'https://evil.test' }
    });
    expect(hostileOrigin.status).toBe(403);
    await expect(hostileOrigin.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ORIGIN' }
    });

    const crossSite = await fetch(`${running.baseUrl}/api/defaultRepositoryPath`, {
      headers: { ...running.headers, 'sec-fetch-site': 'cross-site' }
    });
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toMatchObject({
      error: { code: 'INVALID_FETCH_SITE' }
    });
  });

  it('accepts bounded JSON and rejects unsupported, malformed, compressed, and oversized bodies', async () => {
    const updateAppSettings = vi.fn(async (input: unknown) => input);
    const running = await startServer({ updateAppSettings }, 64);

    const accepted = await fetch(`${running.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' })
    });
    expect(accepted.status).toBe(200);
    expect(updateAppSettings).toHaveBeenCalledWith({ theme: 'dark' });

    const unsupported = await fetch(`${running.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'text/plain' },
      body: '{}'
    });
    expect(unsupported.status).toBe(415);

    const malformed = await fetch(`${running.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: '{'
    });
    expect(malformed.status).toBe(400);

    const compressed = await fetch(`${running.baseUrl}/api/settings`, {
      method: 'POST',
      headers: {
        ...running.headers,
        'content-type': 'application/json',
        'content-encoding': 'gzip'
      },
      body: '{}'
    });
    expect(compressed.status).toBe(415);

    const oversized = await fetch(`${running.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(100) })
    });
    expect(oversized.status).toBe(413);
    expect(updateAppSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps current preview endpoints behind the hardened boundary', async () => {
    const startPreview = vi.fn(async (input: unknown) => ({ id: 'generation-1', input }));
    const running = await startServer({ startPreview });

    const response = await fetch(`${running.baseUrl}/api/preview/start`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1' })
    });

    expect(response.status).toBe(200);
    expect(startPreview).toHaveBeenCalledWith({ taskId: 'task-1' });
    await expect(response.json()).resolves.toMatchObject({ id: 'generation-1' });
  });

  it('keeps internal failures and paths out of structured responses', async () => {
    const logger = { error: vi.fn() };
    const running = await startServer(
      {
        getDefaultRepositoryPath: vi.fn(() => {
          throw new Error('Failed at /Users/private/secret.txt');
        })
      },
      undefined,
      logger
    );

    const response = await fetch(`${running.baseUrl}/api/defaultRepositoryPath`, {
      headers: running.headers
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string; retryable: boolean };
    };
    expect(body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'The development API could not complete the request.',
      retryable: true
    });
    expect(JSON.stringify(body)).not.toContain('/Users/private');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(body.error.requestId),
      expect.any(Error)
    );
  });

  it('authenticates bounded compact SSE invalidations', async () => {
    const running = await startServer(
      {},
      undefined,
      undefined,
      'private-test-token',
      { maxEventStreamClients: 1 }
    );
    const first = await fetch(`${running.baseUrl}/api/events`, {
      headers: running.headers
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('access-control-allow-origin')).toBeNull();
    const reader = first.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader!.read()).value)).toContain(': connected');

    running.events.emit({
      type: 'run.output',
      taskId: 'task-1',
      runId: 'run-1',
      payload: { text: 'x'.repeat(1024 * 1024) },
      at: '2026-07-10T00:00:00.000Z'
    });
    const event = decoder.decode((await reader!.read()).value);
    expect(event).toContain('"payload":null');
    expect(event).not.toContain('xxx');

    const excess = await fetch(`${running.baseUrl}/api/events`, {
      headers: running.headers
    });
    expect(excess.status).toBe(429);
    await reader!.cancel();
  });

  it('creates compact event frames without provider payload duplication', () => {
    const frame = createDevEventStreamFrame({
      type: 'preview.updated',
      taskId: 'task-1',
      previewGenerationId: 'generation-1',
      payload: { text: 'x'.repeat(1024 * 1024) },
      at: '2026-07-10T00:00:00.000Z'
    });

    expect(Buffer.byteLength(frame)).toBeLessThan(512);
    expect(frame).toContain('"previewGenerationId":"generation-1"');
    expect(frame).toContain('"payload":null');
  });
});

type ServerLimitOptions = Pick<
  DevHttpServerOptions,
  'maxEventStreamClients' | 'maxEventStreamBufferBytes'
>;

async function startServer(
  overrides: Record<string, unknown> = {},
  maxJsonBodyBytes?: number,
  logger?: Pick<Console, 'error'>,
  token = 'private-test-token',
  eventStreamOptions: ServerLimitOptions = {}
): Promise<RunningServer> {
  const events = new AppEventBus();
  const service = {
    events,
    getDefaultRepositoryPath: vi.fn(() => '/trusted/repository'),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async (input: unknown) => input),
    ...overrides
  } as unknown as TaskManagerService;
  const security: DevApiSecurityConfig = {
    token,
    expectedHost: '',
    expectedOrigin: devRendererOrigin(5173)
  };
  const devServer = createDevHttpServer({
    service,
    security,
    chooseRepositoryFolder: async () => undefined,
    maxJsonBodyBytes,
    logger,
    ...eventStreamOptions
  });
  await new Promise<void>((resolve, reject) => {
    devServer.server.once('error', reject);
    devServer.server.listen(0, '127.0.0.1', resolve);
  });
  const address = devServer.server.address() as AddressInfo;
  security.expectedHost = `127.0.0.1:${address.port}`;
  const running: RunningServer = {
    devServer,
    baseUrl: `http://${security.expectedHost}`,
    headers: {
      [DEV_API_TOKEN_HEADER]: security.token || 'not-ready',
      origin: security.expectedOrigin,
      'sec-fetch-site': 'same-origin'
    },
    service,
    events
  };
  runningServers.push(running);
  return running;
}

async function stopServer(running: RunningServer): Promise<void> {
  running.devServer.closeEventStreams();
  running.devServer.dispose();
  if (!running.devServer.server.listening) return;
  await new Promise<void>((resolve, reject) => {
    running.devServer.server.close((error) => (error ? reject(error) : resolve()));
    running.devServer.server.closeIdleConnections();
    running.devServer.server.closeAllConnections();
  });
}

async function requestWithExplicitHost(
  url: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    request.once('error', reject);
    request.end();
  });
}
