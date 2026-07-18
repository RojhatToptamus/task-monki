import type { AgentProtocolMessageReference } from '../../../shared/agent';
import { redactCredentialText } from '../AgentCredentialRedaction';
import { redactProtocolJournalRecord } from '../journal/AgentProtocolRedaction';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

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
  startEventStream(handlers: OpenCodeEventStreamHandlers): { stop(): void };
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

  startEventStream(handlers: OpenCodeEventStreamHandlers): { stop(): void } {
    const controller = new AbortController();
    void this.runEventStream(controller.signal, handlers).catch(async (cause) => {
      if (!controller.signal.aborted) {
        await handlers.onDisconnect(toError(cause)).catch(() => undefined);
      }
    });
    return { stop: () => controller.abort() };
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
          JSON.stringify({ method, path, body: body ?? null }),
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
      let raw: AgentProtocolMessageReference;
      try {
        raw = await waitForAbortable(
          this.appendJournal('INBOUND', text || JSON.stringify({ status: response.status }), {
            transport: 'HTTP',
            operation,
            status: response.status
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
        const data = JSON.parse(text) as T;
        if (controller.signal.aborted || Date.now() >= deadlineAt) {
          throw new Error(`${operation} timed out before its acknowledgement was processed.`);
        }
        return { data, raw };
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
      const raw = await this.appendJournal('INBOUND', data, {
        transport: 'SSE',
        operation: 'GET /event'
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (cause) {
        throw new Error('OpenCode emitted invalid SSE JSON.', { cause });
      }
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

export class OpenCodeSseParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private dataLines: string[] = [];
  private eventBytes = 0;

  constructor(private readonly onData: (data: string) => Promise<void>) {}

  async push(chunk: Uint8Array): Promise<void> {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    await this.drainLines();
    if (Buffer.byteLength(this.buffer) > MAX_SSE_LINE_BYTES) {
      throw new Error('OpenCode SSE line exceeded the bounded parser limit.');
    }
  }

  async finish(): Promise<void> {
    this.buffer += this.decoder.decode();
    if (this.buffer) {
      await this.processLine(this.buffer.replace(/\r$/u, ''));
      this.buffer = '';
    }
    await this.dispatch();
  }

  private async drainLines(): Promise<void> {
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
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
    this.eventBytes += Buffer.byteLength(value);
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
  const normalized = redactCredentialText(body, sensitiveValues)
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
