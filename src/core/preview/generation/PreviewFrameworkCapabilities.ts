import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PREVIEW_FRAMEWORK_CAPABILITIES_VERSION =
  'task-monki-preview-framework-capabilities/v2' as const;

export type PreviewFrameworkConflictCode =
  | 'FIXED_PORT'
  | 'HTTPS_LISTENER'
  | 'INCOMPATIBLE_HOST'
  | 'UNSUPPORTED_SCRIPT';

export interface PreviewFrameworkConflict {
  code: PreviewFrameworkConflictCode;
  argument: string;
  detail: string;
}

export interface PreviewFrameworkCapability {
  framework: 'nextjs';
  knowledgeVersion: 'nextjs-cli-15-16/v2';
  sourcePath: 'package.json';
  detectedVersion: string;
  lockedVersion?: string;
  scriptName: 'dev';
  repositoryCommand: string;
  scriptCommand: string[];
  portBinding: { type: 'environment'; name: 'PORT' };
  upstreamProtocol: 'http';
  conflicts: PreviewFrameworkConflict[];
  dependencyPreparation?: PreviewFrameworkDependencyPreparation;
  compatiblePreviewCommand?: string[];
  yamlCommentLines?: string[];
  limitation?: string;
}

export interface PreviewFrameworkDependencyPreparation {
  packageManager: 'npm';
  lockfilePath: 'package-lock.json';
  lockfileVersion: 2 | 3;
  cwd: '.';
  installCommand: string[];
  installCommandMayRunLifecycleScripts: true;
  repositoryLifecycleScripts: string[];
  yamlCommentLines: string[];
}

export interface PreviewFrameworkCapabilities {
  schemaVersion: typeof PREVIEW_FRAMEWORK_CAPABILITIES_VERSION;
  analyses: PreviewFrameworkCapability[];
}

interface EvidenceFile {
  path: string;
  content: string;
}

type PreviewNpmPackageLockFact =
  | {
      status: 'VALID';
      path: 'package-lock.json';
      lockfileVersion: 2 | 3;
      rootNextSpec?: string;
      lockedNextVersion?: string;
    }
  | {
      status: 'MISSING' | 'UNSAFE' | 'OVERSIZED' | 'INVALID' | 'UNSUPPORTED';
      path: 'package-lock.json';
    };

export interface PreviewFrameworkRepositoryFacts {
  rootLockfiles: readonly ('package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock')[];
  npmPackageLock: PreviewNpmPackageLockFact;
}

const EMPTY_REPOSITORY_FACTS: PreviewFrameworkRepositoryFacts = {
  rootLockfiles: [],
  npmPackageLock: { status: 'MISSING', path: 'package-lock.json' }
};

const SUPPORTED_NEXT_VERSION =
  /^(?:\^|~)?(?:15|16)(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/;
const SUPPORTED_LOCKED_NEXT_VERSION = /^(?:15|16)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_NEXT_DEV_FLAGS = new Set([
  '--disable-source-maps',
  '--no-server-fast-refresh',
  '--turbo',
  '--turbopack',
  '--webpack'
]);
const HTTPS_VALUE_FLAGS = new Set([
  '--experimental-https-key',
  '--experimental-https-cert',
  '--experimental-https-ca'
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);
const MAX_PACKAGE_LOCK_BYTES = 16 * 1024 * 1024;
const NPM_INSTALL_COMMAND = ['npm', 'ci', '--no-audit', '--no-fund'];
const NPM_INSTALL_COMMENT_LINES = [
  '# Installs exactly from package-lock.json inside this captured Preview generation.',
  '# npm may run repository and dependency lifecycle scripts.'
];
const NPM_INSTALL_LIFECYCLE_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare'
] as const;

/**
 * Converts sanitized repository facts into narrowly versioned runtime facts.
 * The result is safe to trust as Task Monki capability evidence; the agent
 * never needs to infer framework CLI behavior from model knowledge.
 */
export function analyzePreviewFrameworkCapabilities(
  files: readonly EvidenceFile[],
  repositoryFacts: PreviewFrameworkRepositoryFacts = EMPTY_REPOSITORY_FACTS
): PreviewFrameworkCapabilities {
  const packageFile = files.find((file) => file.path === 'package.json');
  const analysis = packageFile
    ? analyzeNextPackage(packageFile.content, repositoryFacts)
    : undefined;
  return {
    schemaVersion: PREVIEW_FRAMEWORK_CAPABILITIES_VERSION,
    analyses: analysis ? [analysis] : []
  };
}

export async function inspectPreviewFrameworkRepositoryFacts(
  repositoryPath: string
): Promise<PreviewFrameworkRepositoryFacts> {
  const root = await fs.realpath(path.resolve(repositoryPath));
  const states = await Promise.all(
    (['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const).map(async (name) => ({
      name,
      state: await inspectRootFile(path.join(root, name))
    }))
  );
  const rootLockfiles = states
    .filter((entry) => entry.state === 'REGULAR')
    .map((entry) => entry.name);
  const packageLockState = states.find((entry) => entry.name === 'package-lock.json')?.state;
  return {
    rootLockfiles,
    npmPackageLock:
      packageLockState === 'REGULAR'
        ? await readNpmPackageLockFact(path.join(root, 'package-lock.json'))
        : {
            status: packageLockState === 'MISSING' ? 'MISSING' : 'UNSAFE',
            path: 'package-lock.json'
          }
  };
}

function analyzeNextPackage(
  content: string,
  repositoryFacts: PreviewFrameworkRepositoryFacts
): PreviewFrameworkCapability | undefined {
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const version = dependencyVersion(packageJson, 'next');
  const scripts = record(packageJson.scripts);
  const script = scripts && typeof scripts.dev === 'string' ? scripts.dev.trim() : '';
  if (!version || !script) return undefined;

  const packageRunner = packageManager(packageJson.packageManager, repositoryFacts.rootLockfiles);
  const base: PreviewFrameworkCapability = {
    framework: 'nextjs',
    knowledgeVersion: 'nextjs-cli-15-16/v2',
    sourcePath: 'package.json',
    detectedVersion: version,
    scriptName: 'dev',
    repositoryCommand: script,
    scriptCommand: [packageRunner, 'run', 'dev'],
    portBinding: { type: 'environment', name: 'PORT' },
    upstreamProtocol: 'http',
    conflicts: []
  };
  if (!SUPPORTED_NEXT_VERSION.test(version)) {
    return {
      ...base,
      conflicts: [unsupportedScript(version)],
      limitation: `Next.js version ${version} is outside the trusted 15-16 capability range.`
    };
  }

  const tokens = tokenizeSimpleCommand(script);
  if (!tokens || tokens[0] !== 'next' || tokens[1] !== 'dev') {
    return {
      ...base,
      conflicts: [unsupportedScript(script)],
      limitation: 'The dev script is not a direct, safely analyzable next dev command.'
    };
  }

  const analyzed = analyzeNextDevArguments(tokens.slice(2));
  const conflicts = analyzed.conflicts;
  if (!analyzed.rewriteSafe) {
    return {
      ...base,
      conflicts,
      limitation: 'At least one development argument cannot be safely translated to the HTTP Preview runtime.'
    };
  }
  const preparation = npmDependencyPreparation(
    packageJson,
    version,
    packageRunner,
    repositoryFacts.npmPackageLock
  );
  if ('limitation' in preparation) {
    return { ...base, conflicts, limitation: preparation.limitation };
  }
  if (conflicts.length === 0) {
    return {
      ...base,
      lockedVersion: preparation.lockedVersion,
      conflicts,
      dependencyPreparation: preparation.value,
      compatiblePreviewCommand: base.scriptCommand
    };
  }

  return {
    ...base,
    lockedVersion: preparation.lockedVersion,
    conflicts,
    dependencyPreparation: preparation.value,
    compatiblePreviewCommand: directNextCommand(analyzed.preservedArguments),
    yamlCommentLines: previewCommandComment(conflicts)
  };
}

function analyzeNextDevArguments(arguments_: string[]): {
  conflicts: PreviewFrameworkConflict[];
  preservedArguments: string[];
  rewriteSafe: boolean;
} {
  const conflicts: PreviewFrameworkConflict[] = [];
  const preservedArguments: string[] = [];
  let rewriteSafe = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (SAFE_NEXT_DEV_FLAGS.has(argument)) {
      preservedArguments.push(argument);
      continue;
    }
    const inlinePort = /^(?:--port=|-p=?)(\d+)$/.exec(argument);
    if (inlinePort) {
      conflicts.push(fixedPort(argument, inlinePort[1]));
      continue;
    }
    if (argument === '--port' || argument === '-p') {
      const value = arguments_[index + 1];
      if (!validPort(value)) {
        conflicts.push(unsupportedArgument(argument));
        rewriteSafe = false;
      } else {
        conflicts.push(fixedPort(`${argument} ${value}`, value));
        index += 1;
      }
      continue;
    }
    if (argument === '--experimental-https') {
      conflicts.push(httpsListener(argument));
      continue;
    }
    if (HTTPS_VALUE_FLAGS.has(argument)) {
      conflicts.push(httpsListener(argument));
      if (arguments_[index + 1] && !arguments_[index + 1].startsWith('-')) index += 1;
      continue;
    }
    const inlineHttpsValue = /^(--experimental-https-(?:key|cert|ca))=/.exec(argument);
    if (inlineHttpsValue) {
      conflicts.push(httpsListener(inlineHttpsValue[1]));
      continue;
    }
    const inlineHost = /^--hostname=(.+)$/.exec(argument);
    if (inlineHost) {
      if (!LOOPBACK_HOSTS.has(inlineHost[1])) conflicts.push(incompatibleHost(argument));
      continue;
    }
    if (argument === '--hostname' || argument === '-H') {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('-')) {
        conflicts.push(unsupportedArgument(argument));
        rewriteSafe = false;
      } else {
        if (!LOOPBACK_HOSTS.has(value)) conflicts.push(incompatibleHost(`${argument} ${value}`));
        index += 1;
      }
      continue;
    }
    if (isSafeRelativeDirectory(argument) && !preservedArguments.some((item) => !item.startsWith('-'))) {
      preservedArguments.push(argument);
      continue;
    }
    conflicts.push(unsupportedArgument(argument));
    rewriteSafe = false;
  }
  return { conflicts, preservedArguments, rewriteSafe };
}

function directNextCommand(preservedArguments: string[]): string[] {
  return [
    './node_modules/.bin/next',
    'dev',
    ...preservedArguments,
    '--hostname',
    '127.0.0.1'
  ];
}

function previewCommandComment(conflicts: PreviewFrameworkConflict[]): string[] {
  const port = conflicts.find((conflict) => conflict.code === 'FIXED_PORT')?.detail.match(/\b(\d+)\b/)?.[1];
  const https = conflicts.some((conflict) => conflict.code === 'HTTPS_LISTENER');
  if (port && https) {
    return [
      `# The repository's existing development script pins port ${port} and enables`,
      '# HTTPS. This Preview command intentionally uses standard HTTP and Task',
      "# Monki's dynamically allocated port."
    ];
  }
  if (port) {
    return [
      `# The repository's existing development script pins port ${port}. This`,
      "# Preview command intentionally uses Task Monki's dynamically allocated port."
    ];
  }
  if (https) {
    return [
      '# The repository\'s existing development script enables HTTPS. This Preview',
      "# command intentionally uses standard HTTP and Task Monki's allocated port."
    ];
  }
  return [
    '# The repository\'s development listener conflicts with Preview. This command',
    "# intentionally uses standard HTTP on Task Monki's allocated loopback port."
  ];
}

function dependencyVersion(packageJson: Record<string, unknown>, name: string): string | undefined {
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const dependencies = record(packageJson[field]);
    const value = dependencies?.[name];
    if (typeof value === 'string' && value.length <= 128) return value.trim();
  }
  return undefined;
}

function packageManager(
  value: unknown,
  lockfiles: PreviewFrameworkRepositoryFacts['rootLockfiles']
): string {
  if (typeof value === 'string' && value.trim()) {
    const match = /^([a-z0-9][a-z0-9-]*)(?:@.+)?$/i.exec(value.trim());
    return match?.[1].toLowerCase() ?? 'unsupported';
  }
  const managers = new Set(lockfiles.map((lockfile) =>
    lockfile === 'package-lock.json' ? 'npm' : lockfile === 'pnpm-lock.yaml' ? 'pnpm' : 'yarn'
  ));
  if (managers.size > 1) return 'ambiguous';
  return [...managers][0] ?? 'npm';
}

function npmDependencyPreparation(
  packageJson: Record<string, unknown>,
  declaredVersion: string,
  packageRunner: string,
  packageLock: PreviewNpmPackageLockFact
):
  | { value: PreviewFrameworkDependencyPreparation; lockedVersion: string }
  | { limitation: string } {
  if (packageRunner === 'ambiguous') {
    return { limitation: 'Multiple root package-manager lockfiles are present without an explicit packageManager declaration.' };
  }
  if (packageRunner !== 'npm') {
    return {
      limitation: `Task Monki does not have a trusted lockfile installation profile for package manager ${packageRunner}.`
    };
  }
  if (packageLock.status !== 'VALID') {
    const reason =
      packageLock.status === 'MISSING' ? 'is missing' :
      packageLock.status === 'OVERSIZED' ? 'exceeds the bounded inspection limit' :
      packageLock.status === 'UNSUPPORTED' ? 'uses an unsupported lockfile version' :
      packageLock.status === 'UNSAFE' ? 'is not a safe regular file' :
      'could not be safely validated';
    return {
      limitation: `The root package-lock.json ${reason}; Task Monki cannot prove a deterministic dependency installation command.`
    };
  }
  if (packageLock.rootNextSpec !== declaredVersion || !packageLock.lockedNextVersion) {
    return {
      limitation: 'package-lock.json does not consistently lock the root Next.js dependency declared by package.json.'
    };
  }
  if (!SUPPORTED_LOCKED_NEXT_VERSION.test(packageLock.lockedNextVersion)) {
    return {
      limitation: 'The locked Next.js version is outside the trusted 15-16 capability range.'
    };
  }
  const scripts = record(packageJson.scripts);
  return {
    lockedVersion: packageLock.lockedNextVersion,
    value: {
      packageManager: 'npm',
      lockfilePath: 'package-lock.json',
      lockfileVersion: packageLock.lockfileVersion,
      cwd: '.',
      installCommand: [...NPM_INSTALL_COMMAND],
      installCommandMayRunLifecycleScripts: true,
      repositoryLifecycleScripts: NPM_INSTALL_LIFECYCLE_SCRIPTS.filter(
        (name) => typeof scripts?.[name] === 'string' && Boolean((scripts[name] as string).trim())
      ),
      yamlCommentLines: [...NPM_INSTALL_COMMENT_LINES]
    }
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenizeSimpleCommand(command: string): string[] | undefined {
  if (!command || command.length > 2_048 || /[\r\n;&|<>`$()]/.test(command)) return undefined;
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = () => {
    if (token) tokens.push(token);
    token = '';
  };
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      push();
    } else {
      token += character;
    }
  }
  if (escaped || quote) return undefined;
  push();
  return tokens;
}

function validPort(value: string | undefined): value is string {
  if (!value || !/^\d+$/.test(value)) return false;
  const number = Number(value);
  return number >= 1 && number <= 65_535;
}

function isSafeRelativeDirectory(value: string): boolean {
  return value === '.' || (
    !value.startsWith('-') &&
    !value.startsWith('/') &&
    !value.split('/').includes('..') &&
    /^[A-Za-z0-9._/-]{1,256}$/.test(value)
  );
}

function fixedPort(argument: string, port: string): PreviewFrameworkConflict {
  return { code: 'FIXED_PORT', argument, detail: `The script pins listener port ${port}.` };
}

function httpsListener(argument: string): PreviewFrameworkConflict {
  return { code: 'HTTPS_LISTENER', argument, detail: 'The script enables an HTTPS listener.' };
}

function incompatibleHost(argument: string): PreviewFrameworkConflict {
  return {
    code: 'INCOMPATIBLE_HOST',
    argument,
    detail: 'The explicit hostname is not reachable through the loopback-only Preview gateway.'
  };
}

function unsupportedArgument(argument: string): PreviewFrameworkConflict {
  return {
    code: 'UNSUPPORTED_SCRIPT',
    argument,
    detail: 'The argument is outside the trusted Next.js Preview capability profile.'
  };
}

function unsupportedScript(argument: string): PreviewFrameworkConflict {
  return {
    code: 'UNSUPPORTED_SCRIPT',
    argument,
    detail: 'The development script cannot be safely translated by the trusted Next.js capability profile.'
  };
}

async function inspectRootFile(
  filePath: string
): Promise<'MISSING' | 'REGULAR' | 'UNSAFE'> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() ? 'REGULAR' : 'UNSAFE';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'UNSAFE';
  }
}

async function readNpmPackageLockFact(filePath: string): Promise<PreviewNpmPackageLockFact> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { status: 'UNSAFE', path: 'package-lock.json' };
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { status: 'UNSAFE', path: 'package-lock.json' };
    if (before.size > MAX_PACKAGE_LOCK_BYTES) {
      return { status: 'OVERSIZED', path: 'package-lock.json' };
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      return { status: 'INVALID', path: 'package-lock.json' };
    }
    if (bytes.includes(0)) return { status: 'INVALID', path: 'package-lock.json' };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      ) as Record<string, unknown>;
    } catch {
      return { status: 'INVALID', path: 'package-lock.json' };
    }
    const lockfileVersion = parsed.lockfileVersion;
    if (lockfileVersion !== 2 && lockfileVersion !== 3) {
      return { status: 'UNSUPPORTED', path: 'package-lock.json' };
    }
    const packages = record(parsed.packages);
    const rootPackage = record(packages?.['']);
    const lockedNext = record(packages?.['node_modules/next']);
    const rootNextSpec = rootPackage ? dependencyVersion(rootPackage, 'next') : undefined;
    const lockedNextVersion =
      typeof lockedNext?.version === 'string' && lockedNext.version.length <= 128
        ? lockedNext.version.trim()
        : undefined;
    return {
      status: 'VALID',
      path: 'package-lock.json',
      lockfileVersion,
      rootNextSpec,
      lockedNextVersion
    };
  } finally {
    await handle.close();
  }
}
