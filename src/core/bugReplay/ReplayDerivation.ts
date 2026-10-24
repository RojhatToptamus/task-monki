import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PreviewSpec } from 'previewhost';
import { canonicalJson } from '../../shared/bugCase';
import { parseConfigurationFile } from '../preview/ApplicationPreviewConfiguration';

/**
 * Turns a task's stored `preview.yaml` into the spec of one clean copy: every source directory
 * points into the frozen export, the name is the run's own `br-` name, dependencies install from
 * the lockfile, and nothing else changes. Recipes a clean copy cannot run honestly are refused
 * with one sentence before anything starts.
 */

/** Read access to one frozen tree: its file list and bounded text of a file. */
export interface ReplayTreeReader {
  files: readonly string[];
  readText(relativePath: string): Promise<string | undefined>;
}

export type ReplayEligibilityCode = 'INELIGIBLE' | 'PREREQUISITE';

export class ReplayEligibilityError extends Error {
  constructor(
    readonly code: ReplayEligibilityCode,
    message: string,
    readonly action: 'ask-preview-agent' | 'retry' | 'record-again' = 'ask-preview-agent'
  ) {
    super(message);
    this.name = 'ReplayEligibilityError';
  }
}

export interface ReplayDerivationInput {
  recipeText: string;
  /** Absolute path of the export's source root, or a placeholder for the template. */
  exportRoot: string;
  /** The live task worktree; recipes must never reach into it. */
  liveWorktree: string;
  runName: string;
  /** The value of GIT_CEILING_DIRECTORIES for jobs. */
  ceiling: string;
  tree: ReplayTreeReader;
  /** Included ignored env files, read for classification only. */
  envFiles: Array<{ relativePath: string; text: string }>;
}

export interface ReplayCommandSummary {
  service: string;
  command: string;
  directory: string;
  added?: boolean;
}

/** One service of a clean copy: its directory relative to the export root, '.' for the root. */
export interface ReplayJob {
  id: string;
  type: string;
  directory: string;
  command?: string[];
}

export interface DerivedReplaySpec {
  spec: PreviewSpec;
  templateDigest: string;
  /**
   * What the person approves: the template with the env files replays get and every outside host
   * they call, so a change to any of them asks again.
   */
  approvalDigest: string;
  commands: ReplayCommandSummary[];
  addedInstallJobs: string[];
  outsideHosts: string[];
  secretIds: string[];
  managedDatabases: string[];
  /** Every service the clean copy runs, the install jobs it adds included. */
  jobs: ReplayJob[];
}

/** A directory the recipe runs code in, relative to the export root. */
interface ServiceDirectory {
  service: string;
  type: string;
  directory: string;
}

const ALLOWED_SERVICE_TYPES = new Set(['command', 'worker', 'job', 'static', 'postgres', 'redis']);
const DATABASE_SCHEMES = /^(?:postgres(?:ql)?|mysql|mariadb|redis|rediss|mongodb(?:\+srv)?|amqps?|mssql|sqlserver|cockroachdb):\/\//i;
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;
const INSTALL_TIMEOUT_MS = 600_000;
const CLEAN_COPY_TIMEOUT_MS = 600_000;

/** Static rules: the recipe alone decides them, so the Record bug button can say why it is off. */
export function staticEligibility(recipeText: string): void {
  let spec: PreviewSpec;
  try {
    spec = parseConfigurationFile(recipeText);
  } catch (error) {
    throw new ReplayEligibilityError('INELIGIBLE', `The preview recipe is not valid: ${error instanceof Error ? error.message.replace(/\.$/, '') : 'unreadable'}`);
  }
  checkStaticShape(spec);
}

function checkStaticShape(spec: PreviewSpec): void {
  if (spec.type === 'compose') {
    throw new ReplayEligibilityError('INELIGIBLE', 'Clean copies do not run Compose recipes. Ask the Preview agent for an environment recipe.');
  }
  if (spec.type === 'attach') {
    throw new ReplayEligibilityError('INELIGIBLE', 'Clean copies cannot freeze an app that Preview only attaches to.');
  }
  if (spec.type === 'environment') {
    for (const [id, service] of Object.entries(spec.services)) {
      if (!ALLOWED_SERVICE_TYPES.has(service.type)) {
        throw new ReplayEligibilityError(
          'INELIGIBLE',
          service.type === 'preview'
            ? `Run ${id} in this recipe so clean copies can freeze it.`
            : `Run ${id} through Preview so clean copies can freeze it.`
        );
      }
    }
  }
}

/** Derives the clean-copy spec from the stored recipe. Throws ReplayEligibilityError to refuse. */
export async function deriveReplaySpec(input: ReplayDerivationInput): Promise<DerivedReplaySpec> {
  let spec: PreviewSpec;
  try {
    spec = parseConfigurationFile(input.recipeText);
  } catch (error) {
    throw new ReplayEligibilityError('INELIGIBLE', `The preview recipe is not valid: ${error instanceof Error ? error.message.replace(/\.$/, '') : 'unreadable'}`);
  }
  checkStaticShape(spec);
  const environment = toEnvironment(spec);
  const services = environment.services as Record<string, Record<string, unknown>>;
  const serviceDirectories: ServiceDirectory[] = [];
  const commands: ReplayCommandSummary[] = [];

  // Every directory resolves inside the frozen copy; nothing may point at the live worktree.
  for (const [id, service] of Object.entries(services)) {
    for (const key of ['cwd', 'directory'] as const) {
      const value = service[key];
      if (typeof value !== 'string') continue;
      const relative = relativeInside(value, input.liveWorktree);
      if (relative === undefined) {
        throw new ReplayEligibilityError('INELIGIBLE', `The ${id} service runs from outside this task's folder. Clean copies need every source inside it.`);
      }
      service[key] = path.join(input.exportRoot, relative);
      serviceDirectories.push({ service: id, type: String(service.type), directory: relative || '.' });
      if (key === 'directory' && service.type === 'static' && !treeHasDirectory(input.tree, relative)) {
        throw new ReplayEligibilityError('INELIGIBLE', `The ${id} service serves ${relative || 'files'} that are not in the code. Ask the Preview agent to build them in a job.`);
      }
    }
    for (const probeKey of ['ready', 'liveness'] as const) {
      const holder = service[probeKey] as Record<string, unknown> | undefined;
      const probe = (probeKey === 'liveness' ? holder?.probe : holder) as Record<string, unknown> | undefined;
      if (probe?.type === 'command' && typeof probe.cwd === 'string') {
        const relative = relativeInside(probe.cwd, input.liveWorktree);
        if (relative === undefined) throw new ReplayEligibilityError('INELIGIBLE', `The ${id} readiness check runs outside this task's folder.`);
        probe.cwd = path.join(input.exportRoot, relative);
      }
    }
    if (Array.isArray(service.command)) {
      for (const argument of service.command as string[]) {
        if (path.isAbsolute(argument) && relativeInside(argument, input.liveWorktree) !== undefined) {
          throw new ReplayEligibilityError('INELIGIBLE', `The ${id} command names a file in the live worktree. Use a path relative to the project.`);
        }
      }
      commands.push({ service: id, command: (service.command as string[]).join(' '), directory: relativeDirectory(serviceDirectories, id) });
    }
  }

  // Unmanaged state: a clean copy must never write to a database or folder outside Preview.
  const outsideHosts = new Set<string>();
  const boundKeys = new Map<string, Set<string>>();
  for (const [id, service] of Object.entries(services)) {
    const env = (service.env ?? {}) as Record<string, unknown>;
    const keys = new Set<string>();
    for (const [key, value] of Object.entries(env)) {
      keys.add(key);
      if (typeof value === 'string') classifyValue(key, value, `the ${id} service`, input, outsideHosts);
      else if (value && typeof value === 'object' && 'fromEnv' in value) {
        throw new ReplayEligibilityError('INELIGIBLE', `The ${id} service reads ${key} from Task Monki's own environment, which clean copies do not pass on.`);
      }
    }
    boundKeys.set(id, keys);
  }
  for (const file of input.envFiles) {
    const directory = path.posix.dirname(file.relativePath);
    const owners = serviceDirectories.filter((entry) => entry.directory === directory || (directory === '.' && entry.directory === '.'));
    for (const [key, value] of parseDotenv(file.text)) {
      const boundEverywhere = owners.length > 0 && owners.every((owner) => boundKeys.get(owner.service)?.has(key));
      if (boundEverywhere) continue;
      classifyValue(key, value, path.posix.basename(file.relativePath), input, outsideHosts);
    }
  }

  // Dependencies install from the lockfile in a clean copy; add the job a recipe for live folders omits.
  const addedInstallJobs = await ensureInstallJobs(services, serviceDirectories, input, commands);

  for (const service of Object.values(services)) {
    if (service.type !== 'job') continue;
    const env = { ...((service.env ?? {}) as Record<string, unknown>) };
    env.GIT_CEILING_DIRECTORIES = input.ceiling;
    service.env = env;
  }
  environment.name = input.runName;
  const hasInstall = Object.values(services).some((service) => service.type === 'job' && isInstallCommand(service.command as string[]));
  if (hasInstall) environment.timeoutMs = Math.max(Number(environment.timeoutMs ?? 60_000), CLEAN_COPY_TIMEOUT_MS);

  const secretIds = [...collectSecretIds(environment)].sort();
  const managedDatabases = Object.entries(services)
    .filter(([, service]) => service.type === 'postgres' || service.type === 'redis')
    .map(([id]) => id);
  const derived = environment as unknown as PreviewSpec;
  const template = templateDigest(derived, input);
  const hosts = [...outsideHosts].sort();
  return {
    spec: derived,
    templateDigest: template,
    approvalDigest: approvalDigest(template, input.envFiles.map((file) => file.relativePath), hosts),
    commands,
    addedInstallJobs,
    outsideHosts: hosts.slice(0, 10),
    secretIds,
    managedDatabases,
    jobs: Object.entries(services).map(([id, service]) => {
      const location = service.cwd ?? service.directory;
      return {
        id,
        type: String(service.type),
        directory: typeof location === 'string' ? relativeOf(location, input.exportRoot) : '.',
        ...(Array.isArray(service.command) ? { command: service.command as string[] } : {})
      };
    })
  };
}

/** Top-level command and static recipes run as a one-service environment so jobs can be added. */
function toEnvironment(spec: PreviewSpec): Record<string, unknown> & { services: Record<string, Record<string, unknown>> } {
  const copy = structuredClone(spec) as unknown as Record<string, unknown>;
  delete copy.sourceFile;
  if (copy.type === 'environment') return copy as Record<string, unknown> & { services: Record<string, Record<string, unknown>> };
  const { name, type, ...service } = copy;
  void type;
  const timeoutMs = typeof service.timeoutMs === 'number' ? service.timeoutMs : undefined;
  return {
    name,
    type: 'environment',
    primary: 'app',
    ...(timeoutMs ? { timeoutMs } : {}),
    services: { app: { type: spec.type, ...service } }
  };
}

async function ensureInstallJobs(
  services: Record<string, Record<string, unknown>>,
  serviceDirectories: ServiceDirectory[],
  input: ReplayDerivationInput,
  commands: ReplayCommandSummary[]
): Promise<string[]> {
  const added: string[] = [];
  const roots = new Map<string, string[]>();
  for (const entry of serviceDirectories) {
    if (entry.type === 'static' || entry.type === 'postgres' || entry.type === 'redis') continue;
    const root = await installRoot(entry.directory, input.tree);
    if (!root) continue;
    if (root.needsLockfile) {
      throw new ReplayEligibilityError('INELIGIBLE', `Clean copies install dependencies from a lockfile. Add one to ${root.directory === '.' ? 'the project' : root.directory}.`);
    }
    const list = roots.get(root.directory) ?? [];
    list.push(entry.service);
    roots.set(root.directory, list);
  }
  for (const [directory, users] of roots) {
    const covered = Object.entries(services).some(
      ([, service]) =>
        service.type === 'job' &&
        isInstallCommand(service.command as string[]) &&
        relativeOf(String(service.cwd), input.exportRoot) === directory
    );
    if (covered) continue;
    const command = await installCommandFor(directory, input.tree);
    let id = 'tm-install';
    for (let suffix = 2; services[id]; suffix += 1) id = `tm-install-${suffix}`;
    services[id] = { type: 'job', cwd: path.join(input.exportRoot, directory === '.' ? '' : directory), command, env: {}, timeoutMs: INSTALL_TIMEOUT_MS };
    added.push(id);
    commands.unshift({ service: id, command: command.join(' '), directory, added: true });
    for (const user of users) {
      const service = services[user];
      if (!service || service === services[id]) continue;
      const dependsOn = new Set<string>(Array.isArray(service.dependsOn) ? (service.dependsOn as string[]) : []);
      dependsOn.add(id);
      service.dependsOn = [...dependsOn];
    }
  }
  return added;
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

async function installRoot(directory: string, tree: ReplayTreeReader): Promise<{ directory: string; needsLockfile: boolean } | undefined> {
  const files = new Set(tree.files);
  const segments = directory === '.' ? [] : directory.split('/');
  let nearestPackage: string | undefined;
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const candidate = segments.slice(0, depth).join('/') || '.';
    const prefix = candidate === '.' ? '' : `${candidate}/`;
    if (LOCKFILES.some((lockfile) => files.has(`${prefix}${lockfile}`))) return { directory: candidate, needsLockfile: false };
    if (!nearestPackage && files.has(`${prefix}package.json`)) nearestPackage = candidate;
  }
  if (!nearestPackage) return undefined;
  const text = await tree.readText(`${nearestPackage === '.' ? '' : `${nearestPackage}/`}package.json`);
  const manifest = safeJson(text) as Record<string, unknown> | undefined;
  const hasDependencies = ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
    const value = manifest?.[key];
    return value && typeof value === 'object' && Object.keys(value).length > 0;
  });
  return hasDependencies ? { directory: nearestPackage, needsLockfile: true } : undefined;
}

async function installCommandFor(directory: string, tree: ReplayTreeReader): Promise<string[]> {
  const files = new Set(tree.files);
  const prefix = directory === '.' ? '' : `${directory}/`;
  if (files.has(`${prefix}pnpm-lock.yaml`)) return ['pnpm', 'install', '--frozen-lockfile'];
  if (files.has(`${prefix}yarn.lock`)) {
    const manifest = safeJson(await tree.readText(`${prefix}package.json`)) as { packageManager?: unknown } | undefined;
    const berry = files.has(`${prefix}.yarnrc.yml`) || (typeof manifest?.packageManager === 'string' && /^yarn@[2-9]/.test(manifest.packageManager));
    return berry ? ['yarn', 'install', '--immutable'] : ['yarn', 'install', '--frozen-lockfile'];
  }
  if (files.has(`${prefix}bun.lock`) || files.has(`${prefix}bun.lockb`)) return ['bun', 'install', '--frozen-lockfile'];
  return ['npm', 'ci', '--no-audit', '--no-fund'];
}

export function isInstallCommand(command: string[] | undefined): boolean {
  if (!Array.isArray(command) || command.length === 0) return false;
  const tool = path.basename(command[0]);
  const verb = command[1];
  if (tool === 'npm') return verb === 'ci' || verb === 'install' || verb === 'i';
  if (tool === 'pnpm' || tool === 'bun') return verb === 'install' || verb === 'i';
  if (tool === 'yarn') return verb === undefined || verb === 'install' || verb.startsWith('--');
  return false;
}

function classifyValue(key: string, value: string, owner: string, input: ReplayDerivationInput, outsideHosts: Set<string>): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (DATABASE_SCHEMES.test(trimmed)) {
    throw new ReplayEligibilityError('INELIGIBLE', `This app uses a database outside Preview (${key} in ${owner}). Clean copies would change it.`);
  }
  if (/^file:/i.test(trimmed)) {
    const location = trimmed.replace(/^file:(?:\/\/)?/i, '');
    if (path.isAbsolute(location)) {
      throw new ReplayEligibilityError('INELIGIBLE', `This app keeps data outside its folder (${key} in ${owner}). Clean copies would change it.`);
    }
    return;
  }
  if (path.isAbsolute(trimmed) && !trimmed.includes('\n') && trimmed.length < 1024) {
    if (relativeInside(trimmed, input.liveWorktree) !== undefined) {
      throw new ReplayEligibilityError('INELIGIBLE', `${key} in ${owner} points into the live worktree. Use a path relative to the project.`);
    }
    if (/^\/(?:Users|home|var|tmp|private|opt|srv|data|mnt)\//.test(trimmed)) {
      throw new ReplayEligibilityError('INELIGIBLE', `This app keeps data outside its folder (${key} in ${owner}). Clean copies would change it.`);
    }
    return;
  }
  let url: URL | undefined;
  try {
    url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? new URL(trimmed) : undefined;
  } catch {
    url = undefined;
  }
  if (!url) return;
  const web = url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:';
  if (!web && LOOPBACK_HOST.test(url.hostname)) {
    throw new ReplayEligibilityError('INELIGIBLE', `This app calls a local service outside Preview (${key} in ${owner}). Add it to the recipe so clean copies run it too.`);
  }
  // Web addresses are facts for the person: a clean copy cannot reach the developer's own
  // localhost ports from the browser, and the server's network is not restricted.
  if (web) outsideHosts.add(`${url.protocol}//${url.host}`);
}

/** KEY=value pairs of a dotenv file; comments, blanks and malformed lines are skipped. */
export function parseDotenv(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/).slice(0, 2_000)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    pairs.push([match[1], value]);
  }
  return pairs;
}

/** Every `{ secret: id }` reference in a spec. */
export function collectSecretIds(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectSecretIds(item, found);
    return found;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.secret === 'string' && Object.keys(record).length === 1) found.add(record.secret);
  for (const item of Object.values(record)) collectSecretIds(item, found);
  return found;
}

/** The digest of the spec with the run's name, export root and ceiling replaced by placeholders. */
function templateDigest(spec: PreviewSpec, input: ReplayDerivationInput): string {
  const text = JSON.stringify(spec, (_key, value: unknown) => {
    if (typeof value !== 'string') return value;
    return value.split(input.exportRoot).join('<export>').split(input.ceiling).join('<ceiling>').split(input.runName).join('<name>');
  });
  return createHash('sha256').update(canonicalJson(JSON.parse(text))).digest('hex');
}

/** The template with what the lease sheet states beside it: the env files and every outside host. */
function approvalDigest(template: string, envFiles: string[], hosts: string[]): string {
  return createHash('sha256').update(canonicalJson({ template, envFiles: [...envFiles].sort(), hosts })).digest('hex');
}

function relativeInside(value: string, root: string): string | undefined {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

function relativeOf(directory: string, exportRoot: string): string {
  const relative = path.relative(exportRoot, directory).split(path.sep).join('/');
  return relative === '' ? '.' : relative;
}

function relativeDirectory(entries: ServiceDirectory[], service: string): string {
  return entries.find((entry) => entry.service === service)?.directory ?? '.';
}

function treeHasDirectory(tree: ReplayTreeReader, relative: string): boolean {
  if (!relative || relative === '.') return tree.files.length > 0;
  const prefix = `${relative.replace(/\/$/, '')}/`;
  return tree.files.some((file) => file.startsWith(prefix));
}

function safeJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A short, random Previewhost name for one environment: 15 characters, never reused. */
export function replayEnvironmentName(randomHex: string): string {
  if (!/^[0-9a-f]{12}$/.test(randomHex)) throw new Error('A replay name needs 12 hex characters.');
  return `br-${randomHex}`;
}

export const REPLAY_NAME_PATTERN = /^br-[0-9a-f]{12}$/;
