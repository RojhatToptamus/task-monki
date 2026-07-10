/** Phase 0 prototype only. This is not the production preview gateway. */
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export interface PrototypeGatewayTarget {
  host: string;
  port: number;
}

export class PrototypePreviewGateway {
  private readonly routes = new Map<string, PrototypeGatewayTarget>();
  private readonly sockets = new Set<net.Socket>();
  private readonly server = http.createServer((request, response) => {
    this.proxyRequest(request, response);
  });

  constructor() {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('upgrade', (request, socket, head) => {
      this.proxyUpgrade(request, socket, head);
    });
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      throw new Error('Prototype gateway did not bind to IPv4 loopback.');
    }
    return address.port;
  }

  setRoute(hostname: string, target: PrototypeGatewayTarget): void {
    this.routes.set(normalizeHostname(hostname), target);
  }

  removeRoute(hostname: string): void {
    this.routes.delete(normalizeHostname(hostname));
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private proxyRequest(request: IncomingMessage, response: http.ServerResponse): void {
    const target = this.targetFor(request);
    if (!target) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Preview route is unavailable.');
      return;
    }

    const upstream = http.request(
      {
        hostname: target.host,
        port: target.port,
        method: request.method,
        path: request.url,
        headers: forwardedHeaders(request.headers, target)
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          upstreamResponse.headers
        );
        upstreamResponse.pipe(response);
      }
    );
    upstream.once('error', (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end(`Preview target failed: ${error.message}`);
    });
    request.pipe(upstream);
  }

  private proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = this.targetFor(request);
    if (!target) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }

    const upstream = net.connect(target.port, target.host);
    upstream.once('connect', () => {
      upstream.write(serializeUpgradeRequest(request, target));
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once('error', () => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    socket.once('error', () => upstream.destroy());
  }

  private targetFor(request: IncomingMessage): PrototypeGatewayTarget | undefined {
    return this.routes.get(normalizeHostname(request.headers.host ?? ''));
  }
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function forwardedHeaders(
  source: IncomingMessage['headers'],
  target: PrototypeGatewayTarget
): http.OutgoingHttpHeaders {
  return {
    ...source,
    host: `${target.host}:${target.port}`,
    'x-forwarded-host': source.host,
    'x-forwarded-proto': 'http'
  };
}

function serializeUpgradeRequest(
  request: IncomingMessage,
  target: PrototypeGatewayTarget
): string {
  const headers = forwardedHeaders(request.headers, target);
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}
