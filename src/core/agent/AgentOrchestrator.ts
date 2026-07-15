import { randomUUID } from 'node:crypto';
import type {
  AgentExecutionSettings,
  AgentProviderState,
  AgentReviewTarget,
  AgentRunMode,
  AgentSessionRecord,
  InteractionRequestRecord,
  RespondToInteractionRequest,
  RunRecord,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../shared/contracts';
import type { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import type { FileTaskStore } from '../storage/FileTaskStore';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  type AgentProviderAdapter
} from './AgentProviderAdapter';
import { AgentInteractionService } from './AgentInteractionService';
import {
  assertAttachmentSandboxSupportsDelivery,
  assertModelSupportsAttachments,
  toAgentTurnAttachments,
  type AgentTurnAttachment
} from './AgentAttachmentDelivery';
import {
  assertBrowserDevSettingsSafe,
  BROWSER_DEV_BOUNDARY_MESSAGE,
  browserDevSettingsViolations
} from './BrowserDevAgentBoundary';
import {
  createAgentSessionAccessEpoch
} from './AgentRuntimeOwnership';
import type { AgentRuntimeStore } from './AgentRuntimeStore';
import { AgentTurnScheduler } from './AgentTurnScheduler';
import type {
  AgentExecutionContext,
  AgentRuntimeArtifactKind,
  AgentRuntimePurpose,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord,
  AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';

const MAX_CONCURRENT_TURNS = 2;
const ACTIVE_RUN_STATUSES: RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
];
const RECOVERABLE_RUN_STATUSES: RunRecord['status'][] = [
  ...ACTIVE_RUN_STATUSES,
  'RECOVERY_REQUIRED'
];
export interface StartOrchestratedTurn {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  mode: AgentRunMode;
  prompt: string;
  settings: AgentExecutionSettings;
  generationKey?: string;
  beforeGitSnapshotId?: string;
  sessionId?: string;
  retryOfRunId?: string;
  continuedFromRunId?: string;
}

export interface StartOrchestratedReview {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  sourceRun: RunRecord;
  target: AgentReviewTarget;
  settings: AgentExecutionSettings;
  generationKey?: string;
  beforeGitSnapshotId?: string;
}

export class AgentOrchestrator {
  private startQueue: Promise<void> = Promise.resolve();
  private readonly interactions: AgentInteractionService;
  private taskPumpRunning = false;
  private taskPumpRequested = false;

  constructor(
    private readonly store: FileTaskStore,
    private readonly events: AppEventBus,
    private readonly adapter: AgentProviderAdapter,
    private readonly options: {
      allowNetworkAccess?: boolean;
      providerStartupDisabledReason?: string;
      runtimeStore?: AgentRuntimeStore;
      scheduler?: AgentTurnScheduler;
      dispatchNonTaskQueueEntry?: (entry: AgentSchedulerQueueEntry) => Promise<void>;
    } = {}
  ) {
    if (Boolean(options.runtimeStore) !== Boolean(options.scheduler)) {
      throw new Error('Task runtime scheduling requires both a runtime store and scheduler.');
    }
    if (options.dispatchNonTaskQueueEntry && !options.scheduler) {
      throw new Error('Non-task runtime dispatch requires the durable scheduler.');
    }
    this.interactions = new AgentInteractionService(
      store,
      events,
      adapter,
      options.runtimeStore
    );
    if (options.runtimeStore) {
      events.on((event) => {
        if (event.type === 'run.terminal' && event.runId) {
          void this.ingestTaskTerminal(event.runId).catch(() => undefined);
        }
      });
    }
  }

  async initialize(): Promise<void> {
    if (this.options.providerStartupDisabledReason) {
      await this.store.reconcileRunAttachments();
      return;
    }
    if (this.options.allowNetworkAccess === false) {
      await this.terminalizeUnsafePersistedRuns();
    }
    await this.store.reconcileRunAttachments();
    try {
      await this.adapter.initialize();
    } catch (error) {
      if (this.options.allowNetworkAccess === false) {
        await this.adapter.shutdown().catch(() => undefined);
        throw error;
      }
      // Provider readiness is exposed through preflight and should not prevent the
      // local task/evidence application from opening.
    }
    if (this.options.allowNetworkAccess === false) {
      const terminalizedAfterProviderInitialization =
        await this.terminalizeUnsafePersistedRuns();
      if (terminalizedAfterProviderInitialization > 0) {
        await this.adapter.shutdown().catch(() => undefined);
        throw new Error(
          `${BROWSER_DEV_BOUNDARY_MESSAGE} Provider recovery reported unsafe observed settings, so Codex was stopped before the development API credential was published.`
        );
      }
    }
    await this.reconcileTaskSchedulerAfterStartup();
  }

  async getProviderState(): Promise<AgentProviderState> {
    if (this.options.providerStartupDisabledReason) {
      return {
        preflight: {
          provider: 'codex',
          ready: false,
          capabilities: await this.adapter.capabilities(),
          problems: [this.options.providerStartupDisabledReason],
          warnings: []
        },
        models: [],
        refreshedAt: new Date().toISOString()
      };
    }
    const preflight = await this.adapter.preflight();
    let models: AgentProviderState['models'] = [];
    if (preflight.ready) {
      try {
        models = await this.adapter.listModels();
      } catch (error) {
        preflight.ready = false;
        preflight.problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { preflight, models, refreshedAt: new Date().toISOString() };
  }

  startTurn(input: StartOrchestratedTurn): Promise<RunRecord> {
    const operation = this.startQueue.then(() => this.startTurnSerially(input));
    this.startQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async startTurnSerially(input: StartOrchestratedTurn): Promise<RunRecord> {
    if (this.options.runtimeStore && this.options.scheduler) {
      return this.queueTaskTurn(input);
    }
    this.assertProviderStartupAvailable();
    const taskAttachments = await this.store.getTaskAttachments(input.task.id);
    const settings = await this.validateSettings(
      input.settings,
      taskAttachments
    );
    await this.assertCapacity();

    let session = input.sessionId
      ? await this.requireSession(input.sessionId)
      : (await this.store.getPrimaryAgentSession(input.task.id, input.iteration.id)) ??
        (await this.store.createAgentSession({
          task: input.task,
          iteration: input.iteration,
          worktree: input.worktree,
          provider: 'codex',
          requestedSettings: settings
        }));
    if (
      session.taskId !== input.task.id ||
      session.iterationId !== input.iteration.id ||
      session.worktreeId !== input.worktree.id
    ) {
      throw new Error('Selected agent session does not belong to this task iteration.');
    }
    await this.assertBrowserDevSessionHistory(session, 'Selected session');
    await this.assertNoPendingInteractions(session.id);

    const activeSessionRun = await this.store.getActiveRunForSession(session.id);
    if (activeSessionRun) {
      throw new Error(
        `Agent session ${session.id} already has active run ${activeSessionRun.id}.`
      );
    }

    if (!session.providerSessionId) {
      session = await this.adapter.createSession({
        localSessionId: session.id,
        taskId: input.task.id,
        iterationId: input.iteration.id,
        worktreeId: input.worktree.id,
        worktreePath: input.worktree.worktreePath,
        settings
      });
      await this.assertBrowserDevSessionHistory(session, 'Created session');
    }

    const run = await this.store.createRun({
      task: input.task,
      session,
      mode: input.mode,
      prompt: input.prompt,
      generationKey: input.generationKey,
      requestedSettings: settings,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      retryOfRunId: input.retryOfRunId,
      continuedFromRunId: input.continuedFromRunId
    });

    let attachments: AgentTurnAttachment[] = [];
    try {
      attachments = toAgentTurnAttachments(
        await this.store.prepareRunAttachments(run.id, input.task.id)
      );
      await this.startProviderTurn(run, session, input, settings, attachments);
      return (await this.store.getRun(run.id)) ?? run;
    } catch (error) {
      if (error instanceof AgentProviderSessionMissingError) {
        try {
          const recovered = await this.recreateMissingProviderSession(
            session,
            settings,
            error
          );
          await this.assertBrowserDevSessionHistory(recovered, 'Recreated session');
          await this.startProviderTurn(run, recovered, input, settings, attachments);
          return (await this.store.getRun(run.id)) ?? run;
        } catch (retryError) {
          await this.recordStartFailure(run, retryError);
          throw retryError;
        }
      }
      await this.recordStartFailure(run, error);
      throw error;
    }
  }

  private async queueTaskTurn(input: StartOrchestratedTurn): Promise<RunRecord> {
    this.assertProviderStartupAvailable();
    const taskAttachments = await this.store.getTaskAttachments(input.task.id);
    const settings = await this.validateSettings(input.settings, taskAttachments);
    const attachments = toAgentTurnAttachments(
      await this.store.verifyTaskAttachments(input.task.id)
    );
    const resolved = await this.resolveTaskRuntimeSession(input, settings, attachments);
    const run = await this.store.createRun({
      task: input.task,
      session: resolved.taskSession,
      mode: input.mode,
      prompt: input.prompt,
      generationKey: input.generationKey,
      requestedSettings: settings,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      retryOfRunId: input.retryOfRunId,
      continuedFromRunId: input.continuedFromRunId
    });
    try {
      await this.createAndEnqueueTaskRuntime({
        taskRun: run,
        runtimeSession: resolved.runtimeSession,
        executionContext: resolved.executionContext,
        purpose: runtimePurposeForTaskMode(input.mode),
        generationKey: input.generationKey,
        prompt: input.prompt
      });
    } catch (error) {
      await this.recordStartFailure(run, error);
      throw error;
    }
    this.requestTaskPump();
    return run;
  }

  private async createAndEnqueueTaskRuntime(input: {
    taskRun: RunRecord;
    runtimeSession: AgentRuntimeSessionRecord;
    executionContext: AgentExecutionContext;
    purpose: AgentRuntimePurpose;
    generationKey?: string;
    prompt: string;
    taskReviewTarget?: AgentReviewTarget;
  }): Promise<AgentRuntimeRunRecord> {
    const runtime = this.requireRuntimeStore();
    const runtimeRun = await runtime.createRun({
      id: input.taskRun.id,
      owner: { kind: 'TASK', taskId: input.taskRun.taskId },
      scope: {
        kind: 'TASK',
        taskId: input.taskRun.taskId,
        iterationId: input.taskRun.iterationId,
        worktreeId: input.taskRun.worktreeId
      },
      sessionId: input.runtimeSession.id,
      sessionAccessEpoch: input.runtimeSession.accessEpoch.epoch,
      purpose: input.purpose,
      parentRunId: input.taskRun.parentRunId ?? input.taskRun.continuedFromRunId,
      taskReviewTarget: input.taskReviewTarget,
      generationKey: input.generationKey ?? `task-run-${input.taskRun.id}`,
      clientOperationId: `task-run:${input.taskRun.id}`,
      requestedSettings: input.executionContext.modelSettings,
      promptArtifactId: input.taskRun.promptArtifactId,
      outputArtifactId: input.taskRun.outputArtifactId,
      diagnosticArtifactId: input.taskRun.diagnosticArtifactId
    });
    await Promise.all([
      runtime.createArtifact({
        id: runtimeRun.promptArtifactId,
        owner: runtimeRun.owner,
        runId: runtimeRun.id,
        kind: 'PROMPT',
        clientOperationId: `task-artifact:${runtimeRun.id}:prompt`,
        content: input.prompt
      }),
      runtime.createArtifact({
        id: runtimeRun.outputArtifactId,
        owner: runtimeRun.owner,
        runId: runtimeRun.id,
        kind: 'OUTPUT',
        clientOperationId: `task-artifact:${runtimeRun.id}:output`,
        content: ''
      }),
      runtime.createArtifact({
        id: runtimeRun.diagnosticArtifactId,
        owner: runtimeRun.owner,
        runId: runtimeRun.id,
        kind: 'DIAGNOSTIC',
        clientOperationId: `task-artifact:${runtimeRun.id}:diagnostic`,
        content: ''
      })
    ]);
    await runtime.enqueueRun(
      runtimeRun.id,
      'TASK_FOREGROUND',
      `task-enqueue:${runtimeRun.id}`
    );
    return runtimeRun;
  }

  private async resolveTaskRuntimeSession(
    input: StartOrchestratedTurn,
    settings: AgentExecutionSettings,
    attachments: AgentTurnAttachment[]
  ): Promise<{
    taskSession: AgentSessionRecord;
    runtimeSession: AgentRuntimeSessionRecord;
    executionContext: AgentExecutionContext;
  }> {
    const runtime = this.requireRuntimeStore();
    const describe = this.adapter.describeExecutionContext;
    if (!describe) {
      throw new Error('The configured provider cannot attest a task execution context.');
    }
    let taskSession = input.sessionId
      ? await this.requireSession(input.sessionId)
      : (await this.store.getPrimaryAgentSession(input.task.id, input.iteration.id)) ??
        (await this.store.createAgentSession({
          task: input.task,
          iteration: input.iteration,
          worktree: input.worktree,
          provider: 'codex',
          requestedSettings: settings
        }));
    assertTaskSessionOwnership(taskSession, input);

    let executionContext = await describe.call(this.adapter, {
      sessionId: taskSession.id,
      worktreePath: input.worktree.worktreePath,
      settings,
      attachments,
      clientOperationId: `task-session-context:${taskSession.id}`
    });
    let accessEpoch = createAgentSessionAccessEpoch({
      owner: { kind: 'TASK', taskId: input.task.id },
      sessionId: taskSession.id,
      epoch: 1,
      providerId: taskSession.provider,
      model: requireResolvedModel(executionContext),
      executionContext,
      createdAt: taskSession.createdAt
    });
    let runtimeSession = await runtime.getSession(taskSession.id);
    const canReuse = runtimeSession
      ? runtimeSession.owner.kind === 'TASK' &&
        runtimeSession.owner.taskId === input.task.id &&
        runtimeSession.accessEpoch.executionProfileHash === accessEpoch.executionProfileHash
      : !taskSession.providerSessionId;
    if (!canReuse) {
      taskSession = await this.store.createAgentSession({
        task: input.task,
        iteration: input.iteration,
        worktree: input.worktree,
        provider: 'codex',
        requestedSettings: settings,
        forceNew: true
      });
      executionContext = await describe.call(this.adapter, {
        sessionId: taskSession.id,
        worktreePath: input.worktree.worktreePath,
        settings,
        attachments,
        clientOperationId: `task-session-context:${taskSession.id}`
      });
      accessEpoch = createAgentSessionAccessEpoch({
        owner: { kind: 'TASK', taskId: input.task.id },
        sessionId: taskSession.id,
        epoch: 1,
        providerId: taskSession.provider,
        model: requireResolvedModel(executionContext),
        executionContext,
        createdAt: taskSession.createdAt
      });
      runtimeSession = undefined;
    }
    runtimeSession ??= await runtime.createSession({
      id: taskSession.id,
      owner: { kind: 'TASK', taskId: input.task.id },
      accessEpoch,
      executionContext,
      clientOperationId: `task-session:${taskSession.id}`,
      provider: taskSession.provider,
      role: taskSession.role,
      parentSessionId: taskSession.parentSessionId,
      forkedFromSessionId: taskSession.forkedFromSessionId,
      providerParentSessionId: taskSession.providerParentSessionId,
      providerForkedFromSessionId: taskSession.providerForkedFromSessionId,
      parentRunId: taskSession.parentRunId,
      relationshipState: taskSession.relationshipState,
      relationshipDetail: taskSession.relationshipDetail,
      providerNickname: taskSession.providerNickname,
      providerRole: taskSession.providerRole,
      delegatedPrompt: taskSession.delegatedPrompt,
      agentPath: taskSession.agentPath,
      subagentStatus: taskSession.subagentStatus,
      status: taskSession.status,
      materialized: false,
      requestedSettings: executionContext.modelSettings,
      observedSettings: taskSession.observedSettings
    });
    return { taskSession, runtimeSession, executionContext };
  }

  private requestTaskPump(): void {
    if (!this.options.runtimeStore || !this.options.scheduler) return;
    this.taskPumpRequested = true;
    if (this.taskPumpRunning) return;
    void this.pumpTaskQueue().catch(() => undefined);
  }

  notifySchedulerWorkAvailable(): void {
    this.requestTaskPump();
  }

  private async pumpTaskQueue(): Promise<void> {
    if (this.taskPumpRunning || !this.options.scheduler) return;
    this.taskPumpRunning = true;
    try {
      do {
        this.taskPumpRequested = false;
        const leased = await this.options.scheduler.leaseAvailable(
          `task-pump:${randomUUID()}`,
          this.options.dispatchNonTaskQueueEntry ? {} : { ownerKinds: ['TASK'] }
        );
        await Promise.all(
          leased.map(async (entry) => {
            if (entry.owner.kind !== 'TASK') {
              try {
                await this.options.dispatchNonTaskQueueEntry!(entry);
              } catch {
                // The scoped coordinator owns its durable failure/recovery transition.
                // A provably failed start may have released capacity for another entry.
                this.requestTaskPump();
              }
              return;
            }
            try {
              await this.dispatchTaskQueueEntry(entry);
            } catch (error) {
              await this.failLeasedTaskQueueEntry(entry, error);
            }
          })
        );
      } while (this.taskPumpRequested);
    } finally {
      this.taskPumpRunning = false;
      if (this.taskPumpRequested) this.requestTaskPump();
    }
  }

  private async dispatchTaskQueueEntry(entry: AgentSchedulerQueueEntry): Promise<void> {
    const runtime = this.requireRuntimeStore();
    let runtimeRun = await runtime.getRun(entry.runId);
    const taskRun = await this.store.getRun(entry.runId);
    if (!runtimeRun || runtimeRun.scope.kind !== 'TASK' || !taskRun) {
      throw new Error('A leased task queue entry lost its task/runtime projection.');
    }
    const [task, iteration, worktree] = await Promise.all([
      this.store.getTask(taskRun.taskId),
      this.store.getIteration(taskRun.iterationId),
      this.store.getWorktree(taskRun.worktreeId)
    ]);
    if (!task || !iteration || !worktree) {
      throw new Error('A leased task queue entry lost its task execution context.');
    }
    let taskSession = await this.requireSession(taskRun.sessionId);
    runtimeRun = await runtime.updateRun(
      runtimeRun.id,
      runtimeRun.recordRevision,
      { status: 'STARTING', delivery: 'SENDING', startedAt: new Date().toISOString() },
      `task-dispatch-intent:${runtimeRun.id}`
    );
    try {
      const attachments = toAgentTurnAttachments(
        await this.store.prepareRunAttachments(taskRun.id, task.id)
      );
      const started = runtimeRun.purpose === 'TASK_REVIEW'
        ? await this.dispatchTaskReview(
            runtimeRun,
            taskRun,
            taskSession,
            attachments
          )
        : await this.dispatchTaskTurn(
            task,
            iteration,
            worktree,
            taskRun,
            taskSession,
            attachments
          );
      taskSession = await this.requireSession(taskRun.sessionId);
      await this.syncTaskRuntimeSession(taskSession);
      const current = await runtime.getRun(runtimeRun.id);
      if (current && !isTerminalRuntimeRun(current)) {
        await runtime.updateRun(
          current.id,
          current.recordRevision,
          {
            status: 'RUNNING',
            delivery: 'ACKNOWLEDGED',
            ...(started.providerTurnId ? { providerTurnId: started.providerTurnId } : {}),
            lastEventAt: new Date().toISOString()
          },
          `task-dispatch-ack:${current.id}`
        );
      }
    } catch (error) {
      await this.recordStartFailure(taskRun, error);
      const current = await runtime.getRun(runtimeRun.id);
      if (current && !isTerminalRuntimeRun(current)) {
        if (error instanceof AgentMutationAmbiguousError) {
          await runtime.updateRun(
            current.id,
            current.recordRevision,
            {
              status: 'RECOVERY_REQUIRED',
              delivery: 'AMBIGUOUS',
              recoveryState: 'REQUIRES_USER_ACTION',
              terminalReason: error.message,
              lastEventAt: new Date().toISOString()
            },
            `task-dispatch-ambiguous:${current.id}`
          );
        } else {
          await runtime.updateRun(
            current.id,
            current.recordRevision,
            {
              status: 'FAILED',
              delivery: 'NOT_DELIVERED',
              recoveryState: 'NONE',
              terminalReason: error instanceof Error ? error.message : String(error),
              endedAt: new Date().toISOString()
            },
            `task-dispatch-failed:${current.id}`
          );
          await this.settleTaskQueueEntry(current.id);
          this.requestTaskPump();
        }
      }
    }
  }

  private async dispatchTaskTurn(
    task: Task,
    iteration: TaskIteration,
    worktree: WorktreeRecord,
    taskRun: RunRecord,
    taskSession: AgentSessionRecord,
    attachments: AgentTurnAttachment[]
  ) {
    let session = taskSession;
    if (!session.providerSessionId) {
      session = await this.adapter.createSession({
        localSessionId: session.id,
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        worktreePath: worktree.worktreePath,
        settings: taskRun.requestedSettings
      });
    }
    return this.adapter.startTurn({
      localRunId: taskRun.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: taskRun.mode,
      prompt: await this.store.readArtifact(taskRun.promptArtifactId),
      authoritativeGoal: task.prompt,
      attachments,
      settings: taskRun.requestedSettings
    });
  }

  private async dispatchTaskReview(
    runtimeRun: AgentRuntimeRunRecord,
    taskRun: RunRecord,
    reviewSession: AgentSessionRecord,
    attachments: AgentTurnAttachment[]
  ) {
    if (!this.adapter.startReview || !runtimeRun.taskReviewTarget) {
      throw new Error('The queued task review is missing provider or target metadata.');
    }
    const sourceRunId = taskRun.continuedFromRunId;
    const sourceRun = sourceRunId ? await this.store.getRun(sourceRunId) : undefined;
    if (!sourceRun) {
      throw new Error('The queued task review lost its source run.');
    }
    let sourceSession = await this.requireSession(sourceRun.sessionId);
    try {
      return await this.adapter.startReview({
        localRunId: taskRun.id,
        sourceSession: {
          localSessionId: sourceSession.id,
          providerSessionId: sourceSession.providerSessionId
        },
        reviewSessionId: reviewSession.id,
        target: runtimeRun.taskReviewTarget,
        attachments
      });
    } catch (error) {
      if (!(error instanceof AgentProviderSessionMissingError)) throw error;
      sourceSession = await this.recreateMissingProviderSession(
        sourceSession,
        sourceSession.requestedSettings,
        error
      );
      return this.adapter.startReview({
        localRunId: taskRun.id,
        sourceSession: {
          localSessionId: sourceSession.id,
          providerSessionId: sourceSession.providerSessionId
        },
        reviewSessionId: reviewSession.id,
        target: runtimeRun.taskReviewTarget,
        attachments
      });
    }
  }

  private async failLeasedTaskQueueEntry(
    entry: AgentSchedulerQueueEntry,
    error: unknown
  ): Promise<void> {
    const runtime = this.requireRuntimeStore();
    const message = error instanceof Error ? error.message : String(error);
    const taskRun = await this.store.getRun(entry.runId);
    if (taskRun && !isTerminalTaskRun(taskRun)) {
      await this.recordStartFailure(taskRun, error).catch(() => undefined);
    }
    const current = await runtime.getRun(entry.runId);
    if (current && !isTerminalRuntimeRun(current)) {
      if (error instanceof AgentMutationAmbiguousError) {
        await runtime.updateRun(
          current.id,
          current.recordRevision,
          {
            status: 'RECOVERY_REQUIRED',
            delivery: 'AMBIGUOUS',
            recoveryState: 'REQUIRES_USER_ACTION',
            terminalReason: message,
            lastEventAt: new Date().toISOString()
          },
          `task-lease-ambiguous:${current.id}:${current.recordRevision}`
        );
        return;
      }
      await runtime.updateRun(
        current.id,
        current.recordRevision,
        {
          status: taskRun ? 'FAILED' : 'LOST',
          delivery: 'NOT_DELIVERED',
          recoveryState: 'NONE',
          terminalReason: message,
          endedAt: new Date().toISOString()
        },
        `task-lease-failed:${current.id}:${current.recordRevision}`
      );
    }
    await this.settleTaskQueueEntry(entry.runId);
    this.requestTaskPump();
  }

  private async syncTaskRuntimeSession(taskSession: AgentSessionRecord): Promise<void> {
    const runtime = this.requireRuntimeStore();
    const current = await runtime.getSession(taskSession.id);
    if (!current) {
      throw new Error(`Task runtime session not found: ${taskSession.id}`);
    }
    if (
      current.providerSessionId === taskSession.providerSessionId &&
      current.providerSessionTreeId === taskSession.providerSessionTreeId &&
      current.status === taskSession.status &&
      current.materialized
    ) {
      return;
    }
    await runtime.updateSession(
      current.id,
      current.recordRevision,
      {
        ...(taskSession.providerSessionId
          ? { providerSessionId: taskSession.providerSessionId }
          : {}),
        ...(taskSession.providerSessionTreeId
          ? { providerSessionTreeId: taskSession.providerSessionTreeId }
          : {}),
        status: taskSession.status,
        materialized: Boolean(taskSession.providerSessionId),
        observedSettings: taskSession.observedSettings,
        lastAttachedAt: taskSession.lastAttachedAt
      },
      `task-session-sync:${current.id}:${current.recordRevision}`
    );
  }

  private async ingestTaskTerminal(runId: string): Promise<void> {
    const runtime = this.options.runtimeStore;
    if (!runtime) return;
    let current = await runtime.getRun(runId);
    if (!current || current.scope.kind !== 'TASK') return;
    const taskRun = await this.store.getRun(runId);
    if (!taskRun || !isTerminalTaskRun(taskRun)) return;

    const output = await runtime.getArtifact(current.outputArtifactId);
    if (output) {
      const [runtimeOutput, taskOutput] = await Promise.all([
        runtime.readArtifact(output.id),
        this.store.readArtifact(taskRun.outputArtifactId)
      ]);
      if (runtimeOutput !== taskOutput) {
        await runtime.updateArtifact({
          artifactId: output.id,
          expectedRevision: output.recordRevision,
          clientOperationId: `task-terminal-output:${runId}:${output.recordRevision}`,
          content: taskOutput
        });
      }
    }

    current = (await runtime.getRun(runId)) ?? current;
    if (!isTerminalRuntimeRun(current)) {
      if (current.delivery === 'SENDING' || current.delivery === 'AMBIGUOUS') {
        current = await runtime.updateRun(
          current.id,
          current.recordRevision,
          {
            status: current.status === 'QUEUED' ? 'STARTING' : 'RUNNING',
            delivery: 'ACKNOWLEDGED',
            ...(taskRun.providerTurnId ? { providerTurnId: taskRun.providerTurnId } : {}),
            lastEventAt: taskRun.lastEventAt ?? new Date().toISOString()
          },
          `task-terminal-ack:${runId}`
        );
      }
      const delivery =
        current.delivery === 'ACKNOWLEDGED' || current.delivery === 'AMBIGUOUS'
          ? 'TERMINAL' as const
          : current.delivery;
      await runtime.updateRun(
        current.id,
        current.recordRevision,
        {
          status: taskRun.status,
          delivery,
          recoveryState: taskRun.recoveryState,
          observedSettings: taskRun.observedSettings,
          terminalReason: taskRun.terminalReason,
          providerTerminalSource: taskRun.providerTerminalSource,
          ...(taskRun.providerTurnId ? { providerTurnId: taskRun.providerTurnId } : {}),
          lastEventAt: taskRun.lastEventAt ?? taskRun.endedAt ?? new Date().toISOString(),
          endedAt: taskRun.endedAt ?? new Date().toISOString()
        },
        `task-terminal:${runId}:${taskRun.status}`
      );
    }
    const session = await runtime.getSession(current.sessionId);
    if (
      session &&
      ['ACTIVE', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(session.status)
    ) {
      await runtime.updateSession(
        session.id,
        session.recordRevision,
        { status: 'IDLE' },
        `task-terminal-session:${runId}`
      );
    }
    await this.settleTaskQueueEntry(runId);
    this.requestTaskPump();
  }

  private async settleTaskQueueEntry(runId: string): Promise<void> {
    const runtime = this.requireRuntimeStore();
    const entry = (await runtime.snapshot()).queueEntries.find(
      (candidate) => candidate.runId === runId
    );
    if (!entry || entry.status === 'SETTLED' || entry.status === 'CANCELED') return;
    if (entry.status === 'QUEUED') {
      await runtime.cancelQueueEntry(
        entry.id,
        entry.recordRevision,
        'Task run reached a terminal state before provider dispatch.',
        `task-terminal-queue-cancel:${runId}`
      );
      return;
    }
    await runtime.settleQueueEntry(
      entry.id,
      entry.recordRevision,
      `task-terminal-queue-settle:${runId}`
    );
  }

  private async reconcileTaskSchedulerAfterStartup(): Promise<void> {
    const runtime = this.options.runtimeStore;
    const scheduler = this.options.scheduler;
    if (!runtime || !scheduler) return;
    await this.repairTaskRuntimeLinks();
    const snapshot = await runtime.snapshot();
    for (const entry of snapshot.queueEntries.filter(
      (candidate) => candidate.owner.kind === 'TASK' && candidate.status === 'LEASED'
    )) {
      const run = snapshot.runs.find((candidate) => candidate.id === entry.runId);
      if (!run) continue;
      if (run.status === 'QUEUED' && run.delivery === 'NOT_SENT') {
        await runtime.releaseQueueEntry(
          entry.id,
          entry.recordRevision,
          `task-startup-release:${run.id}`
        );
        this.taskPumpRequested = true;
        continue;
      }
      const taskRun = await this.store.getRun(run.id);
      if (taskRun && isTerminalTaskRun(taskRun)) {
        await this.ingestTaskTerminal(run.id);
        continue;
      }
      if (!isTerminalRuntimeRun(run) && run.status !== 'RECOVERY_REQUIRED') {
        if (taskRun && !isTerminalTaskRun(taskRun)) {
          await this.store.appendEvent(
            createDomainEvent({
              type: 'AGENT_RUNTIME_LOST',
              taskId: taskRun.taskId,
              iterationId: taskRun.iterationId,
              runId: taskRun.id,
              worktreeId: taskRun.worktreeId,
              agentSessionId: taskRun.sessionId,
              serverInstanceId: taskRun.serverInstanceId,
              source: 'process',
              payload: {
                reason:
                  'Task Monki restarted after provider submission without an authoritative terminal.'
              }
            })
          );
        }
        await runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'RECOVERY_REQUIRED',
            delivery: run.delivery === 'NOT_SENT' ? 'NOT_DELIVERED' : 'AMBIGUOUS',
            recoveryState: 'REQUIRES_USER_ACTION',
            terminalReason:
              'Task Monki restarted after leasing this task turn without an authoritative terminal.',
            lastEventAt: new Date().toISOString()
          },
          `task-startup-recovery:${run.id}`
        );
      }
    }
    const recovered = await runtime.snapshot();
    if (
      recovered.shutdownLatched &&
      !recovered.queueEntries.some((entry) => entry.status === 'LEASED')
    ) {
      await scheduler.reopenAfterRecovery(`task-startup-reopen:${randomUUID()}`);
    }
    if (
      this.taskPumpRequested ||
      snapshot.queueEntries.some((entry) =>
        entry.status === 'QUEUED' &&
        (entry.owner.kind === 'TASK' || Boolean(this.options.dispatchNonTaskQueueEntry))
      )
    ) {
      this.requestTaskPump();
    }
  }

  private async repairTaskRuntimeLinks(): Promise<void> {
    const runtime = this.requireRuntimeStore();
    const [taskSnapshot, runtimeSnapshot] = await Promise.all([
      this.store.snapshot(),
      runtime.snapshot()
    ]);
    const runtimeByRunId = new Map(runtimeSnapshot.runs.map((run) => [run.id, run]));
    const taskByRunId = new Map(taskSnapshot.runs.map((run) => [run.id, run]));
    const recoverableTaskStatuses: RunRecord['status'][] = [
      'QUEUED',
      'STARTING',
      'RUNNING',
      'AWAITING_APPROVAL',
      'AWAITING_USER_INPUT',
      'INTERRUPTING'
    ];
    for (const taskRun of taskSnapshot.runs.filter((run) =>
      recoverableTaskStatuses.includes(run.status)
    )) {
      if (runtimeByRunId.has(taskRun.id)) continue;
      if (taskRun.providerTurnId) {
        await this.store.appendEvent(
          createDomainEvent({
            type: 'AGENT_RUNTIME_LOST',
            taskId: taskRun.taskId,
            iterationId: taskRun.iterationId,
            runId: taskRun.id,
            worktreeId: taskRun.worktreeId,
            agentSessionId: taskRun.sessionId,
            serverInstanceId: taskRun.serverInstanceId,
            source: 'storage',
            payload: {
              reason:
                'The task projection contains a provider turn without its owner-neutral runtime record. It was not replayed.'
            }
          })
        );
      } else {
        await this.recordStartFailure(
          taskRun,
          new Error(
            'Task Monki recovered a queued task action whose durable runtime record was never published. No provider turn was sent; retry is safe.'
          )
        );
      }
    }

    for (const run of runtimeSnapshot.runs.filter(
      (candidate) => candidate.owner.kind === 'TASK'
    )) {
      const taskRun = taskByRunId.get(run.id);
      if (!taskRun) {
        if (!isTerminalRuntimeRun(run)) {
          throw new Error(
            `Owner-neutral task runtime ${run.id} has no task projection; provider recovery is required before startup can continue.`
          );
        }
        continue;
      }
      if (isTerminalTaskRun(taskRun)) {
        await this.ingestTaskTerminal(run.id);
        continue;
      }
      const queue = runtimeSnapshot.queueEntries.find((entry) => entry.runId === run.id);
      if (run.status === 'QUEUED' && run.delivery === 'NOT_SENT' && !queue) {
        await this.repairTaskRuntimeArtifacts(run, taskRun);
        await runtime.enqueueRun(
          run.id,
          'TASK_FOREGROUND',
          `task-startup-enqueue-repair:${run.id}`
        );
        this.taskPumpRequested = true;
      }
    }
  }

  private async repairTaskRuntimeArtifacts(
    runtimeRun: AgentRuntimeRunRecord,
    taskRun: RunRecord
  ): Promise<void> {
    const runtime = this.requireRuntimeStore();
    const artifacts: Array<readonly [string, AgentRuntimeArtifactKind]> = [
      [runtimeRun.promptArtifactId, 'PROMPT'],
      [runtimeRun.outputArtifactId, 'OUTPUT'],
      [runtimeRun.diagnosticArtifactId, 'DIAGNOSTIC']
    ];
    for (const [artifactId, kind] of artifacts) {
      if (await runtime.getArtifact(artifactId)) continue;
      await runtime.createArtifact({
        id: artifactId,
        owner: runtimeRun.owner,
        runId: runtimeRun.id,
        kind,
        clientOperationId: `task-startup-artifact-repair:${artifactId}`,
        content: await this.store.readArtifact(
          kind === 'PROMPT'
            ? taskRun.promptArtifactId
            : kind === 'OUTPUT'
              ? taskRun.outputArtifactId
              : taskRun.diagnosticArtifactId
        )
      });
    }
  }

  private requireRuntimeStore(): AgentRuntimeStore {
    if (!this.options.runtimeStore) {
      throw new Error('Owner-neutral agent runtime storage is not configured.');
    }
    return this.options.runtimeStore;
  }

  startReview(input: StartOrchestratedReview): Promise<RunRecord> {
    const operation = this.startQueue.then(() => this.startReviewSerially(input));
    this.startQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async startReviewSerially(
    input: StartOrchestratedReview
  ): Promise<RunRecord> {
    this.assertProviderStartupAvailable();
    if (!this.adapter.startReview) {
      throw new Error('This provider does not support detached review.');
    }
    if (this.options.runtimeStore && this.options.scheduler) {
      return this.queueTaskReview(input);
    }
    const taskAttachments = await this.store.getTaskAttachments(input.task.id);
    const settings = await this.validateSettings(input.settings, taskAttachments);
    await this.assertCapacity();
    const sourceSession = await this.requireSession(input.sourceRun.sessionId);
    this.assertBrowserDevSettings(input.sourceRun.requestedSettings, 'Review source run');
    if (input.sourceRun.observedSettings) {
      this.assertBrowserDevSettings(
        input.sourceRun.observedSettings,
        'Review source run observed settings'
      );
    }
    await this.assertBrowserDevSessionHistory(sourceSession, 'Review source session');
    await this.assertNoPendingInteractions(sourceSession.id);
    const reviewSession = await this.store.createAgentSession({
      task: input.task,
      iteration: input.iteration,
      worktree: input.worktree,
      provider: sourceSession.provider,
      role: 'REVIEW',
      requestedSettings: settings,
      parentSessionId: sourceSession.id,
      forkedFromSessionId: sourceSession.id
    });
    const run = await this.store.createRun({
      task: input.task,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: describeReviewTarget(input.target),
      generationKey: input.generationKey,
      requestedSettings: settings,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      continuedFromRunId: input.sourceRun.id
    });
    let attachments: AgentTurnAttachment[] = [];
    try {
      attachments = toAgentTurnAttachments(
        await this.store.prepareRunAttachments(run.id, input.task.id)
      );
      await this.startProviderReview(
        run,
        sourceSession,
        reviewSession,
        input.target,
        attachments
      );
      return (await this.store.getRun(run.id)) ?? run;
    } catch (error) {
      if (error instanceof AgentProviderSessionMissingError) {
        try {
          const recovered = await this.recreateMissingProviderSession(
            sourceSession,
            settings,
            error
          );
          await this.assertBrowserDevSessionHistory(
            recovered,
            'Recreated review source session'
          );
          await this.startProviderReview(
            run,
            recovered,
            reviewSession,
            input.target,
            attachments
          );
          return (await this.store.getRun(run.id)) ?? run;
        } catch (retryError) {
          await this.recordStartFailure(run, retryError);
          throw retryError;
        }
      }
      await this.recordStartFailure(run, error);
      throw error;
    }
  }

  private async queueTaskReview(input: StartOrchestratedReview): Promise<RunRecord> {
    if (
      input.sourceRun.taskId !== input.task.id ||
      input.sourceRun.iterationId !== input.iteration.id ||
      input.sourceRun.worktreeId !== input.worktree.id
    ) {
      throw new Error('Review source run does not belong to this task iteration.');
    }
    const taskAttachments = await this.store.getTaskAttachments(input.task.id);
    const settings = await this.validateSettings(input.settings, taskAttachments);
    const attachments = toAgentTurnAttachments(
      await this.store.verifyTaskAttachments(input.task.id)
    );
    const sourceSession = await this.requireSession(input.sourceRun.sessionId);
    this.assertBrowserDevSettings(input.sourceRun.requestedSettings, 'Review source run');
    if (input.sourceRun.observedSettings) {
      this.assertBrowserDevSettings(
        input.sourceRun.observedSettings,
        'Review source run observed settings'
      );
    }
    await this.assertBrowserDevSessionHistory(sourceSession, 'Review source session');
    await this.assertNoPendingInteractions(sourceSession.id);
    const reviewSession = await this.store.createAgentSession({
      task: input.task,
      iteration: input.iteration,
      worktree: input.worktree,
      provider: sourceSession.provider,
      role: 'REVIEW',
      requestedSettings: settings,
      parentSessionId: sourceSession.id,
      forkedFromSessionId: sourceSession.id,
      forceNew: true
    });
    const { runtimeSession, executionContext } =
      await this.createFreshTaskRuntimeSession(
        input.task,
        reviewSession,
        input.worktree,
        settings,
        attachments
      );
    const prompt = describeReviewTarget(input.target);
    const run = await this.store.createRun({
      task: input.task,
      session: reviewSession,
      mode: 'REVIEW',
      prompt,
      generationKey: input.generationKey,
      requestedSettings: settings,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      continuedFromRunId: input.sourceRun.id
    });
    try {
      await this.createAndEnqueueTaskRuntime({
        taskRun: run,
        runtimeSession,
        executionContext,
        purpose: 'TASK_REVIEW',
        generationKey: input.generationKey,
        prompt,
        taskReviewTarget: input.target
      });
    } catch (error) {
      await this.recordStartFailure(run, error);
      throw error;
    }
    this.requestTaskPump();
    return run;
  }

  private async createFreshTaskRuntimeSession(
    task: Task,
    taskSession: AgentSessionRecord,
    worktree: WorktreeRecord,
    settings: AgentExecutionSettings,
    attachments: AgentTurnAttachment[]
  ): Promise<{
    runtimeSession: AgentRuntimeSessionRecord;
    executionContext: AgentExecutionContext;
  }> {
    const runtime = this.requireRuntimeStore();
    const describe = this.adapter.describeExecutionContext;
    if (!describe) {
      throw new Error('The configured provider cannot attest a task execution context.');
    }
    const executionContext = await describe.call(this.adapter, {
      sessionId: taskSession.id,
      worktreePath: worktree.worktreePath,
      settings,
      attachments,
      clientOperationId: `task-session-context:${taskSession.id}`
    });
    const accessEpoch = createAgentSessionAccessEpoch({
      owner: { kind: 'TASK', taskId: task.id },
      sessionId: taskSession.id,
      epoch: 1,
      providerId: taskSession.provider,
      model: requireResolvedModel(executionContext),
      executionContext,
      createdAt: taskSession.createdAt
    });
    const runtimeSession = await runtime.createSession({
      id: taskSession.id,
      owner: { kind: 'TASK', taskId: task.id },
      accessEpoch,
      executionContext,
      clientOperationId: `task-session:${taskSession.id}`,
      provider: taskSession.provider,
      role: taskSession.role,
      parentSessionId: taskSession.parentSessionId,
      forkedFromSessionId: taskSession.forkedFromSessionId,
      providerParentSessionId: taskSession.providerParentSessionId,
      providerForkedFromSessionId: taskSession.providerForkedFromSessionId,
      parentRunId: taskSession.parentRunId,
      relationshipState: taskSession.relationshipState,
      relationshipDetail: taskSession.relationshipDetail,
      providerNickname: taskSession.providerNickname,
      providerRole: taskSession.providerRole,
      delegatedPrompt: taskSession.delegatedPrompt,
      agentPath: taskSession.agentPath,
      subagentStatus: taskSession.subagentStatus,
      status: taskSession.status,
      materialized: false,
      requestedSettings: executionContext.modelSettings,
      observedSettings: taskSession.observedSettings
    });
    return { runtimeSession, executionContext };
  }

  async steerRun(runId: string, instruction: string): Promise<void> {
    this.assertProviderStartupAvailable();
    const prompt = instruction.trim();
    if (!prompt) {
      throw new Error('An instruction is required.');
    }
    const run = await this.store.getRun(runId);
    if (!run?.providerTurnId || run.status !== 'RUNNING') {
      throw new Error('Only the current running turn can accept an instruction.');
    }
    const session = await this.requireSession(run.sessionId);
    if (!session.providerSessionId || !this.adapter.steerTurn) {
      throw new Error('This provider session cannot steer the active turn.');
    }
    try {
      await this.adapter.steerTurn({
        session: {
          localSessionId: session.id,
          providerSessionId: session.providerSessionId
        },
        providerTurnId: run.providerTurnId,
        prompt,
        clientMessageId: randomUUID()
      });
    } catch (error) {
      if (error instanceof AgentMutationAmbiguousError) {
        await this.recordAmbiguousMutation(run, error);
      }
      throw error;
    }
  }

  async interruptRun(runId: string): Promise<void> {
    this.assertProviderStartupAvailable();
    const run = await this.store.getRun(runId);
    if (!run) {
      return;
    }
    if (run.status === 'RECOVERY_REQUIRED') {
      await this.resolveRecoveryRun(
        run,
        'Recovery-required run was explicitly abandoned by the user.'
      );
      return;
    }
    const runtimeRun = await this.options.runtimeStore?.getRun(run.id);
    if (
      runtimeRun?.scope.kind === 'TASK' &&
      runtimeRun.status === 'QUEUED' &&
      runtimeRun.delivery === 'NOT_SENT'
    ) {
      await this.store.appendEvent(
        createDomainEvent({
          type: 'CANCEL_REQUESTED',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          source: 'ui',
          payload: { queued: true }
        })
      );
      await this.options.runtimeStore!.updateRun(
        runtimeRun.id,
        runtimeRun.recordRevision,
        {
          status: 'INTERRUPTED',
          delivery: 'NOT_DELIVERED',
          recoveryState: 'NONE',
          terminalReason: 'User canceled the queued task turn before provider dispatch.',
          endedAt: new Date().toISOString()
        },
        `task-queued-cancel:${run.id}`
      );
      await this.settleTaskQueueEntry(run.id);
      await this.recordTaskInterruption(
        run,
        'User canceled the queued task turn before provider dispatch.'
      );
      this.requestTaskPump();
      return;
    }
    if (!run.providerTurnId) return;
    const session = await this.store.getAgentSession(run.sessionId);
    if (!session?.providerSessionId || !this.adapter.interruptTurn) {
      throw new Error('This provider session cannot interrupt the active turn.');
    }
    await this.store.appendEvent(
      createDomainEvent({
        type: 'CANCEL_REQUESTED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'ui',
        payload: {}
      })
    );
    try {
      await this.adapter.interruptTurn({
        session: {
          localSessionId: session.id,
          providerSessionId: session.providerSessionId
        },
        providerTurnId: run.providerTurnId
      });
    } catch (error) {
      if (error instanceof AgentMutationAmbiguousError) {
        await this.recordAmbiguousMutation(run, error);
      }
      throw error;
    }
  }

  async respondToInteraction(
    input: RespondToInteractionRequest
  ): Promise<InteractionRequestRecord> {
    this.assertProviderStartupAvailable();
    if (
      this.options.allowNetworkAccess === false &&
      input.decision.action !== 'DECLINE' &&
      input.decision.action !== 'CANCEL'
    ) {
      const interaction = await this.store.getInteractionRequest(input.interactionRequestId);
      if (
        interaction?.taskId === input.taskId &&
        interaction.runId === input.runId &&
        interaction.type !== 'USER_INPUT'
      ) {
        throw new Error(
          `${BROWSER_DEV_BOUNDARY_MESSAGE} Unexpected provider approval requests can only be declined or canceled.`
        );
      }
    }
    return this.interactions.respond(input);
  }

  async resolveRecoveryRunForReplacement(runId: string): Promise<void> {
    this.assertProviderStartupAvailable();
    const run = await this.store.getRun(runId);
    if (!run || run.status !== 'RECOVERY_REQUIRED') return;
    await this.resolveRecoveryRun(
      run,
      'Recovery-required run was superseded by an explicit continue or retry action.'
    );
  }

  async syncGoal(
    task: Task,
    sessionId: string
  ): Promise<import('../../shared/contracts').AgentGoalSnapshotRecord> {
    this.assertProviderStartupAvailable();
    const session = await this.requireSession(sessionId);
    if (session.taskId !== task.id) {
      throw new Error('Agent session does not belong to the selected task.');
    }
    if (!session.providerSessionId || !this.adapter.syncGoal) {
      throw new Error('This provider session cannot synchronize goals.');
    }
    return this.adapter.syncGoal({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      authoritativeGoal: task.prompt,
      force: true
    });
  }

  async shutdown(): Promise<void> {
    await this.adapter.shutdown();
  }

  private async startProviderTurn(
    run: RunRecord,
    session: AgentSessionRecord,
    input: StartOrchestratedTurn,
    settings: AgentExecutionSettings,
    attachments: AgentTurnAttachment[]
  ): Promise<void> {
    await this.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: input.mode,
      prompt: input.prompt,
      authoritativeGoal: input.task.prompt,
      attachments,
      settings
    });
  }

  private async startProviderReview(
    run: RunRecord,
    sourceSession: AgentSessionRecord,
    reviewSession: AgentSessionRecord,
    target: AgentReviewTarget,
    attachments: AgentTurnAttachment[]
  ): Promise<void> {
    if (!this.adapter.startReview) {
      throw new Error('This provider does not support detached review.');
    }
    await this.adapter.startReview({
      localRunId: run.id,
      sourceSession: {
        localSessionId: sourceSession.id,
        providerSessionId: sourceSession.providerSessionId
      },
      reviewSessionId: reviewSession.id,
      target,
      attachments
    });
  }

  private async recreateMissingProviderSession(
    session: AgentSessionRecord,
    settings: AgentExecutionSettings,
    error: AgentProviderSessionMissingError
  ): Promise<AgentSessionRecord> {
    const previousProviderSessionId = session.providerSessionId;
    if (!previousProviderSessionId) {
      throw error;
    }
    const reset = await this.store.updateAgentSession(session.id, {
      providerSessionId: undefined,
      providerSessionTreeId: undefined,
      status: 'NOT_MATERIALIZED',
      materialized: false,
      observedSettings: undefined,
      lastAttachedAt: undefined,
      relationshipDetail: `Codex provider thread ${previousProviderSessionId} was missing during ${error.operation}; Task Monki recreated the provider session.`
    });
    return this.adapter.createSession({
      localSessionId: reset.id,
      taskId: reset.taskId,
      iterationId: reset.iterationId,
      worktreeId: reset.worktreeId,
      worktreePath: reset.worktreePath,
      settings
    });
  }

  private async validateSettings(
    settings: AgentExecutionSettings,
    attachments: readonly Pick<AgentTurnAttachment, 'kind'>[] = []
  ): Promise<AgentExecutionSettings> {
    const models = await this.adapter.listModels();
    const model =
      models.find((candidate) => candidate.model === settings.model) ??
      models.find((candidate) => candidate.id === settings.model) ??
      models.find((candidate) => candidate.isDefault);
    if (!model) {
      throw new Error('Codex did not report an available model.');
    }
    assertModelSupportsAttachments(model, attachments);
    const effort =
      settings.reasoningEffort ?? model.defaultReasoningEffort;
    if (
      effort &&
      !model.supportedReasoningEfforts.includes(effort)
    ) {
      throw new Error(
        `Reasoning effort ${effort} is not supported by ${model.displayName}.`
      );
    }
    const modelProvider =
      settings.modelProvider && settings.modelProvider !== 'codex'
        ? settings.modelProvider
        : 'openai';
    const resolvedSettings: AgentExecutionSettings = {
      ...settings,
      model: model.model,
      modelProvider,
      reasoningEffort: effort,
      serviceTier: settings.serviceTier ?? model.defaultServiceTier
    };
    if (this.options.allowNetworkAccess === false) {
      this.assertBrowserDevSettings(resolvedSettings, 'Requested run');
    }
    assertAttachmentSandboxSupportsDelivery(resolvedSettings, attachments);
    return resolvedSettings;
  }

  /**
   * Browser development publishes a loopback credential after service
   * initialization. Persisted turns must therefore be made terminal before
   * the provider starts or resumes any thread; checking only newly submitted
   * turns leaves a cold-start recovery bypass.
   */
  private async terminalizeUnsafePersistedRuns(): Promise<number> {
    const snapshot = await this.store.snapshot();
    let terminalized = 0;
    const sessions = new Map(snapshot.agentSessions.map((session) => [session.id, session]));
    const latestSettingsObservations = new Map<
      string,
      (typeof snapshot.agentSettingsObservations)[number]
    >();
    for (const observation of snapshot.agentSettingsObservations) {
      const current = latestSettingsObservations.get(observation.sessionId);
      if (
        !current ||
        observation.observedAt > current.observedAt
      ) {
        latestSettingsObservations.set(observation.sessionId, observation);
      }
    }
    for (const run of snapshot.runs.filter((candidate) =>
      RECOVERABLE_RUN_STATUSES.includes(candidate.status)
    )) {
      const runViolations = browserDevSettingsViolations(run.requestedSettings).map(
        (violation) => `run ${violation}`
      );
      if (run.observedSettings) {
        runViolations.push(
          ...browserDevSettingsViolations(run.observedSettings).map(
            (violation) => `run observed settings ${violation}`
          )
        );
      }
      if (
        snapshot.interactionRequests.some(
          (interaction) =>
            interaction.runId === run.id &&
            interaction.type !== 'USER_INPUT' &&
            (interaction.status === 'PENDING' || interaction.status === 'RESPONDING')
        )
      ) {
        runViolations.push('run has a persisted provider approval request');
      }
      const session = sessions.get(run.sessionId);
      const sessionViolations = session
        ? [
            ...browserDevSettingsViolations(session.requestedSettings).map(
              (violation) => `session ${violation}`
            ),
            ...(session.observedSettings
              ? browserDevSettingsViolations(session.observedSettings).map(
                  (violation) => `session observed settings ${violation}`
                )
              : [])
          ]
        : [];
      const latestObservation = latestSettingsObservations.get(run.sessionId);
      const observationViolations = latestObservation
        ? browserDevSettingsViolations(latestObservation.settings).map(
            (violation) => `latest settings observation ${violation}`
          )
        : [];
      const violations = [
        ...new Set([...runViolations, ...sessionViolations, ...observationViolations])
      ];
      if (violations.length === 0) continue;

      const reason = `${BROWSER_DEV_BOUNDARY_MESSAGE} The persisted run was not resumed because of: ${violations.join(', ')}.`;
      const finalArtifact = await this.store.writeFinalArtifact(
        run.taskId,
        run.id,
        `# Agent turn blocked at startup\n\n${reason}\n`
      );
      await this.store.appendEvent(
        createDomainEvent({
          type: 'AGENT_RUN_FAILED',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: run.serverInstanceId,
          source: 'process',
          payload: {
            error: reason,
            terminalReason: reason,
            finalArtifactId: finalArtifact.id,
            securityBoundary: 'BROWSER_DEV'
          }
        })
      );
      for (const interaction of snapshot.interactionRequests.filter(
        (candidate) =>
          candidate.runId === run.id &&
          (candidate.status === 'PENDING' || candidate.status === 'RESPONDING')
      )) {
        await this.store.transitionInteractionRequest(interaction.id, interaction.status, {
          status: 'STALE',
          resolution: { reason },
          resolvedAt: new Date().toISOString()
        });
      }
      if (session) {
        await this.store.updateAgentSession(session.id, { status: 'NOT_LOADED' });
      }
      this.events.emit({
        type: 'run.terminal',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: { status: 'failed', error: reason, finalArtifactId: finalArtifact.id },
        at: new Date().toISOString()
      });
      terminalized += 1;
    }
    return terminalized;
  }

  private assertBrowserDevSettings(
    settings: AgentExecutionSettings,
    subject: string
  ): void {
    if (this.options.allowNetworkAccess !== false) return;
    assertBrowserDevSettingsSafe(settings, subject);
  }

  private assertProviderStartupAvailable(): void {
    if (this.options.providerStartupDisabledReason) {
      throw new Error(this.options.providerStartupDisabledReason);
    }
  }

  private async assertBrowserDevSessionHistory(
    session: AgentSessionRecord,
    subject: string
  ): Promise<void> {
    if (this.options.allowNetworkAccess !== false) return;
    this.assertBrowserDevSettings(session.requestedSettings, subject);
    if (session.observedSettings) {
      this.assertBrowserDevSettings(session.observedSettings, `${subject} observed settings`);
    }
    const snapshot = await this.store.snapshot();
    const latestObservation = snapshot.agentSettingsObservations.find(
      (observation) => observation.sessionId === session.id
    );
    if (latestObservation) {
      this.assertBrowserDevSettings(
        latestObservation.settings,
        `${subject} latest settings observation`
      );
    }
  }

  private async assertCapacity(): Promise<void> {
    const snapshot = await this.store.snapshot();
    const activeRunCount = snapshot.runs.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(run.status)
    ).length;
    if (activeRunCount >= MAX_CONCURRENT_TURNS) {
      throw new Error(
        `Task Monki allows at most ${MAX_CONCURRENT_TURNS} active agent turns.`
      );
    }
  }

  private async assertNoPendingInteractions(sessionId: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    const pending = snapshot.interactionRequests.find(
      (interaction) =>
        interaction.sessionId === sessionId &&
        ['PENDING', 'RESPONDING'].includes(interaction.status)
    );
    if (pending) {
      throw new Error(
        `Resolve the pending ${pending.type.toLowerCase().replaceAll('_', ' ')} before starting another turn.`
      );
    }
  }

  private async requireSession(sessionId: string) {
    const session = await this.store.getAgentSession(sessionId);
    if (!session) {
      throw new Error(`Agent session not found: ${sessionId}`);
    }
    return session;
  }

  private async recordStartFailure(run: RunRecord, error: unknown): Promise<void> {
    if (error instanceof AgentMutationAmbiguousError) {
      await this.recordAmbiguousMutation(run, error);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const finalArtifact = await this.store.writeFinalArtifact(
      run.taskId,
      run.id,
      `# Agent turn failed to start\n\n${message}\n`
    );
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_FAILED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        source: 'provider',
        payload: { error: message, finalArtifactId: finalArtifact.id }
      })
    );
    this.events.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: 'failed', error: message },
      at: new Date().toISOString()
    });
  }

  private async resolveRecoveryRun(run: RunRecord, terminalReason: string): Promise<void> {
    return this.recordTaskInterruption(run, terminalReason, 'Recovery run closed');
  }

  private async recordTaskInterruption(
    run: RunRecord,
    terminalReason: string,
    heading = 'Agent turn interrupted'
  ): Promise<void> {
    const finalArtifact = await this.store.writeFinalArtifact(
      run.taskId,
      run.id,
      `# ${heading}\n\n${terminalReason}\n`
    );
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_INTERRUPTED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'ui',
        payload: { terminalReason, finalArtifactId: finalArtifact.id }
      })
    );
    this.events.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: 'interrupted', terminalReason },
      at: new Date().toISOString()
    });
  }

  private async recordAmbiguousMutation(
    run: RunRecord,
    error: AgentMutationAmbiguousError
  ): Promise<void> {
    const current = (await this.store.getRun(run.id)) ?? run;
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_MUTATION_AMBIGUOUS',
        taskId: current.taskId,
        iterationId: current.iterationId,
        runId: current.id,
        worktreeId: current.worktreeId,
        agentSessionId: current.sessionId,
        serverInstanceId: current.serverInstanceId,
        source: 'provider',
        payload: {
          operation: error.operation,
          reason: error.message,
          automaticResubmission: false
        }
      })
    );
    this.events.emit({
      type: 'run.activity',
      taskId: current.taskId,
      iterationId: current.iterationId,
      runId: current.id,
      worktreeId: current.worktreeId,
      payload: {
        eventType: 'mutation/ambiguous',
        operation: error.operation
      },
      at: new Date().toISOString()
    });
  }
}

function assertTaskSessionOwnership(
  session: AgentSessionRecord,
  input: StartOrchestratedTurn
): void {
  if (
    session.taskId !== input.task.id ||
    session.iterationId !== input.iteration.id ||
    session.worktreeId !== input.worktree.id
  ) {
    throw new Error('Selected agent session does not belong to this task iteration.');
  }
}

function requireResolvedModel(context: AgentExecutionContext): string {
  const model = context.modelSettings.model;
  if (!model) throw new Error('The provider execution context did not resolve a model.');
  return model;
}

function runtimePurposeForTaskMode(mode: AgentRunMode): AgentRuntimePurpose {
  switch (mode) {
    case 'REVIEW':
      return 'TASK_REVIEW';
    case 'FOLLOW_UP':
    case 'COMPACTION':
      return 'TASK_FOLLOW_UP';
    case 'RETRY':
      return 'TASK_RETRY';
    case 'SUBAGENT':
      return 'PROVIDER_SUBAGENT';
    case 'ANALYSIS':
    case 'IMPLEMENTATION':
      return 'TASK_IMPLEMENTATION';
  }
}

function isTerminalRuntimeRun(run: AgentRuntimeRunRecord): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(run.status);
}

function isTerminalTaskRun(run: RunRecord): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(run.status);
}

function describeReviewTarget(target: AgentReviewTarget): string {
  switch (target.type) {
    case 'UNCOMMITTED_CHANGES':
      return 'Detached provider review of uncommitted changes.';
    case 'BASE_BRANCH':
      return `Detached provider review against base branch ${target.branch}.`;
    case 'COMMIT':
      return `Detached provider review of commit ${target.sha}.`;
    case 'CUSTOM':
      return `Detached provider review: ${target.instructions}`;
  }
}
