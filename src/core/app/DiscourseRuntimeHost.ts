import os from 'node:os';
import path from 'node:path';
import type {
  AgentRuntimeCatalog,
  TaskManagerAppSettings
} from '../../shared/agent';
import type { AgentRuntimeStore } from '../agent/AgentRuntimeStore';
import {
  AgentScopedTurnRouter,
  type AgentScopedTurnEvent
} from '../agent/AgentScopedTurnProvider';
import { AgentTurnScheduler } from '../agent/AgentTurnScheduler';
import {
  appendDiscourseDelta,
  createDiscourseDeltaAccumulator,
  drainDiscourseDeltas,
  type DiscourseDeltaAccumulatorState
} from '../discourse/DiscourseDeltaAccumulator';
import { DiscourseContextResolver } from '../discourse/DiscourseContextResolver';
import { DiscourseContextSnapshotService } from '../discourse/DiscourseContextSnapshotService';
import { DiscourseRuntimeCoordinator } from '../discourse/DiscourseRuntimeCoordinator';
import { DiscourseService } from '../discourse/DiscourseService';
import type { DiscourseStore } from '../discourse/DiscourseStore';
import { DiscourseWorkspace } from '../discourse/DiscourseWorkspace';
import { AppEventBus } from '../runner/AppEventBus';
import type { FileTaskStore } from '../storage/FileTaskStore';
import { RuntimeOperationGate } from './RuntimeOperationGate';

export interface DiscourseRuntimeHostOptions {
  taskStore: FileTaskStore;
  runtimeStore: AgentRuntimeStore;
  discourseStore: DiscourseStore;
  scopedTurnRouter?: AgentScopedTurnRouter;
  events: AppEventBus;
  runtimeOperations: RuntimeOperationGate;
  workspaceRoot?: string;
  providerStartupDisabledReason?: string;
  getRuntimeCatalog(): Promise<AgentRuntimeCatalog>;
  getAppSettings(): TaskManagerAppSettings;
  logger?: Pick<Console, 'error'>;
}

/** Owns Discourse runtime composition, dispatch, delta publication, and recovery. */
export class DiscourseRuntimeHost {
  readonly service: DiscourseService;

  private readonly coordinator: DiscourseRuntimeCoordinator;
  private readonly contextSnapshots: DiscourseContextSnapshotService;
  private readonly scheduler: AgentTurnScheduler;
  private readonly deltaStates = new Map<string, DiscourseDeltaAccumulatorState>();
  private readonly deltaTimers = new Map<string, NodeJS.Timeout>();
  private readonly disposeScopedTurnEvents?: () => void;
  private schedulerWork?: Promise<void>;
  private schedulerRetryTimer?: NodeJS.Timeout;
  private schedulerRetryAttempt = 0;
  private scopedTurnEventTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: DiscourseRuntimeHostOptions) {
    this.coordinator = new DiscourseRuntimeCoordinator(
      options.discourseStore,
      options.runtimeStore
    );
    this.scheduler = new AgentTurnScheduler(options.runtimeStore);
    const resolver = new DiscourseContextResolver(options.taskStore);
    this.contextSnapshots = new DiscourseContextSnapshotService(
      resolver,
      new DiscourseWorkspace(
        options.workspaceRoot ??
          path.join(os.tmpdir(), 'task-monki-discourse-workspaces')
      ),
      async (input) => {
        if (!options.scopedTurnRouter) {
          throw new Error('No agent runtime is configured for Discourse.');
        }
        return options.scopedTurnRouter.buildExecutionContext(input.runtimeId, input);
      }
    );
    this.service = new DiscourseService(
      options.discourseStore,
      resolver,
      options.events,
      {
        getRuntimeCatalog: () => this.getRuntimeCatalog(),
        getAppSettings: () => structuredClone(options.getAppSettings()),
        ...(options.scopedTurnRouter
          ? {
              runtime: {
                coordinator: this.coordinator,
                contextSnapshots: this.contextSnapshots,
                provider: options.scopedTurnRouter,
                notifySchedulerWorkAvailable: () =>
                  this.notifySchedulerWorkAvailable()
              }
            }
          : {})
      }
    );
    this.disposeScopedTurnEvents = options.scopedTurnRouter?.subscribe((event) => {
      if (options.runtimeOperations.isClosing) return;
      const previousEvent = this.scopedTurnEventTail;
      this.scopedTurnEventTail = options.runtimeOperations.runOperation(async () => {
        await previousEvent;
        try {
          await this.ingestScopedTurnEvent(event);
        } catch {
          await this.recoverAfterScopedTurnIngestionFailure(event);
        }
      });
    });
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.options.runtimeStore.init(),
      this.options.discourseStore.init()
    ]);
    const conversationIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.options.discourseStore.listConversations({
        ...(cursor ? { cursor } : {}),
        limit: 100
      });
      page.conversations.forEach((conversation) =>
        conversationIds.add(conversation.id)
      );
      cursor = page.nextCursor;
    } while (cursor);
    const runtime = await this.options.runtimeStore.snapshot();
    runtime.runs.forEach((run) => {
      if (run.scope.kind === 'DISCOURSE') {
        conversationIds.add(run.scope.conversationId);
      }
    });
    for (const conversationId of conversationIds) {
      await this.service.recoverConversation(conversationId);
    }
    const recovered = await this.options.runtimeStore.snapshot();
    if (
      recovered.shutdownLatched &&
      !recovered.queueEntries.some((entry) => entry.status === 'LEASED')
    ) {
      await this.scheduler.reopenAfterRecovery(`service-startup:${Date.now()}`);
    }
    this.notifySchedulerWorkAvailable();
  }

  async beginShutdown(): Promise<void> {
    if (this.schedulerRetryTimer) {
      clearTimeout(this.schedulerRetryTimer);
      this.schedulerRetryTimer = undefined;
    }
    this.disposeScopedTurnEvents?.();
    await Promise.allSettled([this.scopedTurnEventTail]);
    for (const timer of this.deltaTimers.values()) clearTimeout(timer);
    this.deltaTimers.clear();
    this.deltaStates.clear();
  }

  async closeStores(): Promise<void> {
    const results = await Promise.allSettled([
      this.scheduler.latchShutdown(`service-shutdown:${Date.now()}`),
      this.options.discourseStore.close(),
      this.options.runtimeStore.close()
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failed) throw failed.reason;
  }

  private async getRuntimeCatalog(): Promise<AgentRuntimeCatalog> {
    const catalog = await this.options.getRuntimeCatalog();
    return {
      ...catalog,
      runtimes: catalog.runtimes.map((runtime) => {
        const runtimeId = runtime.preflight.runtime.id;
        const configured = this.options.scopedTurnRouter?.has(runtimeId) === true;
        return {
          ...runtime,
          preflight: {
            ...runtime.preflight,
            capabilities: {
              ...runtime.preflight.capabilities,
              extensions: {
                ...runtime.preflight.capabilities.extensions,
                'task-monki.discourse': configured
                  ? {
                      maturity: 'stable' as const,
                      detail:
                        'A scoped runtime binding attests read-only, offline Discourse execution.'
                    }
                  : {
                      maturity: 'unsupported' as const,
                      detail: `${runtime.preflight.runtime.displayName} is not configured for scoped Discourse turns.`
                    }
              }
            }
          }
        };
      })
    };
  }

  private notifySchedulerWorkAvailable(): void {
    if (
      this.options.runtimeOperations.isClosing ||
      this.options.providerStartupDisabledReason ||
      this.schedulerWork ||
      !this.options.scopedTurnRouter
    ) {
      return;
    }
    const work = this.options.runtimeOperations
      .runOperation(() => this.pumpScheduler())
      .finally(() => {
        if (this.schedulerWork === work) this.schedulerWork = undefined;
      });
    this.schedulerWork = work;
    void work.then(
      () => {
        this.schedulerRetryAttempt = 0;
      },
      (error) => this.scheduleSchedulerRetry(error)
    );
  }

  private scheduleSchedulerRetry(error: unknown): void {
    if (
      this.options.runtimeOperations.isClosing ||
      this.schedulerRetryTimer
    ) {
      return;
    }
    this.schedulerRetryAttempt += 1;
    const delayMs = Math.min(
      2_000,
      125 * 2 ** Math.min(this.schedulerRetryAttempt - 1, 4)
    );
    (this.options.logger ?? console).error(
      `Discourse scheduler dispatch failed; retrying in ${delayMs}ms.`,
      error
    );
    this.schedulerRetryTimer = setTimeout(() => {
      this.schedulerRetryTimer = undefined;
      this.notifySchedulerWorkAvailable();
    }, delayMs);
  }

  private async pumpScheduler(): Promise<void> {
    const router = this.options.scopedTurnRouter;
    if (!router) return;
    const recoveredRuntime = await this.options.runtimeStore.snapshot();
    if (
      recoveredRuntime.shutdownLatched &&
      !recoveredRuntime.queueEntries.some((entry) => entry.status === 'LEASED')
    ) {
      await this.scheduler.reopenAfterRecovery(`discourse-reopen:${Date.now()}`);
    }
    for (;;) {
      if (this.options.runtimeOperations.isClosing) return;
      const entries = await this.scheduler.leaseAvailable(
        `discourse-dispatch:${Date.now()}`,
        { ownerKinds: ['DISCOURSE'] }
      );
      if (entries.length === 0) return;
      for (const entry of entries) {
        if (entry.scope.kind !== 'DISCOURSE') continue;
        const scope = entry.scope;
        try {
          const aggregate = await this.options.discourseStore.getConversation(
            scope.conversationId
          );
          const snapshot = aggregate.contextSnapshots.find(
            (candidate) => candidate.id === scope.contextSnapshotId
          );
          if (
            !snapshot ||
            (await this.contextSnapshots.freshness(snapshot)) !== 'FRESH'
          ) {
            await this.coordinator.rejectLeasedJobForStaleContext(
              entry.id,
              `discourse-stale:${entry.id}:${entry.recordRevision}`
            );
            await this.service.advanceWave(
              scope.conversationId,
              scope.waveId,
              `discourse-stale:${entry.id}:advance`
            );
            continue;
          }
          const run = await this.coordinator.dispatchLeasedJob(
            entry.id,
            router,
            `discourse-dispatch:${entry.id}:${entry.recordRevision}`
          );
          this.emitJobUpdate(scope, run.id, {
            status: run.status,
            delivery: run.delivery
          });
        } catch (error) {
          await this.service.recoverConversation(scope.conversationId);
          const recoveredAggregate =
            await this.options.discourseStore.getConversation(scope.conversationId);
          const recoveredJob = recoveredAggregate.jobs.find(
            (candidate) => candidate.id === scope.jobId
          );
          this.emitJobUpdate(
            scope,
            undefined,
            recoveredJob
              ? {
                  status: recoveredJob.status,
                  delivery: recoveredJob.delivery
                }
              : { status: 'RECOVERY_REQUIRED' }
          );
          throw error;
        }
      }
    }
  }

  private async flushDeltas(runId: string, observedAt: string): Promise<void> {
    const timer = this.deltaTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.deltaTimers.delete(runId);
    }
    const current = this.deltaStates.get(runId);
    if (!current) return;
    const drained = drainDiscourseDeltas(current);
    this.deltaStates.set(runId, drained.state);
    if (!drained.publication) return;
    const run = await this.options.runtimeStore.getRun(runId);
    if (!run || run.scope.kind !== 'DISCOURSE') {
      this.deltaStates.delete(runId);
      return;
    }
    this.options.events.emit({
      type: 'discourse.delta',
      scope: {
        kind: 'DISCOURSE',
        conversationId: run.scope.conversationId,
        waveId: run.scope.waveId,
        jobId: run.scope.jobId
      },
      taskId: `discourse:${run.scope.conversationId}`,
      runId: run.id,
      payload: { jobId: run.scope.jobId, publication: drained.publication },
      at: observedAt
    });
  }

  private async ingestScopedTurnEvent(event: AgentScopedTurnEvent): Promise<void> {
    if (event.type === 'DELTA') {
      const run = await this.options.runtimeStore.getRun(event.runId);
      if (run?.scope.kind !== 'DISCOURSE') return;
      const current =
        this.deltaStates.get(run.id) ??
        createDiscourseDeltaAccumulator(run.scope.jobId, 1);
      const appended = appendDiscourseDelta(current, {
        jobId: run.scope.jobId,
        attempt: 1,
        text: event.text
      });
      this.deltaStates.set(run.id, appended.state);
      if (appended.accepted && !this.deltaTimers.has(run.id)) {
        const timer = setTimeout(() => {
          this.deltaTimers.delete(run.id);
          void this.flushDeltas(run.id, event.observedAt).catch(() => undefined);
        }, 75);
        timer.unref?.();
        this.deltaTimers.set(run.id, timer);
      }
      return;
    }

    if (event.type === 'RECOVERY_REQUIRED') {
      const run = await this.options.runtimeStore.getRun(event.runId);
      if (!run || run.scope.kind !== 'DISCOURSE') return;
      const scope = run.scope;
      await this.service.recoverConversation(scope.conversationId);
      const aggregate = await this.options.discourseStore.getConversation(
        scope.conversationId
      );
      const job = aggregate.jobs.find((candidate) => candidate.id === scope.jobId);
      this.emitJobUpdate(
        scope,
        run.id,
        job
          ? {
              status: job.status,
              delivery: job.delivery,
              reason: event.reason
            }
          : {
              status: 'RECOVERY_REQUIRED',
              delivery: run.delivery,
              reason: event.reason
            },
        event.observedAt
      );
      this.deltaStates.delete(run.id);
      this.notifySchedulerWorkAvailable();
      return;
    }

    const run = await this.options.runtimeStore.getRun(event.runId);
    if (!run || run.scope.kind !== 'DISCOURSE') return;
    await this.flushDeltas(run.id, event.completedAt);
    const scope = run.scope;
    const aggregate = await this.options.discourseStore.getConversation(
      scope.conversationId
    );
    const snapshot = aggregate.contextSnapshots.find(
      (candidate) => candidate.id === scope.contextSnapshotId
    );
    const body =
      event.finalMessage ??
      (await this.options.runtimeStore.readArtifact(run.outputArtifactId));
    const freshness = snapshot
      ? await this.contextSnapshots.freshness(snapshot)
      : (run.contextFreshnessAtCompletion ?? 'UNKNOWN');
    const operationId = `discourse-terminal:${event.runId}:${event.providerTurnId}`;
    if (event.status === 'completed' && body.trim()) {
      await this.coordinator.ingestSuccessfulTerminal({
        runId: event.runId,
        providerTurnId: event.providerTurnId,
        body,
        freshnessAtCompletion: freshness,
        clientOperationId: operationId,
        completedAt: event.completedAt,
        providerTerminalSource:
          run.providerTerminalSource ?? 'PROVIDER_TERMINAL_EVENT'
      });
    } else {
      await this.coordinator.ingestFailure({
        runId: event.runId,
        providerTurnId: event.providerTurnId,
        clientOperationId: operationId,
        completedAt: event.completedAt,
        providerTerminalSource:
          run.providerTerminalSource ?? 'PROVIDER_TERMINAL_EVENT',
        reason:
          event.error ??
          `Agent Discourse turn ended with status ${event.status}.`,
        ...(event.status === 'completed' && !body.trim()
          ? {
              error: {
                code: 'OUTPUT_MISSING' as const,
                message: 'The agent completed without a usable response.',
                category: 'VALIDATION' as const,
                retryable: true
              }
            }
          : {})
      });
    }
    await this.service.advanceWave(
      scope.conversationId,
      scope.waveId,
      `${operationId}:advance`
    );
    const settledAggregate = await this.options.discourseStore.getConversation(
      scope.conversationId
    );
    const settledJob = settledAggregate.jobs.find(
      (candidate) => candidate.id === scope.jobId
    );
    this.emitJobUpdate(
      scope,
      run.id,
      settledJob
        ? { status: settledJob.status, delivery: settledJob.delivery }
        : { status: event.status },
      event.completedAt
    );
    this.deltaStates.delete(run.id);
    this.notifySchedulerWorkAvailable();
  }

  private async recoverAfterScopedTurnIngestionFailure(
    event: AgentScopedTurnEvent
  ): Promise<void> {
    const run = await this.options.runtimeStore
      .getRun(event.runId)
      .catch(() => undefined);
    if (!run || run.scope.kind !== 'DISCOURSE') return;
    const scope = run.scope;
    await this.service
      .recoverConversation(scope.conversationId)
      .catch(() => undefined);
    const aggregate = await this.options.discourseStore
      .getConversation(scope.conversationId)
      .catch(() => undefined);
    const job = aggregate?.jobs.find((candidate) => candidate.id === scope.jobId);
    this.emitJobUpdate(
      scope,
      run.id,
      job
        ? { status: job.status, delivery: job.delivery }
        : {
            status: 'RECOVERY_REQUIRED',
            delivery: run.delivery,
            reason:
              'Agent output could not be durably incorporated. Recovery is required.'
          }
    );
    this.notifySchedulerWorkAvailable();
  }

  private emitJobUpdate(
    scope: {
      conversationId: string;
      waveId: string;
      jobId: string;
    },
    runId: string | undefined,
    payload: unknown,
    at = new Date().toISOString()
  ): void {
    this.options.events.emit({
      type: 'discourse.job.updated',
      scope: {
        kind: 'DISCOURSE',
        conversationId: scope.conversationId,
        waveId: scope.waveId,
        jobId: scope.jobId
      },
      taskId: `discourse:${scope.conversationId}`,
      ...(runId ? { runId } : {}),
      payload,
      at
    });
  }
}
