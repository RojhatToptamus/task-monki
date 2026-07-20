import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import {
  redactCredentialText,
  redactCredentialValue
} from '../AgentCredentialRedaction';
import {
  redactProtocolJournalRecord,
  redactProtocolText
} from '../journal/AgentProtocolRedaction';
import {
  ACP_MAX_MESSAGE_BYTES,
  decodeAcpMessage,
  isNotification,
  isRequest,
  isResponse,
  type AcpJsonRpcId,
  type AcpJsonRpcMessage,
  type AcpJsonRpcRequest
} from './AcpProtocol';

export type AcpJournalWriter = (
  direction: AgentProtocolMessageReference['direction'],
  raw: string,
  metadata?: Record<string, unknown>
) => Promise<AgentProtocolMessageReference>;

interface PendingRequest {
  method: string;
  mutation: boolean;
  timer?: NodeJS.Timeout;
  resolve(value: AcpRpcResult<unknown>): void;
  reject(error: Error): void;
}

interface AcpRpcEvents {
  notification: [method: string, params: unknown, raw: AgentProtocolMessageReference];
  request: [request: AcpJsonRpcRequest, raw: AgentProtocolMessageReference];
  protocolError: [error: Error, rawLine?: string, raw?: AgentProtocolMessageReference];
  close: [reason: string];
}

const MALFORMED_ACP_FRAME = '[REDACTED MALFORMED ACP FRAME]';

export interface AcpRpcResult<T> {
  result: T;
  raw: AgentProtocolMessageReference;
}

export interface AcpStartedRequest<T> {
  requestId: AcpJsonRpcId;
  response: Promise<AcpRpcResult<T>>;
  outbound: AgentProtocolMessageReference;
}

/** Omit `timeoutMs` for the bounded client default; use `null` for long-lived completion. */
export interface AcpRequestOptions {
  timeoutMs?: number | null;
}

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

export class AcpAmbiguousMutationError extends Error {
  constructor(
    readonly method: string,
    message: string
  ) {
    super(message);
    this.name = 'AcpAmbiguousMutationError';
  }
}

/** Newline-delimited JSON-RPC 2.0 transport used by ACP stdio agents. */
export class AcpRpcClient {
  readonly events = new EventEmitter<AcpRpcEvents>();

  private readonly pending = new Map<AcpJsonRpcId, PendingRequest>();
  private readonly expiredRequestIds = new Set<AcpJsonRpcId>();
  private inbound = Buffer.alloc(0);
  private inboundQueue: Promise<void> = Promise.resolve();
  private inboundFailure?: Error;
  private outboundQueue: Promise<unknown> = Promise.resolve();
  private nextRequestId = 1;
  private closed = false;

  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
    private readonly journal: AcpJournalWriter,
    readonly serverInstanceId: string,
    private readonly requestTimeoutMs = 30_000,
    private readonly sensitiveValues: readonly string[] = []
  ) {
    output.on('data', this.onData);
    output.once('end', this.onEnd);
    output.once('error', this.onOutputError);
    input.once('error', this.onInputError);
  }

  async request<T>(
    method: string,
    params: unknown,
    options?: AcpRequestOptions
  ): Promise<AcpRpcResult<T>> {
    const started = await this.startRequest<T>(method, params, false, options);
    return started.response;
  }

  async requestMutation<T>(
    method: string,
    params: unknown,
    options?: AcpRequestOptions
  ): Promise<AcpRpcResult<T>> {
    const started = await this.startRequest<T>(method, params, true, options);
    return started.response;
  }

  startMutation<T>(
    method: string,
    params: unknown,
    options?: AcpRequestOptions
  ): Promise<AcpStartedRequest<T>> {
    return this.startRequest<T>(method, params, true, options);
  }

  async notify(method: string, params: unknown): Promise<AgentProtocolMessageReference> {
    return this.write({ jsonrpc: '2.0', method, params });
  }

  /** Waits for every complete message already received from stdout to be dispatched. */
  async drainInbound(): Promise<void> {
    await this.inboundQueue;
    if (this.inboundFailure) throw this.inboundFailure;
  }

  respond(
    id: AcpJsonRpcId,
    result: unknown,
    onJournaled?: (reference: AgentProtocolMessageReference) => Promise<void>
  ): Promise<AgentProtocolMessageReference> {
    return this.write({ jsonrpc: '2.0', id, result }, onJournaled);
  }

  respondError(
    id: AcpJsonRpcId,
    code: number,
    message: string,
    data?: unknown
  ): Promise<AgentProtocolMessageReference> {
    return this.write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) }
    });
  }

  close(reason = 'ACP connection closed.'): void {
    if (this.closed) return;
    this.closed = true;
    this.output.off('data', this.onData);
    this.output.off('end', this.onEnd);
    this.output.off('error', this.onOutputError);
    this.input.off('error', this.onInputError);
    reason = this.redactText(reason);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        pending.mutation
          ? new AcpAmbiguousMutationError(
              pending.method,
              `ACP mutation outcome is ambiguous after disconnect: ${pending.method}. ${reason}`
            )
          : new Error(`${reason} Pending request: ${pending.method}`)
      );
    }
    this.pending.clear();
    this.events.emit('close', reason);
  }

  private async startRequest<T>(
    method: string,
    params: unknown,
    mutation: boolean,
    options?: AcpRequestOptions
  ): Promise<AcpStartedRequest<T>> {
    if (this.closed) throw new Error('ACP connection is closed.');
    const timeoutMs = options?.timeoutMs === undefined
      ? this.requestTimeoutMs
      : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('ACP request timeout must be a positive finite number or null.');
    }
    const requestId = this.nextRequestId++;
    let settle!: PendingRequest;
    const response = new Promise<AcpRpcResult<T>>((resolve, reject) => {
      settle = {
        method,
        mutation,
        resolve: (value) => resolve(value as AcpRpcResult<T>),
        reject
      };
      this.pending.set(requestId, settle);
      if (timeoutMs !== null) {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          this.trackExpired(requestId);
          reject(
            mutation
              ? new AcpAmbiguousMutationError(
                  method,
                  `ACP mutation timed out after submission: ${method}`
                )
              : new Error(`ACP request timed out: ${method}`)
          );
        }, timeoutMs);
        timer.unref();
        settle.timer = timer;
      }
    });

    try {
      const outbound = await this.write({ jsonrpc: '2.0', id: requestId, method, params });
      return { requestId, response, outbound };
    } catch (cause) {
      const safeMessage = this.redactText(errorMessage(cause));
      const deliveryError = mutation
        ? new AcpAmbiguousMutationError(
            method,
            `ACP mutation delivery is ambiguous: ${safeMessage}`
          )
        : new Error(safeMessage);
      if (this.pending.get(requestId) === settle) {
        if (settle.timer) clearTimeout(settle.timer);
        this.pending.delete(requestId);
        settle.reject(deliveryError);
      }
      // The response promise has now been rejected, but callers of startRequest
      // need the direct delivery error and must not receive an unhandled promise.
      void response.catch(() => undefined);
      throw deliveryError;
    }
  }

  private readonly onData = (chunk: Buffer | string): void => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.inbound = Buffer.concat([this.inbound, incoming]);
    if (this.inbound.byteLength > ACP_MAX_MESSAGE_BYTES && this.inbound.indexOf(0x0a) === -1) {
      const error = new Error(`ACP message exceeds ${ACP_MAX_MESSAGE_BYTES} bytes.`);
      this.events.emit('protocolError', error);
      this.close(error.message);
      return;
    }
    let newline: number;
    while ((newline = this.inbound.indexOf(0x0a)) >= 0) {
      const line = this.inbound.subarray(0, newline);
      this.inbound = this.inbound.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > ACP_MAX_MESSAGE_BYTES) {
        const error = new Error(`ACP message exceeds ${ACP_MAX_MESSAGE_BYTES} bytes.`);
        this.events.emit('protocolError', error);
        this.close(error.message);
        return;
      }
      const rawLine = line.toString('utf8').trim();
      if (!rawLine) continue;
      this.enqueueInboundLine(rawLine);
    }
  };

  private readonly onEnd = (): void => {
    if (this.inbound.byteLength > 0) {
      const rawLine = this.inbound.toString('utf8').trim();
      this.inbound = Buffer.alloc(0);
      if (rawLine) {
        this.enqueueInboundLine(rawLine);
      }
    }
    // `close` rejects every pending request. Do not let stream teardown win a
    // race with a complete response that was already accepted from stdout but
    // is still waiting for its durable journal append.
    void this.drainInbound().then(
      () => this.close('ACP stdout ended.'),
      () => this.close('ACP stdout ended after inbound dispatch failed.')
    );
  };

  private readonly onOutputError = (error: Error): void => {
    const safeError = new Error(this.redactText(error.message), { cause: error });
    this.events.emit('protocolError', safeError);
    this.close(`ACP stdout failed: ${safeError.message}`);
  };

  private readonly onInputError = (error: Error): void => {
    const safeError = new Error(this.redactText(error.message), { cause: error });
    this.events.emit('protocolError', safeError);
    this.close(`ACP stdin failed: ${safeError.message}`);
  };

  private async handleLine(rawLine: string): Promise<void> {
    const safeRawLine = redactProtocolText(rawLine, this.sensitiveValues);
    let message: AcpJsonRpcMessage;
    try {
      message = decodeAcpMessage(rawLine);
    } catch (cause) {
      this.events.emit(
        'protocolError',
        new Error(this.redactText(errorMessage(cause)), { cause }),
        MALFORMED_ACP_FRAME
      );
      return;
    }

    let raw: AgentProtocolMessageReference;
    try {
      raw = await this.appendJournal(
        'INBOUND',
        journalSafeInboundMessage(message, rawLine),
        rpcMetadata(message)
      );
    } catch (cause) {
      const error = new Error(
        this.redactText(`Could not durably journal ACP input: ${errorMessage(cause)}`),
        { cause }
      );
      this.events.emit('protocolError', error, safeRawLine);
      this.close(error.message);
      return;
    }

    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (!this.expiredRequestIds.has(message.id)) {
          this.events.emit(
            'protocolError',
            new Error(
              this.redactText(
                `ACP response has no pending request: ${String(message.id)}`
              )
            ),
            safeRawLine,
            raw
          );
        }
        return;
      }
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if ('error' in message) {
        pending.reject(
          new AcpRpcError(
            message.error.code,
            this.redactText(message.error.message),
            redactCredentialValue(message.error.data, this.sensitiveValues)
          )
        );
      } else {
        pending.resolve({ result: message.result, raw });
      }
      return;
    }
    if (isRequest(message)) {
      this.events.emit('request', message, raw);
      return;
    }
    if (isNotification(message)) {
      this.events.emit('notification', message.method, message.params, raw);
    }
  }

  private enqueueInboundLine(rawLine: string): void {
    this.inboundQueue = this.inboundQueue
      .then(() => this.handleLine(rawLine))
      .catch((cause) => {
        this.inboundFailure ??= new Error(this.redactText(errorMessage(cause)), { cause });
      });
  }

  private write(
    message: AcpJsonRpcMessage,
    onJournaled?: (reference: AgentProtocolMessageReference) => Promise<void>
  ): Promise<AgentProtocolMessageReference> {
    const operation = this.outboundQueue.then(async () => {
      if (this.closed) throw new Error('ACP connection is closed.');
      const raw = JSON.stringify(message);
      if (Buffer.byteLength(raw, 'utf8') > ACP_MAX_MESSAGE_BYTES) {
        throw new Error(`ACP outbound message exceeds ${ACP_MAX_MESSAGE_BYTES} bytes.`);
      }
      const reference = await this.appendJournal('OUTBOUND', raw, rpcMetadata(message));
      await onJournaled?.(reference);
      await writeWithBackpressure(this.input, `${raw}\n`);
      return reference;
    });
    this.outboundQueue = operation.catch(() => undefined);
    return operation;
  }

  private trackExpired(id: AcpJsonRpcId): void {
    this.expiredRequestIds.add(id);
    if (this.expiredRequestIds.size > 256) {
      const oldest = this.expiredRequestIds.values().next().value;
      if (oldest !== undefined) this.expiredRequestIds.delete(oldest);
    }
  }

  private appendJournal(
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    const safe = redactProtocolJournalRecord(raw, metadata, this.sensitiveValues);
    return this.journal(direction, safe.raw, safe.metadata);
  }

  private redactText(value: string): string {
    return redactCredentialText(value, this.sensitiveValues);
  }
}

function rpcMetadata(message: AcpJsonRpcMessage): Record<string, unknown> {
  return {
    protocol: 'acp',
    method: 'method' in message ? message.method : undefined,
    id: 'id' in message ? message.id : undefined,
    kind: isRequest(message) ? 'request' : isNotification(message) ? 'notification' : 'response'
  };
}

const MASKED_ACP_STREAM_CONTENT = '[REDACTED PROVIDER STREAM CONTENT]';
const ACP_STREAM_CONTENT_FIELDS = new Set([
  'content',
  'data',
  'rawInput',
  'rawOutput',
  'text',
  'title'
]);

/**
 * Protocol journals are correlation evidence, not provider transcripts. ACP
 * session updates can split one credential across otherwise innocuous JSON-RPC
 * messages, which a record-local exact-value redactor cannot recognize. Keep
 * routing/status fields and remove free-form stream payloads structurally.
 */
function journalSafeInboundMessage(message: AcpJsonRpcMessage, rawLine: string): string {
  if (!isNotification(message) || message.method !== 'session/update') return rawLine;
  if (!isRecord(message.params)) return rawLine;
  const update = message.params.update;
  if (!isRecord(update)) return rawLine;
  return JSON.stringify({
    ...message,
    params: {
      ...message.params,
      update: maskAcpStreamContent(update)
    }
  });
}

function maskAcpStreamContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAcpStreamContent);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      ACP_STREAM_CONTENT_FIELDS.has(key)
        ? MASKED_ACP_STREAM_CONTENT
        : maskAcpStreamContent(entry)
    ])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeWithBackpressure(stream: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off('error', onError);
      stream.off('drain', onDrain);
    };
    stream.once('error', onError);
    const accepted = stream.write(value, 'utf8', (error) => {
      if (error) onError(error);
      else if (accepted) {
        cleanup();
        resolve();
      }
    });
    if (!accepted) stream.once('drain', onDrain);
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
