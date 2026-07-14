export const PREVIEW_FRAMEWORK_CAPABILITIES_VERSION =
  'task-monki-preview-framework-capabilities/v1' as const;

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
  knowledgeVersion: 'nextjs-cli-15-16/v1';
  sourcePath: 'package.json';
  detectedVersion: string;
  scriptName: 'dev';
  repositoryCommand: string;
  scriptCommand: string[];
  portBinding: { type: 'environment'; name: 'PORT' };
  upstreamProtocol: 'http';
  conflicts: PreviewFrameworkConflict[];
  compatiblePreviewCommand?: string[];
  yamlCommentLines?: string[];
  limitation?: string;
}

export interface PreviewFrameworkCapabilities {
  schemaVersion: typeof PREVIEW_FRAMEWORK_CAPABILITIES_VERSION;
  analyses: PreviewFrameworkCapability[];
}

interface EvidenceFile {
  path: string;
  content: string;
}

const SUPPORTED_NEXT_VERSION =
  /^(?:\^|~)?(?:15|16)(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/;
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

/**
 * Converts sanitized repository facts into narrowly versioned runtime facts.
 * The result is safe to trust as Task Monki capability evidence; the agent
 * never needs to infer framework CLI behavior from model knowledge.
 */
export function analyzePreviewFrameworkCapabilities(
  files: readonly EvidenceFile[]
): PreviewFrameworkCapabilities {
  const packageFile = files.find((file) => file.path === 'package.json');
  const analysis = packageFile ? analyzeNextPackage(packageFile.content) : undefined;
  return {
    schemaVersion: PREVIEW_FRAMEWORK_CAPABILITIES_VERSION,
    analyses: analysis ? [analysis] : []
  };
}

function analyzeNextPackage(content: string): PreviewFrameworkCapability | undefined {
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

  const packageRunner = packageManager(packageJson.packageManager);
  const base: PreviewFrameworkCapability = {
    framework: 'nextjs',
    knowledgeVersion: 'nextjs-cli-15-16/v1',
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
  if (conflicts.length === 0) {
    return { ...base, conflicts, compatiblePreviewCommand: base.scriptCommand };
  }

  const compatiblePreviewCommand = directNextCommand(packageRunner, analyzed.preservedArguments);
  if (!compatiblePreviewCommand) {
    return {
      ...base,
      conflicts,
      limitation: `Task Monki does not have a trusted direct Next.js command for package manager ${packageRunner}.`
    };
  }
  return {
    ...base,
    conflicts,
    compatiblePreviewCommand,
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

function directNextCommand(packageRunner: string, preservedArguments: string[]): string[] | undefined {
  const nextArguments = ['next', 'dev', ...preservedArguments, '--hostname', '127.0.0.1'];
  if (packageRunner === 'npm') return ['npm', 'exec', '--offline', '--', ...nextArguments];
  if (packageRunner === 'pnpm') return ['pnpm', 'exec', ...nextArguments];
  if (packageRunner === 'yarn') return ['yarn', 'exec', ...nextArguments];
  return undefined;
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

function packageManager(value: unknown): string {
  if (typeof value !== 'string') return 'npm';
  const name = value.split('@', 1)[0].trim();
  return ['npm', 'pnpm', 'yarn'].includes(name) ? name : 'npm';
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
