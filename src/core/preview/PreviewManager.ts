import { randomUUID } from 'node:crypto';
import type {
  GitSnapshotRecord,
  OpenPreviewRequest,
  OpenPreviewResult,
  PreviewApprovalRecord,
  PreviewGenerationRecord,
  PreviewPlanRecord,
  ReadPreviewLogRequest,
  ReadPreviewLogResult,
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
import { PreviewRecipeLoader, selectPreviewScenario } from './PreviewRecipeLoader';
import { PreviewReconciler } from './PreviewReconciler';
import { PreviewSourcePreparer, serializePreviewSourceManifest } from './PreviewSourcePreparer';
import { NativeServiceRuntime } from './runtime/NativeServiceRuntime';
import { PreviewOpenService } from './runtime/PreviewOpenService';
import { OciResourceRuntime } from './runtime/OciResourceRuntime';
import { PreviewJobCompletionAmbiguousError } from './runtime/NativeJobRunner';

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
  controller: AbortController;
}

export class PreviewManager {
  private readonly live = new Map<string, RunningPreviewGraph>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly startups = new Map<string, AbortController>();
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
    private readonly opener: PreviewOpenService,
    private readonly ociRuntime?: OciResourceRuntime
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

  async resolve(context: PreviewTaskContext, scenarioId?: string): Promise<ResolvePreviewResult> {
    const loaded = await this.recipeLoader.load(context.worktree.worktreePath);
    if (loaded.status === 'MISSING') return { status: 'UNAVAILABLE', reason: loaded.reason };
    const parsed = scenarioId
      ? selectPreviewScenario(loaded.parsed, scenarioId)
      : loaded.parsed;
    const candidate = await this.planResolver.resolve({ ...context, parsed });
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
  }, scenarioId?: string): Promise<PreparedPreviewGeneration> {
    const resolved = await this.resolve(input.context, scenarioId);
    if (resolved.status !== 'PLAN') throw new Error(resolved.reason);
    const approval = await this.approvalPolicy.requireMatching(resolved.plan);
    const sourceHeadSha = input.gitSnapshot.headSha;
    const sourceDirtyFingerprint = input.gitSnapshot.dirtyFingerprint;
    if (!sourceHeadSha || !sourceDirtyFingerprint) {
      throw new Error('Preview source capture requires complete Git HEAD and dirty fingerprint evidence.');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const replaced = (await this.store.getPreviewGenerations(input.context.task.id)).find(
      (candidate) => candidate.routingState === 'ACTIVE' && candidate.state === 'READY'
    );
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
      routingState: 'CANDIDATE',
      replacesGenerationId: replaced?.id,
      freshness: 'CURRENT',
      routes: [],
      createdAt: now,
      updatedAt: now
    };
    generation = await this.store.savePreviewGeneration(generation);
    const controller = new AbortController();
    this.startups.set(generation.id, controller);
    return this.withGenerationLock(generation.id, async () => {
      generation = await this.saveGeneration({ ...generation, state: 'PREPARING_SOURCE' });
      let prepared: Awaited<ReturnType<PreviewSourcePreparer['prepare']>> | undefined;
      try {
        prepared = await this.sourcePreparer.prepare({
          repositoryPath: input.context.worktree.worktreePath,
          taskId: generation.taskId,
          generationId: generation.id,
          expectedHeadSha: sourceHeadSha
        });
        throwIfStartupCanceled(controller.signal);
        const observed = await input.reobserveGit();
        throwIfStartupCanceled(controller.signal);
        if (
          observed.headSha !== sourceHeadSha ||
          observed.dirtyFingerprint !== sourceDirtyFingerprint
        ) {
          throw new Error('Git evidence changed while the preview source was being prepared.');
        }
        const manifest = await this.store.writeTextArtifact(
          generation.taskId,
          'preview-source-manifest',
          serializePreviewSourceManifest(prepared.manifest)
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
          markerDigest: prepared.markerDigest,
          controller
        };
      } catch (error) {
        let cleanupIncomplete = false;
        if (prepared) {
          await this.sourcePreparer
            .cleanupOwnedGeneration({
              taskId: generation.taskId,
              generationId: generation.id
            })
            .catch(() => {
              cleanupIncomplete = true;
            });
        }
        generation = await this.saveGeneration({
          ...generation,
          state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'FAILED',
          failureReason: boundedError(error),
          cleanupReason: cleanupIncomplete
            ? 'Source preparation failure cleanup could not verify the workspace.'
            : undefined
        });
        await this.store.prunePreviewHistory(generation.taskId);
        if (this.startups.get(generation.id) === controller) this.startups.delete(generation.id);
        throw error;
      }
    });
  }

  execute(prepared: PreparedPreviewGeneration): Promise<PreviewGenerationRecord> {
    const controller = prepared.controller;
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
          routeOrigins: Object.fromEntries(
            prepared.plan.executionPlan.routes.map((route) => {
              const hostname = `${route.id}.${generation.previewKey}.preview.localhost`;
              return [route.id, `http://${hostname}:${this.requireGatewayPort()}`];
            })
          ),
          ociEngineIdentity: prepared.plan.ociCapability?.identity,
          signal: controller.signal,
          updateGenerationState: async (state) => {
            generation = await this.saveGeneration({ ...generation, state });
          }
        });
        this.live.set(generation.id, running);
        void running.unexpectedExit
          .then((reason) => {
            if (!reason) return;
            return this.withGenerationLock(generation.id, () =>
              this.handleUnexpectedExit(generation.id, reason)
            );
          })
          .catch(() => undefined);
        if (!running.isRunning()) {
          throw new Error('Preview service exited before gateway routes could be attached.');
        }
        const routes = prepared.plan.executionPlan.routes.map((route) => {
          const targetPort = running.ports[route.service]?.[route.port];
          if (!targetPort) throw new Error(`Preview route ${route.id} target port is unavailable.`);
          const hostname = `${route.id}.${generation.previewKey}.preview.localhost`;
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
        if (!running.isRunning()) {
          throw new Error('Preview service exited before READY could be committed.');
        }
        const cutoverAt = new Date().toISOString();
        const candidate: PreviewGenerationRecord = {
          ...generation,
          state: 'READY',
          routingState: 'ACTIVE' as const,
          routes,
          readyAt: cutoverAt,
          cutoverAt,
          updatedAt: cutoverAt
        };
        const replaced = generation.replacesGenerationId
          ? await this.store.getPreviewGeneration(generation.replacesGenerationId)
          : undefined;
        this.gateway.replaceRoutes(
          generation.id,
          Object.fromEntries(routes.map((route) => [route.hostname, { host: route.targetHost, port: route.targetPort }])),
          replaced?.id
        );
        try {
          const cutover = await this.store.cutoverPreviewGenerations({
            candidate,
            replaced: replaced
              ? {
                  ...replaced,
                  routingState: 'RETIRED',
                  routes: replaced.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
                  updatedAt: cutoverAt
                }
              : undefined
          });
          generation = cutover.candidate;
          this.emitGeneration(generation);
          if (cutover.replaced) this.emitGeneration(cutover.replaced);
        } catch (error) {
          if (replaced) this.restoreRoutes(replaced, generation.id);
          else this.gateway.removeOwnedRoutes(generation.id);
          throw error;
        }
        if (replaced) await this.stop(replaced.id).catch(() => undefined);
        return generation;
      } catch (error) {
        await this.cleanupFailedGeneration(generation, error);
        throw error;
      }
    }).finally(() => {
      if (this.startups.get(prepared.generation.id) === controller) {
        this.startups.delete(prepared.generation.id);
      }
    });
  }

  stop(generationId: string): Promise<PreviewGenerationRecord> {
    this.startups.get(generationId)?.abort();
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
          if (resource.state === 'STOPPED') continue;
          if (resource.adapterKind === 'NATIVE_PROCESS' && ['EXITED', 'FAILED'].includes(resource.state)) continue;
          const result = resource.adapterKind === 'NATIVE_PROCESS'
            ? await this.nativeRuntime.stop(resource).catch(() => 'REFUSED' as const)
            : this.ociRuntime
              ? await this.ociRuntime.stop(resource).catch(() => 'REFUSED' as const)
              : 'REFUSED';
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
        routingState: 'RETIRED',
        state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'STOPPED',
        cleanupReason: cleanupIncomplete
          ? 'One or more preview resources could not be verified for cleanup.'
          : 'Stopped by Task Monki.',
        stoppedAt: cleanupIncomplete ? undefined : new Date().toISOString()
      });
      await this.store.prunePreviewHistory(generation.taskId);
      return generation;
    });
  }

  open(input: OpenPreviewRequest): Promise<OpenPreviewResult> {
    return this.opener.open(input);
  }

  async readLog(input: ReadPreviewLogRequest): Promise<ReadPreviewLogResult> {
    if (!(await this.store.isPreviewLogArtifactOwned(input.taskId, input.artifactId))) {
      throw new Error('Preview log artifact is not owned by this task.');
    }
    return this.store.readArtifactRange(input.artifactId, input.offset, input.maxBytes);
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
    if (await this.ociRuntime?.cleanupTaskResources(taskId) === 'REFUSED') {
      throw new Error('Task preview OCI cleanup is incomplete; task deletion was refused.');
    }
  }

  async resetData(input: {
    taskId: string;
    generationId: string;
    resourceId: string;
    scenarioId: string;
  }): Promise<void> {
    if (!this.ociRuntime) throw new Error('OCI preview resources are unavailable.');
    const generation = await this.requireGeneration(input.generationId);
    if (generation.taskId !== input.taskId) {
      throw new Error('Preview generation was not found for this task.');
    }
    const plan = await this.store.getPreviewPlan(generation.planId);
    if (!plan || plan.executionPlan.selectedScenarioId !== input.scenarioId) {
      throw new Error('Preview reset scenario does not match the approved generation.');
    }
    const scenario = plan.executionPlan.scenarios.find((candidate) => candidate.id === input.scenarioId);
    const resource = plan.executionPlan.resources.find((candidate) => candidate.id === input.resourceId);
    if (!scenario?.resources.includes(input.resourceId) || !resource) {
      throw new Error('Preview reset resource is not part of the approved scenario.');
    }
    if (resource.type === 'oci' && !resource.dataMount) {
      throw new Error('Preview resource has no owned data volume to reset.');
    }
    if (!['STOPPED', 'FAILED'].includes(generation.state)) {
      await this.ociRuntime.prepareDataReset(generation.id);
      await this.stop(generation.id);
    }
    const reset = await this.ociRuntime.resetDataResource(input.taskId, input.resourceId);
    if (reset === 'REFUSED') {
      throw new Error(`Preview data reset could not verify ${input.resourceId} ownership.`);
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
    if (await this.ociRuntime?.cleanupTaskResources() === 'REFUSED') {
      failures.push('preview-scoped-oci-resources');
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
    const nonRetryableMigrationAmbiguity =
      error instanceof PreviewJobCompletionAmbiguousError &&
      error.role === 'migration' &&
      !error.retrySafe;
    this.detachRoutes(current);
    let cleanupIncomplete = false;
    const live = this.live.get(current.id);
    if (live) {
      const result = await live.stop().catch(() => 'REFUSED' as const);
      if (result === 'REFUSED') cleanupIncomplete = true;
      this.live.delete(current.id);
    } else {
      for (const resource of await this.store.getPreviewResources(current.id)) {
        if (resource.state === 'STOPPED') continue;
        if (resource.adapterKind === 'NATIVE_PROCESS' && ['EXITED', 'FAILED'].includes(resource.state)) continue;
        const result = resource.adapterKind === 'NATIVE_PROCESS'
          ? await this.nativeRuntime.stop(resource).catch(() => 'REFUSED' as const)
          : this.ociRuntime
            ? await this.ociRuntime.stop(resource).catch(() => 'REFUSED' as const)
            : 'REFUSED';
        if (result === 'REFUSED') {
          cleanupIncomplete = true;
        }
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
      state: cleanupIncomplete
        ? 'CLEANUP_INCOMPLETE'
        : nonRetryableMigrationAmbiguity
          ? 'RECOVERY_REQUIRED'
          : 'FAILED',
      failureReason: boundedError(error),
      cleanupReason: cleanupIncomplete ? 'Failure cleanup could not verify every resource.' : undefined
    });
    await this.store.prunePreviewHistory(current.taskId);
  }

  private async handleUnexpectedExit(generationId: string, reason: string): Promise<void> {
    const generation = await this.store.getPreviewGeneration(generationId);
    if (!generation || ['STOPPING', 'STOPPED'].includes(generation.state)) return;
    this.detachRoutes(generation);
    let cleanupIncomplete = false;
    const live = this.live.get(generation.id);
    if (live) {
      const result = await live.stop().catch(() => 'REFUSED' as const);
      if (result === 'REFUSED') cleanupIncomplete = true;
      this.live.delete(generation.id);
    }
    if (!cleanupIncomplete) {
      await this.sourcePreparer
        .cleanupOwnedGeneration({ taskId: generation.taskId, generationId: generation.id })
        .catch(() => {
          cleanupIncomplete = true;
        });
    }
    await this.saveGeneration({
      ...generation,
      routes: generation.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
      routingState: generation.routingState === 'ACTIVE' ? 'RETIRED' : generation.routingState,
      state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'FAILED',
      failureReason: reason,
      cleanupReason: cleanupIncomplete ? 'Service exit cleanup could not verify the workspace.' : undefined
    });
    await this.store.prunePreviewHistory(generation.taskId);
  }

  private detachRoutes(generation: PreviewGenerationRecord): void {
    this.gateway.removeOwnedRoutes(generation.id);
  }

  private restoreRoutes(generation: PreviewGenerationRecord, replacesGenerationId: string): void {
    this.gateway.replaceRoutes(
      generation.id,
      Object.fromEntries(
        generation.routes
          .filter((route) => route.state === 'ATTACHED')
          .map((route) => [route.hostname, { host: route.targetHost, port: route.targetPort }])
      ),
      replacesGenerationId
    );
  }

  private emitGeneration(stored: PreviewGenerationRecord): void {
    this.events.emit({
      type: 'preview.updated',
      taskId: stored.taskId,
      iterationId: stored.iterationId,
      worktreeId: stored.worktreeId,
      previewGenerationId: stored.id,
      payload: stored,
      at: stored.updatedAt
    });
  }

  private saveGeneration(generation: PreviewGenerationRecord): Promise<PreviewGenerationRecord> {
    const updated = { ...generation, updatedAt: new Date().toISOString() };
    return this.store.savePreviewGeneration(updated).then((stored) => {
      this.emitGeneration(stored);
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

function throwIfStartupCanceled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Preview startup canceled.');
  error.name = 'AbortError';
  throw error;
}
