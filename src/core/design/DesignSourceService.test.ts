import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Repository, WorktreeRecord } from '../../shared/contracts';
import { WorktreeService } from '../worktree/WorktreeService';
import {
  DESIGN_REPOSITORY_MARKER,
  DesignSourceService
} from './DesignSourceService';

const execFileAsync = promisify(execFile);

describe('DesignSourceService', () => {
  it('creates one private marker-owned repository for an idempotent creation token', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-source-'));
    const repositoryRoot = path.join(root, 'repositories');
    const worktreeRoot = path.join(root, 'worktrees');
    const service = new DesignSourceService({ repositoryRoot, worktreeRoot });

    const created = await service.prepareBlankRepository({
      creationToken: 'design-creation-0001'
    });
    const retried = await service.prepareBlankRepository({
      creationToken: 'design-creation-0001'
    });

    expect(retried).toMatchObject({
      id: created.id,
      path: created.path,
      headSha: created.headSha,
      branch: 'main'
    });
    expect(path.dirname(created.path)).toBe(repositoryRoot);
    expect((await fs.stat(created.path)).mode & 0o077).toBe(0);
    expect(
      JSON.parse(
        await fs.readFile(path.join(created.path, DESIGN_REPOSITORY_MARKER), 'utf8')
      )
    ).toMatchObject({
      repositoryId: created.id,
      creationToken: 'design-creation-0001',
      state: 'READY',
      initialCommitSha: created.headSha
    });
    expect((await git(created.path, ['remote'])).trim()).toBe('');
    expect(await git(created.path, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
      ''
    );
  }, 20_000);

  it('publishes exactly the captured tree, recovers it, repairs the index, and safely removes owned state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-candidate-'));
    const repositoryRoot = path.join(root, 'repositories');
    const worktreeRoot = path.join(root, 'worktrees');
    const source = new DesignSourceService({ repositoryRoot, worktreeRoot });
    const prepared = await source.prepareBlankRepository({
      creationToken: 'design-creation-0002'
    });
    const designId = randomUUID();
    const now = new Date().toISOString();
    const repository: Repository = {
      id: prepared.id,
      kind: 'DESIGN_MANAGED',
      name: prepared.name,
      path: prepared.path,
      status: 'AVAILABLE',
      headSha: prepared.headSha,
      branch: prepared.branch,
      remotes: [],
      createdAt: now,
      updatedAt: now,
      checkedAt: prepared.checkedAt
    };
    const record: WorktreeRecord = {
      id: randomUUID(),
      taskId: designId,
      iterationId: randomUUID(),
      repositoryId: repository.id,
      worktreePath: path.join(worktreeRoot, designId),
      branchName: `task-monki/design-${designId.slice(0, 8)}`,
      baseSha: prepared.headSha,
      status: 'CREATING',
      createdAt: now,
      updatedAt: now
    };
    const worktrees = new WorktreeService(worktreeRoot);
    const worktree = await worktrees.create(record, repository.path);
    const ownership = {
      designId,
      repository,
      worktree,
      turnId: randomUUID(),
      runId: randomUUID()
    };

    await expect(
      source.captureCandidate({ ...ownership, expectedParentCommit: prepared.headSha })
    ).resolves.toMatchObject({ kind: 'NO_CHANGE', commitSha: prepared.headSha });

    const firstBytes = '<!doctype html><title>Captured</title>\n';
    const laterBytes = '<!doctype html><title>Changed after capture</title>\n';
    await fs.writeFile(path.join(worktree.worktreePath, 'index.html'), firstBytes, 'utf8');
    const capture = await source.captureCandidate({
      ...ownership,
      expectedParentCommit: prepared.headSha
    });
    expect(capture.kind).toBe('CAPTURED');
    if (capture.kind !== 'CAPTURED') throw new Error('Expected a captured Design tree.');

    await fs.writeFile(path.join(worktree.worktreePath, 'index.html'), laterBytes, 'utf8');
    const candidateMessage = [
      'Task Monki Design candidate',
      '',
      `Design: ${ownership.designId}`,
      `Turn: ${ownership.turnId}`,
      `Run: ${ownership.runId}`,
      `Parent: ${capture.checkpoint.expectedParentCommit}`,
      `Tree: ${capture.checkpoint.treeSha}`
    ].join('\n');
    const danglingCandidate = (
      await git(
        repository.path,
        [
          'commit-tree',
          capture.checkpoint.treeSha,
          '-p',
          capture.checkpoint.expectedParentCommit,
          '-m',
          candidateMessage
        ],
        {
          GIT_AUTHOR_NAME: 'Task Monki',
          GIT_AUTHOR_EMAIL: 'task-monki@localhost',
          GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
          GIT_COMMITTER_NAME: 'Task Monki',
          GIT_COMMITTER_EMAIL: 'task-monki@localhost',
          GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z'
        }
      )
    ).trim();
    const preparedCandidate = await source.prepareCandidateCommit({
      ...ownership,
      checkpoint: capture.checkpoint
    });
    expect(
      (await git(repository.path, ['rev-parse', `refs/heads/${worktree.branchName}`])).trim()
    ).toBe(capture.checkpoint.expectedParentCommit);
    const published = await source.publishPreparedCandidateCommit({
      ...ownership,
      checkpoint: preparedCandidate
    });
    expect(published.candidateCommitSha).toBe(danglingCandidate);
    expect(
      await git(repository.path, ['show', `${published.candidateCommitSha}:index.html`])
    ).toBe(firstBytes);
    expect(await fs.readFile(path.join(worktree.worktreePath, 'index.html'), 'utf8')).toBe(
      laterBytes
    );

    await expect(
      source.recoverCandidate({ ...ownership, checkpoint: capture.checkpoint })
    ).resolves.toEqual({ state: 'CANDIDATE_REF', checkpoint: published });
    await source.repairCandidateIndex({ ...ownership, checkpoint: published });
    expect((await git(worktree.worktreePath, ['write-tree'])).trim()).toBe(
      capture.checkpoint.treeSha
    );
    expect(await git(worktree.worktreePath, ['status', '--porcelain=v1'])).toContain(
      'index.html'
    );

    await expect(worktrees.removeOwnedManaged(worktree, repository)).resolves.toMatchObject({
      status: 'REMOVED'
    });
    await source.removeManagedRepository(repository);
    await expect(fs.access(repository.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(source.removeManagedRepository(repository)).resolves.toBeUndefined();
    await expect(
      source.removeManagedRepository({ ...repository, kind: 'USER_REGISTERED' })
    ).rejects.toThrow('never removes a registered repository');
  }, 30_000);

  it('restores an exact earlier tree as a child of the current commit', async () => {
    const project = await createManagedProject('restore', 'design-restore-token');
    const filePath = path.join(project.worktree.worktreePath, 'index.html');
    await fs.writeFile(filePath, '<h1>First ready state</h1>\n', 'utf8');
    await fs.writeFile(
      path.join(project.worktree.worktreePath, '.gitignore'),
      'node_modules/\n',
      'utf8'
    );
    await commitAll(project.worktree.worktreePath, 'First ready state');
    const selectedCommitSha = (await git(project.worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();

    await fs.writeFile(filePath, '<h1>Current ready state</h1>\n', 'utf8');
    await commitAll(project.worktree.worktreePath, 'Current ready state');
    const currentCommitSha = (await git(project.worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await fs.writeFile(
      path.join(project.worktree.worktreePath, 'untracked.txt'),
      'remove during exact materialization',
      'utf8'
    );
    await fs.mkdir(path.join(project.worktree.worktreePath, 'node_modules'));
    await fs.writeFile(
      path.join(project.worktree.worktreePath, 'node_modules', 'stale.txt'),
      'ignored stale bytes',
      'utf8'
    );

    const ownership = {
      designId: project.designId,
      repository: project.repository,
      worktree: project.worktree,
      actionId: randomUUID(),
      sourceRevisionId: randomUUID()
    };
    const captured = await project.source.captureRestoreSource({
      ...ownership,
      selectedCommitSha
    });
    expect(captured.expectedParentCommit).toBe(currentCommitSha);
    const prepared = await project.source.prepareRestoreCommit({
      ...ownership,
      ...captured
    });

    expect(
      (await git(project.repository.path, ['rev-parse', `${prepared.targetCommitSha}^`])).trim()
    ).toBe(currentCommitSha);
    expect(
      (await git(project.repository.path, ['rev-parse', `${prepared.targetCommitSha}^{tree}`])).trim()
    ).toBe(
      (await git(project.repository.path, ['rev-parse', `${selectedCommitSha}^{tree}`])).trim()
    );

    await project.source.publishRestoreCommit({ ...ownership, ...prepared });
    await project.source.materializeRestoreCommit({
      ...ownership,
      targetCommitSha: prepared.targetCommitSha
    });

    expect(await fs.readFile(filePath, 'utf8')).toBe('<h1>First ready state</h1>\n');
    await expect(
      fs.access(path.join(project.worktree.worktreePath, 'untracked.txt'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.access(path.join(project.worktree.worktreePath, 'node_modules'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await git(project.worktree.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(
      prepared.targetCommitSha
    );
    expect(await git(project.worktree.worktreePath, ['status', '--porcelain=v1'])).toBe('');
  }, 30_000);

  it('removes only unreferenced, marker-owned repositories during reconciliation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-orphans-'));
    const repositoryRoot = path.join(root, 'repositories');
    const worktreeRoot = path.join(root, 'worktrees');
    const source = new DesignSourceService({ repositoryRoot, worktreeRoot });
    const retained = await source.prepareBlankRepository({
      creationToken: 'design-creation-0003'
    });
    const orphaned = await source.prepareBlankRepository({
      creationToken: 'design-creation-0004'
    });
    const unknownPath = path.join(repositoryRoot, 'unowned');
    await fs.mkdir(unknownPath);

    const result = await source.reconcileOrphanedRepositories([
      { id: retained.id, kind: 'DESIGN_MANAGED', path: retained.path }
    ]);

    expect(result.removedRepositoryIds).toEqual([orphaned.id]);
    expect(result.retainedPaths).toContain(unknownPath);
    await expect(fs.access(retained.path)).resolves.toBeUndefined();
    await expect(fs.access(orphaned.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(unknownPath)).resolves.toBeUndefined();
  }, 20_000);

  it('imports exact reference bytes at one safe editable project path', async () => {
    const project = await createManagedProject('asset', 'design-asset-import-token');
    const bytes = Buffer.from('editable asset bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const imported = await project.source.importProjectAsset({
      designId: project.designId,
      repository: project.repository,
      worktree: project.worktree,
      displayName: 'brand.txt',
      bytes,
      sha256
    });

    expect(imported).toMatchObject({
      relativePath: 'assets/brand.txt',
      sha256,
      created: true
    });
    expect(await fs.readFile(imported.absolutePath)).toEqual(bytes);
    await expect(
      project.source.importProjectAsset({
        designId: project.designId,
        repository: project.repository,
        worktree: project.worktree,
        displayName: 'brand.txt',
        bytes,
        sha256
      })
    ).resolves.toMatchObject({ relativePath: 'assets/brand.txt', created: false });
    await expect(
      project.source.importProjectAsset({
        designId: project.designId,
        repository: project.repository,
        worktree: project.worktree,
        displayName: '../escape.txt',
        bytes,
        sha256
      })
    ).rejects.toThrow('not safe');
    await expect(
      project.source.importProjectAsset({
        designId: project.designId,
        repository: project.repository,
        worktree: project.worktree,
        displayName: 'brand.txt',
        bytes: Buffer.from('different'),
        sha256: createHash('sha256').update('different').digest('hex')
      })
    ).rejects.toThrow('different project file');

    await expect(
      project.source.listProjectFiles({
        designId: project.designId,
        repository: project.repository,
        worktree: project.worktree
      })
    ).resolves.toEqual({
      files: [
        { path: 'assets/brand.txt', byteCount: bytes.byteLength },
        expect.objectContaining({ path: 'index.html' })
      ],
      truncated: false
    });

    await project.source.rollbackProjectAsset(imported);
    await expect(fs.access(imported.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it.runIf(process.platform !== 'win32')(
    'rejects a symbolic-link asset directory and an ignored destination',
    async () => {
      const project = await createManagedProject('asset-security', 'design-asset-security-token');
      const bytes = Buffer.from('protected bytes');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const outside = path.join(project.root, 'outside');
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(project.worktree.worktreePath, 'assets'));

      await expect(
        project.source.importProjectAsset({
          designId: project.designId,
          repository: project.repository,
          worktree: project.worktree,
          displayName: 'escape.txt',
          bytes,
          sha256
        })
      ).rejects.toThrow('not a safe directory');
      await expect(fs.access(path.join(outside, 'escape.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      });

      await fs.unlink(path.join(project.worktree.worktreePath, 'assets'));
      await fs.writeFile(
        path.join(project.worktree.worktreePath, '.gitignore'),
        'assets/\n',
        'utf8'
      );
      await expect(
        project.source.importProjectAsset({
          designId: project.designId,
          repository: project.repository,
          worktree: project.worktree,
          displayName: 'ignored.txt',
          bytes,
          sha256
        })
      ).rejects.toThrow('Git cannot preserve it');
      await expect(
        fs.access(path.join(project.worktree.worktreePath, 'assets', 'ignored.txt'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    20_000
  );
});

async function createManagedProject(prefix: string, creationToken: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-design-${prefix}-`));
  const repositoryRoot = path.join(root, 'repositories');
  const worktreeRoot = path.join(root, 'worktrees');
  const source = new DesignSourceService({ repositoryRoot, worktreeRoot });
  const prepared = await source.prepareBlankRepository({ creationToken });
  const designId = randomUUID();
  const now = new Date().toISOString();
  const repository: Repository = {
    id: prepared.id,
    kind: 'DESIGN_MANAGED',
    name: prepared.name,
    path: prepared.path,
    status: 'AVAILABLE',
    headSha: prepared.headSha,
    branch: prepared.branch,
    remotes: [],
    createdAt: now,
    updatedAt: now,
    checkedAt: prepared.checkedAt
  };
  const requestedWorktree: WorktreeRecord = {
    id: randomUUID(),
    taskId: designId,
    iterationId: randomUUID(),
    repositoryId: repository.id,
    worktreePath: path.join(worktreeRoot, designId),
    branchName: `task-monki/design-${designId.slice(0, 8)}`,
    baseSha: prepared.headSha,
    status: 'CREATING',
    createdAt: now,
    updatedAt: now
  };
  const worktree = await new WorktreeService(worktreeRoot).create(
    requestedWorktree,
    repository.path
  );
  return { root, source, designId, repository, worktree };
}

async function git(
  cwd: string,
  argv: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await execFileAsync('git', argv, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env
  });
  return stdout;
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '--all']);
  await git(
    cwd,
    ['commit', '-m', message],
    {
      GIT_AUTHOR_NAME: 'Task Monki',
      GIT_AUTHOR_EMAIL: 'task-monki@localhost',
      GIT_COMMITTER_NAME: 'Task Monki',
      GIT_COMMITTER_EMAIL: 'task-monki@localhost'
    }
  );
}
