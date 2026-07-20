import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { WorktreeRecord } from '../../shared/contracts';
import { buildDiffFileTree, parseGitDiffEvidenceForScope } from '../../renderer/model/diffEvidence';
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
    const { dir, worktree } = await createCommittedRepoFixture();
    await fs.writeFile(path.join(dir, 'phase2-note.txt'), 'phase 2\n', 'utf8');

    const snapshot = await inspectGitSnapshot(worktree);
    const diffEvidence = await buildDiffEvidence(worktree);

    expect(snapshot.status).toBe('DIRTY');
    expect(snapshot.untrackedCount).toBe(1);
    expect(snapshot.workingDiffFileCount).toBe(1);
    expect(snapshot.diffStat).toContain('phase2-note.txt');
    expect(snapshot.dirtyFingerprint).toHaveLength(64);
    expect(diffEvidence).toContain('Git diff evidence');
    expect(diffEvidence).toContain('diff --git a/phase2-note.txt b/phase2-note.txt');
    expect(diffEvidence).toContain('new file mode');
    expect(diffEvidence).toContain('+phase 2');

    const parsedFiles = parseGitDiffEvidenceForScope(diffEvidence, 'uncommitted');
    expect(parsedFiles).toEqual([
      expect.objectContaining({
        path: 'phase2-note.txt',
        status: 'added',
        additions: 1,
        deletions: 0
      })
    ]);
  });

  it('captures empty untracked files as added files with no line changes', async () => {
    const { dir, worktree } = await createCommittedRepoFixture();
    await fs.writeFile(path.join(dir, 'empty.txt'), '', 'utf8');

    const snapshot = await inspectGitSnapshot(worktree);
    const diffEvidence = await buildDiffEvidence(worktree);

    expect(snapshot.status).toBe('DIRTY');
    expect(snapshot.untrackedCount).toBe(1);
    expect(snapshot.workingDiffFileCount).toBe(1);
    expect(snapshot.diffStat).toContain('empty.txt');
    expect(diffEvidence).toContain('diff --git a/empty.txt b/empty.txt');
    expect(diffEvidence).toContain('new file mode 100644');

    const parsedFiles = parseGitDiffEvidenceForScope(diffEvidence, 'uncommitted');
    expect(parsedFiles).toEqual([
      expect.objectContaining({
        path: 'empty.txt',
        status: 'added',
        additions: 0,
        deletions: 0
      })
    ]);
  });

  it('captures nested untracked files instead of collapsed untracked directories', async () => {
    const { dir, worktree } = await createCommittedRepoFixture();

    await fs.mkdir(path.join(dir, 'alpha', 'one'), { recursive: true });
    await fs.mkdir(path.join(dir, 'beta', 'two'), { recursive: true });
    await fs.writeFile(path.join(dir, 'alpha', 'one', 'index.html'), '<h1>Alpha</h1>\n', 'utf8');
    await fs.writeFile(path.join(dir, 'beta', 'two', 'about.html'), '<h1>Beta</h1>\n', 'utf8');

    const snapshot = await inspectGitSnapshot(worktree);
    const diffEvidence = await buildDiffEvidence(worktree);

    expect(snapshot.status).toBe('DIRTY');
    expect(snapshot.untrackedCount).toBe(2);
    expect(snapshot.workingDiffFileCount).toBe(2);
    expect(snapshot.diffStat).toContain('alpha/one/index.html');
    expect(snapshot.diffStat).toContain('beta/two/about.html');
    expect(diffEvidence).toContain('## Unstaged diff');
    expect(diffEvidence).toContain('diff --git a/alpha/one/index.html b/alpha/one/index.html');
    expect(diffEvidence).toContain('diff --git a/beta/two/about.html b/beta/two/about.html');
    expect(diffEvidence).toContain('new file mode 100644');
    expect(diffEvidence).toContain('--- /dev/null');
    expect(diffEvidence).toContain('+++ b/alpha/one/index.html');
    expect(diffEvidence).toContain('+++ b/beta/two/about.html');
    expect(diffEvidence).toContain('+<h1>Alpha</h1>');
    expect(diffEvidence).toContain('+<h1>Beta</h1>');

    const parsedFiles = parseGitDiffEvidenceForScope(diffEvidence, 'uncommitted');
    expect(parsedFiles).toHaveLength(2);
    expect(parsedFiles.map((file) => file.path)).toEqual(['alpha/one/index.html', 'beta/two/about.html']);
    expect(parsedFiles).toEqual([
      expect.objectContaining({
        path: 'alpha/one/index.html',
        status: 'added',
        additions: 1,
        deletions: 0
      }),
      expect.objectContaining({
        path: 'beta/two/about.html',
        status: 'added',
        additions: 1,
        deletions: 0
      })
    ]);
    expect(parsedFiles.every((file) => file.blocks[0]?.source === 'unstaged')).toBe(true);

    const tree = buildDiffFileTree(parsedFiles);
    expect(tree).toMatchObject({
      fileCount: 2,
      additions: 2,
      deletions: 0
    });
    expect(tree.children.map((node) => node.name)).toEqual(['alpha', 'beta']);
    expect(tree.children[0]).toMatchObject({
      type: 'directory',
      name: 'alpha',
      fileCount: 1
    });
  });

  it('does not report empty directories because Git has no file entry to diff', async () => {
    const { dir, worktree } = await createCommittedRepoFixture();
    await fs.mkdir(path.join(dir, 'empty-folder'), { recursive: true });

    const snapshot = await inspectGitSnapshot(worktree);
    const diffEvidence = await buildDiffEvidence(worktree);

    expect(snapshot.status).toBe('CLEAN');
    expect(snapshot.untrackedCount).toBe(0);
    expect(snapshot.workingDiffFileCount).toBe(0);
    expect(diffEvidence).toContain('No unstaged diff.');
    expect(parseGitDiffEvidenceForScope(diffEvidence, 'uncommitted')).toEqual([]);
  });
});

async function createCommittedRepoFixture(): Promise<{
  dir: string;
  worktree: WorktreeRecord;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-git-snapshot-'));
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);

  return {
    dir,
    worktree: createWorktreeRecord(dir, (await git(dir, ['rev-parse', 'HEAD'])).trim())
  };
}

function createWorktreeRecord(dir: string, baseSha: string): WorktreeRecord {
  const timestamp = new Date().toISOString();
  return {
    id: 'worktree-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    repositoryId: dir,
    worktreePath: dir,
    branchName: 'main',
    baseSha,
    status: 'PRESENT',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function git(cwd: string, argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', argv, { cwd });
  return stdout;
}
