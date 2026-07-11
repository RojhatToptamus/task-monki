import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewReadinessService } from './PreviewReadinessService';

const servers: http.Server[] = [];
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
