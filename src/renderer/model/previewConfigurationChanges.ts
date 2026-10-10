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
  type: 'type',
  primary: 'primary service',
  name: 'name'
};

type Node = Record<string, unknown>;

/** The row that names a change to the file as a whole, such as which service receives the preview's traffic. */
const FILE = 'preview.yaml';

/**
 * Every execution-affecting difference between the configuration a run started with and the file
 * now, for the restart review: file-level fields first (type, primary service), then each service.
 * An empty list means the two files run the same configuration.
 */
export function previewConfigurationChanges(previousText: string, nextText: string): PreviewConfigurationChange[] | undefined {
  const before = configuration(previousText);
  const after = configuration(nextText);
  if (!before || !after) return undefined;
  if (before.type !== after.type) return [{ service: FILE, change: `type ${text(after.type)}, was ${text(before.type)}` }];
  const changes: PreviewConfigurationChange[] =
    after.type === 'environment' ? fieldChanges(FILE, omit(before, 'services'), omit(after, 'services')) : [];
  const previous = services(before);
  const next = services(after);
  for (const [id, node] of Object.entries(next)) {
    const was = previous[id];
    if (!was) {
      changes.push({ service: id, change: `new ${String(node.type ?? 'service')}` });
      continue;
    }
    changes.push(...fieldChanges(id, omit(was, 'env'), omit(node, 'env')));
    const beforeEnv = (was.env as Node | undefined) ?? {};
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

function configuration(yamlText: string): Node | undefined {
  const document = parseDocument(yamlText);
  if (document.errors.length) return undefined;
  let config: Node | null;
  try { config = document.toJS({ maxAliasCount: 0 }) as Node | null; } catch { return undefined; }
  return config && typeof config === 'object' && !Array.isArray(config) ? config : undefined;
}

function services(config: Node): Record<string, Node> {
  if (config.type !== 'environment') return { Application: config };
  return Object.fromEntries(Object.entries((config.services as Record<string, Node>) ?? {}).filter(([, node]) => !!node && typeof node === 'object'));
}

/** One row per changed field; values that can carry environment or connection secrets are named, never shown. */
function fieldChanges(owner: string, before: Node, after: Node): PreviewConfigurationChange[] {
  const changes: PreviewConfigurationChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    const name = FIELD_NAMES[key] ?? key;
    if (key === 'url' || hasEnvironment(before[key]) || hasEnvironment(after[key])) {
      changes.push({ service: owner, change: `${name} ${after[key] === undefined ? 'removed' : before[key] === undefined ? 'added' : 'changed'}`, concealed: true });
      continue;
    }
    changes.push({
      service: owner,
      change:
        after[key] === undefined
          ? `${name} removed, was ${text(before[key])}`
          : before[key] === undefined
            ? `${name} ${text(after[key])}`
            : `${name} ${text(after[key])}, was ${text(before[key])}`
    });
  }
  return changes;
}

function omit(node: Node, key: string): Node {
  const { [key]: _omitted, ...rest } = node;
  return rest;
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
