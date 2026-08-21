import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const PORT_ENV = 'TASK_MONKI_MANAGED_STATIC_PORT';
const port = parsePort(process.env[PORT_ENV]);
const root = await fsp.realpath(process.cwd());
const sockets = new Set();

const server = http.createServer((request, response) => {
  void serve(request, response).catch(() => {
    if (!response.headersSent) sendError(response, 500, 'Preview file is unavailable.');
    else response.destroy();
  });
});
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
    server.off('error', reject);
    resolve();
  });
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown();
  });
}

async function serve(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendError(response, 405, 'Method is not allowed.');
    return;
  }

  const relativePath = requestPath(request.url);
  if (!relativePath) {
    sendError(response, 400, 'Preview path is invalid.');
    return;
  }
  const candidate = path.resolve(root, relativePath);
  if (!isWithinRoot(root, candidate)) {
    sendError(response, 404, 'Preview file was not found.');
    return;
  }

  const safe = await inspectRegularFile(root, relativePath).catch(() => undefined);
  if (!safe) {
    sendError(response, 404, 'Preview file was not found.');
    return;
  }

  const handle = await fsp.open(safe.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let stat;
  try {
    stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      sendError(response, 404, 'Preview file was not found.');
      return;
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }

  setSecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType(safe.path));
  response.setHeader('Content-Length', String(stat.size));
  if (request.method === 'HEAD') {
    await handle.close();
    response.end();
    return;
  }

  const stream = handle.createReadStream({ autoClose: true });
  stream.once('error', () => response.destroy());
  response.once('close', () => {
    if (!response.writableEnded) stream.destroy();
  });
  stream.pipe(response);
}

function requestPath(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 16_384 || rawUrl.includes('\\')) return;
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return;
  const segments = decoded.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return;
  if (segments.some((segment) => !segment) && decoded !== '/') return;
  return decoded === '/' ? 'index.html' : segments.join('/');
}

async function inspectRegularFile(sourceRoot, relativePath) {
  let current = sourceRoot;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) return;
  }
  const real = await fsp.realpath(current);
  if (!isWithinRoot(sourceRoot, real)) return;
  const stat = await fsp.lstat(real);
  return stat.isFile() && !stat.isSymbolicLink() ? { path: real } : undefined;
}

function isWithinRoot(sourceRoot, candidate) {
  return candidate !== sourceRoot && !path.relative(sourceRoot, candidate).startsWith(`..${path.sep}`) &&
    path.relative(sourceRoot, candidate) !== '..' && !path.isAbsolute(path.relative(sourceRoot, candidate));
}

function setSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' ws://*.localhost:*",
    "worker-src 'self' blob:"
  ].join('; '));
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendError(response, status, message) {
  setSecurityHeaders(response);
  const body = `${message}\n`;
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', String(Buffer.byteLength(body)));
  response.end(body);
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error(`${PORT_ENV} must contain a valid port.`);
  }
  return parsed;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise((resolve) => server.close(resolve));
  for (const socket of sockets) socket.destroy();
  await closed;
}
