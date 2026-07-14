import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
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
  timer: NodeJS.Timeout;
  resolve(value: AcpRpcResult<unknown>): void;
  reject(error: Error): void;
}

interface AcpRpcEvents {
  notification: [method: string, params: unknown, raw: AgentProtocolMessageReference];
  request: [request: AcpJsonRpcRequest, raw: AgentProtocolMessageReference];
  protocolError: [error: Error, rawLine?: string, raw?: AgentProtocolMessageReference];
  close: [reason: string];
}

export interface AcpRpcResult<T> {
  result: T;
  raw: AgentProtocolMessageReference;
}

export interface AcpStartedRequest<T> {
  requestId: AcpJsonRpcId;
  response: Promise<AcpRpcResult<T>>;
  outbound: AgentProtocolMessageReference;
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
  private outboundQueue: Promise<unknown> = Promise.resolve();
  private nextRequestId = 1;
  private closed = false;

  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
    private readonly journal: AcpJournalWriter,
    readonly serverInstanceId: string,
    private readonly requestTimeoutMs = 30_000
  ) {
    output.on('data', this.onData);
    output.once('end', this.onEnd);
    output.once('error', this.onOutputError);
    input.once('error', this.onInputError);
  }

  async request<T>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<AcpRpcResult<T>> {
    const started = await this.startRequest<T>(method, params, false, timeoutMs);
    return started.response;
  }

  async requestMutation<T>(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<AcpRpcResult<T>> {
    const started = await this.startRequest<T>(method, params, true, timeoutMs);
    return started.response;
  }

  startMutation<T>(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<AcpStartedRequest<T>> {
    return this.startRequest<T>(method, params, true, timeoutMs);
  }

  async notify(method: string, params: unknown): Promise<AgentProtocolMessageReference> {
    return this.write({ jsonrpc: '2.0', method, params });
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
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
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
    timeoutMs: number
  ): Promise<AcpStartedRequest<T>> {
    if (this.closed) throw new Error('ACP connection is closed.');
    const requestId = this.nextRequestId++;
    let settle!: PendingRequest;
    const response = new Promise<AcpRpcResult<T>>((resolve, reject) => {
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
      settle = {
        method,
        mutation,
        timer,
        resolve: (value) => resolve(value as AcpRpcResult<T>),
        reject
      };
      this.pending.set(requestId, settle);
    });

    try {
      const outbound = await this.write({ jsonrpc: '2.0', id: requestId, method, params });
      return { requestId, response, outbound };
    } catch (cause) {
      if (this.pending.get(requestId) === settle) {
        clearTimeout(settle.timer);
        this.pending.delete(requestId);
        settle.reject(
          mutation
            ? new AcpAmbiguousMutationError(
                method,
                `ACP mutation delivery is ambiguous: ${errorMessage(cause)}`
              )
            : asError(cause)
        );
      }
      // The response promise has now been rejected, but callers of startRequest
      // need the direct delivery error and must not receive an unhandled promise.
      void response.catch(() => undefined);
      throw mutation
        ? new AcpAmbiguousMutationError(
            method,
            `ACP mutation delivery is ambiguous: ${errorMessage(cause)}`
          )
        : asError(cause);
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
      this.inboundQueue = this.inboundQueue.then(
        () => this.handleLine(rawLine),
        () => this.handleLine(rawLine)
      );
    }
  };

  private readonly onEnd = (): void => {
    if (this.inbound.byteLength > 0) {
      const rawLine = this.inbound.toString('utf8').trim();
      this.inbound = Buffer.alloc(0);
      if (rawLine) {
        this.inboundQueue = this.inboundQueue.then(
          () => this.handleLine(rawLine),
          () => this.handleLine(rawLine)
        );
      }
    }
    void this.inboundQueue.finally(() => this.close('ACP stdout ended.'));
  };

  private readonly onOutputError = (error: Error): void => {
    this.events.emit('protocolError', error);
    this.close(`ACP stdout failed: ${error.message}`);
  };

  private readonly onInputError = (error: Error): void => {
    this.events.emit('protocolError', error);
    this.close(`ACP stdin failed: ${error.message}`);
  };

  private async handleLine(rawLine: string): Promise<void> {
    let message: AcpJsonRpcMessage;
    try {
      message = decodeAcpMessage(rawLine);
    } catch (cause) {
      this.events.emit('protocolError', asError(cause), rawLine);
      return;
    }

    let raw: AgentProtocolMessageReference;
    try {
      raw = await this.journal('INBOUND', rawLine, rpcMetadata(message));
    } catch (cause) {
      const error = new Error(`Could not durably journal ACP input: ${errorMessage(cause)}`);
      this.events.emit('protocolError', error, rawLine);
      this.close(error.message);
      return;
    }

    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (!this.expiredRequestIds.has(message.id)) {
          this.events.emit(
            'protocolError',
            new Error(`ACP response has no pending request: ${String(message.id)}`),
            rawLine,
            raw
          );
        }
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ('error' in message) {
        pending.reject(new AcpRpcError(message.error.code, message.error.message, message.error.data));
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
      const reference = await this.journal('OUTBOUND', raw, rpcMetadata(message));
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
}

function rpcMetadata(message: AcpJsonRpcMessage): Record<string, unknown> {
  return {
    protocol: 'acp',
    method: 'method' in message ? message.method : undefined,
    id: 'id' in message ? message.id : undefined,
    kind: isRequest(message) ? 'request' : isNotification(message) ? 'notification' : 'response'
  };
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
