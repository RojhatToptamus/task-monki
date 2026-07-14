import { createHash } from 'node:crypto';
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
  openCodeMessageError,
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
  resolveOpenCodeRuntime,
  type OpenCodeRuntimeResolverOptions,
  type ResolvedOpenCodeRuntime
} from './OpenCodeRuntimeResolver';
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
const OPENCODE_CATALOG_EVENTS = new Set([
  'models-dev.refreshed',
  'catalog.updated',
  'config.updated',
  'provider.updated',
  'integration.updated',
  'integration.connection.updated',
  'installation.updated'
]);

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
}

export class OpenCodeAdapter implements AgentRuntimeAdapter {
  readonly descriptor = OPENCODE_RUNTIME_DESCRIPTOR;

  private runtime?: ResolvedOpenCodeRuntime;
  private models: AgentModel[] = [];
  private nativeCatalogState?: AgentJsonValue;
  private preflightState: AgentPreflight = {
    runtime: OPENCODE_RUNTIME_DESCRIPTOR,
    ready: false,
    capabilities: opencodeCapabilities(),
    problems: ['OpenCode has not been initialized.'],
    warnings: []
  };
  private readonly supervisors = new Map<string, OpenCodeSessionSupervisor>();
  private readonly eventStreams = new Map<string, { stop(): void }>();
  private readonly inboundQueues = new Map<string, Promise<void>>();
  private readonly streamBuffers = new Map<string, OpenCodeRunStreamBuffer>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleEvictionTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconciliationCounts = new Map<string, number>();
  private catalogRefreshTimer?: NodeJS.Timeout;
  private catalogRefreshPromise?: Promise<void>;
  private runtimeConfigurationResetTimer?: NodeJS.Timeout;
  private runtimeConfigurationApplyPromise?: Promise<void>;
  private configuredExecutable?: string;
  private runtimeReconfigurationPending = false;
  private initialized = false;
  private shuttingDown = false;

  constructor(
    private readonly store: FileTaskStore,
    private readonly appEvents: AppEventBus,
    private readonly options: OpenCodeAdapterOptions
  ) {
    this.configuredExecutable = normalizeExecutableOverride(options.executable);
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
        ready: false,
        capabilities: opencodeCapabilities(),
        problems: [errorMessage(cause)],
        warnings: []
      };
      await this.shutdown().catch(() => undefined);
      this.initialized = false;
      this.runtime = undefined;
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
    if (this.models.length === 0) await this.refreshCatalog();
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
      this.preflightState = {
        ...this.preflightState,
        warnings: [
          ...new Set([
            ...this.preflightState.warnings,
            'The OpenCode runtime configuration is saved and will be applied after active provider work reaches a definitive terminal state.'
          ])
        ]
      };
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
      mapOpenCodeModels(projectCatalog),
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
      assertSessionDirectory(existingProviderSession, session.worktreePath);
      session = await this.store.updateAgentSession(session.id, {
        providerSessionId: existingProviderSession.id,
        providerSessionTreeId: existingProviderSession.id,
        status: await this.readProviderSessionStatus(client, existingProviderSession.id),
        materialized: true,
        requestedSettings: selectedSettings,
        observedSettings: settingsFromSession(existingProviderSession, selectedSettings),
        lastAttachedAt: new Date().toISOString()
      });
      await this.bindEventStream(session, client, server.id);
      if (session.status === 'IDLE') this.scheduleSessionIdleEviction(session.id);
      return session;
    }
    const response = parseOpenCodeSession(
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
    assertSessionDirectory(response, session.worktreePath);
    try {
      session = await this.store.updateAgentSession(session.id, {
        providerSessionId: response.id,
        providerSessionTreeId: response.id,
        status: 'IDLE',
        materialized: false,
        requestedSettings: selectedSettings,
        observedSettings: settingsFromSession(response, selectedSettings),
        lastAttachedAt: new Date().toISOString()
      });
    } catch (cause) {
      const persisted = await this.store.getAgentSession(session.id).catch(() => undefined);
      if (persisted?.providerSessionId === response.id) {
        session = persisted;
      } else {
        throw new Error(
          `OpenCode created session ${response.id}, but Task Monki could not persist its ownership. A retry will recover it by Task Monki metadata instead of creating another session.`,
          { cause }
        );
      }
    }
    await this.recordSettingsObservation(session, 'THREAD_START_RESPONSE', selectedSettings);
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
    assertSessionDirectory(response, session.worktreePath);
    const status = await this.readProviderSessionStatus(client, providerSessionId);
    session = await this.store.updateAgentSession(session.id, {
      providerSessionId: response.id,
      providerSessionTreeId: response.id,
      status,
      materialized: true,
      observedSettings: settingsFromSession(response, session.requestedSettings),
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
    const { client } = await this.ensureSessionRuntime(session);
    const response = parseOpenCodeSession(
      (await client.get<unknown>(sessionPath(providerSessionId))).data
    );
    assertSessionDirectory(response, session.worktreePath);
    session = await this.store.updateAgentSession(session.id, {
      status: await this.readProviderSessionStatus(client, providerSessionId),
      materialized: true,
      observedSettings: settingsFromSession(response, session.requestedSettings),
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
    let session = await this.requireSession(input.session.localSessionId);
    this.assertSessionOwnership(session);
    assertOpenCodeManagedAttachmentsUnsupported(input.attachments ?? []);
    const settings = input.settings ?? session.requestedSettings;
    assertOpenCodeExecutionSettings(settings);
    const hadProviderSession = Boolean(session.providerSessionId);
    const runtimeWasDetached = !this.supervisors.has(session.id);
    let running = await this.ensureSessionRuntime(session);
    const projectCatalog = parseOpenCodeProviderCatalog(
      (await running.client.get<unknown>('/provider')).data
    );
    const selectedModel = this.resolveExecutionFromModels(
      { settings, attachments: [] },
      mapOpenCodeModels(projectCatalog),
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
    if (hadProviderSession && session.providerSessionId && runtimeWasDetached) {
      session = await this.attachSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
    }
    const providerSessionId = session.providerSessionId!;
    running = await this.ensureSessionRuntime(session);
    const { client, server } = running;
    await this.bindEventStream(session, client, server.id);
    const providerMessageId = providerMessageIdForRun(input.localRunId);
    await this.store.updateRun(input.localRunId, {
      providerTurnId: providerMessageId,
      serverInstanceId: server.id,
      status: 'STARTING',
      lastEventAt: new Date().toISOString()
    });
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
      throw mapOpenCodeMutationError('session/prompt_async', cause);
    }
    const submittedAt = new Date().toISOString();
    try {
      await this.store.updateRun(input.localRunId, {
        status: 'RUNNING',
        observedSettings: selectedModel.settings,
        attachmentSubmissions: [],
        lastEventAt: submittedAt
      });
      session = await this.store.updateAgentSession(session.id, {
        status: 'ACTIVE',
        materialized: true,
        requestedSettings: selectedModel.settings,
        observedSettings: selectedModel.settings,
        lastAttachedAt: submittedAt
      });
      await this.recordSettingsObservation(
        session,
        'THREAD_SETTINGS_NOTIFICATION',
        selectedModel.settings,
        input.localRunId
      );
    } catch (cause) {
      throw new AgentMutationAmbiguousError(
        'session/prompt_async',
        `OpenCode accepted message ${providerMessageId}, but Task Monki could not durably record the acknowledgement: ${errorMessage(cause)} Automatic resubmission is disabled.`
      );
    }
    return { localRunId: input.localRunId, providerTurnId: providerMessageId };
  }

  async interruptTurn(input: InterruptAgentTurn): Promise<void> {
    const session = await this.requireSession(input.session.localSessionId);
    const providerSessionId = input.session.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId) throw new Error('Cannot interrupt an unmaterialized OpenCode session.');
    const { client } = await this.ensureSessionRuntime(session);
    try {
      await client.post<boolean>(`${sessionPath(providerSessionId)}/abort`);
    } catch (cause) {
      throw mapOpenCodeMutationError('session/abort', cause);
    }
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, input.providerTurnId);
    if (run && ACTIVE_RUN_STATES.includes(run.status)) {
      await this.store.updateRun(run.id, { status: 'INTERRUPTING', lastEventAt: new Date().toISOString() });
    }
    await this.reconcileSession(session.id);
  }

  async forkSession(input: ForkAgentSession): Promise<AgentSessionRecord> {
    const source = await this.requireSession(input.sourceSession.localSessionId);
    this.assertSessionOwnership(source);
    const sourceProviderId = input.sourceSession.providerSessionId ?? source.providerSessionId;
    if (!sourceProviderId) throw new Error('Cannot fork an unmaterialized OpenCode session.');
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
      throw mapOpenCodeMutationError('session/fork', cause);
    }
    let stored: AgentSessionRecord;
    try {
      assertSessionDirectory(forked, target.worktreePath);
      stored = await this.store.updateAgentSession(target.id, {
        providerSessionId: forked.id,
        providerSessionTreeId: forked.id,
        providerForkedFromSessionId: sourceProviderId,
        relationshipState: 'RESOLVED',
        status: 'IDLE',
        materialized: true,
        requestedSettings: input.settings,
        observedSettings: settingsFromSession(forked, input.settings),
        lastAttachedAt: new Date().toISOString()
      });
    } catch (cause) {
      throw new AgentMutationAmbiguousError(
        'session/fork',
        `OpenCode created fork ${forked.id}, but Task Monki could not durably record its ownership: ${errorMessage(cause)} Automatic resubmission is disabled.`
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
      throw mapOpenCodeMutationError(`${mapped.path}/reply`, cause);
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
      throw new AgentMutationAmbiguousError(
        `${mapped.path}/reply`,
        `OpenCode acknowledged the ${mapped.path} reply, but Task Monki could not durably record it: ${errorMessage(cause)} Automatic resubmission is disabled.`
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
    this.eventStreams.clear();
    await Promise.allSettled([...this.inboundQueues.values()]);
    if (this.catalogRefreshPromise) await this.catalogRefreshPromise.catch(() => undefined);
    const failures: unknown[] = [];
    for (const runId of [...this.streamBuffers.keys()]) {
      try {
        await this.materializeRunStreamBuffer(runId);
      } catch (cause) {
        failures.push(cause);
      }
    }
    const supervisorResults = await Promise.allSettled(
      [...this.supervisors.values()].map((supervisor) => supervisor.shutdown())
    );
    this.supervisors.clear();
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
    const supervisor = this.createSupervisor(runtime, this.options.cwd);
    try {
      const { client } = await supervisor.start();
      const catalog = parseOpenCodeProviderCatalog((await client.get<unknown>('/provider')).data);
      this.applyCatalog(catalog, runtime);
    } finally {
      await supervisor.shutdown().catch(() => undefined);
    }
  }

  private applyCatalog(
    catalog: ReturnType<typeof parseOpenCodeProviderCatalog>,
    runtime: ResolvedOpenCodeRuntime
  ): void {
    this.models = mapOpenCodeModels(catalog);
    this.nativeCatalogState = JSON.parse(
      JSON.stringify({
        connectedProviders: catalog.connected ?? catalog.providers.map((provider) => provider.id),
        defaults: catalog.defaults,
        providers: catalog.providers.map((provider) => ({
          id: provider.id,
          name: provider.name ?? provider.id,
          modelCount: Object.keys(provider.models).length
        }))
      })
    ) as AgentJsonValue;
    const providerCount = new Set(this.models.map((model) => model.modelProvider)).size;
    this.preflightState = {
      runtime: this.descriptor,
      ready: this.models.length > 0,
      capabilities: opencodeCapabilities(),
      runtimeVersion: runtime.version,
      accountLabel: providerCount > 0
        ? `${providerCount} connected provider${providerCount === 1 ? '' : 's'}`
        : undefined,
      problems: this.models.length > 0 ? [] : ['OpenCode has no connected provider models.'],
      warnings: [
        'OpenCode does not provide an attested OS or network sandbox. Mutation tools remain approval-gated, while process network is provider-controlled.',
        ...(this.runtimeReconfigurationPending
          ? ['The saved OpenCode executable change is pending a safe runtime restart.']
          : [])
      ]
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
        this.preflightState = {
          ...this.preflightState,
          warnings: [
            ...new Set([
              ...this.preflightState.warnings,
              `OpenCode provider catalog refresh failed: ${errorMessage(cause)}`
            ])
          ]
        };
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
    this.appEvents.emit({
      type: 'runtime.updated',
      taskId: `runtime:${this.descriptor.id}`,
      payload: {
        preflight: structuredClone(this.preflightState),
        models: structuredClone(this.models),
        native: this.nativeCatalogState === undefined
          ? undefined
          : structuredClone(this.nativeCatalogState)
      },
      at: new Date().toISOString()
    });
  }

  private async ensureSessionRuntime(
    session: AgentSessionRecord
  ): Promise<{ client: OpenCodeClientTransport; server: { id: string } }> {
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
          await this.handleRuntimeLoss(server.id);
          this.scheduleSessionRecovery(session.id);
        });
      });
      this.supervisors.set(session.id, supervisor);
    }
    const running = await supervisor.start();
    return { client: running.client, server: running.server };
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
        await this.enqueueInbound(session.id, () => this.handleEvent(value, raw, serverId));
      },
      onDisconnect: async (error) => {
        await supervisor?.markDegraded(error.message);
        const run = await this.getCurrentRunForSession(session.id);
        if (run) await this.recordRunActivity(run, 'runtime/sse/disconnected', { reason: error.message });
      },
      onReconnect: async () => {
        await supervisor?.markRunning();
        await this.reconcileSession(session.id);
      }
    });
    this.eventStreams.set(session.id, stream);
    await supervisor?.markRunning();
  }

  private enqueueInbound(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const queued = (this.inboundQueues.get(sessionId) ?? Promise.resolve())
      .then(operation)
      .catch((cause) => this.recordProtocolIncident(sessionId, cause));
    const tracked = queued.finally(() => {
      if (this.inboundQueues.get(sessionId) === tracked) this.inboundQueues.delete(sessionId);
    });
    this.inboundQueues.set(sessionId, tracked);
    return tracked;
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
        await this.handleSessionStatus(event);
        return;
      case 'session.idle':
        await this.handleSessionIdle(event);
        return;
      case 'message.updated':
        await this.handleMessageUpdated(event, raw);
        return;
      case 'message.part.updated':
      case 'message.part.delta':
        await this.handlePartUpdated(event, raw);
        return;
      case 'todo.updated':
        await this.handleTodoUpdated(event, raw);
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
        await this.handleChildSession(event, raw);
        return;
      case 'session.error':
        await this.handleSessionError(event);
        return;
      default: {
        const sessionId = stringProperty(event.properties, 'sessionID');
        const session = sessionId
          ? await this.store.getAgentSessionByProviderId(this.descriptor.id, sessionId)
          : undefined;
        const run = session ? await this.getCurrentRunForSession(session.id) : undefined;
        if (run) await this.recordRunActivity(run, event.type, { eventId: event.id });
      }
    }
  }

  private async handleSessionStatus(event: OpenCodeEvent): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    if (!providerSessionId) return;
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId);
    if (!session) return;
    const status = mapOpenCodeSessionStatus(event.properties.status);
    await this.store.updateAgentSession(session.id, { status });
    const run = await this.getCurrentRunForSession(session.id);
    if (run) await this.recordRunActivity(run, 'session/status', { status: event.properties.status });
    if (status === 'IDLE') {
      await this.reconcileSession(session.id);
      this.scheduleSessionIdleEviction(session.id);
    }
  }

  private async handleSessionIdle(event: OpenCodeEvent): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    const session = providerSessionId
      ? await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    if (session) {
      await this.reconcileSession(session.id);
      this.scheduleSessionIdleEviction(session.id);
    }
  }

  private async handleMessageUpdated(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const info = asRecord(event.properties.info) as unknown as OpenCodeMessageInfo | undefined;
    if (!info || typeof info.id !== 'string' || typeof info.sessionID !== 'string') return;
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, info.sessionID);
    if (!session) return;
    const run = await this.getCurrentRunForSession(session.id);
    if (!run) return;
    if (info.role === 'user' && info.id === run.providerTurnId) {
      const observed = settingsFromMessage(info, run.requestedSettings);
      if (run.status === 'RECOVERY_REQUIRED') {
        await this.recordReconciliation(run, 'RUNNING', 'RECOVERED', false);
      }
      await this.store.updateRun(run.id, { observedSettings: observed, status: 'RUNNING' });
      await this.store.updateAgentSession(session.id, { observedSettings: observed, status: 'ACTIVE' });
      await this.recordSettingsObservation(session, 'THREAD_SETTINGS_NOTIFICATION', observed, run.id, raw);
      return;
    }
    if (info.role === 'assistant' && (info.time?.completed || info.finish || info.error)) {
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
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const part = asRecord(event.properties.part) as unknown as OpenCodePart | undefined;
    if (!part || typeof part.id !== 'string' || typeof part.sessionID !== 'string') return;
    const session = await this.store.getAgentSessionByProviderId(this.descriptor.id, part.sessionID);
    const run = session ? await this.getCurrentRunForSession(session.id) : undefined;
    if (!session || !run) return;
    const isUserPart = part.messageID === run.providerTurnId;
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
      payload: part,
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
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    const session = providerSessionId
      ? await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    const run = session ? await this.getCurrentRunForSession(session.id) : undefined;
    if (!session || !run) return;
    const steps = mapOpenCodeTodoSteps(event.properties.todos);
    await this.store.recordAgentPlanRevision({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      runtimeId: this.descriptor.id,
      steps,
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
    if (!session) return;
    await this.materializeInteraction(
      session,
      permission.id,
      mapOpenCodePermission(permission, session.worktreePath),
      raw,
      serverId
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
    if (!session) return;
    await this.materializeInteraction(session, question.id, mapOpenCodeQuestion(question), raw, serverId);
  }

  private async materializeInteraction(
    session: AgentSessionRecord,
    providerRequestId: string,
    mapped: MappedOpenCodeInteraction,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const run = await this.getCurrentRunForSession(session.id);
    if (!run || run.serverInstanceId !== serverId) return;
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
      request: mapped.request,
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
    if (!interaction || interaction.status !== 'PENDING') return;
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
    raw: AgentProtocolMessageReference
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
    if (!parent) return;
    const parentRun = await this.getCurrentRunForSession(parent.id);
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

  private async handleSessionError(event: OpenCodeEvent): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    const session = providerSessionId
      ? await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    const run = session ? await this.getCurrentRunForSession(session.id) : undefined;
    if (!run) return;
    await this.finalizeRun(run, 'FAILED', errorMessage(event.properties.error ?? 'OpenCode session error.'));
    if (session) {
      await this.store.updateAgentSession(session.id, { status: 'SYSTEM_ERROR' });
      this.scheduleSessionIdleEviction(session.id);
    }
  }

  private async reconcileRun(run: RunRecord): Promise<'reconciled' | 'recovery-required'> {
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
    if (TERMINAL_RUN_STATES.includes(run.status)) return 'reconciled';
    const session = await this.requireSession(run.sessionId);
    if (!session.providerSessionId) {
      await this.recordReconciliation(run, 'RECOVERY_REQUIRED', 'REQUIRES_USER_ACTION', false);
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
    const status = await this.readProviderSessionStatus(client, session.providerSessionId);
    const assistant = latestAssistantFor(messages, userMessage.info.id);
    if (assistant && status === 'IDLE') {
      await this.finalizeFromSnapshot(run, session, assistant, messagesResult.raw);
    } else if (status === 'ACTIVE') {
      await this.recordReconciliation(run, 'RUNNING', 'RECOVERED', false);
      await this.store.updateAgentSession(session.id, { status: 'ACTIVE', materialized: true });
    } else {
      await this.recordReconciliation(run, 'RECOVERY_REQUIRED', 'REQUIRES_USER_ACTION', false);
      await this.reconcilePendingInteractions(session, client, serverId);
      return 'recovery-required';
    }
    await this.reconcilePendingInteractions(session, client, serverId);
    return 'reconciled';
  }

  private async reconcileSession(
    sessionId: string
  ): Promise<'none' | 'reconciled' | 'recovery-required'> {
    const run = await this.getCurrentRunForSession(sessionId);
    return run ? this.reconcileRun(run) : 'none';
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
    for (const permission of parseOpenCodePermissions(permissionsResult.data)) {
      if (permission.sessionID !== session.providerSessionId) continue;
      await this.materializeInteraction(
        session,
        permission.id,
        mapOpenCodePermission(permission, session.worktreePath),
        permissionsResult.raw,
        serverId
      );
    }
    for (const question of parseOpenCodeQuestions(questionsResult.data)) {
      if (question.sessionID !== session.providerSessionId) continue;
      await this.materializeInteraction(
        session,
        question.id,
        mapOpenCodeQuestion(question),
        questionsResult.raw,
        serverId
      );
    }
  }

  private async finalizeFromSnapshot(
    run: RunRecord,
    session: AgentSessionRecord,
    assistant: OpenCodeMessage,
    raw: AgentProtocolMessageReference
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
        payload: part,
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
    const providerError = openCodeMessageError(assistant.info);
    const interrupted = providerError ? /abort|interrupt/i.test(JSON.stringify(assistant.info.error)) : false;
    const status: Extract<RunRecord['status'], 'COMPLETED' | 'FAILED' | 'INTERRUPTED'> = providerError
      ? interrupted
        ? 'INTERRUPTED'
        : 'FAILED'
      : current.status === 'INTERRUPTING'
        ? 'INTERRUPTED'
        : 'COMPLETED';
    await this.recordRunActivity(current, 'message/completed', {
      messageText: finalMessage,
      providerMessageId: assistant.info.id
    });
    await this.finalizeRun(current, status, providerError, finalMessage);
    await this.store.updateAgentSession(session.id, { status: 'IDLE', materialized: true });
    this.scheduleSessionIdleEviction(session.id);
  }

  private async finalizeRun(
    run: RunRecord,
    status: Extract<RunRecord['status'], 'COMPLETED' | 'FAILED' | 'INTERRUPTED'>,
    error?: string,
    finalMessage = ''
  ): Promise<void> {
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
        source: 'provider',
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

  private async handleRuntimeLoss(serverInstanceId: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    const runs = snapshot.runs.filter(
      (run) => run.serverInstanceId === serverInstanceId && ACTIVE_RUN_STATES.includes(run.status)
    );
    for (const run of runs) {
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
          payload: { reason: 'OpenCode session runtime exited unexpectedly.' }
        })
      );
      this.emitRunActivity(run, {
        eventType: 'runtime/lost',
        reason: 'OpenCode session runtime exited unexpectedly.'
      });
      await this.store.updateAgentSession(run.sessionId, { status: 'NOT_LOADED' });
    }
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) => candidate.serverInstanceId === serverInstanceId && ['PENDING', 'RESPONDING'].includes(candidate.status)
    )) {
      const aborted = await this.store.transitionInteractionRequest(interaction.id, interaction.status, {
        status: 'ABORTED_SERVER_LOST',
        resolution: { reason: 'OpenCode session runtime exited.' },
        resolvedAt: new Date().toISOString()
      });
      this.emitInteractionUpdate(aborted);
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
    this.cancelSessionIdleEviction(sessionId);
    const recoveryTimer = this.recoveryTimers.get(sessionId);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    this.recoveryTimers.delete(sessionId);
    this.recoveryAttempts.delete(sessionId);
    const stream = this.eventStreams.get(sessionId);
    stream?.stop();
    this.eventStreams.delete(sessionId);
    for (const buffer of this.streamBuffers.values()) {
      if (buffer.sessionId === sessionId && buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = undefined;
      }
    }
    if (waitForInbound) {
      const pending = this.inboundQueues.get(sessionId);
      if (pending) await pending;
      this.cancelSessionIdleEviction(sessionId);
    }
    for (const buffer of [...this.streamBuffers.values()]) {
      if (buffer.sessionId === sessionId) {
        await this.materializeRunStreamBuffer(buffer.runId);
      }
    }
    const supervisor = this.supervisors.get(sessionId);
    this.supervisors.delete(sessionId);
    if (supervisor) await supervisor.shutdown();
    const session = await this.store.getAgentSession(sessionId).catch(() => undefined);
    if (session) await this.store.updateAgentSession(sessionId, { status: 'NOT_LOADED' });
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
    this.models = [];
    this.nativeCatalogState = undefined;
    this.runtimeReconfigurationPending = false;
    this.shuttingDown = false;
    this.preflightState = {
      runtime: this.descriptor,
      ready: false,
      capabilities: opencodeCapabilities(),
      problems: ['OpenCode executable discovery must be refreshed.'],
      warnings: [
        'Runtime discovery and provider catalog probing will run when OpenCode is initialized.'
      ]
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
          problems: [
            ...new Set([...this.preflightState.problems, errorMessage(cause)])
          ]
        };
        this.emitRuntimeUpdate();
      });
    }, 0);
    timer.unref();
    this.runtimeConfigurationResetTimer = timer;
  }

  private async readProviderSessionStatus(
    client: OpenCodeClientTransport,
    providerSessionId: string
  ): Promise<AgentSessionRecord['status']> {
    const value = (await client.get<unknown>('/session/status')).data;
    const statuses = asRecord(value);
    return mapOpenCodeSessionStatus(statuses?.[providerSessionId] ?? { type: 'idle' });
  }

  private async recordSettingsObservation(
    session: AgentSessionRecord,
    source: 'THREAD_START_RESPONSE' | 'THREAD_SETTINGS_NOTIFICATION' | 'RECOVERY_RESUME_RESPONSE',
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
        payload: entry.part,
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
        payload: { parseError: errorMessage(cause) }
      })
    );
    this.emitRunActivity(run, {
      eventType: 'runtime/protocol-incident',
      error: errorMessage(cause)
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

function settingsFromMessage(
  info: OpenCodeMessageInfo,
  fallback: AgentExecutionSettings
): AgentExecutionSettings {
  return {
    ...fallback,
    runtimeId: OPENCODE_RUNTIME_ID,
    modelProvider: info.providerID ?? info.model?.providerID ?? fallback.modelProvider,
    model: info.modelID ?? info.model?.modelID ?? info.model?.id ?? fallback.model,
    reasoningEffort: info.variant ?? fallback.reasoningEffort
  };
}

function assertSessionDirectory(session: OpenCodeSession, expected: string): void {
  if (path.resolve(session.directory) !== path.resolve(expected)) {
    throw new Error(
      `OpenCode session directory ${session.directory} does not match its Task Monki worktree.`
    );
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
