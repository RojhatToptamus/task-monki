import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
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
  AgentTokenUsageBreakdown,
  InteractionRequestRecord,
  RunRecord
} from '../../../shared/contracts';
import { AGENT_RUNTIME_LIMITS } from '../../../shared/agentRuntime';
import type { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import type {
  AgentProviderRuntimeStore,
  AgentRuntimeStore,
  TaskAgentRuntimeSnapshot,
  TaskAgentRuntimeAccess
} from '../AgentRuntimeStore';
import type {
  AgentExecutionContext,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord
} from '../../../shared/agentRuntime';
import { AgentRuntimeArtifactMutationAmbiguousError } from '../AgentRuntimeStore';
import {
  assertModelSupportsAttachments,
  completeAttachmentSubmissions,
  type AgentTurnAttachment,
  type AttachmentSubmissionCandidate,
  verifyAgentTurnAttachments
} from '../AgentAttachmentDelivery';
import {
  REDACTED_CREDENTIAL,
  credentialPrefixCarryLength,
  redactCredentialText,
  redactCredentialValue
} from '../AgentCredentialRedaction';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  AgentRuntimeDeliveryError,
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
  type StartAgentRuntimeTurn,
  type StartedAgentRuntimeTurn,
  type StartAgentTurn
} from '../AgentRuntimeAdapter';
import type {
  AgentRuntimeTurnEvent,
  BuildAgentRuntimeExecutionContextInput
} from '../AgentRuntimeCoordinator';
import { assertReadOnlyExecutionContext } from '../AgentRuntimeOwnership';
import {
  appendRuntimeDiagnostic,
  createRuntimeReadiness,
  errorDiagnostic,
  warningDiagnostic
} from '../AgentRuntimeReadiness';
import { agentServersRequiringLossRecovery } from '../AgentRuntimeRecovery';
import {
  buildInteractionPolicy,
  interactionTerminalStatus
} from '../AgentInteractionPolicy';
import {
  mapOpenCodeInteractionResponse,
  mapOpenCodePermission,
  mapOpenCodeQuestion,
  openCodePermissionRules,
  openCodeReadOnlyPermissionRules,
  openCodePermissionRulesEndWith,
  assertOpenCodeExecutionSettings,
  type MappedOpenCodeInteraction
} from './OpenCodeInteractionMapper';
import {
  OpenCodeAmbiguousMutationError,
  OpenCodeHttpError,
  type OpenCodeClientTransport,
  type OpenCodeEventStream
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
  OPENCODE_DESIGN_MCP_SERVER_NAME,
  openCodeErrorDiagnostic,
  parseOpenCodeMessages,
  parseOpenCodePermissions,
  parseOpenCodeProviderCatalog,
  parseOpenCodePartDelta,
  parseOpenCodeQuestions,
  parseOpenCodeSession,
  parseOpenCodeSessions,
  type OpenCodeEvent,
  type OpenCodeMessage,
  type OpenCodeMessageInfo,
  type OpenCodePart,
  type OpenCodePromptPart,
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
import { buildDesignAgentDeveloperInstructions } from '../../../shared/promptTemplates';
import {
  loadDesignSkillPack,
  type DesignSkillPack
} from '../../design/DesignSkillPack';
import type {
  DesignClientToolBridge
} from '../../design/DesignClientToolBridge';

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
const STREAM_OUTPUT_FLUSH_MS = 1_000;
const STREAM_OUTPUT_FLUSH_BYTES = 64 * 1024;
const STREAM_OUTPUT_MAX_BUFFER_BYTES = 512 * 1024;
const STREAM_OUTPUT_MAX_FAILURES = 2;
const MAX_BUFFERED_STREAM_PARTS_PER_RUN = 8;
const OPENCODE_CATALOG_REFRESH_MS = 250;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INTERRUPT_COMPLETION_TIMEOUT_MS = 6_000;
const MAX_INTERRUPT_RECONCILIATION_WINDOW_MS = 1_500;
const MAX_TRACKED_ASSISTANT_MESSAGES_PER_SESSION = 2_048;
const MAX_TRACKED_ASSISTANT_USAGE_EVICTIONS_PER_SESSION = 2_048;
const MAX_TRACKED_ASSISTANT_USAGE_RUNS = 2_048;
const MAX_INBOUND_RESYNC_MS = 15_000;
const MAX_RUNTIME_DELTA_BYTES = 64 * 1024;
const OPENCODE_DESIGN_MCP_TIMEOUT_MS = 120_000;
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

interface TrackedAssistantUsage {
  runId: string;
  usage: AgentTokenUsageBreakdown;
  createdAt: number;
}

interface OpenCodeRunStreamBuffer {
  runId: string;
  sessionId: string;
  parts: Map<string, BufferedOpenCodeStreamPart>;
  output: Array<{ source: string; chunks: string[]; evidence: string[] }>;
  outputBytes: number;
  credentialCarry?: { source: string; text: string; evidence: string[] };
  failureCount: number;
  timer?: NodeJS.Timeout;
  flushing?: Promise<void>;
}

interface OpenCodeInboundGeneration {
  sessionId: string;
  serverId: string;
}

interface OpenCodeEventStreamBinding {
  stream?: OpenCodeEventStream;
  supervisor: OpenCodeSessionSupervisor;
  client: OpenCodeClientTransport;
  serverId: string;
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

interface OpenCodeSessionRuntimeOwner {
  id: string;
  runtimeId: string;
  worktreePath: string;
  pure?: boolean;
  design?: boolean;
}

interface OpenCodeDesignToolRegistration {
  serverId: string;
  grantId: string;
}

interface PreparedOpenCodeAttachmentDelivery {
  parts: OpenCodePromptPart[];
  submissionCandidates: AttachmentSubmissionCandidate[];
}

export interface OpenCodeAdapterOptions
  extends Omit<OpenCodeRuntimeResolverOptions, 'cwd'>,
    Pick<OpenCodeServerSupervisorOptions, 'requestTimeoutMs' | 'startupTimeoutMs'> {
  cwd: string;
  /** Explicit construction seam for deterministic lifecycle/protocol tests. */
  runtimeResolver?: typeof resolveOpenCodeRuntime;
  /** Explicit construction seam; production uses OpenCodeServerSupervisor. */
  supervisorFactory?: (
    store: AgentProviderRuntimeStore,
    options: OpenCodeServerSupervisorOptions
  ) => OpenCodeSessionSupervisor;
  /** Keeps inactive per-session loopback processes bounded; primarily shortened by lifecycle tests. */
  sessionIdleTimeoutMs?: number;
  /** Total post-acknowledgement window for OpenCode to prove interruption. */
  interruptCompletionTimeoutMs?: number;
  designSkillRoot?: string;
  designClientToolBridge?: Pick<
    DesignClientToolBridge,
    'createSessionGrant' | 'activateGrant' | 'revokeGrant' | 'releaseSessionGrant'
  >;
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
  private readonly eventStreams = new Map<string, OpenCodeEventStreamBinding>();
  private readonly sessionOperationQueues = new Map<string, Promise<void>>();
  private readonly sessionExitDrains = new Map<string, Promise<void>>();
  private readonly acceptedInboundGeneration =
    new AsyncLocalStorage<OpenCodeInboundGeneration>();
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
  private readonly assistantMessageUsage = new Map<
    string,
    Map<string, TrackedAssistantUsage>
  >();
  private readonly assistantUsageEvictedMessageIds = new Map<string, Set<string>>();
  private readonly assistantUsageTotals = new Map<string, AgentTokenUsageBreakdown>();
  private readonly inboundResyncs = new Map<string, Promise<void>>();
  private readonly runtimeTurnListeners = new Set<
    (event: AgentRuntimeTurnEvent) => void
  >();
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
  private designSkillPack?: DesignSkillPack;
  private designSkillFailure?: string;
  private designSkillLoadAttempted = false;
  private readonly designToolRegistrations = new Map<
    string,
    OpenCodeDesignToolRegistration
  >();

  constructor(
    private readonly taskRuntime: TaskAgentRuntimeAccess,
    private readonly providerRuntime: AgentRuntimeStore,
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
      await this.prepareDesignSkillPack();
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
        capabilities: this.runtimeCapabilities(),
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
    return Promise.resolve(this.runtimeCapabilities());
  }

  async listModels(): Promise<AgentModel[]> {
    if (!this.initialized) await this.initializeRuntime(true);
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
    const models = await this.listModels();
    return this.resolveExecutionFromModels(
      {
        ...input,
        settings: isProviderNeutralReadOnlySettings(input.settings)
          ? {
              ...input.settings,
              sandbox: 'DANGER_FULL_ACCESS',
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              networkAccess: true
            }
          : input.settings
      },
      models,
      'application OpenCode catalog',
      true
    );
  }

  async buildExecutionContext(
    input: BuildAgentRuntimeExecutionContextInput
  ): Promise<AgentExecutionContext> {
    const primaryCwd = await canonicalExistingDirectory(
      input.primaryCwd,
      'read-only working directory'
    );
    const readRoots = await Promise.all(
      input.readRoots.map(async (root) => ({
        ...root,
        canonicalPath: await canonicalExistingDirectory(
          root.canonicalPath,
          'read-only root'
        )
      }))
    );
    if (
      readRoots.length !== 1 ||
      readRoots[0]?.canonicalPath !== primaryCwd
    ) {
      throw new Error(
        'OpenCode read-only turns support one repository working directory and no additional readable path.'
      );
    }
    const modelSettings: AgentExecutionSettings = {
      ...input.modelSettings,
      runtimeId: this.descriptor.id,
      sandbox: 'DANGER_FULL_ACCESS',
      approvalPolicy: 'NEVER',
      approvalsReviewer: 'user',
      networkAccess: true
    };
    const permissionProfileHash = openCodeReadOnlyProfileHash(
      primaryCwd,
      readRoots,
      modelSettings
    );
    const context: AgentExecutionContext = {
      attestation: { status: 'ATTESTED' },
      primaryCwd,
      readRoots,
      managedAttachments: [],
      permissionProfileHash,
      modelSettings,
      externalTools: {
        // This records provider-process reachability. Web tools are denied by
        // the native permission policy below.
        network: true,
        webSearch: 'disabled',
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      repositoryAccess: 'READ_ONLY',
      clientOperationId: input.clientOperationId
    };
    assertReadOnlyExecutionContext(context);
    return context;
  }

  onRuntimeTurnEvent(listener: (event: AgentRuntimeTurnEvent) => void): () => void {
    this.runtimeTurnListeners.add(listener);
    return () => this.runtimeTurnListeners.delete(listener);
  }

  async startRuntimeTurn(input: StartAgentRuntimeTurn): Promise<StartedAgentRuntimeTurn> {
    await this.applyPendingRuntimeConfiguration(input.run.id);
    this.assertRuntimeExecutionContext(input);
    return this.enqueueSessionOperation(input.session.id, async () => {
      let session = (await this.providerRuntime.getSession(input.session.id)) ?? input.session;
      if (
        session.runtimeId !== this.descriptor.id ||
        input.run.sessionId !== session.id
      ) {
        throw new Error('OpenCode received an invalid owner-neutral read-only turn.');
      }
      const settings = openCodeNativeReadOnlySettings(
        input.executionContext.modelSettings
      );
      if (!settings.model || !settings.modelProvider) {
        throw new Error('OpenCode read-only turns require a resolved model and provider.');
      }
      const selectedModel = this.resolveExecutionFromModels(
        { settings, attachments: input.attachments },
        this.models,
        'application OpenCode catalog'
      ).model;
      const running = await this.ensureSessionRuntime(runtimeSessionOwner(session));
      let providerSession: OpenCodeSession;
      if (session.providerSessionId) {
        providerSession = parseOpenCodeSession(
          (await running.client.get<unknown>(sessionPath(session.providerSessionId))).data
        );
      } else {
        try {
          providerSession = parseOpenCodeSession(
            (
              await running.client.post<unknown>('/session', {
                title: openCodeOwnershipTitle(session.id),
                model: modelReference(settings),
                metadata: { taskMonkiSessionId: session.id },
                permission: openCodeReadOnlyPermissionRules()
              })
            ).data
          );
        } catch (cause) {
          throw runtimeDeliveryErrorFromOpenCode('session/create', cause);
        }
      }
      if (!this.isSafeOperationalIdentifier(providerSession.id)) {
        await this.quarantineSessionRuntime(
          session.id,
          'runtime/session-identity',
          'OpenCode returned a read-only session identifier matching a runtime credential.'
        );
        throw new Error('OpenCode returned an unsafe read-only session identity.');
      }
      await this.assertSessionDirectoryOrQuarantine(
        session.id,
        'runtime/session-directory',
        providerSession,
        session.executionContext.primaryCwd
      );
      providerSession = await this.synchronizeRuntimeSessionPermissionPolicy(
        session,
        providerSession,
        running.client
      );
      session = await this.providerRuntime.updateSession(
        session.id,
        session.recordRevision,
        {
          providerSessionId: providerSession.id,
          providerSessionTreeId: providerSession.id,
          materialized: true,
          status: 'IDLE',
          requestedSettings: input.executionContext.modelSettings,
          observedSettings: settings,
          lastAttachedAt: new Date().toISOString()
        },
        runtimeOperationId('runtime/session-attested', session.id, providerSession.id)
      );
      await this.bindEventStream(runtimeSessionOwner(session), running.client, running.server.id);
      if (!this.isCurrentSessionServerGeneration(session.id, running.server.id)) {
        throw new AgentRuntimeDeliveryError(
          'NOT_DELIVERED',
          'OpenCode replaced the read-only session runtime before prompt submission.'
        );
      }
      let attachmentDelivery: PreparedOpenCodeAttachmentDelivery;
      try {
        attachmentDelivery = await prepareOpenCodeAttachmentDelivery(
          input.prompt,
          selectedModel,
          input.attachments
        );
      } catch (cause) {
        throw new AgentRuntimeDeliveryError(
          'NOT_DELIVERED',
          errorMessage(cause),
          { cause }
        );
      }
      const providerMessageId = createOpenCodeMessageId();
      await this.updateRuntimeRun(
        input.run.id,
        {
          serverInstanceId: running.server.id,
          providerTurnId: providerMessageId,
          observedSettings: settings,
          lastEventAt: new Date().toISOString()
        },
        runtimeOperationId(
          'runtime/turn-send-intent',
          input.run.id,
          providerMessageId,
          running.server.id
        )
      );
      try {
        await running.client.post<void>(`${sessionPath(providerSession.id)}/prompt_async`, {
          messageID: providerMessageId,
          model: {
            providerID: settings.modelProvider,
            modelID: settings.model
          },
          ...(settings.reasoningEffort
            ? { variant: settings.reasoningEffort }
            : {}),
          parts: attachmentDelivery.parts
        });
      } catch (cause) {
        throw runtimeDeliveryErrorFromOpenCode('session/prompt_async', cause);
      }
      if (!this.isCurrentSessionServerGeneration(session.id, running.server.id)) {
        throw new AgentRuntimeDeliveryError(
          'AMBIGUOUS',
          `OpenCode accepted message ${providerMessageId}, but its owning runtime generation changed before acknowledgement.`
        );
      }
      const startedAt = new Date().toISOString();
      return {
        serverInstanceId: running.server.id,
        providerSessionId: providerSession.id,
        providerSessionTreeId: providerSession.id,
        providerTurnId: providerMessageId,
        startedAt,
        attachmentSubmissions: completeAttachmentSubmissions(
          attachmentDelivery.submissionCandidates,
          { kind: 'provider-message', id: providerMessageId },
          startedAt
        )
      };
    });
  }

  async interruptRuntimeTurn(input: {
    session: AgentRuntimeSessionRecord;
    run: AgentRuntimeRunRecord;
  }): Promise<void> {
    await this.enqueueSessionOperation(input.session.id, async () => {
      const providerSessionId = input.session.providerSessionId;
      const providerTurnId = input.run.providerTurnId;
      const supervisor = this.supervisors.get(input.session.id);
      const client = supervisor?.currentClient;
      const server = supervisor?.currentServer;
      if (
        !providerSessionId ||
        !providerTurnId ||
        !client ||
        !server ||
        input.run.serverInstanceId !== server.id ||
        !isOpenCodeReadOnlyRuntimeSession(input.session)
      ) {
        throw new AgentRuntimeDeliveryError(
          'AMBIGUOUS',
          'The OpenCode process that owns this read-only turn is unavailable; cancellation delivery cannot be confirmed.'
        );
      }
      const deadlineAt = Date.now() + this.interruptCompletionTimeoutMs;
      let unsettledReason: string | undefined;
      try {
        await client.post<boolean>(
          `${sessionPath(providerSessionId)}/abort`,
          undefined,
          {
            deadlineAt: Math.min(
              deadlineAt,
              Date.now() + this.interruptReconciliationWindowMs()
            )
          }
        );
      } catch (cause) {
        unsettledReason =
          `OpenCode did not confirm cancellation delivery: ${this.redactProviderText(errorMessage(cause))}`;
      }
      while (!unsettledReason && Date.now() < deadlineAt) {
        if (!this.isCurrentSessionServerGeneration(input.session.id, server.id)) {
          throw new AgentRuntimeDeliveryError(
            'AMBIGUOUS',
            'The OpenCode process that owns this read-only turn changed before cancellation settled.'
          );
        }
        const current = await this.providerRuntime.getRun(input.run.id);
        if (!current || TERMINAL_RUN_STATES.includes(current.status)) return;
        let status: 'IDLE' | 'ACTIVE' | 'UNKNOWN';
        try {
          status = await this.readProviderInterruptStatus(
            client,
            providerSessionId,
            deadlineAt
          );
        } catch (cause) {
          unsettledReason =
            `Task Monki could not confirm OpenCode cancellation settlement: ${this.redactProviderText(errorMessage(cause))}`;
          break;
        }
        if (status === 'IDLE') {
          await this.finalizeRuntimeRun(
            current,
            input.session,
            'interrupted',
            'OpenCode acknowledged cancellation and reported the provider session idle.',
            ''
          );
          return;
        }
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          unsettledReason =
            `OpenCode acknowledged cancellation but still reported the provider session as ${status.toLowerCase()} at the interruption deadline.`;
          break;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(250, remainingMs))
        );
      }
      unsettledReason ??=
        'OpenCode acknowledged cancellation but Task Monki could not prove provider settlement before the interruption deadline.';
      if (!this.isCurrentSessionServerGeneration(input.session.id, server.id)) {
        throw new AgentRuntimeDeliveryError(
          'AMBIGUOUS',
          'The OpenCode process that owns this read-only turn changed before Task Monki could stop it.'
        );
      }
      try {
        await this.quarantineSessionRuntime(
          input.session.id,
          'runtime/session-abort-completion',
          unsettledReason,
          false,
          input.run.id
        );
      } catch (cause) {
        throw new AgentRuntimeDeliveryError(
          'AMBIGUOUS',
          `${unsettledReason} Task Monki fenced the session, but could not confirm process termination: ${this.redactProviderText(errorMessage(cause))}`,
          { cause }
        );
      }
      const current = await this.providerRuntime.getRun(input.run.id);
      if (!current || TERMINAL_RUN_STATES.includes(current.status)) return;
      await this.finalizeRuntimeRun(
        current,
        input.session,
        'interrupted',
        `${unsettledReason} Task Monki stopped the owning OpenCode session process.`,
        '',
        { sessionStopped: true }
      );
    });
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
    if (!model.modelProvider) {
      throw new Error('OpenCode returned a model without its connected provider identity.');
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
    assertModelSupportsAttachments(model, input.attachments);
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
    const startedSessionRuntime = !this.supervisors.has(session.id);
    try {
      const { client, server } = await this.ensureSessionRuntime({
        ...session,
        pure: input.mode === 'DESIGN',
        design: input.mode === 'DESIGN'
      });
      const projectCatalog = parseOpenCodeProviderCatalog(
        (await client.get<unknown>('/provider')).data
      );
      const selectedSettings = this.resolveExecutionFromModels(
        { settings: input.settings, attachments: input.attachments ?? [] },
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
        session = await this.taskRuntime.updateAgentSession(
          session.id,
          {
            providerSessionId: existingProviderSession.id,
            providerSessionTreeId: existingProviderSession.id,
            status: await this.readProviderSessionStatus(
              client,
              existingProviderSession.id
            ),
            materialized: true,
            requestedSettings: selectedSettings,
            observedSettings: this.safeObservedSettings(
              settingsFromSession(existingProviderSession, selectedSettings)
            ),
            lastAttachedAt: new Date().toISOString()
          },
          runtimeOperationId(
            'session/discovery',
            session.id,
            existingProviderSession.id,
            server.id
          )
        );
        const verified = await this.synchronizeSessionPermissionPolicy(
          session,
          client,
          selectedSettings,
          'session/discovery-permission'
        );
        session = await this.persistPermissionAttestation(
          session,
          verified,
          selectedSettings,
          'session/discovery-permission'
        );
        await this.bindEventStream(session, client, server.id);
        if (session.status === 'IDLE') {
          this.scheduleSessionIdleEviction(session.id);
        }
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
        session = await this.taskRuntime.updateAgentSession(
          session.id,
          {
            providerSessionId: response.id,
            providerSessionTreeId: response.id,
            status: 'IDLE',
            materialized: false,
            requestedSettings: selectedSettings,
            observedSettings: this.safeObservedSettings(
              settingsFromSession(response, selectedSettings)
            ),
            lastAttachedAt: new Date().toISOString()
          },
          runtimeOperationId('session/create', session.id, response.id)
        );
      } catch (cause) {
        const persisted = await this.taskRuntime
          .getAgentSession(session.id)
          .catch(() => undefined);
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
      const verified = await this.synchronizeSessionPermissionPolicy(
        session,
        client,
        selectedSettings,
        'session/create-permission'
      );
      session = await this.persistPermissionAttestation(
        session,
        verified,
        selectedSettings,
        'session/create-permission'
      );
      await this.recordSettingsObservation(
        session,
        'THREAD_START_RESPONSE',
        session.observedSettings ?? selectedSettings
      );
      await this.bindEventStream(session, client, server.id);
      this.scheduleSessionIdleEviction(session.id);
      return session;
    } catch (cause) {
      if (startedSessionRuntime && this.supervisors.has(session.id)) {
        try {
          await this.closeSessionRuntime(session.id, false);
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'OpenCode session creation and runtime cleanup both failed.'
          );
        }
      }
      throw cause;
    }
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
    const { client, server } = await this.ensureSessionRuntime(
      await this.runtimeSessionOwnerForSession(session)
    );
    let response: OpenCodeSession;
    let responseRaw: AgentProtocolMessageReference;
    try {
      const result = await client.get<unknown>(sessionPath(providerSessionId));
      response = parseOpenCodeSession(result.data);
      responseRaw = result.raw;
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
    const activeRun = await this.getCurrentRunForSession(session.id);
    const status = await this.sessionStatusWithInteractionAuthority(
      await this.readProviderSessionStatus(client, providerSessionId),
      activeRun
    );
    session = await this.taskRuntime.updateAgentSession(session.id, {
      providerSessionId: response.id,
      providerSessionTreeId: response.id,
      status,
      materialized: true,
      observedSettings: this.safeObservedSettings(
        settingsFromSession(response, session.requestedSettings)
      ),
      lastAttachedAt: new Date().toISOString()
    }, protocolOperationId(
      'session/attach',
      responseRaw,
      session.id,
      response.id,
      server.id,
      status
    ));
    if (activeRun && activeRun.serverInstanceId !== server.id) {
      await this.taskRuntime.updateRun(
        activeRun.id,
        { serverInstanceId: server.id },
        runtimeOperationId('run/attach-server', activeRun.id, server.id)
      );
    }
    await this.bindEventStream(session, client, server.id);
    await this.reconcilePendingInteractions(session, client, server.id);
    if (status === 'IDLE' && !activeRun) this.scheduleSessionIdleEviction(session.id);
    return session;
  }

  async releaseSession(ref: AgentSessionRef): Promise<void> {
    const taskSession = await this.taskRuntime.getAgentSession(ref.localSessionId);
    const runtimeSession = taskSession
      ? undefined
      : await this.providerRuntime.getSession(ref.localSessionId);
    const session = taskSession ?? runtimeSession;
    if (!session) throw new Error(`Agent session not found: ${ref.localSessionId}`);
    this.assertSessionOwnership(session);
    const activeRun = taskSession
      ? await this.getCurrentRunForSession(session.id)
      : await this.providerRuntime.getActiveRunForSession(session.id);
    if (activeRun) {
      throw new Error(
        `Cannot release OpenCode session ${session.id} while run ${activeRun.id} is ${activeRun.status}.`
      );
    }
    await this.closeSessionRuntime(session.id, true);
  }

  async releaseTask(taskId: string): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
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
    const { client } = await this.ensureSessionRuntime(
      await this.runtimeSessionOwnerForSession(session)
    );
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
    const activeRun = await this.getCurrentRunForSession(session.id);
    session = await this.taskRuntime.updateAgentSession(session.id, {
      status: await this.sessionStatusWithInteractionAuthority(
        await this.readProviderSessionStatus(client, providerSessionId),
        activeRun
      ),
      materialized: true,
      observedSettings: this.safeObservedSettings(
        settingsFromSession(response, session.requestedSettings)
      ),
      lastAttachedAt: new Date().toISOString()
    }, runtimeOperationId('session/read', session.id, response.id, session.updatedAt));
    const snapshot = await this.taskRuntime.snapshot();
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
    const attachments = input.attachments ?? [];
    const settings = input.settings ?? session.requestedSettings;
    assertOpenCodeExecutionSettings(settings);
    const hadProviderSession = Boolean(session.providerSessionId);
    const previousSupervisor = this.supervisors.get(session.id);
    let promptAcknowledged = false;
    try {
      const designInstructions = this.designInstructions(input);
      const runtimeOwner = {
        ...session,
        pure: input.mode === 'DESIGN',
        design: input.mode === 'DESIGN'
      };
      let running = await this.ensureSessionRuntime(runtimeOwner);
      const projectCatalog = parseOpenCodeProviderCatalog(
        (await running.client.get<unknown>('/provider')).data
      );
      const projectModels = mapOpenCodeModels(projectCatalog);
      const selectedModel = this.resolveExecutionFromModels(
        { settings, attachments },
        this.safePublishedModels(projectModels),
        `worktree catalog for ${session.worktreePath}`
      );
      if (
        input.mode === 'DESIGN' &&
        selectedModel.model.designSupport?.maturity !== 'stable'
      ) {
        throw new Error(
          selectedModel.model.designSupport?.detail ??
            'OpenCode reports that the selected model cannot accept images required by Design Mode.'
        );
      }
      if (!session.providerSessionId) {
        session = await this.createSession({
          runtimeId: this.descriptor.id,
          localSessionId: session.id,
          taskId: session.taskId,
          iterationId: session.iterationId,
          worktreeId: session.worktreeId,
          worktreePath: session.worktreePath,
          mode: input.mode,
          instructionProfile: input.instructionProfile,
          settings: selectedModel.settings,
          attachments
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
      running = await this.ensureSessionRuntime({
        ...session,
        pure: input.mode === 'DESIGN',
        design: input.mode === 'DESIGN'
      });
      const { client, server } = running;
      await this.bindEventStream(session, client, server.id);
      if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
        throw new Error('OpenCode replaced the session runtime before prompt submission.');
      }
      const verifiedPermissionSession = await this.synchronizeSessionPermissionPolicy(
        session,
        client,
        selectedModel.settings,
        'session/pre-prompt-permission'
      );
      session = await this.persistPermissionAttestation(
        session,
        verifiedPermissionSession,
        selectedModel.settings,
        'session/pre-prompt-permission'
      );
      if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
        throw new Error('OpenCode replaced the session runtime before prompt submission.');
      }
      const attachmentDelivery = await prepareOpenCodeAttachmentDelivery(
        input.prompt,
        selectedModel.model,
        attachments
      );
      const providerMessageId = createOpenCodeMessageId();
      await this.taskRuntime.updateRun(input.localRunId, {
        providerTurnId: providerMessageId,
        serverInstanceId: server.id,
        status: 'STARTING',
        lastEventAt: new Date().toISOString()
      }, runtimeOperationId('turn/send-intent', input.localRunId, providerMessageId, server.id));
      if (input.mode === 'DESIGN') {
        await this.activateDesignToolGrant(session, input.localRunId, server.id);
      }
      if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
        await this.revokeDesignToolGrant(session.id).catch(() => undefined);
        throw new Error('OpenCode replaced the session runtime before prompt submission.');
      }
      let promptAcknowledgement: AgentProtocolMessageReference;
      try {
        promptAcknowledgement = (
          await client.post<void>(`${sessionPath(providerSessionId)}/prompt_async`, {
            messageID: providerMessageId,
            model: {
              providerID: selectedModel.model.modelProvider,
              modelID: selectedModel.model.model
            },
            ...(selectedModel.settings.reasoningEffort
              ? { variant: selectedModel.settings.reasoningEffort }
              : {}),
            ...(designInstructions ? { system: designInstructions } : {}),
            parts: attachmentDelivery.parts
          })
        ).raw;
        promptAcknowledged = true;
      } catch (cause) {
        await this.revokeDesignToolGrant(session.id).catch(() => undefined);
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
        await this.revokeDesignToolGrant(session.id).catch(() => undefined);
        throw new AgentMutationAmbiguousError(
          'session/prompt_async',
          `OpenCode accepted message ${providerMessageId}, but its owning runtime generation was replaced before Task Monki could persist the acknowledgement.`
        );
      }
      const submittedAt = new Date().toISOString();
      try {
        await this.taskRuntime.updateRun(input.localRunId, {
          status: 'RUNNING',
          observedSettings: selectedModel.settings,
          attachmentSubmissions: completeAttachmentSubmissions(
            attachmentDelivery.submissionCandidates,
            { kind: 'provider-message', id: providerMessageId },
            submittedAt
          ),
          lastEventAt: submittedAt
        }, runtimeOperationId('turn/acknowledged', input.localRunId, providerMessageId, server.id));
        if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
          throw new OpenCodeRuntimeGenerationChangedError();
        }
        session = await this.taskRuntime.updateAgentSession(session.id, {
          status: 'ACTIVE',
          materialized: true,
          requestedSettings: selectedModel.settings,
          observedSettings: selectedModel.settings,
          lastAttachedAt: submittedAt
        }, runtimeOperationId('session/turn-active', session.id, providerMessageId, server.id));
        if (!this.isCurrentSessionServerGeneration(session.id, server.id)) {
          throw new OpenCodeRuntimeGenerationChangedError();
        }
        await this.recordSettingsObservation(
          session,
          'TASK_MONKI_RESOLUTION',
          selectedModel.settings,
          input.localRunId,
          promptAcknowledgement
        );
      } catch (cause) {
        await this.revokeDesignToolGrant(session.id).catch(() => undefined);
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
    } catch (cause) {
      if (
        !previousSupervisor &&
        !promptAcknowledged &&
        this.supervisors.has(session.id)
      ) {
        try {
          await this.closeSessionRuntime(session.id, false);
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'OpenCode turn setup and runtime cleanup both failed.'
          );
        }
      }
      throw cause;
    }
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
      const run = await this.taskRuntime.getRunByProviderTurnId(
        this.descriptor.id,
        input.providerTurnId
      );
      if (!run || run.sessionId !== session.id) {
        throw new Error('The OpenCode turn does not belong to the selected session.');
      }
      if (run.mode === 'DESIGN') {
        await this.revokeDesignToolGrant(session.id).catch((cause) =>
          this.recordProtocolIncident(session.id, cause).catch(() => undefined)
        );
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
        await this.taskRuntime.updateRun(run.id, {
          status: 'INTERRUPTING',
          lastEventAt: new Date().toISOString()
        }, runtimeOperationId('turn/interrupt-acknowledged', run.id, input.providerTurnId, server.id));
      }
      const interrupting = await this.taskRuntime.getRun(run.id);
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
        const current = await this.taskRuntime.getRun(run.id);
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
    const run = await this.taskRuntime.getRun(deadline.runId);
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
      const current = await this.taskRuntime.getRun(deadline.runId);
      if (current?.status === 'INTERRUPTING') {
        await this.recordRunActivity(current, 'session/abort/reconcile-failed', {
          error: this.redactProviderText(errorMessage(cause))
        });
      }
    }
    if (!this.isCurrentInterruptDeadline(deadline)) return;
    const current = await this.taskRuntime.getRun(deadline.runId);
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
    const run = await this.taskRuntime.getRun(deadline.runId);
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
    const current = await this.taskRuntime.getRun(deadline.runId);
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
      isTerminalAssistantMessage(assistant) &&
      (status === 'IDLE' || isOpenCodeAbortError(assistant.info.error))
    ) {
      const finalized = await this.finalizeFromSnapshot(
        run,
        session,
        assistant,
        messagesResult.raw,
        serverInstanceId
      );
      return finalized ? 'TERMINAL' : 'UNCERTAIN';
    }
    if (status === 'IDLE') {
      const finalized = await this.finalizeRun(
        run,
        'INTERRUPTED',
        'OpenCode acknowledged cancellation and reported the provider session idle.'
      );
      if (
        finalized &&
        this.isCurrentSessionServerGeneration(session.id, serverInstanceId)
      ) {
        await this.taskRuntime.updateAgentSession(session.id, {
          status: 'IDLE',
          materialized: true
        }, runtimeOperationId('session/interrupt-idle', session.id, run.id, serverInstanceId));
        this.scheduleSessionIdleEviction(session.id);
      }
      return finalized ? 'TERMINAL' : 'UNCERTAIN';
    }
    if (status === 'ACTIVE') {
      await this.taskRuntime.updateAgentSession(session.id, {
        status: 'ACTIVE',
        materialized: true
      }, runtimeOperationId('session/interrupt-active', session.id, run.id, serverInstanceId));
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
      stored = await this.taskRuntime.updateAgentSession(target.id, {
        providerSessionId: forked.id,
        providerSessionTreeId: forked.id,
        providerForkedFromSessionId: sourceProviderId,
        relationshipState: 'RESOLVED',
        status: 'NOT_LOADED',
        materialized: false,
        requestedSettings: input.settings,
        observedSettings: this.safeObservedSettings(
          settingsFromSession(forked, input.settings)
        ),
        lastAttachedAt: new Date().toISOString()
      }, runtimeOperationId('session/fork', target.id, forked.id, sourceProviderId));
    } catch (cause) {
      let persisted: AgentSessionRecord | undefined;
      try {
        persisted = await this.taskRuntime.getAgentSession(target.id);
      } catch (confirmationCause) {
        await this.throwAmbiguousAfterQuarantine(
          target.id,
          'session/fork-ownership',
          `Task Monki could not confirm whether OpenCode fork ${forked.id} was durably owned after the ownership write failed.`,
          new AgentMutationAmbiguousError(
            'session/fork-ownership',
            `OpenCode created fork ${forked.id}, but its Task Monki ownership could not be confirmed: ${this.redactProviderText(errorMessage(confirmationCause))} The provider session was not deleted.`
          )
        );
      }
      if (
        persisted?.providerSessionId === forked.id &&
        persisted.providerSessionTreeId === forked.id
      ) {
        stored = persisted;
      } else {
        await this.deleteUnownedFork(target.id, client, forked.id, cause);
        throw new Error(
          `OpenCode created fork ${forked.id}, but Task Monki could not durably record its ownership. The unowned provider session was deleted, so the fork can be retried safely.`,
          { cause }
        );
      }
    }
    const verifiedPermissionSession = await this.synchronizeSessionPermissionPolicy(
      stored,
      client,
      input.settings,
      'session/fork-permission'
    );
    stored = await this.persistPermissionAttestation(
      stored,
      verifiedPermissionSession,
      input.settings,
      'session/fork-permission',
      { status: 'IDLE', materialized: true }
    );
    await this.bindEventStream(stored, client, server.id);
    this.scheduleSessionIdleEviction(stored.id);
    return stored;
  }

  private async deleteUnownedFork(
    localSessionId: string,
    client: OpenCodeClientTransport,
    providerSessionId: string,
    ownershipFailure: unknown
  ): Promise<void> {
    let existingOwner: AgentSessionRecord | undefined;
    try {
      existingOwner = await this.taskRuntime.getAgentSessionByProviderId(
        this.descriptor.id,
        providerSessionId
      );
    } catch (cause) {
      await this.throwAmbiguousAfterQuarantine(
        localSessionId,
        'session/fork-cleanup',
        `Task Monki could not prove that OpenCode fork ${providerSessionId} was unowned.`,
        new AgentMutationAmbiguousError(
          'session/fork-cleanup',
          `Task Monki could not verify ownership of OpenCode fork ${providerSessionId}: ${this.redactProviderText(errorMessage(cause))} The provider session was not deleted.`
        )
      );
    }
    if (existingOwner) {
      await this.throwAmbiguousAfterQuarantine(
        localSessionId,
        'session/fork-cleanup',
        `OpenCode returned provider session ${providerSessionId}, which is already owned by Task Monki session ${existingOwner.id}.`,
        new AgentMutationAmbiguousError(
          'session/fork-cleanup',
          `OpenCode returned provider session ${providerSessionId}, which is already owned by Task Monki. It was not deleted.`
        )
      );
    }
    let deletionFailure: unknown;
    try {
      const deletion = await client.delete<boolean>(sessionPath(providerSessionId));
      if (deletion.data === true) {
        this.scheduleSessionIdleEviction(localSessionId);
        return;
      }
      deletionFailure = new Error(
        `OpenCode did not confirm deletion of session ${providerSessionId}.`
      );
    } catch (cause) {
      deletionFailure = cause;
    }
    try {
      await client.get<unknown>(sessionPath(providerSessionId));
    } catch (cause) {
      if (cause instanceof OpenCodeHttpError && cause.status === 404) {
        this.scheduleSessionIdleEviction(localSessionId);
        return;
      }
      deletionFailure = deletionFailure ?? cause;
    }
    const diagnostic = this.redactProviderText(
      deletionFailure
        ? errorMessage(deletionFailure)
        : `OpenCode session ${providerSessionId} still exists after deletion.`
    );
    await this.throwAmbiguousAfterQuarantine(
      localSessionId,
      'session/fork-cleanup',
      `Task Monki could not confirm deletion of unowned OpenCode fork ${providerSessionId}.`,
      new AgentMutationAmbiguousError(
        'session/fork-cleanup',
        `Task Monki could not confirm deletion of unowned OpenCode fork ${providerSessionId} after its ownership write failed: ${this.redactProviderText(errorMessage(ownershipFailure))} Cleanup result: ${diagnostic} Automatic retry is disabled.`
      )
    );
  }

  async respondToInteraction(input: AgentInteractionResponse): Promise<void> {
    const session = await this.requireSession(input.interaction.sessionId);
    const supervisor = this.supervisors.get(session.id);
    const server = supervisor?.currentServer;
    if (!server || server.id !== input.interaction.serverInstanceId) {
      throw new Error('OpenCode interaction belongs to a no-longer-active runtime instance.');
    }
    const { client } = await this.ensureSessionRuntime(
      await this.runtimeSessionOwnerForSession(session)
    );
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
      const latest = await this.taskRuntime.getInteractionRequest(input.interaction.id);
      if (!latest) {
        throw new Error('The acknowledged interaction no longer has a durable Task Monki record.');
      }
      if (latest.status === 'PENDING') {
        throw new Error('The acknowledged interaction unexpectedly returned to pending state.');
      }
      if (latest.status !== 'RESPONDING') return;
      const resolved = await this.taskRuntime.transitionInteractionRequest(latest.id, 'RESPONDING', {
        status: interactionTerminalStatus(input.decision),
        responseRawMessage: responseRaw,
        resolution: { provider: OPENCODE_RUNTIME_ID, acknowledged: true },
        resolvedAt: new Date().toISOString()
      }, protocolOperationId('interaction/response-acknowledged', responseRaw, latest.id));
      this.emitInteractionUpdate(resolved);
      await this.resumeAfterInteractionResolution(resolved);
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
    const runs = await this.taskRuntime.getRunsRequiringRecovery({
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
    const designToolReleaseResults = await Promise.allSettled(
      [...this.designToolRegistrations.keys()].map((sessionId) =>
        this.releaseDesignToolRegistration(sessionId)
      )
    );
    const streams = [...this.eventStreams.values()]
      .map((binding) => binding.stream)
      .filter((stream): stream is OpenCodeEventStream => stream !== undefined);
    for (const stream of streams) stream.stop();
    const streamResults = await Promise.allSettled(
      streams.map((stream) => stream.settled)
    );
    const exitDrainResults = await Promise.allSettled([
      ...this.sessionExitDrains.values()
    ]);
    await Promise.allSettled([...this.sessionOperationQueues.values()]);
    await Promise.allSettled([...this.inboundResyncs.values()]);
    this.inboundResyncs.clear();
    this.assistantMessageParents.clear();
    this.assistantMessageUsage.clear();
    this.assistantUsageEvictedMessageIds.clear();
    this.assistantUsageTotals.clear();
    if (this.catalogRefreshPromise) await this.catalogRefreshPromise.catch(() => undefined);
    const failures: unknown[] = [
      ...designToolReleaseResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason),
      ...streamResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason),
      ...exitDrainResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
    ];
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
      } finally {
        this.discardStreamBuffer(runId);
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
      capabilities: this.runtimeCapabilities(),
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
    session: OpenCodeSessionRuntimeOwner
  ): Promise<{ client: OpenCodeClientTransport; server: { id: string } }> {
    const exitDrain = this.sessionExitDrains.get(session.id);
    if (exitDrain) await exitDrain;
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
      supervisor = this.createSupervisor(
        this.requireRuntime(),
        session.worktreePath,
        session.pure === true
      );
      const ownedSupervisor = supervisor;
      supervisor.events.on('exit', (server, unexpected) => {
        if (!unexpected || this.shuttingDown) return;
        this.beginUnexpectedSessionExitDrain(
          session.id,
          ownedSupervisor,
          server.id
        );
      });
      this.supervisors.set(session.id, supervisor);
    }
    const running = await supervisor.start();
    if (session.pure) {
      const server = await this.providerRuntime.getAgentServer(running.server.id);
      if (!server?.argv.includes('--pure')) {
        await this.quarantineSessionRuntime(
          session.id,
          'runtime/pure-mode',
          'The OpenCode pure process did not start with external plugins disabled.'
        );
        throw new Error(
          'OpenCode could not attest that external plugins were disabled for this pure session.'
        );
      }
    }
    if (session.design) {
      await this.ensureDesignToolRegistration(
        session,
        running.client,
        running.server.id
      );
    }
    return { client: running.client, server: running.server };
  }

  private async ensureDesignToolRegistration(
    session: OpenCodeSessionRuntimeOwner,
    client: OpenCodeClientTransport,
    serverId: string
  ): Promise<void> {
    const bridge = this.options.designClientToolBridge;
    if (!bridge) {
      throw new Error('The packaged inspect_design MCP bridge is not configured.');
    }
    const existing = this.designToolRegistrations.get(session.id);
    if (existing?.serverId === serverId) return;
    if (existing) {
      await bridge.releaseSessionGrant(existing.grantId);
      this.designToolRegistrations.delete(session.id);
    }

    const grant = await bridge.createSessionGrant({
      runtimeId: this.descriptor.id,
      sessionId: session.id,
      worktreeId: await this.requireSessionWorktreeId(session.id),
      providerGeneration: serverId
    });
    const environment = grant.launch.environment;
    const sensitiveValues = Object.entries(environment)
      .filter(([name]) => name.startsWith('TASK_MONKI_DESIGN_TOOL_'))
      .map(([, value]) => value);
    try {
      const registration = await client.post<unknown>('/mcp', {
        name: OPENCODE_DESIGN_MCP_SERVER_NAME,
        config: {
          type: 'local',
          command: [grant.launch.executablePath, ...grant.launch.argv],
          environment,
          timeout: OPENCODE_DESIGN_MCP_TIMEOUT_MS
        }
      }, { sensitiveValues });
      assertOpenCodeMcpConnected(
        registration.data,
        OPENCODE_DESIGN_MCP_SERVER_NAME
      );
    } catch (cause) {
      await bridge.releaseSessionGrant(grant.id).catch(() => undefined);
      const error = mapOpenCodeMutationError('mcp/register', cause);
      if (error instanceof AgentMutationAmbiguousError) {
        await this.throwAmbiguousAfterQuarantine(
          session.id,
          'mcp/register',
          'OpenCode may have registered the Design MCP server without an authoritative acknowledgement.',
          error
        );
      }
      throw error;
    }
    const registration = { serverId, grantId: grant.id };
    this.designToolRegistrations.set(session.id, registration);
  }

  private async requireSessionWorktreeId(sessionId: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    if (!session.worktreeId) {
      throw new Error('The OpenCode Design session has no worktree identity.');
    }
    return session.worktreeId;
  }

  private async activateDesignToolGrant(
    session: AgentSessionRecord,
    runId: string,
    serverId: string
  ): Promise<void> {
    const registration = this.designToolRegistrations.get(session.id);
    const bridge = this.options.designClientToolBridge;
    if (!registration || registration.serverId !== serverId || !bridge) {
      throw new Error('The OpenCode Design MCP server is not registered for this runtime.');
    }
    await bridge.activateGrant({
      grantId: registration.grantId,
      authority: {
        runtimeId: this.descriptor.id,
        sessionId: session.id,
        runId,
        worktreeId: session.worktreeId,
        providerGeneration: serverId
      }
    });
  }

  private async revokeDesignToolGrant(sessionId: string): Promise<void> {
    const registration = this.designToolRegistrations.get(sessionId);
    if (!registration || !this.options.designClientToolBridge) return;
    await this.options.designClientToolBridge.revokeGrant(registration.grantId);
  }

  private async releaseDesignToolRegistration(sessionId: string): Promise<void> {
    const registration = this.designToolRegistrations.get(sessionId);
    if (!registration) return;
    await this.options.designClientToolBridge?.releaseSessionGrant(
      registration.grantId
    );
    this.designToolRegistrations.delete(sessionId);
  }

  private async releaseDesignToolRegistrationSafely(sessionId: string): Promise<void> {
    try {
      await this.releaseDesignToolRegistration(sessionId);
    } catch (cause) {
      await this.recordProtocolIncident(sessionId, cause).catch(() => undefined);
    }
  }

  private async disconnectDesignToolRegistration(
    sessionId: string,
    client: OpenCodeClientTransport,
    serverId: string
  ): Promise<void> {
    const registration = this.designToolRegistrations.get(sessionId);
    if (!registration || registration.serverId !== serverId) return;
    await this.revokeDesignToolGrant(sessionId);
    let failure: unknown;
    try {
      await client.post(
        `/mcp/${encodeURIComponent(OPENCODE_DESIGN_MCP_SERVER_NAME)}/disconnect`
      );
    } catch (cause) {
      failure = mapOpenCodeMutationError('mcp/disconnect', cause);
    }
    await this.releaseDesignToolRegistration(sessionId);
    if (failure) throw failure;
  }

  private beginUnexpectedSessionExitDrain(
    sessionId: string,
    supervisor: OpenCodeSessionSupervisor,
    serverId: string
  ): void {
    if (
      this.supervisors.get(sessionId) !== supervisor ||
      supervisor.currentServer?.id !== serverId ||
      this.sessionExitDrains.has(sessionId) ||
      this.sessionQuarantinePromises.has(sessionId) ||
      this.sessionClosePromises.has(sessionId) ||
      this.sessionRuntimeFences.has(sessionId)
    ) {
      return;
    }

    const fence = new Error(
      'OpenCode session runtime loss is draining accepted provider events.'
    );
    this.sessionRuntimeFences.set(sessionId, fence);
    this.cancelSessionIdleEviction(sessionId);
    const binding = this.eventStreams.get(sessionId);
    const stream = binding?.stream;
    stream?.stop();

    const operation = (async () => {
      let completed = false;
      try {
        await this.revokeDesignToolGrant(sessionId).catch(() => undefined);
        await stream?.settled;
        if (this.eventStreams.get(sessionId) === binding) {
          this.eventStreams.delete(sessionId);
        }
        if (this.supervisors.get(sessionId) === supervisor) {
          this.supervisors.delete(sessionId);
        }
        await this.releaseDesignToolRegistrationSafely(sessionId);
        await this.enqueueSessionOperation(sessionId, async () => {
          await this.handleRuntimeLoss(
            serverId,
            'OpenCode session runtime exited unexpectedly.',
            sessionId
          );
          if (await this.taskRuntime.getAgentSession(sessionId)) {
            this.scheduleSessionRecovery(sessionId);
          }
        });
        completed = true;
      } catch (cause) {
        await this.recordProtocolIncident(sessionId, cause).catch(() => undefined);
        throw cause;
      } finally {
        if (completed && this.sessionRuntimeFences.get(sessionId) === fence) {
          this.sessionRuntimeFences.delete(sessionId);
        }
      }
    })();
    const tracked = operation.finally(() => {
      if (this.sessionExitDrains.get(sessionId) === tracked) {
        this.sessionExitDrains.delete(sessionId);
      }
    });
    this.sessionExitDrains.set(sessionId, tracked);
    void tracked.catch(() => undefined);
  }

  /**
   * OpenCode servers are session-scoped. Unsafe provider state invalidates
   * only that session's process, but it must be stopped before the session can
   * be reused so late SSE events cannot cross a run boundary.
   */
  private quarantineSessionRuntime(
    sessionId: string,
    operation: string,
    detail: string,
    drainAcceptedEvents = false,
    runtimeRunToSettleAfterShutdownId?: string
  ): Promise<void> {
    const exitDrain = this.sessionExitDrains.get(sessionId);
    if (exitDrain) return exitDrain;
    const existing = this.sessionQuarantinePromises.get(sessionId);
    if (existing) return existing;
    let quarantine: Promise<void>;
    if (drainAcceptedEvents) {
      const fence = new Error(
        `OpenCode session runtime is draining accepted events after ${operation}.`
      );
      this.sessionRuntimeFences.set(sessionId, fence);
      const stream = this.eventStreams.get(sessionId)?.stream;
      stream?.stop();
      quarantine = (stream?.settled ?? Promise.resolve()).then(() =>
        this.performSessionQuarantine(
          sessionId,
          operation,
          detail,
          runtimeRunToSettleAfterShutdownId
        )
      );
    } else {
      quarantine = this.performSessionQuarantine(
        sessionId,
        operation,
        detail,
        runtimeRunToSettleAfterShutdownId
      );
    }
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

  private async synchronizeSessionPermissionPolicy(
    session: AgentSessionRecord,
    client: OpenCodeClientTransport,
    settings: AgentExecutionSettings,
    operation: string
  ): Promise<OpenCodeSession> {
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) {
      throw new Error('Cannot attest an unmaterialized OpenCode session permission policy.');
    }
    return this.synchronizeNativePermissionPolicy({
      sessionId: session.id,
      providerSessionId,
      directory: session.worktreePath,
      client,
      desired: openCodePermissionRules(settings),
      operation
    });
  }

  private async synchronizeNativePermissionPolicy(input: {
    sessionId: string;
    providerSessionId: string;
    directory: string;
    client: OpenCodeClientTransport;
    desired: ReturnType<typeof openCodePermissionRules>;
    operation: string;
  }): Promise<OpenCodeSession> {
    const deadlineAt = Date.now() + positiveTimeout(this.options.requestTimeoutMs, 30_000);
    const readSession = async (): Promise<OpenCodeSession> => {
      const providerSession = parseOpenCodeSession(
        (
          await input.client.get<unknown>(sessionPath(input.providerSessionId), {
            deadlineAt
          })
        ).data
      );
      if (
        providerSession.id !== input.providerSessionId ||
        !this.isSafeOperationalIdentifier(providerSession.id)
      ) {
        throw new Error(
          'OpenCode returned a different or unsafe session identity during permission attestation.'
        );
      }
      await assertSessionDirectory(providerSession, input.directory);
      return providerSession;
    };

    try {
      let providerSession = await readSession();
      if (!openCodePermissionRulesEndWith(providerSession.permission, input.desired)) {
        try {
          await input.client.patch<unknown>(
            sessionPath(input.providerSessionId),
            { permission: input.desired },
            { deadlineAt }
          );
        } catch (cause) {
          throw mapOpenCodeMutationError('session/update-permission', cause);
        }
        providerSession = await readSession();
      }
      if (!openCodePermissionRulesEndWith(providerSession.permission, input.desired)) {
        throw new Error(
          'OpenCode did not attest the requested permission policy after synchronization.'
        );
      }
      return providerSession;
    } catch (cause) {
      const diagnostic = this.redactProviderText(errorMessage(cause));
      try {
        await this.quarantineSessionRuntime(
          input.sessionId,
          input.operation,
          `The OpenCode permission policy could not be attested: ${diagnostic}`
        );
      } catch (quarantineCause) {
        throw new Error(
          `${diagnostic} Task Monki fenced the session from reuse, but could not confirm process quarantine: ${this.redactProviderText(errorMessage(quarantineCause))}`,
          { cause }
        );
      }
      throw cause;
    }
  }

  private assertRuntimeExecutionContext(input: StartAgentRuntimeTurn): void {
    const context = input.executionContext;
    assertReadOnlyExecutionContext(context);
    const expectedHash = openCodeReadOnlyProfileHash(
      context.primaryCwd,
      context.readRoots,
      context.modelSettings
    );
    if (
      context.permissionProfileHash !== expectedHash ||
      context.managedAttachments.length > 0 ||
      context.readRoots.length !== 1 ||
      context.readRoots[0]?.canonicalPath !== context.primaryCwd ||
      context.modelSettings.runtimeId !== this.descriptor.id ||
      context.modelSettings.sandbox !== 'DANGER_FULL_ACCESS' ||
      context.modelSettings.approvalPolicy !== 'NEVER' ||
      context.modelSettings.networkAccess !== true ||
      context.externalTools.network !== true ||
      context.externalTools.webSearch !== 'disabled' ||
      context.externalTools.mcpServers ||
      context.externalTools.apps ||
      context.externalTools.dynamicTools ||
      !isDeepStrictEqual(input.session.executionContext, context) ||
      !isDeepStrictEqual(input.session.owner, input.run.owner)
    ) {
      throw new Error(
        'OpenCode read-only execution does not match its attested provider-native permission policy.'
      );
    }
  }

  private async synchronizeRuntimeSessionPermissionPolicy(
    session: AgentRuntimeSessionRecord,
    providerSession: OpenCodeSession,
    client: OpenCodeClientTransport
  ): Promise<OpenCodeSession> {
    return this.synchronizeNativePermissionPolicy({
      sessionId: session.id,
      providerSessionId: providerSession.id,
      directory: session.executionContext.primaryCwd,
      client,
      desired: openCodeReadOnlyPermissionRules(),
      operation: 'runtime/session-permission'
    });
  }

  private async updateRuntimeRun(
    runId: string,
    update: Parameters<AgentRuntimeStore['updateRun']>[2],
    operationId: string
  ): Promise<AgentRuntimeRunRecord> {
    let current = await this.providerRuntime.getRun(runId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!current) throw new Error(`Agent runtime run not found: ${runId}`);
      try {
        return await this.providerRuntime.updateRun(
          current.id,
          current.recordRevision,
          update,
          `${operationId}:${attempt}`
        );
      } catch (cause) {
        const latest = await this.providerRuntime.getRun(runId);
        if (!latest || latest.recordRevision === current.recordRevision || attempt === 3) {
          throw cause;
        }
        current = latest;
      }
    }
    throw new Error(`Agent runtime run update failed: ${runId}`);
  }


  private async persistPermissionAttestation(
    session: AgentSessionRecord,
    providerSession: OpenCodeSession,
    settings: AgentExecutionSettings,
    operation: string,
    update: Partial<Pick<AgentSessionRecord, 'status' | 'materialized'>> = {}
  ): Promise<AgentSessionRecord> {
    try {
      return await this.taskRuntime.updateAgentSession(session.id, {
        ...update,
        requestedSettings: settings,
        observedSettings: this.safeObservedSettings(
          settingsFromSession(providerSession, settings)
        )
      }, runtimeOperationId('session/permission-attestation', session.id, providerSession.id, operation));
    } catch (cause) {
      const diagnostic = this.redactProviderText(errorMessage(cause));
      await this.quarantineSessionRuntime(
        session.id,
        operation,
        `Task Monki could not persist the attested OpenCode permission policy: ${diagnostic}`
      );
      throw new Error(diagnostic, { cause });
    }
  }

  private async performSessionQuarantine(
    sessionId: string,
    operation: string,
    detail: string,
    runtimeRunToSettleAfterShutdownId?: string
  ): Promise<void> {
    const fence = new Error(
      `OpenCode session runtime is quarantined after ${operation}.`
    );
    this.sessionRuntimeFences.set(sessionId, fence);
    this.clearSessionInterruptDeadlines(sessionId);
    this.cancelSessionIdleEviction(sessionId);
    const recoveryTimer = this.recoveryTimers.get(sessionId);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    this.recoveryTimers.delete(sessionId);
    const binding = this.eventStreams.get(sessionId);
    const stream = binding?.stream;
    stream?.stop();
    const supervisor = this.supervisors.get(sessionId);
    const serverId = supervisor?.currentServer?.id;
    // The provider process may outlive an unconfirmed shutdown. Remove its
    // generation-bound bridge credentials before waiting on that shutdown.
    await this.releaseDesignToolRegistrationSafely(sessionId);
    let shutdownFailure: unknown;
    try {
      await supervisor?.shutdown();
      if (this.supervisors.get(sessionId) === supervisor) {
        this.supervisors.delete(sessionId);
      }
      if (this.eventStreams.get(sessionId) === binding) {
        this.eventStreams.delete(sessionId);
      }
    } catch (cause) {
      shutdownFailure = cause;
    }
    await this.releaseDesignToolRegistrationSafely(sessionId);
    this.clearAssistantMessageParents(sessionId);
    if (shutdownFailure) {
      // Keep the run active behind the session fence. A recovery event is a
      // repository-verification boundary, so it must not be emitted while the
      // old provider process may still be able to change the repository.
      throw new Error(
        `OpenCode session process quarantine was incomplete: ${errorMessage(shutdownFailure)}`,
        { cause: shutdownFailure }
      );
    }
    const reason = `Task Monki quarantined the OpenCode session process after ${operation}. ${detail}`;
    if (serverId) {
      await this.handleRuntimeLoss(
        serverId,
        reason,
        sessionId,
        runtimeRunToSettleAfterShutdownId
      );
    }
    const session = await this.taskRuntime.getAgentSession(sessionId).catch(() => undefined);
    if (session && session.status !== 'NOT_LOADED') {
      await this.taskRuntime.updateAgentSession(
        sessionId,
        { status: 'NOT_LOADED' },
        runtimeOperationId('session/quarantine', sessionId, serverId, operation)
      );
    } else if (!session) {
      const runtimeSession = await this.providerRuntime.getSession(sessionId);
      if (runtimeSession && runtimeSession.status !== 'NOT_LOADED') {
        await this.providerRuntime.updateSession(
          runtimeSession.id,
          runtimeSession.recordRevision,
          { status: 'NOT_LOADED' },
          runtimeOperationId('runtime/session-quarantine', sessionId, serverId, operation)
        );
      }
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
    const run = await this.taskRuntime.getRunByProviderTurnId(
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
    serverId: string,
    allowProviderRead = true
  ): Promise<RunRecord | undefined> {
    const direct = await this.runForProviderMessage(session, providerMessageId, serverId);
    if (direct) return direct;
    let parentId = this.assistantMessageParents.get(session.id)?.get(providerMessageId);
    if (!parentId && allowProviderRead && session.providerSessionId) {
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

  private async recordAssistantUsage(
    run: RunRecord,
    session: AgentSessionRecord,
    info: OpenCodeMessageInfo,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const usage = mapOpenCodeUsage(info);
    const tracked = this.assistantMessageUsage.get(session.id)?.get(info.id);
    if (tracked?.runId === run.id && isDeepStrictEqual(tracked.usage, usage)) return;
    const nextTracked = {
      runId: run.id,
      usage,
      createdAt: info.time?.created ?? 0
    };
    const currentTotal = this.assistantUsageTotals.get(run.id) ??
      latestUsageForRun(await this.taskRuntime.snapshot(), run.id)?.total ??
      emptyUsage();
    const total = replaceUsageInTotal(
      currentTotal,
      tracked?.runId === run.id ? tracked.usage : emptyUsage(),
      usage
    );
    const runUsage = [
      ...(this.assistantMessageUsage.get(session.id)?.entries() ?? [])
    ]
      .map(([messageId, value]) => messageId === info.id ? nextTracked : value)
      .filter((value) => value.runId === run.id);
    if (!tracked) runUsage.push(nextTracked);
    const last = runUsage.sort(
      (left, right) => left.createdAt - right.createdAt
    ).at(-1)?.usage ?? usage;
    await this.taskRuntime.recordAgentUsageSnapshot({
      taskId: run.taskId,
      iterationId: run.iterationId,
      sessionId: session.id,
      runId: run.id,
      runtimeId: this.descriptor.id,
      total,
      last,
      rawMessage: raw
    }, protocolOperationId('usage/assistant', raw, run.id, info.id));
    this.rememberAssistantUsageTotal(run.id, total);
    this.rememberAssistantUsage(session.id, info.id, nextTracked);
  }

  private rememberAssistantUsage(
    sessionId: string,
    assistantMessageId: string,
    tracked: TrackedAssistantUsage
  ): void {
    const messages =
      this.assistantMessageUsage.get(sessionId) ?? new Map<string, TrackedAssistantUsage>();
    const evictedMessageIds = this.assistantUsageEvictedMessageIds.get(sessionId);
    evictedMessageIds?.delete(assistantMessageId);
    if (evictedMessageIds?.size === 0) {
      this.assistantUsageEvictedMessageIds.delete(sessionId);
    }
    messages.delete(assistantMessageId);
    messages.set(assistantMessageId, tracked);
    while (messages.size > MAX_TRACKED_ASSISTANT_MESSAGES_PER_SESSION) {
      const oldest = messages.keys().next().value as string | undefined;
      if (!oldest) break;
      messages.delete(oldest);
      const evicted = this.assistantUsageEvictedMessageIds.get(sessionId) ?? new Set<string>();
      evicted.delete(oldest);
      evicted.add(oldest);
      while (evicted.size > MAX_TRACKED_ASSISTANT_USAGE_EVICTIONS_PER_SESSION) {
        const oldestEviction = evicted.values().next().value as string | undefined;
        if (!oldestEviction) break;
        evicted.delete(oldestEviction);
      }
      this.assistantUsageEvictedMessageIds.set(sessionId, evicted);
    }
    this.assistantMessageUsage.set(sessionId, messages);
  }

  private rememberAssistantUsageTotal(
    runId: string,
    total: AgentTokenUsageBreakdown
  ): void {
    this.assistantUsageTotals.delete(runId);
    this.assistantUsageTotals.set(runId, total);
    while (this.assistantUsageTotals.size > MAX_TRACKED_ASSISTANT_USAGE_RUNS) {
      const oldest = this.assistantUsageTotals.keys().next().value as string | undefined;
      if (!oldest) break;
      this.assistantUsageTotals.delete(oldest);
    }
  }

  private replaceAssistantUsageForRun(
    sessionId: string,
    runId: string,
    assistants: readonly OpenCodeMessage[]
  ): void {
    const tracked = this.assistantMessageUsage.get(sessionId);
    for (const [messageId, message] of tracked ?? []) {
      if (message.runId === runId) tracked?.delete(messageId);
    }
    for (const message of assistants) {
      this.rememberAssistantUsage(sessionId, message.info.id, {
        runId,
        usage: mapOpenCodeUsage(message.info),
        createdAt: message.info.time?.created ?? 0
      });
    }
  }

  private clearAssistantMessageParents(sessionId: string): void {
    this.assistantMessageParents.delete(sessionId);
    for (const message of this.assistantMessageUsage.get(sessionId)?.values() ?? []) {
      this.assistantUsageTotals.delete(message.runId);
    }
    this.assistantMessageUsage.delete(sessionId);
    this.assistantUsageEvictedMessageIds.delete(sessionId);
  }

  private createSupervisor(
    runtime: ResolvedOpenCodeRuntime,
    cwd: string,
    pure = false
  ): OpenCodeSessionSupervisor {
    const supervisorOptions: OpenCodeServerSupervisorOptions = {
      runtime,
      cwd,
      environment: this.options.environment,
      requestTimeoutMs: this.options.requestTimeoutMs,
      startupTimeoutMs: this.options.startupTimeoutMs,
      pure
    };
    return this.options.supervisorFactory
      ? this.options.supervisorFactory(this.providerRuntime, supervisorOptions)
      : new OpenCodeServerSupervisor(this.providerRuntime, supervisorOptions);
  }

  private async bindEventStream(
    session: OpenCodeSessionRuntimeOwner,
    client: OpenCodeClientTransport,
    serverId: string
  ): Promise<void> {
    if (this.eventStreams.has(session.id)) return;
    const supervisor = this.supervisors.get(session.id);
    if (!supervisor) return;
    const binding: OpenCodeEventStreamBinding = {
      supervisor,
      client,
      serverId
    };
    this.eventStreams.set(session.id, binding);
    try {
      binding.stream = client.startEventStream({
        onEvent: async (value, raw) => {
          if (!this.ownsEventStreamBinding(session.id, binding)) return;
          await this.acceptedInboundGeneration.run(
            { sessionId: session.id, serverId },
            () => this.enqueueInbound(
              session.id,
              () => this.handleEvent(value, raw, serverId),
              serverId
            )
          );
        },
        onDisconnect: async (error) => {
          if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
          await this.enqueueInbound(session.id, async () => {
            const reason = this.redactProviderText(error.message);
            await supervisor.markDegraded(reason);
            if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
            const run = await this.getCurrentRunForSession(session.id);
            if (run?.serverInstanceId === serverId) {
              await this.recordRunActivity(run, 'runtime/sse/disconnected', { reason });
            }
          }, serverId);
        },
        onReconnect: async () => {
          if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
          await supervisor.markRunning();
          if (!this.isCurrentSessionRuntime(session.id, supervisor, client, serverId)) return;
          await this.scheduleInboundResync(session.id, serverId);
        }
      });
    } catch (cause) {
      if (this.eventStreams.get(session.id) === binding) {
        this.eventStreams.delete(session.id);
      }
      throw cause;
    }
    await supervisor?.markRunning();
  }

  private ownsEventStreamBinding(
    sessionId: string,
    binding: OpenCodeEventStreamBinding
  ): boolean {
    return this.eventStreams.get(sessionId) === binding &&
      this.supervisors.get(sessionId) === binding.supervisor;
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
    const accepted = this.acceptedInboundGeneration.getStore();
    if (accepted?.sessionId === sessionId && accepted.serverId === serverId) {
      const binding = this.eventStreams.get(sessionId);
      return binding?.serverId === serverId &&
        this.ownsEventStreamBinding(sessionId, binding);
    }
    return !this.shuttingDown &&
      !this.sessionRuntimeFences.has(sessionId) &&
      this.supervisors.get(sessionId)?.currentServer?.id === serverId;
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
      if (
        serverId &&
        (this.sessionRuntimeFences.has(sessionId) ||
          !this.isCurrentSessionServerGeneration(sessionId, serverId))
      ) {
        return;
      }
      const runtimeSession = await this.providerRuntime.getSession(sessionId);
      if (runtimeSession) {
        const run = await this.providerRuntime.getActiveRunForSession(sessionId);
        if (run && isOpenCodeReadOnlyRuntimeSession(runtimeSession)) {
          const reason = this.redactProviderText(errorMessage(cause));
          const observedAt = new Date().toISOString();
          const updated = await this.updateRuntimeRun(
            run.id,
            {
              status: 'RECOVERY_REQUIRED',
              recoveryState: 'REQUIRES_USER_ACTION',
              terminalReason: reason,
              lastEventAt: observedAt
            },
            runtimeOperationId('runtime/inbound-failed', run.id, reason)
          );
          this.emitRuntimeTurnEvent({
            type: 'RECOVERY_REQUIRED',
            runId: updated.id,
            providerTurnId: updated.providerTurnId,
            reason,
            observedAt
          });
          return;
        }
      }
      await this.recordProtocolIncident(sessionId, cause).catch(() => undefined);
      if (serverId) await this.scheduleInboundResync(sessionId, serverId);
    });
  }

  private scheduleInboundResync(sessionId: string, serverId: string): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    const key = inboundGenerationKey(sessionId, serverId);
    const existing = this.inboundResyncs.get(key);
    if (existing) return existing;
    const recovery = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      this.enqueueSessionOperation(sessionId, async () => {
        if (!this.isCurrentSessionServerGeneration(sessionId, serverId)) return;
        try {
          await this.recoverInboundGenerationOwned(sessionId, serverId);
        } catch (cause) {
          if (!this.isCurrentSessionServerGeneration(sessionId, serverId)) return;
          const diagnostic = openCodeErrorDiagnostic(cause, this.sensitiveValues);
          const run = await this.getCurrentRunForSession(sessionId).catch(() => undefined);
          await this.quarantineSessionRuntime(
            sessionId,
            'inbound/persistence-resync',
            `OpenCode inbound persistence failed and its read-only recovery snapshot also failed: ${diagnostic}`
          );
          const current = run ? await this.taskRuntime.getRun(run.id) : undefined;
          if (current?.status === 'RECOVERY_REQUIRED') {
            await this.recordReconciliation(
              current,
              'RECOVERY_REQUIRED',
              'REQUIRES_USER_ACTION',
              false
            );
          }
          throw new Error(
            `OpenCode inbound persistence recovery failed; the affected session generation was quarantined: ${diagnostic}`,
            { cause }
          );
        }
      })
    );
    const tracked = recovery.finally(() => {
      if (this.inboundResyncs.get(key) === tracked) this.inboundResyncs.delete(key);
    });
    this.inboundResyncs.set(key, tracked);
    return tracked;
  }

  private async recoverInboundGenerationOwned(
    sessionId: string,
    serverId: string
  ): Promise<void> {
    if (!this.isCurrentSessionServerGeneration(sessionId, serverId)) return;
    const run = await this.getCurrentRunForSession(sessionId);
    if (run) {
      const result = await this.reconcileRunOwned(run, serverId);
      if (!this.isCurrentSessionServerGeneration(sessionId, serverId)) return;
      if (result === 'recovery-required') {
        throw new Error(
          'OpenCode could not restore the active run from its authoritative provider snapshot.'
        );
      }
      return;
    }
    const session = await this.requireSession(sessionId);
    await this.readSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
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
    if (await this.handleRuntimeTurnEvent(event, serverId)) return;
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
        await this.handlePartUpdated(event, raw, serverId);
        return;
      case 'message.part.delta':
        await this.handlePartDelta(event, raw, serverId);
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
          ? await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, sessionId)
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

  private async handleRuntimeTurnEvent(
    event: OpenCodeEvent,
    serverId: string
  ): Promise<boolean> {
    const providerSessionId = openCodeEventSessionId(event);
    if (!providerSessionId) return false;
    const session = await this.providerRuntime.getSessionByProviderId(
      providerSessionId,
      this.descriptor.id
    );
    if (
      !session ||
      !isOpenCodeReadOnlyRuntimeSession(session) ||
      !this.isCurrentSessionServerGeneration(session.id, serverId)
    ) {
      return false;
    }
    const run = await this.providerRuntime.getActiveRunForSession(session.id);
    if (
      !run || run.serverInstanceId !== serverId
    ) {
      return false;
    }
    switch (event.type) {
      case 'server.connected':
        return true;
      case 'session.status': {
        const status = mapOpenCodeSessionStatus(event.properties.status);
        if (status === 'IDLE') {
          await this.finalizeRuntimeFromSnapshot(run, session, serverId);
        }
        return true;
      }
      case 'session.idle':
        await this.finalizeRuntimeFromSnapshot(run, session, serverId);
        return true;
      case 'message.updated': {
        const info = asRecord(event.properties.info) as
          | (OpenCodeMessageInfo & Record<string, unknown>)
          | undefined;
        if (!info || typeof info.id !== 'string') return true;
        if (
          info.role === 'assistant' &&
          typeof info.parentID === 'string' &&
          info.parentID === run.providerTurnId
        ) {
          this.rememberAssistantParent(session.id, info.id, info.parentID);
        }
        return true;
      }
      case 'message.part.delta': {
        const delta = parseOpenCodePartDelta(event.properties);
        const parent = this.assistantMessageParents
          .get(session.id)
          ?.get(delta.messageID);
        if (
          parent === run.providerTurnId &&
          delta.field === 'text' &&
          delta.delta
        ) {
          this.emitRuntimeTurnEvent({
            type: 'DELTA',
            runId: run.id,
            providerTurnId: run.providerTurnId!,
            text: this.redactProviderText(
              Buffer.from(delta.delta).subarray(0, MAX_RUNTIME_DELTA_BYTES).toString()
            ),
            observedAt: new Date().toISOString()
          });
        }
        return true;
      }
      case 'permission.updated':
      case 'permission.asked':
      case 'permission.v2.asked': {
        const permission = event.properties as unknown as OpenCodePermissionRequest;
        if (typeof permission.id !== 'string') return true;
        await this.rejectRuntimeInteraction({
          run,
          session,
          serverId,
          endpoint: `/permission/${encodeURIComponent(permission.id)}/reply`,
          body: { reply: 'reject' },
          reason:
            'OpenCode requested permission during a provider-native read-only turn. The request was denied and the turn failed.'
        });
        return true;
      }
      case 'question.asked':
      case 'question.v2.asked': {
        const question = event.properties as unknown as OpenCodeQuestionRequest;
        if (typeof question.id !== 'string') return true;
        await this.rejectRuntimeInteraction({
          run,
          session,
          serverId,
          endpoint: `/question/${encodeURIComponent(question.id)}/reply`,
          body: { answers: question.questions.map(() => []) },
          reason:
            'OpenCode asked for user input during a provider-native read-only turn. The request was denied and the turn failed.'
        });
        return true;
      }
      case 'session.error': {
        const diagnostic = openCodeErrorDiagnostic(
          event.properties.error ?? 'OpenCode read-only session error.',
          this.sensitiveValues
        );
        await this.finalizeRuntimeRun(run, session, 'failed', diagnostic, '');
        return true;
      }
      default:
        // Read-only workflows intentionally retain only bounded output and
        // terminal evidence. Task-specific items, plans, and subagents remain
        // owned by the normal Task path.
        return true;
    }
  }

  private async finalizeRuntimeFromSnapshot(
    run: AgentRuntimeRunRecord,
    session: AgentRuntimeSessionRecord,
    serverId: string
  ): Promise<void> {
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    const client = this.supervisors.get(session.id)?.currentClient;
    if (!client || !session.providerSessionId || !run.providerTurnId) return;
    const result = await client.get<unknown>(
      `${sessionPath(session.providerSessionId)}/message`
    );
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    const messages = parseOpenCodeMessages(result.data);
    const user = messages.find(
      (message) =>
        message.info.role === 'user' && message.info.id === run.providerTurnId
    );
    if (!user) {
      await this.finalizeRuntimeRun(
        run,
        session,
        'failed',
        'OpenCode became idle without retaining the submitted read-only prompt.',
        ''
      );
      return;
    }
    const assistant = latestAssistantFor(messages, user.info.id);
    if (!assistant || !isTerminalAssistantMessage(assistant)) {
      await this.finalizeRuntimeRun(
        run,
        session,
        run.status === 'INTERRUPTING' ? 'interrupted' : 'failed',
        run.status === 'INTERRUPTING'
          ? undefined
          : 'OpenCode became idle without a terminal read-only response.',
        ''
      );
      return;
    }
    const message = assistant.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    const diagnostic = assistant.info.error
      ? openCodeErrorDiagnostic(assistant.info.error, this.sensitiveValues)
      : undefined;
    await this.finalizeRuntimeRun(
      run,
      session,
      run.status === 'INTERRUPTING'
        ? 'interrupted'
        : diagnostic
          ? 'failed'
          : message
            ? 'completed'
            : 'failed',
      diagnostic ?? (message ? undefined : 'OpenCode returned no final text.'),
      message
    );
  }

  private async rejectRuntimeInteraction(input: {
    run: AgentRuntimeRunRecord;
    session: AgentRuntimeSessionRecord;
    serverId: string;
    endpoint: string;
    body: unknown;
    reason: string;
  }): Promise<void> {
    const client = this.supervisors.get(input.session.id)?.currentClient;
    const providerSessionId = input.session.providerSessionId;
    if (!this.isCurrentSessionServerGeneration(input.session.id, input.serverId)) {
      return;
    }
    if (!client || !providerSessionId) {
      await this.quarantineSessionRuntime(
        input.session.id,
        'runtime/read-only-policy-violation',
        `${input.reason} Task Monki could not reach the owning OpenCode session to stop it.`
      );
      return;
    }
    let rejectionError: unknown;
    try {
      await client.post<boolean>(input.endpoint, input.body);
    } catch (cause) {
      rejectionError = cause;
    }
    const reason = rejectionError
      ? `${input.reason} OpenCode did not confirm the denial: ${this.redactProviderText(errorMessage(rejectionError))}`
      : input.reason;
    const deadlineAt = Date.now() + this.interruptReconciliationWindowMs();
    try {
      await client.post<boolean>(
        `${sessionPath(providerSessionId)}/abort`,
        undefined,
        { deadlineAt }
      );
      if (!this.isCurrentSessionServerGeneration(input.session.id, input.serverId)) return;
      const status = await this.readProviderInterruptStatus(
        client,
        providerSessionId,
        deadlineAt
      );
      if (!this.isCurrentSessionServerGeneration(input.session.id, input.serverId)) return;
      if (status !== 'IDLE') {
        throw new Error(
          `OpenCode did not confirm provider settlement after abort; session status was ${status.toLowerCase()}.`
        );
      }
    } catch (cause) {
      if (!this.isCurrentSessionServerGeneration(input.session.id, input.serverId)) return;
      await this.quarantineSessionRuntime(
        input.session.id,
        'runtime/read-only-policy-violation',
        `${reason} Task Monki could not confirm provider settlement after abort: ${this.redactProviderText(errorMessage(cause))}`
      );
      return;
    }
    await this.finalizeRuntimeRun(input.run, input.session, 'failed', reason, '');
  }

  private async finalizeRuntimeRun(
    run: AgentRuntimeRunRecord,
    session: AgentRuntimeSessionRecord,
    status: 'completed' | 'interrupted' | 'failed',
    error: string | undefined,
    finalMessage: string,
    options: { sessionStopped?: boolean } = {}
  ): Promise<void> {
    const current = await this.providerRuntime.getRun(run.id);
    if (!current || TERMINAL_RUN_STATES.includes(current.status)) return;
    const safeMessage = this.redactProviderText(finalMessage);
    if (safeMessage) {
      const artifact = await this.providerRuntime.getArtifact(current.outputArtifactId);
      if (artifact && artifact.contentSha256 !== hashText(safeMessage)) {
        await this.providerRuntime.updateArtifact({
          artifactId: artifact.id,
          expectedRevision: artifact.recordRevision,
          clientOperationId: runtimeOperationId(
            'runtime/output-final',
            current.id,
            current.providerTurnId,
            safeMessage
          ),
          content: safeMessage
        });
      }
    }
    const completedAt = new Date().toISOString();
    const terminalStatus =
      status === 'completed'
        ? 'COMPLETED'
        : status === 'interrupted'
          ? 'INTERRUPTED'
          : 'FAILED';
    const updated = await this.updateRuntimeRun(
      current.id,
      {
        status: terminalStatus,
        delivery: 'TERMINAL',
        ...(current.interruptDelivery ? { interruptDelivery: 'TERMINAL' as const } : {}),
        recoveryState: 'NONE',
        terminalReason: error ? this.redactProviderText(error) : undefined,
        providerTerminalSource: options.sessionStopped
          ? 'OPENCODE_PROCESS_STOP'
          : 'OPENCODE_SESSION_SNAPSHOT',
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      runtimeOperationId('runtime/terminal', current.id, terminalStatus, completedAt)
    );
    const durableSession = await this.providerRuntime.getSession(session.id);
    if (durableSession && !options.sessionStopped) {
      await this.providerRuntime.updateSession(
        durableSession.id,
        durableSession.recordRevision,
        {
          status: status === 'failed' ? 'SYSTEM_ERROR' : 'IDLE',
          materialized: true,
          lastAttachedAt: completedAt
        },
        runtimeOperationId('runtime/session-terminal', durableSession.id, updated.id)
      );
    }
    this.emitRuntimeTurnEvent({
      type: 'TERMINAL',
      runId: updated.id,
      providerTurnId: updated.providerTurnId!,
      status,
      ...(error ? { error: this.redactProviderText(error) } : {}),
      completedAt
    });
    if (!options.sessionStopped) this.scheduleSessionIdleEviction(session.id);
    this.schedulePendingRuntimeReset();
  }

  private emitRuntimeTurnEvent(event: AgentRuntimeTurnEvent): void {
    for (const listener of this.runtimeTurnListeners) listener(event);
  }

  private async handleSessionStatus(event: OpenCodeEvent, serverId: string): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    if (!providerSessionId) return;
    const session = await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, providerSessionId);
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    const status = mapOpenCodeSessionStatus(event.properties.status);
    const run = await this.getCurrentRunForSession(session.id);
    const sessionStatus = await this.sessionStatusWithInteractionAuthority(status, run);
    await this.taskRuntime.updateAgentSession(
      session.id,
      { status: sessionStatus },
      runtimeOperationId('session/status-event', serverId, event.id, session.id, sessionStatus)
    );
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    if (run?.serverInstanceId === serverId) {
      await this.recordRunActivity(run, 'session/status', {
        status: event.properties.status,
        resumeConfirmed:
          status === 'ACTIVE' && sessionStatus === 'ACTIVE'
      });
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
      ? await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
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
    const session = await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, info.sessionID);
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
      const sessionStatus = await this.sessionStatusWithInteractionAuthority('ACTIVE', run);
      const runStatus =
        sessionStatus === 'AWAITING_APPROVAL' || sessionStatus === 'AWAITING_USER_INPUT'
          ? sessionStatus
          : 'RUNNING';
      await this.taskRuntime.updateRun(run.id, {
        observedSettings: observed,
        status: runStatus
      }, protocolOperationId('turn/message-observed', raw, run.id, info.id));
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      await this.taskRuntime.updateAgentSession(session.id, {
        observedSettings: observed,
        status: sessionStatus
      }, protocolOperationId('session/message-observed', raw, session.id, info.id));
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
      const cachedUsage = this.assistantMessageUsage.get(session.id);
      const cacheHasRun = [...(cachedUsage?.values() ?? [])].some(
        (tracked) => tracked.runId === run.id
      );
      const exactUsageMayHaveBeenEvicted =
        !cachedUsage?.has(info.id) &&
        Boolean(this.assistantUsageEvictedMessageIds.get(session.id)?.has(info.id));
      if (!cacheHasRun || exactUsageMayHaveBeenEvicted) {
        const latestUsage = latestUsageForRun(await this.taskRuntime.snapshot(), run.id);
        if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
        if (latestUsage) {
          const client = this.supervisors.get(session.id)?.currentClient;
          if (!client || !session.providerSessionId) return;
          const messagesResult = await client.get<unknown>(
            `${sessionPath(session.providerSessionId)}/message`
          );
          if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
          const messages = parseOpenCodeMessages(messagesResult.data);
          const userMessage = messages.find(
            (message) =>
              message.info.role === 'user' && message.info.id === info.parentID
          );
          const assistantMessage = messages.find(
            (message) =>
              message.info.role === 'assistant' &&
              message.info.id === info.id &&
              message.info.parentID === info.parentID
          );
          if (!userMessage || !assistantMessage) {
            throw new Error(
              `OpenCode terminal message ${info.id} was absent from its authoritative session history.`
            );
          }
          await this.materializeRecoveredMessages(
            run,
            session,
            messages,
            userMessage,
            messagesResult.raw,
            serverId
          );
          return;
        }
      }
      await this.recordAssistantUsage(run, session, info, raw);
    }
  }

  private async handlePartUpdated(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const part = asRecord(event.properties.part) as unknown as OpenCodePart | undefined;
    if (!part || typeof part.id !== 'string' || typeof part.sessionID !== 'string') return;
    const session = await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, part.sessionID);
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
    await this.materializePart(run, session, part, raw, isUserPart);
  }

  private async handlePartDelta(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const delta = parseOpenCodePartDelta(event.properties);
    const session = await this.taskRuntime.getAgentSessionByProviderId(
      this.descriptor.id,
      delta.sessionID
    );
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    let run = await this.runForProviderMessage(session, delta.messageID, serverId);
    const isUserPart = Boolean(run);
    if (!run) {
      const parentId = this.assistantMessageParents.get(session.id)?.get(delta.messageID);
      run = parentId
        ? await this.runForProviderMessage(session, parentId, serverId)
        : undefined;
    }
    if (!run || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    const previous =
      this.streamBuffers.get(run.id)?.parts.get(delta.partID)?.part ??
      asRecord((await this.taskRuntime.getAgentItemByProviderId(run.id, delta.partID))?.payload);
    if (
      !previous ||
      previous.id !== delta.partID ||
      previous.sessionID !== delta.sessionID ||
      previous.messageID !== delta.messageID ||
      (previous.type !== 'text' && previous.type !== 'reasoning') ||
      delta.field !== 'text' ||
      !Object.prototype.hasOwnProperty.call(previous, delta.field) ||
      typeof previous[delta.field] !== 'string'
    ) {
      throw new Error(
        `OpenCode emitted a delta for unknown part field ${delta.partID}.${delta.field}.`
      );
    }
    const part = {
      ...previous,
      [delta.field]: previous[delta.field] + delta.delta
    } as OpenCodePart;
    await this.materializePart(
      run,
      session,
      part,
      raw,
      isUserPart,
      delta.field === 'text' ? delta.delta : undefined
    );
  }

  private async materializePart(
    run: RunRecord,
    session: AgentSessionRecord,
    part: OpenCodePart,
    raw: AgentProtocolMessageReference,
    isUserPart: boolean,
    explicitOutputDelta?: string
  ): Promise<void> {
    const status = mapOpenCodePartStatus(part);
    const type = isUserPart ? 'USER_MESSAGE' : mapOpenCodePartType(part);
    if (!isUserPart && (part.type === 'text' || part.type === 'reasoning')) {
      await this.bufferStreamingPart(
        run,
        session,
        part,
        raw,
        status,
        mapOpenCodePartType(part),
        explicitOutputDelta
      );
      return;
    }
    await this.taskRuntime.upsertAgentItem({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      providerItemId: part.id,
      type,
      status,
      payload: this.boundedItemPayload(part),
      rawMessage: raw,
      providerStartedAt: providerTimestamp(part.state?.time?.start),
      providerCompletedAt: providerTimestamp(part.state?.time?.end)
    }, protocolOperationId('item/upsert', raw, run.id, part.id));
    const interactionPending =
      typeof part.callID === 'string' &&
      (await this.taskRuntime.snapshot()).interactionRequests.some(
        (interaction) =>
          interaction.runId === run.id &&
          interaction.sessionId === session.id &&
          interaction.serverInstanceId === run.serverInstanceId &&
          interaction.providerItemId === part.callID &&
          (interaction.status === 'PENDING' ||
            interaction.status === 'RESPONDING')
      );
    await this.recordRunActivity(run, `item/${part.type}/${status.toLowerCase()}`, {
      providerItemId: part.id,
      tool: part.tool,
      ...(interactionPending ? { interactionPending: true } : {})
    });
  }

  private async bufferStreamingPart(
    run: RunRecord,
    session: AgentSessionRecord,
    part: OpenCodePart,
    raw: AgentProtocolMessageReference,
    status: ReturnType<typeof mapOpenCodePartStatus>,
    type: ReturnType<typeof mapOpenCodePartType>,
    explicitOutputDelta?: string
  ): Promise<void> {
    const buffer = this.streamBuffers.get(run.id) ?? {
      runId: run.id,
      sessionId: session.id,
      parts: new Map<string, BufferedOpenCodeStreamPart>(),
      output: [],
      outputBytes: 0,
      failureCount: 0
    };
    this.streamBuffers.set(run.id, buffer);

    const previousBuffered = buffer.parts.get(part.id);
    const previousPayload = previousBuffered?.part ??
      (await this.taskRuntime.getAgentItemByProviderId(run.id, part.id))?.payload;
    const delta = explicitOutputDelta ?? outputDelta(previousPayload, part);

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
      this.bufferStreamOutput(buffer, part.type, delta, raw);
      if (this.bufferedStreamOutputBytes(buffer) > STREAM_OUTPUT_MAX_BUFFER_BYTES) {
        const terminal = streamPartIsTerminal(part, status);
        await this.flushBufferedStreamOutput(run.id, terminal);
        const retained = this.streamBuffers.get(run.id);
        if (
          retained &&
          this.bufferedStreamOutputBytes(retained) > STREAM_OUTPUT_MAX_BUFFER_BYTES
        ) {
          const cause = new Error(
            `OpenCode buffered output for run ${run.id} exceeded ${STREAM_OUTPUT_MAX_BUFFER_BYTES} bytes.`
          );
          this.discardSessionStreamBuffers(session.id);
          this.fenceStreamOutputPersistence(run, cause);
          throw cause;
        }
        if (terminal) await this.materializeBufferedStreamParts(run.id, [part.id]);
        return;
      }
    }

    if (streamPartIsTerminal(part, status)) {
      await this.flushBufferedStreamOutput(run.id, true);
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
      ? await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
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
    await this.taskRuntime.recordAgentPlanRevision({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: session.id,
      runtimeId: this.descriptor.id,
      steps: this.redactProviderValue(steps),
      rawMessage: raw
    }, protocolOperationId('plan/todo', raw, run.id));
    this.emitRunActivity(run, { eventType: 'turn/plan/updated', stepCount: steps.length });
  }

  private async handlePermissionRequest(
    event: OpenCodeEvent,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const permission = event.properties as unknown as OpenCodePermissionRequest;
    if (typeof permission.id !== 'string' || typeof permission.sessionID !== 'string') return;
    const session = await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, permission.sessionID);
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
    const session = await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, question.sessionID);
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
    providerMessageId?: string,
    fromRecoverySnapshot = false
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
      serverId,
      !fromRecoverySnapshot
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
    const allowedActions = policy.allowedActions.filter(
      (action) =>
        action !== 'ACCEPT_FOR_SESSION' &&
        action !== 'GRANT_SESSION' &&
        action !== 'DECLINE_FOR_SESSION'
    );
    const interaction = await this.taskRuntime.createInteractionRequest({
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
      allowedActions,
      policyWarnings: policy.warnings,
      requestRawMessage: raw
    }, protocolOperationId('interaction/create', raw, run.id, providerRequestId));
    this.emitInteractionUpdate(interaction);
    if (mapped.type === 'USER_INPUT' && allowedActions.length === 0) {
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
    const responding = await this.taskRuntime.transitionInteractionRequest(
      interaction.id,
      'PENDING',
      {
        status: 'RESPONDING',
        decision,
        respondedAt: new Date().toISOString()
      },
      runtimeOperationId('interaction/auto-response', interaction.id, interaction.requestedAt)
    );
    this.emitInteractionUpdate(responding);
    try {
      await this.respondToInteraction({ interaction: responding, decision });
    } catch (cause) {
      const latest = await this.taskRuntime.getInteractionRequest(interaction.id);
      if (latest?.status === 'RESPONDING') {
        const reason = errorMessage(cause);
        const stale = await this.taskRuntime.transitionInteractionRequest(
          latest.id,
          'RESPONDING',
          {
            status: 'STALE',
            resolution: {
              error: reason,
              automaticResubmission: false
            },
            resolvedAt: new Date().toISOString()
          },
          runtimeOperationId('interaction/auto-response-failed', latest.id, latest.respondedAt, reason)
        );
        this.emitInteractionUpdate(stale);
        const run = await this.taskRuntime.getRun(interaction.runId);
        if (run) {
          await this.taskRuntime.applyTaskRuntimeEvent(
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
            }),
            runtimeOperationId('event/mutation-ambiguous', run.id, latest.id, reason)
          );
          this.emitRunStateUpdate(run, {
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
    const interaction = await this.taskRuntime.getInteractionRequestByProviderId(serverId, requestId);
    if (
      !interaction ||
      interaction.status !== 'PENDING' ||
      !this.isCurrentSessionServerGeneration(interaction.sessionId, serverId)
    ) {
      return;
    }
    const stale = await this.taskRuntime.transitionInteractionRequest(interaction.id, 'PENDING', {
      status: 'STALE',
      responseRawMessage: raw,
      resolution: { providerResolvedExternally: true, eventType: event.type },
      resolvedAt: new Date().toISOString()
    }, protocolOperationId('interaction/provider-resolved', raw, interaction.id, event.type));
    this.emitInteractionUpdate(stale);
    await this.resumeAfterInteractionResolution(stale);
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
    const parent = await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, child.parentID);
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
    await this.taskRuntime.observeSubagent({
      parentSessionId: parent.id,
      parentRunId: parentRun?.id,
      providerChildSessionId: child.id,
      providerParentSessionId: child.parentID,
      source: 'THREAD_STARTED_PARENT',
      status: 'RUNNING',
      materialized: true,
      rawMessage: raw
    }, protocolOperationId('subagent/observed', raw, parent.id, child.id));
  }

  private async handleSessionError(event: OpenCodeEvent, serverId: string): Promise<void> {
    const providerSessionId = stringProperty(event.properties, 'sessionID');
    const session = providerSessionId
      ? await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    if (!session || !this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    const run = session ? await this.getCurrentRunForSession(session.id) : undefined;
    if (
      run?.serverInstanceId !== serverId ||
      !this.isCurrentSessionServerGeneration(session.id, serverId)
    ) {
      return;
    }
    if (isOpenCodeContextOverflowError(event.properties.error)) {
      await this.recordRunActivity(run, 'session/error/context-overflow', {
        diagnostic: openCodeErrorDiagnostic(
          event.properties.error,
          this.sensitiveValues
        )
      });
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      await this.reconcileSessionOwned(session.id, serverId);
      return;
    }
    const diagnostic = openCodeErrorDiagnostic(
      event.properties.error ?? 'OpenCode session error.',
      this.sensitiveValues
    );
    const status = run.status === 'INTERRUPTING' ? 'INTERRUPTED' : 'FAILED';
    const finalized = await this.finalizeRun(run, status, diagnostic);
    if (!finalized) return;
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    await this.taskRuntime.updateAgentSession(session.id, {
      status: status === 'INTERRUPTED' ? 'IDLE' : 'SYSTEM_ERROR'
    }, runtimeOperationId('session/error', serverId, event.id, session.id, status));
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    this.scheduleSessionIdleEviction(session.id);
  }

  private reconcileRun(run: RunRecord): Promise<'reconciled' | 'recovery-required'> {
    return this.enqueueSessionOperation(run.sessionId, () => this.reconcileRunOwned(run));
  }

  private async reconcileRunOwned(
    run: RunRecord,
    expectedServerId?: string
  ): Promise<'reconciled' | 'recovery-required'> {
    this.reconciliationCounts.set(
      run.sessionId,
      (this.reconciliationCounts.get(run.sessionId) ?? 0) + 1
    );
    try {
      return await this.reconcileRunInternal(run, expectedServerId);
    } finally {
      const remaining = (this.reconciliationCounts.get(run.sessionId) ?? 1) - 1;
      if (remaining > 0) this.reconciliationCounts.set(run.sessionId, remaining);
      else this.reconciliationCounts.delete(run.sessionId);
    }
  }

  private async reconcileRunInternal(
    run: RunRecord,
    expectedServerId?: string
  ): Promise<'reconciled' | 'recovery-required'> {
    const storedRun = await this.taskRuntime.getRun(run.id);
    if (!storedRun || TERMINAL_RUN_STATES.includes(storedRun.status)) return 'reconciled';
    run = storedRun;
    let session = await this.requireSession(run.sessionId);
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) {
      await this.recordReconciliation(run, 'RECOVERY_REQUIRED', 'REQUIRES_USER_ACTION', false);
      return 'recovery-required';
    }
    if (!this.isSafeOperationalIdentifier(providerSessionId)) {
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
      const running = await this.ensureSessionRuntime(
        await this.runtimeSessionOwnerForSession(session)
      );
      client = running.client;
      serverId = running.server.id;
      if (expectedServerId && serverId !== expectedServerId) return 'recovery-required';
      if (run.serverInstanceId !== serverId) {
        run = await this.taskRuntime.updateRun(
          run.id,
          { serverInstanceId: serverId },
          runtimeOperationId('run/reconcile-server', run.id, serverId)
        );
      }
      await this.bindEventStream(session, client, serverId);
    } catch {
      return 'recovery-required';
    }
    const request = expectedServerId
      ? {
          deadlineAt:
            Date.now() +
            Math.min(
              positiveTimeout(this.options.requestTimeoutMs, 30_000),
              MAX_INBOUND_RESYNC_MS
            )
        }
      : undefined;
    const [
      sessionResult,
      messagesResult,
      statusesResult,
      permissionsResult,
      questionsResult,
      todosResult
    ] = await Promise.all([
      client.get<unknown>(sessionPath(providerSessionId), request),
      client.get<unknown>(`${sessionPath(providerSessionId)}/message`, request),
      client.get<unknown>('/session/status', request),
      client.get<unknown>('/permission', request),
      client.get<unknown>('/question', request),
      client.get<unknown>(`${sessionPath(providerSessionId)}/todo`, request)
    ]);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
      return 'recovery-required';
    }
    const providerSession = parseOpenCodeSession(sessionResult.data);
    if (
      providerSession.id !== providerSessionId ||
      !this.isSafeOperationalIdentifier(providerSession.id)
    ) {
      throw new Error('OpenCode returned an unsafe session identity during reconciliation.');
    }
    await assertSessionDirectory(providerSession, session.worktreePath);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
      return 'recovery-required';
    }
    const messages = parseOpenCodeMessages(messagesResult.data);
    const statuses = asRecord(statusesResult.data);
    if (!statuses) throw new Error('OpenCode returned an incompatible session status snapshot.');
    const permissions = parseOpenCodePermissions(permissionsResult.data);
    const questions = parseOpenCodeQuestions(questionsResult.data);
    const steps = this.redactProviderValue(mapOpenCodeTodoSteps(todosResult.data));
    const status = mapOpenCodeSessionStatus(
      statuses[providerSessionId] ?? { type: 'idle' }
    );
    const approvalPolicy = attestedApprovalPolicy(
      providerSession,
      session.requestedSettings
    );
    const providerMessageId = run.providerTurnId;
    const userMessage = providerMessageId
      ? messages.find(
          (message) =>
            message.info.role === 'user' && message.info.id === providerMessageId
        )
      : undefined;
    const messageSettings = userMessage
      ? settingsObservedFromMessage(userMessage.info, run.requestedSettings)
      : undefined;
    const recoveredSettings = messageSettings
      ? { ...messageSettings, approvalPolicy }
      : undefined;
    const observed = this.safeObservedSettings(
      recoveredSettings ??
        settingsFromSession(providerSession, run.requestedSettings)
    );
    if (!isDeepStrictEqual(run.observedSettings, observed)) {
      run = await this.taskRuntime.updateRun(
        run.id,
        { observedSettings: observed },
        protocolOperationId('run/reconcile-settings', messagesResult.raw, run.id)
      );
    }
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
      return 'recovery-required';
    }
    session = await this.taskRuntime.updateAgentSession(session.id, {
      observedSettings: observed,
      materialized: true
    }, protocolOperationId('session/reconcile', sessionResult.raw, session.id, serverId));
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
      return 'recovery-required';
    }
    if (approvalPolicy === undefined) {
      let quarantineFailure: unknown;
      try {
        await this.quarantineSessionRuntime(
          session.id,
          'session/reconcile-permission-policy',
          `The native OpenCode session does not attest the requested ${run.requestedSettings.approvalPolicy} approval policy.`
        );
      } catch (cause) {
        quarantineFailure = cause;
      }
      const currentRun = await this.taskRuntime.getRun(run.id);
      if (currentRun && !TERMINAL_RUN_STATES.includes(currentRun.status)) {
        await this.recordReconciliation(
          currentRun,
          'RECOVERY_REQUIRED',
          'REQUIRES_USER_ACTION',
          false
        );
      }
      if (quarantineFailure) throw quarantineFailure;
      return 'recovery-required';
    }
    if (recoveredSettings) {
      const duplicate = (await this.taskRuntime.snapshot()).agentSettingsObservations.some(
        (observation) =>
          observation.runId === run.id &&
          observation.source === 'RECOVERY_RESUME_RESPONSE' &&
          isDeepStrictEqual(observation.settings, observed)
      );
      if (!duplicate) {
        await this.recordSettingsObservation(
          session,
          'RECOVERY_RESUME_RESPONSE',
          observed,
          run.id,
          messagesResult.raw
        );
      }
    }
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
      return 'recovery-required';
    }
    if (userMessage) {
      await this.materializeRecoveredMessages(
        run,
        session,
        messages,
        userMessage,
        messagesResult.raw,
        serverId
      );
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
        return 'recovery-required';
      }
      const latestPlan = (await this.taskRuntime.snapshot()).agentPlanRevisions
        .filter((revision) => revision.runId === run.id)
        .sort((left, right) => left.revision - right.revision)
        .at(-1);
      if (
        (latestPlan && !isDeepStrictEqual(latestPlan.steps, steps)) ||
        (!latestPlan && steps.length > 0)
      ) {
        await this.taskRuntime.recordAgentPlanRevision({
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          sessionId: session.id,
          runtimeId: this.descriptor.id,
          steps,
          rawMessage: todosResult.raw
        }, protocolOperationId('plan/reconcile', todosResult.raw, run.id));
      }
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
        return 'recovery-required';
      }
    }
    await this.materializePendingInteractionsSnapshot(
      session,
      permissions,
      permissionsResult.raw,
      questions,
      questionsResult.raw,
      serverId
    );
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
      return 'recovery-required';
    }
    const currentRunAfterInteractions = (await this.taskRuntime.getRun(run.id)) ?? run;
    session = await this.taskRuntime.updateAgentSession(session.id, {
      status: await this.sessionStatusWithInteractionAuthority(
        status,
        currentRunAfterInteractions
      )
    }, protocolOperationId('session/reconcile-status', statusesResult.raw, session.id, serverId));
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
      return 'recovery-required';
    }
    if (!userMessage) {
      await this.recordReconciliation(run, 'RECOVERY_REQUIRED', 'REQUIRES_USER_ACTION', false);
      return 'recovery-required';
    }
    const assistant = latestAssistantFor(messages, userMessage.info.id);
    if (assistant && status === 'IDLE' && isTerminalAssistantMessage(assistant)) {
      await this.finalizeFromSnapshot(run, session, assistant, messagesResult.raw, serverId);
    } else if (status === 'ACTIVE') {
      const currentRun = (await this.taskRuntime.getRun(run.id)) ?? run;
      const hasPendingInteraction = (await this.taskRuntime.snapshot()).interactionRequests.some(
        (interaction) =>
          interaction.runId === run.id &&
          interaction.serverInstanceId === serverId &&
          (interaction.status === 'PENDING' || interaction.status === 'RESPONDING')
      );
      const recoveredStatus =
        run.status === 'INTERRUPTING'
          ? 'INTERRUPTING'
          : hasPendingInteraction &&
              (currentRun.status === 'AWAITING_APPROVAL' ||
                currentRun.status === 'AWAITING_USER_INPUT')
            ? currentRun.status
            : 'RUNNING';
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) {
        return 'recovery-required';
      }
      await this.recordReconciliation(
        currentRun,
        recoveredStatus,
        'RECOVERED',
        false
      );
    } else {
      await this.recordReconciliation(run, 'RECOVERY_REQUIRED', 'REQUIRES_USER_ACTION', false);
      return 'recovery-required';
    }
    return 'reconciled';
  }

  private async materializeRecoveredMessages(
    run: RunRecord,
    session: AgentSessionRecord,
    messages: readonly OpenCodeMessage[],
    userMessage: OpenCodeMessage,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const related = messages.filter(
      (message) =>
        message.info.id === userMessage.info.id ||
        (message.info.role === 'assistant' &&
          message.info.parentID === userMessage.info.id)
    );
    for (const message of related) {
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      if (message.info.role === 'assistant' && message.info.parentID) {
        this.rememberAssistantParent(session.id, message.info.id, message.info.parentID);
      }
      const terminal = Boolean(
        message.info.role === 'assistant' &&
        (message.info.time?.completed || message.info.finish || message.info.error)
      );
      for (const part of message.parts) {
        const type = message.info.role === 'user' ? 'USER_MESSAGE' : mapOpenCodePartType(part);
        const partStatus = terminal ? terminalPartStatus(part) : mapOpenCodePartStatus(part);
        const payload = this.redactProviderValue(part);
        const providerStartedAt = providerTimestamp(part.state?.time?.start);
        const providerCompletedAt = providerTimestamp(
          part.state?.time?.end ?? (terminal ? message.info.time?.completed : undefined)
        );
        const existing = await this.taskRuntime.getAgentItemByProviderId(run.id, part.id);
        if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
        if (
          existing?.type === type &&
          existing.status === partStatus &&
          existing.providerStartedAt === providerStartedAt &&
          existing.providerCompletedAt === providerCompletedAt &&
          isDeepStrictEqual(existing.payload, payload)
        ) {
          continue;
        }
        await this.taskRuntime.upsertAgentItem({
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          sessionId: session.id,
          providerItemId: part.id,
          type,
          status: partStatus,
          payload,
          rawMessage: raw,
          providerStartedAt,
          providerCompletedAt
        }, protocolOperationId('item/recovered', raw, run.id, message.info.id, part.id));
      }
    }
    const assistants = related
      .filter(
        (message) =>
          message.info.role === 'assistant' &&
          Boolean(message.info.time?.completed || message.info.finish || message.info.error)
      )
      .sort(
        (left, right) =>
          (left.info.time?.created ?? 0) - (right.info.time?.created ?? 0)
      );
    const assistant = assistants.at(-1);
    if (!assistant) return;
    const total = assistants.reduce(
      (usage, message) => addUsage(usage, mapOpenCodeUsage(message.info)),
      emptyUsage()
    );
    const last = mapOpenCodeUsage(assistant.info);
    const latestUsage = latestUsageForRun(await this.taskRuntime.snapshot(), run.id);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
    if (
      latestUsage &&
      isDeepStrictEqual(latestUsage.total, total) &&
      isDeepStrictEqual(latestUsage.last, last)
    ) {
      this.rememberAssistantUsageTotal(run.id, total);
      this.replaceAssistantUsageForRun(session.id, run.id, assistants);
      return;
    }
    await this.taskRuntime.recordAgentUsageSnapshot({
      taskId: run.taskId,
      iterationId: run.iterationId,
      sessionId: session.id,
      runId: run.id,
      runtimeId: this.descriptor.id,
      total,
      last,
      rawMessage: raw
    }, protocolOperationId('usage/recovered', raw, run.id, assistant.info.id));
    this.rememberAssistantUsageTotal(run.id, total);
    this.replaceAssistantUsageForRun(session.id, run.id, assistants);
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
    return run ? this.reconcileRunOwned(run, expectedServerId) : 'none';
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
    await this.materializePendingInteractionsSnapshot(
      session,
      parseOpenCodePermissions(permissionsResult.data),
      permissionsResult.raw,
      parseOpenCodeQuestions(questionsResult.data),
      questionsResult.raw,
      serverId
    );
  }

  private async materializePendingInteractionsSnapshot(
    session: AgentSessionRecord,
    permissions: readonly OpenCodePermissionRequest[],
    permissionsRaw: AgentProtocolMessageReference,
    questions: readonly OpenCodeQuestionRequest[],
    questionsRaw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<void> {
    const pending = [
      ...permissions
        .filter((permission) => permission.sessionID === session.providerSessionId)
        .map((permission) => ({
          id: permission.id,
          mapped: mapOpenCodePermission(permission, session.worktreePath),
          raw: permissionsRaw,
          messageId: permission.source?.messageID ?? permission.tool?.messageID
        })),
      ...questions
        .filter((question) => question.sessionID === session.providerSessionId)
        .map((question) => ({
          id: question.id,
          mapped: mapOpenCodeQuestion(question),
          raw: questionsRaw,
          messageId: question.tool?.messageID
        }))
    ];
    const providerRequestIds = new Set(pending.map((request) => request.id));
    for (const request of pending) {
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      const existing = await this.taskRuntime.getInteractionRequestByProviderId(
        serverId,
        request.id
      );
      if (existing) {
        if (existing.sessionId !== session.id || existing.type !== request.mapped.type) {
          throw new Error(
            'OpenCode reused a pending interaction identity with different ownership.'
          );
        }
        continue;
      }
      await this.materializeInteraction(
        session,
        request.id,
        request.mapped,
        request.raw,
        serverId,
        request.messageId,
        true
      );
    }
    const snapshot = await this.taskRuntime.snapshot();
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) =>
        candidate.sessionId === session.id &&
        candidate.serverInstanceId === serverId &&
        (candidate.status === 'PENDING' || candidate.status === 'RESPONDING') &&
        !providerRequestIds.has(String(candidate.providerRequestId))
    )) {
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      const current = await this.taskRuntime.getInteractionRequest(interaction.id);
      if (!current || (current.status !== 'PENDING' && current.status !== 'RESPONDING')) continue;
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return;
      const stale = await this.taskRuntime.transitionInteractionRequest(current.id, current.status, {
        status: 'STALE',
        resolution: { providerQueueAbsent: true },
        resolvedAt: new Date().toISOString()
      }, runtimeOperationId(
        'interaction/provider-queue-absent',
        current.id,
        serverId,
        permissionsRaw.sha256,
        questionsRaw.sha256
      ));
      this.emitInteractionUpdate(stale);
      await this.resumeAfterInteractionResolution(stale);
    }
  }

  private async finalizeFromSnapshot(
    run: RunRecord,
    session: AgentSessionRecord,
    assistant: OpenCodeMessage,
    raw: AgentProtocolMessageReference,
    serverId: string
  ): Promise<boolean> {
    const current = await this.taskRuntime.getRun(run.id);
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return false;
    if (!current || !ACTIVE_RUN_STATES.includes(current.status)) return false;
    await this.flushBufferedStreamOutput(current.id, true);
    for (const part of assistant.parts) {
      const type = mapOpenCodePartType(part);
      const status = terminalPartStatus(part);
      const payload = this.boundedItemPayload(part);
      const providerStartedAt = providerTimestamp(part.state?.time?.start);
      const providerCompletedAt = providerTimestamp(
        part.state?.time?.end ?? assistant.info.time?.completed
      );
      const existing = await this.taskRuntime.getAgentItemByProviderId(current.id, part.id);
      if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return false;
      if (
        existing?.type === type &&
        existing.status === status &&
        existing.providerStartedAt === providerStartedAt &&
        existing.providerCompletedAt === providerCompletedAt &&
        isDeepStrictEqual(existing.payload, payload)
      ) {
        continue;
      }
      await this.taskRuntime.upsertAgentItem({
        taskId: current.taskId,
        iterationId: current.iterationId,
        runId: current.id,
        sessionId: session.id,
        providerItemId: part.id,
        type,
        status,
        payload,
        rawMessage: raw,
        providerStartedAt,
        providerCompletedAt
      }, protocolOperationId('item/finalized', raw, current.id, assistant.info.id, part.id));
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
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return false;
    await this.recordRunActivity(current, 'message/completed', {
      messageText: finalMessage,
      providerMessageId: assistant.info.id
    });
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return false;
    const finalized = await this.finalizeRun(
      current,
      status,
      providerDiagnostic,
      finalMessage
    );
    if (!finalized) return false;
    if (!this.isCurrentSessionServerGeneration(session.id, serverId)) return false;
    await this.taskRuntime.updateAgentSession(
      session.id,
      { status: 'IDLE', materialized: true },
      protocolOperationId('session/finalized', raw, session.id, current.id, assistant.info.id)
    );
    this.scheduleSessionIdleEviction(session.id);
    return true;
  }

  private async finalizeRun(
    run: RunRecord,
    status: Extract<RunRecord['status'], 'COMPLETED' | 'FAILED' | 'INTERRUPTED'>,
    error?: string,
    finalMessage = '',
    source: 'provider' | 'process' = 'provider'
  ): Promise<boolean> {
    error = error === undefined ? undefined : this.redactProviderText(error);
    finalMessage = this.redactProviderText(finalMessage);
    await this.materializeRunStreamBuffer(run.id);
    const current = await this.taskRuntime.getRun(run.id);
    if (!current || !ACTIVE_RUN_STATES.includes(current.status)) return false;
    const finalArtifact = await this.taskRuntime.writeFinalArtifact(
      current.taskId,
      current.id,
      [
        '# OpenCode turn result',
        '',
        `Status: ${status}`,
        `Model: ${current.observedSettings?.modelProvider ?? current.requestedSettings.modelProvider ?? 'unknown'}/${current.observedSettings?.model ?? current.requestedSettings.model ?? 'unknown'}`,
        '',
        finalMessage || error || 'OpenCode returned no final text.'
      ].join('\n'),
      runtimeOperationId('artifact/final', current.id, status, finalMessage, error)
    );
    const eventType = status === 'COMPLETED'
      ? 'AGENT_RUN_COMPLETED'
      : status === 'INTERRUPTED'
        ? 'AGENT_RUN_INTERRUPTED'
        : 'AGENT_RUN_FAILED';
    const published = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
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
          agentReviewStatus: 'NOT_RUN'
        }
      }),
      [current.status],
      runtimeOperationId('event/run-terminal', current.id, current.status, status, finalArtifact.id)
    );
    if (!published) return false;
    if (current.mode === 'DESIGN') {
      await this.revokeDesignToolGrant(current.sessionId).catch((cause) =>
        this.recordProtocolIncident(current.sessionId, cause).catch(() => undefined)
      );
    }
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
    return true;
  }

  private async handleRuntimeLoss(
    serverInstanceId: string,
    reason = 'OpenCode session runtime exited unexpectedly.',
    owningSessionId?: string,
    runtimeRunToSettleAfterShutdownId?: string
  ): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    const runs = snapshot.runs.filter(
      (run) => run.serverInstanceId === serverInstanceId && ACTIVE_RUN_STATES.includes(run.status)
    );
    for (const run of runs) {
      try {
        await this.materializeRunStreamBuffer(run.id);
      } catch {
        // The output buffer owns its bounded retry or ambiguity fence. Runtime
        // loss must still become authoritative even when artifact I/O fails.
      }
      const published = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
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
        }),
        [run.status],
        runtimeOperationId('event/runtime-lost', run.id, serverInstanceId, run.status, reason)
      );
      if (!published) continue;
      this.clearInterruptDeadline(run.id);
      this.emitRunStateUpdate(run, {
        eventType: 'runtime/lost',
        reason
      });
      await this.taskRuntime.updateAgentSession(
        run.sessionId,
        { status: 'NOT_LOADED' },
        runtimeOperationId('session/runtime-lost', run.sessionId, serverInstanceId, run.id)
      );
    }
    const runtimeSnapshot = await this.providerRuntime.snapshot();
    const runtimeSessions = new Map(
      runtimeSnapshot.sessions.map((session) => [session.id, session])
    );
    const runtimeRuns = runtimeSnapshot.runs.filter(
      (run) =>
        run.serverInstanceId === serverInstanceId &&
        run.id !== runtimeRunToSettleAfterShutdownId &&
        ACTIVE_RUN_STATES.includes(run.status) &&
        isOpenCodeReadOnlyRuntimeSession(runtimeSessions.get(run.sessionId))
    );
    for (const runtimeRun of runtimeRuns) {
      const observedAt = new Date().toISOString();
      const current = await this.providerRuntime.getRun(runtimeRun.id);
      if (!current || !ACTIVE_RUN_STATES.includes(current.status)) continue;
      const updated = await this.updateRuntimeRun(
        current.id,
        {
          status: 'RECOVERY_REQUIRED',
          delivery:
            current.delivery === 'SENDING' ? 'AMBIGUOUS' : current.delivery,
          recoveryState: 'REQUIRES_USER_ACTION',
          terminalReason: reason,
          lastEventAt: observedAt
        },
        runtimeOperationId('runtime/process-lost', current.id, serverInstanceId)
      );
      const runtimeSession = await this.providerRuntime.getSession(updated.sessionId);
      if (runtimeSession && runtimeSession.status !== 'NOT_LOADED') {
        await this.providerRuntime.updateSession(
          runtimeSession.id,
          runtimeSession.recordRevision,
          { status: 'NOT_LOADED' },
          runtimeOperationId(
            'runtime/session-process-lost',
            runtimeSession.id,
            serverInstanceId
          )
        );
      }
      this.emitRuntimeTurnEvent({
        type: 'RECOVERY_REQUIRED',
        runId: updated.id,
        providerTurnId: updated.providerTurnId,
        reason,
        observedAt
      });
    }
    if (owningSessionId && !runs.some((run) => run.sessionId === owningSessionId)) {
      const session = await this.taskRuntime.getAgentSession(owningSessionId);
      if (session && session.status !== 'NOT_LOADED') {
        await this.taskRuntime.updateAgentSession(
          owningSessionId,
          { status: 'NOT_LOADED' },
          runtimeOperationId('session/runtime-lost-unowned', owningSessionId, serverInstanceId)
        );
      }
    }
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) => candidate.serverInstanceId === serverInstanceId && ['PENDING', 'RESPONDING'].includes(candidate.status)
    )) {
      const latest = await this.taskRuntime.getInteractionRequest(interaction.id);
      if (!latest || !['PENDING', 'RESPONDING'].includes(latest.status)) continue;
      try {
        const aborted = await this.taskRuntime.transitionInteractionRequest(
          latest.id,
          latest.status,
          {
            status: 'ABORTED_SERVER_LOST',
            resolution: { reason },
            resolvedAt: new Date().toISOString()
          },
          runtimeOperationId('interaction/runtime-lost', latest.id, serverInstanceId, reason)
        );
        this.emitInteractionUpdate(aborted);
      } catch (cause) {
        const raced = await this.taskRuntime.getInteractionRequest(interaction.id);
        if (raced && ['PENDING', 'RESPONDING'].includes(raced.status)) throw cause;
      }
    }
  }

  private async recoverPersistedRuntimeLosses(): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    const inMemoryServerIds = new Set(
      [
        this.catalogSupervisor?.currentServer?.id,
        ...[...this.supervisors.values()].map(
          (supervisor) => supervisor.currentServer?.id
        )
      ].filter((serverId): serverId is string => serverId !== undefined)
    );
    for (const server of agentServersRequiringLossRecovery(
      snapshot,
      this.descriptor.id
    ).filter((candidate) => !inMemoryServerIds.has(candidate.id))) {
      if (!['EXITED', 'FAILED', 'LOST'].includes(server.status)) {
        await this.providerRuntime.updateAgentServer(server.id, {
          status: 'LOST',
          disconnectedAt: new Date().toISOString(),
          exitedAt: new Date().toISOString(),
          exitReason: 'Task Monki restarted without the prior OpenCode process.'
        });
      }
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
    const snapshot = await this.taskRuntime.snapshot();
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
    const binding = this.eventStreams.get(sessionId);
    const stream = binding?.stream;
    stream?.stop();
    this.clearAssistantMessageParents(sessionId);
    for (const buffer of this.streamBuffers.values()) {
      if (buffer.sessionId === sessionId && buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = undefined;
      }
    }
    if (waitForInbound) {
      await stream?.settled;
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
    const client = supervisor?.currentClient;
    const serverId = supervisor?.currentServer?.id;
    if (client && serverId) {
      await this.disconnectDesignToolRegistration(sessionId, client, serverId).catch(
        () => undefined
      );
    } else {
      await this.releaseDesignToolRegistrationSafely(sessionId);
    }
    let shutdownConfirmed = false;
    try {
      if (supervisor) await supervisor.shutdown();
      shutdownConfirmed = true;
      if (this.supervisors.get(sessionId) === supervisor) {
        this.supervisors.delete(sessionId);
      }
      if (this.eventStreams.get(sessionId) === binding) {
        this.eventStreams.delete(sessionId);
      }
      const session = await this.taskRuntime.getAgentSession(sessionId).catch(() => undefined);
      if (session) {
        await this.taskRuntime.updateAgentSession(
          sessionId,
          { status: 'NOT_LOADED' },
          runtimeOperationId('session/close', sessionId, session.updatedAt)
        );
      } else {
        const runtimeSession = await this.providerRuntime.getSession(sessionId);
        if (runtimeSession) {
          await this.providerRuntime.updateSession(
            runtimeSession.id,
            runtimeSession.recordRevision,
            { status: 'NOT_LOADED' },
            runtimeOperationId(
              'runtime/session-close',
              sessionId,
              runtimeSession.updatedAt
            )
          );
        }
      }
    } finally {
      await this.releaseDesignToolRegistrationSafely(sessionId);
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
    const [snapshot, runtimeSnapshot] = await Promise.all([
      this.taskRuntime.snapshot(),
      this.providerRuntime.snapshot()
    ]);
    const runtimeSessions = new Map(
      runtimeSnapshot.sessions.map((session) => [session.id, session])
    );
    return snapshot.runs.some(
      (run) =>
        run.runtimeId === this.descriptor.id &&
        ACTIVE_RUN_STATES.includes(run.status) &&
        !(run.id === excludedQueuedRunId && run.status === 'QUEUED')
    ) || runtimeSnapshot.runs.some(
      (run) =>
        isOpenCodeReadOnlyRuntimeSession(runtimeSessions.get(run.sessionId)) &&
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
      capabilities: this.runtimeCapabilities(),
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
    await this.taskRuntime.recordAgentSettingsObservation({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runId,
      runtimeId: this.descriptor.id,
      source,
      settings,
      rawMessage
    }, rawMessage
      ? protocolOperationId('settings/observed', rawMessage, session.id, runId, source)
      : runtimeOperationId('settings/observed', session.id, runId, source, settings));
  }

  private async recordRunActivity(
    run: RunRecord,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    payload = this.redactProviderValue(payload);
    await this.taskRuntime.applyTaskRuntimeEvent(
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
      }),
      runtimeOperationId('event/activity', run.id, eventType, payload)
    );
    this.emitRunActivity(run, { eventType, ...payload });
  }

  private async persistRunOutputGroups(
    run: RunRecord,
    groups: ReadonlyArray<{
      source: string;
      chunks: readonly string[];
      evidence: readonly string[];
    }>
  ): Promise<Array<{ source: string; text: string }>> {
    const safeGroups = groups.map(({ source, chunks, evidence }) => ({
      source: this.redactProviderText(source),
      text: this.redactProviderText(chunks.join('')),
      evidence
    }));
    const artifactText = safeGroups
      .map(({ source, text }) => `\n[${source}]\n${text}`)
      .join('');
    if (artifactText) {
      await this.taskRuntime.appendArtifact(
        run.outputArtifactId,
        artifactText,
        runtimeOperationId(
          'artifact/output',
          run.id,
          safeGroups.map(({ source, text, evidence }) => ({ source, text, evidence }))
        )
      );
    }
    return safeGroups.map(({ source, text }) => ({ source, text }));
  }

  private scheduleBufferedStreamOutputFlush(buffer: OpenCodeRunStreamBuffer): void {
    if (buffer.timer || buffer.outputBytes === 0 || this.shuttingDown) return;
    const delay = STREAM_OUTPUT_FLUSH_MS * 2 ** buffer.failureCount;
    const timer = setTimeout(() => {
      if (buffer.timer === timer) buffer.timer = undefined;
      void this.enqueueInbound(buffer.sessionId, () =>
        this.flushBufferedStreamOutput(buffer.runId)
      );
    }, delay);
    timer.unref();
    buffer.timer = timer;
  }

  private async flushBufferedStreamOutput(
    runId: string,
    releaseCredentialCarry = false
  ): Promise<void> {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer) return;
    if (releaseCredentialCarry) this.redactStreamCredentialCarry(buffer);
    if (buffer.flushing) {
      await buffer.flushing;
      if (
        buffer.outputBytes > 0 ||
        (releaseCredentialCarry && buffer.credentialCarry)
      ) {
        await this.flushBufferedStreamOutput(runId, releaseCredentialCarry);
      }
      return;
    }
    const flushing = this.flushBufferedStreamOutputBatch(runId, buffer);
    buffer.flushing = flushing;
    try {
      await flushing;
    } finally {
      if (buffer.flushing === flushing) buffer.flushing = undefined;
    }
  }

  private async flushBufferedStreamOutputBatch(
    runId: string,
    buffer: OpenCodeRunStreamBuffer
  ): Promise<void> {
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = undefined;
    if (buffer.outputBytes === 0) return;
    const output = buffer.output;
    const outputBytes = buffer.outputBytes;
    buffer.output = [];
    buffer.outputBytes = 0;
    const run = await this.taskRuntime.getRun(runId);
    if (!run) {
      this.discardStreamBuffer(runId);
      return;
    }
    let safeOutput: Array<{ source: string; text: string }>;
    try {
      safeOutput = await this.persistRunOutputGroups(run, output);
    } catch (cause) {
      buffer.output = [...output, ...buffer.output];
      buffer.outputBytes += outputBytes;
      const failureCount = buffer.failureCount + 1;
      if (
        cause instanceof AgentRuntimeArtifactMutationAmbiguousError ||
        failureCount >= STREAM_OUTPUT_MAX_FAILURES ||
        this.bufferedStreamOutputBytes(buffer) > STREAM_OUTPUT_MAX_BUFFER_BYTES
      ) {
        this.discardSessionStreamBuffers(buffer.sessionId);
        this.fenceStreamOutputPersistence(run, cause);
        throw cause;
      }
      buffer.failureCount = failureCount;
      this.scheduleBufferedStreamOutputFlush(buffer);
      throw cause;
    }
    buffer.failureCount = 0;
    if (
      buffer.parts.size === 0 &&
      buffer.outputBytes === 0 &&
      !buffer.credentialCarry
    ) {
      this.discardStreamBuffer(runId);
    } else {
      this.scheduleBufferedStreamOutputFlush(buffer);
    }
    for (const { source, text } of safeOutput) {
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
  }

  private bufferStreamOutput(
    buffer: OpenCodeRunStreamBuffer,
    source: string,
    text: string,
    raw: AgentProtocolMessageReference
  ): void {
    if (buffer.credentialCarry && buffer.credentialCarry.source !== source) {
      this.redactStreamCredentialCarry(buffer);
    }
    const evidence = uniqueStrings([
      ...(buffer.credentialCarry?.source === source
        ? buffer.credentialCarry.evidence
        : []),
      protocolReferenceIdentity(raw)
    ]);
    const combined = (
      buffer.credentialCarry?.source === source
        ? buffer.credentialCarry.text
        : ''
    ) + text;
    const safe = this.redactProviderText(combined);
    const carryLength = credentialPrefixCarryLength(safe, this.sensitiveValues);
    this.appendBufferedStreamOutput(
      buffer,
      source,
      safe.slice(0, safe.length - carryLength),
      evidence
    );
    buffer.credentialCarry = carryLength > 0
      ? { source, text: safe.slice(-carryLength), evidence }
      : undefined;
  }

  private appendBufferedStreamOutput(
    buffer: OpenCodeRunStreamBuffer,
    source: string,
    text: string,
    evidence: readonly string[]
  ): void {
    if (!text) return;
    const previous = buffer.output.at(-1);
    if (previous?.source === source) {
      previous.chunks.push(text);
      previous.evidence = uniqueStrings([...previous.evidence, ...evidence]);
    } else {
      buffer.output.push({ source, chunks: [text], evidence: [...evidence] });
    }
    buffer.outputBytes += Buffer.byteLength(text);
  }

  private redactStreamCredentialCarry(buffer: OpenCodeRunStreamBuffer): void {
    if (!buffer.credentialCarry) return;
    this.appendBufferedStreamOutput(
      buffer,
      buffer.credentialCarry.source,
      REDACTED_CREDENTIAL,
      buffer.credentialCarry.evidence
    );
    buffer.credentialCarry = undefined;
  }

  private bufferedStreamOutputBytes(buffer: OpenCodeRunStreamBuffer): number {
    return buffer.outputBytes + Buffer.byteLength(buffer.credentialCarry?.text ?? '');
  }

  private fenceStreamOutputPersistence(run: RunRecord, cause: unknown): void {
    if (this.shuttingDown) return;
    const detail = cause instanceof AgentRuntimeArtifactMutationAmbiguousError
      ? `Output persistence for run ${run.id} became ambiguous and cannot be retried safely.`
      : `Output persistence for run ${run.id} failed repeatedly or exceeded its safety bound.`;
    void this.quarantineSessionRuntime(
      run.sessionId,
      'stream-output/persistence',
      detail,
      true
    ).catch(() => undefined);
  }

  private discardSessionStreamBuffers(sessionId: string): void {
    for (const buffer of [...this.streamBuffers.values()]) {
      if (buffer.sessionId === sessionId) this.discardStreamBuffer(buffer.runId);
    }
  }

  private async materializeBufferedStreamParts(
    runId: string,
    partIds?: readonly string[]
  ): Promise<void> {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer) return;
    const run = await this.taskRuntime.getRun(runId);
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
      await this.taskRuntime.upsertAgentItem({
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        sessionId: buffer.sessionId,
        providerItemId: entry.part.id,
        type: entry.type,
        status,
        payload: this.boundedItemPayload(entry.part),
        rawMessage: entry.raw,
        providerStartedAt: providerTimestamp(entry.part.state?.time?.start),
        providerCompletedAt: providerTimestamp(entry.part.state?.time?.end)
      }, protocolOperationId('item/stream-flush', entry.raw, run.id, entry.part.id));
      await this.recordRunActivity(run, `item/${entry.part.type}/${status.toLowerCase()}`, {
        providerItemId: entry.part.id,
        coalescedEvents: entry.eventCount
      });
      buffer.parts.delete(partId);
    }
    if (
      buffer.parts.size === 0 &&
      buffer.outputBytes === 0 &&
      !buffer.credentialCarry
    ) {
      this.discardStreamBuffer(runId);
    }
  }

  private async materializeRunStreamBuffer(runId: string): Promise<void> {
    let outputFailure: unknown;
    try {
      await this.flushBufferedStreamOutput(runId, true);
    } catch (cause) {
      outputFailure = cause;
    }
    try {
      await this.materializeBufferedStreamParts(runId);
    } catch (cause) {
      if (outputFailure) {
        throw new AggregateError(
          [outputFailure, cause],
          'OpenCode could not persist buffered output or item evidence.'
        );
      }
      throw cause;
    }
    if (outputFailure) throw outputFailure;
  }

  private discardStreamBuffer(runId: string): void {
    const buffer = this.streamBuffers.get(runId);
    if (buffer?.timer) clearTimeout(buffer.timer);
    if (buffer) {
      buffer.timer = undefined;
      buffer.parts.clear();
      buffer.output = [];
      buffer.outputBytes = 0;
      buffer.credentialCarry = undefined;
    }
    this.streamBuffers.delete(runId);
  }

  private async recordReconciliation(
    run: RunRecord,
    status: RunRecord['status'],
    recoveryState: RunRecord['recoveryState'],
    terminal: boolean
  ): Promise<void> {
    await this.taskRuntime.applyTaskRuntimeEvent(
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
      }),
      runtimeOperationId('event/reconciled', run.id, status, recoveryState, terminal)
    );
    this.emitRunStateUpdate(run, {
      eventType: 'runtime/reconciled',
      status,
      recoveryState,
      terminal
    });
  }

  private async stalePendingInteractions(runId: string, reason: string): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) => candidate.runId === runId && ['PENDING', 'RESPONDING'].includes(candidate.status)
    )) {
      const stale = await this.taskRuntime.transitionInteractionRequest(interaction.id, interaction.status, {
        status: 'STALE',
        resolution: { reason },
        resolvedAt: new Date().toISOString()
      }, runtimeOperationId('interaction/stale-terminal', interaction.id, interaction.status, reason));
      this.emitInteractionUpdate(stale);
    }
  }

  private async recordProtocolIncident(sessionId: string, cause: unknown): Promise<void> {
    const session = await this.taskRuntime.getAgentSession(sessionId).catch(() => undefined);
    const run = session ? await this.getCurrentRunForSession(session.id).catch(() => undefined) : undefined;
    if (!session || !run) return;
    await this.taskRuntime.applyTaskRuntimeEvent(
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
      }),
      runtimeOperationId('event/protocol-incident', run.id, errorMessage(cause))
    );
    this.emitRunStateUpdate(run, {
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

  private emitRunStateUpdate(run: RunRecord, payload: Record<string, unknown>): void {
    this.appEvents.emit({
      type: 'run.state.updated',
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

  private boundedItemPayload(part: OpenCodePart): AgentJsonValue {
    const payload = this.redactProviderValue(part) as AgentJsonValue;
    const encoded = JSON.stringify(payload);
    if (
      encoded !== undefined &&
      Buffer.byteLength(encoded) <= AGENT_RUNTIME_LIMITS.maxTelemetryPayloadBytes
    ) {
      return payload;
    }
    const state = asRecord(part.state);
    const time = asRecord(state?.time);
    return {
      type: part.type,
      ...(part.tool ? { tool: this.redactProviderText(part.tool) } : {}),
      ...(part.callID ? { callID: this.redactProviderText(part.callID) } : {}),
      ...(typeof state?.status === 'string' ? { status: state.status } : {}),
      ...(time
        ? {
            time: {
              ...(typeof time.start === 'number' ? { start: time.start } : {}),
              ...(typeof time.end === 'number' ? { end: time.end } : {})
            }
          }
        : {}),
      truncated: true,
      byteLength: encoded === undefined ? 0 : Buffer.byteLength(encoded)
    };
  }

  private isSafeOperationalIdentifier(value: string): boolean {
    return this.redactProviderText(value) === value;
  }

  private safePublishedModels(models: readonly AgentModel[]): AgentModel[] {
    return models.flatMap((model) => {
      if (
        !this.isSafeOperationalIdentifier(model.id) ||
        !model.modelProvider ||
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

  private async prepareDesignSkillPack(): Promise<void> {
    if (this.designSkillLoadAttempted) return;
    this.designSkillLoadAttempted = true;
    if (!this.options.designSkillRoot) {
      this.designSkillFailure = 'The Task Monki host did not configure a Design skill root.';
      return;
    }
    try {
      this.designSkillPack = await loadDesignSkillPack(this.options.designSkillRoot);
      this.designSkillFailure = undefined;
    } catch (cause) {
      this.designSkillPack = undefined;
      this.designSkillFailure = errorMessage(cause);
    }
  }

  private runtimeCapabilities(): AgentRuntimeCapabilities {
    return opencodeCapabilities({
      designSkills: this.designSkillPack
        ? { available: true }
        : {
            available: false,
            detail:
              this.designSkillFailure ??
              'The app-owned Design skill pack has not been validated yet.'
          },
      designBrowser: {
        available: Boolean(this.options.designClientToolBridge),
        detail: this.options.designClientToolBridge
          ? undefined
          : 'The packaged inspect_design MCP bridge has not been configured yet.'
      }
    });
  }

  private designInstructions(input: Pick<StartAgentTurn, 'mode' | 'instructionProfile'>): string | undefined {
    if (input.mode !== 'DESIGN' && input.instructionProfile !== 'DESIGN') return undefined;
    if (input.mode !== 'DESIGN' || input.instructionProfile !== 'DESIGN') {
      throw new Error('The DESIGN instruction profile is valid only for a Design turn.');
    }
    if (!this.designSkillPack) {
      throw new Error(
        `Task Monki cannot start Design work because its skill pack is unavailable. ${
          this.designSkillFailure ?? 'The skill pack has not been validated.'
        }`
      );
    }
    return [
      buildDesignAgentDeveloperInstructions(this.designSkillPack.catalog),
      '',
      'Read each matching Task Monki skill with the normal file-reading tool at its exact Path. Do not invoke a provider-native skill loader by skill name; it does not own the app skill pack.'
    ].join('\n');
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
    const session = await this.taskRuntime.getAgentSession(sessionId);
    if (!session) throw new Error(`Agent session not found: ${sessionId}`);
    return session;
  }

  private async runtimeSessionOwnerForSession(
    session: AgentSessionRecord
  ): Promise<OpenCodeSessionRuntimeOwner> {
    const snapshot = await this.taskRuntime.snapshot();
    const design = snapshot.runs.some(
      (run) => run.sessionId === session.id && run.mode === 'DESIGN'
    );
    return {
      ...session,
      pure: design,
      design
    };
  }

  private async getCurrentRunForSession(sessionId: string): Promise<RunRecord | undefined> {
    const active = await this.taskRuntime.getActiveRunForSession(sessionId);
    if (active) return active;
    const snapshot = await this.taskRuntime.snapshot();
    return snapshot.runs.find(
      (run) => run.sessionId === sessionId && ACTIVE_RUN_STATES.includes(run.status)
    );
  }

  private async sessionStatusWithInteractionAuthority(
    providerStatus: AgentSessionRecord['status'],
    run: RunRecord | undefined
  ): Promise<AgentSessionRecord['status']> {
    if (
      run?.status !== 'AWAITING_APPROVAL' &&
      run?.status !== 'AWAITING_USER_INPUT'
    ) {
      return providerStatus;
    }
    const snapshot = await this.taskRuntime.snapshot();
    return snapshot.interactionRequests.some(
      (interaction) =>
        interaction.runId === run.id &&
        interaction.sessionId === run.sessionId &&
        interaction.serverInstanceId === run.serverInstanceId &&
        (interaction.status === 'PENDING' || interaction.status === 'RESPONDING')
    )
      ? run.status
      : providerStatus;
  }

  private async resumeAfterInteractionResolution(
    interaction: InteractionRequestRecord
  ): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    if (
      snapshot.interactionRequests.some(
        (candidate) =>
          candidate.runId === interaction.runId &&
          candidate.sessionId === interaction.sessionId &&
          candidate.serverInstanceId === interaction.serverInstanceId &&
          (candidate.status === 'PENDING' || candidate.status === 'RESPONDING')
      )
    ) {
      return;
    }
    const run = snapshot.runs.find((candidate) => candidate.id === interaction.runId);
    if (
      run?.status === 'AWAITING_APPROVAL' ||
      run?.status === 'AWAITING_USER_INPUT'
    ) {
      await this.recordRunActivity(run, 'interaction/resolved', {
        interactionId: interaction.id,
        resumeConfirmed: true
      });
    }
    const session = snapshot.agentSessions.find(
      (candidate) => candidate.id === interaction.sessionId
    );
    if (
      session?.status === 'AWAITING_APPROVAL' ||
      session?.status === 'AWAITING_USER_INPUT'
    ) {
      await this.taskRuntime.updateAgentSession(
        session.id,
        { status: 'ACTIVE' },
        runtimeOperationId('session/interaction-resolved', session.id, interaction.id)
      );
    }
  }

  private assertSessionOwnership(session: Pick<OpenCodeSessionRuntimeOwner, 'id' | 'runtimeId'>): void {
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

function runtimeSessionOwner(
  session: AgentRuntimeSessionRecord
): OpenCodeSessionRuntimeOwner {
  return {
    id: session.id,
    runtimeId: session.runtimeId,
    worktreePath: session.executionContext.primaryCwd,
    pure: true
  };
}

function isOpenCodeReadOnlyRuntimeSession(
  session: AgentRuntimeSessionRecord | undefined
): boolean {
  return session?.runtimeId === OPENCODE_RUNTIME_ID &&
    session.executionContext.repositoryAccess === 'READ_ONLY';
}

function isProviderNeutralReadOnlySettings(settings: AgentExecutionSettings): boolean {
  return settings.sandbox === 'READ_ONLY' &&
    settings.approvalPolicy?.toLowerCase() === 'never' &&
    settings.networkAccess === false;
}

function openCodeNativeReadOnlySettings(
  settings: AgentExecutionSettings
): AgentExecutionSettings {
  const native: AgentExecutionSettings = {
    ...settings,
    sandbox: 'DANGER_FULL_ACCESS',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    networkAccess: true
  };
  assertOpenCodeExecutionSettings(native);
  return native;
}

function openCodeReadOnlyProfileHash(
  primaryCwd: string,
  readRoots: AgentExecutionContext['readRoots'],
  modelSettings: AgentExecutionSettings
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        runtimeId: OPENCODE_RUNTIME_ID,
        primaryCwd,
        readRoots,
        model: {
          provider: modelSettings.modelProvider,
          id: modelSettings.model,
          reasoningEffort: modelSettings.reasoningEffort
        },
        permission: openCodeReadOnlyPermissionRules()
      })
    )
    .digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runtimeDeliveryErrorFromOpenCode(
  operation: string,
  cause: unknown
): AgentRuntimeDeliveryError {
  const mapped = mapOpenCodeMutationError(operation, cause);
  return new AgentRuntimeDeliveryError(
    mapped instanceof AgentMutationAmbiguousError ? 'AMBIGUOUS' : 'NOT_DELIVERED',
    mapped.message,
    { cause: mapped }
  );
}

function openCodeEventSessionId(event: OpenCodeEvent): string | undefined {
  if (event.type === 'message.updated') {
    const info = asRecord(event.properties.info);
    return typeof info?.sessionID === 'string' ? info.sessionID : undefined;
  }
  if (event.type === 'message.part.updated') {
    const part = asRecord(event.properties.part);
    return typeof part?.sessionID === 'string' ? part.sessionID : undefined;
  }
  return stringProperty(event.properties, 'sessionID');
}

function runtimeOperationId(action: string, ...identity: unknown[]): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');
  return `opencode:${action}:${fingerprint}`;
}

function protocolOperationId(
  action: string,
  raw: AgentProtocolMessageReference,
  ...identity: unknown[]
): string {
  return runtimeOperationId(
    action,
    raw.serverInstanceId,
    raw.segment ?? 0,
    raw.sequence,
    raw.sha256,
    ...identity
  );
}

function protocolReferenceIdentity(raw: AgentProtocolMessageReference): string {
  return [
    raw.serverInstanceId,
    raw.segment ?? 0,
    raw.sequence,
    raw.sha256
  ].join(':');
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const OPENCODE_ID_RANDOM_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const OPENCODE_ID_RANDOM_LENGTH = 14;
let lastOpenCodeMessageIdTimestamp = 0;
let openCodeMessageIdCounter = 0;

// OpenCode compares user and assistant IDs to decide whether its prompt loop
// may stop, so caller-supplied IDs must match its ascending Identifier format.
export function createOpenCodeMessageId(): string {
  const timestamp = Date.now();
  if (timestamp !== lastOpenCodeMessageIdTimestamp) {
    lastOpenCodeMessageIdTimestamp = timestamp;
    openCodeMessageIdCounter = 0;
  }
  openCodeMessageIdCounter += 1;

  const encoded = BigInt(timestamp) * 0x1000n + BigInt(openCodeMessageIdCounter);
  const timeBytes = Buffer.alloc(6);
  for (let index = 0; index < timeBytes.length; index += 1) {
    timeBytes[index] = Number((encoded >> BigInt(40 - 8 * index)) & 0xffn);
  }

  const entropy = randomBytes(OPENCODE_ID_RANDOM_LENGTH);
  let random = '';
  for (const byte of entropy) {
    random +=
      OPENCODE_ID_RANDOM_ALPHABET[byte % OPENCODE_ID_RANDOM_ALPHABET.length];
  }
  return `msg_${timeBytes.toString('hex')}${random}`;
}

function inboundGenerationKey(sessionId: string, serverId: string): string {
  return `${sessionId}\u0000${serverId}`;
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

function assertOpenCodeMcpConnected(value: unknown, serverName: string): void {
  const status = asRecord(value)?.[serverName];
  const state = asRecord(status)?.status;
  if (state === 'connected') return;
  throw new Error(
    `OpenCode reported ${typeof state === 'string' ? state : 'an invalid status'} for the Design MCP server.`
  );
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
    reasoningEffort: session.model?.variant ?? fallback.reasoningEffort,
    approvalPolicy: attestedApprovalPolicy(session, fallback)
  };
}

function attestedApprovalPolicy(
  session: OpenCodeSession,
  requested: AgentExecutionSettings
): AgentExecutionSettings['approvalPolicy'] | undefined {
  const desired = openCodePermissionRules(requested);
  return openCodePermissionRulesEndWith(session.permission, desired)
    ? requested.approvalPolicy
    : undefined;
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

function latestAssistantFor(
  messages: readonly OpenCodeMessage[],
  userMessageId: string
): OpenCodeMessage | undefined {
  return messages
    .filter((message) => message.info.role === 'assistant' && message.info.parentID === userMessageId)
    .sort((left, right) => (right.info.time?.created ?? 0) - (left.info.time?.created ?? 0))[0];
}

function isTerminalAssistantMessage(message: OpenCodeMessage): boolean {
  return message.info.finish !== undefined ||
    message.info.error !== undefined ||
    message.info.time?.completed !== undefined;
}

function latestUsageForRun(
  snapshot: TaskAgentRuntimeSnapshot,
  runId: string
) {
  let latest: (typeof snapshot.agentUsageSnapshots)[number] | undefined;
  for (const usage of snapshot.agentUsageSnapshots) {
    if (
      usage.runId === runId &&
      (!latest || usage.observedAt > latest.observedAt)
    ) {
      latest = usage;
    }
  }
  return latest;
}

function emptyUsage(): AgentTokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}

function addUsage(
  left: AgentTokenUsageBreakdown,
  right: AgentTokenUsageBreakdown
): AgentTokenUsageBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens
  };
}

function replaceUsageInTotal(
  total: AgentTokenUsageBreakdown,
  previous: AgentTokenUsageBreakdown,
  next: AgentTokenUsageBreakdown
): AgentTokenUsageBreakdown {
  return {
    totalTokens: Math.max(0, total.totalTokens - previous.totalTokens + next.totalTokens),
    inputTokens: Math.max(0, total.inputTokens - previous.inputTokens + next.inputTokens),
    cachedInputTokens: Math.max(
      0,
      total.cachedInputTokens - previous.cachedInputTokens + next.cachedInputTokens
    ),
    outputTokens: Math.max(
      0,
      total.outputTokens - previous.outputTokens + next.outputTokens
    ),
    reasoningOutputTokens: Math.max(
      0,
      total.reasoningOutputTokens -
        previous.reasoningOutputTokens +
        next.reasoningOutputTokens
    )
  };
}

function terminalPartStatus(part: OpenCodePart): ReturnType<typeof mapOpenCodePartStatus> {
  const mapped = mapOpenCodePartStatus(part);
  if (mapped === 'STARTED' || mapped === 'IN_PROGRESS' || mapped === 'UNKNOWN') {
    return part.state?.status === 'error' ? 'FAILED' : 'COMPLETED';
  }
  return mapped;
}

async function prepareOpenCodeAttachmentDelivery(
  prompt: string,
  model: AgentModel,
  attachments: readonly AgentTurnAttachment[]
): Promise<PreparedOpenCodeAttachmentDelivery> {
  assertModelSupportsAttachments(model, attachments);
  const verified = await verifyAgentTurnAttachments(attachments, {
    includeBytes: () => true
  });
  const parts: OpenCodePromptPart[] = [{ type: 'text', text: prompt }];
  const submissionCandidates: AttachmentSubmissionCandidate[] = [];

  for (const attachment of verified) {
    if (!attachment.bytes) {
      throw new Error(
        `Attachment ${attachment.attachmentId} was not available for inline delivery.`
      );
    }
    const mime = attachment.kind === 'text' ? 'text/plain' : attachment.mediaType;
    const bytes = Buffer.from(
      attachment.bytes.buffer,
      attachment.bytes.byteOffset,
      attachment.bytes.byteLength
    );
    parts.push({
      type: 'file',
      mime,
      filename: attachment.displayName,
      url: `data:${mime};base64,${bytes.toString('base64')}`
    });
    submissionCandidates.push({
      attachmentId: attachment.attachmentId,
      ordinal: attachment.ordinal,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      byteCount: attachment.byteCount,
      sha256: attachment.sha256,
      transport: 'native-file',
      verifiedAt: attachment.verifiedAt
    });
  }

  return { parts, submissionCandidates };
}

function outputDelta(
  existingPayload: unknown,
  part: OpenCodePart
): string | undefined {
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

function isOpenCodeContextOverflowError(value: unknown): boolean {
  return asRecord(value)?.name === 'ContextOverflowError';
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
