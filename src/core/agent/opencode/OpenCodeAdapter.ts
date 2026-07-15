import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentExecutionSettings,
  AgentInteractionDecision,
  AgentJsonValue,
  AgentModel,
  AgentPreflight,
  AgentProtocolMessageReference,
  AgentRuntimeCapabilities,
  AgentSessionRecord,
  AgentSessionSnapshot,
  InteractionRequestRecord,
  RunRecord
} from '../../../shared/contracts';
import type { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import {
  type AgentTurnAttachment
} from '../AgentAttachmentDelivery';
import {
  redactCredentialText,
  redactCredentialValue
} from '../AgentCredentialRedaction';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  type AgentInteractionResponse,
  type AgentReconciliationResult,
  type AgentRuntimeAdapter,
  type AgentSessionRef,
  type AgentTurn,
  type CreateAgentSession,
  type ForkAgentSession,
  type InterruptAgentTurn,
  type ResolvedAgentExecution,
  type ResolveAgentExecution,
  type StartAgentTurn
} from '../AgentRuntimeAdapter';
import {
  appendRuntimeDiagnostic,
  createRuntimeReadiness,
  errorDiagnostic,
  warningDiagnostic
} from '../AgentRuntimeReadiness';
import {
  buildInteractionPolicy,
  interactionTerminalStatus
} from '../AgentInteractionPolicy';
import {
  mapOpenCodeInteractionResponse,
  mapOpenCodePermission,
  mapOpenCodeQuestion,
  openCodePermissionRules,
  assertOpenCodeExecutionSettings,
  type MappedOpenCodeInteraction
} from './OpenCodeInteractionMapper';
import {
  OpenCodeAmbiguousMutationError,
  OpenCodeHttpError,
  type OpenCodeClientTransport
} from './OpenCodeHttpClient';
import {
  asRecord,
  mapOpenCodeModels,
  mapOpenCodePartStatus,
  mapOpenCodePartType,
  mapOpenCodeSessionStatus,
  mapOpenCodeTodoSteps,
  mapOpenCodeUsage,
  normalizeOpenCodeEvent,
  openCodeErrorDiagnostic,
  parseOpenCodeMessages,
  parseOpenCodePermissions,
  parseOpenCodeProviderCatalog,
  parseOpenCodeQuestions,
  parseOpenCodeSession,
  parseOpenCodeSessions,
  type OpenCodeEvent,
  type OpenCodeMessage,
  type OpenCodeMessageInfo,
  type OpenCodePart,
  type OpenCodePermissionRequest,
  type OpenCodeQuestionRequest,
  type OpenCodeSession
} from './OpenCodeProtocol';
import {
  OPENCODE_RUNTIME_DESCRIPTOR,
  opencodeCapabilities
} from './opencodeCapabilities';
import {
  OpenCodeServerSupervisor,
  type OpenCodeServerSupervisorOptions,
  type OpenCodeSessionSupervisor
} from './OpenCodeServerSupervisor';
import {
  OPENCODE_RUNTIME_ID,
  OpenCodeRuntimeResolutionError,
  resolveOpenCodeRuntime,
  type OpenCodeRuntimeResolverOptions,
  type ResolvedOpenCodeRuntime
} from './OpenCodeRuntimeResolver';
import { openCodeSensitiveEnvironmentValues } from './OpenCodeEnvironmentPolicy';
import {
  agentReviewStatusFromResult,
  parseAgentReviewResult
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
const TERMINAL_RUN_STATES: RunRecord['status'][] = [
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'LOST'
];
const RECOVERY_DELAYS_MS = [500, 1_000, 2_000, 5_000];
const STREAM_OUTPUT_FLUSH_MS = 75;
const STREAM_OUTPUT_FLUSH_BYTES = 64 * 1024;
const MAX_BUFFERED_STREAM_PARTS_PER_RUN = 8;
const OPENCODE_CATALOG_REFRESH_MS = 250;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INTERRUPT_COMPLETION_TIMEOUT_MS = 6_000;
const MAX_INTERRUPT_RECONCILIATION_WINDOW_MS = 1_500;
const MAX_TRACKED_ASSISTANT_MESSAGES_PER_SESSION = 2_048;
const OPENCODE_CATALOG_EVENTS = new Set([
  'models-dev.refreshed',
  'catalog.updated',
  'config.updated',
  'provider.updated',
  'integration.updated',
  'integration.connection.updated',
  'installation.updated'
]);

class OpenCodeRuntimeGenerationChangedError extends Error {
  readonly name = 'OpenCodeRuntimeGenerationChangedError';
}

interface BufferedOpenCodeStreamPart {
  part: OpenCodePart;
  raw: AgentProtocolMessageReference;
  status: ReturnType<typeof mapOpenCodePartStatus>;
  type: ReturnType<typeof mapOpenCodePartType>;
  eventCount: number;
}

interface OpenCodeRunStreamBuffer {
  runId: string;
  sessionId: string;
  parts: Map<string, BufferedOpenCodeStreamPart>;
  output: Array<{ source: string; chunks: string[] }>;
  outputBytes: number;
  timer?: NodeJS.Timeout;
}

interface OpenCodeInterruptDeadline {
  runId: string;
  sessionId: string;
  providerTurnId: string;
  serverInstanceId: string;
  deadlineAt: number;
  evidence?: 'ACTIVE' | 'UNCERTAIN';
  probeCount: number;
  timer?: NodeJS.Timeout;
}

export interface OpenCodeAdapterOptions
  extends Omit<OpenCodeRuntimeResolverOptions, 'cwd'>,
    Pick<OpenCodeServerSupervisorOptions, 'requestTimeoutMs' | 'startupTimeoutMs'> {
  cwd: string;
  /** Explicit construction seam for deterministic lifecycle/protocol tests. */
  runtimeResolver?: typeof resolveOpenCodeRuntime;
  /** Explicit construction seam; production uses OpenCodeServerSupervisor. */
  supervisorFactory?: (
    store: FileTaskStore,
    options: OpenCodeServerSupervisorOptions
  ) => OpenCodeSessionSupervisor;
  /** Keeps inactive per-session loopback processes bounded; primarily shortened by lifecycle tests. */
  sessionIdleTimeoutMs?: number;
  /** Total post-acknowledgement window for OpenCode to prove interruption. */
  interruptCompletionTimeoutMs?: number;
}

export class OpenCodeAdapter implements AgentRuntimeAdapter {
  readonly descriptor = OPENCODE_RUNTIME_DESCRIPTOR;

  private runtime?: ResolvedOpenCodeRuntime;
  private operationalModels: AgentModel[] = [];
  private models: AgentModel[] = [];
  private nativeCatalogState?: AgentJsonValue;
  private preflightState: AgentPreflight = {
    runtime: OPENCODE_RUNTIME_DESCRIPTOR,
    readiness: createRuntimeReadiness(
      'INITIALIZING',
      'OpenCode has not been initialized.',
      { checks: { initialization: 'NOT_STARTED' } }
    ),
    capabilities: opencodeCapabilities(),
  };
  private readonly supervisors = new Map<string, OpenCodeSessionSupervisor>();
  private readonly eventStreams = new Map<string, { stop(): void }>();
  private readonly sessionOperationQueues = new Map<string, Promise<void>>();
  private readonly retiredSessionOperationQueues = new Set<Promise<void>>();
  private readonly streamBuffers = new Map<string, OpenCodeRunStreamBuffer>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleEvictionTimers = new Map<string, NodeJS.Timeout>();
  private readonly interruptDeadlines = new Map<string, OpenCodeInterruptDeadline>();
  private readonly reconciliationCounts = new Map<string, number>();
  private readonly sessionQuarantinePromises = new Map<string, Promise<void>>();
  private readonly sessionClosePromises = new Map<string, Promise<void>>();
  private readonly sessionRuntimeFences = new Map<string, Error>();
  private readonly assistantMessageParents = new Map<string, Map<string, string>>();
  private catalogSupervisor?: OpenCodeSessionSupervisor;
  private catalogRefreshTimer?: NodeJS.Timeout;
  private catalogRefreshPromise?: Promise<void>;
  private runtimeConfigurationResetTimer?: NodeJS.Timeout;
  private runtimeConfigurationApplyPromise?: Promise<void>;
  private configuredExecutable?: string;
  private runtimeReconfigurationPending = false;
  private initialized = false;
  private shuttingDown = false;
  private readonly sensitiveValues: readonly string[];
  private readonly interruptCompletionTimeoutMs: number;

  constructor(
    private readonly store: FileTaskStore,
    private readonly appEvents: AppEventBus,
    private readonly options: OpenCodeAdapterOptions
  ) {
    this.configuredExecutable = normalizeExecutableOverride(options.executable);
    this.sensitiveValues = openCodeSensitiveEnvironmentValues(
      options.environment ?? process.env
    );
    this.interruptCompletionTimeoutMs = positiveTimeout(
      options.interruptCompletionTimeoutMs,
      DEFAULT_INTERRUPT_COMPLETION_TIMEOUT_MS
    );
  }

  async initialize(): Promise<void> {
    await this.initializeRuntime(true);
  }

  private async initializeRuntime(reconcilePersistedRuns: boolean): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.shuttingDown = false;
    try {
      await this.recoverPersistedRuntimeLosses();
      this.runtime = await (this.options.runtimeResolver ?? resolveOpenCodeRuntime)({
        ...this.options,
        executable: this.configuredExecutable,
        cwd: this.options.cwd
      });
      await this.refreshCatalog();
      if (reconcilePersistedRuns) await this.reconcile();
    } catch (cause) {
      this.preflightState = {
        runtime: this.descriptor,
        readiness: openCodeFailureReadiness(cause, this.sensitiveValues),
        capabilities: opencodeCapabilities(),
      };
      await this.shutdown().catch(() => undefined);
      this.initialized = false;
      this.runtime = undefined;
      this.operationalModels = [];
      this.models = [];
      this.nativeCatalogState = undefined;
      throw cause;
    }
  }

  preflight(): Promise<AgentPreflight> {
    return Promise.resolve(structuredClone(this.preflightState));
  }

  capabilities(): Promise<AgentRuntimeCapabilities> {
    return Promise.resolve(opencodeCapabilities());
  }

  async listModels(): Promise<AgentModel[]> {
    if (!this.runtime) {
      this.runtime = await (this.options.runtimeResolver ?? resolveOpenCodeRuntime)({
        ...this.options,
        executable: this.configuredExecutable,
        cwd: this.options.cwd
      });
    }
    if (this.operationalModels.length === 0) await this.refreshCatalog();
    return structuredClone(this.models);
  }

  readNativeState(): Promise<AgentJsonValue | undefined> {
    return Promise.resolve(
      this.nativeCatalogState === undefined
        ? undefined
        : structuredClone(this.nativeCatalogState)
    );
  }

  async configureRuntime(input: { executable?: string; restart: boolean }): Promise<void> {
    const executable = normalizeExecutableOverride(input.executable);
    const changed = executable !== this.configuredExecutable;
    this.configuredExecutable = executable;
    if (!changed && !input.restart) return;

    if (await this.hasActiveRuntimeWork()) {
      this.runtimeReconfigurationPending = true;
      this.preflightState = appendRuntimeDiagnostic(
        this.preflightState,
        warningDiagnostic(
          'RUNTIME_RESTART_REQUIRED',
          'CONFIGURATION',
          'The OpenCode runtime configuration is saved and will be applied after active provider work reaches a definitive terminal state.'
        )
      );
      this.emitRuntimeUpdate();
      return;
    }

    const shouldReinitialize = this.initialized || input.restart;
    await this.resetRuntimeForConfiguration();
    if (shouldReinitialize) await this.initialize();
  }

  async resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution> {
    await this.applyPendingRuntimeConfiguration();
    assertOpenCodeManagedAttachmentsUnsupported(input.attachments);
    const models = await this.listModels();
    return this.resolveExecutionFromModels(
      input,
      models,
      'application OpenCode catalog',
      true
    );
  }

  private resolveExecutionFromModels(
    input: ResolveAgentExecution,
    models: readonly AgentModel[],
    catalogLabel: string,
    allowDeferredExplicitSelection = false
  ): ResolvedAgentExecution {
    if (
      (input.settings.modelProvider &&
        !this.isSafeOperationalIdentifier(input.settings.modelProvider)) ||
      (input.settings.model &&
        !this.isSafeOperationalIdentifier(input.settings.model)) ||
      (input.settings.reasoningEffort &&
        !this.isSafeOperationalIdentifier(input.settings.reasoningEffort))
    ) {
      throw new Error(
        'OpenCode rejected a model selection whose operational identifier matches a runtime credential.'
      );
    }
    const matchingProvider = input.settings.modelProvider
      ? models.filter((candidate) => candidate.modelProvider === input.settings.modelProvider)
      : models;
    const exact = matchingProvider.filter(
      (candidate) => candidate.id === input.settings.model || candidate.model === input.settings.model
    );
    if (exact.length > 1 && !input.settings.modelProvider) {
      throw new Error(
        `OpenCode model ${input.settings.model} exists for multiple providers; select a provider explicitly.`
      );
    }
    let deferredSelection = false;
    let model = exact[0];
    if (input.settings.model && exact.length === 0) {
      if (allowDeferredExplicitSelection && input.settings.modelProvider) {
        model = deferredOpenCodeModel(
          input.settings.modelProvider,
          input.settings.model,
          input.settings.reasoningEffort
        );
        deferredSelection = true;
      } else {
        const provider = input.settings.modelProvider
          ? ` for provider ${input.settings.modelProvider}`
          : '';
        throw new Error(
          `OpenCode model ${input.settings.model}${provider} is not available in the ${catalogLabel}. Refresh the provider catalog or select an available model.`
        );
      }
    }
    model ??= matchingProvider.find((candidate) => candidate.isDefault) ?? matchingProvider[0];
    if (!model) {
      throw new Error(
        `OpenCode did not report an available connected model in the ${catalogLabel}${input.settings.modelProvider ? ` for provider ${input.settings.modelProvider}` : ''}.`
      );
    }
    const variant = input.settings.reasoningEffort ?? model.defaultReasoningEffort;
    if (
      variant &&
      !deferredSelection &&
      !model.supportedReasoningEfforts.includes(variant)
    ) {
      throw new Error(`OpenCode variant ${variant} is not supported by ${model.displayName}.`);
    }
    const settings: AgentExecutionSettings = {
      ...input.settings,
      runtimeId: this.descriptor.id,
      model: model.model,
      modelProvider: model.modelProvider,
      reasoningEffort: variant,
      serviceTier: undefined
    };
    assertOpenCodeExecutionSettings(settings);
    return { settings, model };
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    await this.applyPendingRuntimeConfiguration();
    let session = await this.requireSession(input.localSessionId);
    this.assertSessionOwnership(session);
    assertOpenCodeExecutionSettings(input.settings);
    if (session.providerSessionId) {
      return this.attachSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
    }
    const { client, server } = await this.ensureSessionRuntime(session);
    const projectCatalog = parseOpenCodeProviderCatalog(
      (await client.get<unknown>('/provider')).data
    );
    const selectedSettings = this.resolveExecutionFromModels(
      { settings: input.settings, attachments: [] },
      this.safePublishedModels(mapOpenCodeModels(projectCatalog)),
      `worktree catalog for ${session.worktreePath}`
    ).settings;
    const ownershipTitle = openCodeOwnershipTitle(session.id);
    const existingProviderSession = parseOpenCodeSessions(
      (await client.get<unknown>('/session')).data
    ).find(
      (candidate) =>
        candidate.metadata?.taskMonkiSessionId === session.id ||
        candidate.title === ownershipTitle
    );
    if (existingProviderSession) {
      if (!this.isSafeOperationalIdentifier(existingProviderSession.id)) {
        await this.quarantineSessionRuntime(
          session.id,
          'session/discovery',
          'OpenCode returned a session identifier matching a runtime credential.'
        );
        throw new Error(
          'OpenCode cannot attach the discovered session because its identifier matches a runtime credential.'
        );
      }
      await this.assertSessionDirectoryOrQuarantine(
        session.id,
        'session/discovery',
        existingProviderSession,
        session.worktreePath
      );
      session = await this.store.updateAgentSession(session.id, {
        providerSessionId: existingProviderSession.id,
        providerSessionTreeId: existingProviderSession.id,
        status: await this.readProviderSessionStatus(client, existingProviderSession.id),
        materialized: true,
        requestedSettings: selectedSettings,
        observedSettings: this.safeObservedSettings(
          settingsFromSession(existingProviderSession, selectedSettings)
        ),
        lastAttachedAt: new Date().toISOString()
      });
      await this.bindEventStream(session, client, server.id);
      if (session.status === 'IDLE') this.scheduleSessionIdleEviction(session.id);
      return session;
    }
    let response: OpenCodeSession;
    try {
      response = parseOpenCodeSession(
        (
          await client.post<unknown>('/session', {
          title: ownershipTitle,
          model: modelReference(selectedSettings),
          metadata: {
            taskMonkiSessionId: session.id,
            taskMonkiTaskId: input.taskId
          },
          permission: openCodePermissionRules(selectedSettings)
          })
        ).data
      );
    } catch (cause) {
      const error = mapOpenCodeMutationError('session/create', cause);
      if (error instanceof AgentMutationAmbiguousError) {
        await this.throwAmbiguousAfterQuarantine(
          session.id,
          'session/create',
          'The provider may have created a session whose identity was not confirmed.',
          error
        );
      }
      throw error;
    }
    await this.assertSessionDirectoryOrQuarantine(
      session.id,
      'session/create',
      response,
      session.worktreePath
    );
    if (!this.isSafeOperationalIdentifier(response.id)) {
      await this.throwAmbiguousAfterQuarantine(
        session.id,
        'session/create',
        'OpenCode created a session whose identifier cannot be persisted safely.',
        new AgentMutationAmbiguousError(
          'session/create',
          'OpenCode created a session whose identifier matches a runtime credential.'
        )
      );
    }
    try {
      session = await this.store.updateAgentSession(session.id, {
        providerSessionId: response.id,
        providerSessionTreeId: response.id,
        status: 'IDLE',
        materialized: false,
        requestedSettings: selectedSettings,
        observedSettings: this.safeObservedSettings(
          settingsFromSession(response, selectedSettings)
        ),
        lastAttachedAt: new Date().toISOString()
      });
    } catch (cause) {
      const persisted = await this.store.getAgentSession(session.id).catch(() => undefined);
      if (persisted?.providerSessionId === response.id) {
        session = persisted;
      } else {
        await this.throwAmbiguousAfterQuarantine(
          session.id,
          'session/create',
          `OpenCode created session ${response.id}, but Task Monki could not persist its ownership.`,
          new AgentMutationAmbiguousError(
            'session/create',
            `OpenCode created session ${response.id}, but Task Monki could not persist its ownership. A retry will recover it by Task Monki metadata instead of creating another session.`
          )
        );
      }
    }
    await this.recordSettingsObservation(
      session,
      'THREAD_START_RESPONSE',
      session.observedSettings ?? selectedSettings
    );
    await this.bindEventStream(session, client, server.id);
    this.scheduleSessionIdleEviction(session.id);
    return session;
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    await this.applyPendingRuntimeConfiguration();
    let session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    const providerSessionId = ref.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId) {
      throw new Error(`OpenCode session ${session.id} has not been materialized.`);
    }
    if (!this.isSafeOperationalIdentifier(providerSessionId)) {
      throw new Error(
        'The persisted OpenCode session identifier matches a runtime credential and cannot be attached safely.'
      );
    }
    const { client, server } = await this.ensureSessionRuntime(session);
    let response: OpenCodeSession;
    try {
      response = parseOpenCodeSession(
        (await client.get<unknown>(sessionPath(providerSessionId))).data
      );
    } catch (cause) {
      if (cause instanceof OpenCodeHttpError && cause.status === 404) {
        throw new AgentProviderSessionMissingError(
          'session/attach',
          `OpenCode session ${providerSessionId} no longer exists.`
        );
      }
      throw cause;
    }
    if (!this.isSafeOperationalIdentifier(response.id)) {
      await this.quarantineSessionRuntime(
        session.id,
        'session/attach',
        'OpenCode returned a session identifier matching a runtime credential.'
      );
      throw new Error(
        'OpenCode cannot attach the session because its returned identifier matches a runtime credential.'
      );
    }
    await this.assertSessionDirectoryOrQuarantine(
      session.id,
      'session/attach',
      response,
      session.worktreePath
    );
    const status = await this.readProviderSessionStatus(client, providerSessionId);
    session = await this.store.updateAgentSession(session.id, {
      providerSessionId: response.id,
      providerSessionTreeId: response.id,
      status,
      materialized: true,
      observedSettings: this.safeObservedSettings(
        settingsFromSession(response, session.requestedSettings)
      ),
      lastAttachedAt: new Date().toISOString()
    });
    const activeRun = await this.getCurrentRunForSession(session.id);
    if (activeRun && activeRun.serverInstanceId !== server.id) {
      await this.store.updateRun(activeRun.id, { serverInstanceId: server.id });
    }
    await this.bindEventStream(session, client, server.id);
    await this.reconcilePendingInteractions(session, client, server.id);
    if (status === 'IDLE' && !activeRun) this.scheduleSessionIdleEviction(session.id);
    return session;
  }

  async releaseSession(ref: AgentSessionRef): Promise<void> {
    const session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    const activeRun = await this.getCurrentRunForSession(session.id);
    if (activeRun) {
      throw new Error(
        `Cannot release OpenCode session ${session.id} while run ${activeRun.id} is ${activeRun.status}.`
      );
    }
    await this.closeSessionRuntime(session.id, true);
  }

  async releaseTask(taskId: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    const sessions = snapshot.agentSessions.filter(
      (session) => session.runtimeId === this.descriptor.id && session.taskId === taskId
    );
    for (const session of sessions) {
      await this.releaseSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
    }
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot> {
    let session = await this.requireSession(ref.localSessionId);
    const providerSessionId = ref.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId) return { session, runs: [] };
    if (!this.isSafeOperationalIdentifier(providerSessionId)) {
      throw new Error(
        'The OpenCode session identifier matches a runtime credential and cannot be read safely.'
      );
    }
    const { client } = await this.ensureSessionRuntime(session);
    const response = parseOpenCodeSession(
      (await client.get<unknown>(sessionPath(providerSessionId))).data
    );
    if (!this.isSafeOperationalIdentifier(response.id)) {
      await this.quarantineSessionRuntime(
        session.id,
        'session/read',
        'OpenCode returned a session identifier matching a runtime credential.'
      );
      throw new Error(
        'OpenCode cannot read the session because its returned identifier matches a runtime credential.'
      );
    }
    await this.assertSessionDirectoryOrQuarantine(
      session.id,
      'session/read',
      response,
      session.worktreePath
    );
    session = await this.store.updateAgentSession(session.id, {
      status: await this.readProviderSessionStatus(client, providerSessionId),
      materialized: true,
      observedSettings: this.safeObservedSettings(
        settingsFromSession(response, session.requestedSettings)
      ),
      lastAttachedAt: new Date().toISOString()
    });
    const snapshot = await this.store.snapshot();
    if (session.status === 'IDLE') this.scheduleSessionIdleEviction(session.id);
    return {
      session,
      runs: snapshot.runs
        .filter((run) => run.sessionId === session.id)
        .map((run) => ({ id: run.id, providerTurnId: run.providerTurnId, status: run.status }))
    };
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    await this.applyPendingRuntimeConfiguration(input.localRunId);
    return this.enqueueSessionOperation(input.session.localSessionId, () =>
      this.startTurnOwned(input)
    );
  }

  private async startTurnOwned(input: StartAgentTurn): Promise<AgentTurn> {
    const quarantine = this.sessionQuarantinePromises.get(input.session.localSessionId);
    if (quarantine) await quarantine;
    let session = await this.requireSession(input.session.localSessionId);
    this.assertSessionOwnership(session);
    assertOpenCodeManagedAttachmentsUnsupported(input.attachments ?? []);
    const settings = input.settings ?? session.requestedSettings;
    assertOpenCodeExecutionSettings(settings);
    const hadProviderSession = Boolean(session.providerSessionId);
    const previousSupervisor = this.supervisors.get(session.id);
    let running = await this.ensureSessionRuntime(session);
    const projectCatalog = parseOpenCodeProviderCatalog(
      (await running.client.get<unknown>('/provider')).data
    );
    const selectedModel = this.resolveExecutionFromModels(
      { settings, attachments: [] },
      this.safePublishedModels(mapOpenCodeModels(projectCatalog)),
      `worktree catalog for ${session.worktreePath}`
    );
    if (!session.providerSessionId) {
      session = await this.createSession({
        runtimeId: this.descriptor.id,
        localSessionId: session.id,
        taskId: session.taskId,
        iterationId: session.iterationId,
        worktreeId: session.worktreeId,
        worktreePath: session.worktreePath,
        settings: selectedModel.settings
      });
    }
    if (
      hadProviderSession &&
      session.providerSessionId &&
      this.supervisors.get(session.id) !== previousSupervisor
    ) {
      session = await this.attachSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
    }
    const providerSessionId = session.providerSessionId!;
    if (!this.isSafeOperationalIdentifier(providerSessionId)) {
      throw new Error(
        'The persisted OpenCode session identifier matches a runtime credential and cannot be used safely.'
      );
    }
    running = await this.ensureSessionRuntime(session);
    const { client, server } = running;
    await this.bindEventStream(session, client, server.id);
    if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
      throw new Error('OpenCode replaced the session runtime before prompt submission.');
    }
    const providerMessageId = providerMessageIdForRun(input.localRunId);
    await this.store.updateRun(input.localRunId, {
      providerTurnId: providerMessageId,
      serverInstanceId: server.id,
      status: 'STARTING',
      lastEventAt: new Date().toISOString()
    });
    if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
      throw new Error('OpenCode replaced the session runtime before prompt submission.');
    }
    try {
      await client.post<void>(`${sessionPath(providerSessionId)}/prompt_async`, {
        messageID: providerMessageId,
        model: {
          providerID: selectedModel.model.modelProvider,
          modelID: selectedModel.model.model
        },
        ...(selectedModel.settings.reasoningEffort
          ? { variant: selectedModel.settings.reasoningEffort }
          : {}),
        parts: [{ type: 'text', text: input.prompt }]
      });
    } catch (cause) {
      const error = mapOpenCodeMutationError('session/prompt_async', cause);
      if (error instanceof AgentMutationAmbiguousError) {
        await this.throwAmbiguousAfterQuarantine(
          session.id,
          'session/prompt_async',
          `Prompt ${providerMessageId} may have been accepted without an authoritative acknowledgement.`,
          error
        );
      }
      throw error;
    }
    if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
      throw new AgentMutationAmbiguousError(
        'session/prompt_async',
        `OpenCode accepted message ${providerMessageId}, but its owning runtime generation was replaced before Task Monki could persist the acknowledgement.`
      );
    }
    const submittedAt = new Date().toISOString();
    try {
      await this.store.updateRun(input.localRunId, {
        status: 'RUNNING',
        observedSettings: selectedModel.settings,
        attachmentSubmissions: [],
        lastEventAt: submittedAt
      });
      if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
        throw new OpenCodeRuntimeGenerationChangedError();
      }
      session = await this.store.updateAgentSession(session.id, {
        status: 'ACTIVE',
        materialized: true,
        requestedSettings: selectedModel.settings,
        observedSettings: selectedModel.settings,
        lastAttachedAt: submittedAt
      });
      if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
        throw new OpenCodeRuntimeGenerationChangedError();
      }
      await this.recordSettingsObservation(
        session,
        'TASK_MONKI_RESOLUTION',
        selectedModel.settings,
        input.localRunId
      );
    } catch (cause) {
      if (cause instanceof OpenCodeRuntimeGenerationChangedError) {
        throw new AgentMutationAmbiguousError(
          'session/prompt_async',
          `OpenCode accepted message ${providerMessageId}, but its owning runtime generation changed during durable acknowledgement.`
        );
      }
      await this.throwAmbiguousAfterQuarantine(
        session.id,
        'session/prompt_async',
        `OpenCode accepted message ${providerMessageId}, but Task Monki could not persist the acknowledgement.`,
        new AgentMutationAmbiguousError(
          'session/prompt_async',
          `OpenCode accepted message ${providerMessageId}, but Task Monki could not durably record the acknowledgement: ${errorMessage(cause)} Automatic resubmission is disabled.`
        )
      );
    }
    return { localRunId: input.localRunId, providerTurnId: providerMessageId };
  }

  async interruptTurn(input: InterruptAgentTurn): Promise<void> {
    await this.enqueueSessionOperation(input.session.localSessionId, async () => {
      const session = await this.requireSession(input.session.localSessionId);
      const providerSessionId = input.session.providerSessionId ?? session.providerSessionId;
      if (!providerSessionId) {
        throw new Error('Cannot interrupt an unmaterialized OpenCode session.');
      }
      if (!this.isSafeOperationalIdentifier(providerSessionId)) {
        throw new Error(
          'The OpenCode session identifier matches a runtime credential and cannot be interrupted safely.'
        );
      }
      const run = await this.store.getRunByProviderTurnId(
        this.descriptor.id,
        input.providerTurnId
      );
      if (!run || run.sessionId !== session.id) {
        throw new Error('The OpenCode turn does not belong to the selected session.');
      }
      const supervisor = this.supervisors.get(session.id);
      const client = supervisor?.currentClient;
      const server = supervisor?.currentServer;
      if (!client || !server || run.serverInstanceId !== server.id) {
        throw new AgentMutationAmbiguousError(
          'session/abort',
          'The OpenCode process that owns this turn is no longer available; cancellation delivery cannot be confirmed.'
        );
      }
      const controlWindowMs = this.interruptReconciliationWindowMs();
      try {
        await client.post<boolean>(
          `${sessionPath(providerSessionId)}/abort`,
          undefined,
          { deadlineAt: Date.now() + controlWindowMs }
        );
      } catch (cause) {
        const error = mapOpenCodeMutationError('session/abort', cause);
        if (error instanceof AgentMutationAmbiguousError) {
          await this.throwAmbiguousAfterQuarantine(
            session.id,
            'session/abort',
            `Cancellation of provider session ${providerSessionId} could not be confirmed.`,
            error
          );
        }
        throw error;
      }
      if (run && ACTIVE_RUN_STATES.includes(run.status)) {
        await this.store.updateRun(run.id, {
          status: 'INTERRUPTING',
          lastEventAt: new Date().toISOString()
        });
      }
      const interrupting = await this.store.getRun(run.id);
      if (!interrupting || interrupting.status !== 'INTERRUPTING') return;
      const deadline = this.armInterruptDeadline(interrupting, server.id);
      try {
        await this.reconcileInterruptOwned(
          interrupting,
          session,
          client,
          server.id,
          Math.min(deadline.deadlineAt, Date.now() + controlWindowMs)
        );
      } catch (cause) {
        const current = await this.store.getRun(run.id);
        if (current?.status === 'INTERRUPTING') {
          await this.recordRunActivity(current, 'session/abort/reconcile-deferred', {
            error: this.redactProviderText(errorMessage(cause))
          });
        }
      }
    });
  }

  private interruptReconciliationWindowMs(): number {
    return Math.max(
      1,
      Math.min(
        MAX_INTERRUPT_RECONCILIATION_WINDOW_MS,
        Math.floor(this.interruptCompletionTimeoutMs / 4)
      )
    );
  }

  private armInterruptDeadline(
    run: RunRecord,
    serverInstanceId: string
  ): OpenCodeInterruptDeadline {
    this.clearInterruptDeadline(run.id);
    const deadline: OpenCodeInterruptDeadline = {
      runId: run.id,
      sessionId: run.sessionId,
      providerTurnId: run.providerTurnId!,
      serverInstanceId,
      deadlineAt: Date.now() + this.interruptCompletionTimeoutMs,
      probeCount: 0
    };
    this.interruptDeadlines.set(run.id, deadline);
    this.scheduleInterruptProbe(deadline);
    return deadline;
  }

  private scheduleInterruptProbe(deadline: OpenCodeInterruptDeadline): void {
    const probeAt = deadline.deadlineAt - this.interruptReconciliationWindowMs();
    this.scheduleInterruptTimer(deadline, Math.max(0, probeAt - Date.now()), () =>
      this.handleInterruptProbe(deadline)
    );
  }

  private scheduleInterruptExpiration(deadline: OpenCodeInterruptDeadline): void {
    this.scheduleInterruptTimer(
      deadline,
      Math.max(0, deadline.deadlineAt - Date.now()),
      () => this.handleInterruptExpiration(deadline)
    );
  }

  private scheduleInterruptTimer(
    deadline: OpenCodeInterruptDeadline,
    delayMs: number,
    operation: () => Promise<void>
  ): void {
    if (deadline.timer) clearTimeout(deadline.timer);
    const timer = setTimeout(() => {
      if (
        this.shuttingDown ||
        this.interruptDeadlines.get(deadline.runId) !== deadline
      ) {
        return;
      }
      deadline.timer = undefined;
      void this.enqueueSessionOperation(deadline.sessionId, operation).catch((cause) =>
        this.recordProtocolIncident(deadline.sessionId, cause).catch(() => undefined)
      );
    }, delayMs);
    timer.unref();
    deadline.timer = timer;
  }

  private async handleInterruptProbe(
    deadline: OpenCodeInterruptDeadline
  ): Promise<void> {
    if (!this.isCurrentInterruptDeadline(deadline)) return;
    const run = await this.store.getRun(deadline.runId);
    if (!run || run.status !== 'INTERRUPTING') {
      this.clearInterruptDeadline(deadline.runId, deadline);
      return;
    }
    const session = await this.requireSession(deadline.sessionId);
    const client = this.supervisors.get(deadline.sessionId)?.currentClient;
    deadline.probeCount += 1;
    if (!client) {
      deadline.evidence = 'UNCERTAIN';
      this.scheduleInterruptExpiration(deadline);
      return;
    }
    try {
      const result = await this.reconcileInterruptOwned(
        run,
        session,
        client,
        deadline.serverInstanceId,
        deadline.deadlineAt
      );
      deadline.evidence = result === 'ACTIVE' ? 'ACTIVE' : 'UNCERTAIN';
    } catch (cause) {
      deadline.evidence = 'UNCERTAIN';
      const current = await this.store.getRun(deadline.runId);
      if (current?.status === 'INTERRUPTING') {
        await this.recordRunActivity(current, 'session/abort/reconcile-failed', {
          error: this.redactProviderText(errorMessage(cause))
        });
      }
    }
    if (!this.isCurrentInterruptDeadline(deadline)) return;
    const current = await this.store.getRun(deadline.runId);
    if (!current || current.status !== 'INTERRUPTING') {
      this.clearInterruptDeadline(deadline.runId, deadline);
      return;
    }
    const remainingMs = deadline.deadlineAt - Date.now();
    if (remainingMs <= 0 || deadline.probeCount >= 2) {
      this.scheduleInterruptExpiration(deadline);
      return;
    }
    const finalProbeWindowMs = Math.max(
      1,
      Math.min(250, Math.floor(this.interruptReconciliationWindowMs() / 4))
    );
    this.scheduleInterruptTimer(
      deadline,
      Math.max(0, deadline.deadlineAt - finalProbeWindowMs - Date.now()),
      () => this.handleInterruptProbe(deadline)
    );
  }

  private async handleInterruptExpiration(
    deadline: OpenCodeInterruptDeadline
  ): Promise<void> {
    if (!this.isCurrentInterruptDeadline(deadline)) return;
    const run = await this.store.getRun(deadline.runId);
    if (!run || run.status !== 'INTERRUPTING') {
      this.clearInterruptDeadline(deadline.runId, deadline);
      return;
    }
    this.clearInterruptDeadline(deadline.runId, deadline);
    const reason = deadline.evidence === 'ACTIVE'
      ? 'OpenCode acknowledged cancellation but still reported the provider session as active at the interruption deadline.'
      : 'OpenCode acknowledged cancellation but Task Monki could not prove a terminal provider state before the interruption deadline.';
    let quarantineFailure: unknown;
    try {
      await this.quarantineSessionRuntime(
        deadline.sessionId,
        'session/abort-completion',
        reason
      );
    } catch (cause) {
      quarantineFailure = cause;
    }
    const current = await this.store.getRun(deadline.runId);
    if (!current || !ACTIVE_RUN_STATES.includes(current.status)) return;
    if (!quarantineFailure) {
      await this.finalizeRun(
        current,
        'INTERRUPTED',
        `${reason} Task Monki stopped the owning OpenCode session process.`,
        '',
        'process'
      );
      return;
    }
    await this.recordReconciliation(
      current,
      'RECOVERY_REQUIRED',
      'REQUIRES_USER_ACTION',
      false
    );
    await this.recordRunActivity(current, 'session/abort/deadline-expired', {
      reason,
      quarantineError: this.redactProviderText(errorMessage(quarantineFailure))
    });
  }

  private async reconcileInterruptOwned(
    run: RunRecord,
    session: AgentSessionRecord,
    client: OpenCodeClientTransport,
    serverInstanceId: string,
    deadlineAt: number
  ): Promise<'TERMINAL' | 'ACTIVE' | 'UNCERTAIN'> {
    if (!this.isCurrentSessionServerGeneration(session.id, serverInstanceId)) {
      return 'UNCERTAIN';
    }
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) return 'UNCERTAIN';
    const messagesResult = await client.get<unknown>(
      `${sessionPath(providerSessionId)}/message`,
      { deadlineAt }
    );
    if (!this.isCurrentSessionServerGeneration(session.id, serverInstanceId)) {
      return 'UNCERTAIN';
    }
    const messages = parseOpenCodeMessages(messagesResult.data);
    const userMessage = messages.find(
      (message) => message.info.role === 'user' && message.info.id === run.providerTurnId
    );
    if (!userMessage) return 'UNCERTAIN';
    const status = await this.readProviderInterruptStatus(
      client,
      providerSessionId,
      deadlineAt
    );
    if (!this.isCurrentSessionServerGeneration(session.id, serverInstanceId)) {
      return 'UNCERTAIN';
    }
    const assistant = latestAssistantFor(messages, userMessage.info.id);
    if (
      assistant &&
      (status === 'IDLE' || isOpenCodeAbortError(assistant.info.error))
    ) {
      await this.finalizeFromSnapshot(
        run,
        session,
        assistant,
        messagesResult.raw,
        serverInstanceId
      );
      return 'TERMINAL';
    }
    if (status === 'IDLE') {
      await this.finalizeRun(
        run,
        'INTERRUPTED',
        'OpenCode acknowledged cancellation and reported the provider session idle.'
      );
      if (this.isCurrentSessionServerGeneration(session.id, serverInstanceId)) {
        await this.store.updateAgentSession(session.id, {
          status: 'IDLE',
          materialized: true
        });
        this.scheduleSessionIdleEviction(session.id);
      }
      return 'TERMINAL';
    }
    if (status === 'ACTIVE') {
      await this.store.updateAgentSession(session.id, {
        status: 'ACTIVE',
        materialized: true
      });
      return 'ACTIVE';
    }
    return 'UNCERTAIN';
  }

  private async readProviderInterruptStatus(
    client: OpenCodeClientTransport,
    providerSessionId: string,
    deadlineAt: number
  ): Promise<'IDLE' | 'ACTIVE' | 'UNKNOWN'> {
    const value = (
      await client.get<unknown>('/session/status', { deadlineAt })
    ).data;
    const statuses = asRecord(value);
    if (
      !statuses ||
      !Object.prototype.hasOwnProperty.call(statuses, providerSessionId)
    ) {
      return 'UNKNOWN';
    }
    const status = mapOpenCodeSessionStatus(statuses[providerSessionId]);
    return status === 'IDLE' ? 'IDLE' : status === 'ACTIVE' ? 'ACTIVE' : 'UNKNOWN';
  }

  private isCurrentInterruptDeadline(deadline: OpenCodeInterruptDeadline): boolean {
    return !this.shuttingDown &&
      this.interruptDeadlines.get(deadline.runId) === deadline &&
      this.isCurrentSessionServerGeneration(
        deadline.sessionId,
        deadline.serverInstanceId
      );
  }

  private clearInterruptDeadline(
    runId: string,
    expected?: OpenCodeInterruptDeadline
  ): void {
    const deadline = this.interruptDeadlines.get(runId);
    if (!deadline || (expected && deadline !== expected)) return;
    if (deadline.timer) clearTimeout(deadline.timer);
    this.interruptDeadlines.delete(runId);
  }

  private clearSessionInterruptDeadlines(sessionId: string): void {
    for (const deadline of [...this.interruptDeadlines.values()]) {
      if (deadline.sessionId === sessionId) {
        this.clearInterruptDeadline(deadline.runId, deadline);
      }
    }
  }

  async forkSession(input: ForkAgentSession): Promise<AgentSessionRecord> {
    const source = await this.requireSession(input.sourceSession.localSessionId);
    this.assertSessionOwnership(source);
    const sourceProviderId = input.sourceSession.providerSessionId ?? source.providerSessionId;
    if (!sourceProviderId) throw new Error('Cannot fork an unmaterialized OpenCode session.');
    if (!this.isSafeOperationalIdentifier(sourceProviderId)) {
      throw new Error(
        'The source OpenCode session identifier matches a runtime credential and cannot be forked safely.'
      );
    }
    const target = await this.requireSession(input.localSessionId);
    this.assertSessionOwnership(target);
    assertOpenCodeExecutionSettings(input.settings);
    if (target.id === source.id) {
      throw new Error('An OpenCode session fork requires a distinct target session.');
    }
    if (target.providerSessionId) {
      throw new Error('Cannot replace a materialized OpenCode target session with a fork.');
    }

    // OpenCode selects the fork's directory from the request context rather
    // than inheriting it from the source session. Use the target worktree's
    // directory-bound client so isolated alternatives do not fork back into
    // the source worktree.
    const { client, server } = await this.ensureSessionRuntime(target);
    let forked: OpenCodeSession;
    try {
      forked = parseOpenCodeSession(
        (await client.post<unknown>(`${sessionPath(sourceProviderId)}/fork`, {})).data
      );
    } catch (cause) {
      const error = mapOpenCodeMutationError('session/fork', cause);
      if (error instanceof AgentMutationAmbiguousError) {
        await this.throwAmbiguousAfterQuarantine(
          target.id,
          'session/fork',
          `The fork of provider session ${sourceProviderId} may have been created without a confirmed identity.`,
          error
        );
      }
      throw error;
    }
    if (!this.isSafeOperationalIdentifier(forked.id)) {
      return this.throwAmbiguousAfterQuarantine(
        target.id,
        'session/fork',
        'OpenCode created a fork whose identifier cannot be persisted safely.',
        new AgentMutationAmbiguousError(
          'session/fork',
          'OpenCode created a fork whose identifier matches a runtime credential.'
        )
      );
    }
    let stored: AgentSessionRecord;
    try {
      await assertSessionDirectory(forked, target.worktreePath);
      stored = await this.store.updateAgentSession(target.id, {
        providerSessionId: forked.id,
        providerSessionTreeId: forked.id,
        providerForkedFromSessionId: sourceProviderId,
        relationshipState: 'RESOLVED',
        status: 'IDLE',
        materialized: true,
        requestedSettings: input.settings,
        observedSettings: this.safeObservedSettings(
          settingsFromSession(forked, input.settings)
        ),
        lastAttachedAt: new Date().toISOString()
      });
    } catch (cause) {
      return this.throwAmbiguousAfterQuarantine(
        target.id,
        'session/fork',
        `OpenCode created fork ${forked.id}, but Task Monki could not persist its ownership.`,
        new AgentMutationAmbiguousError(
          'session/fork',
          `OpenCode created fork ${forked.id}, but Task Monki could not durably record its ownership: ${errorMessage(cause)} Automatic resubmission is disabled.`
        )
      );
    }
    await this.bindEventStream(stored, client, server.id);
    this.scheduleSessionIdleEviction(stored.id);
    return stored;
  }

  async respondToInteraction(input: AgentInteractionResponse): Promise<void> {
    const session = await this.requireSession(input.interaction.sessionId);
    const supervisor = this.supervisors.get(session.id);
    const server = supervisor?.currentServer;
    if (!server || server.id !== input.interaction.serverInstanceId) {
      throw new Error('OpenCode interaction belongs to a no-longer-active runtime instance.');
    }
    const { client } = await this.ensureSessionRuntime(session);
    const mapped = mapOpenCodeInteractionResponse(input.decision, input.interaction.request);
    const endpoint = mapped.path === 'question'
      ? `/question/${encodeURIComponent(String(input.interaction.providerRequestId))}/reply`
      : `/permission/${encodeURIComponent(String(input.interaction.providerRequestId))}/reply`;
    let responseRaw: AgentProtocolMessageReference;
    try {
      responseRaw = (await client.post<boolean>(endpoint, mapped.body)).raw;
    } catch (cause) {
      const operation = `${mapped.path}/reply`;
      const error = mapOpenCodeMutationError(operation, cause);
      if (error instanceof AgentMutationAmbiguousError) {
        await this.throwAmbiguousAfterQuarantine(
          session.id,
          operation,
          `The interaction reply for ${input.interaction.id} could not be confirmed.`,
          error
        );
      }
      throw error;
    }
    try {
      const latest = await this.store.getInteractionRequest(input.interaction.id);
      if (!latest) {
        throw new Error('The acknowledged interaction no longer has a durable Task Monki record.');
      }
      if (latest.status === 'PENDING') {
        throw new Error('The acknowledged interaction unexpectedly returned to pending state.');
      }
      if (latest.status !== 'RESPONDING') return;
      const resolved = await this.store.transitionInteractionRequest(latest.id, 'RESPONDING', {
        status: interactionTerminalStatus(input.decision),
        responseRawMessage: responseRaw,
        resolution: { provider: OPENCODE_RUNTIME_ID, acknowledged: true },
        resolvedAt: new Date().toISOString()
      });
      this.emitInteractionUpdate(resolved);
    } catch (cause) {
      await this.throwAmbiguousAfterQuarantine(
        session.id,
        `${mapped.path}/reply`,
        `OpenCode acknowledged interaction ${input.interaction.id}, but Task Monki could not persist its resolution.`,
        new AgentMutationAmbiguousError(
          `${mapped.path}/reply`,
          `OpenCode acknowledged the ${mapped.path} reply, but Task Monki could not durably record it: ${errorMessage(cause)} Automatic resubmission is disabled.`
        )
      );
    }
  }

  async reconcile(): Promise<AgentReconciliationResult> {
    const reconciledSessionIds = new Set<string>();
    const recoveryRequiredSessionIds = new Set<string>();
    const runs = await this.store.getRunsRequiringRecovery({
      includeQueued: true,
      runtimeId: this.descriptor.id
    });
    for (const run of runs) {
      const result = await this.reconcileRun(run);
      if (result === 'reconciled') reconciledSessionIds.add(run.sessionId);
      if (result === 'recovery-required') recoveryRequiredSessionIds.add(run.sessionId);
    }
    return {
      reconciledSessionIds: [...reconciledSessionIds],
      recoveryRequiredSessionIds: [...recoveryRequiredSessionIds]
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const deadline of this.interruptDeadlines.values()) {
      if (deadline.timer) clearTimeout(deadline.timer);
    }
    this.interruptDeadlines.clear();
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    for (const timer of this.idleEvictionTimers.values()) clearTimeout(timer);
    this.idleEvictionTimers.clear();
    if (this.catalogRefreshTimer) clearTimeout(this.catalogRefreshTimer);
    this.catalogRefreshTimer = undefined;
    if (this.runtimeConfigurationResetTimer) {
      clearTimeout(this.runtimeConfigurationResetTimer);
      this.runtimeConfigurationResetTimer = undefined;
    }
    for (const buffer of this.streamBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    for (const stream of this.eventStreams.values()) stream.stop();
    this.assistantMessageParents.clear();
    await Promise.allSettled([
      ...this.sessionOperationQueues.values(),
      ...this.retiredSessionOperationQueues
    ]);
    if (this.catalogRefreshPromise) await this.catalogRefreshPromise.catch(() => undefined);
    const failures: unknown[] = [];
    const quarantineResults = await Promise.allSettled([
      ...this.sessionQuarantinePromises.values()
    ]);
    failures.push(
      ...quarantineResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
    );
    const closeResults = await Promise.allSettled([...this.sessionClosePromises.values()]);
    failures.push(
      ...closeResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
    );
    for (const runId of [...this.streamBuffers.keys()]) {
      try {
        await this.materializeRunStreamBuffer(runId);
      } catch (cause) {
        failures.push(cause);
      }
    }
    const catalogSupervisor = this.catalogSupervisor;
    if (catalogSupervisor) {
      try {
        await catalogSupervisor.shutdown();
        if (this.catalogSupervisor === catalogSupervisor) {
          this.catalogSupervisor = undefined;
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    const supervisorEntries = [...this.supervisors.entries()];
    const supervisorResults = await Promise.allSettled(
      supervisorEntries.map(([, supervisor]) => supervisor.shutdown())
    );
    for (const [index, result] of supervisorResults.entries()) {
      const [sessionId, supervisor] = supervisorEntries[index]!;
      if (result.status === 'fulfilled') {
        if (this.supervisors.get(sessionId) === supervisor) {
          this.supervisors.delete(sessionId);
        }
        this.eventStreams.delete(sessionId);
        if (!this.sessionQuarantinePromises.has(sessionId)) {
          this.sessionRuntimeFences.delete(sessionId);
        }
      } else if (!this.sessionRuntimeFences.has(sessionId)) {
        this.sessionRuntimeFences.set(
          sessionId,
          new Error(
            `OpenCode session runtime shutdown is unconfirmed: ${errorMessage(result.reason)}`,
            { cause: result.reason }
          )
        );
      }
    }
    for (const sessionId of [...this.eventStreams.keys()]) {
      if (!this.supervisors.has(sessionId)) this.eventStreams.delete(sessionId);
    }
    this.initialized = false;
    failures.push(
      ...supervisorResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'OpenCode runtimes failed to shut down.');
    }
  }

  private async refreshCatalog(): Promise<void> {
    const runtime = this.requireRuntime();
    if (this.catalogSupervisor) {
      throw new Error(
        'OpenCode cannot launch a catalog runtime because termination of the previous catalog process is unconfirmed.'
      );
    }
    const supervisor = this.createSupervisor(runtime, this.options.cwd);
    this.catalogSupervisor = supervisor;
    let catalog: ReturnType<typeof parseOpenCodeProviderCatalog> | undefined;
    let operationFailure: unknown;
    try {
      const { client } = await supervisor.start();
      catalog = parseOpenCodeProviderCatalog((await client.get<unknown>('/provider')).data);
    } catch (cause) {
      operationFailure = cause;
    }
    let shutdownFailure: unknown;
    try {
      await supervisor.shutdown();
      if (this.catalogSupervisor === supervisor) this.catalogSupervisor = undefined;
    } catch (cause) {
      shutdownFailure = cause;
    }
    if (operationFailure && shutdownFailure) {
      throw new AggregateError(
        [operationFailure, shutdownFailure],
        'OpenCode catalog discovery failed and its temporary runtime could not be shut down safely.'
      );
    }
    if (shutdownFailure) throw shutdownFailure;
    if (operationFailure) throw operationFailure;
    if (!catalog) throw new Error('OpenCode catalog discovery returned no result.');
    this.applyCatalog(catalog, runtime);
  }

  private applyCatalog(
    catalog: ReturnType<typeof parseOpenCodeProviderCatalog>,
    runtime: ResolvedOpenCodeRuntime
  ): void {
    this.operationalModels = mapOpenCodeModels(catalog);
    this.models = this.safePublishedModels(this.operationalModels);
    const safeProviderIds = new Set(
      catalog.providers
        .map((provider) => provider.id)
        .filter((id) => this.isSafeOperationalIdentifier(id))
    );
    this.nativeCatalogState = JSON.parse(
      JSON.stringify({
        connectedProviders: catalog.connected.filter((id) => safeProviderIds.has(id)),
        defaults: Object.fromEntries(
          Object.entries(catalog.defaults).filter(
            ([providerId, modelId]) =>
              safeProviderIds.has(providerId) &&
              this.isSafeOperationalIdentifier(modelId)
          )
        ),
        providers: catalog.providers.flatMap((provider) =>
          safeProviderIds.has(provider.id)
            ? [{
                id: provider.id,
                name: this.redactProviderText(provider.name ?? provider.id),
                modelCount: Object.values(provider.models).filter((model) =>
                  this.isSafeOperationalIdentifier(model.id)
                ).length
              }]
            : []
        )
      })
    ) as AgentJsonValue;
    const providerCount = new Set(this.models.map((model) => model.modelProvider)).size;
    const connectedProviderCount = catalog.connected.length;
    const sandboxWarning = warningDiagnostic(
      'PROVIDER_PROCESS_NOT_SANDBOXED',
      'SECURITY',
      'OpenCode does not attest an OS or network sandbox.',
      'Native permission rules may gate mutations, while process filesystem and network access remain provider-controlled.'
    );
    const pendingRestartWarning = this.runtimeReconfigurationPending
      ? [
          warningDiagnostic(
            'RUNTIME_RESTART_REQUIRED',
            'CONFIGURATION',
            'The saved OpenCode executable change is pending a safe runtime restart.'
          )
        ]
      : [];
    const sensitiveIdentifierWarning =
      this.models.length < this.operationalModels.length ||
      this.operationalModels.some((model) =>
        model.supportedReasoningEfforts.some(
          (variant) => !this.isSafeOperationalIdentifier(variant)
        ) || model.inputModalities.some(
          (modality) => !this.isSafeOperationalIdentifier(modality)
        )
      ) ||
      safeProviderIds.size < catalog.providers.length
        ? [
            warningDiagnostic(
              'SENSITIVE_PROVIDER_IDENTIFIER_OMITTED',
              'SECURITY',
              'OpenCode returned provider, model, variant, or modality identifiers matching runtime credentials, so those catalog entries were omitted.',
              'Exact identifiers remain internal for provider operations and are never replaced with redacted placeholders in actionable views.'
            )
          ]
        : [];
    const readiness = this.models.length > 0
      ? createRuntimeReadiness('READY', 'OpenCode and its provider catalog are operational.', {
          checks: {
            discovery: 'FOUND',
            compatibility: 'COMPATIBLE',
            initialization: 'INITIALIZED',
            authentication: providerCount > 0 ? 'AUTHENTICATED' : 'UNKNOWN',
            modelCatalog: 'AVAILABLE'
          },
          diagnostics: [
            sandboxWarning,
            ...sensitiveIdentifierWarning,
            ...pendingRestartWarning
          ]
        })
      : connectedProviderCount === 0
        ? createRuntimeReadiness(
          'AUTHENTICATION_REQUIRED',
          'Connect at least one model provider in OpenCode.',
          {
            checks: {
              discovery: 'FOUND',
              compatibility: 'COMPATIBLE',
              initialization: 'INITIALIZED',
              authentication: 'REQUIRED',
              modelCatalog: 'EMPTY'
            },
            diagnostics: [
              errorDiagnostic(
                'NO_CONNECTED_PROVIDER_MODELS',
                'AUTHENTICATION',
                'OpenCode has no connected provider models.'
              ),
              sandboxWarning,
              ...sensitiveIdentifierWarning,
              ...pendingRestartWarning
            ],
            nextAction: { kind: 'AUTHENTICATE', label: 'Configure OpenCode providers' }
          }
        )
        : createRuntimeReadiness(
            'FAILED',
            'OpenCode connected providers did not expose any usable models.',
            {
              checks: {
                discovery: 'FOUND',
                compatibility: 'COMPATIBLE',
                initialization: 'INITIALIZED',
                authentication: 'AUTHENTICATED',
                modelCatalog: 'FAILED'
              },
              diagnostics: [
                errorDiagnostic(
                  'CONNECTED_PROVIDER_MODEL_CATALOG_EMPTY',
                  'MODEL_CATALOG',
                  'OpenCode reported connected providers but no usable models.'
                ),
                sandboxWarning,
                ...sensitiveIdentifierWarning,
                ...pendingRestartWarning
              ],
              nextAction: { kind: 'RETRY', label: 'Refresh OpenCode models' }
            }
          );
    this.preflightState = {
      runtime: this.descriptor,
      readiness,
      capabilities: opencodeCapabilities(),
      runtimeVersion: runtime.version,
      accountLabel: providerCount > 0
        ? `${providerCount} connected provider${providerCount === 1 ? '' : 's'}`
        : undefined
    };
  }

  private scheduleCatalogRefresh(): void {
    if (this.shuttingDown) return;
    if (this.catalogRefreshTimer) clearTimeout(this.catalogRefreshTimer);
    const timer = setTimeout(() => {
      if (this.catalogRefreshTimer === timer) this.catalogRefreshTimer = undefined;
      void this.refreshCatalogAfterNativeChange();
    }, OPENCODE_CATALOG_REFRESH_MS);
    timer.unref();
    this.catalogRefreshTimer = timer;
  }

  private refreshCatalogAfterNativeChange(): Promise<void> {
    if (this.catalogRefreshPromise) return this.catalogRefreshPromise;
    const refresh = (async () => {
      try {
        const activeClient = [...this.supervisors.values()]
          .map((supervisor) => supervisor.currentClient)
          .find((client): client is OpenCodeClientTransport => Boolean(client));
        if (activeClient) {
          const catalog = parseOpenCodeProviderCatalog(
            (await activeClient.get<unknown>('/provider')).data
          );
          this.applyCatalog(catalog, this.requireRuntime());
        } else {
          await this.refreshCatalog();
        }
      } catch (cause) {
        this.preflightState = appendRuntimeDiagnostic(
          this.preflightState,
          warningDiagnostic(
            'MODEL_CATALOG_REFRESH_FAILED',
            'MODEL_CATALOG',
            'OpenCode provider catalog refresh failed.',
            this.redactProviderText(errorMessage(cause))
          ),
          this.preflightState.readiness.status === 'READY' ? 'DEGRADED' : undefined
        );
      } finally {
        this.emitRuntimeUpdate();
      }
    })();
    const tracked = refresh.finally(() => {
      if (this.catalogRefreshPromise === tracked) this.catalogRefreshPromise = undefined;
    });
    this.catalogRefreshPromise = tracked;
    return tracked;
  }

  private emitRuntimeUpdate(): void {
    const payload = this.redactProviderValue({
      preflight: structuredClone(this.preflightState),
      models: structuredClone(this.models),
      native: this.nativeCatalogState === undefined
        ? undefined
        : structuredClone(this.nativeCatalogState)
    });
    this.appEvents.emit({
      type: 'runtime.updated',
      taskId: `runtime:${this.descriptor.id}`,
      payload,
      at: new Date().toISOString()
    });
  }

  private async ensureSessionRuntime(
    session: AgentSessionRecord
  ): Promise<{ client: OpenCodeClientTransport; server: { id: string } }> {
    const quarantine = this.sessionQuarantinePromises.get(session.id);
    if (quarantine) await quarantine;
    const closing = this.sessionClosePromises.get(session.id);
    if (closing) await closing;
    const fence = this.sessionRuntimeFences.get(session.id);
    if (fence) {
      throw new Error(
        `OpenCode session ${session.id} is fenced because termination of its previous runtime is unconfirmed: ${fence.message}`,
        { cause: fence }
      );
    }
    this.assertSessionOwnership(session);
    this.cancelSessionIdleEviction(session.id);
    let supervisor = this.supervisors.get(session.id);
    if (!supervisor) {
      supervisor = this.createSupervisor(this.requireRuntime(), session.worktreePath);
      supervisor.events.on('exit', (server, unexpected) => {
        if (!unexpected || this.shuttingDown) return;
        this.cancelSessionIdleEviction(session.id);
        this.eventStreams.get(session.id)?.stop();
        this.eventStreams.delete(session.id);
        this.supervisors.delete(session.id);
        void this.enqueueInbound(session.id, async () => {
          await this.handleRuntimeLoss(
            server.id,
            'OpenCode session runtime exited unexpectedly.',
            session.id
          );
          this.scheduleSessionRecovery(session.id);
        });
      });
      this.supervisors.set(session.id, supervisor);
    }
    const running = await supervisor.start();
    return { client: running.client, server: running.server };
  }

  /**
   * OpenCode servers are session-scoped. Unsafe provider state invalidates
   * only that session's process, but it must be stopped before the session can
   * be reused so late SSE events cannot cross a run boundary.
   */
  private quarantineSessionRuntime(
    sessionId: string,
    operation: string,
    detail: string
  ): Promise<void> {
    const existing = this.sessionQuarantinePromises.get(sessionId);
    if (existing) return existing;
    const quarantine = this.performSessionQuarantine(sessionId, operation, detail);
    this.sessionQuarantinePromises.set(sessionId, quarantine);
    void quarantine.then(
      () => {
        if (this.sessionQuarantinePromises.get(sessionId) === quarantine) {
          this.sessionQuarantinePromises.delete(sessionId);
        }
      },
      // Retain a rejected quarantine as a hard fence. Reusing the session
      // while its old provider process may still exist is unsafe.
      () => undefined
    );
    return quarantine;
  }

  private async throwAmbiguousAfterQuarantine(
    sessionId: string,
    operation: string,
    detail: string,
    ambiguity: AgentMutationAmbiguousError
  ): Promise<never> {
    try {
      await this.quarantineSessionRuntime(sessionId, operation, detail);
    } catch (cause) {
      throw new AgentMutationAmbiguousError(
        operation,
        `${ambiguity.message} Task Monki fenced the session from reuse, but could not fully confirm process quarantine: ${errorMessage(cause)}`
      );
    }
    throw ambiguity;
  }

  private async assertSessionDirectoryOrQuarantine(
    sessionId: string,
    operation: string,
    providerSession: OpenCodeSession,
    expectedDirectory: string
  ): Promise<void> {
    try {
      await assertSessionDirectory(providerSession, expectedDirectory);
    } catch (cause) {
      const diagnostic = this.redactProviderText(errorMessage(cause));
      try {
        await this.quarantineSessionRuntime(
          sessionId,
          operation,
          `The provider-reported session directory failed ownership verification: ${diagnostic}`
        );
      } catch (quarantineCause) {
        throw new Error(
          `${diagnostic} Task Monki fenced the session from reuse, but could not fully confirm process quarantine: ${errorMessage(quarantineCause)}`,
          { cause: quarantineCause }
        );
      }
      throw cause;
    }
  }

  private async performSessionQuarantine(
    sessionId: string,
    operation: string,
    detail: string
  ): Promise<void> {
    const fence = new Error(
      `OpenCode session runtime is quarantined after ${operation}.`
    );
    this.sessionRuntimeFences.set(sessionId, fence);
    this.retireSessionOperationQueue(sessionId);
    this.clearSessionInterruptDeadlines(sessionId);
    this.cancelSessionIdleEviction(sessionId);
    const recoveryTimer = this.recoveryTimers.get(sessionId);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    this.recoveryTimers.delete(sessionId);
    const stream = this.eventStreams.get(sessionId);
    stream?.stop();
    const supervisor = this.supervisors.get(sessionId);
    const serverId = supervisor?.currentServer?.id;
    let shutdownFailure: unknown;
    try {
      await supervisor?.shutdown();
      if (this.supervisors.get(sessionId) === supervisor) {
        this.supervisors.delete(sessionId);
      }
      if (this.eventStreams.get(sessionId) === stream) {
        this.eventStreams.delete(sessionId);
      }
    } catch (cause) {
      shutdownFailure = cause;
    }
    this.clearAssistantMessageParents(sessionId);
    const reason = `Task Monki quarantined the OpenCode session process after ${operation}. ${detail}`;
    if (serverId) await this.handleRuntimeLoss(serverId, reason, sessionId);
    const session = await this.store.getAgentSession(sessionId).catch(() => undefined);
    if (session?.status !== 'NOT_LOADED') {
      await this.store.updateAgentSession(sessionId, { status: 'NOT_LOADED' });
    }
    if (shutdownFailure) {
      throw new Error(
        `OpenCode session process quarantine was incomplete: ${errorMessage(shutdownFailure)}`,
        { cause: shutdownFailure }
      );
    }
    if (this.sessionRuntimeFences.get(sessionId) === fence) {
      this.sessionRuntimeFences.delete(sessionId);
    }
  }

  private async runForProviderMessage(
    session: AgentSessionRecord,
    providerMessageId: string,
    serverId: string
  ): Promise<RunRecord | undefined> {
    const run = await this.store.getRunByProviderTurnId(
      this.descriptor.id,
      providerMessageId
    );
    return run &&
      run.sessionId === session.id &&
      run.serverInstanceId === serverId &&
      ACTIVE_RUN_STATES.includes(run.status)
      ? run
      : undefined;
  }

  private async runForInteractionMessage(
    session: AgentSessionRecord,
    providerMessageId: string,
    serverId: string
  ): Promise<RunRecord | undefined> {
    const direct = await this.runForProviderMessage(session, providerMessageId, serverId);
    if (direct) return direct;
    let parentId = this.assistantMessageParents.get(session.id)?.get(providerMessageId);
    if (!parentId && session.providerSessionId) {
      const client = this.supervisors.get(session.id)?.currentClient;
      if (client) {
        try {
          const messages = parseOpenCodeMessages(
            (await client.get<unknown>(`${sessionPath(session.providerSessionId)}/message`)).data
          );
          const assistant = messages.find(
            (message) =>
              message.info.role === 'assistant' &&
              message.info.id === providerMessageId &&
              typeof message.info.parentID === 'string'
          );
          parentId = assistant?.info.parentID;
          if (parentId) {
            this.rememberAssistantParent(session.id, providerMessageId, parentId);
          }
        } catch {
          // The raw request remains in the journal. Fail closed and let the
          // next authoritative reconciliation retry correlation.
          return undefined;
        }
      }
    }
    return parentId
      ? this.runForProviderMessage(session, parentId, serverId)
      : undefined;
  }

  private rememberAssistantParent(
    sessionId: string,
    assistantMessageId: string,
    parentUserMessageId: string
  ): void {
    const parents = this.assistantMessageParents.get(sessionId) ?? new Map<string, string>();
    parents.delete(assistantMessageId);
    parents.set(assistantMessageId, parentUserMessageId);
    while (parents.size > MAX_TRACKED_ASSISTANT_MESSAGES_PER_SESSION) {
      const oldest = parents.keys().next().value as string | undefined;
      if (!oldest) break;
      parents.delete(oldest);
    }
    this.assistantMessageParents.set(sessionId, parents);
  }

  private clearAssistantMessageParents(sessionId: string): void {
    this.assistantMessageParents.delete(sessionId);
  }

  private createSupervisor(
    runtime: ResolvedOpenCodeRuntime,
    cwd: string
  ): OpenCodeSessionSupervisor {
    const supervisorOptions: OpenCodeServerSupervisorOptions = {
      runtime,
      cwd,
      environment: this.options.environment,
      requestTimeoutMs: this.options.requestTimeoutMs,
      startupTimeoutMs: this.options.startupTimeoutMs,
      minimumVersion: this.options.minimumVersion,
      maximumMajor: this.options.maximumMajor
    };
    return this.options.supervisorFactory
      ? this.options.supervisorFactory(this.store, supervisorOptions)
      : new OpenCodeServerSupervisor(this.store, supervisorOptions);
  }

  private async bindEventStream(
    session: AgentSessionRecord,
    client: OpenCodeClientTransport,
    serverId: string
  ): Promise<void> {
    if (this.eventStreams.has(session.id)) return;
    const supervisor = this.supervisors.get(session.id);
    const stream = client.startEventStream({
      onEvent: async (value, raw) => {
        if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
        await this.enqueueInbound(session.id, async () => {
          if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
          await this.handleEvent(value, raw, serverId);
        }, serverId);
      },
      onDisconnect: async (error) => {
        if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
        const reason = this.redactProviderText(error.message);
        await supervisor?.markDegraded(reason);
        if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
        const run = await this.getCurrentRunForSession(session.id);
        if (
          run?.serverInstanceId === serverId &&
          this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)
        ) {
          await this.recordRunActivity(run, 'runtime/sse/disconnected', { reason });
        }
      },
      onReconnect: async () => {
        if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
        await supervisor?.markRunning();
        if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
        await this.reconcileSession(session.id);
      }
    });
    this.eventStreams.set(session.id, stream);
    await supervisor?.markRunning();
  }

  private isCurrentSessionRuntime(
    sessionId: string,
    supervisor: OpenCodeSessionSupervisor | undefined,
    client: OpenCodeClientTransport,
    serverId: string
  ): boolean {
    return this.isCurrentSessionServerGeneration(sessionId, serverId) &&
      supervisor !== undefined &&
      this.supervisors.get(sessionId) === supervisor &&
      supervisor.currentClient === client;
  }

  private isCurrentSessionServerGeneration(sessionId: string, serverId: string): boolean {
    return !this.shuttingDown &&
      !this.sessionRuntimeFences.has(sessionId) &&
      this.supervisors.get(sessionId)?.currentServer?.id === serverId;
  }

  /**
   * Quarantine cuts over to a fresh session operation lane immediately. Work
   * already running on the retired lane remains tracked for shutdown, but its
   * server-generation attestations make it a no-op after the cutover. This
   * avoids waiting on an inbound handler that initiated quarantine itself.
   */
  private retireSessionOperationQueue(sessionId: string): void {
    const retired = this.sessionOperationQueues.get(sessionId);
    if (!retired) return;
    this.sessionOperationQueues.delete(sessionId);
    this.retiredSessionOperationQueues.add(retired);
    void retired.then(
      () => this.retiredSessionOperationQueues.delete(retired),
      () => this.retiredSessionOperationQueues.delete(retired)
    );
  }

  private enqueueSessionOperation<T>(
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const result = (
      this.sessionOperationQueues.get(sessionId) ?? Promise.resolve()
    ).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    const tracked = tail.finally(() => {
      if (this.sessionOperationQueues.get(sessionId) === tracked) {
        this.sessionOperationQueues.delete(sessionId);
      }
    });
    this.sessionOperationQueues.set(sessionId, tracked);
    return result;
  }

  private enqueueInbound(
    sessionId: string,
    operation: () => Promise<void>,
    serverId?: string
  ): Promise<void> {
    return this.enqueueSessionOperation(sessionId, operation).catch(async (cause) => {
      if (serverId && !this.isCurrentSessionServerGeneration(sessionId, serverId)) return;
      await this.recordProtocolIncident(sessionId, cause);
    });
  }

  private async handleEvent(
    value: unknown,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const event = normalizeOpenCodeEvent(value);
    if (OPENCODE_CATALOG_EVENTS.has(event.type)) {
      this.scheduleCatalogRefresh();
      return;
    }
    switch (event.type) {
      case 'server.connected':
        return;
      case 'session.status':
        await this.handleSessionStatus(event, serverId);
        return;
      case 'session.idle':
        await this.handleSessionIdle(event, serverId);
        return;
      case 'message.updated':
        await this.handleMessageUpdated(event, raw, serverId);
        return;
      case 'message.part.updated':
      case 'message.part.delta':
        await this.handlePartUpdated(event, raw, serverId);
        return;
      case 'todo.updated':
        await this.handleTodoUpdated(event, raw, serverId);
        return;
      case 'permission.updated':
      case 'permission.asked':
      case 'permission.v2.asked':
        await this.handlePermissionRequest(event, raw, serverId);
        return;
      case 'question.asked':
      case 'question.v2.asked':
        await this.handleQuestionRequest(event, raw, serverId);
        return;
      case 'permission.replied':
      case 'permission.v2.replied':
      case 'question.replied':
      case 'question.v2.replied':
      case 'question.rejected':
      case 'question.v2.rejected':
        await this.handleExternalInteractionResolution(event, raw, serverId);
        return;
      case 'session.created':
        await this.handleChildSession(event, raw, serverId);
        return;
      case 'session.error':
        await this.handleSessionError(event, serverId);
        return;
      default: {
        const sessionId = stringProperty(event.properties, 'sessionID');
        const session = sessionId
          ? await this.store.getAgentSessionByProviderId(this.descriptor.id, sessionId)
          : undefined;
        const run = session ? await this.getCurrentRunForSession(session.id) : undefined;
        if (
          session &&
          run?.serverInstanceId === serverId &&
          this.isCurrentSessionServerGeneration(session.id, serverId)
        ) {
          await this.recordRunActivity(run, event.type, { eventId: event.id });
        }
      }
    }
  }

  private async handleSessionStatus(event: OpenCodeEvent, serverId: string): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    if (!providerSessionId) return;
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId);
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    const status = mapOpenCodeSessionStatus(event.properties.status);
    await this.store.updateAgentSession(session.id, { status });
    const run = await this.getCurrentRunForSession(session.id);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    if (run?.serverInstanceId === serverId) {
      await this.recordRunActivity(run, 'session/status', { status: event.properties.status });
    }
    if (status === 'IDLE') {
      await this.reconcileSessionOwned(session.id, serverId);
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      this.scheduleSessionIdleEviction(session.id);
    }
  }

  private async handleSessionIdle(event: OpenCodeEvent, serverId: string): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    const session = providerSessionId
      ? await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    if (session && this.isCurrentSessionServerGeneration(session.id, serverId)) {
      await this.reconcileSessionOwned(session.id, serverId);
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      this.scheduleSessionIdleEviction(session.id);
    }
  }

  private async handleMessageUpdated(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const info = asRecord(event.properties.info) as unknown as OpenCodeMessageInfo | undefined;
    if (!info || typeof info.id !== 'string' || typeof info.sessionID !== 'string') return;
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, info.sessionID);
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    if (info.role === 'user') {
      const run = await this.runForProviderMessage(session, info.id, serverId);
      if (!run || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      const providerSettings = settingsObservedFromMessage(info, run.requestedSettings);
      const observed = this.safeObservedSettings(
        providerSettings ?? run.requestedSettings
      );
      if (run.status === 'RECOVERY_REQUIRED') {
        await this.recordReconciliation(run, 'RUNNING', 'RECOVERED', false);
        if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      }
      await this.store.updateRun(run.id, { observedSettings: observed, status: 'RUNNING' });
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      await this.store.updateAgentSession(session.id, { observedSettings: observed, status: 'ACTIVE' });
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      if (providerSettings) {
        await this.recordSettingsObservation(
          session,
          'THREAD_SETTINGS_NOTIFICATION',
          observed,
          run.id,
          raw
        );
      }
      return;
    }
    if (!info.parentID) return;
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    this.rememberAssistantParent(session.id, info.id, info.parentID);
    const run = await this.runForProviderMessage(session, info.parentID, serverId);
    if (!run || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    if (info.time?.completed || info.finish || info.error) {
      const usage = mapOpenCodeUsage(info);
      await this.store.recordAgentUsageSnapshot({
        taskId: run.taskId,
        iterationId: run.iterationId,
        sessionId: session.id,
        runId: run.id,
        runtimeId: this.descriptor.id,
        total: usage,
        last: usage,
        rawMessage: raw
      });
    }
  }

  private async handlePartUpdated(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const part = asRecord(event.properties.part) as unknown as OpenCodePart | undefined;
    if (!part || typeof part.id !== 'string' || typeof part.sessionID !== 'string') return;
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, part.sessionID);
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    let run = await this.runForProviderMessage(session, part.messageID, serverId);
    const isUserPart = Boolean(run);
    if (!run) {
      const parentId = this.assistantMessageParents.get(session.id)?.get(part.messageID);
      run = parentId
        ? await this.runForProviderMessage(session, parentId, serverId)
        : undefined;
    }
    if (!run || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    const status = mapOpenCodePartStatus(part);
    const type = isUserPart ? 'USER_MESSAGE' : mapOpenCodePartType(part);
    if (!isUserPart && (part.type === 'text' || part.type === 'reasoning')) {
      await this.bufferStreamingPart(
        run,
        session,
        event,
        part,
        raw,
        status,
        mapOpenCodePartType(part)
      );
      return;
    }
    await this.store.upsertAgentItem({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      providerItemId: part.id,
      type,
      status,
      payload: this.redactProviderValue(part),
      rawMessage: raw,
      providerStartedAt: providerTimestamp(part.state?.time?.start),
      providerCompletedAt: providerTimestamp(part.state?.time?.end)
    });
    await this.recordRunActivity(run, `item/${part.type}/${status.toLowerCase()}`, {
      providerItemId: part.id,
      tool: part.tool
    });
  }

  private async bufferStreamingPart(
    run: RunRecord,
    session: AgentSessionRecord,
    event: OpenCodeEvent,
    part: OpenCodePart,
    raw: AgentProtocolMessageReference,
    status: ReturnType<typeof mapOpenCodePartStatus>,
    type: ReturnType<typeof mapOpenCodePartType>
  ): Promise<void> {
    const buffer = this.streamBuffers.get(run.id) ?? {
      runId: run.id,
      sessionId: session.id,
      parts: new Map<string, BufferedOpenCodeStreamPart>(),
      output: [],
      outputBytes: 0
    };
    this.streamBuffers.set(run.id, buffer);

    const previousBuffered = buffer.parts.get(part.id);
    const previousPayload = previousBuffered?.part ??
      (await this.store.getAgentItemByProviderId(run.id, part.id))?.payload;
    const delta = outputDelta(event, previousPayload, part);

    if (!previousBuffered && buffer.parts.size >= MAX_BUFFERED_STREAM_PARTS_PER_RUN) {
      const oldestPartId = buffer.parts.keys().next().value as string | undefined;
      if (oldestPartId) await this.materializeBufferedStreamParts(run.id, [oldestPartId]);
    }

    buffer.parts.set(part.id, {
      part,
      raw,
      status,
      type,
      eventCount: (previousBuffered?.eventCount ?? 0) + 1
    });
    if (delta) {
      const previousOutput = buffer.output.at(-1);
      if (previousOutput?.source === part.type) previousOutput.chunks.push(delta);
      else buffer.output.push({ source: part.type, chunks: [delta] });
      buffer.outputBytes += Buffer.byteLength(delta);
    }

    if (streamPartIsTerminal(part, status)) {
      await this.flushBufferedStreamOutput(run.id);
      await this.materializeBufferedStreamParts(run.id, [part.id]);
      return;
    }
    if (buffer.outputBytes >= STREAM_OUTPUT_FLUSH_BYTES) {
      await this.flushBufferedStreamOutput(run.id);
      return;
    }
    this.scheduleBufferedStreamOutputFlush(buffer);
  }

  private async handleTodoUpdated(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    const session = providerSessionId
      ? await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    const run = session ? await this.getCurrentRunForSession(session.id) : undefined;
    if (
      !session ||
      run?.serverInstanceId !== serverId ||
      !this.isCurrentSessionServerGeneration(session.id, serverId)
    ) {
      return;
    }
    const steps = mapOpenCodeTodoSteps(event.properties.todos);
    await this.store.recordAgentPlanRevision({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      runtimeId: this.descriptor.id,
      steps: this.redactProviderValue(steps),
      rawMessage: raw
    });
    this.emitRunActivity(run, { eventType: 'turn/plan/updated', stepCount: steps.length });
  }

  private async handlePermissionRequest(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const permission = event.properties as unknown as OpenCodePermissionRequest;
    if (typeof permission.id !== 'string' || typeof permission.sessionID !== 'string') return;
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, permission.sessionID);
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    await this.materializeInteraction(
      session,
      permission.id,
      mapOpenCodePermission(permission, session.worktreePath),
      raw,
      serverId,
      permission.source?.messageID ?? permission.tool?.messageID
    );
  }

  private async handleQuestionRequest(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const question = event.properties as unknown as OpenCodeQuestionRequest;
    if (typeof question.id !== 'string' || typeof question.sessionID !== 'string') return;
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, question.sessionID);
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    await this.materializeInteraction(
      session,
      question.id,
      mapOpenCodeQuestion(question),
      raw,
      serverId,
      question.tool?.messageID
    );
  }

  private async materializeInteraction(
    session: AgentSessionRecord,
    providerRequestId: string,
    mapped: MappedOpenCodeInteraction,
    raw: AgentProtocolMessageReference,
    serverId: string,
    providerMessageId?: string
  ): Promise<void> {
    if (!providerMessageId) {
      await this.quarantineSessionRuntime(
        session.id,
        'interaction/ownership',
        `OpenCode interaction ${providerRequestId} did not identify its owning message.`
      );
      return;
    }
    if (
      [providerRequestId, providerMessageId, mapped.providerItemId].some(
        (value) =>
          typeof value === 'string' && !this.isSafeOperationalIdentifier(value)
      )
    ) {
      await this.quarantineSessionRuntime(
        session.id,
        'interaction/sensitive-identifier',
        'OpenCode returned an actionable interaction identifier matching a runtime credential.'
      );
      return;
    }
    const run = await this.runForInteractionMessage(
      session,
      providerMessageId,
      serverId
    );
    if (
      !run ||
      run.serverInstanceId !== serverId ||
      !this.isCurrentSessionServerGeneration(session.id, serverId)
    ) {
      return;
    }
    const policy = buildInteractionPolicy({
      type: mapped.type,
      request: mapped.request,
      session,
      run,
      providerItemPayload: mapped.providerItemPayload
    });
    const interaction = await this.store.createInteractionRequest({
      runtimeId: this.descriptor.id,
      serverInstanceId: serverId,
      providerRequestId,
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      providerTurnId: run.providerTurnId,
      providerItemId: mapped.providerItemId,
      type: mapped.type,
      request: this.redactProviderValue(mapped.request),
      allowedActions: policy.allowedActions,
      policyWarnings: policy.warnings,
      requestRawMessage: raw
    });
    this.emitInteractionUpdate(interaction);
    if (mapped.type === 'USER_INPUT' && policy.allowedActions.length === 0) {
      await this.resolveBlockedUserInput(interaction);
    }
  }

  private async resolveBlockedUserInput(
    interaction: InteractionRequestRecord
  ): Promise<void> {
    const decision: AgentInteractionDecision = {
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
    } catch (cause) {
      const latest = await this.store.getInteractionRequest(interaction.id);
      if (latest?.status === 'RESPONDING') {
        const reason = errorMessage(cause);
        const stale = await this.store.transitionInteractionRequest(
          latest.id,
          'RESPONDING',
          {
            status: 'STALE',
            resolution: {
              error: reason,
              automaticResubmission: false
            },
            resolvedAt: new Date().toISOString()
          }
        );
        this.emitInteractionUpdate(stale);
        const run = await this.store.getRun(interaction.runId);
        if (run) {
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
                operation: 'question/reply',
                reason,
                automaticResubmission: false
              }
            })
          );
          this.emitRunActivity(run, {
            eventType: 'mutation/ambiguous',
            operation: 'question/reply'
          });
        }
      }
      throw cause;
    }
  }

  private async handleExternalInteractionResolution(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const requestId = stringProperty(event.properties, 'requestID') ?? stringProperty(event.properties, 'permissionID');
    if (!requestId) return;
    const interaction = await this.store.getInteractionRequestByProviderId(serverId, requestId);
    if (
      !interaction ||
      interaction.status !== 'PENDING' ||
      !this.isCurrentSessionServerGeneration(interaction.sessionId, serverId)
    ) {
      return;
    }
    const stale = await this.store.transitionInteractionRequest(interaction.id, 'PENDING', {
      status: 'STALE',
      responseRawMessage: raw,
      resolution: { providerResolvedExternally: true, eventType: event.type },
      resolvedAt: new Date().toISOString()
    });
    this.emitInteractionUpdate(stale);
  }

  private async handleChildSession(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const infoRecord = asRecord(event.properties.info);
    if (!infoRecord) return;
    let child: OpenCodeSession;
    try {
      child = parseOpenCodeSession(infoRecord);
    } catch {
      return;
    }
    if (!child.parentID) return;
    const parent = await this.store.getAgentSessionByProviderId(this.descriptor.id, child.parentID);
    if (!parent || !this.isCurrentSessionServerGeneration(parent.id, serverId)) return;
    const parentRun = await this.getCurrentRunForSession(parent.id);
    if (
      !this.isCurrentSessionServerGeneration(parent.id, serverId) ||
      (parentRun && parentRun.serverInstanceId !== serverId)
    ) {
      return;
    }
    if (
      !this.isSafeOperationalIdentifier(child.id) ||
      !this.isSafeOperationalIdentifier(child.parentID)
    ) {
      if (parentRun) {
        await this.recordRunActivity(parentRun, 'subagent/sensitive-identifier-omitted', {});
      }
      return;
    }
    await this.store.observeSubagent({
      parentSessionId: parent.id,
      parentRunId: parentRun?.id,
      providerChildSessionId: child.id,
      providerParentSessionId: child.parentID,
      source: 'THREAD_STARTED_PARENT',
      status: 'RUNNING',
      materialized: true,
      rawMessage: raw
    });
  }

  private async handleSessionError(event: OpenCodeEvent, serverId: string): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    const session = providerSessionId
      ? await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    const run = session ? await this.getCurrentRunForSession(session.id) : undefined;
    if (
      run?.serverInstanceId !== serverId ||
      !this.isCurrentSessionServerGeneration(session.id, serverId)
    ) {
      return;
    }
    const diagnostic = openCodeErrorDiagnostic(
      event.properties.error ?? 'OpenCode session error.',
      this.sensitiveValues
    );
    const status = run.status === 'INTERRUPTING' ? 'INTERRUPTED' : 'FAILED';
    await this.finalizeRun(run, status, diagnostic);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    await this.store.updateAgentSession(session.id, {
      status: status === 'INTERRUPTED' ? 'IDLE' : 'SYSTEM_ERROR'
    });
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    this.scheduleSessionIdleEviction(session.id);
  }

  private reconcileRun(run: RunRecord): Promise<'reconciled' | 'recovery-required'> {
    return this.enqueueSessionOperation(run.sessionId, () => this.reconcileRunOwned(run));
  }

  private async reconcileRunOwned(
    run: RunRecord
  ): Promise<'reconciled' | 'recovery-required'> {
    this.reconciliationCounts.set(
      run.sessionId,
      (this.reconciliationCounts.get(run.sessionId) ?? 0) + 1
    );
    try {
      return await this.reconcileRunInternal(run);
    } finally {
      const remaining = (this.reconciliationCounts.get(run.sessionId) ?? 1) - 1;
      if (remaining > 0) this.reconciliationCounts.set(run.sessionId, remaining);
      else this.reconciliationCounts.delete(run.sessionId);
    }
  }

  private async reconcileRunInternal(
    run: RunRecord
  ): Promise<'reconciled' | 'recovery-required'> {
    const storedRun = await this.store.getRun(run.id);
    if (!storedRun || TERMINAL_RUN_STATES.includes(storedRun.status)) return 'reconciled';
    run = storedRun;
    const session = await this.requireSession(run.sessionId);
    if (!session.providerSessionId) {
      await this.recordReconciliation(run, 'RECOVERY_REQUIRED', 'REQUIRES_USER_ACTION', false);
      return 'recovery-required';
    }
    if (!this.isSafeOperationalIdentifier(session.providerSessionId)) {
      await this.quarantineSessionRuntime(
        session.id,
        'session/reconcile',
        'The persisted OpenCode session identifier matches a runtime credential.'
      );
      return 'recovery-required';
    }
    let client: OpenCodeClientTransport;
    let serverId: string;
    try {
      const running = await this.ensureSessionRuntime(session);
      client = running.client;
      serverId = running.server.id;
      if (run.serverInstanceId !== serverId) {
        run = await this.store.updateRun(run.id, { serverInstanceId: serverId });
      }
      await this.bindEventStream(session, client, serverId);
    } catch {
      return 'recovery-required';
    }
    const messagesResult = await client.get<unknown>(`${sessionPath(session.providerSessionId)}/message`);
    const messages = parseOpenCodeMessages(messagesResult.data);
    const providerMessageId = run.providerTurnId;
    const userMessage = providerMessageId
      ? messages.find((message) => message.info.role === 'user' && message.info.id === providerMessageId)
      : undefined;
    if (!userMessage) {
      await this.recordReconciliation(run, 'RECOVERY_REQUIRED', 'REQUIRES_USER_ACTION', false);
      await this.reconcilePendingInteractions(session, client, serverId);
      return 'recovery-required';
    }
    const recoveredSettings = settingsObservedFromMessage(
      userMessage.info,
      run.requestedSettings
    );
    if (recoveredSettings) {
      const observed = this.safeObservedSettings(recoveredSettings);
      run = await this.store.updateRun(run.id, { observedSettings: observed });
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
        return 'recovery-required';
      }
      await this.store.updateAgentSession(session.id, { observedSettings: observed });
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
        return 'recovery-required';
      }
      await this.recordSettingsObservation(
        session,
        'RECOVERY_RESUME_RESPONSE',
        observed,
        run.id,
        messagesResult.raw
      );
    }
    const status = await this.readProviderSessionStatus(client, session.providerSessionId);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
      return 'recovery-required';
    }
    const assistant = latestAssistantFor(messages, userMessage.info.id);
    if (assistant && status === 'IDLE') {
      await this.finalizeFromSnapshot(run, session, assistant, messagesResult.raw, serverId);
    } else if (status === 'ACTIVE') {
      await this.recordReconciliation(
        run,
        run.status === 'INTERRUPTING' ? 'INTERRUPTING' : 'RUNNING',
        'RECOVERED',
        false
      );
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
        return 'recovery-required';
      }
      await this.store.updateAgentSession(session.id, { status: 'ACTIVE', materialized: true });
    } else {
      await this.recordReconciliation(run, 'RECOVERY_REQUIRED', 'REQUIRES_USER_ACTION', false);
      await this.reconcilePendingInteractions(session, client, serverId);
      return 'recovery-required';
    }
    await this.reconcilePendingInteractions(session, client, serverId);
    return 'reconciled';
  }

  private reconcileSession(
    sessionId: string
  ): Promise<'none' | 'reconciled' | 'recovery-required'> {
    return this.enqueueSessionOperation(sessionId, () => this.reconcileSessionOwned(sessionId));
  }

  private async reconcileSessionOwned(
    sessionId: string,
    expectedServerId?: string
  ): Promise<'none' | 'reconciled' | 'recovery-required'> {
    if (
      expectedServerId &&
      !this.isCurrentSessionServerGeneration(sessionId, expectedServerId)
    ) {
      return 'none';
    }
    const run = await this.getCurrentRunForSession(sessionId);
    if (
      expectedServerId &&
      (!this.isCurrentSessionServerGeneration(sessionId, expectedServerId) ||
        (run && run.serverInstanceId !== expectedServerId))
    ) {
      return 'none';
    }
    return run ? this.reconcileRunOwned(run) : 'none';
  }

  private async reconcilePendingInteractions(
    session: AgentSessionRecord,
    client: OpenCodeClientTransport,
    serverId: string
  ): Promise<void> {
    const [permissionsResult, questionsResult] = await Promise.all([
      client.get<unknown>('/permission'),
      client.get<unknown>('/question')
    ]);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    for (const permission of parseOpenCodePermissions(permissionsResult.data)) {
      if (permission.sessionID !== session.providerSessionId) continue;
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      await this.materializeInteraction(
        session,
        permission.id,
        mapOpenCodePermission(permission, session.worktreePath),
        permissionsResult.raw,
        serverId,
        permission.source?.messageID ?? permission.tool?.messageID
      );
    }
    for (const question of parseOpenCodeQuestions(questionsResult.data)) {
      if (question.sessionID !== session.providerSessionId) continue;
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      await this.materializeInteraction(
        session,
        question.id,
        mapOpenCodeQuestion(question),
        questionsResult.raw,
        serverId,
        question.tool?.messageID
      );
    }
  }

  private async finalizeFromSnapshot(
    run: RunRecord,
    session: AgentSessionRecord,
    assistant: OpenCodeMessage,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const current = await this.store.getRun(run.id);
    if (!current || !ACTIVE_RUN_STATES.includes(current.status)) return;
    await this.flushBufferedStreamOutput(current.id);
    for (const part of assistant.parts) {
      await this.store.upsertAgentItem({
        taskId: current.taskId,
        iterationId: current.iterationId,
        runId: current.id,
        sessionId: session.id,
        providerItemId: part.id,
        type: mapOpenCodePartType(part),
        status: terminalPartStatus(part),
        payload: this.redactProviderValue(part),
        rawMessage: raw,
        providerStartedAt: providerTimestamp(part.state?.time?.start),
        providerCompletedAt: providerTimestamp(part.state?.time?.end ?? assistant.info.time?.completed)
      });
    }
    this.discardStreamBuffer(current.id);
    const finalMessage = assistant.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    const providerDiagnostic = assistant.info.error
      ? openCodeErrorDiagnostic(assistant.info.error, this.sensitiveValues)
      : undefined;
    const status: Extract<RunRecord['status'], 'COMPLETED' | 'FAILED' | 'INTERRUPTED'> =
      current.status === 'INTERRUPTING'
        ? 'INTERRUPTED'
        : providerDiagnostic
          ? 'FAILED'
          : 'COMPLETED';
    await this.recordRunActivity(current, 'message/completed', {
      messageText: finalMessage,
      providerMessageId: assistant.info.id
    });
    await this.finalizeRun(current, status, providerDiagnostic, finalMessage);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    await this.store.updateAgentSession(session.id, { status: 'IDLE', materialized: true });
    this.scheduleSessionIdleEviction(session.id);
  }

  private async finalizeRun(
    run: RunRecord,
    status: Extract<RunRecord['status'], 'COMPLETED' | 'FAILED' | 'INTERRUPTED'>,
    error?: string,
    finalMessage = '',
    source: 'provider' | 'process' = 'provider'
  ): Promise<void> {
    error = error === undefined ? undefined : this.redactProviderText(error);
    finalMessage = this.redactProviderText(finalMessage);
    await this.materializeRunStreamBuffer(run.id);
    const current = await this.store.getRun(run.id);
    if (!current || !ACTIVE_RUN_STATES.includes(current.status)) return;
    const reviewResult = current.mode === 'REVIEW' ? parseAgentReviewResult(finalMessage) : undefined;
    const finalArtifact = await this.store.writeFinalArtifact(
      current.taskId,
      current.id,
      [
        '# OpenCode turn result',
        '',
        `Status: ${status}`,
        `Model: ${current.observedSettings?.modelProvider ?? current.requestedSettings.modelProvider ?? 'unknown'}/${current.observedSettings?.model ?? current.requestedSettings.model ?? 'unknown'}`,
        '',
        finalMessage || error || 'OpenCode returned no final text.'
      ].join('\n')
    );
    const eventType = status === 'COMPLETED'
      ? 'AGENT_RUN_COMPLETED'
      : status === 'INTERRUPTED'
        ? 'AGENT_RUN_INTERRUPTED'
        : 'AGENT_RUN_FAILED';
    await this.store.appendEvent(
      createDomainEvent({
        type: eventType,
        taskId: current.taskId,
        iterationId: current.iterationId,
        runId: current.id,
        worktreeId: current.worktreeId,
        agentSessionId: current.sessionId,
        serverInstanceId: current.serverInstanceId,
        source,
        payload: {
          terminalStatus: status.toLowerCase(),
          terminalReason: error,
          error,
          finalArtifactId: finalArtifact.id,
          codexReviewStatus: agentReviewStatusFromResult(reviewResult),
          codexReviewResult: reviewResult
        }
      })
    );
    this.clearInterruptDeadline(current.id);
    this.appEvents.emit({
      type: 'run.terminal',
      taskId: current.taskId,
      iterationId: current.iterationId,
      runId: current.id,
      worktreeId: current.worktreeId,
      payload: { status: status.toLowerCase(), error, finalArtifactId: finalArtifact.id },
      at: new Date().toISOString()
    });
    await this.stalePendingInteractions(current.id, 'OpenCode turn reached a terminal state.');
    this.scheduleSessionIdleEviction(current.sessionId);
    this.schedulePendingRuntimeReset();
  }

  private async handleRuntimeLoss(
    serverInstanceId: string,
    reason = 'OpenCode session runtime exited unexpectedly.',
    owningSessionId?: string
  ): Promise<void> {
    const snapshot = await this.store.snapshot();
    const runs = snapshot.runs.filter(
      (run) => run.serverInstanceId === serverInstanceId && ACTIVE_RUN_STATES.includes(run.status)
    );
    for (const run of runs) {
      this.clearInterruptDeadline(run.id);
      await this.materializeRunStreamBuffer(run.id);
      await this.store.appendEvent(
        createDomainEvent({
          type: 'AGENT_RUNTIME_LOST',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId,
          source: 'process',
          payload: { reason }
        })
      );
      this.emitRunActivity(run, {
        eventType: 'runtime/lost',
        reason
      });
      await this.store.updateAgentSession(run.sessionId, { status: 'NOT_LOADED' });
    }
    if (owningSessionId && !runs.some((run) => run.sessionId === owningSessionId)) {
      const session = await this.store.getAgentSession(owningSessionId);
      if (session && session.status !== 'NOT_LOADED') {
        await this.store.updateAgentSession(owningSessionId, { status: 'NOT_LOADED' });
      }
    }
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) => candidate.serverInstanceId === serverInstanceId && ['PENDING', 'RESPONDING'].includes(candidate.status)
    )) {
      const latest = await this.store.getInteractionRequest(interaction.id);
      if (!latest || !['PENDING', 'RESPONDING'].includes(latest.status)) continue;
      try {
        const aborted = await this.store.transitionInteractionRequest(
          latest.id,
          latest.status,
          {
            status: 'ABORTED_SERVER_LOST',
            resolution: { reason },
            resolvedAt: new Date().toISOString()
          }
        );
        this.emitInteractionUpdate(aborted);
      } catch (cause) {
        const raced = await this.store.getInteractionRequest(interaction.id);
        if (raced && ['PENDING', 'RESPONDING'].includes(raced.status)) throw cause;
      }
    }
  }

  private async recoverPersistedRuntimeLosses(): Promise<void> {
    const snapshot = await this.store.snapshot();
    for (const server of snapshot.agentServers.filter(
      (candidate) =>
        candidate.runtimeId === this.descriptor.id &&
        ['STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING'].includes(candidate.status)
    )) {
      await this.store.updateAgentServer(server.id, {
        status: 'LOST',
        disconnectedAt: new Date().toISOString(),
        exitedAt: new Date().toISOString(),
        exitReason: 'Task Monki restarted without the prior OpenCode process.'
      });
      await this.handleRuntimeLoss(server.id);
    }
  }

  private scheduleSessionRecovery(sessionId: string): void {
    if (this.shuttingDown || this.recoveryTimers.has(sessionId)) return;
    const attempt = this.recoveryAttempts.get(sessionId) ?? 0;
    if (attempt >= RECOVERY_DELAYS_MS.length) {
      void this.enqueueInbound(sessionId, async () => {
        if ((this.reconciliationCounts.get(sessionId) ?? 0) > 0) return;
        const run = await this.getCurrentRunForSession(sessionId);
        if (run) {
          await this.recordRunActivity(run, 'runtime/recovery-exhausted', {
            attempts: RECOVERY_DELAYS_MS.length,
            recoveryState: run.recoveryState
          });
        }
        await this.closeSessionRuntime(sessionId, false);
      });
      return;
    }
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(sessionId);
      this.recoveryAttempts.set(sessionId, attempt + 1);
      void this.reconcileSession(sessionId)
        .then((result) => {
          if (result === 'recovery-required') {
            throw new Error('OpenCode session still requires runtime recovery.');
          }
          this.recoveryAttempts.delete(sessionId);
        })
        .catch(() => this.scheduleSessionRecovery(sessionId));
    }, RECOVERY_DELAYS_MS[attempt]);
    timer.unref();
    this.recoveryTimers.set(sessionId, timer);
  }

  private scheduleSessionIdleEviction(sessionId: string): void {
    this.cancelSessionIdleEviction(sessionId);
    if (this.shuttingDown || !this.supervisors.has(sessionId)) return;
    const configured = this.options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (this.idleEvictionTimers.get(sessionId) === timer) {
        this.idleEvictionTimers.delete(sessionId);
      }
      void this.enqueueInbound(sessionId, () => this.evictIdleSessionRuntime(sessionId));
    }, timeoutMs);
    timer.unref();
    this.idleEvictionTimers.set(sessionId, timer);
  }

  private cancelSessionIdleEviction(sessionId: string): void {
    const timer = this.idleEvictionTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.idleEvictionTimers.delete(sessionId);
  }

  private async evictIdleSessionRuntime(sessionId: string): Promise<void> {
    if (this.shuttingDown || !this.supervisors.has(sessionId)) return;
    if ((this.reconciliationCounts.get(sessionId) ?? 0) > 0) {
      this.scheduleSessionIdleEviction(sessionId);
      return;
    }
    const activeRun = await this.getCurrentRunForSession(sessionId);
    if (activeRun) return;
    const snapshot = await this.store.snapshot();
    const hasPendingInteraction = snapshot.interactionRequests.some(
      (interaction) =>
        interaction.sessionId === sessionId &&
        (interaction.status === 'PENDING' || interaction.status === 'RESPONDING')
    );
    if (hasPendingInteraction) {
      this.scheduleSessionIdleEviction(sessionId);
      return;
    }
    const session = snapshot.agentSessions.find((candidate) => candidate.id === sessionId);
    if (session?.status === 'ACTIVE') {
      this.scheduleSessionIdleEviction(sessionId);
      return;
    }
    await this.closeSessionRuntime(sessionId, false);
  }

  private async closeSessionRuntime(
    sessionId: string,
    waitForInbound: boolean
  ): Promise<void> {
    const existing = this.sessionClosePromises.get(sessionId);
    if (existing) return existing;
    const operation = this.performSessionRuntimeClose(sessionId, waitForInbound);
    const tracked = operation.finally(() => {
      if (this.sessionClosePromises.get(sessionId) === tracked) {
        this.sessionClosePromises.delete(sessionId);
      }
    });
    this.sessionClosePromises.set(sessionId, tracked);
    return tracked;
  }

  private async performSessionRuntimeClose(
    sessionId: string,
    waitForInbound: boolean
  ): Promise<void> {
    const fence = new Error('OpenCode session runtime teardown is in progress.');
    this.sessionRuntimeFences.set(sessionId, fence);
    this.clearSessionInterruptDeadlines(sessionId);
    this.cancelSessionIdleEviction(sessionId);
    const recoveryTimer = this.recoveryTimers.get(sessionId);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    this.recoveryTimers.delete(sessionId);
    this.recoveryAttempts.delete(sessionId);
    const stream = this.eventStreams.get(sessionId);
    stream?.stop();
    this.clearAssistantMessageParents(sessionId);
    for (const buffer of this.streamBuffers.values()) {
      if (buffer.sessionId === sessionId && buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = undefined;
      }
    }
    if (waitForInbound) {
      const pending = this.sessionOperationQueues.get(sessionId);
      if (pending) await pending;
      this.cancelSessionIdleEviction(sessionId);
    }
    for (const buffer of [...this.streamBuffers.values()]) {
      if (buffer.sessionId === sessionId) {
        await this.materializeRunStreamBuffer(buffer.runId);
      }
    }
    const supervisor = this.supervisors.get(sessionId);
    let shutdownConfirmed = false;
    try {
      if (supervisor) await supervisor.shutdown();
      shutdownConfirmed = true;
      if (this.supervisors.get(sessionId) === supervisor) {
        this.supervisors.delete(sessionId);
      }
      if (this.eventStreams.get(sessionId) === stream) {
        this.eventStreams.delete(sessionId);
      }
      const session = await this.store.getAgentSession(sessionId).catch(() => undefined);
      if (session) await this.store.updateAgentSession(sessionId, { status: 'NOT_LOADED' });
    } finally {
      if (shutdownConfirmed && this.sessionRuntimeFences.get(sessionId) === fence) {
        this.sessionRuntimeFences.delete(sessionId);
      }
    }
  }

  private applyPendingRuntimeConfiguration(excludedQueuedRunId?: string): Promise<void> {
    if (!this.runtimeReconfigurationPending) return Promise.resolve();
    if (this.runtimeConfigurationApplyPromise) return this.runtimeConfigurationApplyPromise;
    const operation = (async () => {
      if (
        !this.runtimeReconfigurationPending ||
        (await this.hasActiveRuntimeWork(excludedQueuedRunId))
      ) {
        return;
      }
      await this.resetRuntimeForConfiguration();
      // A start guard can run after its new local run is durably QUEUED. There
      // is no older work left to reconcile, and reconciling that unsubmitted
      // run would incorrectly turn it into recovery-required work.
      await this.initializeRuntime(false);
    })();
    const tracked = operation.finally(() => {
      if (this.runtimeConfigurationApplyPromise === tracked) {
        this.runtimeConfigurationApplyPromise = undefined;
      }
    });
    this.runtimeConfigurationApplyPromise = tracked;
    return tracked;
  }

  private async hasActiveRuntimeWork(excludedQueuedRunId?: string): Promise<boolean> {
    const snapshot = await this.store.snapshot();
    return snapshot.runs.some(
      (run) =>
        run.runtimeId === this.descriptor.id &&
        ACTIVE_RUN_STATES.includes(run.status) &&
        !(run.id === excludedQueuedRunId && run.status === 'QUEUED')
    );
  }

  private async resetRuntimeForConfiguration(): Promise<void> {
    if (this.runtimeConfigurationResetTimer) {
      clearTimeout(this.runtimeConfigurationResetTimer);
      this.runtimeConfigurationResetTimer = undefined;
    }
    await this.shutdown();
    this.runtime = undefined;
    this.operationalModels = [];
    this.models = [];
    this.nativeCatalogState = undefined;
    this.runtimeReconfigurationPending = false;
    this.shuttingDown = false;
    this.preflightState = {
      runtime: this.descriptor,
      readiness: createRuntimeReadiness(
        'INITIALIZING',
        'OpenCode executable discovery must be refreshed.',
        {
          checks: { initialization: 'NOT_STARTED' },
          nextAction: { kind: 'RETRY', label: 'Refresh OpenCode' }
        }
      ),
      capabilities: opencodeCapabilities(),
    };
    this.emitRuntimeUpdate();
  }

  private schedulePendingRuntimeReset(): void {
    if (!this.runtimeReconfigurationPending || this.runtimeConfigurationResetTimer) return;
    const timer = setTimeout(() => {
      if (this.runtimeConfigurationResetTimer === timer) {
        this.runtimeConfigurationResetTimer = undefined;
      }
      void this.configureRuntime({
        executable: this.configuredExecutable,
        restart: true
      }).catch((cause) => {
        this.preflightState = {
          ...this.preflightState,
          readiness: createRuntimeReadiness(
            'FAILED',
            'OpenCode could not apply the saved runtime configuration.',
            {
              checks: {
                ...this.preflightState.readiness.checks,
                initialization: 'FAILED'
              },
              diagnostics: [
                ...this.preflightState.readiness.diagnostics,
                errorDiagnostic(
                  'RUNTIME_RECONFIGURATION_FAILED',
                  'CONFIGURATION',
                  errorMessage(cause)
                )
              ],
              nextAction: { kind: 'RETRY', label: 'Retry OpenCode' }
            }
          )
        };
        this.emitRuntimeUpdate();
      });
    }, 0);
    timer.unref();
    this.runtimeConfigurationResetTimer = timer;
  }

  private async readProviderSessionStatus(
    client: OpenCodeClientTransport,
    providerSessionId: string,
    deadlineAt?: number
  ): Promise<AgentSessionRecord['status']> {
    const value = (
      await client.get<unknown>(
        '/session/status',
        deadlineAt === undefined ? undefined : { deadlineAt }
      )
    ).data;
    const statuses = asRecord(value);
    return mapOpenCodeSessionStatus(statuses?.[providerSessionId] ?? { type: 'idle' });
  }

  private async recordSettingsObservation(
    session: AgentSessionRecord,
    source:
      | 'TASK_MONKI_RESOLUTION'
      | 'THREAD_START_RESPONSE'
      | 'THREAD_SETTINGS_NOTIFICATION'
      | 'RECOVERY_RESUME_RESPONSE',
    settings: AgentExecutionSettings,
    runId?: string,
    rawMessage?: AgentProtocolMessageReference
  ): Promise<void> {
    await this.store.recordAgentSettingsObservation({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runId,
      runtimeId: this.descriptor.id,
      source,
      settings,
      rawMessage
    });
  }

  private async recordRunActivity(
    run: RunRecord,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    payload = this.redactProviderValue(payload);
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
    this.emitRunActivity(run, { eventType, ...payload });
  }

  private async appendRunOutput(run: RunRecord, source: string, text: string): Promise<void> {
    source = this.redactProviderText(source);
    text = this.redactProviderText(text);
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

  private scheduleBufferedStreamOutputFlush(buffer: OpenCodeRunStreamBuffer): void {
    if (buffer.timer || buffer.outputBytes === 0 || this.shuttingDown) return;
    const timer = setTimeout(() => {
      if (buffer.timer === timer) buffer.timer = undefined;
      void this.enqueueInbound(buffer.sessionId, () =>
        this.flushBufferedStreamOutput(buffer.runId)
      );
    }, STREAM_OUTPUT_FLUSH_MS);
    timer.unref();
    buffer.timer = timer;
  }

  private async flushBufferedStreamOutput(runId: string): Promise<void> {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer) return;
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = undefined;
    const run = await this.store.getRun(runId);
    if (!run) {
      this.discardStreamBuffer(runId);
      return;
    }
    try {
      while (buffer.output.length > 0) {
        const next = buffer.output[0];
        const text = next.chunks.join('');
        if (text) await this.appendRunOutput(run, next.source, text);
        buffer.output.shift();
        buffer.outputBytes = Math.max(0, buffer.outputBytes - Buffer.byteLength(text));
      }
    } catch (cause) {
      this.scheduleBufferedStreamOutputFlush(buffer);
      throw cause;
    }
  }

  private async materializeBufferedStreamParts(
    runId: string,
    partIds?: readonly string[]
  ): Promise<void> {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer) return;
    const run = await this.store.getRun(runId);
    if (!run) {
      this.discardStreamBuffer(runId);
      return;
    }
    const selectedIds = partIds ?? [...buffer.parts.keys()];
    for (const partId of selectedIds) {
      const entry = buffer.parts.get(partId);
      if (!entry) continue;
      const status = streamPartIsTerminal(entry.part, entry.status)
        ? terminalPartStatus(entry.part)
        : entry.status;
      await this.store.upsertAgentItem({
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        sessionId: buffer.sessionId,
        providerItemId: entry.part.id,
        type: entry.type,
        status,
        payload: this.redactProviderValue(entry.part),
        rawMessage: entry.raw,
        providerStartedAt: providerTimestamp(entry.part.state?.time?.start),
        providerCompletedAt: providerTimestamp(entry.part.state?.time?.end)
      });
      await this.recordRunActivity(run, `item/${entry.part.type}/${status.toLowerCase()}`, {
        providerItemId: entry.part.id,
        coalescedEvents: entry.eventCount
      });
      buffer.parts.delete(partId);
    }
    if (buffer.parts.size === 0 && buffer.outputBytes === 0) {
      this.discardStreamBuffer(runId);
    }
  }

  private async materializeRunStreamBuffer(runId: string): Promise<void> {
    await this.flushBufferedStreamOutput(runId);
    await this.materializeBufferedStreamParts(runId);
  }

  private discardStreamBuffer(runId: string): void {
    const buffer = this.streamBuffers.get(runId);
    if (buffer?.timer) clearTimeout(buffer.timer);
    this.streamBuffers.delete(runId);
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
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: { status, recoveryState, terminal }
      })
    );
    this.emitRunActivity(run, {
      eventType: 'runtime/reconciled',
      status,
      recoveryState,
      terminal
    });
  }

  private async stalePendingInteractions(runId: string, reason: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) => candidate.runId === runId && ['PENDING', 'RESPONDING'].includes(candidate.status)
    )) {
      const stale = await this.store.transitionInteractionRequest(interaction.id, interaction.status, {
        status: 'STALE',
        resolution: { reason },
        resolvedAt: new Date().toISOString()
      });
      this.emitInteractionUpdate(stale);
    }
  }

  private async recordProtocolIncident(sessionId: string, cause: unknown): Promise<void> {
    const session = await this.store.getAgentSession(sessionId).catch(() => undefined);
    const run = session ? await this.getCurrentRunForSession(session.id).catch(() => undefined) : undefined;
    if (!session || !run) return;
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_PROTOCOL_INCIDENT',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: session.id,
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: { parseError: this.redactProviderText(errorMessage(cause)) }
      })
    );
    this.emitRunActivity(run, {
      eventType: 'runtime/protocol-incident',
      error: this.redactProviderText(errorMessage(cause))
    });
  }

  private emitRunActivity(run: RunRecord, payload: Record<string, unknown>): void {
    this.appEvents.emit({
      type: 'run.activity',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: this.redactProviderValue(payload),
      at: new Date().toISOString()
    });
  }

  private emitInteractionUpdate(interaction: InteractionRequestRecord): void {
    this.appEvents.emit({
      type: 'interaction.updated',
      taskId: interaction.taskId,
      iterationId: interaction.iterationId,
      runId: interaction.runId,
      payload: this.redactProviderValue(interaction),
      at: new Date().toISOString()
    });
  }

  private redactProviderText(value: string): string {
    return redactCredentialText(value, this.sensitiveValues);
  }

  private redactProviderValue<T>(value: T): T {
    return redactCredentialValue(value, this.sensitiveValues);
  }

  private isSafeOperationalIdentifier(value: string): boolean {
    return this.redactProviderText(value) === value;
  }

  private safePublishedModels(models: readonly AgentModel[]): AgentModel[] {
    return models.flatMap((model) => {
      if (
        !this.isSafeOperationalIdentifier(model.id) ||
        !this.isSafeOperationalIdentifier(model.modelProvider) ||
        !this.isSafeOperationalIdentifier(model.model)
      ) {
        return [];
      }
      const inputModalities = model.inputModalities.filter(
        (modality) => this.isSafeOperationalIdentifier(modality)
      );
      if (inputModalities.length === 0) return [];
      const published = this.redactProviderValue(model);
      published.inputModalities = inputModalities;
      published.supportedReasoningEfforts = model.supportedReasoningEfforts.filter(
        (variant) => this.isSafeOperationalIdentifier(variant)
      );
      published.defaultReasoningEffort =
        model.defaultReasoningEffort &&
        this.isSafeOperationalIdentifier(model.defaultReasoningEffort)
          ? model.defaultReasoningEffort
          : undefined;
      const exactVariants = asRecord(asRecord(model.native)?.variants);
      const safeNative = asRecord(published.native);
      if (safeNative && exactVariants) {
        safeNative.variants = Object.fromEntries(
          Object.entries(exactVariants)
            .filter(([variant]) => this.isSafeOperationalIdentifier(variant))
            .map(([variant, metadata]) => [
              variant,
              this.redactProviderValue(metadata)
            ])
        );
      }
      return [published];
    });
  }

  private safeObservedSettings(
    settings: AgentExecutionSettings
  ): AgentExecutionSettings {
    const unsafeModel =
      (settings.modelProvider !== undefined &&
        !this.isSafeOperationalIdentifier(settings.modelProvider)) ||
      (settings.model !== undefined &&
        !this.isSafeOperationalIdentifier(settings.model));
    const unsafeVariant =
      settings.reasoningEffort !== undefined &&
      !this.isSafeOperationalIdentifier(settings.reasoningEffort);
    if (!unsafeModel && !unsafeVariant) return settings;
    this.noteSensitiveIdentifierOmission();
    return {
      ...settings,
      ...(unsafeModel
        ? { modelProvider: undefined, model: undefined, reasoningEffort: undefined }
        : { reasoningEffort: undefined })
    };
  }

  private noteSensitiveIdentifierOmission(): void {
    if (
      this.preflightState.readiness.diagnostics.some(
        (diagnostic) => diagnostic.code === 'SENSITIVE_PROVIDER_IDENTIFIER_OMITTED'
      )
    ) return;
    this.preflightState = appendRuntimeDiagnostic(
      this.preflightState,
      warningDiagnostic(
        'SENSITIVE_PROVIDER_IDENTIFIER_OMITTED',
        'SECURITY',
        'OpenCode returned an operational identifier matching a runtime credential, so the affected model setting was omitted.',
        'Exact identifiers remain internal to protocol processing and are never replaced with redacted placeholders in actionable or durable settings.'
      )
    );
  }

  private async requireSession(sessionId: string): Promise<AgentSessionRecord> {
    const session = await this.store.getAgentSession(sessionId);
    if (!session) throw new Error(`Agent session not found: ${sessionId}`);
    return session;
  }

  private async getCurrentRunForSession(sessionId: string): Promise<RunRecord | undefined> {
    const active = await this.store.getActiveRunForSession(sessionId);
    if (active) return active;
    const snapshot = await this.store.snapshot();
    return snapshot.runs.find(
      (run) => run.sessionId === sessionId && ACTIVE_RUN_STATES.includes(run.status)
    );
  }

  private assertSessionOwnership(session: AgentSessionRecord): void {
    if (session.runtimeId !== this.descriptor.id) {
      throw new Error(`OpenCode cannot operate session ${session.id} owned by ${session.runtimeId}.`);
    }
  }

  private requireRuntime(): ResolvedOpenCodeRuntime {
    if (!this.runtime) throw new Error('OpenCode runtime is not initialized.');
    return this.runtime;
  }
}

function sessionPath(providerSessionId: string): string {
  return `/session/${encodeURIComponent(providerSessionId)}`;
}

function providerMessageIdForRun(localRunId: string): string {
  return `msg_taskmonki_${createHash('sha256').update(localRunId).digest('hex').slice(0, 32)}`;
}

function openCodeOwnershipTitle(localSessionId: string): string {
  return `Task Monki session ${localSessionId}`;
}

function deferredOpenCodeModel(
  provider: string,
  model: string,
  variant: string | undefined
): AgentModel {
  return {
    id: `${OPENCODE_RUNTIME_ID}:${provider}/${model}`,
    runtimeId: OPENCODE_RUNTIME_ID,
    modelProvider: provider,
    model,
    displayName: `${model} (${provider})`,
    description: 'Explicit OpenCode selection; validated against the worktree catalog before submission.',
    hidden: false,
    supportedReasoningEfforts: variant ? [variant] : [],
    defaultReasoningEffort: variant,
    serviceTiers: [],
    inputModalities: ['text'],
    isDefault: false,
    native: {
      discovery: 'deferred-to-worktree-catalog'
    }
  };
}

function modelReference(settings: AgentExecutionSettings): { id: string; providerID: string; variant?: string } | undefined {
  if (!settings.model || !settings.modelProvider) return undefined;
  return {
    id: settings.model,
    providerID: settings.modelProvider,
    ...(settings.reasoningEffort ? { variant: settings.reasoningEffort } : {})
  };
}

function settingsFromSession(
  session: OpenCodeSession,
  fallback: AgentExecutionSettings
): AgentExecutionSettings {
  const provider = session.model?.providerID ?? fallback.modelProvider;
  const model = session.model?.modelID ?? session.model?.id ?? fallback.model;
  return {
    ...fallback,
    runtimeId: OPENCODE_RUNTIME_ID,
    model,
    modelProvider: provider,
    reasoningEffort: session.model?.variant ?? fallback.reasoningEffort
  };
}

function settingsObservedFromMessage(
  info: OpenCodeMessageInfo,
  fallback: AgentExecutionSettings
): AgentExecutionSettings | undefined {
  const modelProvider = info.providerID ?? info.model?.providerID;
  const model = info.modelID ?? info.model?.modelID ?? info.model?.id;
  if (!modelProvider || !model) return undefined;
  return {
    ...fallback,
    runtimeId: OPENCODE_RUNTIME_ID,
    modelProvider,
    model,
    reasoningEffort: info.variant
  };
}

async function assertSessionDirectory(
  session: OpenCodeSession,
  expected: string
): Promise<void> {
  const [reportedDirectory, worktreeDirectory] = await Promise.all([
    canonicalExistingDirectory(session.directory, 'reported session directory'),
    canonicalExistingDirectory(expected, 'Task Monki worktree')
  ]);
  if (reportedDirectory !== worktreeDirectory) {
    throw new Error(
      `OpenCode session directory ${session.directory} does not match its Task Monki worktree.`
    );
  }
}

async function canonicalExistingDirectory(candidate: string, label: string): Promise<string> {
  try {
    const canonical = await fs.realpath(candidate);
    if (!(await fs.stat(canonical)).isDirectory()) {
      throw new Error(`${label} is not a directory.`);
    }
    return canonical;
  } catch (cause) {
    throw new Error(`OpenCode ${label} ${candidate} could not be verified.`, { cause });
  }
}

function latestAssistantFor(messages: OpenCodeMessage[], userMessageId: string): OpenCodeMessage | undefined {
  return messages
    .filter((message) => message.info.role === 'assistant' && message.info.parentID === userMessageId)
    .sort((left, right) => (right.info.time?.created ?? 0) - (left.info.time?.created ?? 0))[0];
}

function terminalPartStatus(part: OpenCodePart): ReturnType<typeof mapOpenCodePartStatus> {
  const mapped = mapOpenCodePartStatus(part);
  if (mapped === 'STARTED' || mapped === 'IN_PROGRESS' || mapped === 'UNKNOWN') {
    return part.state?.status === 'error' ? 'FAILED' : 'COMPLETED';
  }
  return mapped;
}

function assertOpenCodeManagedAttachmentsUnsupported(
  attachments: readonly Pick<AgentTurnAttachment, 'kind'>[]
): void {
  if (attachments.length > 0) {
    throw new Error(
      'Task Monki managed attachments are unavailable for OpenCode because its credential-bearing process cannot attest attachment confinement. OpenCode native file parts remain available to OpenCode-owned tools and integrations.'
    );
  }
}

function outputDelta(
  event: OpenCodeEvent,
  existingPayload: unknown,
  part: OpenCodePart
): string | undefined {
  const explicit = stringProperty(event.properties, 'delta');
  if (explicit) return explicit;
  if (typeof part.text !== 'string') return undefined;
  const previous = asRecord(existingPayload)?.text;
  if (typeof previous === 'string') {
    if (previous === part.text) return undefined;
    if (part.text.length >= previous.length) {
      // OpenCode text parts are append-only in normal streaming. Compare only
      // a bounded suffix so cumulative snapshots do not create per-token O(n²)
      // prefix scans as the message grows.
      const boundaryStart = Math.max(0, previous.length - 64);
      if (
        part.text.slice(boundaryStart, previous.length) ===
        previous.slice(boundaryStart)
      ) {
        return part.text.slice(previous.length) || undefined;
      }
    }
  }
  return previous === part.text ? undefined : part.text;
}

function streamPartIsTerminal(
  part: OpenCodePart,
  status: ReturnType<typeof mapOpenCodePartStatus>
): boolean {
  return (
    status === 'COMPLETED' ||
    status === 'FAILED' ||
    status === 'DECLINED' ||
    status === 'INTERRUPTED' ||
    part.state?.time?.end !== undefined ||
    asRecord(part.time)?.end !== undefined
  );
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function providerTimestamp(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function isOpenCodeAbortError(value: unknown): boolean {
  return asRecord(value)?.name === 'MessageAbortedError';
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function mapOpenCodeMutationError(operation: string, cause: unknown): Error {
  if (cause instanceof OpenCodeAmbiguousMutationError) {
    return new AgentMutationAmbiguousError(
      operation,
      `${cause.message} Task Monki will reconcile OpenCode state and will not resend automatically.`
    );
  }
  if (cause instanceof OpenCodeHttpError && cause.status === 404) {
    return new AgentProviderSessionMissingError(operation, cause.message);
  }
  return cause instanceof Error ? cause : new Error(String(cause));
}

function normalizeExecutableOverride(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function openCodeFailureReadiness(
  cause: unknown,
  sensitiveValues: readonly string[] = []
) {
  const message = redactCredentialText(errorMessage(cause), sensitiveValues);
  if (cause instanceof OpenCodeRuntimeResolutionError) {
    const found = cause.diagnostics.probes.some((probe) => Boolean(probe.version));
    return createRuntimeReadiness(
      found ? 'INCOMPATIBLE' : 'NOT_INSTALLED',
      found
        ? 'The installed OpenCode executable does not expose the required server contract.'
        : 'OpenCode was not found on this computer.',
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
          label: found ? 'Choose a compatible executable' : 'Install OpenCode'
        }
      }
    );
  }
  return createRuntimeReadiness('FAILED', message, {
    checks: { initialization: 'FAILED' },
    diagnostics: [
      errorDiagnostic('RUNTIME_INITIALIZATION_FAILED', 'INITIALIZATION', message)
    ],
    nextAction: { kind: 'RETRY', label: 'Retry OpenCode' }
  });
}
