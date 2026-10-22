import {
  REMOTE_WORK_LIMITS,
  formatRemoteWorkNumber,
  normalizeRepositoryPath,
  type RemoteRepositoryRef,
  type RemoteWorkKind,
  type RemoteWorkRef,
  type RemoteWorkSummary
} from '../../shared/remoteWork';
import { RemoteWorkError } from '../remote/RemoteWorkError';
import { buildRemoteWorkSnapshot, type RemotePullRequest, type RemoteWorkReader } from '../remote/RemoteWorkReader';
import { isGitObjectId } from '../git/gitCli';
import { GitLabCli, gitLabProject, gitLabState } from './GitLabCli';

interface GitLabItem {
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  web_url?: string;
  updated_at?: string;
  author?: { username?: string } | null;
  labels?: string[];
  user_notes_count?: number;
  draft?: boolean;
  source_branch?: string;
  target_branch?: string;
  source_project_id?: number;
  target_project_id?: number;
  sha?: string;
  diff_refs?: { base_sha?: string } | null;
}

interface GitLabNote {
  body?: string;
  system?: boolean;
  created_at?: string;
  author?: { username?: string } | null;
}

/** GitLab issues and merge requests through the signed-in GitLab CLI. */
export class GitLabRemoteWork implements RemoteWorkReader {
  constructor(private readonly cli: GitLabCli) {}

  async list(repository: RemoteRepositoryRef, kind: RemoteWorkKind, text: string | undefined, cwd: string): Promise<RemoteWorkSummary[]> {
    const query = new URLSearchParams({ state: 'opened', order_by: 'updated_at', sort: 'desc', per_page: String(REMOTE_WORK_LIMITS.listItems) });
    // The service passes the search words trimmed and bounded.
    if (text) query.set('search', text);
    const rows = await this.cli.request<unknown>({
      host: repository.host,
      endpoint: `projects/${gitLabProject(repository.path)}/${kind === 'ISSUE' ? 'issues' : 'merge_requests'}?${query}`,
      cwd,
      subject: repository.path
    });
    if (!Array.isArray(rows)) throw new RemoteWorkError('FAILED', 'GitLab returned an invalid list.');
    return rows.map((row) => summary(repository, kind, row as GitLabItem));
  }

  async readIssue(ref: RemoteWorkRef, cwd: string) {
    const item = await this.readItem(ref, cwd);
    return {
      summary: summary(ref.repository, 'ISSUE', item),
      snapshot: await this.snapshot(ref, item, cwd)
    };
  }

  async readPullRequest(ref: RemoteWorkRef, cwd: string): Promise<RemotePullRequest> {
    const item = await this.readItem(ref, cwd);
    const headSha = item.sha;
    const baseSha = item.diff_refs?.base_sha;
    if (!item.source_branch || !item.target_branch || !isGitObjectId(headSha)) {
      throw new RemoteWorkError('FAILED', 'GitLab did not report the merge request’s branches.');
    }
    if (!isGitObjectId(baseSha)) {
      throw new RemoteWorkError('FAILED', 'GitLab has not prepared this merge request’s changes yet. Try again shortly.');
    }
    const crossRepository = typeof item.source_project_id === 'number' && item.source_project_id !== item.target_project_id;
    const headRepositoryPath = crossRepository ? await this.projectPath(ref.repository, item.source_project_id!, cwd) : ref.repository.path;
    return {
      summary: { ...summary(ref.repository, 'PULL_REQUEST', item), ...(headRepositoryPath ? { headRepositoryPath } : {}) },
      snapshot: await this.snapshot(ref, item, cwd),
      headRefName: item.source_branch,
      headSha,
      ...(headRepositoryPath ? { headRepositoryPath } : {}),
      crossRepository,
      baseRefName: item.target_branch,
      baseSha,
      baseIsMergeBase: true
    };
  }

  private async snapshot(ref: RemoteWorkRef, item: GitLabItem, cwd: string) {
    return buildRemoteWorkSnapshot({
      ref, url: requireUrl(ref, item), title: item.title ?? '', state: gitLabState(item.state),
      author: item.author?.username, labels: item.labels ?? [], body: item.description ?? '',
      comments: await this.recentComments(ref, cwd), commentCount: item.user_notes_count ?? 0,
      capturedAt: new Date().toISOString()
    });
  }

  private async readItem(ref: RemoteWorkRef, cwd: string): Promise<GitLabItem> {
    const number = formatRemoteWorkNumber('GITLAB', ref.kind, ref.number);
    try {
      return await this.cli.request<GitLabItem>({
        host: ref.repository.host,
        endpoint: `projects/${gitLabProject(ref.repository.path)}/${ref.kind === 'ISSUE' ? 'issues' : 'merge_requests'}/${ref.number}`,
        cwd,
        subject: ref.repository.path
      });
    } catch (error) {
      if (error instanceof RemoteWorkError && error.code === 'NOT_FOUND') {
        throw new RemoteWorkError('NOT_FOUND', `${ref.repository.path}${number} does not exist, or it is not visible to this account.`);
      }
      throw error;
    }
  }

  /** The most recent comments people wrote, oldest first; system notes are left out. */
  private async recentComments(ref: RemoteWorkRef, cwd: string) {
    const notes = await this.cli.request<unknown>({
      host: ref.repository.host,
      endpoint: `projects/${gitLabProject(ref.repository.path)}/${ref.kind === 'ISSUE' ? 'issues' : 'merge_requests'}/${ref.number}/notes?sort=desc&order_by=created_at&per_page=50`,
      cwd,
      subject: ref.repository.path
    });
    return (Array.isArray(notes) ? notes as GitLabNote[] : [])
      .filter((note) => !note.system && note.body)
      .slice(0, REMOTE_WORK_LIMITS.comments)
      .reverse()
      .map((note) => ({ author: note.author?.username, createdAt: note.created_at, body: note.body }));
  }

  private async projectPath(repository: RemoteRepositoryRef, projectId: number, cwd: string): Promise<string | undefined> {
    try {
      const project = await this.cli.request<{ path_with_namespace?: string }>({
        host: repository.host, endpoint: `projects/${projectId}`, cwd
      });
      return project.path_with_namespace ? normalizeRepositoryPath('GITLAB', project.path_with_namespace) : undefined;
    } catch {
      // A source project the account cannot see stays unnamed; its commits are still in the target.
      return undefined;
    }
  }
}

function summary(repository: RemoteRepositoryRef, kind: RemoteWorkKind, item: GitLabItem): RemoteWorkSummary {
  if (typeof item.iid !== 'number' || !item.web_url) {
    throw new RemoteWorkError('FAILED', 'GitLab did not report the item’s identity.');
  }
  return {
    ref: { repository, kind, number: item.iid },
    url: item.web_url,
    title: (item.title ?? '').trim(),
    state: gitLabState(item.state) as RemoteWorkSummary['state'],
    ...(item.author?.username ? { author: item.author.username } : {}),
    ...(item.updated_at ? { updatedAt: item.updated_at } : {}),
    ...(kind === 'PULL_REQUEST' ? {
      draft: Boolean(item.draft),
      ...(item.source_branch ? { headRefName: item.source_branch } : {}),
      crossRepository: typeof item.source_project_id === 'number' && item.source_project_id !== item.target_project_id
    } : {})
  };
}

function requireUrl(ref: RemoteWorkRef, item: GitLabItem): string {
  const base = `https://${ref.repository.host}/${ref.repository.path}/-/`.toLowerCase();
  const url = item.web_url?.toLowerCase() ?? '';
  const kinds = ref.kind === 'ISSUE' ? ['issues', 'work_items'] : ['merge_requests'];
  if (item.iid !== ref.number || !kinds.some((kind) => url === `${base}${kind}/${ref.number}`)) {
    throw new RemoteWorkError('FAILED', 'GitLab returned a different item than requested.');
  }
  return item.web_url!;
}
