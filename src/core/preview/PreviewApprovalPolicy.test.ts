import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewApprovalPolicy } from './PreviewApprovalPolicy';

describe('PreviewApprovalPolicy', () => {
  it('requires exact plan identity/digest and invalidates approval when capability authority changes', async () => {
    const store = new FileTaskStore(await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-')));
    const plan = await store.savePreviewPlan(testPlan('plan-1', 'digest-1'));
    const policy = new PreviewApprovalPolicy(store);
    await expect(policy.approve({ taskId: 'task-1', planId: plan.id, executionDigest: 'wrong' })).rejects.toThrow('digest changed');
    const approval = await policy.approve({ taskId: 'task-1', planId: plan.id, executionDigest: plan.executionDigest });
    await expect(policy.requireMatching(plan)).resolves.toEqual(approval);
    const changed = await store.savePreviewPlan(testPlan('plan-2', 'digest-2'));
    await expect(policy.requireMatching(changed)).rejects.toThrow('approval is required');
    expect((await store.snapshot()).previewApprovals[0]?.invalidatedAt).toBeDefined();
  });
});

function testPlan(id: string, executionDigest: string) {
  return {
    id, taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1',
    recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const,
    recipeDigest: `recipe-${id}`, executionDigest,
    executionPlan: { version: 1 as const, jobs: [], services: [], routes: [] },
    warnings: [], createdAt: new Date().toISOString()
  };
}
