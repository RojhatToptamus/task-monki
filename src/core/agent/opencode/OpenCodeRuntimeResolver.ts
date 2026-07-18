import { access } from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import type { AgentRuntimeResolutionDiagnostics } from '../../../shared/agent';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import { execFilePortable } from '../../process/portableChildProcess';

export const OPENCODE_RUNTIME_ID = 'opencode' as const;
export const TASK_MONKI_OPENCODE_BIN_ENV = 'TASK_MONKI_OPENCODE_BIN';
export const MINIMUM_OPENCODE_VERSION = '1.4.0';
export const MAXIMUM_OPENCODE_MAJOR = 1;

export const REQUIRED_OPENCODE_HTTP_CAPABILITIES = [
  'GET /global/health',
  'GET /provider',
  'GET /event (SSE)',
  'POST /session',
  'GET /session/{id}',
  'DELETE /session/{id}',
  'GET /session/{id}/message',
  'POST /session/{id}/fork',
  'POST /session/{id}/prompt_async',
  'POST /session/{id}/abort',
  'GET /permission',
  'POST /permission/{requestID}/reply',
  'GET /question',
  'POST /question/{requestID}/reply'
] as const;

export interface OpenCodeRuntimeResolverOptions {
  executable?: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  minimumVersion?: string;
  maximumMajor?: number;
}

export interface ResolvedOpenCodeRuntime {
  executable: string;
  version: string;
  source: 'config' | 'environment' | 'path';
  diagnostics: AgentRuntimeResolutionDiagnostics;
}

export class OpenCodeRuntimeResolutionError extends Error {
  constructor(readonly diagnostics: AgentRuntimeResolutionDiagnostics) {
    super(formatResolutionError(diagnostics));
    this.name = 'OpenCodeRuntimeResolutionError';
  }
}

export async function resolveOpenCodeRuntime(
  options: OpenCodeRuntimeResolverOptions
): Promise<ResolvedOpenCodeRuntime> {
  const environment = options.environment ?? process.env;
  const configured = options.executable?.trim();
  const fromEnvironment = environment[TASK_MONKI_OPENCODE_BIN_ENV]?.trim();
  const candidates = configured
    ? [{ executable: configured, source: 'config' as const, explicit: true }]
    : fromEnvironment
      ? [{ executable: fromEnvironment, source: 'environment' as const, explicit: true }]
      : await pathCandidates(environment);
  const probes: AgentRuntimeResolutionDiagnostics['probes'] = [];

  for (const candidate of candidates) {
    try {
      const version = await probeOpenCodeVersion(
        candidate.executable,
        options.cwd,
        environment
      );
      const compatible = isCompatibleOpenCodeVersion(
        version,
        options.minimumVersion,
        options.maximumMajor
      );
      const help = compatible
        ? await execFilePortable(candidate.executable, ['serve', '--help'], {
            cwd: options.cwd,
            env: sanitizeEnvironment(environment),
            timeout: 10_000,
            maxBuffer: 1024 * 1024
          })
        : undefined;
      const helpOutput = help ? `${help.stdout}\n${help.stderr}` : '';
      const hasHttpServer = Boolean(
        help &&
          /\bopencode\s+serve\b/u.test(helpOutput) &&
          /--hostname\b/u.test(helpOutput) &&
          /--port\b/u.test(helpOutput)
      );
      const accepted = compatible && hasHttpServer;
      probes.push({
        executable: candidate.executable,
        source: candidate.source,
        explicit: candidate.explicit,
        compatible: accepted,
        version,
        launchArgv: accepted
          ? ['serve', '--hostname', '127.0.0.1', '--port', '<allocated-loopback-port>']
          : undefined,
        launchForm: accepted ? 'native-http-sse' : undefined,
        missingCapabilities: hasHttpServer ? undefined : ['opencode serve --hostname/--port'],
        detail: accepted
          ? `Compatible OpenCode ${version} native HTTP/SSE runtime.`
          : compatible
            ? 'OpenCode does not expose the required headless server flags.'
            : supportedVersionMessage(options.minimumVersion, options.maximumMajor)
      });
      if (accepted) {
        return {
          executable: candidate.executable,
          version,
          source: candidate.source,
          diagnostics: {
            selectedExecutable: candidate.executable,
            selectedSource: candidate.source,
            selectedVersion: version,
            selectedLaunchArgv: [
              'serve',
              '--hostname',
              '127.0.0.1',
              '--port',
              '<allocated-loopback-port>'
            ],
            requiredCapabilities: [...REQUIRED_OPENCODE_HTTP_CAPABILITIES],
            probes
          }
        };
      }
    } catch (cause) {
      probes.push({
        executable: candidate.executable,
        source: candidate.source,
        explicit: candidate.explicit,
        compatible: false,
        detail: errorMessage(cause)
      });
    }
  }

  throw new OpenCodeRuntimeResolutionError({
    selectedExecutable: candidates[0]?.executable ?? 'opencode',
    selectedSource: candidates[0]?.source ?? 'path',
    requiredCapabilities: [...REQUIRED_OPENCODE_HTTP_CAPABILITIES],
    probes
  });
}

export async function probeOpenCodeVersion(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const result = await execFilePortable(executable, ['--version'], {
    cwd,
    env: sanitizeEnvironment(environment),
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  const stdoutVersions = semanticVersionsIn(result.stdout);
  if (stdoutVersions.length === 1) return stdoutVersions[0];
  if (stdoutVersions.length > 1) {
    throw new Error('OpenCode returned an ambiguous version string.');
  }
  const stderrVersions = semanticVersionsIn(result.stderr);
  if (stderrVersions.length !== 1) {
    throw new Error('OpenCode returned an unrecognized version string.');
  }
  return stderrVersions[0];
}

export function isCompatibleOpenCodeVersion(
  version: string,
  minimumVersion = MINIMUM_OPENCODE_VERSION,
  maximumMajor = MAXIMUM_OPENCODE_MAJOR
): boolean {
  const parsed = parseVersion(version);
  const minimum = parseVersion(minimumVersion);
  return parsed.major === maximumMajor && compareVersion(parsed, minimum) >= 0;
}

async function pathCandidates(
  environment: NodeJS.ProcessEnv
): Promise<Array<{ executable: string; source: 'path'; explicit: false }>> {
  const executableNames = process.platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode']
    : ['opencode'];
  const entries = (environment.PATH ?? '').split(path.delimiter).filter(Boolean);
  const resolved: Array<{ executable: string; source: 'path'; explicit: false }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const name of executableNames) {
      const candidate = path.resolve(entry, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        resolved.push({ executable: candidate, source: 'path', explicit: false });
      } catch {
        // Keep searching PATH.
      }
    }
  }
  if (resolved.length === 0) {
    // Let execFile provide the platform-native diagnostic when PATH lookup is
    // unavailable or intentionally virtualized by the host application.
    resolved.push({ executable: 'opencode', source: 'path', explicit: false });
  }
  return resolved;
}

function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersion(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number }
): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function semanticVersionsIn(value: string): string[] {
  const versions = new Set<string>();
  for (const match of value.matchAll(/(?:^|\s)v?(\d+\.\d+\.\d+)(?=[-+\s]|$)/gu)) {
    versions.add(match[1]);
  }
  return [...versions];
}

function supportedVersionMessage(minimum = MINIMUM_OPENCODE_VERSION, maximumMajor = MAXIMUM_OPENCODE_MAJOR): string {
  return `Task Monki requires OpenCode >=${minimum} and <${maximumMajor + 1}.0.0.`;
}

function formatResolutionError(diagnostics: AgentRuntimeResolutionDiagnostics): string {
  if (diagnostics.probes.length === 0) {
    return 'OpenCode was not found. Install OpenCode or configure its executable path.';
  }
  return [
    'No compatible OpenCode native HTTP/SSE runtime was found.',
    ...diagnostics.probes.map((probe) => `${probe.executable}: ${probe.detail}`)
  ].join(' ');
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
