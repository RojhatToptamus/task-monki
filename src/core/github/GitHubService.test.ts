import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Task, WorktreeRecord } from '../../shared/contracts';
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
      worktree
    );

    expect(parsed.pullRequest.status).toBe('OPEN_DRAFT');
    expect(parsed.ci.status).toBe('PENDING');
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
  });
});

describe('GitHubService branch publication', () => {
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
});

function taskFixture(repositoryPath: string): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    prompt: 'Do work.',
    repositoryPath,
    workflowPhase: 'REVIEW',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    currentIterationId: 'iteration-1',
    currentWorktreeId: 'worktree-1',
    createdAt: now,
    updatedAt: now,
    projection: {
      requestedAction: 'NONE',
      codexRun: 'COMPLETED',
      osProcess: 'EXITED',
      repositoryPreflight: 'VALID',
      worktree: 'PRESENT',
      git: 'COMMITTED_UNPUSHED',
      tests: 'PASSED',
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
    repositoryPath: worktreePath,
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
