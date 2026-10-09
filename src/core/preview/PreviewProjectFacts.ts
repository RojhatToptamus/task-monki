import fs from 'node:fs/promises';
import path from 'node:path';
import { isMap, isScalar, parseDocument } from 'yaml';
import type { PreviewProjectFact } from '../../shared/applicationPreview';

const MAX_FILE_BYTES = 256 * 1024;
const MANIFEST_FOLDERS = ['.', 'web', 'client', 'frontend', 'app', 'apps/web'];
const ENV_TEMPLATES = ['.env.example', '.env.sample', '.env.template', '.env.local.example'];
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const LOCKFILES: Array<[string, string]> = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun']
];
const FRAMEWORKS: Array<[string, string]> = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@remix-run/react', 'Remix'],
  ['astro', 'Astro'],
  ['gatsby', 'Gatsby'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@angular/core', 'Angular'],
  ['react-scripts', 'Create React App'],
  ['vite', 'Vite'],
  ['@nestjs/core', 'NestJS'],
  ['fastify', 'Fastify'],
  ['express', 'Express'],
  ['hono', 'Hono'],
  ['koa', 'Koa']
];
const OTHER_MANIFESTS: Array<[string, string]> = [
  ['pyproject.toml', 'Python project'],
  ['requirements.txt', 'Python project'],
  ['go.mod', 'Go module'],
  ['Cargo.toml', 'Rust crate'],
  ['Gemfile', 'Ruby project']
];

/**
 * What the project files say about running it, before anything runs: the application and its
 * command, how dependencies install, which environment keys it reads, and which services a
 * Compose file defines. Only environment key names are returned; template values never leave this reader.
 */
export async function readPreviewProjectFacts(projectDirectory: string): Promise<PreviewProjectFact[]> {
  const facts: PreviewProjectFact[] = [];
  const read = (relative: string) => readBounded(path.join(projectDirectory, relative));
  for (const folder of MANIFEST_FOLDERS) {
    const relative = path.posix.join(folder, 'package.json');
    const manifest = parseJson(await read(relative));
    if (!manifest) continue;
    facts.push({ label: 'Application', detail: applicationDetail(manifest, folder), source: relative });
    if (facts.length === 1) facts.push({ label: 'Dependencies', ...(await dependenciesDetail(manifest, projectDirectory, folder)) });
  }
  if (!facts.length)
    for (const [file, name] of OTHER_MANIFESTS) {
      if ((await read(file)) === undefined) continue;
      facts.push({ label: 'Application', detail: name, source: file });
      break;
    }
  for (const file of ENV_TEMPLATES) {
    const keys = envKeys(await read(file));
    if (!keys) continue;
    facts.push({ label: 'Environment', detail: list(keys, 'variable'), source: file });
    break;
  }
  for (const file of COMPOSE_FILES) {
    const services = composeServices(await read(file));
    if (!services) continue;
    facts.push({ label: 'Services', detail: list(services, 'Compose service'), source: file });
    break;
  }
  return facts;
}

type Manifest = { packageManager?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function applicationDetail(manifest: Manifest, folder: string): string {
  const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
  const framework = FRAMEWORKS.find(([name]) => name in dependencies)?.[1] ?? 'Node.js';
  const script = ['dev', 'start', 'serve'].find((name) => manifest.scripts?.[name]);
  const where = folder === '.' ? '' : ` in ${folder}`;
  return script ? `${framework}${where} · npm run ${script}` : `${framework}${where} · no dev or start script`;
}

async function dependenciesDetail(manifest: Manifest, root: string, folder: string) {
  const lockfile = (await Promise.all(LOCKFILES.map(async ([file, manager]) => {
    const relative = path.posix.join(folder, file);
    const stat = await fs.lstat(path.join(root, relative)).catch(() => undefined);
    return stat?.isFile() ? [relative, manager] as const : undefined;
  }))).find((entry) => entry);
  const declared = manifest.packageManager?.match(/^([a-z]+)/)?.[1];
  const manager = declared ?? lockfile?.[1] ?? 'npm';
  return lockfile
    ? { detail: `${manager} · ${lockfile[0]}`, source: lockfile[0] }
    : { detail: `${manager} · no lockfile committed`, source: path.posix.join(folder, 'package.json') };
}

function envKeys(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  const keys = [...new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((match) => match[1]!))];
  return keys.length ? keys : undefined;
}

function composeServices(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  const document = parseDocument(text);
  if (document.errors.length) return undefined;
  // Only inspect names. Resolving service bodies rejects common Compose anchors and
  // needlessly expands data that this summary never uses.
  const value = document.get('services', true);
  const services = isMap(value)
    ? value.items.flatMap(({ key }) => isScalar(key) && typeof key.value === 'string' && key.value !== '<<' ? [key.value] : [])
    : [];
  return services.length ? services : undefined;
}

function list(items: string[], noun: string): string {
  const shown = items.slice(0, 6).join(', ');
  const more = items.length - 6;
  return more > 0 ? `${shown} and ${more} more ${noun}${more === 1 ? '' : 's'}` : shown;
}

function parseJson(text: string | undefined): Manifest | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

async function readBounded(file: string): Promise<string | undefined> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
  return fs.readFile(file, 'utf8').catch(() => undefined);
}
