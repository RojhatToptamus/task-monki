import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  createTaskMonkiScenario,
  ScriptedAgentProviderAdapter
} from '../../testSupport/taskMonkiScenario';
import { createAgentSessionAccessEpoch } from '../agent/AgentRuntimeOwnership';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileDiscourseStore } from '../storage/FileDiscourseStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

const exec = promisify(execFile);

describe('TaskManagerService task deletion', () => {
  it('purges generic task runtime state after the task deletion commits', async () => {
    const fixture = await runtimeDeletionFixture('task-manager-delete-runtime-');
    const server = await fixture.runtime.createAgentServer({
      provider: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: '/usr/local/bin/codex',
      argv: ['app-server', '--stdio']
    });
    const reference = await fixture.runtime.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"turn/completed"}'
    );
    await expect(
      fixture.service.readProtocolMessage({ reference })
    ).resolves.toMatchObject({ raw: '{"method":"turn/completed"}' });

    await expect(fixture.service.deleteTask({ taskId: fixture.task.id })).resolves.toEqual({
      taskId: fixture.task.id,
      removedWorktree: false
    });
    expect(await fixture.store.getTask(fixture.task.id)).toBeUndefined();
    expect((await fixture.runtime.snapshot()).sessions).toEqual([]);
    await fixture.service.shutdown();
  });

  it('repairs a crash after task deletion but before generic runtime purge', async () => {
    const fixture = await runtimeDeletionFixture('task-manager-delete-repair-', false);
    await fixture.store.deleteTask(fixture.task.id);

    await fixture.service.init();

    expect((await fixture.runtime.snapshot()).sessions).toEqual([]);
    await fixture.service.shutdown();
  });

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

  it('blocks deletion while an agent run is active', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-delete-active-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      codexPath: 'codex-not-used'
    });

    const task = await store.createTask({
      title: 'Active delete guard',
      prompt: 'Keep the run alive.',
      repositoryPath: dir
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
      provider: 'codex'
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
      codexPath: 'codex-not-used'
    });
    const task = await service.createTaskFromTrustedPath({
      title: 'Dirty delete guard',
      prompt: 'Create a dirty worktree.',
      repositoryPath
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
      codexPath: 'codex-not-used'
    });
    const task = await service.createTaskFromTrustedPath({
      title: 'Clean delete removal',
      prompt: 'Remove the clean worktree.',
      repositoryPath
    });
    const worktree = await service.prepareWorktree({ taskId: task.id });

    const result = await service.deleteTask({ taskId: task.id, removeWorktree: true });

    expect(result).toEqual({ taskId: task.id, removedWorktree: true });
    await expect(store.getTask(task.id)).resolves.toBeUndefined();
    await expect(fs.access(worktree.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(repositoryPath, 'README.md'))).resolves.toBeUndefined();
  });
});

async function runtimeDeletionFixture(prefix: string, initialize = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new FileTaskStore(path.join(dir, 'store'));
  const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
  const discourse = new FileDiscourseStore(path.join(dir, 'discourse'));
  const task = await store.createTask({
    title: 'Runtime deletion boundary',
    prompt: 'Delete all task-owned runtime state.',
    repositoryPath: dir
  });
  const owner = { kind: 'TASK' as const, taskId: task.id };
  const executionContext = {
    attestation: { status: 'ATTESTED' as const },
    primaryCwd: dir,
    readRoots: [{ canonicalPath: dir, kind: 'REPOSITORY' as const }],
    managedAttachments: [],
    permissionProfileHash: 'a'.repeat(64),
    modelSettings: {
      model: 'scenario-model',
      sandbox: 'READ_ONLY' as const,
      approvalPolicy: 'NEVER',
      networkAccess: false
    },
    externalTools: {
      network: false,
      webSearch: 'disabled' as const,
      mcpServers: false,
      apps: false,
      dynamicTools: false
    },
    clientOperationId: `delete-context:${task.id}`
  };
  const sessionId = `delete-session-${task.id}`;
  await runtime.createSession({
    id: sessionId,
    owner,
    accessEpoch: createAgentSessionAccessEpoch({
      owner,
      sessionId,
      epoch: 1,
      providerId: 'codex',
      model: 'scenario-model',
      executionContext,
      createdAt: task.createdAt
    }),
    executionContext,
    clientOperationId: `delete-session:${task.id}`,
    provider: 'codex',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    status: 'NOT_MATERIALIZED',
    materialized: false,
    requestedSettings: executionContext.modelSettings
  });
  const service = new TaskManagerService(store, dir, undefined, {
    agentProviderAdapter: new ScriptedAgentProviderAdapter(store),
    agentRuntimeStore: runtime,
    discourseStore: discourse
  });
  if (initialize) await service.init();
  return { dir, store, runtime, discourse, service, task };
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
