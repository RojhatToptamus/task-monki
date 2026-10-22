import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PULL_REQUEST_FEEDBACK_LIMITS, type Task, type WorktreeRecord } from '../../shared/contracts';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import { createFakeGitHub } from '../../testSupport/fakeGitHub';
import { GitHubCli } from './GitHubCli';
import { gitHubMergeFailure } from './GitHubPullRequestActions';
import {
  GitHubService,
  detectGitHubRemote,
  parseCiRollup,
  parsePrView
} from './GitHubService';

const execFileAsync = promisify(execFile);
const now = '2026-06-20T10:00:00.000Z';

describe('GitHub remote detection', () => {
  // The remote grammar itself is covered beside parseRemoteRepositoryUrl; these are the remotes delivery picks.
  it.each([
    'ssh://git@ssh.github.com:443/acme/widgets.git',
    'https://GitHub.com/acme/widgets.git/'
  ])('delivers through %s as acme/widgets on github.com', async (url) => {
    const { repo } = await checkout({ origin: url });
    expect(await detectGitHubRemote(repo)).toEqual({
      remoteName: 'origin', remoteUrl: 'https://github.com/acme/widgets.git', host: 'github.com', owner: 'acme', repo: 'widgets'
    });
  });

  it('delivers through origin, not a fork remote listed before it', async () => {
    const { repo } = await checkout({ fork: 'git@github.com:someone/widgets.git', origin: 'https://github.com/acme/widgets.git' });
    expect(await detectGitHubRemote(repo)).toMatchObject({ remoteName: 'origin', owner: 'acme', repo: 'widgets' });
  });

  it('records the remote preflight checked without its credentials', async () => {
    const { root, repo } = await checkout({ origin: 'https://x-access-token:ghp_secret@github.com/acme/widgets.git' });
    const github = await createFakeGitHub(root);
    const record = await new GitHubService(new GitHubCli(github.ghPath)).preflight(taskFixture(repo), worktreeFixture(repo));
    expect(record).toMatchObject({
      status: 'READY', remoteName: 'origin', remoteUrl: 'https://github.com/acme/widgets.git', host: 'github.com', owner: 'acme', repo: 'widgets'
    });
    expect(JSON.stringify(record)).not.toContain('ghp_secret');
  });
});

describe('GitHub CLI failures', () => {
  it('reads a missing or signed-out gh the same way on every call', async () => {
    const { root, repo } = await checkout({ origin: 'https://github.com/acme/widgets.git' });
    const github = await createFakeGitHub(root);
    const cli = new GitHubCli(path.join(root, 'missing-gh'));
    const service = new GitHubService(cli);
    const address = { number: 9, url: 'https://github.com/acme/widgets/pull/9' };
    const merge = { method: 'MERGE' as const, expectedHeadSha: 'a'.repeat(40) };

    expect(await service.preflight(taskFixture(repo), worktreeFixture(repo))).toMatchObject({ status: 'GH_MISSING', error: 'GitHub CLI was not found.' });
    await expect(service.mergePullRequest(worktreeFixture(repo), address, merge)).rejects.toThrow('GitHub CLI was not found.');

    // Every later call runs the executable settings resolved last.
    cli.setExecutable(github.ghPath);
    await github.setSignedIn(false);
    expect(await service.preflight(taskFixture(repo), worktreeFixture(repo)))
      .toMatchObject({ status: 'AUTH_REQUIRED', error: 'GitHub CLI is not signed in to github.com.' });
    await expect(service.readMergeOptions(worktreeFixture(repo), address)).rejects.toThrow('GitHub CLI is not signed in to github.com.');
    await expect(service.mergePullRequest(worktreeFixture(repo), address, merge)).rejects.toThrow('GitHub CLI is not signed in to github.com.');
    await github.setSignedIn(true);
    expect(await service.preflight(taskFixture(repo), worktreeFixture(repo))).toMatchObject({ status: 'READY' });
  }, 15_000);

  it('names GitHub\'s whole reason for refusing a merge', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-merge-refused-'));
    const github = await createFakeGitHub(dir);
    await github.setItem({
      owner: 'acme', repo: 'widgets', number: 9, kind: 'PULL_REQUEST', title: 'Save layouts', headRefName: 'feature',
      mergeRefusal: 'Required status check "build" is expected.'
    });
    // gh prints the response on stdout and its own line on stderr; the quoted check name survives both.
    await expect(new GitHubService(new GitHubCli(github.ghPath)).mergePullRequest(worktreeFixture(dir),
      { number: 9, url: 'https://github.com/acme/widgets/pull/9' }, { method: 'MERGE', expectedHeadSha: 'a'.repeat(40) }))
      .rejects.toMatchObject({ message: 'GitHub refused the merge: Required status check "build" is expected.' });
    // Without the response, gh's own line still names the reason.
    expect(gitHubMergeFailure('gh: Pull Request is not mergeable (HTTP 405)')).toBe('GitHub refused the merge: Pull Request is not mergeable.');
  });
});

describe('GitHub PR rollups', () => {
  it('separates PR, CI, review, and merge facts', () => {
    const worktree = worktreeFixture('/tmp/repo');
    const parsed = parsePrView(
      {
        number: 7,
        url: 'https://github.com/openai/task-manager/pull/7',
        state: 'OPEN',
        isDraft: true,
        headRefName: 'codex/task',
        headRefOid: 'abc',
        baseRefName: 'main',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [
          { name: 'test', conclusion: 'SUCCESS' },
          { name: 'lint', status: 'IN_PROGRESS' }
        ]
      },
      worktree,
      [
        {
          name: 'test',
          bucket: 'pass',
          state: 'SUCCESS',
          workflow: 'CI',
          link: 'https://github.com/openai/task-manager/actions/runs/1'
        },
        {
          name: 'lint',
          bucket: 'pending',
          state: 'IN_PROGRESS',
          workflow: 'CI'
        }
      ]
    );

    expect(parsed.pullRequest.status).toBe('OPEN_DRAFT');
    expect(parsed.ci.status).toBe('PENDING');
    expect(parsed.ci.checkDetails).toEqual([
      {
        name: 'test',
        status: 'passed',
        state: 'SUCCESS',
        workflow: 'CI',
        link: 'https://github.com/openai/task-manager/actions/runs/1',
        description: undefined,
        event: undefined,
        startedAt: undefined,
        completedAt: undefined
      },
      {
        name: 'lint',
        status: 'pending',
        state: 'IN_PROGRESS',
        workflow: 'CI',
        link: undefined,
        description: undefined,
        event: undefined,
        startedAt: undefined,
        completedAt: undefined
      }
    ]);
    expect(parsed.reviews.status).toBe('REQUESTED');
    expect(parsed.merge.status).toBe('NOT_MERGED');
  });

  it('reads mergeability from GitHub\'s merge state, which conflicts alone do not decide', () => {
    const merge = (mergeStateStatus: string | undefined, mergeable = 'MERGEABLE', isDraft = false) => parsePrView({
      number: 9, url: 'https://github.com/openai/task-manager/pull/9', state: 'OPEN', isDraft,
      headRefOid: 'abc', mergeable, ...(mergeStateStatus ? { mergeStateStatus } : {})
    }, worktreeFixture('/tmp/repo')).merge.status;

    expect(merge('CLEAN')).toBe('MERGEABLE');
    // Checks that are not required may fail; the checks say so.
    expect(merge('UNSTABLE')).toBe('MERGEABLE');
    // A draft, and a pull request held by required reviews or checks, can merge cleanly and still not merge.
    expect(merge('DRAFT', 'MERGEABLE', true)).toBe('NOT_MERGED');
    expect(merge('BLOCKED')).toBe('NOT_MERGED');
    // Conflicts and a branch that must be updated block it.
    expect(merge('DRAFT', 'CONFLICTING', true)).toBe('BLOCKED');
    expect(merge('DIRTY', 'CONFLICTING')).toBe('BLOCKED');
    expect(merge('BEHIND')).toBe('BLOCKED');
    expect(merge('UNKNOWN', 'UNKNOWN')).toBe('UNKNOWN');
    // Without a merge state, Git's answer is all there is.
    expect(merge(undefined)).toBe('MERGEABLE');
  });

  it('keeps GitHub\'s merge time in the store\'s canonical form', () => {
    const parsed = parsePrView({
      number: 9, url: 'https://github.com/openai/task-manager/pull/9', state: 'MERGED', headRefOid: 'abc',
      mergedAt: '2026-10-17T00:51:22Z'
    }, worktreeFixture('/tmp/repo'));
    expect(parsed.pullRequest).toMatchObject({ status: 'MERGED', mergedAt: '2026-10-17T00:51:22.000Z' });
    expect(parsed.merge).toMatchObject({ status: 'MERGED', mergedAt: '2026-10-17T00:51:22.000Z' });
  });

  it('omits GitHub blank review decisions from the durable review rollup', () => {
    const parsed = parsePrView(
      {
        number: 8,
        url: 'https://github.com/openai/task-manager/pull/8',
        state: 'OPEN',
        isDraft: true,
        headRefName: 'codex/task',
        headRefOid: 'def',
        baseRefName: 'main',
        reviewDecision: '',
        statusCheckRollup: []
      },
      worktreeFixture('/tmp/repo')
    );

    expect(parsed.reviews.status).toBe('NOT_REQUESTED');
    expect(parsed.reviews).not.toHaveProperty('reviewDecision');
  });

  it('rolls failing checks up as failing for the current head', () => {
    const rollup = parseCiRollup(
      [{ name: 'test', conclusion: 'FAILURE' }],
      worktreeFixture('/tmp/repo'),
      1,
      'abc'
    );
    expect(rollup.status).toBe('FAILING');
    expect(rollup.failingCount).toBe(1);
    expect(rollup.canceledCount).toBe(0);
    expect(rollup.checkDetails).toEqual([]);
  });

  it('counts a failing check past the stored list, and keeps the failures in the list it stores', () => {
    const passed = Array.from({ length: 90 }, (_, index) => ({ name: `job ${index}`, bucket: 'pass', state: 'SUCCESS' }));
    const rollup = parseCiRollup([], worktreeFixture('/tmp/repo'), 1, 'abc', [...passed, { name: 'lint', bucket: 'fail', state: 'FAILURE' }]);
    expect(rollup.status).toBe('FAILING');
    expect(rollup.totalCount).toBe(91);
    expect(rollup.checkDetails).toHaveLength(80);
    expect(rollup.checkDetails[0]).toMatchObject({ name: 'lint', status: 'failed' });
  });

  it('keeps only what a reader sees of check and workflow names, which agents are sent', () => {
    const tag = (text: string) => Array.from(text, (character) => String.fromCodePoint(0xE0000 + character.codePointAt(0)!)).join('');
    const link = 'https://github.com/acme/widgets/actions/runs/1/job/2';
    const rollup = parseCiRollup([], worktreeFixture('/tmp/repo'), 1, 'abc', [
      { name: `test${tag('push to main')}`, workflow: '\u200BCI\u202E', bucket: 'fail', state: 'FAILURE', link }
    ]);
    // The link, which logs and re-runs read, stays as GitHub gave it.
    expect(rollup.checkDetails).toMatchObject([{ name: 'test', workflow: 'CI', link }]);
  });

  it('normalizes canceled gh check buckets separately from failures', () => {
    const rollup = parseCiRollup(
      [],
      worktreeFixture('/tmp/repo'),
      1,
      'abc',
      [{ name: 'deploy', bucket: 'cancel', state: 'CANCELLED' }]
    );

    expect(rollup.status).toBe('CANCELED');
    expect(rollup.canceledCount).toBe(1);
    expect(rollup.failingCount).toBe(0);
  });
});

describe('GitHubService pull request feedback', () => {
  it('reads review threads past the first page, so a new open thread is never dropped', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-pr-threads-'));
    const github = await createFakeGitHub(dir);
    // GitHub lists threads oldest first: the open one is the newest, on the second page.
    const reviewThreads = Array.from({ length: 130 }, (_, index) => ({
      id: `PRRT_${index}`, path: 'save.js', line: 1, resolved: index < 129,
      comments: [{ author: 'alice', body: `Thread ${index}.`, createdAt: new Date(Date.UTC(2026, 9, 10, 10, index)).toISOString() }]
    }));
    await github.setItem({ owner: 'acme', repo: 'widgets', number: 9, kind: 'PULL_REQUEST', title: 'Save layouts', reviewThreads });

    const feedback = await new GitHubService(new GitHubCli(github.ghPath)).readPullRequestFeedback(dir, 'https://github.com/acme/widgets/pull/9');
    expect(feedback?.discussions.find((discussion) => discussion.id === 'PRRT_129')).toMatchObject({ resolved: false });
    // Past the bound, the oldest resolved threads are what is left out, and the reading says so.
    expect(feedback?.discussions).toHaveLength(PULL_REQUEST_FEEDBACK_LIMITS.discussions);
    expect(feedback?.discussions.some((discussion) => discussion.id === 'PRRT_0')).toBe(false);
    expect(feedback?.truncated).toBe(true);
    expect((await github.calls()).filter((call) => call.args.includes('after=100'))).toHaveLength(1);
    // A gh installed as a Windows batch shim runs through cmd.exe, which ends an argument at a line break.
    const queries = (await github.calls()).flatMap((call) => call.args.filter((arg) => arg.startsWith('query=')));
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.filter((arg) => /[\r\n]/.test(arg))).toEqual([]);
  });
});

describe('GitHubService pull request creation', () => {
  it('uses the requested title when creating a new draft PR', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-pr-title-'));
    const logPath = path.join(dir, 'gh.log');
    const ghPath = await writeFakePullRequestGh(logPath, {
      listRows: [],
      viewTitle: 'Custom PR title'
    });
    const service = new GitHubService(new GitHubCli(ghPath));

    const sync = await service.createOrFindDraftPullRequest({
      worktree: worktreeFixture(dir),
      baseRef: 'main',
      body: '## Summary\n\nPrivate draft body.\n',
      title: 'Custom PR title'
    });

    expect(sync.pullRequest.title).toBe('Custom PR title');
    const createInvocation = (await readGhInvocations(logPath)).find(
      (args) => args[0] === 'pr' && args[1] === 'create'
    );
    expect(createInvocation).toEqual(
      expect.arrayContaining(['--title', 'Custom PR title', '--body-file', '-'])
    );
    await expect(fs.readFile(`${logPath}.body`, 'utf8')).resolves.toBe(
      '## Summary\n\nPrivate draft body.\n'
    );
  });

  it('reuses an existing open PR without creating or retitling it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-pr-existing-'));
    const logPath = path.join(dir, 'gh.log');
    const ghPath = await writeFakePullRequestGh(logPath, {
      listRows: [
        {
          number: 14,
          url: 'https://github.com/example/repo/pull/14',
          state: 'OPEN',
          isDraft: true,
          headRefName: 'codex/task-test',
          headRefOid: 'abc',
          baseRefName: 'main',
          title: 'Existing PR title',
          reviewDecision: 'REVIEW_REQUIRED',
          statusCheckRollup: []
        }
      ],
      viewTitle: 'Existing PR title'
    });
    const service = new GitHubService(new GitHubCli(ghPath));

    const sync = await service.createOrFindDraftPullRequest({
      worktree: worktreeFixture(dir),
      baseRef: 'main',
      body: 'unused because the PR exists',
      title: 'Edited title'
    });

    expect(sync.pullRequest.title).toBe('Existing PR title');
    const invocations = await readGhInvocations(logPath);
    expect(invocations.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });
});

describe('GitHubService branch publication', { timeout: 15_000 }, () => {
  it('pushes a committed task branch to a local bare remote', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-publish-'));
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    await git(dir, ['init', '--bare', remote]);
    await fs.mkdir(repo);
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(repo, 'README.md'), '# Repo\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'init']);
    await git(repo, ['checkout', '-b', 'codex/task-test']);
    await fs.writeFile(path.join(repo, 'change.txt'), 'change\n', 'utf8');
    await git(repo, ['add', 'change.txt']);
    await git(repo, ['commit', '-m', 'change']);

    const service = new GitHubService(new GitHubCli());
    const result = await service.publishBranch({
      task: taskFixture(repo),
      worktree: worktreeFixture(repo),
      remoteName: 'origin'
    });

    expect(result.status).toBe('PUSHED');
    await expect(git(repo, ['ls-remote', '--heads', 'origin', 'codex/task-test'])).resolves.toContain(
      'refs/heads/codex/task-test'
    );
  });

  it('normalizes non-fast-forward push rejections', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-publish-reject-'));
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const peer = path.join(dir, 'peer');
    await git(dir, ['init', '--bare', remote]);
    await fs.mkdir(repo);
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(repo, 'README.md'), '# Repo\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'init']);
    await git(repo, ['checkout', '-b', 'codex/task-test']);
    await fs.writeFile(path.join(repo, 'first.txt'), 'first\n', 'utf8');
    await git(repo, ['add', 'first.txt']);
    await git(repo, ['commit', '-m', 'first']);
    await git(repo, ['push', '--set-upstream', 'origin', 'HEAD']);

    await git(dir, ['clone', remote, peer]);
    await git(peer, ['config', 'user.email', 'peer@example.com']);
    await git(peer, ['config', 'user.name', 'Peer User']);
    await git(peer, ['checkout', 'codex/task-test']);
    await fs.writeFile(path.join(peer, 'remote.txt'), 'remote\n', 'utf8');
    await git(peer, ['add', 'remote.txt']);
    await git(peer, ['commit', '-m', 'remote update']);
    await git(peer, ['push', 'origin', 'HEAD']);

    await fs.writeFile(path.join(repo, 'local.txt'), 'local\n', 'utf8');
    await git(repo, ['add', 'local.txt']);
    await git(repo, ['commit', '-m', 'local update']);

    const service = new GitHubService(new GitHubCli());
    const result = await service.publishBranch({
      task: taskFixture(repo),
      worktree: worktreeFixture(repo),
      remoteName: 'origin'
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toBe(
      'Remote branch has newer commits'
    );
  }, 15_000);

  it('blocks an interrupted publication when the remote ref differs or cannot be inspected', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-manager-publish-reconcile-')
    );
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    await git(dir, ['init', '--bare', remote]);
    await fs.mkdir(repo);
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(repo, 'README.md'), '# Repo\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'init']);
    await git(repo, ['checkout', '-b', 'codex/task-test']);
    const remoteHead = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['push', '--set-upstream', 'origin', 'HEAD']);

    const service = new GitHubService(new GitHubCli());
    const mismatched = await service.reconcileBranchPublication({
      task: taskFixture(repo),
      worktree: worktreeFixture(repo),
      remoteName: 'origin',
      expectedHeadSha: '1111111111111111111111111111111111111111'
    });
    expect(mismatched).toMatchObject({
      status: 'AMBIGUOUS',
      headSha: '1111111111111111111111111111111111111111'
    });
    expect(mismatched.error).toContain(remoteHead.slice(0, 12));

    const unavailable = await service.reconcileBranchPublication({
      task: taskFixture(repo),
      worktree: worktreeFixture(repo),
      remoteName: 'missing',
      expectedHeadSha: remoteHead
    });
    expect(unavailable.status).toBe('AMBIGUOUS');
    expect(unavailable.error).toMatch(/Could not confirm the remote branch/iu);
  });
});

async function writeFakePullRequestGh(
  logPath: string,
  options: { listRows: unknown[]; viewTitle: string }
): Promise<string> {
  return writeNodeExecutable(
    path.dirname(logPath),
    'gh',
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify(${JSON.stringify(options.listRows)}));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { body += chunk; });
  process.stdin.on('end', () => {
    fs.writeFileSync(${JSON.stringify(`${logPath}.body`)}, body);
    console.log('https://github.com/example/repo/pull/14');
  });
} else if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({
    number: 14,
    url: 'https://github.com/example/repo/pull/14',
    state: 'OPEN',
    isDraft: true,
    headRefName: 'codex/task-test',
    headRefOid: 'abc',
    baseRefName: 'main',
    title: ${JSON.stringify(options.viewTitle)},
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: []
  }));
  process.exit(0);
} else if (args[0] === 'pr' && args[1] === 'checks') {
  console.log('[]');
  process.exit(0);
} else {
  console.error('Unexpected gh invocation: ' + args.join(' '));
  process.exit(1);
}
`
  );
}

async function readGhInvocations(logPath: string): Promise<string[][]> {
  const content = await fs.readFile(logPath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function taskFixture(repositoryId: string): Task {
  return {
    id: 'task-1',
    kind: 'NORMAL',
    runtimeId: 'codex',
    title: 'Test task',
    prompt: 'Do work.',
    repositoryId,
    workflowPhase: 'REVIEW',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    currentIterationId: 'iteration-1',
    currentWorktreeId: 'worktree-1',
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    projection: {
      requestedAction: 'NONE',
      agentRun: 'COMPLETED',
      osProcess: 'EXITED',
      repositoryPreflight: 'VALID',
      worktree: 'PRESENT',
      git: 'COMMITTED_UNPUSHED',
      githubRepository: 'READY',
      branchPublication: 'NOT_PUSHED',
      githubPullRequest: 'UNLINKED',
      ciChecks: 'NOT_APPLICABLE',
      reviews: 'NOT_APPLICABLE',
      merge: 'NOT_APPLICABLE',
      artifact: 'FINAL_MESSAGE_PRESENT',
      health: 'HEALTHY',
      summary: 'Ready.',
      findings: [],
      updatedAt: now
    }
  };
}

function worktreeFixture(worktreePath: string): WorktreeRecord {
  return {
    id: 'worktree-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    repositoryId: 'repository-1',
    ownership: 'MANAGED' as const,
    worktreePath,
    branchName: 'codex/task-test',
    baseSha: 'base',
    status: 'PRESENT',
    createdAt: now,
    updatedAt: now
  };
}

async function git(cwd: string, argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', argv, { cwd });
  return stdout;
}

/** A scratch checkout with these remotes, in a directory of its own. */
async function checkout(remotes: Record<string, string>): Promise<{ root: string; repo: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-remotes-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '--quiet']);
  for (const [name, url] of Object.entries(remotes)) await git(repo, ['remote', 'add', name, url]);
  return { root, repo };
}
