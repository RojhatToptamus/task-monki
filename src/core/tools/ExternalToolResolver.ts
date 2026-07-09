import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExternalExecutablePathSettings } from '../../shared/agent';
import type {
  ExternalToolId,
  ExternalToolProbeResult,
  ExternalToolResolutionSource,
  ExternalToolStatusReport,
  TestExternalToolRequest
} from '../../shared/contracts';
import { TASK_MONKI_CODEX_BIN_ENV } from '../agent/codex/CodexRuntimeResolver';
import { execFilePortable } from '../process/portableChildProcess';

const TOOL_DEFINITIONS: Record<
  ExternalToolId,
  {
    label: string;
    command: string;
    required: boolean;
    versionArgs: string[];
    envVar: string;
    settingKey: keyof ExternalExecutablePathSettings;
  }
> = {
  git: {
    label: 'Git',
    command: 'git',
    required: true,
    versionArgs: ['--version'],
    envVar: 'TASK_MANAGER_GIT_PATH',
    settingKey: 'gitExecutablePath'
  },
  codex: {
    label: 'Codex CLI',
    command: 'codex',
    required: true,
    versionArgs: ['--version'],
    envVar: TASK_MONKI_CODEX_BIN_ENV,
    settingKey: 'codexExecutablePath'
  },
  gh: {
    label: 'GitHub CLI',
    command: 'gh',
    required: false,
    versionArgs: ['--version'],
    envVar: 'TASK_MANAGER_GH_PATH',
    settingKey: 'ghExecutablePath'
  }
};

export interface ExternalToolResolverOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<Record<ExternalToolId, string | null | undefined>>;
}

export class ExternalToolResolver {
  constructor(private readonly options: ExternalToolResolverOptions = {}) {}

  async getStatus(settings: ExternalExecutablePathSettings): Promise<ExternalToolStatusReport> {
    const [git, codex, gh] = await Promise.all([
      this.probe('git', settings),
      this.probe('codex', settings),
      this.probe('gh', settings)
    ]);
    return {
      tools: { git, codex, gh },
      refreshedAt: new Date().toISOString()
    };
  }

  probe(
    tool: ExternalToolId,
    settings: ExternalExecutablePathSettings,
    request: TestExternalToolRequest = { tool }
  ): Promise<ExternalToolProbeResult> {
    const definition = TOOL_DEFINITIONS[tool];
    const configured = resolveConfiguredExecutable({
      tool,
      settings,
      request,
      env: this.options.env ?? process.env,
      overrides: this.options.overrides
    });
    return probeExecutable({
      tool,
      label: definition.label,
      required: definition.required,
      executable: configured.executable,
      configuredPath: configured.configuredPath,
      source: configured.source,
      versionArgs: definition.versionArgs,
      cwd: this.options.cwd ?? process.cwd(),
      env: this.options.env ?? process.env
    });
  }
}

export async function probeExecutable(input: {
  tool: ExternalToolId;
  label: string;
  required: boolean;
  executable: string;
  configuredPath: string | null;
  source: ExternalToolResolutionSource;
  versionArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ExternalToolProbeResult> {
  const resolvedPath = await resolveExecutablePath(input.executable, input.env);
  try {
    const { stdout, stderr } = await execFilePortable(input.executable, input.versionArgs, {
      cwd: input.cwd,
      env: input.env,
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    return {
      tool: input.tool,
      label: input.label,
      required: input.required,
      source: input.source,
      configuredPath: input.configuredPath,
      executable: input.executable,
      resolvedPath,
      status: 'ok',
      version: firstOutputLine(stdout || stderr),
      error: null
    };
  } catch (error) {
    return {
      tool: input.tool,
      label: input.label,
      required: input.required,
      source: input.source,
      configuredPath: input.configuredPath,
      executable: input.executable,
      resolvedPath,
      status: 'error',
      version: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function resolveConfiguredExecutable(input: {
  tool: ExternalToolId;
  settings: ExternalExecutablePathSettings;
  request?: TestExternalToolRequest;
  env: NodeJS.ProcessEnv;
  overrides?: Partial<Record<ExternalToolId, string | null | undefined>>;
}): {
  executable: string;
  configuredPath: string | null;
  source: ExternalToolResolutionSource;
} {
  const definition = TOOL_DEFINITIONS[input.tool];
  const requestedPath =
    input.request && 'executablePath' in input.request
      ? normalizePath(input.request.executablePath)
      : undefined;
  if (requestedPath !== undefined) {
    if (requestedPath) {
      return {
        executable: requestedPath,
        configuredPath: requestedPath,
        source: 'override'
      };
    }
  }

  const envPath = normalizePath(input.env[definition.envVar]);
  if (envPath) {
    return {
      executable: envPath,
      configuredPath: envPath,
      source: 'env'
    };
  }

  const overridePath = normalizePath(input.overrides?.[input.tool]);
  if (overridePath) {
    return {
      executable: overridePath,
      configuredPath: overridePath,
      source: 'override'
    };
  }

  const settingsPath = normalizePath(input.settings[definition.settingKey]);
  if (settingsPath) {
    return {
      executable: settingsPath,
      configuredPath: settingsPath,
      source: 'settings'
    };
  }

  return {
    executable: definition.command,
    configuredPath: null,
    source: 'auto'
  };
}

async function resolveExecutablePath(
  executable: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    return executable;
  }

  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = candidateExecutableNames(executable, env);
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function candidateExecutableNames(executable: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32' || path.extname(executable)) {
    return [executable];
  }
  const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [executable, ...extensions.map((extension) => `${executable}${extension}`)];
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstOutputLine(output: string): string | null {
  return output.trim().split(/\r?\n/)[0]?.trim() || null;
}

function normalizePath(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
