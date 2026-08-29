import type { AgentProtocolMessageReference } from '../../../shared/agent';
import {
  REDACTED_CREDENTIAL,
  redactCredentialText
} from '../AgentCredentialRedaction';
import { redactProtocolJournalRecord } from '../journal/AgentProtocolRedaction';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const OPENCODE_MAX_WIRE_BYTES = 32 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = OPENCODE_MAX_WIRE_BYTES;
const MAX_SSE_LINE_BYTES = OPENCODE_MAX_WIRE_BYTES;
const MAX_SSE_EVENT_BYTES = OPENCODE_MAX_WIRE_BYTES;
const REDACTED_ATTACHMENT_CONTENT = '[Task Monki attachment content omitted]';

export interface OpenCodeJournalWriter {
  (
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference>;
}

export interface OpenCodeHttpClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  directory: string;
  requestTimeoutMs?: number;
  sensitiveValues?: readonly string[];
  journal: OpenCodeJournalWriter;
  fetch?: typeof fetch;
}

export interface OpenCodeHttpResult<T> {
  data: T;
  raw: AgentProtocolMessageReference;
}

export interface OpenCodeRequestOptions {
  /** Absolute wall-clock deadline shared by a bounded multi-request control flow. */
  deadlineAt?: number;
}

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    message: string
  ) {
    super(message);
    this.name = 'OpenCodeHttpError';
  }
}

export class OpenCodeAmbiguousMutationError extends Error {
  constructor(
    readonly operation: string,
    message: string
  ) {
    super(message);
    this.name = 'OpenCodeAmbiguousMutationError';
  }
}

export interface OpenCodeEventStreamHandlers {
  onEvent(value: unknown, raw: AgentProtocolMessageReference): Promise<void>;
  onDisconnect(error: Error): Promise<void>;
  onReconnect(): Promise<void>;
}

export interface OpenCodeEventStream {
  stop(): void;
  /** Resolves after the transport has stopped and every accepted callback has finished. */
  settled: Promise<void>;
}

export interface OpenCodeClientTransport {
  get<T>(path: string, options?: OpenCodeRequestOptions): Promise<OpenCodeHttpResult<T>>;
  post<T>(
    path: string,
    body?: unknown,
    options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>>;
  patch<T>(
    path: string,
    body?: unknown,
    options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>>;
  delete<T>(path: string, options?: OpenCodeRequestOptions): Promise<OpenCodeHttpResult<T>>;
  startEventStream(handlers: OpenCodeEventStreamHandlers): OpenCodeEventStream;
}

export class OpenCodeHttpClient implements OpenCodeClientTransport {
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly authorization: string;

  constructor(private readonly options: OpenCodeHttpClientOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
  }

  get<T>(path: string, options?: OpenCodeRequestOptions): Promise<OpenCodeHttpResult<T>> {
    return this.request<T>('GET', path, undefined, false, options);
  }

  post<T>(
    path: string,
    body?: unknown,
    options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>> {
    return this.request<T>('POST', path, body, true, options);
  }

  patch<T>(
    path: string,
    body?: unknown,
    options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>> {
    return this.request<T>('PATCH', path, body, true, options);
  }

  delete<T>(
    path: string,
    options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>> {
    return this.request<T>('DELETE', path, undefined, true, options);
  }

  startEventStream(handlers: OpenCodeEventStreamHandlers): OpenCodeEventStream {
    const controller = new AbortController();
    const settled = this.runEventStream(controller.signal, handlers).catch(async (cause) => {
      if (!controller.signal.aborted) {
        await handlers.onDisconnect(toError(cause)).catch(() => undefined);
      }
    });
    return { stop: () => controller.abort(), settled };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    mutation = false,
    options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>> {
    const operation = `${method} ${path}`;
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    if (
      requestBody !== undefined &&
      Buffer.byteLength(requestBody) > OPENCODE_MAX_WIRE_BYTES
    ) {
      throw new Error(`${operation} exceeded the bounded OpenCode request limit.`);
    }
    if (
      options?.deadlineAt !== undefined &&
      (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= Date.now())
    ) {
      throw new Error(`${operation} exceeded its caller deadline before it was sent.`);
    }
    const remainingMs = options?.deadlineAt === undefined
      ? this.requestTimeoutMs
      : Math.min(this.requestTimeoutMs, options.deadlineAt - Date.now());
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new Error(`${operation} exceeded its caller deadline before it was sent.`);
    }
    const controller = new AbortController();
    const deadlineAt = Date.now() + remainingMs;
    const timer = setTimeout(() => controller.abort(), remainingMs);
    timer.unref();
    try {
      await waitForAbortable(
        this.appendJournal(
          'OUTBOUND',
          JSON.stringify({
            method,
            path,
            body: sanitizeOpenCodeInlineAttachmentContent(body ?? null)
          }),
          { transport: 'HTTP', operation }
        ),
        controller.signal,
        `${operation} timed out before its outbound journal entry was persisted.`
      );
      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        throw new Error(`${operation} exceeded its caller deadline before it was sent.`);
      }
      let response: Response;
      try {
        response = await this.fetchImplementation(this.url(path), {
          method,
          headers: {
            Authorization: this.authorization,
            Accept: 'application/json',
            ...(requestBody ? { 'Content-Type': 'application/json' } : {})
          },
          body: requestBody,
          signal: controller.signal
        });
      } catch (cause) {
        const message = this.redactText(
          `${operation} did not produce an authoritative HTTP response: ${errorMessage(cause)}`
        );
        if (mutation) throw new OpenCodeAmbiguousMutationError(operation, message);
        throw new Error(message, { cause });
      }

      let text: string;
      try {
        text = response.status === 204
          ? ''
          : await readBoundedResponse(response, controller.signal);
      } catch (cause) {
        throw mutation
          ? new OpenCodeAmbiguousMutationError(
              operation,
              this.redactText(
                `${operation} returned HTTP ${response.status}, but its response body could not be read: ${errorMessage(cause)}`
              )
            )
          : cause;
      }
      let parsed: unknown;
      let validJson = false;
      if (text) {
        try {
          parsed = sanitizeOpenCodeInlineAttachmentContent(JSON.parse(text));
          validJson = true;
        } catch {
          parsed = undefined;
        }
      }
      let raw: AgentProtocolMessageReference;
      try {
        const journalBody = text
          ? validJson
            ? JSON.stringify(parsed)
            : JSON.stringify({ type: 'opencode.http.non-json', status: response.status })
          : JSON.stringify({ status: response.status });
        raw = await waitForAbortable(
          this.appendJournal('INBOUND', journalBody, {
            transport: 'HTTP',
            operation,
            status: response.status,
            ...(text && !validJson ? { malformed: true } : {})
          }),
          controller.signal,
          `${operation} timed out while journaling its acknowledgement.`
        );
      } catch (cause) {
        throw mutation
          ? new OpenCodeAmbiguousMutationError(
              operation,
              this.redactText(
                `${operation} returned HTTP ${response.status}, but Task Monki could not journal the acknowledgement: ${errorMessage(cause)}`
              )
            )
          : cause;
      }
      if (!response.ok) {
        throw new OpenCodeHttpError(
          response.status,
          operation,
          `OpenCode rejected ${operation} with HTTP ${response.status}: ${safeErrorBody(
            text,
            this.options.sensitiveValues
          )}`
        );
      }
      if (!text) {
        if (controller.signal.aborted || Date.now() >= deadlineAt) {
          if (mutation) {
            throw new OpenCodeAmbiguousMutationError(
              operation,
              `${operation} returned HTTP ${response.status}, but acknowledgement processing timed out.`
            );
          }
          throw new Error(`${operation} timed out before its response was processed.`);
        }
        return { data: undefined as T, raw };
      }
      try {
        if (!validJson) throw new SyntaxError('Invalid OpenCode JSON response.');
        if (controller.signal.aborted || Date.now() >= deadlineAt) {
          throw new Error(`${operation} timed out before its acknowledgement was processed.`);
        }
        return { data: parsed as T, raw };
      } catch (cause) {
        if (mutation) {
          throw new OpenCodeAmbiguousMutationError(
            operation,
            controller.signal.aborted
              ? `${operation} returned HTTP ${response.status}, but acknowledgement processing timed out.`
              : `${operation} returned HTTP ${response.status}, but the acknowledgement body was invalid JSON.`
          );
        }
        throw new Error(`OpenCode returned invalid JSON for ${operation}.`, { cause });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async runEventStream(
    signal: AbortSignal,
    handlers: OpenCodeEventStreamHandlers
  ): Promise<void> {
    let attempt = 0;
    let connected = false;
    while (!signal.aborted) {
      try {
        await this.consumeEventStream(signal, handlers.onEvent, async () => {
          if (connected) await handlers.onReconnect();
          connected = true;
          attempt = 0;
        });
        if (signal.aborted) return;
        throw new Error('OpenCode event stream ended without a terminal signal.');
      } catch (cause) {
        if (signal.aborted) return;
        const error = toError(cause);
        // Event and reconnect callback failures enter the same disconnect
        // path as transport loss. A failure in the disconnect diagnostic
        // itself must not terminate the only reconnect loop.
        await handlers.onDisconnect(error).catch(() => undefined);
        attempt += 1;
        await abortableDelay(Math.min(10_000, 250 * 2 ** Math.min(attempt, 6)), signal);
        if (signal.aborted) return;
      }
    }
  }

  private async consumeEventStream(
    signal: AbortSignal,
    onEvent: OpenCodeEventStreamHandlers['onEvent'],
    onConnected: () => Promise<void>
  ): Promise<void> {
    const response = await this.fetchImplementation(this.url('/event'), {
      headers: {
        Authorization: this.authorization,
        Accept: 'text/event-stream'
      },
      signal
    });
    if (!response.ok || !response.body) {
      const body = await readBoundedResponse(response);
      throw new OpenCodeHttpError(
        response.status,
        'GET /event',
        `OpenCode event stream failed with HTTP ${response.status}: ${safeErrorBody(
          body,
          this.options.sensitiveValues
        )}`
      );
    }
    await onConnected();
    const parser = new OpenCodeSseParser(async (data) => {
      if (data === '[DONE]') return;
      let parsed: unknown;
      try {
        parsed = sanitizeOpenCodeInlineAttachmentContent(JSON.parse(data));
      } catch {
        await this.appendJournal('INBOUND', JSON.stringify({
          type: 'opencode.sse.malformed'
        }), {
          transport: 'SSE',
          operation: 'GET /event',
          malformed: true
        });
        throw new Error('OpenCode emitted invalid SSE JSON.');
      }
      const raw = await this.appendJournal(
        'INBOUND',
        JSON.stringify(maskOpenCodeStreamingJournalContent(parsed)),
        {
          transport: 'SSE',
          operation: 'GET /event'
        }
      );
      await onEvent(parsed, raw);
    });
    const reader = response.body.getReader();
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        await parser.push(value);
      }
      await parser.finish();
    } finally {
      reader.releaseLock();
    }
  }

  private url(pathname: string): string {
    const url = new URL(pathname, this.options.baseUrl);
    url.searchParams.set('directory', this.options.directory);
    return url.toString();
  }

  private appendJournal(
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    const safe = redactProtocolJournalRecord(
      raw,
      metadata,
      this.options.sensitiveValues
    );
    return this.options.journal(direction, safe.raw, safe.metadata);
  }

  private redactText(value: string): string {
    return redactCredentialText(value, this.options.sensitiveValues);
  }
}

/**
 * Streaming text can split an exact inherited credential across otherwise
 * independent SSE records. Keep routing and lifecycle fields useful while
 * preventing free-form content from reaching the durable protocol journal.
 */
function maskOpenCodeStreamingJournalContent(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.properties)) return value;
  if (value.type === 'message.part.delta') {
    return {
      ...value,
      properties: {
        ...value.properties,
        ...(typeof value.properties.delta === 'string'
          ? { delta: REDACTED_CREDENTIAL }
          : {})
      }
    };
  }
  if (value.type !== 'message.part.updated' || !isRecord(value.properties.part)) {
    return value;
  }

  const part = value.properties.part;
  const state = isRecord(part.state)
    ? {
        ...part.state,
        ...maskPresentField(part.state, 'input'),
        ...maskPresentField(part.state, 'output'),
        ...maskPresentField(part.state, 'error'),
        ...maskPresentField(part.state, 'title'),
        ...maskPresentField(part.state, 'metadata')
      }
    : part.state;
  return {
    ...value,
    properties: {
      ...value.properties,
      part: {
        ...part,
        ...maskPresentField(part, 'text'),
        ...(state === undefined ? {} : { state })
      }
    }
  };
}

function maskPresentField(
  record: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  return Object.prototype.hasOwnProperty.call(record, field)
    ? { [field]: REDACTED_CREDENTIAL }
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class OpenCodeSseParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private bufferBytes = 0;
  private dataLines: string[] = [];
  private eventBytes = 0;

  constructor(private readonly onData: (data: string) => Promise<void>) {}

  async push(chunk: Uint8Array): Promise<void> {
    const decoded = this.decoder.decode(chunk, { stream: true });
    this.buffer += decoded;
    this.bufferBytes += Buffer.byteLength(decoded);
    await this.drainLines();
    if (this.bufferBytes > MAX_SSE_LINE_BYTES) {
      throw new Error('OpenCode SSE line exceeded the bounded parser limit.');
    }
  }

  async finish(): Promise<void> {
    const decoded = this.decoder.decode();
    this.buffer += decoded;
    this.bufferBytes += Buffer.byteLength(decoded);
    if (this.bufferBytes > MAX_SSE_LINE_BYTES) {
      throw new Error('OpenCode SSE line exceeded the bounded parser limit.');
    }
    if (this.buffer) {
      await this.processLine(this.buffer.replace(/\r$/u, ''));
      this.buffer = '';
      this.bufferBytes = 0;
    }
    await this.dispatch();
  }

  private async drainLines(): Promise<void> {
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const rawLine = this.buffer.slice(0, newline);
      const line = rawLine.replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.bufferBytes -= Buffer.byteLength(rawLine) + 1;
      await this.processLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private async processLine(line: string): Promise<void> {
    if (Buffer.byteLength(line) > MAX_SSE_LINE_BYTES) {
      throw new Error('OpenCode SSE line exceeded the bounded parser limit.');
    }
    if (!line) {
      await this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).replace(/^ /u, '');
    this.eventBytes += Buffer.byteLength(line);
    if (this.eventBytes > MAX_SSE_EVENT_BYTES) {
      throw new Error('OpenCode SSE event exceeded the bounded parser limit.');
    }
    this.dataLines.push(value);
  }

  private async dispatch(): Promise<void> {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    this.eventBytes = 0;
    await this.onData(data);
  }
}

/**
 * Removes native file bytes from values that can reach journals, events, or
 * recovered message history. Routing ids and safe file metadata stay intact.
 */
export function sanitizeOpenCodeInlineAttachmentContent(
  value: unknown,
  depth = 0
): unknown {
  if (typeof value === 'string') {
    return value.startsWith('data:') ? REDACTED_ATTACHMENT_CONTENT : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 64) return '[OpenCode nested content omitted]';
  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeOpenCodeInlineAttachmentContent(entry, depth + 1)
    );
  }

  const record = value as Record<string, unknown>;
  const filePart = record.type === 'file';
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      filePart && ['url', 'data', 'content', 'source'].includes(key)
        ? REDACTED_ATTACHMENT_CONTENT
        : sanitizeOpenCodeInlineAttachmentContent(entry, depth + 1)
    ])
  );
}

async function readBoundedResponse(
  response: Response,
  signal?: AbortSignal
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_BODY_BYTES) {
    throw new Error('OpenCode HTTP response exceeded the bounded body limit.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = '';
  let aborted = signal?.aborted ?? false;
  const onAbort = () => {
    aborted = true;
    void reader.cancel(new Error('OpenCode HTTP response timed out.')).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (aborted) throw new Error('OpenCode HTTP response timed out.');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_BODY_BYTES) {
        await reader.cancel();
        throw new Error('OpenCode HTTP response exceeded the bounded body limit.');
      }
      result += decoder.decode(value, { stream: true });
    }
    if (aborted) throw new Error('OpenCode HTTP response timed out.');
    return result + decoder.decode();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function waitForAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  message: string
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause) => {
        cleanup();
        reject(cause);
      }
    );
  });
}

function safeErrorBody(
  body: string,
  sensitiveValues: readonly string[] = []
): string {
  let safeBody = body;
  try {
    safeBody = JSON.stringify(
      sanitizeOpenCodeInlineAttachmentContent(JSON.parse(body))
    );
  } catch {
    // Non-JSON diagnostics still use the existing bounded credential redaction.
  }
  const normalized = redactCredentialText(safeBody, sensitiveValues)
    .replace(/[\r\n\t]+/gu, ' ')
    .trim();
  return normalized.slice(0, 1_000) || 'no response body';
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(cleanup, milliseconds);
    timer.unref();
    const onAbort = () => cleanup();
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
