import { parseDocument } from 'yaml';

export interface PreviewConfigurationChange {
  service: string;
  /** One sentence in ink: "ready at /health, was /ready", "new variable FEATURE_FLAG". */
  change: string;
  /** Environment values are never shown; the row says so. */
  concealed?: boolean;
}

const FIELD_NAMES: Record<string, string> = {
  command: 'command',
  cwd: 'working folder',
  directory: 'folder',
  dependsOn: 'starts after',
  readyPath: 'ready at',
  ready: 'readiness',
  liveness: 'health check',
  timeoutMs: 'startup deadline',
  run: 'repeat',
  url: 'connection',
  image: 'image',
  ports: 'ports',
  type: 'type'
};

type Node = Record<string, unknown>;

/** Service-level differences between the configuration a run started with and the file now, for the restart review. */
export function previewConfigurationChanges(previousText: string, nextText: string): PreviewConfigurationChange[] | undefined {
  const previous = services(previousText);
  const next = services(nextText);
  if (!previous || !next) return undefined;
  const changes: PreviewConfigurationChange[] = [];
  for (const [id, node] of Object.entries(next)) {
    const before = previous[id];
    if (!before) {
      changes.push({ service: id, change: `new ${String(node.type ?? 'service')}` });
      continue;
    }
    for (const key of new Set([...Object.keys(before), ...Object.keys(node)])) {
      if (key === 'env') continue;
      if (same(before[key], node[key])) continue;
      const name = FIELD_NAMES[key] ?? key;
      if (key === 'url' || hasEnvironment(before[key]) || hasEnvironment(node[key])) {
        changes.push({ service: id, change: `${name} ${node[key] === undefined ? 'removed' : before[key] === undefined ? 'added' : 'changed'}`, concealed: true });
        continue;
      }
      changes.push({
        service: id,
        change:
          node[key] === undefined
            ? `${name} removed, was ${text(before[key])}`
            : before[key] === undefined
              ? `${name} ${text(node[key])}`
              : `${name} ${text(node[key])}, was ${text(before[key])}`
      });
    }
    const beforeEnv = (before.env as Node | undefined) ?? {};
    const nextEnv = (node.env as Node | undefined) ?? {};
    for (const key of new Set([...Object.keys(beforeEnv), ...Object.keys(nextEnv)])) {
      if (same(beforeEnv[key], nextEnv[key])) continue;
      changes.push({
        service: id,
        change: !(key in beforeEnv) ? `new variable ${key}` : !(key in nextEnv) ? `variable ${key} removed` : `variable ${key} changed`,
        concealed: key in nextEnv
      });
    }
  }
  for (const id of Object.keys(previous)) if (!next[id]) changes.push({ service: id, change: 'removed' });
  return changes;
}

function services(yamlText: string): Record<string, Node> | undefined {
  const document = parseDocument(yamlText);
  if (document.errors.length) return undefined;
  let config: Node | null;
  try { config = document.toJS({ maxAliasCount: 0 }) as Node | null; } catch { return undefined; }
  if (!config || typeof config !== 'object') return undefined;
  if (config.type === 'environment') {
    const entries = Object.entries((config.services as Record<string, Node>) ?? {}).filter(([, node]) => !!node && typeof node === 'object');
    return Object.fromEntries(entries);
  }
  return { Application: config };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(' ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Probe environments receive the same concealment as a service environment. */
function hasEnvironment(value: unknown): boolean {
  return !!value && typeof value === 'object' &&
    ('env' in value || Object.values(value).some(hasEnvironment));
}
