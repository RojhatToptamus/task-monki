import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import {
  decodeCodexProtocolMessage,
  type CodexRpcErrorPayload,
  type CodexRpcResponse,
  type UnsupportedCodexServerRequest
} from './protocol/CodexProtocolCodec';
import type { InitializeParams } from './protocol/generated/InitializeParams';
import type { InitializeResponse } from './protocol/generated/InitializeResponse';
import type { RequestId } from './protocol/generated/RequestId';
import type { ServerNotification } from './protocol/generated/ServerNotification';
import type { ServerRequest } from './protocol/generated/ServerRequest';
import type { GetAccountParams } from './protocol/generated/v2/GetAccountParams';
import type { GetAccountResponse } from './protocol/generated/v2/GetAccountResponse';
import type { ModelListParams } from './protocol/generated/v2/ModelListParams';
import type { ModelListResponse } from './protocol/generated/v2/ModelListResponse';
import type { ModelProviderCapabilitiesReadParams } from './protocol/generated/v2/ModelProviderCapabilitiesReadParams';
import type { ModelProviderCapabilitiesReadResponse } from './protocol/generated/v2/ModelProviderCapabilitiesReadResponse';
import type { ThreadReadParams } from './protocol/generated/v2/ThreadReadParams';
import type { ThreadReadResponse } from './protocol/generated/v2/ThreadReadResponse';
import type { ThreadForkParams } from './protocol/generated/v2/ThreadForkParams';
import type { ThreadForkResponse } from './protocol/generated/v2/ThreadForkResponse';
import type { ThreadGoalGetParams } from './protocol/generated/v2/ThreadGoalGetParams';
import type { ThreadGoalGetResponse } from './protocol/generated/v2/ThreadGoalGetResponse';
import type { ThreadGoalSetParams } from './protocol/generated/v2/ThreadGoalSetParams';
import type { ThreadGoalSetResponse } from './protocol/generated/v2/ThreadGoalSetResponse';
import type { ThreadResumeParams } from './protocol/generated/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from './protocol/generated/v2/ThreadResumeResponse';
import type { ThreadStartParams } from './protocol/generated/v2/ThreadStartParams';
import type { ThreadStartResponse } from './protocol/generated/v2/ThreadStartResponse';
import type { TurnInterruptParams } from './protocol/generated/v2/TurnInterruptParams';
import type { TurnInterruptResponse } from './protocol/generated/v2/TurnInterruptResponse';
import type { TurnStartParams } from './protocol/generated/v2/TurnStartParams';
import type { TurnStartResponse } from './protocol/generated/v2/TurnStartResponse';
import type { TurnSteerParams } from './protocol/generated/v2/TurnSteerParams';
import type { TurnSteerResponse } from './protocol/generated/v2/TurnSteerResponse';
import type { ReviewStartParams } from './protocol/generated/v2/ReviewStartParams';
import type { ReviewStartResponse } from './protocol/generated/v2/ReviewStartResponse';

interface CodexMethodMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  'account/read': { params: GetAccountParams; result: GetAccountResponse };
  'model/list': { params: ModelListParams; result: ModelListResponse };
  'modelProvider/capabilities/read': {
    params: ModelProviderCapabilitiesReadParams;
    result: ModelProviderCapabilitiesReadResponse;
  };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/fork': { params: ThreadForkParams; result: ThreadForkResponse };
  'thread/goal/get': { params: ThreadGoalGetParams; result: ThreadGoalGetResponse };
  'thread/goal/set': { params: ThreadGoalSetParams; result: ThreadGoalSetResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
  'review/start': { params: ReviewStartParams; result: ReviewStartResponse };
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  mutation: boolean;
}

interface RpcEvents {
  notification: [
    notification: ServerNotification,
    raw: AgentProtocolMessageReference
  ];
  serverRequest: [request: ServerRequest, raw: AgentProtocolMessageReference];
  unsupportedServerRequest: [
    request: UnsupportedCodexServerRequest,
    raw: AgentProtocolMessageReference
  ];
  protocolError: [error: Error, rawLine: string, raw?: AgentProtocolMessageReference];
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

export class CodexAmbiguousMutationError extends Error {
  constructor(
    readonly method: string,
    message: string
  ) {
    super(message);
    this.name = 'CodexAmbiguousMutationError';
  }
}

export class CodexRpcClient {
  readonly events = new EventEmitter<RpcEvents>();

  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly expiredRequests = new Set<RequestId>();
  private readonly reader;
  private inboundQueue: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly store: FileTaskStore,
    readonly serverInstanceId: string,
    private readonly requestTimeoutMs = 30_000
  ) {
    this.reader = createInterface({ input: output, crlfDelay: Infinity });
    this.reader.on('line', (line) => {
      this.inboundQueue = this.inboundQueue.then(
        () => this.handleLine(line),
        () => this.handleLine(line)
      );
    });
  }

  request<M extends keyof CodexMethodMap>(
    method: M,
    params: CodexMethodMap[M]['params'],
    timeoutMs = this.requestTimeoutMs
  ): Promise<CodexMethodMap[M]['result']> {
    return this.sendRequest(method, params, timeoutMs, false);
  }

  requestMutation<M extends keyof CodexMethodMap>(
    method: M,
    params: CodexMethodMap[M]['params'],
    timeoutMs = this.requestTimeoutMs
  ): Promise<CodexMethodMap[M]['result']> {
    return this.sendRequest(method, params, timeoutMs, true);
  }

  private sendRequest<M extends keyof CodexMethodMap>(
    method: M,
    params: CodexMethodMap[M]['params'],
    timeoutMs: number,
    mutation: boolean
  ): Promise<CodexMethodMap[M]['result']> {
    if (this.closed) {
      return Promise.reject(new Error('Codex App Server connection is closed.'));
    }

    const id = this.nextRequestId++;
    return new Promise<CodexMethodMap[M]['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.trackExpiredRequest(id);
        reject(
          mutation
            ? new CodexAmbiguousMutationError(
                method,
                `Codex App Server mutation timed out after submission: ${method}`
              )
            : new Error(`Codex App Server request timed out: ${method}`)
        );
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as CodexMethodMap[M]['result']),
        reject,
        timer,
        mutation
      });

      void this.write({ method, id, params }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        reject(
          mutation
            ? new CodexAmbiguousMutationError(
                method,
                `Codex App Server mutation delivery is ambiguous: ${message}`
              )
            : error instanceof Error
              ? error
              : new Error(message)
        );
      });
    });
  }

  async notify(method: 'initialized', params: Record<string, never>): Promise<void> {
    await this.write({ method, params });
  }

  respond(
    id: RequestId,
    result: unknown,
    onJournaled?: (reference: AgentProtocolMessageReference) => Promise<void>
  ): Promise<AgentProtocolMessageReference> {
    return this.write({ id, result }, onJournaled);
  }

  async respondError(id: RequestId, error: CodexRpcErrorPayload): Promise<void> {
    await this.write({ id, error });
  }

  close(reason = 'Codex App Server connection closed.'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.reader.close();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        request.mutation
          ? new CodexAmbiguousMutationError(
              request.method,
              `${reason} Mutation delivery is ambiguous: ${request.method}`
            )
          : new Error(`${reason} Pending request: ${request.method}`)
      );
    }
    this.pending.clear();
  }

  drain(): Promise<void> {
    return this.inboundQueue;
  }

  private async write(
    message: unknown,
    onJournaled?: (reference: AgentProtocolMessageReference) => Promise<void>
  ): Promise<AgentProtocolMessageReference> {
    const raw = JSON.stringify(message);
    const reference = await this.store.appendProtocolMessage(
      this.serverInstanceId,
      'OUTBOUND',
      raw,
      { transport: 'stdio' }
    );
    await onJournaled?.(reference);
    await writeLine(this.input, `${raw}\n`);
    return reference;
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    let rawReference: AgentProtocolMessageReference | undefined;
    try {
      rawReference = await this.store.appendProtocolMessage(
        this.serverInstanceId,
        'INBOUND',
        line,
        { transport: 'stdio' }
      );
      const decoded = decodeCodexProtocolMessage(line);
      switch (decoded.kind) {
        case 'notification':
          this.events.emit('notification', decoded.notification, rawReference);
          return;
        case 'serverRequest':
          this.events.emit('serverRequest', decoded.request, rawReference);
          return;
        case 'unsupportedServerRequest':
          this.events.emit('unsupportedServerRequest', decoded.request, rawReference);
          return;
        case 'response':
          this.handleResponse(decoded.response);
          return;
      }
    } catch (error) {
      this.events.emit(
        'protocolError',
        error instanceof Error ? error : new Error(String(error)),
        line,
        rawReference
      );
    }
  }

  private handleResponse(response: CodexRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      if (this.expiredRequests.delete(response.id)) {
        return;
      }
      throw new Error(`Codex App Server responded with an unknown request id: ${response.id}`);
    }

    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(
        new CodexRpcError(response.error.code, response.error.message, response.error.data)
      );
      return;
    }
    if (!('result' in response)) {
      pending.reject(
        pending.mutation
          ? new CodexAmbiguousMutationError(
              pending.method,
              `Codex App Server mutation response has no result: ${response.id}`
            )
          : new Error(`Codex App Server response has no result: ${response.id}`)
      );
      return;
    }
    pending.resolve(response.result);
  }

  private trackExpiredRequest(id: RequestId): void {
    this.expiredRequests.add(id);
    if (this.expiredRequests.size <= 100) {
      return;
    }
    const oldest = this.expiredRequests.values().next().value;
    if (oldest !== undefined) {
      this.expiredRequests.delete(oldest);
    }
  }
}

function writeLine(stream: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(line, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
