import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { PreviewOpenService } from './PreviewOpenService';

describe('PreviewOpenService', () => {
  it('opens only a recorded attached ready .localhost route identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-open-preview-'));
    const store = new FileTaskStore(root);
    const opened: string[] = [];
    const service = new PreviewOpenService(store, {
      async openExternal(url) { opened.push(url); }
    });
    const generation = await seedGeneration(store);
    await expect(
      service.open({ taskId: 'task-1', generationId: generation.id, routeId: 'app' })
    ).resolves.toEqual({ opened: true, url: generation.routes[0].url });
    expect(opened).toEqual([generation.routes[0].url]);
    await expect(
      service.open({ taskId: 'task-1', generationId: generation.id, routeId: 'unknown' })
    ).rejects.toThrow('not attached');
  });

  it('rejects a stored arbitrary external URL even when the caller knows its route id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-open-preview-unsafe-'));
    const store = new FileTaskStore(root);
    const generation = await seedGeneration(store, 'https://example.com/');
    const service = new PreviewOpenService(store, { async openExternal() {} });
    await expect(
      service.open({ taskId: 'task-1', generationId: generation.id, routeId: 'app' })
    ).rejects.toThrow('safety check');
  });
});

async function seedGeneration(store: FileTaskStore, url = 'http://app.task-a.preview.localhost:31234/') {
  return store.savePreviewGeneration({
    id: 'generation-1', previewKey: 'task-a', taskId: 'task-1', iterationId: 'iteration-1',
    worktreeId: 'worktree-1', planId: 'plan-1', approvalId: 'approval-1', executionDigest: 'digest',
    sourceGitSnapshotId: 'git-1', sourceHeadSha: 'head', sourceDirtyFingerprint: 'dirty',
    workspacePath: '/preview', state: 'READY', freshness: 'CURRENT',
    routes: [{ id: 'app', hostname: url.includes('example.com') ? 'example.com' : 'app.task-a.preview.localhost', url, gatewayPort: url.includes('example.com') ? 443 : 31234, targetHost: '127.0.0.1', targetPort: 41000, state: 'ATTACHED' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  });
}
