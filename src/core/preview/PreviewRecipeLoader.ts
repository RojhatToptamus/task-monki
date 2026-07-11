import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  visit,
  type Node
} from 'yaml';
import type {
  PreviewEnvironmentValue,
  PreviewExecutionPlan,
  PreviewJobPlan,
  PreviewLivenessPlan,
  PreviewReadinessPlan,
  PreviewRoutePlan,
  PreviewServicePlan,
  PreviewWorkerPlan
} from '../../shared/preview';
import { isPathWithin } from './PreviewPaths';

export const PREVIEW_RECIPE_PATH = '.taskmonki/preview.yaml' as const;
export const MAX_PREVIEW_RECIPE_BYTES = 64 * 1024;
const MAX_NODES = 32;
const MAX_COMMAND_ARGS = 64;
const MAX_ARGUMENT_BYTES = 2_048;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_ROUTES = 16;
const MAX_TOTAL_PORTS = 64;
const MAX_RESTARTS = 8;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export interface ParsedPreviewRecipe {
  recipeDigest: string;
  executionDigest: string;
  executionPlan: PreviewExecutionPlan;
}

export type LoadedPreviewRecipe =
  | { status: 'MISSING'; reason: string }
  | { status: 'LOADED'; recipePath: typeof PREVIEW_RECIPE_PATH; parsed: ParsedPreviewRecipe };

export class PreviewRecipeLoader {
  async load(worktreePath: string): Promise<LoadedPreviewRecipe> {
    const worktreeRoot = await fs.realpath(path.resolve(worktreePath));
    const recipePath = path.join(worktreePath, PREVIEW_RECIPE_PATH);
    let recipeStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      recipeStat = await fs.lstat(recipePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          status: 'MISSING',
          reason: `No ${PREVIEW_RECIPE_PATH} exists in the task worktree.`
        };
      }
      throw error;
    }
    if (recipeStat.isSymbolicLink() || !recipeStat.isFile()) {
      throw new Error(`Preview recipe must be a regular file, not a symlink or special file.`);
    }
    const realRecipePath = await fs.realpath(recipePath);
    if (!isPathWithin(worktreeRoot, realRecipePath)) {
      throw new Error(`Preview recipe escapes the task worktree.`);
    }
    if (recipeStat.size > MAX_PREVIEW_RECIPE_BYTES) {
      throw new Error(`Preview recipe exceeds ${MAX_PREVIEW_RECIPE_BYTES} bytes.`);
    }

    const handle = await fs.open(realRecipePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let source: string;
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size > MAX_PREVIEW_RECIPE_BYTES) {
        throw new Error(`Preview recipe exceeds ${MAX_PREVIEW_RECIPE_BYTES} bytes or is not regular.`);
      }
      const bytes = Buffer.alloc(MAX_PREVIEW_RECIPE_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_PREVIEW_RECIPE_BYTES) {
        throw new Error(`Preview recipe exceeds ${MAX_PREVIEW_RECIPE_BYTES} bytes.`);
      }
      source = bytes.subarray(0, offset).toString('utf8');
    } finally {
      await handle.close();
    }
    return {
      status: 'LOADED',
      recipePath: PREVIEW_RECIPE_PATH,
      parsed: parsePreviewRecipe(source)
    };
  }
}

export function parsePreviewRecipe(source: string): ParsedPreviewRecipe {
  if (Buffer.byteLength(source) > MAX_PREVIEW_RECIPE_BYTES) {
    throw new Error(`Preview recipe exceeds ${MAX_PREVIEW_RECIPE_BYTES} bytes.`);
  }
  const document = parseDocument(source, {
    schema: 'core',
    uniqueKeys: true,
    prettyErrors: true,
    strict: true
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join('\n'));
  }

  visit(document, (_key, node) => rejectUnsafeYamlNode(node as Node | null));
  assertStringKeys(document.contents);
  const value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  if (!isRecord(value)) {
    throw new Error('Preview recipe must be a mapping.');
  }

  const executionPlan = normalizeExecutionPlan(value);
  return {
    recipeDigest: sha256(canonicalJson(value)),
    executionDigest: sha256(canonicalJson(executionAuthority(executionPlan))),
    executionPlan
  };
}

function normalizeExecutionPlan(recipe: Record<string, unknown>): PreviewExecutionPlan {
  assertKeys(recipe, ['version', 'jobs', 'services', 'workers', 'routes'], 'recipe');
  if (recipe.version !== 1) {
    throw new Error('Preview recipe version must be 1.');
  }

  const jobs = normalizeNodeMap(recipe.jobs, 'jobs', normalizeJob);
  const services = normalizeNodeMap(recipe.services, 'services', normalizeService);
  const workers = normalizeNodeMap(recipe.workers, 'workers', normalizeWorker);
  const routes = normalizeNodeMap(recipe.routes, 'routes', normalizeRoute);
  if (jobs.length + services.length + workers.length > MAX_NODES) {
    throw new Error(`Preview recipe exceeds ${MAX_NODES} executable nodes.`);
  }
  const totalPorts = [...services, ...workers].reduce(
    (count, node) => count + Object.keys(node.ports).length,
    0
  );
  if (totalPorts > MAX_TOTAL_PORTS) {
    throw new Error(`Preview recipe exceeds ${MAX_TOTAL_PORTS} allocated ports.`);
  }
  if (services.length === 0) {
    throw new Error('Preview recipe requires at least one service.');
  }
  if (routes.length === 0 || routes.length > MAX_ROUTES) {
    throw new Error(`Preview recipe must contain 1-${MAX_ROUTES} routes.`);
  }
  if (routes.filter((route) => route.primary).length !== 1) {
    throw new Error('Preview recipe requires exactly one primary route.');
  }

  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const allIds = new Set([...jobById.keys(), ...serviceById.keys(), ...workerById.keys()]);
  if (allIds.size !== jobs.length + services.length + workers.length) {
    throw new Error('Preview job, service, and worker identifiers must be unique.');
  }
  for (const job of jobs) {
    for (const [dependencyId, condition] of Object.entries(job.needs)) {
      if (!jobById.has(dependencyId) || condition !== 'succeeded') {
        throw new Error(`Job ${job.id} needs unknown or unsupported job ${dependencyId}.`);
      }
    }
  }
  for (const node of [...services, ...workers]) {
    for (const [dependencyId, condition] of Object.entries(node.needs)) {
      if (
        (condition === 'succeeded' && !jobById.has(dependencyId)) ||
        (condition === 'ready' && !serviceById.has(dependencyId) && !workerById.has(dependencyId))
      ) {
        throw new Error(`${node.id} needs unknown ${condition} node ${dependencyId}.`);
      }
    }
    validateEnvironmentReferences(node, serviceById, routeById);
  }
  for (const route of routes) {
    const service = serviceById.get(route.service);
    if (!service) {
      throw new Error(`Route ${route.id} references unknown service ${route.service}.`);
    }
    if (!service.critical) {
      throw new Error(`Route ${route.id} must reference a critical service.`);
    }
    if (!service.ports[route.port]) {
      throw new Error(`Route ${route.id} references unknown port ${route.port}.`);
    }
  }
  assertAcyclic([...jobs, ...services, ...workers]);

  return { version: 1, jobs, services, workers, routes };
}

function normalizeJob(value: Record<string, unknown>, context: string, id: string): PreviewJobPlan {
  assertKeys(value, ['label', 'cwd', 'command', 'needs'], context);
  return {
    id,
    label: optionalLabel(value.label, context),
    cwd: normalizeCwd(value.cwd, context),
    command: normalizeCommand(value.command, context),
    needs: normalizeNeeds(value.needs, context, ['succeeded']) as Record<string, 'succeeded'>
  };
}

function normalizeService(
  value: Record<string, unknown>,
  context: string,
  id: string
): PreviewServicePlan {
  const common = normalizeLongRunning(value, context, id, true);
  const ready = normalizeProbe(value.ready, `${context}.ready`, common.ports);
  return { ...common, ready };
}

function normalizeWorker(
  value: Record<string, unknown>,
  context: string,
  id: string
): PreviewWorkerPlan {
  const common = normalizeLongRunning(value, context, id, false);
  return {
    ...common,
    ready: value.ready === undefined ? undefined : normalizeProbe(value.ready, `${context}.ready`, common.ports)
  };
}

function normalizeLongRunning(
  value: Record<string, unknown>,
  context: string,
  id: string,
  service: boolean
): Omit<PreviewServicePlan, 'ready'> {
  assertKeys(
    value,
    ['label', 'cwd', 'command', 'needs', 'env', 'ports', 'ready', 'critical', 'restart', 'liveness'],
    context
  );
  const env = optionalRecord(value.env, `${context}.env`);
  if (Object.keys(env).length > MAX_ENV_ENTRIES) {
    throw new Error(`${context}.env has too many entries.`);
  }
  const normalizedEnv: Record<string, PreviewEnvironmentValue> = {};
  for (const key of Object.keys(env).sort()) {
    const envValue = env[key];
    if (!ENV_KEY_PATTERN.test(key)) throw new Error(`${context}.env contains an invalid key.`);
    if (typeof envValue === 'string') {
      if (Buffer.byteLength(envValue) > MAX_ENV_VALUE_BYTES) {
        throw new Error(`${context}.env must contain bounded environment values.`);
      }
      normalizedEnv[key] = envValue;
      continue;
    }
    const reference = requiredRecord(envValue, `${context}.env.${key}`);
    if (reference.type === 'service-origin') {
      assertKeys(reference, ['type', 'service', 'port'], `${context}.env.${key}`);
      if (typeof reference.service !== 'string' || typeof reference.port !== 'string') {
        throw new Error(`${context}.env.${key} has an invalid service-origin reference.`);
      }
      normalizedEnv[key] = { type: 'service-origin', service: reference.service, port: reference.port };
    } else if (reference.type === 'route-origin') {
      assertKeys(reference, ['type', 'route'], `${context}.env.${key}`);
      if (typeof reference.route !== 'string') {
        throw new Error(`${context}.env.${key} has an invalid route-origin reference.`);
      }
      normalizedEnv[key] = { type: 'route-origin', route: reference.route };
    } else {
      throw new Error(`${context}.env.${key} must be a literal or typed origin reference.`);
    }
  }

  const portsValue = optionalRecord(value.ports, `${context}.ports`);
  const ports: PreviewServicePlan['ports'] = {};
  const portEnvironmentKeys = new Set<string>();
  for (const portId of Object.keys(portsValue).sort()) {
    assertId(portId, `${context}.ports`);
    const port = requiredRecord(portsValue[portId], `${context}.ports.${portId}`);
    assertKeys(port, ['env'], `${context}.ports.${portId}`);
    if (typeof port.env !== 'string' || !ENV_KEY_PATTERN.test(port.env)) {
      throw new Error(`${context}.ports.${portId}.env is invalid.`);
    }
    if (normalizedEnv[port.env] !== undefined) {
      throw new Error(`${context}.ports.${portId}.env conflicts with a literal environment value.`);
    }
    if (portEnvironmentKeys.has(port.env)) {
      throw new Error(`${context}.ports.${portId}.env duplicates another generated port environment key.`);
    }
    portEnvironmentKeys.add(port.env);
    ports[portId] = { env: port.env };
  }
  if ((service && Object.keys(ports).length === 0) || Object.keys(ports).length > 16) {
    throw new Error(`${context}.ports must contain ${service ? '1-' : '0-'}16 entries.`);
  }

  return {
    id,
    label: optionalLabel(value.label, context),
    cwd: normalizeCwd(value.cwd, context),
    command: normalizeCommand(value.command, context),
    needs: normalizeNeeds(value.needs, context, ['succeeded', 'ready']),
    env: normalizedEnv,
    ports,
    critical: normalizeBoolean(value.critical, service, `${context}.critical`),
    restart: normalizeRestart(value.restart, `${context}.restart`),
    liveness: normalizeLiveness(value.liveness, `${context}.liveness`, ports)
  };
}

function normalizeProbe(
  value: unknown,
  context: string,
  ports: PreviewServicePlan['ports'],
  defaultTimeoutSeconds = 30
): PreviewReadinessPlan {
  const probe = requiredRecord(value, context);
  const timeoutSeconds = probe.timeoutSeconds ?? defaultTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 300) {
    throw new Error(`${context}.timeoutSeconds must be between 1 and 300.`);
  }
  if (probe.type === 'http') {
    assertKeys(probe, ['type', 'port', 'path', 'timeoutSeconds'], context);
    assertProbePort(probe.port, ports, context);
    if (
      typeof probe.path !== 'string' ||
      !probe.path.startsWith('/') ||
      probe.path.startsWith('//') ||
      /[\r\n]/.test(probe.path)
    ) {
      throw new Error(`${context}.path must be a safe absolute URL path.`);
    }
    return {
      type: 'http',
      port: probe.port as string,
      path: probe.path,
      timeoutSeconds: Number(timeoutSeconds)
    };
  }
  if (probe.type === 'tcp') {
    assertKeys(probe, ['type', 'port', 'timeoutSeconds'], context);
    assertProbePort(probe.port, ports, context);
    return { type: 'tcp', port: probe.port as string, timeoutSeconds: Number(timeoutSeconds) };
  }
  if (probe.type === 'argv') {
    assertKeys(probe, ['type', 'cwd', 'command', 'timeoutSeconds'], context);
    return {
      type: 'argv',
      cwd: normalizeCwd(probe.cwd, context),
      command: normalizeCommand(probe.command, context),
      timeoutSeconds: Number(timeoutSeconds)
    };
  }
  throw new Error(`${context}.type must be http, tcp, or argv.`);
}

function normalizeLiveness(
  value: unknown,
  context: string,
  ports: PreviewServicePlan['ports']
): PreviewLivenessPlan | undefined {
  if (value === undefined) return undefined;
  const live = requiredRecord(value, context);
  const { intervalSeconds = 10, failureThreshold = 3, ...probeValue } = live;
  if (!Number.isInteger(intervalSeconds) || Number(intervalSeconds) < 1 || Number(intervalSeconds) > 300) {
    throw new Error(`${context}.intervalSeconds must be between 1 and 300.`);
  }
  if (!Number.isInteger(failureThreshold) || Number(failureThreshold) < 1 || Number(failureThreshold) > 10) {
    throw new Error(`${context}.failureThreshold must be between 1 and 10.`);
  }
  return {
    probe: normalizeProbe(probeValue, context, ports, 5),
    intervalSeconds: Number(intervalSeconds),
    failureThreshold: Number(failureThreshold)
  };
}

function normalizeRestart(
  value: unknown,
  context: string
): NonNullable<PreviewServicePlan['restart']> {
  if (value === undefined) return { mode: 'never', maxRestarts: 0, backoffMs: 250 };
  const restart = requiredRecord(value, context);
  assertKeys(restart, ['mode', 'maxRestarts', 'backoffMs'], context);
  if (!['never', 'on-failure', 'always'].includes(String(restart.mode))) {
    throw new Error(`${context}.mode must be never, on-failure, or always.`);
  }
  const mode = restart.mode as NonNullable<PreviewServicePlan['restart']>['mode'];
  const maxRestarts = restart.maxRestarts ?? (mode === 'never' ? 0 : 3);
  const backoffMs = restart.backoffMs ?? 250;
  if (!Number.isInteger(maxRestarts) || Number(maxRestarts) < 0 || Number(maxRestarts) > MAX_RESTARTS) {
    throw new Error(`${context}.maxRestarts must be between 0 and ${MAX_RESTARTS}.`);
  }
  if (mode === 'never' && Number(maxRestarts) !== 0) {
    throw new Error(`${context}.maxRestarts must be 0 when restart mode is never.`);
  }
  if (!Number.isInteger(backoffMs) || Number(backoffMs) < 0 || Number(backoffMs) > 30_000) {
    throw new Error(`${context}.backoffMs must be between 0 and 30000.`);
  }
  return { mode, maxRestarts: Number(maxRestarts), backoffMs: Number(backoffMs) };
}

function normalizeBoolean(value: unknown, defaultValue: boolean, context: string): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') throw new Error(`${context} must be a boolean.`);
  return value;
}

function assertProbePort(
  value: unknown,
  ports: PreviewServicePlan['ports'],
  context: string
): asserts value is string {
  if (typeof value !== 'string' || !ports[value]) {
    throw new Error(`${context}.port must name a declared port.`);
  }
}

function validateEnvironmentReferences(
  node: PreviewServicePlan | PreviewWorkerPlan,
  services: Map<string, PreviewServicePlan>,
  routes: Map<string, PreviewRoutePlan>
): void {
  for (const [key, value] of Object.entries(node.env)) {
    if (typeof value === 'string') continue;
    if (value.type === 'service-origin') {
      const service = services.get(value.service);
      if (!service || !service.ports[value.port]) {
        throw new Error(`${node.id}.env.${key} references an unknown service origin.`);
      }
      if (value.service === node.id || node.needs[value.service] !== 'ready') {
        throw new Error(`${node.id}.env.${key} requires an explicit ready dependency on ${value.service}.`);
      }
    } else if (!routes.has(value.route)) {
      throw new Error(`${node.id}.env.${key} references an unknown route origin.`);
    }
  }
}

function normalizeRoute(
  value: Record<string, unknown>,
  context: string,
  id: string
): PreviewRoutePlan {
  assertKeys(value, ['service', 'port', 'primary'], context);
  if (typeof value.service !== 'string' || typeof value.port !== 'string') {
    throw new Error(`${context} must name a service and port.`);
  }
  return {
    id,
    service: value.service,
    port: value.port,
    primary: value.primary === true
  };
}

function normalizeNodeMap<T>(
  value: unknown,
  context: string,
  normalize: (value: Record<string, unknown>, context: string, id: string) => T
): T[] {
  const record = optionalRecord(value, context);
  return Object.keys(record)
    .sort()
    .map((id) => {
      assertId(id, context);
      return normalize(requiredRecord(record[id], `${context}.${id}`), `${context}.${id}`, id);
    });
}

function normalizeNeeds(
  value: unknown,
  context: string,
  conditions: Array<'succeeded' | 'ready'>
): Record<string, 'succeeded' | 'ready'> {
  const needs = optionalRecord(value, `${context}.needs`);
  const normalized: Record<string, 'succeeded' | 'ready'> = {};
  for (const id of Object.keys(needs).sort()) {
    assertId(id, `${context}.needs`);
    const condition = needs[id];
    if (!conditions.includes(condition as 'succeeded' | 'ready')) {
      throw new Error(`${context}.needs.${id} has an unsupported condition.`);
    }
    normalized[id] = condition as 'succeeded' | 'ready';
  }
  return normalized;
}

function normalizeCommand(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_ARGS) {
    throw new Error(`${context}.command must contain 1-${MAX_COMMAND_ARGS} arguments.`);
  }
  return value.map((argument) => {
    if (
      typeof argument !== 'string' ||
      argument.length === 0 ||
      Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES ||
      argument.includes('\0')
    ) {
      throw new Error(`${context}.command contains an invalid argument.`);
    }
    return argument;
  });
}

function normalizeCwd(value: unknown, context: string): string {
  const cwd = value ?? '.';
  if (
    typeof cwd !== 'string' ||
    cwd.includes('\0') ||
    path.posix.isAbsolute(cwd) ||
    path.win32.isAbsolute(cwd) ||
    cwd.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`${context}.cwd must stay within the repository.`);
  }
  const normalized = cwd.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized || '.';
}

function assertAcyclic(nodes: Array<{ id: string; needs: Record<string, unknown> }>): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitNode = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Preview dependency graph contains a cycle at ${id}.`);
    visiting.add(id);
    for (const dependencyId of Object.keys(byId.get(id)?.needs ?? {})) {
      visitNode(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visitNode(id);
}

function executionAuthority(plan: PreviewExecutionPlan): unknown {
  return {
    version: plan.version,
    jobs: plan.jobs.map(({ label: _label, ...job }) => job),
    services: plan.services.map(({ label: _label, ...service }) => service),
    workers: plan.workers.map(({ label: _label, ...worker }) => worker),
    routes: plan.routes
  };
}

function rejectUnsafeYamlNode(node: Node | null): void {
  if (!node) return;
  if (isAlias(node)) throw new Error('YAML aliases are not supported.');
  if ('anchor' in node && node.anchor) throw new Error('YAML anchors are not supported.');
  if ('tag' in node && node.tag && !node.tag.startsWith('tag:yaml.org,2002:')) {
    throw new Error('Custom YAML tags are not supported.');
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === '<<') {
        throw new Error('YAML merge keys are not supported.');
      }
    }
  }
}

function assertStringKeys(node: Node | null): void {
  visit(node, (_key, candidate) => {
    if (!isMap(candidate)) return;
    for (const pair of candidate.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        throw new Error('Preview recipe mapping keys must be strings.');
      }
    }
  });
}

function optionalLabel(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 256) {
    throw new Error(`${context}.label must be a bounded nonempty string.`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertKeys(record: Record<string, unknown>, keys: string[], context: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unknown field ${context}.${key}.`);
  }
}

function assertId(value: string, context: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid identifier ${context}.${value}.`);
}

function optionalRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === undefined) return {};
  return requiredRecord(value, context);
}

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be a mapping.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
