import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import {
  parsePreviewSpec,
  type PreviewSpec,
  type PreviewDescription
} from 'previewhost';
import type {
  PreviewConfigurationFile,
  PreviewSourceRequirement
} from '../../shared/applicationPreview';

export function parseConfigurationFile(text: string): PreviewSpec {
  if (Buffer.byteLength(text) > 65_536)
    throw new Error('Preview configuration exceeds 64 KiB.');
  const document = parseDocument(text);
  if (document.errors.length) {
    const line = document.errors[0]?.linePos?.[0]?.line;
    throw new Error(
      `Invalid YAML${line ? ` at line ${line}` : ''}. Open Configuration to correct it.`
    );
  }
  try {
    return parsePreviewSpec(document.toJS({ maxAliasCount: 0 }));
  } catch {
    throw new Error(
      'The YAML does not match the Preview configuration format. Review service types, commands, and references.'
    );
  }
}

export function within(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** File paths remain portable. Only this runtime input receives local substitutions. */
export async function resolveConfigurationSources(
  file: PreviewConfigurationFile,
  worktree: string,
  repository: string,
  roots: readonly string[],
  locations: ReadonlyMap<string, { path: string; canonical: string }>
): Promise<{ spec: PreviewSpec; sources: PreviewSourceRequirement[] }> {
  const spec = parseConfigurationFile(file.text);
  const root = await fs.realpath(worktree);
  const sources: PreviewSourceRequirement[] = [];
  async function resolveSource(service: string, declaration: string) {
    const local = path.resolve(root, declaration);
    const external = !within(root, local);
    const selected = locations.get(declaration);
    const directory =
      selected?.path ??
      (external ? path.resolve(repository, declaration) : local);
    const canonical = await fs.realpath(directory).catch(() => undefined);
    const exists =
      !!canonical &&
      (await fs.stat(canonical).then(
        (stat) => stat.isDirectory(),
        () => false
      ));
    const unchanged = !selected || canonical === selected.canonical;
    const connected =
      exists &&
      unchanged &&
      (within(root, canonical!) ||
        roots.some((allowed) => within(allowed, canonical!)));
    sources.push({
      service,
      declaration,
      directory,
      connected,
      ...(!exists ? { missing: true } : {})
    });
    // Keep the declared path until access is checked; a re-pointed selection
    // must not silently become a newly approved directory.
    return canonical && unchanged ? canonical : directory;
  }
  const entries =
    spec.type === 'environment'
      ? Object.entries(spec.services)
      : [['Application', spec] as const];
  for (const [id, service] of entries) {
    if ('cwd' in service) service.cwd = await resolveSource(id, service.cwd);
    if ('directory' in service)
      service.directory = await resolveSource(id, service.directory);
    const probes = [
      ['readiness', 'ready' in service ? service.ready : undefined],
      ['liveness', 'liveness' in service ? service.liveness?.probe : undefined]
    ] as const;
    for (const [kind, probe] of probes) {
      if (probe?.type === 'command' && probe.cwd)
        probe.cwd = await resolveSource(`${id} ${kind}`, probe.cwd);
    }
  }
  return { spec, sources };
}

export function missingConnections(spec: PreviewSpec): string[] {
  if (spec.type !== 'environment') return [];
  return Object.entries(spec.services)
    .filter(
      ([, service]) =>
        ((service.type === 'attach' ||
          service.type === 'external-postgres' ||
          service.type === 'external-redis') &&
          !service.url) ||
        (service.type === 'external-tcp' && !service.port)
    )
    .map(([id]) => id);
}

/** Recover only fields a redacted description actually carries, as an unsaved proposal. */
export function reconcileRetainedConfiguration(
  file: PreviewConfigurationFile,
  description: PreviewDescription
) {
  const document = parseDocument(file.text);
  if (document.errors.length) return;
  const value = document.toJS({ maxAliasCount: 0 });
  if (
    !value ||
    typeof value !== 'object' ||
    value.type !== description.spec.type
  )
    return;
  const services =
    description.spec.type === 'environment'
      ? Object.entries(description.spec.services)
      : [['Application', description.spec] as const];
  const changes: string[] = [];
  const concealedKeys: string[] = [];
  for (const [id, node] of services) {
    const prefix = value.type === 'environment' ? ['services', id] : [];
    const saved = prefix.length ? value.services?.[id] : value;
    if (!saved || saved.type !== node.type) continue;
    for (const [key, entry] of Object.entries(node)) {
      // Defaults omitted from the file are intentional. A missing address is a
      // requirement; other settings are offered only when explicitly present.
      if (
        ![
          'url',
          'readyPath',
          'timeoutMs',
          'dependsOn',
          'run',
          'ready',
          'ports'
        ].includes(key) ||
        (key !== 'url' && !(key in saved))
      )
        continue;
      if (entry !== undefined && !isDeepStrictEqual(saved[key], entry)) {
        document.setIn([...prefix, key], entry);
        changes.push(`${id} · ${key}`);
      }
    }
    const bindings = 'bindings' in node ? node.bindings : undefined;
    for (const [key, binding] of Object.entries(bindings ?? {})) {
      if (!isDeepStrictEqual(saved.env?.[key], binding)) {
        document.setIn([...prefix, 'env', key], binding);
        changes.push(`${id} · ${key}`);
      }
    }
    const keys =
      'envKeys' in node
        ? node.envKeys
        : id === 'Application'
          ? description.envKeys
          : undefined;
    for (const key of keys ?? [])
      if (!(key in (bindings ?? {})) && !(key in (saved.env ?? {})))
        concealedKeys.push(`${id} · ${key}`);
  }
  return changes.length || concealedKeys.length
    ? { text: document.toString(), changes, concealedKeys }
    : undefined;
}
