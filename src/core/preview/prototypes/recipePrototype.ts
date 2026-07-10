/** Phase 0 prototype only. This is not the production preview schema. */
import { createHash } from 'node:crypto';
import {
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  visit,
  type Node
} from 'yaml';

const MAX_RECIPE_BYTES = 64 * 1024;
const MAX_NODES = 32;
const MAX_COMMAND_ARGS = 64;
const MAX_ARGUMENT_BYTES = 2048;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

export interface PrototypeRecipeResult {
  recipe: Record<string, unknown>;
  recipeDigest: string;
  executionPlan: Record<string, unknown>;
  executionDigest: string;
}

export function parsePrototypeRecipe(source: string): PrototypeRecipeResult {
  if (Buffer.byteLength(source) > MAX_RECIPE_BYTES) {
    throw new Error(`Preview recipe exceeds ${MAX_RECIPE_BYTES} bytes.`);
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

  visit(document, (_key, node) => {
    rejectUnsafeYamlNode(node as Node | null);
  });
  const value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  if (!isRecord(value)) {
    throw new Error('Preview recipe must be a mapping.');
  }
  assertStringKeys(document.contents);

  const executionPlan = normalizeExecutionPlan(value);
  return {
    recipe: value,
    recipeDigest: sha256(canonicalJson(value)),
    executionPlan,
    executionDigest: sha256(canonicalJson(executionPlan))
  };
}

function normalizeExecutionPlan(recipe: Record<string, unknown>): Record<string, unknown> {
  assertKeys(recipe, ['version', 'jobs', 'services', 'routes'], 'recipe');
  if (recipe.version !== 1) throw new Error('Preview recipe version must be 1.');

  const jobs = normalizeNodeMap(recipe.jobs, 'jobs', normalizeJob);
  const services = normalizeNodeMap(recipe.services, 'services', normalizeService);
  const routes = normalizeNodeMap(recipe.routes, 'routes', normalizeRoute);
  if (Object.keys(jobs).length + Object.keys(services).length > MAX_NODES) {
    throw new Error(`Preview recipe exceeds ${MAX_NODES} executable nodes.`);
  }
  if (Object.keys(services).length === 0) {
    throw new Error('Preview recipe requires at least one service.');
  }
  const primaryRoutes = Object.values(routes).filter(
    (route) => isRecord(route) && route.primary === true
  );
  if (primaryRoutes.length !== 1) {
    throw new Error('Preview recipe requires exactly one primary route.');
  }

  const nodes = new Set([...Object.keys(jobs), ...Object.keys(services)]);
  for (const [serviceId, service] of Object.entries(services)) {
    const needs = service.needs as Record<string, unknown>;
    for (const dependencyId of Object.keys(needs)) {
      if (!nodes.has(dependencyId)) {
        throw new Error(`Service ${serviceId} needs unknown node ${dependencyId}.`);
      }
    }
  }
  for (const [routeId, route] of Object.entries(routes)) {
    const serviceId = String(route.service);
    const service = services[serviceId];
    if (!service) throw new Error(`Route ${routeId} references unknown service ${serviceId}.`);
    const ports = service.ports as Record<string, unknown>;
    if (!ports[String(route.port)]) {
      throw new Error(`Route ${routeId} references unknown port ${String(route.port)}.`);
    }
  }

  return { version: 1, jobs, services, routes };
}

function normalizeJob(value: Record<string, unknown>, context: string): Record<string, unknown> {
  assertKeys(value, ['label', 'cwd', 'command'], context);
  return {
    cwd: normalizeCwd(value.cwd, context),
    command: normalizeCommand(value.command, context)
  };
}

function normalizeService(value: Record<string, unknown>, context: string): Record<string, unknown> {
  assertKeys(value, ['label', 'cwd', 'command', 'needs', 'env', 'ports', 'ready'], context);
  const needs = optionalRecord(value.needs, `${context}.needs`);
  for (const [id, condition] of Object.entries(needs)) {
    assertId(id, `${context}.needs`);
    if (condition !== 'succeeded' && condition !== 'ready') {
      throw new Error(`${context}.needs.${id} must be succeeded or ready.`);
    }
  }
  const env = optionalRecord(value.env, `${context}.env`);
  if (Object.keys(env).length > 64) throw new Error(`${context}.env has too many entries.`);
  for (const [key, envValue] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof envValue !== 'string') {
      throw new Error(`${context}.env must contain string environment values.`);
    }
  }
  const ports = requiredRecord(value.ports, `${context}.ports`);
  for (const [portId, port] of Object.entries(ports)) {
    assertId(portId, `${context}.ports`);
    const portRecord = requiredRecord(port, `${context}.ports.${portId}`);
    assertKeys(portRecord, ['env'], `${context}.ports.${portId}`);
    if (typeof portRecord.env !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(portRecord.env)) {
      throw new Error(`${context}.ports.${portId}.env is invalid.`);
    }
  }
  const ready = requiredRecord(value.ready, `${context}.ready`);
  assertKeys(ready, ['type', 'port', 'path', 'timeoutSeconds'], `${context}.ready`);
  if (ready.type !== 'http') throw new Error(`${context}.ready.type must be http.`);
  if (typeof ready.port !== 'string' || !ports[ready.port]) {
    throw new Error(`${context}.ready.port must name a declared port.`);
  }
  if (typeof ready.path !== 'string' || !ready.path.startsWith('/')) {
    throw new Error(`${context}.ready.path must be an absolute URL path.`);
  }
  const timeoutSeconds = ready.timeoutSeconds ?? 30;
  if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 300) {
    throw new Error(`${context}.ready.timeoutSeconds must be between 1 and 300.`);
  }
  return {
    cwd: normalizeCwd(value.cwd, context),
    command: normalizeCommand(value.command, context),
    needs,
    env,
    ports,
    ready: {
      type: 'http',
      port: ready.port,
      path: ready.path,
      timeoutSeconds
    }
  };
}

function normalizeRoute(value: Record<string, unknown>, context: string): Record<string, unknown> {
  assertKeys(value, ['service', 'port', 'primary'], context);
  if (typeof value.service !== 'string' || typeof value.port !== 'string') {
    throw new Error(`${context} must name a service and port.`);
  }
  return {
    service: value.service,
    port: value.port,
    primary: value.primary === true
  };
}

function normalizeNodeMap(
  value: unknown,
  context: string,
  normalize: (value: Record<string, unknown>, context: string) => Record<string, unknown>
): Record<string, Record<string, unknown>> {
  const record = optionalRecord(value, context);
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const id of Object.keys(record).sort()) {
    assertId(id, context);
    normalized[id] = normalize(requiredRecord(record[id], `${context}.${id}`), `${context}.${id}`);
  }
  return normalized;
}

function normalizeCommand(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_ARGS) {
    throw new Error(`${context}.command must contain 1-${MAX_COMMAND_ARGS} arguments.`);
  }
  return value.map((argument) => {
    if (typeof argument !== 'string' || argument.length === 0 || Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES) {
      throw new Error(`${context}.command contains an invalid argument.`);
    }
    return argument;
  });
}

function normalizeCwd(value: unknown, context: string): string {
  const cwd = value ?? '.';
  if (typeof cwd !== 'string' || cwd.startsWith('/') || cwd.split(/[\\/]/).includes('..')) {
    throw new Error(`${context}.cwd must stay within the repository.`);
  }
  return cwd || '.';
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
    if (isMap(candidate)) {
      for (const pair of candidate.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
          throw new Error('Preview recipe mapping keys must be strings.');
        }
      }
    }
  });
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
