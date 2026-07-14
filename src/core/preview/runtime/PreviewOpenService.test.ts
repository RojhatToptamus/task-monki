import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { previewRouteHostname } from '../PreviewRouteHostname';
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
    const { generation, taskId } = await seedGeneration(store, {
      hostname: 'example.com',
      url: 'https://example.com/',
      gatewayPort: 443
    });
    const service = new PreviewOpenService(store, { async openExternal() {} });
    await expect(
      service.open({ taskId, generationId: generation.id, routeId: 'app' })
    ).rejects.toThrow('safety check');
  });

  it('rejects stale, malformed, and foreign stored route identities', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-open-preview-invalid-'));
    fixtureRoots.push(root);
    const store = new FileTaskStore(root);
    const service = new PreviewOpenService(store, { async openExternal() {} });
    const { generation, taskId } = await seedGeneration(store);

    for (const hostname of [
      'app.task-a.preview.localhost',
      'other.localhost',
      previewRouteHostname('foreign-task', 'app')
    ]) {
      await store.savePreviewGeneration({
        ...generation,
        routes: [{
          ...generation.routes[0],
          hostname,
          url: `http://${hostname}:31234/`
        }]
      });
      await expect(
        service.open({ taskId, generationId: generation.id, routeId: 'app' })
      ).rejects.toThrow('safety check');
    }

    const expectedHostname = previewRouteHostname(taskId, 'app');
    await store.savePreviewGeneration({
      ...generation,
      routes: [{
        ...generation.routes[0],
        hostname: expectedHostname,
        url: `http://${expectedHostname.toUpperCase()}:31234/`
      }]
    });
    await expect(
      service.open({ taskId, generationId: generation.id, routeId: 'app' })
    ).rejects.toThrow('safety check');
  });
});

async function seedGeneration(
  store: FileTaskStore,
  routeOverride?: { hostname: string; url: string; gatewayPort: number }
) {
  const task = await store.createTask({ title: 'Open', prompt: 'Test', repositoryPath: process.cwd() });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task, branchName: 'codex/open', worktreePath: process.cwd(), baseSha: 'base'
  });
  const plan = await store.savePreviewPlan({
    id: 'plan-1', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
    recipePath: '.taskmonki/preview.yaml', recipeVersion: 1, recipeDigest: 'recipe',
    executionDigest: 'digest', executionPlan: {
      version: 1, jobs: [], resources: [], services: [], workers: [], routes: [],
      scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default'
    },
    warnings: [], createdAt: '2026-01-01T00:00:00.000Z'
  });
  const approval = await store.savePreviewApproval({
    id: 'approval-1', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
    scope: 'TASK', approvedAt: '2026-01-01T00:00:00.000Z'
  });
  const hostname = routeOverride?.hostname ?? previewRouteHostname(task.id, 'app');
  const gatewayPort = routeOverride?.gatewayPort ?? 31234;
  const url = routeOverride?.url ?? `http://${hostname}:${gatewayPort}/`;
  const generation = await store.savePreviewGeneration({
    id: 'generation-1', previewKey: 'task-a', taskId: task.id, iterationId: iteration.id,
    worktreeId: worktree.id, planId: plan.id, approvalId: approval.id, executionDigest: 'digest',
    sourceGitSnapshotId: 'git-1', sourceHeadSha: 'head', sourceDirtyFingerprint: 'dirty',
    workspacePath: '/preview', state: 'READY', routingState: 'ACTIVE', freshness: 'CURRENT',
    routes: [{ id: 'app', hostname, url, gatewayPort, targetHost: '127.0.0.1', targetPort: 41000, state: 'ATTACHED' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  });
  return { generation, taskId: task.id };
}
