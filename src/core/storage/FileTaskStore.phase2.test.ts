import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitSnapshotRecord } from '../../shared/contracts';
import { createDomainEvent } from './domainEvent';
import { FileTaskStore } from './FileTaskStore';

describe('FileTaskStore Phase 2 evidence', () => {
  it('marks completed tests stale when a later Git generation changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-phase2-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Phase 2 task',
      prompt: 'Change one harmless file.',
      repositoryPath: dir,
      testCommand: 'node --version'
    });
    const { worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/task-test',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });
    const firstSnapshot = snapshotFixture(task.id, worktree.id, worktree.iterationId, 'head-1', 'fingerprint-1');
    await store.recordGitSnapshot(firstSnapshot, '# diff\n');
    const testRun = await store.createTestRun({
      task,
      worktree,
      gitSnapshot: { id: 'snapshot-1', capturedAt: new Date().toISOString(), ...firstSnapshot },
      commandLine: 'node --version',
      executable: 'node',
      argv: ['--version']
    });
    expect((await store.getTask(task.id))?.workflowPhase).toBe('READY');
    await store.appendEvent(
      createDomainEvent({
        type: 'TEST_RUN_COMPLETED',
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        testRunId: testRun.id,
        source: 'test',
        payload: { exitCode: 0, signal: null }
      })
    );

    await store.recordGitSnapshot(
      snapshotFixture(task.id, worktree.id, worktree.iterationId, 'head-2', 'fingerprint-2'),
      '# diff changed\n'
    );

    const stored = await store.snapshot();
    expect(stored.testRuns.find((candidate) => candidate.id === testRun.id)?.status).toBe('STALE');
    expect(stored.events.some((event) => event.type === 'TEST_RESULT_STALE')).toBe(true);
  });
});

function snapshotFixture(
  taskId: string,
  worktreeId: string,
  iterationId: string,
  headSha: string,
  dirtyFingerprint: string
): Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'> {
  return {
    taskId,
    iterationId,
    worktreeId,
    worktreePath: '/tmp/worktree',
    repoRoot: '/tmp/worktree',
    gitCommonDir: '/tmp/worktree/.git',
    headSha,
    branch: 'codex/task-test',
    baseSha: 'base',
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
    dirtyFingerprint,
    status: 'CLEAN'
  };
}
