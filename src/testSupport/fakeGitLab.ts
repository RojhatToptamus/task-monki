import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../core/git/gitCli';
import { writeFakeSsh, writeNodeExecutable } from './fakeExecutable';

export interface FakeGitLabItem {
  project: string;
  iid: number;
  kind: 'ISSUE' | 'MERGE_REQUEST';
  title: string;
  description?: string;
  state?: 'opened' | 'closed' | 'merged';
  author?: string;
  notes?: Array<{ author: string; body: string; created_at: string; system?: boolean }>;
  /** Merge requests. */
  draft?: boolean;
  sourceBranch?: string;
  targetBranch?: string;
  sourceProject?: string;
  /** The merge request's own "Delete source branch" choice, which a merge follows unless told otherwise. */
  forceRemoveSourceBranch?: boolean;
  /** The head pipeline's jobs: each job's name, stage and status, from which the pipeline's own status follows. */
  jobs?: Array<{ id?: number; name: string; stage: string; status: string; allow_failure?: boolean }>;
  /** GitLab's first reason it cannot merge; a draft reports `draft_status` unless set. */
  detailedMergeStatus?: string;
  /** Merge request discussions, as the discussions API returns them. */
  discussions?: FakeGitLabDiscussion[];
  reviewers?: Array<{ username: string; state: string }>;
  /** Job logs by job id, as the trace API returns them. */
  jobTraces?: Record<string, string>;
  /** Whether the fake squashed when it merged. */
  mergedWith?: { squash: boolean; removedBranch: boolean };
}

/** A project's merge settings, as `GET /projects/:id` reports them. */
export interface FakeGitLabProjectSettings {
  squash_option: 'never' | 'always' | 'default_on' | 'default_off';
}

export interface FakeGitLabDiscussion {
  id: string;
  /** A single comment on the merge request rather than a thread. */
  individualNote?: boolean;
  /** A diff thread: its file and line on the new side, or on the old side. */
  path?: string;
  newLine?: number;
  oldLine?: number;
  /** The head the note was written on; the merge request's head when absent. */
  headSha?: string;
  resolved?: boolean;
  notes: Array<{ id: number; author: string; body: string; created_at: string; system?: boolean }>;
}

export interface FakeGitLabCall {
  args: string[];
  stdin: string;
}

/**
 * A local stand-in for gitlab.com: bare repositories reached through
 * `ssh://git@gitlab.com/<namespace>/<project>.git`, and a `glab` whose `api`
 * answers GitLab's REST paths from fixture state.
 */
export interface FakeGitLab {
  glabPath: string;
  sshCommand: string;
  remoteUrl(project: string): string;
  barePath(project: string): string;
  publish(project: string, sourceRepository: string): Promise<void>;
  fork(project: string, fork: string): Promise<void>;
  pushRef(project: string, sourceRepository: string, sha: string, ref: string): Promise<void>;
  refSha(project: string, ref: string): Promise<string | undefined>;
  setItem(item: FakeGitLabItem): Promise<void>;
  setProjectSettings(project: string, settings: FakeGitLabProjectSettings): Promise<void>;
  items(): Promise<FakeGitLabItem[]>;
  calls(): Promise<FakeGitLabCall[]>;
}

export async function createFakeGitLab(rootDir: string): Promise<FakeGitLab> {
  const hostRoot = path.join(rootDir, 'fake-gitlab');
  const binDir = path.join(rootDir, 'fake-gitlab-bin');
  const statePath = path.join(rootDir, 'fake-gitlab-state.json');
  const logPath = path.join(rootDir, 'fake-gitlab-calls.ndjson');
  await fs.mkdir(hostRoot, { recursive: true });
  const state: { username: string; projects: string[]; items: FakeGitLabItem[]; settings?: Record<string, FakeGitLabProjectSettings> } =
    { username: 'lab-tester', projects: [], items: [] };
  const writeState = () => fs.writeFile(statePath, JSON.stringify(state), 'utf8');
  await writeState();
  const sshCommand = await writeFakeSsh(binDir, hostRoot);
  const glabPath = await writeNodeExecutable(binDir, 'glab', fakeGlabScript(statePath, logPath, hostRoot));
  const barePath = (project: string) => path.join(hostRoot, `${project}.git`);
  return {
    glabPath,
    sshCommand,
    remoteUrl: (project) => `ssh://git@gitlab.com/${project}.git`,
    barePath,
    async publish(project, sourceRepository) {
      await fs.mkdir(path.dirname(barePath(project)), { recursive: true });
      await git(rootDir, ['init', '--bare', '-b', 'main', barePath(project)]);
      await git(sourceRepository, ['push', barePath(project), 'main:refs/heads/main']);
      state.projects.push(project);
      await writeState();
    },
    async fork(project, forkPath) {
      await fs.mkdir(path.dirname(barePath(forkPath)), { recursive: true });
      await git(rootDir, ['clone', '--bare', '--quiet', barePath(project), barePath(forkPath)]);
      state.projects.push(forkPath);
      await writeState();
    },
    async pushRef(project, sourceRepository, sha, ref) {
      await git(sourceRepository, ['push', '--force', barePath(project), `${sha}:${ref}`]);
    },
    async refSha(project, ref) {
      return git(barePath(project), ['rev-parse', '--verify', '--quiet', ref]).then((value) => value.trim(), () => undefined);
    },
    async setItem(item) {
      const current = JSON.parse(await fs.readFile(statePath, 'utf8')) as typeof state;
      state.items = [...current.items.filter((candidate) => !(candidate.project === item.project && candidate.iid === item.iid && candidate.kind === item.kind)), item];
      await writeState();
    },
    async setProjectSettings(project, settings) {
      Object.assign(state, JSON.parse(await fs.readFile(statePath, 'utf8')) as typeof state);
      state.settings = { ...state.settings, [project]: settings };
      await writeState();
    },
    async items() {
      return (JSON.parse(await fs.readFile(statePath, 'utf8')) as typeof state).items;
    },
    async calls() {
      const text = await fs.readFile(logPath, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeGitLabCall);
    }
  };
}

function fakeGlabScript(statePath: string, logPath: string, hostRoot: string): string {
  return `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
let stdin = '';
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const fields = {};
args.forEach((arg, index) => {
  if (arg === '--raw-field' || arg === '--field') {
    const value = args[index + 1]; const split = value.indexOf('=');
    fields[value.slice(0, split)] = value.slice(split + 1);
  }
});
if (Object.values(fields).includes('@-')) stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + '\\n');
if (args[0] === '--version') { console.log('glab 1.46.0 (fake)'); process.exit(0); }
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const notFound = () => { process.stdout.write('{"message":"404 Not found"}'); process.stderr.write('glab: 404 Not Found\\n'); process.exit(1); };
if (args[0] !== 'api') { process.stderr.write('fake glab: unexpected ' + args.join(' ') + '\\n'); process.exit(1); }
const [endpointPath, queryText] = args[1].split('?');
const query = new URLSearchParams(queryText ?? '');
const method = option('--method') ?? 'GET';
const bare = (project) => path.join(${JSON.stringify(hostRoot)}, project + '.git');
const rev = (project, ref) => { try { return execFileSync('git', ['--git-dir', bare(project), 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim(); } catch { return undefined; } };
const idOf = (project) => state.projects.indexOf(project) + 1;
const projectOf = (segment) => /^\\d+$/.test(segment) ? state.projects[Number(segment) - 1] : decodeURIComponent(segment);
const url = (item) => 'https://gitlab.com/' + item.project + '/-/' + (item.kind === 'ISSUE' ? 'issues' : 'merge_requests') + '/' + item.iid;
const mergeRequest = (item) => {
  const source = item.sourceProject ?? item.project;
  const head = rev(source, 'refs/heads/' + item.sourceBranch) ?? rev(item.project, 'refs/merge-requests/' + item.iid + '/head');
  if (head && (item.state ?? 'opened') === 'opened') execFileSync('git', ['--git-dir', bare(item.project), 'fetch', '--quiet', bare(source), '+' + head + ':refs/merge-requests/' + item.iid + '/head']);
  const target = rev(item.project, 'refs/heads/' + (item.targetBranch ?? 'main'));
  const base = head && target ? execFileSync('git', ['--git-dir', bare(item.project), 'merge-base', target, head], { encoding: 'utf8' }).trim() : undefined;
  return {
    iid: item.iid, title: item.title, description: item.description ?? '', state: item.state ?? 'opened', web_url: url(item),
    author: { username: item.author ?? 'someone' }, labels: [], user_notes_count: (item.notes ?? []).length, updated_at: '2026-10-01T00:00:00Z',
    draft: Boolean(item.draft), source_branch: item.sourceBranch, target_branch: item.targetBranch ?? 'main',
    source_project_id: idOf(source), target_project_id: idOf(item.project), sha: head, force_remove_source_branch: item.forceRemoveSourceBranch ?? null,
    diff_refs: base ? { base_sha: base, head_sha: head, start_sha: target } : null,
    detailed_merge_status: item.detailedMergeStatus ?? (item.draft ? 'draft_status' : 'mergeable'), merged_at: item.state === 'merged' ? '2026-10-02T00:00:00.000Z' : null,
    head_pipeline: item.jobs ? { id: 900 + item.iid, project_id: idOf(item.project), sha: head, status: pipelineStatus(item.jobs),
      web_url: 'https://gitlab.com/' + item.project + '/-/pipelines/' + (900 + item.iid) } : null
  };
};
// As GitLab composes a pipeline's status from its jobs: a job still to run keeps it running, then a failure not allowed to fail fails it.
const pipelineStatus = (jobs) => jobs.some((job) => ['created', 'pending', 'running'].includes(job.status)) ? 'running'
  : jobs.some((job) => job.status === 'failed' && !job.allow_failure) ? 'failed'
    : jobs.some((job) => job.status === 'canceled') ? 'canceled' : 'success';
const issue = (item) => ({ iid: item.iid, title: item.title, description: item.description ?? '', state: item.state ?? 'opened',
  web_url: url(item), author: { username: item.author ?? 'someone' }, labels: [], user_notes_count: (item.notes ?? []).length, updated_at: '2026-10-01T00:00:00Z' });
const parts = endpointPath.split('/');
if (endpointPath === 'user') out({ username: state.username });
if (parts[0] !== 'projects') notFound();
const project = projectOf(parts[1] ?? '');
if (!project || !state.projects.includes(project)) notFound();
const items = state.items.filter((item) => item.project === project);
if (parts.length === 2) out({ id: idOf(project), path_with_namespace: project, default_branch: 'main', merge_method: 'merge',
  squash_option: 'default_off', ...(state.settings?.[project] ?? {}) });
if (parts[2] === 'jobs' && parts[4] === 'trace') {
  const trace = state.items.map((candidate) => candidate.jobTraces?.[parts[3]]).find((value) => value !== undefined);
  if (trace === undefined) notFound();
  process.stdout.write(trace);
  process.exit(0);
}
if (parts[2] === 'jobs' && parts[4] === 'retry' && method === 'POST') out({ id: Number(parts[3]) + 1000, status: 'pending' });
if (parts[2] === 'repository' && parts[3] === 'branches') { const name = decodeURIComponent(parts[4]); rev(project, 'refs/heads/' + name) ? out({ name }) : notFound(); }
if (parts[2] === 'pipelines' && parts[4] === 'jobs') {
  const item = state.items.find((candidate) => 900 + candidate.iid === Number(parts[3]));
  out((item?.jobs ?? []).map((job) => ({ ...job, web_url: 'https://gitlab.com/' + project + '/-/jobs/' + (job.id ?? 1), started_at: null, finished_at: null })));
}
const kind = parts[2] === 'issues' ? 'ISSUE' : parts[2] === 'merge_requests' ? 'MERGE_REQUEST' : undefined;
if (!kind) notFound();
if (kind === 'MERGE_REQUEST' && method === 'POST' && parts.length === 3) {
  const targetProject = fields.target_project_id ? state.projects[Number(fields.target_project_id) - 1] : project;
  const iid = Math.max(0, ...state.items.filter((item) => item.project === targetProject && item.kind === 'MERGE_REQUEST').map((item) => item.iid)) + 1;
  const draft = /^Draft:/.test(fields.title);
  const item = { project: targetProject, iid, kind: 'MERGE_REQUEST', title: fields.title.replace(/^Draft:\\s*/, ''), description: stdin, draft,
    sourceBranch: fields.source_branch, targetBranch: fields.target_branch, sourceProject: targetProject === project ? undefined : project };
  state.items.push(item); save(); out(mergeRequest(item));
}
const list = items.filter((item) => item.kind === kind && (!query.get('state') || (item.state ?? 'opened') === query.get('state')) &&
  (!query.get('source_branch') || item.sourceBranch === query.get('source_branch')) &&
  (!query.get('search') || item.title.toLowerCase().includes(query.get('search').toLowerCase())));
if (parts.length === 3) out(list.map((item) => kind === 'ISSUE' ? issue(item) : mergeRequest(item)));
const item = items.find((candidate) => candidate.kind === kind && candidate.iid === Number(parts[3]));
if (!item) notFound();
if (parts.length === 4 && method === 'PUT' && kind === 'MERGE_REQUEST') {
  item.title = fields.title.replace(/^\\s*(?:draft:|\\[draft\\]|\\(draft\\))\\s*/i, '');
  item.draft = /^\\s*(?:draft:|\\[draft\\]|\\(draft\\))/i.test(fields.title);
  save();
  out(mergeRequest(item));
}
if (parts[4] === 'merge' && method === 'PUT') {
  const current = mergeRequest(item);
  if ((item.state ?? 'opened') !== 'opened' || item.draft) { process.stdout.write('{"message":"405 Method Not Allowed"}'); process.stderr.write('glab: 405 Method Not Allowed\\n'); process.exit(1); }
  if (fields.sha !== current.sha) { process.stdout.write('{"message":"409 SHA does not match HEAD of source branch"}'); process.stderr.write('glab: 409 Conflict\\n'); process.exit(1); }
  item.state = 'merged';
  item.mergedWith = { squash: fields.squash === 'true', removedBranch: fields.should_remove_source_branch === undefined ? Boolean(item.forceRemoveSourceBranch) : fields.should_remove_source_branch === 'true' };
  if (item.mergedWith.removedBranch) execFileSync('git', ['--git-dir', bare(item.sourceProject ?? item.project), 'update-ref', '-d', 'refs/heads/' + item.sourceBranch]);
  save();
  out({ ...current, state: 'merged' });
}
if (parts[4] === 'notes' && method === 'POST') {
  item.notes = [...(item.notes ?? []), { author: state.username, body: stdin, created_at: new Date().toISOString() }];
  item.discussions = [...(item.discussions ?? []), { id: 'note-' + Date.now(), individualNote: true, notes: [{ id: Date.now(), author: state.username, body: stdin, created_at: new Date().toISOString() }] }];
  save();
  out({ id: Date.now(), body: stdin });
}
if (parts[4] === 'discussions' && parts[5]) {
  const discussion = (item.discussions ?? []).find((candidate) => candidate.id === decodeURIComponent(parts[5]));
  if (!discussion) notFound();
  if (parts[6] === 'notes' && method === 'POST') {
    discussion.notes.push({ id: Date.now(), author: state.username, body: stdin, created_at: new Date().toISOString() });
    save();
    out({ id: Date.now(), body: stdin });
  }
  if (!parts[6] && method === 'PUT') {
    discussion.resolved = fields.resolved === 'true';
    save();
    out({ id: discussion.id, resolved: discussion.resolved });
  }
}
if (parts[4] === 'notes') out([...(item.notes ?? [])].reverse().map((note) => ({ body: note.body, system: Boolean(note.system), created_at: note.created_at, author: { username: note.author } })));
// As gitlab.com answers for a project without approval rules: approved before anyone approves.
if (parts[4] === 'approvals') out({ approved: true, approvals_left: 0,
  approved_by: (item.reviewers ?? []).filter((reviewer) => reviewer.state === 'approved').map((reviewer) => ({ user: { username: reviewer.username } })) });
if (parts[4] === 'reviewers') out((item.reviewers ?? []).map((reviewer) => ({ user: { username: reviewer.username }, state: reviewer.state, created_at: '2026-10-01T00:00:00Z' })));
if (parts[4] === 'discussions') {
  const head = mergeRequest(item).sha;
  // As on GitLab: 20 a page unless asked, oldest first.
  const perPage = Number(query.get('per_page') ?? 20);
  const page = Number(query.get('page') ?? 1);
  out((item.discussions ?? []).slice((page - 1) * perPage, page * perPage).map((discussion) => ({
    id: discussion.id,
    individual_note: Boolean(discussion.individualNote),
    notes: discussion.notes.map((note) => ({
      id: note.id, type: discussion.individualNote ? null : discussion.path ? 'DiffNote' : 'DiscussionNote', body: note.body,
      author: { username: note.author }, created_at: note.created_at, system: Boolean(note.system),
      resolvable: !discussion.individualNote && !note.system, resolved: Boolean(discussion.resolved),
      position: discussion.path ? { position_type: 'text', new_path: discussion.path, old_path: discussion.path, head_sha: discussion.headSha ?? head,
        new_line: discussion.newLine ?? null, old_line: discussion.newLine ? null : discussion.oldLine ?? null } : null
    }))
  })));
}
out(kind === 'ISSUE' ? issue(item) : mergeRequest(item));
`;
}
