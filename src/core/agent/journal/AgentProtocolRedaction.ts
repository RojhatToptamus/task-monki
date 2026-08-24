import {
  REDACTED_CREDENTIAL,
  normalizeCredentialFieldName,
  redactCredentialText,
  shouldRedactCredentialRecordEntry
} from '../AgentCredentialRedaction';

const DEPTH_LIMIT = 64;
const DESIGN_TOOL_NAME = 'inspect_design';
const OMITTED_DESIGN_IMAGE = '[transient Design screenshot omitted]';

export interface RedactedProtocolJournalRecord {
  raw: string;
  metadata?: Record<string, unknown>;
}

interface RedactionResult {
  value: unknown;
  changed: boolean;
}

/**
 * Removes images only from Task Monki's registered Design tool shapes.
 * The caller still sends the original protocol message to Codex.
 */
export class DesignToolProtocolSanitizer {
  private readonly requestIds = new Set<string>();

  sanitizeRaw(raw: string, direction: 'INBOUND' | 'OUTBOUND'): string {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (!isRecord(value)) return raw;
    if (direction === 'INBOUND' && isDesignToolRequest(value)) {
      this.remember(this.requestIds, requestIdKey(value.id));
    }
    const sanitized = this.sanitizeValue(value);
    if (
      direction === 'OUTBOUND' &&
      value.id !== undefined &&
      this.requestIds.has(requestIdKey(value.id))
    ) {
      const direct = redactToolResponseImages(sanitized);
      return JSON.stringify(direct);
    }
    return JSON.stringify(sanitized) === JSON.stringify(value)
      ? raw
      : JSON.stringify(sanitized);
  }

  sanitizeValue<T>(value: T): T {
    return sanitizeDesignToolValue(value, 0) as T;
  }

  private remember(set: Set<string>, value: string): void {
    set.add(value);
    if (set.size > 200) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }
}

/**
 * Removes credential material before a provider message reaches durable
 * storage. JSON messages retain their structure; non-JSON diagnostics retain
 * their surrounding text.
 */
export function redactProtocolJournalRecord(
  raw: string,
  metadata?: Record<string, unknown>,
  sensitiveValues: readonly string[] = []
): RedactedProtocolJournalRecord {
  return {
    raw: redactProtocolText(raw, sensitiveValues),
    ...(metadata === undefined
      ? {}
      : { metadata: redactMetadata(metadata, sensitiveValues) })
  };
}

export function redactProtocolText(
  raw: string,
  sensitiveValues: readonly string[] = []
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return redactCredentialText(raw, sensitiveValues);
  }

  const redacted = redactJsonValue(parsed, 0, sensitiveValues);
  return redacted.changed ? JSON.stringify(redacted.value) : raw;
}

function redactMetadata(
  metadata: Record<string, unknown>,
  sensitiveValues: readonly string[]
): Record<string, unknown> {
  // Normalize metadata using the same JSON semantics used by the journal
  // encoder. This also prevents a caller from mutating it after append starts.
  const normalized = JSON.parse(JSON.stringify(metadata)) as Record<
    string,
    unknown
  >;
  return redactJsonValue(normalized, 0, sensitiveValues).value as Record<string, unknown>;
}

function redactJsonValue(
  value: unknown,
  depth: number,
  sensitiveValues: readonly string[]
): RedactionResult {
  if (typeof value === 'string') {
    const redacted = redactCredentialText(value, sensitiveValues);
    return { value: redacted, changed: redacted !== value };
  }
  if (value === null || typeof value !== 'object') {
    return { value, changed: false };
  }
  if (depth >= DEPTH_LIMIT) {
    return { value: REDACTED_CREDENTIAL, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const redacted = value.map((entry) => {
      const result = redactJsonValue(entry, depth + 1, sensitiveValues);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? redacted : value, changed };
  }

  const record = value as Record<string, unknown>;
  let changed = false;
  const redacted: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;

  for (const [key, entry] of Object.entries(record)) {
    if (
      normalizeCredentialFieldName(key) === 'email' ||
      shouldRedactCredentialRecordEntry(record, key, entry)
    ) {
      redacted[key] = REDACTED_CREDENTIAL;
      changed = true;
      continue;
    }
    const result = redactJsonValue(entry, depth + 1, sensitiveValues);
    redacted[key] = result.value;
    changed ||= result.changed;
  }

  return { value: changed ? redacted : value, changed };
}

function sanitizeDesignToolValue(
  value: unknown,
  depth: number
): unknown {
  if (depth >= DEPTH_LIMIT || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDesignToolValue(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (
    record.type === 'dynamicToolCall' &&
    record.tool === DESIGN_TOOL_NAME &&
    record.namespace === null &&
    typeof record.id === 'string'
  ) {
    return {
      ...record,
      contentItems: redactContentItems(record.contentItems)
    };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      sanitizeDesignToolValue(entry, depth + 1)
    ])
  );
}

function redactToolResponseImages(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.result)) return value;
  return {
    ...value,
    result: {
      ...value.result,
      contentItems: redactContentItems(value.result.contentItems)
    }
  };
}

function redactContentItems(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) =>
    isRecord(item) && item.type === 'inputImage'
      ? { ...item, imageUrl: OMITTED_DESIGN_IMAGE }
      : item
  );
}

function isDesignToolRequest(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  id: unknown;
  params: { namespace: null; tool: string; callId: string };
} {
  return (
    value.method === 'item/tool/call' &&
    isRecord(value.params) &&
    value.params.namespace === null &&
    value.params.tool === DESIGN_TOOL_NAME &&
    typeof value.params.callId === 'string' &&
    value.id !== undefined
  );
}

function requestIdKey(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
