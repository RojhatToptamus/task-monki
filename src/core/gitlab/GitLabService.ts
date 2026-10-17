import type {
  GitHubRepositoryRecord,
  MergeStatus,
  PullRequestSnapshotRecord,
  ReviewStatus,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import type { RemoteRepositoryRef } from '../../shared/remoteWork';
import { git } from '../git/gitCli';
import { parseCiRollup } from '../github/GitHubService';
import { listCheckoutRemoteRepositories } from '../remote/RemoteCheckout';
import { RemoteWorkError } from '../remote/RemoteWorkError';
import type { DeliveryRemote, DeliveryTarget, PullRequestDelivery, PullRequestSync } from '../remote/PullRequestDelivery';
import { GitLabCli, gitLabProject } from './GitLabCli';

interface GitLabMergeRequest {
  iid?: number;
  web_url?: string;
  title?: string;
  state?: string;
  draft?: boolean;
  source_branch?: string;
  target_branch?: string;
  source_project_id?: number;
  target_project_id?: number;
  sha?: string;
  merged_at?: string | null;
  detailed_merge_status?: string;
  head_pipeline?: { id?: number; project_id?: number; sha?: string; status?: string } | null;
}

interface GitLabJob {
  name?: string;
  stage?: string;
  status?: string;
  allow_failure?: boolean;
  web_url?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

const COMPUTING_MERGE_STATUSES = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing']);

/** Merge request delivery on GitLab through the signed-in GitLab CLI. */
export class GitLabService implements PullRequestDelivery {
  readonly provider = 'GITLAB' as const;

  constructor(private readonly cli = new GitLabCli()) {}

  setExecutable(executable: string | undefined): void {
    this.cli.setExecutable(executable);
  }

  async preflight(task: Task, worktree: WorktreeRecord, pushRemote?: DeliveryRemote): Promise<Omit<GitHubRepositoryRecord, 'id' | 'checkedAt'>> {
    const owner = { taskId: task.id, iterationId: worktree.iterationId, worktreeId: worktree.id };
    const remote = pushRemote ?? await detectGitLabRemote(worktree.worktreePath);
    if (!remote) return { ...owner, status: 'MISSING_REMOTE', error: 'No GitLab remote was found.' };
    try {
      await this.cli.request({ host: remote.host, endpoint: 'user', cwd: worktree.worktreePath });
    } catch (error) {
      const code = error instanceof RemoteWorkError ? error.code : 'FAILED';
      const message = error instanceof Error ? error.message : String(error);
      return code === 'CLI_MISSING' ? { ...owner, ...remote, status: 'GH_MISSING', error: message }
        : code === 'SIGNED_OUT' ? { ...owner, ...remote, authStatus: 'UNAUTHENTICATED', status: 'AUTH_REQUIRED', error: message }
          : { ...owner, ...remote, status: 'ERROR', error: message };
    }
    return { ...owner, ...remote, authStatus: 'AUTHENTICATED', status: 'READY' };
  }

  async createOrFindDraftPullRequest(input: {
    worktree: WorktreeRecord;
    baseRef?: string;
    body: string;
    title: string;
    target?: DeliveryTarget;
  }): Promise<PullRequestSync> {
    const existing = await this.findOpenPullRequest(input.worktree, input.target);
    if (existing) return existing;
    const project = input.target?.repository ?? await this.requireProject(input.worktree);
    const fields: Record<string, string> = {
      source_branch: input.worktree.branchName,
      target_branch: input.baseRef ?? await this.pullRequestBase(input.worktree),
      title: draftTitle(input.title)
    };
    let endpoint = `projects/${gitLabProject(project.path)}/merge_requests`;
    if (input.target?.headRepository) {
      // A merge request from a fork is opened in the fork and targets the upstream project.
      fields.target_project_id = String(await this.projectId(project, input.worktree.worktreePath));
      endpoint = `projects/${gitLabProject(input.target.headRepository.path)}/merge_requests`;
    }
    const created = await this.cli.request<GitLabMergeRequest>({
      host: project.host, endpoint, method: 'POST', fields,
      stdinField: { name: 'description', value: input.body },
      cwd: input.worktree.worktreePath, subject: project.path, timeout: 120_000
    });
    if (typeof created.iid !== 'number') throw new RemoteWorkError('FAILED', 'GitLab did not report the new merge request.');
    return this.viewPullRequest(input.worktree, created.iid, { ...input.target, repository: project });
  }

  async findOpenPullRequest(worktree: WorktreeRecord, target?: DeliveryTarget): Promise<PullRequestSync | undefined> {
    const project = target?.repository ?? await detectGitLabProject(worktree.worktreePath);
    if (!project) return undefined;
    const query = new URLSearchParams({ state: 'opened', source_branch: worktree.branchName, per_page: '10' });
    const rows = await this.cli.request<unknown>({
      host: project.host, endpoint: `projects/${gitLabProject(project.path)}/merge_requests?${query}`,
      cwd: worktree.worktreePath, subject: project.path
    });
    if (!Array.isArray(rows)) throw new RemoteWorkError('FAILED', 'GitLab returned an invalid merge request list.');
    if (rows.length >= 10) throw new Error('The merge request lookup is incomplete. Inspect the branch on GitLab.');
    const sourceProjectId = target?.headRepository ? await this.projectId(target.headRepository, worktree.worktreePath) : undefined;
    const matches = (rows as GitLabMergeRequest[]).filter((row) =>
      row.source_branch === worktree.branchName &&
      (sourceProjectId === undefined ? row.source_project_id === row.target_project_id : row.source_project_id === sourceProjectId));
    if (matches.length > 1) throw new Error('Multiple merge requests match this branch. Inspect the branch on GitLab.');
    return matches[0]?.iid ? this.viewPullRequest(worktree, matches[0].iid, { ...target, repository: project }) : undefined;
  }

  async viewPullRequest(worktree: WorktreeRecord, selector: string | number, target?: DeliveryTarget): Promise<PullRequestSync> {
    const project = target?.repository ?? await this.requireProject(worktree);
    const iid = typeof selector === 'number' ? selector : Number(/\/-\/merge_requests\/(\d+)/u.exec(selector)?.[1]);
    if (!Number.isSafeInteger(iid) || iid < 1) throw new Error('The merge request is not recorded.');
    const base = `projects/${gitLabProject(project.path)}/merge_requests/${iid}`;
    const cwd = worktree.worktreePath;
    const mergeRequest = await this.cli.request<GitLabMergeRequest>({ host: project.host, endpoint: base, cwd, subject: project.path });
    const [approvals, jobs] = await Promise.all([
      this.cli.request<{ approved?: boolean; approvals_left?: number }>({ host: project.host, endpoint: `${base}/approvals`, cwd })
        .catch(() => undefined),
      mergeRequest.head_pipeline?.id
        ? this.cli.request<unknown>({
          host: project.host,
          endpoint: `projects/${mergeRequest.head_pipeline.project_id ?? gitLabProject(project.path)}/pipelines/${mergeRequest.head_pipeline.id}/jobs?per_page=100`,
          cwd
        }).catch(() => undefined)
        : Promise.resolve([])
    ]);
    return parseMergeRequest(mergeRequest, worktree, approvals, Array.isArray(jobs) ? jobs as GitLabJob[] : undefined);
  }

  async pullRequestBase(worktree: WorktreeRecord, requestedBranch?: string): Promise<string> {
    if (worktree.ownership !== 'EXTERNAL') return requestedBranch ?? worktree.baseRef ?? 'main';
    const branch = requestedBranch?.trim().replace(/^refs\/heads\//u, '');
    if (!branch) throw new Error('Choose a target branch for the new merge request.');
    if (branch === 'HEAD' || branch === worktree.branchName) throw new Error('Choose a named target branch other than this checkout branch.');
    await git(worktree.worktreePath, ['check-ref-format', '--branch', branch]);
    const project = await this.requireProject(worktree);
    const found = await this.cli.request<{ name?: string }>({
      host: project.host, endpoint: `projects/${gitLabProject(project.path)}/repository/branches/${encodeURIComponent(branch)}`,
      cwd: worktree.worktreePath, subject: project.path
    });
    if (found.name !== branch) throw new Error('GitLab did not confirm the selected target branch.');
    return branch;
  }

  private async requireProject(worktree: WorktreeRecord): Promise<RemoteRepositoryRef> {
    const project = await detectGitLabProject(worktree.worktreePath);
    if (!project) throw new Error('No GitLab remote was found.');
    return project;
  }

  private async projectId(project: RemoteRepositoryRef, cwd: string): Promise<number> {
    const found = await this.cli.request<{ id?: number }>({
      host: project.host, endpoint: `projects/${gitLabProject(project.path)}`, cwd, subject: project.path
    });
    if (typeof found.id !== 'number') throw new RemoteWorkError('FAILED', 'GitLab did not report the project.');
    return found.id;
  }
}

async function detectGitLabProject(worktreePath: string): Promise<RemoteRepositoryRef | undefined> {
  const remote = (await listCheckoutRemoteRepositories(worktreePath)).find((candidate) => candidate.provider === 'GITLAB');
  return remote ? { provider: remote.provider, host: remote.host, path: remote.path } : undefined;
}

async function detectGitLabRemote(worktreePath: string): Promise<DeliveryRemote | undefined> {
  const remote = (await listCheckoutRemoteRepositories(worktreePath)).find((candidate) => candidate.provider === 'GITLAB');
  if (!remote) return undefined;
  const split = remote.path.lastIndexOf('/');
  return {
    remoteName: remote.remoteName,
    remoteUrl: `https://${remote.host}/${remote.path}.git`,
    host: remote.host,
    owner: remote.path.slice(0, split),
    repo: remote.path.slice(split + 1)
  };
}

/** GitLab marks a draft by its title. */
export function draftTitle(title: string): string {
  return /^\s*(?:draft:|\[draft\]|\(draft\))/iu.test(title) ? title : `Draft: ${title}`;
}

/** One GitLab observation split into Task Monki's PR, check, review and merge evidence. */
export function parseMergeRequest(
  raw: GitLabMergeRequest,
  worktree: WorktreeRecord,
  approvals?: { approved?: boolean; approvals_left?: number },
  jobs?: readonly GitLabJob[]
): PullRequestSync {
  const owner = { taskId: worktree.taskId, iterationId: worktree.iterationId, worktreeId: worktree.id };
  const number = raw.iid;
  const headSha = raw.sha;
  const state = raw.state === 'merged' ? 'MERGED' : raw.state === 'opened' ? 'OPEN' : 'CLOSED';
  const status: PullRequestSnapshotRecord['status'] = state === 'MERGED' ? 'MERGED'
    : state === 'CLOSED' ? 'CLOSED_UNMERGED' : raw.draft ? 'OPEN_DRAFT' : 'OPEN_READY';
  const pipeline = raw.head_pipeline ?? undefined;
  // Pipeline jobs in the shape the check list reads; a job allowed to fail cannot block.
  const checks = (jobs ?? []).map((job) => ({
    name: [job.stage?.trim(), job.name?.trim()].filter(Boolean).join(': ') || 'Unnamed job',
    bucket: job.status === 'success' ? 'pass'
      : job.status === 'failed' ? (job.allow_failure ? 'skipping' : 'fail')
        : job.status === 'canceled' ? 'cancel'
          : job.status === 'skipped' || job.status === 'manual' ? 'skipping'
            : 'pending',
    state: job.status,
    workflow: job.stage,
    link: job.web_url,
    startedAt: job.started_at ?? undefined,
    completedAt: job.finished_at ?? undefined
  }));
  const reviewStatus: ReviewStatus = raw.detailed_merge_status === 'requested_changes' ? 'CHANGES_REQUESTED'
    : approvals?.approved && (approvals.approvals_left ?? 0) === 0 ? 'APPROVED'
      : (approvals?.approvals_left ?? 0) > 0 || raw.detailed_merge_status === 'not_approved' ? 'REQUESTED'
        : 'NOT_REQUESTED';
  const mergeStatus: MergeStatus = state === 'MERGED' ? 'MERGED'
    : state === 'CLOSED' ? 'CLOSED_UNMERGED'
      : raw.detailed_merge_status === 'mergeable' ? 'MERGEABLE'
        : COMPUTING_MERGE_STATUSES.has(raw.detailed_merge_status ?? '') ? 'COMPUTING'
          : raw.detailed_merge_status ? 'BLOCKED' : 'UNKNOWN';
  return {
    pullRequest: {
      ...owner,
      number,
      url: raw.web_url,
      status,
      state,
      isDraft: Boolean(raw.draft),
      headRefName: raw.source_branch,
      headRefOid: headSha,
      baseRefName: raw.target_branch,
      mergedAt: raw.merged_at ?? null,
      title: raw.title,
      raw
    },
    // A pipeline for an older commit is evidence for that commit, which PR Status marks stale.
    ci: parseCiRollup(undefined, worktree, number, pipeline ? pipeline.sha : headSha, checks.length ? checks : undefined),
    reviews: { ...owner, pullRequestNumber: number, headSha, status: reviewStatus, ...(raw.detailed_merge_status ? { reviewDecision: raw.detailed_merge_status } : {}), raw: approvals },
    merge: { ...owner, pullRequestNumber: number, headSha, status: mergeStatus, mergedAt: raw.merged_at ?? null, raw: { detailed_merge_status: raw.detailed_merge_status } }
  };
}
