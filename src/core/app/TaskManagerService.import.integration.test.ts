import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportTaskRequest } from '../../shared/contracts';
import { ScriptedAgentRuntimeAdapter, TaskMonkiScenarioRegistry, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';
import { FileTaskStore } from '../storage/FileTaskStore';
import { WorktreeService } from '../worktree/WorktreeService';
import { TaskManagerService } from './TaskManagerService';

const exec = promisify(execFile);
const scenarios = new TaskMonkiScenarioRegistry();
afterEach(async () => {
  vi.restoreAllMocks();
  await scenarios.dispose();
});

describe('existing checkout attachment', () => {
  it('shares a dirty linked checkout without changing files, index, upstream, or agent history', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    await fs.writeFile(path.join(request.worktreePath, 'staged.txt'), 'staged\n');
    await externalGit(request.worktreePath, ['add', 'staged.txt']);
    await fs.writeFile(path.join(request.worktreePath, 'staged.txt'), 'staged and edited\n');
    await fs.writeFile(path.join(request.worktreePath, 'untracked.txt'), 'keep\n');
    const gitDir = await externalGit(request.worktreePath, ['rev-parse', '--absolute-git-dir']);
    const indexBefore = await fs.readFile(path.join(gitDir, 'index'));
    const configBefore = await fs.readFile(path.join(scenario.repositoryPath, '.git/config'));
    const listedBefore = await externalGit(scenario.repositoryPath, ['worktree', 'list', '--porcelain']);

    const imported = await scenario.service.importTask(request);
    expect(imported.task.workflowPhase).toBe('IN_PROGRESS');
    expect(imported.task.currentRunId).toBeUndefined();
    const detail = await scenario.service.getTaskDetail(imported.task.id);
    expect(detail.worktrees.find((worktree) => worktree.id === detail.task.currentWorktreeId)).toMatchObject({ ownership: 'EXTERNAL', worktreePath: await fs.realpath(request.worktreePath), branchName: 'external-work' });
    expect(detail.runs).toEqual([]);
    expect(detail.agentSessions).toEqual([]);
    expect(detail.gitSnapshots[0]).toMatchObject({ stagedCount: 1, unstagedCount: 1, untrackedCount: 1 });
    expect(detail.events.some((event) => ['WORKTREE_CREATE_REQUESTED', 'WORKTREE_CREATED', 'AGENT_RUN_STARTED'].includes(event.type))).toBe(false);
    expect(scenario.agent.startedTurns).toEqual([]);
    expect(await fs.readFile(path.join(gitDir, 'index'))).toEqual(indexBefore);
    expect(await fs.readFile(path.join(scenario.repositoryPath, '.git/config'))).toEqual(configBefore);
    expect(await externalGit(scenario.repositoryPath, ['worktree', 'list', '--porcelain'])).toBe(listedBefore);
    expect(await fs.readFile(path.join(request.worktreePath, 'staged.txt'), 'utf8')).toBe('staged and edited\n');

    await externalGit(request.worktreePath, ['add', 'staged.txt']);
    await externalGit(request.worktreePath, ['commit', '-m', 'External progress']);
    const newHead = await externalGit(request.worktreePath, ['rev-parse', 'HEAD']);
    expect((await scenario.service.getTaskDetail(imported.task.id)).gitSnapshots[0].headSha).not.toBe(newHead);
    await scenario.service.refreshEvidence({ taskId: imported.task.id });
    const refreshed = await scenario.service.getTaskDetail(imported.task.id);
    expect(refreshed.gitSnapshots[0]).toMatchObject({ headSha: newHead, untrackedCount: 1 });
    expect(refreshed.task.workflowPhase).toBe('IN_PROGRESS');
    await scenario.service.refreshEvidence({ taskId: imported.task.id });
    expect((await scenario.service.getTaskDetail(imported.task.id)).gitSnapshots).toHaveLength(refreshed.gitSnapshots.length);
  }, 30_000);

  it('allows the primary default-branch checkout with an explicit current-commit comparison', async () => {
    const scenario = await scenarios.create();
    const head = await externalGit(scenario.repositoryPath, ['rev-parse', 'HEAD']);
    const result = await scenario.service.importTask({
      repositoryId: scenario.repositoryId, worktreePath: scenario.repositoryPath,
      branchName: 'main', comparison: { type: 'COMMIT', ref: 'HEAD' },
      title: 'Existing primary work', creationToken: randomUUID(), readyForReview: true
    });
    expect(result.task.workflowPhase).toBe('REVIEW');
    expect(await scenario.store.getCurrentWorktree(result.task.id)).toMatchObject({ baseSha: head, baseRef: head });
  });

  it('resolves repeated, concurrent, aliased, managed, and archived checkout selections to one task', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    const [first, repeated] = await Promise.all([scenario.service.importTask(request), scenario.service.importTask(request)]);
    expect(first.task.id).toBe(repeated.task.id);
    await expect(scenario.service.importTask({ ...request, title: 'Different request' })).rejects.toThrow('different request');
    await scenario.service.transitionTask({ taskId: first.task.id, toPhase: 'ARCHIVED' });
    const alias = path.join(scenario.rootDir, 'checkout-alias');
    await fs.symlink(request.worktreePath, alias, 'dir');
    const duplicate = await scenario.service.importTask({ ...request, worktreePath: alias, creationToken: randomUUID() });
    expect(duplicate).toMatchObject({ existing: true, task: { id: first.task.id, workflowPhase: 'ARCHIVED' } });
    expect((await scenario.store.snapshot()).tasks).toHaveLength(1);

    const managed = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: managed.id });
    const managedDuplicate = await scenario.service.importTask({ ...request, worktreePath: worktree.worktreePath, branchName: worktree.branchName, creationToken: randomUUID() });
    expect(managedDuplicate).toMatchObject({ existing: true, task: { id: managed.id } });
  }, 30_000);

  it('publishes the whole attachment or nothing and keeps a failed submission retryable', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    const storePath = path.join(scenario.rootDir, 'store/store.json');
    const before = await fs.readFile(storePath);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === storePath) throw new Error('injected publication failure');
      return rename(source, destination);
    });
    await expect(scenario.service.importTask(request)).rejects.toThrow('injected publication failure');
    failure.mockRestore();
    expect(await fs.readFile(storePath)).toEqual(before);
    expect(await scenario.store.snapshot()).toMatchObject({ tasks: [], iterations: [], worktrees: [], runs: [] });
    const result = await scenario.service.importTask(request);
    expect(result.existing).toBe(false);
    expect(await scenario.store.snapshot()).toMatchObject({ tasks: [expect.anything()], iterations: [expect.anything()], worktrees: [expect.anything()], runs: [] });
  });

  it('blocks switched branches and missing paths without repair, then reconnects without rewriting historical paths', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    const { task } = await scenario.service.importTask(request);
    const original = (await scenario.store.getCurrentWorktree(task.id))!;
    const iteration = (await scenario.store.getCurrentIteration(task.id))!;
    const session = await scenario.store.createAgentSession({ task, iteration, worktree: original, runtimeId: task.runtimeId });
    await externalGit(request.worktreePath, ['switch', '-c', 'unrelated-work']);
    await expect(scenario.service.refreshEvidence({ taskId: task.id })).rejects.toThrow();
    expect((await scenario.store.getTask(task.id))?.projection.git).toBe('UNAVAILABLE');
    await expect(scenario.service.prepareWorktree({ taskId: task.id })).rejects.toThrow('Expected branch');
    expect(await externalGit(request.worktreePath, ['branch', '--show-current'])).toBe('unrelated-work');
    await externalGit(request.worktreePath, ['switch', 'external-work']);
    const moved = path.join(scenario.rootDir, 'moved-checkout');
    await externalGit(scenario.repositoryPath, ['worktree', 'move', request.worktreePath, moved]);
    await expect(scenario.service.prepareWorktree({ taskId: task.id })).rejects.toThrow();
    await expect(fs.access(request.worktreePath)).rejects.toThrow();
    const reconnected = await scenario.service.reconnectWorktree({ taskId: task.id, worktreePath: moved });
    expect(reconnected.worktreePath).toBe(await fs.realpath(moved));
    const state = await scenario.store.snapshot();
    expect(state.agentSessions.find((candidate) => candidate.id === session.id)?.worktreePath).toBe(original.worktreePath);
    expect(state.gitSnapshots.some((snapshot) => snapshot.worktreePath === original.worktreePath)).toBe(true);
    await scenario.service.shutdown();
    const restartedStore = new FileTaskStore(path.join(scenario.rootDir, 'store'));
    const restarted = new TaskManagerService(restartedStore, scenario.repositoryPath, undefined, {
      worktreeRoot: scenario.worktreeRoot,
      agentRuntimeAdapters: [new ScriptedAgentRuntimeAdapter(restartedStore)]
    });
    try {
      await restarted.init();
      expect((await restartedStore.getCurrentWorktree(task.id))?.worktreePath).toBe(reconnected.worktreePath);
      expect((await restartedStore.getTask(task.id))?.workflowPhase).toBe('IN_PROGRESS');
    } finally {
      await restarted.shutdown();
    }
  }, 30_000);

  it('rejects forged removal before resource cleanup and leaves the external checkout after task deletion', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    const { task } = await scenario.service.importTask(request);
    const record = (await scenario.store.getCurrentWorktree(task.id))!;
    const owner = new WorktreeService(scenario.worktreeRoot);
    await expect(owner.create(record, scenario.repositoryPath)).rejects.toThrow('externally owned');
    await expect(owner.remove(record, scenario.repositoryPath)).rejects.toThrow('externally owned');
    const before = await scenario.store.snapshot();
    await expect(scenario.service.deleteTask({ taskId: task.id, removeWorktree: true })).rejects.toThrow('externally owned');
    expect(await scenario.store.snapshot()).toEqual(before);
    await scenario.service.transitionTask({ taskId: task.id, toPhase: 'ARCHIVED' });
    await scenario.service.deleteTask({ taskId: task.id });
    expect(await scenario.store.getTask(task.id)).toBeUndefined();
    expect(await externalGit(request.worktreePath, ['branch', '--show-current'])).toBe('external-work');
    await expect(fs.access(path.join(request.worktreePath, '.git'))).resolves.toBeUndefined();
  }, 30_000);

  it.each(['prepare', 'restart', 'prepare with unavailable repository', 'restart with unavailable repository'] as const)(
    'invalidates current Git and review evidence during %s when the attachment is unavailable',
    async (trigger) => {
      const scenario = await scenarios.create();
      const request = await linkedRequest(scenario);
      const { task } = await scenario.service.importTask({ ...request, readyForReview: true });
      const review = await scenario.service.startReview({ taskId: task.id });
      await scenario.completeRun(review.id, JSON.stringify({
        schemaVersion: 'agent-review/v1', verdict: 'PASSED', summary: 'No findings.', findings: []
      }));
      await scenario.waitForSnapshot((state) => state.tasks[0].projection.agentReview?.status === 'PASSED', 10_000);
      const before = await scenario.service.getTaskDetail(task.id);
      let restarted: TaskManagerService | undefined;
      const unavailableRepository = trigger.endsWith('unavailable repository');
      try {
        if (unavailableRepository) {
          await fs.rename(scenario.repositoryPath, path.join(scenario.rootDir, 'moved-repository'));
          expect((await scenario.service.refreshRepository(scenario.repositoryId)).status).toBe('MISSING');
        }
        if (trigger.startsWith('prepare')) {
          if (!unavailableRepository) {
            await externalGit(request.worktreePath, ['switch', '-c', 'different-work']);
          }
          await expect(scenario.service.prepareWorktree({ taskId: task.id })).rejects.toThrow(
            unavailableRepository ? 'is missing' : 'Expected branch'
          );
        } else {
          await scenario.service.shutdown();
          if (!unavailableRepository) {
            await externalGit(request.worktreePath, ['switch', '-c', 'different-work']);
          }
          const store = new FileTaskStore(path.join(scenario.rootDir, 'store'));
          restarted = new TaskManagerService(store, scenario.repositoryPath, undefined, {
            worktreeRoot: scenario.worktreeRoot,
            agentRuntimeAdapters: [new ScriptedAgentRuntimeAdapter(store)]
          });
          await restarted.init();
        }

        const detail = await (restarted ?? scenario.service).getTaskDetail(task.id);
        expect(detail.task.projection.git).toBe('UNAVAILABLE');
        expect(detail.task.projection.agentReview).toMatchObject({
          runId: review.id, status: 'STALE', result: before.task.projection.agentReview?.result
        });
        expect(detail.gitSnapshots).toEqual(before.gitSnapshots);
        expect(detail.task.currentRunId).toBeUndefined();
        if (!unavailableRepository) {
          expect(detail.worktrees[0]).toMatchObject({ status: 'ERROR' });
          expect(await externalGit(request.worktreePath, ['branch', '--show-current'])).toBe('different-work');
        }
      } finally {
        await restarted?.shutdown();
      }
    },
    30_000
  );

  it('reconnects a moved checkout before repairing an expired comparison without discarding history', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    const originalHead = await externalGit(request.worktreePath, ['rev-parse', 'HEAD']);
    await externalGit(request.worktreePath, ['commit', '--allow-empty', '-m', 'External work before rewrite']);
    const expiredAnchor = await externalGit(request.worktreePath, ['rev-parse', 'HEAD']);
    const { task } = await scenario.service.importTask({
      ...request, comparison: { type: 'COMMIT', ref: expiredAnchor }
    });
    const oldGit = (await scenario.service.getTaskDetail(task.id)).gitSnapshots[0]!;
    // These history changes and object expiry occur only in the disposable external repository.
    await externalGit(request.worktreePath, ['reset', '--hard', originalHead]);
    await externalGit(scenario.repositoryPath, ['reflog', 'expire', '--expire=now', '--all']);
    await externalGit(scenario.repositoryPath, ['gc', '--prune=now']);
    await expect(externalGit(request.worktreePath, ['rev-parse', '--verify', `${expiredAnchor}^{commit}`])).rejects.toThrow();
    const moved = path.join(scenario.rootDir, 'moved-checkout');
    await externalGit(scenario.repositoryPath, ['worktree', 'move', request.worktreePath, moved]);

    const reconnected = await scenario.service.reconnectWorktree({ taskId: task.id, worktreePath: moved });

    expect(reconnected).toMatchObject({
      worktreePath: await fs.realpath(moved), baseSha: expiredAnchor, baseRef: expiredAnchor
    });
    expect((await scenario.store.getTask(task.id))?.projection.git).toBe('UNAVAILABLE');
    await scenario.service.updateWorktreeComparison({
      taskId: task.id, comparison: { type: 'COMMIT', ref: originalHead }
    });
    const repaired = await scenario.service.getTaskDetail(task.id);
    expect(repaired.task.projection.git).toBe('CLEAN');
    expect(repaired.gitSnapshots[0]).toMatchObject({
      worktreePath: await fs.realpath(moved), baseSha: originalHead, headSha: originalHead,
      committedDiffFileCount: 0
    });
    expect(repaired.gitSnapshots.find((snapshot) => snapshot.id === oldGit.id)).toEqual(oldGit);
    expect(repaired.runs).toEqual([]);
    expect(repaired.agentSessions).toEqual([]);
    expect(await externalGit(moved, ['branch', '--show-current'])).toBe(request.branchName);
    expect(await externalGit(moved, ['rev-parse', 'HEAD'])).toBe(originalHead);
    await expect(fs.access(request.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('reviews externally maintained work without a primary run and starts implementation only from an explicit instruction', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    await fs.writeFile(path.join(request.worktreePath, 'change.txt'), 'first\n');
    const { task } = await scenario.service.importTask({ ...request, readyForReview: true });
    const review = await scenario.service.startReview({ taskId: task.id });
    expect(review.mode).toBe('REVIEW');
    expect(review.continuedFromRunId).toBeUndefined();
    expect((await scenario.store.getTask(task.id))?.currentRunId).toBeUndefined();
    const output = JSON.stringify({ schemaVersion: 'agent-review/v1', verdict: 'PASSED', summary: 'No findings.', findings: [] });
    await scenario.completeRun(review.id, output);
    expect((await scenario.store.getTask(task.id))?.projection.agentReview?.status).not.toBe('PASSED');
    await scenario.waitForSnapshot((state) => state.tasks[0].projection.agentReview?.status === 'PASSED', 10_000);
    expect((await scenario.store.snapshot()).runs.map((run) => run.mode)).toEqual(['REVIEW']);
    await fs.writeFile(path.join(request.worktreePath, 'change.txt'), 'external fix\n');
    await scenario.service.refreshEvidence({ taskId: task.id });
    expect((await scenario.store.getTask(task.id))?.projection.agentReview?.status).toBe('STALE');
    await expect(scenario.service.startRun({ taskId: task.id })).rejects.toThrow('Enter an implementation instruction');
    const run = await scenario.service.startRun({ taskId: task.id, instruction: 'Add one focused test for the external fix.' });
    expect(run.mode).toBe('IMPLEMENTATION');
    expect(run.sessionId).not.toBe(review.sessionId);
    expect(await scenario.store.readArtifact(run.promptArtifactId)).toContain('Add one focused test for the external fix.');
    expect((await scenario.store.getTask(task.id))?.workflowPhase).toBe('IN_PROGRESS');
    await scenario.completeRun(run.id);
  }, 30_000);

  it('rejects stale finding instructions before either first implementation or a later follow-up starts', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    await fs.writeFile(path.join(request.worktreePath, 'change.txt'), 'review me\n');
    const { task } = await scenario.service.importTask({ ...request, readyForReview: true });
    const reviewOutput = JSON.stringify({
      schemaVersion: 'agent-review/v1', verdict: 'NEEDS_CHANGES', summary: 'Add a test.',
      findings: [{ id: 'test', severity: 'MAJOR', title: 'Missing test', explanation: 'The changed behavior has no test.' }]
    });
    const review = await scenario.service.startReview({ taskId: task.id });
    await scenario.completeRun(review.id, reviewOutput);
    await scenario.waitForSnapshot((state) => state.tasks[0].projection.agentReview?.status === 'NEEDS_CHANGES');
    await fs.writeFile(path.join(request.worktreePath, 'change.txt'), 'external fix\n');
    await expect(scenario.service.startRun({ taskId: task.id, instruction: 'Fix selected finding.', sourceReviewRunId: review.id }))
      .rejects.toThrow('The review changed');
    expect((await scenario.store.snapshot()).runs.map((run) => run.mode)).toEqual(['REVIEW']);
    const run = await scenario.service.startRun({ taskId: task.id, instruction: 'Implement the current test.' });
    await scenario.completeRun(run.id);
    const nextReview = await scenario.service.startReview({ taskId: task.id });
    await scenario.completeRun(nextReview.id, reviewOutput);
    await scenario.waitForSnapshot((state) => state.tasks[0].projection.agentReview?.status === 'NEEDS_CHANGES');
    const starts = scenario.agent.startedTurns.length;
    await fs.writeFile(path.join(request.worktreePath, 'change.txt'), 'another external fix\n');
    await expect(scenario.service.continueRun({ taskId: task.id, runId: run.id, instruction: 'Fix selected finding.', sourceReviewRunId: nextReview.id }))
      .rejects.toThrow('The review changed');
    expect(scenario.agent.startedTurns).toHaveLength(starts);
  }, 30_000);

  it('marks a review stale when external files change during the run without blaming the reviewer', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    const { task } = await scenario.service.importTask({ ...request, readyForReview: true });
    const review = await scenario.service.startReview({ taskId: task.id });
    await fs.writeFile(path.join(request.worktreePath, 'external.txt'), 'saved during review\n');
    await scenario.completeRun(review.id, JSON.stringify({ verdict: 'PASSED', summary: 'No findings.', findings: [] }));
    await scenario.waitForSnapshot((state) => state.runs.find((run) => run.id === review.id)?.afterGitSnapshotId !== undefined);
    const state = await scenario.store.snapshot();
    expect(state.tasks[0].projection.agentReview?.status).toBe('STALE');
    expect(state.events.some((event) => event.type === 'AGENT_REVIEW_POLICY_VIOLATION')).toBe(false);
    expect(state.runs).toHaveLength(1);
    expect(state.tasks[0].currentRunId).toBeUndefined();
  }, 30_000);

  it('changes the comparison atomically, preserves old evidence, and rejects a delayed observation of the old attachment', async () => {
    const scenario = await scenarios.create();
    const request = await linkedRequest(scenario);
    await fs.writeFile(path.join(request.worktreePath, 'feature.txt'), 'feature\n');
    await externalGit(request.worktreePath, ['add', 'feature.txt']);
    await externalGit(request.worktreePath, ['commit', '-m', 'External feature']);
    const head = await externalGit(request.worktreePath, ['rev-parse', 'HEAD']);
    const { task } = await scenario.service.importTask({ ...request, readyForReview: true });
    const original = (await scenario.store.getCurrentWorktree(task.id))!;
    const oldGit = (await scenario.store.snapshot()).gitSnapshots[0];
    const before = await scenario.store.snapshot();
    const rename = fs.rename.bind(fs);
    const failedPublication = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === path.join(scenario.rootDir, 'store/store.json')) throw new Error('comparison publication failed');
      return rename(source, destination);
    });
    await expect(scenario.service.updateWorktreeComparison({ taskId: task.id, comparison: { type: 'COMMIT', ref: head } }))
      .rejects.toThrow('comparison publication failed');
    failedPublication.mockRestore();
    expect(await scenario.store.snapshot()).toEqual(before);

    await scenario.service.updateWorktreeComparison({ taskId: task.id, comparison: { type: 'COMMIT', ref: head } });
    const state = await scenario.store.snapshot();
    expect(state.worktrees[0].baseSha).toBe(head);
    expect(state.iterations[0].baseSha).toBe(head);
    expect(state.gitSnapshots[0]).toMatchObject({ baseSha: head, committedDiffFileCount: 0 });
    expect(state.gitSnapshots.find((snapshot) => snapshot.id === oldGit.id)).toEqual(oldGit);
    await expect(scenario.store.updateWorktree(original, 'WORKTREE_VERIFIED')).rejects.toThrow('context changed');
    await expect(scenario.store.recordGitSnapshot(oldGit, 'old diff')).rejects.toThrow('checkout changed');
    expect((await scenario.store.getCurrentWorktree(task.id))?.baseSha).toBe(head);
    expect(await externalGit(request.worktreePath, ['rev-parse', 'HEAD'])).toBe(head);
  }, 30_000);
});

async function linkedRequest(scenario: TaskMonkiScenario): Promise<ImportTaskRequest> {
  const worktreePath = path.join(scenario.rootDir, 'external-checkout');
  await externalGit(scenario.repositoryPath, ['worktree', 'add', '-b', 'external-work', worktreePath]);
  return {
    repositoryId: scenario.repositoryId,
    worktreePath,
    branchName: 'external-work',
    comparison: { type: 'MERGE_BASE', ref: 'main' },
    title: 'Continue external work',
    creationToken: randomUUID()
  };
}

async function externalGit(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}
