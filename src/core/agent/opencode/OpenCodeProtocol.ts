import type {
  AgentItemStatus,
  AgentItemType,
  AgentModel,
  AgentPlanStep,
  AgentSessionStatus,
  AgentTokenUsageBreakdown
} from '../../../shared/agent';
import { redactCredentialText } from '../AgentCredentialRedaction';
import { OPENCODE_RUNTIME_ID } from './OpenCodeRuntimeResolver';

const MAX_ERROR_DIAGNOSTIC_BYTES = 4 * 1024;
const ERROR_DIAGNOSTIC_TRUNCATION_SUFFIX = '… [OpenCode diagnostic truncated]';

export interface OpenCodeHealth {
  healthy: true;
  version: string;
}

export interface OpenCodeSession {
  id: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  model?: { providerID: string; modelID?: string; id?: string; variant?: string };
  metadata?: Record<string, unknown>;
  time?: { created?: number; updated?: number };
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  parentID?: string;
  providerID?: string;
  modelID?: string;
  model?: { providerID?: string; modelID?: string; id?: string };
  variant?: string;
  finish?: string;
  error?: unknown;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number; completed?: number };
}

export interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  [key: string]: unknown;
}

export interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  action?: string;
  permission?: string;
  resources?: string[];
  patterns?: string[];
  save?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  source?: { type?: string; messageID?: string; callID?: string };
  tool?: { messageID?: string; callID?: string };
  title?: string;
  time?: { created?: number };
}

export interface OpenCodeQuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options?: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  tool?: { messageID?: string; callID?: string };
}

export interface OpenCodeEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface OpenCodeProvider {
  id: string;
  name?: string;
  models: Record<string, OpenCodeProviderModel>;
}

export interface OpenCodeProviderModel {
  id: string;
  providerID?: string;
  name?: string;
  status?: 'alpha' | 'beta' | 'deprecated' | 'active' | string;
  capabilities?: {
    reasoning?: boolean;
    attachment?: boolean;
    input?: Record<string, boolean>;
  };
  variants?: Record<string, unknown>;
  family?: string;
  limit?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  release_date?: string;
}

export interface OpenCodeProviderCatalog {
  providers: OpenCodeProvider[];
  connected: string[];
  defaults: Record<string, string>;
}

export function parseOpenCodeHealth(value: unknown): OpenCodeHealth {
  const record = asRecord(value);
  if (record?.healthy !== true || typeof record.version !== 'string') {
    throw new Error('OpenCode health response is incompatible.');
  }
  return { healthy: true, version: record.version };
}

export function parseOpenCodeSession(value: unknown): OpenCodeSession {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.directory !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.version !== 'string'
  ) {
    throw new Error('OpenCode returned an incompatible session record.');
  }
  return record as unknown as OpenCodeSession;
}

export function parseOpenCodeSessions(value: unknown): OpenCodeSession[] {
  if (!Array.isArray(value)) throw new Error('OpenCode session list is incompatible.');
  return value.map(parseOpenCodeSession);
}

export function parseOpenCodeMessages(value: unknown): OpenCodeMessage[] {
  if (!Array.isArray(value)) throw new Error('OpenCode message history is incompatible.');
  return value.map((entry) => {
    const record = asRecord(entry);
    const info = asRecord(record?.info);
    if (
      !record ||
      !info ||
      typeof info.id !== 'string' ||
      typeof info.sessionID !== 'string' ||
      (info.role !== 'user' && info.role !== 'assistant') ||
      !Array.isArray(record.parts)
    ) {
      throw new Error('OpenCode returned an incompatible message record.');
    }
    return record as unknown as OpenCodeMessage;
  });
}

export function parseOpenCodePermissions(value: unknown): OpenCodePermissionRequest[] {
  if (!Array.isArray(value)) throw new Error('OpenCode permission queue is incompatible.');
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record || typeof record.id !== 'string' || typeof record.sessionID !== 'string') {
      throw new Error('OpenCode returned an incompatible permission request.');
    }
    return record as unknown as OpenCodePermissionRequest;
  });
}

export function parseOpenCodeQuestions(value: unknown): OpenCodeQuestionRequest[] {
  if (!Array.isArray(value)) throw new Error('OpenCode question queue is incompatible.');
  return value.map((entry) => {
    const record = asRecord(entry);
    if (
      !record ||
      typeof record.id !== 'string' ||
      typeof record.sessionID !== 'string' ||
      !Array.isArray(record.questions)
    ) {
      throw new Error('OpenCode returned an incompatible question request.');
    }
    return record as unknown as OpenCodeQuestionRequest;
  });
}

export function normalizeOpenCodeEvent(value: unknown): OpenCodeEvent {
  let record = asRecord(value);
  if (record && asRecord(record.payload)) record = asRecord(record.payload);
  if (!record || typeof record.type !== 'string') {
    throw new Error('OpenCode emitted an incompatible event.');
  }
  const properties = asRecord(record.properties) ?? asRecord(record.data) ?? {};
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    type: record.type,
    properties
  };
}

export function parseOpenCodeProviderCatalog(value: unknown): OpenCodeProviderCatalog {
  const record = asRecord(value);
  const all = Array.isArray(record?.all)
    ? record.all
    : Array.isArray(record?.providers)
      ? record.providers
      : Array.isArray(value)
        ? value
        : undefined;
  if (!all) throw new Error('OpenCode provider catalog is incompatible.');
  const providers = all.map((entry) => {
    const provider = asRecord(entry);
    if (!provider || typeof provider.id !== 'string' || !asRecord(provider.models)) {
      throw new Error('OpenCode returned an incompatible provider record.');
    }
    return provider as unknown as OpenCodeProvider;
  });
  if (!Array.isArray(record?.connected) || record.connected.some((entry) => typeof entry !== 'string')) {
    throw new Error(
      'OpenCode provider catalog is missing authoritative connected-provider state.'
    );
  }
  const connected = record.connected as string[];
  const defaults = asRecord(record?.default) ?? {};
  return {
    providers,
    connected,
    defaults: Object.fromEntries(
      Object.entries(defaults).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  };
}

export function mapOpenCodeModels(catalog: OpenCodeProviderCatalog): AgentModel[] {
  const connected = new Set(catalog.connected);
  return catalog.providers
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models).map((model): AgentModel => {
        const modelId = model.id;
        const modalities = Object.entries(model.capabilities?.input ?? { text: true })
          .filter(([, supported]) => supported)
          .map(([modality]) => modality);
        const variants = Object.keys(model.variants ?? {});
        return {
          id: `${OPENCODE_RUNTIME_ID}:${provider.id}/${modelId}`,
          runtimeId: OPENCODE_RUNTIME_ID,
          modelProvider: provider.id,
          model: modelId,
          displayName: model.name ?? `${provider.name ?? provider.id} ${modelId}`,
          description: `${provider.name ?? provider.id} via OpenCode`,
          hidden: model.status === 'deprecated',
          supportedReasoningEfforts: variants,
          defaultReasoningEffort: undefined,
          serviceTiers: [],
          inputModalities: modalities.length > 0 ? modalities : ['text'],
          isDefault: catalog.defaults[provider.id] === modelId,
          native: jsonValue({
            providerName: provider.name ?? provider.id,
            status: model.status,
            family: model.family,
            capabilities: model.capabilities,
            variants: model.variants,
            limit: model.limit,
            cost: model.cost,
            releaseDate: model.release_date
          })
        };
      })
    )
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.displayName.localeCompare(right.displayName);
    });
}

export function mapOpenCodeSessionStatus(value: unknown): AgentSessionStatus {
  const type = typeof value === 'string' ? value : asRecord(value)?.type;
  if (type === 'busy' || type === 'active') return 'ACTIVE';
  if (type === 'idle') return 'IDLE';
  if (type === 'retry' || type === 'error') return 'SYSTEM_ERROR';
  return 'UNKNOWN';
}

export function mapOpenCodePartType(part: OpenCodePart): AgentItemType {
  switch (part.type) {
    case 'text':
      return 'AGENT_MESSAGE';
    case 'reasoning':
      return 'REASONING_SUMMARY';
    case 'compaction':
      return 'CONTEXT_COMPACTION';
    case 'subtask':
    case 'agent':
      return 'SUBAGENT';
    case 'patch':
      return 'FILE_CHANGE';
    case 'tool': {
      const tool = part.tool?.toLowerCase() ?? '';
      if (['bash', 'shell', 'terminal'].some((name) => tool.includes(name))) return 'COMMAND_EXECUTION';
      if (['edit', 'write', 'patch', 'apply'].some((name) => tool.includes(name))) return 'FILE_CHANGE';
      if (tool.includes('web')) return 'WEB_SEARCH';
      if (tool.includes('mcp')) return 'MCP_TOOL_CALL';
      if (tool.includes('task') || tool.includes('agent')) return 'SUBAGENT';
      return 'OTHER';
    }
    default:
      return 'OTHER';
  }
}

export function mapOpenCodePartStatus(part: OpenCodePart): AgentItemStatus {
  const status = part.state?.status;
  if (status === 'pending') return 'STARTED';
  if (status === 'running') return 'IN_PROGRESS';
  if (status === 'completed') return 'COMPLETED';
  if (status === 'error') return 'FAILED';
  if (part.type === 'text' || part.type === 'reasoning') return 'IN_PROGRESS';
  return 'UNKNOWN';
}

export function mapOpenCodeTodoSteps(value: unknown): AgentPlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const todo = asRecord(entry);
    if (!todo || typeof todo.content !== 'string') return [];
    const status = todo.status === 'completed'
      ? 'COMPLETED'
      : todo.status === 'in_progress'
        ? 'IN_PROGRESS'
        : 'PENDING';
    return [{ step: todo.content, status }];
  });
}

export function mapOpenCodeUsage(info: OpenCodeMessageInfo): AgentTokenUsageBreakdown {
  const input = finiteToken(info.tokens?.input);
  const cached = finiteToken(info.tokens?.cache?.read);
  const cacheWrite = finiteToken(info.tokens?.cache?.write);
  const output = finiteToken(info.tokens?.output);
  const reasoning = finiteToken(info.tokens?.reasoning);
  return {
    totalTokens:
      finiteToken(info.tokens?.total) || input + cached + cacheWrite + output + reasoning,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: reasoning
  };
}

/**
 * Maps OpenCode's provider-owned error envelope to a safe durable diagnostic.
 *
 * Error envelopes may contain response bodies, headers, request metadata, and
 * credentials. Only the small scalar contract below is eligible for a user-
 * visible diagnostic. The structurally redacted envelope remains available in
 * the bounded protocol journal for debugging.
 */
export function openCodeErrorDiagnostic(
  value: unknown,
  sensitiveValues: readonly string[] = []
): string {
  const record = asRecord(value);
  const data = asRecord(record?.data);
  const nestedError = asRecord(record?.error);
  const dataError = asRecord(data?.error);
  const cause = asRecord(record?.cause);
  const message = firstNonEmptyString(
    typeof value === 'string' ? value : undefined,
    record?.message,
    data?.message,
    nestedError?.message,
    dataError?.message,
    cause?.message
  );
  const name = firstNonEmptyString(
    record?.name,
    data?.name,
    nestedError?.name,
    dataError?.name,
    cause?.name
  );
  const status = firstDiagnosticScalar(
    record?.statusCode,
    data?.statusCode,
    nestedError?.statusCode,
    dataError?.statusCode,
    record?.status,
    data?.status
  );
  const code = firstDiagnosticScalar(
    record?.code,
    data?.code,
    nestedError?.code,
    dataError?.code
  );
  const retryable = firstBoolean(
    record?.isRetryable,
    data?.isRetryable,
    nestedError?.isRetryable,
    dataError?.isRetryable
  );
  const details = [
    status === undefined ? undefined : `status ${status}`,
    code === undefined || code === status ? undefined : `code ${code}`,
    retryable === undefined ? undefined : retryable ? 'retryable' : 'not retryable'
  ].filter((entry): entry is string => entry !== undefined);
  const summary = message
    ? `${name ? `${name}: ` : ''}${message}${details.length > 0 ? ` (${details.join('; ')})` : ''}`
    : name
      ? `${name}${details.length > 0 ? ` (${details.join('; ')})` : ''}`
      : details.length > 0
        ? `OpenCode reported a provider error (${details.join('; ')}).`
        : 'OpenCode reported a structured provider error.';
  const redacted = redactCredentialText(normalizeDiagnosticText(summary), sensitiveValues);
  return boundDiagnostic(redacted);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
}

function firstDiagnosticScalar(...values: unknown[]): string | undefined {
  const value = values.find(
    (candidate): candidate is string | number =>
      (typeof candidate === 'string' && candidate.trim().length > 0) ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
  );
  return typeof value === 'number' ? String(value) : value?.trim();
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean');
}

function normalizeDiagnosticText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function boundDiagnostic(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= MAX_ERROR_DIAGNOSTIC_BYTES) return value;
  const suffix = Buffer.from(ERROR_DIAGNOSTIC_TRUNCATION_SUFFIX, 'utf8');
  const head = bytes
    .subarray(0, MAX_ERROR_DIAGNOSTIC_BYTES - suffix.byteLength)
    .toString('utf8')
    .replace(/\uFFFD+$/gu, '');
  return `${head}${ERROR_DIAGNOSTIC_TRUNCATION_SUFFIX}`;
}

function jsonValue(value: unknown): import('../../../shared/agent').AgentJsonValue {
  return JSON.parse(JSON.stringify(value)) as import('../../../shared/agent').AgentJsonValue;
}
