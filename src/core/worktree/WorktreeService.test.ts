import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Task, WorktreeRecord } from '../../shared/contracts';
import { parseGitWorktreeList, WorktreeService } from './WorktreeService';

const execFileAsync = promisify(execFile);

describe('parseGitWorktreeList', () => {
  it('parses porcelain -z worktree output', () => {
    const parsed = parseGitWorktreeList(
      [
        'worktree /repo',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /repo-wt',
        'HEAD def',
        'branch refs/heads/codex/task',
        'locked maintenance',
        ''
      ].join('\0')
    );

    expect(parsed).toEqual([
      {
        path: '/repo',
        headSha: 'abc',
        branch: 'main',
        bare: false,
        detached: false
      },
      {
        path: '/repo-wt',
        headSha: 'def',
        branch: 'codex/task',
        bare: false,
        detached: false,
        locked: 'maintenance'
      }
    ]);
  });
});

describe('WorktreeService', () => {
  it('uses a provider-neutral branch namespace for new task worktrees', () => {
    const service = new WorktreeService('/tmp/task-monki-worktrees');
    const spec = service.buildSpecFromBase(
      {
        id: '12345678-task',
        title: 'Implement provider routing'
      } as Task,
      { baseRef: 'main', baseSha: 'abc123' }
    );

    expect(spec.branchName).toBe(
      'task-monki/task-12345678-implement-provider-routing'
    );
  });

  it('creates and verifies an isolated worktree for a task branch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-worktree-'));
    const repo = path.join(dir, 'repo');
    const worktreeRoot = path.join(dir, 'worktrees');
    await fs.mkdir(repo);
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    await fs.writeFile(path.join(repo, 'README.md'), '# Repo\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'init']);
    const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    const service = new WorktreeService(worktreeRoot);
    const record: WorktreeRecord = {
      id: 'worktree-1',
      taskId: 'task-1',
      iterationId: 'iteration-1',
      repositoryId: 'repository-1',
      worktreePath: path.join(worktreeRoot, 'task-1'),
      branchName: 'codex/task-test',
      baseSha,
      status: 'CREATING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const created = await service.create(record, repo);
    expect(created.status).toBe('PRESENT');
    expect(created.headSha).toBe(baseSha);
    await expect(fs.access(path.join(record.worktreePath, 'README.md'))).resolves.toBeUndefined();
  }, 15_000);
});

async function git(cwd: string, argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', argv, { cwd });
  return stdout;
}
