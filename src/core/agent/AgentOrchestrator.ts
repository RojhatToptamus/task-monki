import { randomUUID } from 'node:crypto';
import type {
  AgentExecutionSettings,
  AgentProviderState,
  AgentReviewTarget,
  AgentRetryStrategy,
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

const MAX_CONCURRENT_TURNS = 2;
const ACTIVE_RUN_STATUSES: RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
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

export interface ForkAndStartOrchestratedTurn
  extends Omit<StartOrchestratedTurn, 'sessionId'> {
  sourceRun: RunRecord;
  retryStrategy: Extract<AgentRetryStrategy, 'FORK'>;
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
    private readonly adapter: AgentProviderAdapter
  ) {
    this.interactions = new AgentInteractionService(store, events, adapter);
  }

  async initialize(): Promise<void> {
    try {
      await this.adapter.initialize();
    } catch {
      // Provider readiness is exposed through preflight and should not prevent the
      // local task/evidence application from opening.
    }
  }

  async getProviderState(): Promise<AgentProviderState> {
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
    const settings = await this.validateSettings(input.settings);
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

    try {
      await this.startProviderTurn(run, session, input, settings);
      return (await this.store.getRun(run.id)) ?? run;
    } catch (error) {
      if (error instanceof AgentProviderSessionMissingError) {
        try {
          const recovered = await this.recreateMissingProviderSession(
            session,
            settings,
            error
          );
          await this.startProviderTurn(run, recovered, input, settings);
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

  forkAndStartTurn(input: ForkAndStartOrchestratedTurn): Promise<RunRecord> {
    const operation = this.startQueue.then(() => this.forkAndStartTurnSerially(input));
    this.startQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async forkAndStartTurnSerially(
    input: ForkAndStartOrchestratedTurn
  ): Promise<RunRecord> {
    if (!this.adapter.forkSession) {
      throw new Error('This provider does not support session forks.');
    }
    const settings = await this.validateSettings(input.settings);
    await this.assertCapacity();
    const sourceSession = await this.requireSession(input.sourceRun.sessionId);
    await this.assertNoPendingInteractions(sourceSession.id);
    const fork = await this.store.createAgentSession({
      task: input.task,
      iteration: input.iteration,
      worktree: input.worktree,
      provider: sourceSession.provider,
      role: 'ALTERNATIVE',
      requestedSettings: settings,
      parentSessionId: sourceSession.id,
      forkedFromSessionId: sourceSession.id
    });
    try {
      let materialized: AgentSessionRecord;
      try {
        materialized = await this.adapter.forkSession({
          sourceSession: {
            localSessionId: sourceSession.id,
            providerSessionId: sourceSession.providerSessionId
          },
          localSessionId: fork.id,
          settings
        });
      } catch (error) {
        if (!(error instanceof AgentProviderSessionMissingError)) {
          throw error;
        }
        const recovered = await this.recreateMissingProviderSession(
          sourceSession,
          settings,
          error
        );
        materialized = await this.adapter.forkSession({
          sourceSession: {
            localSessionId: recovered.id,
            providerSessionId: recovered.providerSessionId
          },
          localSessionId: fork.id,
          settings
        });
      }
      return this.startTurnSerially({
        ...input,
        settings,
        sessionId: materialized.id,
        retryOfRunId: input.sourceRun.id
      });
    } catch (error) {
      await this.store.updateAgentSession(fork.id, { status: 'UNKNOWN' });
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
    if (!this.adapter.startReview) {
      throw new Error('This provider does not support detached review.');
    }
    const settings = await this.validateSettings(input.settings);
    await this.assertCapacity();
    const sourceSession = await this.requireSession(input.sourceRun.sessionId);
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
    try {
      await this.startProviderReview(run, sourceSession, reviewSession, input.target);
      return (await this.store.getRun(run.id)) ?? run;
    } catch (error) {
      if (error instanceof AgentProviderSessionMissingError) {
        try {
          const recovered = await this.recreateMissingProviderSession(
            sourceSession,
            settings,
            error
          );
          await this.startProviderReview(run, recovered, reviewSession, input.target);
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
    const run = await this.store.getRun(runId);
    if (!run || !run.providerTurnId) {
      return;
    }
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

  respondToInteraction(
    input: RespondToInteractionRequest
  ): Promise<InteractionRequestRecord> {
    return this.interactions.respond(input);
  }

  async syncGoal(
    task: Task,
    sessionId: string
  ): Promise<import('../../shared/contracts').AgentGoalSnapshotRecord> {
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

  shutdown(): Promise<void> {
    return this.adapter.shutdown();
  }

  private async startProviderTurn(
    run: RunRecord,
    session: AgentSessionRecord,
    input: StartOrchestratedTurn,
    settings: AgentExecutionSettings
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
      settings
    });
  }

  private async startProviderReview(
    run: RunRecord,
    sourceSession: AgentSessionRecord,
    reviewSession: AgentSessionRecord,
    target: AgentReviewTarget
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
      target
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
    settings: AgentExecutionSettings
  ): Promise<AgentExecutionSettings> {
    const models = await this.adapter.listModels();
    const model =
      models.find((candidate) => candidate.model === settings.model) ??
      models.find((candidate) => candidate.id === settings.model) ??
      models.find((candidate) => candidate.isDefault);
    if (!model) {
      throw new Error('Codex did not report an available model.');
    }
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
    return {
      ...settings,
      model: model.model,
      modelProvider,
      reasoningEffort: effort,
      serviceTier: settings.serviceTier ?? model.defaultServiceTier
    };
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
