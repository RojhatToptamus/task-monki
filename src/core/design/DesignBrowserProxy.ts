import http from 'node:http';
import net from 'node:net';

export interface DesignBrowserLease {
  origin: string;
  entryPath: string;
  allowedOrigins: string[];
  proxyUrl: string;
  close(): Promise<void>;
}

/** A Design browser can reach only the selected attempt's declared HTTP origins. */
export async function openDesignBrowserProxy(input: {
  origin: string;
  entryPath: string;
  routes: Record<string, string>;
  isCurrent(): Promise<boolean>;
}): Promise<DesignBrowserLease> {
  const routes = new Map(
    Object.entries(input.routes).map(([origin, destination]) => {
      const source = localOrigin(origin);
      const target = localOrigin(destination);
      return [source.origin, target] as const;
    })
  );
  if (!routes.has(input.origin))
    throw new Error(
      'Design browser access requires its selected application origin.'
    );
  const sockets = new Set<net.Socket>();
  let closed = false;
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const destination = (request: http.IncomingMessage) => {
    try {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`);
      if (url.protocol === 'ws:') url.protocol = 'http:';
      const target = routes.get(url.origin);
      return target && !url.username && !url.password
        ? { url, target }
        : undefined;
    } catch {
      return undefined;
    }
  };
  const server = http.createServer((request, response) => {
    const selected = destination(request);
    void input.isCurrent().then(
      (current) => {
        if (closed || !current || !selected) {
          response.writeHead(403).end();
          return;
        }
        const { target, url } = selected;
        const upstream = http.request(
          {
            hostname: '127.0.0.1',
            port: target.port,
            path: `${url.pathname}${url.search}`,
            method: request.method,
            headers: { ...safeHeaders(request.headers), host: target.host }
          },
          (result) => {
            response.writeHead(
              result.statusCode ?? 502,
              safeHeaders(result.headers)
            );
            result.pipe(response);
          }
        );
        upstream.on('socket', track);
        upstream.setTimeout(30_000, () =>
          upstream.destroy(new Error('Design request timed out.'))
        );
        upstream.once('error', () => {
          if (!response.headersSent) response.writeHead(502).end();
          else response.destroy();
        });
        request.once('aborted', () => upstream.destroy());
        response.once('close', () => {
          if (!response.writableEnded) upstream.destroy();
        });
        request.pipe(upstream);
      },
      () => response.writeHead(503).end()
    );
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 64;
  server.on('connection', track);
  server.on('connect', (_request, socket) =>
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  );
  server.on('upgrade', (request, socket, head) => {
    const selected = destination(request);
    void input.isCurrent().then(
      (current) => {
        if (closed || !current || !selected) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        const upstream = net.connect(Number(selected.target.port), '127.0.0.1');
        track(upstream);
        upstream.setTimeout(30_000, () => upstream.destroy());
        upstream.once('connect', () => {
          upstream.setTimeout(0);
          const headers = {
            ...safeHeaders(request.headers),
            host: selected.target.host,
            connection: 'Upgrade',
            upgrade: 'websocket'
          };
          const lines = [
            `GET ${selected.url.pathname}${selected.url.search} HTTP/1.1`
          ];
          for (const [key, value] of Object.entries(headers)) {
            for (const item of Array.isArray(value) ? value : [value])
              if (item !== undefined) lines.push(`${key}: ${item}`);
          }
          upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.once('error', () =>
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
        );
        socket.once('error', () => upstream.destroy());
        socket.once('close', () => upstream.destroy());
      },
      () =>
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'
        )
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Design proxy address is unavailable.');
  return {
    origin: input.origin,
    entryPath: input.entryPath,
    allowedOrigins: [...routes.keys()],
    proxyUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

function localOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && !url.hostname.endsWith('.localhost')) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Design browser access requires exact loopback origins.');
  }
  return url;
}
function safeHeaders(
  headers: http.IncomingHttpHeaders
): http.OutgoingHttpHeaders {
  const omitted = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...String(headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((value) => value.trim())
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) => value !== undefined && !omitted.has(key.toLowerCase())
    )
  );
}
