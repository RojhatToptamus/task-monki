import type {
  GitHubCheckDetailRecord,
  GitHubRepositoryRecord,
  MergeStatus,
  PullRequestSnapshotRecord,
  ReviewStatus,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import { gitLabMergeReason, type PullRequestMergeMethod, type PullRequestMergeOptions } from '../../shared/pullRequestActions';
import type { PullRequestReviewer } from '../../shared/pullRequestFeedback';
import { parseRemoteWorkReference, type RemoteRepositoryOption, type RemoteRepositoryRef } from '../../shared/remoteWork';
import { parseCiRollup } from '../github/GitHubService';
import { externalTargetBranch, listCheckoutRemoteRepositories } from '../remote/RemoteCheckout';
import { RemoteWorkError } from '../remote/RemoteWorkError';
import { canonicalPlatformTime } from '../remote/platformTime';
import { deliveryRemote, startEach, type DeliveryRemote, type DeliveryTarget, type PullRequestAddress, type PullRequestDelivery, type PullRequestSync } from '../remote/PullRequestDelivery';
import { GitLabCli, gitLabProject, gitLabState } from './GitLabCli';
import {
  GITLAB_DISCUSSION_PAGE,
  GITLAB_DISCUSSION_PAGES,
  gitLabReviewers,
  parseGitLabMergeRequestFeedback,
  type GitLabDiscussion,
  type GitLabReviewer
} from './GitLabPullRequestFeedback';

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
  /** The merge request's own choice, which a merge follows unless it says otherwise. */
  force_remove_source_branch?: boolean | null;
  sha?: string;
  merged_at?: string | null;
  detailed_merge_status?: string;
  head_pipeline?: { id?: number; project_id?: number; sha?: string; ref?: string; status?: string; web_url?: string } | null;
}

interface GitLabApprovals {
  approved?: boolean;
  approvals_left?: number;
  approved_by?: Array<{ user?: { username?: string } | null }>;
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

/** Merge request delivery on GitLab through the signed-in GitLab CLI. */
export class GitLabService implements PullRequestDelivery {
  readonly provider = 'GITLAB' as const;

  constructor(private readonly cli: GitLabCli) {}

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

  async viewPullRequest(worktree: WorktreeRecord, selector: string | number, target?: DeliveryTarget, options: { feedback?: boolean } = {}): Promise<PullRequestSync> {
    const project = target?.repository ?? await this.requireProject(worktree);
    const iid = typeof selector === 'number' ? selector : Number(/\/-\/merge_requests\/(\d+)/u.exec(selector)?.[1]);
    if (!Number.isSafeInteger(iid) || iid < 1) throw new Error('The merge request is not recorded.');
    const base = `projects/${gitLabProject(project.path)}/merge_requests/${iid}`;
    const cwd = worktree.worktreePath;
    // Each read but the pipeline's jobs runs beside the merge request's; one that fails leaves its part unread.
    const approvalsRead = this.cli.request<GitLabApprovals>({ host: project.host, endpoint: `${base}/approvals`, cwd }).catch(() => undefined);
    const reviewersRead = this.cli.request<unknown>({ host: project.host, endpoint: `${base}/reviewers`, cwd }).catch(() => undefined);
    // A status-only read leaves what people said, and who read it, unread.
    const feedback = options.feedback !== false;
    const discussionsRead = feedback ? this.readDiscussions(project.host, base, cwd).catch(() => undefined) : Promise.resolve(undefined);
    const viewerRead = feedback
      ? this.cli.request<{ username?: string }>({ host: project.host, endpoint: 'user', cwd }).catch(() => undefined)
      : Promise.resolve(undefined);
    const mergeRequest = await this.cli.request<GitLabMergeRequest>({ host: project.host, endpoint: base, cwd, subject: project.path });
    const [approvals, jobs, reviewers, discussions, viewer] = await Promise.all([
      approvalsRead,
      mergeRequest.head_pipeline?.id
        ? this.cli.request<unknown>({
          host: project.host,
          endpoint: `projects/${mergeRequest.head_pipeline.project_id ?? gitLabProject(project.path)}/pipelines/${mergeRequest.head_pipeline.id}/jobs?per_page=100`,
          cwd
        }).catch(() => undefined)
        : Promise.resolve([]),
      reviewersRead,
      discussionsRead,
      viewerRead
    ]);
    const people = Array.isArray(reviewers) || approvals?.approved_by
      ? gitLabReviewers(Array.isArray(reviewers) ? reviewers as GitLabReviewer[] : undefined, approvals?.approved_by)
      : undefined;
    const sync = parseMergeRequest(mergeRequest, worktree, approvals, Array.isArray(jobs) ? jobs as GitLabJob[] : undefined, people);
    // Without the discussions, the status still stands and the last reading of them is kept.
    if (!discussions || typeof mergeRequest.iid !== 'number') return sync;
    return {
      ...sync,
      feedback: parseGitLabMergeRequestFeedback({
        number: mergeRequest.iid,
        webUrl: mergeRequest.web_url,
        headSha: mergeRequest.sha,
        discussions: discussions.rows,
        reviewers: people ?? [],
        capturedAt: new Date().toISOString(),
        ...(viewer?.username ? { viewer: viewer.username } : {}),
        more: discussions.more
      })
    };
  }

  /**
   * A merge request's discussions, oldest first, a page at a time up to a
   * bound; system notes fill pages too, so the newest are past the first page.
   */
  private async readDiscussions(host: string, base: string, cwd: string): Promise<{ rows: GitLabDiscussion[]; more: boolean } | undefined> {
    const rows: GitLabDiscussion[] = [];
    for (let page = 1; page <= GITLAB_DISCUSSION_PAGES; page += 1) {
      const batch = await this.cli.request<unknown>({ host, endpoint: `${base}/discussions?per_page=${GITLAB_DISCUSSION_PAGE}&page=${page}`, cwd });
      if (!Array.isArray(batch)) return undefined;
      rows.push(...(batch as GitLabDiscussion[]));
      if (batch.length < GITLAB_DISCUSSION_PAGE) return { rows, more: false };
    }
    return { rows, more: true };
  }

  async pullRequestBase(worktree: WorktreeRecord, requestedBranch?: string): Promise<string> {
    if (worktree.ownership !== 'EXTERNAL') return requestedBranch ?? worktree.baseRef ?? 'main';
    const project = await gitLabRemote(worktree.worktreePath);
    if (!project) throw new Error('No GitLab remote was found.');
    const branch = await externalTargetBranch(worktree, requestedBranch, project.remoteName, 'merge request');
    const found = await this.cli.request<{ name?: string }>({
      host: project.host, endpoint: `projects/${gitLabProject(project.path)}/repository/branches/${encodeURIComponent(branch)}`,
      cwd: worktree.worktreePath, subject: project.path
    });
    if (found.name !== branch) throw new Error('GitLab did not confirm the selected target branch.');
    return branch;
  }

  async markReadyForReview(worktree: WorktreeRecord, address: PullRequestAddress): Promise<void> {
    const { project, base } = recordedMergeRequest(address);
    const mergeRequest = await this.cli.request<GitLabMergeRequest>({ host: project.host, endpoint: base, cwd: worktree.worktreePath, subject: project.path });
    // GitLab marks a draft by its title, so ready is the title without the marker.
    const title = (mergeRequest.title ?? '').replace(DRAFT_PREFIX, '').trim();
    if (!title) throw new RemoteWorkError('FAILED', 'GitLab did not report the merge request title.');
    await this.cli.request({ host: project.host, endpoint: base, method: 'PUT', fields: { title }, cwd: worktree.worktreePath, subject: project.path });
  }

  async readMergeOptions(worktree: WorktreeRecord, address: PullRequestAddress): Promise<PullRequestMergeOptions> {
    const { project, base } = recordedMergeRequest(address);
    const cwd = worktree.worktreePath;
    const [settings, mergeRequest] = await Promise.all([
      this.cli.request<GitLabProjectSettings>({ host: project.host, endpoint: `projects/${gitLabProject(project.path)}`, cwd, subject: project.path }),
      this.cli.request<GitLabMergeRequest>({ host: project.host, endpoint: base, cwd, subject: project.path })
    ]);
    return gitLabMergeOptions(settings, mergeRequest);
  }

  async mergePullRequest(worktree: WorktreeRecord, address: PullRequestAddress, input: {
    method: PullRequestMergeMethod;
    expectedHeadSha: string;
    deleteBranch?: string;
  }): Promise<void> {
    const { project, base } = recordedMergeRequest(address);
    try {
      await this.cli.request({
        host: project.host, endpoint: `${base}/merge`, method: 'PUT', cwd: worktree.worktreePath, timeout: 120_000,
        fields: {
          sha: input.expectedHeadSha,
          squash: String(input.method === 'SQUASH'),
          // Sent only to delete: an explicit false would override the merge request's own choice to delete.
          ...(input.deleteBranch ? { should_remove_source_branch: 'true' } : {})
        }
      });
    } catch (error) {
      throw await this.mergeRefusal(error, project.host, worktree.worktreePath);
    }
  }

  /**
   * Why GitLab did not merge, in words that say what to do about it. What the CLI
   * told apart, such as a missing sign-in, stands as it said it; but GitLab also
   * answers 401 to an account that may not merge, and one it still answers is signed in.
   */
  private async mergeRefusal(error: unknown, host: string, cwd: string): Promise<Error> {
    if (error instanceof RemoteWorkError && error.code === 'SIGNED_OUT') {
      const signedIn = await this.cli.request({ host, endpoint: 'user', cwd }).then(() => true, () => false);
      return signedIn ? new Error(GITLAB_MERGE_NOT_ALLOWED) : error;
    }
    if (error instanceof RemoteWorkError && error.code !== 'FAILED') return error;
    return new Error(gitLabMergeFailure(error instanceof Error ? error.message : String(error)));
  }

  async replyToDiscussion(worktree: WorktreeRecord, address: PullRequestAddress, discussionId: string, body: string): Promise<void> {
    const { project, base } = recordedMergeRequest(address);
    await this.cli.request({
      host: project.host, endpoint: `${base}/discussions/${encodeURIComponent(discussionId)}/notes`, method: 'POST',
      stdinField: { name: 'body', value: body }, cwd: worktree.worktreePath, timeout: 60_000
    });
  }

  async resolveDiscussion(worktree: WorktreeRecord, address: PullRequestAddress, discussionId: string, resolved = true): Promise<void> {
    const { project, base } = recordedMergeRequest(address);
    await this.cli.request({
      host: project.host, endpoint: `${base}/discussions/${encodeURIComponent(discussionId)}`, method: 'PUT',
      fields: { resolved: String(resolved) }, cwd: worktree.worktreePath, timeout: 60_000
    });
  }

  async commentOnPullRequest(worktree: WorktreeRecord, address: PullRequestAddress, body: string): Promise<void> {
    const { project, base } = recordedMergeRequest(address);
    await this.cli.request({
      host: project.host, endpoint: `${base}/notes`, method: 'POST',
      stdinField: { name: 'body', value: body }, cwd: worktree.worktreePath, timeout: 60_000
    });
  }

  async readCheckLog(worktree: WorktreeRecord, address: PullRequestAddress, check: GitHubCheckDetailRecord): Promise<string | undefined> {
    const { project } = recordedMergeRequest(address);
    const job = ownJobId(check.link, project);
    if (!job) return undefined;
    return this.cli.requestText({
      host: project.host, endpoint: `projects/${gitLabProject(project.path)}/jobs/${job}/trace`,
      cwd: worktree.worktreePath, timeout: 60_000
    });
  }

  async rerunFailedChecks(worktree: WorktreeRecord, address: PullRequestAddress, checks: readonly GitHubCheckDetailRecord[]): Promise<number> {
    const { project } = recordedMergeRequest(address);
    const jobs = checks.flatMap((check) => ownJobId(check.link, project) ?? []);
    return startEach(jobs, (job) => this.cli.request({
      host: project.host, endpoint: `projects/${gitLabProject(project.path)}/jobs/${job}/retry`, method: 'POST',
      cwd: worktree.worktreePath, timeout: 60_000
    }));
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

/** The project and API path of the merge request a task recorded. */
function recordedMergeRequest(address: PullRequestAddress): { project: RemoteRepositoryRef; base: string } {
  if (!Number.isSafeInteger(address.number) || address.number < 1) throw new Error('The merge request is not recorded.');
  // The recorded merge request names its project, as on GitHub: a remote added since does not move it.
  const recorded = parseRemoteWorkReference(address.url);
  if (!recorded?.repository || recorded.kind !== 'PULL_REQUEST' || recorded.number !== address.number) {
    throw new Error('The merge request is not recorded.');
  }
  const project = recorded.repository;
  return { project, base: `projects/${gitLabProject(project.path)}/merge_requests/${address.number}` };
}

/** The id of a job of this merge request's own project; a link elsewhere is not its to read or retry. */
function ownJobId(link: string | undefined, project: RemoteRepositoryRef): string | undefined {
  const match = /^https:\/\/([^/]+)\/(.+)\/-\/jobs\/(\d+)(?:[/?#].*)?$/u.exec(link ?? '');
  return match && match[1]!.toLowerCase() === project.host.toLowerCase() && match[2]!.toLowerCase() === project.path.toLowerCase() ? match[3] : undefined;
}

/**
 * The checkout's GitLab remote a task pushes to and opens its merge request
 * from: `origin` when it is on GitLab, a contributor's fork or the project
 * itself, as on GitHub; otherwise the first GitLab remote.
 */
async function gitLabRemote(worktreePath: string): Promise<RemoteRepositoryOption | undefined> {
  const remotes = (await listCheckoutRemoteRepositories(worktreePath)).filter((candidate) => candidate.provider === 'GITLAB');
  return remotes.find((candidate) => candidate.remoteName === 'origin') ?? remotes[0];
}

async function detectGitLabProject(worktreePath: string): Promise<RemoteRepositoryRef | undefined> {
  const remote = await gitLabRemote(worktreePath);
  return remote ? { provider: remote.provider, host: remote.host, path: remote.path } : undefined;
}

async function detectGitLabRemote(worktreePath: string): Promise<DeliveryRemote | undefined> {
  const remote = await gitLabRemote(worktreePath);
  return remote ? deliveryRemote(remote) : undefined;
}

const DRAFT_PREFIX = /^\s*(?:draft:|\[draft\]|\(draft\))\s*/iu;
const MERGE_REF_PIPELINE = /^refs\/merge-requests\/\d+\/(?:merge|train)$/u;

/** GitLab marks a draft by its title. */
function draftTitle(title: string): string {
  return DRAFT_PREFIX.test(title) ? title : `Draft: ${title}`;
}

interface GitLabProjectSettings {
  default_branch?: string;
  squash_option?: string;
}

/**
 * GitLab merges the way the project is set up (a merge commit, semi-linear or
 * fast-forward); squashing is the choice a merge request makes, as the project allows.
 */
function gitLabMergeOptions(settings: GitLabProjectSettings, mergeRequest: GitLabMergeRequest): PullRequestMergeOptions {
  const squash = settings.squash_option ?? 'default_off';
  const methods: PullRequestMergeMethod[] = squash === 'never' ? ['MERGE']
    : squash === 'always' ? ['SQUASH']
      : squash === 'default_on' ? ['SQUASH', 'MERGE'] : ['MERGE', 'SQUASH'];
  const head = mergeRequest.source_branch || undefined;
  return {
    methods,
    defaultMethod: methods[0]!,
    // The project's default only sets the box when the merge request is created; its own setting is what a merge follows.
    deletesBranchOnMerge: mergeRequest.force_remove_source_branch === true,
    canDeleteBranch: mergeRequest.source_project_id === mergeRequest.target_project_id && Boolean(head) && head !== settings.default_branch,
    ...(head ? { head } : {}),
    ...(mergeRequest.target_branch ? { base: mergeRequest.target_branch } : {})
  };
}

const GITLAB_MERGE_NOT_ALLOWED = 'The signed-in GitLab account cannot merge this merge request.';

/** A merge GitLab refused, from the CLI's message, in words that say what to do about it. */
function gitLabMergeFailure(text: string): string {
  if (/\b409\b|sha does not match/iu.test(text)) return 'The merge request changed since Task Monki read it. Refresh, then merge.';
  if (/\b405\b|method not allowed|not mergeable|cannot be merged/iu.test(text)) return 'GitLab refused the merge: the merge request cannot merge yet.';
  if (/\b403\b|forbidden/iu.test(text)) return GITLAB_MERGE_NOT_ALLOWED;
  return 'GitLab could not merge the merge request.';
}

/** One GitLab observation split into Task Monki's PR, check, review and merge evidence. */
export function parseMergeRequest(
  raw: GitLabMergeRequest,
  worktree: WorktreeRecord,
  approvals?: GitLabApprovals,
  jobs?: readonly GitLabJob[],
  /** Reviewers' own states: a request for changes holds even when GitLab reports another reason first, such as a draft. */
  reviewers?: readonly PullRequestReviewer[]
): PullRequestSync {
  const owner = { taskId: worktree.taskId, iterationId: worktree.iterationId, worktreeId: worktree.id };
  const number = raw.iid;
  const headSha = raw.sha;
  const state = gitLabState(raw.state);
  const status: PullRequestSnapshotRecord['status'] = state === 'MERGED' ? 'MERGED'
    : state === 'CLOSED' ? 'CLOSED_UNMERGED' : raw.draft ? 'OPEN_DRAFT' : 'OPEN_READY';
  const pipeline = raw.head_pipeline ?? undefined;
  // The jobs read leaves out trigger jobs, stops at its first page and can fail, so the pipeline's own
  // status is evidence too: unless a listed job reads the same, it stands as a check of its own, and a
  // pipeline that failed or still runs never reads as passing.
  const pipelineRow: GitLabJob | undefined = pipeline?.status
    ? { name: 'Pipeline', status: pipeline.status, ...(pipeline.web_url ? { web_url: pipeline.web_url } : {}) }
    : undefined;
  const listed = jobs ?? [];
  const rows = pipelineRow && !listed.some((job) => checkBucket(job) === checkBucket(pipelineRow)) ? [pipelineRow, ...listed] : listed;
  // Pipeline jobs in the shape the check list reads.
  const checks = rows.map((job) => ({
    name: [job.stage?.trim(), job.name?.trim()].filter(Boolean).join(': ') || 'Unnamed job',
    bucket: checkBucket(job),
    state: job.status,
    workflow: job.stage,
    link: job.web_url,
    startedAt: job.started_at ?? undefined,
    completedAt: job.finished_at ?? undefined
  }));
  const changesRequested = raw.detailed_merge_status === 'requested_changes' ||
    Boolean(reviewers?.some((reviewer) => reviewer.state === 'CHANGES_REQUESTED'));
  // A project without approval rules reports itself approved before anyone approved: only an approver approves.
  const reviewStatus: ReviewStatus = changesRequested ? 'CHANGES_REQUESTED'
    : approvals?.approved && (approvals.approvals_left ?? 0) === 0 && (approvals.approved_by?.length ?? 0) > 0 ? 'APPROVED'
      : (approvals?.approvals_left ?? 0) > 0 || raw.detailed_merge_status === 'not_approved' ? 'REQUESTED'
        : 'NOT_REQUESTED';
  const mergeStatus: MergeStatus = state === 'MERGED' ? 'MERGED'
    : state === 'CLOSED' ? 'CLOSED_UNMERGED'
      : gitLabMergeReason(raw.detailed_merge_status)?.merge ?? 'UNKNOWN';
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
      mergedAt: canonicalPlatformTime(raw.merged_at) ?? null,
      title: raw.title,
      // What the reading turned on, not the whole response: a description can be a megabyte.
      raw: { state: raw.state, draft: raw.draft, sha: raw.sha, detailed_merge_status: raw.detailed_merge_status, head_pipeline: pipeline }
    },
    // A pipeline for an older commit is evidence for that commit, which PR Status marks stale. A
    // merged-results or merge-train pipeline runs on a merge commit GitLab makes for the current head.
    ci: parseCiRollup(undefined, worktree, number,
      pipeline?.sha && !MERGE_REF_PIPELINE.test(pipeline.ref ?? '') ? pipeline.sha : headSha, checks),
    // GitLab's merge reason is merge evidence: it changes from one reading to the next while the review stands.
    reviews: { ...owner, pullRequestNumber: number, headSha, status: reviewStatus, raw: approvals },
    merge: { ...owner, pullRequestNumber: number, headSha, status: mergeStatus, mergedAt: canonicalPlatformTime(raw.merged_at) ?? null, raw: { detailed_merge_status: raw.detailed_merge_status } }
  };
}

/** A job's or pipeline's status in the check list's buckets; a job allowed to fail cannot block. */
function checkBucket(job: GitLabJob): 'pass' | 'fail' | 'cancel' | 'skipping' | 'pending' {
  return job.status === 'success' ? 'pass'
    : job.status === 'failed' ? (job.allow_failure ? 'skipping' : 'fail')
      : job.status === 'canceled' ? 'cancel'
        : job.status === 'skipped' || job.status === 'manual' ? 'skipping'
          : 'pending';
}
