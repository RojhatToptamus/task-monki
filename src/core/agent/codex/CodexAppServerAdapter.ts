import { createHash } from 'node:crypto';
import type {
  AgentExecutionSettings,
  AgentInteractionRequestPayload,
  AgentInteractionDecision,
  AgentItemStatus,
  AgentModel,
  AgentPreflight,
  AgentProviderCapabilities,
  AgentGoalSnapshotRecord,
  AgentReviewTarget,
  AgentServerInstance,
  AgentSessionRecord,
  AgentSessionSnapshot,
  AgentSubagentStatus,
  InteractionRequestRecord,
  RunRecord
} from '../../../shared/contracts';
import type { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import type {
  AgentInteractionResponse,
  AgentProviderAdapter,
  AgentReconciliationResult,
  AgentSessionRef,
  AgentTurn,
  CreateAgentSession,
  ForkAgentSession,
  InterruptAgentTurn,
  StartAgentReview,
  StartAgentTurn,
  SyncAgentGoal,
  SteerAgentTurn
} from '../AgentProviderAdapter';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError
} from '../AgentProviderAdapter';
import { codexCapabilities } from './codexCapabilities';
import {
  CodexAppServerSupervisor,
  type CodexAppServerSupervisorOptions
} from './CodexAppServerSupervisor';
import {
  CodexAmbiguousMutationError,
  type CodexRpcClient
} from './CodexRpcClient';
import type {
  AgentProtocolMessageReference,
  CodexExternalToolSettings
} from '../../../shared/agent';
import type { UnsupportedCodexServerRequest } from './protocol/CodexProtocolCodec';
import type { ServerNotification } from './protocol/generated/ServerNotification';
import type { ServerRequest } from './protocol/generated/ServerRequest';
import type { Model } from './protocol/generated/v2/Model';
import type { ApprovalsReviewer } from './protocol/generated/v2/ApprovalsReviewer';
import type { ThreadItem } from './protocol/generated/v2/ThreadItem';
import type { Thread } from './protocol/generated/v2/Thread';
import type { ThreadGoal } from './protocol/generated/v2/ThreadGoal';
import type { ThreadSettings } from './protocol/generated/v2/ThreadSettings';
import type { ThreadStatus } from './protocol/generated/v2/ThreadStatus';
import type { ThreadTokenUsage } from './protocol/generated/v2/ThreadTokenUsage';
import type { Turn } from './protocol/generated/v2/Turn';
import type { TurnPlanStep } from './protocol/generated/v2/TurnPlanStep';
import type { CollabAgentStatus } from './protocol/generated/v2/CollabAgentStatus';
import type { SubAgentActivityKind } from './protocol/generated/v2/SubAgentActivityKind';
import type { TurnStatus } from './protocol/generated/v2/TurnStatus';
import type { ReviewTarget } from './protocol/generated/v2/ReviewTarget';
import {
  describeAccount,
  formatFinalArtifact,
  mapCompletedItemStatus,
  mapGoalFields,
  mapItemType,
  mapModel,
  mapPlanSteps,
  mapThreadStatus,
  mapTokenUsage,
  mapTurnStatus,
  settingsFromThreadSettings,
  settingsFromThreadResponse,
  toSandboxMode,
  toSandboxPolicy
} from './CodexEventMapper';
import {
  mapCodexInteractionRequest,
  mapCodexInteractionResponse
} from './CodexInteractionMapper';
import {
  buildInteractionPolicy,
  interactionTerminalStatus
} from '../AgentInteractionPolicy';
import { CODEX_REVIEW_DEVELOPER_INSTRUCTIONS } from '../../../shared/promptTemplates';
import {
  codexReviewStatusFromResult,
  parseCodexReviewResult
} from '../../review/CodexReviewContract';
const ACTIVE_RUN_STATES: RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
];

const RUNTIME_CONFIG_PENDING_RESTART_WARNING =
  'Codex executable or tool settings changed and will apply after active runs finish or the app restarts.';

function canRetargetReviewTurn(
  run: RunRecord,
  session: AgentSessionRecord
): boolean {
  return (
    session.role === 'REVIEW' &&
    run.mode === 'REVIEW' &&
    ACTIVE_RUN_STATES.includes(run.status)
  );
}

function isNoActiveTurnToInterrupt(error: Error): boolean {
  return /no active turn to interrupt/i.test(error.message);
}

function toThreadConfig(
  settings: AgentExecutionSettings
): Record<string, string> | null {
  if (!settings.reasoningEffort) {
    return null;
  }
  return { model_reasoning_effort: settings.reasoningEffort };
}

export interface CodexAppServerAdapterOptions
  extends Omit<CodexAppServerSupervisorOptions, 'appVersion'> {
  appVersion?: string;
  restartDelaysMs?: number[];
  interruptRequestTimeoutMs?: number;
  interruptCompletionTimeoutMs?: number;
}

export class CodexAppServerAdapter implements AgentProviderAdapter {
  private readonly supervisor: CodexAppServerSupervisor;
  private readonly restartDelaysMs: number[];
  private boundClient?: CodexRpcClient;
  private models: AgentModel[] = [];
  private preflightState: AgentPreflight = {
    provider: 'codex',
    ready: false,
    capabilities: codexCapabilities(),
    problems: ['Codex App Server has not been initialized.'],
    warnings: []
  };
  private restartAttempt = 0;
  private restartTimer?: NodeJS.Timeout;
  private restartWork?: Promise<void>;
  private runtimeLossWork?: Promise<void>;
  private shutdownWork?: Promise<void>;
  private inboundQueue: Promise<void> = Promise.resolve();
  private readonly interruptRequestTimeoutMs: number;
  private readonly interruptCompletionTimeoutMs: number;
  private readonly interruptTimers = new Map<string, NodeJS.Timeout>();
  private initialized = false;
  private runtimeConfigRestartPending = false;
  private shuttingDown = false;
  private supervisorExitListenerAttached = false;
  private readonly handleSupervisorExit = (
    server: AgentServerInstance,
    unexpected: boolean
  ): void => {
    if (!unexpected || this.shuttingDown) return;
    const previous = this.runtimeLossWork ?? Promise.resolve();
    const work = previous
      .then(() => this.handleRuntimeLoss(server.id))
      .then(() => {
        if (!this.shuttingDown) this.scheduleRestart();
      })
      .catch(() => undefined);
    this.runtimeLossWork = work;
    void work.then(() => {
      if (this.runtimeLossWork === work) this.runtimeLossWork = undefined;
    });
  };

  constructor(
    private readonly store: FileTaskStore,
    private readonly appEvents: AppEventBus,
    options: CodexAppServerAdapterOptions
  ) {
    this.restartDelaysMs = options.restartDelaysMs ?? [500, 1_000, 2_000];
    this.interruptRequestTimeoutMs = options.interruptRequestTimeoutMs ?? 5_000;
    this.interruptCompletionTimeoutMs = options.interruptCompletionTimeoutMs ?? 15_000;
    this.supervisor = new CodexAppServerSupervisor(store, {
      ...options,
      appVersion: options.appVersion ?? '0.1.0'
    });
    this.attachSupervisorExitListener();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.shuttingDown = false;
    this.attachSupervisorExitListener();
    this.initialized = true;
    await this.recoverPersistedRuntimeLosses();
    await this.ensureClient();
    await this.refreshPreflight();
    await this.reconcile();
  }

  async preflight(): Promise<AgentPreflight> {
    try {
      await this.ensureClient();
      await this.refreshPreflight();
    } catch (error) {
      this.preflightState = {
        provider: 'codex',
        ready: false,
        capabilities: codexCapabilities(),
        problems: [error instanceof Error ? error.message : String(error)],
        warnings: []
      };
    }
    return structuredClone(this.preflightState);
  }

  capabilities(): Promise<AgentProviderCapabilities> {
    return Promise.resolve(codexCapabilities());
  }

  async listModels(): Promise<AgentModel[]> {
    await this.ensureClient();
    if (this.models.length === 0) {
      await this.refreshModels();
    }
    return structuredClone(this.models);
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    const session = await this.requireSession(input.localSessionId);
    if (session.providerSessionId) {
      return this.attachSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
    }

    const client = await this.ensureClient();
    const settings = input.settings;
    const response = await client.request('thread/start', {
      model: settings.model ?? null,
      modelProvider: settings.modelProvider ?? null,
      serviceTier: settings.serviceTier ?? null,
      cwd: input.worktreePath,
      approvalPolicy: toApprovalPolicy(settings),
      approvalsReviewer: toApprovalsReviewer(settings),
      sandbox: toSandboxMode(settings),
      config: toThreadConfig(settings),
      ephemeral: false
    });

    const stored = await this.store.updateAgentSession(session.id, {
      providerSessionId: response.thread.id,
      providerSessionTreeId: response.thread.sessionId,
      status: mapThreadStatus(response.thread.status),
      materialized: false,
      requestedSettings: settings,
      observedSettings: settingsFromThreadResponse(response),
      lastAttachedAt: new Date().toISOString()
    });
    await this.recordSettingsObservation(
      stored,
      'THREAD_START_RESPONSE',
      settingsFromThreadResponse(response)
    );
    return stored;
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    const session = await this.requireSession(ref.localSessionId);
    const providerSessionId = ref.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId) {
      throw new Error(`Agent session ${session.id} has not been materialized.`);
    }

    const client = await this.ensureClient();
    const response = await client.request('thread/resume', {
      threadId: providerSessionId,
      model: session.requestedSettings.model ?? null,
      modelProvider: session.requestedSettings.modelProvider ?? null,
      serviceTier: session.requestedSettings.serviceTier ?? null,
      cwd: session.worktreePath,
      approvalPolicy: toApprovalPolicy(session.requestedSettings),
      approvalsReviewer: toApprovalsReviewer(session.requestedSettings),
      sandbox: toSandboxMode(session.requestedSettings),
      config: toThreadConfig(session.requestedSettings)
    });

    const stored = await this.store.updateAgentSession(session.id, {
      providerSessionId: response.thread.id,
      providerSessionTreeId: response.thread.sessionId,
      status: mapThreadStatus(response.thread.status),
      materialized: true,
      observedSettings: settingsFromThreadResponse(response),
      lastAttachedAt: new Date().toISOString()
    });
    await this.recordSettingsObservation(
      stored,
      'THREAD_RESUME_RESPONSE',
      settingsFromThreadResponse(response)
    );
    return stored;
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot> {
    const session = await this.requireSession(ref.localSessionId);
    const providerSessionId = ref.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId) {
      return { session, runs: [] };
    }
    const client = await this.ensureClient();
    const response = await client.request('thread/read', {
      threadId: providerSessionId,
      includeTurns: true
    });
    const snapshot = await this.store.snapshot();
    return {
      session: await this.store.updateAgentSession(session.id, {
        status: mapThreadStatus(response.thread.status),
        materialized: response.thread.turns.length > 0
      }),
      runs: snapshot.runs
        .filter((run) => run.sessionId === session.id)
        .map((run) => ({
          id: run.id,
          providerTurnId: run.providerTurnId,
          status: run.status
        }))
    };
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    let session = await this.requireSession(input.session.localSessionId);
    if (!session.providerSessionId) {
      session = await this.createSession({
        localSessionId: session.id,
        taskId: session.taskId,
        iterationId: session.iterationId,
        worktreeId: session.worktreeId,
        worktreePath: session.worktreePath,
        settings: input.settings ?? session.requestedSettings
      });
    }

    const client = await this.ensureClient();
    const server = this.supervisor.currentServer;
    if (!server || !session.providerSessionId) {
      throw new Error('Codex App Server is not ready to start a turn.');
    }
    const settings = input.settings ?? session.requestedSettings;
    await this.store.updateRun(input.localRunId, {
      serverInstanceId: server.id,
      status: 'STARTING',
      lastEventAt: new Date().toISOString()
    });
    let response;
    try {
      response = await client.requestMutation('turn/start', {
        threadId: session.providerSessionId,
        clientUserMessageId: input.localRunId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        cwd: session.worktreePath,
        approvalPolicy: toApprovalPolicy(settings),
        approvalsReviewer: toApprovalsReviewer(settings),
        sandboxPolicy: toSandboxPolicy(settings, session.worktreePath),
        model: settings.model ?? null,
        serviceTier: settings.serviceTier ?? null,
        effort: settings.reasoningEffort ?? null,
        summary: 'auto',
        personality: null,
        outputSchema: null
      });
    } catch (error) {
      throw mapMutationError('turn/start', error);
    }

    await this.store.updateRun(input.localRunId, {
      providerTurnId: response.turn.id,
      serverInstanceId: server.id,
      status: 'RUNNING',
      lastEventAt: new Date().toISOString()
    });
    await this.store.updateAgentSession(session.id, {
      status: 'ACTIVE',
      materialized: true,
      requestedSettings: settings,
      lastAttachedAt: new Date().toISOString()
    });
    void this.syncGoalIfNeeded(session.id, input.authoritativeGoal).catch((error) => {
      this.preflightState = {
        ...this.preflightState,
        warnings: [
          ...new Set([
            ...this.preflightState.warnings,
            `Goal synchronization failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          ])
        ]
      };
      this.emitProviderUpdate();
    });
    return { localRunId: input.localRunId, providerTurnId: response.turn.id };
  }

  async steerTurn(input: SteerAgentTurn): Promise<void> {
    const session = await this.requireSession(input.session.localSessionId);
    if (!session.providerSessionId) {
      throw new Error('Cannot steer a session without a provider thread id.');
    }
    const client = await this.ensureClient();
    try {
      const response = await client.requestMutation('turn/steer', {
        threadId: session.providerSessionId,
        clientUserMessageId: input.clientMessageId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        expectedTurnId: input.providerTurnId
      });
      if (response.turnId !== input.providerTurnId) {
        throw new Error(
          `Codex accepted steering for unexpected turn ${response.turnId}.`
        );
      }
    } catch (error) {
      throw mapMutationError('turn/steer', error);
    }
    const run = await this.store.getRunByProviderTurnId(input.providerTurnId);
    if (run) {
      await this.recordRunActivity(run, 'turn/steered', {
        clientMessageId: input.clientMessageId
      });
    }
  }

  async interruptTurn(input: InterruptAgentTurn): Promise<void> {
    const session = await this.requireSession(input.session.localSessionId);
    if (!session.providerSessionId) {
      throw new Error('Cannot interrupt a session without a provider thread id.');
    }
    const providerSessionId = session.providerSessionId;
    const client = await this.ensureClient();
    const interrupt = async (providerTurnId: string): Promise<void> => {
      await client.requestMutation(
        'turn/interrupt',
        {
          threadId: providerSessionId,
          turnId: providerTurnId
        },
        this.interruptRequestTimeoutMs
      );
    };
    const stopAlreadyInactiveReview = async (
      providerTurnId: string,
      error: Error
    ): Promise<boolean> => {
      if (!isNoActiveTurnToInterrupt(error)) {
        return false;
      }
      const run = await this.store.getRunByProviderTurnId(providerTurnId);
      if (!run || !canRetargetReviewTurn(run, session)) {
        return false;
      }
      await this.recordLocalInterruption(
        run,
        'Codex reported no active turn to interrupt; treating the review as already stopped.'
      );
      await this.store.updateAgentSession(run.sessionId, { status: 'IDLE' });
      return true;
    };
    try {
      await interrupt(input.providerTurnId);
    } catch (error) {
      const mapped = mapMutationError('turn/interrupt', error);
      if (mapped instanceof AgentMutationAmbiguousError) {
        await this.recordInterruptAmbiguity(input.providerTurnId, mapped.message);
        this.armInterruptDeadline(input.providerTurnId);
        return;
      }
      if (await stopAlreadyInactiveReview(input.providerTurnId, mapped)) {
        return;
      }
      const activeTurnId = activeTurnIdFromInterruptMismatch(mapped);
      if (activeTurnId && activeTurnId !== input.providerTurnId) {
        const run = await this.store.getRunByProviderTurnId(input.providerTurnId);
        if (run && canRetargetReviewTurn(run, session)) {
          const updatedRun = await this.store.updateRun(run.id, {
            providerTurnId: activeTurnId,
            lastEventAt: new Date().toISOString()
          });
          await this.recordRunActivity(updatedRun, 'turn/interrupt/retargeted', {
            previousProviderTurnId: input.providerTurnId,
            providerTurnId: activeTurnId
          });
          try {
            await interrupt(activeTurnId);
          } catch (retryError) {
            const retryMapped = mapMutationError('turn/interrupt', retryError);
            if (retryMapped instanceof AgentMutationAmbiguousError) {
              await this.recordInterruptAmbiguity(activeTurnId, retryMapped.message);
              this.armInterruptDeadline(activeTurnId);
              return;
            }
            if (await stopAlreadyInactiveReview(activeTurnId, retryMapped)) {
              return;
            }
            throw retryMapped;
          }
          this.armInterruptDeadline(activeTurnId);
          return;
        }
      }
      throw mapped;
    }
    this.armInterruptDeadline(input.providerTurnId);
  }

  async forkSession(input: ForkAgentSession): Promise<AgentSessionRecord> {
    const source = await this.requireSession(input.sourceSession.localSessionId);
    const target = await this.requireSession(input.localSessionId);
    const providerSessionId =
      input.sourceSession.providerSessionId ?? source.providerSessionId;
    if (!providerSessionId) {
      throw new Error('Cannot fork a session without a provider thread id.');
    }
    const client = await this.ensureClient();
    let response;
    try {
      response = await client.requestMutation('thread/fork', {
        threadId: providerSessionId,
        model: input.settings.model ?? null,
        modelProvider: input.settings.modelProvider ?? null,
        serviceTier: input.settings.serviceTier ?? null,
        cwd: target.worktreePath,
        approvalPolicy: toApprovalPolicy(input.settings),
        approvalsReviewer: toApprovalsReviewer(input.settings),
        sandbox: toSandboxMode(input.settings),
        config: toThreadConfig(input.settings),
        ephemeral: false
      });
    } catch (error) {
      throw mapMutationError('thread/fork', error);
    }
    const stored = await this.store.updateAgentSession(target.id, {
      providerSessionId: response.thread.id,
      providerSessionTreeId: response.thread.sessionId,
      status: mapThreadStatus(response.thread.status),
      materialized: true,
      requestedSettings: input.settings,
      observedSettings: settingsFromThreadResponse(response),
      lastAttachedAt: new Date().toISOString()
    });
    await this.recordSettingsObservation(
      stored,
      'THREAD_FORK_RESPONSE',
      settingsFromThreadResponse(response)
    );
    return stored;
  }

  async startReview(input: StartAgentReview): Promise<AgentTurn> {
    const source = await this.requireSession(input.sourceSession.localSessionId);
    const reviewSession = await this.requireSession(input.reviewSessionId);
    const providerSessionId =
      input.sourceSession.providerSessionId ?? source.providerSessionId;
    if (!providerSessionId) {
      throw new Error('Cannot review a session without a provider thread id.');
    }
    const client = await this.ensureClient();
    const server = this.supervisor.currentServer;
    if (!server) {
      throw new Error('Codex App Server is not ready to start a review.');
    }
    await this.store.updateRun(input.localRunId, {
      serverInstanceId: server.id,
      status: 'STARTING',
      lastEventAt: new Date().toISOString()
    });
    const settings = reviewSession.requestedSettings;
    let response;
    try {
      const reviewBase = await client.requestMutation('thread/fork', {
        threadId: providerSessionId,
        model: settings.model ?? null,
        modelProvider: settings.modelProvider ?? null,
        serviceTier: settings.serviceTier ?? null,
        cwd: reviewSession.worktreePath,
        approvalPolicy: toApprovalPolicy(settings),
        approvalsReviewer: toApprovalsReviewer(settings),
        sandbox: toSandboxMode(settings),
        config: toThreadConfig(settings),
        developerInstructions: CODEX_REVIEW_DEVELOPER_INSTRUCTIONS,
        ephemeral: false
      });
      await this.recordSettingsObservation(
        reviewSession,
        'THREAD_FORK_RESPONSE',
        settingsFromThreadResponse(reviewBase)
      );
      response = await client.requestMutation('review/start', {
        threadId: reviewBase.thread.id,
        target: toReviewTarget(input.target),
        delivery: 'inline'
      });
    } catch (error) {
      throw mapMutationError('review/start', error);
    }
    await this.store.updateAgentSession(reviewSession.id, {
      providerSessionId: response.reviewThreadId,
      providerSessionTreeId: response.reviewThreadId,
      status: 'ACTIVE',
      materialized: true,
      lastAttachedAt: new Date().toISOString()
    });
    await this.store.updateRun(input.localRunId, {
      providerTurnId: response.turn.id,
      serverInstanceId: server.id,
      status: 'RUNNING',
      lastEventAt: new Date().toISOString()
    });
    return {
      localRunId: input.localRunId,
      providerTurnId: response.turn.id
    };
  }

  async syncGoal(input: SyncAgentGoal): Promise<AgentGoalSnapshotRecord> {
    const session = await this.requireSession(input.session.localSessionId);
    const providerSessionId =
      input.session.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId || !session.materialized) {
      throw new Error('The provider thread must be materialized before goal sync.');
    }
    const latest = await this.store.getLatestAgentGoalSnapshot(session.id);
    const taskGoalHash = hashGoal(input.authoritativeGoal);
    if (
      !input.force &&
      latest?.lastSynchronizedTaskGoalHash === taskGoalHash &&
      latest.syncState !== 'SYNC_FAILED' &&
      latest.syncState !== 'UNKNOWN'
    ) {
      return latest;
    }
    const client = await this.ensureClient();
    try {
      const response = await client.requestMutation('thread/goal/set', {
        threadId: providerSessionId,
        objective: input.authoritativeGoal
      });
      const stored = await this.recordGoalSnapshot({
        session,
        authoritativeGoal: input.authoritativeGoal,
        goal: response.goal,
        source: 'TASK_MONKI_SYNC'
      });
      this.emitGoalUpdate(stored);
      return stored;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const stored = await this.store.recordAgentGoalSnapshot({
        taskId: session.taskId,
        iterationId: session.iterationId,
        sessionId: session.id,
        provider: session.provider,
        taskGoalHash,
        lastSynchronizedTaskGoalHash: latest?.lastSynchronizedTaskGoalHash,
        providerObjective: latest?.providerObjective,
        providerStatus: latest?.providerStatus,
        tokenBudget: latest?.tokenBudget,
        tokensUsed: latest?.tokensUsed,
        timeUsedSeconds: latest?.timeUsedSeconds,
        syncState: 'SYNC_FAILED',
        source: 'SYNC_ERROR',
        detail
      });
      this.emitGoalUpdate(stored);
      return stored;
    }
  }

  async respondToInteraction(input: AgentInteractionResponse): Promise<void> {
    const { interaction, decision } = input;
    const client = this.supervisor.currentClient;
    const server = this.supervisor.currentServer;
    if (
      !client ||
      !server ||
      server.id !== interaction.serverInstanceId ||
      client.serverInstanceId !== interaction.serverInstanceId
    ) {
      throw new Error('The interaction belongs to a prior Codex App Server instance.');
    }
    if (interaction.status !== 'RESPONDING') {
      throw new Error(
        `Interaction request ${interaction.id} is ${interaction.status}; expected RESPONDING.`
      );
    }

    await client.respond(
      interaction.providerRequestId,
      mapCodexInteractionResponse(decision),
      async (reference) => {
        await this.store.transitionInteractionRequest(
          interaction.id,
          'RESPONDING',
          {
            status: 'RESPONDING',
            responseRawMessage: reference
          }
        );
      }
    );
  }

  async reconcile(): Promise<AgentReconciliationResult> {
    const runs = await this.store.getRunsRequiringRecovery();
    const reconciledSessionIds = new Set<string>();
    const recoveryRequiredSessionIds = new Set<string>();
    if (runs.length === 0) {
      return { reconciledSessionIds: [], recoveryRequiredSessionIds: [] };
    }

    const client = await this.ensureClient();
    for (const run of runs) {
      const session = await this.store.getAgentSession(run.sessionId);
      if (!session?.providerSessionId) {
        await this.recordReconciliation(run, 'LOST', 'UNRECOVERABLE', true);
        recoveryRequiredSessionIds.add(run.sessionId);
        continue;
      }
      if (!run.providerTurnId) {
        await this.recordReconciliation(
          run,
          'RECOVERY_REQUIRED',
          'REQUIRES_USER_ACTION',
          false
        );
        recoveryRequiredSessionIds.add(run.sessionId);
        continue;
      }

      try {
        const response = await client.request('thread/resume', {
          threadId: session.providerSessionId,
          cwd: session.worktreePath,
          approvalPolicy: toApprovalPolicy(session.requestedSettings),
          approvalsReviewer: toApprovalsReviewer(session.requestedSettings),
          sandbox: toSandboxMode(session.requestedSettings)
        });
        await this.store.updateAgentSession(session.id, {
          status: mapThreadStatus(response.thread.status),
          materialized: true,
          observedSettings: settingsFromThreadResponse(response),
          lastAttachedAt: new Date().toISOString()
        });
        await this.recordSettingsObservation(
          session,
          'RECOVERY_RESUME_RESPONSE',
          settingsFromThreadResponse(response),
          run.id
        );
        const providerTurn = response.thread.turns.find(
          (turn) => turn.id === run.providerTurnId
        );
        if (!providerTurn) {
          await this.recordReconciliation(
            run,
            'RECOVERY_REQUIRED',
            'REQUIRES_USER_ACTION',
            false
          );
          recoveryRequiredSessionIds.add(run.sessionId);
          continue;
        }
        const status = mapTurnStatus(providerTurn.status);
        const terminal = status !== 'RUNNING';
        if (terminal) {
          await this.finalizeTurn(run, providerTurn, 'RECOVERY_RESUME_RESPONSE');
        }
        await this.recordReconciliation(
          run,
          terminal ? status : 'RECOVERY_REQUIRED',
          terminal ? 'RECOVERED' : 'REQUIRES_USER_ACTION',
          terminal
        );
        if (terminal) {
          reconciledSessionIds.add(run.sessionId);
        } else {
          recoveryRequiredSessionIds.add(run.sessionId);
        }
      } catch {
        await this.recordReconciliation(
          run,
          'RECOVERY_REQUIRED',
          'REQUIRES_USER_ACTION',
          false
        );
        recoveryRequiredSessionIds.add(run.sessionId);
      }
    }

    return {
      reconciledSessionIds: [...reconciledSessionIds],
      recoveryRequiredSessionIds: [...recoveryRequiredSessionIds]
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    this.shuttingDown = true;
    this.detachSupervisorExitListener();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    for (const timer of this.interruptTimers.values()) {
      clearTimeout(timer);
    }
    this.interruptTimers.clear();
    const work = this.completeShutdown();
    this.shutdownWork = work;
    void work.then(
      () => {
        if (this.shutdownWork === work) this.shutdownWork = undefined;
      },
      () => {
        if (this.shutdownWork === work) this.shutdownWork = undefined;
      }
    );
    return work;
  }

  async updateRuntimeConfig(input: {
    executable?: string;
    toolSettings: CodexExternalToolSettings;
    restart: boolean;
  }): Promise<void> {
    this.supervisor.setExecutable(input.executable);
    this.supervisor.setToolSettings(input.toolSettings);
    if (!this.initialized) {
      return;
    }
    if (!input.restart) {
      this.runtimeConfigRestartPending = true;
      this.preflightState = {
        ...this.preflightState,
        warnings: [
          ...new Set([
            ...this.preflightState.warnings,
            RUNTIME_CONFIG_PENDING_RESTART_WARNING
          ])
        ]
      };
      this.emitProviderUpdate();
      return;
    }

    await this.shutdown();
    this.runtimeConfigRestartPending = false;
    this.boundClient = undefined;
    this.models = [];
    this.initialized = false;
    this.preflightState = {
      provider: 'codex',
      ready: false,
      capabilities: codexCapabilities(),
      problems: ['Codex App Server is restarting with updated settings.'],
      warnings: []
    };
    this.emitProviderUpdate();
    await this.initialize();
  }

  getProviderState(): { preflight: AgentPreflight; models: AgentModel[]; refreshedAt: string } {
    return {
      preflight: structuredClone(this.preflightState),
      models: structuredClone(this.models),
      refreshedAt: new Date().toISOString()
    };
  }

  private async ensureClient(): Promise<CodexRpcClient> {
    if (this.shuttingDown) {
      throw new Error('Codex App Server is shutting down.');
    }
    const client = await this.supervisor.start();
    if (this.shuttingDown) {
      throw new Error('Codex App Server is shutting down.');
    }
    if (client !== this.boundClient) {
      this.bindClient(client);
    }
    return client;
  }

  private bindClient(client: CodexRpcClient): void {
    this.boundClient = client;
    client.events.on('notification', (notification, raw) => {
      this.enqueueInbound(() => this.handleNotification(notification, raw));
    });
    client.events.on('serverRequest', (request, raw) => {
      this.enqueueInbound(() => this.handleServerRequest(client, request, raw));
    });
    client.events.on('unsupportedServerRequest', (request) => {
      this.enqueueInbound(() => this.handleUnsupportedServerRequest(client, request));
    });
  }

  private enqueueInbound(operation: () => Promise<void>): void {
    this.inboundQueue = this.inboundQueue.then(operation).catch((error: unknown) => {
      const warning =
        error instanceof Error
          ? `Codex event materialization failed: ${error.message}`
          : `Codex event materialization failed: ${String(error)}`;
      this.preflightState = {
        ...this.preflightState,
        warnings: [...new Set([...this.preflightState.warnings, warning])]
      };
      this.emitProviderUpdate();
    });
  }

  private async refreshPreflight(publishUpdate = false): Promise<void> {
    const client = await this.ensureClient();
    const problems: string[] = [];
    const warnings: string[] = [];
    const accountResponse = await client.request('account/read', { refreshToken: false });
    const accountLabel = describeAccount(accountResponse.account);
    if (accountResponse.requiresOpenaiAuth && !accountResponse.account) {
      problems.push('Codex authentication is required. Run `codex login`.');
    }
    try {
      await this.refreshModels();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (this.runtimeConfigRestartPending) {
      warnings.push(RUNTIME_CONFIG_PENDING_RESTART_WARNING);
    }

    this.preflightState = {
      provider: 'codex',
      ready: problems.length === 0,
      capabilities: codexCapabilities(),
      runtimeVersion: this.supervisor.currentServer?.runtimeVersion,
      accountLabel,
      problems,
      warnings
    };
    if (publishUpdate) {
      this.emitProviderUpdate();
    }
  }

  private async refreshModels(): Promise<void> {
    const client = await this.ensureClient();
    const models: Model[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await client.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: true
      });
      models.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    this.models = models.map(mapModel);
  }

  private async handleNotification(
    notification: ServerNotification,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    switch (notification.method) {
      case 'thread/started':
        await this.handleThreadStarted(notification.params.thread, raw);
        return;
      case 'turn/started':
        await this.handleTurnStarted(notification.params.threadId, notification.params.turn);
        return;
      case 'turn/completed':
        await this.handleTurnCompleted(
          notification.params.threadId,
          notification.params.turn,
          raw
        );
        return;
      case 'item/started':
        await this.handleItem(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.item,
          'STARTED',
          raw,
          notification.params.startedAtMs
        );
        return;
      case 'item/completed':
        await this.handleItem(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.item,
          mapCompletedItemStatus(notification.params.item),
          raw,
          undefined,
          notification.params.completedAtMs
        );
        return;
      case 'item/agentMessage/delta':
      case 'item/commandExecution/outputDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/plan/delta':
        await this.appendTurnOutput(
          notification.params.turnId,
          notification.method,
          notification.params.delta
        );
        return;
      case 'turn/diff/updated':
        await this.appendTurnOutput(
          notification.params.turnId,
          notification.method,
          notification.params.diff
        );
        await this.recordTurnActivity(notification.params.turnId, notification.method, {
          byteCount: Buffer.byteLength(notification.params.diff),
          provenance: raw
        });
        return;
      case 'turn/plan/updated':
        await this.handlePlanRevision(
          notification.params.turnId,
          notification.params.explanation ?? undefined,
          notification.params.plan,
          raw
        );
        return;
      case 'thread/tokenUsage/updated':
        await this.handleUsageUpdate(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.tokenUsage,
          raw
        );
        return;
      case 'thread/goal/updated':
        await this.handleGoalUpdated(
          notification.params.threadId,
          notification.params.goal,
          raw
        );
        return;
      case 'thread/goal/cleared':
        await this.handleGoalCleared(notification.params.threadId, raw);
        return;
      case 'thread/settings/updated':
        await this.handleSettingsUpdated(
          notification.params.threadId,
          notification.params.threadSettings,
          raw
        );
        return;
      case 'model/rerouted':
        await this.handleModelReroute(
          notification.params.turnId,
          notification.params.fromModel,
          notification.params.toModel,
          notification.params.reason,
          raw
        );
        return;
      case 'item/reasoning/summaryPartAdded':
        await this.recordTurnActivity(
          notification.params.turnId,
          notification.method,
          {
            itemId: notification.params.itemId,
            summaryIndex: notification.params.summaryIndex,
            provenance: raw
          }
        );
        return;
      case 'thread/compacted':
        await this.recordTurnActivity(notification.params.turnId, notification.method, {
          provenance: raw,
          deprecated: true
        });
        return;
      case 'error':
        await this.recordTurnActivity(notification.params.turnId, notification.method, {
          error: notification.params.error,
          willRetry: notification.params.willRetry,
          provenance: raw
        });
        return;
      case 'warning':
        await this.handleThreadWarning(
          notification.params.threadId,
          notification.params.message,
          raw
        );
        return;
      case 'thread/status/changed':
        await this.handleThreadStatus(notification.params.threadId, notification.params.status);
        return;
      case 'thread/closed': {
        const session = await this.store.getAgentSessionByProviderId(
          notification.params.threadId
        );
        if (session) {
          await this.store.updateAgentSession(session.id, { status: 'NOT_LOADED' });
        }
        return;
      }
      case 'serverRequest/resolved':
        await this.handleServerRequestResolved(notification.params.requestId);
        return;
      default:
        return;
    }
  }

  private async handleThreadStarted(
    thread: Thread,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const existing = await this.store.getAgentSessionByProviderId(thread.id);
    const sourceMetadata = getSubagentThreadMetadata(thread);
    const providerParentSessionId =
      thread.parentThreadId ??
      sourceMetadata.parentThreadId ??
      (sourceMetadata.isSpawnedSubagent ? thread.forkedFromId : null);

    if (providerParentSessionId) {
      const parent = await this.store.getAgentSessionByProviderId(
        providerParentSessionId
      );
      if (parent) {
        const parentRun = await this.store.getActiveRunForSession(parent.id);
        const observed = await this.store.observeSubagent({
          parentSessionId: parent.id,
          parentRunId: parentRun?.id,
          providerChildSessionId: thread.id,
          providerParentSessionId,
          providerForkedFromSessionId: thread.forkedFromId ?? undefined,
          source: thread.parentThreadId
            ? 'THREAD_STARTED_PARENT'
            : thread.forkedFromId
              ? 'THREAD_STARTED_FORK'
              : 'THREAD_STARTED_SOURCE',
          status: mapThreadToSubagentStatus(thread.status),
          providerSessionTreeId: thread.sessionId,
          providerNickname:
            thread.agentNickname ?? sourceMetadata.nickname ?? undefined,
          providerRole: thread.agentRole ?? sourceMetadata.role ?? undefined,
          agentPath: sourceMetadata.agentPath,
          materialized: true,
          rawMessage: raw
        });
        await this.store.updateAgentSession(observed.session.id, {
          status: mapThreadStatus(thread.status),
          materialized: true,
          lastAttachedAt: new Date().toISOString()
        });
        return;
      }
    }

    if (existing) {
      const unresolved =
        existing.role === 'SUBAGENT' &&
        existing.relationshipState !== 'RESOLVED' &&
        existing.relationshipState !== 'CONTRADICTORY';
      await this.store.updateAgentSession(existing.id, {
        providerSessionTreeId: thread.sessionId,
        providerParentSessionId:
          thread.parentThreadId ?? sourceMetadata.parentThreadId,
        providerForkedFromSessionId: thread.forkedFromId ?? undefined,
        providerNickname:
          thread.agentNickname ?? sourceMetadata.nickname ?? undefined,
        providerRole: thread.agentRole ?? sourceMetadata.role ?? undefined,
        agentPath: sourceMetadata.agentPath,
        relationshipState: unresolved ? 'UNRESOLVED' : existing.relationshipState,
        relationshipDetail: unresolved
          ? 'The provider identified this as a child thread, but its parent is not known to Task Monki.'
          : existing.relationshipDetail,
        status: mapThreadStatus(thread.status),
        subagentStatus:
          existing.role === 'SUBAGENT'
            ? mapThreadToSubagentStatus(thread.status)
            : existing.subagentStatus,
        materialized: true,
        lastAttachedAt: new Date().toISOString()
      });
    }
  }

  private async observeItemSubagents(
    session: AgentSessionRecord,
    run: RunRecord,
    item: ThreadItem,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (item.type === 'collabAgentToolCall') {
      const parent =
        (await this.store.getAgentSessionByProviderId(item.senderThreadId)) ??
        (item.senderThreadId === session.providerSessionId ? session : undefined);
      if (!parent) {
        return;
      }
      const requestedSettings: AgentExecutionSettings = {
        model: item.model ?? undefined,
        reasoningEffort: item.reasoningEffort ?? undefined
      };
      for (const childThreadId of new Set(item.receiverThreadIds)) {
        await this.store.observeSubagent({
          parentSessionId: parent.id,
          parentRunId: run.id,
          providerChildSessionId: childThreadId,
          providerParentSessionId: item.senderThreadId,
          source: 'COLLAB_RECEIVER',
          delegatedPrompt:
            item.tool === 'spawnAgent' ? item.prompt ?? undefined : undefined,
          requestedSettings,
          rawMessage: raw
        });
      }
      for (const [childThreadId, state] of Object.entries(item.agentsStates)) {
        if (!state) {
          continue;
        }
        await this.store.observeSubagent({
          parentSessionId: parent.id,
          parentRunId: run.id,
          providerChildSessionId: childThreadId,
          providerParentSessionId: item.senderThreadId,
          source: 'COLLAB_STATE',
          status: mapCollabAgentStatus(state.status),
          rawMessage: raw
        });
      }
      return;
    }
    if (item.type === 'subAgentActivity') {
      await this.store.observeSubagent({
        parentSessionId: session.id,
        parentRunId: run.id,
        providerChildSessionId: item.agentThreadId,
        providerParentSessionId: session.providerSessionId,
        source: 'SUBAGENT_ACTIVITY',
        status: mapSubagentActivityStatus(item.kind),
        agentPath: item.agentPath,
        rawMessage: raw
      });
    }
  }

  private async ensureRunForSession(
    session: AgentSessionRecord,
    providerTurnId: string
  ): Promise<RunRecord | undefined> {
    const existing = await this.store.getRunByProviderTurnId(providerTurnId);
    if (existing) {
      return existing;
    }
    if (session.role === 'REVIEW') {
      const activeReviewRun = await this.store.getActiveRunForSession(session.id);
      if (activeReviewRun?.mode === 'REVIEW') {
        return activeReviewRun;
      }
    }
    if (session.role !== 'SUBAGENT') {
      return undefined;
    }
    const server = this.supervisor.currentServer;
    if (!server) {
      return undefined;
    }
    return this.store.createObservedSubagentRun({
      session,
      providerTurnId,
      serverInstanceId: server.id,
      parentRunId: session.parentRunId,
      prompt: session.delegatedPrompt,
      requestedSettings: session.requestedSettings
    });
  }

  private async handleServerRequest(
    client: CodexRpcClient,
    request: ServerRequest,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const mapped = mapCodexInteractionRequest(request);
    if (!mapped) {
      await client.respondError(request.id, {
        code: -32601,
        message: `Task Monki does not support server request ${request.method}.`
      });
      return;
    }

    const params = request.params as unknown as {
      threadId?: string;
      turnId?: string | null;
      itemId?: string;
    };
    if (!params.threadId) {
      await client.respondError(request.id, {
        code: -32602,
        message: 'Task Monki could not correlate the request to a thread.'
      });
      return;
    }
    const session = await this.store.getAgentSessionByProviderId(params.threadId);
    const run =
      session && params.turnId
        ? await this.ensureRunForSession(session, params.turnId)
        : session
          ? await this.store.getActiveRunForSession(session.id)
          : undefined;
    const server = this.supervisor.currentServer;
    if (!session || !run || !server) {
      await client.respondError(request.id, {
        code: -32602,
        message: 'Task Monki could not correlate the request to an active run.'
      });
      return;
    }

    const item = params.itemId
      ? await this.store.getAgentItemByProviderId(run.id, params.itemId)
      : undefined;
    const interactionRequest = withProviderItemContext(
      mapped.type,
      mapped.request,
      item?.payload
    );
    const policy = buildInteractionPolicy({
      type: mapped.type,
      request: interactionRequest,
      session,
      run,
      providerItemPayload: item?.payload
    });
    const interaction = await this.store.createInteractionRequest({
      serverInstanceId: server.id,
      providerRequestId: request.id,
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      providerTurnId: params.turnId ?? undefined,
      providerItemId: params.itemId,
      type: mapped.type,
      request: interactionRequest,
      allowedActions: policy.allowedActions,
      policyWarnings: policy.warnings,
      requestRawMessage: raw
    });
    this.emitInteractionUpdate(interaction);
    this.appEvents.emit({
      type: 'run.activity',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { type: mapped.type, status: 'PENDING' },
      at: new Date().toISOString()
    });

    if (mapped.type === 'DYNAMIC_TOOL') {
      await this.rejectUnregisteredDynamicTool(interaction);
    }
  }

  private async handleUnsupportedServerRequest(
    client: CodexRpcClient,
    request: UnsupportedCodexServerRequest
  ): Promise<void> {
    await client.respondError(request.id, {
      code: -32601,
      message: `Task Monki does not support server request ${request.method}.`
    });
  }

  private async handleServerRequestResolved(
    providerRequestId: string | number
  ): Promise<void> {
    const server = this.supervisor.currentServer;
    if (!server) {
      return;
    }
    const interaction = await this.store.getInteractionRequestByProviderId(
      server.id,
      providerRequestId
    );
    if (!interaction || !['PENDING', 'RESPONDING'].includes(interaction.status)) {
      return;
    }
    const status =
      interaction.status === 'PENDING'
        ? 'STALE'
        : interaction.decision
          ? interactionTerminalStatus(interaction.decision)
          : 'STALE';
    const resolved = await this.store.transitionInteractionRequest(
      interaction.id,
      interaction.status,
      {
        status,
        resolvedAt: new Date().toISOString(),
        resolution: {
          method: 'serverRequest/resolved',
          clearedWithoutResponse: interaction.status === 'PENDING'
        }
      }
    );
    this.emitInteractionUpdate(resolved);
  }

  private async handleTurnStarted(threadId: string, turn: Turn): Promise<void> {
    const session = await this.store.getAgentSessionByProviderId(threadId);
    if (!session) {
      return;
    }
    let run = await this.ensureRunForSession(session, turn.id);
    if (!run) {
      run = await this.store.getActiveRunForSession(session.id);
      if (run) {
        if (!run.providerTurnId) {
          run = await this.store.updateRun(run.id, {
            providerTurnId: turn.id,
            status: 'RUNNING',
            lastEventAt: new Date().toISOString()
          });
        } else if (run.providerTurnId === turn.id) {
          run = await this.store.updateRun(run.id, {
            status: 'RUNNING',
            lastEventAt: new Date().toISOString()
          });
        } else {
          await this.store.appendEvent(
            createDomainEvent({
              type: 'AGENT_PROTOCOL_INCIDENT',
              taskId: run.taskId,
              iterationId: run.iterationId,
              runId: run.id,
              worktreeId: run.worktreeId,
              agentSessionId: run.sessionId,
              serverInstanceId: run.serverInstanceId,
              source: 'provider',
              payload: {
                parseError: `Ignoring turn/started for ${turn.id}; active run already tracks ${run.providerTurnId}.`
              }
            })
          );
          return;
        }
      }
    }
    if (!run) {
      return;
    }
    await this.store.updateAgentSession(session.id, {
      status: 'ACTIVE',
      materialized: true,
      subagentStatus: session.role === 'SUBAGENT' ? 'RUNNING' : session.subagentStatus
    });
    await this.recordRunActivity(run, 'turn/started', { providerTurnId: turn.id });
  }

  private async handleTurnCompleted(
    threadId: string,
    turn: Turn,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const interruptTimer = this.interruptTimers.get(turn.id);
    if (interruptTimer) {
      clearTimeout(interruptTimer);
      this.interruptTimers.delete(turn.id);
    }
    const session = await this.store.getAgentSessionByProviderId(threadId);
    const run = session
      ? await this.ensureRunForSession(session, turn.id)
      : undefined;
    if (!session || !run) {
      return;
    }
    await this.finalizeTurn(
      run,
      turn,
      'TURN_COMPLETED_NOTIFICATION',
      raw
    );
    await this.store.updateAgentSession(session.id, {
      status: turn.status === 'failed' ? 'SYSTEM_ERROR' : 'IDLE',
      materialized: true,
      subagentStatus:
        session.role === 'SUBAGENT'
          ? mapSubagentTurnStatus(turn.status)
          : session.subagentStatus
    });
  }

  private async handleItem(
    threadId: string,
    turnId: string,
    item: ThreadItem,
    status: AgentItemStatus,
    raw: AgentProtocolMessageReference,
    startedAtMs?: number,
    completedAtMs?: number
  ): Promise<void> {
    const session = await this.store.getAgentSessionByProviderId(threadId);
    const run = session
      ? await this.ensureRunForSession(session, turnId)
      : undefined;
    if (!session || !run) {
      return;
    }
    await this.store.upsertAgentItem({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      providerItemId: item.id,
      type: mapItemType(item),
      status,
      payload: item,
      rawMessage: raw,
      providerStartedAt: startedAtMs ? new Date(startedAtMs).toISOString() : undefined,
      providerCompletedAt: completedAtMs
        ? new Date(completedAtMs).toISOString()
        : undefined
    });
    if (item.type === 'agentMessage' && status === 'COMPLETED') {
      await this.store.updateRun(run.id, {
        finalMessage: item.text,
        lastEventAt: new Date().toISOString()
      });
    }
    await this.observeItemSubagents(session, run, item, raw);
    this.appEvents.emit({
      type: 'run.activity',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { itemType: item.type, itemId: item.id, status },
      at: new Date().toISOString()
    });
  }

  private async handleThreadStatus(
    threadId: string,
    status: ThreadStatus
  ): Promise<void> {
    const session = await this.store.getAgentSessionByProviderId(threadId);
    if (!session) {
      return;
    }
    await this.store.updateAgentSession(session.id, { status: mapThreadStatus(status) });
    const run = await this.store.getActiveRunForSession(session.id);
    if (run && status.type === 'active' && status.activeFlags.length === 0) {
      await this.recordRunActivity(run, 'thread/status/changed', {
        status: status.type,
        activeFlags: status.activeFlags,
        resumeConfirmed: true
      });
    }
  }

  private async handlePlanRevision(
    turnId: string,
    explanation: string | undefined,
    plan: TurnPlanStep[],
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(turnId);
    if (!run) {
      return;
    }
    await this.store.recordAgentPlanRevision({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: run.sessionId,
      provider: 'codex',
      explanation,
      steps: mapPlanSteps(plan),
      rawMessage: raw
    });
    this.emitRunActivity(run, {
      eventType: 'turn/plan/updated',
      stepCount: plan.length
    });
  }

  private async handleUsageUpdate(
    threadId: string,
    turnId: string,
    usage: ThreadTokenUsage,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const session = await this.store.getAgentSessionByProviderId(threadId);
    if (!session) {
      return;
    }
    const run = await this.store.getRunByProviderTurnId(turnId);
    const stored = await this.store.recordAgentUsageSnapshot({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runId: run?.id,
      provider: session.provider,
      total: mapTokenUsage(usage.total),
      last: mapTokenUsage(usage.last),
      modelContextWindow: usage.modelContextWindow ?? undefined,
      rawMessage: raw
    });
    if (run) {
      this.emitRunActivity(run, {
        eventType: 'thread/tokenUsage/updated',
        totalTokens: stored.total.totalTokens
      });
    }
  }

  private async handleGoalUpdated(
    threadId: string,
    goal: ThreadGoal,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const session = await this.store.getAgentSessionByProviderId(threadId);
    if (!session) {
      return;
    }
    const task = await this.store.getTask(session.taskId);
    if (!task) {
      return;
    }
    const stored = await this.recordGoalSnapshot({
      session,
      authoritativeGoal: task.prompt,
      goal,
      source: 'PROVIDER_NOTIFICATION',
      rawMessage: raw
    });
    this.emitGoalUpdate(stored);
  }

  private async handleGoalCleared(
    threadId: string,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const session = await this.store.getAgentSessionByProviderId(threadId);
    if (!session) {
      return;
    }
    const [task, latest] = await Promise.all([
      this.store.getTask(session.taskId),
      this.store.getLatestAgentGoalSnapshot(session.id)
    ]);
    if (!task) {
      return;
    }
    const stored = await this.store.recordAgentGoalSnapshot({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      provider: session.provider,
      taskGoalHash: hashGoal(task.prompt),
      lastSynchronizedTaskGoalHash: latest?.lastSynchronizedTaskGoalHash,
      syncState: 'CLEARED',
      source: 'PROVIDER_CLEARED',
      rawMessage: raw
    });
    this.emitGoalUpdate(stored);
  }

  private async handleSettingsUpdated(
    threadId: string,
    settings: ThreadSettings,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const session = await this.store.getAgentSessionByProviderId(threadId);
    if (!session) {
      return;
    }
    const observed = settingsFromThreadSettings(settings);
    await this.store.updateAgentSession(session.id, {
      observedSettings: observed
    });
    await this.recordSettingsObservation(
      session,
      'THREAD_SETTINGS_NOTIFICATION',
      observed,
      undefined,
      raw
    );
  }

  private async handleThreadWarning(
    threadId: string | null,
    message: string,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!threadId) {
      return;
    }
    const session = await this.store.getAgentSessionByProviderId(threadId);
    const run = session
      ? await this.store.getActiveRunForSession(session.id)
      : undefined;
    if (run) {
      await this.recordRunActivity(run, 'warning', {
        message,
        provenance: raw
      });
    }
  }

  private async handleModelReroute(
    turnId: string,
    fromModel: string,
    model: string,
    reason: unknown,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(turnId);
    if (!run) {
      return;
    }
    await this.store.updateRun(run.id, {
      observedSettings: { ...run.observedSettings, model },
      lastEventAt: new Date().toISOString()
    });
    const session = await this.requireSession(run.sessionId);
    await this.recordSettingsObservation(
      session,
      'MODEL_REROUTED_NOTIFICATION',
      { model },
      run.id,
      raw,
      `${fromModel} → ${model}: ${String(reason)}`
    );
    await this.recordRunActivity(run, 'model/rerouted', {
      fromModel,
      model,
      reason,
      provenance: raw
    });
  }

  private async appendTurnOutput(
    turnId: string,
    source: string,
    text: string
  ): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(turnId);
    if (!run) {
      return;
    }
    await this.store.appendArtifact(run.outputArtifactId, `\n[${source}]\n${text}`);
    this.appEvents.emit({
      type: 'run.output',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { source, text },
      at: new Date().toISOString()
    });
  }

  private async recordTurnActivity(
    turnId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(turnId);
    if (run) {
      await this.recordRunActivity(run, eventType, payload);
    }
  }

  private async recordRunActivity(
    run: RunRecord,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_ACTIVITY_RECEIVED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: { eventType, ...payload }
      })
    );
  }

  private async recordInterruptAmbiguity(
    providerTurnId: string,
    reason: string
  ): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(providerTurnId);
    if (!run) {
      return;
    }
    if (
      ['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
        run.status
      )
    ) {
      return;
    }
    await this.recordRunActivity(run, 'turn/interrupt/ambiguous', {
      providerTurnId,
      reason
    });
  }

  private async recordLocalInterruption(
    run: RunRecord,
    terminalReason: string
  ): Promise<void> {
    const current = (await this.store.getRun(run.id)) ?? run;
    if (
      ['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
        current.status
      )
    ) {
      return;
    }
    const finalArtifact = await this.store.writeFinalArtifact(
      current.taskId,
      current.id,
      `# Agent turn interrupted\n\n${terminalReason}\n`
    );
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_INTERRUPTED',
        taskId: current.taskId,
        iterationId: current.iterationId,
        runId: current.id,
        worktreeId: current.worktreeId,
        agentSessionId: current.sessionId,
        serverInstanceId: current.serverInstanceId,
        source: 'provider',
        payload: {
          terminalStatus: 'interrupted',
          terminalReason,
          finalArtifactId: finalArtifact.id
        }
      })
    );
    this.appEvents.emit({
      type: 'run.terminal',
      taskId: current.taskId,
      iterationId: current.iterationId,
      runId: current.id,
      worktreeId: current.worktreeId,
      payload: { status: 'interrupted', finalArtifactId: finalArtifact.id },
      at: new Date().toISOString()
    });
  }

  private async finalizeTurn(
    run: RunRecord,
    turn: Turn,
    source:
      | 'TURN_COMPLETED_NOTIFICATION'
      | 'RECOVERY_RESUME_RESPONSE',
    rawMessage?: AgentProtocolMessageReference
  ): Promise<void> {
    const current = await this.store.getRun(run.id);
    if (!current || !ACTIVE_RUN_STATES.includes(current.status)) {
      return;
    }
    const items = await this.store.getAgentItemsForRun(run.id);
    const finalMessage =
      current.finalMessage ??
      [...items]
        .reverse()
        .map((item) => item.payload)
        .find(
          (item): item is Extract<ThreadItem, { type: 'agentMessage' }> =>
            typeof item === 'object' &&
            item !== null &&
            'type' in item &&
            item.type === 'agentMessage'
        )?.text;
    const reviewResult =
      run.mode === 'REVIEW' ? parseCodexReviewResult(finalMessage) : undefined;
    const codexReviewStatus = codexReviewStatusFromResult(reviewResult);
    const finalArtifact = await this.store.writeFinalArtifact(
      run.taskId,
      run.id,
      formatFinalArtifact(run, turn, finalMessage)
    );
    await this.store.updateRun(run.id, {
      providerTerminalSource: source,
      providerTerminalRawMessage: rawMessage
    });
    const type =
      turn.status === 'completed'
        ? 'AGENT_RUN_COMPLETED'
        : turn.status === 'interrupted'
          ? 'AGENT_RUN_INTERRUPTED'
          : 'AGENT_RUN_FAILED';
    await this.store.appendEvent(
      createDomainEvent({
        type,
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: {
          terminalStatus: turn.status,
          error: turn.error?.message,
          finalArtifactId: finalArtifact.id,
          terminalReason: turn.error?.message,
          codexReviewStatus,
          codexReviewResult: reviewResult
        }
      })
    );
    this.appEvents.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: turn.status, finalArtifactId: finalArtifact.id },
      at: new Date().toISOString()
    });
  }

  private async handleRuntimeLoss(serverInstanceId: string): Promise<void> {
    this.preflightState = {
      ...this.preflightState,
      ready: false,
      problems: ['Codex App Server exited unexpectedly. Restarting.']
    };
    this.emitProviderUpdate();
    const snapshot = await this.store.snapshot();
    const affected = snapshot.runs.filter(
      (run) =>
        run.serverInstanceId === serverInstanceId && ACTIVE_RUN_STATES.includes(run.status)
    );
    for (const run of affected) {
      if (run.status === 'INTERRUPTING') {
        await this.recordLocalInterruption(
          run,
          'Codex App Server exited while processing an interruption.'
        );
      } else {
        await this.store.appendEvent(
          createDomainEvent({
            type: 'AGENT_RUNTIME_LOST',
            taskId: run.taskId,
            iterationId: run.iterationId,
            runId: run.id,
            worktreeId: run.worktreeId,
            agentSessionId: run.sessionId,
            serverInstanceId,
            source: 'provider',
            payload: { reason: 'Codex App Server exited unexpectedly.' }
          })
        );
      }
      await this.store.updateAgentSession(run.sessionId, { status: 'NOT_LOADED' });
    }
    for (const interaction of snapshot.interactionRequests.filter(
      (request) =>
        request.serverInstanceId === serverInstanceId &&
        ['PENDING', 'RESPONDING'].includes(request.status)
    )) {
      const aborted = await this.store.transitionInteractionRequest(
        interaction.id,
        interaction.status,
        {
          status: 'ABORTED_SERVER_LOST',
          resolution: { reason: 'Codex App Server exited.' },
          resolvedAt: new Date().toISOString()
        }
      );
      this.emitInteractionUpdate(aborted);
    }
  }

  private async recoverPersistedRuntimeLosses(): Promise<void> {
    const snapshot = await this.store.snapshot();
    const orphaned = snapshot.agentServers.filter((server) =>
      ['STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING'].includes(server.status)
    );
    for (const server of orphaned) {
      await this.store.updateAgentServer(server.id, {
        status: 'LOST',
        disconnectedAt: new Date().toISOString(),
        exitedAt: new Date().toISOString(),
        exitReason: 'Task Monki restarted without the prior App Server process.'
      });
      await this.handleRuntimeLoss(server.id);
    }
  }

  private armInterruptDeadline(providerTurnId: string): void {
    const existing = this.interruptTimers.get(providerTurnId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.interruptTimers.delete(providerTurnId);
      void this.store.getRunByProviderTurnId(providerTurnId).then(async (run) => {
        if (
          run &&
          ['INTERRUPTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(
            run.status
          )
        ) {
          await this.recordLocalInterruption(
            run,
            `Turn ${providerTurnId} did not emit a terminal event after interruption; stopped the local runtime.`
          );
          await this.supervisor.terminateUnresponsive(
            `Turn ${providerTurnId} did not emit a terminal event after interruption.`
          );
        }
      });
    }, this.interruptCompletionTimeoutMs);
    timer.unref();
    this.interruptTimers.set(providerTurnId, timer);
  }

  private scheduleRestart(): void {
    if (
      this.shuttingDown ||
      this.restartTimer ||
      this.restartWork ||
      this.restartAttempt >= this.restartDelaysMs.length
    ) {
      return;
    }
    const delay = this.restartDelaysMs[this.restartAttempt++];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.shuttingDown) return;
      let retry = false;
      const work = this.ensureClient()
        .then(() => this.shuttingDown ? undefined : this.refreshPreflight(true))
        .then(() => this.shuttingDown ? undefined : this.reconcile())
        .then(() => {
          if (!this.shuttingDown) this.restartAttempt = 0;
        })
        .catch(() => {
          retry = true;
        });
      this.restartWork = work;
      void work.then(() => {
        if (this.restartWork === work) this.restartWork = undefined;
        if (retry && !this.shuttingDown) this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref();
  }

  private attachSupervisorExitListener(): void {
    if (this.supervisorExitListenerAttached) return;
    this.supervisor.events.on('exit', this.handleSupervisorExit);
    this.supervisorExitListenerAttached = true;
  }

  private detachSupervisorExitListener(): void {
    if (!this.supervisorExitListenerAttached) return;
    this.supervisor.events.off('exit', this.handleSupervisorExit);
    this.supervisorExitListenerAttached = false;
  }

  private async completeShutdown(): Promise<void> {
    await Promise.all([
      this.runtimeLossWork ?? Promise.resolve(),
      this.restartWork ?? Promise.resolve()
    ]);
    await this.supervisor.shutdown();
    this.boundClient = undefined;
    this.restartAttempt = 0;
  }

  private async recordReconciliation(
    run: RunRecord,
    status: RunRecord['status'],
    recoveryState: RunRecord['recoveryState'],
    terminal: boolean
  ): Promise<void> {
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUNTIME_RECONCILED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: this.supervisor.currentServer?.id,
        source: 'provider',
        payload: { status, recoveryState, terminal }
      })
    );
  }

  private async syncGoalIfNeeded(
    sessionId: string,
    authoritativeGoal: string
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    if (!session.providerSessionId || !session.materialized) {
      return;
    }
    await this.syncGoal({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      authoritativeGoal,
      force: false
    });
  }

  private async recordGoalSnapshot(input: {
    session: AgentSessionRecord;
    authoritativeGoal: string;
    goal: ThreadGoal;
    source: 'TASK_MONKI_SYNC' | 'PROVIDER_NOTIFICATION';
    rawMessage?: AgentProtocolMessageReference;
  }): Promise<AgentGoalSnapshotRecord> {
    const taskGoalHash = hashGoal(input.authoritativeGoal);
    const latest = await this.store.getLatestAgentGoalSnapshot(input.session.id);
    const providerGoalHash = hashGoal(input.goal.objective);
    return this.store.recordAgentGoalSnapshot({
      taskId: input.session.taskId,
      iterationId: input.session.iterationId,
      sessionId: input.session.id,
      provider: input.session.provider,
      taskGoalHash,
      lastSynchronizedTaskGoalHash:
        input.source === 'TASK_MONKI_SYNC' || providerGoalHash === taskGoalHash
          ? taskGoalHash
          : latest?.lastSynchronizedTaskGoalHash,
      ...mapGoalFields(input.goal),
      syncState: providerGoalHash === taskGoalHash ? 'IN_SYNC' : 'DIVERGED',
      source: input.source,
      rawMessage: input.rawMessage
    });
  }

  private async recordSettingsObservation(
    session: AgentSessionRecord,
    source:
      | 'THREAD_START_RESPONSE'
      | 'THREAD_RESUME_RESPONSE'
      | 'THREAD_FORK_RESPONSE'
      | 'THREAD_SETTINGS_NOTIFICATION'
      | 'MODEL_REROUTED_NOTIFICATION'
      | 'RECOVERY_RESUME_RESPONSE',
    settings: AgentExecutionSettings,
    runId?: string,
    rawMessage?: AgentProtocolMessageReference,
    detail?: string
  ): Promise<void> {
    await this.store.recordAgentSettingsObservation({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runId,
      provider: session.provider,
      source,
      settings,
      detail,
      rawMessage
    });
  }

  private emitRunActivity(run: RunRecord, payload: Record<string, unknown>): void {
    this.appEvents.emit({
      type: 'run.activity',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload,
      at: new Date().toISOString()
    });
  }

  private emitGoalUpdate(goal: AgentGoalSnapshotRecord): void {
    this.appEvents.emit({
      type: 'agent.goal.updated',
      taskId: goal.taskId,
      iterationId: goal.iterationId,
      payload: goal,
      at: new Date().toISOString()
    });
  }

  private async requireSession(sessionId: string): Promise<AgentSessionRecord> {
    const session = await this.store.getAgentSession(sessionId);
    if (!session) {
      throw new Error(`Agent session not found: ${sessionId}`);
    }
    return session;
  }

  private emitProviderUpdate(): void {
    this.appEvents.emit({
      type: 'provider.updated',
      taskId: 'provider:codex',
      payload: this.getProviderState(),
      at: new Date().toISOString()
    });
  }

  private async rejectUnregisteredDynamicTool(
    interaction: InteractionRequestRecord
  ): Promise<void> {
    const decision: AgentInteractionDecision = {
      interactionType: 'DYNAMIC_TOOL',
      action: 'REJECT_UNREGISTERED'
    };
    const responding = await this.store.transitionInteractionRequest(
      interaction.id,
      'PENDING',
      {
        status: 'RESPONDING',
        decision,
        respondedAt: new Date().toISOString()
      }
    );
    this.emitInteractionUpdate(responding);
    try {
      await this.respondToInteraction({ interaction: responding, decision });
    } catch (error) {
      const latest = await this.store.getInteractionRequest(interaction.id);
      if (latest?.status === 'RESPONDING') {
        const stale = await this.store.transitionInteractionRequest(
          latest.id,
          'RESPONDING',
          {
            status: 'STALE',
            resolution: {
              error: error instanceof Error ? error.message : String(error)
            },
            resolvedAt: new Date().toISOString()
          }
        );
        this.emitInteractionUpdate(stale);
      }
      throw error;
    }
  }

  private emitInteractionUpdate(interaction: InteractionRequestRecord): void {
    this.appEvents.emit({
      type: 'interaction.updated',
      taskId: interaction.taskId,
      iterationId: interaction.iterationId,
      runId: interaction.runId,
      payload: interaction,
      at: new Date().toISOString()
    });
  }
}

function toApprovalPolicy(
  settings: AgentExecutionSettings
): 'on-request' | 'never' {
  return settings.approvalPolicy === 'never' ? 'never' : 'on-request';
}

function toApprovalsReviewer(settings: AgentExecutionSettings): ApprovalsReviewer {
  return settings.approvalsReviewer === 'auto_review' ||
    settings.approvalsReviewer === 'guardian_subagent'
    ? settings.approvalsReviewer
    : 'user';
}

function toReviewTarget(target: AgentReviewTarget): ReviewTarget {
  switch (target.type) {
    case 'UNCOMMITTED_CHANGES':
      return { type: 'uncommittedChanges' };
    case 'BASE_BRANCH':
      return { type: 'baseBranch', branch: target.branch };
    case 'COMMIT':
      return {
        type: 'commit',
        sha: target.sha,
        title: target.title ?? null
      };
    case 'CUSTOM':
      return { type: 'custom', instructions: target.instructions };
  }
}

function mapMutationError(operation: string, error: unknown): Error {
  if (error instanceof CodexAmbiguousMutationError) {
    return new AgentMutationAmbiguousError(error.method || operation, error.message);
  }
  const mapped = error instanceof Error ? error : new Error(String(error));
  if (/\bthread not found:/i.test(mapped.message)) {
    return new AgentProviderSessionMissingError(operation, mapped.message);
  }
  return mapped;
}

function activeTurnIdFromInterruptMismatch(error: Error): string | undefined {
  const match = error.message.match(
    /expected active turn id\s+\S+\s+but found\s+([A-Za-z0-9_-]+)/i
  );
  return match?.[1];
}

function hashGoal(goal: string): string {
  return createHash('sha256').update(goal.trim()).digest('hex');
}

function withProviderItemContext(
  type: InteractionRequestRecord['type'],
  request: AgentInteractionRequestPayload,
  itemPayload: unknown
): AgentInteractionRequestPayload {
  if (
    type !== 'FILE_CHANGE_APPROVAL' ||
    typeof itemPayload !== 'object' ||
    itemPayload === null ||
    !('changes' in itemPayload) ||
    !Array.isArray(itemPayload.changes)
  ) {
    return request;
  }
  return {
    ...request,
    changes: itemPayload.changes
      .filter(
        (change): change is { path: string; kind: string; diff: string } =>
          typeof change === 'object' &&
          change !== null &&
          'path' in change &&
          typeof change.path === 'string' &&
          'kind' in change &&
          typeof change.kind === 'string' &&
          'diff' in change &&
          typeof change.diff === 'string'
      )
      .map((change) => ({ ...change }))
  };
}

function getSubagentThreadMetadata(thread: Thread): {
  isSpawnedSubagent: boolean;
  parentThreadId?: string;
  nickname?: string;
  role?: string;
  agentPath?: string;
} {
  const source = thread.source;
  if (
    typeof source !== 'object' ||
    source === null ||
    !('subAgent' in source)
  ) {
    return { isSpawnedSubagent: false };
  }
  const subagent = source.subAgent;
  if (
    typeof subagent !== 'object' ||
    subagent === null ||
    !('thread_spawn' in subagent)
  ) {
    return { isSpawnedSubagent: false };
  }
  const spawn = subagent.thread_spawn;
  return {
    isSpawnedSubagent: true,
    parentThreadId: spawn.parent_thread_id,
    nickname: spawn.agent_nickname ?? undefined,
    role: spawn.agent_role ?? undefined,
    agentPath:
      typeof spawn.agent_path === 'string' ? spawn.agent_path : undefined
  };
}

function mapCollabAgentStatus(status: CollabAgentStatus): AgentSubagentStatus {
  switch (status) {
    case 'pendingInit':
      return 'PENDING_INIT';
    case 'running':
      return 'RUNNING';
    case 'interrupted':
      return 'INTERRUPTED';
    case 'completed':
      return 'COMPLETED';
    case 'errored':
      return 'ERRORED';
    case 'shutdown':
      return 'SHUTDOWN';
    case 'notFound':
      return 'NOT_FOUND';
  }
}

function mapSubagentActivityStatus(
  kind: SubAgentActivityKind
): AgentSubagentStatus {
  switch (kind) {
    case 'started':
    case 'interacted':
      return 'RUNNING';
    case 'interrupted':
      return 'INTERRUPTED';
  }
}

function mapSubagentTurnStatus(status: TurnStatus): AgentSubagentStatus {
  switch (status) {
    case 'inProgress':
      return 'RUNNING';
    case 'completed':
      return 'COMPLETED';
    case 'interrupted':
      return 'INTERRUPTED';
    case 'failed':
      return 'ERRORED';
  }
}

function mapThreadToSubagentStatus(
  status: ThreadStatus
): AgentSubagentStatus | undefined {
  switch (status.type) {
    case 'active':
      return 'RUNNING';
    case 'systemError':
      return 'ERRORED';
    case 'idle':
    case 'notLoaded':
      return undefined;
  }
}
