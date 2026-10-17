import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../core/git/gitCli';
import { writeNodeExecutable } from './fakeExecutable';

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
  /** A finished pipeline for the head: each job's name, stage and status. */
  jobs?: Array<{ name: string; stage: string; status: string; allow_failure?: boolean }>;
  detailedMergeStatus?: string;
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
  items(): Promise<FakeGitLabItem[]>;
  calls(): Promise<FakeGitLabCall[]>;
}

export async function createFakeGitLab(rootDir: string): Promise<FakeGitLab> {
  const hostRoot = path.join(rootDir, 'fake-gitlab');
  const binDir = path.join(rootDir, 'fake-gitlab-bin');
  const statePath = path.join(rootDir, 'fake-gitlab-state.json');
  const logPath = path.join(rootDir, 'fake-gitlab-calls.ndjson');
  await fs.mkdir(hostRoot, { recursive: true });
  const state: { username: string; projects: string[]; items: FakeGitLabItem[] } = { username: 'lab-tester', projects: [], items: [] };
  const writeState = () => fs.writeFile(statePath, JSON.stringify(state), 'utf8');
  await writeState();
  const sshCommand = await writeNodeExecutable(binDir, 'fake-ssh', `
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const command = process.argv[process.argv.length - 1];
const match = /^(git-upload-pack|git-receive-pack) '?\\/?([^']+?)'?$/.exec(command);
if (!match || match[2].split('/').includes('..')) { console.error('fake ssh: unexpected command ' + command); process.exit(128); }
const result = spawnSync('git', [match[1].slice(4), path.join(${JSON.stringify(hostRoot)}, match[2])], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
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
    source_project_id: idOf(source), target_project_id: idOf(item.project), sha: head,
    diff_refs: base ? { base_sha: base, head_sha: head, start_sha: target } : null,
    detailed_merge_status: item.detailedMergeStatus ?? 'mergeable', merged_at: null,
    head_pipeline: item.jobs ? { id: 900 + item.iid, project_id: idOf(item.project), sha: head, status: 'running' } : null
  };
};
const issue = (item) => ({ iid: item.iid, title: item.title, description: item.description ?? '', state: item.state ?? 'opened',
  web_url: url(item), author: { username: item.author ?? 'someone' }, labels: [], user_notes_count: (item.notes ?? []).length, updated_at: '2026-10-01T00:00:00Z' });
const parts = endpointPath.split('/');
if (endpointPath === 'user') out({ username: state.username });
if (parts[0] !== 'projects') notFound();
const project = projectOf(parts[1] ?? '');
if (!project || !state.projects.includes(project)) notFound();
const items = state.items.filter((item) => item.project === project);
if (parts.length === 2) out({ id: idOf(project), path_with_namespace: project });
if (parts[2] === 'repository' && parts[3] === 'branches') { const name = decodeURIComponent(parts[4]); rev(project, 'refs/heads/' + name) ? out({ name }) : notFound(); }
if (parts[2] === 'pipelines' && parts[4] === 'jobs') {
  const item = state.items.find((candidate) => 900 + candidate.iid === Number(parts[3]));
  out((item?.jobs ?? []).map((job) => ({ ...job, web_url: 'https://gitlab.com/' + project + '/-/jobs/1', started_at: null, finished_at: null })));
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
if (parts[4] === 'notes') out([...(item.notes ?? [])].reverse().map((note) => ({ body: note.body, system: Boolean(note.system), created_at: note.created_at, author: { username: note.author } })));
if (parts[4] === 'approvals') out({ approved: false, approvals_left: 0 });
out(kind === 'ISSUE' ? issue(item) : mergeRequest(item));
`;
}
