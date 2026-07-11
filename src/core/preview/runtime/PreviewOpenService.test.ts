import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { PreviewOpenService } from './PreviewOpenService';

const fixtureRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('PreviewOpenService', () => {
  it('opens only a recorded attached ready .localhost route identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-open-preview-'));
    fixtureRoots.push(root);
    const store = new FileTaskStore(root);
    const opened: string[] = [];
    const service = new PreviewOpenService(store, {
      async openExternal(url) { opened.push(url); }
    });
    const { generation, taskId } = await seedGeneration(store);
    await expect(
      service.open({ taskId, generationId: generation.id, routeId: 'app' })
    ).resolves.toEqual({ opened: true, url: generation.routes[0].url });
    expect(opened).toEqual([generation.routes[0].url]);
    await expect(
      service.open({ taskId, generationId: generation.id, routeId: 'unknown' })
    ).rejects.toThrow('not attached');
  });

  it('rejects a stored arbitrary external URL even when the caller knows its route id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-open-preview-unsafe-'));
    fixtureRoots.push(root);
    const store = new FileTaskStore(root);
    const { generation, taskId } = await seedGeneration(store, 'https://example.com/');
    const service = new PreviewOpenService(store, { async openExternal() {} });
    await expect(
      service.open({ taskId, generationId: generation.id, routeId: 'app' })
    ).rejects.toThrow('safety check');
  });
});

async function seedGeneration(store: FileTaskStore, url = 'http://app.task-a.preview.localhost:31234/') {
  const task = await store.createTask({ title: 'Open', prompt: 'Test', repositoryPath: process.cwd() });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task, branchName: 'codex/open', worktreePath: process.cwd(), baseSha: 'base'
  });
  const plan = await store.savePreviewPlan({
    id: 'plan-1', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
    recipePath: '.taskmonki/preview.yaml', recipeVersion: 1, recipeDigest: 'recipe',
    executionDigest: 'digest', executionPlan: { version: 1, jobs: [], services: [], routes: [] },
    warnings: [], createdAt: '2026-01-01T00:00:00.000Z'
  });
  const approval = await store.savePreviewApproval({
    id: 'approval-1', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
    scope: 'TASK', approvedAt: '2026-01-01T00:00:00.000Z'
  });
  const generation = await store.savePreviewGeneration({
    id: 'generation-1', previewKey: 'task-a', taskId: task.id, iterationId: iteration.id,
    worktreeId: worktree.id, planId: plan.id, approvalId: approval.id, executionDigest: 'digest',
    sourceGitSnapshotId: 'git-1', sourceHeadSha: 'head', sourceDirtyFingerprint: 'dirty',
    workspacePath: '/preview', state: 'READY', freshness: 'CURRENT',
    routes: [{ id: 'app', hostname: url.includes('example.com') ? 'example.com' : 'app.task-a.preview.localhost', url, gatewayPort: url.includes('example.com') ? 443 : 31234, targetHost: '127.0.0.1', targetPort: 41000, state: 'ATTACHED' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  });
  return { generation, taskId: task.id };
}
