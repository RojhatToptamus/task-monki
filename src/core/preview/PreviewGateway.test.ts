import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewGateway } from './PreviewGateway';
import { previewRouteHostname } from './PreviewRouteHostname';

const closers: Array<() => Promise<void>> = [];
const sockets = new WeakMap<http.Server, Set<net.Socket>>();
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

describe('PreviewGateway', () => {
  it('routes and replaces a stable .localhost target', async () => {
    const first = await fixture((_request, response) => response.end('first'));
    const second = await fixture((_request, response) => response.end('second'));
    const gateway = await startGateway();
    const hostname = previewRouteHostname('task-a', 'app');
    gateway.instance.replaceRoutes('first', { [hostname]: { host: '127.0.0.1', port: first } });
    await expect(request(gateway.port, hostname)).resolves.toMatchObject({ status: 200, body: 'first' });
    gateway.instance.replaceRoutes('second', { [hostname]: { host: '127.0.0.1', port: second } }, 'first');
    await expect(request(gateway.port, hostname)).resolves.toMatchObject({ status: 200, body: 'second' });
  });

  it('replaces multiple routes as one owned set and refuses stale-owner cleanup', async () => {
    const oldTarget = await fixture((_request, response) => response.end('old'));
    const newApp = await fixture((_request, response) => response.end('new-app'));
    const candidateOnlyTarget = await fixture((_request, response) => response.end('candidate-only'));
    const gateway = await startGateway();
    const app = previewRouteHostname('task-owned', 'app');
    const api = previewRouteHostname('task-owned', 'api');
    const metrics = previewRouteHostname('task-owned', 'metrics');
    gateway.instance.replaceRoutes('old-generation', {
      [app]: { host: '127.0.0.1', port: oldTarget },
      [api]: { host: '127.0.0.1', port: oldTarget }
    });
    gateway.instance.replaceRoutes(
      'new-generation',
      {
        [app]: { host: '127.0.0.1', port: newApp },
        [metrics]: { host: '127.0.0.1', port: candidateOnlyTarget }
      },
      'old-generation'
    );
    await expect(request(gateway.port, app)).resolves.toMatchObject({ body: 'new-app' });
    await expect(request(gateway.port, api)).resolves.toMatchObject({
      status: 503,
      body: 'Preview route is unavailable.'
    });
    await expect(request(gateway.port, metrics)).resolves.toMatchObject({ body: 'candidate-only' });

    gateway.instance.removeOwnedRoutes('old-generation');
    await expect(request(gateway.port, app)).resolves.toMatchObject({ body: 'new-app' });
    await expect(request(gateway.port, metrics)).resolves.toMatchObject({ body: 'candidate-only' });

    gateway.instance.replaceRoutes(
      'old-generation',
      {
        [app]: { host: '127.0.0.1', port: oldTarget },
        [api]: { host: '127.0.0.1', port: oldTarget }
      },
      'new-generation'
    );
    await expect(request(gateway.port, app)).resolves.toMatchObject({ body: 'old' });
    await expect(request(gateway.port, api)).resolves.toMatchObject({ body: 'old' });
    await expect(request(gateway.port, metrics)).resolves.toMatchObject({
      status: 503,
      body: 'Preview route is unavailable.'
    });
  });

  it('relocates a colliding preferred gateway port and returns bounded route/upstream errors', async () => {
    const occupied = await fixture((_request, response) => response.end('occupied'));
    const instance = new PreviewGateway();
    const listening = await instance.listen(occupied);
    closers.push(() => instance.close());
    expect(listening.relocated).toBe(true);
    expect(listening.port).not.toBe(occupied);
    const hostname = previewRouteHostname('task-a', 'missing');
    await expect(request(listening.port, hostname)).resolves.toEqual({
      status: 503,
      body: 'Preview route is unavailable.'
    });
    const unused = await reserveAndRelease();
    instance.replaceRoutes('missing', { [hostname]: { host: '127.0.0.1', port: unused } });
    const failed = await request(listening.port, hostname);
    expect(failed).toEqual({ status: 502, body: 'Preview target is unavailable.' });
  });

  it('strips hop-by-hop headers and streams SSE chunks', async () => {
    const upstream = await fixture((request, response) => {
      expect(request.headers['x-remove-me']).toBeUndefined();
      expect(request.headers.connection).not.toContain('x-remove-me');
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'x-upstream-only',
        'x-upstream-only': 'remove-me'
      });
      response.write('data: first\n\n');
      setTimeout(() => response.end('data: second\n\n'), 30);
    });
    const gateway = await startGateway();
    const hostname = previewRouteHostname('task-a', 'events');
    gateway.instance.replaceRoutes('events', { [hostname]: { host: '127.0.0.1', port: upstream } });
    const result = await stream(gateway.port, hostname, {
      connection: 'x-remove-me',
      'x-remove-me': 'remove-me'
    });
    expect(result.chunks.join('')).toBe('data: first\n\ndata: second\n\n');
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    expect(result.headers['x-upstream-only']).toBeUndefined();
  });

  it('preserves stable authority and rewrites target-origin absolute redirects', async () => {
    let upstreamHeaders: http.IncomingHttpHeaders | undefined;
    const upstream = await fixture((request, response) => {
      upstreamHeaders = request.headers;
      const address = request.socket.localAddress;
      const port = request.socket.localPort;
      response.writeHead(302, {
        location: `http://${address}:${port}/signed-in?next=1`,
        'set-cookie': 'preview-session=retained; Path=/; HttpOnly; SameSite=Lax'
      }).end();
    });
    const gateway = await startGateway();
    const hostname = previewRouteHostname('task-a', 'redirect');
    const authority = `${hostname}:${gateway.port}`;
    gateway.instance.replaceRoutes('redirect', { [hostname]: { host: '127.0.0.1', port: upstream } });
    const result = await requestWithHeaders(gateway.port, authority, {
      origin: `http://${authority}`,
      cookie: 'browser-session=truthful'
    });
    expect(upstreamHeaders).toMatchObject({
      host: authority,
      origin: `http://${authority}`,
      cookie: 'browser-session=truthful',
      'x-forwarded-host': authority,
      'x-forwarded-port': String(gateway.port),
      'x-forwarded-proto': 'http'
    });
    expect(result.headers.location).toBe(`http://${authority}/signed-in?next=1`);
    expect(result.headers['set-cookie']).toEqual([
      'preview-session=retained; Path=/; HttpOnly; SameSite=Lax'
    ]);
  });

  it('tunnels an HTTP upgrade and subsequent bytes', async () => {
    const server = http.createServer();
    let upgradeHeaders: http.IncomingHttpHeaders | undefined;
    server.on('upgrade', (request, socket) => {
      upgradeHeaders = request.headers;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`));
    });
    const upstream = await listen(server);
    closers.push(() => closeServer(server));
    const gateway = await startGateway();
    const hostname = previewRouteHostname('task-a', 'socket');
    const authority = `${hostname}:${gateway.port}`;
    gateway.instance.replaceRoutes('socket', { [hostname]: { host: '127.0.0.1', port: upstream } });
    await expect(rawUpgrade(gateway.port, authority)).resolves.toContain('echo:ping');
    expect(upgradeHeaders).toMatchObject({
      host: authority,
      origin: `http://${authority}`,
      'x-forwarded-host': authority,
      'x-forwarded-port': String(gateway.port),
      'x-forwarded-proto': 'http'
    });
  });

  it('tracks a reused upstream socket once across sustained asset traffic', async () => {
    const upstream = await fixture((_request, response) => response.end('asset'));
    const gateway = await startGateway();
    const hostname = previewRouteHostname('task-a', 'assets');
    gateway.instance.replaceRoutes('assets', {
      [hostname]: { host: '127.0.0.1', port: upstream }
    });
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    try {
      for (let index = 0; index < 24; index += 1) {
        await expect(request(gateway.port, hostname)).resolves.toMatchObject({
          status: 200,
          body: 'asset'
        });
      }
      expect(
        warningSpy.mock.calls.filter(([warning]) =>
          warning instanceof Error
            ? warning.name === 'MaxListenersExceededWarning'
            : String(warning).includes('Possible EventEmitter memory leak')
        )
      ).toEqual([]);
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('rejects legacy, malformed, and foreign route registrations', async () => {
    const upstream = await fixture((_request, response) => response.end('unused'));
    const gateway = await startGateway();

    for (const hostname of [
      'app.task-a.preview.localhost',
      'other.localhost',
      'tm-deadbeef.localhost',
      'tm-c56924243da73fb3ca189a97b3ea51d3.example.com',
      'TM-C56924243DA73FB3CA189A97B3EA51D3.LOCALHOST',
      'tm-c56924243da73fb3ca189a97b3ea51d3.localhost.',
      'tm-c56924243da73fb3ca189a97b3ea51d3.localhost:31337'
    ]) {
      expect(() => gateway.instance.replaceRoutes('invalid', {
        [hostname]: { host: '127.0.0.1', port: upstream }
      })).toThrow('Task Monki single-label .localhost hostname');
    }
  });
});

async function startGateway() {
  const instance = new PreviewGateway();
  const { port } = await instance.listen();
  closers.push(() => instance.close());
  return { instance, port };
}

async function fixture(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  const port = await listen(server);
  closers.push(() => closeServer(server));
  return port;
}

function request(port: number, hostname: string): Promise<{ status: number; body: string }> {
  return requestWithHeaders(port, hostname).then(({ status, body }) => ({ status, body }));
}

function requestWithHeaders(
  port: number,
  hostname: string,
  extra: http.OutgoingHttpHeaders = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, headers: { host: hostname, ...extra } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.once('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.once('error', reject);
    req.end();
  });
}

function stream(port: number, hostname: string, extra: http.OutgoingHttpHeaders) {
  return new Promise<{ chunks: string[]; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const chunks: string[] = [];
    const req = http.request(
      { host: '127.0.0.1', port, headers: { host: hostname, ...extra } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => chunks.push(chunk));
        res.once('end', () => resolve({ chunks, headers: res.headers }));
      }
    );
    req.once('error', reject);
    req.end();
  });
}

function rawUpgrade(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let output = '';
    let pinged = false;
    const timer = setTimeout(() => reject(new Error('Upgrade timed out.')), 2_000);
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${authority}\r\nOrigin: http://${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
      )
    );
    socket.on('data', (chunk) => {
      output += chunk;
      if (!pinged && output.includes('\r\n\r\n')) {
        pinged = true;
        socket.write('ping');
      }
      if (output.includes('echo:ping')) {
        clearTimeout(timer);
        socket.end();
        resolve(output);
      }
    });
    socket.once('error', reject);
  });
}

async function reserveAndRelease(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function listen(server: http.Server): Promise<number> {
  const active = new Set<net.Socket>();
  sockets.set(server, active);
  server.on('connection', (socket) => {
    active.add(socket);
    socket.once('close', () => active.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('No address.'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  for (const socket of sockets.get(server) ?? []) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}
