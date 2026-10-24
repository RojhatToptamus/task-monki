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

  it('captures an edit made within the second the index was written, which cached file stats would hide', async () => {
    const { repo, store } = await repository();
    const second = async (file: string) => Math.floor((await fs.stat(file)).mtimeMs / 1000);
    const cachedSecond = async () => Number(/mtime: (\d+):/.exec(await git(repo, ['ls-files', '--debug', 'total.js']))?.[1]);
    // A same-length edit in the very second Git cached the file and wrote the index: its stats
    // match the cached ones, so Git reads it again only while the index keeps its own time.
    let racy = false;
    for (let attempt = 0; attempt < 10 && !racy; attempt += 1) {
      await write(repo, 'total.js', 'total $40.00\n');
      await git(repo, ['add', 'total.js']);
      await git(repo, ['commit', '--quiet', '-m', `total ${attempt}`]);
      await write(repo, 'total.js', 'total $45.00\n');
      const cached = await cachedSecond();
      racy = cached === (await second(path.join(repo, '.git', 'index'))) && cached === (await second(path.join(repo, 'total.js')));
    }
    expect(racy).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const { treeId } = await store.captureTree(repo, 'refs/tasks/task-1/bug-replay/probe');

    expect(treeId).not.toBe((await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim());
    expect(await store.readText(repo, treeId, 'total.js')).toBe('total $45.00\n');
  });

  it('runs no repository hook, even one the checkout itself carries, while capturing', async () => {
    const { repo, store } = await repository();
    const marker = path.join(path.dirname(repo), 'hook-ran');
    await git(repo, ['config', 'core.hooksPath', '.githooks']);
    await write(repo, '.githooks/post-index-change', `#!/bin/sh\necho ran >> '${marker}'\n`);
    await fs.chmod(path.join(repo, '.githooks', 'post-index-change'), 0o755);
    await write(repo, 'app.js', 'changed\n');
    const tree = await store.capture(repo);
    await store.pin(repo, 'task-1', 'review-1', tree);
    await write(repo, 'app.js', 'changed again\n');
    expect((await store.changesSince(repo, 'task-1', 'review-1', tree)).status).toBe('READY');
    await expect(fs.access(marker)).rejects.toThrow();
    // Control: an ordinary index write in the checkout runs it.
    await git(repo, ['add', 'app.js']);
    await expect(fs.access(marker)).resolves.toBeUndefined();
  });

  it('indexes the change a review read from its base, renames and deletions included, and reads it back as one diff', async () => {
    const { repo, store } = await repository();
    await write(repo, 'src/old-name.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    await write(repo, 'src/gone.ts', 'gone 1\ngone 2\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '--quiet', '-m', 'more']);
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
    await write(repo, 'src/new-name.ts', 'one\ntwo\nthree\nfour\nFIVE\nsix\n');
    await git(repo, ['rm', '--quiet', 'src/gone.ts']);
    await write(repo, 'app.js', 'export const a = 10;\nexport const b = 2;\n');
    await write(repo, 'notes.md', 'untracked\n');
    const tree = await store.capture(repo);
    await store.pin(repo, 'task-1', 'review-1', tree);

    const index = await store.changeIndex(repo, base, tree);
    if (index.status !== 'READY') throw new Error(`Expected the change index, got ${index.reason}.`);
    expect(index.files.map(({ hunks, ...file }) => ({
      ...file,
      head: hunks.map((hunk) => [hunk.newStart, hunk.newCount]),
      base: hunks.map((hunk) => [hunk.oldStart, hunk.oldCount])
    })).sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { path: 'app.js', status: 'modified', additions: 1, deletions: 1, head: [[1, 2]], base: [[1, 2]] },
      { path: 'notes.md', status: 'added', additions: 1, deletions: 0, head: [[1, 1]], base: [[0, 0]] },
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 2, head: [[0, 0]], base: [[1, 2]] },
      { path: 'src/new-name.ts', status: 'renamed', oldPath: 'src/old-name.ts', additions: 1, deletions: 1, head: [[2, 5]], base: [[2, 5]] }
    ]);
    // The prompt's form: a deleted file's hunks at the base, a renamed one's source.
    expect(index.text.split('\n').sort()).toEqual([
      'app.js modified +1 -1 head 1-2',
      'notes.md new +1 -0 head 1',
      'src/gone.ts deleted +0 -2 base 1-2',
      'src/new-name.ts renamed from src/old-name.ts +1 -1 head 2-6'
    ]);

    // The Guide reads the same change, whatever the worktree holds since.
    await write(repo, 'app.js', 'edited after the review\n');
    const reviewed = await store.reviewedDiff(repo, 'task-1', 'review-1', base, tree);
    expect(reviewed).toMatchObject({ status: 'READY', reviewRunId: 'review-1', tree });
    const diff = reviewed.status === 'READY' ? reviewed.diff : '';
    expect(diff).toContain('rename from src/old-name.ts');
    expect(diff).toContain('+export const a = 10;');
    expect(diff).not.toContain('edited after the review');
    expect(await store.reviewedDiff(repo, 'task-1', 'review-2', base)).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_RECORDED' });
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
