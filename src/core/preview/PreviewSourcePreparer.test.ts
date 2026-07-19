import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git/gitCli';
import {
  capturePreviewSourceManifest,
  PreviewSourcePreparer,
  serializePreviewSourceManifest
} from './PreviewSourcePreparer';

const fixtureRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('PreviewSourcePreparer', () => {
  it('captures dirty Git states outside the worktree and excludes ignored files', async () => {
    const fixture = await createRepositoryFixture();
    await fs.writeFile(path.join(fixture.repo, 'tracked.txt'), 'unstaged\n');
    await fs.writeFile(path.join(fixture.repo, 'staged.txt'), 'staged\n');
    await git(fixture.repo, ['add', 'staged.txt']);
    await fs.rm(path.join(fixture.repo, 'deleted.txt'));
    await fs.writeFile(path.join(fixture.repo, 'untracked.txt'), 'untracked\n');
    await fs.writeFile(path.join(fixture.repo, 'ignored.secret'), 'do-not-copy\n');
    await fs.symlink('tracked.txt', path.join(fixture.repo, 'tracked-link'));
    await git(fixture.repo, ['add', 'tracked-link']);
    const head = (await git(fixture.repo, ['rev-parse', 'HEAD'])).trim();

    const prepared = await fixture.preparer.prepare({
      repositoryPath: fixture.repo,
      taskId: 'task-1',
      generationId: 'generation-1',
      expectedHeadSha: head
    });
    const byPath = new Map(prepared.manifest.entries.map((entry) => [entry.path, entry]));

    await expect(fs.readFile(path.join(prepared.sourcePath, 'tracked.txt'), 'utf8')).resolves.toBe(
      'unstaged\n'
    );
    await expect(fs.readFile(path.join(prepared.sourcePath, 'untracked.txt'), 'utf8')).resolves.toBe(
      'untracked\n'
    );
    await expect(fs.access(path.join(prepared.sourcePath, 'ignored.secret'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(byPath.get('deleted.txt')?.kind).toBe('deleted');
    expect(byPath.has('ignored.secret')).toBe(false);
    expect(prepared.generationRoot.startsWith(fixture.repo)).toBe(false);
  });

  it('detects concurrent mutation and deletes only its marker-owned incomplete workspace', async () => {
    const fixture = await createRepositoryFixture();
    const head = (await git(fixture.repo, ['rev-parse', 'HEAD'])).trim();
    let mutated = false;
    await expect(
      fixture.preparer.prepare({
        repositoryPath: fixture.repo,
        taskId: 'task-1',
        generationId: 'generation-2',
        expectedHeadSha: head,
        async afterEntryCopied(relativePath) {
          if (!mutated && relativePath === '.gitignore') {
            mutated = true;
            await fs.writeFile(path.join(fixture.repo, 'tracked.txt'), 'changed-during-copy\n');
          }
        }
      })
    ).rejects.toThrow('Source changed while');
    await expect(
      fs.access(path.join(fixture.previewRoot, 'task-1', 'generation-2'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(fixture.repo, 'tracked.txt'), 'utf8')).resolves.toBe(
      'changed-during-copy\n'
    );
  });

  it('refuses pre-existing or marker-mismatched paths instead of deleting by name', async () => {
    const fixture = await createRepositoryFixture();
    const collision = path.join(fixture.previewRoot, 'task-1', 'generation-3');
    await fs.mkdir(collision, { recursive: true });
    await fs.writeFile(path.join(collision, 'user-data.txt'), 'keep');
    const head = (await git(fixture.repo, ['rev-parse', 'HEAD'])).trim();
    await expect(
      fixture.preparer.prepare({
        repositoryPath: fixture.repo,
        taskId: 'task-1',
        generationId: 'generation-3',
        expectedHeadSha: head
      })
    ).rejects.toThrow('already exists');
    await expect(
      fixture.preparer.cleanupOwnedGeneration({ taskId: 'task-1', generationId: 'generation-3' })
    ).rejects.toThrow();
    await expect(fs.readFile(path.join(collision, 'user-data.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('rejects external/excluded symlinks, submodules, and unresolved LFS pointers', async () => {
    const fixture = await createRepositoryFixture();
    await fs.symlink('../outside.txt', path.join(fixture.repo, 'escape-link'));
    await git(fixture.repo, ['add', 'escape-link']);
    await expect(capturePreviewSourceManifest(fixture.repo)).rejects.toThrow('escapes');

    await fs.rm(path.join(fixture.repo, 'escape-link'));
    await git(fixture.repo, ['add', '-u']);
    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${'a'.repeat(64)}`,
      'size 1234',
      ''
    ].join('\n');
    await fs.writeFile(path.join(fixture.repo, 'asset.bin'), pointer);
    await git(fixture.repo, ['add', 'asset.bin']);
    await expect(capturePreviewSourceManifest(fixture.repo)).rejects.toThrow('not materialized');

    await fs.rm(path.join(fixture.repo, 'asset.bin'));
    await git(fixture.repo, ['add', '-u']);
    await git(fixture.repo, [
      'update-index',
      '--add',
      '--cacheinfo',
      '160000',
      '0000000000000000000000000000000000000001',
      'vendor/submodule'
    ]);
    await expect(capturePreviewSourceManifest(fixture.repo)).rejects.toThrow('submodules');
  });

  it('enforces injectable entry, source-byte, and manifest-byte production bounds', async () => {
    const fixture = await createRepositoryFixture();
    const base = {
      maxEntries: 100,
      maxPathBytes: 4_096,
      maxTotalSourceBytes: 1_000_000,
      maxManifestBytes: 1_000_000
    };
    await expect(
      capturePreviewSourceManifest(fixture.repo, { ...base, maxEntries: 1 })
    ).rejects.toThrow('entry limit');
    await expect(
      capturePreviewSourceManifest(fixture.repo, { ...base, maxPathBytes: 1 })
    ).rejects.toThrow('path exceeds');
    await expect(
      capturePreviewSourceManifest(fixture.repo, { ...base, maxTotalSourceBytes: 1 })
    ).rejects.toThrow('aggregate limit');
    const manifest = await capturePreviewSourceManifest(fixture.repo, base);
    expect(() => serializePreviewSourceManifest(manifest, 10)).toThrow('manifest exceeds');
    expect(serializePreviewSourceManifest(manifest)).not.toContain('\n  ');
  });
});

async function createRepositoryFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-preview-source-'));
  fixtureRoots.push(root);
  const repo = path.join(root, 'repo');
  const previewRoot = path.join(root, 'preview-runtime');
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
  return {
    root,
    repo,
    previewRoot,
    preparer: new PreviewSourcePreparer(previewRoot, 'store-test')
  };
}
