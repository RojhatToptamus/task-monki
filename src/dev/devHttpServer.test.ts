import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskManagerService } from '../core/app/TaskManagerService';
import { AppEventBus } from '../core/runner/AppEventBus';
import { AttachmentStoreError } from '../core/storage/AttachmentFileStore';
import { TaskCreationRequestError } from '../core/storage/FileTaskStore';
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

    const unauthenticated = await fetch(`${running.baseUrl}/api/settings`);
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHORIZED', retryable: false }
    });

    const authenticated = await fetch(`${running.baseUrl}/api/settings`, {
      headers: running.headers
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('access-control-allow-origin')).toBeNull();
    expect(authenticated.headers.get('cache-control')).toBe('no-store');
    await expect(authenticated.json()).resolves.toEqual({});
  });

  it('returns a retryable 503 during the listen-to-token startup window', async () => {
    const running = await startServer({}, undefined, undefined, '');
    const response = await fetch(`${running.baseUrl}/api/settings`, {
      headers: running.headers
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'DEV_API_STARTING', retryable: true }
    });
  });

  it('rejects hostile origins and cross-site browser requests even with the proxy token', async () => {
    const running = await startServer();

    const hostileOrigin = await fetch(`${running.baseUrl}/api/settings`, {
      headers: { ...running.headers, origin: 'https://evil.test' }
    });
    expect(hostileOrigin.status).toBe(403);
    await expect(hostileOrigin.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ORIGIN' }
    });

    const crossSite = await fetch(`${running.baseUrl}/api/settings`, {
      headers: { ...running.headers, 'sec-fetch-site': 'cross-site' }
    });
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toMatchObject({
      error: { code: 'INVALID_FETCH_SITE' }
    });
  });

  it('accepts bounded JSON and rejects unsupported, malformed, and oversized bodies', async () => {
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
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE' }
    });

    const malformed = await fetch(`${running.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: '{'
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: 'INVALID_JSON' } });

    const oversized = await fetch(`${running.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(100) })
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: 'REQUEST_BODY_TOO_LARGE' }
    });
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

  it('accepts one bounded attachment batch and preserves no source path', async () => {
    const stageTaskAttachmentBatch = vi.fn(async (input: { attachments: Array<{ bytes: ArrayBuffer }> }) => ({
      id: 'draft-1',
      attachments: [{
        id: 'attachment-1',
        draftId: 'draft-1',
        clientToken: 'client-token-http-0001',
        ordinal: 0,
        displayName: 'notes.md',
        kind: 'text' as const,
        mediaType: 'text/markdown',
        byteCount: input.attachments[0]!.bytes.byteLength,
        sha256: 'a'.repeat(64),
        createdAt: '2026-07-10T00:00:00.000Z'
      }],
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z'
    }));
    const running = await startServer({ stageTaskAttachmentBatch });

    const bytes = new TextEncoder().encode('# Notes\n');
    const accepted = await fetch(`${running.baseUrl}/api/attachments/stage-batch`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ attachments: [{
        clientToken: 'client-token-http-0001',
        displayName: 'notes.md',
        bytesBase64: Buffer.from(bytes).toString('base64')
      }] })
    });
    expect(accepted.status).toBe(201);
    expect(stageTaskAttachmentBatch).toHaveBeenCalledWith({
      attachments: [expect.objectContaining({
        clientToken: 'client-token-http-0001',
        displayName: 'notes.md'
      })]
    });
    expect(
      Array.from(new Uint8Array(stageTaskAttachmentBatch.mock.calls[0][0].attachments[0].bytes))
    ).toEqual(Array.from(bytes));
    expect(JSON.stringify(stageTaskAttachmentBatch.mock.calls[0][0])).not.toContain('/Users/');

    const unsupported = await fetch(
      `${running.baseUrl}/api/attachments/stage-batch`,
      {
        method: 'POST',
        headers: { ...running.headers, 'content-type': 'application/octet-stream' },
        body: '# Notes'
      }
    );
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE' }
    });
  });

  it('returns safe attachment errors and inert no-store preview responses', async () => {
    const running = await startServer({
      discardTaskAttachmentDraft: vi.fn(async () => {
        throw new AttachmentStoreError(
          'ATTACHMENT_NOT_FOUND',
          'Attachment not found.',
          404
        );
      }),
      readTaskAttachment: vi.fn(async () => ({
        attachmentId: 'attachment-1',
        displayName: 'example.svg',
        kind: 'text' as const,
        mediaType: 'text/plain',
        byteCount: 11,
        bytes: new TextEncoder().encode('<svg></svg>').buffer
      }))
    });

    const missing = await fetch(`${running.baseUrl}/api/attachments/drafts/discard`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'missing' })
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found.' }
    });

    const preview = await fetch(
      `${running.baseUrl}/api/attachments/content?attachmentId=attachment-1`,
      { headers: running.headers }
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(preview.headers.get('content-disposition')).toContain('attachment');
    expect(preview.headers.get('cache-control')).toBe('private, no-store');
    expect(preview.headers.get('content-security-policy')).toContain('sandbox');
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(preview.text()).resolves.toBe('<svg></svg>');
  });

  it('returns a structured 409 when a task creation token is reused differently', async () => {
    const running = await startServer({
      createTask: vi.fn(async () => {
        throw new TaskCreationRequestError(
          'TASK_CREATION_CONFLICT',
          'This task creation retry token was already used for a different request.',
          409
        );
      })
    });

    const response = await fetch(`${running.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Changed task',
        prompt: 'Changed request.',
        repositoryId: 'repository-1',
        creationToken: 'task-create-http-conflict-0001'
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'TASK_CREATION_CONFLICT',
        message: 'This task creation retry token was already used for a different request.',
        retryable: false
      }
    });
  });

  it('bounds concurrent attachment buffering with a structured retryable error', async () => {
    let releaseUpload!: () => void;
    const uploadBlocked = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const stageTaskAttachmentBatch = vi.fn(async () => {
      await uploadBlocked;
      return {
        id: 'draft-1',
        attachments: [],
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z'
      };
    });
    const running = await startServer(
      { stageTaskAttachmentBatch },
      undefined,
      undefined,
      'private-test-token',
      { maxAttachmentOperations: 1 }
    );
    const uploadUrl = `${running.baseUrl}/api/attachments/stage-batch`;
    const uploadBody = JSON.stringify({ attachments: [{
      clientToken: 'client-token-http-0002',
      displayName: 'notes.txt',
      bytesBase64: 'YQ=='
    }] });
    const first = fetch(uploadUrl, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: uploadBody
    });
    await vi.waitFor(() => expect(stageTaskAttachmentBatch).toHaveBeenCalledTimes(1));

    const second = await fetch(uploadUrl, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: uploadBody
    });
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: 'ATTACHMENT_OPERATION_LIMIT', retryable: true }
    });

    releaseUpload();
    expect((await first).status).toBe(201);
  });

  it('keeps internal failures and paths out of structured responses', async () => {
    const logger = { error: vi.fn() };
    const running = await startServer(
      {
        addRepository: vi.fn(() => {
          throw new Error('Failed at /Users/private/secret.txt');
        })
      },
      undefined,
      logger
    );

    const response = await fetch(`${running.baseUrl}/api/repositories`, {
      method: 'POST',
      headers: { ...running.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/private/secret' })
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
    expect(body.error.requestId).toBeTruthy();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(body.error.requestId),
      expect.any(Error)
    );
  });

  it('authenticates SSE, streams events, and removes wildcard CORS', async () => {
    const running = await startServer();
    const response = await fetch(`${running.baseUrl}/api/events`, {
      headers: running.headers
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    const connected = decoder.decode((await reader!.read()).value);
    expect(connected).toContain(': connected');

    running.events.emit({
      type: 'projection.updated',
      taskId: 'task-1',
      payload: { source: 'test' },
      at: '2026-07-10T00:00:00.000Z'
    });
    const event = decoder.decode((await reader!.read()).value);
    expect(event).toContain('event: update');
    expect(event).toContain('task-1');
    await reader!.cancel();
  });

  it('bounds concurrent SSE clients and rejects excess streams', async () => {
    const running = await startServer({}, undefined, undefined, 'private-test-token', {
      maxEventStreamClients: 1
    });
    const first = await fetch(`${running.baseUrl}/api/events`, {
      headers: running.headers
    });
    expect(first.status).toBe(200);
    const reader = first.body?.getReader();
    expect(reader).toBeDefined();
    await reader!.read();

    const second = await fetch(`${running.baseUrl}/api/events`, {
      headers: running.headers
    });
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: 'EVENT_STREAM_LIMIT', retryable: true }
    });
    await reader!.cancel();
  });

  it('uses SSE as a compact invalidation signal instead of copying provider output', () => {
    const frame = createDevEventStreamFrame({
      type: 'run.output',
      taskId: 'task-1',
      runId: 'run-1',
      payload: { source: 'agent', text: 'x'.repeat(1024 * 1024) },
      at: '2026-07-10T00:00:00.000Z'
    });

    expect(Buffer.byteLength(frame)).toBeLessThan(512);
    expect(frame).toContain('"type":"run.output"');
    expect(frame).toContain('"payload":null');
    expect(frame).not.toContain('xxx');
  });

  it('preserves the preview generation identity in compact invalidation frames', () => {
    const frame = createDevEventStreamFrame({
      type: 'preview.updated',
      taskId: 'task-1',
      previewGenerationId: 'generation-1',
      payload: null,
      at: '2026-07-10T00:00:00.000Z'
    });

    expect(Buffer.byteLength(frame)).toBeLessThan(512);
    expect(frame).toContain('"previewGenerationId":"generation-1"');
  });
});

type ServerLimitOptions = Pick<
  DevHttpServerOptions,
  | 'maxEventStreamClients'
  | 'maxEventStreamBufferBytes'
  | 'maxAttachmentOperations'
  | 'maxAttachmentInFlightBytes'
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
    addRepository: vi.fn(async () => ({ id: 'repository-1' })),
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
  if (!running.devServer.server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    running.devServer.server.close((error) => (error ? reject(error) : resolve()));
    running.devServer.server.closeIdleConnections();
  });
}
