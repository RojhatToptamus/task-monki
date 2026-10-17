import { execFileOwnedPortable } from '../process/ownedProcess';
import {
  RemoteWorkError,
  cliOutput,
  isMissingExecutable,
  isNetworkFailure,
  safeCliMessage
} from '../remote/RemoteWorkError';

/**
 * GitLab's REST API through the signed-in GitLab CLI (`glab api`). The CLI owns
 * the token; Task Monki passes no credential and keeps none. Responses are the
 * documented REST JSON, which is steadier than the CLI's own output formats.
 */
export class GitLabCli {
  constructor(private executable = 'glab') {}

  setExecutable(executable: string | undefined): void {
    this.executable = executable ?? 'glab';
  }

  async request<T>(input: {
    host: string;
    endpoint: string;
    cwd: string;
    method?: 'GET' | 'POST';
    /** String fields, sent as they are. */
    fields?: Record<string, string>;
    /** One long string field, sent on stdin. */
    stdinField?: { name: string; value: string };
    /** Names the project in a not-found message. */
    subject?: string;
    timeout?: number;
  }): Promise<T> {
    const argv = ['api', input.endpoint, '--hostname', input.host];
    if (input.method && input.method !== 'GET') argv.push('--method', input.method);
    for (const [key, value] of Object.entries(input.fields ?? {})) argv.push('--raw-field', `${key}=${value}`);
    if (input.stdinField) argv.push('--field', `${input.stdinField.name}=@-`);
    let stdout: string;
    try {
      ({ stdout } = await execFileOwnedPortable(this.executable, argv, {
        cwd: input.cwd,
        timeout: input.timeout ?? 30_000,
        maxBuffer: 20 * 1024 * 1024
      }, input.stdinField?.value));
    } catch (error) {
      throw await this.classify(error, input.host, input.cwd, input.subject);
    }
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new RemoteWorkError('FAILED', 'GitLab returned an unreadable response.');
    }
  }

  private async classify(error: unknown, host: string, cwd: string, subject?: string): Promise<RemoteWorkError> {
    if (isMissingExecutable(error)) return new RemoteWorkError('CLI_MISSING', 'GitLab CLI was not found.');
    const { stdout, stderr } = cliOutput(error);
    const text = `${stderr}\n${stdout}`;
    if (/\b401\b|unauthorized|glab auth login|not authenticated|no token/iu.test(text)) {
      return new RemoteWorkError('SIGNED_OUT', `GitLab CLI is not signed in to ${host}.`);
    }
    if (/\b404\b|not found/iu.test(text)) {
      const account = await this.account(host, cwd);
      return new RemoteWorkError('NOT_FOUND', subject
        ? account ? `${account} cannot see ${subject} on ${host}.` : `${subject} is not available on ${host}.`
        : 'GitLab could not find it.');
    }
    if (isNetworkFailure(text)) return new RemoteWorkError('FAILED', `Could not reach ${host}.`);
    return new RemoteWorkError('FAILED', safeCliMessage(error, 'GitLab CLI failed.'));
  }

  /** The signed-in account, for naming who cannot see a project. */
  private async account(host: string, cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileOwnedPortable(this.executable, ['api', 'user', '--hostname', host],
        { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
      const username = (JSON.parse(stdout) as { username?: string }).username;
      return username && /^[A-Za-z0-9_.-]{1,255}$/u.test(username) ? username : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A project path as one URL path segment, as GitLab's API expects it. */
export function gitLabProject(path: string): string {
  return encodeURIComponent(path);
}
