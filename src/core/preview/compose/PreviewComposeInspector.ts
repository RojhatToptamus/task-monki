import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAlias, parseDocument, visit, type Node } from 'yaml';
import type {
  PreviewComposeHostInput,
  PreviewComposeInspection,
  PreviewComposePlan,
  PreviewComposeServiceInspection
} from '../../../shared/contracts';
import { isPathWithin } from '../PreviewPaths';
import { PreviewComposeCliAdapter, type PreviewComposeCommand } from './PreviewComposeCliAdapter';

const MAX_COMPOSE_FILE_BYTES = 1024 * 1024;
const MAX_HOST_INPUT_BYTES = 64 * 1024;
const MAX_SERVICES = 64;
const MAX_ENVIRONMENT_KEYS = 256;

export class PreviewComposeInspector {
  constructor(
    private readonly cli: PreviewComposeCliAdapter,
    private readonly controlledRoot: string
  ) {}

  async inspect(input: {
    sourceRoot: string;
    contextName: string;
    projectName: string;
    plan: PreviewComposePlan;
  }): Promise<PreviewComposeInspection> {
    const sourceRoot = await fs.realpath(path.resolve(input.sourceRoot));
    const projectDirectory = await resolveContainedDirectory(sourceRoot, input.plan.projectDirectory);
    await fs.mkdir(this.controlledRoot, { recursive: true, mode: 0o700 });
    const envFile = path.join(this.controlledRoot, 'empty-compose.env');
    await ensureEmptyPrivateFile(envFile);
    const files = await Promise.all(input.plan.files.map((file) =>
      resolveContainedFile(sourceRoot, path.resolve(projectDirectory, file), MAX_COMPOSE_FILE_BYTES)
    ));
    const composeFileIdentities = await Promise.all(files.map(readFileIdentity));
    const hostInputs: PreviewComposeHostInput[] = files.map((file) => ({
      kind: 'COMPOSE_FILE',
      path: relativePath(sourceRoot, file)
    }));
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      const scanned = scanComposeSource(source, relativePath(sourceRoot, file));
      for (const reference of scanned.hostInputs) {
        const absolute = path.resolve(projectDirectory, reference.path);
        if (reference.kind === 'BUILD_CONTEXT') {
          await resolveContainedDirectory(sourceRoot, relativePath(sourceRoot, absolute));
        } else {
          await resolveContainedFile(sourceRoot, absolute, MAX_HOST_INPUT_BYTES);
        }
        hostInputs.push({ ...reference, path: relativePath(sourceRoot, absolute) });
      }
    }
    const dedupedHostInputs = dedupeHostInputs(hostInputs);
    if (dedupedHostInputs.length > 64) throw new Error('Compose configuration reads too many repository files.');

    const capability = await this.cli.probe(input.contextName);
    if (!capability.supportsNoEnvResolution) {
      throw new Error(
        `Docker Compose ${capability.version} is unsupported because config --no-env-resolution is unavailable.`
      );
    }
    if (capability.supportsRuntimeFlags === false) {
      throw new Error(`Docker Compose ${capability.version} lacks required bounded up/wait controls.`);
    }
    const command: PreviewComposeCommand = {
      contextName: input.contextName,
      projectName: input.projectName,
      projectDirectory,
      files,
      profiles: input.plan.profiles,
      envFile
    };
    const structuralRaw = await this.cli.config(command, { materialized: false });
    const materializedRaw = await this.cli.config(command, { materialized: true });
    const finalComposeFileIdentities = await Promise.all(files.map(readFileIdentity));
    if (canonicalJson(composeFileIdentities) !== canonicalJson(finalComposeFileIdentities)) {
      throw new Error('Compose configuration changed during bounded inspection.');
    }
    let structural: Record<string, unknown>;
    let materialized: Record<string, unknown>;
    try {
      structural = requiredRecord(JSON.parse(structuralRaw), 'structural Compose config');
      materialized = requiredRecord(JSON.parse(materializedRaw), 'materialized Compose config');
    } catch {
      throw new Error('Docker Compose returned invalid normalized configuration.');
    }
    const sanitizedStructural = sanitizeComposeConfig(structural, input.plan);
    const sanitizedMaterialized = sanitizeComposeConfig(materialized, input.plan);
    assertNonEnvironmentAuthorityStable(sanitizedStructural, sanitizedMaterialized);
    const trustAuthority = {
      files: input.plan.files,
      projectDirectory: input.plan.projectDirectory,
      profiles: input.plan.profiles,
      rootServices: input.plan.rootServices,
      composeVersion: capability.version,
      flags: ['--no-interpolate', '--no-env-resolution'],
      hostInputs: dedupedHostInputs
    };
    return {
      composeVersion: capability.version,
      supportsNoEnvResolution: true,
      trustDigest: sha256(canonicalJson(trustAuthority)),
      configDigest: sha256(canonicalJson(sanitizedMaterialized)),
      hostInputs: dedupedHostInputs,
      ...sanitizedMaterialized
    };
  }
}

function scanComposeSource(source: string, sourceName: string): { hostInputs: PreviewComposeHostInput[] } {
  const document = parseDocument(source, {
    schema: 'core',
    uniqueKeys: true,
    prettyErrors: true,
    strict: true
  });
  if (document.errors.length) throw new Error(`Compose file ${sourceName} is invalid.`);
  visit(document, (_key, node) => {
    if (isAlias(node as Node)) throw new Error(`Compose file ${sourceName} may not use YAML aliases.`);
  });
  const value = requiredRecord(document.toJS({ maxAliasCount: 0, mapAsMap: false }), sourceName);
  for (const forbidden of ['include', 'configs']) {
    if (forbidden in value) throw new Error(`Compose ${forbidden} is unsupported because it expands host-read authority.`);
  }
  const services = optionalRecord(value.services);
  const hostInputs: PreviewComposeHostInput[] = [];
  for (const [serviceId, candidate] of Object.entries(services)) {
    const service = requiredRecord(candidate, `service ${serviceId}`);
    const allowedServiceKeys = new Set([
      'image', 'platform', 'build', 'command', 'entrypoint', 'user', 'working_dir',
      'environment', 'env_file', 'secrets', 'depends_on', 'healthcheck', 'volumes',
      'networks', 'ports', 'expose', 'profiles'
    ]);
    for (const key of Object.keys(service)) {
      if (!allowedServiceKeys.has(key)) {
        throw new Error(`Compose service ${serviceId} uses unsupported ${key}.`);
      }
    }
    for (const key of ['network_mode', 'pid', 'ipc', 'userns_mode']) {
      if (key in service) throw new Error(`Compose service ${serviceId} uses unsupported host namespace control.`);
    }
    if ('ports' in service && hasPublishedPort(service.ports)) {
      throw new Error(`Compose service ${serviceId} declares source host ports; Task Monki owns loopback publication.`);
    }
    for (const volume of asList(service.volumes)) {
      if (isBindMount(volume)) throw new Error(`Compose service ${serviceId} uses an unsupported bind mount.`);
      if (typeof volume !== 'string') assertOnlyKeys(
        requiredRecord(volume, `service ${serviceId} volume`),
        ['type', 'source', 'target', 'read_only'],
        `service ${serviceId} volume`
      );
    }
    for (const envFile of normalizeFileReferences(service.env_file, 'ENV_FILE')) hostInputs.push(envFile);
    const build = service.build;
    if (build !== undefined) {
      if (typeof build === 'string') {
        hostInputs.push({ kind: 'BUILD_CONTEXT', path: safeStaticPath(build, `service ${serviceId} build context`) });
      } else {
        const buildRecord = requiredRecord(build, `service ${serviceId} build`);
        assertOnlyKeys(buildRecord, ['context', 'dockerfile'], `service ${serviceId} build`);
        const context = safeStaticPath(String(buildRecord.context ?? '.'), `service ${serviceId} build context`);
        hostInputs.push({ kind: 'BUILD_CONTEXT', path: context });
        if (buildRecord.dockerfile !== undefined) {
          hostInputs.push({
            kind: 'DOCKERFILE',
            path: path.posix.join(context, safeStaticPath(String(buildRecord.dockerfile), `service ${serviceId} dockerfile`))
          });
        }
      }
    }
    for (const secret of asList(service.secrets)) {
      if (typeof secret !== 'string') {
        throw new Error(`Compose service ${serviceId} secret targets must use the default recipient path.`);
      }
    }
    for (const port of asList(service.ports)) {
      if (typeof port !== 'string' && typeof port !== 'number') {
        assertOnlyKeys(requiredRecord(port, `service ${serviceId} port`), ['target', 'protocol'], `service ${serviceId} port`);
      }
    }
    if (service.networks && !Array.isArray(service.networks)) {
      for (const [networkName, networkValue] of Object.entries(requiredRecord(service.networks, `service ${serviceId} networks`))) {
        if (networkValue !== null && Object.keys(optionalRecord(networkValue)).length > 0) {
          throw new Error(`Compose service ${serviceId} network ${networkName} uses unsupported attachment options.`);
        }
      }
    }
  }
  const secrets = optionalRecord(value.secrets);
  for (const [name, candidate] of Object.entries(secrets)) {
    const secret = requiredRecord(candidate, `secret ${name}`);
    assertOnlyKeys(secret, ['file'], `secret ${name}`);
    if ('environment' in secret || 'external' in secret) {
      throw new Error(`Compose secret ${name} must be a repository file; environment and external secrets are unsupported.`);
    }
    if (typeof secret.file !== 'string') throw new Error(`Compose secret ${name} must declare a file.`);
    hostInputs.push({ kind: 'SECRET_FILE', path: safeStaticPath(secret.file, `secret ${name}`) });
  }
  for (const [name, candidate] of Object.entries(optionalRecord(value.volumes))) {
    const volume = optionalRecord(candidate);
    assertOnlyKeys(volume, ['external', 'driver'], `volume ${name}`);
    assertOptionalBoolean(volume.external, `Compose volume ${name} external`);
  }
  for (const [name, candidate] of Object.entries(optionalRecord(value.networks))) {
    const network = optionalRecord(candidate);
    assertOnlyKeys(network, ['external'], `network ${name}`);
    assertOptionalBoolean(network.external, `Compose network ${name} external`);
  }
  return { hostInputs };
}

function sanitizeComposeConfig(
  config: Record<string, unknown>,
  plan: PreviewComposePlan
): Pick<PreviewComposeInspection, 'services' | 'volumes' | 'networks'> {
  const servicesRecord = optionalRecord(config.services);
  if (Object.keys(servicesRecord).length > MAX_SERVICES) throw new Error('Compose config has too many services.');
  for (const id of plan.rootServices) {
    if (!(id in servicesRecord)) throw new Error(`Compose root service ${id} does not exist.`);
  }
  for (const exposure of plan.services) {
    if (!(exposure.id in servicesRecord)) throw new Error(`Compose exposed service ${exposure.id} does not exist.`);
  }
  const services: PreviewComposeServiceInspection[] = Object.keys(servicesRecord).sort().map((id) => {
    const service = requiredRecord(servicesRecord[id], `normalized service ${id}`);
    for (const key of [
      'privileged', 'devices', 'device_cgroup_rules', 'network_mode', 'pid', 'ipc',
      'userns_mode', 'provider', 'extends', 'container_name', 'deploy', 'extra_hosts',
      'configs', 'logging', 'labels', 'cap_add', 'cap_drop', 'security_opt', 'restart',
      'scale', 'volumes_from', 'links', 'dns', 'dns_search', 'sysctls', 'ulimits',
      'tmpfs', 'storage_opt', 'credential_spec', 'isolation', 'runtime', 'group_add'
    ]) {
      const value = service[key];
      if (
        value !== undefined && value !== null && value !== false && value !== '' &&
        (!Array.isArray(value) || value.length > 0) &&
        (typeof value !== 'object' || Array.isArray(value) || Object.keys(value as Record<string, unknown>).length > 0)
      ) {
        throw new Error(`Normalized Compose service ${id} contains unsupported ${key}.`);
      }
    }
    const environment = optionalRecord(service.environment);
    const environmentKeys = Object.keys(environment).sort();
    if (environmentKeys.length > MAX_ENVIRONMENT_KEYS) throw new Error(`Compose service ${id} has too many environment keys.`);
    const build = normalizeBuild(service.build, id);
    const namedVolumes = asList(service.volumes).map((mount) => normalizeNamedVolume(mount, id));
    const ports = asList(service.ports);
    if (ports.some((port) => hasPublishedPort([port]))) {
      throw new Error(`Compose service ${id} declares a source host port.`);
    }
    const declaredTargets = new Set([
      ...ports.flatMap((port) => portTarget(port)),
      ...asList(service.expose).flatMap((port) => portTarget(port))
    ]);
    for (const exposure of plan.services.filter((candidate) => candidate.id === id)) {
      for (const port of Object.values(exposure.ports)) {
        if (!declaredTargets.has(port.target)) {
          throw new Error(`Compose service ${id} does not declare target port ${port.target}.`);
        }
      }
    }
    return {
      id,
      image: optionalPublicString(service.image, `Compose service ${id} image`),
      platform: optionalPublicString(service.platform, `Compose service ${id} platform`),
      build,
      command: normalizePublicArgv(service.command, `Compose service ${id} command`),
      entrypoint: normalizePublicArgv(service.entrypoint, `Compose service ${id} entrypoint`),
      user: optionalPublicString(service.user, `Compose service ${id} user`),
      workingDirectory: optionalPublicString(service.working_dir, `Compose service ${id} working directory`),
      dependsOn: normalizeDependsOn(service.depends_on, id),
      exposedPorts: [...declaredTargets].sort((a, b) => a - b),
      environmentKeys,
      secretSources: asList(service.secrets).map((secret) =>
        typeof secret === 'string'
          ? secret
          : String(requiredRecord(secret, `Compose service ${id} secret`).source ?? '')
      ).filter(Boolean).sort(),
      namedVolumes,
      networks: Array.isArray(service.networks)
        ? service.networks.map(String).sort()
        : Object.keys(optionalRecord(service.networks)).sort(),
      healthcheck: normalizeHealthcheck(service.healthcheck, id)
    };
  });
  const volumes = Object.entries(optionalRecord(config.volumes)).sort(([a], [b]) => a.localeCompare(b)).map(([name, candidate]) => {
    const volume = optionalRecord(candidate);
    const external = volume.external === true || typeof volume.external === 'string';
    const options = optionalRecord(volume.driver_opts);
    if (Object.keys(options).length) {
      throw new Error(`Compose volume ${name} uses unsupported driver options.`);
    }
    return {
      name,
      external,
      driver: optionalPublicString(volume.driver, `Compose volume ${name} driver`)
    };
  });
  const networks = Object.entries(optionalRecord(config.networks)).sort(([a], [b]) => a.localeCompare(b)).map(([name, candidate]) => {
    const network = optionalRecord(candidate);
    return { name, external: network.external === true || typeof network.external === 'string' };
  });
  for (const service of services) {
    for (const mount of service.namedVolumes) {
      const volume = volumes.find((candidate) => candidate.name === mount.source);
      if (!volume) throw new Error(`Compose service ${service.id} references unknown volume ${mount.source}.`);
      if (volume.external && !mount.readOnly) {
        throw new Error(`External Compose volume ${volume.name} must be mounted read-only.`);
      }
    }
    for (const network of service.networks) {
      if (!networks.some((candidate) => candidate.name === network)) {
        throw new Error(`Compose service ${service.id} references unknown network ${network}.`);
      }
    }
  }
  return { services, volumes, networks };
}

function assertNonEnvironmentAuthorityStable(
  structural: Pick<PreviewComposeInspection, 'services' | 'volumes' | 'networks'>,
  materialized: Pick<PreviewComposeInspection, 'services' | 'volumes' | 'networks'>
): void {
  const withoutEnvironmentKeys = (value: typeof structural) => ({
    ...value,
    services: value.services.map(({ environmentKeys: _keys, ...service }) => service)
  });
  if (canonicalJson(withoutEnvironmentKeys(structural)) !== canonicalJson(withoutEnvironmentKeys(materialized))) {
    throw new Error('Compose interpolation may affect only service environment values in the Phase 5 adapter.');
  }
}

function normalizeBuild(value: unknown, serviceId: string): PreviewComposeServiceInspection['build'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { context: safeStaticPath(value, `Compose service ${serviceId} build`) };
  const build = requiredRecord(value, `Compose service ${serviceId} build`);
  return {
    context: safeStaticPath(String(build.context ?? '.'), `Compose service ${serviceId} build context`),
    dockerfile: build.dockerfile === undefined
      ? undefined
      : safeStaticPath(String(build.dockerfile), `Compose service ${serviceId} dockerfile`)
  };
}

function normalizeDependsOn(
  value: unknown,
  serviceId: string
): PreviewComposeServiceInspection['dependsOn'] {
  if (Array.isArray(value)) {
    return value.map((dependency) => ({
      service: requiredPublicString(dependency, `Compose service ${serviceId} dependency`),
      condition: 'service_started' as const,
      required: true,
      restart: false
    })).sort((a, b) => a.service.localeCompare(b.service));
  }
  return Object.entries(optionalRecord(value)).sort(([a], [b]) => a.localeCompare(b)).map(([service, candidate]) => {
    const dependency = optionalRecord(candidate);
    const condition = dependency.condition ?? 'service_started';
    if (!['service_started', 'service_healthy'].includes(String(condition))) {
      throw new Error(`Compose service ${serviceId} dependency condition is unsupported.`);
    }
    return {
      service,
      condition: condition as 'service_started' | 'service_healthy',
      required: dependency.required !== false,
      restart: dependency.restart === true
    };
  });
}

function normalizeHealthcheck(
  value: unknown,
  serviceId: string
): PreviewComposeServiceInspection['healthcheck'] {
  if (value === undefined || value === null) return undefined;
  const health = requiredRecord(value, `Compose service ${serviceId} healthcheck`);
  if (health.disable === true) return undefined;
  const test = normalizePublicArgv(health.test, `Compose service ${serviceId} healthcheck`) ?? [];
  if (!test.length) throw new Error(`Compose service ${serviceId} healthcheck is invalid.`);
  const retries = health.retries === undefined ? undefined : Number(health.retries);
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 1 || retries > 100)) {
    throw new Error(`Compose service ${serviceId} healthcheck retries are invalid.`);
  }
  return {
    test,
    interval: optionalPublicString(health.interval, `Compose service ${serviceId} healthcheck interval`),
    timeout: optionalPublicString(health.timeout, `Compose service ${serviceId} healthcheck timeout`),
    startPeriod: optionalPublicString(health.start_period, `Compose service ${serviceId} healthcheck start period`),
    retries
  };
}

function normalizeNamedVolume(value: unknown, serviceId: string) {
  if (typeof value === 'string') {
    const [source, target, mode] = value.split(':');
    if (!source || !target || isHostPath(source)) throw new Error(`Compose service ${serviceId} has an unsupported volume mount.`);
    return { source, target, readOnly: mode === 'ro' };
  }
  const mount = requiredRecord(value, `Compose service ${serviceId} volume`);
  if (mount.type !== 'volume' || typeof mount.source !== 'string' || typeof mount.target !== 'string') {
    throw new Error(`Compose service ${serviceId} has an unsupported non-volume mount.`);
  }
  return { source: mount.source, target: mount.target, readOnly: mount.read_only === true };
}

function normalizeFileReferences(value: unknown, kind: 'ENV_FILE'): PreviewComposeHostInput[] {
  return asList(value).map((candidate) => {
    if (typeof candidate === 'string') return { kind, path: safeStaticPath(candidate, 'env_file'), format: 'COMPOSE' };
    const record = requiredRecord(candidate, 'env_file');
    if (typeof record.path !== 'string') throw new Error('Compose env_file entry must name a path.');
    return {
      kind,
      path: safeStaticPath(record.path, 'env_file'),
      format: record.format === 'raw' ? 'RAW' : 'COMPOSE'
    };
  });
}

function hasPublishedPort(value: unknown): boolean {
  return asList(value).some((candidate) => {
    if (typeof candidate === 'number') return false;
    if (typeof candidate === 'string') return candidate.split(':').length > 1;
    const port = requiredRecord(candidate, 'Compose port');
    return port.published !== undefined || port.host_ip !== undefined;
  });
}

function portTarget(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (typeof value === 'string') {
    const match = /^(\d+)(?:\/tcp)?$/.exec(value);
    return match ? [Number(match[1])] : [];
  }
  const port = requiredRecord(value, 'Compose port');
  return Number.isInteger(port.target) ? [Number(port.target)] : [];
}

function isBindMount(value: unknown): boolean {
  if (typeof value === 'string') return isHostPath(value.split(':')[0] ?? '');
  const mount = requiredRecord(value, 'Compose volume');
  return mount.type === 'bind' || (typeof mount.source === 'string' && isHostPath(mount.source));
}

function isHostPath(value: string): boolean {
  return value.startsWith('.') || value.startsWith('/') || value.startsWith('~') || value.includes('\\');
}

function safeStaticPath(value: string, context: string): string {
  if (
    !value || value.includes('\0') || /[\r\n$]/.test(value) || path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) || value.split(/[\\/]/).includes('..')
  ) throw new Error(`${context} must be a static repository-relative path.`);
  return value.replace(/\\/g, '/').replace(/^\.\//, '') || '.';
}

async function resolveContainedDirectory(root: string, relative: string): Promise<string> {
  const candidate = path.resolve(root, relative);
  const real = await fs.realpath(candidate);
  const stat = await fs.lstat(real);
  if (!isPathWithin(root, real) || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Compose project path must be a contained regular directory.');
  }
  return real;
}

async function resolveContainedFile(root: string, candidate: string, maxBytes: number): Promise<string> {
  const lexical = path.resolve(candidate);
  if (!isPathWithin(root, lexical)) throw new Error('Compose host input escapes the captured source.');
  const stat = await fs.lstat(lexical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error('Compose host input must be a bounded regular file, not a symlink.');
  }
  const real = await fs.realpath(lexical);
  if (!isPathWithin(root, real)) throw new Error('Compose host input escapes the captured source.');
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  await handle.close();
  return real;
}

async function ensureEmptyPrivateFile(file: string): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readFileIdentity(file: string): Promise<Record<string, string>> {
  const stat = await fs.lstat(file, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function dedupeHostInputs(inputs: PreviewComposeHostInput[]): PreviewComposeHostInput[] {
  const byKey = new Map<string, PreviewComposeHostInput>();
  for (const input of inputs) byKey.set(`${input.kind}:${input.path}:${input.format ?? ''}`, input);
  return [...byKey.values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function relativePath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).replace(/\\/g, '/');
  if (relative.startsWith('../')) throw new Error('Compose path is outside captured source.');
  return relative || '.';
}

function normalizePublicArgv(value: unknown, context: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.map((candidate) => requiredPublicString(candidate, context));
}

function optionalPublicString(value: unknown, context: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredPublicString(value, context);
}

function requiredPublicString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.includes('\0') || /[\r\n]/.test(value) || Buffer.byteLength(value) > 4096) {
    throw new Error(`${context} is invalid.`);
  }
  return value;
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be a mapping.`);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: string[], context: string): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unsupported) throw new Error(`${context} uses unsupported ${unsupported}.`);
}

function assertOptionalBoolean(value: unknown, context: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${context} must be boolean.`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
