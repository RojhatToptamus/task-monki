import path from 'node:path';
import type { AgentRuntimeResolutionDiagnostics } from '../../../shared/agent';
import { redactProcessDiagnostic } from '../../process/ProcessSupervisor';
import { execFilePortable } from '../../process/portableChildProcess';
import { sensitiveEnvironmentValues } from '../ProviderEnvironmentPolicy';
import type { AcpRuntimeProfile } from './AcpRuntimeProfiles';

const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;
const MAX_PROBE_DIAGNOSTIC_BYTES = 8 * 1024;
const ACP_DISCOVERY_PROBE_TIMEOUT_MS = 5_000;
const PORTABLE_PROBE_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SystemRoot',
  'ComSpec',
  'PATHEXT'
] as const;

export interface AcpRuntimeProbe {
  executable: string;
  source: string;
  explicit: boolean;
  compatible: boolean;
  version?: string;
  detail: string;
}

export interface ResolvedAcpRuntime {
  executable: string;
  version?: string;
  diagnostics: AgentRuntimeResolutionDiagnostics;
}

export interface ResolveAcpRuntimeOptions {
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  cwd: string;
}

export type AcpRuntimeResolutionErrorCode =
  | 'ACP_RUNTIME_NOT_FOUND'
  | 'ACP_RUNTIME_INCOMPATIBLE';

export class AcpRuntimeResolutionError extends Error {
  constructor(
    readonly code: AcpRuntimeResolutionErrorCode,
    readonly diagnostics: AgentRuntimeResolutionDiagnostics,
    displayName: string
  ) {
    super(formatResolutionError(displayName, code, diagnostics));
    this.name = 'AcpRuntimeResolutionError';
  }
}

export async function resolveAcpRuntime(
  profile: AcpRuntimeProfile,
  options: ResolveAcpRuntimeOptions
): Promise<ResolvedAcpRuntime> {
  const environment = options.environment ?? process.env;
  const candidates = options.executable
    ? [{ executable: options.executable, source: 'explicit setting', explicit: true }]
    : profile.executableCandidates.map((executable) => ({
        executable,
        source: 'runtime profile / PATH',
        explicit: false
      }));
  const probes: AcpRuntimeProbe[] = [];
  let foundExecutable = false;
  const probeEnvironment = portableProbeEnvironment(environment);

  for (const candidate of candidates) {
    if (candidate.executable.includes('\0')) {
      probes.push({
        ...candidate,
        compatible: false,
        detail: 'Executable contains a NUL byte.'
      });
      continue;
    }

    let version: string | undefined;
    try {
      const { stdout, stderr } = await execFilePortable(
        candidate.executable,
        [...profile.versionArgv],
        {
          cwd: options.cwd,
          // Discovery runs before provider identity is proven. Never expose
          // provider credentials, configuration roots, or proxy credentials to
          // an arbitrary candidate executable.
          env: probeEnvironment,
          timeout: ACP_DISCOVERY_PROBE_TIMEOUT_MS,
          maxBuffer: MAX_VERSION_OUTPUT_BYTES,
          windowsHide: true
        }
      );
      foundExecutable = true;
      version = firstLine(redactProbeOutput(profile, environment, stdout)) ??
        firstLine(redactProbeOutput(profile, environment, stderr));
    } catch (cause) {
      if (!isExecutableNotFoundError(cause)) foundExecutable = true;
      probes.push({
        executable: normalizeExecutable(candidate.executable),
        source: candidate.source,
        explicit: candidate.explicit,
        compatible: false,
        detail: boundedProbeDiagnostic(
          `Version probe failed: ${redactProbeOutput(
            profile,
            environment,
            errorMessage(cause)
          )}`
        )
      });
      continue;
    }

    try {
      const executable = normalizeExecutable(candidate.executable);
      const contractDetail = await proveLaunchContract(
        profile,
        candidate.executable,
        probeEnvironment,
        options.cwd
      );
      const probe: AcpRuntimeProbe = {
        executable,
        source: candidate.source,
        explicit: candidate.explicit,
        compatible: true,
        version,
        detail: version
          ? `Executable responded to ${profile.versionArgv.join(' ')} with ${version}. ${contractDetail} ACP wire compatibility will be negotiated during initialize.`
          : `Executable responded to the version probe. ${contractDetail} ACP wire compatibility will be negotiated during initialize.`
      };
      probes.push(probe);
      return {
        executable,
        version,
        diagnostics: diagnostics(profile, probe, probes)
      };
    } catch (cause) {
      probes.push({
        executable: normalizeExecutable(candidate.executable),
        source: candidate.source,
        explicit: candidate.explicit,
        compatible: false,
        version,
        detail: boundedProbeDiagnostic(
          redactProbeOutput(profile, environment, errorMessage(cause))
        )
      });
    }
  }

  const failureDiagnostics = diagnosticsForFailure(profile, candidates, probes);
  throw new AcpRuntimeResolutionError(
    foundExecutable ? 'ACP_RUNTIME_INCOMPATIBLE' : 'ACP_RUNTIME_NOT_FOUND',
    failureDiagnostics,
    profile.descriptor.displayName
  );
}

async function proveLaunchContract(
  profile: AcpRuntimeProfile,
  executable: string,
  probeEnvironment: NodeJS.ProcessEnv,
  cwd: string
): Promise<string> {
  const proof = profile.launchContractProbe;
  const { stdout, stderr } = await execFilePortable(executable, [...proof.argv], {
    cwd,
    env: probeEnvironment,
    timeout: ACP_DISCOVERY_PROBE_TIMEOUT_MS,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    windowsHide: true
  });
  const output = `${stdout}\n${stderr}`;
  const missing = proof.requiredOutput
    .filter(({ pattern }) => {
      pattern.lastIndex = 0;
      return !pattern.test(output);
    })
    .map(({ description }) => description);
  if (missing.length > 0) {
    throw new Error(
      `${proof.description} failed; probe output did not prove ${formatList(missing)}.`
    );
  }
  return `${proof.description} succeeded.`;
}

function diagnostics(
  profile: AcpRuntimeProfile,
  selected: AcpRuntimeProbe,
  probes: AcpRuntimeProbe[]
): AgentRuntimeResolutionDiagnostics {
  return {
    selectedExecutable: selected.executable,
    selectedSource: selected.source,
    selectedVersion: selected.version,
    selectedLaunchArgv: [...profile.argv],
    requiredCapabilities: [
      'ACP protocolVersion=1',
      'session/new',
      'session/prompt',
      'session/cancel',
      'session/update'
    ],
    probes: probes.map((probe) => ({
      executable: probe.executable,
      source: probe.source,
      explicit: probe.explicit,
      compatible: probe.compatible,
      version: probe.version,
      launchArgv: [...profile.argv],
      launchForm: `${probe.executable} ${profile.argv.join(' ')}`.trim(),
      detail: probe.detail
    }))
  };
}

function diagnosticsForFailure(
  profile: AcpRuntimeProfile,
  candidates: Array<{ executable: string; source: string; explicit: boolean }>,
  probes: AcpRuntimeProbe[]
): AgentRuntimeResolutionDiagnostics {
  const selected = probes.find((probe) => probe.version) ?? probes[0];
  const fallback = candidates[0];
  return {
    selectedExecutable: selected?.executable ?? fallback?.executable ?? profile.executableCandidates[0],
    selectedSource: selected?.source ?? fallback?.source ?? 'runtime profile / PATH',
    selectedVersion: selected?.version,
    selectedLaunchArgv: [...profile.argv],
    requiredCapabilities: [
      'ACP protocolVersion=1',
      'session/new',
      'session/prompt',
      'session/cancel',
      'session/update'
    ],
    probes: probes.map((probe) => ({
      executable: probe.executable,
      source: probe.source,
      explicit: probe.explicit,
      compatible: probe.compatible,
      version: probe.version,
      launchArgv: [...profile.argv],
      launchForm: `${probe.executable} ${profile.argv.join(' ')}`.trim(),
      detail: probe.detail
    }))
  };
}

function normalizeExecutable(executable: string): string {
  return path.isAbsolute(executable) ? path.normalize(executable) : executable;
}

function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/u).map((part) => part.trim()).find(Boolean);
  return line ? line.slice(0, 512) : undefined;
}

function portableProbeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const expectedKey of PORTABLE_PROBE_ENVIRONMENT_KEYS) {
    const entry = Object.entries(source).find(
      ([key, value]) => key.toLowerCase() === expectedKey.toLowerCase() && value !== undefined
    );
    if (entry) next[entry[0]] = entry[1];
  }
  return next;
}

function redactProbeOutput(
  profile: AcpRuntimeProfile,
  environment: NodeJS.ProcessEnv,
  value: string
): string {
  return redactProcessDiagnostic(
    value,
    sensitiveEnvironmentValues(profile.environmentPolicy, environment)
  );
}

function boundedProbeDiagnostic(value: string): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= MAX_PROBE_DIAGNOSTIC_BYTES) return value;
  const suffix = Buffer.from('\n[diagnostic truncated]');
  const prefix = buffer.subarray(0, MAX_PROBE_DIAGNOSTIC_BYTES - suffix.byteLength);
  return `${prefix.toString('utf8')}\n[diagnostic truncated]`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isExecutableNotFoundError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('code' in value)) return false;
  const code = (value as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function formatResolutionError(
  displayName: string,
  code: AcpRuntimeResolutionErrorCode,
  diagnostics: AgentRuntimeResolutionDiagnostics
): string {
  const summary = code === 'ACP_RUNTIME_NOT_FOUND'
    ? `${displayName} was not found. Install it or configure its executable path.`
    : `No compatible ${displayName} executable was found. A version response alone does not prove the required ACP launch contract.`;
  if (diagnostics.probes.length === 0) return summary;
  return [
    summary,
    ...diagnostics.probes.map((probe) => `${probe.executable}: ${probe.detail}`)
  ].join(' ');
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? 'the required launch contract';
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}
