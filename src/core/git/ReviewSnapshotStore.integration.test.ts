import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from './gitCli';
import { ReviewSnapshotStore } from './ReviewSnapshotStore';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-review-snapshots-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '--quiet', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, '.gitignore'), 'build/\n');
  await fs.writeFile(path.join(repo, 'app.js'), 'export const a = 1;\nexport const b = 2;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '--quiet', '-m', 'base']);
  return { repo, store: new ReviewSnapshotStore(path.join(root, 'profile', 'review-snapshots')) };
}

const write = (repo: string, file: string, text: string) => fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true })
  .then(() => fs.writeFile(path.join(repo, file), text));

describe('ReviewSnapshotStore', () => {
  it('keeps the exact code a review read and shows only what changed since, without touching the repository', async () => {
    const { repo, store } = await repository();
    await write(repo, 'app.js', 'export const a = 10;\nexport const b = 2;\n');
    await write(repo, 'staged.js', 'staged\n');
    await git(repo, ['add', 'staged.js']);
    await write(repo, 'notes.md', 'untracked\n');
    await write(repo, 'build/out.js', 'ignored\n');
    const statusBefore = await git(repo, ['status', '--porcelain=v1']);
    const objectsBefore = await git(repo, ['count-objects', '-v']);

    const tree = await store.capture(repo);
    await store.pin(repo, 'task-1', 'review-1', tree);

    // The repository is as it was: no refs, objects, or index changes of the store's.
    expect(await git(repo, ['status', '--porcelain=v1'])).toBe(statusBefore);
    expect(await git(repo, ['count-objects', '-v'])).toBe(objectsBefore);
    expect(await git(repo, ['for-each-ref', 'refs/tasks/'])).toBe('');

    // Nothing changed since the review yet.
    expect(await store.changesSince(repo, 'task-1', 'review-1', tree)).toEqual({ status: 'READY', reviewRunId: 'review-1', tree, diff: '' });

    await write(repo, 'app.js', 'export const a = 10;\nexport const b = 20;\n');
    await write(repo, 'notes.md', 'untracked, edited\n');
    await write(repo, 'added.js', 'new since the review\n');
    await write(repo, 'build/out.js', 'ignored, edited\n');
    const changes = await store.changesSince(repo, 'task-1', 'review-1', tree);
    expect(changes.status).toBe('READY');
    const diff = changes.status === 'READY' ? changes.diff : '';
    expect(diff).toContain('-export const b = 2;\n+export const b = 20;');
    // The edit the review already read is not shown again.
    expect(diff).not.toContain('+export const a = 10;');
    expect(diff).toContain('+untracked, edited');
    expect(diff).toContain('diff --git a/added.js b/added.js');
    expect(diff).not.toContain('build/out.js');
    expect(diff).not.toContain('staged.js');
  });

  it('never shows another tree as a review\'s, and lets a deleted task\'s reviews go', async () => {
    const { repo, store } = await repository();
    const tree = await store.capture(repo);
    await store.pin(repo, 'task-1', 'review-1', tree);

    expect(await store.changesSince(repo, 'task-1', 'review-2')).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_RECORDED' });
    expect(await store.changesSince(repo, 'task-1', 'review-1', '0'.repeat(40))).toEqual({ status: 'UNAVAILABLE', reason: 'UNREADABLE' });

    await store.removeTask(repo, 'task-1');
    expect(await store.changesSince(repo, 'task-1', 'review-1')).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_RECORDED' });
  });
});
