import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseReviewedDiff } from '../review/ReviewedDiff';
import { git } from './gitCli';
import { isTaskCommit, listTaskCommits, readTaskCommitDiff } from './TaskCommits';
import { boundedTreeDiff } from './treeDiff';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-task-commits-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '--quiet', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Ana Test']);
  await fs.writeFile(path.join(repo, 'app.js'), 'export const a = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '--quiet', '-m', 'base']);
  return repo;
}

async function commit(repo: string, file: string, text: string, message: string): Promise<string> {
  await fs.writeFile(path.join(repo, file), text);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '--quiet', '-m', message]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

describe('task commits', () => {
  it("lists the branch's own commits oldest first, a merge of the base branch as one commit, and reads each commit's own change", async () => {
    const repo = await repository();
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['switch', '--quiet', '-c', 'feature']);
    const first = await commit(repo, 'app.js', 'export const a = 2;\n', 'Raise a\n\nThe old value overflowed.');
    // The base branch moves on and is merged in: its own commit is not the branch's.
    await git(repo, ['switch', '--quiet', 'main']);
    await commit(repo, 'main.md', 'main\n', 'Document main');
    await git(repo, ['switch', '--quiet', 'feature']);
    await git(repo, ['merge', '--quiet', '--no-edit', 'main']);
    const merge = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const last = await commit(repo, 'retry.js', 'export const retry = 3;\n', 'Add retry');

    const { commits, total } = await listTaskCommits(repo, base, last);
    expect(total).toBe(3);
    expect(commits.map(({ sha, subject }) => [sha, subject])).toEqual([[first, 'Raise a'], [merge, "Merge branch 'main' into feature"], [last, 'Add retry']]);
    expect(commits[0]).toMatchObject({ body: 'The old value overflowed.', author: 'Ana Test' });
    expect(commits[2]!.body).toBeUndefined();
    expect(Number.isNaN(Date.parse(commits[0]!.authoredAt))).toBe(false);

    const own = await readTaskCommitDiff(repo, first);
    expect(own.status).toBe('READY');
    const files = own.status === 'READY' ? parseReviewedDiff(own.diff) : [];
    expect(files.map(({ path: file, additions, deletions }) => [file, additions, deletions])).toEqual([['app.js', 1, 1]]);
  });

  it('keeps the latest commits past the limit and counts every one', async () => {
    const repo = await repository();
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    for (const value of [1, 2, 3]) await commit(repo, 'app.js', `export const a = ${value + 1};\n`, `Step ${value}`);
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    const { commits, total } = await listTaskCommits(repo, base, head, 2);
    expect(total).toBe(3);
    expect(commits.map((entry) => entry.subject)).toEqual(['Step 2', 'Step 3']);
  });

  it('reads only the branch\'s own commits, and never hands git anything but object ids', async () => {
    const repo = await repository();
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['switch', '--quiet', '-c', 'other']);
    const foreign = await commit(repo, 'app.js', 'export const a = 9;\n', 'Elsewhere');
    await git(repo, ['switch', '--quiet', 'main']);
    const own = await commit(repo, 'app.js', 'export const a = 2;\n', 'Raise a');

    expect(await isTaskCommit(repo, base, own, own)).toBe(true);
    expect(await isTaskCommit(repo, base, own, foreign)).toBe(false);
    // Git reads options among revisions: an option-shaped value is refused before git sees it.
    const target = path.join(path.dirname(repo), 'written-by-git');
    expect(await isTaskCommit(repo, base, own, `--output=${target}`)).toBe(false);
    expect(await boundedTreeDiff(repo, `--output=${target}`, own)).toEqual({ reason: 'UNREADABLE' });
    expect(await readTaskCommitDiff(repo, `--output=${target}`)).toEqual({ status: 'UNAVAILABLE', reason: 'UNREADABLE' });
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('lists signed commits when the person\'s git shows signatures in its log', async () => {
    const repo = await repository();
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const key = path.join(path.dirname(repo), 'signing-key');
    await promisify(execFile)('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    await git(repo, ['config', 'gpg.format', 'ssh']);
    await git(repo, ['config', 'user.signingkey', key]);
    await git(repo, ['config', 'log.showSignature', 'true']);
    await fs.writeFile(path.join(repo, 'app.js'), 'export const a = 2;\n');
    await git(repo, ['commit', '--quiet', '-S', '-am', 'Signed']);
    const head = await commit(repo, 'app.js', 'export const a = 3;\n', 'Unsigned');

    const { commits, total } = await listTaskCommits(repo, base, head);
    expect(total).toBe(2);
    expect(commits.map((entry) => entry.subject)).toEqual(['Signed', 'Unsigned']);
  });

  it('compares a commit without a parent against the empty tree', async () => {
    const repo = await repository();
    const root = (await git(repo, ['rev-list', '--max-parents=0', 'HEAD'])).trim();
    const read = await readTaskCommitDiff(repo, root);
    expect(read.status === 'READY' && parseReviewedDiff(read.diff).map((file) => [file.path, file.status])).toEqual([['app.js', 'added']]);
  });
});
