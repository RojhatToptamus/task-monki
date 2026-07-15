import path from 'node:path';
import type { AgentRuntimeResolutionDiagnostics } from '../../../shared/agent';
import { redactProcessDiagnostic } from '../../process/ProcessSupervisor';
import { execFilePortable } from '../../process/portableChildProcess';
import {
  ANTIGRAVITY_RUNTIME_DESCRIPTOR,
  TASK_MONKI_ANTIGRAVITY_BIN_ENV
} from './AntigravityCapabilities';

const MAX_PROBE_OUTPUT_BYTES = 128 * 1024;
const MAX_PROBE_DIAGNOSTIC_BYTES = 8 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const REQUIRED_HELP_PATTERNS = [
  { pattern: /\bUsage of agy:/u, detail: 'the Antigravity CLI identity' },
  { pattern: /--print\b/u, detail: 'the --print flag' },
  { pattern: /--model\b/u, detail: 'the --model flag' },
  { pattern: /--new-project\b/u, detail: 'the --new-project flag' },
  { pattern: /--sandbox\b/u, detail: 'the --sandbox flag' },
  { pattern: /--print-timeout\b/u, detail: 'the --print-timeout flag' },
  { pattern: /--mode\b/u, detail: 'the --mode flag' },
  { pattern: /^\s*models\s+List available models\s*$/mu, detail: 'the models command' }
] as const;
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

export interface AntigravityRuntimeResolverOptions {
  executable?: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
}

export interface ResolvedAntigravityRuntime {
  executable: string;
  source: 'config' | 'environment' | 'path';
  diagnostics: AgentRuntimeResolutionDiagnostics;
}

export type AntigravityRuntimeResolutionErrorCode =
  | 'ANTIGRAVITY_NOT_FOUND'
  | 'ANTIGRAVITY_INCOMPATIBLE';

export class AntigravityRuntimeResolutionError extends Error {
  constructor(
    readonly code: AntigravityRuntimeResolutionErrorCode,
    readonly diagnostics: AgentRuntimeResolutionDiagnostics
  ) {
    super(formatResolutionError(code, diagnostics));
    this.name = 'AntigravityRuntimeResolutionError';
  }
}

export async function resolveAntigravityRuntime(
  options: AntigravityRuntimeResolverOptions
): Promise<ResolvedAntigravityRuntime> {
  const environment = options.environment ?? process.env;
  const configured = options.executable?.trim();
  const environmentOverride = environment[TASK_MONKI_ANTIGRAVITY_BIN_ENV]?.trim();
  const candidates = configured
    ? [{ executable: configured, source: 'config' as const, explicit: true }]
    : environmentOverride
      ? [{ executable: environmentOverride, source: 'environment' as const, explicit: true }]
      : [{ executable: 'agy', source: 'path' as const, explicit: false }];
  const probes: AgentRuntimeResolutionDiagnostics['probes'] = [];
  let executableFound = false;

  for (const candidate of candidates) {
    if (!candidate.executable || candidate.executable.includes('\0')) {
      probes.push({
        ...candidate,
        compatible: false,
        detail: 'The executable path is empty or contains a NUL byte.'
      });
      continue;
    }
    try {
      const result = await execFilePortable(candidate.executable, ['--help'], {
        cwd: options.cwd,
        env: portableProbeEnvironment(environment),
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        windowsHide: true
      });
      executableFound = true;
      const output = `${result.stdout}\n${result.stderr}`;
      const missing = REQUIRED_HELP_PATTERNS.filter(({ pattern }) => !pattern.test(output));
      if (missing.length > 0) {
        throw new Error(
          `Public CLI help did not advertise ${missing.map((entry) => entry.detail).join(', ')}.`
        );
      }
      const executable = normalizeExecutable(candidate.executable);
      probes.push({
        executable,
        source: candidate.source,
        explicit: candidate.explicit,
        compatible: true,
        launchArgv: antigravityDiagnosticArgv(),
        launchForm: 'documented turn-scoped CLI print mode',
        detail: 'The public Antigravity print, model, project, sandbox, timeout, and mode contracts are available.'
      });
      return {
        executable,
        source: candidate.source,
        diagnostics: {
          selectedExecutable: executable,
          selectedSource: candidate.source,
          selectedLaunchArgv: antigravityDiagnosticArgv(),
          requiredCapabilities: antigravityRequiredCapabilities(),
          probes
        }
      };
    } catch (cause) {
      if (!isExecutableNotFoundError(cause)) executableFound = true;
      probes.push({
        executable: normalizeExecutable(candidate.executable),
        source: candidate.source,
        explicit: candidate.explicit,
        compatible: false,
        detail: boundedDiagnostic(redactProcessDiagnostic(errorMessage(cause)))
      });
    }
  }

  const diagnostics: AgentRuntimeResolutionDiagnostics = {
    selectedExecutable: normalizeExecutable(candidates[0]?.executable ?? 'agy'),
    selectedSource: candidates[0]?.source ?? 'path',
    selectedLaunchArgv: antigravityDiagnosticArgv(),
    requiredCapabilities: antigravityRequiredCapabilities(),
    probes
  };
  throw new AntigravityRuntimeResolutionError(
    executableFound ? 'ANTIGRAVITY_INCOMPATIBLE' : 'ANTIGRAVITY_NOT_FOUND',
    diagnostics
  );
}

export function antigravityDiagnosticArgv(): string[] {
  return [
    '--print',
    '<prompt>',
    '--model',
    '<exact-advertised-label>',
    '--new-project',
    '--sandbox',
    '--print-timeout',
    '30m',
    '--mode',
    '<plan|accept-edits>'
  ];
}

function antigravityRequiredCapabilities(): string[] {
  return [
    'agy models',
    'agy --print',
    '--model',
    '--new-project',
    '--sandbox',
    '--print-timeout',
    '--mode plan|accept-edits'
  ];
}

function portableProbeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const expected of PORTABLE_PROBE_ENVIRONMENT_KEYS) {
    const entry = Object.entries(source).find(
      ([key, value]) => key.toLowerCase() === expected.toLowerCase() && value !== undefined
    );
    if (entry) next[entry[0]] = entry[1];
  }
  return next;
}

function normalizeExecutable(executable: string): string {
  return path.isAbsolute(executable) ? path.normalize(executable) : executable;
}

function boundedDiagnostic(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= MAX_PROBE_DIAGNOSTIC_BYTES) return value;
  return `${bytes.subarray(0, MAX_PROBE_DIAGNOSTIC_BYTES).toString('utf8')}\n[diagnostic truncated]`;
}

function isExecutableNotFoundError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('code' in value)) return false;
  return ['ENOENT', 'ENOTDIR'].includes(String((value as { code?: unknown }).code));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function formatResolutionError(
  code: AntigravityRuntimeResolutionErrorCode,
  diagnostics: AgentRuntimeResolutionDiagnostics
): string {
  const summary = code === 'ANTIGRAVITY_NOT_FOUND'
    ? 'Antigravity CLI was not found. Install `agy` or configure its executable path.'
    : 'No compatible Antigravity CLI was found. Task Monki requires its documented non-interactive print contract.';
  return [
    summary,
    ...diagnostics.probes.map((probe) => `${probe.executable}: ${probe.detail}`)
  ].join(' ');
}

export const ANTIGRAVITY_RUNTIME_DISPLAY_NAME =
  ANTIGRAVITY_RUNTIME_DESCRIPTOR.displayName;
