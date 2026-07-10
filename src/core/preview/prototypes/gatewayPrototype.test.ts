import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PrototypePreviewGateway } from './gatewayPrototype';

const closers: Array<() => Promise<void>> = [];
const serverSockets = new WeakMap<http.Server, Set<net.Socket>>();

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

describe('Phase 0 preview gateway prototype', () => {
  it('routes a .localhost hostname and replaces its target without changing the route', async () => {
    const first = await startHttpFixture((_request, response) => response.end('first'));
    const second = await startHttpFixture((_request, response) => response.end('second'));
    const gateway = await startGateway();
    const hostname = 'app.task-a.preview.localhost';

    gateway.instance.setRoute(hostname, { host: '127.0.0.1', port: first.port });
    await expect(requestGateway(gateway.port, hostname, '/')).resolves.toMatchObject({
      status: 200,
      body: 'first'
    });

    gateway.instance.setRoute(hostname, { host: '127.0.0.1', port: second.port });
    await expect(requestGateway(gateway.port, hostname, '/')).resolves.toMatchObject({
      status: 200,
      body: 'second'
    });
  });

  it('returns explicit unavailable and bad-target responses', async () => {
    const gateway = await startGateway();
    const hostname = 'missing.task-a.preview.localhost';
    await expect(requestGateway(gateway.port, hostname, '/')).resolves.toMatchObject({
      status: 503,
      body: 'Preview route is unavailable.'
    });

    const unusedPort = await reserveAndReleasePort();
    gateway.instance.setRoute(hostname, { host: '127.0.0.1', port: unusedPort });
    const result = await requestGateway(gateway.port, hostname, '/');
    expect(result.status).toBe(502);
    expect(result.body).toContain('Preview target failed');
  });

  it('streams SSE chunks without buffering the complete response', async () => {
    const upstream = await startHttpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      setTimeout(() => {
        response.end('data: second\n\n');
      }, 80);
    });
    const gateway = await startGateway();
    const hostname = 'events.task-a.preview.localhost';
    gateway.instance.setRoute(hostname, { host: '127.0.0.1', port: upstream.port });

    const chunks = await streamGateway(gateway.port, hostname, '/events');
    expect(chunks.join('')).toBe('data: first\n\ndata: second\n\n');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain('first');
  });

  it('tunnels an HTTP WebSocket upgrade and subsequent bytes', async () => {
    const upstream = await startUpgradeFixture();
    const gateway = await startGateway();
    const hostname = 'socket.task-a.preview.localhost';
    gateway.instance.setRoute(hostname, { host: '127.0.0.1', port: upstream.port });

    const response = await rawUpgrade(gateway.port, hostname);
    expect(response).toContain('101 Switching Protocols');
    expect(response).toContain('upstream-echo:ping');
  });
});

async function startGateway(): Promise<{ instance: PrototypePreviewGateway; port: number }> {
  const instance = new PrototypePreviewGateway();
  const port = await instance.listen();
  closers.push(() => instance.close());
  return { instance, port };
}

async function startHttpFixture(
  handler: http.RequestListener
): Promise<{ port: number }> {
  const server = http.createServer(handler);
  const port = await listen(server);
  closers.push(() => closeServer(server));
  return { port };
}

async function startUpgradeFixture(): Promise<{ port: number }> {
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n\r\n'
    );
    socket.on('data', (chunk) => socket.write(`upstream-echo:${chunk.toString('utf8')}`));
  });
  const port = await listen(server);
  closers.push(() => closeServer(server));
  return { port };
}

function requestGateway(
  port: number,
  hostname: string,
  requestPath: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        headers: { host: hostname }
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    request.once('error', reject);
    request.end();
  });
}

function streamGateway(port: number, hostname: string, requestPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, headers: { host: hostname } },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => resolve(chunks));
      }
    );
    request.once('error', reject);
    request.end();
  });
}

function rawUpgrade(port: number, hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let output = '';
    let sentPing = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for upgrade tunnel.'));
    }, 3000);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(
        `GET /socket HTTP/1.1\r\nHost: ${hostname}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
      );
    });
    socket.on('data', (chunk) => {
      output += chunk;
      if (!sentPing && output.includes('\r\n\r\n')) {
        sentPing = true;
        socket.write('ping');
      }
      if (output.includes('upstream-echo:ping')) {
        clearTimeout(timer);
        socket.end();
        resolve(output);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function reserveAndReleasePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function listen(server: http.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  serverSockets.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('No TCP address.'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  for (const socket of serverSockets.get(server) ?? []) {
    socket.destroy();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
