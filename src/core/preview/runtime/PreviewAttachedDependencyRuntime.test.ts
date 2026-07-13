import { describe, expect, it, vi } from 'vitest';
import {
  PreviewAttachedDependencyRuntime,
  attachmentEnvironmentValue,
  probeAttachedPostgres,
  type AttachedPostgresClient
} from './PreviewAttachedDependencyRuntime';

describe('PreviewAttachedDependencyRuntime', () => {
  it('bounds an unavailable TCP observation and returns a safe failure code', async () => {
    const runtime = new PreviewAttachedDependencyRuntime();
    expect(await runtime.check({ id: 'smtp', type: 'tcp', target: { type: 'endpoint', host: '127.0.0.1', port: 1 }, check: { timeoutSeconds: 1 } }, {})).toMatchObject({ status: 'FAILED', failureCode: 'TARGET_UNAVAILABLE' });
  });

  it('derives stable task-route authority without resolving a producer generation', () => {
    expect(attachmentEnvironmentValue({ id: 'api', type: 'http', target: { type: 'task-preview-route', targetTaskId: 'Task-123', routeId: 'api', basePath: '/' } }, 'attached-http-origin', {}, 4123)).toBe('http://api.task-task123.preview.localhost:4123');
  });

  it('checks a task route through the current gateway authority', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 })
    );
    try {
      const runtime = new PreviewAttachedDependencyRuntime();
      await expect(runtime.check({
        id: 'api',
        type: 'http',
        target: {
          type: 'task-preview-route', targetTaskId: 'Task-123', routeId: 'api', basePath: '/v1/'
        },
        check: { path: '/ready', timeoutSeconds: 1 }
      }, {}, undefined, 4123)).resolves.toMatchObject({ status: 'PASSED' });
      expect(fetch).toHaveBeenCalledWith(
        new URL('http://api.task-task123.preview.localhost:4123/v1/ready'),
        expect.objectContaining({ method: 'GET', redirect: 'manual' })
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it('returns cancellation immediately for an already-aborted check without leaving work alive', async () => {
    const controller = new AbortController();
    controller.abort(new Error('preview canceled'));
    const runtime = new PreviewAttachedDependencyRuntime();
    await expect(runtime.check(
      { id: 'smtp', type: 'tcp', target: { type: 'endpoint', host: '127.0.0.1', port: 25 }, check: { timeoutSeconds: 10 } },
      {},
      controller.signal
    )).resolves.toMatchObject({ status: 'FAILED', failureCode: 'CHECK_CANCELED' });
  });

  it('closes and joins an authenticated PostgreSQL client when canceled', async () => {
    const controller = new AbortController();
    let rejectConnect!: (error: Error) => void;
    let ended = 0;
    const client: AttachedPostgresClient = {
      connect: () => new Promise((_resolve, reject) => { rejectConnect = reject; }),
      async query() {},
      async end() { ended += 1; rejectConnect(new Error('closed')); }
    };
    const operation = probeAttachedPostgres({
      attachment: {
        id: 'database',
        type: 'postgres',
        target: {
          type: 'endpoint', host: '127.0.0.1', port: 5432,
          database: 'app', username: 'reader', tls: 'disabled'
        }
      },
      password: 'transient-password',
      signal: controller.signal,
      timeoutMs: 100
    }, (config) => {
      expect(config).toMatchObject({
        host: '127.0.0.1', port: 5432, database: 'app', user: 'reader',
        password: 'transient-password', connectionTimeoutMillis: 100, query_timeout: 100
      });
      return client;
    });
    await Promise.resolve();
    controller.abort(new Error('preview canceled'));
    await expect(operation).rejects.toThrow('preview canceled');
    expect(ended).toBe(1);
  });
});
