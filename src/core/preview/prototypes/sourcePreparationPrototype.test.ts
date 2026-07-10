import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../../git/gitCli';
import {
  capturePrototypeSourceManifest,
  preparePrototypeSource
} from './sourcePreparationPrototype';

describe('Phase 0 source preparation prototype', () => {
  it('refuses a destination equal to or inside the repository before deleting anything', async () => {
    const fixture = await createRepositoryFixture();
    const trackedBefore = await fs.readFile(path.join(fixture.repo, 'tracked.txt'), 'utf8');
    expect(
      await fs.realpath((await git(fixture.repo, ['rev-parse', '--show-toplevel'])).trim())
    ).toBe(await fs.realpath(fixture.repo));

    await expect(preparePrototypeSource(fixture.repo, fixture.repo)).rejects.toThrow(
      'Prototype destination must be outside the repository'
    );
    await expect(
      preparePrototypeSource(fixture.repo, path.join(fixture.repo, '.preview-runtime'))
    ).rejects.toThrow('Prototype destination must be outside the repository');
    await expect(fs.readFile(path.join(fixture.repo, 'tracked.txt'), 'utf8')).resolves.toBe(
      trackedBefore
    );
  });

  it('captures committed, staged, unstaged, deleted, untracked, and internal symlink state while excluding ignored files', async () => {
    const fixture = await createRepositoryFixture();
    await fs.writeFile(path.join(fixture.repo, 'tracked.txt'), 'unstaged\n');
    await fs.writeFile(path.join(fixture.repo, 'staged.txt'), 'staged\n');
    await git(fixture.repo, ['add', 'staged.txt']);
    await fs.rm(path.join(fixture.repo, 'deleted.txt'));
    await fs.writeFile(path.join(fixture.repo, 'untracked.txt'), 'untracked\n');
    await fs.writeFile(path.join(fixture.repo, 'ignored.secret'), 'do-not-copy\n');
    await fs.symlink('tracked.txt', path.join(fixture.repo, 'tracked-link'));
    await git(fixture.repo, ['add', 'tracked-link']);

    const manifest = await preparePrototypeSource(fixture.repo, fixture.destination);
    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));

    await expect(fs.readFile(path.join(fixture.destination, 'tracked.txt'), 'utf8')).resolves.toBe('unstaged\n');
    await expect(fs.readFile(path.join(fixture.destination, 'staged.txt'), 'utf8')).resolves.toBe('staged\n');
    await expect(fs.readFile(path.join(fixture.destination, 'untracked.txt'), 'utf8')).resolves.toBe('untracked\n');
    await expect(fs.readFile(path.join(fixture.destination, 'ignored.secret'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readlink(path.join(fixture.destination, 'tracked-link'))).resolves.toBe('tracked.txt');
    expect(byPath.get('deleted.txt')?.kind).toBe('deleted');
    expect(byPath.has('ignored.secret')).toBe(false);
  });

  it('detects a concurrent source mutation and removes the incomplete destination', async () => {
    const fixture = await createRepositoryFixture();
    let mutated = false;

    await expect(
      preparePrototypeSource(fixture.repo, fixture.destination, {
        async afterEntryCopied(relativePath) {
          if (!mutated && relativePath === '.gitignore') {
            mutated = true;
            await fs.writeFile(path.join(fixture.repo, 'tracked.txt'), 'changed-during-copy\n');
          }
        }
      })
    ).rejects.toThrow('Source changed while');
    await expect(fs.access(fixture.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects symlinks that escape the repository or target excluded content', async () => {
    const fixture = await createRepositoryFixture();
    await fs.symlink('../outside.txt', path.join(fixture.repo, 'escape-link'));
    await git(fixture.repo, ['add', 'escape-link']);

    await expect(capturePrototypeSourceManifest(fixture.repo)).rejects.toThrow('Path escapes source root');

    await fs.rm(path.join(fixture.repo, 'escape-link'));
    await git(fixture.repo, ['add', '-u']);
    await fs.symlink('ignored.secret', path.join(fixture.repo, 'ignored-link'));
    await git(fixture.repo, ['add', 'ignored-link']);
    await expect(capturePrototypeSourceManifest(fixture.repo)).rejects.toThrow(
      'Symlink target must be included in the source manifest'
    );
  });

  it('rejects unresolved Git LFS pointers', async () => {
    const fixture = await createRepositoryFixture();
    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${'a'.repeat(64)}`,
      'size 1234',
      ''
    ].join('\n');
    await fs.writeFile(path.join(fixture.repo, 'asset.bin'), pointer);
    await git(fixture.repo, ['add', 'asset.bin']);

    await expect(capturePrototypeSourceManifest(fixture.repo)).rejects.toThrow(
      'Git LFS content is not materialized'
    );
  });

  it('rejects a Git submodule entry instead of copying an ambiguous directory', async () => {
    const fixture = await createRepositoryFixture();
    await git(fixture.repo, [
      'update-index',
      '--add',
      '--cacheinfo',
      '160000',
      '0000000000000000000000000000000000000001',
      'vendor/submodule'
    ]);

    await expect(capturePrototypeSourceManifest(fixture.repo)).rejects.toThrow(
      'Git submodules are not supported'
    );
  });

  it('captures this repository-sized source corpus within a diagnostic budget', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-preview-corpus-'));
    const started = performance.now();
    const manifest = await preparePrototypeSource(
      process.cwd(),
      path.join(root, 'prepared')
    );
    const elapsedMs = performance.now() - started;

    expect(manifest.entries.length).toBeGreaterThan(100);
    expect(elapsedMs).toBeLessThan(30_000);
    console.info(
      `[phase0:source] prepared ${manifest.entries.length} entries in ${elapsedMs.toFixed(1)}ms`
    );
  }, 40_000);
});

async function createRepositoryFixture(): Promise<{ root: string; repo: string; destination: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-preview-source-'));
  const repo = path.join(root, 'repo');
  const destination = path.join(root, 'prepared');
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Task Monki Test']);
  await fs.writeFile(path.join(repo, '.gitignore'), '*.secret\n');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'tracked\n');
  await fs.writeFile(path.join(repo, 'staged.txt'), 'original\n');
  await fs.writeFile(path.join(repo, 'deleted.txt'), 'delete me\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Initial fixture']);
  return { root, repo, destination };
}
