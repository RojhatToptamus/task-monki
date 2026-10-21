import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../core/git/gitCli';
import { writeFakeSsh, writeNodeExecutable } from './fakeExecutable';

/** An issue or pull request the fake platform serves. */
export interface FakeGitHubItem {
  owner: string;
  repo: string;
  number: number;
  kind: 'ISSUE' | 'PULL_REQUEST';
  title: string;
  body?: string;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  author?: string;
  labels?: string[];
  comments?: Array<{ author: string; body: string; createdAt: string }>;
  updatedAt?: string;
  /** Pull requests. */
  isDraft?: boolean;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  headRepository?: string;
  isCrossRepository?: boolean;
  /** GitHub's review decision and merge state for `gh pr view`. */
  reviewDecision?: string;
  mergeStateStatus?: string;
  /** Review feedback the GraphQL API reports. */
  reviewThreads?: FakeGitHubReviewThread[];
  reviews?: Array<{ id: string; author: string; state: 'CHANGES_REQUESTED' | 'APPROVED' | 'COMMENTED' | 'DISMISSED'; body?: string; submittedAt: string }>;
  reviewRequests?: string[];
  /** Check rows `gh pr checks` reports for the pull request's head. */
  checks?: Array<{ name: string; bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'; state?: string; workflow?: string; link?: string }>;
  /** GitHub Actions job logs by job id. */
  jobLogs?: Record<string, string>;
  /** How the pull request was merged, when the fake merged it. */
  mergedWith?: string;
}

export interface FakeGitHubReviewThread {
  id: string;
  path: string;
  /** The last line; absent for a comment on the whole file. */
  line?: number;
  startLine?: number;
  side?: 'LEFT' | 'RIGHT';
  resolved?: boolean;
  outdated?: boolean;
  comments: Array<{ id?: string; author: string; body: string; createdAt: string; minimized?: boolean }>;
}

interface FakeGitHubState {
  viewer: string;
  signedIn: boolean;
  items: FakeGitHubItem[];
}

export interface FakeGitHubCall {
  args: string[];
  stdin: string;
}

/**
 * A local stand-in for github.com: bare repositories reached through
 * `ssh://git@github.com/<owner>/<repo>.git` by an ssh shim, and a `gh` that
 * answers from fixture state. Real Git fetches, pushes and refs run against it.
 */
export interface FakeGitHub {
  ghPath: string;
  /** Set as `GIT_SSH_COMMAND` while the fake serves Git traffic. */
  sshCommand: string;
  remoteUrl(owner: string, repo: string): string;
  barePath(owner: string, repo: string): string;
  /** Creates the repository on the fake platform from a local repository's `main`. */
  publish(owner: string, repo: string, sourceRepository: string): Promise<void>;
  /** Points a ref of the hosted repository at a commit of a local repository. */
  pushRef(owner: string, repo: string, sourceRepository: string, sha: string, ref: string): Promise<void>;
  refSha(owner: string, repo: string, ref: string): Promise<string | undefined>;
  setItem(item: FakeGitHubItem): Promise<void>;
  /** The item as the fake holds it now, after any writes `gh` made. */
  item(owner: string, repo: string, number: number): Promise<FakeGitHubItem | undefined>;
  setSignedIn(signedIn: boolean): Promise<void>;
  calls(): Promise<FakeGitHubCall[]>;
}

export async function createFakeGitHub(rootDir: string): Promise<FakeGitHub> {
  const hostRoot = path.join(rootDir, 'fake-github');
  const binDir = path.join(rootDir, 'fake-github-bin');
  const statePath = path.join(rootDir, 'fake-github-state.json');
  const logPath = path.join(rootDir, 'fake-github-calls.ndjson');
  await fs.mkdir(hostRoot, { recursive: true });
  const state: FakeGitHubState = { viewer: 'octo-tester', signedIn: true, items: [] };
  await writeState();
  const sshCommand = await writeFakeSsh(binDir, hostRoot);
  const ghPath = await writeNodeExecutable(binDir, 'gh', fakeGhScript(statePath, logPath, hostRoot));

  async function writeState(): Promise<void> {
    await fs.writeFile(statePath, JSON.stringify(state), 'utf8');
  }

  const barePath = (owner: string, repo: string) => path.join(hostRoot, owner, `${repo}.git`);
  return {
    ghPath,
    sshCommand,
    remoteUrl: (owner, repo) => `ssh://git@github.com/${owner}/${repo}.git`,
    barePath,
    async publish(owner, repo, sourceRepository) {
      await fs.mkdir(path.dirname(barePath(owner, repo)), { recursive: true });
      await git(rootDir, ['init', '--bare', '-b', 'main', barePath(owner, repo)]);
      await git(sourceRepository, ['push', barePath(owner, repo), 'main:refs/heads/main']);
    },
    async pushRef(owner, repo, sourceRepository, sha, ref) {
      await git(sourceRepository, ['push', '--force', barePath(owner, repo), `${sha}:${ref}`]);
    },
    async refSha(owner, repo, ref) {
      return git(barePath(owner, repo), ['rev-parse', '--verify', '--quiet', ref]).then((value) => value.trim(), () => undefined);
    },
    async setItem(item) {
      Object.assign(state, JSON.parse(await fs.readFile(statePath, 'utf8')) as FakeGitHubState);
      state.items = [...state.items.filter((candidate) =>
        !(candidate.owner === item.owner && candidate.repo === item.repo && candidate.number === item.number)), item];
      await writeState();
    },
    async item(owner, repo, number) {
      const current = JSON.parse(await fs.readFile(statePath, 'utf8')) as FakeGitHubState;
      return current.items.find((candidate) => candidate.owner === owner && candidate.repo === repo && candidate.number === number);
    },
    async setSignedIn(signedIn) {
      state.signedIn = signedIn;
      await writeState();
    },
    async calls() {
      const text = await fs.readFile(logPath, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeGitHubCall);
    }
  };
}

function fakeGhScript(statePath: string, logPath: string, hostRoot: string): string {
  return `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
let stdin = '';
try { if (args.includes('-') || args.some((arg) => arg.endsWith('=@-'))) stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const fields = {};
for (let index = 0; index < args.length; index += 1) {
  if ((args[index] === '-f' || args[index] === '-F') && args[index + 1]) {
    const value = args[index + 1];
    const split = value.indexOf('=');
    fields[value.slice(0, split)] = value.slice(split + 1);
  }
}
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
const restFail = (status, message) => { process.stdout.write(JSON.stringify({ message })); process.stderr.write('gh: ' + message + ' (HTTP ' + status + ')\\n'); process.exit(1); };
const out = (value) => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exit(0); };
const fail = (value, code = 1) => { process.stdout.write(JSON.stringify(value)); process.stderr.write('gh: ' + (value.errors?.[0]?.message ?? 'failed') + '\\n'); process.exit(code); };
if (args[0] === '--version') { console.log('gh version 2.81.0 (fake)'); process.exit(0); }
if (!state.signedIn) { process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exit(4); }
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
const repoOf = (item) => item.owner + '/' + item.repo;
const bare = (owner, repo) => path.join(${JSON.stringify(hostRoot)}, owner, repo + '.git');
const revParse = (gitDir, ref) => { try { return execFileSync('git', ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim(); } catch { return undefined; } };
// As on GitHub, a same-repository pull request follows its branch, and refs/pull/N/head follows the head.
// A merged or closed one keeps reporting the head it ended at.
for (const item of state.items) {
  if (item.kind !== 'PULL_REQUEST') continue;
  const gitDir = bare(item.owner, item.repo);
  if ((item.state ?? 'OPEN') !== 'OPEN') {
    item.headRefOid = revParse(gitDir, 'refs/pull/' + item.number + '/head') ?? item.headRefOid;
    item.baseRefOid = revParse(gitDir, 'refs/heads/' + (item.baseRefName ?? 'main')) ?? item.baseRefOid;
    continue;
  }
  const branchHead = !item.isCrossRepository && item.headRefName ? revParse(gitDir, 'refs/heads/' + item.headRefName) : undefined;
  if (branchHead) {
    item.headRefOid = branchHead;
    execFileSync('git', ['--git-dir', gitDir, 'update-ref', 'refs/pull/' + item.number + '/head', branchHead]);
  } else {
    item.headRefOid = revParse(gitDir, 'refs/pull/' + item.number + '/head') ?? item.headRefOid;
  }
  item.baseRefOid = revParse(gitDir, 'refs/heads/' + (item.baseRefName ?? 'main')) ?? item.baseRefOid;
}
const url = (item) => 'https://github.com/' + repoOf(item) + '/' + (item.kind === 'ISSUE' ? 'issues' : 'pull') + '/' + item.number;
const node = (item) => ({
  __typename: item.kind === 'ISSUE' ? 'Issue' : 'PullRequest',
  number: item.number, title: item.title, url: url(item), body: item.body ?? '',
  state: item.state === 'MERGED' ? 'MERGED' : item.state ?? 'OPEN', merged: item.state === 'MERGED',
  updatedAt: item.updatedAt ?? '2026-10-01T00:00:00Z', author: { login: item.author ?? 'someone' },
  labels: { nodes: (item.labels ?? []).map((name) => ({ name })) },
  comments: { totalCount: (item.comments ?? []).length, nodes: (item.comments ?? []).map((comment) => ({ author: { login: comment.author }, body: comment.body, createdAt: comment.createdAt })) },
  isDraft: Boolean(item.isDraft), headRefName: item.headRefName, headRefOid: item.headRefOid,
  baseRefName: item.baseRefName, baseRefOid: item.baseRefOid, isCrossRepository: Boolean(item.isCrossRepository),
  headRepository: item.headRepository ? { nameWithOwner: item.headRepository } : null,
  repository: { nameWithOwner: repoOf(item) }
});
if (args[0] === 'api' && args[1] === 'graphql') {
  const query = fields.query ?? '';
  const threadOf = (id) => {
    for (const item of state.items) {
      const thread = (item.reviewThreads ?? []).find((candidate) => candidate.id === id);
      if (thread) return thread;
    }
    fail({ data: null, errors: [{ type: 'NOT_FOUND', message: "Could not resolve to a node with the global id of '" + id + "'." }] });
  };
  if (query.includes('addPullRequestReviewThreadReply')) {
    const thread = threadOf(fields.threadId);
    const body = fields.body === '@-' ? stdin : fields.body;
    thread.comments.push({ author: state.viewer, body, createdAt: new Date().toISOString() });
    save();
    out({ data: { addPullRequestReviewThreadReply: { comment: { id: 'PRRC_' + thread.comments.length } } } });
  }
  if (query.includes('unresolveReviewThread')) {
    const thread = threadOf(fields.threadId);
    thread.resolved = false;
    save();
    out({ data: { unresolveReviewThread: { thread: { id: thread.id, isResolved: false } } } });
  }
  if (query.includes('resolveReviewThread')) {
    const thread = threadOf(fields.threadId);
    thread.resolved = true;
    save();
    out({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } });
  }
  if (query.includes('squashMergeAllowed')) {
    const item = state.items.find((candidate) => candidate.kind === 'PULL_REQUEST' && candidate.owner === fields.owner &&
      candidate.repo === fields.name && candidate.number === Number(fields.number));
    // Every method is allowed, merge commits by default.
    const settings = { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, deleteBranchOnMerge: false, viewerDefaultMergeMethod: 'MERGE' };
    out({ data: { repository: { ...settings, defaultBranchRef: { name: 'main' }, pullRequest: item
      ? { headRefName: item.headRefName, baseRefName: item.baseRefName ?? 'main', isCrossRepository: Boolean(item.isCrossRepository) } : null } } });
  }
  if (query.includes('reviewThreads')) {
    const item = state.items.find((candidate) => candidate.kind === 'PULL_REQUEST' && candidate.owner === fields.owner &&
      candidate.repo === fields.name && candidate.number === Number(fields.number));
    if (!item) fail({ data: { viewer: { login: state.viewer }, repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Could not resolve to a PullRequest.' }] });
    const comment = (thread, value, index) => ({ id: value.id ?? thread.id + '-' + index, body: value.body, createdAt: value.createdAt,
      url: url(item) + '#discussion_r' + (1000 + index), isMinimized: Boolean(value.minimized), author: { login: value.author } });
    const reviews = (item.reviews ?? []).map((review) => ({ id: review.id, state: review.state, body: review.body ?? '', submittedAt: review.submittedAt,
      url: url(item) + '#pullrequestreview-' + review.id, author: { login: review.author } }));
    // As on GitHub: a hundred threads a page, the next one after the cursor.
    const threads = item.reviewThreads ?? [];
    const start = fields.after ? Number(fields.after) : 0;
    const shown = threads.slice(start, start + 100);
    out({ data: { viewer: { login: state.viewer }, repository: { pullRequest: {
      headRefOid: item.headRefOid,
      reviewThreads: { totalCount: threads.length, pageInfo: { hasNextPage: start + shown.length < threads.length, endCursor: String(start + shown.length) }, nodes: shown.map((thread) => ({
        id: thread.id, isResolved: Boolean(thread.resolved), isOutdated: Boolean(thread.outdated), path: thread.path,
        line: thread.outdated ? null : thread.line ?? null, startLine: thread.outdated ? null : thread.startLine ?? null,
        originalLine: thread.line ?? null, originalStartLine: thread.startLine ?? null,
        diffSide: thread.side ?? 'RIGHT', startDiffSide: thread.startLine ? thread.side ?? 'RIGHT' : null,
        subjectType: thread.line ? 'LINE' : 'FILE',
        first: { totalCount: thread.comments.length, nodes: thread.comments.slice(0, 1).map((value, index) => comment(thread, value, index)) },
        recent: { nodes: thread.comments.slice(-9).map((value, index) => comment(thread, value, thread.comments.length - Math.min(9, thread.comments.length) + index)) }
      })) },
      latestReviews: { nodes: reviews },
      latestOpinionatedReviews: { nodes: reviews.filter((review) => review.state !== 'COMMENTED') },
      reviewRequests: { nodes: (item.reviewRequests ?? []).map((login) => ({ requestedReviewer: { __typename: 'User', login } })) },
      comments: { totalCount: (item.comments ?? []).length, nodes: (item.comments ?? []).map((value, index) => ({ id: 'IC_' + item.number + '_' + index,
        body: value.body, createdAt: value.createdAt, url: url(item) + '#issuecomment-' + index, isMinimized: false, author: { __typename: 'User', login: value.author } })) }
    } } } });
  }
  if (query.includes('viewer')) out({ data: { viewer: { login: state.viewer } } });
  if (query.includes('search(')) {
    const kind = fields.q.includes('is:pr') ? 'PULL_REQUEST' : 'ISSUE';
    const repo = /repo:(\\S+)/.exec(fields.q)[1];
    const words = fields.q.replace(/\\S+:\\S+/g, '').trim().toLowerCase();
    out({ data: { search: { nodes: state.items.filter((item) => item.kind === kind && repoOf(item) === repo &&
      (item.state ?? 'OPEN') === 'OPEN' && item.title.toLowerCase().includes(words)).map(node) } } });
  }
  const repoItems = state.items.filter((item) => item.owner.toLowerCase() === (fields.owner ?? '').toLowerCase() &&
    item.repo.toLowerCase() === (fields.name ?? '').toLowerCase());
  if (!fs.existsSync(path.join(${JSON.stringify(hostRoot)}, fields.owner ?? '', (fields.name ?? '') + '.git'))) {
    fail({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name '" + fields.owner + '/' + fields.name + "'." }] });
  }
  if (query.includes('issueOrPullRequest')) {
    const item = repoItems.find((candidate) => candidate.number === Number(fields.number));
    if (!item) fail({ data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'issueOrPullRequest'], message: 'Could not resolve to an issue or pull request.' }] });
    out({ data: { repository: { issueOrPullRequest: node(item) } } });
  }
  const kind = query.includes('pullRequests(') ? 'PULL_REQUEST' : 'ISSUE';
  const connection = kind === 'ISSUE' ? 'issues' : 'pullRequests';
  out({ data: { repository: { [connection]: { nodes: repoItems.filter((item) => item.kind === kind && (item.state ?? 'OPEN') === 'OPEN').map(node) } } } });
}
const repoArg = option('--repo');
const pulls = state.items.filter((item) => item.kind === 'PULL_REQUEST' && (!repoArg || repoArg.endsWith('/' + repoOf(item))));
const view = (item) => ({
  number: item.number, url: url(item), state: item.state ?? 'OPEN', isDraft: Boolean(item.isDraft),
  mergedAt: item.state === 'MERGED' ? '2026-10-02T00:00:00Z' : null, reviewDecision: item.reviewDecision ?? '', statusCheckRollup: [],
  headRefOid: item.headRefOid, headRefName: item.headRefName, baseRefName: item.baseRefName,
  mergeable: 'MERGEABLE', mergeStateStatus: item.mergeStateStatus ?? (item.isDraft ? 'DRAFT' : 'CLEAN'), title: item.title,
  headRepository: { name: (item.headRepository ?? repoOf(item)).split('/')[1] },
  headRepositoryOwner: { login: (item.headRepository ?? repoOf(item)).split('/')[0] },
  isCrossRepository: Boolean(item.isCrossRepository)
});
if (args[0] === 'api') {
  const endpoint = args.find((arg) => /^repos\\//.test(arg)) ?? '';
  const method = option('--method') ?? 'GET';
  const rest = /^repos\\/([^/]+)\\/([^/]+)\\/(.*)$/.exec(endpoint);
  if (!rest) { process.stderr.write('fake gh: unexpected api ' + args.join(' ') + '\\n'); process.exit(1); }
  const [, owner, repo, route] = rest;
  const pull = /^pulls\\/(\\d+)\\/(merge|requested_reviewers)$/.exec(route);
  const item = pull && state.items.find((candidate) => candidate.kind === 'PULL_REQUEST' && candidate.owner === owner && candidate.repo === repo && candidate.number === Number(pull[1]));
  if (pull && !item) restFail(404, 'Not Found');
  if (pull && pull[2] === 'merge' && method === 'PUT') {
    if ((item.state ?? 'OPEN') !== 'OPEN') restFail(405, 'Pull Request is not mergeable');
    if (item.isDraft) restFail(405, 'Pull Request is still a draft');
    if (fields.sha !== item.headRefOid) restFail(409, 'Head branch was modified. Review and try the merge again.');
    item.state = 'MERGED';
    item.mergedWith = fields.merge_method;
    save();
    out({ sha: item.headRefOid, merged: true, message: 'Pull Request successfully merged' });
  }
  if (pull && pull[2] === 'requested_reviewers' && method === 'POST') {
    const asked = args.filter((arg) => arg.startsWith('reviewers[]=')).map((arg) => arg.slice('reviewers[]='.length));
    item.reviewRequests = [...new Set([...(item.reviewRequests ?? []), ...asked])];
    save();
    out({ number: item.number });
  }
  const ref = /^git\\/refs\\/heads\\/(.+)$/.exec(route);
  if (ref && method === 'DELETE') {
    const gitDir = bare(owner, repo);
    if (!revParse(gitDir, 'refs/heads/' + decodeURIComponent(ref[1]))) restFail(422, 'Reference does not exist');
    execFileSync('git', ['--git-dir', gitDir, 'update-ref', '-d', 'refs/heads/' + decodeURIComponent(ref[1])]);
    process.exit(0);
  }
  // As on GitHub: re-running a run's failed jobs answers 201 with no body.
  if (/^actions\\/runs\\/\\d+\\/rerun-failed-jobs$/.test(route) && method === 'POST') process.exit(0);
  const job = /^actions\\/jobs\\/(\\d+)\\/logs$/.exec(route);
  if (job) {
    const log = state.items.map((candidate) => candidate.jobLogs?.[job[1]]).find((value) => value !== undefined);
    if (log === undefined) restFail(404, 'Not Found');
    process.stdout.write(log);
    process.exit(0);
  }
  process.stderr.write('fake gh: unexpected api ' + args.join(' ') + '\\n');
  process.exit(1);
}
if (args[0] === 'pr' && (args[1] === 'ready' || args[1] === 'comment')) {
  const item = pulls.find((candidate) => url(candidate) === args[2]);
  if (!item) { process.stderr.write('no pull requests found\\n'); process.exit(1); }
  if (args[1] === 'ready') item.isDraft = false;
  else item.comments = [...(item.comments ?? []), { author: state.viewer, body: stdin, createdAt: new Date().toISOString() }];
  save();
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  const selector = args[2];
  const item = pulls.find((candidate) => String(candidate.number) === selector || url(candidate) === selector || candidate.headRefName === selector);
  console.log(JSON.stringify((item?.checks ?? []).map((check) => ({ state: check.bucket === 'pass' ? 'SUCCESS' : check.bucket === 'fail' ? 'FAILURE' : 'PENDING', ...check }))));
  process.exit(check_exit(item));
}
function check_exit(item) { return (item?.checks ?? []).some((check) => check.bucket === 'pending') ? 8 : 0; }
if (args[0] === 'pr' && args[1] === 'view') {
  const selector = args[2];
  const item = pulls.find((candidate) => String(candidate.number) === selector || url(candidate) === selector || candidate.headRefName === selector);
  if (!item) { process.stderr.write('no pull requests found\\n'); process.exit(1); }
  out(view(item));
}
if (args[0] === 'pr' && args[1] === 'list') {
  const head = option('--head');
  out(pulls.filter((item) => (item.state ?? 'OPEN') === 'OPEN' && item.headRefName === head).map(view));
}
if (args[0] === 'pr' && args[1] === 'create') {
  const [owner, repo] = repoArg.split('/').slice(-2);
  const head = option('--head');
  const branch = head.includes(':') ? head.split(':')[1] : head;
  const headOwner = head.includes(':') ? head.split(':')[0] : owner;
  const headSha = execFileSync('git', ['--git-dir', path.join(${JSON.stringify(hostRoot)}, headOwner, repo + '.git'), 'rev-parse', 'refs/heads/' + branch], { encoding: 'utf8' }).trim();
  const number = Math.max(0, ...state.items.filter((item) => item.owner === owner && item.repo === repo).map((item) => item.number)) + 1;
  const item = { owner, repo, number, kind: 'PULL_REQUEST', title: option('--title'), body: stdin, isDraft: args.includes('--draft'),
    headRefName: branch, headRefOid: headSha, baseRefName: option('--base'), headRepository: headOwner + '/' + repo, isCrossRepository: headOwner !== owner };
  state.items.push(item);
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  console.log(url(item));
  process.exit(0);
}
process.stderr.write('fake gh: unexpected invocation ' + args.join(' ') + '\\n');
process.exit(1);
`;
}
