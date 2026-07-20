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
import { execFilePortable } from '../process/portableChildProcess';

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
    const remote = await detectGitHubRemote(worktree.worktreePath);
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
  }): Promise<Omit<BranchPublicationRecord, 'id' | 'requestedAt' | 'updatedAt'>> {
    const remoteName = input.remoteName ?? 'origin';
    const branchName = input.worktree.branchName;
    try {
      await git(input.worktree.worktreePath, ['push', '--set-upstream', remoteName, 'HEAD'], 120_000);
      const headSha = (await git(input.worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
      return {
        taskId: input.task.id,
        iterationId: input.worktree.iterationId,
        worktreeId: input.worktree.id,
        remoteName,
        branchName,
        remoteRef: `${remoteName}/${branchName}`,
        headSha,
        status: 'PUSHED'
      };
    } catch (error) {
      return {
        taskId: input.task.id,
        iterationId: input.worktree.iterationId,
        worktreeId: input.worktree.id,
        remoteName,
        branchName,
        remoteRef: `${remoteName}/${branchName}`,
        status: 'FAILED',
        error: publishBranchErrorMessage(error)
      };
    }
  }

  async createOrFindDraftPullRequest(input: {
    worktree: WorktreeRecord;
    baseRef?: string;
    body: string;
    title: string;
  }): Promise<GitHubPrSync> {
    const existing = await this.findOpenPullRequest(input.worktree);
    if (existing) {
      return existing;
    }

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
        input.baseRef ?? input.worktree.baseRef ?? 'main',
        '--head',
        input.worktree.branchName
      ],
      input.worktree.worktreePath,
      120_000,
      [],
      input.body
    );

    const url = createResult.stdout.trim().split(/\s+/).find((value) => value.startsWith('http'));
    return this.viewPullRequest(input.worktree, url ?? input.worktree.branchName);
  }

  async findOpenPullRequest(worktree: WorktreeRecord): Promise<GitHubPrSync | undefined> {
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
        prJsonFields
      ],
      worktree.worktreePath
    );
    const rows = parseJson<unknown[]>(result.stdout, []);
    const match = rows.map((row) => parsePrView(row, worktree)).find((row) => row.pullRequest.number);
    return match?.pullRequest.number
      ? this.viewPullRequest(worktree, match.pullRequest.number)
      : match;
  }

  async viewPullRequest(worktree: WorktreeRecord, selector: string | number): Promise<GitHubPrSync> {
    const [viewResult, checksResult] = await Promise.all([
      this.exec(['pr', 'view', String(selector), '--json', prJsonFields], worktree.worktreePath),
      this.exec(
        ['pr', 'checks', String(selector), '--json', prChecksJsonFields],
        worktree.worktreePath,
        30_000,
        [8]
      ).catch(() => undefined)
    ]);
    return parsePrView(
      parseJson<Record<string, unknown>>(viewResult.stdout, {}),
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
      '## Agent summary',
      '',
      input.agentSummary?.trim().slice(0, 8000) || 'No agent final summary captured.',
      '',
      '## Delivery note',
      '',
      'Created by Task Monki as a draft PR. Merge remains a human/GitHub decision.',
      ''
    ].join('\n');
  }

  private async exec(
    argv: string[],
    cwd: string,
    timeout = 30_000,
    allowedExitCodes: number[] = [],
    stdin?: string | Buffer
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFilePortable(
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

export async function detectGitHubRemote(worktreePath: string): Promise<GitHubRemote | undefined> {
  const output = await git(worktreePath, ['remote', '-v']);
  for (const line of output.split('\n')) {
    const match = /^(?<name>\S+)\s+(?<url>\S+)\s+\((?<direction>fetch|push)\)$/.exec(line.trim());
    if (!match?.groups || match.groups.direction !== 'fetch') {
      continue;
    }
    const parsed = parseGitHubRemoteUrl(match.groups.url);
    if (parsed) {
      return {
        remoteName: match.groups.name,
        remoteUrl: match.groups.url,
        ...parsed
      };
    }
  }
  return undefined;
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
    reviewDecision: decision,
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
  const normalized = message.toLowerCase();
  if (
    normalized.includes('fetch first') ||
    normalized.includes('non-fast-forward') ||
    normalized.includes('remote contains work') ||
    normalized.includes('updates were rejected')
  ) {
    return 'Remote branch has newer commits. Sync the branch before pushing again.';
  }
  return message;
}

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return value?.toString('utf8') ?? '';
}
