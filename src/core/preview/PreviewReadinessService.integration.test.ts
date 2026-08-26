import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewReadinessService } from './PreviewReadinessService';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.allSettled(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('PreviewReadinessService', () => {
  it('waits for an accepted direct HTTP observation', async () => {
    let requests = 0;
    const port = await startServer((_request, response) => {
      requests += 1;
      response.writeHead(requests < 2 ? 503 : 204).end();
    });
    const result = await new PreviewReadinessService().waitForHttp({
      port,
      path: '/ready',
      timeoutMs: 2_000,
      intervalMs: 10
    });
    expect(result).toMatchObject({ status: 'PASSED', lastStatusCode: 204 });
    expect(requests).toBeGreaterThanOrEqual(2);
  });

  it('returns a compact failure instead of treating process existence as readiness', async () => {
    const result = await new PreviewReadinessService().waitForHttp({
      port: 65_534,
      path: '/ready',
      timeoutMs: 50,
      requestTimeoutMs: 20,
      intervalMs: 5
    });
    expect(result.status).toBe('FAILED');
    expect(result.lastError?.length).toBeLessThanOrEqual(512);
  });

  it('observes TCP readiness directly on IPv4 loopback', async () => {
    const server = net.createServer((socket) => socket.end());
    servers.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') reject(new Error('No server address.'));
        else resolve(address.port);
      });
    });
    await expect(new PreviewReadinessService().waitForTcp({ port, timeoutMs: 500 })).resolves.toMatchObject({
      status: 'PASSED'
    });
  });

  it('accepts response headers without waiting for a slow or unbounded body', async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(200);
      response.write('first');
      const timer = setInterval(() => response.write('more'), 20);
      response.once('close', () => clearInterval(timer));
    });
    const started = Date.now();
    const result = await new PreviewReadinessService().waitForHttp({
      port,
      path: '/ready',
      timeoutMs: 100,
      requestTimeoutMs: 100
    });
    expect(result).toMatchObject({ status: 'PASSED', lastStatusCode: 200 });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('uses an absolute request deadline when response headers never arrive', async () => {
    const port = await startServer((_request, response) => {
      const timer = setInterval(() => response.socket?.write(''), 5);
      response.once('close', () => clearInterval(timer));
    });
    const started = Date.now();
    const result = await new PreviewReadinessService().waitForHttp({
      port,
      path: '/ready',
      timeoutMs: 80,
      requestTimeoutMs: 40,
      intervalMs: 5
    });
    expect(result.status).toBe('FAILED');
    expect(Date.now() - started).toBeLessThan(200);
  });
});

function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('No server address.'));
      else resolve(address.port);
    });
  });
}
