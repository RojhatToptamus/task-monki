import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorktreeRecord } from '../../shared/contracts';
import { git } from '../git/gitCli';
import { inspectExistingWorktree, WorktreeService } from './WorktreeService';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-external-checkout-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const linked = path.join(root, 'linked');
  const managed = path.join(root, 'managed');
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'base\n');
  await git(repo, ['add', 'file.txt']);
  await git(repo, ['commit', '-m', 'base']);
  await git(repo, ['worktree', 'add', '-b', 'feature', linked]);
  return { root, repo, linked, managed, service: new WorktreeService(managed) };
}

function record(worktreePath: string, branchName: string, headSha: string): WorktreeRecord {
  return {
    id: 'worktree', taskId: 'task', iterationId: 'iteration', repositoryId: 'repository',
    ownership: 'EXTERNAL', worktreePath, branchName, baseRef: 'main', baseSha: headSha,
    headSha, status: 'PRESENT', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

describe('External checkouts', () => {
  it('observes primary and linked checkouts without changing files, index, refs, permissions, or Git configuration', async () => {
    const f = await fixture();
    for (const checkout of [f.repo, f.linked]) {
      const observed = await inspectExistingWorktree(f.repo, checkout);
      const tracked = path.join(checkout, 'file.txt');
      await fs.writeFile(tracked, 'staged\n');
      await git(checkout, ['add', 'file.txt']);
      await fs.writeFile(tracked, 'unstaged\n');
      await fs.writeFile(path.join(checkout, 'untracked.txt'), 'untracked\n');
      const indexPath = path.resolve(checkout, (await git(checkout, ['rev-parse', '--git-path', 'index'])).trim());
      const before = {
        index: await fs.readFile(indexPath),
        mode: (await fs.stat(checkout)).mode,
        config: await git(checkout, ['config', '--local', '--list']),
        refs: await git(checkout, ['show-ref']),
        status: await git(checkout, ['status', '--porcelain=v2'])
      };
      const external = record(observed.worktreePath, observed.branchName, observed.headSha);
      await expect(f.service.verify(external, f.repo)).resolves.toMatchObject({ status: 'PRESENT' });
      await expect(f.service.verify(external, f.repo)).resolves.toMatchObject({ status: 'PRESENT' });
      expect(await fs.readFile(indexPath)).toEqual(before.index);
      expect((await fs.stat(checkout)).mode).toBe(before.mode);
      expect(await fs.readFile(tracked, 'utf8')).toBe('unstaged\n');
      expect(await fs.readFile(path.join(checkout, 'untracked.txt'), 'utf8')).toBe('untracked\n');
      expect(await git(checkout, ['config', '--local', '--list'])).toBe(before.config);
      expect(await git(checkout, ['show-ref'])).toBe(before.refs);
      expect(await git(checkout, ['status', '--porcelain=v2'])).toBe(before.status);
    }
    await expect(fs.stat(f.managed)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects creation and every removal path even when an external checkout is clean or missing', async () => {
    const f = await fixture();
    const observed = await inspectExistingWorktree(f.repo, f.linked, 'feature');
    for (const checkout of [f.repo, f.linked, path.join(f.root, 'missing')]) {
      const external = record(checkout, observed.branchName, observed.headSha);
      await expect(f.service.create(external, f.repo)).rejects.toThrow('external checkout');
      await expect(f.service.remove(external, f.repo)).rejects.toThrow('external checkout');
      await expect(f.service.removeOwnedManaged(external, { kind: 'DESIGN_MANAGED', path: f.repo })).rejects.toThrow('external checkout');
    }
    await expect(fs.readFile(path.join(f.linked, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    await expect(fs.stat(f.managed)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a changed branch, detached HEAD, an unrelated clone, and replaced Git metadata', async () => {
    const f = await fixture();
    const observed = await inspectExistingWorktree(f.repo, f.linked, 'feature');
    const external = record(observed.worktreePath, 'feature', observed.headSha);
    await git(f.linked, ['switch', '-c', 'other']);
    await expect(f.service.verify(external, f.repo)).resolves.toMatchObject({ status: 'ERROR', error: expect.stringContaining('feature') });
    await git(f.linked, ['checkout', '--detach']);
    await expect(inspectExistingWorktree(f.repo, f.linked)).rejects.toThrow('named branch');
    const clone = path.join(f.root, 'clone');
    await git(f.root, ['clone', f.repo, clone]);
    await expect(inspectExistingWorktree(f.repo, clone)).rejects.toThrow('common Git directory');
    const pointer = path.join(f.linked, '.git');
    await fs.rename(pointer, `${pointer}.original`);
    await fs.symlink(`${pointer}.original`, pointer);
    await expect(inspectExistingWorktree(f.repo, f.linked)).rejects.toThrow();
  });
});
