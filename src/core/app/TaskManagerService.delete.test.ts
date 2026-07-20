import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createTaskMonkiScenario } from '../../testSupport/taskMonkiScenario';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';
import { ScriptedAgentRuntimeAdapter } from '../../testSupport/taskMonkiScenario';
import { addTestRepository } from '../../testSupport/repositoryFixture';

const exec = promisify(execFile);

describe('TaskManagerService task deletion', () => {
  it('serializes deletion against a concurrent run start before materialization', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-delete-start-race'
    });
    const task = await scenario.createTask({
      title: 'Delete versus start',
      prompt: 'Exercise the per-task action boundary.'
    });
    const originalDelete = scenario.store.deleteTask.bind(scenario.store);
    let signalDeleteEntered!: () => void;
    const deleteEntered = new Promise<void>((resolve) => {
      signalDeleteEntered = resolve;
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteTask = vi
      .spyOn(scenario.store, 'deleteTask')
      .mockImplementation(async (taskId) => {
        signalDeleteEntered();
        await deleteGate;
        return originalDelete(taskId);
      });

    const deletion = scenario.service.deleteTask({ taskId: task.id });
    await deleteEntered;
    try {
      await expect(
        scenario.service.startRun({ taskId: task.id })
      ).rejects.toThrow('Task deletion is already running for this task.');
      expect(scenario.agent.startedTurns).toHaveLength(0);
    } finally {
      releaseDelete();
    }

    await expect(deletion).resolves.toEqual({
      taskId: task.id,
      removedWorktree: false
    });
    expect(await scenario.store.getTask(task.id)).toBeUndefined();
    deleteTask.mockRestore();
  });

  it('keeps storage open until task deletion finishes', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-delete-shutdown-race'
    });
    const task = await scenario.createTask({
      title: 'Delete during shutdown',
      prompt: 'Keep the deletion transaction intact.'
    });
    const originalDelete = scenario.store.deleteTask.bind(scenario.store);
    let markDeleteEntered!: () => void;
    const deleteEntered = new Promise<void>((resolve) => {
      markDeleteEntered = resolve;
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    vi.spyOn(scenario.store, 'deleteTask').mockImplementation(async (taskId) => {
      markDeleteEntered();
      await deleteGate;
      return originalDelete(taskId);
    });
    const closeStore = vi.spyOn(scenario.store, 'close');

    const deletion = scenario.service.deleteTask({ taskId: task.id });
    await deleteEntered;
    const shutdown = scenario.service.shutdown();
    await Promise.resolve();
    expect(closeStore).not.toHaveBeenCalled();

    releaseDelete();
    await expect(deletion).resolves.toEqual({
      taskId: task.id,
      removedWorktree: false
    });
    await expect(shutdown).resolves.toBeUndefined();
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('blocks deletion while an agent run is active', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-delete-active-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: 'codex-not-used'
    });

    const task = await store.createTask({
      title: 'Active delete guard',
      prompt: 'Keep the run alive.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/delete-active',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    await expect(service.deleteTask({ taskId: task.id })).rejects.toThrow(
      'active agent run'
    );
    expect(await store.getTask(task.id)).toBeDefined();
  });

  it('blocks local worktree removal when the worktree is dirty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-delete-dirty-'));
    const repositoryPath = path.join(dir, 'repo');
    const worktreeRoot = path.join(dir, 'worktrees');
    await fs.mkdir(repositoryPath, { recursive: true });
    await initRepository(repositoryPath);

    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, repositoryPath, undefined, {
      worktreeRoot,
      agentRuntimeAdapters: [new ScriptedAgentRuntimeAdapter(store)]
    });
    const repository = await service.addRepository(repositoryPath);
    const task = await service.createTask({
      title: 'Dirty delete guard',
      prompt: 'Create a dirty worktree.',
      repositoryId: repository.id
    });
    const worktree = await service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'dirty.txt'), 'dirty\n');

    await expect(
      service.deleteTask({ taskId: task.id, removeWorktree: true })
    ).rejects.toThrow('uncommitted or untracked files');
    expect(await store.getTask(task.id)).toBeDefined();
    await expect(fs.access(worktree.worktreePath)).resolves.toBeUndefined();
  });

  it('removes a clean task worktree when explicitly requested', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-delete-clean-'));
    const repositoryPath = path.join(dir, 'repo');
    const worktreeRoot = path.join(dir, 'worktrees');
    await fs.mkdir(repositoryPath, { recursive: true });
    await initRepository(repositoryPath);

    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, repositoryPath, undefined, {
      worktreeRoot,
      agentRuntimeAdapters: [new ScriptedAgentRuntimeAdapter(store)]
    });
    const repository = await service.addRepository(repositoryPath);
    const task = await service.createTask({
      title: 'Clean delete removal',
      prompt: 'Remove the clean worktree.',
      repositoryId: repository.id
    });
    const worktree = await service.prepareWorktree({ taskId: task.id });

    const result = await service.deleteTask({ taskId: task.id, removeWorktree: true });

    expect(result).toEqual({ taskId: task.id, removedWorktree: true });
    await expect(store.getTask(task.id)).resolves.toBeUndefined();
    await expect(fs.access(worktree.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(repositoryPath, 'README.md'))).resolves.toBeUndefined();
  });
});

async function initRepository(repositoryPath: string): Promise<string> {
  await exec('git', ['init'], { cwd: repositoryPath });
  await fs.writeFile(path.join(repositoryPath, 'README.md'), 'base\n');
  await exec('git', ['add', 'README.md'], { cwd: repositoryPath });
  await exec(
    'git',
    [
      '-c',
      'user.name=Task Monki',
      '-c',
      'user.email=task-monki@example.invalid',
      'commit',
      '-m',
      'base'
    ],
    { cwd: repositoryPath }
  );
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath });
  return stdout.trim();
}
