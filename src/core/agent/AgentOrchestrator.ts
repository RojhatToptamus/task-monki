import { randomUUID } from 'node:crypto';
import type {
  AgentExecutionSettings,
  AgentRuntimeCatalog,
  AgentRuntimeId,
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
import { buildAgentReviewPrompt } from '../../shared/promptTemplates';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  type AgentRuntimeAdapter
} from './AgentRuntimeAdapter';
import { AgentRuntimeRegistry } from './AgentRuntimeRegistry';
import {
  createRuntimeReadiness,
  errorDiagnostic
} from './AgentRuntimeReadiness';
import { AgentInteractionService } from './AgentInteractionService';
import { toAgentTurnAttachments, type AgentTurnAttachment } from './AgentAttachmentDelivery';
import {
  assertBrowserDevRuntimeIsolation,
  assertBrowserDevSettingsSafe,
  BROWSER_DEV_BOUNDARY_MESSAGE,
  browserDevSettingsViolations
} from './BrowserDevAgentBoundary';

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

function assertSessionPostcondition(
  actual: AgentSessionRecord,
  expected: AgentSessionRecord,
  subject: string
): void {
  if (
    actual.id !== expected.id ||
    actual.taskId !== expected.taskId ||
    actual.iterationId !== expected.iterationId ||
    actual.worktreeId !== expected.worktreeId ||
    actual.worktreePath !== expected.worktreePath ||
    actual.runtimeId !== expected.runtimeId ||
    actual.role !== expected.role
  ) {
    throw new Error(
      `${subject} returned by the runtime does not match its Task Monki ownership record.`
    );
  }
  if (!actual.providerSessionId) {
    throw new Error(`${subject} did not return a provider session id.`);
  }
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
  private readonly runtimes: AgentRuntimeRegistry;

  constructor(
    private readonly store: FileTaskStore,
    private readonly events: AppEventBus,
    runtimes: AgentRuntimeRegistry | AgentRuntimeAdapter,
    private readonly options: {
      allowNetworkAccess?: boolean;
      providerStartupDisabledReason?: string;
    } = {}
  ) {
    this.runtimes =
      runtimes instanceof AgentRuntimeRegistry
        ? runtimes
        : new AgentRuntimeRegistry([runtimes], runtimes.descriptor.id);
    this.interactions = new AgentInteractionService(store, events, (runtimeId) =>
      this.runtimes.require(runtimeId)
    );
  }

  async initialize(
    requiredRuntimeIds: readonly string[] = [this.runtimes.defaultRuntimeId],
    disabledRuntimeIds: ReadonlySet<AgentRuntimeId> = new Set()
  ): Promise<void> {
    if (this.options.providerStartupDisabledReason) {
      await this.store.reconcileRunAttachments();
      return;
    }
    const persisted = await this.store.snapshot();
    const recoveryRuntimeIds = new Set(
      persisted.runs
        .filter((run) => RECOVERABLE_RUN_STATUSES.includes(run.status))
        .map((run) => run.runtimeId)
    );
    let runtimeIdsToInitialize = this.runtimes
      .list()
      .filter(
        (adapter) =>
          !disabledRuntimeIds.has(adapter.descriptor.id) &&
          (adapter.descriptor.startupPolicy !== 'ON_DEMAND' ||
            requiredRuntimeIds.includes(adapter.descriptor.id) ||
            recoveryRuntimeIds.has(adapter.descriptor.id))
      )
      .map((adapter) => adapter.descriptor.id);
    let browserUnsafeRuntimeIds = new Set<string>();
    if (this.options.allowNetworkAccess === false) {
      const classification = await this.classifyBrowserRuntimeIsolation();
      runtimeIdsToInitialize = runtimeIdsToInitialize.filter((runtimeId) =>
        classification.safeRuntimeIds.includes(runtimeId)
      );
      browserUnsafeRuntimeIds = classification.unsafeRuntimeIds;
      for (const runtimeId of requiredRuntimeIds) {
        if (browserUnsafeRuntimeIds.has(runtimeId)) {
          const adapter = this.runtimes.require(runtimeId);
          assertBrowserDevRuntimeIsolation(
            adapter.descriptor,
            await adapter.capabilities()
          );
        }
      }
      await this.terminalizeUnsafePersistedRuns(browserUnsafeRuntimeIds);
    }
    await this.store.reconcileRunAttachments();
    const initializationFailures = await this.runtimes.initialize(
      runtimeIdsToInitialize
    );
    if (this.options.allowNetworkAccess === false) {
      const requiredFailure = initializationFailures.find((failure) =>
        requiredRuntimeIds.includes(failure.runtimeId)
      );
      if (requiredFailure) {
        await this.runtimes.shutdownAll().catch(() => undefined);
        throw requiredFailure.error;
      }
      try {
        await Promise.all(
          requiredRuntimeIds.map(async (runtimeId) => {
            const adapter = this.runtimes.require(runtimeId);
            assertBrowserDevRuntimeIsolation(
              adapter.descriptor,
              await adapter.capabilities()
            );
          })
        );
      } catch (error) {
        await this.runtimes.shutdownAll().catch(() => undefined);
        throw error;
      }
    }
    if (this.options.allowNetworkAccess === false) {
      const terminalizedAfterProviderInitialization =
        await this.terminalizeUnsafePersistedRuns();
      if (terminalizedAfterProviderInitialization > 0) {
        await this.runtimes.shutdownAll().catch(() => undefined);
        throw new Error(
          `${BROWSER_DEV_BOUNDARY_MESSAGE} Runtime recovery reported unsafe observed settings, so agent runtimes were stopped before the development API credential was published.`
        );
      }
    }
  }

  async getRuntimeCatalog(
    disabledRuntimeIds: ReadonlySet<AgentRuntimeId> = new Set()
  ): Promise<AgentRuntimeCatalog> {
    if (this.options.providerStartupDisabledReason) {
      const refreshedAt = new Date().toISOString();
      const runtimes = await Promise.all(
        this.runtimes.list().map(async (adapter) => ({
          preflight: {
            runtime: adapter.descriptor,
            readiness: createRuntimeReadiness(
              'DISABLED',
              this.options.providerStartupDisabledReason!,
              {
                diagnostics: [
                  errorDiagnostic(
                    'RUNTIME_DISABLED',
                    'SECURITY',
                    this.options.providerStartupDisabledReason!
                  )
                ]
              }
            ),
            capabilities: await adapter.capabilities(),
          },
          models: [],
          refreshedAt
        }))
      );
      return {
        runtimes,
        models: [],
        defaultRuntimeId: this.runtimes.defaultRuntimeId,
        refreshedAt
      };
    }
    if (this.options.allowNetworkAccess !== false) {
      return this.runtimes.getCatalog({ disabledRuntimeIds });
    }
    const { unsafeRuntimeIds } = await this.classifyBrowserRuntimeIsolation();
    return this.runtimes.getCatalog({
      disabledRuntimeIds,
      excludedRuntimeIds: unsafeRuntimeIds,
      exclusionReason:
        'This runtime is unavailable in browser development because it does not attest the required process, filesystem, and network isolation.'
    });
  }

  async releaseTask(taskId: string): Promise<void> {
    const results = await Promise.allSettled(
      this.runtimes.list().map((adapter) => adapter.releaseTask?.(taskId))
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more agent runtimes could not release the task.'
      );
    }
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
    this.assertProviderStartupAvailable();
    const taskAttachments = await this.store.getTaskAttachments(input.task.id);
    let session = input.sessionId
      ? await this.requireSession(input.sessionId)
      : await this.store.getPrimaryAgentSession(input.task.id, input.iteration.id);
    const runtimeId = session?.runtimeId ?? input.task.runtimeId;
    if (input.settings.runtimeId && input.settings.runtimeId !== runtimeId) {
      throw new Error(
        `Task runtime ${runtimeId} cannot start work through ${input.settings.runtimeId}.`
      );
    }
    if (input.task.runtimeId !== runtimeId) {
      throw new Error('Selected agent session runtime does not match its task.');
    }
    const adapter = this.runtimes.require(runtimeId);
    const settings = await this.validateSettings(
      adapter,
      { ...input.settings, runtimeId },
      taskAttachments
    );
    await this.assertCapacity();

    session =
      session ??
        (await this.store.createAgentSession({
          task: input.task,
          iteration: input.iteration,
          worktree: input.worktree,
          runtimeId,
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
    const unresolvedRecoveryRun = (await this.store.snapshot()).runs.find(
      (run) => run.sessionId === session!.id && run.status === 'RECOVERY_REQUIRED'
    );
    if (
      unresolvedRecoveryRun &&
      input.continuedFromRunId !== unresolvedRecoveryRun.id
    ) {
      throw new Error(
        `Agent session ${session.id} has unresolved recovery run ${unresolvedRecoveryRun.id}; close it or explicitly continue from it before another provider mutation.`
      );
    }

    if (session.runtimeId !== runtimeId) {
      throw new Error('Selected agent session runtime changed unexpectedly.');
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
      if (!session.providerSessionId) {
        const localSession = session;
        session = await adapter.createSession({
          runtimeId,
          localSessionId: session.id,
          taskId: input.task.id,
          iterationId: input.iteration.id,
          worktreeId: input.worktree.id,
          worktreePath: input.worktree.worktreePath,
          settings,
          attachments
        });
        assertSessionPostcondition(session, localSession, 'Created session');
        await this.assertBrowserDevSessionHistory(session, 'Created session');
      }
      await this.startProviderTurn(adapter, run, session, input, settings, attachments);
      return (await this.store.getRun(run.id)) ?? run;
    } catch (error) {
      if (error instanceof AgentProviderSessionMissingError) {
        try {
          const recovered = await this.recreateMissingProviderSession(
            adapter,
            session,
            settings,
            error,
            attachments
          );
          await this.assertBrowserDevSessionHistory(recovered, 'Recreated session');
          await this.startProviderTurn(adapter, run, recovered, input, settings, attachments);
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
    const sourceSession = await this.requireSession(input.sourceRun.sessionId);
    if (input.sourceRun.runtimeId !== sourceSession.runtimeId) {
      throw new Error('Review source runtime ownership is inconsistent.');
    }
    const reviewRuntimeId = input.settings.runtimeId ?? sourceSession.runtimeId;
    const adapter = this.runtimes.require(reviewRuntimeId);
    const capabilities = await adapter.capabilities();
    const useNativeReview =
      reviewRuntimeId === sourceSession.runtimeId &&
      capabilities.review.maturity !== 'unsupported' &&
      typeof adapter.startReview === 'function';
    const supportsGenericDetachedReview =
      capabilities.extensions.genericDetachedReview?.maturity === 'stable';
    if (!useNativeReview && !supportsGenericDetachedReview) {
      throw new Error(
        `${adapter.descriptor.displayName} cannot run a detached review because it does not attest stable read-only review isolation.`
      );
    }
    const taskAttachments = await this.store.getTaskAttachments(input.task.id);
    const settings = await this.validateSettings(
      adapter,
      { ...input.settings, runtimeId: reviewRuntimeId },
      taskAttachments
    );
    await this.assertCapacity();
    if (useNativeReview) {
      this.assertBrowserDevSettings(input.sourceRun.requestedSettings, 'Review source run');
      if (input.sourceRun.observedSettings) {
        this.assertBrowserDevSettings(
          input.sourceRun.observedSettings,
          'Review source run observed settings'
        );
      }
      await this.assertBrowserDevSessionHistory(sourceSession, 'Review source session');
      await this.assertNoPendingInteractions(sourceSession.id);
    }
    let reviewSession = await this.store.createAgentSession({
      task: input.task,
      iteration: input.iteration,
      worktree: input.worktree,
      runtimeId: reviewRuntimeId,
      role: 'REVIEW',
      requestedSettings: settings,
      parentSessionId: sourceSession.id,
      forkedFromSessionId: useNativeReview ? sourceSession.id : undefined
    });
    const prompt = buildAgentReviewPrompt({
      task: input.task,
      worktree: input.worktree,
      target: input.target
    });
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
    let attachments: AgentTurnAttachment[] = [];
    try {
      attachments = toAgentTurnAttachments(
        await this.store.prepareRunAttachments(run.id, input.task.id)
      );
      if (!useNativeReview && !reviewSession.providerSessionId) {
        const localReviewSession = reviewSession;
        reviewSession = await adapter.createSession({
          runtimeId: reviewRuntimeId,
          localSessionId: reviewSession.id,
          taskId: input.task.id,
          iterationId: input.iteration.id,
          worktreeId: input.worktree.id,
          worktreePath: input.worktree.worktreePath,
          settings,
          attachments
        });
        assertSessionPostcondition(
          reviewSession,
          localReviewSession,
          'Created review session'
        );
        await this.assertBrowserDevSessionHistory(
          reviewSession,
          'Created review session'
        );
      }
      if (useNativeReview) {
        await this.startProviderReview(
          adapter,
          run,
          sourceSession,
          reviewSession,
          input.target,
          attachments
        );
      } else {
        await adapter.startTurn({
          localRunId: run.id,
          session: {
            localSessionId: reviewSession.id,
            providerSessionId: reviewSession.providerSessionId
          },
          mode: 'REVIEW',
          prompt,
          authoritativeGoal: input.task.prompt,
          attachments,
          settings
        });
      }
      return (await this.store.getRun(run.id)) ?? run;
    } catch (error) {
      if (error instanceof AgentProviderSessionMissingError) {
        try {
          const recovered = await this.recreateMissingProviderSession(
            adapter,
            useNativeReview ? sourceSession : reviewSession,
            settings,
            error,
            attachments
          );
          await this.assertBrowserDevSessionHistory(
            recovered,
            'Recreated review source session'
          );
          if (useNativeReview) {
            await this.startProviderReview(
              adapter,
              run,
              recovered,
              reviewSession,
              input.target,
              attachments
            );
          } else {
            await adapter.startTurn({
              localRunId: run.id,
              session: {
                localSessionId: recovered.id,
                providerSessionId: recovered.providerSessionId
              },
              mode: 'REVIEW',
              prompt,
              authoritativeGoal: input.task.prompt,
              attachments,
              settings
            });
          }
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
    this.assertRunRuntimeOwnership(run, session);
    const adapter = this.runtimes.require(session.runtimeId);
    const capabilities = await adapter.capabilities();
    if (this.options.allowNetworkAccess === false) {
      assertBrowserDevRuntimeIsolation(adapter.descriptor, capabilities);
    }
    if (
      !session.providerSessionId ||
      capabilities.activeTurnSteering.maturity === 'unsupported' ||
      !adapter.steerTurn
    ) {
      throw new Error('This provider session cannot steer the active turn.');
    }
    try {
      await adapter.steerTurn({
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
    if (!run.providerTurnId) return;
    const session = await this.store.getAgentSession(run.sessionId);
    if (!session) {
      throw new Error(`Agent session not found: ${run.sessionId}`);
    }
    this.assertRunRuntimeOwnership(run, session);
    const adapter = this.runtimes.require(session.runtimeId);
    const capabilities = await adapter.capabilities();
    if (this.options.allowNetworkAccess === false) {
      assertBrowserDevRuntimeIsolation(adapter.descriptor, capabilities);
    }
    if (
      !session.providerSessionId ||
      capabilities.turnInterruption.maturity === 'unsupported' ||
      !adapter.interruptTurn
    ) {
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
      await adapter.interruptTurn({
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
    if (this.options.allowNetworkAccess === false) {
      const interaction = await this.store.getInteractionRequest(input.interactionRequestId);
      if (interaction?.taskId === input.taskId && interaction.runId === input.runId) {
        const adapter = this.runtimes.require(interaction.runtimeId);
        assertBrowserDevRuntimeIsolation(
          adapter.descriptor,
          await adapter.capabilities()
        );
      }
      if (
        interaction?.taskId === input.taskId &&
        interaction.runId === input.runId &&
        interaction.type !== 'USER_INPUT' &&
        input.decision.action !== 'DECLINE' &&
        input.decision.action !== 'DECLINE_FOR_SESSION' &&
        input.decision.action !== 'CANCEL'
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
    if (session.runtimeId !== task.runtimeId) {
      throw new Error('Agent session runtime does not match the selected task.');
    }
    const adapter = this.runtimes.require(session.runtimeId);
    const capabilities = await adapter.capabilities();
    if (this.options.allowNetworkAccess === false) {
      assertBrowserDevRuntimeIsolation(adapter.descriptor, capabilities);
    }
    if (
      !session.providerSessionId ||
      capabilities.goals.maturity === 'unsupported' ||
      !adapter.syncGoal
    ) {
      throw new Error('This provider session cannot synchronize goals.');
    }
    return adapter.syncGoal({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      authoritativeGoal: task.prompt,
      force: true
    });
  }

  async shutdown(): Promise<void> {
    await this.runtimes.shutdownAll();
  }

  private async startProviderTurn(
    adapter: AgentRuntimeAdapter,
    run: RunRecord,
    session: AgentSessionRecord,
    input: StartOrchestratedTurn,
    settings: AgentExecutionSettings,
    attachments: AgentTurnAttachment[]
  ): Promise<void> {
    await adapter.startTurn({
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
    adapter: AgentRuntimeAdapter,
    run: RunRecord,
    sourceSession: AgentSessionRecord,
    reviewSession: AgentSessionRecord,
    target: AgentReviewTarget,
    attachments: AgentTurnAttachment[]
  ): Promise<void> {
    if (!adapter.startReview) {
      throw new Error('This provider does not support detached review.');
    }
    await adapter.startReview({
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
    adapter: AgentRuntimeAdapter,
    session: AgentSessionRecord,
    settings: AgentExecutionSettings,
    error: AgentProviderSessionMissingError,
    attachments: AgentTurnAttachment[]
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
      relationshipDetail: `${adapter.descriptor.displayName} session ${previousProviderSessionId} was missing during ${error.operation}; Task Monki recreated the provider session.`
    });
    const recreated = await adapter.createSession({
      runtimeId: reset.runtimeId,
      localSessionId: reset.id,
      taskId: reset.taskId,
      iterationId: reset.iterationId,
      worktreeId: reset.worktreeId,
      worktreePath: reset.worktreePath,
      settings,
      attachments
    });
    assertSessionPostcondition(recreated, reset, 'Recreated session');
    return recreated;
  }

  private async validateSettings(
    adapter: AgentRuntimeAdapter,
    settings: AgentExecutionSettings,
    attachments: readonly Pick<AgentTurnAttachment, 'kind'>[] = []
  ): Promise<AgentExecutionSettings> {
    if (this.options.allowNetworkAccess === false) {
      assertBrowserDevRuntimeIsolation(
        adapter.descriptor,
        await adapter.capabilities()
      );
    }
    const resolvedSettings = (await adapter.resolveExecution({ settings, attachments })).settings;
    if (resolvedSettings.runtimeId !== adapter.descriptor.id) {
      throw new Error(
        `Runtime ${adapter.descriptor.id} returned execution settings for ${String(resolvedSettings.runtimeId)}.`
      );
    }
    if (this.options.allowNetworkAccess === false) {
      this.assertBrowserDevSettings(resolvedSettings, 'Requested run');
    }
    return resolvedSettings;
  }

  /**
   * Browser development publishes a loopback credential after service
   * initialization. Persisted turns must therefore be made terminal before
   * the provider starts or resumes any thread; checking only newly submitted
   * turns leaves a cold-start recovery bypass.
   */
  private async terminalizeUnsafePersistedRuns(
    unsafeRuntimeIds: ReadonlySet<string> = new Set()
  ): Promise<number> {
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
        ...new Set([
          ...(unsafeRuntimeIds.has(run.runtimeId)
            ? [`runtime ${run.runtimeId} does not attest the browser development isolation boundary`]
            : []),
          ...runViolations,
          ...sessionViolations,
          ...observationViolations
        ])
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

  private async classifyBrowserRuntimeIsolation(): Promise<{
    safeRuntimeIds: string[];
    unsafeRuntimeIds: Set<string>;
  }> {
    const safeRuntimeIds: string[] = [];
    const unsafeRuntimeIds = new Set<string>();
    await Promise.all(
      this.runtimes.list().map(async (adapter) => {
        try {
          assertBrowserDevRuntimeIsolation(
            adapter.descriptor,
            await adapter.capabilities()
          );
          safeRuntimeIds.push(adapter.descriptor.id);
        } catch {
          unsafeRuntimeIds.add(adapter.descriptor.id);
        }
      })
    );
    return { safeRuntimeIds, unsafeRuntimeIds };
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

  private assertRunRuntimeOwnership(
    run: RunRecord,
    session: AgentSessionRecord
  ): void {
    if (run.sessionId !== session.id || run.runtimeId !== session.runtimeId) {
      throw new Error('Agent run runtime ownership is inconsistent.');
    }
  }

  private async recordStartFailure(run: RunRecord, error: unknown): Promise<void> {
    if (error instanceof AgentMutationAmbiguousError) {
      await this.recordAmbiguousMutation(run, error);
      return;
    }
    const current = await this.store.getRun(run.id);
    if (!current || !ACTIVE_RUN_STATUSES.includes(current.status)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const recorded = await this.store.appendRunEventIfStatus(
      createDomainEvent({
        type: 'AGENT_RUN_FAILED',
        taskId: current.taskId,
        iterationId: current.iterationId,
        runId: current.id,
        worktreeId: current.worktreeId,
        agentSessionId: current.sessionId,
        source: 'provider',
        payload: { error: message }
      }),
      ACTIVE_RUN_STATUSES
    );
    if (!recorded) return;
    let finalArtifactId: string | undefined;
    try {
      finalArtifactId = (
        await this.store.writeFinalArtifact(
          current.taskId,
          current.id,
          `# Agent turn failed to start\n\n${message}\n`
        )
      ).id;
    } catch (artifactError) {
      const artifactMessage =
        artifactError instanceof Error ? artifactError.message : String(artifactError);
      await this.store
        .appendArtifact(
          current.diagnosticArtifactId,
          `\n[task-monki/start-failure-artifact]\n${artifactMessage}\n`
        )
        .catch(() => undefined);
    }
    this.events.emit({
      type: 'run.terminal',
      taskId: current.taskId,
      iterationId: current.iterationId,
      runId: current.id,
      worktreeId: current.worktreeId,
      payload: {
        status: 'failed',
        error: message,
        ...(finalArtifactId ? { finalArtifactId } : {})
      },
      at: new Date().toISOString()
    });
  }

  private async resolveRecoveryRun(run: RunRecord, terminalReason: string): Promise<void> {
    const finalArtifact = await this.store.writeFinalArtifact(
      run.taskId,
      run.id,
      `# Recovery run closed\n\n${terminalReason}\n`
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
    const recorded = await this.store.appendRunEventIfStatus(
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
      }),
      ACTIVE_RUN_STATUSES
    );
    if (!recorded) return;
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
