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
  PreviewAttachmentPlan,
  PreviewComposePlan,
  PreviewEnvironmentValue,
  PreviewExecutionPlan,
  PreviewJobPlan,
  PreviewLivenessPlan,
  PreviewOciResourceLimits,
  PreviewOciResourcePlan,
  PreviewPrivateInputPlan,
  PreviewReadinessPlan,
  PreviewRoutePlan,
  PreviewScenarioPlan,
  PreviewServicePlan,
  PreviewWorkerPlan
} from '../../shared/preview';
import { isPathWithin } from './PreviewPaths';
import { canonicalJson, sha256 } from './PreviewCanonicalDigest';
import {
  attachmentPasswordInput,
  previewExecutionDigest
} from './PreviewExecutionAuthority';

export const PREVIEW_RECIPE_PATH = '.taskmonki/preview.yaml' as const;
export const MAX_PREVIEW_RECIPE_BYTES = 64 * 1024;
const MAX_NODES = 32;
const MAX_RESOURCES = 16;
const MAX_ATTACHMENTS = 16;
const MAX_INPUTS = 32;
const MAX_SCENARIOS = 16;
const MAX_COMMAND_ARGS = 64;
const MAX_ARGUMENT_BYTES = 2_048;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_ROUTES = 16;
const MAX_TOTAL_PORTS = 64;
const MAX_RESTARTS = 8;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

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
    executionDigest: previewExecutionDigest(executionPlan),
    executionPlan
  };
}

export function selectPreviewScenario(
  parsed: ParsedPreviewRecipe,
  scenarioId: string
): ParsedPreviewRecipe {
  if (!parsed.executionPlan.scenarios.some((scenario) => scenario.id === scenarioId)) {
    throw new Error(`Preview scenario does not exist: ${scenarioId}.`);
  }
  const executionPlan = { ...parsed.executionPlan, selectedScenarioId: scenarioId };
  return {
    ...parsed,
    executionDigest: previewExecutionDigest(executionPlan),
    executionPlan
  };
}

function normalizeExecutionPlan(recipe: Record<string, unknown>): PreviewExecutionPlan {
  assertKeys(
    recipe,
    [
      'version', 'inputs', 'attachments', 'jobs', 'resources', 'services', 'workers', 'routes',
      'scenarios', 'defaultScenario', 'compose'
    ],
    'recipe'
  );
  if (recipe.version !== 1) {
    throw new Error('Preview recipe version must be 1.');
  }

  const inputs = normalizeNodeMap(recipe.inputs, 'inputs', normalizeInput);
  const attachments = normalizeNodeMap(recipe.attachments, 'attachments', normalizeAttachment);
  const jobs = normalizeNodeMap(recipe.jobs, 'jobs', normalizeJob);
  const resources = normalizeNodeMap(recipe.resources, 'resources', normalizeResource);
  const services = normalizeNodeMap(recipe.services, 'services', normalizeService);
  const workers = normalizeNodeMap(recipe.workers, 'workers', normalizeWorker);
  const routes = normalizeNodeMap(recipe.routes, 'routes', normalizeRoute);
  const compose = recipe.compose === undefined
    ? undefined
    : normalizeComposePlan(requiredRecord(recipe.compose, 'compose'));
  if (compose) {
    if (inputs.length || attachments.length || jobs.length || resources.length || services.length || workers.length) {
      throw new Error('Compose preview recipes cannot mix native nodes, managed resources, attachments, or private inputs.');
    }
    if (routes.length === 0 || routes.length > MAX_ROUTES) {
      throw new Error(`Preview recipe must contain 1-${MAX_ROUTES} routes.`);
    }
    if (routes.filter((route) => route.primary).length !== 1) {
      throw new Error('Preview recipe requires exactly one primary route.');
    }
    const composeServices = new Map(compose.services.map((service) => [service.id, service]));
    for (const route of routes) {
      const service = composeServices.get(route.service);
      if (!service?.ports[route.port]) {
        throw new Error(`Route ${route.id} references an unknown Compose service port.`);
      }
      if (!service.ready) {
        throw new Error(`Routed Compose service ${service.id} requires an explicit bounded readiness check.`);
      }
    }
    return {
      version: 1,
      adapter: 'COMPOSE',
      compose,
      inputs: [],
      attachments: [],
      jobs: [],
      resources: [],
      services: [],
      workers: [],
      routes,
      scenarios: [{ id: 'default', jobs: [], resources: [] }],
      selectedScenarioId: 'default'
    };
  }
  if (jobs.length + services.length + workers.length + resources.length > MAX_NODES) {
    throw new Error(`Preview recipe exceeds ${MAX_NODES} executable nodes.`);
  }
  if (resources.length > MAX_RESOURCES) {
    throw new Error(`Preview recipe exceeds ${MAX_RESOURCES} OCI resources.`);
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`Preview recipe exceeds ${MAX_ATTACHMENTS} attached dependencies.`);
  }
  if (inputs.length > MAX_INPUTS) {
    throw new Error(`Preview recipe exceeds ${MAX_INPUTS} private inputs.`);
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
  const inputById = new Map(inputs.map((input) => [input.id, input]));
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const allIds = new Set([
    ...jobById.keys(),
    ...resourceById.keys(),
    ...serviceById.keys(),
    ...workerById.keys(),
    ...attachmentById.keys()
  ]);
  if (allIds.size !== jobs.length + resources.length + services.length + workers.length + attachments.length) {
    throw new Error('Preview job, resource, attachment, service, and worker identifiers must be unique.');
  }
  for (const job of jobs) {
    for (const [dependencyId, condition] of Object.entries(job.needs)) {
      if (
        (condition === 'succeeded' && !jobById.has(dependencyId)) ||
        (condition === 'ready' && !resourceById.has(dependencyId) && !attachmentById.has(dependencyId))
      ) {
        throw new Error(`Job ${job.id} needs an unknown or unsupported ${condition} node ${dependencyId}.`);
      }
    }
    if (
      job.role !== 'generic' &&
      (Object.keys(job.needs).some((id) => attachmentById.has(id)) ||
        environmentAttachmentIds(job.env).length > 0)
    ) {
      throw new Error(`${job.id} cannot use attached dependencies from a migration or seed job.`);
    }
    validateEnvironmentReferences(job, serviceById, routeById, resourceById, attachmentById, inputById);
  }
  for (const node of [...services, ...workers]) {
    for (const [dependencyId, condition] of Object.entries(node.needs)) {
      if (
        (condition === 'succeeded' && !jobById.has(dependencyId)) ||
        (condition === 'ready' &&
          !serviceById.has(dependencyId) &&
          !workerById.has(dependencyId) &&
          !resourceById.has(dependencyId) &&
          !attachmentById.has(dependencyId))
      ) {
        throw new Error(`${node.id} needs unknown ${condition} node ${dependencyId}.`);
      }
    }
    validateEnvironmentReferences(node, serviceById, routeById, resourceById, attachmentById, inputById);
    validateProbeEnvironmentReferences(node, serviceById, routeById, resourceById, attachmentById, inputById);
  }
  for (const service of services) {
    for (const dependencyId of Object.keys(service.needs)) {
      if (workerById.has(dependencyId)) {
        throw new Error(`Service ${service.id} cannot depend on worker ${dependencyId}; routed readiness must precede exclusive handoff.`);
      }
    }
  }
  for (const worker of workers.filter((candidate) => candidate.overlap === 'safe')) {
    for (const dependencyId of Object.keys(worker.needs)) {
      if (workerById.get(dependencyId)?.overlap === 'exclusive') {
        throw new Error(`Safe-overlap worker ${worker.id} cannot depend on exclusive worker ${dependencyId}.`);
      }
    }
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
  const scenarios = normalizeScenarios(recipe.scenarios, jobs, resources);
  const selectedScenarioId = normalizeSelectedScenario(
    recipe.defaultScenario,
    scenarios,
    recipe.scenarios !== undefined
  );
  validateScenarioGraph(selectedScenarioId, scenarios, jobs, resources, services, workers);
  validateAttachmentAndInputUsage(inputs, attachments, jobs, services, workers);
  assertAcyclic([
    ...jobs,
    ...resources.map((resource) => ({ id: resource.id, needs: {} })),
    ...attachments.map((attachment) => ({ id: attachment.id, needs: {} })),
    ...services,
    ...workers
  ]);

  return {
    version: 1,
    adapter: 'NATIVE',
    inputs,
    attachments,
    jobs,
    resources,
    services,
    workers,
    routes,
    scenarios,
    selectedScenarioId
  };
}

function normalizeComposePlan(value: Record<string, unknown>): PreviewComposePlan {
  assertKeys(value, ['files', 'projectDirectory', 'profiles', 'rootServices', 'services'], 'compose');
  const files = normalizeSafeRelativePaths(value.files, 'compose.files', 4);
  if (files.length === 0) throw new Error('compose.files must name at least one Compose file.');
  const projectDirectory = normalizeCwd(value.projectDirectory, 'compose.projectDirectory');
  const profiles = normalizeStringList(value.profiles, 'compose.profiles', 16, 128);
  const rootServices = normalizeStringList(value.rootServices, 'compose.rootServices', 64, 128);
  if (rootServices.length === 0) throw new Error('compose.rootServices must name at least one service.');
  const serviceValues = requiredRecord(value.services, 'compose.services');
  const services = Object.keys(serviceValues).sort().map((id) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) {
      throw new Error('compose.services contains an invalid Compose service name.');
    }
    const context = `compose.services.${id}`;
    const service = requiredRecord(serviceValues[id], context);
    assertKeys(service, ['ports', 'ready'], context);
    const portValues = requiredRecord(service.ports, `${context}.ports`);
    if (Object.keys(portValues).length === 0 || Object.keys(portValues).length > MAX_TOTAL_PORTS) {
      throw new Error(`${context}.ports must contain a bounded nonempty port map.`);
    }
    const ports: PreviewComposePlan['services'][number]['ports'] = {};
    for (const name of Object.keys(portValues).sort()) {
      assertId(name, `${context}.ports`);
      const port = requiredRecord(portValues[name], `${context}.ports.${name}`);
      assertKeys(port, ['target', 'protocol'], `${context}.ports.${name}`);
      const target = port.target;
      if (!Number.isInteger(target) || Number(target) < 1 || Number(target) > 65_535) {
        throw new Error(`${context}.ports.${name}.target must be between 1 and 65535.`);
      }
      if (port.protocol !== undefined && port.protocol !== 'tcp') {
        throw new Error(`${context}.ports.${name}.protocol must be tcp.`);
      }
      ports[name] = { target: Number(target), protocol: 'tcp' };
    }
    const ready = normalizeProbe(service.ready, `${context}.ready`, ports, 30);
    if (ready.type === 'argv') throw new Error(`${context}.ready must be http or tcp for Compose.`);
    return { id, ports, ready };
  });
  if (services.length === 0 || services.length > 64) {
    throw new Error('compose.services must contain 1-64 exposed services.');
  }
  const serviceIds = new Set(services.map((service) => service.id));
  for (const id of rootServices) {
    if (!serviceIds.has(id)) throw new Error(`compose.rootServices names undeclared service ${id}.`);
  }
  return { files, projectDirectory, profiles, rootServices, services };
}

function normalizeSafeRelativePaths(value: unknown, context: string, limit: number): string[] {
  const values = normalizeStringList(value, context, limit, 512);
  return values.map((candidate) => {
    const normalized = normalizeCwd(candidate, context);
    if (normalized === '.') throw new Error(`${context} entries must name files.`);
    return normalized;
  });
}

function normalizeStringList(
  value: unknown,
  context: string,
  limit: number,
  maxBytes: number
): string[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${context} must be a list with at most ${limit} entries.`);
  }
  const result = value.map((candidate) => {
    if (
      typeof candidate !== 'string' || !candidate || candidate.includes('\0') ||
      /[\r\n]/.test(candidate) || Buffer.byteLength(candidate) > maxBytes
    ) throw new Error(`${context} contains an invalid entry.`);
    return candidate;
  });
  if (new Set(result).size !== result.length) throw new Error(`${context} contains duplicates.`);
  return result;
}

function normalizeInput(
  value: Record<string, unknown>,
  context: string,
  id: string
): PreviewPrivateInputPlan {
  assertKeys(value, ['type', 'label'], context);
  if (value.type !== 'private') throw new Error(`${context}.type must be private.`);
  return { id, type: 'private', label: optionalLabel(value.label, context) };
}

function normalizeAttachment(
  value: Record<string, unknown>,
  context: string,
  id: string
): PreviewAttachmentPlan {
  const type = value.type;
  if (!['http', 'tcp', 'postgres', 'redis'].includes(String(type))) {
    throw new Error(`${context}.type must be http, tcp, postgres, or redis.`);
  }
  const base = {
    id,
    label: optionalLabel(value.label, context),
    check: normalizeAttachmentCheck(value.check, `${context}.check`, type as PreviewAttachmentPlan['type'])
  };
  const target = normalizeAttachmentTarget(
    value.target,
    `${context}.target`,
    type as PreviewAttachmentPlan['type']
  );
  if (type === 'http' || type === 'tcp') {
    assertKeys(value, ['type', 'label', 'target', 'check'], context);
    return { ...base, type, target } as PreviewAttachmentPlan;
  }
  assertKeys(value, ['type', 'label', 'target', 'credentials', 'check'], context);
  const credentials = optionalRecord(value.credentials, `${context}.credentials`);
  assertKeys(credentials, ['passwordInput'], `${context}.credentials`);
  const passwordInput = credentials.passwordInput;
  if (passwordInput !== undefined) {
    if (typeof passwordInput !== 'string') {
      throw new Error(`${context}.credentials.passwordInput must name a private input.`);
    }
    assertId(passwordInput, `${context}.credentials.passwordInput`);
  }
  return { ...base, type, target, passwordInput } as PreviewAttachmentPlan;
}

function normalizeAttachmentCheck(
  value: unknown,
  context: string,
  type: PreviewAttachmentPlan['type']
): PreviewAttachmentPlan['check'] {
  if (value === undefined) return undefined;
  const check = requiredRecord(value, context);
  assertKeys(check, type === 'http' ? ['path', 'timeoutSeconds'] : ['timeoutSeconds'], context);
  const timeoutSeconds = check.timeoutSeconds ?? 10;
  if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 60) {
    throw new Error(`${context}.timeoutSeconds must be between 1 and 60.`);
  }
  if (type !== 'http') return { timeoutSeconds: Number(timeoutSeconds) };
  const pathValue = check.path ?? '/';
  return { timeoutSeconds: Number(timeoutSeconds), path: normalizeHttpPath(pathValue, `${context}.path`) };
}

function normalizeAttachmentTarget(
  value: unknown,
  context: string,
  type: PreviewAttachmentPlan['type']
): PreviewAttachmentPlan['target'] {
  const target = requiredRecord(value, context);
  if (target.type === 'local') {
    assertKeys(target, ['type'], context);
    return { type: 'local' };
  }
  if (target.type !== 'endpoint') throw new Error(`${context}.type must be endpoint or local.`);
  const host = normalizeAttachmentHost(target.host, `${context}.host`);
  if (type === 'http') {
    assertKeys(target, ['type', 'scheme', 'host', 'port', 'basePath'], context);
    const scheme = target.scheme ?? 'http';
    if (scheme !== 'http' && scheme !== 'https') throw new Error(`${context}.scheme must be http or https.`);
    return {
      type: 'endpoint', scheme, host,
      port: target.port === undefined
        ? (scheme === 'https' ? 443 : 80)
        : normalizeAttachmentPort(target.port, `${context}.port`),
      basePath: normalizeHttpPath(target.basePath ?? '/', `${context}.basePath`)
    };
  }
  if (type === 'tcp') {
    assertKeys(target, ['type', 'host', 'port'], context);
    return { type: 'endpoint', host, port: normalizeAttachmentPort(target.port, `${context}.port`) };
  }
  if (type === 'postgres') {
    assertKeys(target, ['type', 'host', 'port', 'database', 'username', 'tls'], context);
    const database = normalizePublicConnectionPart(target.database, `${context}.database`);
    const username = normalizePublicConnectionPart(target.username, `${context}.username`);
    return {
      type: 'endpoint', host, port: normalizeAttachmentPort(target.port, `${context}.port`), database, username,
      tls: normalizeTls(target.tls, `${context}.tls`)
    };
  }
  assertKeys(target, ['type', 'host', 'port', 'database', 'username', 'tls'], context);
  const database = target.database ?? 0;
  if (!Number.isInteger(database) || Number(database) < 0 || Number(database) > 65_535) {
    throw new Error(`${context}.database must be between 0 and 65535.`);
  }
  const username = target.username === undefined
    ? undefined
    : normalizePublicConnectionPart(target.username, `${context}.username`);
  return {
    type: 'endpoint', host, port: normalizeAttachmentPort(target.port, `${context}.port`), database: Number(database), username,
    tls: normalizeTls(target.tls, `${context}.tls`)
  };
}

function normalizeAttachmentHost(value: unknown, context: string): string {
  if (
    typeof value !== 'string' || !value || Buffer.byteLength(value) > 253 ||
    /[\s\0\r\n/@?#]/.test(value) || value.startsWith('-')
  ) throw new Error(`${context} must be a bounded credential-free hostname or IP address.`);
  return value.toLowerCase();
}

function normalizeAttachmentPort(value: unknown, context: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`${context} must be between 1 and 65535.`);
  }
  return Number(value);
}

function normalizeHttpPath(value: unknown, context: string): string {
  if (
    typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
    /[\0\r\n?#]/.test(value) || Buffer.byteLength(value) > 2_048
  ) throw new Error(`${context} must be a safe absolute path without query or fragment.`);
  return value;
}

function normalizePublicConnectionPart(value: unknown, context: string): string {
  if (
    typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 ||
    /[\0\r\n]/.test(value)
  ) throw new Error(`${context} must be a bounded public value.`);
  return value;
}

function normalizeTls(value: unknown, context: string): 'disabled' | 'system-verified' {
  const tls = value ?? 'disabled';
  if (tls !== 'disabled' && tls !== 'system-verified') {
    throw new Error(`${context} must be disabled or system-verified.`);
  }
  return tls;
}

function normalizeJob(value: Record<string, unknown>, context: string, id: string): PreviewJobPlan {
  assertKeys(value, ['label', 'cwd', 'command', 'needs', 'env', 'role', 'retrySafe'], context);
  const role = value.role ?? 'generic';
  if (!['generic', 'migration', 'seed'].includes(String(role))) {
    throw new Error(`${context}.role must be generic, migration, or seed.`);
  }
  if (role !== 'generic' && typeof value.retrySafe !== 'boolean') {
    throw new Error(`${context}.retrySafe must be declared for migration and seed jobs.`);
  }
  return {
    id,
    label: optionalLabel(value.label, context),
    cwd: normalizeCwd(value.cwd, context),
    command: normalizeCommand(value.command, context),
    role: role as PreviewJobPlan['role'],
    retrySafe: value.retrySafe === true,
    needs: normalizeNeeds(value.needs, context, ['succeeded', 'ready']),
    env: normalizeEnvironment(value.env, `${context}.env`)
  };
}

function normalizeEnvironment(value: unknown, context: string): Record<string, PreviewEnvironmentValue> {
  const env = optionalRecord(value, context);
  if (Object.keys(env).length > MAX_ENV_ENTRIES) {
    throw new Error(`${context} has too many entries.`);
  }
  const normalized: Record<string, PreviewEnvironmentValue> = {};
  for (const key of Object.keys(env).sort()) {
    const envValue = env[key];
    if (!ENV_KEY_PATTERN.test(key)) throw new Error(`${context} contains an invalid key.`);
    if (typeof envValue === 'string') {
      if (Buffer.byteLength(envValue) > MAX_ENV_VALUE_BYTES) {
        throw new Error(`${context} must contain bounded environment values.`);
      }
      normalized[key] = envValue;
      continue;
    }
    const reference = requiredRecord(envValue, `${context}.${key}`);
    if (reference.type === 'service-origin') {
      assertKeys(reference, ['type', 'service', 'port'], `${context}.${key}`);
      if (typeof reference.service !== 'string' || typeof reference.port !== 'string') {
        throw new Error(`${context}.${key} has an invalid service-origin reference.`);
      }
      normalized[key] = { type: 'service-origin', service: reference.service, port: reference.port };
    } else if (reference.type === 'route-origin') {
      assertKeys(reference, ['type', 'route'], `${context}.${key}`);
      if (typeof reference.route !== 'string') {
        throw new Error(`${context}.${key} has an invalid route-origin reference.`);
      }
      normalized[key] = { type: 'route-origin', route: reference.route };
    } else if (reference.type === 'private-input') {
      assertKeys(reference, ['type', 'input'], `${context}.${key}`);
      if (typeof reference.input !== 'string') {
        throw new Error(`${context}.${key} has an invalid private-input reference.`);
      }
      normalized[key] = { type: 'private-input', input: reference.input };
    } else if (reference.type === 'postgres-url' || reference.type === 'redis-url') {
      assertKeys(reference, ['type', 'resource'], `${context}.${key}`);
      if (typeof reference.resource !== 'string') {
        throw new Error(`${context}.${key} has an invalid ${reference.type} reference.`);
      }
      normalized[key] = { type: reference.type, resource: reference.resource };
    } else if (
      reference.type === 'attached-http-origin' ||
      reference.type === 'attached-tcp-host' ||
      reference.type === 'attached-tcp-port' ||
      reference.type === 'attached-postgres-url' ||
      reference.type === 'attached-redis-url'
    ) {
      assertKeys(reference, ['type', 'attachment'], `${context}.${key}`);
      if (typeof reference.attachment !== 'string') {
        throw new Error(`${context}.${key} has an invalid ${reference.type} reference.`);
      }
      normalized[key] = { type: reference.type, attachment: reference.attachment };
    } else {
      throw new Error(`${context}.${key} must be a literal or supported typed reference.`);
    }
  }
  return normalized;
}

function normalizeResource(
  value: Record<string, unknown>,
  context: string,
  id: string
): PreviewOciResourcePlan {
  const type = value.type;
  if (!['postgres', 'redis'].includes(String(type))) {
    throw new Error(`${context}.type must be postgres or redis in this phase.`);
  }
  const common = {
    id,
    label: optionalLabel(value.label, context),
    image: normalizeImage(value.image, type as PreviewOciResourcePlan['type'], context),
    limits: normalizeResourceLimits(value.limits, context)
  };
  if (type === 'postgres') {
    assertKeys(value, ['type', 'label', 'image', 'limits', 'database'], context);
    const database = value.database ?? 'app';
    if (typeof database !== 'string' || !DATABASE_NAME_PATTERN.test(database)) {
      throw new Error(`${context}.database must be a safe PostgreSQL database identifier.`);
    }
    return { ...common, type: 'postgres', database };
  }
  if (type === 'redis') {
    assertKeys(value, ['type', 'label', 'image', 'limits'], context);
    return { ...common, type: 'redis' };
  }
  throw new Error(`${context}.type is unsupported.`);
}

function normalizeImage(
  value: unknown,
  type: PreviewOciResourcePlan['type'],
  context: string
): string {
  const supported = type === 'postgres' ? 'postgres:17-alpine' : 'redis:7-alpine';
  const image = value ?? supported;
  if (
    typeof image !== 'string' ||
    !image ||
    Buffer.byteLength(image) > 512 ||
    /[\s\0]/.test(image) ||
    image.startsWith('-')
  ) {
    throw new Error(`${context}.image must be a bounded OCI image reference.`);
  }
  if (image !== supported) {
    throw new Error(`${context}.image must be the supported ${supported} image.`);
  }
  return image;
}

function normalizeResourceLimits(value: unknown, context: string): PreviewOciResourceLimits {
  const limits = optionalRecord(value, `${context}.limits`);
  assertKeys(limits, ['cpus', 'memoryMb', 'diskMb', 'pids'], `${context}.limits`);
  const normalized: PreviewOciResourceLimits = {};
  if (limits.cpus !== undefined) {
    if (typeof limits.cpus !== 'number' || !Number.isFinite(limits.cpus) || limits.cpus < 0.1 || limits.cpus > 16) {
      throw new Error(`${context}.limits.cpus must be between 0.1 and 16.`);
    }
    normalized.cpus = limits.cpus;
  }
  for (const [key, minimum, maximum] of [
    ['memoryMb', 64, 65_536],
    ['diskMb', 64, 1_048_576],
    ['pids', 16, 32_768]
  ] as const) {
    const candidate = limits[key];
    if (candidate === undefined) continue;
    if (!Number.isInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) {
      throw new Error(`${context}.limits.${key} must be between ${minimum} and ${maximum}.`);
    }
    normalized[key] = Number(candidate);
  }
  return normalized;
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
    ready: normalizeProbe(value.ready, `${context}.ready`, common.ports),
    overlap: normalizeOverlap(value.overlap, `${context}.overlap`)
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
    [
      'label', 'cwd', 'command', 'needs', 'env', 'ports', 'ready', 'critical', 'restart', 'liveness',
      ...(service ? [] : ['overlap'])
    ],
    context
  );
  const normalizedEnv = normalizeEnvironment(value.env, `${context}.env`);

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

function normalizeOverlap(value: unknown, context: string): 'exclusive' | 'safe' {
  if (value === undefined) return 'exclusive';
  if (value !== 'safe') throw new Error(`${context} must be safe when declared.`);
  return 'safe';
}

function normalizeProbe(
  value: unknown,
  context: string,
  ports: Record<string, unknown>,
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
    assertKeys(probe, ['type', 'cwd', 'command', 'timeoutSeconds', 'env'], context);
    return {
      type: 'argv',
      cwd: normalizeCwd(probe.cwd, context),
      command: normalizeCommand(probe.command, context),
      timeoutSeconds: Number(timeoutSeconds),
      env: normalizeEnvironment(probe.env, `${context}.env`)
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
  ports: Record<string, unknown>,
  context: string
): asserts value is string {
  if (typeof value !== 'string' || !ports[value]) {
    throw new Error(`${context}.port must name a declared port.`);
  }
}

function validateEnvironmentReferences(
  node: PreviewJobPlan | PreviewServicePlan | PreviewWorkerPlan,
  services: Map<string, PreviewServicePlan>,
  routes: Map<string, PreviewRoutePlan>,
  resources: Map<string, PreviewOciResourcePlan>,
  attachments: Map<string, PreviewAttachmentPlan>,
  inputs: Map<string, PreviewPrivateInputPlan>,
  environment = node.env
): void {
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string') continue;
    if (value.type === 'service-origin') {
      const service = services.get(value.service);
      if (!service || !service.ports[value.port]) {
        throw new Error(`${node.id}.env.${key} references an unknown service origin.`);
      }
      if (value.service === node.id || node.needs[value.service] !== 'ready') {
        throw new Error(`${node.id}.env.${key} requires an explicit ready dependency on ${value.service}.`);
      }
    } else if (value.type === 'route-origin') {
      if (!routes.has(value.route)) {
        throw new Error(`${node.id}.env.${key} references an unknown route origin.`);
      }
    } else if (value.type === 'private-input') {
      if (!inputs.has(value.input)) {
        throw new Error(`${node.id}.env.${key} references an unknown private input.`);
      }
    } else if (value.type === 'postgres-url' || value.type === 'redis-url') {
      const resource = resources.get(value.resource);
      if (!resource) {
        throw new Error(`${node.id}.env.${key} references an unknown OCI resource.`);
      }
      if (node.needs[value.resource] !== 'ready') {
        throw new Error(`${node.id}.env.${key} requires an explicit ready dependency on ${value.resource}.`);
      }
      if (value.type === 'postgres-url' && resource.type !== 'postgres') {
        throw new Error(`${node.id}.env.${key} requires a PostgreSQL resource.`);
      }
      if (value.type === 'redis-url' && resource.type !== 'redis') {
        throw new Error(`${node.id}.env.${key} requires a Redis resource.`);
      }
    } else {
      const attachment = attachments.get(value.attachment);
      if (!attachment) {
        throw new Error(`${node.id}.env.${key} references an unknown attachment.`);
      }
      const expected =
        value.type === 'attached-http-origin' ? 'http' :
        value.type === 'attached-tcp-host' || value.type === 'attached-tcp-port' ? 'tcp' :
        value.type === 'attached-postgres-url' ? 'postgres' : 'redis';
      if (attachment.type !== expected) {
        throw new Error(`${node.id}.env.${key} requires a ${expected} attachment.`);
      }
    }
  }
}

function validateProbeEnvironmentReferences(
  node: PreviewServicePlan | PreviewWorkerPlan,
  services: Map<string, PreviewServicePlan>,
  routes: Map<string, PreviewRoutePlan>,
  resources: Map<string, PreviewOciResourcePlan>,
  attachments: Map<string, PreviewAttachmentPlan>,
  inputs: Map<string, PreviewPrivateInputPlan>
): void {
  for (const probe of [node.ready, node.liveness?.probe]) {
    if (probe?.type !== 'argv') continue;
    validateEnvironmentReferences(
      node, services, routes, resources, attachments, inputs, probe.env ?? {}
    );
  }
}

function validateAttachmentAndInputUsage(
  inputs: PreviewPrivateInputPlan[],
  attachments: PreviewAttachmentPlan[],
  jobs: PreviewJobPlan[],
  services: PreviewServicePlan[],
  workers: PreviewWorkerPlan[]
): void {
  const nodes = [...jobs, ...services, ...workers];
  const usedInputs = new Set<string>();
  const usedAttachments = new Set<string>();
  const checkedAttachments = new Set<string>();
  for (const attachment of attachments) {
    const passwordInput = attachmentPasswordInput(attachment);
    if (passwordInput) usedInputs.add(passwordInput);
  }
  for (const node of nodes) {
    for (const id of Object.keys(node.needs)) {
      if (attachments.some((attachment) => attachment.id === id)) {
        usedAttachments.add(id);
        checkedAttachments.add(id);
        if (!attachments.find((attachment) => attachment.id === id)?.check) {
          throw new Error(`${node.id} needs attachment ${id} ready, but it declares no check.`);
        }
      }
    }
    for (const env of [node.env, ...('ready' in node ? [
      node.ready.type === 'argv' ? node.ready.env ?? {} : {},
      node.liveness?.probe.type === 'argv' ? node.liveness.probe.env ?? {} : {}
    ] : [])]) {
      for (const value of Object.values(env)) {
        if (typeof value === 'string') continue;
        if (value.type === 'private-input') usedInputs.add(value.input);
        if ('attachment' in value) usedAttachments.add(value.attachment);
      }
    }
  }
  for (const attachment of attachments) {
    const passwordInput = attachmentPasswordInput(attachment);
    if (passwordInput && !inputs.some((input) => input.id === passwordInput)) {
      throw new Error(`Attachment ${attachment.id} references unknown private input ${passwordInput}.`);
    }
    if (!usedAttachments.has(attachment.id)) {
      throw new Error(`Attachment ${attachment.id} must have a declared recipient or readiness dependency.`);
    }
    if (attachment.check && !checkedAttachments.has(attachment.id)) {
      throw new Error(`Attachment ${attachment.id} declares an unused readiness check.`);
    }
  }
  for (const input of inputs) {
    if (!usedInputs.has(input.id)) throw new Error(`Private input ${input.id} has no declared recipient.`);
  }
}

function environmentAttachmentIds(environment: Record<string, PreviewEnvironmentValue>): string[] {
  return Object.values(environment).flatMap((value) =>
    typeof value !== 'string' && 'attachment' in value ? [value.attachment] : []
  );
}

function normalizeScenarios(
  value: unknown,
  jobs: PreviewJobPlan[],
  resources: PreviewOciResourcePlan[]
): PreviewScenarioPlan[] {
  if (value === undefined) {
    return [{
      id: 'default',
      jobs: jobs.filter((job) => job.role !== 'generic').map((job) => job.id),
      resources: resources.map((resource) => resource.id)
    }];
  }
  const scenarios = normalizeNodeMap(value, 'scenarios', (scenario, context, id) => {
    assertKeys(scenario, ['label', 'jobs', 'resources'], context);
    return {
      id,
      label: optionalLabel(scenario.label, context),
      jobs: normalizeIdList(scenario.jobs, `${context}.jobs`),
      resources: normalizeIdList(scenario.resources, `${context}.resources`)
    };
  });
  if (scenarios.length < 1 || scenarios.length > MAX_SCENARIOS) {
    throw new Error(`Preview recipe must contain 1-${MAX_SCENARIOS} scenarios.`);
  }
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const resourceIds = new Set(resources.map((resource) => resource.id));
  for (const scenario of scenarios) {
    for (const jobId of scenario.jobs) {
      const job = jobById.get(jobId);
      if (!job || job.role === 'generic') {
        throw new Error(`Scenario ${scenario.id} may select only declared migration or seed jobs.`);
      }
    }
    for (const resourceId of scenario.resources) {
      if (!resourceIds.has(resourceId)) {
        throw new Error(`Scenario ${scenario.id} references unknown resource ${resourceId}.`);
      }
    }
  }
  const selectedJobs = new Set(scenarios.flatMap((scenario) => scenario.jobs));
  for (const job of jobs) {
    if (job.role !== 'generic' && !selectedJobs.has(job.id)) {
      throw new Error(`Job ${job.id} must belong to at least one scenario.`);
    }
  }
  return scenarios;
}

function normalizeSelectedScenario(
  value: unknown,
  scenarios: PreviewScenarioPlan[],
  explicitScenarios: boolean
): string {
  if (value === undefined) {
    if (explicitScenarios && scenarios.length > 1) {
      throw new Error('Preview recipe with multiple scenarios requires defaultScenario.');
    }
    return scenarios[0].id;
  }
  if (typeof value !== 'string' || !scenarios.some((scenario) => scenario.id === value)) {
    throw new Error('Preview recipe defaultScenario must name a declared scenario.');
  }
  return value;
}

function validateScenarioGraph(
  _selectedScenarioId: string,
  scenarios: PreviewScenarioPlan[],
  jobs: PreviewJobPlan[],
  resources: PreviewOciResourcePlan[],
  services: PreviewServicePlan[],
  workers: PreviewWorkerPlan[]
): void {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const resourceIds = new Set(resources.map((resource) => resource.id));
  for (const scenario of scenarios) {
    const activeJobs = new Set([
      ...jobs.filter((job) => job.role === 'generic').map((job) => job.id),
      ...scenario.jobs
    ]);
    const activeResources = new Set(scenario.resources);
    for (const jobId of activeJobs) {
      const job = jobById.get(jobId)!;
      for (const [dependencyId, condition] of Object.entries(job.needs)) {
        if (condition === 'succeeded' && !activeJobs.has(dependencyId)) {
          throw new Error(`Scenario ${scenario.id} omits job dependency ${dependencyId} required by ${job.id}.`);
        }
        if (condition === 'ready' && !activeResources.has(dependencyId)) {
          throw new Error(`Scenario ${scenario.id} omits resource ${dependencyId} required by ${job.id}.`);
        }
      }
      if (
        job.role === 'seed' &&
        !Object.entries(job.needs).some(
          ([dependencyId, condition]) =>
            condition === 'succeeded' && jobById.get(dependencyId)?.role === 'migration'
        )
      ) {
        throw new Error(`Seed job ${job.id} must depend on a migration job succeeding.`);
      }
    }
    for (const node of [...services, ...workers]) {
      for (const [dependencyId, condition] of Object.entries(node.needs)) {
        if (condition === 'succeeded' && !activeJobs.has(dependencyId)) {
          throw new Error(`Scenario ${scenario.id} omits job ${dependencyId} required by ${node.id}.`);
        }
        if (condition === 'ready' && resourceIds.has(dependencyId) && !activeResources.has(dependencyId)) {
          throw new Error(`Scenario ${scenario.id} omits resource ${dependencyId} required by ${node.id}.`);
        }
      }
    }
  }
}

function normalizeIdList(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NODES) {
    throw new Error(`${context} must be a bounded list of identifiers.`);
  }
  const ids = value.map((candidate) => {
    if (typeof candidate !== 'string') throw new Error(`${context} must contain identifiers.`);
    assertId(candidate, context);
    return candidate;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${context} contains duplicate identifiers.`);
  return ids.sort();
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
