import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AgentExecutionSettings,
  AgentInteractionRequestPayload,
  AgentInteractionDecision,
  AgentPermissionApprovalRequest,
  AgentItemStatus,
  AgentModel,
  AgentPreflight,
  AgentRuntimeDiagnostic,
  AgentRuntimeCapabilities,
  AgentGoalSnapshotRecord,
  AgentReviewTarget,
  AgentSessionRecord,
  AgentSessionSnapshot,
  AgentSubagentStatus,
  InteractionRequestRecord,
  RunRecord
} from '../../../shared/contracts';
import type { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import {
  ArtifactAppendAmbiguousError,
  type FileTaskStore
} from '../../storage/FileTaskStore';
import type {
  AgentInteractionResponse,
  AgentRuntimeAdapter,
  AgentReconciliationResult,
  AgentSessionRef,
  AgentTurn,
  CreateAgentSession,
  ForkAgentSession,
  InterruptAgentTurn,
  StartAgentReview,
  StartAgentTurn,
  SyncAgentGoal,
  SteerAgentTurn,
  ResolveAgentExecution,
  ResolvedAgentExecution,
  RefineAgentPrompt
} from '../AgentRuntimeAdapter';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError
} from '../AgentRuntimeAdapter';
import {
  appendRuntimeDiagnostic,
  createRuntimeReadiness,
  errorDiagnostic,
  warningDiagnostic
} from '../AgentRuntimeReadiness';
import { assertBrowserDevSettingsSafe } from '../BrowserDevAgentBoundary';
import {
  assertAttachmentSandboxSupportsDelivery,
  assertModelSupportsAttachments,
  prepareAgentAttachmentDelivery,
  toAgentTurnAttachments,
  verifyAgentTurnAttachments,
  type AgentTurnAttachment
} from '../AgentAttachmentDelivery';
import { redactExternalPermissionPaths } from '../AgentPermissionRedaction';
import {
  REDACTED_CREDENTIAL,
  redactCredentialText,
  redactCredentialValue
} from '../AgentCredentialRedaction';
import { CODEX_RUNTIME_DESCRIPTOR, codexCapabilities } from './codexCapabilities';
import {
  assertCodexActivePermissionProfile,
  assertCodexPermissionProfileEvidence,
  codexPermissionProfileConfig,
  type CodexPermissionProfileEvidence
} from './CodexPermissionProfile';
import {
  CodexAppServerSupervisor,
  codexSensitiveEnvironmentValues,
  type CodexAppServerSupervisorOptions
} from './CodexAppServerSupervisor';
import { CodexRuntimeResolutionError } from './CodexRuntimeResolver';
import {
  CodexAmbiguousMutationError,
  CodexRpcError,
  type CodexRpcClient
} from './CodexRpcClient';
import type {
  AgentProtocolMessageReference,
  CodexExternalToolSettings
} from '../../../shared/agent';
import type { UnsupportedCodexServerRequest } from './protocol/CodexProtocolCodec';
import {
  assertCodexAttachmentExternalToolsDisabled,
  normalizeCodexExternalToolSettings
} from './CodexToolConfig';
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
import { PromptRefinementService } from '../../prompt/PromptRefinementService';
const ACTIVE_RUN_STATES: RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
];

const SUBMITTED_RUN_STATES: RunRecord['status'][] = [
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
];

function isTerminalRunStatus(status: RunRecord['status']): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(status);
}

const RUNTIME_CONFIG_PENDING_RESTART_WARNING =
  'Codex executable or tool settings changed and will apply after active runs finish or the app restarts.';
const STREAM_OUTPUT_FLUSH_MS = 75;
const STREAM_OUTPUT_FLUSH_BYTES = 64 * 1024;
const STREAM_OUTPUT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const STREAM_OUTPUT_MAX_FAILURES = 2;

interface CodexRunOutputBuffer {
  groups: Array<{ source: string; chunks: string[] }>;
  byteCount: number;
  credentialCarry?: { source: string; text: string };
  failureCount: number;
  timer?: NodeJS.Timeout;
  flushing?: Promise<void>;
}

class BrowserDevBoundaryViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserDevBoundaryViolationError';
  }
}

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

export interface CodexAppServerAdapterOptions
  extends Omit<CodexAppServerSupervisorOptions, 'appVersion'> {
  appVersion?: string;
  restartDelaysMs?: number[];
  interruptRequestTimeoutMs?: number;
  interruptCompletionTimeoutMs?: number;
  enforceBrowserDevBoundary?: boolean;
}

interface UnmaterializedThreadAttestation {
  providerSessionId: string;
  serverInstanceId: string;
  profileFingerprint: string;
  inboundFailureGeneration: number;
}

interface InboundNotificationRecoveryTarget {
  threadId?: string;
  providerTurnId?: string;
}

export class CodexAppServerAdapter implements AgentRuntimeAdapter {
  readonly descriptor = CODEX_RUNTIME_DESCRIPTOR;
  private supervisor: CodexAppServerSupervisor;
  private readonly supervisorOptions: CodexAppServerSupervisorOptions;
  private readonly restartDelaysMs: number[];
  private boundClient?: CodexRpcClient;
  private models: AgentModel[] = [];
  private preflightState: AgentPreflight = {
    runtime: CODEX_RUNTIME_DESCRIPTOR,
    readiness: createRuntimeReadiness(
      'INITIALIZING',
      'Codex App Server has not been initialized.',
      {
        checks: { initialization: 'NOT_STARTED' }
      }
    ),
    capabilities: codexCapabilities(),
  };
  private restartAttempt = 0;
  private restartTimer?: NodeJS.Timeout;
  private inboundQueue: Promise<void> = Promise.resolve();
  private exitedGenerationDrain?: Promise<void>;
  private inboundMaterializationFailureGeneration = 0;
  private activeInboundRecoveryTarget?: InboundNotificationRecoveryTarget;
  private readonly interruptRequestTimeoutMs: number;
  private readonly interruptCompletionTimeoutMs: number;
  private readonly enforceBrowserDevBoundary: boolean;
  private readonly sensitiveValues: string[];
  private externalToolSettings: CodexExternalToolSettings;
  private promptRefinementExecutable?: string;
  private readonly promptRefiner = new PromptRefinementService();
  private readonly interruptTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamBuffers = new Map<string, CodexRunOutputBuffer>();
  private readonly runSettlementQueues = new Map<string, Promise<unknown>>();
  private readonly runSettlementContext = new AsyncLocalStorage<string>();
  private readonly runReconciliationBarriers = new Map<string, Promise<void>>();
  private readonly unmaterializedThreadAttestations = new Map<
    string,
    UnmaterializedThreadAttestation
  >();
  private initialized = false;
  private shuttingDown = false;
  private runtimeConfigRestartPending = false;
  private securityBoundaryViolation?: string;
  private inboundMaterializationRecoveryFailure?: string;
  private outputPersistenceFence?: Promise<void>;

  constructor(
    private readonly store: FileTaskStore,
    private readonly appEvents: AppEventBus,
    options: CodexAppServerAdapterOptions
  ) {
    const {
      restartDelaysMs,
      interruptRequestTimeoutMs,
      interruptCompletionTimeoutMs,
      enforceBrowserDevBoundary,
      appVersion,
      ...supervisorOptions
    } = options;
    this.restartDelaysMs = restartDelaysMs ?? [500, 1_000, 2_000];
    this.interruptRequestTimeoutMs = interruptRequestTimeoutMs ?? 5_000;
    this.interruptCompletionTimeoutMs = interruptCompletionTimeoutMs ?? 15_000;
    this.enforceBrowserDevBoundary = enforceBrowserDevBoundary === true;
    this.sensitiveValues = codexSensitiveEnvironmentValues(
      options.environment ?? process.env
    );
    this.externalToolSettings = normalizeCodexExternalToolSettings(options.toolSettings);
    this.promptRefinementExecutable = options.executable;
    this.supervisorOptions = {
      ...supervisorOptions,
      appVersion: appVersion ?? '0.1.0'
    };
    this.supervisor = this.createSupervisor();
  }

  private createSupervisor(): CodexAppServerSupervisor {
    const supervisor = new CodexAppServerSupervisor(this.store, {
      ...this.supervisorOptions,
      toolSettings: this.supervisorOptions.toolSettings
        ? { ...this.supervisorOptions.toolSettings }
        : undefined
    });
    supervisor.events.on('exit', (server, unexpected, processTreeExited) => {
      if (unexpected) {
        // Stdout messages are parsed before the child close event, but their
        // durable materialization is intentionally serialized through
        // `inboundQueue`. Put runtime-loss handling on the same queue so a
        // just-received approval cannot be persisted as PENDING after the
        // server-loss sweep has already completed.
        this.enqueueInbound(async () => {
          try {
            await this.handleRuntimeLoss(server.id, {
              reason: server.exitReason,
              confirmedStopped: processTreeExited
            });
          } finally {
            this.scheduleRestart();
          }
        });
        // The RPC drain ends when these listeners accept a message. Preserve
        // this generation's adapter tail so replacement binding cannot make
        // an already-journaled callback look stale before it materializes.
        const drain = this.inboundQueue;
        this.exitedGenerationDrain = drain;
        void drain.then(
          () => {
            if (this.exitedGenerationDrain === drain) {
              this.exitedGenerationDrain = undefined;
            }
          },
          () => undefined
        );
      }
    });
    return supervisor;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      if (this.shuttingDown) {
        throw new Error(
          'Codex App Server cannot restart because its previous shutdown was not confirmed.'
        );
      }
      return;
    }
    this.shuttingDown = false;
    this.initialized = true;
    await this.recoverPersistedRuntimeLosses();
    await this.ensureClient();
    await this.refreshPreflight();
    await this.reconcileRuns(true);
  }

  async preflight(): Promise<AgentPreflight> {
    if (this.securityBoundaryViolation || this.inboundMaterializationRecoveryFailure) {
      return structuredClone(this.preflightState);
    }
    try {
      await this.ensureClient();
      await this.refreshPreflight();
    } catch (error) {
      this.preflightState = {
        runtime: CODEX_RUNTIME_DESCRIPTOR,
        readiness: codexFailureReadiness(error),
        capabilities: codexCapabilities(),
      };
    }
    return structuredClone(this.preflightState);
  }

  capabilities(): Promise<AgentRuntimeCapabilities> {
    return Promise.resolve(codexCapabilities());
  }

  async listModels(): Promise<AgentModel[]> {
    await this.ensureClient();
    if (this.models.length === 0) {
      await this.refreshModels();
    }
    return structuredClone(this.models);
  }

  async resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution> {
    const requestedModel = input.settings.model;
    const explicitModel = Boolean(requestedModel && requestedModel !== 'default');
    let models = await this.listModels();
    let model = explicitModel
      ? models.find((candidate) => candidate.id === requestedModel) ??
        models.find((candidate) => candidate.model === requestedModel)
      : models.find((candidate) => candidate.isDefault);
    if (explicitModel && !model) {
      await this.refreshModels();
      models = structuredClone(this.models);
      model =
        models.find((candidate) => candidate.id === requestedModel) ??
        models.find((candidate) => candidate.model === requestedModel);
    }
    if (!model) {
      throw new Error(
        explicitModel
          ? `Codex did not report requested model ${requestedModel}.`
          : 'Codex did not report a default model.'
      );
    }
    // `model/list` does not report the Codex model-provider dimension. Keep an
    // explicit provider selected by an existing task/session instead of
    // incorrectly reclassifying every Codex model as the catalog fallback.
    const modelProvider =
      input.settings.modelProvider && input.settings.modelProvider !== 'codex'
        ? input.settings.modelProvider
        : model.modelProvider;
    const resolvedModel =
      modelProvider === model.modelProvider
        ? model
        : {
            ...model,
            id: `${this.descriptor.id}:${modelProvider}/${model.model}`,
            modelProvider
          };
    assertModelSupportsAttachments(model, input.attachments);
    const effort = input.settings.reasoningEffort ?? model.defaultReasoningEffort;
    if (effort && !model.supportedReasoningEfforts.includes(effort)) {
      throw new Error(`Reasoning effort ${effort} is not supported by ${model.displayName}.`);
    }
    const settings: AgentExecutionSettings = {
      ...input.settings,
      runtimeId: this.descriptor.id,
      model: model.model,
      modelProvider,
      reasoningEffort: effort,
      serviceTier: input.settings.serviceTier ?? model.defaultServiceTier
    };
    assertAttachmentSandboxSupportsDelivery(settings, input.attachments);
    return { settings, model: resolvedModel };
  }

  refinePrompt(input: RefineAgentPrompt) {
    return this.promptRefiner.refine(
      input.repositoryPath,
      input.input,
      input.settings.model,
      this.promptRefinementExecutable,
      this.externalToolSettings,
      this.enforceBrowserDevBoundary
    );
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    const session = await this.requireSession(input.localSessionId);
    if (session.providerSessionId) {
      if (
        !session.materialized ||
        this.unmaterializedThreadAttestations.has(session.id)
      ) {
        return (
          await this.prepareUnmaterializedThreadForTurn(
            session,
            input.settings,
            input.attachments ?? []
          )
        ).session;
      }
      return this.attachSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
    }

    return this.startUnmaterializedProviderThread(
      session,
      input.settings,
      input.attachments ?? []
    );
  }

  private async startUnmaterializedProviderThread(
    session: AgentSessionRecord,
    settings: AgentExecutionSettings,
    attachments: readonly AgentTurnAttachment[]
  ): Promise<AgentSessionRecord> {
    assertAttachmentSandboxSupportsDelivery(settings, attachments);
    assertCodexAttachmentExternalToolsDisabled(
      this.externalToolSettings,
      attachments.length > 0
    );

    const client = await this.ensureClient();
    const server = this.supervisor.currentServer;
    if (!server || client.serverInstanceId !== server.id) {
      throw new Error('Codex App Server changed while starting an empty thread.');
    }
    const attachmentPaths = attachments
      .map((attachment) => attachment.path)
      .sort((left, right) => left.localeCompare(right));
    const config = codexPermissionProfileConfig({
      sessionId: session.id,
      settings,
      worktreePath: session.worktreePath,
      attachmentPaths
    });
    const inboundFailureGeneration =
      this.inboundMaterializationFailureGeneration;
    let response;
    try {
      response = await client.requestMutation('thread/start', {
        model: settings.model ?? null,
        modelProvider: settings.modelProvider ?? null,
        serviceTier: settings.serviceTier ?? null,
        cwd: session.worktreePath,
        approvalPolicy: toApprovalPolicy(settings),
        approvalsReviewer: toApprovalsReviewer(settings),
        config,
        ephemeral: false
      });
    } catch (error) {
      throw mapMutationError('thread/start', error);
    }
    await this.assertProviderPermissionProfileOrFence({
      sessionId: session.id,
      worktreePath: session.worktreePath,
      operation: 'thread/start',
      providerReference: response.thread.id,
      response
    });
    const observedSettings = await this.prepareObservedSettings(
      settingsFromThreadResponse(response),
      'Created session observed settings'
    );

    try {
      const stored = await this.store.updateAgentSession(session.id, {
        providerSessionId: response.thread.id,
        providerSessionTreeId: response.thread.sessionId,
        status: mapThreadStatus(response.thread.status),
        materialized: false,
        requestedSettings: settings,
        observedSettings,
        lastAttachedAt: new Date().toISOString()
      });
      await this.recordSettingsObservation(
        stored,
        'THREAD_START_RESPONSE',
        observedSettings
      );
      this.unmaterializedThreadAttestations.set(session.id, {
        providerSessionId: response.thread.id,
        serverInstanceId: server.id,
        profileFingerprint: threadStartProfileFingerprint(settings, config),
        inboundFailureGeneration
      });
      return stored;
    } catch {
      throw postAcknowledgementPersistenceError('thread/start', response.thread.id);
    }
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    const session = await this.requireSession(ref.localSessionId);
    const providerSessionId = ref.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId) {
      throw new Error(`Agent session ${session.id} has not been materialized.`);
    }
    if (
      !session.materialized ||
      this.unmaterializedThreadAttestations.has(session.id)
    ) {
      throw new Error(
        `Agent session ${session.id} has no resumable rollout until its first turn is durably acknowledged.`
      );
    }

    const response = await this.resumeSessionWithProfile(
      session,
      providerSessionId,
      session.requestedSettings,
      []
    );
    const observedSettings = await this.prepareObservedSettings(
      settingsFromThreadResponse(response),
      'Resumed session observed settings'
    );

    const stored = await this.store.updateAgentSession(session.id, {
      providerSessionId: response.thread.id,
      providerSessionTreeId: response.thread.sessionId,
      status: mapThreadStatus(response.thread.status),
      materialized: true,
      observedSettings,
      lastAttachedAt: new Date().toISOString()
    });
    this.unmaterializedThreadAttestations.delete(session.id);
    await this.recordSettingsObservation(
      stored,
      'THREAD_RESUME_RESPONSE',
      observedSettings
    );
    return stored;
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot> {
    const session = await this.requireSession(ref.localSessionId);
    const providerSessionId = ref.providerSessionId ?? session.providerSessionId;
    const snapshot = await this.store.snapshot();
    const runs = snapshot.runs
      .filter((run) => run.sessionId === session.id)
      .map((run) => ({
        id: run.id,
        providerTurnId: run.providerTurnId,
        status: run.status
      }));
    if (
      !providerSessionId ||
      !session.materialized ||
      this.unmaterializedThreadAttestations.has(session.id)
    ) {
      return { session, runs };
    }
    const client = await this.ensureClient();
    const response = await client.request('thread/read', {
      threadId: providerSessionId,
      includeTurns: true
    });
    // `materialized` is also the durable no-resend fence for a possibly
    // submitted first turn. A temporarily empty provider read must never
    // downgrade that local safety fact.
    const materialized = session.materialized || response.thread.turns.length > 0;
    const stored = await this.store.updateAgentSession(session.id, {
      status: mapThreadStatus(response.thread.status),
      materialized
    });
    if (materialized) {
      this.unmaterializedThreadAttestations.delete(session.id);
    }
    return {
      session: stored,
      runs
    };
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    const attachments = input.attachments ?? [];
    let session = await this.requireSession(input.session.localSessionId);
    const settings = input.settings ?? session.requestedSettings;
    assertAttachmentSandboxSupportsDelivery(settings, attachments);
    assertCodexAttachmentExternalToolsDisabled(this.externalToolSettings, attachments.length > 0);
    if (attachments.length > 0) {
      const selectedModel =
        this.models.find((candidate) => candidate.model === settings.model) ??
        this.models.find((candidate) => candidate.id === settings.model) ??
        this.models.find((candidate) => candidate.isDefault);
      if (!selectedModel) {
        throw new Error('Codex did not report an available model for attachment delivery.');
      }
      assertModelSupportsAttachments(selectedModel, attachments);
    }
    const verifiedAttachments = await verifyAgentTurnAttachments(attachments);
    if (!session.providerSessionId) {
      session = await this.createSession({
        runtimeId: this.descriptor.id,
        localSessionId: session.id,
        taskId: session.taskId,
        iterationId: session.iterationId,
        worktreeId: session.worktreeId,
        worktreePath: session.worktreePath,
        settings,
        attachments: verifiedAttachments
      });
    }

    const attachmentDelivery = prepareAgentAttachmentDelivery({
      prompt: input.prompt,
      attachments: verifiedAttachments,
      includeLocalImages: !session.materialized
    });
    const requiresFirstTurnFence = !session.materialized;
    let client: CodexRpcClient;
    let serverInstanceId: string;
    let providerThreadId: string;
    let firstTurnProfileFingerprint: string | undefined;
    let firstTurnInboundFailureGeneration: number | undefined;
    if (session.materialized) {
      client = await this.ensureClient();
      const server = this.supervisor.currentServer;
      if (!server || client.serverInstanceId !== server.id || !session.providerSessionId) {
        throw new Error('Codex App Server is not ready to resume a turn.');
      }
      const profileResponse = await this.resumeSessionWithProfile(
        session,
        session.providerSessionId,
        settings,
        verifiedAttachments.map((attachment) => attachment.path)
      );
      if (this.boundClient !== client || this.supervisor.currentServer?.id !== server.id) {
        throw new Error(
          'Codex App Server changed after attesting the resumed thread; retry the turn on the current server.'
        );
      }
      const observedSettings = await this.prepareObservedSettings(
        settingsFromThreadResponse(profileResponse),
        'Turn permission profile observed settings'
      );
      session = await this.store.updateAgentSession(session.id, {
        requestedSettings: settings,
        observedSettings,
        lastAttachedAt: new Date().toISOString()
      });
      await this.recordSettingsObservation(
        session,
        'THREAD_RESUME_RESPONSE',
        observedSettings,
        input.localRunId
      );
      providerThreadId = profileResponse.thread.id;
      serverInstanceId = server.id;
    } else {
      const prepared = await this.prepareUnmaterializedThreadForTurn(
        session,
        settings,
        verifiedAttachments
      );
      session = prepared.session;
      client = prepared.client;
      serverInstanceId = prepared.serverInstanceId;
      providerThreadId = prepared.providerSessionId;
      firstTurnProfileFingerprint = prepared.profileFingerprint;
      firstTurnInboundFailureGeneration = prepared.inboundFailureGeneration;
    }
    await this.store.updateRun(input.localRunId, {
      serverInstanceId,
      status: 'STARTING',
      lastEventAt: new Date().toISOString()
    });
    if (requiresFirstTurnFence) {
      // Persist the no-resend fence before provider input. If Task Monki loses
      // the `turn/start` acknowledgement, this session must resume/reconcile
      // the possible rollout; it must never be mistaken for a replaceable
      // empty thread after restart or explicit recovery resolution.
      session = await this.store.updateAgentSession(session.id, { materialized: true });

      // Store writes above yield to already parsed App Server notifications.
      // Drain them before the mutation boundary, then synchronously prove that
      // the empty thread is still owned by the same live process and carries
      // the exact permission profile that was attested at thread/start.
      await this.drainInbound();
      const currentAttestation = this.unmaterializedThreadAttestations.get(
        session.id
      );
      const boundaryFailure = this.securityBoundaryViolation
        ? this.securityBoundaryViolation
        : this.boundClient !== client ||
            this.supervisor.currentServer?.id !== serverInstanceId ||
            currentAttestation?.providerSessionId !== providerThreadId ||
            currentAttestation?.serverInstanceId !== serverInstanceId ||
            currentAttestation?.profileFingerprint !== firstTurnProfileFingerprint ||
            currentAttestation?.inboundFailureGeneration !==
              firstTurnInboundFailureGeneration ||
            this.inboundMaterializationFailureGeneration !==
              firstTurnInboundFailureGeneration
          ? 'Codex App Server or its permission attestation changed before the first turn was submitted.'
          : undefined;
      if (boundaryFailure) {
        const restored = await this.restoreEmptyThreadAfterFirstTurnDidNotStart({
          localRunId: input.localRunId,
          localSessionId: session.id,
          providerSessionId: providerThreadId,
          expectedInboundFailureGeneration: firstTurnInboundFailureGeneration
        });
        if (!restored) {
          this.unmaterializedThreadAttestations.delete(session.id);
          throw new AgentMutationAmbiguousError(
            'turn/start',
            `${boundaryFailure} Task Monki could not prove that the provider has no turn evidence, so the no-resend fence remains in place.`
          );
        }
        this.unmaterializedThreadAttestations.delete(session.id);
        throw new Error(boundaryFailure);
      }
    }
    let response;
    try {
      response = await client.requestMutation('turn/start', {
        threadId: providerThreadId,
        clientUserMessageId: input.localRunId,
        input: [
          { type: 'text', text: attachmentDelivery.prompt, text_elements: [] },
          ...attachmentDelivery.localImagePaths.map((imagePath) => ({
            type: 'localImage' as const,
            path: imagePath
          }))
        ],
        cwd: session.worktreePath,
        approvalPolicy: toApprovalPolicy(settings),
        approvalsReviewer: toApprovalsReviewer(settings),
        model: settings.model ?? null,
        serviceTier: settings.serviceTier ?? null,
        effort: settings.reasoningEffort ?? null,
        summary: 'auto',
        personality: null,
        outputSchema: null
      });
    } catch (error) {
      const mapped = mapMutationError('turn/start', error);
      if (requiresFirstTurnFence && error instanceof CodexRpcError) {
        const restored = await this.restoreEmptyThreadAfterFirstTurnDidNotStart({
          localRunId: input.localRunId,
          localSessionId: session.id,
          providerSessionId: providerThreadId,
          expectedInboundFailureGeneration: firstTurnInboundFailureGeneration
        });
        if (!restored) {
          this.unmaterializedThreadAttestations.delete(session.id);
          throw new AgentMutationAmbiguousError(
            'turn/start',
            `Codex returned a definitive turn/start error, but Task Monki observed or could not exclude provider turn evidence. The no-resend fence remains in place. Provider error: ${mapped.message}`
          );
        }
        if (mapped instanceof AgentProviderSessionMissingError) {
          this.unmaterializedThreadAttestations.delete(session.id);
        }
      } else if (requiresFirstTurnFence) {
        // A timeout, transport loss, or other non-response cannot prove that
        // the provider rejected the prompt. Retain the durable materialized
        // fence and stop treating the thread as a reusable empty allocation.
        this.unmaterializedThreadAttestations.delete(session.id);
      }
      throw mapped;
    }

    try {
      await this.store.updateRun(input.localRunId, {
        providerTurnId: response.turn.id,
        serverInstanceId,
        status: 'RUNNING',
        ...(attachmentDelivery.submissionCandidates.length > 0
          ? {
              attachmentSubmissions: attachmentDelivery.submissionCandidates.map(
                (submission) => ({
                  ...submission,
                  providerTurnId: response.turn.id,
                  submittedAt: new Date().toISOString()
                })
              )
            }
          : {}),
        lastEventAt: new Date().toISOString()
      });
      await this.store.updateAgentSession(session.id, {
        status: 'ACTIVE',
        materialized: true,
        requestedSettings: settings,
        lastAttachedAt: new Date().toISOString()
      });
      this.unmaterializedThreadAttestations.delete(session.id);
    } catch (persistenceError) {
      const fenceReason =
        `Codex acknowledged turn/start (${response.turn.id}), but Task Monki could not persist the acknowledgement.`;
      // Preserve the provider correlation independently of richer run state
      // such as attachment submission evidence. This best-effort write lets a
      // replacement App Server reconcile the acknowledged turn without ever
      // resending its prompt.
      await this.store
        .updateRun(input.localRunId, {
          providerTurnId: response.turn.id,
          serverInstanceId,
          lastEventAt: new Date().toISOString()
        })
        .catch(() => undefined);
      try {
        await this.supervisor.terminateUnresponsive(fenceReason);
        await this.drainInbound();
        this.unmaterializedThreadAttestations.delete(session.id);
      } catch (terminationError) {
        const persistenceDetail =
          persistenceError instanceof Error
            ? persistenceError.message
            : String(persistenceError);
        const terminationDetail =
          terminationError instanceof Error
            ? terminationError.message
            : String(terminationError);
        throw new AgentMutationAmbiguousError(
          'turn/start',
          `${fenceReason} The App Server lifecycle is fenced because process termination could not be confirmed (${terminationDetail}). Persistence failure: ${persistenceDetail}`
        );
      }
      throw postAcknowledgementPersistenceError('turn/start', response.turn.id);
    }
    void this.syncGoalIfNeeded(session.id, input.authoritativeGoal).catch((error) => {
      this.preflightState = appendRuntimeDiagnostic(
        this.preflightState,
        warningDiagnostic(
          'GOAL_SYNC_FAILED',
          'HEALTH',
          'Goal synchronization failed.',
          error instanceof Error ? error.message : String(error)
        )
      );
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
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, input.providerTurnId);
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
      const run = await this.store.getRunByProviderTurnId(this.descriptor.id, providerTurnId);
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
        const run = await this.store.getRunByProviderTurnId(this.descriptor.id, input.providerTurnId);
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
        config: codexPermissionProfileConfig({
          sessionId: target.id,
          settings: input.settings,
          worktreePath: target.worktreePath
        }),
        ephemeral: false
      });
    } catch (error) {
      throw mapMutationError('thread/fork', error);
    }
    await this.assertProviderPermissionProfileOrFence({
      sessionId: target.id,
      worktreePath: target.worktreePath,
      operation: 'thread/fork',
      providerReference: response.thread.id,
      response
    });
    const observedSettings = await this.prepareObservedSettings(
      settingsFromThreadResponse(response),
      'Forked session observed settings'
    );
    try {
      const stored = await this.store.updateAgentSession(target.id, {
        providerSessionId: response.thread.id,
        providerSessionTreeId: response.thread.sessionId,
        status: mapThreadStatus(response.thread.status),
        materialized: true,
        requestedSettings: input.settings,
        observedSettings,
        lastAttachedAt: new Date().toISOString()
      });
      await this.recordSettingsObservation(
        stored,
        'THREAD_FORK_RESPONSE',
        observedSettings
      );
      return stored;
    } catch {
      throw postAcknowledgementPersistenceError('thread/fork', response.thread.id);
    }
  }

  async startReview(input: StartAgentReview): Promise<AgentTurn> {
    const attachments = input.attachments ?? [];
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
    assertAttachmentSandboxSupportsDelivery(settings, attachments);
    assertCodexAttachmentExternalToolsDisabled(this.externalToolSettings, attachments.length > 0);
    if (attachments.length > 0) {
      const selectedModel =
        this.models.find((candidate) => candidate.model === settings.model) ??
        this.models.find((candidate) => candidate.id === settings.model) ??
        this.models.find((candidate) => candidate.isDefault);
      if (!selectedModel) {
        throw new Error('Codex did not report an available model for attachment delivery.');
      }
      assertModelSupportsAttachments(selectedModel, attachments);
    }
    const attachmentDelivery = prepareAgentAttachmentDelivery({
      prompt: CODEX_REVIEW_DEVELOPER_INSTRUCTIONS,
      attachments: await verifyAgentTurnAttachments(attachments),
      includeLocalImages: false
    });
    let reviewBase;
    try {
      reviewBase = await client.requestMutation('thread/fork', {
        threadId: providerSessionId,
        model: settings.model ?? null,
        modelProvider: settings.modelProvider ?? null,
        serviceTier: settings.serviceTier ?? null,
        cwd: reviewSession.worktreePath,
        approvalPolicy: toApprovalPolicy(settings),
        approvalsReviewer: toApprovalsReviewer(settings),
        config: codexPermissionProfileConfig({
          sessionId: reviewSession.id,
          settings,
          worktreePath: reviewSession.worktreePath,
          attachmentPaths: attachmentDelivery.attachments.map(
            (attachment) => attachment.path
          )
        }),
        developerInstructions: attachmentDelivery.prompt,
        ephemeral: false
      });
    } catch (error) {
      throw mapMutationError('thread/fork', error);
    }
    await this.assertProviderPermissionProfileOrFence({
      sessionId: reviewSession.id,
      worktreePath: reviewSession.worktreePath,
      operation: 'thread/fork',
      providerReference: reviewBase.thread.id,
      response: reviewBase
    });
    const observedSettings = await this.prepareObservedSettings(
      settingsFromThreadResponse(reviewBase),
      'Review fork observed settings'
    );
    let storedReviewBase: AgentSessionRecord;
    try {
      storedReviewBase = await this.store.updateAgentSession(reviewSession.id, {
        providerSessionId: reviewBase.thread.id,
        providerSessionTreeId: reviewBase.thread.sessionId,
        status: mapThreadStatus(reviewBase.thread.status),
        materialized: true,
        requestedSettings: settings,
        observedSettings,
        lastAttachedAt: new Date().toISOString()
      });
      await this.recordSettingsObservation(
        storedReviewBase,
        'THREAD_FORK_RESPONSE',
        observedSettings
      );
    } catch {
      throw postAcknowledgementPersistenceError(
        'thread/fork',
        reviewBase.thread.id
      );
    }
    let response;
    try {
      response = await client.requestMutation('review/start', {
        threadId: reviewBase.thread.id,
        target: toReviewTarget(input.target),
        delivery: 'inline'
      });
    } catch (error) {
      throw mapMutationError('review/start', error);
    }
    try {
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
        ...(attachmentDelivery.submissionCandidates.length > 0
          ? {
              attachmentSubmissions: attachmentDelivery.submissionCandidates.map(
                (submission) => ({
                  ...submission,
                  providerTurnId: response.turn.id,
                  submittedAt: new Date().toISOString()
                })
              )
            }
          : {}),
        lastEventAt: new Date().toISOString()
      });
    } catch {
      throw postAcknowledgementPersistenceError('review/start', response.turn.id);
    }
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
        runtimeId: session.runtimeId,
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

    try {
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
    } catch (error) {
      throw mapMutationError('server-request/response', error);
    }
  }

  async reconcile(): Promise<AgentReconciliationResult> {
    return this.reconcileRuns(false);
  }

  private async reconcileRuns(
    includePersistedQueuedRuns: boolean,
    targetRunIds?: ReadonlySet<string>
  ): Promise<AgentReconciliationResult> {
    const runs = (
      await this.store.getRunsRequiringRecovery({
        includeQueued: includePersistedQueuedRuns,
        runtimeId: this.descriptor.id
      })
    ).filter((run) => !targetRunIds || targetRunIds.has(run.id));
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

      const finishReconciliation = this.beginRunReconciliation(run.id);
      try {
        const attachments = toAgentTurnAttachments(
          await this.store.verifyRunAttachments(run.id, run.taskId)
        );
        const response = await this.resumeSessionWithProfile(
          session,
          session.providerSessionId,
          session.requestedSettings,
          attachments.map((attachment) => attachment.path)
        );
        const observedSettings = await this.prepareObservedSettings(
          settingsFromThreadResponse(response),
          'Recovery resume observed settings'
        );
        await this.store.updateAgentSession(session.id, {
          status: mapThreadStatus(response.thread.status),
          materialized: true,
          observedSettings,
          lastAttachedAt: new Date().toISOString()
        });
        await this.recordSettingsObservation(
          session,
          'RECOVERY_RESUME_RESPONSE',
          observedSettings,
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
        let reconciledRun: RunRecord | undefined;
        if (terminal) {
          reconciledRun = await this.finalizeRecoveredTurn(run, providerTurn);
        } else if (!(await this.bindRunToServer(run, client.serverInstanceId))) {
          continue;
        }
        reconciledRun ??= await this.recordReconciliation(
          run,
          'RECOVERY_REQUIRED',
          'REQUIRES_USER_ACTION',
          false
        );
        if (reconciledRun && isTerminalRunStatus(reconciledRun.status)) {
          reconciledSessionIds.add(run.sessionId);
        } else {
          recoveryRequiredSessionIds.add(run.sessionId);
        }
      } catch (error) {
        if (error instanceof BrowserDevBoundaryViolationError) {
          throw error;
        }
        await this.recordReconciliation(
          run,
          'RECOVERY_REQUIRED',
          'REQUIRES_USER_ACTION',
          false
        );
        recoveryRequiredSessionIds.add(run.sessionId);
      } finally {
        finishReconciliation();
      }
    }

    return {
      reconciledSessionIds: [...reconciledSessionIds],
      recoveryRequiredSessionIds: [...recoveryRequiredSessionIds]
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    for (const timer of this.interruptTimers.values()) {
      clearTimeout(timer);
    }
    this.interruptTimers.clear();
    for (const buffer of this.streamBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    this.unmaterializedThreadAttestations.clear();
    const serverInstanceId = this.supervisor.currentServer?.id;
    let shutdownFailure: unknown;
    try {
      await this.supervisor.shutdown();
    } catch (cause) {
      shutdownFailure = cause;
    }
    let settlementFailure: unknown;
    try {
      if (!serverInstanceId) {
        await this.drainInbound();
      } else {
        let ownershipEnded = !shutdownFailure || this.supervisor.currentClient === undefined;
        if (!ownershipEnded) {
          const storedServer = await this.store.getAgentServer(serverInstanceId);
          ownershipEnded =
            storedServer !== undefined &&
            ['EXITED', 'FAILED', 'LOST'].includes(storedServer.status);
        }
        if (ownershipEnded) {
          const settlement = this.inboundQueue.then(() =>
            this.handleRuntimeLoss(serverInstanceId, {
              reason: 'Codex App Server shut down.',
              restarting: false,
              confirmedStopped: !this.supervisor.processTreeRunning
            })
          );
          this.inboundQueue = settlement.catch((error: unknown) =>
            this.handleInboundMaterializationFailure(error)
          );
          await settlement;
        }
      }
      await this.flushAllBufferedOutput();
    } catch (cause) {
      settlementFailure = cause;
    } finally {
      this.boundClient = undefined;
    }
    if (shutdownFailure && settlementFailure) {
      throw new AggregateError(
        [shutdownFailure, settlementFailure],
        'Codex App Server shutdown and ownership settlement both failed.'
      );
    }
    const confirmedStopped = !this.supervisor.processTreeRunning;
    if (!settlementFailure && confirmedStopped) {
      this.resetAfterConfirmedShutdown();
    }
    if (shutdownFailure) throw shutdownFailure;
    if (settlementFailure) throw settlementFailure;
  }

  private resetAfterConfirmedShutdown(): void {
    this.supervisor = this.createSupervisor();
    this.boundClient = undefined;
    this.models = [];
    this.initialized = false;
    this.shuttingDown = false;
    this.restartAttempt = 0;
    this.exitedGenerationDrain = undefined;
    this.runtimeConfigRestartPending = false;
    if (!this.securityBoundaryViolation && !this.inboundMaterializationRecoveryFailure) {
      this.preflightState = {
        runtime: CODEX_RUNTIME_DESCRIPTOR,
        readiness: createRuntimeReadiness(
          'INITIALIZING',
          'Codex App Server is stopped and ready to initialize.',
          { checks: { initialization: 'NOT_STARTED' } }
        ),
        capabilities: codexCapabilities(),
      };
    }
  }

  async updateRuntimeConfig(input: {
    executable?: string;
    toolSettings: CodexExternalToolSettings;
    restart: boolean;
  }): Promise<void> {
    this.externalToolSettings = normalizeCodexExternalToolSettings(input.toolSettings);
    this.promptRefinementExecutable = input.executable;
    this.supervisorOptions.executable = input.executable;
    this.supervisorOptions.toolSettings = this.externalToolSettings;
    if (!this.initialized) {
      this.supervisor.setExecutable(input.executable);
      this.supervisor.setToolSettings(this.externalToolSettings);
      return;
    }
    if (!input.restart) {
      this.runtimeConfigRestartPending = true;
      this.preflightState = appendRuntimeDiagnostic(
        this.preflightState,
        warningDiagnostic(
          'RUNTIME_RESTART_REQUIRED',
          'CONFIGURATION',
          RUNTIME_CONFIG_PENDING_RESTART_WARNING
        )
      );
      this.emitProviderUpdate();
      return;
    }

    await this.shutdown();
    this.runtimeConfigRestartPending = false;
    this.inboundMaterializationRecoveryFailure = undefined;
    this.outputPersistenceFence = undefined;
    this.preflightState = {
      runtime: CODEX_RUNTIME_DESCRIPTOR,
      readiness: createRuntimeReadiness(
        'INITIALIZING',
        'Codex App Server is restarting with updated settings.',
        {
          checks: {
            discovery: 'FOUND',
            compatibility: 'COMPATIBLE',
            initialization: 'NEGOTIATING'
          }
        }
      ),
      capabilities: codexCapabilities(),
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

  private async prepareObservedSettings(
    observedSettings: AgentExecutionSettings,
    subject: string
  ): Promise<AgentExecutionSettings> {
    if (this.enforceBrowserDevBoundary) {
      try {
        assertBrowserDevSettingsSafe(observedSettings, subject);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.latchSecurityBoundary(reason);
        await this.supervisor.terminateAndFence(reason);
        throw new BrowserDevBoundaryViolationError(reason);
      }
    }
    return this.sanitizeProviderSettings(observedSettings);
  }

  private async assertProviderPermissionProfileOrFence(input: {
    sessionId: string;
    worktreePath: string;
    operation: string;
    providerReference: string;
    response: unknown;
  }): Promise<void> {
    try {
      assertProviderPermissionProfile(
        input.sessionId,
        input.worktreePath,
        input.response
      );
    } catch (cause) {
      const reason =
        cause instanceof Error ? cause.message : String(cause);
      const fencedReason =
        `Codex ${input.operation} returned an unattested permission profile: ${reason}`;
      this.latchSecurityBoundary(fencedReason);
      let terminationFailure: unknown;
      try {
        await this.supervisor.terminateAndFence(fencedReason);
      } catch (error) {
        terminationFailure = error;
      }
      const detail = terminationFailure
        ? ` Process termination also failed: ${
            terminationFailure instanceof Error
              ? terminationFailure.message
              : String(terminationFailure)
          }`
        : '';
      throw new AgentMutationAmbiguousError(
        input.operation,
        `Codex acknowledged ${input.operation} (${input.providerReference}), but its permission profile could not be attested. The App Server is fenced and the mutation must not be submitted again automatically.${detail}`
      );
    }
  }

  private async ensureClient(): Promise<CodexRpcClient> {
    await this.drainExitedGeneration();
    if (this.securityBoundaryViolation) {
      throw new Error(this.securityBoundaryViolation);
    }
    if (this.inboundMaterializationRecoveryFailure) {
      throw new Error(this.inboundMaterializationRecoveryFailure);
    }
    const client = await this.supervisor.start();
    // An ensure call may have entered `supervisor.start()` just before the old
    // child closed. Recheck after startup so that call cannot bind the new
    // client ahead of callbacks already accepted from the exited generation.
    await this.drainExitedGeneration();
    if (this.securityBoundaryViolation) {
      throw new Error(this.securityBoundaryViolation);
    }
    if (this.inboundMaterializationRecoveryFailure) {
      throw new Error(this.inboundMaterializationRecoveryFailure);
    }
    if (client !== this.boundClient) {
      this.bindClient(client);
    }
    return client;
  }

  private async drainExitedGeneration(): Promise<void> {
    const drain = this.exitedGenerationDrain;
    if (!drain) return;
    await drain;
    if (this.exitedGenerationDrain && this.exitedGenerationDrain !== drain) {
      await this.drainExitedGeneration();
    }
  }

  private bindClient(client: CodexRpcClient): void {
    if (this.boundClient && this.boundClient !== client) {
      this.unmaterializedThreadAttestations.clear();
    }
    this.boundClient = client;
    client.events.on('notification', (notification, raw) => {
      const target = inboundNotificationRecoveryTarget(notification);
      this.enqueueInbound(
        () => this.handleNotification(client, notification, raw),
        inboundRecoveryTargetsOverlap(target, this.activeInboundRecoveryTarget)
          ? undefined
          : { client, notification, raw }
      );
    });
    client.events.on('serverRequest', (request, raw) => {
      this.enqueueInbound(() => this.handleServerRequest(client, request, raw));
    });
    client.events.on('unsupportedServerRequest', (request, raw) => {
      this.enqueueInbound(() => this.handleUnsupportedServerRequest(client, request, raw));
    });
  }

  /**
   * RPC clients can still have parsed callbacks queued after their process has
   * exited. Once a replacement App Server is bound, traffic from the old
   * client must not be allowed to mutate sessions or runs owned by the new
   * server generation.
   */
  private isCurrentClientEvent(
    client: CodexRpcClient,
    raw: AgentProtocolMessageReference
  ): boolean {
    return (
      this.boundClient === client &&
      raw.serverInstanceId === client.serverInstanceId
    );
  }

  private enqueueInbound(
    operation: () => Promise<void>,
    recovery?: {
      client: CodexRpcClient;
      notification: ServerNotification;
      raw: AgentProtocolMessageReference;
    }
  ): void {
    this.inboundQueue = this.inboundQueue
      .then(operation)
      .catch((error: unknown) => this.handleInboundMaterializationFailure(error, recovery));
  }

  private async handleInboundMaterializationFailure(
    error: unknown,
    recovery?: {
      client: CodexRpcClient;
      notification: ServerNotification;
      raw: AgentProtocolMessageReference;
    }
  ): Promise<void> {
    this.inboundMaterializationFailureGeneration += 1;
    const safeError = redactCredentialText(
      errorMessage(error),
      this.sensitiveValues
    );
    this.preflightState = appendRuntimeDiagnostic(
      this.preflightState,
      warningDiagnostic(
        'EVENT_MATERIALIZATION_FAILED',
        'HEALTH',
        'Codex event materialization failed.',
        safeError
      ),
      this.preflightState.readiness.status === 'READY' ? 'DEGRADED' : undefined
    );
    this.emitProviderUpdate();

    if (!recovery || this.inboundMaterializationRecoveryFailure) {
      return;
    }
    const target = inboundNotificationRecoveryTarget(recovery.notification);
    if (!target) {
      return;
    }

    let activeTarget: InboundNotificationRecoveryTarget | undefined;
    try {
      const run = await this.resolveInboundRecoveryRun(target);
      if (!run) {
        return;
      }
      const session = await this.store.getAgentSession(run.sessionId);
      activeTarget = {
        threadId: target.threadId ?? session?.providerSessionId,
        providerTurnId: target.providerTurnId ?? run.providerTurnId
      };
      this.activeInboundRecoveryTarget = activeTarget;
      if (['COMPLETED', 'FAILED', 'INTERRUPTED'].includes(run.status)) {
        // `FileTaskStore` updates its immutable in-memory projection before the
        // atomic snapshot publish. If that publish failed, a reconciliation
        // event republishes the already-terminal provider fact durably.
        await this.recordReconciliation(run, run.status, 'RECOVERED', true);
      } else {
        await this.reconcileRuns(false, new Set([run.id]));
      }
      const reconciled = await this.store.getRun(run.id);
      if (reconciled && SUBMITTED_RUN_STATES.includes(reconciled.status)) {
        throw new Error(
          `Codex inbound recovery left run ${run.id} in submitted state ${reconciled.status}.`
        );
      }
    } catch (recoveryError) {
      await this.fenceInboundMaterializationRecoveryFailure(
        error,
        recoveryError,
        recovery.client.serverInstanceId
      );
    } finally {
      if (this.activeInboundRecoveryTarget === activeTarget) {
        this.activeInboundRecoveryTarget = undefined;
      }
    }
  }

  private async resolveInboundRecoveryRun(
    target: InboundNotificationRecoveryTarget
  ): Promise<RunRecord | undefined> {
    let run = target.providerTurnId
      ? await this.store.getRunByProviderTurnId(
          this.descriptor.id,
          target.providerTurnId
        )
      : undefined;
    if (!run && target.threadId) {
      const session = await this.store.getAgentSessionByProviderId(
        this.descriptor.id,
        target.threadId
      );
      if (!session) {
        return undefined;
      }
      const candidates = (await this.store.snapshot()).runs.filter(
        (candidate) =>
          candidate.runtimeId === this.descriptor.id &&
          candidate.sessionId === session.id &&
          ACTIVE_RUN_STATES.includes(candidate.status) &&
          (!target.providerTurnId ||
            !candidate.providerTurnId ||
            candidate.providerTurnId === target.providerTurnId)
      );
      if (candidates.length !== 1) {
        return undefined;
      }
      run = candidates[0];
      if (run && target.providerTurnId && !run.providerTurnId) {
        run = await this.store.updateRun(run.id, {
          providerTurnId: target.providerTurnId,
          serverInstanceId: this.supervisor.currentServer?.id,
          lastEventAt: new Date().toISOString()
        });
      }
    }
    return run?.runtimeId === this.descriptor.id ? run : undefined;
  }

  private async fenceInboundMaterializationRecoveryFailure(
    materializationError: unknown,
    recoveryError: unknown,
    serverInstanceId: string
  ): Promise<void> {
    const materializationDetail = redactCredentialText(
      errorMessage(materializationError),
      this.sensitiveValues
    );
    const recoveryDetail = redactCredentialText(
      errorMessage(recoveryError),
      this.sensitiveValues
    );
    const reason =
      'Codex inbound event materialization could not be durably reconciled. ' +
      `Materialization failure: ${materializationDetail} Recovery failure: ${recoveryDetail}`;
    this.latchInboundMaterializationRecoveryFailure(reason);

    const fenceFailures: string[] = [];
    try {
      await this.supervisor.terminateAndFence(reason);
    } catch (error) {
      fenceFailures.push(`process fence: ${errorMessage(error)}`);
    }
    try {
      await this.handleRuntimeLoss(serverInstanceId, {
        reason: 'Codex App Server was fenced after an inbound event could not be materialized.',
        restarting: false,
        confirmedStopped: !this.supervisor.processTreeRunning
      });
    } catch (error) {
      fenceFailures.push(`runtime-loss persistence: ${errorMessage(error)}`);
    }
    if (fenceFailures.length > 0) {
      this.preflightState = appendRuntimeDiagnostic(
        this.preflightState,
        errorDiagnostic(
          'EVENT_MATERIALIZATION_FENCE_INCOMPLETE',
          'HEALTH',
          'Codex event recovery failed and its runtime fence was incomplete.',
          fenceFailures.join('; ')
        ),
        'FAILED'
      );
      this.emitProviderUpdate();
    }
  }

  private latchInboundMaterializationRecoveryFailure(reason: string): void {
    if (this.inboundMaterializationRecoveryFailure) {
      return;
    }
    this.inboundMaterializationRecoveryFailure = reason;
    this.activeInboundRecoveryTarget = undefined;
    this.unmaterializedThreadAttestations.clear();
    for (const timer of this.interruptTimers.values()) {
      clearTimeout(timer);
    }
    this.interruptTimers.clear();
    this.preflightState = {
      ...this.preflightState,
      readiness: createRuntimeReadiness('FAILED', reason, {
        checks: {
          ...this.preflightState.readiness.checks,
          initialization: 'FAILED'
        },
        diagnostics: [
          ...this.preflightState.readiness.diagnostics,
          errorDiagnostic(
            'EVENT_MATERIALIZATION_RECOVERY_FAILED',
            'HEALTH',
            'Codex event recovery failed; the App Server generation was fenced.',
            reason
          )
        ],
        nextAction: { kind: 'RETRY', label: 'Restart Codex runtime' }
      })
    };
    this.emitProviderUpdate();
  }

  private async drainInbound(): Promise<void> {
    for (;;) {
      const queued = this.inboundQueue;
      await queued;
      if (queued === this.inboundQueue) {
        return;
      }
    }
  }

  private async refreshPreflight(publishUpdate = false): Promise<void> {
    const client = await this.ensureClient();
    const diagnostics: AgentRuntimeDiagnostic[] = [];
    const accountResponse = await client.request('account/read', { refreshToken: false });
    const accountLabel = describeAccount(accountResponse.account);
    const authenticationRequired =
      accountResponse.requiresOpenaiAuth && !accountResponse.account;
    if (authenticationRequired) {
      diagnostics.push(
        errorDiagnostic(
          'AUTHENTICATION_REQUIRED',
          'AUTHENTICATION',
          'Codex authentication is required.',
          'Run `codex login` and refresh the runtime.'
        )
      );
    }
    let modelError: string | undefined;
    try {
      await this.refreshModels();
      if (this.models.length === 0) {
        throw new Error('Codex did not report any available models.');
      }
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error);
      diagnostics.push(
        errorDiagnostic(
          'MODEL_CATALOG_FAILED',
          'MODEL_CATALOG',
          'Codex model discovery failed.',
          modelError
        )
      );
    }
    if (this.runtimeConfigRestartPending) {
      diagnostics.push(
        warningDiagnostic(
          'RUNTIME_RESTART_REQUIRED',
          'CONFIGURATION',
          RUNTIME_CONFIG_PENDING_RESTART_WARNING
        )
      );
    }

    const readiness = authenticationRequired
      ? createRuntimeReadiness(
          'AUTHENTICATION_REQUIRED',
          'Sign in to Codex before starting a task.',
          {
            checks: {
              discovery: 'FOUND',
              compatibility: 'COMPATIBLE',
              initialization: 'INITIALIZED',
              authentication: 'REQUIRED',
              modelCatalog: modelError ? 'FAILED' : 'AVAILABLE'
            },
            diagnostics,
            nextAction: {
              kind: 'AUTHENTICATE',
              label: 'Run codex login',
              command: 'codex login'
            }
          }
        )
      : modelError
        ? createRuntimeReadiness('FAILED', 'Codex models could not be loaded.', {
            checks: {
              discovery: 'FOUND',
              compatibility: 'COMPATIBLE',
              initialization: 'INITIALIZED',
              authentication: 'AUTHENTICATED',
              modelCatalog: 'FAILED'
            },
            diagnostics,
            nextAction: { kind: 'RETRY', label: 'Retry model discovery' }
          })
        : createRuntimeReadiness('READY', 'Codex App Server is operational.', {
            checks: {
              discovery: 'FOUND',
              compatibility: 'COMPATIBLE',
              initialization: 'INITIALIZED',
              authentication: accountResponse.account
                ? 'AUTHENTICATED'
                : 'PROVIDER_MANAGED',
              modelCatalog: this.models.length > 0 ? 'AVAILABLE' : 'EMPTY'
            },
            diagnostics
          });

    if (this.securityBoundaryViolation || this.inboundMaterializationRecoveryFailure) {
      return;
    }
    this.preflightState = {
      runtime: CODEX_RUNTIME_DESCRIPTOR,
      readiness,
      capabilities: codexCapabilities(),
      runtimeVersion: this.supervisor.currentServer?.runtimeVersion,
      accountLabel
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
    client: CodexRpcClient,
    notification: ServerNotification,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (
      this.securityBoundaryViolation ||
      this.inboundMaterializationRecoveryFailure ||
      !this.isCurrentClientEvent(client, raw)
    ) {
      return;
    }
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
        const session = await this.store.getAgentSessionByProviderId(this.descriptor.id,
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
    const existing = await this.store.getAgentSessionByProviderId(this.descriptor.id, thread.id);
    const sourceMetadata = getSubagentThreadMetadata(thread);
    const providerParentSessionId =
      thread.parentThreadId ??
      sourceMetadata.parentThreadId ??
      (sourceMetadata.isSpawnedSubagent ? thread.forkedFromId : null);

    if (providerParentSessionId) {
      const parent = await this.store.getAgentSessionByProviderId(this.descriptor.id,
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
            redactOptionalProviderText(
              thread.agentNickname ?? sourceMetadata.nickname ?? undefined,
              this.sensitiveValues
            ),
          providerRole: redactOptionalProviderText(
            thread.agentRole ?? sourceMetadata.role ?? undefined,
            this.sensitiveValues
          ),
          agentPath: redactOptionalProviderText(
            sourceMetadata.agentPath,
            this.sensitiveValues
          ),
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
          redactOptionalProviderText(
            thread.agentNickname ?? sourceMetadata.nickname ?? undefined,
            this.sensitiveValues
          ),
        providerRole: redactOptionalProviderText(
          thread.agentRole ?? sourceMetadata.role ?? undefined,
          this.sensitiveValues
        ),
        agentPath: redactOptionalProviderText(
          sourceMetadata.agentPath,
          this.sensitiveValues
        ),
        relationshipState: unresolved ? 'UNRESOLVED' : existing.relationshipState,
        relationshipDetail: unresolved
          ? 'The provider identified this as a child thread, but its parent is not known to Task Monki.'
          : existing.relationshipDetail,
        status: mapThreadStatus(thread.status),
        subagentStatus:
          existing.role === 'SUBAGENT'
            ? mapThreadToSubagentStatus(thread.status)
            : existing.subagentStatus,
        // Root `thread/started` can describe the empty thread returned by
        // `thread/start`; only a turn acknowledgement makes it resumable.
        materialized: existing.role === 'SUBAGENT' ? true : existing.materialized,
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
        (await this.store.getAgentSessionByProviderId(this.descriptor.id, item.senderThreadId)) ??
        (item.senderThreadId === session.providerSessionId ? session : undefined);
      if (!parent) {
        return;
      }
      const requestedSettings = this.sanitizeProviderSettings({
        model: item.model ?? undefined,
        reasoningEffort: item.reasoningEffort ?? undefined
      });
      for (const childThreadId of new Set(item.receiverThreadIds)) {
        await this.store.observeSubagent({
          parentSessionId: parent.id,
          parentRunId: run.id,
          providerChildSessionId: childThreadId,
          providerParentSessionId: item.senderThreadId,
          source: 'COLLAB_RECEIVER',
          delegatedPrompt:
            item.tool === 'spawnAgent' && item.prompt
              ? redactCredentialText(item.prompt, this.sensitiveValues)
              : undefined,
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
        agentPath: item.agentPath
          ? redactCredentialText(item.agentPath, this.sensitiveValues)
          : undefined,
        rawMessage: raw
      });
    }
  }

  private async ensureRunForSession(
    session: AgentSessionRecord,
    providerTurnId: string
  ): Promise<RunRecord | undefined> {
    const existing = await this.store.getRunByProviderTurnId(this.descriptor.id, providerTurnId);
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
      const snapshot = await this.store.snapshot();
      const uncorrelated = snapshot.runs.filter(
        (run) =>
          run.sessionId === session.id &&
          run.runtimeId === this.descriptor.id &&
          run.status === 'RECOVERY_REQUIRED' &&
          !run.providerTurnId
      );
      if (uncorrelated.length === 1) {
        return this.store.updateRun(uncorrelated[0]!.id, {
          providerTurnId,
          serverInstanceId: this.supervisor.currentServer?.id,
          lastEventAt: new Date().toISOString()
        });
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

  /**
   * A resumed nonterminal turn is owned by the App Server connection that
   * authoritatively reported it. Persist that handoff before accepting new
   * approvals so interaction and protocol references share one server owner.
   */
  private async bindRunToServer(
    run: RunRecord,
    serverInstanceId: string
  ): Promise<RunRecord | undefined> {
    const current = await this.store.getRun(run.id);
    if (!current || !ACTIVE_RUN_STATES.includes(current.status)) {
      return undefined;
    }
    if (current.serverInstanceId === serverInstanceId) {
      return current;
    }
    return this.store.updateRun(current.id, {
      serverInstanceId,
      lastEventAt: new Date().toISOString()
    });
  }

  private beginRunReconciliation(runId: string): () => void {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runReconciliationBarriers.set(runId, barrier);
    return () => {
      release();
      if (this.runReconciliationBarriers.get(runId) === barrier) {
        this.runReconciliationBarriers.delete(runId);
      }
    };
  }

  private async waitForRunReconciliation(runId: string): Promise<void> {
    await this.runReconciliationBarriers.get(runId);
  }

  /**
   * Provider terminal notifications, local interrupt deadlines, reconciliation,
   * and direct user interrupt responses can arrive on different async paths.
   * One run-local queue owns their final durable status check and publication.
   */
  private serializeRunSettlement<T>(
    runId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.runSettlementContext.getStore() === runId) {
      return operation();
    }
    const previous = this.runSettlementQueues.get(runId) ?? Promise.resolve();
    const settlement = previous
      .catch(() => undefined)
      .then(() => this.runSettlementContext.run(runId, operation));
    this.runSettlementQueues.set(runId, settlement);
    return settlement.finally(() => {
      if (this.runSettlementQueues.get(runId) === settlement) {
        this.runSettlementQueues.delete(runId);
      }
    });
  }

  private async handleServerRequest(
    client: CodexRpcClient,
    request: ServerRequest,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (
      this.securityBoundaryViolation ||
      this.inboundMaterializationRecoveryFailure ||
      !this.isCurrentClientEvent(client, raw)
    ) {
      return;
    }
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
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, params.threadId);
    let run =
      session && params.turnId
        ? await this.ensureRunForSession(session, params.turnId)
        : session
          ? await this.store.getActiveRunForSession(session.id)
          : undefined;
    if (run) {
      await this.waitForRunReconciliation(run.id);
    }
    const server = this.supervisor.currentServer;
    if (
      !session ||
      !run ||
      !server ||
      !this.isCurrentClientEvent(client, raw) ||
      !ACTIVE_RUN_STATES.includes(run.status)
    ) {
      await client.respondError(request.id, {
        code: -32602,
        message: 'Task Monki could not correlate the request to an active run.'
      });
      return;
    }
    run = await this.bindRunToServer(run, server.id);
    if (!run) {
      await client.respondError(request.id, {
        code: -32602,
        message: 'Task Monki could not correlate the request to an active run.'
      });
      return;
    }

    const item = params.itemId
      ? await this.store.getAgentItemByProviderId(run.id, params.itemId)
      : undefined;
    const providerInteractionRequest = withProviderItemContext(
      mapped.type,
      this.redactProviderValue(mapped.request),
      item?.payload
    );
    const interactionRequest =
      mapped.type === 'PERMISSION_APPROVAL'
        ? redactExternalPermissionPaths(
            providerInteractionRequest as AgentPermissionApprovalRequest,
            session.worktreePath
          )
        : providerInteractionRequest;
    const policy = buildInteractionPolicy({
      type: mapped.type,
      request: interactionRequest,
      session,
      run,
      providerItemPayload: item?.payload
    });
    const interaction = await this.store.createInteractionRequest({
      runtimeId: this.descriptor.id,
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
    if (
      mapped.type === 'DYNAMIC_TOOL' ||
      (mapped.type === 'USER_INPUT' && policy.allowedActions.length === 0)
    ) {
      await this.resolveBlockedInteraction(interaction);
    }
  }

  private async handleUnsupportedServerRequest(
    client: CodexRpcClient,
    request: UnsupportedCodexServerRequest,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (
      this.securityBoundaryViolation ||
      this.inboundMaterializationRecoveryFailure ||
      !this.isCurrentClientEvent(client, raw)
    ) {
      return;
    }
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
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
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
    if (run.status === 'RECOVERY_REQUIRED') {
      const recoveryRun = run;
      run = await this.store.updateRun(run.id, {
        status: 'RUNNING',
        recoveryState: 'NONE',
        serverInstanceId: this.supervisor.currentServer?.id,
        lastEventAt: new Date().toISOString()
      });
      await this.recordReconciliation(
        recoveryRun,
        'RUNNING',
        'NONE',
        false
      );
    }
    await this.store.updateAgentSession(session.id, {
      status: 'ACTIVE',
      materialized: true,
      subagentStatus: session.role === 'SUBAGENT' ? 'RUNNING' : session.subagentStatus
    });
    this.unmaterializedThreadAttestations.delete(session.id);
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
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
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
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
    const run = session
      ? await this.ensureRunForSession(session, turnId)
      : undefined;
    if (!session || !run) {
      return;
    }
    const safeItem = this.redactProviderValue(item);
    await this.store.upsertAgentItem({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      providerItemId: item.id,
      type: mapItemType(item),
      status,
      payload: safeItem,
      rawMessage: raw,
      providerStartedAt: startedAtMs ? new Date(startedAtMs).toISOString() : undefined,
      providerCompletedAt: completedAtMs
        ? new Date(completedAtMs).toISOString()
        : undefined
    });
    if (safeItem.type === 'agentMessage' && status === 'COMPLETED') {
      await this.store.updateRun(run.id, {
        finalMessage: safeItem.text,
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
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
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
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, turnId);
    if (!run) {
      return;
    }
    const safePlan = this.redactProviderValue(plan);
    await this.store.recordAgentPlanRevision({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: run.sessionId,
      runtimeId: this.descriptor.id,
      explanation: explanation
        ? redactCredentialText(explanation, this.sensitiveValues)
        : undefined,
      steps: mapPlanSteps(safePlan),
      rawMessage: raw
    });
    this.emitRunActivity(run, {
      eventType: 'turn/plan/updated',
      stepCount: safePlan.length
    });
  }

  private async handleUsageUpdate(
    threadId: string,
    turnId: string,
    usage: ThreadTokenUsage,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
    if (!session) {
      return;
    }
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, turnId);
    const stored = await this.store.recordAgentUsageSnapshot({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runId: run?.id,
      runtimeId: session.runtimeId,
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
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
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
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
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
      runtimeId: session.runtimeId,
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
    const observed = settingsFromThreadSettings(settings);
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
    if (session) {
      try {
        assertCodexActivePermissionProfile(
          session.id,
          settings.activePermissionProfile
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.latchSecurityBoundary(reason);
        await this.supervisor.terminateAndFence(reason);
        await this.persistSettingsObservation(session, observed, raw).catch(
          () => undefined
        );
        await this.terminalizeRunsForSecurityBoundary(
          reason,
          'CODEX_PERMISSION_PROFILE'
        );
        return;
      }
    }
    if (this.enforceBrowserDevBoundary) {
      try {
        assertBrowserDevSettingsSafe(observed, 'Live session observed settings');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // No lookup or durable write may precede this latch. Unknown/stale
        // thread IDs are process-wide failures too because the notification
        // proves this App Server can leave the requested security profile.
        this.latchSecurityBoundary(reason);
        await this.supervisor.terminateAndFence(reason);

        let persistenceError: unknown;
        if (session) {
          try {
            await this.persistSettingsObservation(
              session,
              observed,
              raw
            );
          } catch (caught) {
            persistenceError = caught;
          }
        }
        await this.terminalizeRunsForSecurityBoundary(
          reason,
          'BROWSER_DEV_LIVE_SETTINGS'
        );
        if (persistenceError) throw persistenceError;
        return;
      }
    }
    if (!session) {
      return;
    }
    await this.persistSettingsObservation(session, observed, raw);
  }

  private async persistSettingsObservation(
    session: AgentSessionRecord,
    observed: AgentExecutionSettings,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const safeObserved = this.sanitizeProviderSettings(observed);
    await this.store.updateAgentSession(session.id, {
      observedSettings: safeObserved
    });
    await this.recordSettingsObservation(
      session,
      'THREAD_SETTINGS_NOTIFICATION',
      safeObserved,
      undefined,
      raw
    );
  }

  private latchSecurityBoundary(reason: string): void {
    if (this.securityBoundaryViolation) return;
    this.securityBoundaryViolation = reason;
    this.preflightState = {
      ...this.preflightState,
      readiness: createRuntimeReadiness('FAILED', reason, {
        checks: {
          ...this.preflightState.readiness.checks,
          initialization: 'FAILED'
        },
        diagnostics: [errorDiagnostic('SECURITY_BOUNDARY_FAILED', 'SECURITY', reason)]
      })
    };
    this.emitProviderUpdate();
  }

  private async terminalizeRunsForSecurityBoundary(
    reason: string,
    boundary: 'BROWSER_DEV_LIVE_SETTINGS' | 'CODEX_PERMISSION_PROFILE'
  ): Promise<void> {
    const snapshot = await this.store.snapshot();
    const affectedRuns = snapshot.runs.filter((run) =>
      run.runtimeId === this.descriptor.id && ACTIVE_RUN_STATES.includes(run.status)
    );
    for (const run of affectedRuns) {
      await this.serializeRunSettlement(run.id, async () => {
        const current = await this.store.getRun(run.id);
        if (!current || !ACTIVE_RUN_STATES.includes(current.status)) return;
        await this.flushBufferedOutput(current.id, true);
        const finalArtifact = await this.store.writeFinalArtifact(
          current.taskId,
          current.id,
          `# Agent turn blocked by provider security boundary\n\n${reason}\n`
        );
        const published = await this.store.appendRunEventIfStatus(
          createDomainEvent({
            type: 'AGENT_RUN_FAILED',
            taskId: current.taskId,
            iterationId: current.iterationId,
            runId: current.id,
            worktreeId: current.worktreeId,
            agentSessionId: current.sessionId,
            serverInstanceId: current.serverInstanceId,
            source: 'provider',
            payload: {
              error: reason,
              terminalReason: reason,
              finalArtifactId: finalArtifact.id,
              securityBoundary: boundary
            }
          }),
          ACTIVE_RUN_STATES
        );
        if (!published) return;
        await this.store.updateAgentSession(current.sessionId, { status: 'NOT_LOADED' });
        this.appEvents.emit({
          type: 'run.terminal',
          taskId: current.taskId,
          iterationId: current.iterationId,
          runId: current.id,
          worktreeId: current.worktreeId,
          payload: { status: 'failed', error: reason, finalArtifactId: finalArtifact.id },
          at: new Date().toISOString()
        });
      });
    }
    for (const interaction of snapshot.interactionRequests.filter(
      (request) =>
        affectedRuns.some((run) => run.id === request.runId) &&
        (request.status === 'PENDING' || request.status === 'RESPONDING')
    )) {
      const stale = await this.store.transitionInteractionRequest(
        interaction.id,
        interaction.status,
        {
          status: 'STALE',
          resolution: { reason },
          resolvedAt: new Date().toISOString()
        }
      );
      this.emitInteractionUpdate(stale);
    }
  }

  private async handleThreadWarning(
    threadId: string | null,
    message: string,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!threadId) {
      return;
    }
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, threadId);
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
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, turnId);
    if (!run) {
      return;
    }
    const observedSettings = this.sanitizeProviderSettings({
      ...run.observedSettings,
      model
    });
    await this.store.updateRun(run.id, {
      observedSettings,
      lastEventAt: new Date().toISOString()
    });
    const session = await this.requireSession(run.sessionId);
    await this.recordSettingsObservation(
      session,
      'MODEL_REROUTED_NOTIFICATION',
      { model },
      run.id,
      raw,
      redactCredentialText(
        `${fromModel} → ${model}: ${String(reason)}`,
        this.sensitiveValues
      )
    );
    await this.recordRunActivity(run, 'model/rerouted', {
      fromModel,
      model,
      reason: this.redactProviderValue(reason),
      provenance: raw
    });
  }

  private async appendTurnOutput(
    turnId: string,
    source: string,
    text: string
  ): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, turnId);
    if (!run) {
      return;
    }
    if (!text) return;
    const buffer = this.streamBuffers.get(run.id) ?? {
      groups: [],
      byteCount: 0,
      failureCount: 0
    };
    this.streamBuffers.set(run.id, buffer);
    this.bufferTurnOutput(buffer, source, text);
    if (buffer.byteCount >= STREAM_OUTPUT_FLUSH_BYTES) {
      await this.flushBufferedOutput(run.id);
    } else {
      this.scheduleBufferedOutputFlush(run.id, buffer);
    }
  }

  private scheduleBufferedOutputFlush(
    runId: string,
    buffer: CodexRunOutputBuffer
  ): void {
    if (buffer.timer || buffer.byteCount === 0 || this.shuttingDown) return;
    const delay = STREAM_OUTPUT_FLUSH_MS * 2 ** buffer.failureCount;
    const timer = setTimeout(() => {
      if (buffer.timer === timer) buffer.timer = undefined;
      this.enqueueInbound(() => this.flushBufferedOutput(runId));
    }, delay);
    timer.unref();
    buffer.timer = timer;
  }

  private async flushBufferedOutput(
    runId: string,
    releaseCredentialCarry = false
  ): Promise<void> {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer) return;
    if (releaseCredentialCarry) {
      this.redactOutputCredentialCarry(buffer);
    }
    if (buffer.flushing) {
      await buffer.flushing;
      if (
        buffer.byteCount > 0 ||
        (releaseCredentialCarry && buffer.credentialCarry)
      ) {
        await this.flushBufferedOutput(runId, releaseCredentialCarry);
      }
      return;
    }
    const flushing = this.flushBufferedOutputBatch(runId, buffer);
    buffer.flushing = flushing;
    try {
      await flushing;
    } finally {
      if (buffer.flushing === flushing) {
        buffer.flushing = undefined;
      }
    }
  }

  private async flushBufferedOutputBatch(
    runId: string,
    buffer: CodexRunOutputBuffer
  ): Promise<void> {
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = undefined;
    if (buffer.byteCount === 0) {
      return;
    }
    // Detach before the first await. Provider deltas that arrive while this
    // batch is persisted remain in the live buffer and are flushed next.
    const groups = buffer.groups;
    const byteCount = buffer.byteCount;
    buffer.groups = [];
    buffer.byteCount = 0;
    const run = await this.store.getRun(runId);
    if (!run) {
      if (this.streamBuffers.get(runId) === buffer) {
        this.streamBuffers.delete(runId);
      }
      return;
    }
    const safeGroups = groups.map(({ source, chunks }) => ({
      source: redactCredentialText(source, this.sensitiveValues),
      text: redactCredentialText(chunks.join(''), this.sensitiveValues)
    }));
    const artifactText = safeGroups
      .map(({ source, text }) => `\n[${source}]\n${text}`)
      .join('');
    try {
      await this.store.appendArtifact(run.outputArtifactId, artifactText);
    } catch (error) {
      const nextFailureCount = buffer.failureCount + 1;
      const restoredByteCount = buffer.byteCount + byteCount;
      if (
        error instanceof ArtifactAppendAmbiguousError ||
        nextFailureCount >= STREAM_OUTPUT_MAX_FAILURES ||
        restoredByteCount > STREAM_OUTPUT_MAX_BUFFER_BYTES
      ) {
        this.discardAllBufferedOutput();
        this.fenceOutputPersistenceFailure(run, error);
        throw error;
      }
      // The detached batch is older than anything appended while persistence
      // was in flight, so restore it at the front without losing either side.
      const newerGroups = buffer.groups;
      const lastOlderGroup = groups.at(-1);
      const firstNewerGroup = newerGroups[0];
      if (lastOlderGroup && firstNewerGroup?.source === lastOlderGroup.source) {
        lastOlderGroup.chunks.push(...firstNewerGroup.chunks);
        buffer.groups = [...groups, ...newerGroups.slice(1)];
      } else {
        buffer.groups = [...groups, ...newerGroups];
      }
      buffer.byteCount += byteCount;
      buffer.failureCount = nextFailureCount;
      this.streamBuffers.set(runId, buffer);
      this.scheduleBufferedOutputFlush(runId, buffer);
      throw error;
    }
    buffer.failureCount = 0;
    if (buffer.byteCount === 0 && !buffer.credentialCarry) {
      if (this.streamBuffers.get(runId) === buffer) {
        this.streamBuffers.delete(runId);
      }
    } else {
      this.scheduleBufferedOutputFlush(runId, buffer);
    }
    for (const group of safeGroups) {
      this.appEvents.emit({
        type: 'run.output',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: { source: group.source, text: group.text },
        at: new Date().toISOString()
      });
    }
  }

  private async flushAllBufferedOutput(): Promise<void> {
    for (const runId of [...this.streamBuffers.keys()]) {
      await this.flushBufferedOutput(runId, true);
    }
  }

  private bufferTurnOutput(
    buffer: CodexRunOutputBuffer,
    source: string,
    text: string
  ): void {
    if (buffer.credentialCarry && buffer.credentialCarry.source !== source) {
      this.redactOutputCredentialCarry(buffer);
    }
    const combined = redactCredentialText(`${
      buffer.credentialCarry?.source === source
        ? buffer.credentialCarry.text
        : ''
    }${text}`, this.sensitiveValues);
    const carryLength = credentialPrefixCarryLength(
      combined,
      this.sensitiveValues
    );
    const ready = combined.slice(0, combined.length - carryLength);
    if (ready) {
      this.appendBufferedOutputGroup(buffer, source, ready);
    }
    buffer.credentialCarry = carryLength > 0
      ? { source, text: combined.slice(-carryLength) }
      : undefined;
  }

  private appendBufferedOutputGroup(
    buffer: CodexRunOutputBuffer,
    source: string,
    text: string
  ): void {
    if (!text) return;
    const previous = buffer.groups.at(-1);
    if (previous?.source === source) previous.chunks.push(text);
    else buffer.groups.push({ source, chunks: [text] });
    buffer.byteCount += Buffer.byteLength(text);
  }

  private redactOutputCredentialCarry(buffer: CodexRunOutputBuffer): void {
    if (!buffer.credentialCarry) return;
    this.appendBufferedOutputGroup(
      buffer,
      buffer.credentialCarry.source,
      REDACTED_CREDENTIAL
    );
    buffer.credentialCarry = undefined;
  }

  private discardAllBufferedOutput(): void {
    for (const buffer of this.streamBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    this.streamBuffers.clear();
  }

  private fenceOutputPersistenceFailure(
    run: RunRecord,
    error: unknown
  ): void {
    if (!this.outputPersistenceFence) {
      const reason =
        error instanceof ArtifactAppendAmbiguousError
          ? `Codex output persistence for run ${run.id} became ambiguous and cannot be retried safely.`
          : `Codex output persistence for run ${run.id} failed repeatedly.`;
      const serverInstanceId =
        run.serverInstanceId ?? this.supervisor.currentServer?.id;
      this.outputPersistenceFence = serverInstanceId
        ? this.fenceInboundMaterializationRecoveryFailure(
            error,
            new Error(reason),
            serverInstanceId
          )
        : Promise.resolve(this.latchInboundMaterializationRecoveryFailure(reason));
    }
  }

  private async recordTurnActivity(
    turnId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, turnId);
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
        payload: { eventType, ...this.redactProviderValue(payload) }
      })
    );
  }

  private async recordInterruptAmbiguity(
    providerTurnId: string,
    reason: string
  ): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, providerTurnId);
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
    await this.serializeRunSettlement(run.id, async () => {
      await this.recordLocalInterruptionOwned(run, terminalReason);
    });
  }

  private async recordLocalInterruptionOwned(
    run: RunRecord,
    terminalReason: string
  ): Promise<void> {
    const current = (await this.store.getRun(run.id)) ?? run;
    if (!ACTIVE_RUN_STATES.includes(current.status)) {
      return;
    }
    await this.flushBufferedOutput(current.id, true);
    const finalArtifact = await this.store.writeFinalArtifact(
      current.taskId,
      current.id,
      `# Agent turn interrupted\n\n${terminalReason}\n`
    );
    const published = await this.store.appendRunEventIfStatus(
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
      }),
      ACTIVE_RUN_STATES
    );
    if (!published) return;
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
    await this.serializeRunSettlement(run.id, async () => {
      await this.finalizeTurnOwned(run, turn, source, rawMessage);
    });
  }

  private async finalizeRecoveredTurn(
    run: RunRecord,
    turn: Turn
  ): Promise<RunRecord | undefined> {
    return this.serializeRunSettlement(run.id, async () => {
      await this.finalizeTurnOwned(run, turn, 'RECOVERY_RESUME_RESPONSE');
      const current = await this.store.getRun(run.id);
      const expectedStatus = mapTurnStatus(turn.status);
      if (!current || current.status !== expectedStatus) {
        return current;
      }
      return this.recordReconciliationOwned(
        current,
        expectedStatus,
        'RECOVERED',
        true
      );
    });
  }

  private async finalizeTurnOwned(
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
    await this.flushBufferedOutput(current.id, true);
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
    const safeFinalMessage = finalMessage
      ? redactCredentialText(finalMessage, this.sensitiveValues)
      : undefined;
    const safeTurn = this.redactProviderValue(turn);
    const reviewResult =
      run.mode === 'REVIEW' ? parseCodexReviewResult(safeFinalMessage) : undefined;
    const codexReviewStatus = codexReviewStatusFromResult(reviewResult);
    const finalArtifact = await this.store.writeFinalArtifact(
      run.taskId,
      run.id,
      formatFinalArtifact(run, safeTurn, safeFinalMessage)
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
    const published = await this.store.appendRunEventIfStatus(
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
          terminalStatus: safeTurn.status,
          error: safeTurn.error?.message,
          finalArtifactId: finalArtifact.id,
          terminalReason: safeTurn.error?.message,
          codexReviewStatus,
          codexReviewResult: reviewResult
        }
      }),
      ACTIVE_RUN_STATES
    );
    if (!published) return;
    this.appEvents.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: safeTurn.status, finalArtifactId: finalArtifact.id },
      at: new Date().toISOString()
    });
  }

  private async handleRuntimeLoss(
    serverInstanceId: string,
    options: {
      reason?: string;
      restarting?: boolean;
      confirmedStopped?: boolean;
    } = {}
  ): Promise<void> {
    const reason = options.reason ?? 'Codex App Server exited unexpectedly.';
    for (const [sessionId, attestation] of this.unmaterializedThreadAttestations) {
      if (attestation.serverInstanceId === serverInstanceId) {
        this.unmaterializedThreadAttestations.delete(sessionId);
      }
    }
    if (options.restarting !== false) {
      this.preflightState = {
        ...this.preflightState,
        readiness: createRuntimeReadiness(
          'INITIALIZING',
          'Codex App Server exited unexpectedly and is restarting.',
          {
            checks: {
              discovery: 'FOUND',
              compatibility: 'COMPATIBLE',
              initialization: 'NEGOTIATING',
              authentication: this.preflightState.readiness.checks.authentication,
              modelCatalog: this.preflightState.readiness.checks.modelCatalog
            },
            diagnostics: [
              errorDiagnostic(
                'RUNTIME_EXITED',
                'HEALTH',
                'Codex App Server exited unexpectedly.'
              )
            ]
          }
        )
      };
      this.emitProviderUpdate();
    }
    const snapshot = await this.store.snapshot();
    const affected = snapshot.runs.filter(
      (run) =>
        run.serverInstanceId === serverInstanceId && ACTIVE_RUN_STATES.includes(run.status)
    );
    for (const run of affected) {
      await this.flushBufferedOutput(run.id, true);
      if (run.status === 'INTERRUPTING' && options.confirmedStopped === true) {
        await this.recordLocalInterruption(
          run,
          options.reason
            ? `${reason} The runtime stopped while processing an interruption.`
            : 'Codex App Server exited while processing an interruption.'
        );
      } else {
        await this.recordRuntimeLoss(run, reason, serverInstanceId);
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
    const serversWithActiveOwnership = new Set([
      ...snapshot.runs
        .filter((run) => ACTIVE_RUN_STATES.includes(run.status))
        .map((run) => run.serverInstanceId),
      ...snapshot.interactionRequests
        .filter((request) => ['PENDING', 'RESPONDING'].includes(request.status))
        .map((request) => request.serverInstanceId)
    ]);
    const orphaned = snapshot.agentServers.filter(
      (server) =>
        server.runtimeId === this.descriptor.id &&
        (['STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING'].includes(server.status) ||
          serversWithActiveOwnership.has(server.id))
    );
    for (const server of orphaned) {
      if (!['EXITED', 'FAILED', 'LOST'].includes(server.status)) {
        await this.store.updateAgentServer(server.id, {
          status: 'LOST',
          disconnectedAt: new Date().toISOString(),
          exitedAt: new Date().toISOString(),
          exitReason: 'Task Monki restarted without the prior App Server process.'
        });
      }
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
      void this.store
        .getRunByProviderTurnId(this.descriptor.id, providerTurnId)
        .then(async (run) => {
          if (
            run &&
            ['INTERRUPTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(
              run.status
            )
          ) {
            const reason =
              `Turn ${providerTurnId} did not emit a terminal event after interruption.`;
            let terminationFailure: unknown;
            try {
              await this.supervisor.terminateUnresponsive(reason);
            } catch (error) {
              terminationFailure = error;
            }
            // Process exit enqueues runtime-loss handling synchronously. Queue
            // the deadline settlement behind it so exactly one owner can make
            // the run terminal after re-reading durable state.
            this.enqueueInbound(() =>
              this.settleInterruptDeadline(run.id, reason, terminationFailure)
            );
          }
        })
        .catch((error: unknown) => this.handleInboundMaterializationFailure(error));
    }, this.interruptCompletionTimeoutMs);
    timer.unref();
    this.interruptTimers.set(providerTurnId, timer);
  }

  private async settleInterruptDeadline(
    runId: string,
    reason: string,
    terminationFailure: unknown
  ): Promise<void> {
    const run = await this.store.getRun(runId);
    if (
      !run ||
      !['INTERRUPTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(
        run.status
      )
    ) {
      return;
    }

    if (terminationFailure === undefined) {
      await this.recordLocalInterruption(run, `${reason} Stopped the local runtime.`);
      return;
    }

    const failureReason =
      `${reason} Local process-tree termination was not fully confirmed: ${redactCredentialText(
        errorMessage(terminationFailure),
        this.sensitiveValues
      )}`;
    if (run.serverInstanceId) {
      await this.handleRuntimeLoss(run.serverInstanceId, {
        reason: failureReason,
        restarting: false,
        confirmedStopped: !this.supervisor.processTreeRunning
      });
    } else {
      await this.recordRuntimeLoss(run, failureReason);
      await this.store.updateAgentSession(run.sessionId, {
        status: 'NOT_LOADED'
      });
    }
    const recoveryRun = await this.store.getRun(run.id);
    if (recoveryRun?.status === 'RECOVERY_REQUIRED') {
      await this.recordReconciliation(
        recoveryRun,
        'RECOVERY_REQUIRED',
        'REQUIRES_USER_ACTION',
        false
      );
    }
  }

  private async recordRuntimeLoss(
    run: RunRecord,
    reason: string,
    serverInstanceId = run.serverInstanceId
  ): Promise<void> {
    await this.serializeRunSettlement(run.id, async () => {
      const current = await this.store.getRun(run.id);
      if (!current || !ACTIVE_RUN_STATES.includes(current.status)) return;
      await this.store.appendRunEventIfStatus(
        createDomainEvent({
          type: 'AGENT_RUNTIME_LOST',
          taskId: current.taskId,
          iterationId: current.iterationId,
          runId: current.id,
          worktreeId: current.worktreeId,
          agentSessionId: current.sessionId,
          serverInstanceId,
          source: 'provider',
          payload: { reason }
        }),
        ACTIVE_RUN_STATES
      );
    });
  }

  private scheduleRestart(): void {
    if (
      this.inboundMaterializationRecoveryFailure ||
      this.restartTimer ||
      this.restartAttempt >= this.restartDelaysMs.length
    ) {
      return;
    }
    const delay = this.restartDelaysMs[this.restartAttempt++];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.ensureClient()
        .then(() => this.refreshPreflight(true))
        .then(() => this.reconcile())
        .then(() => {
          this.restartAttempt = 0;
        })
        .catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private async recordReconciliation(
    run: RunRecord,
    status: RunRecord['status'],
    recoveryState: RunRecord['recoveryState'],
    terminal: boolean
  ): Promise<RunRecord | undefined> {
    return this.serializeRunSettlement(run.id, async () => {
      const current = await this.store.getRun(run.id);
      if (
        !current ||
        (!ACTIVE_RUN_STATES.includes(current.status) &&
          !(terminal && current.status === status))
      ) {
        return current;
      }
      return this.recordReconciliationOwned(
        current,
        status,
        recoveryState,
        terminal
      );
    });
  }

  private async recordReconciliationOwned(
    run: RunRecord,
    status: RunRecord['status'],
    recoveryState: RunRecord['recoveryState'],
    terminal: boolean
  ): Promise<RunRecord | undefined> {
    await this.store.appendRunEventIfStatus(
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
      }),
      [run.status]
    );
    return this.store.getRun(run.id);
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
    const safeGoal = this.redactProviderValue(input.goal);
    return this.store.recordAgentGoalSnapshot({
      taskId: input.session.taskId,
      iterationId: input.session.iterationId,
      sessionId: input.session.id,
      runtimeId: input.session.runtimeId,
      taskGoalHash,
      lastSynchronizedTaskGoalHash:
        input.source === 'TASK_MONKI_SYNC' || providerGoalHash === taskGoalHash
          ? taskGoalHash
          : latest?.lastSynchronizedTaskGoalHash,
      ...mapGoalFields(safeGoal),
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
      runtimeId: session.runtimeId,
      source,
      settings: this.sanitizeProviderSettings(settings),
      detail: detail
        ? redactCredentialText(detail, this.sensitiveValues)
        : undefined,
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

  private redactProviderValue<T>(value: T): T {
    return redactCredentialValue(value, this.sensitiveValues);
  }

  /**
   * Provider-reported settings are later used to route models and enforce
   * permissions. If an actionable value collides with an inherited secret,
   * omitting it is safer than persisting a redaction marker as an identifier.
   */
  private sanitizeProviderSettings(
    settings: AgentExecutionSettings
  ): AgentExecutionSettings {
    const safe = this.redactProviderValue(settings);
    if (safe.runtimeId !== settings.runtimeId) delete safe.runtimeId;
    if (safe.model !== settings.model) delete safe.model;
    if (safe.modelProvider !== settings.modelProvider) delete safe.modelProvider;
    if (safe.reasoningEffort !== settings.reasoningEffort) delete safe.reasoningEffort;
    if (safe.serviceTier !== settings.serviceTier) delete safe.serviceTier;
    if (safe.sandbox !== settings.sandbox) delete safe.sandbox;
    if (safe.approvalPolicy !== settings.approvalPolicy) delete safe.approvalPolicy;
    if (safe.approvalsReviewer !== settings.approvalsReviewer) {
      delete safe.approvalsReviewer;
    }
    if (JSON.stringify(safe.runtimeOptions) !== JSON.stringify(settings.runtimeOptions)) {
      delete safe.runtimeOptions;
    }
    return safe;
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

  /**
   * `thread/start` allocates an empty thread on the live App Server, but Codex
   * does not write a resumable rollout until the first turn starts. Reuse that
   * empty thread only while its permission profile is attested on the current
   * server generation. After a restart (or any profile change), replacing the
   * empty thread is safe because no provider input has been submitted yet.
   */
  private async prepareUnmaterializedThreadForTurn(
    inputSession: AgentSessionRecord,
    settings: AgentExecutionSettings,
    attachments: readonly AgentTurnAttachment[]
  ): Promise<{
    session: AgentSessionRecord;
    client: CodexRpcClient;
    serverInstanceId: string;
    providerSessionId: string;
    profileFingerprint: string;
    inboundFailureGeneration: number;
  }> {
    let session = inputSession;
    const attachmentPaths = attachments
      .map((attachment) => attachment.path)
      .sort((left, right) => left.localeCompare(right));
    const config = codexPermissionProfileConfig({
      sessionId: session.id,
      settings,
      worktreePath: session.worktreePath,
      attachmentPaths
    });
    const requiredFingerprint = threadStartProfileFingerprint(settings, config);
    let client = await this.ensureClient();
    let server = this.supervisor.currentServer;
    let attestation = this.unmaterializedThreadAttestations.get(session.id);
    const isCurrentAttestation = () =>
      Boolean(
        server &&
          client.serverInstanceId === server.id &&
          session.providerSessionId &&
          session.observedSettings &&
          attestation?.providerSessionId === session.providerSessionId &&
          attestation.serverInstanceId === server.id &&
          attestation.profileFingerprint === requiredFingerprint
      );

    if (!isCurrentAttestation()) {
      session = await this.startUnmaterializedProviderThread(
        session,
        settings,
        attachments
      );
      client = await this.ensureClient();
      server = this.supervisor.currentServer;
      attestation = this.unmaterializedThreadAttestations.get(session.id);
    }

    if (
      !server ||
      !session.providerSessionId ||
      !attestation ||
      !isCurrentAttestation()
    ) {
      throw new AgentProviderSessionMissingError(
        'thread/start',
        'Codex empty thread is not attested on the current App Server generation.'
      );
    }
    return {
      session,
      client,
      serverInstanceId: server.id,
      providerSessionId: session.providerSessionId,
      profileFingerprint: requiredFingerprint,
      inboundFailureGeneration: attestation.inboundFailureGeneration
    };
  }

  /**
   * A JSON-RPC error response proves that `turn/start` was rejected, but a
   * provider notification parsed immediately before that response may already
   * carry stronger evidence. Drain those notifications first and only clear
   * the durable no-resend fence when the same local run still has no provider
   * turn correlation and still owns the same provider thread.
   */
  private async restoreEmptyThreadAfterFirstTurnDidNotStart(input: {
    localRunId: string;
    localSessionId: string;
    providerSessionId: string;
    expectedInboundFailureGeneration: number | undefined;
  }): Promise<boolean> {
    let restored = false;
    let failure: unknown;
    // Put the proof and write on the same queue as provider notifications so
    // a newly parsed turn event cannot race between the evidence check and the
    // materialization update.
    this.enqueueInbound(async () => {
      try {
        const [run, session] = await Promise.all([
          this.store.getRun(input.localRunId),
          this.store.getAgentSession(input.localSessionId)
        ]);
        if (
          !run ||
          run.sessionId !== input.localSessionId ||
          run.providerTurnId ||
          !session ||
          session.providerSessionId !== input.providerSessionId ||
          input.expectedInboundFailureGeneration === undefined ||
          this.inboundMaterializationFailureGeneration !==
            input.expectedInboundFailureGeneration
        ) {
          return;
        }
        await this.store.updateAgentSession(session.id, { materialized: false });
        restored = true;
      } catch (cause) {
        failure = cause;
      }
    });
    await this.inboundQueue;
    if (failure !== undefined) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      throw new AgentMutationAmbiguousError(
        'turn/start',
        `Task Monki could not durably restore the empty Codex thread after the first turn did not start. The no-resend fence remains in place. ${detail}`
      );
    }
    return restored;
  }

  private async resumeSessionWithProfile(
    session: AgentSessionRecord,
    providerSessionId: string,
    settings: AgentExecutionSettings,
    attachmentPaths: readonly string[]
  ) {
    const client = await this.ensureClient();
    let response;
    try {
      response = await client.requestMutation('thread/resume', {
        threadId: providerSessionId,
        model: settings.model ?? null,
        modelProvider: settings.modelProvider ?? null,
        serviceTier: settings.serviceTier ?? null,
        cwd: session.worktreePath,
        approvalPolicy: toApprovalPolicy(settings),
        approvalsReviewer: toApprovalsReviewer(settings),
        config: codexPermissionProfileConfig({
          sessionId: session.id,
          settings,
          worktreePath: session.worktreePath,
          attachmentPaths
        })
      });
    } catch (error) {
      throw mapMutationError('thread/resume', error);
    }
    await this.assertProviderPermissionProfileOrFence({
      sessionId: session.id,
      worktreePath: session.worktreePath,
      operation: 'thread/resume',
      providerReference: response.thread.id,
      response
    });
    return response;
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
      type: 'runtime.updated',
      taskId: 'runtime:codex',
      payload: this.getProviderState(),
      at: new Date().toISOString()
    });
  }

  private async resolveBlockedInteraction(
    interaction: InteractionRequestRecord
  ): Promise<void> {
    const decision: AgentInteractionDecision =
      interaction.type === 'DYNAMIC_TOOL'
        ? {
            interactionType: 'DYNAMIC_TOOL',
            action: 'REJECT_UNREGISTERED'
          }
        : {
            interactionType: 'USER_INPUT',
            action: 'ANSWER',
            answers: {}
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
        const run = await this.store.getRun(interaction.runId);
        if (run) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.store.appendEvent(
            createDomainEvent({
              type: 'AGENT_MUTATION_AMBIGUOUS',
              taskId: run.taskId,
              iterationId: run.iterationId,
              runId: run.id,
              worktreeId: run.worktreeId,
              agentSessionId: run.sessionId,
              serverInstanceId: run.serverInstanceId,
              source: 'provider',
              payload: {
                operation:
                  interaction.type === 'DYNAMIC_TOOL'
                    ? 'dynamic-tool/reject'
                    : 'user-input/empty-response',
                reason,
                automaticResubmission: false
              }
            })
          );
          this.appEvents.emit({
            type: 'run.activity',
            taskId: run.taskId,
            iterationId: run.iterationId,
            runId: run.id,
            worktreeId: run.worktreeId,
            payload: {
              eventType: 'mutation/ambiguous',
              operation:
                interaction.type === 'DYNAMIC_TOOL'
                  ? 'dynamic-tool/reject'
                  : 'user-input/empty-response'
            },
            at: new Date().toISOString()
          });
        }
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

function inboundNotificationRecoveryTarget(
  notification: ServerNotification
): InboundNotificationRecoveryTarget | undefined {
  const params = notification.params as unknown as {
    threadId?: unknown;
    turnId?: unknown;
    thread?: { id?: unknown };
    turn?: { id?: unknown };
  };
  const threadId =
    typeof params.threadId === 'string'
      ? params.threadId
      : typeof params.thread?.id === 'string'
        ? params.thread.id
        : undefined;
  const providerTurnId =
    typeof params.turnId === 'string'
      ? params.turnId
      : typeof params.turn?.id === 'string'
        ? params.turn.id
        : undefined;
  return threadId || providerTurnId ? { threadId, providerTurnId } : undefined;
}

function inboundRecoveryTargetsOverlap(
  candidate: InboundNotificationRecoveryTarget | undefined,
  active: InboundNotificationRecoveryTarget | undefined
): boolean {
  if (!candidate || !active) {
    return false;
  }
  return Boolean(
    (candidate.providerTurnId &&
      active.providerTurnId &&
      candidate.providerTurnId === active.providerTurnId) ||
      (candidate.threadId && active.threadId && candidate.threadId === active.threadId)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactOptionalProviderText(
  value: string | null | undefined,
  sensitiveValues: readonly string[]
): string | undefined {
  return value ? redactCredentialText(value, sensitiveValues) : undefined;
}

/**
 * Retains only a suffix that could still become an inherited credential when
 * the next chunk from the same provider stream arrives.
 */
function credentialPrefixCarryLength(
  value: string,
  sensitiveValues: readonly string[]
): number {
  let longest = 0;
  for (const sensitive of sensitiveValues) {
    const candidateLimit = Math.min(value.length, sensitive.length - 1);
    for (let length = candidateLimit; length > longest; length -= 1) {
      if (value.endsWith(sensitive.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
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
  if (
    /\bthread not found:/i.test(mapped.message) ||
    /\bno rollout found for thread id\b/i.test(mapped.message)
  ) {
    return new AgentProviderSessionMissingError(operation, mapped.message);
  }
  return mapped;
}

function postAcknowledgementPersistenceError(
  operation: string,
  providerReference: string
): AgentMutationAmbiguousError {
  return new AgentMutationAmbiguousError(
    operation,
    `Codex acknowledged ${operation} (${providerReference}), but Task Monki could not persist the acknowledgement. The provider mutation requires recovery and must not be resubmitted automatically.`
  );
}

function assertProviderPermissionProfile(
  sessionId: string,
  worktreePath: string,
  response: unknown
): void {
  assertCodexPermissionProfileEvidence({
    sessionId,
    worktreePath,
    response: response as CodexPermissionProfileEvidence
  });
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

function threadStartProfileFingerprint(
  settings: AgentExecutionSettings,
  config: Record<string, unknown>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        model: settings.model ?? null,
        modelProvider: settings.modelProvider ?? null,
        serviceTier: settings.serviceTier ?? null,
        approvalPolicy: toApprovalPolicy(settings),
        approvalsReviewer: toApprovalsReviewer(settings),
        config
      })
    )
    .digest('hex');
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

function codexFailureReadiness(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CodexRuntimeResolutionError) {
    const found = error.diagnostics.length > 0;
    const status = found ? 'INCOMPATIBLE' : 'NOT_INSTALLED';
    return createRuntimeReadiness(
      status,
      found
        ? 'No installed Codex executable exposes the required App Server contract.'
        : 'Codex was not found on this computer.',
      {
        checks: {
          discovery: found ? 'FOUND' : 'NOT_FOUND',
          compatibility: found ? 'INCOMPATIBLE' : 'UNKNOWN',
          initialization: 'NOT_STARTED'
        },
        diagnostics: [
          errorDiagnostic(
            found ? 'RUNTIME_INCOMPATIBLE' : 'RUNTIME_NOT_INSTALLED',
            found ? 'COMPATIBILITY' : 'DISCOVERY',
            message
          )
        ],
        nextAction: {
          kind: found ? 'CONFIGURE' : 'INSTALL',
          label: found ? 'Choose a compatible executable' : 'Install Codex'
        }
      }
    );
  }
  return createRuntimeReadiness('FAILED', message, {
    checks: { initialization: 'FAILED' },
    diagnostics: [
      errorDiagnostic('RUNTIME_INITIALIZATION_FAILED', 'INITIALIZATION', message)
    ],
    nextAction: { kind: 'RETRY', label: 'Retry runtime' }
  });
}
