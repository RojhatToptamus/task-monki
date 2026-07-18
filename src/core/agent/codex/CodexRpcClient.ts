import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import {
  REDACTED_CREDENTIAL,
  redactCredentialText,
  redactCredentialValue
} from '../AgentCredentialRedaction';
import { redactProtocolJournalRecord } from '../journal/AgentProtocolRedaction';
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
  private readonly closedSignal: Promise<Error>;
  private resolveClosedSignal!: (error: Error) => void;
  private inboundQueue: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly store: FileTaskStore,
    readonly serverInstanceId: string,
    private readonly requestTimeoutMs = 30_000,
    private readonly sensitiveValues: readonly string[] = []
  ) {
    this.closedSignal = new Promise((resolve) => {
      this.resolveClosedSignal = resolve;
    });
    this.reader = createInterface({ input: output, crlfDelay: Infinity });
    // Writable failures are reported to each write callback below. Keep the
    // stream error observed as well so an EPIPE cannot surface as an uncaught
    // process-level exception while that callback settles the RPC operation.
    this.input.on('error', () => undefined);
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

      void this.write(
        { method, id, params },
        undefined,
        mutation ? method : undefined
      ).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        reject(error instanceof Error ? error : new Error(message));
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
    return this.write({ id, result }, onJournaled, 'server-request/response');
  }

  async respondError(id: RequestId, error: CodexRpcErrorPayload): Promise<void> {
    await this.write({ id, error }, undefined, 'server-request/error-response');
  }

  /**
   * Waits until every line observed by the stdout reader has been journaled
   * and delivered to protocol listeners. The supervisor calls this only after
   * the child stdio streams have closed, so no later line can join the queue.
   */
  drainInbound(): Promise<void> {
    return this.inboundQueue;
  }

  close(reason = 'Codex App Server connection closed.'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.reader.close();
    this.resolveClosedSignal(new Error(reason));
    this.input.destroy();
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

  private async write(
    message: unknown,
    onJournaled?: (reference: AgentProtocolMessageReference) => Promise<void>,
    ambiguousOperation?: string
  ): Promise<AgentProtocolMessageReference> {
    const raw = JSON.stringify(message);
    const safe = redactProtocolJournalRecord(
      raw,
      { transport: 'stdio' },
      this.sensitiveValues
    );
    const reference = await this.store.appendProtocolMessage(
      this.serverInstanceId,
      'OUTBOUND',
      safe.raw,
      safe.metadata
    );
    await onJournaled?.(reference);
    if (this.closed) {
      throw new Error('Codex App Server connection is closed.');
    }
    try {
      await Promise.race([
        writeLine(this.input, `${raw}\n`),
        this.closedSignal.then((error) => Promise.reject(error))
      ]);
    } catch (error) {
      const message = redactCredentialText(
        error instanceof Error ? error.message : String(error),
        this.sensitiveValues
      );
      const safeError = new Error(message);
      throw ambiguousOperation
        ? new CodexAmbiguousMutationError(
            ambiguousOperation,
            `Codex App Server mutation delivery is ambiguous: ${message}`
          )
        : safeError;
    }
    return reference;
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    let rawReference: AgentProtocolMessageReference | undefined;
    try {
      const safe = redactProtocolJournalRecord(
        redactInboundStreamingJournalPayload(line),
        { transport: 'stdio' },
        this.sensitiveValues
      );
      rawReference = await this.store.appendProtocolMessage(
        this.serverInstanceId,
        'INBOUND',
        safe.raw,
        safe.metadata
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
      const safeError = new Error(
        redactCredentialText(
          error instanceof Error ? error.message : String(error),
          this.sensitiveValues
        ),
        { cause: error }
      );
      this.events.emit(
        'protocolError',
        safeError,
        REDACTED_MALFORMED_PROTOCOL_FRAME,
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
        new CodexRpcError(
          response.error.code,
          redactCredentialText(response.error.message, this.sensitiveValues),
          redactCredentialValue(response.error.data, this.sensitiveValues)
        )
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

/**
 * Streaming payloads can split a credential across otherwise harmless JSON
 * records, which makes record-local exact-value redaction insufficient. The
 * journal does not need provider-authored free-form deltas for correlation, so
 * remove those fields structurally while preserving method and identity data.
 * Normalized output remains available through the run artifact.
 */
function redactInboundStreamingJournalPayload(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return REDACTED_MALFORMED_PROTOCOL_FRAME;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return REDACTED_MALFORMED_PROTOCOL_FRAME;
  }

  const message = value as Record<string, unknown>;
  if (typeof message.method !== 'string') {
    return 'id' in message ? raw : REDACTED_MALFORMED_PROTOCOL_FRAME;
  }
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return REDACTED_MALFORMED_PROTOCOL_FRAME;
  }

  const field = STREAMING_JOURNAL_FIELDS.get(message.method);
  if (field) {
    const originalParams = params as Record<string, unknown>;
    if (!(field in originalParams)) {
      return raw;
    }
    return JSON.stringify({
      ...message,
      params: { ...originalParams, [field]: REDACTED_CREDENTIAL }
    });
  }

  if (message.method === 'thread/realtime/outputAudio/delta') {
    const originalParams = params as Record<string, unknown>;
    const audio = originalParams.audio;
    if (!audio || typeof audio !== 'object' || Array.isArray(audio)) {
      return raw;
    }
    const originalAudio = audio as Record<string, unknown>;
    if (!('data' in originalAudio)) {
      return raw;
    }
    return JSON.stringify({
      ...message,
      params: {
        ...originalParams,
        audio: { ...originalAudio, data: REDACTED_CREDENTIAL }
      }
    });
  }

  return raw;
}

const REDACTED_MALFORMED_PROTOCOL_FRAME = JSON.stringify({
  malformedProtocolFrame: REDACTED_CREDENTIAL
});

const STREAMING_JOURNAL_FIELDS = new Map<string, string>([
  ['item/agentMessage/delta', 'delta'],
  ['item/plan/delta', 'delta'],
  ['item/commandExecution/outputDelta', 'delta'],
  ['item/fileChange/outputDelta', 'delta'],
  ['item/reasoning/summaryTextDelta', 'delta'],
  ['item/reasoning/textDelta', 'delta'],
  ['turn/diff/updated', 'diff'],
  ['command/exec/outputDelta', 'deltaBase64'],
  ['process/outputDelta', 'deltaBase64'],
  ['item/mcpToolCall/progress', 'message'],
  ['thread/realtime/transcript/delta', 'delta']
]);

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
