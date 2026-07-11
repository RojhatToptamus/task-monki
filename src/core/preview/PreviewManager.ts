import { randomUUID } from 'node:crypto';
import type {
  GitSnapshotRecord,
  OpenPreviewRequest,
  OpenPreviewResult,
  PreviewApprovalRecord,
  PreviewGenerationRecord,
  PreviewPlanRecord,
  ReadPreviewLogRequest,
  ResolvePreviewResult,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../shared/contracts';
import { AppEventBus } from '../runner/AppEventBus';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewApprovalPolicy } from './PreviewApprovalPolicy';
import { PreviewGateway } from './PreviewGateway';
import { PreviewGraph, type RunningPreviewGraph } from './PreviewGraph';
import { PreviewPlanResolver } from './PreviewPlanResolver';
import { PreviewRecipeLoader } from './PreviewRecipeLoader';
import { PreviewReconciler } from './PreviewReconciler';
import { PreviewSourcePreparer } from './PreviewSourcePreparer';
import { NativeServiceRuntime } from './runtime/NativeServiceRuntime';
import { PreviewOpenService } from './runtime/PreviewOpenService';

export interface PreviewTaskContext {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
}

export interface PreparedPreviewGeneration {
  generation: PreviewGenerationRecord;
  plan: PreviewPlanRecord;
  generationRoot: string;
  sourcePath: string;
  markerDigest: string;
}

export class PreviewManager {
  private readonly live = new Map<string, RunningPreviewGraph>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private gatewayPort: number | undefined;

  constructor(
    private readonly store: FileTaskStore,
    private readonly events: AppEventBus,
    private readonly recipeLoader: PreviewRecipeLoader,
    private readonly planResolver: PreviewPlanResolver,
    private readonly approvalPolicy: PreviewApprovalPolicy,
    private readonly sourcePreparer: PreviewSourcePreparer,
    private readonly graph: PreviewGraph,
    private readonly gateway: PreviewGateway,
    private readonly nativeRuntime: NativeServiceRuntime,
    private readonly reconciler: PreviewReconciler,
    private readonly opener: PreviewOpenService
  ) {}

  async init(
    preferredGatewayPort = 0,
    options: { reconcile?: boolean } = {}
  ): Promise<{ port: number; relocated: boolean }> {
    const listening = await this.gateway.listen(preferredGatewayPort);
    this.gatewayPort = listening.port;
    if (options.reconcile !== false) await this.reconciler.reconcile();
    return listening;
  }

  async resolve(context: PreviewTaskContext): Promise<ResolvePreviewResult> {
    const loaded = await this.recipeLoader.load(context.worktree.worktreePath);
    if (loaded.status === 'MISSING') return { status: 'UNAVAILABLE', reason: loaded.reason };
    const candidate = await this.planResolver.resolve({ ...context, parsed: loaded.parsed });
    const latest = await this.store.getLatestPreviewPlan(context.task.id);
    const plan =
      latest &&
      latest.iterationId === candidate.iterationId &&
      latest.worktreeId === candidate.worktreeId &&
      latest.recipeDigest === candidate.recipeDigest &&
      latest.executionDigest === candidate.executionDigest
        ? latest
        : await this.store.savePreviewPlan(candidate);
    const approval = await this.store.getMatchingPreviewApproval(
      context.task.id,
      plan.executionDigest
    );
    return { status: 'PLAN', plan, approval };
  }

  approve(input: { taskId: string; planId: string; executionDigest: string }): Promise<PreviewApprovalRecord> {
    return this.approvalPolicy.approve(input);
  }

  async prepare(input: {
    context: PreviewTaskContext;
    gitSnapshot: GitSnapshotRecord;
    reobserveGit(): Promise<GitSnapshotRecord>;
  }): Promise<PreparedPreviewGeneration> {
    const resolved = await this.resolve(input.context);
    if (resolved.status !== 'PLAN') throw new Error(resolved.reason);
    const approval = await this.approvalPolicy.requireMatching(resolved.plan);
    const sourceHeadSha = input.gitSnapshot.headSha;
    const sourceDirtyFingerprint = input.gitSnapshot.dirtyFingerprint;
    if (!sourceHeadSha || !sourceDirtyFingerprint) {
      throw new Error('Preview source capture requires complete Git HEAD and dirty fingerprint evidence.');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    let generation: PreviewGenerationRecord = {
      id,
      previewKey: stablePreviewKey(input.context.task.id),
      taskId: input.context.task.id,
      iterationId: input.context.iteration.id,
      worktreeId: input.context.worktree.id,
      planId: resolved.plan.id,
      approvalId: approval.id,
      executionDigest: resolved.plan.executionDigest,
      sourceGitSnapshotId: input.gitSnapshot.id,
      sourceHeadSha,
      sourceDirtyFingerprint,
      workspacePath: this.sourcePreparer.getGenerationPath(input.context.task.id, id),
      state: 'CREATED',
      freshness: 'CURRENT',
      routes: [],
      createdAt: now,
      updatedAt: now
    };
    generation = await this.store.savePreviewGeneration(generation);
    generation = await this.saveGeneration({ ...generation, state: 'PREPARING_SOURCE' });
    try {
      const prepared = await this.sourcePreparer.prepare({
        repositoryPath: input.context.worktree.worktreePath,
        taskId: generation.taskId,
        generationId: generation.id,
        expectedHeadSha: sourceHeadSha
      });
      const observed = await input.reobserveGit();
      if (
        observed.headSha !== sourceHeadSha ||
        observed.dirtyFingerprint !== sourceDirtyFingerprint
      ) {
        await this.sourcePreparer.cleanupOwnedGeneration({
          taskId: generation.taskId,
          generationId: generation.id
        });
        throw new Error('Git evidence changed while the preview source was being prepared.');
      }
      const manifest = await this.store.writeTextArtifact(
        generation.taskId,
        'preview-source-manifest',
        `${JSON.stringify(prepared.manifest, null, 2)}\n`
      );
      generation = await this.saveGeneration({
        ...generation,
        sourceManifestArtifactId: manifest.id,
        sourceManifestDigest: prepared.manifest.digest,
        workspacePath: prepared.generationRoot
      });
      return {
        generation,
        plan: resolved.plan,
        generationRoot: prepared.generationRoot,
        sourcePath: prepared.sourcePath,
        markerDigest: prepared.markerDigest
      };
    } catch (error) {
      generation = await this.saveGeneration({
        ...generation,
        state: 'FAILED',
        failureReason: boundedError(error)
      });
      throw error;
    }
  }

  execute(prepared: PreparedPreviewGeneration): Promise<PreviewGenerationRecord> {
    return this.withGenerationLock(prepared.generation.id, async () => {
      let generation = prepared.generation;
      try {
        const running = await this.graph.start({
          taskId: generation.taskId,
          generationId: generation.id,
          generationRoot: prepared.generationRoot,
          sourcePath: prepared.sourcePath,
          markerDigest: prepared.markerDigest,
          plan: prepared.plan.executionPlan,
          updateGenerationState: async (state) => {
            generation = await this.saveGeneration({ ...generation, state });
          },
          onUnexpectedServiceExit: async (reason) => {
            await this.handleUnexpectedExit(generation.id, reason);
          }
        });
        this.live.set(generation.id, running);
        const routes = prepared.plan.executionPlan.routes.map((route) => {
          const targetPort = running.ports[route.port];
          const hostname = `${route.id}.${generation.previewKey}.preview.localhost`;
          this.gateway.setRoute(hostname, { host: '127.0.0.1', port: targetPort });
          return {
            id: route.id,
            hostname,
            url: `http://${hostname}:${this.requireGatewayPort()}/`,
            gatewayPort: this.requireGatewayPort(),
            targetHost: '127.0.0.1' as const,
            targetPort,
            state: 'ATTACHED' as const
          };
        });
        generation = await this.saveGeneration({
          ...generation,
          state: 'READY',
          routes,
          readyAt: new Date().toISOString()
        });
        return generation;
      } catch (error) {
        await this.cleanupFailedGeneration(generation, error);
        throw error;
      }
    });
  }

  stop(generationId: string): Promise<PreviewGenerationRecord> {
    return this.withGenerationLock(generationId, async () => {
      let generation = await this.requireGeneration(generationId);
      if (generation.state === 'STOPPED') return generation;
      generation = await this.saveGeneration({ ...generation, state: 'STOPPING' });
      this.detachRoutes(generation);
      let cleanupIncomplete = false;
      const live = this.live.get(generation.id);
      if (live) {
        const result = await live.stop().catch(() => 'REFUSED' as const);
        cleanupIncomplete = result === 'REFUSED';
        this.live.delete(generation.id);
      } else {
        for (const resource of await this.store.getPreviewResources(generation.id)) {
          if (['STOPPED', 'EXITED', 'FAILED'].includes(resource.state)) continue;
          const result = await this.nativeRuntime.stop(resource).catch(() => 'REFUSED' as const);
          if (result === 'REFUSED') cleanupIncomplete = true;
        }
      }
      if (!cleanupIncomplete) {
        try {
          await this.sourcePreparer.cleanupOwnedGeneration({
            taskId: generation.taskId,
            generationId: generation.id
          });
        } catch {
          cleanupIncomplete = true;
        }
      }
      generation = await this.saveGeneration({
        ...generation,
        routes: generation.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
        state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'STOPPED',
        cleanupReason: cleanupIncomplete
          ? 'One or more preview resources could not be verified for cleanup.'
          : 'Stopped by Task Monki.',
        stoppedAt: cleanupIncomplete ? undefined : new Date().toISOString()
      });
      return generation;
    });
  }

  open(input: OpenPreviewRequest): Promise<OpenPreviewResult> {
    return this.opener.open(input);
  }

  async readLog(input: ReadPreviewLogRequest): Promise<string> {
    const attempts = (await this.store.snapshot()).previewNodeAttempts.filter(
      (attempt) =>
        attempt.taskId === input.taskId &&
        (attempt.stdoutArtifactId === input.artifactId || attempt.stderrArtifactId === input.artifactId)
    );
    if (attempts.length === 0) throw new Error('Preview log artifact is not owned by this task.');
    return this.store.readArtifact(input.artifactId);
  }

  async observeGitSnapshot(snapshot: GitSnapshotRecord): Promise<void> {
    for (const generation of await this.store.getPreviewGenerations(snapshot.taskId)) {
      const freshness =
        generation.sourceHeadSha === snapshot.headSha &&
        generation.sourceDirtyFingerprint === snapshot.dirtyFingerprint
          ? 'CURRENT'
          : 'STALE';
      if (generation.freshness !== freshness) {
        await this.saveGeneration({ ...generation, freshness });
      }
    }
  }

  async stopTask(taskId: string): Promise<void> {
    for (const generation of await this.store.getPreviewGenerations(taskId)) {
      if (generation.state === 'STOPPED') continue;
      const stopped = await this.stop(generation.id);
      if (stopped.state === 'CLEANUP_INCOMPLETE') {
        throw new Error('Task preview cleanup is incomplete; task deletion was refused.');
      }
    }
  }

  async shutdown(): Promise<void> {
    const failures: string[] = [];
    for (const generation of await this.store.getPreviewGenerations()) {
      if (!['STOPPED', 'FAILED'].includes(generation.state)) {
        try {
          const stopped = await this.stop(generation.id);
          if (stopped.state === 'CLEANUP_INCOMPLETE') failures.push(stopped.id);
        } catch {
          failures.push(generation.id);
        }
      }
    }
    await this.gateway.close();
    if (failures.length > 0) {
      throw new Error(
        `Preview shutdown left ${failures.length} generation(s) with unverified cleanup residue.`
      );
    }
  }

  private async cleanupFailedGeneration(
    generation: PreviewGenerationRecord,
    error: unknown
  ): Promise<void> {
    const current = (await this.store.getPreviewGeneration(generation.id)) ?? generation;
    this.detachRoutes(current);
    let cleanupIncomplete = false;
    for (const resource of await this.store.getPreviewResources(current.id)) {
      if (['STOPPED', 'EXITED', 'FAILED'].includes(resource.state)) continue;
      if ((await this.nativeRuntime.stop(resource).catch(() => 'REFUSED' as const)) === 'REFUSED') {
        cleanupIncomplete = true;
      }
    }
    if (!cleanupIncomplete) {
      await this.sourcePreparer
        .cleanupOwnedGeneration({ taskId: current.taskId, generationId: current.id })
        .catch(() => {
          cleanupIncomplete = true;
        });
    }
    await this.saveGeneration({
      ...current,
      routes: current.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
      state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'FAILED',
      failureReason: boundedError(error),
      cleanupReason: cleanupIncomplete ? 'Failure cleanup could not verify every resource.' : undefined
    });
  }

  private async handleUnexpectedExit(generationId: string, reason: string): Promise<void> {
    const generation = await this.store.getPreviewGeneration(generationId);
    if (!generation || ['STOPPING', 'STOPPED'].includes(generation.state)) return;
    this.live.delete(generation.id);
    this.detachRoutes(generation);
    let cleanupIncomplete = false;
    await this.sourcePreparer
      .cleanupOwnedGeneration({ taskId: generation.taskId, generationId: generation.id })
      .catch(() => {
        cleanupIncomplete = true;
      });
    await this.saveGeneration({
      ...generation,
      routes: generation.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
      state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'FAILED',
      failureReason: reason,
      cleanupReason: cleanupIncomplete ? 'Service exit cleanup could not verify the workspace.' : undefined
    });
  }

  private detachRoutes(generation: PreviewGenerationRecord): void {
    for (const route of generation.routes) this.gateway.removeRoute(route.hostname);
  }

  private saveGeneration(generation: PreviewGenerationRecord): Promise<PreviewGenerationRecord> {
    const updated = { ...generation, updatedAt: new Date().toISOString() };
    return this.store.savePreviewGeneration(updated).then((stored) => {
      this.events.emit({
        type: 'preview.updated',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        previewGenerationId: stored.id,
        payload: stored,
        at: stored.updatedAt
      });
      return stored;
    });
  }

  private async requireGeneration(id: string): Promise<PreviewGenerationRecord> {
    const generation = await this.store.getPreviewGeneration(id);
    if (!generation) throw new Error(`Preview generation not found: ${id}`);
    return generation;
  }

  private requireGatewayPort(): number {
    if (!this.gatewayPort) throw new Error('Preview gateway is not initialized.');
    return this.gatewayPort;
  }

  private async withGenerationLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    this.locks.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(id) === operation) this.locks.delete(id);
    }
  }
}

function stablePreviewKey(taskId: string): string {
  const compact = taskId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  return `task-${compact || 'preview'}`;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}
