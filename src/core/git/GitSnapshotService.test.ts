import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { WorktreeRecord } from '../../shared/contracts';
import { buildDiffEvidence, inspectGitSnapshot, parseGitStatusPorcelain } from './GitSnapshotService';

const execFileAsync = promisify(execFile);

describe('parseGitStatusPorcelain', () => {
  it('extracts branch, ahead/behind, dirty, and untracked counts', () => {
    const parsed = parseGitStatusPorcelain(
      [
        '# branch.oid abc',
        '# branch.head feature',
        '# branch.upstream origin/feature',
        '# branch.ab +2 -1',
        '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
        '1 .M N... 100644 100644 100644 aaa bbb src/b.ts',
        '? notes.txt',
        ''
      ].join('\0')
    );

    expect(parsed).toMatchObject({
      headSha: 'abc',
      branch: 'feature',
      upstreamRef: 'origin/feature',
      aheadCount: 2,
      behindCount: 1,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedPaths: ['notes.txt']
    });
  });
});

describe('inspectGitSnapshot', () => {
  it('captures dirty worktree status and diff evidence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-git-snapshot-'));
    await git(dir, ['init']);
    await git(dir, ['config', 'user.email', 'test@example.com']);
    await git(dir, ['config', 'user.name', 'Test User']);
    await fs.writeFile(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    await git(dir, ['add', 'README.md']);
    await git(dir, ['commit', '-m', 'init']);
    const baseSha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    await fs.writeFile(path.join(dir, 'phase2-note.txt'), 'phase 2\n', 'utf8');

    const worktree: WorktreeRecord = {
      id: 'worktree-1',
      taskId: 'task-1',
      iterationId: 'iteration-1',
      repositoryPath: dir,
      worktreePath: dir,
      branchName: 'main',
      baseSha,
      status: 'PRESENT',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const snapshot = await inspectGitSnapshot(worktree);
    const diffEvidence = await buildDiffEvidence(worktree);

    expect(snapshot.status).toBe('DIRTY');
    expect(snapshot.untrackedCount).toBe(1);
    expect(snapshot.dirtyFingerprint).toHaveLength(64);
    expect(diffEvidence).toContain('Git diff evidence');
  });
});

async function git(cwd: string, argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', argv, { cwd });
  return stdout;
}
