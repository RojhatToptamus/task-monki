import { randomUUID } from 'node:crypto';
import type {
  GitSnapshotRecord,
  OpenPreviewRequest,
  OpenPreviewResult,
  PreviewApprovalRecord,
  PreviewComposeInspection,
  PreviewGenerationRecord,
  PreviewLocalAttachmentBindingRecord,
  PreviewResolvedAttachmentTarget,
  PreviewPlanRecord,
  PreviewPrivateInputOperationResult,
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
import { cleanupPreviewGenerationRuntime } from './PreviewGenerationCleanup';
import { PreviewGraph, type RunningPreviewGraph } from './PreviewGraph';
import { PreviewPlanResolver } from './PreviewPlanResolver';
import { PreviewLocalBindingRequiredError } from './PreviewPlanResolver';
import { PreviewRecipeLoader, selectPreviewScenario } from './PreviewRecipeLoader';
import { PreviewReconciler } from './PreviewReconciler';
import { PreviewSourcePreparer, serializePreviewSourceManifest } from './PreviewSourcePreparer';
import { NativeServiceRuntime } from './runtime/NativeServiceRuntime';
import { PreviewOpenService } from './runtime/PreviewOpenService';
import { OciResourceRuntime } from './runtime/OciResourceRuntime';
import { PreviewJobCompletionAmbiguousError } from './runtime/NativeJobRunner';
import { activePreviewInputIds } from './PreviewRecipeLoader';
import { PreviewPrivateVault, type PreviewPrivateLease } from './private/PreviewPrivateVault';
import {
  PreviewComposeActivationError,
  PreviewComposeResetRequiredError,
  PreviewComposeRuntime
} from './compose/PreviewComposeRuntime';

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
  setupRetryResourceIds?: string[];
  privateLease?: PreviewPrivateLease;
}

export class PreviewManager {
  private readonly live = new Map<string, RunningPreviewGraph>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly startups = new Map<string, AbortController>();
  private readonly resourceHealthStops = new Map<string, () => Promise<void>>();
  private gatewayPort: number | undefined;
  private lifecycle: 'NEW' | 'INITIALIZING' | 'READY' | 'SHUTTING_DOWN' | 'STOPPED' = 'NEW';
  private initWork?: Promise<{ port: number; relocated: boolean }>;
  private shutdownWork?: Promise<void>;

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
    private readonly ociRuntime?: OciResourceRuntime,
    private readonly privateVault?: PreviewPrivateVault,
    private readonly composeRuntime?: PreviewComposeRuntime
  ) {}

  init(
    preferredGatewayPort = 0,
    options: { reconcile?: boolean } = {}
  ): Promise<{ port: number; relocated: boolean }> {
    if (this.lifecycle === 'READY') {
      return Promise.resolve({ port: this.requireGatewayPort(), relocated: false });
    }
    if (this.initWork) return this.initWork;
    if (this.lifecycle === 'SHUTTING_DOWN' || this.lifecycle === 'STOPPED') {
      return Promise.reject(new Error('Preview runtime is shutting down.'));
    }
    this.lifecycle = 'INITIALIZING';
    const operation = this.initialize(preferredGatewayPort, options).finally(() => {
      if (this.initWork === operation) this.initWork = undefined;
    });
    this.initWork = operation;
    return operation;
  }

  async resolve(context: PreviewTaskContext, scenarioId?: string): Promise<ResolvePreviewResult> {
    this.assertAcceptingWork();
    const loaded = await this.recipeLoader.load(context.worktree.worktreePath);
    if (loaded.status === 'MISSING') return { status: 'UNAVAILABLE', reason: loaded.reason };
    const parsed = scenarioId
      ? selectPreviewScenario(loaded.parsed, scenarioId)
      : loaded.parsed;
    let candidate: PreviewPlanRecord;
    try {
      candidate = await this.planResolver.resolve({ ...context, parsed });
    } catch (error) {
      if (error instanceof PreviewLocalBindingRequiredError) {
        return {
          status: 'CONFIGURATION_REQUIRED',
          reason: error.message,
          attachmentIds: error.attachmentIds
        };
      }
      throw error;
    }
    const latest = await this.store.getLatestPreviewPlan(context.task.id);
    const active = (await this.store.getPreviewGenerations(context.task.id)).find(
      (generation) => generation.routingState === 'ACTIVE' && generation.state === 'READY'
    );
    if (active && (active.adapter ?? 'NATIVE') !== (candidate.executionPlan.adapter ?? 'NATIVE')) {
      throw new Error('Stop the current preview before switching between native and Compose adapters.');
    }
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
    const inputIds = activePreviewInputIds(plan.executionPlan);
    const blockers = inputIds.length
      ? this.privateVault
        ? await this.privateVault.readiness(context.task.id, inputIds)
        : inputIds.map((inputId) => ({ kind: 'PROTECTION_UNAVAILABLE' as const, inputId }))
      : [];
    return {
      status: 'PLAN',
      plan,
      approval,
      executionReadiness: { status: blockers.length ? 'BLOCKED' : 'READY', blockers }
    };
  }

  async setPrivateInput(taskId: string, inputId: string, value: string): Promise<PreviewPrivateInputOperationResult> {
    this.assertAcceptingWork();
    if (!value || Buffer.byteLength(value, 'utf8') > 8_192 || value.includes('\0')) return { status: 'FAILED', code: 'INVALID_VALUE' };
    if (!this.privateVault) return { status: 'FAILED', code: 'PROTECTION_UNAVAILABLE' };
    const declared = await this.isPrivateInputDeclared(taskId, inputId);
    if (!declared) return { status: 'FAILED', code: 'INPUT_NOT_DECLARED' };
    const result = await this.privateVault.set(taskId, inputId, value);
    return result === 'STORED' ? { status: 'STORED' } : { status: 'FAILED', code: result };
  }

  async deletePrivateInput(taskId: string, inputId: string): Promise<PreviewPrivateInputOperationResult> {
    this.assertAcceptingWork();
    if (!this.privateVault) return { status: 'FAILED', code: 'PROTECTION_UNAVAILABLE' };
    await this.privateVault.remove(taskId, inputId);
    return { status: 'DELETED' };
  }

  async retryPrivateVaultCleanup() {
    return { status: await this.sweepPrivateVault() };
  }

  async retireDeletedTaskPrivateInputs(taskId: string): Promise<void> {
    await this.privateVault?.retireTask(taskId);
  }

  approve(input: { taskId: string; planId: string; executionDigest: string }): Promise<PreviewApprovalRecord> {
    this.assertAcceptingWork();
    return this.approvalPolicy.approve(input);
  }

  async setLocalAttachmentBinding(input: {
    context: PreviewTaskContext;
    taskId: string;
    attachmentId: string;
    target: PreviewResolvedAttachmentTarget;
  }): Promise<PreviewLocalAttachmentBindingRecord> {
    this.assertAcceptingWork();
    const loaded = await this.recipeLoader.load(input.context.worktree.worktreePath);
    if (loaded.status !== 'LOADED') throw new Error(loaded.reason);
    const attachment = (loaded.parsed.executionPlan.attachments ?? []).find(
      (candidate) => candidate.id === input.attachmentId
    );
    if (!attachment || attachment.target.type !== 'local') {
      throw new Error('Preview attachment does not declare a local target binding.');
    }
    validateLocalAttachmentTarget(input.taskId, attachment.type, input.target);
    const existing = await this.store.getPreviewLocalBinding(input.taskId, input.attachmentId);
    const now = new Date().toISOString();
    const binding = await this.store.savePreviewLocalBinding({
      id: existing?.id ?? randomUUID(),
      taskId: input.taskId,
      attachmentId: input.attachmentId,
      target: structuredClone(input.target),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    this.events.emit({
      type: 'preview.updated', taskId: input.taskId, payload: binding, at: now
    });
    return binding;
  }

  async deleteLocalAttachmentBinding(input: {
    context: PreviewTaskContext;
    taskId: string;
    attachmentId: string;
  }): Promise<void> {
    this.assertAcceptingWork();
    const loaded = await this.recipeLoader.load(input.context.worktree.worktreePath);
    if (loaded.status === 'LOADED') {
      const attachment = (loaded.parsed.executionPlan.attachments ?? []).find(
        (candidate) => candidate.id === input.attachmentId
      );
      if (attachment && attachment.target.type !== 'local') {
        throw new Error('Literal preview attachment targets do not have local bindings.');
      }
    }
    await this.store.deletePreviewLocalBinding(input.taskId, input.attachmentId);
    this.events.emit({
      type: 'preview.updated', taskId: input.taskId,
      payload: { attachmentId: input.attachmentId, deleted: true }, at: new Date().toISOString()
    });
  }

  async prepare(input: {
    context: PreviewTaskContext;
    gitSnapshot: GitSnapshotRecord;
    reobserveGit(): Promise<GitSnapshotRecord>;
  }, scenarioId?: string, setupRetryResourceIds?: string[]): Promise<PreparedPreviewGeneration> {
    this.assertAcceptingWork();
    const resolved = await this.resolve(input.context, scenarioId);
    this.assertAcceptingWork();
    if (resolved.status !== 'PLAN') throw new Error(resolved.reason);
    const approval = await this.approvalPolicy.requireMatching(resolved.plan);
    const requiredInputs = activePreviewInputIds(resolved.plan.executionPlan);
    let privateLease: PreviewPrivateLease | undefined;
    if (requiredInputs.length) {
      const acquired = this.privateVault
        ? await this.privateVault.acquire(input.context.task.id, requiredInputs)
        : requiredInputs.map((inputId) => ({ kind: 'PROTECTION_UNAVAILABLE' as const, inputId }));
      if (Array.isArray(acquired)) {
        throw new Error(`Preview execution is blocked: ${acquired.map((blocker) => `${blocker.kind}:${blocker.inputId}`).join(', ')}.`);
      }
      privateLease = acquired;
    }
    const sourceHeadSha = input.gitSnapshot.headSha;
    const sourceDirtyFingerprint = input.gitSnapshot.dirtyFingerprint;
    if (!sourceHeadSha || !sourceDirtyFingerprint) {
      await privateLease?.release();
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
      adapter: resolved.plan.executionPlan.adapter ?? 'NATIVE',
      sourceGitSnapshotId: input.gitSnapshot.id,
      sourceHeadSha,
      sourceDirtyFingerprint,
      workspacePath: this.sourcePreparer.getGenerationPath(input.context.task.id, id),
      state: 'CREATED',
      routingState: 'CANDIDATE',
      replacesGenerationId: replaced?.id,
      freshness: 'CURRENT',
      routes: [],
      attachmentReadiness: [],
      createdAt: now,
      updatedAt: now
    };
    const controller = new AbortController();
    this.startups.set(id, controller);
    try {
      if (privateLease) {
        await this.privateVault?.retainGeneration(id, input.context.task.id, privateLease.revisions);
      }
    } catch (error) {
      if (this.startups.get(id) === controller) this.startups.delete(id);
      await privateLease?.release();
      await this.privateVault?.releaseGeneration(id).catch(() => undefined);
      throw error;
    }
    generation = await this.store.savePreviewGeneration(generation).catch(async (error) => {
      if (this.startups.get(id) === controller) this.startups.delete(id);
      await privateLease?.release();
      await this.privateVault?.releaseGeneration(id);
      throw error;
    });
    if (controller.signal.aborted || this.lifecycle !== 'READY') {
      generation = await this.saveGeneration({
        ...generation,
        state: 'STOPPED',
        routingState: 'RETIRED',
        cleanupReason: 'Preview startup was canceled before source preparation.',
        stoppedAt: new Date().toISOString()
      });
      if (this.startups.get(id) === controller) this.startups.delete(id);
      await privateLease?.release();
      await this.privateVault?.releaseGeneration(id);
      throwIfStartupCanceled(controller.signal);
      throw new Error('Preview runtime is shutting down.');
    }
    return this.withGenerationLock(generation.id, async () => {
      throwIfStartupCanceled(controller.signal);
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
          controller,
          privateLease,
          setupRetryResourceIds
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
        await privateLease?.release();
        await this.privateVault?.releaseGeneration(generation.id);
        throw error;
      }
    });
  }

  execute(prepared: PreparedPreviewGeneration): Promise<PreviewGenerationRecord> {
    this.assertAcceptingWork();
    if (prepared.plan.executionPlan.adapter === 'COMPOSE') {
      return this.executeCompose(prepared);
    }
    const controller = prepared.controller;
    return this.withGenerationLock(prepared.generation.id, async () => {
      let generation = prepared.generation;
      let setupResourceIds: string[] = [];
      let setupCompleted = false;
      let oldExclusiveHandedOff = false;
      try {
        const scenario = prepared.plan.executionPlan.scenarios.find(
          (candidate) => candidate.id === prepared.plan.executionPlan.selectedScenarioId
        );
        if (!scenario) throw new Error('Selected preview scenario is missing.');
        const activeResourceIds = new Set(scenario.resources);
        const resourcePlans = prepared.plan.executionPlan.resources.filter((resource) => activeResourceIds.has(resource.id));
        const managed = resourcePlans.length > 0
          ? await this.requireOciRuntime().ensureManagedPreview({
              taskId: generation.taskId,
              previewKey: generation.previewKey,
              markerDigest: generation.previewKey,
              expectedEngine: this.requireOciEngine(prepared.plan),
              resources: resourcePlans,
              retrySetupResourceIds: prepared.setupRetryResourceIds,
              signal: controller.signal
            })
          : undefined;
        setupResourceIds = managed?.setupResourceIds ?? [];
        if (managed) {
          await this.store.savePreviewGenerationAttachments(
            managed.resources.map((resource) => ({
              id: randomUUID(),
              taskId: generation.taskId,
              generationId: generation.id,
              managedResourceId: resource.id,
              logicalResourceId: resource.logicalResourceId,
              bindingId: resource.binding!.id,
              attachedAt: new Date().toISOString()
            }))
          );
        }
        const replacedGraph = generation.replacesGenerationId
          ? this.live.get(generation.replacesGenerationId)
          : undefined;
        const running = await this.graph.start({
          taskId: generation.taskId,
          generationId: generation.id,
          generationRoot: prepared.generationRoot,
          sourcePath: prepared.sourcePath,
          markerDigest: prepared.markerDigest,
          plan: prepared.plan.executionPlan,
          resourceBindings: managed?.bindings,
          privateBindings: prepared.privateLease?.values,
          attachmentGatewayPort: this.requireGatewayPort(),
          releaseBindings: async () => { await prepared.privateLease?.release(); await this.privateVault?.releaseGeneration(generation.id); },
          onAttachmentEvidence: async (evidence) => {
            generation = await this.saveGeneration({
              ...generation,
              attachmentReadiness: [
                ...(generation.attachmentReadiness ?? []).filter((item) => item.attachmentId !== evidence.attachmentId),
                evidence
              ]
            });
          },
          runSetup: setupResourceIds.length > 0,
          onSetupComplete: async () => {
            await this.requireOciRuntime().markSetupReady(setupResourceIds);
            setupCompleted = true;
          },
          beforeExclusiveStart: replacedGraph
            ? async () => {
                const stopped = await replacedGraph.stopExclusive();
                if (stopped === 'REFUSED') {
                  throw new Error('Old exclusive preview nodes could not be stopped safely.');
                }
                oldExclusiveHandedOff = stopped === 'STOPPED';
              }
            : undefined,
          routeOrigins: Object.fromEntries(
            prepared.plan.executionPlan.routes.map((route) => {
              const hostname = `${route.id}.${generation.previewKey}.preview.localhost`;
              return [route.id, `http://${hostname}:${this.requireGatewayPort()}`];
            })
          ),
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
        await this.startResourceHealthWatch(
          generation.taskId,
          generation.id,
          managed?.resources.map((resource) => resource.id) ?? []
        );
        if (replaced) await this.stopApplicationGeneration(replaced.id).catch(() => undefined);
        return generation;
      } catch (error) {
        if (setupResourceIds.length > 0 && !setupCompleted) {
          const ambiguous =
            error instanceof PreviewJobCompletionAmbiguousError && !error.retrySafe;
          await this.requireOciRuntime().markSetupFailure(setupResourceIds, {
            ambiguous,
            reason: boundedError(error)
          });
        }
        if (oldExclusiveHandedOff && generation.replacesGenerationId) {
          const oldGraph = this.live.get(generation.replacesGenerationId);
          const restored = await oldGraph?.restoreExclusive() ?? false;
          if (!restored) await this.failAndDetachGeneration(
            generation.replacesGenerationId,
            'The previous preview could not restore and reverify its exclusive nodes within their declared readiness deadline.'
          );
        }
        await this.cleanupFailedGeneration(generation, error);
        throw error;
      }
    }).finally(() => {
      if (this.startups.get(prepared.generation.id) === controller) {
        this.startups.delete(prepared.generation.id);
      }
    });
  }

  private executeCompose(prepared: PreparedPreviewGeneration): Promise<PreviewGenerationRecord> {
    const controller = prepared.controller;
    return this.withGenerationLock(prepared.generation.id, async () => {
      let generation = prepared.generation;
      const compose = prepared.plan.executionPlan.compose;
      const approvedInspection = compose?.inspection;
      if (!compose || !approvedInspection) {
        throw new Error('Approved Compose inspection is missing.');
      }
      const runtime = this.requireComposeRuntime();
      const replaced = generation.replacesGenerationId
        ? await this.store.getPreviewGeneration(generation.replacesGenerationId)
        : undefined;
      const previousPlan = replaced ? await this.store.getPreviewPlan(replaced.planId) : undefined;
      let previousInspection = previousPlan?.executionPlan.adapter === 'COMPOSE'
        ? previousPlan.executionPlan.compose?.inspection
        : undefined;
      let activationStarted = false;
      try {
        previousInspection ??= await this.findComposeProjectInspection(
          generation.taskId,
          generation.id
        );
        generation = await this.saveGeneration({ ...generation, state: 'RUNNING_GRAPH' });
        const applied = await runtime.apply({
          taskId: generation.taskId,
          previewKey: generation.previewKey,
          generationId: generation.id,
          sourcePath: prepared.sourcePath,
          generationRoot: prepared.generationRoot,
          markerDigest: prepared.markerDigest,
          plan: compose,
          approvedInspection,
          previousInspection,
          expectedEngine: this.requireOciEngine(prepared.plan),
          signal: controller.signal,
          beforeActivation: async () => {
            if (replaced) {
              const detached = await this.saveGeneration({
                ...replaced,
                routes: replaced.routes.map((route) => ({ ...route, state: 'DETACHED' as const }))
              });
              this.detachRoutes(detached);
            }
            activationStarted = true;
          }
        });
        const routes = prepared.plan.executionPlan.routes.map((route) => {
          const targetPort = applied.ports[route.service]?.[route.port];
          if (!targetPort) throw new Error(`Compose route ${route.id} target port is unavailable.`);
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
        const cutoverAt = new Date().toISOString();
        const candidate: PreviewGenerationRecord = {
          ...generation,
          composeChange: applied.change,
          state: 'READY',
          routingState: 'ACTIVE',
          routes,
          readyAt: cutoverAt,
          cutoverAt,
          updatedAt: cutoverAt
        };
        this.gateway.replaceRoutes(
          generation.id,
          Object.fromEntries(routes.map((route) => [route.hostname, {
            host: route.targetHost,
            port: route.targetPort
          }])),
          replaced?.id
        );
        let cutover: Awaited<ReturnType<FileTaskStore['cutoverPreviewGenerations']>>;
        try {
          cutover = await this.store.cutoverPreviewGenerations({
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
        } catch (error) {
          this.gateway.removeOwnedRoutes(generation.id);
          throw error;
        }
        generation = cutover.candidate;
        this.emitGeneration(generation);
        if (cutover.replaced) {
          this.emitGeneration(cutover.replaced);
          await this.stopApplicationGeneration(cutover.replaced.id).catch(() => undefined);
        }
        await runtime.watch(generation.taskId, async (reason) => {
          await this.withGenerationLock(generation.id, async () => {
            const current = await this.store.getPreviewGeneration(generation.id);
            if (!current || current.state !== 'READY') return;
            this.detachRoutes(current);
            const composeCleanupIncomplete =
              await runtime.cleanupTask(current.taskId, { deleteData: false }) === 'REFUSED';
            const cleanupIncomplete = composeCleanupIncomplete
              ? true
              : await this.cleanupApplicationRuntime(current);
            await this.saveGeneration({
              ...current,
              routes: current.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
              routingState: 'RETIRED',
              state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'FAILED',
              failureReason: reason,
              cleanupReason: cleanupIncomplete
                ? 'Compose failure cleanup could not verify captured-source removal.'
                : undefined
            });
          });
        });
        return generation;
      } catch (error) {
        if (error instanceof PreviewComposeResetRequiredError) {
          const cleanupIncomplete = await this.cleanupApplicationRuntime(generation);
          await this.saveGeneration({
            ...generation,
            composeChange: 'DESTRUCTIVE_RESET_REQUIRED',
            state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'RECOVERY_REQUIRED',
            failureReason: error.message,
            cleanupReason: cleanupIncomplete
              ? 'Compose reset-required candidate workspace cleanup is incomplete.'
              : undefined
          });
          throw error;
        }
        const changedProject = activationStarted ||
          (error instanceof PreviewComposeActivationError && error.activationStarted);
        let composeCleanupIncomplete = error instanceof PreviewComposeActivationError
          ? error.cleanupIncomplete
          : false;
        if (changedProject && !(error instanceof PreviewComposeActivationError)) {
          composeCleanupIncomplete =
            await runtime.cleanupTask(generation.taskId, { deleteData: false }) === 'REFUSED';
        }
        if (changedProject && replaced) {
          const cleanupIncomplete = composeCleanupIncomplete
            ? true
            : await this.cleanupApplicationRuntime(replaced);
          await this.saveGeneration({
            ...replaced,
            routes: replaced.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
            routingState: 'RETIRED',
            state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'FAILED',
            failureReason: 'Compose replacement changed the stable project but did not reach readiness.',
            cleanupReason: cleanupIncomplete
              ? 'Compose replacement cleanup is incomplete; captured source was retained.'
              : undefined
          });
        }
        if (changedProject) {
          const cleanupIncomplete = composeCleanupIncomplete
            ? true
            : await this.cleanupApplicationRuntime(generation);
          await this.saveGeneration({
            ...generation,
            routes: generation.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
            routingState: 'RETIRED',
            state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'RECOVERY_REQUIRED',
            failureReason: error instanceof Error ? error.message : 'Compose activation failed.',
            cleanupReason: cleanupIncomplete
              ? 'Compose activation cleanup is incomplete; captured source was retained.'
              : undefined
          });
          throw error;
        }
        await this.cleanupFailedGeneration(generation, error);
        throw error;
      }
    }).finally(() => {
      if (this.startups.get(prepared.generation.id) === controller) {
        this.startups.delete(prepared.generation.id);
      }
    });
  }

  async stop(generationId: string): Promise<PreviewGenerationRecord> {
    const generation = await this.requireGeneration(generationId);
    this.startups.get(generationId)?.abort();
    const cancelingCandidate =
      generation.routingState === 'CANDIDATE' &&
      Boolean(generation.replacesGenerationId) &&
      !['FAILED', 'RECOVERY_REQUIRED', 'STOPPED'].includes(generation.state);
    if (cancelingCandidate) return this.stopApplicationGeneration(generationId);

    await this.stopResourceHealthWatch(generation.taskId);
    await this.composeRuntime?.stopWatch(generation.taskId);
    const stoppingCompose = (generation.adapter ?? 'NATIVE') === 'COMPOSE';
    if (stoppingCompose && this.composeRuntime) {
      for (const taskGeneration of await this.store.getPreviewGenerations(generation.taskId)) {
        this.detachRoutes(taskGeneration);
      }
      if (await this.composeRuntime.cleanupTask(generation.taskId, { deleteData: true }) === 'REFUSED') {
        return this.saveGeneration({
          ...generation,
          routes: generation.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
          state: 'CLEANUP_INCOMPLETE',
          cleanupReason: 'Compose preview project cleanup is incomplete; captured source was retained.'
        });
      }
    }
    let stopped = await this.stopApplicationGeneration(generationId);
    for (const candidate of await this.store.getPreviewGenerations(generation.taskId)) {
      if (candidate.id === generationId || ['STOPPED', 'FAILED'].includes(candidate.state)) continue;
      const result = await this.stopApplicationGeneration(candidate.id);
      if (result.state === 'CLEANUP_INCOMPLETE') stopped = result;
    }
    if (this.ociRuntime && await this.ociRuntime.cleanupTaskResources(generation.taskId) === 'REFUSED') {
      stopped = await this.saveGeneration({
        ...stopped,
        state: 'CLEANUP_INCOMPLETE',
        cleanupReason: 'Managed preview environment cleanup is incomplete.'
      });
    }
    if (!stoppingCompose && this.composeRuntime && await this.composeRuntime.cleanupTask(generation.taskId, { deleteData: true }) === 'REFUSED') {
      stopped = await this.saveGeneration({
        ...stopped,
        state: 'CLEANUP_INCOMPLETE',
        cleanupReason: 'Compose preview project cleanup is incomplete.'
      });
    }
    return stopped;
  }

  private stopApplicationGeneration(generationId: string): Promise<PreviewGenerationRecord> {
    this.startups.get(generationId)?.abort();
    return this.withGenerationLock(generationId, async () => {
      let generation = await this.requireGeneration(generationId);
      if (generation.state === 'STOPPED') return generation;
      generation = await this.saveGeneration({ ...generation, state: 'STOPPING' });
      const cleanupIncomplete = await this.cleanupApplicationRuntime(generation);
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
    await this.stopResourceHealthWatch(taskId);
    await this.composeRuntime?.stopWatch(taskId);
    const composeProject = await this.store.getPreviewComposeProject(taskId);
    if (composeProject?.state !== 'STOPPED') {
      for (const generation of await this.store.getPreviewGenerations(taskId)) this.detachRoutes(generation);
    }
    if (
      composeProject?.state !== 'STOPPED' &&
      this.composeRuntime &&
      await this.composeRuntime.cleanupTask(taskId, { deleteData: true }) === 'REFUSED'
    ) {
      throw new Error('Task Compose preview cleanup is incomplete; task deletion was refused.');
    }
    for (const generation of await this.store.getPreviewGenerations(taskId)) {
      if (generation.state === 'STOPPED') continue;
      const stopped = await this.stopApplicationGeneration(generation.id);
      if (stopped.state === 'CLEANUP_INCOMPLETE') {
        throw new Error('Task preview cleanup is incomplete; task deletion was refused.');
      }
    }
    if (this.ociRuntime && await this.ociRuntime.cleanupTaskResources(taskId) === 'REFUSED') {
      throw new Error('Task preview OCI cleanup is incomplete; task deletion was refused.');
    }
  }

  async resetData(input: {
    taskId: string;
    generationId: string;
    resourceId: string;
    scenarioId: string;
    context: PreviewTaskContext;
  }): Promise<void> {
    const generation = await this.requireGeneration(input.generationId);
    if (generation.taskId !== input.taskId) {
      throw new Error('Preview generation was not found for this task.');
    }
    const activeApplication = generation.routingState === 'ACTIVE' && generation.state === 'READY';
    const failedApplication = ['FAILED', 'RECOVERY_REQUIRED'].includes(generation.state);
    if (!activeApplication && !failedApplication) {
      throw new Error('Reset requires the active preview or a failed setup generation.');
    }
    const resolved = await this.resolve(input.context, input.scenarioId);
    if (resolved.status !== 'PLAN') throw new Error(resolved.reason);
    await this.approvalPolicy.requireMatching(resolved.plan);
    const plan = resolved.plan;
    const scenario = plan.executionPlan.scenarios.find((candidate) => candidate.id === input.scenarioId);
    const resource = plan.executionPlan.resources.find((candidate) => candidate.id === input.resourceId);
    if (!scenario?.resources.includes(input.resourceId) || !resource) {
      throw new Error('Preview reset resource is not part of the approved scenario.');
    }
    const authority = await this.requireOciRuntime().verifyManagedPreview({
      taskId: input.taskId,
      expectedEngine: this.requireOciEngine(plan),
      resources: plan.executionPlan.resources.filter((candidate) => scenario.resources.includes(candidate.id)),
      resourceStates: failedApplication
        ? ['READY', 'SETUP_FAILED', 'RECOVERY_REQUIRED', 'FAILED']
        : ['READY'],
      verification: 'CLEANUP'
    });
    const target = authority.resources.find((candidate) => candidate.logicalResourceId === input.resourceId);
    if (!target) throw new Error(`Managed reset resource ${input.resourceId} is unavailable.`);
    if (failedApplication) {
      const attached = await this.store.getPreviewGenerationAttachments(generation.id);
      if (!attached.some((attachment) => attachment.managedResourceId === target.id)) {
        throw new Error('Reset requires the failed generation to be attached to the selected resource.');
      }
    }

    await this.stopResourceHealthWatch(input.taskId);
    const active = (await this.store.getPreviewGenerations(input.taskId)).find(
      (candidate) => candidate.routingState === 'ACTIVE' && candidate.state === 'READY'
    );
    for (const applicationId of new Set([active?.id, generation.id].filter(Boolean) as string[])) {
      const stoppedApplication = await this.stopApplicationGeneration(applicationId);
      if (stoppedApplication.state === 'CLEANUP_INCOMPLETE') {
        throw new Error('Preview application cleanup is incomplete; managed data was not changed.');
      }
    }
    const reset = await this.requireOciRuntime().stopManagedResource(target.id);
    if (reset === 'REFUSED') {
      throw new Error(`Preview data reset could not verify ${input.resourceId} ownership.`);
    }
  }

  async authorizeSetupRetry(input: {
    taskId: string;
    generationId: string;
    scenarioId: string;
    context: PreviewTaskContext;
  }): Promise<string[]> {
    const generation = await this.requireGeneration(input.generationId);
    if (generation.taskId !== input.taskId || generation.state !== 'FAILED') {
      throw new Error('Retry Setup requires a failed preview generation for this task.');
    }
    const resolved = await this.resolve(input.context, input.scenarioId);
    if (resolved.status !== 'PLAN') throw new Error(resolved.reason);
    await this.approvalPolicy.requireMatching(resolved.plan);
    if (generation.executionDigest !== resolved.plan.executionDigest) {
      throw new Error('Retry Setup requires the failed generation to match the current approved execution plan.');
    }
    const scenario = resolved.plan.executionPlan.scenarios.find(
      (candidate) => candidate.id === input.scenarioId
    );
    if (!scenario) throw new Error('Retry Setup scenario is unavailable.');
    const setupJobs = resolved.plan.executionPlan.jobs.filter((job) => scenario.jobs.includes(job.id));
    if (setupJobs.length === 0 || setupJobs.some((job) => !job.retrySafe)) {
      throw new Error('Retry Setup requires every selected migration and seed job to declare retrySafe: true.');
    }
    const setupJobIds = new Set(setupJobs.map((job) => job.id));
    const priorAttempts = await this.store.getPreviewNodeAttempts(generation.id);
    if (!priorAttempts.some(
      (attempt) =>
        setupJobIds.has(attempt.nodeId) &&
        ['FAILED', 'RECOVERY_REQUIRED', 'STOPPED'].includes(attempt.state)
    )) {
      throw new Error('Retry Setup requires prior failed or ambiguous setup-attempt evidence.');
    }
    const attachedResourceIds = new Set(
      (await this.store.getPreviewGenerationAttachments(generation.id))
        .map((attachment) => attachment.managedResourceId)
    );
    const authority = await this.requireOciRuntime().verifyManagedPreview({
      taskId: input.taskId,
      expectedEngine: this.requireOciEngine(resolved.plan),
      resources: resolved.plan.executionPlan.resources.filter((resource) => scenario.resources.includes(resource.id)),
      resourceStates: ['READY', 'SETUP_FAILED']
    });
    const retryIds = authority.resources
      .filter((resource) => attachedResourceIds.has(resource.id) && resource.state === 'SETUP_FAILED')
      .map((resource) => resource.id);
    if (retryIds.length === 0) throw new Error('No retry-safe failed setup is available.');
    return retryIds;
  }

  shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    this.lifecycle = 'SHUTTING_DOWN';
    for (const controller of this.startups.values()) controller.abort();
    const operation = this.shutdownOnce().finally(() => {
      this.lifecycle = 'STOPPED';
      if (this.shutdownWork === operation) this.shutdownWork = undefined;
    });
    this.shutdownWork = operation;
    return operation;
  }

  private async shutdownOnce(): Promise<void> {
    await this.initWork?.catch(() => undefined);
    for (const controller of this.startups.values()) controller.abort();
    await this.composeRuntime?.shutdown();
    await Promise.allSettled([...this.locks.values()]);
    const failures: string[] = [];
    await Promise.all(
      [...this.resourceHealthStops.keys()].map((taskId) => this.stopResourceHealthWatch(taskId))
    );
    if (this.composeRuntime) {
      for (const project of await this.store.getPreviewComposeProjects()) {
        if (project.state === 'STOPPED') continue;
        for (const generation of await this.store.getPreviewGenerations(project.taskId)) {
          this.detachRoutes(generation);
        }
        if (await this.composeRuntime.cleanupTask(project.taskId, { deleteData: true }) === 'REFUSED') {
          failures.push(`compose-project:${project.id}`);
        }
      }
    }
    for (const generation of await this.store.getPreviewGenerations()) {
      if (failures.includes(`compose-project:${(await this.store.getPreviewComposeProject(generation.taskId))?.id}`)) {
        continue;
      }
      if (!['STOPPED', 'FAILED'].includes(generation.state)) {
        try {
          const stopped = await this.stopApplicationGeneration(generation.id);
          if (stopped.state === 'CLEANUP_INCOMPLETE') failures.push(stopped.id);
        } catch {
          failures.push(generation.id);
        }
      }
    }
    if (this.ociRuntime && await this.ociRuntime.cleanupTaskResources() === 'REFUSED') {
      failures.push('preview-scoped-oci-resources');
    }
    if (this.composeRuntime) {
      await this.composeRuntime.shutdown();
    }
    await this.gateway.close();
    await this.privateVault?.shutdown();
    if (failures.length > 0) {
      throw new Error(
        `Preview shutdown left ${failures.length} generation(s) with unverified cleanup residue.`
      );
    }
  }

  private async initialize(
    preferredGatewayPort: number,
    options: { reconcile?: boolean }
  ): Promise<{ port: number; relocated: boolean }> {
    try {
      await this.sweepPrivateVault();
      const listening = await this.gateway.listen(preferredGatewayPort);
      this.gatewayPort = listening.port;
      if (this.lifecycle !== 'INITIALIZING') {
        throw new Error('Preview runtime initialization was canceled.');
      }
      if (options.reconcile !== false) await this.reconciler.reconcile();
      if (this.lifecycle !== 'INITIALIZING') {
        throw new Error('Preview runtime initialization was canceled.');
      }
      this.lifecycle = 'READY';
      return listening;
    } catch (error) {
      this.gatewayPort = undefined;
      await this.gateway.close().catch(() => undefined);
      if (this.lifecycle === 'INITIALIZING') this.lifecycle = 'NEW';
      throw error;
    }
  }

  private assertAcceptingWork(): void {
    if (this.lifecycle !== 'READY') {
      throw new Error(
        this.lifecycle === 'SHUTTING_DOWN' || this.lifecycle === 'STOPPED'
          ? 'Preview runtime is shutting down.'
          : 'Preview runtime is not initialized.'
      );
    }
  }

  private async cleanupFailedGeneration(
    generation: PreviewGenerationRecord,
    error: unknown
  ): Promise<void> {
    const current = (await this.store.getPreviewGeneration(generation.id)) ?? generation;
    const nonRetryableSetupAmbiguity =
      error instanceof PreviewJobCompletionAmbiguousError &&
      error.role !== 'generic' &&
      !error.retrySafe;
    const cleanupIncomplete = await this.cleanupApplicationRuntime(current);
    await this.saveGeneration({
      ...current,
      routes: current.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
      state: cleanupIncomplete
        ? 'CLEANUP_INCOMPLETE'
        : nonRetryableSetupAmbiguity
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
    const cleanupIncomplete = await this.cleanupApplicationRuntime(generation);
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

  private async startResourceHealthWatch(
    taskId: string,
    generationId: string,
    resourceIds: string[]
  ): Promise<void> {
    await this.stopResourceHealthWatch(taskId);
    if (!this.ociRuntime || resourceIds.length === 0) return;
    const stop = await this.ociRuntime.watchRequiredResources(taskId, resourceIds, async (_resource, reason) => {
      try {
        await this.failAndDetachGeneration(generationId, reason);
      } finally {
        if (this.resourceHealthStops.get(taskId) === stop) this.resourceHealthStops.delete(taskId);
      }
    });
    this.resourceHealthStops.set(taskId, stop);
  }

  private async stopResourceHealthWatch(taskId: string): Promise<void> {
    const stop = this.resourceHealthStops.get(taskId);
    if (!stop) return;
    await stop();
    if (this.resourceHealthStops.get(taskId) === stop) {
      this.resourceHealthStops.delete(taskId);
    }
  }

  private async failAndDetachGeneration(generationId: string, reason: string): Promise<void> {
    await this.withGenerationLock(generationId, async () => {
      const generation = await this.requireGeneration(generationId);
      if (['FAILED', 'STOPPED', 'STOPPING'].includes(generation.state)) return;
      const cleanupIncomplete = await this.cleanupApplicationRuntime(generation);
      await this.saveGeneration({
        ...generation,
        routes: generation.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
        routingState: 'RETIRED',
        state: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'FAILED',
        failureReason: boundedError(reason),
        cleanupReason: cleanupIncomplete
          ? 'Application cleanup after managed-resource failure is incomplete.'
          : undefined
      });
      await this.store.prunePreviewHistory(generation.taskId);
    });
  }

  private async cleanupApplicationRuntime(generation: PreviewGenerationRecord): Promise<boolean> {
    this.detachRoutes(generation);
    const live = this.live.get(generation.id);
    const cleanupIncomplete = await cleanupPreviewGenerationRuntime({
      generation,
      store: this.store,
      nativeRuntime: this.nativeRuntime,
      sourcePreparer: this.sourcePreparer,
      liveGraph: live
    });
    if (live) this.live.delete(generation.id);
    if (!cleanupIncomplete) await this.privateVault?.releaseGeneration(generation.id);
    return cleanupIncomplete;
  }

  private requireOciRuntime(): OciResourceRuntime {
    if (!this.ociRuntime) throw new Error('OCI preview resources are unavailable.');
    return this.ociRuntime;
  }

  private requireComposeRuntime(): PreviewComposeRuntime {
    if (!this.composeRuntime) throw new Error('Compose preview runtime is unavailable.');
    return this.composeRuntime;
  }

  private async findComposeProjectInspection(
    taskId: string,
    excludedGenerationId: string
  ): Promise<PreviewComposeInspection | undefined> {
    const project = await this.store.getPreviewComposeProject(taskId);
    if (!project || project.state === 'STOPPED') return undefined;
    const generations = (await this.store.getPreviewGenerations(taskId))
      .filter((generation) =>
        generation.id !== excludedGenerationId &&
        (generation.adapter ?? 'NATIVE') === 'COMPOSE' &&
        generation.composeChange !== 'DESTRUCTIVE_RESET_REQUIRED'
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const generation of generations) {
      const plan = await this.store.getPreviewPlan(generation.planId);
      const inspection = plan?.executionPlan.adapter === 'COMPOSE'
        ? plan.executionPlan.compose?.inspection
        : undefined;
      if (
        inspection?.trustDigest === project.trustDigest &&
        inspection.configDigest === project.configDigest
      ) {
        return inspection;
      }
    }
    throw new Error(
      'Compose project compatibility authority is unavailable; stop and delete its data before starting again.'
    );
  }

  private async isPrivateInputDeclared(taskId: string, inputId: string): Promise<boolean> {
    const plan = await this.store.getLatestPreviewPlan(taskId);
    return Boolean(plan?.executionPlan.inputs?.some((input) => input.id === inputId));
  }

  private async sweepPrivateVault(): Promise<'CLEAN' | 'CLEANUP_PENDING' | 'RECOVERY_REQUIRED'> {
    if (!this.privateVault) return 'RECOVERY_REQUIRED';
    const snapshot = await this.store.snapshot();
    return this.privateVault.sweep({
      taskIds: new Set(snapshot.tasks.map((task) => task.id)),
      retainedGenerationIds: new Set(snapshot.previewGenerations.filter((generation) =>
        !['STOPPED', 'FAILED'].includes(generation.state) ||
        ['CLEANUP_INCOMPLETE', 'RECOVERY_REQUIRED'].includes(generation.state)
      ).map((generation) => generation.id))
    });
  }

  private requireOciEngine(plan: PreviewPlanRecord) {
    const identity = plan.ociCapability?.status === 'READY'
      ? plan.ociCapability.identity
      : undefined;
    if (!identity) throw new Error('The approved OCI engine is unavailable for preview execution.');
    return identity;
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

function validateLocalAttachmentTarget(
  consumerTaskId: string,
  attachmentType: 'http' | 'tcp' | 'postgres' | 'redis',
  target: PreviewResolvedAttachmentTarget
): void {
  if (!target || typeof target !== 'object') throw new Error('Preview attachment target is invalid.');
  if (target.type === 'task-preview-route') {
    if (
      attachmentType !== 'http' ||
      target.targetTaskId === consumerTaskId ||
      !isBoundedIdentifier(target.targetTaskId, 256) ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(target.routeId) ||
      !isSafeAttachmentPath(target.basePath)
    ) {
      throw new Error('Task preview route binding is invalid.');
    }
    return;
  }
  if (target.type !== 'endpoint' || !isSafeAttachmentHost(target.host) || !isPort(target.port)) {
    throw new Error('Preview endpoint binding is invalid.');
  }
  if (attachmentType === 'http') {
    if (!('scheme' in target) || !['http', 'https'].includes(target.scheme) || !isSafeAttachmentPath(target.basePath)) {
      throw new Error('HTTP preview endpoint binding is invalid.');
    }
    return;
  }
  if (attachmentType === 'tcp') {
    if ('scheme' in target || 'database' in target) throw new Error('TCP preview endpoint binding is invalid.');
    return;
  }
  if (!('database' in target) || !('tls' in target) || !['disabled', 'system-verified'].includes(target.tls)) {
    throw new Error('Database preview endpoint binding is invalid.');
  }
  if (attachmentType === 'postgres') {
    if (typeof target.database !== 'string' || !target.database || !('username' in target) || !target.username) {
      throw new Error('PostgreSQL preview endpoint binding is invalid.');
    }
    return;
  }
  if (typeof target.database !== 'number' || !Number.isInteger(target.database) || target.database < 0 || target.database > 65_535) {
    throw new Error('Redis preview endpoint binding is invalid.');
  }
}

function isSafeAttachmentHost(value: string): boolean {
  return Boolean(value) && Buffer.byteLength(value) <= 253 && !/[\s\0\r\n/@?#]/.test(value) && !value.startsWith('-');
}

function isSafeAttachmentPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !/[\0\r\n?#]/.test(value) && Buffer.byteLength(value) <= 2_048;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isBoundedIdentifier(value: string, maxBytes: number): boolean {
  return Boolean(value) && !/[\0\r\n]/.test(value) && Buffer.byteLength(value) <= maxBytes;
}

function throwIfStartupCanceled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Preview startup canceled.');
  error.name = 'AbortError';
  throw error;
}
