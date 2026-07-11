import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import net from 'node:net';
import { randomInt } from 'node:crypto';
import type { Duplex } from 'node:stream';

export interface PreviewGatewayTarget {
  host: '127.0.0.1';
  port: number;
  generationId: string;
}

export interface PreviewGatewayListenResult {
  port: number;
  relocated: boolean;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

export class PreviewGateway {
  private readonly routes = new Map<string, PreviewGatewayTarget>();
  private readonly sockets = new Set<net.Socket>();
  private readonly upstreamSockets = new Set<net.Socket>();
  private readonly server = http.createServer((request, response) => {
    this.proxyRequest(request, response);
  });

  constructor() {
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 30_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.on('connection', (socket) => trackSocket(this.sockets, socket));
    this.server.on('upgrade', (request, socket, head) => {
      this.proxyUpgrade(request, socket, head);
    });
  }

  async listen(preferredPort = 0): Promise<PreviewGatewayListenResult> {
    if (this.server.listening) {
      const address = this.server.address();
      if (!address || typeof address === 'string') throw new Error('Gateway address is unavailable.');
      return { port: address.port, relocated: false };
    }
    if (preferredPort === 0) {
      return { port: await this.bindAvailableHighPort(), relocated: false };
    }
    try {
      return { port: await this.bind(preferredPort), relocated: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      return { port: await this.bindAvailableHighPort(), relocated: true };
    }
  }

  setRoute(hostname: string, target: PreviewGatewayTarget): void {
    const normalized = normalizeHostname(hostname);
    if (!normalized.endsWith('.preview.localhost') || normalized.split('.').length < 4) {
      throw new Error('Preview gateway routes must use a scoped .preview.localhost hostname.');
    }
    if (target.host !== '127.0.0.1' || !isValidPort(target.port)) {
      throw new Error('Preview gateway targets must be valid IPv4 loopback ports.');
    }
    this.routes.set(normalized, target);
  }

  replaceRoutes(generationId: string, routes: Record<string, Omit<PreviewGatewayTarget, 'generationId'>>): void {
    const replacements = Object.entries(routes).map(([hostname, target]) => {
      const normalized = normalizeHostname(hostname);
      validateRoute(normalized, target);
      return [normalized, { ...target, generationId }] as const;
    });
    if (new Set(replacements.map(([hostname]) => hostname)).size !== replacements.length) {
      throw new Error('Preview gateway replacement contains duplicate hostnames.');
    }
    for (const [hostname, target] of replacements) this.routes.set(hostname, target);
  }

  removeRoute(hostname: string, generationId: string): void {
    const normalized = normalizeHostname(hostname);
    if (this.routes.get(normalized)?.generationId === generationId) this.routes.delete(normalized);
  }

  removeOwnedRoutes(generationId: string): void {
    for (const [hostname, target] of this.routes) {
      if (target.generationId === generationId) this.routes.delete(hostname);
    }
  }

  clearRoutes(): void {
    this.routes.clear();
  }

  hasRoute(hostname: string): boolean {
    return this.routes.has(normalizeHostname(hostname));
  }

  async close(): Promise<void> {
    this.routes.clear();
    for (const socket of [...this.sockets, ...this.upstreamSockets]) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  private bind(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
          reject(new Error('Preview gateway did not bind IPv4 loopback.'));
          return;
        }
        resolve(address.port);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, '127.0.0.1');
    });
  }

  private async bindAvailableHighPort(): Promise<number> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      try {
        return await this.bind(randomInt(32_000, 49_000));
      } catch (error) {
        if (['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
    }
    throw new Error('Unable to bind a Task Monki preview gateway port in the configured high range.');
  }

  private proxyRequest(request: IncomingMessage, response: http.ServerResponse): void {
    const target = this.targetFor(request);
    if (!target) {
      sendBoundedError(response, 503, 'Preview route is unavailable.');
      return;
    }
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: request.method,
        path: request.url,
        headers: forwardedHeaders(request.headers, target)
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          rewriteResponseHeaders(
            upstreamResponse.headers,
            target,
            request.headers.host
          )
        );
        upstreamResponse.pipe(response);
      }
    );
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('Preview upstream timed out.')));
    upstream.on('socket', (socket) => trackSocket(this.upstreamSockets, socket));
    upstream.once('error', () => {
      if (!response.headersSent) sendBoundedError(response, 502, 'Preview target is unavailable.');
      else response.destroy();
    });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy();
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
    trackSocket(this.upstreamSockets, upstream);
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      upstream.write(serializeUpgradeRequest(request, target));
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once('error', () => {
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    });
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
  }

  private targetFor(request: IncomingMessage): PreviewGatewayTarget | undefined {
    return this.routes.get(normalizeHostname(request.headers.host ?? ''));
  }
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function validateRoute(hostname: string, target: Pick<PreviewGatewayTarget, 'host' | 'port'>): void {
  if (!hostname.endsWith('.preview.localhost') || hostname.split('.').length < 4) {
    throw new Error('Preview gateway routes must use a scoped .preview.localhost hostname.');
  }
  if (target.host !== '127.0.0.1' || !isValidPort(target.port)) {
    throw new Error('Preview gateway targets must be valid IPv4 loopback ports.');
  }
}

function forwardedHeaders(
  source: IncomingHttpHeaders,
  target: PreviewGatewayTarget
): http.OutgoingHttpHeaders {
  return {
    ...stripHopByHopHeaders(source),
    host: source.host,
    'x-forwarded-host': source.host,
    'x-forwarded-port': forwardedPort(source.host),
    'x-forwarded-proto': 'http'
  };
}

function rewriteResponseHeaders(
  source: IncomingHttpHeaders,
  target: PreviewGatewayTarget,
  stableAuthority: string | undefined
): http.OutgoingHttpHeaders {
  const headers = stripHopByHopHeaders(source);
  if (typeof headers.location !== 'string' || !stableAuthority) return headers;
  try {
    const location = new URL(headers.location);
    if (location.hostname !== target.host || Number(location.port) !== target.port) return headers;
    const stable = new URL(`http://${stableAuthority}`);
    location.protocol = 'http:';
    location.hostname = stable.hostname;
    location.port = stable.port;
    headers.location = location.toString();
  } catch {
    // Relative and non-URL Location values already remain on the stable route.
  }
  return headers;
}

function forwardedPort(authority: string | undefined): string | undefined {
  if (!authority) return undefined;
  const match = /:(\d+)$/.exec(authority);
  return match?.[1] ?? '80';
}

function stripHopByHopHeaders(source: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const connectionTokens = new Set(
    String(source.connection ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const output: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP.has(normalized) || connectionTokens.has(normalized) || value === undefined) continue;
    output[key] = value;
  }
  return output;
}

function serializeUpgradeRequest(request: IncomingMessage, target: PreviewGatewayTarget): string {
  const headers = forwardedHeaders(request.headers, target);
  headers.connection = request.headers.connection ?? 'Upgrade';
  headers.upgrade = request.headers.upgrade ?? 'websocket';
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

function sendBoundedError(response: http.ServerResponse, status: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
    connection: 'close'
  });
  response.end(message);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

function trackSocket(set: Set<net.Socket>, socket: net.Socket): void {
  set.add(socket);
  socket.once('close', () => set.delete(socket));
}
