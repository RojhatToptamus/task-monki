import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from './gitCli';
import {
  resolveReviewGitExecutablePath,
  resolveReviewGitMetadata
} from './ReviewGitMetadata';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('resolveReviewGitMetadata', () => {
  it('resolves a concrete executable and bypasses the macOS xcrun shim', async () => {
    const executable = await resolveReviewGitExecutablePath();

    expect(path.isAbsolute(executable)).toBe(true);
    await expect(fs.access(executable)).resolves.toBeUndefined();
    if (process.platform === 'darwin') {
      expect(executable).not.toBe('/usr/bin/git');
    }
  });

  it('resolves a linked worktree common directory outside a path containing spaces', async () => {
    const fixture = await createLinkedFixture('task monki review metadata ');

    const metadata = await resolveReviewGitMetadata({
      repositoryPath: fixture.repository,
      worktreePath: fixture.worktree
    });

    expect(metadata.repositoryRoot).toBe(await fs.realpath(fixture.repository));
    expect(metadata.worktreeRoot).toBe(await fs.realpath(fixture.worktree));
    expect(metadata.gitCommonDir).toBe(
      await fs.realpath(path.join(fixture.repository, '.git'))
    );
    expect(metadata.gitDir).toMatch(
      new RegExp(
        `${escapeRegExp(path.join(fixture.repository, '.git', 'worktrees'))}${escapeRegExp(path.sep)}`
      )
    );
  });

  it('accepts a canonical relative .git pointer for a linked worktree', async () => {
    const fixture = await createLinkedFixture('task-monki-relative-git-pointer-');
    const gitEntry = path.join(fixture.worktree, '.git');
    const absoluteGitDir = (await fs.readFile(gitEntry, 'utf8'))
      .trim()
      .slice('gitdir: '.length);
    const relativeGitDir = path.relative(
      await fs.realpath(fixture.worktree),
      await fs.realpath(absoluteGitDir)
    );
    await fs.writeFile(gitEntry, `gitdir: ${relativeGitDir}\n`, 'utf8');

    const metadata = await resolveReviewGitMetadata({
      repositoryPath: fixture.repository,
      worktreePath: fixture.worktree
    });

    expect(metadata.gitDir).toBe(await fs.realpath(absoluteGitDir));
    expect(metadata.gitCommonDir).toBe(
      await fs.realpath(path.join(fixture.repository, '.git'))
    );
  });

  it('resolves a normal repository without a linked-worktree pointer', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-normal-review-repo-')
    );
    fixtureRoots.push(root);
    const repository = path.join(root, 'repository');
    await initRepository(repository);

    await expect(
      resolveReviewGitMetadata({
        repositoryPath: repository,
        worktreePath: repository
      })
    ).resolves.toEqual({
      repositoryRoot: await fs.realpath(repository),
      worktreeRoot: await fs.realpath(repository),
      gitDir: await fs.realpath(path.join(repository, '.git')),
      gitCommonDir: await fs.realpath(path.join(repository, '.git'))
    });
  });

  it('ignores an unrelated stale registered worktree', async () => {
    const fixture = await createLinkedFixture(
      'task-monki-stale-review-worktree-'
    );
    const staleWorktree = path.join(path.dirname(fixture.worktree), 'stale worktree');
    await git(fixture.repository, [
      'worktree',
      'add',
      '-b',
      'stale-review-branch',
      staleWorktree,
      'HEAD'
    ]);
    await fs.rm(staleWorktree, { recursive: true, force: true });

    await expect(
      resolveReviewGitMetadata({
        repositoryPath: fixture.repository,
        worktreePath: fixture.worktree
      })
    ).resolves.toMatchObject({
      worktreeRoot: await fs.realpath(fixture.worktree),
      gitCommonDir: await fs.realpath(path.join(fixture.repository, '.git'))
    });
  });

  it('fails clearly when Git metadata is missing', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-missing-review-git-')
    );
    fixtureRoots.push(root);
    const repository = path.join(root, 'repository');
    await fs.mkdir(repository);

    await expect(
      resolveReviewGitMetadata({
        repositoryPath: repository,
        worktreePath: repository
      })
    ).rejects.toThrow('Cannot resolve trusted Git metadata for agent review');
  });

  it('rejects a worktree that belongs to a different repository', async () => {
    const first = await createLinkedFixture('task-monki-review-first-');
    const second = await createLinkedFixture('task-monki-review-second-');

    await expect(
      resolveReviewGitMetadata({
        repositoryPath: first.repository,
        worktreePath: second.worktree
      })
    ).rejects.toThrow('does not use the selected repository common Git directory');
  });

  it('rejects a symlinked .git entry', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-symlink-review-git-')
    );
    fixtureRoots.push(root);
    const repository = path.join(root, 'repository');
    await initRepository(repository);
    const gitDirectory = path.join(repository, '.git-data');
    await fs.rename(path.join(repository, '.git'), gitDirectory);
    await fs.symlink(
      gitDirectory,
      path.join(repository, '.git'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    await expect(
      resolveReviewGitMetadata({
        repositoryPath: repository,
        worktreePath: repository
      })
    ).rejects.toThrow('.git entry must not be a symbolic link');
  });
});

async function createLinkedFixture(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureRoots.push(root);
  const repository = path.join(root, 'main repository');
  const worktree = path.join(root, 'review worktree');
  await initRepository(repository);
  await git(repository, [
    'worktree',
    'add',
    '-b',
    'review-branch',
    worktree,
    'HEAD'
  ]);
  return { repository, worktree };
}

async function initRepository(repository: string): Promise<void> {
  await fs.mkdir(repository, { recursive: true });
  await git(repository, ['init']);
  await git(repository, ['config', 'user.email', 'review@example.invalid']);
  await git(repository, ['config', 'user.name', 'Review Fixture']);
  await fs.writeFile(
    path.join(repository, 'app.ts'),
    'export const value = 1;\n',
    'utf8'
  );
  await git(repository, ['add', 'app.ts']);
  await git(repository, ['commit', '-m', 'Initial commit']);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
