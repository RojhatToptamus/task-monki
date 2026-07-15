export const REDACTED_CREDENTIAL = '[REDACTED]';

const NON_SECRET_DESCRIPTOR_SUFFIX =
  /(?:status|state|type|count|name|required|available|enabled|supported|id|policy)$/u;
const TOKEN_ACCOUNTING_FIELD =
  /(?:input|output|total|cached|reasoning|completion|prompt|max|min)tokens?$/u;
const PAGINATION_TOKEN_FIELD = /(?:page|continuation)token$/u;
const PAIRED_CREDENTIAL_DESCRIPTOR_FIELDS = new Set([
  'env',
  'envname',
  'header',
  'headername',
  'id',
  'key',
  'name',
  'variable',
  'variablename'
]);
const PAIRED_CREDENTIAL_VALUE_FIELDS = new Set([
  'currentvalue',
  'defaultvalue',
  'value'
]);

/**
 * Returns whether a field name conventionally carries credential material.
 * Call {@link shouldRedactCredentialField} when the field value is available
 * so boolean capability descriptors can be preserved.
 */
export function isSensitiveCredentialFieldName(fieldName: string): boolean {
  const normalized = normalizeCredentialFieldName(fieldName);
  if (!normalized) return false;

  if (
    NON_SECRET_DESCRIPTOR_SUFFIX.test(normalized) ||
    TOKEN_ACCOUNTING_FIELD.test(normalized) ||
    PAGINATION_TOKEN_FIELD.test(normalized)
  ) {
    return false;
  }

  if (
    normalized.includes('authorization') ||
    normalized.includes('password') ||
    normalized.includes('passphrase') ||
    normalized.includes('secret') ||
    normalized.includes('credential') ||
    normalized.includes('cookie') ||
    normalized.includes('apikey') ||
    normalized.includes('privatekey') ||
    normalized === 'proxyauthorization' ||
    normalized === 'passwd' ||
    normalized === 'setcookie'
  ) {
    return true;
  }

  return (
    /(?:auth|access|refresh|identity|id|session|bearer|csrf|xsrf|security|oauth|api|personalaccess)token$/u.test(
      normalized
    ) || /token$/u.test(normalized)
  );
}

export function shouldRedactCredentialField(
  fieldName: string,
  value: unknown
): boolean {
  if (!isSensitiveCredentialFieldName(fieldName)) return false;
  const normalized = normalizeCredentialFieldName(fieldName);
  return !(
    typeof value === 'boolean' &&
    (normalized.startsWith('has') || normalized.startsWith('supports'))
  );
}

/**
 * Handles structures such as `{ name: 'OPENAI_API_KEY', value: '...' }`,
 * `{ key: 'Authorization', value: '...' }`, and ACP config selectors.
 */
export function shouldRedactCredentialRecordEntry(
  record: Record<string, unknown>,
  fieldName: string,
  value: unknown
): boolean {
  if (shouldRedactCredentialField(fieldName, value)) return true;
  if (
    !PAIRED_CREDENTIAL_VALUE_FIELDS.has(
      normalizeCredentialFieldName(fieldName)
    )
  ) {
    return false;
  }

  return Object.entries(record).some(([candidateField, candidateValue]) => {
    if (
      !PAIRED_CREDENTIAL_DESCRIPTOR_FIELDS.has(
        normalizeCredentialFieldName(candidateField)
      ) ||
      typeof candidateValue !== 'string'
    ) {
      return false;
    }
    return shouldRedactCredentialField(candidateValue, value);
  });
}

export function normalizeCredentialFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/**
 * Redacts credentials embedded in provider-controlled display or diagnostic
 * text. Runtime adapters pass the exact values inherited by their child
 * process so opaque credentials are covered even when their shape carries no
 * recognizable credential marker.
 */
export function redactCredentialText(
  value: string,
  sensitiveValues: readonly string[] = []
): string {
  let redacted = value
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
      (_match, scheme: string) => `${scheme} ${REDACTED_CREDENTIAL}`
    )
    .replace(
      /(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^/?#\s@]+)@/giu,
      (_match, boundary: string, scheme: string) =>
        `${boundary}${scheme}${REDACTED_CREDENTIAL}@`
    )
    .replace(
      /\b((?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/giu,
      (_match, label: string) => `${label}${REDACTED_CREDENTIAL}`
    )
    .replace(
      /\b((?:(?:[a-z0-9]+[_-])*(?:api[_-]?key|auth[_-]?token|oauth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|personal[_-]?access[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|password|passwd|credentials?|secret|token))["']?\s*[:=]\s*)(["']?)([^\s,;&"']+)\2/giu,
      (_match, label: string, quote: string) =>
        `${label}${quote}${REDACTED_CREDENTIAL}${quote}`
    )
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[oprsu]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
      REDACTED_CREDENTIAL
    );
  for (const sensitive of normalizedSensitiveValues(sensitiveValues)) {
    redacted = redacted.split(sensitive).join(REDACTED_CREDENTIAL);
  }
  return redacted;
}

/** Redacts a JSON-compatible provider value without mutating its source. */
export function redactCredentialValue<T>(
  value: T,
  sensitiveValues: readonly string[] = [],
  depth = 0
): T {
  if (typeof value === 'string') {
    return redactCredentialText(value, sensitiveValues) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 64) return REDACTED_CREDENTIAL as T;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactCredentialValue(entry, sensitiveValues, depth + 1)
    ) as T;
  }

  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const safeKey = redactCredentialText(key, sensitiveValues);
    if (safeKey !== key) continue;
    redacted[safeKey] = shouldRedactCredentialRecordEntry(record, key, entry)
      ? REDACTED_CREDENTIAL
      : redactCredentialValue(entry, sensitiveValues, depth + 1);
  }
  return redacted as T;
}

function normalizedSensitiveValues(values: readonly string[]): string[] {
  return [...new Set(values)]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
}
