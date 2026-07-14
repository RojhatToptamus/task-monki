import net from 'node:net';
import { Client as PgClient, type ClientConfig } from 'pg';
import { createClient } from 'redis';
import type { PreviewAttachmentFailureCode, PreviewAttachmentPlan } from '../../../shared/preview';
import { previewRouteHostname } from '../PreviewRouteHostname';

export interface PreviewAttachmentCheckResult {
  status: 'PASSED' | 'FAILED';
  observedAt: string;
  failureCode?: PreviewAttachmentFailureCode;
}

export class PreviewAttachedDependencyRuntime {
  async check(
    attachment: PreviewAttachmentPlan,
    passwords: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    gatewayPort?: number
  ): Promise<PreviewAttachmentCheckResult> {
    const timeoutMs = (attachment.check?.timeoutSeconds ?? 10) * 1_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      throwIfAborted(controller.signal);
      if (attachment.target.type === 'local') throw new Error('Unresolved attachment target.');
      if (attachment.type === 'http') await checkHttp(httpOrigin(attachment, gatewayPort), attachment.check?.path ?? '/', controller.signal);
      else if (attachment.type === 'tcp') await checkTcp(attachment.target.host, attachment.target.port, controller.signal);
      else if (attachment.type === 'postgres') await probeAttachedPostgres({
        attachment,
        password: attachment.passwordInput ? passwords[attachment.passwordInput] : undefined,
        signal: controller.signal,
        timeoutMs
      });
      else await checkRedis(attachment, attachment.passwordInput ? passwords[attachment.passwordInput] : undefined, controller.signal, timeoutMs);
      return { status: 'PASSED', observedAt: new Date().toISOString() };
    } catch (error) {
      return { status: 'FAILED', observedAt: new Date().toISOString(), failureCode: classify(error, controller.signal, signal) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export function attachmentEnvironmentValue(attachment: PreviewAttachmentPlan, kind: string, passwords: Readonly<Record<string, string>>, gatewayPort?: number): string {
  if (attachment.target.type === 'local') throw new Error(`Attachment ${attachment.id} target is unresolved.`);
  if (kind === 'attached-http-origin' && attachment.type === 'http') return httpOrigin(attachment, gatewayPort);
  if (kind === 'attached-tcp-host' && attachment.type === 'tcp') return attachment.target.host;
  if (kind === 'attached-tcp-port' && attachment.type === 'tcp') return String(attachment.target.port);
  if (kind === 'attached-postgres-url' && attachment.type === 'postgres') {
    const url = new URL('postgresql://localhost'); url.hostname = attachment.target.host; url.port = String(attachment.target.port);
    url.username = attachment.target.username; if (attachment.passwordInput) url.password = passwords[attachment.passwordInput] ?? '';
    url.pathname = `/${encodeURIComponent(attachment.target.database)}`;
    if (attachment.target.tls === 'system-verified') url.searchParams.set('sslmode', 'verify-full');
    return url.toString();
  }
  if (kind === 'attached-redis-url' && attachment.type === 'redis') {
    const url = new URL(`${attachment.target.tls === 'system-verified' ? 'rediss' : 'redis'}://localhost`);
    url.hostname = attachment.target.host; url.port = String(attachment.target.port); url.pathname = `/${attachment.target.database}`;
    if (attachment.target.username) url.username = attachment.target.username;
    if (attachment.passwordInput) url.password = passwords[attachment.passwordInput] ?? '';
    return url.toString();
  }
  throw new Error(`Attachment ${attachment.id} cannot provide ${kind}.`);
}

function httpOrigin(attachment: Extract<PreviewAttachmentPlan, { type: 'http' }>, gatewayPort?: number): string {
  if (attachment.target.type === 'task-preview-route') {
    if (!gatewayPort) throw new Error('Preview gateway authority is unavailable.');
    const hostname = previewRouteHostname(
      attachment.target.targetTaskId,
      attachment.target.routeId
    );
    return `http://${hostname}:${gatewayPort}${attachment.target.basePath === '/' ? '' : attachment.target.basePath}`;
  }
  if (attachment.target.type !== 'endpoint') throw new Error('Unresolved HTTP target.');
  const url = new URL(`${attachment.target.scheme}://${attachment.target.host}:${attachment.target.port}`);
  url.pathname = attachment.target.basePath;
  return url.toString().replace(/\/$/, attachment.target.basePath === '/' ? '' : '/');
}
async function checkHttp(origin: string, checkPath: string, signal: AbortSignal): Promise<void> {
  const url = new URL(origin);
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}${checkPath}`;
  const response = await fetch(url, { method: 'GET', redirect: 'manual', signal });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
}
function checkTcp(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError(signal)); return; }
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      socket.destroy();
      error ? reject(error) : resolve();
    };
    const onAbort = () => finish(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true }); socket.once('connect', () => finish()); socket.once('error', finish);
  });
}

export interface AttachedPostgresProbeInput {
  attachment: Extract<PreviewAttachmentPlan, { type: 'postgres' }>;
  password?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface AttachedPostgresClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export async function probeAttachedPostgres(
  input: AttachedPostgresProbeInput,
  createClient: (config: ClientConfig) => AttachedPostgresClient = (config) => new PgClient(config)
): Promise<void> {
  if (input.attachment.target.type !== 'endpoint') throw new Error('Unresolved PostgreSQL target.');
  const client = createClient({
    host: input.attachment.target.host,
    port: input.attachment.target.port,
    database: input.attachment.target.database,
    user: input.attachment.target.username,
    password: input.password,
    ssl: input.attachment.target.tls === 'system-verified' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: input.timeoutMs,
    query_timeout: input.timeoutMs
  });
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= client.end().catch(() => undefined);
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => { void close(); rejectAbort(abortError(input.signal)); };
  if (input.signal.aborted) abort();
  else input.signal.addEventListener('abort', abort, { once: true });
  const operation = (async () => {
    await client.connect();
    throwIfAborted(input.signal);
    await client.query('SELECT 1');
    throwIfAborted(input.signal);
  })();
  try {
    await Promise.race([operation, aborted]);
  } finally {
    input.signal.removeEventListener('abort', abort);
    await close();
    await operation.catch(() => undefined);
  }
}

async function checkRedis(
  attachment: Extract<PreviewAttachmentPlan, { type: 'redis' }>,
  password: string | undefined,
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  if (attachment.target.type !== 'endpoint') throw new Error('Unresolved Redis target.');
  throwIfAborted(signal);
  const client = createClient({
    url: attachmentEnvironmentValue(attachment, 'attached-redis-url', attachment.passwordInput ? { [attachment.passwordInput]: password ?? '' } : {}),
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false }
  });
  client.on('error', () => undefined); const abort = () => client.destroy(); signal.addEventListener('abort', abort, { once: true });
  try { await client.connect(); await client.ping(); } finally { signal.removeEventListener('abort', abort); if (client.isOpen) client.destroy(); }
}
function classify(error: unknown, local: AbortSignal, parent?: AbortSignal): PreviewAttachmentFailureCode {
  if (parent?.aborted) return 'CHECK_CANCELED'; if (local.aborted) return 'CHECK_TIMEOUT';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('auth') || message.includes('password')) return 'AUTHENTICATION_FAILED';
  if (message.includes('certificate') || message.includes('tls')) return 'TLS_FAILED';
  return 'TARGET_UNAVAILABLE';
}
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw abortError(signal); }
function abortError(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new Error('canceled'); }
