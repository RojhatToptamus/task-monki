import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewApprovalPolicy } from './PreviewApprovalPolicy';

describe('PreviewApprovalPolicy', () => {
  it('requires an exact digest and invalidates approval when capability authority changes', async () => {
    const store = new FileTaskStore(await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-')));
    const task = await store.createTask({ title: 'Approval', prompt: 'Test', repositoryPath: process.cwd() });
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
    const store = new FileTaskStore(await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-reuse-')));
    const task = await store.createTask({ title: 'Approval reuse', prompt: 'Test', repositoryPath: process.cwd() });
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

    await expect(policy.requireMatching(next)).resolves.toEqual(approval);
    await expect(store.savePreviewGeneration({
      id: 'generation-2',
      previewKey: 'preview-reuse',
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      planId: next.id,
      approvalId: approval.id,
      executionDigest: next.executionDigest,
      sourceGitSnapshotId: 'git-snapshot-2',
      sourceHeadSha: 'head',
      sourceDirtyFingerprint: 'dirty',
      workspacePath: path.join(process.cwd(), 'preview-reuse'),
      state: 'CREATED',
      routingState: 'CANDIDATE',
      freshness: 'CURRENT',
      routes: [],
      createdAt: now,
      updatedAt: now
    })).resolves.toMatchObject({ planId: next.id, approvalId: approval.id });
  });
});

function testPlan(id: string, executionDigest: string, taskId: string, iterationId: string, worktreeId: string) {
  return {
    id, taskId, iterationId, worktreeId,
    recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const,
    recipeDigest: `recipe-${id}`, executionDigest,
    executionPlan: {
      version: 1 as const, jobs: [], resources: [], services: [], workers: [], routes: [],
      scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default'
    },
    warnings: [], createdAt: new Date().toISOString()
  };
}
