import type {
  AgentCommandApprovalDecision,
  AgentExecutionSettings,
  AgentItemRecord,
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
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  type AgentInteractionResponse,
  type AgentReconciliationResult,
  type AgentRuntimeAdapter,
  type AgentSessionRef,
  type AgentTurn,
  type CreateAgentSession,
  type InterruptAgentTurn,
  type ResolveAgentExecution,
  type ResolvedAgentExecution,
  type StartAgentTurn
} from '../AgentRuntimeAdapter';
import {
  type AgentTurnAttachment
} from '../AgentAttachmentDelivery';
import { interactionTerminalStatus } from '../AgentInteractionPolicy';
import {
  agentReviewStatusFromResult,
  parseAgentReviewResult
} from '../../review/CodexReviewContract';
import {
  parseConfigOptions,
  parseNewSessionResponse,
  parsePermissionRequest,
  parsePromptResponse,
  parseSessionNotification,
  parseSessionSetupResponse,
  type AcpInitializeResponse,
  type AcpJsonRpcRequest,
  type AcpPermissionOption,
  type AcpSessionConfigOption,
  type AcpSessionModeState,
  type AcpSessionUpdate,
  type AcpToolCallUpdate
} from './AcpProtocol';
import {
  AcpAmbiguousMutationError,
  type AcpRpcClient,
  type AcpRpcResult
} from './AcpRpcClient';
import {
  acpTextBlock,
  mapAcpPlanEntries,
  mapAcpToolKind,
  mapAcpToolStatus,
  modelsFromAcpConfig,
  observedSettingsFromAcpState,
  permissionOutcomeForDecision,
  promptInputModalities,
  requestedNativeConfigValues,
  textFromAcpContent,
  type AcpNativeSessionState
} from './AcpEventMapper';
import {
  acpCapabilities,
  defaultAcpModel,
  type AcpRuntimeProfile
} from './AcpRuntimeProfiles';
import {
  resolveAcpRuntime,
  type ResolveAcpRuntimeOptions,
  type ResolvedAcpRuntime
} from './AcpRuntimeResolver';
import { AcpStdioSupervisor } from './AcpStdioSupervisor';
import { materializeAcpPermission } from './AcpPermissionPolicy';
import {
  acpInitializeNativeView,
  normalizeAcpOperationalSession,
  redactAcpNativeValue,
  redactNativeString,
  sanitizeAcpNativeSession
} from './AcpNativeRedaction';

const ACTIVE_RUN_STATUSES: RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
];
const INTERRUPT_COMPLETION_TIMEOUT_MS = 15_000;
const STREAM_OUTPUT_FLUSH_INTERVAL_MS = 75;
const STREAM_OUTPUT_FLUSH_BYTES = 64 * 1024;
const STREAM_TEXT_SEGMENT_BYTES = 8 * 1024;
const MAX_BUFFERED_OUTPUT_GROUPS = 256;
const MAX_BUFFERED_STREAM_PARTS_PER_RUN = 8;
const MAX_BUFFERED_STREAM_BYTES = 4 * 1024 * 1024;

interface BufferedAcpTextSegment {
  text: string;
  byteCount: number;
}

interface BufferedAcpContentPart {
  messageId: string;
  updateType: string;
  itemType: AgentItemRecord['type'];
  chunks: BufferedAcpTextSegment[];
  byteCount: number;
  raw: AgentProtocolMessageReference;
  eventCount: number;
}

interface BufferedAcpOutput {
  source: string;
  chunks: BufferedAcpTextSegment[];
  byteCount: number;
}

interface AcpRunStreamBuffer {
  runId: string;
  sessionId: string;
  parts: Map<string, BufferedAcpContentPart>;
  partBytes: number;
  output: BufferedAcpOutput[];
  outputBytes: number;
  timer?: NodeJS.Timeout;
}

export interface AcpRuntimeAdapterOptions
  extends Omit<ResolveAcpRuntimeOptions, 'cwd'> {
  cwd: string;
  appVersion?: string;
  requestTimeoutMs?: number;
  interruptCompletionTimeoutMs?: number;
  runtimeResolver?: (
    profile: AcpRuntimeProfile,
    options: ResolveAcpRuntimeOptions
  ) => Promise<ResolvedAcpRuntime>;
}

/**
 * First-class ACP runtime. Each instance owns one concrete provider profile;
 * no operation can fall through to another profile or model provider.
 */
export class AcpRuntimeAdapter implements AgentRuntimeAdapter {
  readonly descriptor;

  private supervisor?: AcpStdioSupervisor;
  private resolvedRuntime?: ResolvedAcpRuntime;
  private resolutionPromise?: Promise<ResolvedAcpRuntime>;
  private boundClient?: AcpRpcClient;
  private initializeResponse?: AcpInitializeResponse;
  private initialized = false;
  private nativeSessions = new Map<string, AcpNativeSessionState>();
  private models: AgentModel[];
  private preflightState: AgentPreflight;
  private inboundQueue: Promise<void> = Promise.resolve();
  private interruptTimers = new Map<string, NodeJS.Timeout>();
  private activePromptRunIds = new Set<string>();
  private provisionalProviderSessionIds = new Map<string, string>();
  private replayingProviderSessionIds = new Set<string>();
  private streamBuffers = new Map<string, AcpRunStreamBuffer>();
  private bufferedStreamBytes = 0;
  private readonly interruptCompletionTimeoutMs: number;
  private configuredExecutable?: string;
  private runtimeReconfigurationPending = false;
  private runtimeResetTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: FileTaskStore,
    private readonly appEvents: AppEventBus,
    readonly profile: AcpRuntimeProfile,
    private readonly options: AcpRuntimeAdapterOptions
  ) {
    this.descriptor = profile.descriptor;
    this.interruptCompletionTimeoutMs =
      options.interruptCompletionTimeoutMs ?? INTERRUPT_COMPLETION_TIMEOUT_MS;
    this.configuredExecutable = normalizeExecutableOverride(options.executable);
    this.models = [defaultAcpModel(profile)];
    this.preflightState = {
      runtime: profile.descriptor,
      ready: false,
      capabilities: acpCapabilities(profile),
      problems: [`${profile.descriptor.displayName} has not been initialized.`],
      warnings: [
        'ACP client filesystem and terminal capabilities are disabled; the agent must use its own tools.'
      ]
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      await this.recoverPersistedRuntimeLosses();
      // Cold recovery is passive: advance persisted ambiguous runs to a
      // user-actionable reconciliation state without launching an ACP child,
      // attaching a session, or replaying a prompt. This must not depend on
      // the configured executable still being installed.
      await this.reconcile();
      const runtime = await this.ensureResolvedRuntime();
      this.setDiscoveryPreflight(runtime);
    } catch (cause) {
      this.initialized = false;
      throw cause;
    }
  }

  async preflight(): Promise<AgentPreflight> {
    try {
      const runtime = await this.ensureResolvedRuntime();
      if (!this.supervisor?.currentClient) this.setDiscoveryPreflight(runtime);
    } catch (cause) {
      this.preflightState = {
        runtime: this.descriptor,
        ready: false,
        capabilities: this.currentCapabilities(),
        problems: [errorMessage(cause)],
        warnings: [
          'ACP client filesystem and terminal capabilities are disabled; the agent must use its own tools.'
        ]
      };
    }
    return structuredClone(this.preflightState);
  }

  capabilities(): Promise<AgentRuntimeCapabilities> {
    return Promise.resolve(this.currentCapabilities());
  }

  async listModels(): Promise<AgentModel[]> {
    await this.ensureResolvedRuntime();
    return structuredClone(this.models);
  }

  async readNativeState(): Promise<import('../../../shared/agent').AgentJsonValue> {
    const snapshot = await this.store.snapshot();
    const persistedSessions = snapshot.agentSessions
      .filter((session) => session.runtimeId === this.descriptor.id)
      .map((session) => ({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId,
        runtimeOptions: session.observedSettings?.runtimeOptions?.[this.descriptor.id]
      }));
    return redactAcpNativeValue({
      protocol: { wireVersion: 1, schemaArtifactVersion: '1.19.0' },
      initialize: acpInitializeNativeView(this.initializeResponse),
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      sessions: [
        ...[...this.nativeSessions.values()].map(sanitizeAcpNativeSession),
        ...persistedSessions.filter(
          (session) =>
            !session.providerSessionId || !this.nativeSessions.has(session.providerSessionId)
        )
      ]
    });
  }

  async configureRuntime(input: { executable?: string; restart: boolean }): Promise<void> {
    const executable = normalizeExecutableOverride(input.executable);
    const changed = executable !== this.configuredExecutable;
    this.configuredExecutable = executable;
    if (!changed && !input.restart) return;

    if (await this.hasUnsafeRuntimeWork()) {
      this.runtimeReconfigurationPending = true;
      this.preflightState = {
        ...this.preflightState,
        warnings: [
          ...new Set([
            ...this.preflightState.warnings,
            'The ACP executable change is saved and will be applied after the current provider turn reaches a definitive terminal state.'
          ])
        ]
      };
      this.emitRuntimeUpdate();
      return;
    }
    await this.resetRuntimeForConfiguration();
  }

  async resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution> {
    assertAcpManagedAttachmentsUnsupported(this.profile, input.attachments);
    assertAcpExecutionPolicy(this.profile, input.settings);
    await this.ensureResolvedRuntime();
    const requestedModel = input.settings.model;
    let model =
      this.models.find((candidate) => candidate.id === requestedModel) ??
      this.models.find((candidate) => candidate.model === requestedModel) ??
      this.models.find((candidate) => candidate.isDefault) ??
      this.models[0];
    if (!model) throw new Error(`${this.descriptor.displayName} has no selectable model.`);
    if (
      requestedModel &&
      requestedModel !== model.id &&
      requestedModel !== model.model &&
      requestedModel !== 'default'
    ) {
      // ACP exposes model catalogs only after session setup. Preserve explicit
      // native values instead of rejecting a valid provider-specific choice.
      model = {
        ...model,
        id: `${this.descriptor.id}:${input.settings.modelProvider ?? this.profile.defaultModelProvider}/${requestedModel}`,
        model: requestedModel,
        displayName: requestedModel,
        isDefault: false,
        native: { source: 'explicit-runtime-setting' }
      };
    }
    const settings: AgentExecutionSettings = {
      ...input.settings,
      runtimeId: this.descriptor.id,
      model: model.model,
      modelProvider: input.settings.modelProvider ?? model.modelProvider
    };
    return { settings, model };
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    const local = await this.requireSession(input.localSessionId);
    this.assertSessionOwnership(local);
    assertAcpExecutionPolicy(this.profile, input.settings);
    const provisionalProviderSessionId = this.provisionalProviderSessionIds.get(local.id);
    if (provisionalProviderSessionId) {
      const client = await this.ensureClient();
      let provisional = this.nativeSessions.get(provisionalProviderSessionId);
      if (!provisional) {
        await this.attachSession({
          localSessionId: local.id,
          providerSessionId: provisionalProviderSessionId
        });
        provisional = this.nativeSessions.get(provisionalProviderSessionId);
      }
      if (!provisional) {
        throw new AgentProviderSessionMissingError(
          'session/new',
          `ACP created session ${provisionalProviderSessionId}, but its native state could not be recovered.`
        );
      }
      return this.completeCreatedSession(local, provisional, input.settings, client);
    }
    if (local.providerSessionId) {
      return this.attachSession({
        localSessionId: local.id,
        providerSessionId: local.providerSessionId
      });
    }

    const client = await this.ensureClient();
    let response: AcpRpcResult<unknown>;
    try {
      response = await client.requestMutation('session/new', {
        cwd: input.worktreePath,
        mcpServers: []
      });
    } catch (cause) {
      throw mapMutationError('session/new', cause);
    }
    const setup = parseNewSessionResponse(response.result);
    let state: AcpNativeSessionState = {
      sessionId: setup.sessionId,
      modes: setup.modes ?? null,
      configOptions: setup.configOptions ?? []
    };
    state = normalizeAcpOperationalSession(state);
    this.nativeSessions.set(state.sessionId, state);
    return this.completeCreatedSession(local, state, input.settings, client, response.raw);
  }

  private async completeCreatedSession(
    local: AgentSessionRecord,
    initialState: AcpNativeSessionState,
    settings: AgentExecutionSettings,
    client: AcpRpcClient,
    raw?: AgentProtocolMessageReference
  ): Promise<AgentSessionRecord> {
    let state = initialState;
    this.provisionalProviderSessionIds.set(local.id, state.sessionId);
    const initialObservedSettings = observedSettingsFromAcpState(
      this.profile,
      state,
      settings
    );
    try {
      // Persist provider ownership before issuing follow-up configuration
      // mutations. A failed mode/model update can then resume this exact
      // session instead of creating an orphan or duplicating it on retry.
      await this.store.updateAgentSession(local.id, {
        providerSessionId: state.sessionId,
        status: 'NOT_LOADED',
        materialized: false,
        requestedSettings: settings,
        observedSettings: initialObservedSettings,
        lastAttachedAt: new Date().toISOString()
      });
    } catch (cause) {
      throw new AgentMutationAmbiguousError(
        'session/new',
        `ACP created session ${state.sessionId}, but Task Monki could not persist its ownership: ${errorMessage(cause)}`
      );
    }
    state = await this.applyRequestedNativeSettings(client, state, settings);
    const observedSettings = observedSettingsFromAcpState(
      this.profile,
      state,
      settings
    );
    const stored = await this.store.updateAgentSession(local.id, {
      status: 'IDLE',
      materialized: false,
      requestedSettings: settings,
      observedSettings,
      lastAttachedAt: new Date().toISOString()
    });
    this.provisionalProviderSessionIds.delete(local.id);
    await this.recordSettingsObservation(
      stored,
      'THREAD_START_RESPONSE',
      observedSettings,
      raw
    );
    this.refreshModels();
    this.emitRuntimeUpdate();
    return stored;
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    const session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    const providerSessionId = ref.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId) {
      throw new AgentProviderSessionMissingError(
        'session/attach',
        `ACP session ${session.id} has no provider session ID.`
      );
    }
    const existing = this.nativeSessions.get(providerSessionId);
    if (existing) {
      const stored = await this.store.updateAgentSession(session.id, {
        providerSessionId,
        status: 'IDLE',
        observedSettings: observedSettingsFromAcpState(
          this.profile,
          existing,
          session.requestedSettings
        ),
        lastAttachedAt: new Date().toISOString()
      });
      this.provisionalProviderSessionIds.delete(session.id);
      return stored;
    }

    const client = await this.ensureClient();
    const capabilities = this.initializeResponse?.agentCapabilities;
    const method = capabilities?.sessionCapabilities?.resume
      ? 'session/resume'
      : capabilities?.loadSession
        ? 'session/load'
        : undefined;
    if (!method) {
      throw new AgentProviderSessionMissingError(
        'session/attach',
        `${this.descriptor.displayName} advertised neither ACP session/resume nor session/load.`
      );
    }
    let response: AcpRpcResult<unknown>;
    if (method === 'session/load') this.replayingProviderSessionIds.add(providerSessionId);
    try {
      response = await client.requestMutation(method, {
        sessionId: providerSessionId,
        cwd: session.worktreePath,
        mcpServers: []
      });
    } catch (cause) {
      throw mapMutationError(method, cause);
    } finally {
      // session/load streams historical session/update records before its
      // response. Drain already-enqueued updates while the replay guard is set
      // so history cannot be mistaken for output from an ambiguous live run.
      await this.inboundQueue;
      this.replayingProviderSessionIds.delete(providerSessionId);
    }
    const setup = parseSessionSetupResponse(response.result);
    const state = normalizeAcpOperationalSession({
      sessionId: providerSessionId,
      modes: setup.modes ?? null,
      configOptions: setup.configOptions ?? []
    });
    this.nativeSessions.set(providerSessionId, state);
    const observedSettings = observedSettingsFromAcpState(
      this.profile,
      state,
      session.requestedSettings
    );
    const stored = await this.store.updateAgentSession(session.id, {
      providerSessionId,
      status: 'IDLE',
      materialized: true,
      observedSettings,
      lastAttachedAt: new Date().toISOString()
    });
    this.provisionalProviderSessionIds.delete(session.id);
    await this.recordSettingsObservation(
      stored,
      'THREAD_RESUME_RESPONSE',
      observedSettings,
      response.raw
    );
    this.refreshModels();
    return stored;
  }

  async releaseSession(ref: AgentSessionRef): Promise<void> {
    // A terminal run projection can become visible before its serialized
    // inbound handler finishes the corresponding session update. Drain that
    // queue so release state cannot be overwritten by a late terminal write.
    await this.inboundQueue;
    const session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    const snapshot = await this.store.snapshot();
    const activeRun = snapshot.runs.find(
      (run) => run.sessionId === session.id && ACTIVE_RUN_STATUSES.includes(run.status)
    );
    if (activeRun) {
      throw new Error(
        `Cannot release ACP session ${session.id} while run ${activeRun.id} is ${activeRun.status}.`
      );
    }
    const pendingInteraction = snapshot.interactionRequests.find(
      (interaction) =>
        interaction.sessionId === session.id &&
        ['PENDING', 'RESPONDING'].includes(interaction.status)
    );
    if (pendingInteraction) {
      throw new Error(
        `Cannot release ACP session ${session.id} while interaction ${pendingInteraction.id} is ${pendingInteraction.status}.`
      );
    }

    const providerSessionId =
      ref.providerSessionId ??
      session.providerSessionId ??
      this.provisionalProviderSessionIds.get(session.id);
    const client = this.supervisor?.currentClient;
    const supportsClose = Boolean(
      this.initializeResponse?.agentCapabilities.sessionCapabilities?.close
    );
    if (
      providerSessionId &&
      client &&
      supportsClose &&
      this.nativeSessions.has(providerSessionId)
    ) {
      try {
        await client.requestMutation('session/close', { sessionId: providerSessionId });
      } catch (cause) {
        throw mapMutationError('session/close', cause);
      }
    }

    if (providerSessionId) {
      this.nativeSessions.delete(providerSessionId);
      this.replayingProviderSessionIds.delete(providerSessionId);
    }
    for (const [localSessionId, provisionalProviderSessionId] of
      this.provisionalProviderSessionIds) {
      if (
        localSessionId === session.id ||
        provisionalProviderSessionId === providerSessionId
      ) {
        this.provisionalProviderSessionIds.delete(localSessionId);
      }
    }
    await this.store.updateAgentSession(session.id, { status: 'NOT_LOADED' });
    this.refreshModels();
    this.emitRuntimeUpdate();
    await this.stopUnusedRuntimeProcess();
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
    const session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    const snapshot = await this.store.snapshot();
    return {
      session,
      runs: snapshot.runs
        .filter((run) => run.sessionId === session.id)
        .map((run) => ({ id: run.id, providerTurnId: run.providerTurnId, status: run.status }))
    };
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    assertAcpManagedAttachmentsUnsupported(this.profile, input.attachments ?? []);
    let session = await this.requireSession(input.session.localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) {
      session = await this.createSession({
        runtimeId: this.descriptor.id,
        localSessionId: session.id,
        taskId: session.taskId,
        iterationId: session.iterationId,
        worktreeId: session.worktreeId,
        worktreePath: session.worktreePath,
        settings: input.settings ?? session.requestedSettings
      });
    } else if (!this.nativeSessions.has(session.providerSessionId)) {
      // Provider session IDs survive process restarts, but the new ACP process
      // must explicitly resume/load the conversation before receiving a turn.
      session = await this.attachSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
    }
    if (!session.providerSessionId) throw new Error('ACP session setup did not return an ID.');
    const competing = await this.store.getActiveRunForSession(session.id);
    if (competing && competing.id !== input.localRunId && ACTIVE_RUN_STATUSES.includes(competing.status)) {
      throw new Error(`ACP session ${session.id} already has active run ${competing.id}.`);
    }

    const settings = input.settings ?? session.requestedSettings;
    assertAcpExecutionPolicy(this.profile, settings);
    const prompt = [acpTextBlock(input.prompt)];
    const client = await this.ensureClient();
    const server = this.supervisor?.currentServer;
    if (!server) throw new Error('ACP runtime is not ready.');
    await this.store.updateRun(input.localRunId, {
      serverInstanceId: server.id,
      status: 'STARTING',
      lastEventAt: new Date().toISOString()
    });

    let started;
    this.activePromptRunIds.add(input.localRunId);
    try {
      started = await client.startMutation<unknown>('session/prompt', {
        sessionId: session.providerSessionId,
        prompt
      });
    } catch (cause) {
      this.activePromptRunIds.delete(input.localRunId);
      throw mapMutationError('session/prompt', cause);
    }
    // The agent may reject immediately while durable run acknowledgement is
    // still being written. Attach a rejection observer now; the authoritative
    // terminal handler is registered below after persistence succeeds.
    void started.response.catch(() => undefined);
    const providerTurnId = `${server.id}:${String(started.requestId)}`;
    try {
      await this.store.updateRun(input.localRunId, {
        providerTurnId,
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
      await this.supervisor?.markRunning();
    } catch (cause) {
      this.activePromptRunIds.delete(input.localRunId);
      await this.store.updateAgentSession(session.id, { status: 'NOT_LOADED' })
        .catch(() => undefined);
      throw new AgentMutationAmbiguousError(
        'session/prompt',
        `ACP accepted prompt request ${providerTurnId}, but Task Monki could not persist the acknowledgement: ${errorMessage(cause)}`
      );
    }

    void started.response.then(
      (response) => this.enqueueInbound(() => this.finalizePrompt(input.localRunId, response)),
      (error) => this.enqueueInbound(() => this.handlePromptFailure(input.localRunId, error))
    );
    return { localRunId: input.localRunId, providerTurnId };
  }

  async interruptTurn(input: InterruptAgentTurn): Promise<void> {
    const session = await this.requireSession(input.session.localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) throw new Error('ACP session is not materialized.');
    const run = await this.store.getRunByProviderTurnId(this.descriptor.id, input.providerTurnId);
    if (!run || run.sessionId !== session.id) {
      throw new Error('ACP turn does not belong to the selected session.');
    }
    const client = this.supervisor?.currentClient;
    const server = this.supervisor?.currentServer;
    if (!client || !server || server.id !== run.serverInstanceId) {
      this.activePromptRunIds.delete(run.id);
      await this.store.updateAgentSession(run.sessionId, { status: 'NOT_LOADED' });
      throw new AgentMutationAmbiguousError(
        'session/cancel',
        'The ACP process that owns this turn is no longer available; cancellation delivery cannot be confirmed.'
      );
    }
    await this.store.updateRun(run.id, {
      status: 'INTERRUPTING',
      lastEventAt: new Date().toISOString()
    });
    try {
      await client.notify('session/cancel', { sessionId: session.providerSessionId });
      await this.cancelPendingPermissions(run, client);
    } catch (cause) {
      this.activePromptRunIds.delete(run.id);
      await this.staleRunInteractions(
        run,
        `ACP cancellation is ambiguous: ${errorMessage(cause)}`
      ).catch(() => undefined);
      await this.store.updateAgentSession(run.sessionId, { status: 'NOT_LOADED' })
        .catch(() => undefined);
      throw new AgentMutationAmbiguousError(
        'session/cancel',
        `ACP cancellation delivery is ambiguous: ${errorMessage(cause)}`
      );
    }
    this.armInterruptDeadline(run.id);
  }

  async respondToInteraction(input: AgentInteractionResponse): Promise<void> {
    const interaction = input.interaction;
    if (interaction.status !== 'RESPONDING') {
      throw new Error(`ACP interaction ${interaction.id} must be RESPONDING.`);
    }
    const client = this.supervisor?.currentClient;
    const server = this.supervisor?.currentServer;
    if (!client || !server || server.id !== interaction.serverInstanceId) {
      throw new Error('ACP interaction belongs to a prior runtime process.');
    }
    if (input.decision.interactionType !== 'COMMAND_APPROVAL') {
      throw new Error('ACP stable v1 exposes only permission-option interactions.');
    }
    const options = providerOptions(interaction);
    const outcome = permissionOutcomeForDecision(
      options,
      input.decision as AgentCommandApprovalDecision
    );
    let responseEvidencePersisted = false;
    let responseRaw: AgentProtocolMessageReference;
    try {
      responseRaw = await client.respond(
        interaction.providerRequestId,
        { outcome },
        async (raw) => {
          await this.store.transitionInteractionRequest(interaction.id, 'RESPONDING', {
            status: 'RESPONDING',
            responseRawMessage: raw
          });
          responseEvidencePersisted = true;
        }
      );
    } catch (cause) {
      if (responseEvidencePersisted) {
        throw new AgentMutationAmbiguousError(
          'session/request_permission',
          `ACP permission response delivery is ambiguous after durable submission: ${errorMessage(cause)}`
        );
      }
      throw cause;
    }
    let resolved: InteractionRequestRecord;
    try {
      resolved = await this.store.transitionInteractionRequest(
        interaction.id,
        'RESPONDING',
        {
          status: interactionTerminalStatus(input.decision),
          responseRawMessage: responseRaw,
          resolution: { outcome },
          resolvedAt: new Date().toISOString()
        }
      );
    } catch (cause) {
      throw new AgentMutationAmbiguousError(
        'session/request_permission',
        `ACP permission response was delivered, but local completion persistence failed: ${errorMessage(cause)}`
      );
    }
    this.emitInteractionUpdate(resolved);
  }

  async reconcile(): Promise<AgentReconciliationResult> {
    const runs = await this.store.getRunsRequiringRecovery({
      runtimeId: this.descriptor.id
    });
    const recoveryRequiredSessionIds = new Set<string>();
    const reconciledSessionIds = new Set<string>();
    for (const run of runs) {
      if (
        run.status === 'RECOVERY_REQUIRED' &&
        run.recoveryState === 'REQUIRES_USER_ACTION'
      ) {
        recoveryRequiredSessionIds.add(run.sessionId);
        continue;
      }
      if (
        run.serverInstanceId === this.supervisor?.currentServer?.id &&
        this.activePromptRunIds.has(run.id)
      ) {
        reconciledSessionIds.add(run.sessionId);
        continue;
      }
      recoveryRequiredSessionIds.add(run.sessionId);
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
          payload: {
            status: 'RECOVERY_REQUIRED',
            recoveryState: 'REQUIRES_USER_ACTION',
            terminal: false,
            reason: 'ACP has no prompt-status read method. Task Monki will not replay an ambiguous prompt.'
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
          eventType: 'runtime/recovery-required',
          reason: 'ACP cannot read authoritative prompt status; automatic replay is disabled.'
        },
        at: new Date().toISOString()
      });
    }
    return {
      reconciledSessionIds: [...reconciledSessionIds],
      recoveryRequiredSessionIds: [...recoveryRequiredSessionIds]
    };
  }

  async shutdown(): Promise<void> {
    for (const timer of this.interruptTimers.values()) clearTimeout(timer);
    this.interruptTimers.clear();
    if (this.runtimeResetTimer) clearTimeout(this.runtimeResetTimer);
    this.runtimeResetTimer = undefined;
    // Stop the producer first, then drain every line and terminal rejection it
    // emitted. This prevents shutdown from racing a final stream chunk.
    await this.supervisor?.shutdown();
    await this.inboundQueue;
    await this.flushAllContent(true);
  }

  /** Runtime-specific seam for dedicated ACP configuration UI. */
  async setSessionConfigOption(
    localSessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<import('../../../shared/agent').AgentJsonValue> {
    const session = await this.requireSession(localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) throw new Error('ACP session is not materialized.');
    const current = this.nativeSessions.get(session.providerSessionId);
    if (!current) throw new Error('ACP session native configuration is not loaded.');
    const advertised = current.configOptions.find((option) => option.id === configId);
    if (!advertised) {
      throw new Error(`ACP session did not advertise config option ${configId}.`);
    }
    if ((advertised.type === 'boolean') !== (typeof value === 'boolean')) {
      throw new Error(`ACP config option ${configId} received the wrong value type.`);
    }
    if (advertised.type === 'select' && !selectHasValue(advertised, String(value))) {
      throw new Error(`ACP config option ${configId} does not offer value ${String(value)}.`);
    }
    const client = await this.ensureClient();
    let response: AcpRpcResult<unknown>;
    try {
      response = await client.requestMutation<unknown>('session/set_config_option', {
        sessionId: session.providerSessionId,
        configId,
        ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value })
      });
    } catch (cause) {
      throw mapMutationError('session/set_config_option', cause);
    }
    const record = requireRecord(response.result, 'ACP config response');
    const configOptions = parseConfigOptions(record.configOptions) ?? [];
    const state = { ...current, configOptions };
    try {
      await this.persistNativeState(session, state, response.raw);
    } catch (cause) {
      throw new AgentMutationAmbiguousError(
        'session/set_config_option',
        `ACP applied config option ${configId}, but Task Monki could not persist the observed state: ${errorMessage(cause)}`
      );
    }
    return redactAcpNativeValue(sanitizeAcpNativeSession(state));
  }

  /** Runtime-specific seam for provider modes such as plan/ask/code. */
  async setSessionMode(
    localSessionId: string,
    modeId: string
  ): Promise<import('../../../shared/agent').AgentJsonValue> {
    const session = await this.requireSession(localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) throw new Error('ACP session is not materialized.');
    const current = this.nativeSessions.get(session.providerSessionId);
    if (!current?.modes?.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`ACP session did not advertise mode ${modeId}.`);
    }
    const client = await this.ensureClient();
    let response: AcpRpcResult<unknown>;
    try {
      response = await client.requestMutation<unknown>('session/set_mode', {
        sessionId: session.providerSessionId,
        modeId
      });
    } catch (cause) {
      throw mapMutationError('session/set_mode', cause);
    }
    const state = {
      ...current,
      modes: { ...current.modes, currentModeId: modeId }
    };
    try {
      await this.persistNativeState(session, state, response.raw);
    } catch (cause) {
      throw new AgentMutationAmbiguousError(
        'session/set_mode',
        `ACP applied mode ${modeId}, but Task Monki could not persist the observed state: ${errorMessage(cause)}`
      );
    }
    return redactAcpNativeValue(sanitizeAcpNativeSession(state));
  }

  private async ensureClient(): Promise<AcpRpcClient> {
    if (!this.supervisor) {
      const runtime = await this.ensureResolvedRuntime();
      this.supervisor = new AcpStdioSupervisor(this.store, {
        profile: this.profile,
        runtime,
        cwd: this.options.cwd,
        environment: this.options.environment,
        appVersion: this.options.appVersion,
        requestTimeoutMs: this.options.requestTimeoutMs
      });
      this.supervisor.events.on('exit', (server, unexpected) => {
        if (unexpected) this.enqueueInbound(() => this.handleRuntimeLoss(server.id));
      });
      this.supervisor.events.on('protocolError', (error) => {
        this.preflightState = {
          ...this.preflightState,
          ready: false,
          problems: [`ACP protocol failure: ${error.message}`]
        };
        this.emitRuntimeUpdate();
      });
    }
    const running = await this.supervisor.start();
    this.initializeResponse = running.initialize;
    this.bindClient(running.client);
    this.preflightState = {
      runtime: this.descriptor,
      ready: true,
      capabilities: this.currentCapabilities(),
      runtimeVersion: running.server.runtimeVersion,
      accountLabel: redactNativeString(
        running.initialize.agentInfo?.title ?? running.initialize.agentInfo?.name ?? ''
      ) || undefined,
      problems: [],
      warnings: [
        'Task Monki advertises fs.readTextFile=false, fs.writeTextFile=false, and terminal=false. Agent-native tools remain inside the provider process.',
        'ACP agents currently lack a Task Monki-attested workspace/network sandbox. Restricted runs fail closed; only explicit full-access, network-enabled runs are accepted.',
        ...(running.initialize.authMethods.length > 0
          ? ['The agent advertises native authentication methods; authentication remains provider-owned.']
          : [])
      ]
    };
    this.refreshModels();
    return running.client;
  }

  private ensureResolvedRuntime(): Promise<ResolvedAcpRuntime> {
    if (this.resolvedRuntime) return Promise.resolve(this.resolvedRuntime);
    if (!this.resolutionPromise) {
      const resolver = this.options.runtimeResolver ?? resolveAcpRuntime;
      this.resolutionPromise = resolver(this.profile, {
        executable: this.configuredExecutable,
        environment: this.options.environment,
        cwd: this.options.cwd
      })
        .then((runtime) => {
          this.resolvedRuntime = runtime;
          return runtime;
        })
        .finally(() => {
          this.resolutionPromise = undefined;
        });
    }
    return this.resolutionPromise;
  }

  private async hasUnsafeRuntimeWork(): Promise<boolean> {
    if (this.activePromptRunIds.size > 0) return true;
    const server = this.supervisor?.currentServer;
    if (!server || !this.supervisor?.currentClient) return false;
    const snapshot = await this.store.snapshot();
    return snapshot.runs.some(
      (run) =>
        run.runtimeId === this.descriptor.id &&
        run.serverInstanceId === server.id &&
        ACTIVE_RUN_STATUSES.includes(run.status)
    );
  }

  private async resetRuntimeForConfiguration(): Promise<void> {
    if (this.runtimeResetTimer) {
      clearTimeout(this.runtimeResetTimer);
      this.runtimeResetTimer = undefined;
    }
    const pendingResolution = this.resolutionPromise;
    if (pendingResolution) await pendingResolution.catch(() => undefined);
    await this.supervisor?.shutdown();
    await this.inboundQueue;
    await this.flushAllContent(true);
    this.supervisor = undefined;
    this.boundClient = undefined;
    this.initializeResponse = undefined;
    this.resolvedRuntime = undefined;
    this.resolutionPromise = undefined;
    this.nativeSessions.clear();
    this.models = [defaultAcpModel(this.profile)];
    this.initialized = false;
    this.runtimeReconfigurationPending = false;
    this.preflightState = {
      runtime: this.descriptor,
      ready: false,
      capabilities: this.currentCapabilities(),
      problems: [`${this.descriptor.displayName} executable discovery must be refreshed.`],
      warnings: [
        'ACP capability negotiation will run lazily when the configured runtime is next selected.'
      ]
    };
    this.emitRuntimeUpdate();
  }

  private async stopUnusedRuntimeProcess(): Promise<void> {
    if (
      this.activePromptRunIds.size > 0 ||
      this.nativeSessions.size > 0 ||
      this.provisionalProviderSessionIds.size > 0 ||
      !this.supervisor
    ) {
      return;
    }
    await this.supervisor.shutdown();
    await this.inboundQueue;
    await this.flushAllContent(true);
    this.supervisor = undefined;
    this.boundClient = undefined;
    this.initializeResponse = undefined;
    this.models = [defaultAcpModel(this.profile)];
    if (this.resolvedRuntime) this.setDiscoveryPreflight(this.resolvedRuntime);
    this.emitRuntimeUpdate();
  }

  private schedulePendingRuntimeReset(): void {
    if (
      !this.runtimeReconfigurationPending ||
      this.activePromptRunIds.size > 0 ||
      this.runtimeResetTimer
    ) {
      return;
    }
    this.runtimeResetTimer = setTimeout(() => {
      this.runtimeResetTimer = undefined;
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
    this.runtimeResetTimer.unref();
  }

  private setDiscoveryPreflight(runtime: ResolvedAcpRuntime): void {
    this.preflightState = {
      runtime: this.descriptor,
      ready: true,
      capabilities: this.currentCapabilities(),
      runtimeVersion: runtime.version,
      problems: [],
      warnings: [
        'Executable discovery succeeded. ACP capabilities, authentication, native models, and session configuration will be negotiated lazily when the first session starts.',
        'Task Monki advertises fs.readTextFile=false, fs.writeTextFile=false, and terminal=false.',
        'ACP agents currently lack a Task Monki-attested workspace/network sandbox. Restricted runs fail closed; only the provider-controlled full-access preset is accepted.'
      ]
    };
  }

  private bindClient(client: AcpRpcClient): void {
    if (this.boundClient === client) return;
    this.boundClient = client;
    client.events.on('notification', (method, params, raw) => {
      this.enqueueInbound(() => this.handleNotification(method, params, raw));
    });
    client.events.on('request', (request, raw) => {
      this.enqueueInbound(() => this.handleServerRequest(request, raw));
    });
  }

  private async applyRequestedNativeSettings(
    client: AcpRpcClient,
    initial: AcpNativeSessionState,
    settings: AgentExecutionSettings
  ): Promise<AcpNativeSessionState> {
    let state = initial;
    const native = settings.runtimeOptions?.[this.descriptor.id];
    const nativeRecord = isRecord(native) ? native : {};
    const requestedMode = typeof nativeRecord.modeId === 'string' ? nativeRecord.modeId : undefined;
    if (requestedMode) {
      if (!state.modes?.availableModes.some((mode) => mode.id === requestedMode)) {
        throw new Error(`ACP session did not advertise requested mode ${requestedMode}.`);
      }
      try {
        await client.requestMutation('session/set_mode', {
          sessionId: state.sessionId,
          modeId: requestedMode
        });
      } catch (cause) {
        throw mapMutationError('session/set_mode', cause);
      }
      state = { ...state, modes: { ...state.modes, currentModeId: requestedMode } };
    }

    const values = requestedNativeConfigValues(this.descriptor.id, settings);
    const modelOption = state.configOptions.find(
      (option) => option.type === 'select' && option.category === 'model'
    );
    if (settings.model && settings.model !== 'default') {
      if (!modelOption) {
        throw new Error(
          `${this.descriptor.displayName} did not expose an ACP model configuration selector.`
        );
      }
      values[modelOption.id] = settings.model;
    }
    for (const [configId, value] of Object.entries(values)) {
      const option = state.configOptions.find((candidate) => candidate.id === configId);
      if (!option) throw new Error(`ACP session did not advertise config option ${configId}.`);
      if ((option.type === 'boolean') !== (typeof value === 'boolean')) {
        throw new Error(`ACP config option ${configId} received the wrong value type.`);
      }
      if (option.type === 'select' && !selectHasValue(option, String(value))) {
        throw new Error(`ACP config option ${configId} does not offer value ${String(value)}.`);
      }
      let response: AcpRpcResult<unknown>;
      try {
        response = await client.requestMutation<unknown>('session/set_config_option', {
          sessionId: state.sessionId,
          configId,
          ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value })
        });
      } catch (cause) {
        throw mapMutationError('session/set_config_option', cause);
      }
      const record = requireRecord(response.result, 'ACP config response');
      state = {
        ...state,
        configOptions: parseConfigOptions(record.configOptions) ?? state.configOptions
      };
      state = normalizeAcpOperationalSession(state);
      this.nativeSessions.set(state.sessionId, state);
    }
    state = normalizeAcpOperationalSession(state);
    this.nativeSessions.set(state.sessionId, state);
    return state;
  }

  private async handleNotification(
    method: string,
    params: unknown,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (method !== 'session/update') {
      await this.recordExtensionTelemetry(method, params, raw);
      return;
    }
    let notification;
    try {
      notification = parseSessionNotification(params);
    } catch (cause) {
      await this.recordProtocolIncident(errorMessage(cause), raw);
      return;
    }
    const session = await this.store.getAgentSessionByProviderId(
      this.descriptor.id,
      notification.sessionId
    );
    if (!session) return;
    const activeRun = this.replayingProviderSessionIds.has(notification.sessionId)
      ? undefined
      : await this.store.getActiveRunForSession(session.id);
    // ACP session updates do not carry a prompt ID. Once a prompt mutation is
    // ambiguous, later traffic cannot safely be attributed to that recovered
    // run and must not move it forward.
    const run = activeRun && this.activePromptRunIds.has(activeRun.id)
      ? activeRun
      : undefined;
    const update = notification.update;
    const streamedContent = [
      'agent_message_chunk',
      'agent_thought_chunk',
      'user_message_chunk'
    ].includes(update.sessionUpdate);
    if (run && !streamedContent) {
      await this.recordRunActivity(run, update.sessionUpdate, raw);
      await this.store.updateRun(run.id, { lastEventAt: new Date().toISOString() });
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'user_message_chunk':
        if (run) await this.handleContentChunk(run, update, raw);
        break;
      case 'tool_call':
      case 'tool_call_update':
        if (run) await this.handleToolUpdate(run, update as unknown as AcpToolCallUpdate, raw);
        break;
      case 'plan':
        if (run) await this.handlePlan(run, update, raw);
        break;
      case 'usage_update':
        await this.handleUsage(session, run, update, raw);
        break;
      case 'config_option_update':
        await this.handleConfigUpdate(session, update, raw);
        break;
      case 'current_mode_update':
        await this.handleModeUpdate(session, update, raw);
        break;
      default:
        // The raw, including _meta and future extension fields, is already in
        // the journal and referenced by the activity record above.
        break;
    }
  }

  private async handleServerRequest(
    request: AcpJsonRpcRequest,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const client = this.supervisor?.currentClient;
    if (!client) return;
    if (request.method !== 'session/request_permission') {
      await this.recordExtensionTelemetry(request.method, request.params, raw);
      await client.respondError(
        request.id,
        -32601,
        `Task Monki does not implement ACP client method ${request.method}. Its filesystem and terminal capabilities are false.`
      );
      return;
    }
    let permission;
    try {
      permission = parsePermissionRequest(request.params);
    } catch (cause) {
      await this.recordProtocolIncident(errorMessage(cause), raw);
      await client.respondError(request.id, -32602, errorMessage(cause));
      return;
    }
    const session = await this.store.getAgentSessionByProviderId(
      this.descriptor.id,
      permission.sessionId
    );
    const activeRun = session ? await this.store.getActiveRunForSession(session.id) : undefined;
    const run = activeRun && this.activePromptRunIds.has(activeRun.id)
      ? activeRun
      : undefined;
    const server = this.supervisor?.currentServer;
    if (!session || !run || !server) {
      await client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    if (request.id === null) {
      await this.recordProtocolIncident('ACP permission request used a null JSON-RPC id.', raw);
      await client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const materialized = materializeAcpPermission({
      toolCall: permission.toolCall,
      options: permission.options,
      session,
      run
    });
    const interaction = await this.store.createInteractionRequest({
      runtimeId: this.descriptor.id,
      serverInstanceId: server.id,
      providerRequestId: request.id,
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      providerTurnId: run.providerTurnId,
      providerItemId: permission.toolCall.toolCallId,
      type: 'COMMAND_APPROVAL',
      request: materialized.request,
      allowedActions: materialized.allowedActions,
      policyWarnings: materialized.warnings,
      requestRawMessage: raw
    });
    await this.store.updateAgentSession(session.id, { status: 'AWAITING_APPROVAL' });
    this.emitInteractionUpdate(interaction);
  }

  private async handleContentChunk(
    run: RunRecord,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const text = textFromAcpContent(update.content);
    if (text === undefined) return;
    const messageId = typeof update.messageId === 'string'
      ? update.messageId
      : `${run.id}:${update.sessionUpdate}`;
    const type =
      update.sessionUpdate === 'agent_message_chunk'
        ? 'AGENT_MESSAGE'
        : update.sessionUpdate === 'agent_thought_chunk'
          ? 'REASONING_SUMMARY'
          : 'USER_MESSAGE';
    const byteCount = Buffer.byteLength(text, 'utf8');

    await this.flushBufferedContentForCapacity(byteCount, run.id, messageId);
    let buffer = this.getOrCreateStreamBuffer(run);
    let part = buffer.parts.get(messageId);
    if (!part && buffer.parts.size >= MAX_BUFFERED_STREAM_PARTS_PER_RUN) {
      const oldestPartId = buffer.parts.keys().next().value as string | undefined;
      if (oldestPartId) {
        await this.materializeBufferedContentParts(run.id, [oldestPartId], false);
        buffer = this.getOrCreateStreamBuffer(run);
      }
    }
    part = buffer.parts.get(messageId);
    if (!part) {
      part = {
        messageId,
        updateType: update.sessionUpdate,
        itemType: type,
        chunks: [],
        byteCount: 0,
        raw,
        eventCount: 0
      };
      buffer.parts.set(messageId, part);
    }
    appendBufferedText(part.chunks, text, byteCount);
    part.byteCount += byteCount;
    part.raw = raw;
    part.eventCount += 1;
    buffer.partBytes += byteCount;
    this.bufferedStreamBytes += byteCount;

    if (update.sessionUpdate !== 'user_message_chunk' && byteCount > 0) {
      const previousOutput = buffer.output.at(-1);
      if (previousOutput?.source === update.sessionUpdate) {
        appendBufferedText(previousOutput.chunks, text, byteCount);
        previousOutput.byteCount += byteCount;
      } else {
        buffer.output.push({
          source: update.sessionUpdate,
          chunks: [{ text, byteCount }],
          byteCount
        });
      }
      buffer.outputBytes += byteCount;
    }

    if (
      buffer.outputBytes >= STREAM_OUTPUT_FLUSH_BYTES ||
      buffer.output.length >= MAX_BUFFERED_OUTPUT_GROUPS
    ) {
      await this.flushBufferedStreamOutput(run.id);
    } else {
      this.scheduleBufferedStreamOutputFlush(buffer);
    }
  }

  private async flushRunContent(runId: string, terminal: boolean): Promise<void> {
    await this.flushBufferedStreamOutput(runId);
    await this.materializeBufferedContentParts(runId, undefined, terminal);
    if (!terminal) return;
    for (const item of await this.store.getAgentItemsForRun(runId)) {
      if (
        item.status === 'IN_PROGRESS' &&
        ['AGENT_MESSAGE', 'REASONING_SUMMARY', 'USER_MESSAGE'].includes(item.type)
      ) {
        await this.store.upsertAgentItem({ ...item, status: 'COMPLETED' });
      }
    }
  }

  private async flushAllContent(terminal: boolean): Promise<void> {
    const runIds = [...this.streamBuffers.keys()];
    for (const runId of runIds) await this.flushRunContent(runId, terminal);
  }

  private getOrCreateStreamBuffer(run: RunRecord): AcpRunStreamBuffer {
    const existing = this.streamBuffers.get(run.id);
    if (existing) return existing;
    const buffer: AcpRunStreamBuffer = {
      runId: run.id,
      sessionId: run.sessionId,
      parts: new Map(),
      partBytes: 0,
      output: [],
      outputBytes: 0
    };
    this.streamBuffers.set(run.id, buffer);
    return buffer;
  }

  private scheduleBufferedStreamOutputFlush(buffer: AcpRunStreamBuffer): void {
    if (buffer.timer || buffer.outputBytes === 0) return;
    const timer = setTimeout(() => {
      if (buffer.timer === timer) buffer.timer = undefined;
      this.enqueueInbound(() => this.flushBufferedStreamOutput(buffer.runId));
    }, STREAM_OUTPUT_FLUSH_INTERVAL_MS);
    timer.unref();
    buffer.timer = timer;
  }

  private async flushBufferedStreamOutput(runId: string): Promise<void> {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer) return;
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = undefined;
    if (buffer.outputBytes === 0) return;
    const run = await this.store.getRun(runId);
    if (!run) {
      this.discardStreamBuffer(runId);
      return;
    }
    const output = buffer.output;
    const artifactText = output
      .map((entry) =>
        entry.source === 'agent_thought_chunk'
          ? `\n[thought]\n${bufferedText(entry.chunks)}`
          : bufferedText(entry.chunks)
      )
      .join('');
    try {
      if (artifactText) await this.store.appendArtifact(run.outputArtifactId, artifactText);
    } catch (cause) {
      this.scheduleBufferedStreamOutputFlush(buffer);
      throw cause;
    }
    buffer.output = [];
    buffer.outputBytes = 0;
    for (const entry of output) {
      const text = bufferedText(entry.chunks);
      if (!text) continue;
      this.appEvents.emit({
        type: 'run.output',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: { source: entry.source, text },
        at: new Date().toISOString()
      });
    }
    if (buffer.parts.size === 0) this.discardStreamBuffer(runId);
  }

  private async materializeBufferedContentParts(
    runId: string,
    partIds?: readonly string[],
    terminal = false
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
      const part = buffer.parts.get(partId);
      if (!part) continue;
      const existing = await this.store.getAgentItemByProviderId(run.id, part.messageId);
      const combined = `${itemText(existing)}${bufferedText(part.chunks)}`;
      await this.store.upsertAgentItem({
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        sessionId: buffer.sessionId,
        providerItemId: part.messageId,
        type: part.itemType,
        status: terminal ? 'COMPLETED' : 'IN_PROGRESS',
        payload: { type: part.updateType, text: combined },
        rawMessage: part.raw
      });
      await this.recordRunActivity(run, part.updateType, part.raw, {
        providerItemId: part.messageId,
        coalescedEvents: part.eventCount
      });
      buffer.parts.delete(partId);
      buffer.partBytes = Math.max(0, buffer.partBytes - part.byteCount);
      this.bufferedStreamBytes = Math.max(0, this.bufferedStreamBytes - part.byteCount);
    }
    if (buffer.parts.size === 0 && buffer.outputBytes === 0) {
      this.discardStreamBuffer(runId);
    }
  }

  private async flushBufferedContentForCapacity(
    incomingBytes: number,
    currentRunId: string,
    currentPartId: string
  ): Promise<void> {
    while (
      this.bufferedStreamBytes > 0 &&
      this.bufferedStreamBytes + incomingBytes > MAX_BUFFERED_STREAM_BYTES
    ) {
      const candidates = [...this.streamBuffers.values()].flatMap((buffer) =>
        [...buffer.parts.keys()].map((partId) => ({ runId: buffer.runId, partId }))
      );
      const oldest =
        candidates.find(
          (candidate) =>
            candidate.runId !== currentRunId || candidate.partId !== currentPartId
        ) ?? candidates[0];
      if (!oldest) break;
      await this.materializeBufferedContentParts(oldest.runId, [oldest.partId], false);
    }
  }

  private discardStreamBuffer(runId: string): void {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer) return;
    if (buffer.timer) clearTimeout(buffer.timer);
    this.bufferedStreamBytes = Math.max(0, this.bufferedStreamBytes - buffer.partBytes);
    this.streamBuffers.delete(runId);
  }

  private async handleToolUpdate(
    run: RunRecord,
    update: AcpToolCallUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (typeof update.toolCallId !== 'string') return;
    const existing = await this.store.getAgentItemByProviderId(run.id, update.toolCallId);
    const prior = isRecord(existing?.payload) ? existing.payload : {};
    await this.store.upsertAgentItem({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: run.sessionId,
      providerItemId: update.toolCallId,
      type: mapAcpToolKind(update.kind ?? (prior.kind as never)),
      status: mapAcpToolStatus(update.status),
      payload: { ...prior, ...jsonSafeRecord(update) },
      rawMessage: raw
    });
  }

  private async handlePlan(
    run: RunRecord,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    await this.store.recordAgentPlanRevision({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: run.sessionId,
      runtimeId: this.descriptor.id,
      steps: mapAcpPlanEntries(update.entries),
      rawMessage: raw
    });
  }

  private async handleUsage(
    session: AgentSessionRecord,
    run: RunRecord | undefined,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!Number.isSafeInteger(update.used) || !Number.isSafeInteger(update.size)) return;
    const used = update.used as number;
    await this.store.recordAgentUsageSnapshot({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runId: run?.id,
      runtimeId: this.descriptor.id,
      total: emptyUsage(used),
      last: emptyUsage(0),
      modelContextWindow: update.size as number,
      rawMessage: raw
    });
  }

  private async handleConfigUpdate(
    session: AgentSessionRecord,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!session.providerSessionId) return;
    const current = this.nativeSessions.get(session.providerSessionId) ?? {
      sessionId: session.providerSessionId,
      modes: null,
      configOptions: []
    };
    const state = {
      ...current,
      configOptions: parseConfigOptions(update.configOptions) ?? []
    };
    await this.persistNativeState(session, state, raw);
  }

  private async handleModeUpdate(
    session: AgentSessionRecord,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!session.providerSessionId || typeof update.currentModeId !== 'string') return;
    const current = this.nativeSessions.get(session.providerSessionId);
    if (!current?.modes) return;
    await this.persistNativeState(
      session,
      { ...current, modes: { ...current.modes, currentModeId: update.currentModeId } },
      raw
    );
  }

  private async persistNativeState(
    session: AgentSessionRecord,
    state: AcpNativeSessionState,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    state = normalizeAcpOperationalSession(state);
    this.nativeSessions.set(state.sessionId, state);
    const observedSettings = observedSettingsFromAcpState(
      this.profile,
      state,
      session.requestedSettings
    );
    await this.store.updateAgentSession(session.id, { observedSettings });
    await this.recordSettingsObservation(
      session,
      'THREAD_SETTINGS_NOTIFICATION',
      observedSettings,
      raw
    );
    this.refreshModels();
    this.emitRuntimeUpdate();
  }

  private async finalizePrompt(
    runId: string,
    response: AcpRpcResult<unknown>
  ): Promise<void> {
    // Runtime loss and interrupt timeout remove a run from this set before
    // marking it ambiguous. A late response must not reverse recovery.
    if (!this.activePromptRunIds.delete(runId)) return;
    const run = await this.store.getRun(runId);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) return;
    let prompt: ReturnType<typeof parsePromptResponse>;
    try {
      prompt = parsePromptResponse(response.result);
    } catch (cause) {
      const detail = `ACP prompt response violated the negotiated schema: ${errorMessage(cause)}`;
      await this.store.appendEvent(
        createDomainEvent({
          type: 'AGENT_PROTOCOL_INCIDENT',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: response.raw.serverInstanceId,
          source: 'provider',
          payload: { detail, rawMessage: response.raw }
        })
      );
      await this.handlePromptFailure(runId, new Error(detail), true, response.raw);
      return;
    }
    await this.flushRunContent(run.id, true);
    const items = await this.store.getAgentItemsForRun(run.id);
    const finalMessage = items
      .filter((item) => item.type === 'AGENT_MESSAGE')
      .map(itemText)
      .filter(Boolean)
      .join('\n');
    const finalArtifact = await this.store.writeFinalArtifact(
      run.taskId,
      run.id,
      formatFinalArtifact(this.profile.descriptor.displayName, prompt.stopReason, finalMessage)
    );
    const terminal =
      prompt.stopReason === 'cancelled'
        ? 'interrupted'
        : prompt.stopReason === 'refusal'
          ? 'failed'
          : 'completed';
    const type =
      terminal === 'completed'
        ? 'AGENT_RUN_COMPLETED'
        : terminal === 'interrupted'
          ? 'AGENT_RUN_INTERRUPTED'
          : 'AGENT_RUN_FAILED';
    const reviewResult = run.mode === 'REVIEW' ? parseAgentReviewResult(finalMessage) : undefined;
    await this.store.updateRun(run.id, {
      finalMessage: finalMessage || undefined,
      providerTerminalRawMessage: response.raw
    });
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
          terminalStatus: terminal,
          terminalReason: prompt.stopReason,
          finalArtifactId: finalArtifact.id,
          codexReviewStatus: agentReviewStatusFromResult(reviewResult),
          codexReviewResult: reviewResult
        }
      })
    );
    await this.store.updateAgentSession(run.sessionId, { status: 'IDLE' });
    this.clearInterruptDeadline(run.id);
    this.appEvents.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: terminal, finalArtifactId: finalArtifact.id },
      at: new Date().toISOString()
    });
    this.schedulePendingRuntimeReset();
  }

  private async handlePromptFailure(
    runId: string,
    cause: unknown,
    activeAlreadyClaimed = false,
    providerTerminalRawMessage?: AgentProtocolMessageReference
  ): Promise<void> {
    if (!activeAlreadyClaimed && !this.activePromptRunIds.delete(runId)) return;
    this.clearInterruptDeadline(runId);
    const run = await this.store.getRun(runId);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) return;
    await this.flushRunContent(run.id, true);
    await this.staleRunInteractions(run, errorMessage(cause));
    if (cause instanceof AcpAmbiguousMutationError) {
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
          payload: { operation: cause.method, reason: cause.message }
        })
      );
      await this.store.updateAgentSession(run.sessionId, { status: 'NOT_LOADED' });
      this.appEvents.emit({
        type: 'run.activity',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: {
          eventType: 'session/prompt/ambiguous',
          reason: cause.message,
          automaticReplay: false
        },
        at: new Date().toISOString()
      });
      return;
    }
    const finalArtifact = await this.store.writeFinalArtifact(
      run.taskId,
      run.id,
      `# ${this.profile.descriptor.displayName} turn failed\n\n${errorMessage(cause)}\n`
    );
    if (providerTerminalRawMessage) {
      await this.store.updateRun(run.id, { providerTerminalRawMessage });
    }
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_FAILED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: {
          terminalStatus: 'failed',
          error: errorMessage(cause),
          finalArtifactId: finalArtifact.id
        }
      })
    );
    await this.store.updateAgentSession(run.sessionId, { status: 'SYSTEM_ERROR' });
    this.appEvents.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: 'failed', finalArtifactId: finalArtifact.id },
      at: new Date().toISOString()
    });
    this.schedulePendingRuntimeReset();
  }

  private async staleRunInteractions(run: RunRecord, reason: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) =>
        candidate.runId === run.id && ['PENDING', 'RESPONDING'].includes(candidate.status)
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

  private async handleRuntimeLoss(serverInstanceId: string): Promise<void> {
    this.preflightState = {
      ...this.preflightState,
      ready: false,
      problems: [`${this.descriptor.displayName} exited unexpectedly.`]
    };
    this.nativeSessions.clear();
    this.activePromptRunIds.clear();
    this.initializeResponse = undefined;
    this.boundClient = undefined;
    const snapshot = await this.store.snapshot();
    const affectedRuns = snapshot.runs.filter(
      (candidate) =>
        candidate.runtimeId === this.descriptor.id &&
        candidate.serverInstanceId === serverInstanceId &&
        ACTIVE_RUN_STATUSES.includes(candidate.status)
    );
    for (const run of affectedRuns) {
      await this.flushRunContent(run.id, true);
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
          payload: {
            reason: 'ACP process exited. Prompt outcome is ambiguous and will not be replayed.'
          }
        })
      );
      await this.store.updateAgentSession(run.sessionId, { status: 'NOT_LOADED' });
      this.appEvents.emit({
        type: 'run.activity',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: {
          eventType: 'runtime/lost',
          recoveryState: 'RECOVERY_REQUIRED',
          automaticReplay: false
        },
        at: new Date().toISOString()
      });
    }
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) =>
        candidate.serverInstanceId === serverInstanceId &&
        ['PENDING', 'RESPONDING'].includes(candidate.status)
    )) {
      const aborted = await this.store.transitionInteractionRequest(
        interaction.id,
        interaction.status,
        {
          status: 'ABORTED_SERVER_LOST',
          resolution: { reason: 'ACP process exited.' },
          resolvedAt: new Date().toISOString()
        }
      );
      this.emitInteractionUpdate(aborted);
    }
    this.emitRuntimeUpdate();
    this.schedulePendingRuntimeReset();
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
        exitReason: 'Task Monki restarted without the prior ACP process.'
      });
      await this.handleRuntimeLoss(server.id);
    }
  }

  private async cancelPendingPermissions(run: RunRecord, client: AcpRpcClient): Promise<void> {
    const snapshot = await this.store.snapshot();
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) => candidate.runId === run.id && candidate.status === 'PENDING'
    )) {
      const responding = await this.store.transitionInteractionRequest(
        interaction.id,
        'PENDING',
        {
          status: 'RESPONDING',
          decision: { interactionType: 'COMMAND_APPROVAL', action: 'CANCEL' },
          respondedAt: new Date().toISOString()
        }
      );
      const raw = await client.respond(
        responding.providerRequestId,
        { outcome: { outcome: 'cancelled' } },
        async (reference) => {
          await this.store.transitionInteractionRequest(responding.id, 'RESPONDING', {
            status: 'RESPONDING',
            responseRawMessage: reference
          });
        }
      );
      const canceled = await this.store.transitionInteractionRequest(
        responding.id,
        'RESPONDING',
        {
          status: 'CANCELED',
          responseRawMessage: raw,
          resolution: { outcome: 'cancelled' },
          resolvedAt: new Date().toISOString()
        }
      );
      this.emitInteractionUpdate(canceled);
    }
  }

  private armInterruptDeadline(runId: string): void {
    this.clearInterruptDeadline(runId);
    const timer = setTimeout(() => {
      this.interruptTimers.delete(runId);
      this.enqueueInbound(async () => {
        const run = await this.store.getRun(runId);
        if (!run || run.status !== 'INTERRUPTING') return;
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
              operation: 'session/cancel',
              reason: 'ACP agent did not return a cancelled prompt response before the deadline.'
            }
          })
        );
        this.activePromptRunIds.delete(run.id);
        await this.store.updateAgentSession(run.sessionId, { status: 'NOT_LOADED' });
        this.appEvents.emit({
          type: 'run.activity',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          payload: {
            eventType: 'session/cancel/ambiguous',
            recoveryState: 'RECOVERY_REQUIRED'
          },
          at: new Date().toISOString()
        });
      });
    }, this.interruptCompletionTimeoutMs);
    timer.unref();
    this.interruptTimers.set(runId, timer);
  }

  private clearInterruptDeadline(runId: string): void {
    const timer = this.interruptTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.interruptTimers.delete(runId);
  }

  private async recordSettingsObservation(
    session: AgentSessionRecord,
    source: 'THREAD_START_RESPONSE' | 'THREAD_RESUME_RESPONSE' | 'THREAD_SETTINGS_NOTIFICATION',
    settings: AgentExecutionSettings,
    rawMessage?: AgentProtocolMessageReference
  ): Promise<void> {
    await this.store.recordAgentSettingsObservation({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runtimeId: this.descriptor.id,
      source,
      settings,
      rawMessage
    });
  }

  private async recordRunActivity(
    run: RunRecord,
    eventType: string,
    raw: AgentProtocolMessageReference,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const payload = { eventType, ...details, rawMessage: raw };
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
        payload
      })
    );
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

  private async recordExtensionTelemetry(
    method: string,
    params: unknown,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const providerSessionId =
      isRecord(params) && typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const session = providerSessionId
      ? await this.store.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    const run = session ? await this.store.getActiveRunForSession(session.id) : undefined;
    if (run) await this.recordRunActivity(run, `extension:${method}`, raw);
  }

  private async recordProtocolIncident(
    detail: string,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const runs = await this.store.getRunsRequiringRecovery({ runtimeId: this.descriptor.id });
    const run = runs[0];
    if (!run) return;
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_PROTOCOL_INCIDENT',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: raw.serverInstanceId,
        source: 'provider',
        payload: { detail, rawMessage: raw }
      })
    );
    this.appEvents.emit({
      type: 'run.diagnostic',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { detail, rawMessage: raw },
      at: new Date().toISOString()
    });
  }

  private currentCapabilities(): AgentRuntimeCapabilities {
    const negotiated = this.initializeResponse
      ? {
          prompt: this.initializeResponse.agentCapabilities.promptCapabilities,
          loadSession: this.initializeResponse.agentCapabilities.loadSession,
          resume: Boolean(this.initializeResponse.agentCapabilities.sessionCapabilities?.resume),
          close: Boolean(this.initializeResponse.agentCapabilities.sessionCapabilities?.close)
        }
      : undefined;
    const capabilities = acpCapabilities(this.profile, negotiated);
    return {
      ...capabilities,
      extensions: {
        ...capabilities.extensions,
        'task-monki.browser-dev-isolation': {
          maturity: 'unsupported',
          detail: 'ACP negotiation does not attest OS process, filesystem, and network isolation.'
        },
        workspaceSandbox: {
          maturity: 'unsupported',
          detail: 'No ACP profile currently attests a Task Monki-enforced workspace boundary.'
        },
        networkIsolation: {
          maturity: 'unsupported',
          detail: 'ACP stable v1 does not negotiate provider-process network isolation.'
        },
        approvalPolicyEnforcement: {
          maturity: 'inferred',
          detail: 'Task Monki safely handles permission requests that arrive, but ACP does not guarantee every native tool requests permission.'
        }
      }
    };
  }

  private refreshModels(): void {
    const modalities = promptInputModalities(
      this.initializeResponse?.agentCapabilities.promptCapabilities
    );
    const native = modelsFromAcpConfig(
      this.profile,
      [...this.nativeSessions.values()],
      modalities
    );
    this.models = native.length > 0 ? native : [defaultAcpModel(this.profile, modalities)];
  }

  private async requireSession(sessionId: string): Promise<AgentSessionRecord> {
    const session = await this.store.getAgentSession(sessionId);
    if (!session) throw new Error(`Agent session not found: ${sessionId}`);
    return session;
  }

  private assertSessionOwnership(session: AgentSessionRecord): void {
    if (session.runtimeId !== this.descriptor.id) {
      throw new Error(
        `Session ${session.id} belongs to ${session.runtimeId}, not ${this.descriptor.id}.`
      );
    }
  }

  private enqueueInbound(operation: () => Promise<void>): void {
    this.inboundQueue = this.inboundQueue.then(operation, operation).catch((cause) => {
      this.preflightState = {
        ...this.preflightState,
        warnings: [...new Set([...this.preflightState.warnings, errorMessage(cause)])]
      };
      this.emitRuntimeUpdate();
    });
  }

  private emitRuntimeUpdate(): void {
    this.appEvents.emit({
      type: 'runtime.updated',
      taskId: `runtime:${this.descriptor.id}`,
      payload: {
        preflight: this.preflightState,
        models: this.models,
        nativeSessions: [...this.nativeSessions.values()].map(sanitizeAcpNativeSession)
      },
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
}

/**
 * ACP does not itself provide an execution sandbox. Until a concrete profile
 * can attest equivalent native isolation, restricted Task Monki policies must
 * fail closed instead of being silently downgraded.
 */
export function assertAcpExecutionPolicy(
  profile: AcpRuntimeProfile,
  settings: AgentExecutionSettings
): void {
  if (settings.runtimeId && settings.runtimeId !== profile.descriptor.id) {
    throw new Error(
      `${profile.descriptor.displayName} cannot execute settings owned by runtime ${settings.runtimeId}.`
    );
  }
  if (
    settings.modelProvider &&
    settings.modelProvider !== profile.defaultModelProvider
  ) {
    throw new Error(
      `${profile.descriptor.displayName} models are owned by provider ${profile.defaultModelProvider}, not ${settings.modelProvider}.`
    );
  }
  if (settings.sandbox !== 'DANGER_FULL_ACCESS') {
    throw new Error(
      `${profile.descriptor.displayName} cannot enforce Task Monki's ${settings.sandbox ?? 'restricted'} filesystem sandbox over ACP. Choose Full access only if you accept provider-native process permissions.`
    );
  }
  if (settings.networkAccess !== true) {
    throw new Error(
      `${profile.descriptor.displayName} cannot attest network-disabled execution over ACP. Enable network access only if you accept provider-native network permissions.`
    );
  }
  if (settings.approvalPolicy !== 'on-request') {
    throw new Error(
      `${profile.descriptor.displayName} supports only on-request ACP approvals; ${settings.approvalPolicy ?? 'an unspecified policy'} is not enforceable.`
    );
  }
  if (settings.approvalsReviewer !== 'user') {
    throw new Error(
      `${profile.descriptor.displayName} ACP approvals currently require the user reviewer.`
    );
  }
  const nativeOptions = settings.runtimeOptions?.[profile.descriptor.id];
  if (
    nativeOptions !== undefined &&
    JSON.stringify(redactAcpNativeValue(nativeOptions)) !== JSON.stringify(nativeOptions)
  ) {
    throw new Error(
      `${profile.descriptor.displayName} runtime options cannot contain credentials or opaque _meta. Authenticate through the provider CLI instead.`
    );
  }
}

export function assertAcpManagedAttachmentsUnsupported(
  profile: AcpRuntimeProfile,
  attachments: readonly Pick<AgentTurnAttachment, 'kind'>[]
): void {
  if (attachments.length > 0) {
    throw new Error(
      `Task Monki managed attachments are unavailable for ${profile.descriptor.displayName} because its credential-bearing ACP process cannot attest attachment confinement.`
    );
  }
}

function providerOptions(interaction: InteractionRequestRecord): AcpPermissionOption[] {
  if (!('providerOptions' in interaction.request) || !interaction.request.providerOptions) {
    throw new Error('ACP permission options are missing from the durable interaction.');
  }
  return interaction.request.providerOptions.map((option) => {
    if (!['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind)) {
      throw new Error(`Unknown ACP permission option kind: ${option.kind}`);
    }
    return {
      optionId: option.id,
      name: option.label,
      kind: option.kind as AcpPermissionOption['kind']
    };
  });
}

function selectHasValue(
  option: Extract<AcpSessionConfigOption, { type: 'select' }>,
  value: string
): boolean {
  return option.options.some((candidate) =>
    'options' in candidate
      ? candidate.options.some((nested) => nested.value === value)
      : candidate.value === value
  );
}

function itemText(item: AgentItemRecord | undefined): string {
  return isRecord(item?.payload) && typeof item.payload.text === 'string' ? item.payload.text : '';
}

function appendBufferedText(
  segments: BufferedAcpTextSegment[],
  text: string,
  byteCount: number
): void {
  if (byteCount === 0) return;
  const previous = segments.at(-1);
  if (previous && previous.byteCount + byteCount <= STREAM_TEXT_SEGMENT_BYTES) {
    previous.text += text;
    previous.byteCount += byteCount;
    return;
  }
  segments.push({ text, byteCount });
}

function bufferedText(segments: readonly BufferedAcpTextSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

function emptyUsage(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}

function formatFinalArtifact(
  runtimeName: string,
  stopReason: string,
  finalMessage: string
): string {
  return [
    `# ${runtimeName} turn`,
    '',
    `ACP stop reason: ${stopReason}`,
    '',
    finalMessage || '_The agent returned no final text message._',
    ''
  ].join('\n');
}

function jsonSafe(value: unknown): import('../../../shared/agent').AgentJsonValue {
  return JSON.parse(JSON.stringify(value)) as import('../../../shared/agent').AgentJsonValue;
}

function jsonSafeRecord(
  value: unknown
): { [key: string]: import('../../../shared/agent').AgentJsonValue } {
  const safe = jsonSafe(value);
  return isRecord(safe)
    ? (safe as { [key: string]: import('../../../shared/agent').AgentJsonValue })
    : {};
}

function mapMutationError(operation: string, cause: unknown): Error {
  return cause instanceof AcpAmbiguousMutationError
    ? new AgentMutationAmbiguousError(operation, cause.message)
    : cause instanceof Error
      ? cause
      : new Error(String(cause));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function normalizeExecutableOverride(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes('\0')) throw new Error('ACP executable path contains a NUL byte.');
  return value;
}
