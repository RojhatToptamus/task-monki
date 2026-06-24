import type { RequestId } from './generated/RequestId';
import type { ServerNotification } from './generated/ServerNotification';
import type { ServerRequest } from './generated/ServerRequest';

const KNOWN_CODEX_SERVER_REQUEST_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'applyPatchApproval',
  'execCommandApproval'
] as const satisfies readonly ServerRequest['method'][];

type MissingServerRequestMethod = Exclude<
  ServerRequest['method'],
  (typeof KNOWN_CODEX_SERVER_REQUEST_METHODS)[number]
>;

const SERVER_REQUEST_METHOD_COVERAGE: MissingServerRequestMethod extends never
  ? true
  : never = true;

void SERVER_REQUEST_METHOD_COVERAGE;

const KNOWN_CODEX_SERVER_REQUEST_METHOD_SET = new Set<string>(
  KNOWN_CODEX_SERVER_REQUEST_METHODS
);

export interface CodexRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: CodexRpcErrorPayload;
}

export interface UnsupportedCodexServerRequest {
  method: string;
  id: RequestId;
  params: Record<string, unknown>;
}

export type DecodedCodexProtocolMessage =
  | {
      kind: 'notification';
      notification: ServerNotification;
    }
  | {
      kind: 'serverRequest';
      request: ServerRequest;
    }
  | {
      kind: 'unsupportedServerRequest';
      request: UnsupportedCodexServerRequest;
    }
  | {
      kind: 'response';
      response: CodexRpcResponse;
    };

export class CodexProtocolDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexProtocolDecodeError';
  }
}

export function decodeCodexProtocolMessage(raw: string): DecodedCodexProtocolMessage {
  const message = parseObject(raw);
  const hasMethod = hasOwn(message, 'method');
  const hasId = hasOwn(message, 'id');

  if (hasMethod) {
    const method = readStringField(message, 'method', 'message method');
    if (hasId) {
      const id = readRequestId(message);
      const params = readObjectField(
        message,
        'params',
        `server request ${method} params`
      );
      if (!KNOWN_CODEX_SERVER_REQUEST_METHOD_SET.has(method)) {
        return {
          kind: 'unsupportedServerRequest',
          request: { method, id, params }
        };
      }
      return {
        kind: 'serverRequest',
        request: { method, id, params } as ServerRequest
      };
    }

    const params = readObjectField(message, 'params', `notification ${method} params`);
    return {
      kind: 'notification',
      notification: { method, params } as ServerNotification
    };
  }

  if (hasId) {
    return {
      kind: 'response',
      response: readResponse(message)
    };
  }

  throw new CodexProtocolDecodeError(
    'Codex App Server emitted an unrecognized message shape.'
  );
}

function parseObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexProtocolDecodeError(
      `Codex App Server emitted invalid JSON: ${message}`
    );
  }
  if (!isObjectRecord(parsed)) {
    throw new CodexProtocolDecodeError(
      'Codex App Server emitted a non-object protocol message.'
    );
  }
  return parsed;
}

function readResponse(message: Record<string, unknown>): CodexRpcResponse {
  const id = readRequestId(message);
  const hasResult = hasOwn(message, 'result');
  const hasError = hasOwn(message, 'error');

  if (hasResult === hasError) {
    throw new CodexProtocolDecodeError(
      `Codex App Server response ${String(id)} must include exactly one of result or error.`
    );
  }

  if (hasError) {
    return {
      id,
      error: readRpcError(message.error, id)
    };
  }

  return { id, result: message.result };
}

function readRpcError(value: unknown, id: RequestId): CodexRpcErrorPayload {
  if (!isObjectRecord(value)) {
    throw new CodexProtocolDecodeError(
      `Codex App Server response ${String(id)} has an invalid error payload.`
    );
  }
  const code = value.code;
  const message = value.message;
  if (typeof code !== 'number' || !Number.isFinite(code)) {
    throw new CodexProtocolDecodeError(
      `Codex App Server response ${String(id)} has an invalid error code.`
    );
  }
  if (typeof message !== 'string') {
    throw new CodexProtocolDecodeError(
      `Codex App Server response ${String(id)} has an invalid error message.`
    );
  }
  return hasOwn(value, 'data')
    ? { code, message, data: value.data }
    : { code, message };
}

function readRequestId(message: Record<string, unknown>): RequestId {
  const id = message.id;
  if (typeof id === 'string' || typeof id === 'number') {
    return id;
  }
  throw new CodexProtocolDecodeError(
    'Codex App Server emitted a message with an invalid request id.'
  );
}

function readStringField(
  message: Record<string, unknown>,
  field: string,
  label: string
): string {
  const value = message[field];
  if (typeof value === 'string') {
    return value;
  }
  throw new CodexProtocolDecodeError(`Codex App Server emitted an invalid ${label}.`);
}

function readObjectField(
  message: Record<string, unknown>,
  field: string,
  label: string
): Record<string, unknown> {
  const value = message[field];
  if (isObjectRecord(value)) {
    return value;
  }
  throw new CodexProtocolDecodeError(`Codex App Server emitted invalid ${label}.`);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
