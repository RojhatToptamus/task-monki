import path from 'node:path';
import type { AgentRuntimeResolutionDiagnostics } from '../../../shared/agent';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import { execFilePortable } from '../../process/portableChildProcess';
import type { AcpRuntimeProfile } from './AcpRuntimeProfiles';

const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

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

  for (const candidate of candidates) {
    if (candidate.executable.includes('\0')) {
      probes.push({
        ...candidate,
        compatible: false,
        detail: 'Executable contains a NUL byte.'
      });
      continue;
    }
    try {
      const { stdout, stderr } = await execFilePortable(
        candidate.executable,
        [...profile.versionArgv],
        {
          cwd: options.cwd,
          env: sanitizeEnvironment(environment, profile.allowedEnvironmentKeys),
          timeout: 2_000,
          maxBuffer: MAX_VERSION_OUTPUT_BYTES,
          windowsHide: true
        }
      );
      const version = firstLine(stdout) ?? firstLine(stderr);
      const executable = normalizeExecutable(candidate.executable);
      const identity = await proveCandidateIdentity(
        profile,
        candidate.executable,
        environment,
        options.cwd
      );
      const probe: AcpRuntimeProbe = {
        executable,
        source: candidate.source,
        explicit: candidate.explicit,
        compatible: true,
        version,
        detail: version
          ? `Executable responded to ${profile.versionArgv.join(' ')} with ${version}.${identity} ACP wire compatibility will be negotiated during initialize.`
          : `Executable responded to the version probe.${identity} ACP wire compatibility will be negotiated during initialize.`
      };
      probes.push(probe);
      return {
        executable,
        version,
        diagnostics: diagnostics(profile, probe, probes)
      };
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

  const detail = probes.map((probe) => `${probe.executable}: ${probe.detail}`).join(' ');
  throw new Error(`${profile.descriptor.displayName} ACP executable was not found or failed its version probe. ${detail}`);
}

async function proveCandidateIdentity(
  profile: AcpRuntimeProfile,
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string
): Promise<string> {
  const proof = profile.discoveryIdentity;
  if (!proof || !proof.executableNames.includes(executableBaseName(executable))) return '';
  const { stdout, stderr } = await execFilePortable(executable, [...proof.argv], {
    cwd,
    env: sanitizeEnvironment(environment, profile.allowedEnvironmentKeys),
    timeout: 2_000,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    windowsHide: true
  });
  const output = `${stdout}\n${stderr}`;
  if (!proof.outputPattern.test(output)) {
    throw new Error(
      `${proof.description} failed; refusing ambiguous executable ${executable}.`
    );
  }
  return ` ${proof.description} succeeded.`;
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

function normalizeExecutable(executable: string): string {
  return path.isAbsolute(executable) ? path.normalize(executable) : executable;
}

function executableBaseName(executable: string): string {
  return path.basename(executable).replace(/\.(?:cmd|bat|exe)$/iu, '');
}

function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/u).map((part) => part.trim()).find(Boolean);
  return line ? line.slice(0, 512) : undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
