import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BugReplayProtectedInput } from '../../shared/bugReplay';
import { canonicalJson, readJsonPointer } from '../../shared/bugCase';
import { isInstallCommand, type ReplayTreeReader } from './ReplayDerivation';

/**
 * The setup inputs a case version keeps fixed. A clean copy's starting state comes from the
 * recipe's jobs (install, migrate, seed), so a change to what those jobs read could make the bug
 * vanish without fixing it. Long-running services are the code under test and are not pinned,
 * and code a seed shares with the app is listed for the reviewer instead of pinned, because one
 * file cannot be both kept fixed and fixed.
 */

export interface ProtectedInputPlan {
  pins: BugReplayProtectedInput[];
  /** Files a seed imports from outside its own directory: shared with the app, not pinned. */
  sharedSetup: string[];
  /** Imports Task Monki could not follow. */
  unresolved: string[];
}

export interface RecipeJob {
  id: string;
  type: string;
  /** Directory relative to the export root; '.' for the root. */
  directory: string;
  command?: string[];
}

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const MAX_PINNED_CLOSURE = 200;

export async function planProtectedInputs(jobs: RecipeJob[], tree: ReplayTreeReader): Promise<ProtectedInputPlan> {
  const files = new Set(tree.files);
  const filePins = new Set<string>();
  const memberPins = new Map<string, { path: string; pointer: string }>();
  const sharedSetup = new Set<string>();
  const unresolved = new Set<string>();
  const closureEntries: Array<{ file: string; ownDirectory?: string }> = [];
  const packageNames = await workspacePackages(tree);

  const pinScript = async (packageDirectory: string, name: string, depth: number): Promise<void> => {
    const manifestPath = joinRelative(packageDirectory, 'package.json');
    if (!files.has(manifestPath) || depth > 3) return;
    memberPins.set(`${manifestPath}#/scripts/${name}`, { path: manifestPath, pointer: `/scripts/${escapePointer(name)}` });
    const manifest = safeJson(await tree.readText(manifestPath)) as { scripts?: Record<string, unknown> } | undefined;
    const body = manifest?.scripts?.[name];
    if (typeof body !== 'string') return;
    for (const part of body.split(/&&|\|\||;|\|/)) {
      await pinCommand(packageDirectory, shellWords(part.trim()), depth + 1);
    }
  };

  const pinCommand = async (directory: string, argv: string[], depth: number): Promise<void> => {
    if (argv.length === 0 || isInstallCommand(argv)) return;
    const tool = path.basename(argv[0]);
    if (SCRIPT_RUNNERS.has(tool)) {
      const workspace = workspaceTarget(argv, packageNames);
      const scriptDirectory = workspace ?? directory;
      const script = scriptName(tool, argv);
      if (script) await pinScript(scriptDirectory, script, depth);
    }
    if (tool === 'turbo' && argv[1] === 'run' && argv[2]) {
      for (const packageDirectory of packageNames.values()) await pinScript(packageDirectory, argv[2], depth);
    }
    for (const argument of argv.slice(1)) {
      if (argument.startsWith('-') || argument.includes('=')) continue;
      const candidate = joinRelative(directory, argument);
      if (files.has(candidate)) {
        filePins.add(candidate);
        if (CODE_EXTENSIONS.includes(path.extname(candidate))) closureEntries.push({ file: candidate });
      }
    }
    const invokesPrisma = argv.some((argument) => path.basename(argument) === 'prisma');
    if (invokesPrisma) await pinPrisma(directory);
    if (argv.some((argument) => path.basename(argument) === 'knex')) pinMatching(directory, /^knexfile\.[cm]?[jt]s$/, /^seeds?\//);
    if (argv.some((argument) => argument === 'db:seed' || argument === 'db:setup' || argument === 'db:reset')) {
      pinMatching(directory, /^db\/seeds\.rb$/, /^db\/seeds\//);
    }
    if (argv.includes('loaddata')) {
      for (const file of files) if (/(?:^|\/)fixtures\//.test(file)) filePins.add(file);
    }
  };

  const pinPrisma = async (directory: string): Promise<void> => {
    const manifestPath = joinRelative(directory, 'package.json');
    if (files.has(manifestPath)) {
      memberPins.set(`${manifestPath}#/prisma/seed`, { path: manifestPath, pointer: '/prisma/seed' });
      const manifest = safeJson(await tree.readText(manifestPath)) as { prisma?: { seed?: unknown; schema?: unknown } } | undefined;
      if (typeof manifest?.prisma?.seed === 'string') {
        for (const word of shellWords(manifest.prisma.seed)) {
          const candidate = joinRelative(directory, word);
          if (files.has(candidate) && CODE_EXTENSIONS.includes(path.extname(candidate))) {
            filePins.add(candidate);
            closureEntries.push({ file: candidate });
          }
        }
      }
    }
    for (const file of files) {
      const relative = directory === '.' ? file : file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : undefined;
      if (relative && /^prisma\.config\.[cm]?[jt]s$/.test(relative)) filePins.add(file);
      if (relative && /^prisma\/seed\.[cm]?[jt]s$/.test(relative)) {
        filePins.add(file);
        closureEntries.push({ file });
      }
    }
  };

  const pinMatching = (directory: string, ...patterns: RegExp[]) => {
    for (const file of files) {
      const relative = directory === '.' ? file : file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : undefined;
      if (relative && patterns.some((pattern) => pattern.test(relative))) filePins.add(file);
    }
  };

  for (const job of jobs) {
    if (job.type !== 'job' || !job.command) continue;
    await pinCommand(job.directory, job.command, 0);
    if (isInstallCommand(job.command)) {
      for (const script of LIFECYCLE_SCRIPTS) {
        const manifestPath = joinRelative(job.directory, 'package.json');
        if (files.has(manifestPath)) memberPins.set(`${manifestPath}#/scripts/${script}`, { path: manifestPath, pointer: `/scripts/${script}` });
      }
    }
  }

  // The seed's own directory is setup; what it imports from elsewhere is code the app shares.
  let pinnedClosure = 0;
  const visited = new Set<string>();
  const queue = closureEntries.map((entry) => ({ file: entry.file, ownDirectory: setupDirectory(entry.file, files) }));
  const tsconfigPaths = await readPathAliases(tree);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next.file)) continue;
    visited.add(next.file);
    const text = await tree.readText(next.file);
    if (text === undefined) continue;
    for (const specifier of importSpecifiers(text)) {
      const resolved = resolveImport(next.file, specifier, files, tsconfigPaths, packageNames);
      if (resolved === 'external') continue;
      if (!resolved) {
        unresolved.add(specifier.slice(0, 120));
        continue;
      }
      if (next.ownDirectory && resolved.startsWith(`${next.ownDirectory}/`)) {
        if (!filePins.has(resolved)) {
          pinnedClosure += 1;
          if (pinnedClosure > MAX_PINNED_CLOSURE) {
            throw new Error('This setup job reads too many files to keep fixed.');
          }
          filePins.add(resolved);
        }
        queue.push({ file: resolved, ownDirectory: next.ownDirectory });
      } else {
        sharedSetup.add(resolved);
      }
    }
  }

  // Tracked env files in every directory the recipe runs code in, and no new ones.
  const directories = new Set(jobs.filter((job) => job.type !== 'postgres' && job.type !== 'redis').map((job) => job.directory));
  const absent: BugReplayProtectedInput[] = [];
  for (const directory of directories) {
    const present: string[] = [];
    for (const file of files) {
      if (path.posix.dirname(file) === (directory === '.' ? '.' : directory) && isEnvFileName(path.posix.basename(file))) {
        filePins.add(file);
        present.push(file);
      }
    }
    absent.push({ kind: 'absent', directory, present: present.sort() });
  }

  const pins: BugReplayProtectedInput[] = [];
  const entries = await blobEntries([...filePins], tree);
  for (const file of [...filePins].sort()) {
    const blob = entries.get(file);
    if (blob) pins.push({ kind: 'file', path: file, blob });
  }
  for (const member of [...memberPins.values()].sort((left, right) => `${left.path}${left.pointer}`.localeCompare(`${right.path}${right.pointer}`))) {
    pins.push({ kind: 'jsonMember', path: member.path, pointer: member.pointer, valueSha256: await memberDigest(tree, member.path, member.pointer) });
  }
  pins.push(...absent);
  return { pins, sharedSetup: [...sharedSetup].sort().slice(0, 50), unresolved: [...unresolved].sort().slice(0, 20) };
}

/** Pins whose input differs in `tree`, as paths in the product's words. */
export async function changedProtectedInputs(pins: BugReplayProtectedInput[], tree: ReplayTreeReader): Promise<string[]> {
  const changed = new Set<string>();
  const filePins = pins.filter((pin): pin is Extract<BugReplayProtectedInput, { kind: 'file' }> => pin.kind === 'file');
  const entries = await blobEntries(filePins.map((pin) => pin.path), tree);
  for (const pin of filePins) if (entries.get(pin.path) !== pin.blob) changed.add(pin.path);
  for (const pin of pins) {
    if (pin.kind === 'jsonMember') {
      if ((await memberDigest(tree, pin.path, pin.pointer)) !== pin.valueSha256) changed.add(`${pin.path} (${pin.pointer.slice(1).replace(/\//g, '.')})`);
    } else if (pin.kind === 'absent') {
      for (const file of tree.files) {
        const inDirectory = path.posix.dirname(file) === (pin.directory === '.' ? '.' : pin.directory);
        if (inDirectory && isEnvFileName(path.posix.basename(file)) && !pin.present.includes(file)) changed.add(file);
      }
    }
  }
  return [...changed].sort();
}

/**
 * An env file an app reads at start: `.env` and `.env.<name>`. Examples, samples and templates are
 * documentation, so editing one changes nothing a clean run uses.
 */
export function isEnvFileName(name: string): boolean {
  return /^\.env(?:\.[\w.-]+)?$/.test(name) && !/\.(?:example|sample|template)$/.test(name);
}

/** Files under migration and schema directories that differ between two trees. */
export function schemaPaths(files: readonly string[]): string[] {
  return files.filter((file) => /(?:^|\/)(?:migrations?|migrate|prisma\/schema\.prisma|schema\.prisma|db\/schema\.rb|drizzle)(?:\/|$)/.test(file));
}

async function blobEntries(paths: string[], tree: ReplayTreeReader): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const file of paths) {
    const text = await tree.readText(file);
    if (text === undefined) continue;
    result.set(file, gitBlobId(text));
  }
  return result;
}

/** Git's blob id for UTF-8 text, so pins compare the same way `git ls-tree` would. */
export function gitBlobId(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function memberDigest(tree: ReplayTreeReader, manifestPath: string, pointer: string): Promise<string | null> {
  const manifest = safeJson(await tree.readText(manifestPath));
  const value = manifest === undefined ? undefined : readJsonPointer(manifest, pointer);
  return value === undefined ? null : createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function scriptName(tool: string, argv: string[]): string | undefined {
  const args = argv.slice(1).filter((argument, index, all) => {
    if (argument.startsWith('-')) return false;
    const previous = all[index - 1];
    return !(previous === '-w' || previous === '--workspace' || previous === '--filter' || previous === '-F' || previous === '--prefix' || previous === '-C');
  });
  if (args[0] === 'run' || args[0] === 'run-script') return args[1];
  if (tool === 'npm') return args[0] === 'start' || args[0] === 'test' ? args[0] : undefined;
  if (['install', 'i', 'add', 'exec', 'x', 'dlx', 'ci'].includes(args[0] ?? '')) return undefined;
  return args[0];
}

function workspaceTarget(argv: string[], packages: Map<string, string>): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = flag.includes('=') ? flag.split('=')[1] : argv[index + 1];
    if (['-w', '--workspace', '--filter', '-F'].includes(flag.split('=')[0]) && value) {
      return packages.get(value) ?? (packages.has(value.replace(/^\.\//, '')) ? packages.get(value.replace(/^\.\//, '')) : value.replace(/^\.\//, ''));
    }
  }
  return undefined;
}

async function workspacePackages(tree: ReplayTreeReader): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  const manifests = tree.files.filter((file) => file.endsWith('package.json') && !file.includes('node_modules/')).slice(0, 200);
  for (const manifest of manifests) {
    const parsed = safeJson(await tree.readText(manifest)) as { name?: unknown } | undefined;
    const directory = path.posix.dirname(manifest);
    if (typeof parsed?.name === 'string') packages.set(parsed.name, directory);
    packages.set(directory, directory);
  }
  return packages;
}

/** The directory a seed entry owns: its own folder, unless that folder is a package root. */
function setupDirectory(file: string, files: Set<string>): string | undefined {
  const directory = path.posix.dirname(file);
  if (directory === '.' || files.has(`${directory}/package.json`)) return undefined;
  return directory;
}

interface PathAliases {
  baseDirectory: string;
  entries: Array<{ prefix: string; targets: string[] }>;
}

async function readPathAliases(tree: ReplayTreeReader): Promise<PathAliases[]> {
  const aliases: PathAliases[] = [];
  for (const config of tree.files.filter((file) => /(?:^|\/)(?:tsconfig|jsconfig)\.json$/.test(file) && !file.includes('node_modules/')).slice(0, 20)) {
    const parsed = safeJson(stripJsonComments((await tree.readText(config)) ?? '')) as { compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> } } | undefined;
    const options = parsed?.compilerOptions;
    if (!options?.paths) continue;
    const directory = path.posix.dirname(config);
    const baseDirectory = path.posix.normalize(path.posix.join(directory, typeof options.baseUrl === 'string' ? options.baseUrl : '.'));
    aliases.push({
      baseDirectory,
      entries: Object.entries(options.paths)
        .filter(([key, value]) => key.endsWith('/*') && Array.isArray(value))
        .map(([key, value]) => ({
          prefix: key.slice(0, -1),
          targets: (value as unknown[]).filter((target): target is string => typeof target === 'string' && target.endsWith('/*')).map((target) => target.slice(0, -1))
        }))
    });
  }
  return aliases;
}

function resolveImport(
  from: string,
  specifier: string,
  files: Set<string>,
  aliases: PathAliases[],
  packages: Map<string, string>
): string | undefined | 'external' {
  if (specifier.startsWith('node:')) return 'external';
  if (specifier.startsWith('.')) return resolveFile(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)), files);
  for (const alias of aliases) {
    for (const entry of alias.entries) {
      if (!specifier.startsWith(entry.prefix)) continue;
      for (const target of entry.targets) {
        const resolved = resolveFile(path.posix.normalize(path.posix.join(alias.baseDirectory, target, specifier.slice(entry.prefix.length))), files);
        if (resolved) return resolved;
      }
      return undefined;
    }
  }
  const [scopeOrName, maybeName, ...rest] = specifier.split('/');
  const name = scopeOrName.startsWith('@') ? `${scopeOrName}/${maybeName}` : scopeOrName;
  const remainder = scopeOrName.startsWith('@') ? rest : [maybeName, ...rest].filter(Boolean);
  const workspace = packages.get(name);
  if (workspace && workspace !== '.') {
    return resolveFile(path.posix.join(workspace, ...(remainder.length ? remainder : ['index'])), files) ?? resolveFile(path.posix.join(workspace, 'src', 'index'), files);
  }
  return 'external';
}

function resolveFile(base: string, files: Set<string>): string | undefined {
  if (files.has(base)) return base;
  for (const extension of [...CODE_EXTENSIONS, '.json']) if (files.has(`${base}${extension}`)) return `${base}${extension}`;
  for (const extension of CODE_EXTENSIONS) if (files.has(`${base}/index${extension}`)) return `${base}/index${extension}`;
  const withoutJs = base.replace(/\.(?:js|mjs|cjs)$/, '');
  if (withoutJs !== base) for (const extension of ['.ts', '.tsx', '.mts', '.cts']) if (files.has(`${withoutJs}${extension}`)) return `${withoutJs}${extension}`;
  return undefined;
}

/** Module specifiers of static imports, re-exports, dynamic imports and requires. */
export function importSpecifiers(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g,
    /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found].slice(0, 200);
}

function shellWords(text: string): string[] {
  const words: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3]);
  return words.filter((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
}

function joinRelative(directory: string, relative: string): string {
  return path.posix.normalize(directory === '.' ? relative : `${directory}/${relative}`).replace(/^\.\//, '');
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
}

function safeJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
