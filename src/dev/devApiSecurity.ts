import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const DEV_API_TOKEN_HEADER = 'x-task-monki-dev-token';
export const DEFAULT_DEV_API_PORT = 3099;
export const DEFAULT_DEV_RENDERER_PORT = 5173;
export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface DevApiSecurityConfig {
  token: string;
  expectedHost: string;
  expectedOrigin: string;
}

export interface DevApiTokenLease {
  token: string;
  tokenPath: string;
  dispose(): Promise<void>;
}

export type DevApiAuthorizationFailure =
  | 'NOT_READY'
  | 'UNAUTHORIZED'
  | 'INVALID_HOST'
  | 'INVALID_ORIGIN'
  | 'INVALID_FETCH_SITE';

export class DevApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'DevApiHttpError';
  }
}

export function parseDevPort(
  value: string | undefined,
  fallback: number,
  variableName: string
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} must be an integer between 1 and 65535.`);
  }
  return port;
}

export function devApiExpectedHost(port: number): string {
  return `127.0.0.1:${port}`;
}

export function devRendererOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function devApiTokenPath(port: number): string {
  const userIdentity =
    typeof process.getuid === 'function'
      ? `uid-${process.getuid()}`
      : process.env.USERNAME ?? process.env.USER ?? os.homedir();
  const userKey = createHash('sha256').update(userIdentity).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `task-monki-dev-api-${userKey}`, `${port}.token`);
}

export function readDevApiToken(port: number): string | undefined {
  try {
    const tokenPath = devApiTokenPath(port);
    assertPrivateTokenDirectorySync(path.dirname(tokenPath));
    const descriptor = fs.openSync(
      tokenPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    try {
      const stat = fs.fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > 256 ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      ) {
        return undefined;
      }
      const token = fs.readFileSync(descriptor, 'utf8').trim();
      return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : undefined;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
}

/**
 * Moves the short-lived filesystem rendezvous secret into the Vite proxy's
 * process memory. The lease file is not a same-user security boundary and must
 * not remain readable while agent commands are running.
 */
export function consumeDevApiToken(port: number): string | undefined {
  const token = readDevApiToken(port);
  if (!token) return undefined;
  const tokenPath = devApiTokenPath(port);
  try {
    if (readDevApiToken(port) !== token) return undefined;
    fs.unlinkSync(tokenPath);
    return token;
  } catch {
    return undefined;
  }
}

export async function createDevApiTokenLease(port: number): Promise<DevApiTokenLease> {
  const tokenPath = devApiTokenPath(port);
  const tokenDir = path.dirname(tokenPath);
  const token = randomBytes(32).toString('base64url');
  const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;

  await ensurePrivateTokenDirectory(tokenDir);
  await cleanupTokenTemporaryFiles(tokenDir, path.basename(tokenPath));
  const temporaryHandle = await fsPromises.open(
    temporaryPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    await temporaryHandle.writeFile(`${token}\n`, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    await fsPromises.rename(temporaryPath, tokenPath);
    await syncPrivateDirectory(tokenDir);
  } catch (error) {
    await temporaryHandle.close().catch(() => undefined);
    await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    token,
    tokenPath,
    async dispose() {
      try {
        if ((await readPrivateTokenFile(tokenPath)) === token) {
          await fsPromises.rm(tokenPath, { force: true });
          await syncPrivateDirectory(tokenDir);
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }
  };
}

async function ensurePrivateTokenDirectory(tokenDir: string): Promise<void> {
  try {
    await fsPromises.mkdir(tokenDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fsPromises.lstat(tokenDir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new Error('Development API token directory failed its integrity check.');
  }
  await setPrivateMode(tokenDir, 0o700);
  const secured = await fsPromises.lstat(tokenDir);
  if (
    !secured.isDirectory() ||
    secured.isSymbolicLink() ||
    (process.platform !== 'win32' && (secured.mode & 0o077) !== 0)
  ) {
    throw new Error('Development API token directory is not private.');
  }
}

async function cleanupTokenTemporaryFiles(
  tokenDir: string,
  tokenFileName: string
): Promise<void> {
  for (const entry of await fsPromises.readdir(tokenDir, { withFileTypes: true })) {
    if (
      !entry.name.startsWith(`${tokenFileName}.`) ||
      !entry.name.endsWith('.tmp')
    ) {
      continue;
    }
    const candidate = path.join(tokenDir, entry.name);
    const stat = await fsPromises.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) continue;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error('Development API token temp path failed its integrity check.');
    }
    await fsPromises.unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function assertPrivateTokenDirectorySync(tokenDir: string): void {
  const stat = fs.lstatSync(tokenDir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new Error('Development API token directory failed its integrity check.');
  }
}

async function readPrivateTokenFile(tokenPath: string): Promise<string | undefined> {
  const handle = await fsPromises.open(
    tokenPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > 256 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      return undefined;
    }
    const token = (await handle.readFile('utf8')).trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : undefined;
  } finally {
    await handle.close();
  }
}

async function syncPrivateDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fsPromises.open(
    directory,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    await handle.sync();
  } catch (error) {
    if (
      !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'].includes(
        (error as NodeJS.ErrnoException).code ?? ''
      )
    ) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export function authorizeDevApiRequest(
  request: Pick<http.IncomingMessage, 'headers'>,
  config: DevApiSecurityConfig
): DevApiAuthorizationFailure | undefined {
  if (!config.token) {
    return 'NOT_READY';
  }

  const suppliedToken = singleHeader(request.headers[DEV_API_TOKEN_HEADER]);
  if (!suppliedToken || !tokensMatch(suppliedToken, config.token)) {
    return 'UNAUTHORIZED';
  }

  const host = singleHeader(request.headers.host)?.toLowerCase();
  if (host !== config.expectedHost.toLowerCase()) {
    return 'INVALID_HOST';
  }

  const origin = singleHeader(request.headers.origin);
  if (origin !== undefined && origin !== config.expectedOrigin) {
    return 'INVALID_ORIGIN';
  }

  const fetchSite = singleHeader(request.headers['sec-fetch-site']);
  if (fetchSite !== 'same-origin') {
    return 'INVALID_FETCH_SITE';
  }

  return undefined;
}

export function isAllowedDevRendererRequest(
  headers: Pick<http.IncomingHttpHeaders, 'origin' | 'sec-fetch-site'>,
  expectedOrigin: string
): boolean {
  const origin = singleHeader(headers.origin);
  if (origin !== undefined && origin !== expectedOrigin) {
    return false;
  }
  const fetchSite = singleHeader(headers['sec-fetch-site']);
  return fetchSite === 'same-origin';
}

export async function readBoundedJson(
  request: http.IncomingMessage,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES
): Promise<unknown> {
  const contentType = singleHeader(request.headers['content-type'])
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new DevApiHttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'This endpoint requires an application/json request body.'
    );
  }

  const bytes = await readBoundedBody(request, maxBytes);

  if (bytes.byteLength === 0) {
    return {};
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DevApiHttpError(400, 'INVALID_JSON_ENCODING', 'JSON must be valid UTF-8.');
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DevApiHttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
}

export async function readBoundedBinary(
  request: http.IncomingMessage,
  maxBytes: number
): Promise<Uint8Array> {
  const contentType = singleHeader(request.headers['content-type'])
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/octet-stream') {
    throw new DevApiHttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Attachment uploads require an application/octet-stream request body.'
    );
  }
  return readBoundedBody(request, maxBytes);
}

async function readBoundedBody(
  request: http.IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const contentEncoding = singleHeader(request.headers['content-encoding'])?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new DevApiHttpError(
      415,
      'UNSUPPORTED_CONTENT_ENCODING',
      'Compressed request bodies are not supported.'
    );
  }

  const declaredLength = singleHeader(request.headers['content-length']);
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new DevApiHttpError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.');
    }
    if (parsedLength > maxBytes) {
      request.resume();
      throw requestBodyTooLarge(maxBytes);
    }
  }

  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteCount += chunk.byteLength;
    if (byteCount > maxBytes) {
      request.resume();
      throw requestBodyTooLarge(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteCount);
}

function requestBodyTooLarge(maxBytes: number): DevApiHttpError {
  return new DevApiHttpError(
    413,
    'REQUEST_BODY_TOO_LARGE',
    `The request body exceeds the ${maxBytes}-byte limit.`
  );
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function tokensMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

async function setPrivateMode(targetPath: string, mode: number): Promise<void> {
  try {
    await fsPromises.chmod(targetPath, mode);
  } catch (error) {
    if (process.platform !== 'win32') {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
