import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitSnapshotRecord } from '../../shared/contracts';
import { AppEventBus } from '../runner/AppEventBus';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewApprovalPolicy } from './PreviewApprovalPolicy';
import { PreviewManager } from './PreviewManager';
import { PreviewPlanResolver } from './PreviewPlanResolver';
import { PreviewRecipeLoader } from './PreviewRecipeLoader';

const fixtureRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('PreviewManager source preparation cleanup', () => {
  it.each([
    ['cleans the workspace and records FAILED', false, 'FAILED'],
    ['preserves cleanup uncertainty as CLEANUP_INCOMPLETE', true, 'CLEANUP_INCOMPLETE']
  ] as const)('%s when post-copy Git observation fails', async (_label, refuseCleanup, expectedState) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-manager-prepare-'));
    fixtureRoots.push(root);
    const worktreePath = path.join(root, 'worktree');
    const previewRoot = path.join(root, 'preview');
    await fs.mkdir(path.join(worktreePath, '.taskmonki'), { recursive: true });
    await fs.writeFile(
      path.join(worktreePath, '.taskmonki', 'preview.yaml'),
      `version: 1
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /ready }
routes:
  app: { service: web, port: http, primary: true }
`
    );
    const store = new FileTaskStore(path.join(root, 'store'));
    const task = await store.createTask({ title: 'Prepare cleanup', prompt: 'Test', repositoryPath: worktreePath });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/prepare-cleanup', worktreePath, baseSha: 'head'
    });
    const source = {
      getGenerationPath(taskId: string, generationId: string) {
        return path.join(previewRoot, taskId, generationId);
      },
      async prepare(input: { taskId: string; generationId: string }) {
        const generationRoot = path.join(previewRoot, input.taskId, input.generationId);
        const sourcePath = path.join(generationRoot, 'source');
        await fs.mkdir(sourcePath, { recursive: true });
        return {
          generationRoot,
          sourcePath,
          markerDigest: 'marker',
          manifest: { version: 1 as const, headSha: 'head', entries: [], digest: 'manifest' }
        };
      },
      async cleanupOwnedGeneration(input: { taskId: string; generationId: string }) {
        if (refuseCleanup) throw new Error('Injected ownership refusal.');
        await fs.rm(path.join(previewRoot, input.taskId, input.generationId), {
          recursive: true,
          force: true
        });
        return true;
      }
    };
    const manager = new PreviewManager(
      store,
      new AppEventBus(),
      new PreviewRecipeLoader(),
      new PreviewPlanResolver(),
      new PreviewApprovalPolicy(store),
      source as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const context = { task, iteration, worktree };
    const resolved = await manager.resolve(context);
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await manager.approve({
      taskId: task.id,
      planId: resolved.plan.id,
      executionDigest: resolved.plan.executionDigest
    });
    const gitSnapshot = {
      id: 'git', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
      status: 'CLEAN', headSha: 'head', dirtyFingerprint: 'dirty', capturedAt: new Date().toISOString()
    } as GitSnapshotRecord;

    await expect(
      manager.prepare({
        context,
        gitSnapshot,
        async reobserveGit() {
          throw new Error('Injected post-copy Git observation failure.');
        }
      })
    ).rejects.toThrow('post-copy');
    const generation = (await store.getPreviewGenerations(task.id))[0];
    expect(generation.state).toBe(expectedState);
    if (!refuseCleanup) {
      await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      await expect(fs.access(generation.workspacePath)).resolves.toBeUndefined();
    }
  });

  it('serializes stop with source preparation so a canceled generation cannot be resurrected', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-manager-stop-prepare-'));
    fixtureRoots.push(root);
    const worktreePath = path.join(root, 'worktree');
    const previewRoot = path.join(root, 'preview');
    await fs.mkdir(path.join(worktreePath, '.taskmonki'), { recursive: true });
    await fs.writeFile(
      path.join(worktreePath, '.taskmonki', 'preview.yaml'),
      `version: 1
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /ready }
routes:
  app: { service: web, port: http, primary: true }
`
    );
    const store = new FileTaskStore(path.join(root, 'store'));
    const task = await store.createTask({ title: 'Stop preparation', prompt: 'Test', repositoryPath: worktreePath });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/stop-prepare', worktreePath, baseSha: 'head'
    });
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    let markPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => { markPrepareStarted = resolve; });
    const source = {
      getGenerationPath(taskId: string, generationId: string) {
        return path.join(previewRoot, taskId, generationId);
      },
      async prepare(input: { taskId: string; generationId: string }) {
        const generationRoot = path.join(previewRoot, input.taskId, input.generationId);
        const sourcePath = path.join(generationRoot, 'source');
        await fs.mkdir(sourcePath, { recursive: true });
        markPrepareStarted();
        await prepareGate;
        return {
          generationRoot, sourcePath, markerDigest: 'marker',
          manifest: { version: 1 as const, headSha: 'head', entries: [], digest: 'manifest' }
        };
      },
      async cleanupOwnedGeneration(input: { taskId: string; generationId: string }) {
        await fs.rm(path.join(previewRoot, input.taskId, input.generationId), { recursive: true, force: true });
        return true;
      }
    };
    const manager = new PreviewManager(
      store, new AppEventBus(), new PreviewRecipeLoader(), new PreviewPlanResolver(),
      new PreviewApprovalPolicy(store), source as never, {} as never,
      { removeOwnedRoutes() {} } as never,
      {} as never, {} as never, {} as never
    );
    const context = { task, iteration, worktree };
    const resolved = await manager.resolve(context);
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await manager.approve({
      taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
    });
    const gitSnapshot = {
      id: 'git', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
      status: 'CLEAN', headSha: 'head', dirtyFingerprint: 'dirty', capturedAt: new Date().toISOString()
    } as GitSnapshotRecord;
    const preparing = manager.prepare({ context, gitSnapshot, async reobserveGit() { return gitSnapshot; } });
    await prepareStarted;
    const generation = (await store.getPreviewGenerations(task.id))[0];
    const stopping = manager.stop(generation.id);
    releasePrepare();

    await expect(preparing).rejects.toThrow('canceled');
    const stopped = await stopping;
    expect(stopped.state).toBe('STOPPED');
    expect((await store.getPreviewGeneration(generation.id))?.state).toBe('STOPPED');
    await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
