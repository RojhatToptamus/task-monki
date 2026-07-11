import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../git/gitCli';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewGateway } from './PreviewGateway';
import { PreviewReconciler } from './PreviewReconciler';
import { PreviewSourcePreparer } from './PreviewSourcePreparer';
import { NativeLauncherHost } from './runtime/NativeLauncherHost';
import { NativeServiceRuntime } from './runtime/NativeServiceRuntime';

const describeMac = process.platform === 'darwin' ? describe : describe.skip;
const launcherPath = path.join(process.cwd(), 'src/core/preview/runtime/native-preview-launcher.mjs');

describeMac('PreviewReconciler macOS ownership integration', () => {
  it('never reports a lost preview ready and stops only the exact persisted owner', async () => {
    const fixture = await runningGeneration();
    await fixture.reconciler.reconcile();

    const generation = await fixture.store.getPreviewGeneration(fixture.generationId);
    expect(generation).toMatchObject({ state: 'STOPPED' });
    expect(generation?.routes.every((route) => route.state === 'DETACHED')).toBe(true);
    await expectProcessMissing(fixture.owned.identity.launcher.pid);
    await expect(fs.access(fixture.generationRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a substituted identity, leaves the process alive, and records cleanup residue', async () => {
    const fixture = await runningGeneration();
    const resource = (await fixture.store.getPreviewResources(fixture.generationId))[0];
    await fixture.store.savePreviewResource({
      ...resource,
      native: resource.native
        ? {
            ...resource.native,
            launcher: { ...resource.native.launcher, startedAt: 'substituted start identity' }
          }
        : undefined
    });

    await fixture.reconciler.reconcile();
    const generation = await fixture.store.getPreviewGeneration(fixture.generationId);
    expect(generation).toMatchObject({ state: 'CLEANUP_INCOMPLETE' });
    expect(() => process.kill(fixture.owned.identity.launcher.pid, 0)).not.toThrow();
    await expect(fs.access(fixture.generationRoot)).resolves.toBeUndefined();

    await expect(fixture.host.stopVerified(fixture.owned.identity)).resolves.toBe('STOPPED');
    await fixture.source.cleanupOwnedGeneration({ taskId: fixture.taskId, generationId: fixture.generationId });
  });
});

async function runningGeneration() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-reconcile-'));
  const repo = path.join(root, 'repo');
  const previewRoot = path.join(root, 'preview-runtime');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Task Monki Test']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'content');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Initial']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const store = new FileTaskStore(path.join(root, 'store'));
  const task = await store.createTask({ title: 'Reconcile', prompt: 'Test', repositoryPath: repo });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task, branchName: 'codex/reconcile', worktreePath: repo, baseSha: head
  });
  const generationId = 'generation-1';
  const source = new PreviewSourcePreparer(previewRoot, store.getStoreIdentity());
  const prepared = await source.prepare({
    repositoryPath: repo, taskId: task.id, generationId, expectedHeadSha: head
  });
  const now = new Date().toISOString();
  await store.savePreviewGeneration({
    id: generationId, previewKey: 'task-reconcile', taskId: task.id, iterationId: iteration.id,
    worktreeId: worktree.id, planId: 'plan', approvalId: 'approval', executionDigest: 'digest',
    sourceGitSnapshotId: 'git', sourceHeadSha: head, sourceDirtyFingerprint: 'dirty',
    workspacePath: prepared.generationRoot, state: 'READY', freshness: 'CURRENT',
    routes: [{ id: 'app', hostname: 'app.task-reconcile.preview.localhost', url: 'http://app.task-reconcile.preview.localhost:31234/', gatewayPort: 31234, targetHost: '127.0.0.1', targetPort: 41234, state: 'ATTACHED' }],
    createdAt: now, updatedAt: now
  });
  const resourceId = 'resource-1';
  const receiptPath = path.join(prepared.generationRoot, 'runtime', `${resourceId}.json`);
  let resource = await store.savePreviewResource({
    id: resourceId, taskId: task.id, generationId, logicalNodeId: 'web', adapterKind: 'NATIVE_PROCESS',
    state: 'INTENDED', ownershipMarkerDigest: prepared.markerDigest, receiptPath, updatedAt: now
  });
  const stdoutPath = path.join(root, 'stdout.log');
  const stderrPath = path.join(root, 'stderr.log');
  await fs.writeFile(stdoutPath, '');
  await fs.writeFile(stderrPath, '');
  const host = new NativeLauncherHost(launcherPath);
  const owned = await host.launch({
    receiptPath,
    executable: process.execPath,
    argv: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: prepared.sourcePath,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdoutPath,
    stderrPath,
    persistPrepared: async (identity) => {
      resource = await store.savePreviewResource({ ...resource, state: 'PREPARED', native: identity, updatedAt: new Date().toISOString() });
    },
    persistStarted: async (identity) => {
      resource = await store.savePreviewResource({ ...resource, state: 'RUNNING', native: identity, updatedAt: new Date().toISOString() });
    }
  });
  resource = await store.savePreviewResource({ ...resource, state: 'RUNNING', native: owned.identity, updatedAt: new Date().toISOString() });
  const gateway = new PreviewGateway();
  const runtime = new NativeServiceRuntime(store, host);
  return {
    store,
    taskId: task.id,
    generationId,
    generationRoot: prepared.generationRoot,
    source,
    host,
    owned,
    reconciler: new PreviewReconciler(store, gateway, runtime, source)
  };
}

async function expectProcessMissing(pid: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
  }
  throw new Error(`Process ${pid} remained alive.`);
}
