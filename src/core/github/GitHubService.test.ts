import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Task, WorktreeRecord } from '../../shared/contracts';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import {
  GitHubService,
  parseCiRollup,
  parseGitHubRemoteUrl,
  parsePrView
} from './GitHubService';

const execFileAsync = promisify(execFile);
const now = '2026-06-20T10:00:00.000Z';

describe('parseGitHubRemoteUrl', () => {
  it('parses common GitHub remote URL forms', () => {
    expect(parseGitHubRemoteUrl('https://github.com/openai/task-manager.git')).toEqual({
      host: 'github.com',
      owner: 'openai',
      repo: 'task-manager'
    });
    expect(parseGitHubRemoteUrl('git@github.com:openai/task-manager.git')).toEqual({
      host: 'github.com',
      owner: 'openai',
      repo: 'task-manager'
    });
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

describe('GitHubService pull request creation', () => {
  it('uses the requested title when creating a new draft PR', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-pr-title-'));
    const logPath = path.join(dir, 'gh.log');
    const ghPath = await writeFakePullRequestGh(logPath, {
      listRows: [],
      viewTitle: 'Custom PR title'
    });
    const service = new GitHubService(ghPath);

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
    const service = new GitHubService(ghPath);

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
  it('uses the configured executable instead of rereading raw env overrides', () => {
    const originalGhPath = process.env.TASK_MANAGER_GH_PATH;
    process.env.TASK_MANAGER_GH_PATH = '   ';
    try {
      const service = new GitHubService('/initial/gh');
      service.setExecutable('/resolved/gh');

      expect((service as unknown as { ghExecutable: string }).ghExecutable).toBe(
        '/resolved/gh'
      );
    } finally {
      if (originalGhPath === undefined) {
        delete process.env.TASK_MANAGER_GH_PATH;
      } else {
        process.env.TASK_MANAGER_GH_PATH = originalGhPath;
      }
    }
  });

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

    const service = new GitHubService();
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

    const service = new GitHubService();
    const result = await service.publishBranch({
      task: taskFixture(repo),
      worktree: worktreeFixture(repo),
      remoteName: 'origin'
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toBe(
      'Remote branch has newer commits. Sync the branch before pushing again.'
    );
  }, 15_000);
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
