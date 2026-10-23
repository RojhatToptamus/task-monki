import type {
  BranchPublicationRecord,
  CiChecksStatus,
  CiRollupRecord,
  GitHubCheckDetailRecord,
  GitHubCheckStatus,
  GitHubRepositoryRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import type { PullRequestMergeOptions } from '../../shared/pullRequestActions';
import type { PullRequestFeedback } from '../../shared/pullRequestFeedback';
import { INVISIBLE_CHARACTERS, parseRemoteWorkReference } from '../../shared/remoteWork';
import { UNTRUSTED_CHECKOUT_GIT_ENV, git, gitSucceeds } from '../git/gitCli';
import {
  GITHUB_FEEDBACK_QUERY,
  GITHUB_THREADS_PAGE_QUERY,
  GITHUB_THREAD_PAGES,
  parseGitHubPullRequestFeedback,
  type GitHubFeedbackData,
  type GitHubThreadConnection
} from './GitHubPullRequestFeedback';
import {
  GITHUB_MERGE_OPTIONS_QUERY,
  GITHUB_RESOLVE_THREAD_MUTATION,
  GITHUB_UNRESOLVE_THREAD_MUTATION,
  GITHUB_THREAD_REPLY_MUTATION,
  gitHubActionsJob,
  gitHubMergeFailure,
  parseGitHubMergeOptions
} from './GitHubPullRequestActions';
import { inspectExistingWorkSnapshot } from '../git/GitSnapshotService';
import { deliveryRemote, startEach, type DeliveryRemote, type DeliveryTarget, type PullRequestAddress, type PullRequestDelivery, type PullRequestSync } from '../remote/PullRequestDelivery';
import { externalTargetBranch, listCheckoutRemoteRepositories } from '../remote/RemoteCheckout';
import { RemoteWorkError, remoteWorkMessage } from '../remote/RemoteWorkError';
import { canonicalPlatformTime } from '../remote/platformTime';
import type { GitHubCli } from './GitHubCli';

interface ExecError extends Error {
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export class GitHubService implements PullRequestDelivery {
  readonly provider = 'GITHUB' as const;

  constructor(private readonly cli: GitHubCli) {}

  async preflight(
    task: Task,
    worktree: WorktreeRecord,
    pushRemote?: DeliveryRemote
  ): Promise<Omit<GitHubRepositoryRecord, 'id' | 'checkedAt'>> {
    const remote = pushRemote ?? await detectGitHubRemote(worktree.worktreePath);
    if (!remote) {
      return {
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        status: 'MISSING_REMOTE',
        error: 'No GitHub remote was found.'
      };
    }

    let ghVersion: string | undefined;
    try {
      const version = await this.cli.run(['--version'], { cwd: worktree.worktreePath, host: remote.host });
      ghVersion = version.stdout.split('\n')[0]?.trim();
    } catch (error) {
      return {
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        ...remote,
        status: 'GH_MISSING',
        error: remoteWorkMessage(error)
      };
    }

    try {
      await this.cli.run(['auth', 'status', '--hostname', remote.host], { cwd: worktree.worktreePath, host: remote.host });
    } catch (error) {
      return {
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        ...remote,
        ghVersion,
        authStatus: 'UNAUTHENTICATED',
        status: 'AUTH_REQUIRED',
        error: remoteWorkMessage(error)
      };
    }

    return {
      taskId: task.id,
      iterationId: worktree.iterationId,
      worktreeId: worktree.id,
      ...remote,
      ghVersion,
      authStatus: 'AUTHENTICATED',
      status: 'READY'
    };
  }

  async publishBranch(input: {
    task: Task;
    worktree: WorktreeRecord;
    remoteName?: string;
    remoteUrl?: string;
    expectedHeadSha?: string;
    expectedGitCommonDir?: string;
    /**
     * The branch of an opened pull request. The commit goes to that exact
     * branch, fast-forward only, without changing upstream configuration.
     */
    remoteBranch?: string;
    /** The branch's commit before this push, when known: still there means the push did not land. */
    previousRemoteSha?: string;
  }): Promise<Omit<BranchPublicationRecord, 'id' | 'requestedAt' | 'updatedAt'>> {
    const remoteName = input.remoteName ?? 'origin';
    const branchName = input.remoteBranch ?? input.worktree.branchName;
    const external = input.worktree.ownership === 'EXTERNAL';
    const headSha = external && input.expectedHeadSha
      ? input.expectedHeadSha : (await git(input.worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    const base = {
      taskId: input.task.id, iterationId: input.worktree.iterationId, worktreeId: input.worktree.id,
      remoteName, branchName, remoteRef: `${remoteName}/${branchName}`, headSha,
      ...(input.remoteUrl ? { remoteUrl: input.remoteUrl } : {}),
      ...(input.remoteBranch && input.previousRemoteSha ? { previousRemoteSha: input.previousRemoteSha } : {})
    };
    if (input.remoteBranch) {
      // A pull request's branch moves only forward from the head last observed,
      // and only while it is still there: the lease refuses a branch that moved
      // or was deleted after its merge, and its author's hooks do not run.
      if (!input.previousRemoteSha || !await gitSucceeds(input.worktree.worktreePath, ['merge-base', '--is-ancestor', input.previousRemoteSha, headSha])) {
        return { ...base, status: 'FAILED', error: 'Push update only adds commits on top of the pull request.' };
      }
      try {
        await git(input.worktree.worktreePath, [
          'push', '--no-follow-tags', '--recurse-submodules=no',
          `--force-with-lease=refs/heads/${branchName}:${input.previousRemoteSha}`,
          '--', remoteName, `${headSha}:refs/heads/${branchName}`
        ], { timeout: 120_000, env: { GIT_TERMINAL_PROMPT: '0', ...UNTRUSTED_CHECKOUT_GIT_ENV } });
        return { ...base, status: 'PUSHED' };
      } catch (error) {
        if (isRejectedPushError(error)) {
          return { ...base, status: 'FAILED', error: 'Remote branch has newer commits' };
        }
        return this.reconcileBranchPublication({
          task: input.task,
          worktree: input.worktree,
          remoteName,
          remoteBranch: branchName,
          previousRemoteSha: input.previousRemoteSha,
          expectedHeadSha: headSha,
          failureDetail: publishBranchErrorMessage(error)
        });
      }
    }
    if (external) {
      if (!input.remoteUrl || !input.expectedHeadSha || !input.expectedGitCommonDir) {
        throw new Error('External publication requires a verified commit and an explicit destination.');
      }
      try {
        const snapshot = await inspectExistingWorkSnapshot(input.worktree);
        if (snapshot.headSha !== headSha || snapshot.gitCommonDir !== input.expectedGitCommonDir ||
            snapshot.stagedCount || snapshot.unstagedCount || snapshot.untrackedCount ||
            snapshot.conflictedCount || snapshot.operationInProgress) {
          throw new Error('The external checkout changed before publication. Refresh and try again.');
        }
      } catch (error) {
        return { ...base, status: 'FAILED', error: errorMessage(error) };
      }
    }
    try {
      await git(input.worktree.worktreePath, external
        ? ['push', '--no-follow-tags', '--recurse-submodules=no', '--', input.remoteUrl!, `${headSha}:refs/heads/${branchName}`]
        : ['push', '--set-upstream', remoteName, 'HEAD'],
        120_000);
      return {
        ...base,
        status: 'PUSHED'
      };
    } catch (error) {
      const pushError = publishBranchErrorMessage(error);
      if (isRejectedPushError(error)) {
        return {
          ...base,
          status: 'FAILED',
          error: pushError
        };
      }
      return this.reconcileBranchPublication({
        task: input.task,
        worktree: input.worktree,
        remoteName,
        remoteUrl: input.remoteUrl,
        expectedHeadSha: headSha,
        failureDetail: pushError
      });
    }
  }

  async reconcileBranchPublication(input: {
    task: Task;
    worktree: WorktreeRecord;
    remoteName: string;
    remoteUrl?: string;
    /** The recorded destination branch when it differs from the task branch. */
    remoteBranch?: string;
    /** The branch's commit before the push; finding it unchanged proves the push did not land. */
    previousRemoteSha?: string;
    expectedHeadSha?: string;
    failureDetail?: string;
  }): Promise<Omit<BranchPublicationRecord, 'id' | 'requestedAt' | 'updatedAt'>> {
    const branchName = input.remoteBranch ?? input.worktree.branchName;
    const base = {
      taskId: input.task.id,
      iterationId: input.worktree.iterationId,
      worktreeId: input.worktree.id,
      remoteName: input.remoteName,
      ...(input.remoteUrl ? { remoteUrl: input.remoteUrl } : {}),
      branchName,
      remoteRef: `${input.remoteName}/${branchName}`,
      headSha: input.expectedHeadSha,
      // Kept on an unconfirmed record, so a later check can still prove the push did not land.
      ...(input.previousRemoteSha ? { previousRemoteSha: input.previousRemoteSha } : {})
    };
    let remoteHeadSha: string | undefined;
    if (input.worktree.ownership === 'EXTERNAL' && !input.remoteUrl) {
      return { ...base, status: 'AMBIGUOUS', error: 'The interrupted push has no recorded destination. Inspect the remote before retrying.' };
    }
    try {
      const output = await git(input.worktree.worktreePath, [
        'ls-remote',
        '--heads',
        input.remoteUrl ?? input.remoteName,
        `refs/heads/${branchName}`
      ]);
      remoteHeadSha = output.trim().split(/\s+/)[0] || undefined;
    } catch (error) {
      return {
        ...base,
        status: 'AMBIGUOUS',
        error:
          `Could not confirm the remote branch after an interrupted push: ${errorMessage(error)}` +
          (input.failureDetail ? ` Original push error: ${input.failureDetail}` : '')
      };
    }
    if (!remoteHeadSha) {
      return {
        ...base,
        status: 'FAILED',
        error:
          input.failureDetail ??
          'Branch publication was interrupted before the remote ref was created. Retry is safe.'
      };
    }
    if (input.expectedHeadSha && remoteHeadSha === input.expectedHeadSha) {
      return {
        ...base,
        status: 'PUSHED'
      };
    }
    if (input.previousRemoteSha && remoteHeadSha === input.previousRemoteSha) {
      return {
        ...base,
        status: 'FAILED',
        error: input.failureDetail ?? 'The push did not reach the remote branch. Retry is safe.'
      };
    }
    return {
      ...base,
      status: 'AMBIGUOUS',
      error: input.expectedHeadSha
        ? `Remote branch is at ${remoteHeadSha.slice(0, 12)}, not the attempted ${input.expectedHeadSha.slice(0, 12)}. Sync or inspect the remote before retrying.`
        : `Remote branch exists at ${remoteHeadSha.slice(0, 12)}, but the interrupted attempt did not record its local head. Inspect the remote before retrying.`
    };
  }

  async createOrFindDraftPullRequest(input: {
    worktree: WorktreeRecord;
    baseRef?: string;
    body: string;
    title: string;
    target?: DeliveryTarget;
  }): Promise<PullRequestSync> {
    const existing = await this.findOpenPullRequest(input.worktree, input.target);
    if (existing) {
      return existing;
    }

    const remote = !input.target && input.worktree.ownership === 'EXTERNAL' ? await detectGitHubRemote(input.worktree.worktreePath) : undefined;
    if (!input.target && input.worktree.ownership === 'EXTERNAL' && !remote) throw new Error('No GitHub remote was found.');
    const baseRef = input.baseRef ?? await this.pullRequestBase(input.worktree);
    const createResult = await this.cli.run(
      [
        'pr',
        'create',
        '--draft',
        '--title',
        input.title,
        '--body-file',
        '-',
        '--base',
        baseRef,
        '--head',
        input.target?.headRepository ? `${headOwner(input.target.headRepository)}:${input.worktree.branchName}` : input.worktree.branchName,
        ...repositoryArgs(input.target, remote)
      ],
      { cwd: input.worktree.worktreePath, timeout: 120_000, stdin: input.body }
    );

    const url = createResult.stdout.trim().split(/\s+/).find((value) => value.startsWith('http'));
    return this.viewPullRequest(input.worktree, url ?? input.worktree.branchName, input.target);
  }

  async findOpenPullRequest(worktree: WorktreeRecord, target?: DeliveryTarget): Promise<PullRequestSync | undefined> {
    if (target) {
      // An open pull request of the task branch in the target repository, pushed from the expected owner.
      const owner = headOwner(target.headRepository ?? target.repository).toLowerCase();
      return this.findListedPullRequest(worktree, repositoryArgs(target), 'headRepositoryOwner,isCrossRepository', (row) => {
        const item = row as { headRefName?: unknown; isCrossRepository?: unknown; headRepositoryOwner?: { login?: unknown } };
        return item.headRefName === worktree.branchName &&
          item.isCrossRepository === Boolean(target.headRepository) &&
          typeof item.headRepositoryOwner?.login === 'string' && item.headRepositoryOwner.login.toLowerCase() === owner;
      }, target);
    }
    if (worktree.ownership === 'EXTERNAL') {
      const remote = await detectGitHubRemote(worktree.worktreePath);
      return remote
        ? this.findListedPullRequest(worktree, ['--repo', `${remote.host}/${remote.owner}/${remote.repo}`],
          'headRepository,headRepositoryOwner,isCrossRepository', (row) => matchesExternalPullRequest(row, worktree, remote))
        : undefined;
    }
    const result = await this.cli.run(
      ['pr', 'list', '--state', 'open', '--head', worktree.branchName, '--limit', '10', '--json', prJsonFields],
      { cwd: worktree.worktreePath }
    );
    const rows = parseJson<unknown[]>(result.stdout, []);
    if (!Array.isArray(rows)) throw new Error('GitHub returned an invalid pull request list.');
    const match = rows.map((row) => parsePrView(row, worktree)).find((row) => row.pullRequest.number);
    return match?.pullRequest.number
      ? this.viewPullRequest(worktree, match.pullRequest.number)
      : match;
  }

  /** The one open pull request of the task branch that `matches` accepts; ten rows or more are too many to judge. */
  private async findListedPullRequest(
    worktree: WorktreeRecord,
    repository: string[],
    fields: string,
    matches: (row: unknown) => boolean,
    target?: DeliveryTarget
  ): Promise<PullRequestSync | undefined> {
    const result = await this.cli.run([
      'pr', 'list', '--state', 'open', '--head', worktree.branchName, '--limit', '10', '--json', `${prJsonFields},${fields}`, ...repository
    ], { cwd: worktree.worktreePath });
    const rows = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(rows)) throw new Error('GitHub returned an invalid pull request list.');
    if (rows.length >= 10) throw new Error('The pull request lookup is incomplete. Inspect the branch on GitHub.');
    const found = rows.filter(matches) as Array<{ number: number }>;
    if (found.length > 1) throw new Error('Multiple pull requests match this branch. Inspect the branch on GitHub.');
    return found[0] ? this.viewPullRequest(worktree, found[0].number, target) : undefined;
  }

  async pullRequestBase(worktree: WorktreeRecord, requestedBranch?: string): Promise<string> {
    if (worktree.ownership !== 'EXTERNAL') return requestedBranch ?? worktree.baseRef ?? 'main';
    const remote = await detectGitHubRemote(worktree.worktreePath);
    if (!remote) throw new Error('No GitHub remote was found.');
    const baseRef = await externalTargetBranch(worktree, requestedBranch, remote.remoteName, 'pull request');
    const result = await this.cli.run([
      'api', '--hostname', remote.host,
      `repos/${remote.owner}/${remote.repo}/branches/${encodeURIComponent(baseRef)}`
    ], { cwd: worktree.worktreePath, host: remote.host });
    const branch = JSON.parse(result.stdout) as { name?: string } | null;
    if (branch?.name !== baseRef) throw new Error('GitHub did not confirm the selected target branch.');
    return baseRef;
  }

  async viewPullRequest(worktree: WorktreeRecord, selector: string | number, target?: DeliveryTarget, options: { feedback?: boolean } = {}): Promise<PullRequestSync> {
    const remote = !target && worktree.ownership === 'EXTERNAL' ? await detectGitHubRemote(worktree.worktreePath) : undefined;
    if (!target && worktree.ownership === 'EXTERNAL' && !remote) throw new Error('No GitHub remote was found.');
    const repoArgs = repositoryArgs(target, remote);
    const [viewResult, checksResult] = await Promise.all([
      this.cli.run(['pr', 'view', String(selector), '--json', remote ? `${prJsonFields},headRepository,headRepositoryOwner,isCrossRepository` : prJsonFields, ...repoArgs],
        { cwd: worktree.worktreePath }),
      // Exit code 8 reports pending checks, with the checks.
      this.cli.run(['pr', 'checks', String(selector), '--json', prChecksJsonFields, ...repoArgs],
        { cwd: worktree.worktreePath, allowedExitCodes: [8] }).catch(() => undefined)
    ]);
    const raw = remote ? JSON.parse(viewResult.stdout) as unknown : parseJson<Record<string, unknown>>(viewResult.stdout, {});
    if (remote && !matchesExternalPullRequest(raw, worktree, remote)) {
      throw new Error('The pull request does not match this external checkout.');
    }
    const sync = parsePrView(
      raw,
      worktree,
      checksResult ? parseJson<unknown[]>(checksResult.stdout, []) : undefined
    );
    if (options.feedback === false) return sync;
    // Feedback is read from the pull request GitHub reported; without it, the status still stands.
    const feedback = await this.readPullRequestFeedback(worktree.worktreePath, sync.pullRequest.url).catch(() => undefined);
    return feedback ? { ...sync, feedback } : sync;
  }

  /**
   * What people said on the pull request: review threads, a page at a time up
   * to a bound, review summaries and the conversation.
   */
  async readPullRequestFeedback(cwd: string, url: string | undefined): Promise<PullRequestFeedback | undefined> {
    const location = gitHubLocation(url);
    if (!location) return undefined;
    const data = await this.pullRequestQuery<GitHubFeedbackData>(cwd, location, GITHUB_FEEDBACK_QUERY);
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (threads) {
      let page: GitHubThreadConnection = threads;
      for (let pages = 1; page.pageInfo?.hasNextPage && page.pageInfo.endCursor && pages < GITHUB_THREAD_PAGES; pages += 1) {
        const next = (await this.pullRequestQuery<GitHubFeedbackData>(cwd, location, GITHUB_THREADS_PAGE_QUERY, { after: page.pageInfo.endCursor }))
          .repository?.pullRequest?.reviewThreads;
        if (!next) break;
        threads.nodes = [...(threads.nodes ?? []), ...(next.nodes ?? [])];
        page = next;
      }
    }
    return parseGitHubPullRequestFeedback(data, location.number, new Date().toISOString());
  }

  /** A GraphQL read of one pull request, which the query names by `owner`, `name` and `number`. */
  private pullRequestQuery<T>(cwd: string, location: GitHubLocation, query: string, strings: Record<string, string> = {}): Promise<T> {
    return this.cli.graphql<T>({
      host: location.host, cwd, query, subject: `${location.owner}/${location.name}`,
      strings: { owner: location.owner, name: location.name, ...strings },
      integers: { number: location.number }
    });
  }

  async markReadyForReview(worktree: WorktreeRecord, address: PullRequestAddress): Promise<void> {
    const location = requireGitHubLocation(address);
    await this.cli.run(['pr', 'ready', address.url], { cwd: worktree.worktreePath, host: location.host, timeout: 60_000 });
  }

  async readMergeOptions(worktree: WorktreeRecord, address: PullRequestAddress): Promise<PullRequestMergeOptions> {
    const location = requireGitHubLocation(address);
    return parseGitHubMergeOptions(await this.pullRequestQuery<NonNullable<Parameters<typeof parseGitHubMergeOptions>[0]>>(
      worktree.worktreePath, location, GITHUB_MERGE_OPTIONS_QUERY));
  }

  /**
   * Through the REST API rather than `gh pr merge`, which also deletes and
   * switches local branches: the task's worktree is Task Monki's to manage.
   */
  async mergePullRequest(worktree: WorktreeRecord, address: PullRequestAddress, input: {
    method: 'SQUASH' | 'MERGE' | 'REBASE';
    expectedHeadSha: string;
    deleteBranch?: string;
  }): Promise<void> {
    const location = requireGitHubLocation(address);
    const repository = `repos/${location.owner}/${location.name}`;
    try {
      await this.cli.run([
        'api', '--hostname', location.host, '--method', 'PUT', `${repository}/pulls/${location.number}/merge`,
        '-f', `merge_method=${input.method.toLowerCase()}`, '-f', `sha=${input.expectedHeadSha}`
      ], { cwd: worktree.worktreePath, host: location.host, timeout: 120_000 });
    } catch (error) {
      // A gh that is missing or signed out already says so; anything else is GitHub's refusal.
      throw error instanceof RemoteWorkError ? error : new Error(gitHubMergeFailure(commandText(error)));
    }
    if (input.deleteBranch) {
      // The repository may delete it itself; a branch already gone is the outcome asked for.
      await this.cli.run([
        'api', '--hostname', location.host, '--method', 'DELETE',
        `${repository}/git/refs/heads/${input.deleteBranch.split('/').map(encodeURIComponent).join('/')}`
      ], { cwd: worktree.worktreePath, host: location.host }).catch(() => undefined);
    }
  }

  async replyToDiscussion(worktree: WorktreeRecord, address: PullRequestAddress, discussionId: string, body: string): Promise<void> {
    const location = requireGitHubLocation(address);
    await this.cli.graphql({
      host: location.host, cwd: worktree.worktreePath, query: GITHUB_THREAD_REPLY_MUTATION,
      strings: { threadId: discussionId }, stdinField: { name: 'body', value: body }, timeout: 60_000
    });
  }

  async resolveDiscussion(worktree: WorktreeRecord, address: PullRequestAddress, discussionId: string, resolved = true): Promise<void> {
    const location = requireGitHubLocation(address);
    await this.cli.graphql({
      host: location.host, cwd: worktree.worktreePath, query: resolved ? GITHUB_RESOLVE_THREAD_MUTATION : GITHUB_UNRESOLVE_THREAD_MUTATION,
      strings: { threadId: discussionId }, timeout: 60_000
    });
  }

  async commentOnPullRequest(worktree: WorktreeRecord, address: PullRequestAddress, body: string): Promise<void> {
    const location = requireGitHubLocation(address);
    await this.cli.run(['pr', 'comment', address.url, '--body-file', '-'],
      { cwd: worktree.worktreePath, host: location.host, timeout: 60_000, stdin: body });
  }

  async requestReviewers(worktree: WorktreeRecord, address: PullRequestAddress, names: string[]): Promise<void> {
    const location = requireGitHubLocation(address);
    await this.cli.run([
      'api', '--hostname', location.host, '--method', 'POST',
      `repos/${location.owner}/${location.name}/pulls/${location.number}/requested_reviewers`,
      ...names.flatMap((name) => ['-f', `reviewers[]=${name}`])
    ], { cwd: worktree.worktreePath, host: location.host, timeout: 60_000 });
  }

  async readCheckLog(worktree: WorktreeRecord, address: PullRequestAddress, check: GitHubCheckDetailRecord): Promise<string | undefined> {
    const location = requireGitHubLocation(address);
    const job = ownActionsJob(check.link, location);
    if (!job) return undefined;
    const result = await this.cli.run([
      'api', '--hostname', location.host, `repos/${location.owner}/${location.name}/actions/jobs/${job.job}/logs`
    ], { cwd: worktree.worktreePath, host: location.host, timeout: 60_000 });
    return result.stdout;
  }

  async rerunFailedChecks(worktree: WorktreeRecord, address: PullRequestAddress, checks: readonly GitHubCheckDetailRecord[]): Promise<number> {
    const location = requireGitHubLocation(address);
    // One request per run re-runs every failed job in it.
    const runs = new Set(checks.flatMap((check) => ownActionsJob(check.link, location)?.run ?? []));
    return startEach(runs, (run) => this.cli.run([
      'api', '--method', 'POST', '--hostname', location.host, `repos/${location.owner}/${location.name}/actions/runs/${run}/rerun-failed-jobs`
    ], { cwd: worktree.worktreePath, host: location.host, timeout: 60_000 }));
  }
}

/** A GitHub Actions job of this pull request's own repository; a run elsewhere is not its to read or start. */
function ownActionsJob(link: string | undefined, location: { owner: string; name: string }): ReturnType<typeof gitHubActionsJob> {
  const job = gitHubActionsJob(link);
  return job && job.owner.toLowerCase() === location.owner.toLowerCase() && job.name.toLowerCase() === location.name.toLowerCase() ? job : undefined;
}

interface GitHubLocation {
  host: string;
  owner: string;
  name: string;
  number: number;
}

/** The repository and number a github.com pull request link names. */
function gitHubLocation(url: string | undefined): GitHubLocation | undefined {
  const reference = url ? parseRemoteWorkReference(url) : undefined;
  if (reference?.repository?.provider !== 'GITHUB' || reference.kind !== 'PULL_REQUEST') return undefined;
  const [owner, name] = reference.repository.path.split('/') as [string, string];
  return { host: reference.repository.host, owner, name, number: reference.number };
}

function requireGitHubLocation(address: PullRequestAddress): GitHubLocation {
  const location = gitHubLocation(address.url);
  if (!location || location.number !== address.number) throw new Error('The pull request is not recorded.');
  return location;
}

function commandText(error: unknown): string {
  const execError = error as ExecError;
  return `${bufferToString(execError?.stderr)}\n${bufferToString(execError?.stdout)}\n${error instanceof Error ? error.message : ''}`;
}

function headOwner(repository: { path: string }): string {
  return repository.path.split('/')[0]!;
}

function repositoryArgs(target?: DeliveryTarget, remote?: DeliveryRemote): string[] {
  if (target) return ['--repo', `${target.repository.host}/${target.repository.path}`];
  return remote ? ['--repo', `${remote.host}/${remote.owner}/${remote.repo}`] : [];
}

function matchesExternalPullRequest(raw: unknown, worktree: WorktreeRecord, remote: DeliveryRemote): boolean {
  if (!raw || typeof raw !== 'object') throw new Error('GitHub returned an invalid pull request.');
  const row = raw as Record<string, unknown>;
  const owner = row.headRepositoryOwner as { login?: string } | undefined;
  const repository = row.headRepository as { name?: string } | undefined;
  if (typeof row.number !== 'number' || typeof row.url !== 'string' || typeof row.headRefName !== 'string' ||
      typeof row.isCrossRepository !== 'boolean' || !owner?.login || !repository?.name) {
    throw new Error('GitHub did not return complete pull request identity.');
  }
  return row.isCrossRepository === false && row.headRefName === worktree.branchName &&
    owner.login.toLowerCase() === remote.owner.toLowerCase() && repository.name.toLowerCase() === remote.repo.toLowerCase() &&
    row.url.toLowerCase() === `https://${remote.host}/${remote.owner}/${remote.repo}/pull/${row.number}`.toLowerCase();
}

/**
 * The checkout's GitHub remote a task pushes to and opens its pull request
 * from: `origin` when it is on GitHub (a contributor's fork or the repository
 * itself), otherwise the first GitHub remote, as on GitLab. It names the
 * canonical host and a URL without credentials, which preflight records.
 */
export async function detectGitHubRemote(worktreePath: string): Promise<DeliveryRemote | undefined> {
  const remotes = (await listCheckoutRemoteRepositories(worktreePath)).filter((candidate) => candidate.provider === 'GITHUB');
  const remote = remotes.find((candidate) => candidate.remoteName === 'origin') ?? remotes[0];
  return remote ? deliveryRemote(remote) : undefined;
}

export function parsePrView(
  raw: unknown,
  worktree: WorktreeRecord,
  rawCheckDetails?: unknown
): PullRequestSync {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const number = numberField(data, 'number');
  const headSha = stringField(data, 'headRefOid');
  const state = stringField(data, 'state');
  const isDraft = booleanField(data, 'isDraft');
  const reportedMergedAt = stringOrNullField(data, 'mergedAt');
  const status = derivePullRequestStatus({ state, isDraft, mergedAt: reportedMergedAt });
  const mergedAt = canonicalPlatformTime(reportedMergedAt);

  return {
    pullRequest: {
      taskId: worktree.taskId,
      iterationId: worktree.iterationId,
      worktreeId: worktree.id,
      number,
      url: stringField(data, 'url'),
      status,
      state,
      isDraft,
      headRefName: stringField(data, 'headRefName'),
      headRefOid: headSha,
      baseRefName: stringField(data, 'baseRefName'),
      mergedAt,
      title: stringField(data, 'title'),
      raw
    },
    ci: parseCiRollup(data.statusCheckRollup, worktree, number, headSha, rawCheckDetails),
    reviews: parseReviewRollup(data, worktree, number, headSha),
    merge: parseMergeSnapshot(data, worktree, number, headSha)
  };
}

export function parseCiRollup(
  rawRollup: unknown,
  worktree: WorktreeRecord,
  pullRequestNumber?: number,
  headSha?: string,
  rawCheckDetails?: unknown
): Omit<CiRollupRecord, 'id' | 'observedAt'> {
  // Every check counts toward the rollup; the record keeps a bounded list, failures first.
  const allDetails = parseCheckDetails(rawCheckDetails);
  const checkDetails = allDetails.length > MAX_CHECK_DETAILS
    ? [...allDetails.filter((check) => check.status === 'failed'), ...allDetails.filter((check) => check.status !== 'failed')].slice(0, MAX_CHECK_DETAILS)
    : allDetails;
  const rows = allDetails.length > 0 ? allDetails : Array.isArray(rawRollup) ? rawRollup : [];
  let passingCount = 0;
  let pendingCount = 0;
  let failingCount = 0;
  let skippedCount = 0;
  let canceledCount = 0;

  for (const row of rows) {
    const status = isCheckDetail(row) ? row.status : normalizeRollupCheckStatus(row);
    switch (status) {
      case 'passed':
        passingCount += 1;
        break;
      case 'failed':
        failingCount += 1;
        break;
      case 'skipped':
        skippedCount += 1;
        break;
      case 'canceled':
        canceledCount += 1;
        break;
      case 'pending':
        pendingCount += 1;
        break;
    }
  }

  const totalCount = rows.length;
  const nonSkippedCount = totalCount - skippedCount;
  const status: CiChecksStatus =
    totalCount === 0
      ? 'NO_CHECKS'
      : nonSkippedCount === 0
        ? 'NO_CHECKS'
      : failingCount > 0
        ? 'FAILING'
        : canceledCount > 0
          ? 'CANCELED'
          : pendingCount > 0
            ? 'PENDING'
            : 'PASSING';

  return {
    taskId: worktree.taskId,
    iterationId: worktree.iterationId,
    worktreeId: worktree.id,
    pullRequestNumber,
    headSha,
    status,
    requiredStatus: 'UNKNOWN',
    totalCount,
    pendingCount,
    passingCount,
    failingCount,
    skippedCount,
    canceledCount,
    checkDetails,
    raw: rawRollup
  };
}

export function parseReviewRollup(
  raw: Record<string, unknown>,
  worktree: WorktreeRecord,
  pullRequestNumber?: number,
  headSha?: string
): Omit<ReviewRollupRecord, 'id' | 'observedAt'> {
  const decision = stringField(raw, 'reviewDecision');
  const status =
    decision === 'APPROVED'
      ? 'APPROVED'
      : decision === 'CHANGES_REQUESTED'
        ? 'CHANGES_REQUESTED'
        : decision === 'REVIEW_REQUIRED'
          ? 'REQUESTED'
          : 'NOT_REQUESTED';

  return {
    taskId: worktree.taskId,
    iterationId: worktree.iterationId,
    worktreeId: worktree.id,
    pullRequestNumber,
    headSha,
    status,
    ...(decision ? { reviewDecision: decision } : {}),
    raw
  };
}

export function parseMergeSnapshot(
  raw: Record<string, unknown>,
  worktree: WorktreeRecord,
  pullRequestNumber?: number,
  headSha?: string
): Omit<MergeSnapshotRecord, 'id' | 'observedAt'> {
  const state = stringField(raw, 'state');
  const reportedMergedAt = stringOrNullField(raw, 'mergedAt');
  const mergedAt = canonicalPlatformTime(reportedMergedAt);
  const status: MergeSnapshotRecord['status'] = reportedMergedAt
    ? 'MERGED'
    : state === 'CLOSED'
      ? 'CLOSED_UNMERGED'
      : state === 'MERGED'
        ? 'MERGED'
        : gitHubMergeStatus(stringField(raw, 'mergeStateStatus')?.toUpperCase(), stringField(raw, 'mergeable')?.toUpperCase());
  return {
    taskId: worktree.taskId,
    iterationId: worktree.iterationId,
    worktreeId: worktree.id,
    pullRequestNumber,
    headSha,
    status,
    mergedAt,
    raw
  };
}

/**
 * An open pull request's merge state. `mergeable` speaks only of Git
 * conflicts, so GitHub's merge state decides: a draft, or one held by branch
 * protection (required reviews, checks or resolved conversations), is not
 * mergeable yet, for reasons its own evidence states, and only conflicts or a
 * branch that must be updated block it outright.
 */
function gitHubMergeStatus(mergeStateStatus: string | undefined, mergeable: string | undefined): MergeSnapshotRecord['status'] {
  switch (mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    // Mergeable while checks that are not required fail; the checks say so.
    case 'UNSTABLE':
      return 'MERGEABLE';
    case 'DIRTY':
    case 'BEHIND':
      return 'BLOCKED';
    case 'DRAFT':
    case 'BLOCKED':
      return mergeable === 'CONFLICTING' ? 'BLOCKED' : 'NOT_MERGED';
    case 'UNKNOWN':
      return 'UNKNOWN';
    default:
      return mergeable === 'MERGEABLE' ? 'MERGEABLE'
        : mergeable === 'CONFLICTING' ? 'BLOCKED'
          : mergeable === 'UNKNOWN' ? 'UNKNOWN'
            : 'NOT_MERGED';
  }
}

const prJsonFields = [
  'number',
  'url',
  'state',
  'isDraft',
  'mergedAt',
  'reviewDecision',
  'statusCheckRollup',
  'headRefOid',
  'headRefName',
  'baseRefName',
  'mergeable',
  'mergeStateStatus',
  'title'
].join(',');

const prChecksJsonFields = [
  'bucket',
  'state',
  'name',
  'workflow',
  'link',
  'description',
  'event',
  'startedAt',
  'completedAt'
].join(',');

const MAX_CHECK_DETAILS = 80;

function parseCheckDetails(rawCheckDetails: unknown): GitHubCheckDetailRecord[] {
  const rows = Array.isArray(rawCheckDetails) ? rawCheckDetails : [];
  return rows.map((row) => {
    const item = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    // Platform text is stored trimmed, and an empty value is no value: the store loads neither.
    const text = (key: string) => stringField(item, key)?.trim() || undefined;
    // Names are labels people read and agents are sent, so they keep only what a reader sees.
    // Logs and re-runs find a job by the id in its link.
    const label = (key: string) => stringField(item, key)?.replace(INVISIBLE_CHARACTERS, '').trim() || undefined;
    return {
      name: label('name') ?? 'Unnamed check',
      status: normalizeCheckStatus(stringField(item, 'bucket'), stringField(item, 'state')),
      state: text('state'),
      workflow: label('workflow'),
      link: text('link'),
      description: stringField(item, 'description'),
      event: text('event'),
      startedAt: text('startedAt'),
      completedAt: text('completedAt')
    };
  });
}

function isCheckDetail(row: unknown): row is GitHubCheckDetailRecord {
  return (
    Boolean(row) &&
    typeof row === 'object' &&
    typeof (row as GitHubCheckDetailRecord).name === 'string' &&
    typeof (row as GitHubCheckDetailRecord).status === 'string'
  );
}

function normalizeRollupCheckStatus(row: unknown): GitHubCheckStatus {
  const item = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const value =
    stringField(item, 'conclusion') ??
    stringField(item, 'state') ??
    stringField(item, 'status');
  return normalizeCheckStatus(undefined, value);
}

function normalizeCheckStatus(bucket?: string, state?: string): GitHubCheckStatus {
  const normalizedBucket = bucket?.toLowerCase();
  if (normalizedBucket === 'pass') {
    return 'passed';
  }
  if (normalizedBucket === 'fail') {
    return 'failed';
  }
  if (normalizedBucket === 'skipping') {
    return 'skipped';
  }
  if (normalizedBucket === 'cancel') {
    return 'canceled';
  }
  if (normalizedBucket === 'pending') {
    return 'pending';
  }

  const normalizedState = state?.toUpperCase();
  if (!normalizedState || ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(normalizedState)) {
    return 'pending';
  }
  if (['SUCCESS', 'PASSING', 'PASSED'].includes(normalizedState)) {
    return 'passed';
  }
  if (['SKIPPED', 'NEUTRAL'].includes(normalizedState)) {
    return 'skipped';
  }
  if (['CANCELLED', 'CANCELED', 'CANCEL'].includes(normalizedState)) {
    return 'canceled';
  }
  if (['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(normalizedState)) {
    return 'failed';
  }
  return 'pending';
}

function derivePullRequestStatus(input: {
  state?: string;
  isDraft?: boolean;
  mergedAt?: string | null;
}): PullRequestSnapshotRecord['status'] {
  if (input.mergedAt || input.state === 'MERGED') {
    return 'MERGED';
  }
  if (input.state === 'CLOSED') {
    return 'CLOSED_UNMERGED';
  }
  if (input.state === 'OPEN') {
    return input.isDraft ? 'OPEN_DRAFT' : 'OPEN_READY';
  }
  return 'UNKNOWN';
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function stringOrNullField(payload: Record<string, unknown>, key: string): string | null | undefined {
  const value = payload[key];
  return typeof value === 'string' || value === null ? value : undefined;
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

function booleanField(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function publishBranchErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (isRejectedPushError(error)) {
    return 'Remote branch has newer commits';
  }
  return message;
}

function isRejectedPushError(error: unknown): boolean {
  const execError: { stdout?: string | Buffer; stderr?: string | Buffer } =
    typeof error === 'object' && error !== null ? (error as ExecError) : {};
  const normalized = [
    errorMessage(error),
    bufferToString(execError.stdout),
    bufferToString(execError.stderr)
  ]
    .join('\n')
    .toLowerCase();
  return (
    normalized.includes('fetch first') ||
    normalized.includes('non-fast-forward') ||
    normalized.includes('remote contains work') ||
    normalized.includes('updates were rejected') ||
    // A lease that no longer holds: the branch moved or was deleted, and nothing landed.
    normalized.includes('stale info')
  );
}

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return value?.toString('utf8') ?? '';
}
