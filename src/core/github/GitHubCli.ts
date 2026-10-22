import { execFileOwnedPortable } from '../process/ownedProcess';
import {
  RemoteWorkError,
  cliExitCode,
  cliOutput,
  isMissingExecutable,
  isNetworkFailure,
  safeCliMessage
} from '../remote/RemoteWorkError';
import { graphQlQueryArgument } from './gitHubGraphQl';

interface GitHubCommand {
  cwd: string;
  /** The host the command reaches; github.com when gh finds the repository from the checkout. */
  host?: string;
  timeout?: number;
  /** Sent on standard input. */
  stdin?: string;
  /** Exit codes that still answer, such as 8 from `gh pr checks` while checks are pending. */
  allowedExitCodes?: readonly number[];
}

interface GitHubGraphQlRequest {
  host: string;
  cwd: string;
  query: string;
  /** String variables, sent as they are. */
  strings?: Record<string, string>;
  integers?: Record<string, number>;
  /** One long string variable, sent on standard input. */
  stdinField?: { name: string; value: string };
  /** The repository read, `owner/name`, which a not-found message names. */
  subject?: string;
  timeout?: number;
}

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
/** gh's words when GitHub refuses its token or it holds none. */
const SIGNED_OUT_OUTPUT = /HTTP 401|Bad credentials|gh auth login/iu;

/**
 * GitHub through the signed-in GitHub CLI (`gh`). The CLI owns the token; Task
 * Monki passes no credential and keeps none. A gh that cannot start or is not
 * signed in reads the same on every call.
 */
export class GitHubCli {
  constructor(private executable = 'gh') {}

  setExecutable(executable: string | undefined): void {
    this.executable = executable ?? 'gh';
  }

  /**
   * Runs gh for a caller that reads gh's own answer: a merge GitHub refused, or
   * `gh pr checks`, which exits 8 while checks are pending. Only a gh that cannot
   * start or is not signed in fails in the CLI's words; any other failure is gh's.
   */
  async run(argv: string[], command: GitHubCommand): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileOwnedPortable(this.executable, argv, {
        cwd: command.cwd,
        timeout: command.timeout ?? 30_000,
        maxBuffer: MAX_OUTPUT_BYTES
      }, command.stdin);
    } catch (error) {
      const code = cliExitCode(error);
      if (code !== undefined && command.allowedExitCodes?.includes(code)) return cliOutput(error);
      throw cliUnavailable(error, command.host ?? 'github.com') ?? error;
    }
  }

  /** A GraphQL request through `gh api graphql`; a failure says what the person can do about it. */
  async graphql<T>(request: GitHubGraphQlRequest): Promise<T> {
    const argv = ['api', 'graphql', '--hostname', request.host, '-f', graphQlQueryArgument(request.query)];
    for (const [key, value] of Object.entries(request.strings ?? {})) argv.push('-f', `${key}=${value}`);
    for (const [key, value] of Object.entries(request.integers ?? {})) argv.push('-F', `${key}=${Math.trunc(value)}`);
    if (request.stdinField) argv.push('-F', `${request.stdinField.name}=@-`);
    let stdout: string;
    try {
      ({ stdout } = await execFileOwnedPortable(this.executable, argv, {
        cwd: request.cwd,
        timeout: request.timeout ?? 30_000,
        maxBuffer: MAX_OUTPUT_BYTES
      }, request.stdinField?.value));
    } catch (error) {
      const answered = itemNotFoundData<T>(error);
      if (answered) return answered;
      throw await this.classify(error, request);
    }
    try {
      const parsed = JSON.parse(stdout) as { data?: T };
      if (!parsed.data) throw new Error('missing data');
      return parsed.data;
    } catch {
      throw new RemoteWorkError('FAILED', 'GitHub returned an unreadable response.');
    }
  }

  private async classify(error: unknown, request: GitHubGraphQlRequest): Promise<RemoteWorkError> {
    const unavailable = cliUnavailable(error, request.host);
    if (unavailable) return unavailable;
    const { stdout, stderr } = cliOutput(error);
    if (/"type"\s*:\s*"NOT_FOUND"/u.test(stdout) || /Could not resolve to a Repository/iu.test(stderr)) {
      if (!request.subject) return new RemoteWorkError('NOT_FOUND', 'GitHub could not find it.');
      const account = await this.account(request.host, request.cwd);
      return new RemoteWorkError('NOT_FOUND', account
        ? `${account} cannot see ${request.subject} on ${request.host}.`
        : `${request.subject} is not available on ${request.host}.`);
    }
    if (isNetworkFailure(stderr)) return new RemoteWorkError('FAILED', `Could not reach ${request.host}.`);
    return new RemoteWorkError('FAILED', safeCliMessage(error, 'GitHub CLI failed.'));
  }

  /** The signed-in account, for naming who cannot see a repository. */
  private async account(host: string, cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileOwnedPortable(this.executable,
        ['api', 'graphql', '--hostname', host, '-f', graphQlQueryArgument('query { viewer { login } }')],
        { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
      const login = (JSON.parse(stdout) as { data?: { viewer?: { login?: string } } }).data?.viewer?.login;
      // Enterprise managed accounts carry an underscore, such as `mona_acme`.
      return login && /^[A-Za-z0-9_-]{1,39}$/u.test(login) ? login : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * A gh that cannot start, or that holds no working sign-in for the host: gh
 * exits 4 when it has none, and GitHub answers 401 to a token it refuses.
 * Undefined for any other failure, which is gh's own answer.
 */
function cliUnavailable(error: unknown, host: string): RemoteWorkError | undefined {
  if (isMissingExecutable(error)) return new RemoteWorkError('CLI_MISSING', 'GitHub CLI was not found.');
  if (cliExitCode(error) === 4 || SIGNED_OUT_OUTPUT.test(cliOutput(error).stderr)) {
    return new RemoteWorkError('SIGNED_OUT', `GitHub CLI is not signed in to ${host}.`);
  }
  return undefined;
}

/**
 * GitHub answers a number with no issue or pull request with its data, the
 * item null, and a NOT_FOUND error on the item's path; gh then exits non-zero.
 * That is an answer about the item, not about the repository.
 */
function itemNotFoundData<T>(error: unknown): T | undefined {
  try {
    const parsed = JSON.parse(cliOutput(error).stdout) as { data?: T; errors?: Array<{ type?: unknown; path?: unknown }> };
    const errors = parsed.errors ?? [];
    return parsed.data && errors.length > 0 && errors.every((item) => item.type === 'NOT_FOUND' && Array.isArray(item.path) && item.path.length > 1)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}
