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
import { git } from '../git/gitCli';
import { execFileOwnedPortable } from '../process/ownedProcess';

export interface GitHubRemote {
  remoteName: string;
  remoteUrl: string;
  host: string;
  owner: string;
  repo: string;
}

export interface GitHubPrSync {
  pullRequest: Omit<PullRequestSnapshotRecord, 'id' | 'observedAt'>;
  ci: Omit<CiRollupRecord, 'id' | 'observedAt'>;
  reviews: Omit<ReviewRollupRecord, 'id' | 'observedAt'>;
  merge: Omit<MergeSnapshotRecord, 'id' | 'observedAt'>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecError extends Error {
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export class GitHubService {
  constructor(private ghExecutable = 'gh') {}

  setExecutable(executable: string | undefined): void {
    this.ghExecutable = executable ?? 'gh';
  }

  async preflight(task: Task, worktree: WorktreeRecord): Promise<Omit<GitHubRepositoryRecord, 'id' | 'checkedAt'>> {
    const remote = await detectGitHubRemote(worktree.worktreePath, worktree.ownership === 'EXTERNAL');
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
      const version = await this.exec(['--version'], worktree.worktreePath);
      ghVersion = version.stdout.split('\n')[0]?.trim();
    } catch (error) {
      return {
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        ...remote,
        status: 'GH_MISSING',
        error: errorMessage(error)
      };
    }

    try {
      await this.exec(['auth', 'status', '--hostname', remote.host], worktree.worktreePath);
    } catch (error) {
      return {
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        ...remote,
        ghVersion,
        authStatus: 'UNAUTHENTICATED',
        status: 'AUTH_REQUIRED',
        error: errorMessage(error)
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
    expectedHeadSha?: string;
    expectedRemoteUrl?: string;
  }): Promise<Omit<BranchPublicationRecord, 'id' | 'requestedAt' | 'updatedAt'>> {
    const remoteName = input.remoteName ?? 'origin';
    const branchName = input.worktree.branchName;
    let headSha: string;
    let pushRemoteUrl: string | undefined;
    let pushArgs = ['push', '--set-upstream', remoteName, 'HEAD'];
    if (input.worktree.ownership === 'EXTERNAL') {
      const remote = await this.validateExternalDeliverySource({ ...input, remoteName });
      headSha = input.expectedHeadSha!;
      // Pin the explicit action's source and destination, not the task's future
      // configuration. Do not change upstream or push a later external commit.
      pushArgs = ['push', remote.remoteUrl, `${headSha}:refs/heads/${branchName}`];
      pushRemoteUrl = remote.remoteUrl;
    } else {
      headSha = (await git(input.worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    }
    try {
      await git(input.worktree.worktreePath, pushArgs, 120_000);
      return {
        taskId: input.task.id,
        iterationId: input.worktree.iterationId,
        worktreeId: input.worktree.id,
        remoteName,
        ...(pushRemoteUrl ? { remoteUrl: pushRemoteUrl } : {}),
        branchName,
        remoteRef: `${remoteName}/${branchName}`,
        headSha,
        status: 'PUSHED'
      };
    } catch (error) {
      const pushError = publishBranchErrorMessage(error);
      if (isRejectedPushError(error)) {
        return {
          taskId: input.task.id,
          iterationId: input.worktree.iterationId,
          worktreeId: input.worktree.id,
          remoteName,
          ...(pushRemoteUrl ? { remoteUrl: pushRemoteUrl } : {}),
          branchName,
          remoteRef: `${remoteName}/${branchName}`,
          headSha,
          status: 'FAILED',
          error: pushError
        };
      }
      return this.reconcileBranchPublication({
        task: input.task,
        worktree: input.worktree,
        remoteName,
        remoteUrl: pushRemoteUrl,
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
    expectedHeadSha?: string;
    failureDetail?: string;
  }): Promise<Omit<BranchPublicationRecord, 'id' | 'requestedAt' | 'updatedAt'>> {
    const branchName = input.worktree.branchName;
    const base = {
      taskId: input.task.id,
      iterationId: input.worktree.iterationId,
      worktreeId: input.worktree.id,
      remoteName: input.remoteName,
      ...(input.remoteUrl ? { remoteUrl: input.remoteUrl } : {}),
      branchName,
      remoteRef: `${input.remoteName}/${branchName}`,
      headSha: input.expectedHeadSha
    };
    if (input.worktree.ownership === 'EXTERNAL' && !input.remoteUrl) {
      return {
        ...base,
        status: 'AMBIGUOUS',
        error: 'The interrupted push did not retain its destination URL. Inspect the original remote before retrying.'
      };
    }
    let remoteHeadSha: string | undefined;
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
    expectedHeadSha?: string;
    expectedRemoteUrl?: string;
    body: string;
    title: string;
  }): Promise<GitHubPrSync> {
    const existing = await this.findOpenPullRequest(input.worktree);
    const externalRemote = input.worktree.ownership === 'EXTERNAL'
      ? await this.validateExternalDeliverySource(input)
      : undefined;
    if (existing) {
      if (externalRemote && existing.pullRequest.headRefOid !== input.expectedHeadSha) {
        throw new Error('The GitHub pull request head does not match the delivered commit. Refresh before continuing.');
      }
      return existing;
    }

    const repositoryArgs = externalRemote
      ? ['--repo', `${externalRemote.host}/${externalRemote.owner}/${externalRemote.repo}`]
      : [];
    const baseRef = input.baseRef ?? input.worktree.baseRef ?? 'main';
    await this.validatePullRequestBase(input.worktree, baseRef);
    const createResult = await this.exec(
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
        input.worktree.branchName,
        ...repositoryArgs
      ],
      input.worktree.worktreePath,
      120_000,
      [],
      input.body
    );

    const url = createResult.stdout.trim().split(/\s+/).find((value) => value.startsWith('http'));
    const sync = await this.viewPullRequest(input.worktree, url ?? input.worktree.branchName);
    if (externalRemote && sync.pullRequest.headRefOid !== input.expectedHeadSha) {
      throw new Error('The GitHub pull request head does not match the delivered commit. Refresh before continuing.');
    }
    return sync;
  }

  async validatePullRequestBase(
    worktree: WorktreeRecord,
    baseRef = worktree.baseRef ?? 'main'
  ): Promise<void> {
    if (worktree.ownership === 'EXTERNAL') {
      await git(worktree.worktreePath, ['check-ref-format', '--branch', baseRef]);
      if (baseRef === worktree.branchName || /^[a-f0-9]{40,64}$/i.test(baseRef) || baseRef === 'HEAD') {
        throw new Error('Select a different base branch before creating a pull request.');
      }
    }
  }

  private async validateExternalDeliverySource(input: {
    worktree: WorktreeRecord;
    remoteName?: string;
    expectedHeadSha?: string;
    expectedRemoteUrl?: string;
  }): Promise<GitHubRemote> {
    const cwd = input.worktree.worktreePath;
    const remote = await detectGitHubRemote(cwd, true);
    const dirty = await git(cwd, ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '-z'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
    const headSha = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(cwd, ['branch', '--show-current'])).trim();
    if (
      !input.expectedHeadSha || headSha !== input.expectedHeadSha || branch !== input.worktree.branchName ||
      !remote || remote.remoteUrl !== input.expectedRemoteUrl ||
      (input.remoteName !== undefined && remote.remoteName !== input.remoteName)
    ) {
      throw new Error('The shared checkout or delivery destination changed. Refresh before GitHub delivery.');
    }
    if (dirty) throw new Error('Commit shared-checkout changes in your existing application before GitHub delivery.');
    return remote;
  }

  async findOpenPullRequest(worktree: WorktreeRecord): Promise<GitHubPrSync | undefined> {
    const repositoryArgs = await this.repositoryArgs(worktree);
    const result = await this.exec(
      [
        'pr',
        'list',
        '--state',
        'open',
        '--head',
        worktree.branchName,
        '--limit',
        '10',
        '--json',
        worktree.ownership === 'EXTERNAL' ? externalPrJsonFields : prJsonFields,
        ...repositoryArgs
      ],
      worktree.worktreePath
    );
    const rows = worktree.ownership === 'EXTERNAL' ? JSON.parse(result.stdout) as unknown : parseJson<unknown[]>(result.stdout, []);
    if (!Array.isArray(rows)) throw new Error('GitHub returned an invalid pull request list.');
    if (worktree.ownership === 'EXTERNAL') {
      if (rows.length >= 10) throw new Error('The branch has too many pull request matches to identify one safely.');
      const remote = await detectGitHubRemote(worktree.worktreePath, true);
      if (!remote) throw new Error('No unambiguous GitHub repository is available.');
      const matches = rows.filter((row) => matchesAttachedPullRequest(row, worktree, remote));
      if (matches.length !== rows.length || matches.length > 1) {
        throw new Error('GitHub pull request matches are ambiguous or belong to another repository.');
      }
      if (!matches.length) return undefined;
      const number = numberField(matches[0] as Record<string, unknown>, 'number');
      if (!number) throw new Error('GitHub did not identify the matching pull request.');
      return this.viewPullRequest(worktree, number);
    }
    const match = rows.map((row) => parsePrView(row, worktree)).find((row) => row.pullRequest.number);
    return match?.pullRequest.number
      ? this.viewPullRequest(worktree, match.pullRequest.number)
      : match;
  }

  async viewPullRequest(worktree: WorktreeRecord, selector: string | number): Promise<GitHubPrSync> {
    const repositoryArgs = await this.repositoryArgs(worktree);
    const [viewResult, checksResult] = await Promise.all([
      this.exec(['pr', 'view', String(selector), '--json', worktree.ownership === 'EXTERNAL' ? externalPrJsonFields : prJsonFields, ...repositoryArgs], worktree.worktreePath),
      this.exec(
        ['pr', 'checks', String(selector), '--json', prChecksJsonFields, ...repositoryArgs],
        worktree.worktreePath,
        30_000,
        [8]
      ).catch(() => undefined)
    ]);
    const raw = worktree.ownership === 'EXTERNAL' ? JSON.parse(viewResult.stdout) : parseJson<Record<string, unknown>>(viewResult.stdout, {});
    if (worktree.ownership === 'EXTERNAL') {
      const remote = await detectGitHubRemote(worktree.worktreePath, true);
      if (!remote || !matchesAttachedPullRequest(raw, worktree, remote)) {
        throw new Error('The pull request does not match the attached repository and branch.');
      }
    }
    return parsePrView(
      raw,
      worktree,
      checksResult ? parseJson<unknown[]>(checksResult.stdout, []) : undefined
    );
  }

  buildPullRequestBody(input: {
    task: Task;
    gitDiffStat?: string;
    agentSummary?: string;
  }): string {
    return [
      `## Summary`,
      '',
      input.task.prompt.trim().slice(0, 1200),
      '',
      '## Local evidence',
      '',
      `- Diff stat: ${input.gitDiffStat?.trim().slice(0, 4000) || 'No diff stat captured.'}`,
      '',
      ...(input.agentSummary?.trim() ? ['## Agent summary', '', input.agentSummary.trim().slice(0, 8000), ''] : []),
      '## Delivery note',
      '',
      'Created by Task Monki as a draft PR. Merge remains a human/GitHub decision.',
      ''
    ].join('\n');
  }

  private async repositoryArgs(worktree: WorktreeRecord): Promise<string[]> {
    if (worktree.ownership !== 'EXTERNAL') return [];
    const remote = await detectGitHubRemote(worktree.worktreePath, true);
    if (!remote) throw new Error('No unambiguous GitHub remote was found.');
    return ['--repo', `${remote.host}/${remote.owner}/${remote.repo}`];
  }

  private async exec(
    argv: string[],
    cwd: string,
    timeout = 30_000,
    allowedExitCodes: number[] = [],
    stdin?: string | Buffer
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileOwnedPortable(
        this.ghExecutable,
        argv,
        {
          cwd,
          timeout,
          maxBuffer: 20 * 1024 * 1024
        },
        stdin
      );
      return { stdout, stderr };
    } catch (error) {
      const execError = error as ExecError;
      const numericCode =
        typeof execError.code === 'number'
          ? execError.code
          : typeof execError.code === 'string'
            ? Number(execError.code)
            : undefined;
      if (numericCode !== undefined && allowedExitCodes.includes(numericCode)) {
        return {
          stdout: bufferToString(execError.stdout),
          stderr: bufferToString(execError.stderr)
        };
      }
      throw error;
    }
  }
}

export async function detectGitHubRemote(worktreePath: string, requireUnambiguous = false): Promise<GitHubRemote | undefined> {
  const output = await git(worktreePath, ['remote', '-v']);
  const remotes: GitHubRemote[] = [];
  for (const line of output.split('\n')) {
    const match = /^(?<name>\S+)\s+(?<url>\S+)\s+\((?<direction>fetch|push)\)$/.exec(line.trim());
    if (!match?.groups || match.groups.direction !== 'fetch') {
      continue;
    }
    const parsed = parseGitHubRemoteUrl(match.groups.url);
    if (parsed) {
      const remote = {
        remoteName: match.groups.name,
        remoteUrl: match.groups.url,
        ...parsed
      };
      if (!requireUnambiguous) return remote;
      remotes.push(remote);
    }
  }
  if (!remotes.length) return undefined;
  const identities = new Set(remotes.map((remote) => `${remote.host}/${remote.owner}/${remote.repo}`.toLowerCase()));
  if (identities.size !== 1) throw new Error('Select one GitHub destination in the existing repository before delivery.');
  const selected = remotes.find((remote) => remote.remoteName === 'origin') ?? remotes[0];
  const pushUrls = (await git(worktreePath, ['remote', 'get-url', '--push', '--all', selected.remoteName])).trim().split('\n');
  const pushRemote = pushUrls.length === 1 ? parseGitHubRemoteUrl(pushUrls[0]) : undefined;
  if (!pushRemote || `${pushRemote.host}/${pushRemote.owner}/${pushRemote.repo}`.toLowerCase() !== [...identities][0]) {
    throw new Error('The fetch and push destinations do not identify one GitHub repository.');
  }
  return { ...selected, remoteUrl: pushUrls[0] };
}

function matchesAttachedPullRequest(raw: unknown, worktree: WorktreeRecord, remote: GitHubRemote): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const data = raw as Record<string, unknown>;
  const headRepository = data.headRepository as Record<string, unknown> | undefined;
  const headOwner = data.headRepositoryOwner as Record<string, unknown> | undefined;
  try {
    const url = new URL(String(data.url));
    const expectedRepository = `${remote.owner}/${remote.repo}`.toLowerCase();
    return data.isCrossRepository === false && data.headRefName === worktree.branchName &&
      `${headOwner?.login}/${headRepository?.name}`.toLowerCase() === expectedRepository &&
      url.protocol === 'https:' && url.hostname.toLowerCase() === remote.host.toLowerCase() &&
      url.pathname.toLowerCase() === `/${expectedRepository}/pull/${data.number}`;
  } catch {
    return false;
  }
}

export function parseGitHubRemoteUrl(
  remoteUrl: string
): Omit<GitHubRemote, 'remoteName' | 'remoteUrl'> | undefined {
  const normalized = remoteUrl.replace(/\.git$/i, '');

  const https = /^https:\/\/(?<host>github\.com)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/i.exec(normalized);
  if (https?.groups) {
    return https.groups as Omit<GitHubRemote, 'remoteName' | 'remoteUrl'>;
  }

  const ssh = /^git@(?<host>github\.com):(?<owner>[^/]+)\/(?<repo>[^/]+)$/i.exec(normalized);
  if (ssh?.groups) {
    return ssh.groups as Omit<GitHubRemote, 'remoteName' | 'remoteUrl'>;
  }

  const sshUrl = /^ssh:\/\/git@(?<host>github\.com)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/i.exec(normalized);
  if (sshUrl?.groups) {
    return sshUrl.groups as Omit<GitHubRemote, 'remoteName' | 'remoteUrl'>;
  }

  return undefined;
}

export function parsePrView(
  raw: unknown,
  worktree: WorktreeRecord,
  rawCheckDetails?: unknown
): GitHubPrSync {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const number = numberField(data, 'number');
  const headSha = stringField(data, 'headRefOid');
  const state = stringField(data, 'state');
  const isDraft = booleanField(data, 'isDraft');
  const mergedAt = stringOrNullField(data, 'mergedAt');
  const status = derivePullRequestStatus({ state, isDraft, mergedAt });

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
  const checkDetails = parseCheckDetails(rawCheckDetails);
  const rows = checkDetails.length > 0 ? checkDetails : Array.isArray(rawRollup) ? rawRollup : [];
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
  const mergedAt = stringOrNullField(raw, 'mergedAt');
  const mergeable = stringField(raw, 'mergeable')?.toUpperCase();
  const mergeStateStatus = stringField(raw, 'mergeStateStatus')?.toUpperCase();
  const status = mergedAt
    ? 'MERGED'
    : state === 'CLOSED'
      ? 'CLOSED_UNMERGED'
      : state === 'MERGED'
        ? 'MERGED'
        : mergeStateStatus === 'CLEAN' || mergeStateStatus === 'HAS_HOOKS' || mergeable === 'MERGEABLE'
          ? 'MERGEABLE'
          : ['BLOCKED', 'DIRTY', 'BEHIND', 'DRAFT'].includes(mergeStateStatus ?? '')
            ? 'BLOCKED'
            : mergeStateStatus === 'UNKNOWN' || mergeable === 'UNKNOWN'
              ? 'UNKNOWN'
              : 'NOT_MERGED';
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
const externalPrJsonFields = `${prJsonFields},headRepository,headRepositoryOwner,isCrossRepository`;

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
  return rows.slice(0, MAX_CHECK_DETAILS).map((row) => {
    const item = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    return {
      name: stringField(item, 'name') ?? 'Unnamed check',
      status: normalizeCheckStatus(stringField(item, 'bucket'), stringField(item, 'state')),
      state: stringField(item, 'state'),
      workflow: stringField(item, 'workflow'),
      link: stringField(item, 'link'),
      description: stringField(item, 'description'),
      event: stringField(item, 'event'),
      startedAt: stringField(item, 'startedAt'),
      completedAt: stringField(item, 'completedAt')
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
    return 'Remote branch has newer commits. Sync the branch before pushing again.';
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
    normalized.includes('updates were rejected')
  );
}

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return value?.toString('utf8') ?? '';
}
