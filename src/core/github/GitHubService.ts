import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
  BranchPublicationRecord,
  CiChecksStatus,
  CiRollupRecord,
  GitHubRepositoryRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import { git } from '../git/gitCli';

const execFileAsync = promisify(execFile);

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

export class GitHubService {
  constructor(private readonly ghExecutable = process.env.TASK_MANAGER_GH_PATH ?? 'gh') {}

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
        error: errorMessage(error)
      };
    }
  }

  async createOrFindDraftPullRequest(input: {
    task: Task;
    worktree: WorktreeRecord;
    headSha?: string;
    baseRef?: string;
    bodyFilePath: string;
  }): Promise<GitHubPrSync> {
    const existing = await this.findOpenPullRequest(input.worktree, input.headSha);
    if (existing) {
      return existing;
    }

    const createResult = await this.exec(
      [
        'pr',
        'create',
        '--draft',
        '--title',
        input.task.title,
        '--body-file',
        input.bodyFilePath,
        '--base',
        input.baseRef ?? input.worktree.baseRef ?? 'main',
        '--head',
        input.worktree.branchName
      ],
      input.worktree.worktreePath,
      120_000
    );

    const url = createResult.stdout.trim().split(/\s+/).find((value) => value.startsWith('http'));
    return this.viewPullRequest(input.worktree, url ?? input.worktree.branchName);
  }

  async findOpenPullRequest(worktree: WorktreeRecord, headSha?: string): Promise<GitHubPrSync | undefined> {
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
    const match = rows
      .map((row) => parsePrView(row, worktree))
      .find((row) => !headSha || row.pullRequest.headRefOid === headSha);
    return match;
  }

  async viewPullRequest(worktree: WorktreeRecord, selector: string | number): Promise<GitHubPrSync> {
    const result = await this.exec(
      ['pr', 'view', String(selector), '--json', prJsonFields],
      worktree.worktreePath
    );
    return parsePrView(parseJson<Record<string, unknown>>(result.stdout, {}), worktree);
  }

  async writePullRequestBody(input: {
    filePath: string;
    task: Task;
    gitDiffStat?: string;
    testStatus?: string;
    agentSummary?: string;
  }): Promise<string> {
    const body = [
      `## Summary`,
      '',
      input.task.prompt.trim().slice(0, 1200),
      '',
      '## Local evidence',
      '',
      `- Test status: ${input.testStatus ?? 'unknown'}`,
      `- Diff stat: ${input.gitDiffStat?.trim() || 'No diff stat captured.'}`,
      '',
      '## Agent summary',
      '',
      input.agentSummary?.trim() || 'No agent final summary captured.',
      '',
      '## Delivery note',
      '',
      'Created by Task Monki as a draft PR. Merge remains a human/GitHub decision.',
      ''
    ].join('\n');
    await fs.writeFile(input.filePath, body, 'utf8');
    return body;
  }

  private async exec(argv: string[], cwd: string, timeout = 30_000): Promise<ExecResult> {
    const { stdout, stderr } = await execFileAsync(this.ghExecutable, argv, {
      cwd,
      timeout,
      maxBuffer: 20 * 1024 * 1024
    });
    return { stdout, stderr };
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

export function parsePrView(raw: unknown, worktree: WorktreeRecord): GitHubPrSync {
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
    ci: parseCiRollup(data.statusCheckRollup, worktree, number, headSha),
    reviews: parseReviewRollup(data, worktree, number, headSha),
    merge: parseMergeSnapshot(data, worktree, number, headSha)
  };
}

export function parseCiRollup(
  rawRollup: unknown,
  worktree: WorktreeRecord,
  pullRequestNumber?: number,
  headSha?: string
): Omit<CiRollupRecord, 'id' | 'observedAt'> {
  const rows = Array.isArray(rawRollup) ? rawRollup : [];
  let passingCount = 0;
  let pendingCount = 0;
  let failingCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const item = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const conclusion = stringField(item, 'conclusion')?.toUpperCase();
    const state = stringField(item, 'state')?.toUpperCase();
    const status = stringField(item, 'status')?.toUpperCase();
    const value = conclusion ?? state ?? status;

    if (!value || ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(value)) {
      pendingCount += 1;
    } else if (['SUCCESS', 'PASSING'].includes(value)) {
      passingCount += 1;
    } else if (['SKIPPED', 'NEUTRAL'].includes(value)) {
      skippedCount += 1;
    } else if (['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'CANCELED'].includes(value)) {
      failingCount += 1;
    } else {
      pendingCount += 1;
    }
  }

  const totalCount = rows.length;
  const status: CiChecksStatus =
    totalCount === 0
      ? 'NO_CHECKS'
      : failingCount > 0
        ? 'FAILING'
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
  const status = mergedAt
    ? 'MERGED'
    : state === 'CLOSED'
      ? 'CLOSED_UNMERGED'
      : state === 'MERGED'
        ? 'MERGED'
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
  'title'
].join(',');

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
