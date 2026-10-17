import type { RemoteWorkUnavailable, RemoteWorkUnavailableCode } from '../../shared/remoteWork';
import { redactCredentialText } from '../agent/AgentCredentialRedaction';

/** A remote read or write that failed for a reason the person can act on. Its message is safe to show. */
export class RemoteWorkError extends Error {
  readonly code: RemoteWorkUnavailableCode;

  constructor(code: RemoteWorkUnavailableCode, message: string) {
    super(message);
    this.name = 'RemoteWorkError';
    this.code = code;
  }

  toUnavailable(): RemoteWorkUnavailable {
    return { code: this.code, message: this.message };
  }
}

export function remoteWorkUnavailable(error: unknown): RemoteWorkUnavailable {
  return error instanceof RemoteWorkError
    ? error.toUnavailable()
    : { code: 'FAILED', message: safeCliMessage(error) };
}

interface CliFailure {
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

/** The first useful line of a CLI failure, without credentials. */
export function safeCliMessage(error: unknown, fallback = 'The request failed.'): string {
  const failure = (error && typeof error === 'object' ? error : {}) as CliFailure;
  const text = [asText(failure.stderr), failure.message ?? '']
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('Command failed with exit code'));
  return text ? redactCredentialText(text).slice(0, 500) : fallback;
}

export function cliExitCode(error: unknown): number | undefined {
  const code = (error && typeof error === 'object' ? (error as CliFailure).code : undefined);
  return typeof code === 'number' ? code : typeof code === 'string' && /^\d+$/u.test(code) ? Number(code) : undefined;
}

export function cliOutput(error: unknown): { stdout: string; stderr: string } {
  const failure = (error && typeof error === 'object' ? error : {}) as CliFailure;
  return { stdout: asText(failure.stdout), stderr: asText(failure.stderr) };
}

/** True when the executable itself could not be started. */
export function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as CliFailure).code === 'ENOENT');
}

/** True when the request never reached the host. */
export function isNetworkFailure(text: string): boolean {
  return /could not resolve host|dial tcp|connection refused|network is unreachable|timed? ?out|i\/o timeout|no such host|TLS handshake/iu.test(text);
}

function asText(value: string | Buffer | undefined): string {
  return typeof value === 'string' ? value : value?.toString('utf8') ?? '';
}
