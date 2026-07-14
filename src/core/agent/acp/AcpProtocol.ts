/**
 * Focused ACP stable-v1 wire types.
 *
 * These types follow the official schema artifact v1.19.0. Task Monki's main
 * process is CommonJS while the official TypeScript SDK is ESM-only, so the
 * runtime uses a small typed JSON-RPC transport instead of pulling an SDK
 * through an unsafe interop shim. Unknown `_meta` and extension payloads stay
 * lossless in the protocol journal.
 */

export const ACP_PROTOCOL_VERSION = 1 as const;
export const ACP_SCHEMA_ARTIFACT_VERSION = '1.19.0' as const;
export const ACP_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export type AcpJsonRpcId = string | number | null;

export interface AcpJsonRpcRequest {
  jsonrpc: '2.0';
  id: AcpJsonRpcId;
  method: string;
  params?: unknown;
}

export interface AcpJsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface AcpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type AcpJsonRpcResponse =
  | { jsonrpc: '2.0'; id: AcpJsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: AcpJsonRpcId; error: AcpJsonRpcError };

export type AcpJsonRpcMessage =
  | AcpJsonRpcRequest
  | AcpJsonRpcNotification
  | AcpJsonRpcResponse;

export interface AcpClientCapabilities {
  fs: { readTextFile: false; writeTextFile: false };
  terminal: false;
}

export interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface AcpSessionCapabilities {
  list?: Record<string, unknown> | null;
  delete?: Record<string, unknown> | null;
  additionalDirectories?: Record<string, unknown> | null;
  resume?: Record<string, unknown> | null;
  close?: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: AcpPromptCapabilities;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: AcpSessionCapabilities;
  auth?: Record<string, unknown>;
  _meta?: Record<string, unknown> | null;
}

export interface AcpInitializeResponse {
  protocolVersion: number;
  agentCapabilities: AcpAgentCapabilities;
  authMethods: unknown[];
  agentInfo?: { name: string; version?: string; title?: string } | null;
  _meta?: Record<string, unknown> | null;
}

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
  _meta?: Record<string, unknown> | null;
}

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  kind?: AcpToolKind | null;
  status?: AcpToolCallStatus | null;
  content?: unknown[] | null;
  locations?: unknown[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Record<string, unknown> | null;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpTextContent {
  type: 'text';
  text: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  _meta?: Record<string, unknown> | null;
}

export type AcpContentBlock =
  | AcpTextContent
  | AcpImageContent
  | AcpResourceLink
  | (Record<string, unknown> & { type: string });

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionConfigSelectGroup {
  group: string;
  name: string;
  options: AcpSessionConfigSelectOption[];
  _meta?: Record<string, unknown> | null;
}

export type AcpSessionConfigOption =
  | {
      id: string;
      name: string;
      description?: string | null;
      category?: string | null;
      type: 'select';
      currentValue: string;
      options: Array<AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup>;
      _meta?: Record<string, unknown> | null;
    }
  | {
      id: string;
      name: string;
      description?: string | null;
      category?: string | null;
      type: 'boolean';
      currentValue: boolean;
      _meta?: Record<string, unknown> | null;
    };

export interface AcpSessionSetupResponse {
  sessionId?: string;
  modes?: AcpSessionModeState | null;
  configOptions?: AcpSessionConfigOption[] | null;
  _meta?: Record<string, unknown> | null;
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpPromptResponse {
  stopReason: AcpStopReason;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
  _meta?: Record<string, unknown> | null;
}

export type AcpSessionUpdate = Record<string, unknown> & {
  sessionUpdate: string;
};

export function decodeAcpMessage(rawLine: string): AcpJsonRpcMessage {
  if (Buffer.byteLength(rawLine, 'utf8') > ACP_MAX_MESSAGE_BYTES) {
    throw new Error(`ACP message exceeds ${ACP_MAX_MESSAGE_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(rawLine);
  } catch (cause) {
    throw new Error(`Invalid ACP JSON: ${errorMessage(cause)}`);
  }
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    throw new Error('ACP message is not a JSON-RPC 2.0 object.');
  }

  if (typeof value.method === 'string') {
    if ('id' in value && !isJsonRpcId(value.id)) {
      throw new Error('ACP request id is invalid.');
    }
    return value as unknown as AcpJsonRpcRequest | AcpJsonRpcNotification;
  }

  if (!('id' in value) || !isJsonRpcId(value.id)) {
    throw new Error('ACP response id is invalid.');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  if (hasResult === hasError) {
    throw new Error('ACP response must contain exactly one of result or error.');
  }
  if (hasError && !isRpcError(value.error)) {
    throw new Error('ACP response error is invalid.');
  }
  return value as unknown as AcpJsonRpcResponse;
}

export function parseInitializeResponse(value: unknown): AcpInitializeResponse {
  const record = requireRecord(value, 'ACP initialize response');
  if (!Number.isSafeInteger(record.protocolVersion)) {
    throw new Error('ACP initialize response has no valid protocolVersion.');
  }
  const agentCapabilities = isRecord(record.agentCapabilities)
    ? (record.agentCapabilities as AcpAgentCapabilities)
    : {};
  const agentInfo = record.agentInfo == null
    ? null
    : isRecord(record.agentInfo) && typeof record.agentInfo.name === 'string'
      ? (record.agentInfo as unknown as AcpInitializeResponse['agentInfo'])
      : undefined;
  return {
    protocolVersion: record.protocolVersion as number,
    agentCapabilities,
    authMethods: Array.isArray(record.authMethods) ? record.authMethods : [],
    agentInfo,
    _meta: optionalMeta(record._meta)
  };
}

export function parseNewSessionResponse(value: unknown): AcpSessionSetupResponse & {
  sessionId: string;
} {
  const parsed = parseSessionSetupResponse(value);
  if (!parsed.sessionId) {
    throw new Error('ACP session/new response has no sessionId.');
  }
  return { ...parsed, sessionId: parsed.sessionId };
}

export function parseSessionSetupResponse(value: unknown): AcpSessionSetupResponse {
  const record = requireRecord(value, 'ACP session setup response');
  const sessionId = typeof record.sessionId === 'string' && record.sessionId
    ? record.sessionId
    : undefined;
  return {
    sessionId,
    modes: parseModeState(record.modes),
    configOptions: parseConfigOptions(record.configOptions),
    _meta: optionalMeta(record._meta)
  };
}

export function parsePromptResponse(value: unknown): AcpPromptResponse {
  const record = requireRecord(value, 'ACP prompt response');
  if (!isStopReason(record.stopReason)) {
    throw new Error('ACP prompt response has an invalid stopReason.');
  }
  return { stopReason: record.stopReason, _meta: optionalMeta(record._meta) };
}

export function parseSessionNotification(value: unknown): AcpSessionNotification {
  const record = requireRecord(value, 'ACP session/update notification');
  const update = requireRecord(record.update, 'ACP session update');
  if (typeof record.sessionId !== 'string' || !record.sessionId) {
    throw new Error('ACP session/update has no sessionId.');
  }
  if (typeof update.sessionUpdate !== 'string' || !update.sessionUpdate) {
    throw new Error('ACP session/update has no update discriminator.');
  }
  return {
    sessionId: record.sessionId,
    update: update as AcpSessionUpdate,
    _meta: optionalMeta(record._meta)
  };
}

export function parsePermissionRequest(value: unknown): AcpRequestPermissionParams {
  const record = requireRecord(value, 'ACP permission request');
  const toolCall = requireRecord(record.toolCall, 'ACP permission tool call');
  if (typeof record.sessionId !== 'string' || !record.sessionId) {
    throw new Error('ACP permission request has no sessionId.');
  }
  if (typeof toolCall.toolCallId !== 'string' || !toolCall.toolCallId) {
    throw new Error('ACP permission request has no toolCallId.');
  }
  if (!Array.isArray(record.options) || record.options.length === 0) {
    throw new Error('ACP permission request has no options.');
  }
  const options = record.options.map((candidate) => {
    const option = requireRecord(candidate, 'ACP permission option');
    if (
      typeof option.optionId !== 'string' ||
      !option.optionId ||
      typeof option.name !== 'string' ||
      !isPermissionKind(option.kind)
    ) {
      throw new Error('ACP permission option is invalid.');
    }
    return {
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
      _meta: optionalMeta(option._meta)
    };
  });
  return {
    sessionId: record.sessionId,
    toolCall: toolCall as unknown as AcpToolCallUpdate,
    options,
    _meta: optionalMeta(record._meta)
  };
}

export function parseConfigOptions(value: unknown): AcpSessionConfigOption[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new Error('ACP configOptions must be an array or null.');
  }
  return value.map((candidate) => {
    const option = requireRecord(candidate, 'ACP session config option');
    if (typeof option.id !== 'string' || typeof option.name !== 'string') {
      throw new Error('ACP session config option has no id or name.');
    }
    const common = {
      id: option.id,
      name: option.name,
      description: typeof option.description === 'string' ? option.description : null,
      category: typeof option.category === 'string' ? option.category : null,
      _meta: optionalMeta(option._meta)
    };
    if (option.type === 'boolean' && typeof option.currentValue === 'boolean') {
      return { ...common, type: 'boolean' as const, currentValue: option.currentValue };
    }
    if (
      option.type === 'select' &&
      typeof option.currentValue === 'string' &&
      Array.isArray(option.options)
    ) {
      return {
        ...common,
        type: 'select' as const,
        currentValue: option.currentValue,
        options: option.options.map(parseSelectEntry)
      };
    }
    throw new Error(`ACP session config option ${option.id} has an unsupported shape.`);
  });
}

export function flattenSelectOptions(
  option: Extract<AcpSessionConfigOption, { type: 'select' }>
): AcpSessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}

export function isRequest(message: AcpJsonRpcMessage): message is AcpJsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isNotification(
  message: AcpJsonRpcMessage
): message is AcpJsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isResponse(message: AcpJsonRpcMessage): message is AcpJsonRpcResponse {
  return !('method' in message);
}

function parseSelectEntry(
  value: unknown
): AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup {
  const entry = requireRecord(value, 'ACP config select option');
  if (Array.isArray(entry.options)) {
    if (typeof entry.group !== 'string' || typeof entry.name !== 'string') {
      throw new Error('ACP config select group is invalid.');
    }
    return {
      group: entry.group,
      name: entry.name,
      options: entry.options.map((nested) => {
        const parsed = parseSelectEntry(nested);
        if ('options' in parsed) throw new Error('Nested ACP config groups are not supported.');
        return parsed;
      }),
      _meta: optionalMeta(entry._meta)
    };
  }
  if (typeof entry.value !== 'string' || typeof entry.name !== 'string') {
    throw new Error('ACP config select option is invalid.');
  }
  return {
    value: entry.value,
    name: entry.name,
    description: typeof entry.description === 'string' ? entry.description : null,
    _meta: optionalMeta(entry._meta)
  };
}

function parseModeState(value: unknown): AcpSessionModeState | null {
  if (value == null) return null;
  const state = requireRecord(value, 'ACP session mode state');
  if (typeof state.currentModeId !== 'string' || !Array.isArray(state.availableModes)) {
    throw new Error('ACP session mode state is invalid.');
  }
  return {
    currentModeId: state.currentModeId,
    availableModes: state.availableModes.map((candidate) => {
      const mode = requireRecord(candidate, 'ACP session mode');
      if (typeof mode.id !== 'string' || typeof mode.name !== 'string') {
        throw new Error('ACP session mode is invalid.');
      }
      return {
        id: mode.id,
        name: mode.name,
        description: typeof mode.description === 'string' ? mode.description : null,
        _meta: optionalMeta(mode._meta)
      };
    }),
    _meta: optionalMeta(state._meta)
  };
}

function isJsonRpcId(value: unknown): value is AcpJsonRpcId {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isRpcError(value: unknown): value is AcpJsonRpcError {
  return (
    isRecord(value) &&
    Number.isInteger(value.code) &&
    typeof value.message === 'string'
  );
}

function isStopReason(value: unknown): value is AcpStopReason {
  return [
    'end_turn',
    'max_tokens',
    'max_turn_requests',
    'refusal',
    'cancelled'
  ].includes(String(value));
}

function isPermissionKind(value: unknown): value is AcpPermissionOptionKind {
  return ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(
    String(value)
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalMeta(value: unknown): Record<string, unknown> | null | undefined {
  return value == null ? (value === null ? null : undefined) : isRecord(value) ? value : undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
