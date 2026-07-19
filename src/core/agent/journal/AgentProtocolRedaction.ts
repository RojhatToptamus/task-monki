import {
  REDACTED_CREDENTIAL,
  normalizeCredentialFieldName,
  redactCredentialText,
  shouldRedactCredentialRecordEntry
} from '../AgentCredentialRedaction';

const DEPTH_LIMIT = 64;

export interface RedactedProtocolJournalRecord {
  raw: string;
  metadata?: Record<string, unknown>;
}

interface RedactionResult {
  value: unknown;
  changed: boolean;
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
