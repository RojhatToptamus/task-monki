import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createScriptedAgentRuntimeFixture,
  openScriptedTaskManagerPersistence,
  type TaskMonkiScenario,
  TaskMonkiScenarioRegistry
} from '../../testSupport/taskMonkiScenario';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import type { Task } from '../../shared/contracts';
import type { PreviewSecretProtector } from '../preview/private/PreviewPrivateVault';
import { TaskManagerService } from './TaskManagerService';
import { addTestRepository } from '../../testSupport/repositoryFixture';

const exec = promisify(execFile);
const scenarios = new TaskMonkiScenarioRegistry();
const createTaskMonkiScenario = scenarios.create.bind(scenarios);

afterEach(async () => {
  await scenarios.dispose();
});

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

  it('keeps canonical runtime records when domain deletion does not commit', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-delete-domain-failure'
    });
    const task = await scenario.createTask({
      title: 'Failed domain deletion',
      prompt: 'Keep the provider history until the Task is gone.'
    });
    const session = await createDeletionSession(
      scenario,
      task,
      'delete-domain-failure-session'
    );
    vi.spyOn(scenario.store, 'deleteTask').mockRejectedValueOnce(
      new Error('domain write failed')
    );

    await expect(scenario.service.deleteTask({ taskId: task.id })).rejects.toThrow(
      'domain write failed'
    );
    await expect(scenario.store.getTask(task.id)).resolves.toBeDefined();
    expect((await scenario.runtimeStore.snapshot()).sessions).toContainEqual(
      expect.objectContaining({ id: session.id })
    );
  });

  it('retires Preview-private rows and ciphertext in the task deletion transaction', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-delete-private-'));
    const profileRoot = path.join(root, 'profile');
    const protector: PreviewSecretProtector = {
      isAvailable: () => true,
      encrypt: async (value) => Buffer.from(value.map((byte) => byte ^ 0xaa)),
      decrypt: async (value) => Buffer.from(value.map((byte) => byte ^ 0xaa))
    };
    const persistence = await openTestPersistence(profileRoot, {
      previewSecretProtector: protector
    });
    const scripted = createScriptedAgentRuntimeFixture(persistence);
    const service = new TaskManagerService(persistence.tasks, root, undefined, {
      ...scripted.serviceOptions,
      previewPrivateVault: persistence.previewPrivateVault
    });
    const task = await persistence.tasks.createTask({
      title: 'Delete private input',
      prompt: 'Remove encrypted Task-owned state atomically.',
      repositoryId: (await addTestRepository(persistence.tasks, root)).id
    });
    const vault = persistence.previewPrivateVault!;
    await expect(vault.set(task.id, 'api-token', 'secret-value')).resolves.toBe('STORED');
    const storageKey = await persistence.database.read((reader) =>
      reader.get<{ storage_key: string }>(
        `SELECT storage_key FROM managed_files
         WHERE domain = 'PREVIEW' AND owner_id = ? AND state = 'LIVE'`,
        [task.id]
      )?.storage_key
    );
    expect(storageKey).toBeDefined();

    const deleteFailure = vi
      .spyOn(persistence.tasks, 'deleteTask')
      .mockRejectedValueOnce(new Error('simulated task deletion failure'));
    await expect(service.deleteTask({ taskId: task.id })).rejects.toThrow(
      'simulated task deletion failure'
    );
    const retained = await vault.acquire(task.id, ['api-token']);
    if (Array.isArray(retained)) throw new Error('Private input was lost after rollback.');
    expect(retained.values['api-token']).toBe('secret-value');
    await retained.release();
    deleteFailure.mockRestore();

    await expect(service.deleteTask({ taskId: task.id })).resolves.toEqual({
      taskId: task.id,
      removedWorktree: false
    });
    await vault.shutdown();

    await expect(
      persistence.database.read((reader) =>
        reader.get('SELECT id FROM managed_files WHERE owner_id = ?', [task.id])
      )
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(persistence.paths.managedFilesRoot, ...storageKey!.split('/')))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await service.shutdown();
    await persistence.close();
    const reopened = await openTestPersistence(profileRoot);
    await expect(
      reopened.database.read((reader) =>
        reader.get('SELECT id FROM managed_files WHERE owner_id = ?', [task.id])
      )
    ).resolves.toBeUndefined();
  });

  it('blocks deletion while an agent run is active', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-delete-active-'));
    const { store, ...scriptedRuntime } =
      await openScriptedTaskManagerPersistence(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: 'codex-not-used',
      ...scriptedRuntime.serviceOptions
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
    const session = await scriptedRuntime.createSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    await scriptedRuntime.createRun({
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

    const { store, ...scriptedRuntime } =
      await openScriptedTaskManagerPersistence(path.join(dir, 'store'));
    const service = new TaskManagerService(store, repositoryPath, undefined, {
      worktreeRoot,
      ...scriptedRuntime.serviceOptions
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

    const { store, ...scriptedRuntime } =
      await openScriptedTaskManagerPersistence(path.join(dir, 'store'));
    const service = new TaskManagerService(store, repositoryPath, undefined, {
      worktreeRoot,
      ...scriptedRuntime.serviceOptions
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

async function createDeletionSession(
  scenario: TaskMonkiScenario,
  task: Task,
  sessionId: string
) {
  const { iteration, worktree } = await scenario.store.createIterationAndWorktree({
    task,
    branchName: `codex/${sessionId}`,
    worktreePath: path.join(scenario.rootDir, `${sessionId}-worktree`),
    baseSha: 'base'
  });
  const settings = { runtimeId: 'codex', model: 'scenario-model' };
  const session = await scenario.runtimeStore
    .taskAgentRuntimeAccess()
    .createTaskSession({
      id: sessionId,
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      worktreePath: worktree.worktreePath,
      runtimeId: 'codex',
      requestedSettings: settings,
      executionContext: {
        attestation: { status: 'ATTESTED' },
        repositoryAccess: 'WRITE',
        primaryCwd: worktree.worktreePath,
        readRoots: [
          {
            canonicalPath: worktree.worktreePath,
            kind: 'WORKTREE',
            entityId: worktree.id
          }
        ],
        managedAttachments: [],
        permissionProfileHash: 'a'.repeat(64),
        modelSettings: settings,
        externalTools: {
          network: false,
          webSearch: 'disabled',
          mcpServers: false,
          apps: false,
          dynamicTools: false
        },
        clientOperationId: sessionId
      },
      operationId: sessionId
    });
  await scenario.store.recordAgentSessionCreated(session);
  return session;
}

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
