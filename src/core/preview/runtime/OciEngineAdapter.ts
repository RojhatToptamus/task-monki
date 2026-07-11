import { createHash } from 'node:crypto';
import type {
  PreviewOciEngineCapability,
  PreviewOciEngineIdentity
} from '../../../shared/contracts';
import { execFilePortable } from '../../process/portableChildProcess';

const MAX_OCI_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const OCI_COMMAND_TIMEOUT_MS = 15_000;
const MAX_CONTEXT_NAME_BYTES = 256;

export type OciEngineErrorCode =
  | Exclude<PreviewOciEngineCapability['status'], 'READY'>
  | 'ENGINE_IDENTITY_MISMATCH';

export class OciEngineError extends Error {
  constructor(readonly code: OciEngineErrorCode, message: string) {
    super(message);
  }
}

export interface OciCommandResult {
  stdout: string;
  stderr: string;
}

export type OciCommandExecutor = (
  executable: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  }
) => Promise<OciCommandResult>;

export interface OciEngineAdapterOptions {
  executable?: string;
  contextName?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execute?: OciCommandExecutor;
}

export class OciEngineAdapter {
  private readonly executable: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly execute: OciCommandExecutor;
  private selectedContextName: string | undefined;

  constructor(options: OciEngineAdapterOptions = {}) {
    this.executable = options.executable ?? 'docker';
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.execute = options.execute ?? executeOciCommand;
    this.selectedContextName = options.contextName
      ? validateContextName(options.contextName)
      : undefined;
  }

  async probe(): Promise<PreviewOciEngineCapability> {
    let contextName: string;
    try {
      contextName = await this.resolveContextName();
    } catch (error) {
      return unavailableCapability(error, isMissingExecutable(error) ? 'ENGINE_MISSING' : 'ENGINE_UNAVAILABLE');
    }

    try {
      const [contextResult, versionResult, infoResult] = await Promise.all([
        this.run(['context', 'inspect', contextName]),
        this.run(['--context', contextName, 'version', '--format', '{{json .}}']),
        this.run(['--context', contextName, 'info', '--format', '{{json .}}'])
      ]);
      const context = firstJsonRecord(contextResult.stdout, 'Docker context inspection');
      const version = jsonRecord(versionResult.stdout, 'Docker version');
      const info = jsonRecord(infoResult.stdout, 'Docker engine information');
      const server = requiredRecord(version.Server, 'Docker version Server');
      const endpoint = requiredRecord(requiredRecord(context.Endpoints, 'Docker context Endpoints').docker, 'Docker context endpoint');
      const operatingSystem = requiredString(server.Os, 'Docker server operating system');
      const architecture = normalizeArchitecture(requiredString(server.Arch, 'Docker server architecture'));
      if (operatingSystem !== 'linux' || !['arm64', 'amd64'].includes(architecture)) {
        return {
          status: 'UNSUPPORTED_ENGINE',
          contextName,
          supportsMemoryLimit: false,
          supportsCpuLimit: false,
          supportsPidsLimit: false,
          reason: `OCI engine ${operatingSystem}/${architecture} is unsupported; Task Monki requires a Linux arm64 or amd64 engine.`
        };
      }
      const identity: PreviewOciEngineIdentity = {
        contextName,
        endpointDigest: sha256(canonicalJson({
          host: requiredString(endpoint.Host, 'Docker context endpoint host'),
          skipTlsVerify: endpoint.SkipTLSVerify === true
        })),
        engineId: requiredString(info.ID, 'Docker engine ID'),
        serverVersion: requiredString(server.Version, 'Docker server version'),
        apiVersion: requiredString(server.ApiVersion, 'Docker server API version'),
        operatingSystem,
        architecture
      };
      return {
        status: 'READY',
        contextName,
        identity,
        supportsMemoryLimit: info.MemoryLimit === true,
        supportsCpuLimit: info.CpuCfsQuota === true,
        supportsPidsLimit: info.PidsLimit === true
      };
    } catch (error) {
      return unavailableCapability(error, isMissingExecutable(error) ? 'ENGINE_MISSING' : 'ENGINE_UNAVAILABLE', contextName);
    }
  }

  async requireReady(expected?: PreviewOciEngineIdentity): Promise<PreviewOciEngineCapability & {
    status: 'READY';
    identity: PreviewOciEngineIdentity;
  }> {
    const capability = await this.probe();
    if (capability.status !== 'READY' || !capability.identity) {
      const code: Exclude<PreviewOciEngineCapability['status'], 'READY'> =
        capability.status === 'READY' ? 'ENGINE_UNAVAILABLE' : capability.status;
      throw new OciEngineError(
        code,
        capability.reason ?? `OCI engine is ${capability.status.toLowerCase().replace(/_/g, ' ')}.`
      );
    }
    if (expected && !sameEngine(expected, capability.identity)) {
      throw new OciEngineError(
        'ENGINE_IDENTITY_MISMATCH',
        'The selected OCI context no longer points to the engine that owns this preview resource.'
      );
    }
    return capability as PreviewOciEngineCapability & {
      status: 'READY';
      identity: PreviewOciEngineIdentity;
    };
  }

  contextArgs(contextName: string, argv: string[]): string[] {
    return ['--context', validateContextName(contextName), ...argv];
  }

  run(argv: string[], env: NodeJS.ProcessEnv = this.env): Promise<OciCommandResult> {
    return this.execute(this.executable, argv, {
      cwd: this.cwd,
      env,
      timeoutMs: OCI_COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_OCI_COMMAND_OUTPUT_BYTES
    });
  }

  private async resolveContextName(): Promise<string> {
    if (this.selectedContextName) return this.selectedContextName;
    const result = await this.run(['context', 'show']);
    this.selectedContextName = validateContextName(result.stdout.trim());
    return this.selectedContextName;
  }
}

async function executeOciCommand(
  executable: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  }
): Promise<OciCommandResult> {
  return execFilePortable(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes
  });
}

function unavailableCapability(
  error: unknown,
  status: 'ENGINE_MISSING' | 'ENGINE_UNAVAILABLE',
  contextName?: string
): PreviewOciEngineCapability {
  return {
    status,
    contextName,
    supportsMemoryLimit: false,
    supportsCpuLimit: false,
    supportsPidsLimit: false,
    reason: boundedError(error)
  };
}

function sameEngine(
  expected: PreviewOciEngineIdentity,
  actual: PreviewOciEngineIdentity
): boolean {
  return expected.contextName === actual.contextName &&
    expected.endpointDigest === actual.endpointDigest &&
    expected.engineId === actual.engineId;
}

function normalizeArchitecture(value: string): string {
  if (value === 'aarch64') return 'arm64';
  if (value === 'x86_64') return 'amd64';
  return value;
}

function validateContextName(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    Buffer.byteLength(trimmed) > MAX_CONTEXT_NAME_BYTES ||
    trimmed.includes('\0') ||
    /[\r\n]/.test(trimmed)
  ) {
    throw new Error('OCI context name is invalid.');
  }
  return trimmed;
}

function firstJsonRecord(value: string, context: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`${context} must return exactly one object.`);
  }
  return requiredRecord(parsed[0], context);
}

function jsonRecord(value: string, context: string): Record<string, unknown> {
  return requiredRecord(JSON.parse(value) as unknown, context);
}

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} is invalid.`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 512);
}
