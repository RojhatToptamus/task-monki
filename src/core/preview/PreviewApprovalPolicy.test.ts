import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { openTestTaskStore } from '../../testSupport/persistenceFixture';
import { PreviewApprovalPolicy } from './PreviewApprovalPolicy';

describe('PreviewApprovalPolicy', () => {
  it('requires an exact digest and invalidates approval when capability authority changes', async () => {
    const store = await openTestTaskStore(await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-')));
    const task = await store.createTask({ title: 'Approval', prompt: 'Test', repositoryId: (await addTestRepository(store, process.cwd())).id });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/approval', worktreePath: process.cwd(), baseSha: 'base'
    });
    const plan = await store.savePreviewPlan(testPlan('plan-1', 'digest-1', task.id, iteration.id, worktree.id));
    const policy = new PreviewApprovalPolicy(store);
    await expect(policy.approve({ taskId: task.id, planId: plan.id, executionDigest: 'wrong' })).rejects.toThrow('digest changed');
    const approval = await policy.approve({ taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest });
    await expect(policy.requireMatching(plan)).resolves.toEqual(approval);
    const changed = await store.savePreviewPlan(testPlan('plan-2', 'digest-2', task.id, iteration.id, worktree.id));
    await expect(policy.requireMatching(changed)).rejects.toThrow('approval is required');
    expect((await store.snapshot()).previewApprovals[0]?.invalidatedAt).toBeDefined();
  });

  it('reuses task-scoped authority for a new plan with the same execution digest', async () => {
    const store = await openTestTaskStore(await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-reuse-')));
    const task = await store.createTask({ title: 'Approval reuse', prompt: 'Test', repositoryId: (await addTestRepository(store, process.cwd())).id });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/approval-reuse', worktreePath: process.cwd(), baseSha: 'base'
    });
    const first = await store.savePreviewPlan(
      testPlan('plan-1', 'stable-digest', task.id, iteration.id, worktree.id)
    );
    const policy = new PreviewApprovalPolicy(store);
    const approval = await policy.approve({
      taskId: task.id,
      planId: first.id,
      executionDigest: first.executionDigest
    });
    const next = await store.savePreviewPlan(
      testPlan('plan-2', first.executionDigest, task.id, iteration.id, worktree.id)
    );
    const now = new Date().toISOString();
    const snapshot = await recordSnapshot(store, task.id, iteration.id, worktree.id);

    await expect(policy.requireMatching(next)).resolves.toEqual(approval);
    await expect(store.savePreviewGeneration({
      id: 'generation-2',
      previewKey: 'preview-reuse',
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      planId: next.id,
      executionAuthority: {
        type: 'USER_APPROVAL', approvalId: approval.id, executionDigest: next.executionDigest
      },
      source: {
        type: 'WORKTREE_SNAPSHOT', gitSnapshotId: snapshot.id,
        headSha: snapshot.headSha!, dirtyFingerprint: snapshot.dirtyFingerprint
      },
      workspacePath: path.join(process.cwd(), 'preview-reuse'),
      state: 'CREATED',
      routingState: 'CANDIDATE',
      freshness: 'CURRENT',
      routes: [],
      createdAt: now,
      updatedAt: now
    })).resolves.toMatchObject({
      planId: next.id,
      executionAuthority: { type: 'USER_APPROVAL', approvalId: approval.id }
    });
  });
});

function testPlan(id: string, executionDigest: string, taskId: string, iterationId: string, worktreeId: string) {
  return {
    id, taskId, iterationId, worktreeId,
    planSource: {
      type: 'REPOSITORY_RECIPE' as const,
      recipePath: '.taskmonki/preview.yaml' as const,
      recipeVersion: 1 as const,
      recipeDigest: `recipe-${id}`
    },
    executionDigest,
    executionPlan: {
      version: 1 as const, jobs: [], resources: [], services: [], workers: [], routes: [],
      scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default'
    },
    warnings: [], createdAt: new Date().toISOString()
  };
}

function recordSnapshot(
  store: SqliteTaskStore,
  taskId: string,
  iterationId: string,
  worktreeId: string
) {
  return store.recordGitSnapshot({
    taskId, iterationId, worktreeId,
    worktreePath: process.cwd(), repoRoot: process.cwd(), gitCommonDir: '.git',
    headSha: 'head', branch: 'codex/approval', aheadCount: 0, behindCount: 0,
    stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0,
    commitsAheadOfBase: 0, committedDiffFileCount: 0, workingDiffFileCount: 0,
    diffStat: '', dirtyFingerprint: 'dirty', status: 'DIRTY'
  }, '');
}
