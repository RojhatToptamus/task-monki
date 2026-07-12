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

function previewGatewayStub() {
  return {
    async listen(preferredPort: number) {
      return { port: preferredPort || 31_337, relocated: false };
    },
    async close() {},
    removeOwnedRoutes() {},
    replaceRoutes() {}
  };
}

function previewReconcilerStub() {
  return { async reconcile() {} };
}

describe('PreviewManager lifecycle', () => {
  it('joins an in-flight initialization and closes the gateway when shutdown wins', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-manager-lifecycle-'));
    fixtureRoots.push(root);
    const store = new FileTaskStore(path.join(root, 'store'));
    let releaseReconcile!: () => void;
    const reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    let markReconcileStarted!: () => void;
    const reconcileStarted = new Promise<void>((resolve) => { markReconcileStarted = resolve; });
    let closeCalls = 0;
    const manager = new PreviewManager(
      store,
      new AppEventBus(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        async listen() { return { port: 31_337, relocated: false }; },
        async close() { closeCalls += 1; },
        removeOwnedRoutes() {},
        replaceRoutes() {}
      } as never,
      {} as never,
      {
        async reconcile() {
          markReconcileStarted();
          await reconcileGate;
        }
      } as never,
      {} as never
    );

    const initializing = manager.init();
    await reconcileStarted;
    const shutdown = manager.shutdown();
    expect(manager.shutdown()).toBe(shutdown);
    releaseReconcile();

    await expect(initializing).rejects.toThrow('initialization was canceled');
    await expect(shutdown).resolves.toBeUndefined();
    expect(closeCalls).toBeGreaterThanOrEqual(1);
    await expect(manager.init()).rejects.toThrow('shutting down');
    await expect(manager.resolve({} as never)).rejects.toThrow('shutting down');
  });
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
      previewGatewayStub() as never,
      {} as never,
      previewReconcilerStub() as never,
      {} as never
    );
    await manager.init(0, { reconcile: false });
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
      previewGatewayStub() as never,
      {} as never, previewReconcilerStub() as never, {} as never
    );
    await manager.init(0, { reconcile: false });
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

  it('caps failed source-preparation generations through the shared history policy', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-manager-prepare-retention-'));
    fixtureRoots.push(root);
    const worktreePath = path.join(root, 'worktree');
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
    const task = await store.createTask({
      title: 'Prepare retention', prompt: 'Test', repositoryPath: worktreePath
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/prepare-retention', worktreePath, baseSha: 'head'
    });
    const manager = new PreviewManager(
      store,
      new AppEventBus(),
      new PreviewRecipeLoader(),
      new PreviewPlanResolver(),
      new PreviewApprovalPolicy(store),
      {
        getGenerationPath(taskId: string, generationId: string) {
          return path.join(root, 'preview', taskId, generationId);
        },
        async prepare() {
          throw new Error('Injected source preparation failure.');
        }
      } as never,
      {} as never,
      previewGatewayStub() as never,
      {} as never,
      previewReconcilerStub() as never,
      {} as never
    );
    await manager.init(0, { reconcile: false });
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

    const observedGenerationIds: string[] = [];
    const knownGenerationIds = new Set<string>();
    for (let attempt = 0; attempt < 21; attempt += 1) {
      await expect(
        manager.prepare({ context, gitSnapshot, async reobserveGit() { return gitSnapshot; } })
      ).rejects.toThrow('Injected source preparation failure.');
      const created = (await store.getPreviewGenerations(task.id)).find(
        (generation) => !knownGenerationIds.has(generation.id)
      );
      if (!created) throw new Error('Expected a newly failed generation.');
      observedGenerationIds.push(created.id);
      knownGenerationIds.add(created.id);
    }

    const generations = await store.getPreviewGenerations(task.id);
    expect(generations).toHaveLength(20);
    expect(generations.every((generation) => generation.state === 'FAILED')).toBe(true);
    expect(new Set(generations.map((generation) => generation.id))).toEqual(
      new Set(observedGenerationIds.slice(-20))
    );
    expect(generations.some((generation) => generation.id === observedGenerationIds[0])).toBe(false);
  });
});

describe('PreviewManager managed reset preflight', () => {
  it('leaves the active application and data untouched until the current recipe and approval pass', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-manager-reset-'));
    fixtureRoots.push(root);
    const worktreePath = path.join(root, 'worktree');
    await fs.mkdir(path.join(worktreePath, '.taskmonki'), { recursive: true });
    const recipePath = path.join(worktreePath, '.taskmonki', 'preview.yaml');
    const recipe = (command: string) => `version: 1
resources:
  database: { type: postgres, database: app }
jobs:
  migrate:
    command: [node, migrate.mjs]
    needs: { database: ready }
    role: migration
    retrySafe: true
services:
  web:
    command: [node, ${command}]
    needs: { database: ready, migrate: succeeded }
    env: { DATABASE_URL: { type: postgres-url, resource: database } }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /ready }
routes:
  app: { service: web, port: http, primary: true }
scenarios:
  default: { jobs: [migrate], resources: [database] }
`;
    await fs.writeFile(recipePath, recipe('server-a.mjs'));
    const store = new FileTaskStore(path.join(root, 'store'));
    const task = await store.createTask({ title: 'Reset', prompt: 'Reset data', repositoryPath: worktreePath });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/reset', worktreePath, baseSha: 'head'
    });
    const events: string[] = [];
    const healthCallbacks: Array<(resource: unknown, reason: string) => Promise<void>> = [];
    const identity = {
      contextName: 'desktop-linux', endpointDigest: 'endpoint', engineId: 'engine',
      serverVersion: '1', apiVersion: '1', operatingSystem: 'linux', architecture: 'arm64'
    };
    const oci = {
      async verifyManagedPreview() {
        events.push('authority-verified');
        return {
          resources: [{
            id: 'managed-database', logicalResourceId: 'database', state: 'SETUP_FAILED'
          }]
        };
      },
      async stopManagedResource(id: string) {
        events.push(`resource-stopped:${id}`);
        return 'STOPPED' as const;
      },
      async cleanupTaskResources(taskId: string) {
        events.push(`managed-cleanup:${taskId}`);
        return 'STOPPED' as const;
      },
      async watchRequiredResources(
        _taskId: string,
        _resourceIds: string[],
        onFailure: (resource: unknown, reason: string) => Promise<void>
      ) {
        healthCallbacks.push(onFailure);
        return async () => {};
      }
    };
    const manager = new PreviewManager(
      store,
      new AppEventBus(),
      new PreviewRecipeLoader(),
      new PreviewPlanResolver({
        async probe() {
          return {
            status: 'READY' as const, contextName: identity.contextName, identity,
            supportsMemoryLimit: true, supportsCpuLimit: true, supportsPidsLimit: true
          };
        }
      } as never),
      new PreviewApprovalPolicy(store),
      {
        async cleanupOwnedGeneration() { events.push('application-stopped'); }
      } as never,
      {} as never,
      previewGatewayStub() as never,
      {} as never,
      previewReconcilerStub() as never,
      {} as never,
      oci as never
    );
    await manager.init(0, { reconcile: false });
    const context = { task, iteration, worktree };
    const initial = await manager.resolve(context);
    if (initial.status !== 'PLAN') throw new Error('Expected initial plan.');
    const approval = await manager.approve({
      taskId: task.id, planId: initial.plan.id, executionDigest: initial.plan.executionDigest
    });
    const now = new Date().toISOString();
    const generation = await store.savePreviewGeneration({
      id: 'active-generation', previewKey: 'task-reset', taskId: task.id,
      iterationId: iteration.id, worktreeId: worktree.id, planId: initial.plan.id,
      approvalId: approval.id, executionDigest: initial.plan.executionDigest,
      sourceGitSnapshotId: 'git', sourceHeadSha: 'head', sourceDirtyFingerprint: 'dirty',
      workspacePath: '/preview/reset', state: 'READY', routingState: 'ACTIVE', freshness: 'CURRENT',
      routes: [], createdAt: now, updatedAt: now
    });

    await fs.writeFile(recipePath, recipe('server-b.mjs'));
    await expect(manager.resetData({
      taskId: task.id, generationId: generation.id, resourceId: 'database',
      scenarioId: 'default', context
    })).rejects.toThrow('approval');
    expect(events).toEqual([]);
    expect(await store.getPreviewGeneration(generation.id)).toMatchObject({ state: 'READY' });

    const current = await manager.resolve(context);
    if (current.status !== 'PLAN') throw new Error('Expected current plan.');
    await manager.approve({
      taskId: task.id, planId: current.plan.id, executionDigest: current.plan.executionDigest
    });
    await manager.resetData({
      taskId: task.id, generationId: generation.id, resourceId: 'database',
      scenarioId: 'default', context
    });
    expect(events).toEqual([
      'authority-verified', 'application-stopped', 'resource-stopped:managed-database'
    ]);
    expect(await store.getPreviewGeneration(generation.id)).toMatchObject({ state: 'STOPPED' });

    const preservedActive = await store.savePreviewGeneration({
      ...generation,
      id: 'preserved-active-generation',
      planId: current.plan.id,
      approvalId: (await store.getMatchingPreviewApproval(task.id, current.plan.executionDigest))!.id,
      executionDigest: current.plan.executionDigest,
      state: 'READY',
      routingState: 'ACTIVE',
      stoppedAt: undefined
    });
    const failed = await store.savePreviewGeneration({
      ...generation,
      id: 'failed-setup-generation',
      planId: current.plan.id,
      approvalId: (await store.getMatchingPreviewApproval(task.id, current.plan.executionDigest))!.id,
      executionDigest: current.plan.executionDigest,
      state: 'FAILED',
      routingState: 'CANDIDATE',
      replacesGenerationId: preservedActive.id,
      failureReason: 'Migration failed.',
      stoppedAt: undefined
    });
    const getAttachments = store.getPreviewGenerationAttachments.bind(store);
    store.getPreviewGenerationAttachments = async (generationId) => generationId === failed.id
      ? [{
          id: 'failed-attachment', taskId: task.id, generationId: failed.id,
          managedResourceId: 'managed-database', logicalResourceId: 'database',
          bindingId: 'binding', attachedAt: now
        }]
      : getAttachments(generationId);
    await expect(manager.authorizeSetupRetry({
      taskId: task.id, generationId: failed.id, scenarioId: 'default', context
    })).rejects.toThrow('prior failed or ambiguous setup-attempt evidence');
    await store.savePreviewNodeAttempt({
      id: 'failed-migration-attempt', taskId: task.id, generationId: failed.id,
      nodeId: 'migrate', kind: 'JOB', attempt: 1, commandDigest: 'migrate', state: 'FAILED',
      stdoutArtifactId: 'stdout', stderrArtifactId: 'stderr', endedAt: now
    });
    await expect(manager.authorizeSetupRetry({
      taskId: task.id, generationId: failed.id, scenarioId: 'default', context
    })).resolves.toEqual(['managed-database']);
    events.length = 0;

    await manager.resetData({
      taskId: task.id, generationId: failed.id, resourceId: 'database',
      scenarioId: 'default', context
    });
    expect(events).toEqual([
      'authority-verified', 'application-stopped', 'application-stopped',
      'resource-stopped:managed-database'
    ]);
    expect(await store.getPreviewGeneration(preservedActive.id)).toMatchObject({ state: 'STOPPED' });
    expect(await store.getPreviewGeneration(failed.id)).toMatchObject({ state: 'STOPPED' });

    const cleanupActive = await store.savePreviewGeneration({
      ...preservedActive,
      id: 'cleanup-active-generation',
      state: 'READY',
      routingState: 'ACTIVE',
      stoppedAt: undefined
    });
    const cleanupCandidate = await store.savePreviewGeneration({
      ...failed,
      id: 'cleanup-candidate-generation',
      state: 'CLEANUP_INCOMPLETE',
      replacesGenerationId: cleanupActive.id,
      cleanupReason: 'Candidate cleanup needs another exact attempt.',
      stoppedAt: undefined
    });
    events.length = 0;
    await manager.stop(cleanupCandidate.id);
    expect(events).toEqual(['application-stopped']);
    expect(await store.getPreviewGeneration(cleanupActive.id)).toMatchObject({ state: 'READY' });
    expect(await store.getPreviewGeneration(cleanupCandidate.id)).toMatchObject({ state: 'STOPPED' });

    const destructiveCandidate = await store.savePreviewGeneration({
      ...failed,
      id: 'destructive-failed-generation',
      state: 'FAILED',
      replacesGenerationId: cleanupActive.id,
      stoppedAt: undefined
    });
    let healthStopCalls = 0;
    const healthStops = (manager as unknown as {
      resourceHealthStops: Map<string, () => Promise<void>>;
    }).resourceHealthStops;
    healthStops.set(task.id, async () => { healthStopCalls += 1; });
    events.length = 0;
    await manager.stop(destructiveCandidate.id);
    expect(events).toEqual([
      'application-stopped', 'application-stopped', `managed-cleanup:${task.id}`
    ]);
    expect(healthStopCalls).toBe(1);
    expect(healthStops.has(task.id)).toBe(false);
    expect(await store.getPreviewGeneration(cleanupActive.id)).toMatchObject({ state: 'STOPPED' });
    expect(await store.getPreviewGeneration(destructiveCandidate.id)).toMatchObject({ state: 'STOPPED' });

    const retired = await store.savePreviewGeneration({
      ...failed,
      id: 'retired-health-generation',
      state: 'READY',
      routingState: 'RETIRED',
      stoppedAt: undefined
    });
    const currentActive = await store.savePreviewGeneration({
      ...preservedActive,
      id: 'active-health-generation',
      state: 'READY',
      routingState: 'ACTIVE',
      stoppedAt: undefined
    });
    const startHealthWatch = (manager as unknown as {
      startResourceHealthWatch(taskId: string, generationId: string, resourceIds: string[]): Promise<void>;
    }).startResourceHealthWatch.bind(manager);
    await startHealthWatch(task.id, retired.id, ['old-resource']);
    await startHealthWatch(task.id, currentActive.id, ['new-resource']);
    await healthCallbacks[0]({}, 'Retired resource failed during cutover.');
    expect(await store.getPreviewGeneration(retired.id)).toMatchObject({ state: 'FAILED' });
    expect(await store.getPreviewGeneration(currentActive.id)).toMatchObject({ state: 'READY' });
  });
});
