import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { listGitWorktrees } from '../worktree/WorktreeService';
import { git } from './gitCli';
import { ReadOnlySnapshotService } from './ReadOnlySnapshotService';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) return;
  await fs.chmod(target, stat.mode | 0o700);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(target)) await makeWritable(path.join(target, name));
  }
}

/** A repository with a linked task worktree that has committed, staged, unstaged and untracked work. */
async function taskWorktree() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-snapshots-')));
  roots.push(root);
  const repository = path.join(root, 'repo');
  const live = path.join(root, 'worktrees', 'task');
  await fs.mkdir(repository, { recursive: true });
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['config', 'user.email', 'snapshots@example.invalid']);
  await git(repository, ['config', 'user.name', 'Snapshot Test']);
  await fs.writeFile(path.join(repository, '.gitignore'), 'ignored.log\n');
  await fs.writeFile(path.join(repository, 'committed.txt'), 'base\n');
  await fs.writeFile(path.join(repository, 'staged.txt'), 'base\n');
  await fs.writeFile(path.join(repository, 'unstaged.txt'), 'base\n');
  await fs.writeFile(path.join(repository, 'deleted.txt'), 'remove me\n');
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'base']);
  await git(repository, ['worktree', 'add', '-q', '-b', 'task', live, 'HEAD']);

  await fs.writeFile(path.join(live, 'committed.txt'), 'committed change\n');
  await git(live, ['commit', '-q', '-am', 'task commit']);
  await fs.writeFile(path.join(live, 'staged.txt'), 'staged change\n');
  await git(live, ['add', 'staged.txt']);
  await fs.writeFile(path.join(live, 'unstaged.txt'), 'unstaged change\n');
  await fs.writeFile(path.join(live, 'binary.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
  await git(live, ['add', 'binary.bin']);
  await fs.rm(path.join(live, 'deleted.txt'));
  await fs.mkdir(path.join(live, 'notes'), { recursive: true });
  await fs.writeFile(path.join(live, 'notes', 'untracked.md'), 'untracked note\n');
  await fs.writeFile(path.join(live, 'large.bin'), Buffer.alloc(4096, 1));
  await fs.writeFile(path.join(live, 'ignored.log'), 'not part of the worktree view\n');
  return { root, repository, live };
}

async function registeredUnder(repository: string, directory: string): Promise<string[]> {
  const prefix = `${await fs.realpath(directory).catch(() => directory)}${path.sep}`;
  return (await listGitWorktrees(repository)).map((entry) => entry.path).filter((entry) => entry.startsWith(prefix));
}

describe('ReadOnlySnapshotService', () => {
  it('copies committed, staged, unstaged and untracked work into a read-only detached worktree', async () => {
    const { root, repository, live } = await taskWorktree();
    const snapshots = new ReadOnlySnapshotService({ root: path.join(root, 'snapshots'), maxFileBytes: 1024 });
    const taskId = randomUUID();
    const threadId = randomUUID();

    const snapshot = await snapshots.prepare(taskId, threadId, { worktreePath: live });

    expect(snapshot).toMatchObject({ reused: false, path: path.join(root, 'snapshots', taskId, threadId) });
    expect(snapshot.headSha).toBe((await git(live, ['rev-parse', 'HEAD'])).trim());
    const read = (file: string) => fs.readFile(path.join(snapshot.path, file), 'utf8');
    expect(await read('committed.txt')).toBe('committed change\n');
    expect(await read('staged.txt')).toBe('staged change\n');
    expect(await read('unstaged.txt')).toBe('unstaged change\n');
    expect(await read('notes/untracked.md')).toBe('untracked note\n');
    expect(await fs.readFile(path.join(snapshot.path, 'binary.bin'))).toEqual(Buffer.from([0, 1, 2, 255, 254, 0, 7]));
    await expect(fs.access(path.join(snapshot.path, 'deleted.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(snapshot.path, 'ignored.log'))).rejects.toThrow();
    // Untracked files over the cap are left out and reported.
    await expect(fs.access(path.join(snapshot.path, 'large.bin'))).rejects.toThrow();
    expect(snapshot.omitted).toEqual([{ path: 'large.bin', reason: 'LARGER_THAN_FILE_LIMIT' }]);
    // The snapshot keeps the staging: staged work is in its index, the rest only in its files.
    expect((await git(snapshot.path, ['diff', '--cached', '--name-only'])).trim().split('\n').sort())
      .toEqual(['binary.bin', 'staged.txt']);
    expect((await git(snapshot.path, ['branch', '--show-current'])).trim()).toBe('');

    // Every file and directory is read-only; the `.git` link stays writable for cleanup.
    for (const entry of ['committed.txt', 'notes/untracked.md', 'notes', '.']) {
      expect((await fs.stat(path.join(snapshot.path, entry))).mode & 0o222).toBe(0);
    }
    expect((await fs.stat(path.join(snapshot.path, '.git'))).mode & 0o200).not.toBe(0);
    await expect(fs.writeFile(path.join(snapshot.path, 'committed.txt'), 'overwrite')).rejects.toThrow();
    await expect(fs.writeFile(path.join(snapshot.path, 'new.txt'), 'create')).rejects.toThrow();
    // The live worktree is untouched.
    expect((await git(live, ['diff', '--cached', '--name-only'])).trim().split('\n').sort())
      .toEqual(['binary.bin', 'staged.txt']);
    expect(await registeredUnder(repository, path.join(root, 'snapshots'))).toEqual([snapshot.path]);
  }, 30_000);

  it('skips untracked files beyond the total cap', async () => {
    const { root, live } = await taskWorktree();
    const snapshots = new ReadOnlySnapshotService({
      root: path.join(root, 'snapshots'),
      maxFileBytes: 8192,
      maxTotalBytes: 4100
    });
    const snapshot = await snapshots.prepare(randomUUID(), randomUUID(), { worktreePath: live });
    // Files are admitted in path order: large.bin (4096 bytes) fits, the note no longer does.
    await fs.access(path.join(snapshot.path, 'large.bin'));
    expect(snapshot.omitted).toEqual([{ path: 'notes/untracked.md', reason: 'TOTAL_LIMIT_REACHED' }]);
  }, 30_000);

  it('reuses an unchanged snapshot, replaces a stale one and keeps one per task', async () => {
    const { root, repository, live } = await taskWorktree();
    const snapshotRoot = path.join(root, 'snapshots');
    const snapshots = new ReadOnlySnapshotService({ root: snapshotRoot });
    const taskId = randomUUID();
    const threadId = randomUUID();

    const first = await snapshots.prepare(taskId, threadId, { worktreePath: live });
    const again = await snapshots.prepare(taskId, threadId, { worktreePath: live });
    expect(again).toMatchObject({ reused: true, path: first.path, takenAt: first.takenAt });

    await fs.writeFile(path.join(live, 'unstaged.txt'), 'changed again\n');
    await fs.rm(path.join(live, 'notes'), { recursive: true });
    await git(live, ['commit', '-q', '-m', 'commit the staged work']);
    const replaced = await snapshots.prepare(taskId, threadId, { worktreePath: live });
    expect(replaced).toMatchObject({ reused: false, headSha: (await git(live, ['rev-parse', 'HEAD'])).trim() });
    expect(await fs.readFile(path.join(replaced.path, 'unstaged.txt'), 'utf8')).toBe('changed again\n');
    expect(await fs.readFile(path.join(replaced.path, 'staged.txt'), 'utf8')).toBe('staged change\n');
    await expect(fs.access(path.join(replaced.path, 'notes'))).rejects.toThrow();
    expect((await git(replaced.path, ['diff', '--cached', '--name-only'])).trim()).toBe('');
    for (const entry of ['unstaged.txt', 'staged.txt', '.']) {
      expect((await fs.stat(path.join(replaced.path, entry))).mode & 0o222).toBe(0);
    }
    expect(await registeredUnder(repository, snapshotRoot)).toEqual([first.path]);

    // Another thread of the same task replaces the task's snapshot.
    const otherThread = await snapshots.prepare(taskId, randomUUID(), { worktreePath: live });
    await expect(fs.access(first.path)).rejects.toThrow();
    expect(await registeredUnder(repository, snapshotRoot)).toEqual([otherThread.path]);

    // Removing another thread's snapshot is a no-op; removing the owner's leaves no registration.
    await snapshots.remove(taskId, threadId);
    await fs.access(otherThread.path);
    await snapshots.remove(taskId, otherThread.threadId);
    await snapshots.remove(taskId, otherThread.threadId);
    await expect(fs.access(path.join(snapshotRoot, taskId))).rejects.toThrow();
    expect(await registeredUnder(repository, snapshotRoot)).toEqual([]);
  }, 30_000);

  it('sweeps snapshots and registrations left by an earlier process', async () => {
    const { root, repository, live } = await taskWorktree();
    const snapshotRoot = path.join(root, 'snapshots');
    const earlier = new ReadOnlySnapshotService({ root: snapshotRoot });
    const kept = await earlier.prepare(randomUUID(), randomUUID(), { worktreePath: live });
    const vanished = await earlier.prepare(randomUUID(), randomUUID(), { worktreePath: live });
    // A temporary-file cleaner removed one snapshot directory but not its registration.
    await makeWritable(vanished.path);
    await fs.rm(vanished.path, { recursive: true, force: true });
    expect((await registeredUnder(repository, snapshotRoot)).sort()).toEqual([kept.path, vanished.path].sort());

    const restarted = new ReadOnlySnapshotService({ root: snapshotRoot });
    await restarted.sweep([repository]);

    await expect(fs.access(kept.path)).rejects.toThrow();
    expect(await fs.readdir(snapshotRoot)).toEqual([]);
    expect(await registeredUnder(repository, snapshotRoot)).toEqual([]);
    // The task's own worktree stays registered.
    expect((await listGitWorktrees(repository)).map((entry) => entry.path)).toContain(live);
  }, 30_000);
});
