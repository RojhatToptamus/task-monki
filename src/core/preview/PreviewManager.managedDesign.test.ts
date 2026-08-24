import { describe, expect, it, vi } from 'vitest';
import type { PreviewGenerationRecord } from '../../shared/contracts';
import { AppEventBus } from '../runner/AppEventBus';
import {
  ManagedDesignStaticPreview,
  MANAGED_DESIGN_STATIC_ROUTE_ID
} from './ManagedDesignStaticPreview';
import {
  PreviewManager,
  type ExecuteManagedDesignPreviewInput,
  type PreparedPreviewGeneration,
  type PreviewTaskContext
} from './PreviewManager';

describe('PreviewManager managed Design cutover', () => {
  it('prepares one exact commit with app-owned authority and no approval', async () => {
    const context = designContext();
    const managed = managedOwner();
    const savedPlans: unknown[] = [];
    const savedGenerations: PreviewGenerationRecord[] = [];
    const source = {
      getGenerationPath(taskId: string, generationId: string) {
        return `/preview/${taskId}/${generationId}`;
      },
      prepareExactCommit: vi.fn(async (input: { commitSha: string; generationId: string }) => ({
        generationRoot: `/preview/design-1/${input.generationId}`,
        sourcePath: `/preview/design-1/${input.generationId}/source`,
        markerDigest: 'marker',
        manifest: { version: 1 as const, headSha: input.commitSha, entries: [], digest: 'manifest' }
      }))
    };
    const store = {
      async getLatestPreviewPlan() { return undefined; },
      async savePreviewPlan(plan: unknown) { savedPlans.push(plan); return plan; },
      async getPreviewGenerations() { return []; },
      async savePreviewGeneration(generation: PreviewGenerationRecord) {
        savedGenerations.push(structuredClone(generation));
        return generation;
      },
      async writeTextArtifact() { return { id: 'manifest-artifact' }; }
    };
    const manager = new PreviewManager(
      store as never, new AppEventBus(), {} as never, {} as never, {} as never,
      source as never, {} as never,
      { async listen() { return { port: 4000, relocated: false }; }, async close() {} } as never,
      {} as never, { async reconcile() {} } as never, {} as never,
      undefined, undefined, undefined, managed
    );
    await manager.init(0, { reconcile: false });

    const prepared = await manager.prepareManagedDesignExactCommit({
      context,
      commitSha: 'a'.repeat(40)
    });

    expect(savedPlans).toHaveLength(1);
    expect(source.prepareExactCommit).toHaveBeenCalledWith(expect.objectContaining({
      repositoryPath: context.worktree.worktreePath,
      commitSha: 'a'.repeat(40)
    }));
    expect(prepared.generation).toMatchObject({
      executionAuthority: { type: 'MANAGED_STATIC', adapterVersion: 1 },
      source: {
        type: 'EXACT_COMMIT',
        repositoryId: context.task.repositoryId,
        commitSha: 'a'.repeat(40)
      },
      freshness: 'REVISION',
      sourceManifestArtifactId: 'manifest-artifact'
    });
    expect(savedGenerations).toHaveLength(3);
  });

  it('stores a ready candidate before the checkpoint callback and settles after the fence', async () => {
    const fixture = await createFixture();
    const callback = vi.fn(async (generation: PreviewGenerationRecord) => {
      expect(generation).toMatchObject({ state: 'READY', routingState: 'CANDIDATE' });
      expect(generation.routes).toHaveLength(1);
      expect(fixture.store.saved.at(-1)).toEqual(generation);
      fixture.order.push('candidate-ready');
    });

    const result = await fixture.manager.executeManagedDesign(fixture.prepared, {
      ...fixture.designInput,
      onCandidateReady: callback
    });

    expect(result).toMatchObject({ state: 'READY', routingState: 'ACTIVE' });
    expect(callback).toHaveBeenCalledOnce();
    expect(fixture.running.isRunning).toHaveBeenCalledTimes(3);
    expect(fixture.store.cutoverInput).toMatchObject({
      candidate: { state: 'READY', routingState: 'ACTIVE' },
      designSettlement: {
        designId: 'design-1',
        turnId: 'turn-1',
        runId: 'run-1',
        commitSha: 'a'.repeat(40),
        routeId: MANAGED_DESIGN_STATIC_ROUTE_ID
      }
    });
    expect(fixture.order).toEqual([
      'candidate-ready',
      'fence-begin',
      'gateway-replace:candidate-1',
      'store-cutover',
      'fence-commit'
    ]);
  });

  it('keeps a candidate unrouted during browser checks and cuts over the same live process', async () => {
    const fixture = await createFixture();

    const candidate = await fixture.manager.executeManagedDesignCandidate(
      fixture.prepared,
      {
        designId: 'design-1',
        async onCandidateReady() {
          fixture.order.push('candidate-ready');
        }
      }
    );

    expect(candidate).toMatchObject({ state: 'READY', routingState: 'CANDIDATE' });
    expect(fixture.gateway.replaceRoutes).not.toHaveBeenCalled();
    expect(fixture.store.cutoverInput).toBeUndefined();
    const origin = new URL(candidate.routes[0]!.url).origin;
    const lease = await fixture.manager.openManagedDesignBrowserLease(candidate.id);
    expect(lease).toMatchObject({
      origin,
      proxyUrl: 'http://127.0.0.1:45000'
    });
    expect(fixture.gateway.openBrowserLease).toHaveBeenCalledWith({
      origin: `${origin}/`,
      target: { host: '127.0.0.1', port: 41_000 }
    });

    const settled = await fixture.manager.cutoverManagedDesignCandidate({
      generationId: candidate.id,
      designId: 'design-1',
      settlement: { turnId: 'turn-1', runId: 'run-1' },
      fence: fixture.designInput.fence
    });
    expect(settled).toMatchObject({ routingState: 'ACTIVE' });
    expect(fixture.graph.start).toHaveBeenCalledOnce();
    expect(fixture.order).toEqual([
      'candidate-ready',
      'fence-begin',
      'gateway-replace:candidate-1',
      'store-cutover',
      'fence-commit'
    ]);
  });

  it('does not route or settle a candidate that exits during the canvas fence', async () => {
    const fixture = await createFixture({ runningResults: [true, true, false] });

    await expect(
      fixture.manager.executeManagedDesign(fixture.prepared, fixture.designInput)
    ).rejects.toThrow('exited during the Design canvas cutover fence');

    expect(fixture.gateway.replaceRoutes).not.toHaveBeenCalled();
    expect(fixture.store.cutoverInput).toBeUndefined();
    expect(fixture.fence.rollback).toHaveBeenCalledOnce();
    expect(fixture.running.stop).toHaveBeenCalledOnce();
    expect(fixture.store.saved.at(-1)).toMatchObject({ state: 'FAILED' });
  });

  it('restores the last-good gateway route before it rolls back the canvas', async () => {
    const fixture = await createFixture({ replaced: true, cutoverFailure: true });

    await expect(
      fixture.manager.executeManagedDesign(fixture.prepared, fixture.designInput)
    ).rejects.toThrow('injected settlement failure');

    expect(fixture.order).toContain('gateway-replace:candidate-1');
    expect(fixture.order).toContain('gateway-replace:generation-old');
    expect(fixture.order).toContain('fence-rollback');
    expect(fixture.order.indexOf('gateway-replace:generation-old')).toBeLessThan(
      fixture.order.indexOf('fence-rollback')
    );
    expect(fixture.fence.commit).not.toHaveBeenCalled();
  });
});

async function createFixture(options: {
  runningResults?: boolean[];
  replaced?: boolean;
  cutoverFailure?: boolean;
} = {}) {
  const order: string[] = [];
  const context = designContext();
  const managed = managedOwner();
  const plan = managed.createPlan(context);
  const old = options.replaced ? oldGeneration(plan.id) : undefined;
  const generation: PreviewGenerationRecord = {
    id: 'candidate-1',
    previewKey: 'task-design1',
    taskId: context.task.id,
    iterationId: context.iteration.id,
    worktreeId: context.worktree.id,
    planId: plan.id,
    executionAuthority: {
      type: 'MANAGED_STATIC', adapterVersion: 1, executionDigest: plan.executionDigest
    },
    adapter: 'NATIVE',
    source: {
      type: 'EXACT_COMMIT', repositoryId: context.task.repositoryId, commitSha: 'a'.repeat(40)
    },
    workspacePath: '/tmp/preview/design-1/candidate-1',
    state: 'PREPARING_SOURCE',
    routingState: 'CANDIDATE',
    replacesGenerationId: old?.id,
    freshness: 'REVISION',
    routes: [],
    attachmentReadiness: [],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z'
  };
  const prepared: PreparedPreviewGeneration = {
    generation,
    plan,
    generationRoot: '/tmp/preview/design-1/candidate-1',
    sourcePath: '/tmp/preview/design-1/candidate-1/source',
    markerDigest: 'marker',
    controller: new AbortController()
  };

  const saved: PreviewGenerationRecord[] = [structuredClone(generation)];
  const store = {
    saved,
    cutoverInput: undefined as Record<string, unknown> | undefined,
    async savePreviewGeneration(next: PreviewGenerationRecord) {
      const stored = structuredClone(next);
      saved.push(stored);
      return stored;
    },
    async getPreviewGeneration(id: string) {
      if (id === old?.id) return structuredClone(old);
      return [...saved].reverse().find((candidate) => candidate.id === id);
    },
    async cutoverPreviewGenerations(input: Record<string, unknown>) {
      this.cutoverInput = input;
      order.push('store-cutover');
      if (options.cutoverFailure) throw new Error('injected settlement failure');
      const candidate = structuredClone(input.candidate as PreviewGenerationRecord);
      if (candidate.source.type === 'EXACT_COMMIT') candidate.source.designRevisionId = 'revision-1';
      return { candidate, replaced: input.replaced as PreviewGenerationRecord | undefined };
    },
    async getPreviewResources() { return []; },
    async prunePreviewHistory() { return 0; }
  };
  const runningValues = [...(options.runningResults ?? [true, true, true])];
  const running = {
    ports: { static: { http: 41_000 } },
    unexpectedExit: new Promise<string | undefined>(() => undefined),
    isRunning: vi.fn(() => runningValues.shift() ?? true),
    stopExclusive: vi.fn(async () => 'ALREADY_EXITED' as const),
    restoreExclusive: vi.fn(async () => true),
    stop: vi.fn(async () => 'STOPPED' as const)
  };
  const graph = {
    start: vi.fn(async (input: { updateGenerationState(state: PreviewGenerationRecord['state']): Promise<void> }) => {
      await input.updateGenerationState('RUNNING_GRAPH');
      await input.updateGenerationState('WAITING_READY');
      return running;
    })
  };
  const gateway = {
    async listen() { return { port: 4_000, relocated: false }; },
    async close() {},
    removeOwnedRoutes: vi.fn((generationId: string) => {
      order.push(`gateway-remove:${generationId}`);
    }),
    replaceRoutes: vi.fn((generationId: string) => {
      order.push(`gateway-replace:${generationId}`);
    }),
    openBrowserLease: vi.fn(async () => ({
      proxyUrl: 'http://127.0.0.1:45000',
      async close() {}
    }))
  };
  const fence = {
    commit: vi.fn(async () => { order.push('fence-commit'); }),
    rollback: vi.fn(async () => { order.push('fence-rollback'); })
  };
  const manager = new PreviewManager(
    store as never,
    new AppEventBus(),
    {} as never,
    {} as never,
    {} as never,
    {
      async cleanupOwnedGeneration() { return true; }
    } as never,
    graph as never,
    gateway as never,
    {} as never,
    { async reconcile() {} } as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    managed
  );
  await manager.init(0, { reconcile: false });
  const designInput: ExecuteManagedDesignPreviewInput = {
    designId: 'design-1',
    settlement: { turnId: 'turn-1', runId: 'run-1' },
    fence: {
      async begin() {
        order.push('fence-begin');
        return fence;
      }
    },
    onCandidateReady: async () => undefined
  };
  return { manager, prepared, designInput, store, graph, gateway, running, fence, order };
}

function managedOwner(): ManagedDesignStaticPreview {
  return new ManagedDesignStaticPreview({
    executablePath: '/Applications/Task Monki.app/Contents/MacOS/Task Monki',
    serverPath: '/Applications/Task Monki.app/Contents/Resources/managed-design-static-server.mjs'
  });
}

function oldGeneration(planId: string): PreviewGenerationRecord {
  return {
    id: 'generation-old', previewKey: 'task-design1', taskId: 'design-1',
    iterationId: 'iteration-1', worktreeId: 'worktree-1', planId,
    executionAuthority: { type: 'MANAGED_STATIC', adapterVersion: 1, executionDigest: 'old' },
    source: {
      type: 'EXACT_COMMIT', repositoryId: 'repository-1', commitSha: 'b'.repeat(40),
      designRevisionId: 'revision-old'
    },
    workspacePath: '/tmp/old', state: 'READY', routingState: 'ACTIVE', freshness: 'REVISION',
    routes: [{
      id: 'app', hostname: 'app.design-1.preview.localhost',
      url: 'http://app.design-1.preview.localhost:4000/', gatewayPort: 4000,
      targetHost: '127.0.0.1', targetPort: 4001, state: 'ATTACHED'
    }],
    createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z'
  };
}

function designContext(): PreviewTaskContext {
  const now = '2026-08-20T00:00:00.000Z';
  return {
    task: {
      id: 'design-1', kind: 'DESIGN', runtimeId: 'codex', title: 'Design', prompt: '',
      repositoryId: 'repository-1', workflowPhase: 'READY', resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE', phaseVersion: 1,
      forkedAlternativeTaskIds: [], agentSettings: {}, createdAt: now, updatedAt: now,
      projection: {} as never
    },
    iteration: {
      id: 'iteration-1', taskId: 'design-1', actionRequestId: 'turn-1', generationKey: 'turn-1',
      status: 'ACTIVE', branchName: 'design/design-1', baseSha: 'b'.repeat(40),
      createdAt: now, updatedAt: now
    },
    worktree: {
      id: 'worktree-1', taskId: 'design-1', iterationId: 'iteration-1',
      repositoryId: 'repository-1', worktreePath: '/tmp/design', branchName: 'design/design-1',
      baseSha: 'b'.repeat(40), status: 'PRESENT', createdAt: now, updatedAt: now
    }
  };
}
