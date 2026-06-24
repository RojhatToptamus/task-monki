const WORD_OVERRIDES = new Map<string, string>([
  ['api', 'API'],
  ['ci', 'CI'],
  ['gh', 'GitHub'],
  ['id', 'ID'],
  ['json', 'JSON'],
  ['mcp', 'MCP'],
  ['pr', 'PR'],
  ['sha', 'SHA'],
  ['url', 'URL']
]);

export function humanizeEnum(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return '—';
  }

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const override = WORD_OVERRIDES.get(lower);
      if (override) {
        return override;
      }
      return index === 0 ? capitalize(lower) : lower;
    })
    .join(' ');
}

export function formatStatusValue(value: string): string {
  if (value === '—') {
    return value;
  }
  if (looksLikeInternalEnum(value)) {
    return humanizeEnum(value);
  }
  return value;
}

export function looksLikeInternalEnum(value: string): boolean {
  return value.includes('_') || /^[A-Z]+$/.test(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface StructuredDataProps {
  value: unknown;
  rawLabel?: string;
  emptyLabel?: string;
}

export function StructuredData({
  value,
  rawLabel = 'View raw JSON',
  emptyLabel = 'No structured details.'
}: StructuredDataProps) {
  if (isEmptyValue(value)) {
    return <span className="muted">{emptyLabel}</span>;
  }

  return (
    <div className="structured-data">
      <StructuredValue value={value} depth={0} />
      <details className="structured-data__raw">
        <summary>{rawLabel}</summary>
        <pre>{stringifyJson(value)}</pre>
      </details>
    </div>
  );
}

function StructuredValue({
  value,
  depth
}: {
  value: unknown;
  depth: number;
}) {
  if (Array.isArray(value)) {
    return (
      <ol className="structured-data__list">
        {value.map((entry, index) => (
          <li key={index}>
            <StructuredValue value={entry} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) {
      return <span className="muted">Empty object.</span>;
    }

    if (depth > 1) {
      return <code>{stringifyCompact(value)}</code>;
    }

    return (
      <dl className="structured-data__grid">
        {entries.map(([key, entry]) => (
          <div className="structured-data__row" key={key}>
            <dt>{humanizeEnum(key)}</dt>
            <dd>
              <StructuredValue value={entry} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <PrimitiveValue value={value} />;
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="muted">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span>{value ? 'true' : 'false'}</span>;
  }
  if (typeof value === 'number') {
    return <span>{value.toLocaleString()}</span>;
  }
  if (typeof value === 'string') {
    return looksLikeInternalEnum(value) ? <span>{humanizeEnum(value)}</span> : <span>{value}</span>;
  }
  return <code>{String(value)}</code>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
