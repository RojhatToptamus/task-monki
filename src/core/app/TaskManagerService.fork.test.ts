import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from '../storage/FileTaskStore';
import { ScriptedAgentProviderAdapter } from '../../testSupport/taskMonkiScenario';
import { TaskManagerService } from './TaskManagerService';

const exec = promisify(execFile);

describe('TaskManagerService fork alternatives', () => {
  it('creates a linked task with an isolated worktree and starts a fresh implementation run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-fork-alt-'));
    const repositoryPath = path.join(dir, 'repo');
    const worktreeRoot = path.join(dir, 'worktrees');
    await fs.mkdir(repositoryPath, { recursive: true });
    const baseSha = await initRepository(repositoryPath);

    const store = new FileTaskStore(path.join(dir, 'store'));
    const agent = new ScriptedAgentProviderAdapter(store);
    const service = new TaskManagerService(store, repositoryPath, undefined, {
      worktreeRoot,
      agentProviderAdapter: agent
    });

    const sourceTask = await store.createTask({
      title: 'Build filter',
      prompt: 'Add a better filter.',
      repositoryPath
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task: sourceTask,
      branchName: 'codex/source-filter',
      worktreePath: path.join(worktreeRoot, 'source'),
      baseSha
    });
    const sourceSession = await store.createAgentSession({
      task: sourceTask,
      iteration,
      worktree,
      provider: 'codex'
    });
    const sourceRun = await store.createRun({
      task: sourceTask,
      session: sourceSession,
      mode: 'IMPLEMENTATION',
      prompt: sourceTask.prompt
    });
    await store.updateRun(sourceRun.id, {
      status: 'COMPLETED',
      endedAt: new Date().toISOString()
    });

    const forkedRun = await service.retryRun({
      taskId: sourceTask.id,
      runId: sourceRun.id,
      strategy: 'FORK',
      instruction: 'Try a smaller state-machine approach.'
    });
    const snapshot = await store.snapshot();
    const refreshedSource = snapshot.tasks.find((task) => task.id === sourceTask.id);
    const alternativeTask = snapshot.tasks.find((task) => task.id === forkedRun.taskId);
    const alternativeWorktree = snapshot.worktrees.find(
      (candidate) => candidate.id === alternativeTask?.currentWorktreeId
    );

    expect(forkedRun.taskId).not.toBe(sourceTask.id);
    expect(forkedRun.mode).toBe('IMPLEMENTATION');
    expect(forkedRun.sessionId).not.toBe(sourceRun.sessionId);
    expect(refreshedSource?.forkedAlternativeTaskIds).toContain(forkedRun.taskId);
    expect(alternativeTask?.title).toBe('Alternative #1: Build filter');
    expect(alternativeTask?.forkedFromTaskId).toBe(sourceTask.id);
    expect(alternativeTask?.forkedFromRunId).toBe(sourceRun.id);
    expect(alternativeWorktree?.status).toBe('PRESENT');
    expect(alternativeWorktree?.baseSha).toBe(baseSha);
    expect(alternativeWorktree?.worktreePath).not.toBe(worktree.worktreePath);
    expect(alternativeWorktree?.branchName).toContain(`task-${forkedRun.taskId.slice(0, 8)}`);
    expect(agent.startedTurns).toHaveLength(1);
    expect(agent.startedTurns[0]?.session.providerSessionId).toBeTruthy();

    const prompt = await store.readArtifact(forkedRun.promptArtifactId);
    expect(prompt).toContain('Alternative attempt for this Task Monki goal');
    expect(prompt).toContain('Try a smaller state-machine approach.');

    const secondForkedRun = await service.retryRun({
      taskId: sourceTask.id,
      runId: sourceRun.id,
      strategy: 'FORK',
      instruction: 'Try a data-first approach.'
    });
    const secondSnapshot = await store.snapshot();
    const sourceAfterSecondFork = secondSnapshot.tasks.find((task) => task.id === sourceTask.id);
    const secondAlternativeTask = secondSnapshot.tasks.find(
      (task) => task.id === secondForkedRun.taskId
    );

    expect(sourceAfterSecondFork?.forkedAlternativeTaskIds).toHaveLength(2);
    expect(secondAlternativeTask?.title).toBe('Alternative #2: Build filter');
  }, 20_000);

  it('leaves failed fork setup visible as a blocked alternative task', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-fork-fail-'));
    const repositoryPath = path.join(dir, 'repo');
    const worktreeRoot = path.join(dir, 'worktrees-file');
    await fs.mkdir(repositoryPath, { recursive: true });
    await fs.writeFile(worktreeRoot, 'not a directory');
    const baseSha = await initRepository(repositoryPath);

    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, repositoryPath, undefined, {
      worktreeRoot,
      codexPath: 'codex-not-used'
    });

    const sourceTask = await store.createTask({
      title: 'Build filter',
      prompt: 'Add a better filter.',
      repositoryPath
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task: sourceTask,
      branchName: 'codex/source-filter',
      worktreePath: path.join(dir, 'source'),
      baseSha
    });
    const sourceSession = await store.createAgentSession({
      task: sourceTask,
      iteration,
      worktree,
      provider: 'codex'
    });
    const sourceRun = await store.createRun({
      task: sourceTask,
      session: sourceSession,
      mode: 'IMPLEMENTATION',
      prompt: sourceTask.prompt
    });
    await store.updateRun(sourceRun.id, {
      status: 'COMPLETED',
      endedAt: new Date().toISOString()
    });

    await expect(
      service.retryRun({
        taskId: sourceTask.id,
        runId: sourceRun.id,
        strategy: 'FORK',
        instruction: 'Try another approach.'
      })
    ).rejects.toThrow();

    const snapshot = await store.snapshot();
    const refreshedSource = snapshot.tasks.find((task) => task.id === sourceTask.id);
    const alternativeTask = snapshot.tasks.find(
      (task) => task.forkedFromTaskId === sourceTask.id
    );
    const alternativeWorktree = snapshot.worktrees.find(
      (candidate) => candidate.id === alternativeTask?.currentWorktreeId
    );

    expect(alternativeTask).toBeDefined();
    expect(refreshedSource?.forkedAlternativeTaskIds).toContain(alternativeTask?.id);
    expect(alternativeTask?.title).toBe('Alternative #1: Build filter');
    expect(alternativeTask?.workflowPhase).toBe('BLOCKED');
    expect(alternativeWorktree?.status).toBe('ERROR');
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
