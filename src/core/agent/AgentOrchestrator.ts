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

  constructor(
    private readonly store: FileTaskStore,
    private readonly events: AppEventBus,
    private readonly adapter: AgentProviderAdapter,
    private readonly options: {
      allowNetworkAccess?: boolean;
      providerStartupDisabledReason?: string;
    } = {}
  ) {
    this.interactions = new AgentInteractionService(store, events, adapter);
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
    const resolvedSettings: AgentExecutionSettings = {
      ...settings,
      model: model.model,
      modelProvider: settings.modelProvider ?? 'openai',
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
