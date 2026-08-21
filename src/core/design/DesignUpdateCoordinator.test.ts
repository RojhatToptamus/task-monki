import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DesignSourceCheckpoint,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import type {
  AgentOrchestrator,
  StartOrchestratedTurn
} from '../agent/AgentOrchestrator';
import type { PreviewManager } from '../preview/PreviewManager';
import { AppEventBus } from '../runner/AppEventBus';
import { FileTaskStore, type ManagedDesignRepositoryInput } from '../storage/FileTaskStore';
import type { DesignSourceService } from './DesignSourceService';
import { DesignUpdateCoordinator } from './DesignUpdateCoordinator';

const COMMIT = 'a'.repeat(40);
const harnesses: CoordinatorHarness[] = [];

afterEach(async () => {
  await Promise.allSettled(
    harnesses.splice(0).map(async (harness) => {
      await harness.store.close();
      await fs.rm(harness.dir, { recursive: true, force: true });
    })
  );
});

describe('DesignUpdateCoordinator', () => {
  it('serializes duplicate dispatches around one durable generation-key Run', async () => {
    const harness = await createHarness();
    harness.coordinator.open();

    await Promise.all([
      harness.coordinator.dispatch(harness.designId),
      harness.coordinator.dispatch(harness.designId)
    ]);

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    const detail = await harness.store.getDesignDetail(harness.designId);
    expect(detail.turns[0]).toMatchObject({
      runId: detail.currentRun?.id,
      checkpoint: { boundary: 'RUN_LINKED' }
    });
    expect(detail.currentRun).toMatchObject({
      mode: 'DESIGN',
      generationKey: detail.turns[0]!.id
    });
  });

  it('recovers one queued turn without creating duplicate provider work', async () => {
    const harness = await createHarness();

    await harness.coordinator.recover();
    await harness.coordinator.dispatch(harness.designId);

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    const detail = await harness.store.getDesignDetail(harness.designId);
    expect(detail.turns[0]).toMatchObject({
      runId: detail.currentRun?.id,
      checkpoint: { boundary: 'RUN_LINKED' }
    });
  });

  it('settles a pre-provider dispatch failure instead of leaving the turn queued', async () => {
    const harness = await createHarness({
      refreshGitEvidence: vi.fn(async () => {
        throw new Error('Git evidence is unavailable.');
      })
    });
    harness.coordinator.open();

    await expect(harness.coordinator.dispatch(harness.designId)).rejects.toThrow(
      'Git evidence is unavailable'
    );

    expect(harness.startTurn).not.toHaveBeenCalled();
    const detail = await harness.store.getDesignDetail(harness.designId);
    expect(detail.turns[0]).toMatchObject({
      outcome: 'FAILED',
      failureReason: 'Git evidence is unavailable.'
    });
    expect(detail.turns[0]).not.toHaveProperty('checkpoint');
  });

  it('admits a terminal event during interruption, drains it, then closes admission', async () => {
    const interruptEntered = deferred<void>();
    const releaseInterrupt = deferred<void>();
    const harness = await createHarness({
      interruptRun: vi.fn(async () => {
        interruptEntered.resolve();
        await releaseInterrupt.promise;
      })
    });
    harness.coordinator.open();
    await harness.coordinator.dispatch(harness.designId);
    const run = requireCurrentRun(await harness.store.getDesignDetail(harness.designId));

    const shutdown = harness.coordinator.beginShutdown();
    await interruptEntered.promise;
    await harness.store.updateRun(run.id, {
      status: 'FAILED',
      terminalReason: 'Interrupted during shutdown.',
      endedAt: new Date().toISOString()
    });
    const terminal = harness.coordinator.handleRunTerminal(run.id);
    releaseInterrupt.resolve();
    await Promise.all([shutdown, terminal]);

    const settled = await harness.store.getDesignDetail(harness.designId);
    expect(settled.turns[0]).toMatchObject({
      outcome: 'FAILED',
      failureReason: 'Interrupted during shutdown.'
    });

    const getRun = vi.spyOn(harness.store, 'getRun');
    await harness.coordinator.handleRunTerminal(run.id);
    expect(getRun).not.toHaveBeenCalled();
    expect(() => harness.coordinator.dispatch(harness.designId)).toThrow(
      'not accepting work'
    );
  });

  it('keeps the source checkpoint when branch publication cannot be recorded', async () => {
    const harness = await createHarness();
    const run = await startAndCompleteCurrentTurn(harness);
    const updateCheckpoint = harness.store.updateDesignTurnCheckpoint.bind(
      harness.store
    );
    const checkpointWrite = vi
      .spyOn(harness.store, 'updateDesignTurnCheckpoint')
      .mockImplementation(async (input) => {
        if (input.checkpoint.boundary === 'REF_UPDATED_INDEX_PENDING') {
          throw new Error('The checkpoint file could not be written.');
        }
        return updateCheckpoint(input);
      });

    await harness.coordinator.handleRunTerminal(run.id);

    expect(harness.source.publishCandidateCommit).toHaveBeenCalledTimes(1);
    expect(harness.source.repairCandidateIndex).not.toHaveBeenCalled();
    let turn = (await harness.store.getDesignDetail(harness.designId)).turns[0]!;
    expect(turn.outcome).toBeUndefined();
    expect(turn.checkpoint).toMatchObject({ boundary: 'SOURCE_CAPTURED' });

    checkpointWrite.mockRestore();
    const previewEntered = deferred<void>();
    const releasePreview = deferred<never>();
    harness.previews.prepareManagedDesignExactCommit.mockImplementation(async () => {
      previewEntered.resolve();
      return releasePreview.promise;
    });
    const recovery = harness.coordinator.handleRunTerminal(run.id);
    await previewEntered.promise;

    expect(harness.source.publishCandidateCommit).toHaveBeenCalledTimes(2);
    expect(harness.source.repairCandidateIndex).toHaveBeenCalledTimes(1);
    turn = (await harness.store.getDesignDetail(harness.designId)).turns[0]!;
    expect(turn.outcome).toBeUndefined();
    expect(turn.checkpoint).toMatchObject({ boundary: 'INDEX_REPAIRED' });

    releasePreview.reject(new Error('Stop after the source recovery check.'));
    await recovery;
  });

  it('keeps the ref checkpoint when index repair cannot be recorded', async () => {
    const harness = await createHarness();
    const run = await startAndCompleteCurrentTurn(harness);
    const updateCheckpoint = harness.store.updateDesignTurnCheckpoint.bind(
      harness.store
    );
    const checkpointWrite = vi
      .spyOn(harness.store, 'updateDesignTurnCheckpoint')
      .mockImplementation(async (input) => {
        if (input.checkpoint.boundary === 'INDEX_REPAIRED') {
          throw new Error('The checkpoint file could not be written.');
        }
        return updateCheckpoint(input);
      });

    await harness.coordinator.handleRunTerminal(run.id);

    expect(harness.source.publishCandidateCommit).toHaveBeenCalledTimes(1);
    expect(harness.source.repairCandidateIndex).toHaveBeenCalledTimes(1);
    let turn = (await harness.store.getDesignDetail(harness.designId)).turns[0]!;
    expect(turn.outcome).toBeUndefined();
    expect(turn.checkpoint).toMatchObject({
      boundary: 'REF_UPDATED_INDEX_PENDING'
    });

    checkpointWrite.mockRestore();
    const previewEntered = deferred<void>();
    const releasePreview = deferred<never>();
    harness.previews.prepareManagedDesignExactCommit.mockImplementation(async () => {
      previewEntered.resolve();
      return releasePreview.promise;
    });
    const recovery = harness.coordinator.handleRunTerminal(run.id);
    await previewEntered.promise;

    expect(harness.source.publishCandidateCommit).toHaveBeenCalledTimes(1);
    expect(harness.source.repairCandidateIndex).toHaveBeenCalledTimes(2);
    turn = (await harness.store.getDesignDetail(harness.designId)).turns[0]!;
    expect(turn.outcome).toBeUndefined();
    expect(turn.checkpoint).toMatchObject({ boundary: 'INDEX_REPAIRED' });

    releasePreview.reject(new Error('Stop after the source recovery check.'));
    await recovery;
  });
});

interface CoordinatorHarness {
  dir: string;
  store: FileTaskStore;
  designId: string;
  coordinator: DesignUpdateCoordinator;
  startTurn: ReturnType<typeof vi.fn<(input: StartOrchestratedTurn) => Promise<RunRecord>>>;
  source: {
    captureCandidate: ReturnType<typeof vi.fn>;
    publishCandidateCommit: ReturnType<typeof vi.fn>;
    repairCandidateIndex: ReturnType<typeof vi.fn>;
  };
  previews: {
    prepareManagedDesignExactCommit: ReturnType<typeof vi.fn>;
    executeManagedDesign: ReturnType<typeof vi.fn>;
  };
}

async function createHarness(
  options: {
    refreshGitEvidence?: (designId: string) => Promise<GitSnapshotRecord>;
    interruptRun?: (runId: string) => Promise<void>;
  } = {}
): Promise<CoordinatorHarness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-coordinator-'));
  const store = new FileTaskStore(dir);
  const created = await store.createDesignBundle({
    request: {
      brief: 'Create a compact launch page.',
      creationToken: `design-coordinator-${randomUUID()}`
    },
    repository: managedRepository(dir)
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task: created.task,
    branchName: `task-monki/design-${created.task.id.slice(0, 8)}`,
    worktreePath: path.join(dir, 'worktrees', created.task.id),
    baseRef: 'main',
    baseSha: COMMIT
  });
  const presentWorktree = await store.updateWorktree(
    {
      ...worktree,
      status: 'PRESENT',
      headSha: COMMIT,
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString()
    },
    'WORKTREE_CREATED'
  );
  const task = (await store.getTask(created.task.id))!;
  const session = await store.createAgentSession({
    task,
    iteration,
    worktree: presentWorktree,
    runtimeId: 'codex',
    requestedSettings: task.agentSettings
  });
  const before = await recordGitSnapshot(store, {
    taskId: task.id,
    iterationId: iteration.id,
    worktreeId: presentWorktree.id,
    worktreePath: presentWorktree.worktreePath,
    repositoryPath: created.repository.path,
    branchName: presentWorktree.branchName
  });
  const startTurn = vi.fn(async (input: StartOrchestratedTurn) =>
    store.createRun({
      task: input.task,
      session,
      mode: input.mode,
      prompt: input.prompt,
      generationKey: input.generationKey,
      requestedSettings: input.settings,
      beforeGitSnapshotId: input.beforeGitSnapshotId
    })
  );
  const agents = {
    startTurn,
    interruptRun: options.interruptRun ?? vi.fn(async () => undefined)
  } as unknown as AgentOrchestrator;
  const sourceCheckpoint: DesignSourceCheckpoint = {
    repositoryId: created.repository.id,
    worktreeId: presentWorktree.id,
    branchName: presentWorktree.branchName,
    expectedParentCommit: COMMIT,
    treeSha: 'b'.repeat(40)
  };
  const source = {
    captureCandidate: vi.fn(async () => ({
      kind: 'CAPTURED' as const,
      checkpoint: sourceCheckpoint
    })),
    publishCandidateCommit: vi.fn(async () => ({
      ...sourceCheckpoint,
      candidateCommitSha: 'c'.repeat(40)
    })),
    repairCandidateIndex: vi.fn(async () => undefined)
  };
  const previews = {
    prepareManagedDesignExactCommit: vi.fn(async () => {
      throw new Error('Unexpected Preview preparation.');
    }),
    executeManagedDesign: vi.fn(async () => {
      throw new Error('Unexpected Preview execution.');
    })
  };
  const coordinator = new DesignUpdateCoordinator({
    store,
    agents,
    previews: previews as unknown as PreviewManager,
    source: source as unknown as DesignSourceService,
    fence: {
      async begin() {
        return { async commit() {}, async rollback() {} };
      }
    },
    events: new AppEventBus(),
    refreshGitEvidence: options.refreshGitEvidence ?? (async () => before),
    ensurePostRunEvidence: async () => undefined
  });
  const harness = {
    dir,
    store,
    designId: task.id,
    coordinator,
    startTurn,
    source,
    previews
  };
  harnesses.push(harness);
  return harness;
}

async function startAndCompleteCurrentTurn(
  harness: CoordinatorHarness
): Promise<RunRecord> {
  harness.coordinator.open();
  await harness.coordinator.dispatch(harness.designId);
  const run = requireCurrentRun(await harness.store.getDesignDetail(harness.designId));
  if (!run.beforeGitSnapshotId) {
    throw new Error('Expected the Design Run to have start Git evidence.');
  }
  return harness.store.updateRun(run.id, {
    status: 'COMPLETED',
    finalMessage: 'The Design update is ready.',
    afterGitSnapshotId: run.beforeGitSnapshotId,
    endedAt: new Date().toISOString()
  });
}

function managedRepository(dir: string): ManagedDesignRepositoryInput {
  const id = randomUUID();
  return {
    id,
    name: `Design ${id.slice(0, 8)}`,
    path: path.join(dir, 'managed-repositories', id),
    headSha: COMMIT,
    branch: 'main',
    checkedAt: new Date().toISOString()
  };
}

function recordGitSnapshot(
  store: FileTaskStore,
  input: {
    taskId: string;
    iterationId: string;
    worktreeId: string;
    worktreePath: string;
    repositoryPath: string;
    branchName: string;
  }
): Promise<GitSnapshotRecord> {
  return store.recordGitSnapshot(
    {
      taskId: input.taskId,
      iterationId: input.iterationId,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
      repoRoot: input.repositoryPath,
      gitCommonDir: path.join(input.repositoryPath, '.git'),
      headSha: COMMIT,
      branch: input.branchName,
      baseSha: COMMIT,
      aheadCount: 0,
      behindCount: 0,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      commitsAheadOfBase: 0,
      committedDiffFileCount: 0,
      workingDiffFileCount: 0,
      diffStat: '',
      dirtyFingerprint: 'clean',
      status: 'CLEAN'
    },
    ''
  );
}

function requireCurrentRun(
  detail: Awaited<ReturnType<FileTaskStore['getDesignDetail']>>
): RunRecord {
  if (!detail.currentRun) throw new Error('Expected a current Design Run.');
  return detail.currentRun;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
