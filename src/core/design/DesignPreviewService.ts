import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  loadPreviewSpec,
  PreviewError,
  resolvePreviewFile,
  type PreviewSpec,
  type PreviewRuntime,
  type PreviewStatus
} from 'previewhost';
import type {
  OpenPreviewRequest,
  PreviewGenerationRecord,
  PreviewRouteRecord,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../shared/contracts';
import type { AppEventBus } from '../runner/AppEventBus';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';
import { PreviewSourcePreparer } from '../preview/PreviewSourcePreparer';
import { canonicalProspectivePath } from '../preview/PreviewPaths';

import type { DesignCanvasCutoverFence } from '../preview/DesignCanvasCutoverFence';
import {
  openDesignBrowserProxy,
  type DesignBrowserLease
} from './DesignBrowserProxy';

export interface DesignPreviewContext {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
}

type DesignPreviewSettlement =
  | { kind: 'AGENT_TURN'; turnId: string; runId: string }
  | { kind: 'RESTORE'; actionId: string }
  | { kind: 'DUPLICATE'; actionId: string };

interface RestartDesignPreviewInput {
  context: DesignPreviewContext;
  commitSha: string;
  designRevisionId: string;
  fence: DesignCanvasCutoverFence;
}

interface PreparedDesignPreview {
  generation: PreviewGenerationRecord;
  sourcePath: string;
  controller: AbortController;
  spec: PreviewSpec;
}

/** Design owns exact source and publication; Previewhost owns application resources. */
export class DesignPreviewService {
  private readonly preparing = new Map<
    string,
    { controller: AbortController; managed: boolean }
  >();
  private readonly leases = new Map<string, Set<DesignBrowserLease>>();
  private readonly publishedCandidates = new Set<string>();
  private readonly sources: PreviewSourcePreparer;
  constructor(
    private readonly store: SqliteTaskStore,
    private readonly events: AppEventBus,
    private readonly runtime: () => PreviewRuntime,
    sourceRoot: string
  ) {
    this.sources = new PreviewSourcePreparer(
      sourceRoot,
      store.getStoreIdentity()
    );
  }

  async init(): Promise<void> {
    const snapshot = await this.store.snapshot();
    for (const generation of snapshot.previewGenerations) {
      await this.cleanSource(generation);
    }
    await this.sources.cleanupOrphanedGenerations(
      new Set(snapshot.previewGenerations.map((generation) => generation.id))
    );
  }

  async inspectConfiguration(context: DesignPreviewContext) {
    const owner = this.runtime();
    await owner.allowSources(
      [context.worktree.worktreePath],
      new AbortController().signal
    );
    const spec = await loadPreviewSpec(
      await resolvePreviewFile(context.worktree.worktreePath),
      { allowedRoots: owner.sourceRoots() }
    );
    spec.name = `tm-${context.worktree.id}`;
    return owner.inspect(spec);
  }

  async authorizes(spec: PreviewSpec): Promise<boolean> {
    if (spec.type !== 'static') return false;
    for (const [id, { controller, managed }] of this.preparing) {
      if (controller.signal.aborted || !managed) continue;
      const generation = await this.require(id);
      if (
        spec.name === generation.previewKey &&
        spec.directory ===
          (await fs.realpath(
            path.join(
              this.sources.getGenerationPath(generation.taskId, id),
              'source'
            )
          ))
      )
        return true;
    }
    return false;
  }

  async prepareManagedDesignExactCommit(input: {
    context: DesignPreviewContext;
    commitSha: string;
    designRevisionId?: string;
    runId?: string;
  }): Promise<PreparedDesignPreview> {
    const { context } = input;
    if (
      context.task.kind !== 'DESIGN' ||
      context.worktree.taskId !== context.task.id ||
      context.worktree.repositoryId !== context.task.repositoryId ||
      context.iteration.taskId !== context.task.id ||
      !/^[0-9a-f]{40,64}$/.test(input.commitSha)
    ) {
      throw new Error(
        'Design preview requires one matching task, worktree, and exact commit.'
      );
    }
    const id = randomUUID();
    const repository = (await this.store.snapshot()).repositories.find(
      (value) => value.id === context.task.repositoryId
    );
    if (!repository) throw new Error('Design repository is unavailable.');
    const now = new Date().toISOString();
    const previous = (
      await this.store.getPreviewGenerations(context.task.id)
    ).find((item) => item.state === 'READY' && item.routingState === 'ACTIVE');
    let generation = await this.store.savePreviewGeneration({
      id,
      previewKey: `tm-${context.worktree.id}`,
      taskId: context.task.id,
      iterationId: context.iteration.id,
      worktreeId: context.worktree.id,
      source: {
        type: 'EXACT_COMMIT',
        repositoryId: context.task.repositoryId,
        commitSha: input.commitSha,
        designRevisionId: input.designRevisionId
      },
      workspacePath: this.sources.getGenerationPath(context.task.id, id),
      state: 'PREPARING_SOURCE',
      routingState: 'CANDIDATE',
      replacesGenerationId: previous?.id,
      routes: [],
      createdAt: now,
      updatedAt: now
    });
    const controller = new AbortController();
    this.preparing.set(id, {
      controller,
      managed: repository.kind === 'DESIGN_MANAGED'
    });
    try {
      const prepared = await this.sources.prepareExactCommit({
        repositoryPath: context.worktree.worktreePath,
        taskId: generation.taskId,
        generationId: id,
        commitSha: input.commitSha,
        signal: controller.signal
      });
      if (prepared.commitSha !== input.commitSha)
        throw new Error('Design source capture returned a different commit.');
      if (
        repository.kind === 'DESIGN_MANAGED' &&
        !(await fs.stat(path.join(prepared.sourcePath, 'index.html'))).isFile()
      ) {
        throw new Error('The Design needs an index.html entry page.');
      }
      await this.runtime().allowSources(
        [prepared.sourcePath],
        controller.signal
      );
      const spec: PreviewSpec =
        repository.kind === 'DESIGN_MANAGED'
          ? {
              name: generation.previewKey,
              type: 'static',
              directory: prepared.sourcePath
            }
          : await loadPreviewSpec(
              await resolvePreviewFile(prepared.sourcePath),
              { allowedRoots: this.runtime().sourceRoots() }
            );
      spec.name = generation.previewKey;
      return { generation, sourcePath: prepared.sourcePath, controller, spec };
    } catch (error) {
      this.preparing.delete(id);
      generation = await this.save({
        ...generation,
        state: 'FAILED',
        failureReason: reason(error)
      });
      await this.cleanSource(generation);
      throw error;
    }
  }

  async executeManagedDesignCandidate(
    prepared: PreparedDesignPreview,
    input: {
      designId: string;
      onCandidateReady(generation: PreviewGenerationRecord): Promise<void>;
    }
  ): Promise<PreviewGenerationRecord> {
    let generation = prepared.generation;
    if (generation.taskId !== input.designId)
      throw new Error('Design candidate belongs to another task.');
    const owner = this.runtime();
    const signal = prepared.controller.signal;
    let attemptId: string | undefined;
    try {
      if (signal.aborted) throw new Error('Design candidate was canceled.');
      const pending = await owner.prepareCandidate(prepared.spec);
      if (!pending.candidate)
        throw new Error('Previewhost did not create a Design candidate.');
      attemptId = pending.candidate.id;
      generation = await this.save({
        ...generation,
        runtimeAttemptId: attemptId,
        state: 'WAITING_READY'
      });
      if (signal.aborted) throw new Error('Design candidate was canceled.');
      let ready: Awaited<ReturnType<PreviewRuntime['wait']>>;
      for (;;) {
        try {
          ready = await owner.wait(generation.previewKey, attemptId, { signal });
          break;
        } catch (error) {
          // An observation deadline does not cancel the runtime's pending work.
          if (!(error instanceof PreviewError && error.code === 'TIMEOUT') || signal.aborted)
            throw error;
        }
      }
      if (ready.state !== 'ready')
        throw new Error(
          ready.error?.message ?? 'Design candidate did not become ready.'
        );
      const status = await owner.get(generation.previewKey);
      generation = await this.save({
        ...generation,
        state: 'READY',
        readyAt: ready.readyAt,
        routes: applicationRoutes(status, attemptId)
      });
      await input.onCandidateReady(generation);
      return generation;
    } catch (error) {
      if (attemptId) {
        const status = await owner.get(generation.previewKey);
        if (status.candidate?.id === attemptId)
          await owner.cancel(status.name, attemptId);
      }
      generation = await this.save({
        ...generation,
        state: 'FAILED',
        failureReason: reason(error)
      });
      await this.cleanSource(generation);
      throw error;
    } finally {
      this.preparing.delete(generation.id);
    }
  }

  async requireLiveDesignCandidate(
    generationId: string
  ): Promise<PreviewGenerationRecord> {
    const generation = await this.require(generationId);
    if (generation.state !== 'READY' || generation.routingState !== 'CANDIDATE')
      throw new Error('The inspected Design candidate is no longer available.');
    this.runtime().candidateUrl(
      generation.previewKey,
      this.attempt(generation)
    );
    return generation;
  }

  async openManagedDesignBrowserLease(
    generationId: string
  ): Promise<DesignBrowserLease> {
    return this.openLease(await this.requireLiveDesignCandidate(generationId));
  }

  private async openLease(
    generation: PreviewGenerationRecord
  ): Promise<DesignBrowserLease> {
    const owner = this.runtime();
    const status = await owner.get(generation.previewKey);
    const attemptId = this.attempt(generation);
    const isCandidate = status.candidate?.id === attemptId;
    if (!isCandidate && status.active?.id !== attemptId)
      throw new Error('The Design route is no longer available.');
    const port = isCandidate
      ? new URL(owner.candidateUrl(generation.previewKey, attemptId)).port
      : undefined;
    const target = (await this.store.getTask(generation.taskId))
      ?.designPreviewTarget;
    const routeId = target?.routeId ?? 'app';
    const selected = generation.routes.find((value) => value.id === routeId);
    if (!selected)
      throw new Error(
        'The selected Design application is not declared by this configuration.'
      );
    const routes = Object.fromEntries(
      generation.routes.map((value) => {
        const url = new URL(value.url);
        if (port) url.port = port;
        return [new URL(value.url).origin, url.origin];
      })
    );
    const lease = await openDesignBrowserProxy({
      origin: new URL(selected.url).origin,
      entryPath: target?.entryPath ?? '/',
      routes,
      isCurrent: async () => {
        const current = await owner.get(generation.previewKey);
        return isCandidate
          ? current.candidate?.id === attemptId &&
              current.candidate.state === 'ready'
          : current.active?.id === attemptId &&
              current.active.state === 'ready';
      }
    });
    const leases = this.leases.get(generation.id) ?? new Set();
    leases.add(lease);
    this.leases.set(generation.id, leases);
    return {
      ...lease,
      close: async () => {
        await lease.close();
        leases.delete(lease);
        if (!leases.size) this.leases.delete(generation.id);
      }
    };
  }

  async publishManagedDesignCandidateCanvas(
    generationId: string
  ): Promise<void> {
    await this.requireLiveDesignCandidate(generationId);
    this.publishedCandidates.add(generationId);
  }

  async resolveExternalUrl(input: OpenPreviewRequest): Promise<string> {
    const generation = await this.require(input.generationId);
    const route = generation.routes.find(
      (value) => value.id === input.routeId && value.state === 'ATTACHED'
    );
    if (generation.taskId !== input.taskId || !route)
      throw new Error('Design route is unavailable.');
    const owner = this.runtime();
    const status = await owner.get(generation.previewKey);
    const url = new URL(route.url);
    if (
      status.candidate?.id === generation.runtimeAttemptId &&
      this.publishedCandidates.has(generation.id)
    ) {
      url.port = new URL(
        owner.candidateUrl(generation.previewKey, this.attempt(generation))
      ).port;
    } else if (status.active?.id !== generation.runtimeAttemptId)
      throw new Error('Design route is no longer current.');
    const target = (await this.store.getTask(generation.taskId))
      ?.designPreviewTarget;
    return new URL(target?.entryPath ?? '/', url).href;
  }

  async resolveDesignCanvasRoute(input: OpenPreviewRequest) {
    const generation = await this.require(input.generationId);
    if (
      generation.taskId !== input.taskId ||
      generation.state !== 'READY' ||
      (generation.routingState === 'CANDIDATE' &&
        !this.publishedCandidates.has(generation.id))
    )
      throw new Error('Design canvas does not own this ready route.');
    const target = (await this.store.getTask(generation.taskId))
      ?.designPreviewTarget;
    if (input.routeId !== (target?.routeId ?? 'app'))
      throw new Error('The selected Design canvas route changed.');
    const lease = await this.openLease(generation);
    return {
      taskId: generation.taskId,
      generationId: generation.id,
      routeId: input.routeId,
      url: new URL(lease.entryPath, lease.origin).href,
      origin: lease.origin,
      allowedOrigins: lease.allowedOrigins,
      networkLease: lease
    };
  }

  async cutoverManagedDesignCandidate(input: {
    generationId: string;
    designId: string;
    settlement?: DesignPreviewSettlement;
    fence: DesignCanvasCutoverFence;
  }): Promise<PreviewGenerationRecord> {
    let generation = await this.require(input.generationId);
    if (
      generation.taskId !== input.designId ||
      generation.routingState !== 'CANDIDATE' ||
      generation.source.type !== 'EXACT_COMMIT'
    )
      throw new Error('Design cutover requires its exact-source candidate.');
    const owner = this.runtime();
    const name = generation.previewKey;
    const attemptId = this.attempt(generation);
    owner.candidateUrl(name, attemptId);
    const replaced = generation.replacesGenerationId
      ? await this.require(generation.replacesGenerationId)
      : undefined;
    const routeId =
      (await this.store.getTask(input.designId))?.designPreviewTarget
        ?.routeId ?? 'app';
    const canvas = await input.fence.begin({
      designId: input.designId,
      candidate: identity(generation, routeId),
      replaced: replaced && identity(replaced, routeId)
    });
    let committed = false;
    const failures: unknown[] = [];
    try {
      const status = await owner.get(name);
      if (!status.url) throw new Error('Design route is unavailable.');
      const at = new Date().toISOString();
      const candidate: PreviewGenerationRecord = {
        ...generation,
        routes: applicationRoutes(status, attemptId),
        routingState: 'ACTIVE',
        cutoverAt: at,
        updatedAt: at
      };
      await owner.promote(name, attemptId, async () => {
        const cutover = await this.store.cutoverPreviewGenerations({
          candidate,
          replaced: replaced && {
            ...replaced,
            routingState: 'RETIRED',
            routes: replaced.routes.map((item) => ({
              ...item,
              state: 'DETACHED'
            })),
            updatedAt: at
          },
          designSettlement: input.settlement && {
            designId: input.designId,
            commitSha:
              generation.source.type === 'EXACT_COMMIT'
                ? generation.source.commitSha
                : '',
            routeId,
            settlement: input.settlement
          }
        });
        generation = cutover.candidate;
        committed = true;
      });
    } catch (error) {
      if (!committed) {
        try {
          await canvas.rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Design publication failed and the canvas could not be restored.'
          );
        }
        throw error;
      }
      failures.push(error);
    }
    this.publishedCandidates.delete(generation.id);
    this.emit(generation);
    if (replaced) {
      try {
        await this.cleanSource(await this.require(replaced.id));
      } catch (error) {
        failures.push(error);
      }
    }
    // Durable publication already succeeded. A canvas load error must not restore the old revision.
    try {
      await canvas.commit();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Design was published, but its canvas or previous source needs cleanup.'
      );
    return generation;
  }

  async restartManagedDesign(
    input: RestartDesignPreviewInput
  ): Promise<PreviewGenerationRecord> {
    const prepared = await this.prepareManagedDesignExactCommit(input);
    await this.executeManagedDesignCandidate(prepared, {
      designId: input.context.task.id,
      onCandidateReady: async () => undefined
    });
    return this.cutoverManagedDesignCandidate({
      generationId: prepared.generation.id,
      designId: input.context.task.id,
      fence: input.fence
    });
  }

  async abortManagedDesignCandidateStartups(runId: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    const run = snapshot.runs.find(
      (item) => item.id === runId && item.mode === 'DESIGN'
    );
    if (
      !run ||
      run.status === 'COMPLETED' ||
      snapshot.tasks.find((task) => task.id === run.taskId)?.currentRunId !==
        runId ||
      !snapshot.designTurns.some(
        (turn) => turn.id === run.generationKey && !turn.outcome
      )
    )
      return;
    for (const generation of snapshot.previewGenerations) {
      if (
        generation.taskId === run.taskId &&
        generation.worktreeId === run.worktreeId &&
        generation.routingState === 'CANDIDATE' &&
        generation.source.type === 'EXACT_COMMIT' &&
        !generation.source.designRevisionId
      )
        this.preparing.get(generation.id)?.controller.abort();
    }
  }

  async stopManagedDesignCandidate(generationId: string): Promise<void> {
    const generation = await this.require(generationId);
    if (generation.routingState !== 'CANDIDATE')
      throw new Error('Only the verification candidate can be canceled.');
    this.preparing.get(generationId)?.controller.abort();
    const status = (await this.runtime().list()).find(
      (item) => item.name === generation.previewKey
    );
    if (
      status?.candidate &&
      status.candidate.id === generation.runtimeAttemptId
    )
      await this.runtime().cancel(status.name, status.candidate.id);
    await this.cleanSource(generation);
  }

  async stopTask(taskId: string): Promise<void> {
    const worktree = await this.store.getCurrentWorktree(taskId);
    const names = new Set(
      (await this.store.getPreviewGenerations(taskId)).map(
        (value) => value.previewKey
      )
    );
    if (worktree) names.add(`tm-${worktree.id}`);
    for (const status of await this.runtime().list())
      if (names.has(status.name)) await this.runtime().stop(status.name);
    for (const generation of await this.store.getPreviewGenerations(taskId)) {
      await this.cleanSource(generation);
    }
  }

  async shutdown(): Promise<void> {
    for (const { controller } of this.preparing.values()) controller.abort();
    const designs = await this.store.listDesigns();
    const results = await Promise.allSettled(
      designs.map((design) => this.stopTask(design.id))
    );
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Some Design preview sources remain in use.'
      );
  }

  private async cleanSource(
    generation: PreviewGenerationRecord
  ): Promise<void> {
    if (
      await canonicalProspectivePath(generation.workspacePath) !==
      await canonicalProspectivePath(this.sources.getGenerationPath(generation.taskId, generation.id))
    ) {
      throw new Error('Design source path does not match its owned capture.');
    }
    const status = (await this.runtime().list()).find(
      (item) => item.name === generation.previewKey
    );
    const source = await fs
      .realpath(path.join(generation.workspacePath, 'source'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
          return path.join(generation.workspacePath, 'source');
        throw error;
      });
    if (
      [status?.active, status?.candidate].some((item) =>
        item?.sources.includes(source)
      ) ||
      status?.cleanup?.some((item) => item.sources.includes(source))
    ) {
      throw new Error(
        'Stop the owned Design preview before removing its source.'
      );
    }
    try {
      for (const lease of this.leases.get(generation.id) ?? [])
        await lease.close();
      this.leases.delete(generation.id);
      this.publishedCandidates.delete(generation.id);
      this.runtime().releaseSources([source]);
      await this.sources.cleanupOwnedGeneration({
        taskId: generation.taskId,
        generationId: generation.id
      });
      await this.save({
        ...generation,
        state: 'STOPPED',
        routes: generation.routes.map((item) => ({
          ...item,
          state: 'DETACHED'
        })),
        stoppedAt: new Date().toISOString(),
        cleanupReason: undefined
      });
    } catch (error) {
      await this.save({
        ...generation,
        state: 'CLEANUP_INCOMPLETE',
        cleanupReason: reason(error)
      });
      throw error;
    }
  }

  private attempt(generation: PreviewGenerationRecord): string {
    if (!generation.runtimeAttemptId)
      throw new Error('Design preview has no runtime attempt.');
    return generation.runtimeAttemptId;
  }
  private async require(id: string): Promise<PreviewGenerationRecord> {
    const generation = await this.store.getPreviewGeneration(id);
    if (!generation) throw new Error('Design preview is unavailable.');
    return generation;
  }
  private async save(generation: PreviewGenerationRecord) {
    const saved = await this.store.savePreviewGeneration({
      ...generation,
      updatedAt: new Date().toISOString()
    });
    this.emit(saved);
    return saved;
  }
  private emit(generation: PreviewGenerationRecord) {
    this.events.emit({
      type: 'preview.updated',
      taskId: generation.taskId,
      iterationId: generation.iterationId,
      worktreeId: generation.worktreeId,
      payload: generation,
      at: new Date().toISOString()
    });
  }
}

function identity(generation: PreviewGenerationRecord, routeId: string) {
  return { taskId: generation.taskId, generationId: generation.id, routeId };
}
function route(value: string, id = 'app'): PreviewRouteRecord {
  const url = new URL(value);
  return { id, url: url.href, state: 'ATTACHED' };
}
function reason(error: unknown): string {
  return (
    error instanceof Error ? error.message : 'Design preview failed.'
  ).slice(0, 1024);
}

function applicationRoutes(
  status: PreviewStatus,
  attemptId: string
): PreviewRouteRecord[] {
  const attempt = [status.active, status.candidate].find(
    (value) => value?.id === attemptId
  );
  if (!status.url || !attempt)
    throw new Error('Design application routes are unavailable.');
  return [
    route(status.url),
    ...Object.entries(attempt.services ?? {}).flatMap(([id, service]) =>
      service.browserUrl && id !== 'app' ? [route(service.browserUrl, id)] : []
    )
  ];
}
