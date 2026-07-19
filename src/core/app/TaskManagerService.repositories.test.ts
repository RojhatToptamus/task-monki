import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

const exec = promisify(execFile);

describe('TaskManagerService repository lifecycle', () => {
  it('disconnects without deleting task, worktree, or repository evidence', async () => {
    const harness = await createHarness('disconnect');
    const repository = await harness.service.addRepository(harness.repositoryPath);
    const task = await harness.service.createTask({
      title: 'Preserve repository work',
      prompt: 'Create an isolated worktree.',
      repositoryId: repository.id
    });
    const worktree = await harness.service.prepareWorktree({ taskId: task.id });

    await expect(harness.service.getRepositoryImpact(repository.id)).resolves.toMatchObject({
      taskCount: 1,
      worktreeCount: 1,
      activeRunCount: 0
    });
    await expect(
      harness.service.disconnectRepository({ repositoryId: repository.id, confirmed: false })
    ).rejects.toThrow('explicit confirmation');

    const disconnected = await harness.service.disconnectRepository({
      repositoryId: repository.id,
      confirmed: true
    });
    const snapshot = await harness.store.snapshot();
    expect(disconnected.status).toBe('DISCONNECTED');
    expect(snapshot.tasks.find((candidate) => candidate.id === task.id)?.repositoryId).toBe(
      repository.id
    );
    expect(snapshot.worktrees.find((candidate) => candidate.id === worktree.id)).toBeDefined();
    await expect(fs.access(worktree.worktreePath)).resolves.toBeUndefined();
  }, 20_000);

  it('marks a moved checkout missing and reconnects the same ID at its new path', async () => {
    const harness = await createHarness('reconnect');
    const repository = await harness.service.addRepository(harness.repositoryPath);
    const task = await harness.service.createTask({
      title: 'Follow moved checkout',
      prompt: 'Keep repository identity stable.',
      repositoryId: repository.id
    });
    const movedPath = path.join(harness.rootDir, 'repository-moved');
    await fs.rename(harness.repositoryPath, movedPath);

    const missing = await harness.service.refreshRepository(repository.id);
    expect(missing.status).toBe('MISSING');
    const reconnected = await harness.service.reconnectRepository({
      repositoryId: repository.id,
      path: movedPath
    });
    expect(reconnected).toMatchObject({
      id: repository.id,
      path: await fs.realpath(movedPath),
      status: 'AVAILABLE'
    });
    expect((await harness.store.getTask(task.id))?.repositoryId).toBe(repository.id);

    const worktree = await harness.service.prepareWorktree({ taskId: task.id });
    expect(worktree.repositoryId).toBe(repository.id);
    expect(worktree.status).toBe('PRESENT');
  }, 20_000);

  it('blocks disconnect while a repository task has an active run', async () => {
    const harness = await createHarness('active-run');
    const repository = await harness.service.addRepository(harness.repositoryPath);
    const task = await harness.service.createTask({
      title: 'Active repository run',
      prompt: 'Do not disconnect this repository yet.',
      repositoryId: repository.id
    });
    const { iteration, worktree } = await harness.store.createIterationAndWorktree({
      task,
      branchName: 'codex/active-repository-run',
      worktreePath: path.join(harness.rootDir, 'pending-worktree'),
      baseSha: 'base'
    });
    const session = await harness.store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    await harness.store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    const impact = await harness.service.getRepositoryImpact(repository.id);
    expect(impact.activeRunCount).toBe(1);
    expect(impact.blockingReason).toContain('active repository runs');
    await expect(
      harness.service.disconnectRepository({ repositoryId: repository.id, confirmed: true })
    ).rejects.toThrow('active repository runs');
    expect((await harness.store.getRepository(repository.id))?.status).toBe('AVAILABLE');
  });
});

async function createHarness(name: string) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-repository-${name}-`));
  const repositoryPath = path.join(rootDir, 'repository');
  await fs.mkdir(repositoryPath);
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Repository\n');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial commit']);
  const store = new FileTaskStore(path.join(rootDir, 'store'));
  const service = new TaskManagerService(store, repositoryPath, undefined, {
    worktreeRoot: path.join(rootDir, 'worktrees'),
    codexPath: 'codex-not-used'
  });
  return { rootDir, repositoryPath, store, service };
}

async function git(cwd: string, argv: string[]): Promise<void> {
  await exec('git', argv, { cwd });
}
