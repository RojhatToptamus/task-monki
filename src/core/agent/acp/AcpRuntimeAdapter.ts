import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AgentCommandApprovalDecision,
  AgentExecutionSettings,
  AgentItemRecord,
  AgentJsonValue,
  AgentModel,
  AgentPreflight,
  AgentProtocolMessageReference,
  AgentRuntimeDiagnostic,
  AgentRuntimeCapabilities,
  AgentSessionControl,
  AgentSessionControlSet,
  AgentSessionControlValue,
  AgentSessionRecord,
  AgentSessionSnapshot,
  InteractionRequestRecord,
  RunRecord
} from '../../../shared/contracts';
import {
  AGENT_RUNTIME_LIMITS,
  type AgentExecutionContext,
  type AgentRuntimeRunRecord,
  type AgentRuntimeSessionRecord
} from '../../../shared/agentRuntime';
import type { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import type {
  AgentRuntimeStore,
  TaskAgentRuntimeAccess
} from '../AgentRuntimeStore';
import { AgentRuntimeArtifactMutationAmbiguousError } from '../AgentRuntimeStore';
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
  type InterruptAgentTurn,
  type ResolveAgentExecution,
  type ResolvedAgentExecution,
  type StartAgentRuntimeTurn,
  type StartedAgentRuntimeTurn,
  type StartAgentTurn
} from '../AgentRuntimeAdapter';
import type {
  AgentRuntimeTurnEvent,
  BuildAgentRuntimeExecutionContextInput
} from '../AgentRuntimeCoordinator';
import {
  REDACTED_CREDENTIAL,
  redactCredentialText,
  redactCredentialValue
} from '../AgentCredentialRedaction';
import { sensitiveEnvironmentValues } from '../ProviderEnvironmentPolicy';
import {
  appendRuntimeDiagnostic,
  createRuntimeReadiness,
  errorDiagnostic,
  infoDiagnostic,
  warningDiagnostic
} from '../AgentRuntimeReadiness';
import { agentServersRequiringLossRecovery } from '../AgentRuntimeRecovery';
import {
  assertAgentTurnAttachmentSelection,
  completeAttachmentSubmissions,
  type AgentTurnAttachment
} from '../AgentAttachmentDelivery';
import { interactionTerminalStatus } from '../AgentInteractionPolicy';
import {
  flattenSelectOptions,
  mergeAcpToolCallUpdate,
  parseConfigOptions,
  parseNewSessionResponse,
  parseParameterizedModelCatalog,
  parsePermissionRequest,
  parsePromptResponse,
  parseSessionModelExtension,
  parseSessionModelUpdateExtension,
  parseSessionNotification,
  parseSessionSetupResponse,
  type AcpInitializeResponse,
  type AcpJsonRpcRequest,
  type AcpParameterizedModelCatalog,
  type AcpPermissionOption,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionUpdate,
  type AcpStdioMcpServer,
  type AcpToolCallUpdate
} from './AcpProtocol';
import {
  AcpAmbiguousMutationError,
  type AcpRpcClient,
  type AcpRpcResult
} from './AcpRpcClient';
import {
  acpPermissionKindForAgentAction,
  acpThoughtLevelSelector,
  mapAcpPlanEntries,
  mapAcpStopReason,
  mapAcpToolKind,
  mapAcpToolStatus,
  observedSettingsFromAcpState,
  permissionOutcomeForDecision,
  requestedNativeConfigValues,
  textFromAcpContent
} from './AcpEventMapper';
import {
  assertAcpAttachmentKindsMapped,
  assertAcpAttachmentsSupported,
  prepareAcpAttachmentDelivery,
  sanitizeAcpAttachmentContent,
  type PreparedAcpAttachmentDelivery
} from './AcpAttachmentDelivery';
import type { AcpNativeSessionState } from './AcpNativeSession';
import {
  acpCapabilities,
  acpDesignSupport,
  acpImageInputSupport,
  acpModelInputModalities,
  defaultAcpModel,
  type AcpRuntimeProfile
} from './AcpRuntimeProfiles';
import {
  AcpRuntimeResolutionError,
  resolveAcpRuntime,
  type ResolveAcpRuntimeOptions,
  type ResolvedAcpRuntime
} from './AcpRuntimeResolver';
import {
  AcpStdioSupervisor,
  clientCapabilitiesForAcpProfile
} from './AcpStdioSupervisor';
import {
  materializeAcpPermission,
  selectAutomaticAcpPermissionOption
} from './AcpPermissionPolicy';
import { buildDesignAgentDeveloperInstructions } from '../../../shared/promptTemplates';
import {
  loadDesignSkillPack,
  type DesignSkillPack
} from '../../design/DesignSkillPack';
import type {
  DesignClientToolBridge,
  DesignClientToolMcpLaunch
} from '../../design/DesignClientToolBridge';
import { INSPECT_DESIGN_TOOL_NAME } from '../../design/DesignClientToolContract';
import {
  acpInitializeNativeView,
  hasSafeAcpModelIdentifiers,
  normalizeAcpOperationalModelState,
  normalizeAcpOperationalSession,
  redactAcpNativeValue,
  sanitizeAcpNativeSession
} from './AcpNativeRedaction';

/** A provider initialized ACP but violated the negotiated session contract. */
export class AcpSessionContractError extends Error {
  constructor(
    readonly operation: string,
    message: string
  ) {
    super(message);
    this.name = 'AcpSessionContractError';
  }
}

const PROMPT_OWNED_RUN_STATUSES: RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
];
const ACTIVE_RUN_STATUSES: RunRecord['status'][] = [
  ...PROMPT_OWNED_RUN_STATUSES,
  'RECOVERY_REQUIRED'
];
const INTERRUPT_COMPLETION_TIMEOUT_MS = 15_000;
const STREAM_OUTPUT_FLUSH_INTERVAL_MS = 75;
const STREAM_OUTPUT_FLUSH_BYTES = 64 * 1024;
const STREAM_TEXT_SEGMENT_BYTES = 8 * 1024;
const MAX_BUFFERED_OUTPUT_GROUPS = 256;
const MAX_BUFFERED_STREAM_PARTS_PER_RUN = 8;
const MAX_BUFFERED_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_OUTPUT_APPEND_ATTEMPTS = 3;
const MAX_STREAM_CREDENTIAL_CARRY_BYTES = 64 * 1024;
const MAX_STARTUP_EVENTS = 256;
const MAX_STARTUP_EVENT_BYTES = 4 * 1024 * 1024;
const ACP_DESIGN_MCP_SERVER_NAME = 'task-monki-design-tools';
const CURSOR_DESIGN_TOOL_TITLE = `${ACP_DESIGN_MCP_SERVER_NAME}: ${INSPECT_DESIGN_TOOL_NAME}`;
const GROK_DESIGN_TOOL_NAME = `${ACP_DESIGN_MCP_SERVER_NAME}__${INSPECT_DESIGN_TOOL_NAME}`;

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
  credentialCarries: Map<string, BufferedAcpCredentialCarry>;
  credentialCarryBytes: number;
  outputAppendFailures: number;
  persistenceRecoveryStarted: boolean;
  timer?: NodeJS.Timeout;
}

interface AcpRuntimeOutputBuffer {
  chunks: string[];
  byteCount: number;
  firstSequence: number;
  lastSequence: number;
  serverInstanceId: string;
  credentialCarry: string;
  truncated: boolean;
  timer?: NodeJS.Timeout;
}

interface BufferedAcpCredentialCarry {
  text: string;
  messageId: string;
  updateType: string;
  itemType: AgentItemRecord['type'];
  raw: AgentProtocolMessageReference;
}

interface AppliedAcpSessionSettings {
  state: AcpNativeSessionState;
  /**
   * The final provider response that acknowledged a requested configuration
   * mutation. This remains evidence for a Task Monki resolution; ACP does not
   * define that response as an authoritative settings observation.
   */
  finalMutationResponse?: AgentProtocolMessageReference;
}

interface ActiveAcpRuntimeTarget {
  session: AgentRuntimeSessionRecord;
  run: AgentRuntimeRunRecord;
}

type BufferedAcpStartupEvent =
  | {
      kind: 'notification';
      method: string;
      params: unknown;
      raw: AgentProtocolMessageReference;
    }
  | {
      kind: 'request';
      request: AcpJsonRpcRequest;
      raw: AgentProtocolMessageReference;
    };

interface BufferedAcpStartupDispatch {
  client: AcpRpcClient;
  generation: number;
  events: BufferedAcpStartupEvent[];
  byteCount: number;
  overflow?: Error;
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
  designSkillRoot?: string;
  designClientToolBridge?: Pick<
    DesignClientToolBridge,
    'createSessionGrant' | 'activateGrant' | 'revokeGrant' | 'releaseSessionGrant'
  >;
}

interface AcpDesignToolGrant {
  grantId: string;
  providerGeneration: string;
  worktreeId: string;
  launch: DesignClientToolMcpLaunch;
}

interface AcpDesignSessionContext {
  localSessionId: string;
  worktreeId: string;
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
  private clientGeneration = 0;
  private boundClientGeneration = 0;
  private startupDispatch?: BufferedAcpStartupDispatch;
  private initializeResponse?: AcpInitializeResponse;
  private profileModelState?: AcpSessionModelState;
  private parameterizedModelCatalog?: AcpParameterizedModelCatalog;
  private parameterizedModelDiscovery?: Promise<void>;
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
  private runtimeOutputBuffers = new Map<string, AcpRuntimeOutputBuffer>();
  private activeRuntimePromptRunIds = new Set<string>();
  private readonly runtimeTurnListeners = new Set<
    (event: AgentRuntimeTurnEvent) => void
  >();
  private readonly interruptCompletionTimeoutMs: number;
  private configuredExecutable?: string;
  private runtimeReconfigurationPending = false;
  private runtimeResetTimer?: NodeJS.Timeout;
  private runtimeQuarantinePromise?: Promise<void>;
  private clientReplacementFence?: {
    serverInstanceId: string;
    tail: Promise<void>;
  };
  private runtimeSafetyFence?: Error;
  private readonly sensitiveValues: readonly string[];
  private designSkillPack?: DesignSkillPack;
  private designSkillFailure?: string;
  private designSkillLoadAttempted = false;
  private readonly designToolGrants = new Map<string, AcpDesignToolGrant>();

  constructor(
    private readonly taskRuntime: TaskAgentRuntimeAccess,
    private readonly providerRuntime: AgentRuntimeStore,
    private readonly appEvents: AppEventBus,
    readonly profile: AcpRuntimeProfile,
    private readonly options: AcpRuntimeAdapterOptions
  ) {
    this.descriptor = profile.descriptor;
    this.sensitiveValues = sensitiveEnvironmentValues(
      profile.environmentPolicy,
      options.environment ?? process.env
    );
    this.interruptCompletionTimeoutMs =
      options.interruptCompletionTimeoutMs ?? INTERRUPT_COMPLETION_TIMEOUT_MS;
    this.configuredExecutable = normalizeExecutableOverride(options.executable);
    this.models = [defaultAcpModel(profile)];
    this.preflightState = {
      runtime: profile.descriptor,
      readiness: createRuntimeReadiness(
        'INITIALIZING',
        `${profile.descriptor.displayName} has not been initialized.`,
        { checks: { initialization: 'NOT_STARTED' } }
      ),
      capabilities: acpCapabilities(profile),
    };
  }

  async initialize(): Promise<void> {
    if (this.runtimeSafetyFence) throw this.runtimeSafetyFence;
    if (this.initialized) {
      if (this.supervisor?.safetyFenceReason) {
        throw (
          new Error(
            `ACP runtime cannot restart because its previous shutdown was not confirmed: ${this.supervisor.safetyFenceReason}`
          )
        );
      }
      return;
    }
    this.initialized = true;
    try {
      await this.prepareDesignSkillPack();
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
      if (
        !this.supervisor?.currentClient &&
        ![
          'FAILED',
          'INCOMPATIBLE',
          'AUTHENTICATION_REQUIRED',
          'ACCOUNT_UNSUPPORTED'
        ].includes(this.preflightState.readiness.status)
      ) {
        this.setDiscoveryPreflight(runtime);
      }
    } catch (cause) {
      this.preflightState = {
        runtime: this.descriptor,
        readiness: acpFailureReadiness(this.profile, cause, this.sensitiveValues),
        capabilities: this.currentCapabilities(),
      };
    }
    return structuredClone(this.preflightState);
  }

  capabilities(): Promise<AgentRuntimeCapabilities> {
    return Promise.resolve(this.currentCapabilities());
  }

  async listModels(): Promise<AgentModel[]> {
    if (!this.initialized) await this.initialize();
    await this.ensureResolvedRuntime();
    const modelExtension = this.profile.sessionModelExtension;
    if (modelExtension?.initializeResponseMetaField && !this.profileModelState) {
      await this.ensureClient();
    }
    return structuredClone(this.models);
  }

  async buildExecutionContext(
    input: BuildAgentRuntimeExecutionContextInput
  ): Promise<AgentExecutionContext> {
    const policy = requireAcpReadOnlyTurnPolicy(this.profile);
    const primaryCwd = path.resolve(input.primaryCwd);
    const readRoots = input.readRoots
      .map((root) => ({ ...root, canonicalPath: path.resolve(root.canonicalPath) }))
      .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
    const modelSettings = acpReadOnlyExecutionSettings(
      this.profile,
      input.modelSettings
    );
    assertAcpExecutionPolicy(this.profile, modelSettings);
    return {
      attestation: { status: 'ATTESTED' },
      primaryCwd,
      repositoryAccess: 'READ_ONLY',
      readRoots,
      managedAttachments: [],
      permissionProfileHash: acpReadOnlyProfileHash({
        runtimeId: this.descriptor.id,
        sessionId: input.sessionId,
        policyId: policy.policyId,
        primaryCwd,
        readRoots,
        modelSettings
      }),
      modelSettings,
      externalTools: {
        // The ACP process needs provider network access. No web, MCP, app, or
        // client tool is exposed by Task Monki for this turn.
        network: true,
        webSearch: 'disabled',
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: input.clientOperationId
    };
  }

  onRuntimeTurnEvent(listener: (event: AgentRuntimeTurnEvent) => void): () => void {
    this.runtimeTurnListeners.add(listener);
    return () => this.runtimeTurnListeners.delete(listener);
  }

  async discoverModels(): Promise<void> {
    const contract = this.profile.parameterizedModelCatalog;
    if (!contract || this.parameterizedModelCatalog) return;
    if (!this.parameterizedModelDiscovery) {
      this.parameterizedModelDiscovery = this.discoverParameterizedModels(contract)
        .finally(() => {
          this.parameterizedModelDiscovery = undefined;
        });
    }
    await this.parameterizedModelDiscovery;
  }

  private async discoverParameterizedModels(
    contract: NonNullable<AcpRuntimeProfile['parameterizedModelCatalog']>
  ): Promise<void> {
    if (!this.initialized) await this.initialize();
    const client = await this.ensureClient();
    const generation = this.boundClientGeneration;
    try {
      const response = await client.request<unknown>(contract.listModelsMethod, {});
      const catalog = parseParameterizedModelCatalog(response.result);
      if (!catalog.models.some((model) => model.value === this.profile.defaultModel)) {
        throw new Error(
          `${this.descriptor.displayName} model catalog omitted its required ${this.profile.defaultModel} default.`
        );
      }
      if (
        this.boundClient !== client ||
        this.boundClientGeneration !== generation
      ) {
        throw new Error(
          `${this.descriptor.displayName} model discovery completed for a superseded ACP process.`
        );
      }
      if (containsSensitiveProviderValue(catalog, this.sensitiveValues)) {
        this.noteSensitiveIdentifierOmission();
        throw new Error(
          `${this.descriptor.displayName} model catalog contained a value matching a runtime credential.`
        );
      }
      this.parameterizedModelCatalog = catalog;
      this.refreshModels();
      this.setConnectedPreflight();
      this.emitRuntimeUpdate();
    } catch (cause) {
      if (
        this.boundClient === client &&
        this.boundClientGeneration === generation
      ) {
        this.setParameterizedModelDiscoveryFailure(cause);
      }
      throw cause;
    }
  }

  private setParameterizedModelDiscoveryFailure(cause: unknown): void {
    this.invalidateParameterizedModelCatalog();
    const classified = acpSessionFailureReadiness(
      this.profile,
      cause,
      this.preflightState.readiness.checks,
      true,
      this.sensitiveValues
    );
    const authenticationFailure =
      classified.status === 'AUTHENTICATION_REQUIRED' ||
      classified.status === 'ACCOUNT_UNSUPPORTED';
    const detail = this.redactProviderText(errorMessage(cause));
    this.preflightState = {
      ...this.preflightState,
      readiness: authenticationFailure
        ? classified
        : createRuntimeReadiness(
            'FAILED',
            `${this.descriptor.displayName} model discovery failed.`,
            {
              checks: {
                ...this.preflightState.readiness.checks,
                discovery: 'FOUND',
                compatibility: 'COMPATIBLE',
                initialization: 'INITIALIZED',
                modelCatalog: 'FAILED'
              },
              diagnostics: [
                ...acpRuntimeDiagnostics(
                  Boolean(this.initializeResponse?.authMethods.length)
                ),
                errorDiagnostic('MODEL_CATALOG_FAILED', 'MODEL_CATALOG', detail)
              ],
              nextAction: { kind: 'RETRY', label: 'Retry model discovery' }
            }
          ),
      capabilities: this.currentCapabilities()
    };
    this.emitRuntimeUpdate();
  }

  private setConnectedPreflight(): void {
    const initialize = this.initializeResponse;
    if (!initialize) {
      throw new Error(`${this.descriptor.displayName} lost its ACP initialize state.`);
    }
    const hasProfileCatalog =
      this.models.length > 0 &&
      Boolean(
        (this.profile.sessionModelExtension?.initializeResponseMetaField &&
          this.profileModelState) ||
          (this.profile.parameterizedModelCatalog && this.parameterizedModelCatalog)
      );
    const authenticationAdvertised = initialize.authMethods.length > 0;
    this.preflightState = {
      runtime: this.descriptor,
      readiness: createRuntimeReadiness(
        'DISCOVERED',
        'ACP v1 is connected. The first provider session will verify account and model access.',
        {
          summary: 'Connected; session pending',
          checks: {
            discovery: 'FOUND',
            compatibility: 'COMPATIBLE',
            initialization: 'INITIALIZED',
            authentication: authenticationAdvertised ? 'PROVIDER_MANAGED' : 'UNKNOWN',
            modelCatalog: hasProfileCatalog ? 'AVAILABLE' : 'UNKNOWN'
          },
          diagnostics: acpRuntimeDiagnostics(authenticationAdvertised)
            .concat(this.imageInputDiagnostics())
        }
      ),
      capabilities: this.currentCapabilities(),
      runtimeVersion:
        this.supervisor?.currentServer?.runtimeVersion ?? this.resolvedRuntime?.version,
      accountLabel:
        this.redactProviderText(initialize.agentInfo?.title ?? initialize.agentInfo?.name ?? '') ||
        undefined
    };
  }

  private imageInputDiagnostics(): AgentRuntimeDiagnostic[] {
    const initialize = this.initializeResponse;
    if (!initialize || this.models.length === 0) return [];
    const promptCapabilities = initialize.agentCapabilities.promptCapabilities;
    const runtimeVersion = this.resolvedRuntime?.version;
    const decisions = this.models.map((model) => ({
      model,
      support: acpImageInputSupport({
        profile: this.profile,
        promptCapabilities,
        runtimeVersion,
        modelId: model.model
      })
    }));
    const drift = decisions.filter(({ support }) => support.capabilityDrift);
    const unavailable = decisions.filter(({ support }) => !support.enabled);
    const diagnostics: AgentRuntimeDiagnostic[] = [];
    if (drift.length > 0) {
      diagnostics.push(
        warningDiagnostic(
          'ACP_IMAGE_CAPABILITY_DRIFT',
          'COMPATIBILITY',
          `${this.descriptor.displayName} reports no ACP image support, but an exact packaged image test passed.`,
          `Task Monki enables native image input only for ${drift.map(({ model }) => model.displayName).join(', ')} on ${runtimeVersion ?? 'the qualified runtime'}. Other versions and models remain disabled.`
        )
      );
    }
    if (unavailable.length > 0) {
      const reasons = unavailable
        .slice(0, 3)
        .map(({ support }) => support.unavailableReason)
        .filter((reason): reason is string => Boolean(reason));
      diagnostics.push(
        infoDiagnostic(
          'ACP_IMAGE_INPUT_UNQUALIFIED',
          'MODEL_CATALOG',
          `${unavailable.length} current ${this.descriptor.displayName} model${unavailable.length === 1 ? ' is' : 's are'} not image-qualified.`,
          `${reasons.join(' ')}${unavailable.length > reasons.length ? ` ${unavailable.length - reasons.length} more current models remain disabled.` : ''}`
        )
      );
    }
    return diagnostics;
  }

  async readNativeState(): Promise<import('../../../shared/agent').AgentJsonValue> {
    const liveSessions = [...this.nativeSessions.values()].flatMap((state) => {
      if (!isSafeProviderIdentifier(state.sessionId, this.sensitiveValues)) {
        this.noteSensitiveIdentifierOmission();
        return [];
      }
      if (hasUnsafeAcpActionableIdentifier(state, this.sensitiveValues)) {
        this.noteSensitiveIdentifierOmission();
      }
      return [sanitizeAcpNativeSession(state, this.sensitiveValues)];
    });
    return this.redactProviderValue(redactAcpNativeValue({
      protocol: { wireVersion: 1, schemaArtifactVersion: '1.19.0' },
      initialize: acpInitializeNativeView(this.initializeResponse, this.sensitiveValues),
      clientCapabilities: clientCapabilitiesForAcpProfile(this.profile),
      sessions: liveSessions
    }));
  }

  async listSessionControls(): Promise<AgentSessionControlSet[]> {
    const snapshot = await this.taskRuntime.snapshot();
    return snapshot.agentSessions
      .filter(
        (session) =>
          session.runtimeId === this.descriptor.id &&
          session.providerSessionId &&
          this.nativeSessions.has(session.providerSessionId)
      )
      .flatMap((session) => {
        const state = this.nativeSessions.get(session.providerSessionId!);
        if (!state) return [];
        const controls = acpSessionControlSet(
          session.id,
          state,
          this.sensitiveValues
        );
        if (!controls) {
          this.noteSensitiveIdentifierOmission();
          return [];
        }
        if (hasUnsafeAcpActionableIdentifier(state, this.sensitiveValues)) {
          this.noteSensitiveIdentifierOmission();
        }
        return [controls];
      });
  }

  async applySessionControl(input: {
    localSessionId: string;
    controlId: string;
    value: AgentSessionControlValue;
    revision: string;
  }): Promise<{
    native: import('../../../shared/agent').AgentJsonValue;
    controls: AgentSessionControlSet;
  }> {
    const session = await this.requireSession(input.localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) {
      throw new Error(`Agent session ${session.id} has no provider session ID.`);
    }
    const state = this.nativeSessions.get(session.providerSessionId);
    if (!state) {
      throw new Error(`ACP session ${session.providerSessionId} is not loaded.`);
    }
    const currentControls = acpSessionControlSet(
      session.id,
      state,
      this.sensitiveValues
    );
    if (!currentControls) {
      this.noteSensitiveIdentifierOmission();
      throw new Error('Provider session controls contain a sensitive operational identifier.');
    }
    if (input.revision !== currentControls.revision) {
      throw new Error(
        'Provider session controls changed before this update. Refresh and choose again.'
      );
    }
    const control = currentControls.controls.find(
      (candidate) => candidate.id === input.controlId
    );
    if (!control || !control.mutable) {
      throw new Error(`Provider session control ${input.controlId} is unavailable.`);
    }
    if (control.kind === 'BOOLEAN' && typeof input.value !== 'boolean') {
      throw new Error(`Provider session control ${input.controlId} requires a boolean value.`);
    }
    if (
      control.kind === 'SELECT' &&
      (typeof input.value !== 'string' ||
        !control.choices.some((choice) => choice.value === input.value))
    ) {
      throw new Error(`Provider session control ${input.controlId} received an invalid choice.`);
    }

    let native: import('../../../shared/agent').AgentJsonValue;
    if (input.controlId === 'model') {
      native = await this.applyNativeSessionModel(session.id, input.value as string);
    } else if (input.controlId === 'mode') {
      native = await this.applyNativeSessionMode(session.id, input.value as string);
    } else if (input.controlId.startsWith('config:')) {
      native = await this.applyNativeSessionConfigOption(
        session.id,
        input.controlId.slice('config:'.length),
        input.value
      );
    } else {
      throw new Error(`Unknown provider session control ${input.controlId}.`);
    }
    const updated = this.nativeSessions.get(session.providerSessionId);
    if (!updated) throw new Error(`ACP session ${session.providerSessionId} was unloaded.`);
    const updatedControls = acpSessionControlSet(
      session.id,
      updated,
      this.sensitiveValues
    );
    if (!updatedControls) {
      this.noteSensitiveIdentifierOmission();
      throw new Error('Updated provider controls contain a sensitive operational identifier.');
    }
    return {
      native: this.redactProviderValue(native),
      controls: updatedControls
    };
  }

  async configureRuntime(input: { executable?: string; restart: boolean }): Promise<void> {
    await this.waitForRuntimeQuarantine();
    const executable = normalizeExecutableOverride(input.executable);
    const changed = executable !== this.configuredExecutable;
    this.configuredExecutable = executable;
    if (!changed && !input.restart) return;

    if (await this.hasUnsafeRuntimeWork()) {
      this.runtimeReconfigurationPending = true;
      this.preflightState = appendRuntimeDiagnostic(
        this.preflightState,
        warningDiagnostic(
          'RUNTIME_RESTART_REQUIRED',
          'CONFIGURATION',
          'The ACP executable change is saved and will be applied after the current provider turn reaches a definitive terminal state.'
        )
      );
      this.emitRuntimeUpdate();
      return;
    }
    await this.resetRuntimeForConfiguration();
  }

  async resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution> {
    const requestedSettings = normalizeAcpReadOnlyExecutionSettings(
      this.profile,
      input.settings
    );
    assertAcpExecutionPolicy(this.profile, requestedSettings);
    if (
      (requestedSettings.model &&
        !isSafeProviderIdentifier(requestedSettings.model, this.sensitiveValues)) ||
      (requestedSettings.modelProvider &&
        !isSafeProviderIdentifier(requestedSettings.modelProvider, this.sensitiveValues)) ||
      (requestedSettings.reasoningEffort &&
        !isSafeProviderIdentifier(requestedSettings.reasoningEffort, this.sensitiveValues))
    ) {
      throw new Error(
        'ACP rejected a model selection whose operational identifier matches a runtime credential.'
      );
    }
    assertAcpAttachmentKindsMapped(this.profile, input.attachments);
    await this.ensureResolvedRuntime();
    if (input.attachments.length > 0) await this.ensureClient();
    const modelExtension = this.profile.sessionModelExtension;
    if (
      modelExtension?.initializeResponseMetaField &&
      !this.profileModelState
    ) {
      // A profile-owned model catalog is authoritative. Resolve execution
      // only after it has replaced the provisional profile model so a missing
      // or malformed provider catalog can never become an executable fallback.
      await this.ensureClient();
    }
    const requestedModel = requestedSettings.model;
    const requestedProvider = requestedSettings.modelProvider;
    const extensionCatalogContract =
      modelExtension?.initializeResponseMetaField && this.profileModelState
        ? modelExtension
        : undefined;
    const authoritativeCatalog = extensionCatalogContract
      ? `its ${extensionCatalogContract.contractId} provider catalog`
      : this.profile.parameterizedModelCatalog && this.parameterizedModelCatalog
        ? `its ${this.profile.parameterizedModelCatalog.contractId} provider catalog`
        : undefined;
    const authoritativeModels = authoritativeCatalog
      ? this.models
      : undefined;
    const providerModels =
      authoritativeModels && requestedProvider
        ? authoritativeModels.filter(
            (candidate) => candidate.modelProvider === requestedProvider
          )
        : authoritativeModels ?? this.models;
    if (
      authoritativeCatalog &&
      requestedProvider &&
      providerModels.length === 0
    ) {
      throw new Error(
        `${this.descriptor.displayName} did not advertise model provider ${requestedProvider} in ${authoritativeCatalog}.`
      );
    }
    if (
      authoritativeCatalog &&
      requestedModel &&
      requestedModel !== 'default' &&
      !providerModels.some(
        (candidate) =>
          candidate.id === requestedModel || candidate.model === requestedModel
      )
    ) {
      throw new Error(
        `${this.descriptor.displayName} did not advertise model ${requestedModel} in ${authoritativeCatalog}.`
      );
    }
    let model =
      providerModels.find((candidate) => candidate.id === requestedModel) ??
      providerModels.find((candidate) => candidate.model === requestedModel) ??
      providerModels.find((candidate) => candidate.isDefault) ??
      providerModels[0];
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
        id: `${this.descriptor.id}:${requestedSettings.modelProvider ?? this.profile.defaultModelProvider}/${requestedModel}`,
        model: requestedModel,
        displayName: requestedModel,
        inputModalities: this.modelInputModalities(requestedModel),
        designSupport: acpDesignSupport({
          profile: this.profile,
          runtimeVersion: this.resolvedRuntime?.version,
          modelId: requestedModel
        }),
        isDefault: false,
        native: { source: 'explicit-runtime-setting' }
      };
    }
    assertAcpAttachmentsSupported({
      profile: this.profile,
      initialize: this.initializeResponse,
      runtimeVersion: this.resolvedRuntime?.version,
      model,
      attachments: input.attachments
    });
    const reasoningEffort = requestedSettings.reasoningEffort;
    if (
      reasoningEffort &&
      (authoritativeCatalog || model.supportedReasoningEfforts.length > 0) &&
      !model.supportedReasoningEfforts.includes(reasoningEffort)
    ) {
      throw new Error(
        `${this.descriptor.displayName} model ${model.model} does not advertise reasoning effort ${reasoningEffort}.`
      );
    }
    const settings = normalizeAcpReadOnlyExecutionSettings(this.profile, {
      ...requestedSettings,
      runtimeId: this.descriptor.id,
      model: model.model,
      modelProvider: authoritativeCatalog
        ? model.modelProvider
        : requestedSettings.modelProvider ?? model.modelProvider,
      reasoningEffort
    });
    return { settings, model };
  }

  private async prepareAttachmentDelivery(input: {
    settings: AgentExecutionSettings;
    prompt: string;
    attachments: readonly AgentTurnAttachment[];
  }): Promise<PreparedAcpAttachmentDelivery> {
    const resolved = await this.resolveExecution({
      settings: input.settings,
      attachments: input.attachments
    });
    return prepareAcpAttachmentDelivery({
      profile: this.profile,
      initialize: this.initializeResponse,
      runtimeVersion: this.resolvedRuntime?.version,
      model: resolved.model,
      prompt: input.prompt,
      attachments: input.attachments
    });
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    await this.waitForRuntimeQuarantine();
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

    const created = await this.createNativeSession(
      input.worktreePath,
      this.designSessionContextForCreate(input, local)
    );
    return this.completeCreatedSession(
      local,
      created.state,
      input.settings,
      created.client,
      created.raw
    );
  }

  private async createNativeSession(
    cwd: string,
    design?: AcpDesignSessionContext
  ): Promise<{
    client: AcpRpcClient;
    state: AcpNativeSessionState;
    raw: AgentProtocolMessageReference;
  }> {
    const client = await this.ensureClient();
    const mcpServers = design
      ? [await this.prepareDesignMcpServer(design)]
      : [];
    let response: AcpRpcResult<unknown>;
    try {
      response = await this.requestBoundedMutation(
        client,
        'session/new',
        { cwd, mcpServers },
        'The provider may have created a session, but its identity was not confirmed.'
      );
    } catch (cause) {
      if (design) await this.releaseDesignToolGrantSafely(design.localSessionId);
      const error = mapMutationError('session/new', cause);
      this.setSessionFailurePreflight(error);
      throw error;
    }
    let state: AcpNativeSessionState;
    try {
      const setup = parseNewSessionResponse(response.result);
      state = normalizeAcpOperationalSession({
        sessionId: setup.sessionId,
        modes: setup.modes ?? null,
        models: this.parseSessionModels(response.result),
        configOptions: setup.configOptions ?? []
      });
    } catch (cause) {
      const error = new AcpSessionContractError(
        'session/new',
        `${this.descriptor.displayName} returned an invalid ACP session/new response: ${errorMessage(cause)}`
      );
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/new',
        'The provider created an unreadable session, so this ACP process is incompatible and cannot be reused.'
      );
      this.setSessionFailurePreflight(error);
      throw error;
    }
    if (!isSafeProviderIdentifier(state.sessionId, this.sensitiveValues)) {
      const error = new AcpSessionContractError(
        'session/new',
        'The ACP agent returned a session identifier matching a runtime credential.'
      );
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/new',
        'The provider created a session whose identifier cannot be persisted safely.'
      );
      this.setSessionFailurePreflight(error);
      throw error;
    }
    this.nativeSessions.set(state.sessionId, state);
    return { client, state, raw: response.raw };
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
    const initialObservedSettings = this.projectObservedSettings(state, settings);
    let initialStored: AgentSessionRecord;
    try {
      // Persist provider ownership before issuing follow-up configuration
      // mutations. A failed mode/model update can then resume this exact
      // session instead of creating an orphan or duplicating it on retry.
      initialStored = await this.taskRuntime.updateAgentSession(local.id, {
        providerSessionId: state.sessionId,
        status: 'NOT_LOADED',
        requestedSettings: settings,
        observedSettings: initialObservedSettings,
        lastAttachedAt: new Date().toISOString()
      }, acpRuntimeOperationId('session/create-ownership', local.id, state.sessionId));
    } catch (cause) {
      const ambiguity = new AgentMutationAmbiguousError(
        'session/new',
        `ACP created session ${state.sessionId}, but Task Monki could not persist its ownership: ${errorMessage(cause)}`
      );
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/new',
        `Provider session ${state.sessionId} was created, but its ownership was not durably recorded.`
      );
      throw ambiguity;
    }
    if (raw) {
      try {
        await this.recordSettingsObservation(
          initialStored,
          'THREAD_START_RESPONSE',
          initialObservedSettings,
          raw,
          'ACP session/new reported the provider-selected state before Task Monki applied requested session configuration.'
        );
      } catch (cause) {
        await this.quarantineRuntimeAfterAmbiguousMutation(
          'session/new',
          `Provider session ${state.sessionId} was created, but its initial observed state was not durably recorded.`
        );
        throw new AgentMutationAmbiguousError(
          'session/new',
          `ACP created session ${state.sessionId}, but Task Monki could not persist its initial observed state: ${errorMessage(cause)}`
        );
      }
    }
    this.emitRuntimeUpdate();
    const applied = await this.applyRequestedNativeSettings(client, state, settings);
    state = applied.state;
    const observedSettings = this.projectObservedSettings(state, settings);
    let stored: AgentSessionRecord;
    try {
      stored = await this.taskRuntime.updateAgentSession(local.id, {
        status: 'IDLE',
        requestedSettings: settings,
        observedSettings,
        lastAttachedAt: new Date().toISOString()
      }, acpRuntimeOperationId('session/create-configured', local.id, state.sessionId, observedSettings));
      await this.recordSettingsObservation(
        stored,
        'TASK_MONKI_RESOLUTION',
        observedSettings,
        applied.finalMutationResponse,
        applied.finalMutationResponse
          ? 'Task Monki projected the requested ACP settings after the provider acknowledged the final session configuration mutation. The cited response is mutation evidence, not a provider settings observation.'
          : 'Task Monki resolved the requested ACP settings after session setup without a provider settings response.'
      );
    } catch (cause) {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/configure',
        `Provider session ${state.sessionId} was configured, but its observed state was not durably recorded.`
      );
      throw new AgentMutationAmbiguousError(
        'session/configure',
        `ACP configured session ${state.sessionId}, but Task Monki could not persist its observed state: ${errorMessage(cause)}`
      );
    }
    this.provisionalProviderSessionIds.delete(local.id);
    this.refreshModels();
    this.setOperationalPreflight(state);
    this.emitRuntimeUpdate();
    return stored;
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    await this.waitForRuntimeQuarantine();
    const session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    const providerSessionId = ref.providerSessionId ?? session.providerSessionId;
    if (!providerSessionId) {
      throw new AgentProviderSessionMissingError(
        'session/attach',
        `ACP session ${session.id} has no provider session ID.`
      );
    }
    if (!isSafeProviderIdentifier(providerSessionId, this.sensitiveValues)) {
      this.noteSensitiveIdentifierOmission();
      throw new Error(
        'The persisted ACP session identifier matches a runtime credential and cannot be attached safely.'
      );
    }
    const existing = this.nativeSessions.get(providerSessionId);
    if (existing) {
      const stored = await this.taskRuntime.updateAgentSession(session.id, {
        providerSessionId,
        status: 'IDLE',
        observedSettings: this.projectObservedSettings(
          existing,
          session.requestedSettings
        ),
        lastAttachedAt: new Date().toISOString()
      }, acpRuntimeOperationId('session/attach-loaded', session.id, providerSessionId));
      this.provisionalProviderSessionIds.delete(session.id);
      this.setOperationalPreflight(existing);
      this.emitRuntimeUpdate();
      return stored;
    }

    const loaded = await this.loadNativeSession(
      providerSessionId,
      session.worktreePath,
      await this.designSessionContextForAttach(session)
    );
    const { state, response } = loaded;
    const observedSettings = this.projectObservedSettings(
      state,
      session.requestedSettings
    );
    const stored = await this.taskRuntime.updateAgentSession(session.id, {
      providerSessionId,
      status: 'IDLE',
      materialized: true,
      observedSettings,
      lastAttachedAt: new Date().toISOString()
    }, acpProtocolOperationId('session/attach', response.raw, session.id, providerSessionId));
    this.provisionalProviderSessionIds.delete(session.id);
    await this.recordSettingsObservation(
      stored,
      'THREAD_RESUME_RESPONSE',
      observedSettings,
      response.raw
    );
    this.setOperationalPreflight(state);
    this.emitRuntimeUpdate();
    return stored;
  }

  private async loadNativeSession(
    providerSessionId: string,
    cwd: string,
    design?: AcpDesignSessionContext
  ): Promise<{
    client: AcpRpcClient;
    state: AcpNativeSessionState;
    method: 'session/resume' | 'session/load';
    response: AcpRpcResult<unknown>;
  }> {
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
    const mcpServers = design
      ? [await this.prepareDesignMcpServer(design)]
      : [];
    let response: AcpRpcResult<unknown>;
    if (method === 'session/load') this.replayingProviderSessionIds.add(providerSessionId);
    try {
      response = await this.requestBoundedMutation(
        client,
        method,
        { sessionId: providerSessionId, cwd, mcpServers },
        `The outcome of loading provider session ${providerSessionId} could not be confirmed.`
      );
    } catch (cause) {
      if (design) await this.releaseDesignToolGrantSafely(design.localSessionId);
      const error = mapMutationError(method, cause);
      this.setSessionFailurePreflight(error);
      throw error;
    } finally {
      // session/load streams historical session/update records before its
      // response. Drain already-enqueued updates while the replay guard is set
      // so history cannot be mistaken for output from a live run.
      await this.inboundQueue;
      this.replayingProviderSessionIds.delete(providerSessionId);
    }
    let state: AcpNativeSessionState;
    try {
      const setup = parseSessionSetupResponse(response.result);
      state = normalizeAcpOperationalSession({
        sessionId: providerSessionId,
        modes: setup.modes ?? null,
        models: this.parseSessionModels(response.result),
        configOptions: setup.configOptions ?? []
      });
    } catch (cause) {
      const error = new AcpSessionContractError(
        method,
        `${this.descriptor.displayName} returned an invalid ACP ${method} response: ${errorMessage(cause)}`
      );
      await this.quarantineRuntimeAfterAmbiguousMutation(
        method,
        `Provider session ${providerSessionId} could not be authoritatively loaded from the response.`
      );
      this.setSessionFailurePreflight(error);
      throw error;
    }
    this.nativeSessions.set(providerSessionId, state);
    return { client, state, method, response };
  }

  async releaseSession(ref: AgentSessionRef): Promise<void> {
    await this.waitForRuntimeQuarantine();
    // A terminal run projection can become visible before its serialized
    // inbound handler finishes the corresponding session update. Drain that
    // queue so release state cannot be overwritten by a late terminal write.
    await this.inboundQueue;
    const runtimeSession = await this.providerRuntime.getSession(ref.localSessionId);
    if (runtimeSession && isAcpReadOnlyRuntimeSession(runtimeSession, this.profile)) {
      await this.releaseRuntimeSession(runtimeSession, ref.providerSessionId);
      return;
    }
    const session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    const snapshot = await this.taskRuntime.snapshot();
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
    await this.releaseDesignToolGrantSafely(session.id);
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
      await this.requestBoundedMutation(
        client,
        'session/close',
        { sessionId: providerSessionId },
        `The outcome of closing provider session ${providerSessionId} could not be confirmed.`
      );
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
    await this.taskRuntime.updateAgentSession(
      session.id,
      { status: 'NOT_LOADED' },
      acpRuntimeOperationId(
        'session/release',
        session.id,
        providerSessionId,
        session.updatedAt,
        this.supervisor?.currentServer?.id
      )
    );
    this.refreshModels();
    this.emitRuntimeUpdate();
    await this.stopUnusedRuntimeProcess();
  }

  private async releaseRuntimeSession(
    initialSession: AgentRuntimeSessionRecord,
    requestedProviderSessionId?: string
  ): Promise<void> {
    const activeRun = await this.providerRuntime.getActiveRunForSession(initialSession.id);
    if (activeRun) {
      throw new Error(
        `Cannot release ACP runtime session ${initialSession.id} while run ${activeRun.id} is ${activeRun.status}.`
      );
    }
    const providerSessionId =
      requestedProviderSessionId ?? initialSession.providerSessionId;
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
        await this.requestBoundedMutation(
          client,
          'session/close',
          { sessionId: providerSessionId },
          `The outcome of closing provider session ${providerSessionId} could not be confirmed.`
        );
      } catch (cause) {
        throw runtimeDeliveryErrorForAcp('session/close', cause);
      }
    }
    if (providerSessionId) {
      this.nativeSessions.delete(providerSessionId);
      this.replayingProviderSessionIds.delete(providerSessionId);
    }
    const session =
      (await this.providerRuntime.getSession(initialSession.id)) ?? initialSession;
    await this.updateRuntimeSession(
      session.id,
      {
        status: 'NOT_LOADED'
      },
      acpRuntimeOperationId(
        'runtime/session-release',
        session.id,
        providerSessionId,
        session.recordRevision
      )
    );
    this.refreshModels();
    this.emitRuntimeUpdate();
    await this.stopUnusedRuntimeProcess();
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
    const session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    const snapshot = await this.taskRuntime.snapshot();
    return {
      session,
      runs: snapshot.runs
        .filter((run) => run.sessionId === session.id)
        .map((run) => ({ id: run.id, providerTurnId: run.providerTurnId, status: run.status }))
    };
  }

  async startRuntimeTurn(
    input: StartAgentRuntimeTurn
  ): Promise<StartedAgentRuntimeTurn> {
    await this.waitForRuntimeQuarantine();
    const policy = requireAcpReadOnlyTurnPolicy(this.profile);
    if (
      input.run.sessionId !== input.session.id ||
      input.session.runtimeId !== this.descriptor.id ||
      !isAcpReadOnlyRuntimeSession(input.session, this.profile) ||
      input.executionContext.attestation.status !== 'ATTESTED' ||
      input.executionContext.repositoryAccess !== 'READ_ONLY' ||
      input.executionContext.managedAttachments.length > 0 ||
      !input.executionContext.externalTools.network ||
      input.executionContext.externalTools.webSearch !== 'disabled' ||
      input.executionContext.externalTools.mcpServers ||
      input.executionContext.externalTools.apps ||
      input.executionContext.externalTools.dynamicTools
    ) {
      throw new Error('ACP runtime turn ownership does not match its durable session.');
    }
    const expectedSettings = acpReadOnlyExecutionSettings(
      this.profile,
      input.executionContext.modelSettings
    );
    const expectedHash = acpReadOnlyProfileHash({
      runtimeId: this.descriptor.id,
      sessionId: input.session.id,
      policyId: policy.policyId,
      primaryCwd: input.executionContext.primaryCwd,
      readRoots: input.executionContext.readRoots,
      modelSettings: expectedSettings
    });
    if (expectedHash !== input.executionContext.permissionProfileHash) {
      throw new Error('ACP read-only policy does not match the attested execution context.');
    }
    let attachmentDelivery: PreparedAcpAttachmentDelivery;
    try {
      assertAgentTurnAttachmentSelection(
        input.run.attachmentSelection,
        input.attachments
      );
      attachmentDelivery = await this.prepareAttachmentDelivery({
        settings: expectedSettings,
        prompt: input.prompt,
        attachments: input.attachments
      });
    } catch (cause) {
      throw runtimeDeliveryErrorForAcp('ACP attachment preparation', cause);
    }
    const materialized = await this.materializeRuntimeSession(
      input.session,
      expectedSettings
    );
    const server = this.supervisor?.currentServer;
    if (!server || materialized.client.serverInstanceId !== server.id) {
      throw new AgentRuntimeDeliveryError(
        'NOT_DELIVERED',
        'The ACP process changed before the read-only prompt could start.'
      );
    }

    this.activePromptRunIds.add(input.run.id);
    this.activeRuntimePromptRunIds.add(input.run.id);
    let started: ReturnType<AcpRpcClient['startMutation']> extends Promise<infer Value>
      ? Value
      : never;
    try {
      started = await materialized.client.startMutation<unknown>(
        'session/prompt',
        {
          sessionId: materialized.state.sessionId,
          prompt: attachmentDelivery.prompt
        },
        { timeoutMs: null }
      );
    } catch (cause) {
      this.activePromptRunIds.delete(input.run.id);
      this.activeRuntimePromptRunIds.delete(input.run.id);
      throw runtimeDeliveryErrorForAcp('session/prompt', cause);
    }
    void started.response.catch(() => undefined);
    const providerTurnId = `${server.id}:${String(started.requestId)}`;
    const startedAt = new Date().toISOString();
    const attachmentSubmissions = completeAttachmentSubmissions(
      attachmentDelivery.submissionCandidates,
      { kind: 'client-request', id: String(started.requestId) },
      startedAt
    );
    try {
      const currentSession =
        (await this.providerRuntime.getSession(input.session.id)) ?? materialized.session;
      await this.providerRuntime.updateSession(
        currentSession.id,
        currentSession.recordRevision,
        {
          providerSessionId: materialized.state.sessionId,
          status: 'ACTIVE',
          materialized: true,
          requestedSettings: expectedSettings,
          observedSettings: this.projectObservedSettings(
            materialized.state,
            expectedSettings
          ),
          lastAttachedAt: startedAt
        },
        `acp-runtime-session-active:${input.run.id}`
      );
      const currentRun = (await this.providerRuntime.getRun(input.run.id)) ?? input.run;
      await this.providerRuntime.updateRun(
        currentRun.id,
        currentRun.recordRevision,
        {
          serverInstanceId: server.id,
          providerTurnId,
          status: 'RUNNING',
          delivery: 'ACKNOWLEDGED',
          ...(attachmentSubmissions.length > 0 ? { attachmentSubmissions } : {}),
          lastEventAt: startedAt
        },
        `acp-runtime-turn-acknowledged:${input.run.id}`
      );
      await this.supervisor?.markRunning();
    } catch (cause) {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/prompt',
        `ACP accepted read-only prompt ${providerTurnId}, but Task Monki could not persist its ownership.`
      );
      throw new AgentRuntimeDeliveryError(
        'AMBIGUOUS',
        `ACP accepted prompt ${providerTurnId}, but Task Monki could not persist its acknowledgement: ${errorMessage(cause)}`,
        { cause }
      );
    }
    void started.response.then(
      (response) =>
        this.enqueueInbound(() => this.finalizeRuntimePrompt(input.run.id, response)),
      (error) =>
        this.enqueueInbound(() => this.failRuntimePrompt(input.run.id, error))
    );
    return {
      serverInstanceId: server.id,
      providerSessionId: materialized.state.sessionId,
      providerTurnId,
      ...(attachmentSubmissions.length > 0 ? { attachmentSubmissions } : {}),
      startedAt
    };
  }

  async interruptRuntimeTurn(input: {
    session: AgentRuntimeSessionRecord;
    run: AgentRuntimeRunRecord;
  }): Promise<void> {
    if (
      input.run.sessionId !== input.session.id ||
      !input.session.providerSessionId ||
      !input.run.providerTurnId ||
      !this.activeRuntimePromptRunIds.has(input.run.id)
    ) {
      throw new AgentRuntimeDeliveryError(
        'NOT_DELIVERED',
        'ACP interruption requires the current acknowledged read-only turn.'
      );
    }
    const client = this.supervisor?.currentClient;
    const server = this.supervisor?.currentServer;
    if (!client || !server || server.id !== input.run.serverInstanceId) {
      throw new AgentRuntimeDeliveryError(
        'AMBIGUOUS',
        'The ACP process that owns this turn is no longer available.'
      );
    }
    try {
      await client.notify('session/cancel', {
        sessionId: input.session.providerSessionId
      });
    } catch (cause) {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/cancel',
        `Cancellation delivery could not be confirmed for read-only run ${input.run.id}.`
      );
      throw new AgentRuntimeDeliveryError(
        'AMBIGUOUS',
        `ACP cancellation delivery is ambiguous: ${errorMessage(cause)}`,
        { cause }
      );
    }
    this.armRuntimeInterruptDeadline(input.run.id, input.run.providerTurnId);
  }

  private async materializeRuntimeSession(
    initialSession: AgentRuntimeSessionRecord,
    settings: AgentExecutionSettings
  ): Promise<{
    client: AcpRpcClient;
    session: AgentRuntimeSessionRecord;
    state: AcpNativeSessionState;
  }> {
    let session =
      (await this.providerRuntime.getSession(initialSession.id)) ?? initialSession;
    let client: AcpRpcClient;
    let state: AcpNativeSessionState;
    let providerCreated = false;
    if (session.providerSessionId && this.nativeSessions.has(session.providerSessionId)) {
      client = await this.ensureClient();
      state = this.nativeSessions.get(session.providerSessionId)!;
    } else if (session.providerSessionId && this.canLoadNativeSession()) {
      const loaded = await this.loadNativeSession(
        session.providerSessionId,
        session.executionContext.primaryCwd
      );
      client = loaded.client;
      state = loaded.state;
    } else {
      const created = await this.createNativeSession(
        session.executionContext.primaryCwd
      );
      client = created.client;
      state = created.state;
      providerCreated = true;
    }
    try {
      if (
        session.providerSessionId !== state.sessionId ||
        session.status === 'NOT_MATERIALIZED'
      ) {
        session = await this.providerRuntime.updateSession(
          session.id,
          session.recordRevision,
          {
            providerSessionId: state.sessionId,
            status: 'NOT_LOADED',
            materialized: false,
            requestedSettings: settings,
            observedSettings: this.projectObservedSettings(state, settings),
            lastAttachedAt: new Date().toISOString()
          },
          `acp-runtime-session-ownership:${session.id}:${state.sessionId}`
        );
      }
    } catch (cause) {
      if (providerCreated) {
        await this.quarantineRuntimeAfterAmbiguousMutation(
          'session/new',
          `Provider session ${state.sessionId} was created, but its owner was not persisted.`
        );
      }
      throw new AgentRuntimeDeliveryError(
        providerCreated ? 'AMBIGUOUS' : 'NOT_DELIVERED',
        `Task Monki could not persist ACP session ownership: ${errorMessage(cause)}`,
        { cause }
      );
    }

    const applied = await this.applyRequestedNativeSettings(client, state, settings);
    state = applied.state;
    const policy = requireAcpReadOnlyTurnPolicy(this.profile);
    if (state.modes?.currentModeId !== policy.modeId) {
      throw new Error(
        `${this.descriptor.displayName} did not apply its required ${policy.modeId} read-only mode.`
      );
    }
    session =
      (await this.providerRuntime.getSession(session.id)) ?? session;
    session = await this.providerRuntime.updateSession(
      session.id,
      session.recordRevision,
      {
        providerSessionId: state.sessionId,
        status: 'IDLE',
        materialized: true,
        requestedSettings: settings,
        observedSettings: this.projectObservedSettings(state, settings),
        lastAttachedAt: new Date().toISOString()
      },
      `acp-runtime-session-read-only:${session.id}:${policy.policyId}`
    );
    this.setOperationalPreflight(state);
    this.emitRuntimeUpdate();
    return { client, session, state };
  }

  private canLoadNativeSession(): boolean {
    const capabilities = this.initializeResponse?.agentCapabilities;
    return Boolean(capabilities?.sessionCapabilities?.resume || capabilities?.loadSession);
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    await this.waitForRuntimeQuarantine();
    let session = await this.requireSession(input.session.localSessionId);
    this.assertSessionOwnership(session);
    const run = await this.taskRuntime.getRun(input.localRunId);
    if (!run || run.sessionId !== session.id) {
      throw new Error('ACP turn does not belong to the selected session.');
    }
    const attachments = input.attachments ?? [];
    assertAgentTurnAttachmentSelection(run.attachmentSelection, attachments);
    const settings = input.settings ?? session.requestedSettings;
    assertAcpExecutionPolicy(this.profile, settings);
    const designInstructions = this.designInstructions(input);
    const attachmentDelivery = await this.prepareAttachmentDelivery({
      settings,
      prompt: designInstructions
        ? `${designInstructions}\n\nTask Monki Design request:\n${input.prompt}`
        : input.prompt,
      attachments
    });
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
        settings
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
    const competing = await this.taskRuntime.getActiveRunForSession(session.id);
    if (competing && competing.id !== input.localRunId && ACTIVE_RUN_STATUSES.includes(competing.status)) {
      throw new Error(`ACP session ${session.id} already has active run ${competing.id}.`);
    }

    let client = await this.ensureClient();
    // A quarantine can begin after the initial native-session check but before
    // the client is acquired. Never submit a prompt on a relaunched process
    // until that process has authoritatively resumed or loaded the session.
    if (!this.nativeSessions.has(session.providerSessionId)) {
      session = await this.attachSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
      client = await this.ensureClient();
    }
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) throw new Error('ACP session setup did not return an ID.');
    if (designInstructions) {
      const server = this.supervisor?.currentServer;
      const grant = this.designToolGrants.get(session.id);
      if (!server) throw new Error('ACP runtime is not ready.');
      if (!grant || grant.providerGeneration !== server.id) {
        const loaded = await this.loadNativeSession(
          providerSessionId,
          session.worktreePath,
          { localSessionId: session.id, worktreeId: session.worktreeId }
        );
        client = loaded.client;
      }
    }
    const nativeState = this.nativeSessions.get(providerSessionId);
    if (!nativeState) {
      throw new Error(`ACP session ${session.providerSessionId} is not loaded.`);
    }
    const applied = await this.applyRequestedNativeSettings(client, nativeState, settings);
    const observedSettings = this.projectObservedSettings(applied.state, settings);
    try {
      session = await this.taskRuntime.updateAgentSession(session.id, {
        requestedSettings: settings,
        observedSettings,
        lastAttachedAt: new Date().toISOString()
      }, acpRuntimeOperationId(
        'session/turn-settings',
        input.localRunId,
        session.id,
        nativeState.sessionId,
        observedSettings
      ));
      await this.recordSettingsObservation(
        session,
        'TASK_MONKI_RESOLUTION',
        observedSettings,
        applied.finalMutationResponse,
        'Task Monki re-applied and durably recorded explicit ACP session settings immediately before prompt submission.'
      );
    } catch (cause) {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/configure',
        `Provider session ${nativeState.sessionId} was configured for a turn, but its resulting state was not durably recorded.`
      );
      throw new AgentMutationAmbiguousError(
        'session/configure',
        `ACP configured session ${nativeState.sessionId} for a turn, but Task Monki could not persist the resulting state: ${errorMessage(cause)}`
      );
    }
    const server = this.supervisor?.currentServer;
    if (!server) throw new Error('ACP runtime is not ready.');
    await this.taskRuntime.updateRun(input.localRunId, {
      serverInstanceId: server.id,
      status: 'STARTING',
      lastEventAt: new Date().toISOString()
    }, acpRuntimeOperationId('turn/send-intent', input.localRunId, server.id));
    await this.activateDesignToolGrant(run, server.id);

    let started;
    this.activePromptRunIds.add(input.localRunId);
    try {
      started = await client.startMutation<unknown>('session/prompt', {
        sessionId: session.providerSessionId,
        prompt: attachmentDelivery.prompt
      }, { timeoutMs: null });
    } catch (cause) {
      this.activePromptRunIds.delete(input.localRunId);
      await this.revokeDesignToolGrantSafely({ ...run, serverInstanceId: server.id });
      throw mapMutationError('session/prompt', cause);
    }
    // The agent may reject immediately while durable run acknowledgement is
    // still being written. Attach a rejection observer now; the authoritative
    // terminal handler is registered below after persistence succeeds.
    void started.response.catch(() => undefined);
    const providerTurnId = `${server.id}:${String(started.requestId)}`;
    const submittedAt = new Date().toISOString();
    const attachmentSubmissions = completeAttachmentSubmissions(
      attachmentDelivery.submissionCandidates,
      { kind: 'client-request', id: String(started.requestId) },
      submittedAt
    );
    try {
      await this.taskRuntime.updateRun(input.localRunId, {
        providerTurnId,
        serverInstanceId: server.id,
        status: 'RUNNING',
        ...(attachmentSubmissions.length > 0 ? { attachmentSubmissions } : {}),
        lastEventAt: submittedAt
      }, acpRuntimeOperationId('turn/acknowledged', input.localRunId, providerTurnId, server.id));
      await this.taskRuntime.updateAgentSession(session.id, {
        status: 'ACTIVE',
        materialized: true,
        requestedSettings: settings,
        lastAttachedAt: submittedAt
      }, acpRuntimeOperationId('session/turn-active', session.id, providerTurnId, server.id));
      await this.supervisor?.markRunning();
    } catch (cause) {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/prompt',
        `Task Monki could not persist acknowledgement for prompt ${providerTurnId}.`
      );
      throw new AgentMutationAmbiguousError(
        'session/prompt',
        `ACP accepted prompt request ${providerTurnId}, but Task Monki could not persist the acknowledgement: ${errorMessage(cause)}`
      );
    }

    void started.response.then(
      (response) =>
        this.enqueueInbound(() =>
          this.finalizePrompt({ ...run, serverInstanceId: server.id }, response)
        ),
      (error) =>
        this.enqueueInbound(() =>
          this.handlePromptFailure(
            { ...run, serverInstanceId: server.id },
            error
          )
        )
    );
    return { localRunId: input.localRunId, providerTurnId };
  }

  async interruptTurn(input: InterruptAgentTurn): Promise<void> {
    const session = await this.requireSession(input.session.localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) throw new Error('ACP session is not materialized.');
    const run = await this.taskRuntime.getRunByProviderTurnId(this.descriptor.id, input.providerTurnId);
    if (!run || run.sessionId !== session.id) {
      throw new Error('ACP turn does not belong to the selected session.');
    }
    await this.revokeDesignToolGrantSafely(run);
    const client = this.supervisor?.currentClient;
    const server = this.supervisor?.currentServer;
    if (!client || !server || server.id !== run.serverInstanceId) {
      this.activePromptRunIds.delete(run.id);
      await this.taskRuntime.updateAgentSession(
        run.sessionId,
        { status: 'NOT_LOADED' },
        acpRuntimeOperationId('session/interrupt-runtime-missing', run.sessionId, run.id)
      );
      throw new AgentMutationAmbiguousError(
        'session/cancel',
        'The ACP process that owns this turn is no longer available; cancellation delivery cannot be confirmed.'
      );
    }
    if (run.status !== 'INTERRUPTING') {
      await this.taskRuntime.updateRun(run.id, {
        status: 'INTERRUPTING',
        lastEventAt: new Date().toISOString()
      }, acpRuntimeOperationId('turn/interrupt-intent', run.id, input.providerTurnId));
    }
    try {
      await client.notify('session/cancel', { sessionId: session.providerSessionId });
      await this.cancelPendingPermissions(run, client);
    } catch (cause) {
      await this.staleRunInteractions(
        run,
        `ACP cancellation is ambiguous: ${errorMessage(cause)}`
      ).catch(() => undefined);
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/cancel',
        `Cancellation delivery could not be confirmed for run ${run.id}.`
      );
      throw new AgentMutationAmbiguousError(
        'session/cancel',
        `ACP cancellation delivery is ambiguous: ${errorMessage(cause)}`
      );
    }
    this.armInterruptDeadline(run.id);
  }

  async respondToInteraction(input: AgentInteractionResponse): Promise<void> {
    await this.enqueueInbound(() => this.respondToInteractionInOrder(input));
  }

  private async respondToInteractionInOrder(
    input: AgentInteractionResponse
  ): Promise<void> {
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
          await this.taskRuntime.transitionInteractionRequest(interaction.id, 'RESPONDING', {
            status: 'RESPONDING',
            responseRawMessage: raw
          }, acpProtocolOperationId('interaction/response-sent', raw, interaction.id));
          responseEvidencePersisted = true;
        }
      );
    } catch (cause) {
      if (responseEvidencePersisted) {
        await this.quarantineRuntimeAfterAmbiguousMutation(
          'session/request_permission',
          `Permission response delivery could not be confirmed for interaction ${interaction.id}.`
        );
        throw new AgentMutationAmbiguousError(
          'session/request_permission',
          `ACP permission response delivery is ambiguous after durable submission: ${errorMessage(cause)}`
        );
      }
      throw cause;
    }
    let resolved: InteractionRequestRecord;
    try {
      resolved = await this.taskRuntime.transitionInteractionRequest(
        interaction.id,
        'RESPONDING',
        {
          status: interactionTerminalStatus(input.decision),
          responseRawMessage: responseRaw,
          resolution: { outcome },
          resolvedAt: new Date().toISOString()
        },
        acpProtocolOperationId('interaction/response-acknowledged', responseRaw, interaction.id)
      );
    } catch (cause) {
      // The provider has consumed the response. Fence its generation before
      // any recovery I/O can yield, so a concurrent terminal response cannot
      // make this locally ambiguous mutation appear successful.
      this.invalidateBoundClient(client);
      const reason =
        `The provider accepted interaction ${interaction.id}, but local completion persistence failed.`;
      const ambiguity = new AgentMutationAmbiguousError(
        'session/request_permission',
        `ACP permission response was delivered, but local completion persistence failed: ${errorMessage(cause)}`
      );
      const recoveryFailures: unknown[] = [];
      const run = await this.taskRuntime.getRun(interaction.runId).catch((failure) => {
        recoveryFailures.push(failure);
        return undefined;
      });
      if (run) {
        await this.staleRunInteractions(run, reason).catch((failure) => {
          recoveryFailures.push(failure);
        });
      }
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/request_permission',
        reason,
        false
      ).catch((failure) => {
        recoveryFailures.push(failure);
      });
      if (recoveryFailures.length > 0) {
        throw new AggregateError(
          [ambiguity, ...recoveryFailures],
          'ACP permission response was ambiguous and safe recovery was incomplete.'
        );
      }
      throw ambiguity;
    }
    this.emitInteractionUpdate(resolved);
    await this.resumeAfterInteractionResolution(resolved, responseRaw);
  }

  private async resumeAfterInteractionResolution(
    interaction: InteractionRequestRecord,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    if (
      snapshot.interactionRequests.some(
        (candidate) =>
          candidate.runId === interaction.runId &&
          candidate.sessionId === interaction.sessionId &&
          candidate.serverInstanceId === interaction.serverInstanceId &&
          ['PENDING', 'RESPONDING'].includes(candidate.status)
      )
    ) {
      return;
    }
    const run = snapshot.runs.find((candidate) => candidate.id === interaction.runId);
    if (
      run?.status === 'AWAITING_APPROVAL' ||
      run?.status === 'AWAITING_USER_INPUT'
    ) {
      await this.taskRuntime.applyTaskRuntimeEvent(
        createDomainEvent({
          type: 'AGENT_INTERACTION_RESOLVED',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: run.serverInstanceId,
          interactionRequestId: interaction.id,
          source: 'provider',
          payload: {
            type: interaction.type,
            status: interaction.status,
            resumeConfirmed: true
          }
        }),
        acpProtocolOperationId('event/interaction-resolved', raw, run.id, interaction.id)
      );
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
        acpProtocolOperationId('session/interaction-resolved', raw, session.id, interaction.id)
      );
    }
  }

  async reconcile(): Promise<AgentReconciliationResult> {
    const recoveryRequiredSessionIds = new Set<string>();
    const reconciledSessionIds = new Set<string>();
    const runtimeRuns = await this.providerRuntime.getRunsRequiringRecovery({
      runtimeId: this.descriptor.id
    });
    const runtimeSessionIds = new Set<string>();
    for (let run of runtimeRuns) {
      const session = await this.providerRuntime.getSession(run.sessionId);
      if (!session || !isAcpReadOnlyRuntimeSession(session, this.profile)) continue;
      runtimeSessionIds.add(session.id);
      if (
        run.status === 'RECOVERY_REQUIRED' &&
        run.recoveryState === 'REQUIRES_USER_ACTION'
      ) {
        recoveryRequiredSessionIds.add(run.sessionId);
        continue;
      }
      if (
        run.serverInstanceId === this.supervisor?.currentServer?.id &&
        this.activeRuntimePromptRunIds.has(run.id)
      ) {
        reconciledSessionIds.add(run.sessionId);
        continue;
      }
      const reason =
        'ACP has no prompt-status read method. Task Monki will not replay an ambiguous read-only prompt.';
      run = await this.updateRuntimeRun(
        run.id,
        {
          status: 'RECOVERY_REQUIRED',
          delivery: run.delivery === 'SENDING' ? 'AMBIGUOUS' : run.delivery,
          recoveryState: 'REQUIRES_USER_ACTION',
          terminalReason: reason,
          lastEventAt: new Date().toISOString()
        },
        acpRuntimeOperationId(
          'runtime/reconciled',
          run.id,
          run.status,
          run.serverInstanceId
        )
      );
      const currentSession = await this.providerRuntime.getSession(run.sessionId);
      if (currentSession && currentSession.status !== 'NOT_LOADED') {
        await this.updateRuntimeSession(
          currentSession.id,
          { status: 'NOT_LOADED' },
          acpRuntimeOperationId('runtime/session-reconciled', currentSession.id, run.id)
        );
      }
      recoveryRequiredSessionIds.add(run.sessionId);
      this.emitRuntimeTurnEvent({
        type: 'RECOVERY_REQUIRED',
        runId: run.id,
        providerTurnId: run.providerTurnId,
        reason,
        observedAt: new Date().toISOString()
      });
    }

    const runs = await this.taskRuntime.getRunsRequiringRecovery({
      runtimeId: this.descriptor.id
    });
    for (const run of runs) {
      if (runtimeSessionIds.has(run.sessionId)) continue;
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
      const published = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
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
        }),
        [run.status],
        acpRuntimeOperationId('event/reconciled', run.id, run.status, run.serverInstanceId)
      );
      if (!published) continue;
      recoveryRequiredSessionIds.add(run.sessionId);
      this.appEvents.emit({
        type: 'run.state.updated',
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
    const failures: unknown[] = [];
    let resetSafe = true;
    const quarantine = this.runtimeQuarantinePromise;
    if (quarantine) {
      try {
        await quarantine;
      } catch (cause) {
        failures.push(cause);
        resetSafe = false;
      }
    }
    for (const timer of this.interruptTimers.values()) clearTimeout(timer);
    this.interruptTimers.clear();
    if (this.runtimeResetTimer) clearTimeout(this.runtimeResetTimer);
    this.runtimeResetTimer = undefined;
    // The provider process may outlive an unconfirmed shutdown. Remove every
    // generation-bound bridge credential before waiting on that shutdown.
    try {
      await this.releaseAllDesignToolGrants();
    } catch (cause) {
      failures.push(cause);
      resetSafe = false;
    }
    // Stop the producer first, then drain every line and terminal rejection it
    // emitted. This prevents shutdown from racing a final stream chunk.
    try {
      await this.supervisor?.shutdown();
    } catch (cause) {
      failures.push(cause);
      resetSafe = false;
    }
    try {
      await this.inboundQueue;
    } catch (cause) {
      failures.push(cause);
      resetSafe = false;
    }
    try {
      await this.releaseAllDesignToolGrants();
    } catch (cause) {
      failures.push(cause);
      resetSafe = false;
    }
    try {
      await this.flushAllContent(true);
    } catch (cause) {
      failures.push(cause);
      resetSafe = false;
    }
    for (const runId of [...this.runtimeOutputBuffers.keys()]) {
      try {
        await this.flushRuntimeOutput(runId, true);
      } catch (cause) {
        failures.push(cause);
        resetSafe = false;
      }
    }
    if (resetSafe && !this.supervisor?.safetyFenceReason) {
      this.resetAfterConfirmedShutdown();
    }
    if (failures.length > 0) {
      if (this.initialized) {
        this.latchRuntimeSafetyFence(
          `ACP runtime shutdown was incomplete: ${failures.map(errorMessage).join('; ')}`
        );
      }
      throw new AggregateError(failures, 'ACP runtime shutdown was incomplete.');
    }
  }

  private resetAfterConfirmedShutdown(): void {
    this.supervisor = undefined;
    this.invalidateBoundClient();
    this.initializeResponse = undefined;
    this.profileModelState = undefined;
    this.nativeSessions.clear();
    this.provisionalProviderSessionIds.clear();
    this.replayingProviderSessionIds.clear();
    this.activeRuntimePromptRunIds.clear();
    for (const runId of [...this.runtimeOutputBuffers.keys()]) {
      this.discardRuntimeOutputBuffer(runId);
    }
    this.initialized = false;
    this.runtimeReconfigurationPending = false;
    this.refreshModels();
    if (!this.runtimeSafetyFence) {
      if (this.resolvedRuntime) {
        this.setDiscoveryPreflight(this.resolvedRuntime);
      } else {
        this.preflightState = {
          runtime: this.descriptor,
          readiness: createRuntimeReadiness(
            'INITIALIZING',
            `${this.descriptor.displayName} is stopped and ready for discovery.`,
            { checks: { initialization: 'NOT_STARTED' } }
          ),
          capabilities: this.currentCapabilities(),
        };
      }
    }
  }

  private async applyNativeSessionConfigOption(
    localSessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<import('../../../shared/agent').AgentJsonValue> {
    await this.waitForRuntimeQuarantine();
    let session = await this.requireSession(localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) throw new Error('ACP session is not materialized.');
    const client = await this.ensureClient();
    session = await this.requireSession(localSessionId);
    const current = session.providerSessionId
      ? this.nativeSessions.get(session.providerSessionId)
      : undefined;
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
    const response = await this.requestBoundedMutation<unknown>(
      client,
      'session/set_config_option',
      {
        sessionId: session.providerSessionId,
        configId,
        ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value })
      },
      `The outcome of changing config option ${configId} could not be confirmed.`
    );
    let configOptions: AcpNativeSessionState['configOptions'];
    try {
      configOptions = acknowledgedConfigOptions(response.result, configId, value);
    } catch (cause) {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/set_config_option',
        `The provider replied after changing ${configId}, but its resulting state was invalid.`
      );
      throw new AgentMutationAmbiguousError(
        'session/set_config_option',
        `ACP may have applied config option ${configId}, but its resulting state could not be read: ${errorMessage(cause)}`
      );
    }
    const state = { ...current, configOptions };
    await this.persistNativeState(
      session,
      state,
      response.raw,
      'session/set_config_option',
      `ACP applied config option ${configId}`
    );
    return redactAcpNativeValue(
      sanitizeAcpNativeSession(state, this.sensitiveValues)
    );
  }

  private async applyNativeSessionModel(
    localSessionId: string,
    modelId: string
  ): Promise<import('../../../shared/agent').AgentJsonValue> {
    const extension = this.profile.sessionModelExtension;
    if (!extension) {
      throw new Error(
        `${this.descriptor.displayName} does not enable a provider-native session model extension.`
      );
    }
    await this.waitForRuntimeQuarantine();
    let session = await this.requireSession(localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) throw new Error('ACP session is not materialized.');
    const client = await this.ensureClient();
    session = await this.requireSession(localSessionId);
    const current = session.providerSessionId
      ? this.nativeSessions.get(session.providerSessionId)
      : undefined;
    if (!current?.models?.availableModels.some((model) => model.modelId === modelId)) {
      throw new Error(`ACP session did not advertise model ${modelId}.`);
    }
    const response = await this.requestBoundedMutation<unknown>(
      client,
      extension.setModelMethod,
      {
        sessionId: session.providerSessionId,
        modelId
      },
      `The outcome of changing the session model to ${modelId} could not be confirmed.`
    );
    const state = {
      ...current,
      models: { ...current.models, currentModelId: modelId }
    };
    await this.persistNativeState(
      session,
      state,
      response.raw,
      extension.setModelMethod,
      `ACP applied model ${modelId}`
    );
    return redactAcpNativeValue(
      sanitizeAcpNativeSession(state, this.sensitiveValues)
    );
  }

  private async applyNativeSessionMode(
    localSessionId: string,
    modeId: string
  ): Promise<import('../../../shared/agent').AgentJsonValue> {
    await this.waitForRuntimeQuarantine();
    let session = await this.requireSession(localSessionId);
    this.assertSessionOwnership(session);
    if (!session.providerSessionId) throw new Error('ACP session is not materialized.');
    const client = await this.ensureClient();
    session = await this.requireSession(localSessionId);
    const current = session.providerSessionId
      ? this.nativeSessions.get(session.providerSessionId)
      : undefined;
    if (!current?.modes?.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`ACP session did not advertise mode ${modeId}.`);
    }
    const response = await this.requestBoundedMutation<unknown>(
      client,
      'session/set_mode',
      {
        sessionId: session.providerSessionId,
        modeId
      },
      `The outcome of changing the session mode to ${modeId} could not be confirmed.`
    );
    const state = {
      ...current,
      modes: { ...current.modes, currentModeId: modeId }
    };
    await this.persistNativeState(
      session,
      state,
      response.raw,
      'session/set_mode',
      `ACP applied mode ${modeId}`
    );
    return redactAcpNativeValue(
      sanitizeAcpNativeSession(state, this.sensitiveValues)
    );
  }

  private async waitForRuntimeQuarantine(): Promise<void> {
    if (this.runtimeSafetyFence) throw this.runtimeSafetyFence;
    const pending = this.runtimeQuarantinePromise;
    if (pending) await pending;
    if (this.runtimeSafetyFence) throw this.runtimeSafetyFence;
    const supervisorFence = this.supervisor?.safetyFenceReason;
    if (supervisorFence) {
      throw this.latchRuntimeSafetyFence(supervisorFence);
    }
  }

  /**
   * Bounded ACP mutations can time out only after their request was durably
   * submitted. If that happens, the application-scoped process is no longer a
   * trustworthy source of session state and must be fenced before reuse.
   */
  private async requestBoundedMutation<T>(
    client: AcpRpcClient,
    operation: string,
    params: unknown,
    ambiguityDetail: string
  ): Promise<AcpRpcResult<T>> {
    try {
      return await client.requestMutation<T>(operation, params);
    } catch (cause) {
      const error = mapMutationError(operation, cause);
      if (error instanceof AgentMutationAmbiguousError) {
        await this.quarantineRuntimeAfterAmbiguousMutation(operation, ambiguityDetail);
      }
      throw error;
    }
  }

  private async ensureClient(): Promise<AcpRpcClient> {
    await this.waitForRuntimeQuarantine();
    if (!this.supervisor) {
      const runtime = await this.ensureResolvedRuntime();
      const supervisor = new AcpStdioSupervisor(this.providerRuntime, {
        profile: this.profile,
        runtime,
        cwd: this.options.cwd,
        environment: this.options.environment,
        appVersion: this.options.appVersion,
        requestTimeoutMs: this.options.requestTimeoutMs,
        beforeClientReplacementStart: (priorServerInstanceId) =>
          this.waitForClientReplacementFence(priorServerInstanceId)
      });
      this.supervisor = supervisor;
      supervisor.events.on('client', (client) => {
        this.bindClient(client, true);
      });
      supervisor.events.on('exit', (server, unexpected) => {
        if (supervisor.safetyFenceReason) {
          this.latchRuntimeSafetyFence(supervisor.safetyFenceReason);
        }
        if (unexpected && !this.runtimeQuarantinePromise) {
          this.enqueueInbound(() => this.handleRuntimeLoss(server.id));
          // RPC close has drained parsing and journaling, but accepted adapter
          // callbacks can still be materializing. Capture this exact tail before
          // a replacement is allowed to become authoritative.
          const fence = { serverInstanceId: server.id, tail: this.inboundQueue };
          this.clientReplacementFence = fence;
          const clearFence = () => {
            if (this.clientReplacementFence === fence) {
              this.clientReplacementFence = undefined;
            }
          };
          void fence.tail.then(clearFence, clearFence);
        }
      });
      supervisor.events.on('protocolError', (error) => {
        this.latchRuntimeSafetyFence(
          `ACP protocol failure requires an app restart before this runtime can be launched again: ${error.message}`
        );
        this.preflightState = {
          ...this.preflightState,
          readiness: createRuntimeReadiness(
            'FAILED',
            'The ACP connection violated the negotiated protocol.',
            {
              checks: {
                ...this.preflightState.readiness.checks,
                initialization: 'FAILED'
              },
              diagnostics: [
                ...this.preflightState.readiness.diagnostics,
                errorDiagnostic(
                  'ACP_PROTOCOL_FAILURE',
                  'COMPATIBILITY',
                  `ACP protocol failure: ${error.message}`
                )
              ],
              nextAction: { kind: 'CONFIGURE', label: 'Choose a compatible executable' }
            }
          )
        };
        this.emitRuntimeUpdate();
      });
    }
    let running: Awaited<ReturnType<AcpStdioSupervisor['start']>>;
    const supervisor = this.supervisor;
    try {
      running = await supervisor.start();
    } catch (cause) {
      this.recordInitializationFailure(cause, supervisor);
      throw cause;
    }
    try {
      this.initializeResponse = running.initialize;
      this.profileModelState = running.profileModelState;
      this.bindClient(running.client);
    } catch (cause) {
      this.invalidateBoundClient(running.client);
      this.initializeResponse = undefined;
      this.profileModelState = undefined;
      let failure: unknown = cause;
      try {
        await supervisor.shutdown();
      } catch (cleanupCause) {
        failure = new AggregateError(
          [cause, cleanupCause],
          'ACP initialization event dispatch failed and process cleanup was incomplete.'
        );
      }
      if (this.supervisor === supervisor && !supervisor.safetyFenceReason) {
        this.supervisor = undefined;
      }
      this.recordInitializationFailure(failure, supervisor);
      throw failure;
    }
    this.refreshModels();
    this.setConnectedPreflight();
    await this.inboundQueue;
    return running.client;
  }

  private recordInitializationFailure(
    cause: unknown,
    supervisor: AcpStdioSupervisor
  ): void {
    this.invalidateBoundClient(supervisor.currentClient);
    if (supervisor.safetyFenceReason) {
      this.latchRuntimeSafetyFence(supervisor.safetyFenceReason);
    }
    const detail = this.redactProviderText(
      supervisor.currentServer?.exitReason ?? errorMessage(cause)
    );
    const incompatible = /protocol negotiation selected|protocol violation/iu.test(detail);
    this.preflightState = {
      ...this.preflightState,
      readiness: createRuntimeReadiness(
        incompatible ? 'INCOMPATIBLE' : 'FAILED',
        detail,
        {
          checks: {
            discovery: 'FOUND',
            compatibility: incompatible ? 'INCOMPATIBLE' : 'UNKNOWN',
            initialization: 'FAILED'
          },
          diagnostics: [
            errorDiagnostic(
              'ACP_INITIALIZATION_FAILED',
              'INITIALIZATION',
              detail
            )
          ],
          nextAction: incompatible
            ? { kind: 'CONFIGURE', label: 'Choose a compatible executable' }
            : { kind: 'RETRY', label: 'Retry runtime initialization' }
        }
      )
    };
    this.emitRuntimeUpdate();
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
    const snapshot = await this.taskRuntime.snapshot();
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
    // Revoke app-owned tools before waiting for process shutdown. If the ACP
    // child cannot be stopped, its MCP child must still lose bridge access.
    this.invalidateBoundClient();
    await this.releaseAllDesignToolGrants().catch((cause) =>
      this.noteDesignToolCleanupFailure(cause)
    );
    await this.supervisor?.shutdown();
    await this.inboundQueue;
    await this.flushAllContent(true);
    this.supervisor = undefined;
    this.initializeResponse = undefined;
    this.profileModelState = undefined;
    this.resolvedRuntime = undefined;
    this.resolutionPromise = undefined;
    this.nativeSessions.clear();
    this.refreshModels();
    this.initialized = false;
    this.runtimeReconfigurationPending = false;
    this.preflightState = {
      runtime: this.descriptor,
      readiness: createRuntimeReadiness(
        'INITIALIZING',
        `${this.descriptor.displayName} executable discovery must be refreshed.`,
        {
          checks: { initialization: 'NOT_STARTED' },
          nextAction: { kind: 'RETRY', label: 'Refresh runtime' }
        }
      ),
      capabilities: this.currentCapabilities(),
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
    this.invalidateBoundClient();
    this.initializeResponse = undefined;
    this.profileModelState = undefined;
    this.refreshModels();
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
          readiness: createRuntimeReadiness(
            'FAILED',
            'The saved ACP executable configuration could not be applied.',
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
              nextAction: { kind: 'CONFIGURE', label: 'Review executable path' }
            }
          )
        };
        this.emitRuntimeUpdate();
      });
    }, 0);
    this.runtimeResetTimer.unref();
  }

  private setDiscoveryPreflight(runtime: ResolvedAcpRuntime): void {
    this.preflightState = {
      runtime: this.descriptor,
      readiness: createRuntimeReadiness(
        'DISCOVERED',
        'The executable and ACP launch command were found. Live protocol, account, and model access are checked when the first session starts.',
        {
          checks: {
            discovery: 'FOUND',
            compatibility: 'UNKNOWN',
            initialization: 'NOT_STARTED',
            authentication: 'UNKNOWN',
            modelCatalog:
              this.profile.parameterizedModelCatalog && this.parameterizedModelCatalog
                ? 'AVAILABLE'
                : 'UNKNOWN'
          },
          diagnostics: [
            infoDiagnostic(
              'ACP_LAUNCH_CONTRACT_FOUND',
              'DISCOVERY',
              'The provider-specific ACP launch contract was found.'
            ),
            ...acpRuntimeDiagnostics(false)
          ]
        }
      ),
      capabilities: this.currentCapabilities(),
      runtimeVersion: runtime.version,
    };
  }

  private setOperationalPreflight(state: AcpNativeSessionState): void {
    this.refreshModels();
    const hasNativeModels = Boolean(
      state.models?.availableModels.length ||
        state.configOptions.some(
          (option) => option.type === 'select' && option.category === 'model'
        )
    );
    this.preflightState = {
      runtime: this.descriptor,
      readiness: createRuntimeReadiness(
        'READY',
        `${this.descriptor.displayName} created or resumed a provider session successfully.`,
        {
          checks: {
            discovery: 'FOUND',
            compatibility: 'COMPATIBLE',
            initialization: 'INITIALIZED',
            authentication: 'PROVIDER_MANAGED',
            modelCatalog: hasNativeModels ? 'AVAILABLE' : 'EMPTY'
          },
          diagnostics: acpRuntimeDiagnostics(
            Boolean(this.initializeResponse?.authMethods.length)
          ).concat(this.imageInputDiagnostics())
        }
      ),
      capabilities: this.currentCapabilities(),
      runtimeVersion:
        this.supervisor?.currentServer?.runtimeVersion ?? this.resolvedRuntime?.version,
      accountLabel:
        this.redactProviderText(
          this.initializeResponse?.agentInfo?.title ??
            this.initializeResponse?.agentInfo?.name ??
            ''
        ) || undefined
    };
  }

  private setSessionFailurePreflight(cause: unknown): void {
    const readiness = acpSessionFailureReadiness(
      this.profile,
      cause,
      this.preflightState.readiness.checks,
      Boolean(this.supervisor?.currentClient),
      this.sensitiveValues
    );
    if (
      readiness.status === 'AUTHENTICATION_REQUIRED' ||
      readiness.status === 'ACCOUNT_UNSUPPORTED'
    ) {
      this.invalidateParameterizedModelCatalog();
    }
    this.preflightState = {
      ...this.preflightState,
      readiness
    };
    this.emitRuntimeUpdate();
  }

  private bindClient(client: AcpRpcClient, deferUntilInitialized = false): void {
    if (this.boundClient === client) {
      if (!deferUntilInitialized) this.activateStartupDispatch(client);
      return;
    }
    this.invalidateParameterizedModelCatalog();
    this.boundClient = client;
    const generation = ++this.clientGeneration;
    this.boundClientGeneration = generation;
    this.startupDispatch = deferUntilInitialized
      ? { client, generation, events: [], byteCount: 0 }
      : undefined;
    client.events.on('notification', (method, params, raw) => {
      this.dispatchClientEvent(client, generation, {
        kind: 'notification',
        method,
        params,
        raw
      });
    });
    client.events.on('request', (request, raw) => {
      this.dispatchClientEvent(client, generation, { kind: 'request', request, raw });
    });
  }

  private async waitForClientReplacementFence(
    priorServerInstanceId: string
  ): Promise<void> {
    const fence = this.clientReplacementFence;
    if (fence?.serverInstanceId === priorServerInstanceId) await fence.tail;
  }

  private dispatchClientEvent(
    client: AcpRpcClient,
    generation: number,
    event: BufferedAcpStartupEvent
  ): void {
    const startup = this.startupDispatch;
    if (startup?.client === client && startup.generation === generation) {
      // The journal reference describes the redacted durable record. Startup
      // retains the decoded provider payload, which can be materially larger
      // when credential fields were redacted before journaling.
      const nextBytes = startup.byteCount + Buffer.byteLength(
        JSON.stringify(event),
        'utf8'
      );
      if (
        startup.events.length >= MAX_STARTUP_EVENTS ||
        nextBytes > MAX_STARTUP_EVENT_BYTES
      ) {
        if (!startup.overflow) {
          startup.overflow = new Error(
            'ACP exceeded the bounded event buffer while initialization was completing.'
          );
          client.close(startup.overflow.message);
        }
        return;
      }
      startup.events.push(event);
      startup.byteCount = nextBytes;
      return;
    }
    this.enqueueDispatchedClientEvent(client, generation, event);
  }

  private activateStartupDispatch(client: AcpRpcClient): void {
    const startup = this.startupDispatch;
    if (!startup || startup.client !== client) return;
    this.startupDispatch = undefined;
    if (startup.overflow) throw startup.overflow;
    for (const event of startup.events) {
      this.enqueueDispatchedClientEvent(client, startup.generation, event);
    }
  }

  private enqueueDispatchedClientEvent(
    client: AcpRpcClient,
    generation: number,
    event: BufferedAcpStartupEvent
  ): void {
    this.enqueueInbound(() =>
      event.kind === 'notification'
        ? this.handleNotification(
            client,
            generation,
            event.method,
            event.params,
            event.raw
          )
        : this.handleServerRequest(client, generation, event.request, event.raw)
    );
  }

  /**
   * ACP callbacks can remain queued after their stdio process has exited. A
   * generation token makes every queued callback fail closed once quarantine
   * invalidates that client, even if a replacement process is already bound.
   */
  private isCurrentClientEvent(
    client: AcpRpcClient,
    generation: number,
    raw: AgentProtocolMessageReference
  ): boolean {
    return (
      this.boundClient === client &&
      this.boundClientGeneration === generation &&
      raw.serverInstanceId === client.serverInstanceId
    );
  }

  private invalidateBoundClient(client?: AcpRpcClient): void {
    if (client && this.boundClient !== client) return;
    this.boundClient = undefined;
    this.boundClientGeneration = ++this.clientGeneration;
    this.startupDispatch = undefined;
    this.invalidateParameterizedModelCatalog();
  }

  private invalidateParameterizedModelCatalog(): void {
    if (!this.profile.parameterizedModelCatalog) return;
    this.parameterizedModelCatalog = undefined;
    this.refreshModels();
  }

  private parseSessionModels(value: unknown): AcpNativeSessionState['models'] {
    const extension = this.profile.sessionModelExtension;
    return extension
      ? parseSessionModelExtension(value, extension.setupResponseField)
      : null;
  }

  private async applyRequestedNativeSettings(
    client: AcpRpcClient,
    initial: AcpNativeSessionState,
    settings: AgentExecutionSettings
  ): Promise<AppliedAcpSessionSettings> {
    let state = initial;
    let finalMutationResponse: AgentProtocolMessageReference | undefined;
    const native = settings.runtimeOptions?.[this.descriptor.id];
    const nativeRecord = isRecord(native) ? native : {};
    const requestedMode = typeof nativeRecord.modeId === 'string' ? nativeRecord.modeId : undefined;
    const values = requestedNativeConfigValues(this.descriptor.id, settings);
    const modelOption = state.configOptions.find(
      (option) => option.type === 'select' && option.category === 'model'
    );
    const modelExtension = this.profile.sessionModelExtension;
    const hasExplicitProviderModelSelection = Boolean(
      settings.model &&
        (settings.model !== 'default' || this.profile.parameterizedModelCatalog)
    );
    let requestedSessionModelId =
      hasExplicitProviderModelSelection ? settings.model : undefined;
    let requestedModelReasoningEffort: string | undefined;
    let requestedConfigReasoningEffort: string | undefined;
    if (
      requestedMode &&
      !state.modes?.availableModes.some((mode) => mode.id === requestedMode)
    ) {
      throw new Error(`ACP session did not advertise requested mode ${requestedMode}.`);
    }
    if (hasExplicitProviderModelSelection && settings.model) {
      if (state.models) {
        if (!modelExtension) {
          throw new Error(
            `${this.descriptor.displayName} returned session models without an enabled provider extension.`
          );
        }
        if (!state.models.availableModels.some((model) => model.modelId === settings.model)) {
          throw new Error(`ACP session did not advertise requested model ${settings.model}.`);
        }
      } else if (!modelOption) {
        throw new Error(
          `${this.descriptor.displayName} did not expose provider-native session models or an ACP model configuration selector.`
        );
      } else {
        values[modelOption.id] = settings.model;
      }
    }
    if (settings.reasoningEffort) {
      if (
        state.models &&
        modelExtension?.setModelReasoningEffortMetaField
      ) {
        requestedSessionModelId ??= state.models.currentModelId;
        const requestedModel = state.models.availableModels.find(
          (model) => model.modelId === requestedSessionModelId
        );
        if (
          !requestedModel?.reasoningEfforts?.some(
            (effort) => effort.value === settings.reasoningEffort
          )
        ) {
          throw new Error(
            `${this.descriptor.displayName} model ${requestedSessionModelId} did not advertise reasoning effort ${settings.reasoningEffort}.`
          );
        }
        requestedModelReasoningEffort = settings.reasoningEffort;
      } else {
        requestedConfigReasoningEffort = settings.reasoningEffort;
        for (const option of state.configOptions) {
          if (option.category === 'thought_level') delete values[option.id];
        }
      }
    }
    const pendingModelConfigValue = modelOption
      ? values[modelOption.id]
      : undefined;
    const modelMayReplaceConfigOptions =
      modelOption !== undefined &&
      typeof pendingModelConfigValue === 'string' &&
      pendingModelConfigValue !== modelOption.currentValue;
    if (requestedConfigReasoningEffort && !modelMayReplaceConfigOptions) {
      const thoughtLevel = acpThoughtLevelSelector(state);
      if (!thoughtLevel) {
        throw new Error(
          `${this.descriptor.displayName} did not advertise an ACP thought_level session configuration selector for reasoning effort ${requestedConfigReasoningEffort}.`
        );
      }
      values[thoughtLevel.id] = requestedConfigReasoningEffort;
      requestedConfigReasoningEffort = undefined;
    }

    try {
      const applyConfigValue = async (
        configId: string,
        value: string | boolean
      ): Promise<void> => {
        const option = validateAcpConfigValue(state, configId, value);
        if (option.currentValue === value) return;
        let response: AcpRpcResult<unknown>;
        try {
          response = await this.requestBoundedMutation<unknown>(
            client,
            'session/set_config_option',
            {
              sessionId: state.sessionId,
              configId,
              ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value })
            },
            `The requested config option ${configId} may have been applied during session setup.`
          );
        } catch (cause) {
          throw mapMutationError('session/set_config_option', cause);
        }
        finalMutationResponse = response.raw;
        try {
          state = normalizeAcpOperationalSession({
            ...state,
            configOptions: acknowledgedConfigOptions(response.result, configId, value)
          });
          this.nativeSessions.set(state.sessionId, state);
        } catch (cause) {
          await this.quarantineRuntimeAfterAmbiguousMutation(
            'session/set_config_option',
            `The provider replied after changing ${configId}, but its resulting state was invalid.`
          );
          throw new AgentMutationAmbiguousError(
            'session/set_config_option',
            `ACP may have applied config option ${configId}, but its resulting state could not be read: ${errorMessage(cause)}`
          );
        }
      };

      if (requestedMode) {
        const modes = state.modes;
        if (!modes) {
          throw new Error(`ACP session did not advertise requested mode ${requestedMode}.`);
        }
        if (modes.currentModeId !== requestedMode) {
          try {
            const response = await this.requestBoundedMutation(
              client,
              'session/set_mode',
              { sessionId: state.sessionId, modeId: requestedMode },
              `The requested mode ${requestedMode} may have been applied during session setup.`
            );
            finalMutationResponse = response.raw;
          } catch (cause) {
            throw mapMutationError('session/set_mode', cause);
          }
        }
        state = { ...state, modes: { ...modes, currentModeId: requestedMode } };
      }

      if (requestedSessionModelId && state.models) {
        if (!modelExtension) {
          throw new Error(
            `${this.descriptor.displayName} returned session models without an enabled provider extension.`
          );
        }
        const requestedModel = state.models.availableModels.find(
          (model) => model.modelId === requestedSessionModelId
        );
        const shouldMutate =
          state.models.currentModelId !== requestedSessionModelId ||
          (requestedModelReasoningEffort !== undefined &&
            requestedModel?.reasoningEffort !== requestedModelReasoningEffort);
        if (shouldMutate) {
          try {
            const response = await this.requestBoundedMutation(
              client,
              modelExtension.setModelMethod,
              {
                sessionId: state.sessionId,
                modelId: requestedSessionModelId,
                ...(requestedModelReasoningEffort &&
                modelExtension.setModelReasoningEffortMetaField
                  ? {
                      _meta: {
                        [modelExtension.setModelReasoningEffortMetaField]:
                          requestedModelReasoningEffort
                      }
                    }
                  : {})
              },
              `The requested model ${requestedSessionModelId} may have been applied during session setup.`
            );
            finalMutationResponse = response.raw;
          } catch (cause) {
            throw mapMutationError(modelExtension.setModelMethod, cause);
          }
        }
        state = normalizeAcpOperationalSession({
          ...state,
          models: {
            ...state.models,
            currentModelId: requestedSessionModelId,
            availableModels: state.models.availableModels.map((model) =>
              model.modelId === requestedSessionModelId && requestedModelReasoningEffort
                ? { ...model, reasoningEffort: requestedModelReasoningEffort }
                : model
            )
          }
        });
        this.nativeSessions.set(state.sessionId, state);
      }

      if (
        modelOption &&
        Object.prototype.hasOwnProperty.call(values, modelOption.id)
      ) {
        await applyConfigValue(modelOption.id, values[modelOption.id]!);
        delete values[modelOption.id];
      }
      if (requestedConfigReasoningEffort) {
        const thoughtLevel = acpThoughtLevelSelector(state);
        if (!thoughtLevel) {
          throw new Error(
            `${this.descriptor.displayName} did not advertise an ACP thought_level session configuration selector for reasoning effort ${requestedConfigReasoningEffort}.`
          );
        }
        const requestedConfigValue = values[thoughtLevel.id];
        if (
          requestedConfigValue !== undefined &&
          requestedConfigValue !== requestedConfigReasoningEffort
        ) {
          throw new Error(
            `ACP config option ${thoughtLevel.id} conflicts with requested reasoning effort ${requestedConfigReasoningEffort}.`
          );
        }
        values[thoughtLevel.id] = requestedConfigReasoningEffort;
      }
      for (const [configId, value] of Object.entries(values)) {
        await applyConfigValue(configId, value);
      }
      state = normalizeAcpOperationalSession(state);
      this.nativeSessions.set(state.sessionId, state);
      return { state, finalMutationResponse };
    } catch (cause) {
      if (finalMutationResponse && !(cause instanceof AgentMutationAmbiguousError)) {
        await this.quarantineRuntimeAfterAmbiguousMutation(
          'session/configure',
          `ACP acknowledged part of the requested session configuration before a later setting failed.`
        );
        throw new AgentMutationAmbiguousError(
          'session/configure',
          `ACP partially applied requested session settings that Task Monki could not durably record: ${errorMessage(cause)}`
        );
      }
      throw cause;
    }
  }

  private async handleNotification(
    client: AcpRpcClient,
    generation: number,
    method: string,
    params: unknown,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!this.isCurrentClientEvent(client, generation, raw)) return;
    const modelExtension = this.profile.sessionModelExtension;
    if (method === modelExtension?.modelUpdateNotification) {
      let nextModelState: AcpSessionModelState;
      try {
        const normalized = normalizeAcpOperationalModelState(
          parseSessionModelUpdateExtension(params)
        );
        if (!normalized) {
          throw new Error('ACP provider model update normalized to an empty model state.');
        }
        nextModelState = normalized;
        if (!hasSafeAcpModelIdentifiers(nextModelState, this.sensitiveValues)) {
          throw new Error(
            'ACP provider model update contained an identifier matching a runtime credential.'
          );
        }
      } catch (cause) {
        const detail = `${modelExtension.contractId} model update was rejected: ${errorMessage(cause)}`;
        // A rejected replacement invalidates the whole catalog for this
        // process generation. Keeping the previous catalog selectable would
        // falsely attribute stale model state to a provider that just replaced
        // it with an unreadable or unsafe update.
        this.profileModelState = undefined;
        this.models = [];
        this.emitRuntimeUpdate();
        const quarantine = this.quarantineRuntimeGeneration(
          `Task Monki quarantined the ACP process after a rejected provider model catalog update. ${detail}`,
          false
        );
        try {
          await this.recordProtocolIncident(detail, raw);
        } finally {
          await quarantine;
        }
        return;
      }
      if (!this.isCurrentClientEvent(client, generation, raw)) return;
      this.profileModelState = nextModelState;
      this.refreshModels();
      this.emitRuntimeUpdate();
      return;
    }
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
    const runtimeTarget = await this.findActiveRuntimeTarget(notification.sessionId);
    if (runtimeTarget && this.isCurrentClientEvent(client, generation, raw)) {
      await this.handleRuntimeNotification(runtimeTarget, notification.update, raw);
      return;
    }
    if (await this.isKnownRuntimeSession(notification.sessionId)) {
      // Generic runtime sessions are fenced by their active-run set. Ignore
      // replayed or late updates instead of allowing them into the Task path.
      return;
    }
    const session = await this.taskRuntime.getAgentSessionByProviderId(
      this.descriptor.id,
      notification.sessionId
    );
    if (!session || !this.isCurrentClientEvent(client, generation, raw)) return;
    const activeRun = this.replayingProviderSessionIds.has(notification.sessionId)
      ? undefined
      : await this.taskRuntime.getActiveRunForSession(session.id);
    if (!this.isCurrentClientEvent(client, generation, raw)) return;
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
      await this.taskRuntime.updateRun(
        run.id,
        { lastEventAt: new Date().toISOString() },
        acpProtocolOperationId('run/activity', raw, run.id, update.sessionUpdate)
      );
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
    client: AcpRpcClient,
    generation: number,
    request: AcpJsonRpcRequest,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!this.isCurrentClientEvent(client, generation, raw)) return;
    if (request.method !== 'session/request_permission') {
      await this.recordExtensionTelemetry(request.method, request.params, raw);
      if (!this.isCurrentClientEvent(client, generation, raw)) return;
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
      if (!this.isCurrentClientEvent(client, generation, raw)) return;
      await client.respondError(request.id, -32602, errorMessage(cause));
      return;
    }
    const runtimeTarget = await this.findActiveRuntimeTarget(permission.sessionId);
    if (runtimeTarget && this.isCurrentClientEvent(client, generation, raw)) {
      await this.denyRuntimePermission({
        client,
        generation,
        request,
        raw,
        run: runtimeTarget.run,
        options: permission.options
      });
      return;
    }
    if (await this.isKnownRuntimeSession(permission.sessionId)) {
      if (!this.isCurrentClientEvent(client, generation, raw)) return;
      await client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const session = await this.taskRuntime.getAgentSessionByProviderId(
      this.descriptor.id,
      permission.sessionId
    );
    const activeRun = session ? await this.taskRuntime.getActiveRunForSession(session.id) : undefined;
    const run = activeRun && this.activePromptRunIds.has(activeRun.id)
      ? activeRun
      : undefined;
    const server = this.supervisor?.currentServer;
    if (
      !this.isCurrentClientEvent(client, generation, raw) ||
      !session ||
      !run ||
      !server ||
      server.id !== raw.serverInstanceId
    ) {
      if (!this.isCurrentClientEvent(client, generation, raw)) return;
      await client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    if (request.id === null) {
      await this.recordProtocolIncident('ACP permission request used a null JSON-RPC id.', raw);
      await client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    if (
      [
        typeof request.id === 'string' ? request.id : undefined,
        permission.toolCall.toolCallId,
        ...permission.options.map((option) => option.optionId)
      ].some(
        (value) =>
          typeof value === 'string' &&
          !isSafeProviderIdentifier(value, this.sensitiveValues)
      )
    ) {
      this.noteSensitiveIdentifierOmission();
      await this.recordProtocolIncident(
        'ACP permission request contained an identifier matching a runtime credential and was cancelled.',
        raw
      );
      if (!this.isCurrentClientEvent(client, generation, raw)) return;
      await client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const providerItem = await this.taskRuntime.getAgentItemByProviderId(
      run.id,
      permission.toolCall.toolCallId
    );
    if (!this.isCurrentClientEvent(client, generation, raw)) return;
    const correlatedToolCall = providerItem
      ? mergeAcpToolCallUpdate(providerItem.payload, {
          toolCallId: permission.toolCall.toolCallId
        })
      : undefined;
    const toolCall = mergeAcpToolCallUpdate(providerItem?.payload, permission.toolCall);
    const trustedAppTool =
      correlatedToolCall &&
      this.activeInspectDesignTool(run, correlatedToolCall, server.id)
      ? 'inspect_design'
      : undefined;
    const materialized = materializeAcpPermission({
      toolCall,
      options: permission.options,
      session,
      run,
      trustedAppTool,
      rememberedPermissionOwner:
        !trustedAppTool && this.profile.allowRememberedPermissions === true
          ? this.descriptor.displayName
          : undefined
    });
    if (!this.isCurrentClientEvent(client, generation, raw)) return;
    const automaticOption = selectAutomaticAcpPermissionOption({
      approvalPolicy: run.requestedSettings.approvalPolicy,
      toolCall,
      options: permission.options,
      materialized
    });
    if (automaticOption) {
      await this.respondToAutomaticPermission({
        client,
        generation,
        request,
        raw,
        option: automaticOption
      });
      return;
    }
    let interaction: InteractionRequestRecord;
    try {
      interaction = await this.taskRuntime.createInteractionRequest({
        runtimeId: this.descriptor.id,
        serverInstanceId: server.id,
        providerRequestId: request.id,
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        sessionId: session.id,
        providerTurnId: run.providerTurnId,
        providerItemId: toolCall.toolCallId,
        type: 'COMMAND_APPROVAL',
        request: this.redactProviderValue(materialized.request),
        allowedActions: materialized.allowedActions,
        policyWarnings: materialized.warnings,
        requestRawMessage: raw
      }, acpProtocolOperationId('interaction/create', raw, run.id, request.id));
    } catch (cause) {
      await this.recoverPermissionMaterializationFailure({
        client,
        generation,
        request,
        raw,
        run,
        session,
        cause
      });
      return;
    }
    this.emitInteractionUpdate(interaction);
  }

  private async findActiveRuntimeTarget(
    providerSessionId: string
  ): Promise<ActiveAcpRuntimeTarget | undefined> {
    if (this.replayingProviderSessionIds.has(providerSessionId)) return undefined;
    const session = await this.providerRuntime.getSessionByProviderId(
      providerSessionId,
      this.descriptor.id
    );
    if (!session || !isAcpReadOnlyRuntimeSession(session, this.profile)) {
      return undefined;
    }
    const run = await this.providerRuntime.getActiveRunForSession(session.id);
    if (!run || !this.activeRuntimePromptRunIds.has(run.id)) return undefined;
    const server = this.supervisor?.currentServer;
    if (
      !server ||
      (run.serverInstanceId !== undefined && run.serverInstanceId !== server.id)
    ) {
      return undefined;
    }
    return { session, run };
  }

  private async isKnownRuntimeSession(providerSessionId: string): Promise<boolean> {
    const session = await this.providerRuntime.getSessionByProviderId(
      providerSessionId,
      this.descriptor.id
    );
    return Boolean(
      session && isAcpReadOnlyRuntimeSession(session, this.profile)
    );
  }

  private async handleRuntimeNotification(
    target: ActiveAcpRuntimeTarget,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!this.activeRuntimePromptRunIds.has(target.run.id)) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textFromAcpContent(update.content);
        if (text !== undefined) {
          await this.bufferRuntimeOutput(target.run, text, raw);
        }
        return;
      }
      case 'current_mode_update': {
        if (typeof update.currentModeId !== 'string') return;
        const providerSessionId = target.session.providerSessionId;
        const current = providerSessionId
          ? this.nativeSessions.get(providerSessionId)
          : undefined;
        if (current?.modes) {
          this.nativeSessions.set(current.sessionId, {
            ...current,
            modes: { ...current.modes, currentModeId: update.currentModeId }
          });
        }
        const policy = requireAcpReadOnlyTurnPolicy(this.profile);
        if (update.currentModeId === policy.modeId) return;
        const reason =
          `${this.descriptor.displayName} left required read-only mode ${policy.modeId} during the turn. ` +
          'Task Monki stopped the provider process and will not continue this turn.';
        await this.appendRuntimeDiagnostic(target.run, reason, raw.sequence);
        await this.quarantineRuntimeGeneration(reason, false);
        return;
      }
      default:
        // The bounded protocol journal remains the evidence for usage, plans,
        // read tools, and provider extensions. Shared read-only workflows need
        // only normalized text and terminal state in the common store.
        return;
    }
  }

  private async denyRuntimePermission(input: {
    client: AcpRpcClient;
    generation: number;
    request: AcpJsonRpcRequest;
    raw: AgentProtocolMessageReference;
    run: AgentRuntimeRunRecord;
    options: readonly AcpPermissionOption[];
  }): Promise<void> {
    if (!this.isCurrentClientEvent(input.client, input.generation, input.raw)) return;
    const safeRejectOptions = input.options.filter(
      (option) =>
        option.kind === 'reject_once' &&
        isSafeProviderIdentifier(option.optionId, this.sensitiveValues)
    );
    const reject = safeRejectOptions.length === 1 ? safeRejectOptions[0] : undefined;
    let journaled = false;
    let responseRaw: AgentProtocolMessageReference;
    try {
      responseRaw = await input.client.respond(
        input.request.id,
        reject
          ? {
              outcome: {
                outcome: 'selected',
                optionId: reject.optionId
              }
            }
          : { outcome: { outcome: 'cancelled' } },
        async () => {
          journaled = true;
        }
      );
    } catch (cause) {
      const reason =
        'Task Monki denied an ACP permission request during a read-only turn, ' +
        `but response delivery is ambiguous${journaled ? ' after journaling' : ''}: ${this.redactProviderText(errorMessage(cause))}`;
      await this.markRuntimeRecoveryRequired(input.run.id, reason);
      await this.quarantineRuntimeGeneration(reason, false);
      return;
    }
    const reason = reject
      ? 'Task Monki denied an ACP permission request with the provider\'s one-time rejection option.'
      : 'Task Monki denied an ACP permission request by cancelling it because no unique safe one-time rejection option was available.';
    await this.appendRuntimeDiagnostic(input.run, reason, input.raw.sequence);
    await this.providerRuntime.recordTelemetry({
      id: acpProtocolOperationId(
        'runtime/permission-denied',
        input.raw,
        input.run.id,
        responseRaw.sequence
      ),
      kind: 'PROTOCOL_REFERENCE',
      owner: input.run.owner,
      sessionId: input.run.sessionId,
      runId: input.run.id,
      serverInstanceId: input.raw.serverInstanceId,
      clientOperationId: acpProtocolOperationId(
        'runtime/permission-denied-telemetry',
        input.raw,
        input.run.id
      ),
      payload: {
        denied: true,
        outcome: reject ? 'reject_once' : 'cancelled',
        requestRaw: input.raw,
        responseRaw
      },
      observedAt: new Date().toISOString()
    });
  }

  private async bufferRuntimeOutput(
    run: AgentRuntimeRunRecord,
    providerText: string,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    let buffer = this.runtimeOutputBuffers.get(run.id);
    if (!buffer) {
      const artifact = await this.providerRuntime.getArtifact(run.outputArtifactId);
      buffer = {
        chunks: [],
        byteCount: 0,
        firstSequence: raw.sequence,
        lastSequence: raw.sequence,
        serverInstanceId: raw.serverInstanceId,
        credentialCarry: '',
        truncated: Boolean(
          artifact && artifact.byteCount >= AGENT_RUNTIME_LIMITS.maxArtifactBytes
        )
      };
      this.runtimeOutputBuffers.set(run.id, buffer);
    }
    if (buffer.serverInstanceId !== raw.serverInstanceId || buffer.truncated) return;
    const redacted = redactAcpStreamChunk(
      buffer.credentialCarry,
      providerText,
      this.sensitiveValues
    );
    buffer.credentialCarry = redacted.carry;
    buffer.lastSequence = raw.sequence;
    if (redacted.text) {
      const artifact = await this.providerRuntime.getArtifact(run.outputArtifactId);
      const persistedBytes = artifact?.byteCount ?? 0;
      const available = Math.max(
        0,
        AGENT_RUNTIME_LIMITS.maxArtifactBytes - persistedBytes - buffer.byteCount
      );
      const accepted = utf8Prefix(redacted.text, available);
      if (accepted) {
        buffer.chunks.push(accepted);
        buffer.byteCount += Buffer.byteLength(accepted, 'utf8');
      }
      if (accepted !== redacted.text) {
        buffer.truncated = true;
        buffer.credentialCarry = '';
        await this.appendRuntimeDiagnostic(
          run,
          `ACP output exceeded the ${AGENT_RUNTIME_LIMITS.maxArtifactBytes}-byte runtime artifact limit and was truncated.`,
          raw.sequence
        );
      }
    }
    if (buffer.byteCount >= STREAM_OUTPUT_FLUSH_BYTES) {
      await this.flushRuntimeOutput(run.id, false);
    } else {
      this.scheduleRuntimeOutputFlush(run.id, buffer);
    }
  }

  private scheduleRuntimeOutputFlush(
    runId: string,
    buffer: AcpRuntimeOutputBuffer
  ): void {
    if (buffer.timer || buffer.byteCount === 0) return;
    const timer = setTimeout(() => {
      if (buffer.timer === timer) buffer.timer = undefined;
      this.enqueueInbound(() => this.flushRuntimeOutput(runId, false));
    }, STREAM_OUTPUT_FLUSH_INTERVAL_MS);
    timer.unref();
    buffer.timer = timer;
  }

  private async flushRuntimeOutput(runId: string, terminal: boolean): Promise<void> {
    const buffer = this.runtimeOutputBuffers.get(runId);
    if (!buffer) return;
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = undefined;
    if (terminal && buffer.credentialCarry) {
      const run = await this.providerRuntime.getRun(runId);
      if (run) {
        const artifact = await this.providerRuntime.getArtifact(run.outputArtifactId);
        const available = Math.max(
          0,
          AGENT_RUNTIME_LIMITS.maxArtifactBytes -
            (artifact?.byteCount ?? 0) -
            buffer.byteCount
        );
        const marker = utf8Prefix(REDACTED_CREDENTIAL, available);
        if (marker) {
          buffer.chunks.push(marker);
          buffer.byteCount += Buffer.byteLength(marker, 'utf8');
        }
      }
      buffer.credentialCarry = '';
    }
    const text = buffer.chunks.join('');
    if (!text) {
      if (terminal || buffer.truncated) this.discardRuntimeOutputBuffer(runId);
      return;
    }
    const run = await this.providerRuntime.getRun(runId);
    if (!run || !this.activeRuntimePromptRunIds.has(runId)) {
      this.discardRuntimeOutputBuffer(runId);
      return;
    }
    if (!run.providerTurnId && !terminal) {
      this.scheduleRuntimeOutputFlush(runId, buffer);
      return;
    }
    try {
      await this.providerRuntime.appendArtifact(
        run.outputArtifactId,
        text,
        acpRuntimeOperationId(
          'runtime/output',
          run.id,
          buffer.serverInstanceId,
          buffer.firstSequence,
          buffer.lastSequence,
          text
        )
      );
    } catch (cause) {
      const reason =
        cause instanceof AgentRuntimeArtifactMutationAmbiguousError
          ? 'Task Monki cannot prove whether ACP output was persisted. It will not append the same bytes again.'
          : `Task Monki could not persist ACP output: ${this.redactProviderText(errorMessage(cause))}`;
      this.discardRuntimeOutputBuffer(runId);
      await this.markRuntimeRecoveryRequired(run.id, reason);
      await this.quarantineRuntimeGeneration(reason, false);
      return;
    }
    buffer.chunks = [];
    buffer.byteCount = 0;
    buffer.firstSequence = buffer.lastSequence + 1;
    await this.updateRuntimeRun(
      run.id,
      { lastEventAt: new Date().toISOString() },
      acpRuntimeOperationId(
        'runtime/output-observed',
        run.id,
        buffer.serverInstanceId,
        buffer.lastSequence
      )
    );
    for (const segment of splitUtf8Text(text, STREAM_TEXT_SEGMENT_BYTES)) {
      this.emitRuntimeTurnEvent({
        type: 'DELTA',
        runId: run.id,
        providerTurnId: run.providerTurnId!,
        text: segment,
        observedAt: new Date().toISOString()
      });
    }
    if (terminal || buffer.truncated) this.discardRuntimeOutputBuffer(runId);
  }

  private discardRuntimeOutputBuffer(runId: string): void {
    const buffer = this.runtimeOutputBuffers.get(runId);
    if (buffer?.timer) clearTimeout(buffer.timer);
    this.runtimeOutputBuffers.delete(runId);
  }

  private async appendRuntimeDiagnostic(
    run: AgentRuntimeRunRecord,
    diagnostic: string,
    sequence: number | string
  ): Promise<void> {
    const artifact = await this.providerRuntime.getArtifact(run.diagnosticArtifactId);
    if (!artifact || artifact.byteCount >= AGENT_RUNTIME_LIMITS.maxArtifactBytes) return;
    const prefix = artifact.byteCount > 0 ? '\n' : '';
    const text = utf8Prefix(
      `${prefix}${this.redactProviderText(diagnostic)}`,
      AGENT_RUNTIME_LIMITS.maxArtifactBytes - artifact.byteCount
    );
    if (!text) return;
    await this.providerRuntime.appendArtifact(
      artifact.id,
      text,
      acpRuntimeOperationId('runtime/diagnostic', run.id, sequence, text)
    );
  }

  private async finalizeRuntimePrompt(
    runId: string,
    response: AcpRpcResult<unknown>
  ): Promise<void> {
    if (!this.activeRuntimePromptRunIds.has(runId)) return;
    let prompt: ReturnType<typeof parsePromptResponse>;
    try {
      prompt = parsePromptResponse(response.result);
    } catch (cause) {
      await this.flushRuntimeOutput(runId, true);
      await this.settleRuntimeRun(
        runId,
        'failed',
        `ACP prompt response violated the negotiated schema: ${this.redactProviderText(errorMessage(cause))}`,
        response.raw
      );
      return;
    }
    await this.flushRuntimeOutput(runId, true);
    const run = await this.providerRuntime.getRun(runId);
    if (!run || !this.activeRuntimePromptRunIds.has(runId)) return;
    const output = await this.providerRuntime.readArtifact(run.outputArtifactId);
    const mapped =
      run.status === 'INTERRUPTING'
        ? 'interrupted'
        : mapAcpStopReason(prompt.stopReason);
    const profileFailure =
      this.profile.terminalFailureMessage &&
      output.trim() === this.profile.terminalFailureMessage.exactText
        ? this.profile.terminalFailureMessage.diagnostic
        : undefined;
    const noOutput = mapped === 'completed' && output.trim().length === 0;
    const status = profileFailure || noOutput ? 'failed' : mapped;
    const error =
      profileFailure ??
      (noOutput
        ? `${this.descriptor.displayName} completed the read-only turn without a response.`
        : mapped === 'failed'
          ? `ACP ended the read-only turn with ${prompt.stopReason}.`
          : undefined);
    await this.settleRuntimeRun(runId, status, error, response.raw);
  }

  private async failRuntimePrompt(runId: string, cause: unknown): Promise<void> {
    if (!this.activeRuntimePromptRunIds.has(runId)) return;
    if (cause instanceof AcpAmbiguousMutationError) {
      await this.markRuntimeRecoveryRequired(
        runId,
        `ACP read-only prompt outcome is ambiguous and will not be replayed: ${this.redactProviderText(cause.message)}`
      );
      return;
    }
    await this.flushRuntimeOutput(runId, true);
    await this.settleRuntimeRun(
      runId,
      'failed',
      `ACP read-only prompt failed: ${this.redactProviderText(errorMessage(cause))}`
    );
  }

  private async settleRuntimeRun(
    runId: string,
    status: 'completed' | 'interrupted' | 'failed',
    error?: string,
    raw?: AgentProtocolMessageReference
  ): Promise<void> {
    let run = await this.providerRuntime.getRun(runId);
    if (!run || isTerminalRuntimeStatus(run.status)) {
      this.clearRuntimeTurnState(runId, run?.providerTurnId);
      return;
    }
    const completedAt = new Date().toISOString();
    const terminalStatus =
      status === 'completed'
        ? 'COMPLETED'
        : status === 'interrupted'
          ? 'INTERRUPTED'
          : 'FAILED';
    run = await this.updateRuntimeRun(
      run.id,
      {
        status: terminalStatus,
        delivery: 'TERMINAL',
        ...(run.interruptDelivery ? { interruptDelivery: 'TERMINAL' as const } : {}),
        recoveryState: 'NONE',
        terminalReason: error,
        providerTerminalSource: 'ACP_PROMPT_RESPONSE',
        ...(raw ? { providerTerminalRawMessage: raw } : {}),
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      acpRuntimeOperationId(
        'runtime/terminal',
        run.id,
        run.providerTurnId,
        terminalStatus,
        raw?.sequence
      )
    );
    const session = await this.providerRuntime.getSession(run.sessionId);
    if (session) {
      await this.updateRuntimeSession(
        session.id,
        {
          status: status === 'failed' ? 'SYSTEM_ERROR' : 'IDLE',
          materialized: true,
          lastAttachedAt: completedAt
        },
        acpRuntimeOperationId('runtime/session-terminal', session.id, run.id)
      );
    }
    const providerTurnId = run.providerTurnId;
    this.clearRuntimeTurnState(run.id, providerTurnId);
    if (providerTurnId) {
      this.emitRuntimeTurnEvent({
        type: 'TERMINAL',
        runId: run.id,
        providerTurnId,
        status,
        ...(error ? { error: this.redactProviderText(error) } : {}),
        completedAt
      });
    }
    this.schedulePendingRuntimeReset();
  }

  private async markRuntimeRecoveryRequired(
    runId: string,
    reason: string,
    emitEvent = true
  ): Promise<void> {
    const run = await this.providerRuntime.getRun(runId);
    if (!run || isTerminalRuntimeStatus(run.status) || run.status === 'RECOVERY_REQUIRED') {
      return;
    }
    const observedAt = new Date().toISOString();
    const updated = await this.updateRuntimeRun(
      run.id,
      {
        status: 'RECOVERY_REQUIRED',
        delivery: run.delivery === 'SENDING' ? 'AMBIGUOUS' : run.delivery,
        ...(run.status === 'INTERRUPTING'
          ? { interruptDelivery: 'AMBIGUOUS' as const }
          : {}),
        recoveryState: 'REQUIRES_USER_ACTION',
        terminalReason: this.redactProviderText(reason),
        lastEventAt: observedAt
      },
      acpRuntimeOperationId('runtime/recovery-required', run.id, reason)
    );
    const session = await this.providerRuntime.getSession(updated.sessionId);
    if (session && session.status !== 'NOT_LOADED') {
      await this.updateRuntimeSession(
        session.id,
        { status: 'NOT_LOADED' },
        acpRuntimeOperationId('runtime/session-recovery', session.id, updated.id)
      );
    }
    const providerTurnId = updated.providerTurnId;
    this.clearRuntimeTurnState(updated.id, providerTurnId);
    if (emitEvent) {
      this.emitRuntimeTurnEvent({
        type: 'RECOVERY_REQUIRED',
        runId: updated.id,
        providerTurnId,
        reason: this.redactProviderText(reason),
        observedAt
      });
    }
  }

  private clearRuntimeTurnState(runId: string, providerTurnId?: string): void {
    this.activeRuntimePromptRunIds.delete(runId);
    this.activePromptRunIds.delete(runId);
    this.discardRuntimeOutputBuffer(runId);
    this.clearInterruptDeadline(runId);
    if (providerTurnId) this.clearInterruptDeadline(providerTurnId);
  }

  private async updateRuntimeSession(
    sessionId: string,
    update: Parameters<AgentRuntimeStore['updateSession']>[2],
    operationId: string
  ): Promise<AgentRuntimeSessionRecord> {
    let session = await this.providerRuntime.getSession(sessionId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!session) throw new Error(`Agent runtime session not found: ${sessionId}`);
      try {
        return await this.providerRuntime.updateSession(
          session.id,
          session.recordRevision,
          update,
          `${operationId}:${attempt}`
        );
      } catch (cause) {
        const latest = await this.providerRuntime.getSession(sessionId);
        if (!latest || latest.recordRevision === session.recordRevision || attempt === 3) {
          throw cause;
        }
        session = latest;
      }
    }
    throw new Error(`Agent runtime session update failed: ${sessionId}`);
  }

  private async updateRuntimeRun(
    runId: string,
    update: Parameters<AgentRuntimeStore['updateRun']>[2],
    operationId: string
  ): Promise<AgentRuntimeRunRecord> {
    let run = await this.providerRuntime.getRun(runId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!run) throw new Error(`Agent runtime run not found: ${runId}`);
      try {
        return await this.providerRuntime.updateRun(
          run.id,
          run.recordRevision,
          update,
          `${operationId}:${attempt}`
        );
      } catch (cause) {
        const latest = await this.providerRuntime.getRun(runId);
        if (!latest || latest.recordRevision === run.recordRevision || attempt === 3) {
          throw cause;
        }
        run = latest;
      }
    }
    throw new Error(`Agent runtime run update failed: ${runId}`);
  }

  private armRuntimeInterruptDeadline(
    runId: string,
    providerTurnId: string
  ): void {
    this.clearInterruptDeadline(runId);
    const timer = setTimeout(() => {
      this.interruptTimers.delete(runId);
      this.enqueueInbound(async () => {
        const run = await this.providerRuntime.getRun(runId);
        if (
          !run ||
          run.providerTurnId !== providerTurnId ||
          run.status !== 'INTERRUPTING'
        ) {
          return;
        }
        const reason =
          'ACP acknowledged cancellation but did not confirm a terminal read-only turn before the deadline.';
        try {
          await this.quarantineRuntimeGeneration(reason, false);
        } catch (cause) {
          await this.markRuntimeRecoveryRequired(
            run.id,
            `${reason} Task Monki could not confirm that the ACP process stopped: ${errorMessage(cause)}`,
            false
          );
          return;
        }
        await this.markRuntimeRecoveryRequired(run.id, reason);
      });
    }, this.interruptCompletionTimeoutMs);
    timer.unref();
    this.interruptTimers.set(runId, timer);
  }

  private emitRuntimeTurnEvent(event: AgentRuntimeTurnEvent): void {
    for (const listener of this.runtimeTurnListeners) listener(event);
  }

  private async respondToAutomaticPermission(input: {
    client: AcpRpcClient;
    generation: number;
    request: AcpJsonRpcRequest;
    raw: AgentProtocolMessageReference;
    option: AcpPermissionOption;
  }): Promise<void> {
    if (!this.isCurrentClientEvent(input.client, input.generation, input.raw)) return;
    let journaled = false;
    try {
      await input.client.respond(
        input.request.id,
        {
          outcome: {
            outcome: 'selected',
            optionId: input.option.optionId
          }
        },
        async () => {
          journaled = true;
        }
      );
    } catch (cause) {
      const detail = journaled
        ? 'The exact automatic permission response was journaled, but delivery could not be confirmed.'
        : 'The exact automatic permission response could not be journaled and delivered.';
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/request_permission',
        detail,
        false
      );
      throw new AgentMutationAmbiguousError(
        'session/request_permission',
        `${detail} ${errorMessage(cause)}`
      );
    }
  }

  private async handleContentChunk(
    run: RunRecord,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    const providerText = textFromAcpContent(update.content);
    if (providerText === undefined) return;
    const messageId = typeof update.messageId === 'string'
      ? update.messageId
      : `${run.id}:${update.sessionUpdate}`;
    const type =
      update.sessionUpdate === 'agent_message_chunk'
        ? 'AGENT_MESSAGE'
        : update.sessionUpdate === 'agent_thought_chunk'
          ? 'REASONING_SUMMARY'
          : 'USER_MESSAGE';
    let buffer = this.getOrCreateStreamBuffer(run);
    let priorCarry = buffer.credentialCarries.get(update.sessionUpdate);
    if (priorCarry && priorCarry.messageId !== messageId) {
      await this.materializeCredentialCarry(run, update.sessionUpdate, priorCarry);
      buffer = this.getOrCreateStreamBuffer(run);
      priorCarry = undefined;
    }
    const redacted = redactAcpStreamChunk(
      priorCarry?.text ?? '',
      providerText,
      this.sensitiveValues
    );
    await this.updateCredentialCarry(buffer, run, update.sessionUpdate, {
      text: redacted.carry,
      messageId,
      updateType: update.sessionUpdate,
      itemType: type,
      raw
    });
    await this.bufferRedactedContent(
      run,
      messageId,
      update.sessionUpdate,
      type,
      raw,
      redacted.text,
      true
    );
    buffer = this.getOrCreateStreamBuffer(run);

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
    if (terminal) await this.flushCredentialCarries(runId);
    await this.flushBufferedStreamOutput(runId);
    await this.materializeBufferedContentParts(runId, undefined, terminal);
    if (!terminal) return;
    for (const item of await this.taskRuntime.getAgentItemsForRun(runId)) {
      if (
        item.status === 'IN_PROGRESS' &&
        ['AGENT_MESSAGE', 'REASONING_SUMMARY', 'USER_MESSAGE'].includes(item.type)
      ) {
        await this.taskRuntime.upsertAgentItem(
          { ...item, status: 'COMPLETED' },
          acpRuntimeOperationId('item/terminal', runId, item.id, terminal)
        );
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
      outputBytes: 0,
      credentialCarries: new Map(),
      credentialCarryBytes: 0,
      outputAppendFailures: 0,
      persistenceRecoveryStarted: false
    };
    this.streamBuffers.set(run.id, buffer);
    return buffer;
  }

  private async updateCredentialCarry(
    buffer: AcpRunStreamBuffer,
    run: RunRecord,
    source: string,
    next: BufferedAcpCredentialCarry
  ): Promise<void> {
    const previousBytes = Buffer.byteLength(
      buffer.credentialCarries.get(source)?.text ?? '',
      'utf8'
    );
    const nextBytes = Buffer.byteLength(next.text, 'utf8');
    if (nextBytes > previousBytes) {
      await this.ensureStreamCapacity(nextBytes - previousBytes, run, run.id, next.messageId);
    }
    buffer = this.getOrCreateStreamBuffer(run);
    if (next.text) buffer.credentialCarries.set(source, next);
    else buffer.credentialCarries.delete(source);
    buffer.credentialCarryBytes = [...buffer.credentialCarries.values()].reduce(
      (total, carry) => total + Buffer.byteLength(carry.text, 'utf8'),
      0
    );
  }

  private async bufferRedactedContent(
    run: RunRecord,
    messageId: string,
    updateType: string,
    itemType: AgentItemRecord['type'],
    raw: AgentProtocolMessageReference,
    text: string,
    countEvent: boolean
  ): Promise<void> {
    const segments = text ? splitUtf8Text(text, STREAM_TEXT_SEGMENT_BYTES) : [''];
    let eventCounted = false;
    for (const segment of segments) {
      const byteCount = Buffer.byteLength(segment, 'utf8');
      const outputCopies = updateType === 'user_message_chunk' ? 1 : 2;
      await this.ensureStreamCapacity(
        byteCount * outputCopies,
        run,
        run.id,
        messageId
      );
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
          updateType,
          itemType,
          chunks: [],
          byteCount: 0,
          raw,
          eventCount: 0
        };
        buffer.parts.set(messageId, part);
      }
      if (countEvent && !eventCounted) {
        part.eventCount += 1;
        eventCounted = true;
      }
      part.raw = raw;
      appendBufferedText(part.chunks, segment, byteCount);
      part.byteCount += byteCount;
      buffer.partBytes += byteCount;

      if (updateType !== 'user_message_chunk' && byteCount > 0) {
        const previousOutput = buffer.output.at(-1);
        if (previousOutput?.source === updateType) {
          appendBufferedText(previousOutput.chunks, segment, byteCount);
          previousOutput.byteCount += byteCount;
        } else {
          buffer.output.push({
            source: updateType,
            chunks: [{ text: segment, byteCount }],
            byteCount
          });
        }
        buffer.outputBytes += byteCount;
      }
    }
  }

  private async flushCredentialCarries(runId: string): Promise<void> {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer || buffer.credentialCarries.size === 0) return;
    const run = await this.taskRuntime.getRun(runId);
    if (!run) {
      this.discardStreamBuffer(runId);
      return;
    }
    // A trailing exact-secret prefix can never be proven safe without another
    // provider chunk. Terminal, loss, and shutdown therefore materialize only
    // a marker and discard the raw suffix.
    for (const [source, carry] of [...buffer.credentialCarries.entries()]) {
      await this.materializeCredentialCarry(run, source, carry);
    }
  }

  private async materializeCredentialCarry(
    run: RunRecord,
    source: string,
    carry: BufferedAcpCredentialCarry
  ): Promise<void> {
    await this.updateCredentialCarry(
      this.getOrCreateStreamBuffer(run),
      run,
      source,
      { ...carry, text: '' }
    );
    await this.bufferRedactedContent(
      run,
      carry.messageId,
      carry.updateType,
      carry.itemType,
      carry.raw,
      REDACTED_CREDENTIAL,
      false
    );
  }

  private retainedStreamBytes(): number {
    let total = 0;
    for (const buffer of this.streamBuffers.values()) {
      total += buffer.partBytes + buffer.outputBytes + buffer.credentialCarryBytes;
    }
    return total;
  }

  private async recoverStreamOutputPersistenceFailure(
    buffer: AcpRunStreamBuffer,
    run: RunRecord,
    cause: unknown
  ): Promise<void> {
    if (buffer.persistenceRecoveryStarted) return;
    buffer.persistenceRecoveryStarted = true;
    const ambiguity = cause instanceof AgentRuntimeArtifactMutationAmbiguousError;
    const reason = this.redactProviderText(
      ambiguity
        ? `Task Monki cannot prove the ACP output artifact after an ambiguous append for run ${run.id}. The same bytes will not be retried.`
        : buffer.outputAppendFailures > 0
          ? `Task Monki could not persist ACP output for run ${run.id} after ${buffer.outputAppendFailures} artifact append attempts: ${errorMessage(cause)}`
          : `Task Monki could not persist buffered ACP output for run ${run.id}: ${errorMessage(cause)}`
    );
    // Discard before quarantine yields so no timer, late callback, or runtime
    // loss flush can retry the same bytes or retain unbounded provider output.
    this.discardStreamBuffer(run.id);
    this.preflightState = appendRuntimeDiagnostic(
      this.preflightState,
      errorDiagnostic(
        'ACP_OUTPUT_PERSISTENCE_FAILED',
        'HEALTH',
        'ACP output could not be persisted safely.',
        reason
      ),
      'DEGRADED'
    );
    this.emitRuntimeUpdate();
    await this.quarantineRuntimeGeneration(reason, false);
  }

  private scheduleBufferedStreamOutputFlush(buffer: AcpRunStreamBuffer): void {
    if (buffer.timer || buffer.outputBytes === 0 || buffer.persistenceRecoveryStarted) return;
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
    if (buffer.persistenceRecoveryStarted) {
      throw new Error(`ACP output persistence recovery is already active for run ${runId}.`);
    }
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = undefined;
    if (buffer.outputBytes === 0) return;
    const run = await this.taskRuntime.getRun(runId);
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
      if (artifactText) {
        await this.taskRuntime.appendArtifact(
          run.outputArtifactId,
          artifactText,
          acpRuntimeOperationId('artifact/output', run.id, artifactText)
        );
      }
    } catch (cause) {
      buffer.outputAppendFailures += 1;
      if (
        cause instanceof AgentRuntimeArtifactMutationAmbiguousError ||
        buffer.outputAppendFailures >= MAX_STREAM_OUTPUT_APPEND_ATTEMPTS
      ) {
        await this.recoverStreamOutputPersistenceFailure(buffer, run, cause);
      } else {
        this.scheduleBufferedStreamOutputFlush(buffer);
      }
      throw cause;
    }
    buffer.output = [];
    buffer.outputBytes = 0;
    buffer.outputAppendFailures = 0;
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
    if (buffer.parts.size === 0 && buffer.credentialCarries.size === 0) {
      this.discardStreamBuffer(runId);
    }
  }

  private async materializeBufferedContentParts(
    runId: string,
    partIds?: readonly string[],
    terminal = false
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
      const part = buffer.parts.get(partId);
      if (!part) continue;
      const existing = await this.taskRuntime.getAgentItemByProviderId(run.id, part.messageId);
      const combined = `${itemText(existing)}${bufferedText(part.chunks)}`;
      await this.taskRuntime.upsertAgentItem({
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        sessionId: buffer.sessionId,
        providerItemId: part.messageId,
        type: part.itemType,
        status: terminal ? 'COMPLETED' : 'IN_PROGRESS',
        payload: this.boundedItemPayload({ type: part.updateType, text: combined }),
        rawMessage: part.raw
      }, acpProtocolOperationId('item/stream-flush', part.raw, run.id, part.messageId));
      await this.recordRunActivity(run, part.updateType, part.raw, {
        providerItemId: part.messageId,
        coalescedEvents: part.eventCount
      });
      buffer.parts.delete(partId);
      buffer.partBytes = Math.max(0, buffer.partBytes - part.byteCount);
    }
    if (
      buffer.parts.size === 0 &&
      buffer.outputBytes === 0 &&
      buffer.credentialCarries.size === 0
    ) {
      this.discardStreamBuffer(runId);
    }
  }

  private async ensureStreamCapacity(
    requiredBytes: number,
    run: RunRecord,
    currentRunId: string,
    currentPartId: string
  ): Promise<void> {
    if (requiredBytes > MAX_BUFFERED_STREAM_BYTES) {
      throw new Error('ACP stream segment exceeds the retained-output limit.');
    }
    while (this.retainedStreamBytes() + requiredBytes > MAX_BUFFERED_STREAM_BYTES) {
      const output = [...this.streamBuffers.values()].find(
        (candidate) => candidate.outputBytes > 0 && !candidate.persistenceRecoveryStarted
      );
      if (output) {
        try {
          await this.flushBufferedStreamOutput(output.runId);
        } catch (cause) {
          const current = this.streamBuffers.get(output.runId);
          const outputRun = await this.taskRuntime.getRun(output.runId);
          if (current && outputRun) {
            await this.recoverStreamOutputPersistenceFailure(current, outputRun, cause);
          }
          throw cause;
        }
        continue;
      }
      const candidates = [...this.streamBuffers.values()].flatMap((buffer) =>
        [...buffer.parts.keys()].map((partId) => ({ runId: buffer.runId, partId }))
      );
      const oldest =
        candidates.find(
          (candidate) =>
            candidate.runId !== currentRunId || candidate.partId !== currentPartId
        ) ?? candidates[0];
      if (!oldest) break;
      try {
        await this.materializeBufferedContentParts(oldest.runId, [oldest.partId], false);
      } catch (cause) {
        const current = this.streamBuffers.get(oldest.runId);
        const bufferedRun = await this.taskRuntime.getRun(oldest.runId);
        if (current && bufferedRun) {
          await this.recoverStreamOutputPersistenceFailure(current, bufferedRun, cause);
        }
        throw cause;
      }
    }
    if (this.retainedStreamBytes() + requiredBytes > MAX_BUFFERED_STREAM_BYTES) {
      const buffer = this.streamBuffers.get(currentRunId);
      if (buffer) {
        await this.recoverStreamOutputPersistenceFailure(
          buffer,
          run,
          new Error('ACP could not free enough bounded stream capacity.')
        );
      }
      throw new Error('ACP could not retain provider output within its hard memory limit.');
    }
  }

  private discardStreamBuffer(runId: string): void {
    const buffer = this.streamBuffers.get(runId);
    if (!buffer) return;
    if (buffer.timer) clearTimeout(buffer.timer);
    this.streamBuffers.delete(runId);
  }

  private async handleToolUpdate(
    run: RunRecord,
    update: AcpToolCallUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (typeof update.toolCallId !== 'string') return;
    const existing = await this.taskRuntime.getAgentItemByProviderId(run.id, update.toolCallId);
    const toolCall = mergeAcpToolCallUpdate(existing?.payload, update);
    await this.taskRuntime.upsertAgentItem({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: run.sessionId,
      providerItemId: update.toolCallId,
      type:
        run.mode === 'DESIGN' && isTaskMonkiInspectDesignToolCall(toolCall)
          ? 'MCP_TOOL_CALL'
          : mapAcpToolKind(toolCall.kind),
      status: mapAcpToolStatus(toolCall.status),
      payload: this.boundedItemPayload(
        this.redactProviderValue(sanitizeAcpAttachmentContent(toolCall))
      ),
      rawMessage: raw
    }, acpProtocolOperationId('item/tool-call', raw, run.id, update.toolCallId));
  }

  private async handlePlan(
    run: RunRecord,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    await this.taskRuntime.recordAgentPlanRevision({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: run.sessionId,
      runtimeId: this.descriptor.id,
      steps: this.redactProviderValue(mapAcpPlanEntries(update.entries)),
      rawMessage: raw
    }, acpProtocolOperationId('plan/revision', raw, run.id));
  }

  private async handleUsage(
    session: AgentSessionRecord,
    run: RunRecord | undefined,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!Number.isSafeInteger(update.used) || !Number.isSafeInteger(update.size)) return;
    const used = update.used as number;
    await this.taskRuntime.recordAgentUsageSnapshot({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runId: run?.id,
      runtimeId: this.descriptor.id,
      total: emptyUsage(used),
      last: emptyUsage(0),
      modelContextWindow: update.size as number,
      rawMessage: raw
    }, acpProtocolOperationId('usage/context', raw, session.id, run?.id));
  }

  private async handleConfigUpdate(
    session: AgentSessionRecord,
    update: AcpSessionUpdate,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    if (!session.providerSessionId) return;
    let configOptions: AcpSessionConfigOption[];
    try {
      const parsed = parseConfigOptions(update.configOptions);
      if (!parsed) {
        throw new Error('ACP config update did not include configOptions.');
      }
      configOptions = parsed;
    } catch (cause) {
      await this.recordProtocolIncident(errorMessage(cause), raw);
      return;
    }
    const current = this.nativeSessions.get(session.providerSessionId) ?? {
      sessionId: session.providerSessionId,
      modes: null,
      models: null,
      configOptions: []
    };
    const state = {
      ...current,
      configOptions
    };
    await this.persistNativeState(
      session,
      state,
      raw,
      'session/update',
      'ACP reported a native session setting change',
      false
    );
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
      raw,
      'session/update',
      'ACP reported a native session setting change',
      false
    );
  }

  private async persistNativeState(
    session: AgentSessionRecord,
    state: AcpNativeSessionState,
    raw: AgentProtocolMessageReference,
    operation = 'session/update',
    appliedState = 'ACP reported a native session setting change',
    drainInboundBeforeReplacement = true
  ): Promise<void> {
    state = normalizeAcpOperationalSession(state);
    this.nativeSessions.set(state.sessionId, state);
    const observedSettings = this.projectObservedSettings(
      state,
      session.requestedSettings
    );
    try {
      await this.taskRuntime.updateAgentSession(
        session.id,
        { observedSettings },
        acpProtocolOperationId('session/settings-notification', raw, session.id)
      );
      await this.recordSettingsObservation(
        session,
        'THREAD_SETTINGS_NOTIFICATION',
        observedSettings,
        raw
      );
    } catch (cause) {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        operation,
        `${appliedState}, but Task Monki could not durably record the observed state.`,
        drainInboundBeforeReplacement
      );
      throw new AgentMutationAmbiguousError(
        operation,
        `${appliedState}, but Task Monki could not persist the observed state: ${errorMessage(cause)}`
      );
    }
    this.emitRuntimeUpdate();
  }

  private async finalizePrompt(
    deliveredRun: RunRecord,
    response: AcpRpcResult<unknown>
  ): Promise<void> {
    const runId = deliveredRun.id;
    // Runtime loss and interrupt timeout remove a run from this set before
    // marking it ambiguous. A late response must not reverse recovery.
    if (!this.activePromptRunIds.delete(runId)) return;
    await this.revokeDesignToolGrantSafely(deliveredRun);
    const run = await this.taskRuntime.getRun(runId);
    if (!run || !PROMPT_OWNED_RUN_STATUSES.includes(run.status)) return;

    let prompt: ReturnType<typeof parsePromptResponse>;
    try {
      prompt = parsePromptResponse(response.result);
    } catch (cause) {
      const detail = `ACP prompt response violated the negotiated schema: ${errorMessage(cause)}`;
      let finalArtifactId: string | undefined;
      try {
        await this.taskRuntime.applyTaskRuntimeEvent(
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
          }),
          acpProtocolOperationId('event/protocol-incident', response.raw, run.id, detail)
        );
        finalArtifactId = await this.persistPromptFailure(
          run,
          new Error(detail),
          response.raw
        );
      } catch (persistenceCause) {
        await this.recoverDefinitivePromptFinalization(
          run,
          response.raw,
          persistenceCause
        );
        return;
      }
      if (finalArtifactId) {
        this.appEvents.emit({
          type: 'run.terminal',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          payload: { status: 'failed', finalArtifactId },
          at: new Date().toISOString()
        });
        this.schedulePendingRuntimeReset();
      }
      return;
    }

    let terminal: 'completed' | 'failed' | 'interrupted';
    let finalArtifactId: string;
    try {
      await this.flushRunContent(run.id, true);
      const items = [...await this.taskRuntime.getAgentItemsForRun(run.id)].sort(
        (left, right) => left.createdAt.localeCompare(right.createdAt)
      );
      const finalMessage = items
        .filter((item) => item.type === 'AGENT_MESSAGE')
        .map(itemText)
        .filter(Boolean)
        .join('\n');
      const failureDiagnostic =
        acpStopFailureDiagnostic(prompt.stopReason) ??
        acpTerminalMessageFailureDiagnostic(
          this.profile,
          prompt.stopReason,
          finalMessage
        );
      const finalArtifactContent = formatFinalArtifact(
        this.profile.descriptor.displayName,
        prompt.stopReason,
        finalMessage,
        failureDiagnostic
      );
      const finalArtifact = await this.taskRuntime.writeFinalArtifact(
        run.taskId,
        run.id,
        finalArtifactContent,
        acpRuntimeOperationId('artifact/final', run.id, prompt.stopReason, finalArtifactContent)
      );
      terminal = failureDiagnostic ? 'failed' : mapAcpStopReason(prompt.stopReason);
      const type =
        terminal === 'completed'
          ? 'AGENT_RUN_COMPLETED'
          : terminal === 'interrupted'
            ? 'AGENT_RUN_INTERRUPTED'
            : 'AGENT_RUN_FAILED';
      await this.taskRuntime.updateRun(run.id, {
        finalMessage: finalMessage || undefined,
        providerTerminalRawMessage: response.raw
      }, acpProtocolOperationId('run/terminal-details', response.raw, run.id));
      const terminalPublished = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
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
            ...(failureDiagnostic ? { error: failureDiagnostic } : {}),
            finalArtifactId: finalArtifact.id,
            agentReviewStatus: 'NOT_RUN'
          }
        }),
        PROMPT_OWNED_RUN_STATUSES,
        acpProtocolOperationId('event/run-terminal', response.raw, run.id, terminal, finalArtifact.id)
      );
      if (!terminalPublished) {
        throw new Error(
          `ACP run ${run.id} no longer owned its prompt when terminal persistence completed.`
        );
      }
      await this.taskRuntime.updateAgentSession(
        run.sessionId,
        { status: 'IDLE' },
        acpProtocolOperationId('session/turn-finished', response.raw, run.sessionId, run.id)
      );
      this.clearInterruptDeadline(run.id);
      finalArtifactId = finalArtifact.id;
    } catch (cause) {
      await this.recoverDefinitivePromptFinalization(run, response.raw, cause);
      return;
    }
    this.appEvents.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: terminal, finalArtifactId },
      at: new Date().toISOString()
    });
    this.schedulePendingRuntimeReset();
  }

  private async handlePromptFailure(
    deliveredRun: RunRecord,
    cause: unknown,
    providerTerminalRawMessage?: AgentProtocolMessageReference
  ): Promise<void> {
    const runId = deliveredRun.id;
    if (!this.activePromptRunIds.delete(runId)) return;
    this.clearInterruptDeadline(runId);
    await this.revokeDesignToolGrantSafely(deliveredRun);
    const run = await this.taskRuntime.getRun(runId);
    if (!run || !PROMPT_OWNED_RUN_STATUSES.includes(run.status)) return;
    let finalArtifactId: string | undefined;
    try {
      finalArtifactId = await this.persistPromptFailure(
        run,
        cause,
        providerTerminalRawMessage
      );
    } catch (persistenceCause) {
      await this.recoverDefinitivePromptFinalization(
        run,
        providerTerminalRawMessage,
        persistenceCause
      );
      return;
    }
    if (finalArtifactId) {
      this.appEvents.emit({
        type: 'run.terminal',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: { status: 'failed', finalArtifactId },
        at: new Date().toISOString()
      });
      this.schedulePendingRuntimeReset();
    }
  }

  private async persistPromptFailure(
    run: RunRecord,
    cause: unknown,
    providerTerminalRawMessage?: AgentProtocolMessageReference
  ): Promise<string | undefined> {
    const failureMessage = this.redactProviderText(errorMessage(cause));
    await this.flushRunContent(run.id, true);
    await this.staleRunInteractions(run, failureMessage);
    if (cause instanceof AcpAmbiguousMutationError) {
      const recoveryPublished = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
        createDomainEvent({
          type: 'AGENT_MUTATION_AMBIGUOUS',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: run.serverInstanceId,
          source: 'provider',
          payload: { operation: cause.method, reason: failureMessage }
        }),
        PROMPT_OWNED_RUN_STATUSES,
        acpRuntimeOperationId('event/prompt-ambiguous', run.id, cause.method, failureMessage)
      );
      if (!recoveryPublished) {
        throw new Error(
          `ACP run ${run.id} no longer owned its prompt when ambiguity persistence completed.`
        );
      }
      await this.taskRuntime.updateAgentSession(
        run.sessionId,
        { status: 'NOT_LOADED' },
        acpRuntimeOperationId('session/prompt-ambiguous', run.sessionId, run.id, failureMessage)
      );
      this.appEvents.emit({
        type: 'run.state.updated',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: {
          eventType: 'session/prompt/ambiguous',
          reason: failureMessage,
          automaticReplay: false
        },
        at: new Date().toISOString()
      });
      return undefined;
    }
    const finalArtifactContent = `# ${this.profile.descriptor.displayName} turn failed\n\n${failureMessage}\n`;
    const finalArtifact = await this.taskRuntime.writeFinalArtifact(
      run.taskId,
      run.id,
      finalArtifactContent,
      acpRuntimeOperationId('artifact/failure', run.id, finalArtifactContent)
    );
    if (providerTerminalRawMessage) {
      await this.taskRuntime.updateRun(
        run.id,
        { providerTerminalRawMessage },
        acpProtocolOperationId('run/failure-details', providerTerminalRawMessage, run.id)
      );
    }
    const terminalPublished = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
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
          error: failureMessage,
          finalArtifactId: finalArtifact.id
        }
      }),
      PROMPT_OWNED_RUN_STATUSES,
      acpRuntimeOperationId('event/run-failed', run.id, failureMessage, finalArtifact.id)
    );
    if (!terminalPublished) {
      throw new Error(
        `ACP run ${run.id} no longer owned its prompt when failure persistence completed.`
      );
    }
    await this.taskRuntime.updateAgentSession(
      run.sessionId,
      { status: 'SYSTEM_ERROR' },
      acpRuntimeOperationId('session/run-failed', run.sessionId, run.id, failureMessage)
    );
    return finalArtifact.id;
  }

  /**
   * A provider permission request is already blocking its prompt when it
   * reaches this boundary. If Task Monki cannot durably expose the request and
   * its awaiting state together, cancel it when the same client generation is
   * still writable, publish no-replay recovery, and fence the application-
   * scoped process. The provider must never remain blocked behind an action the
   * user cannot see.
   */
  private async recoverPermissionMaterializationFailure(input: {
    client: AcpRpcClient;
    generation: number;
    request: AcpJsonRpcRequest;
    raw: AgentProtocolMessageReference;
    run: RunRecord;
    session: AgentSessionRecord;
    cause: unknown;
  }): Promise<void> {
    const { client, generation, request, raw, run, session, cause } = input;
    this.activePromptRunIds.delete(run.id);
    this.clearInterruptDeadline(run.id);

    let cancellationRawMessage: AgentProtocolMessageReference | undefined;
    let cancellationFailure: unknown;
    if (this.isCurrentClientEvent(client, generation, raw)) {
      try {
        cancellationRawMessage = await client.respond(request.id, {
          outcome: { outcome: 'cancelled' }
        });
      } catch (responseCause) {
        cancellationFailure = responseCause;
      }
    } else {
      cancellationFailure = new Error(
        'The permission request belongs to a client generation that is no longer current.'
      );
    }

    const materializationError = this.redactProviderText(errorMessage(cause));
    const reason =
      `ACP permission request could not be materialized durably: ${materializationError}. ` +
      'Task Monki will not approve or replay the blocked prompt.';
    let recoveryPublicationFailure: unknown;
    try {
      await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
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
            operation: 'session/request_permission/materialize',
            reason,
            automaticResubmission: false,
            requestRawMessage: raw,
            ...(cancellationRawMessage ? { cancellationRawMessage } : {})
          }
        }),
        PROMPT_OWNED_RUN_STATUSES,
        acpProtocolOperationId('event/permission-materialization-failed', raw, run.id, reason)
      );
    } catch (recoveryCause) {
      recoveryPublicationFailure = recoveryCause;
    }

    let sessionPublicationFailure: unknown;
    try {
      await this.taskRuntime.updateAgentSession(
        session.id,
        { status: 'NOT_LOADED' },
        acpProtocolOperationId('session/permission-materialization-failed', raw, session.id, run.id)
      );
    } catch (sessionCause) {
      sessionPublicationFailure = sessionCause;
    }

    let interactionPublicationFailure: unknown;
    try {
      await this.staleRunInteractions(run, reason);
    } catch (interactionCause) {
      interactionPublicationFailure = interactionCause;
    }

    let quarantineFailure: unknown;
    try {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/request_permission materialization',
        `${reason} Cancellation delivery was ${
          cancellationRawMessage ? 'submitted' : 'not confirmed'
        }.`,
        false
      );
    } catch (quarantineCause) {
      quarantineFailure = quarantineCause;
    }

    const [currentRun, currentSession, snapshot] = await Promise.all([
      this.taskRuntime.getRun(run.id).catch(() => undefined),
      this.taskRuntime.getAgentSession(session.id).catch(() => undefined),
      this.taskRuntime.snapshot().catch(() => undefined)
    ]);
    const runIsSafe = Boolean(
      currentRun &&
        (currentRun.status === 'RECOVERY_REQUIRED' ||
          ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(currentRun.status))
    );
    const sessionIsSafe = currentSession?.status === 'NOT_LOADED';
    const interactionIsSafe =
      snapshot?.interactionRequests.some(
        (interaction) =>
          interaction.runId === run.id &&
          ['PENDING', 'RESPONDING'].includes(interaction.status)
      ) !== true;
    const processIsFenced =
      this.boundClient !== client ||
      Boolean(this.runtimeQuarantinePromise) ||
      Boolean(this.runtimeSafetyFence);

    if (
      !runIsSafe ||
      !sessionIsSafe ||
      !interactionIsSafe ||
      !processIsFenced ||
      quarantineFailure
    ) {
      const failure = new AggregateError(
        [
          cause,
          cancellationFailure,
          recoveryPublicationFailure,
          sessionPublicationFailure,
          interactionPublicationFailure,
          quarantineFailure
        ].filter((value) => value !== undefined),
        'ACP permission materialization failed and safe recovery ownership could not be established.'
      );
      throw this.latchRuntimeSafetyFence(failure);
    }

    this.preflightState = appendRuntimeDiagnostic(
      this.preflightState,
      warningDiagnostic(
        'PERMISSION_MATERIALIZATION_FAILED',
        'HEALTH',
        'ACP permission request could not be exposed safely.',
        `${reason} Cancellation delivery was ${
          cancellationRawMessage ? 'submitted before quarantine' : 'not confirmed before quarantine'
        }.`
      )
    );
    this.emitRuntimeUpdate();
    this.appEvents.emit({
      type: 'run.state.updated',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: {
        eventType: 'session/request_permission/materialization-recovery',
        recoveryState: currentRun?.recoveryState,
        cancellationSubmitted: Boolean(cancellationRawMessage),
        automaticReplay: false
      },
      at: new Date().toISOString()
    });
  }

  /**
   * A prompt response is a one-shot ACP message. Once this adapter claims it,
   * process restart cannot replay the response and prompt retry could duplicate
   * provider work. If local finalization then fails, preserve any terminal run
   * already projected; otherwise publish recovery-required, unload the session,
   * and quarantine the application-scoped process before it can be reused.
   */
  private async recoverDefinitivePromptFinalization(
    run: RunRecord,
    raw: AgentProtocolMessageReference | undefined,
    cause: unknown
  ): Promise<void> {
    this.clearInterruptDeadline(run.id);
    const reason = this.redactProviderText(
      `ACP received a definitive prompt response, but Task Monki could not persist its terminal state: ${errorMessage(cause)}`
    );
    let recoveryPublicationFailure: unknown;
    try {
      const current = await this.taskRuntime.getRun(run.id);
      if (current) {
        await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
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
              operation: 'session/prompt/finalize',
              reason,
              automaticResubmission: false,
              rawMessage: raw
            }
          }),
          PROMPT_OWNED_RUN_STATUSES,
          raw
            ? acpProtocolOperationId('event/prompt-finalization-failed', raw, current.id, reason)
            : acpRuntimeOperationId('event/prompt-finalization-failed', current.id, reason)
        );
      }
      await this.taskRuntime.updateAgentSession(
        run.sessionId,
        { status: 'NOT_LOADED' },
        acpRuntimeOperationId('session/prompt-finalization-failed', run.sessionId, run.id, reason)
      );
    } catch (recoveryCause) {
      recoveryPublicationFailure = recoveryCause;
    }

    let quarantineFailure: unknown;
    try {
      await this.quarantineRuntimeAfterAmbiguousMutation(
        'session/prompt finalization',
        `${reason} The consumed response will not be replayed.`,
        false
      );
    } catch (quarantineCause) {
      quarantineFailure = quarantineCause;
    }

    const [currentRun, currentSession] = await Promise.all([
      this.taskRuntime.getRun(run.id).catch(() => undefined),
      this.taskRuntime.getAgentSession(run.sessionId).catch(() => undefined)
    ]);
    const runIsSafe = Boolean(
      currentRun &&
        (currentRun.status === 'RECOVERY_REQUIRED' ||
          ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(currentRun.status))
    );
    const sessionIsSafe = Boolean(currentSession && currentSession.status !== 'ACTIVE');
    if (!runIsSafe || !sessionIsSafe || quarantineFailure) {
      throw new AggregateError(
        [cause, recoveryPublicationFailure, quarantineFailure].filter(
          (failure) => failure !== undefined
        ),
        'ACP prompt terminal persistence failed and recovery ownership could not be established.'
      );
    }

    this.appEvents.emit({
      type: 'run.state.updated',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: {
        eventType: 'session/prompt/finalization-recovery',
        recoveryState: currentRun?.recoveryState,
        automaticReplay: false
      },
      at: new Date().toISOString()
    });
  }

  private async staleRunInteractions(run: RunRecord, reason: string): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) =>
        candidate.runId === run.id && ['PENDING', 'RESPONDING'].includes(candidate.status)
    )) {
      const stale = await this.taskRuntime.transitionInteractionRequest(
        interaction.id,
        interaction.status,
        {
          status: 'STALE',
          resolution: { reason },
          resolvedAt: new Date().toISOString()
        },
        acpRuntimeOperationId('interaction/stale', interaction.id, interaction.status, reason)
      );
      this.emitInteractionUpdate(stale);
    }
  }

  /**
   * ACP session updates do not carry a prompt ID. Once delivery or
   * cancellation becomes ambiguous, keeping the application-scoped process
   * alive could attribute late output from the old prompt to a replacement
   * run. Stop and forget the whole process before any session can be reused.
   */
  private async quarantineRuntimeAfterAmbiguousMutation(
    operation: string,
    detail: string,
    drainInboundBeforeReplacement = true
  ): Promise<void> {
    await this.quarantineRuntimeGeneration(
      `Task Monki quarantined the ACP process after ambiguous ${operation}. ${detail}`,
      drainInboundBeforeReplacement
    );
  }

  private async quarantineRuntimeGeneration(
    reason: string,
    drainInboundBeforeReplacement: boolean
  ): Promise<void> {
    if (this.runtimeSafetyFence) throw this.runtimeSafetyFence;
    if (this.runtimeQuarantinePromise) {
      // An inbound callback can discover the same ambiguity while a foreground
      // quarantine is draining this queue. Waiting from that callback would
      // make the quarantine wait on itself.
      if (drainInboundBeforeReplacement) await this.runtimeQuarantinePromise;
      return;
    }
    const quarantine = this.quarantineRuntime(
      reason,
      drainInboundBeforeReplacement
    );
    this.runtimeQuarantinePromise = quarantine;
    try {
      await quarantine;
    } catch (cause) {
      throw this.latchRuntimeSafetyFence(
        `ACP process quarantine failed and the runtime cannot be reused safely: ${errorMessage(cause)}`
      );
    } finally {
      if (this.runtimeQuarantinePromise === quarantine) {
        this.runtimeQuarantinePromise = undefined;
      }
    }
  }

  private async quarantineRuntime(
    reason: string,
    drainInboundBeforeReplacement: boolean
  ): Promise<void> {
    const supervisor = this.supervisor;
    const server = supervisor?.currentServer;
    if (!supervisor || !server) return;
    const client = this.boundClient;
    const inboundAtFence = this.inboundQueue;

    // Invalidate synchronously, before process shutdown yields. Every already
    // queued or subsequently delivered callback from this client is now a
    // no-op, even if a replacement process is later bound.
    this.invalidateBoundClient(client);
    // The provider process may outlive an unconfirmed shutdown. Remove its
    // generation-bound bridge credentials before waiting on that shutdown.
    await this.releaseDesignToolGrantsForGeneration(server.id).catch((cause) =>
      this.noteDesignToolCleanupFailure(cause)
    );
    let shutdownFailure: unknown;
    try {
      await supervisor.shutdown();
    } catch (cause) {
      shutdownFailure = cause;
    }
    const safetyFenceReason = supervisor.safetyFenceReason;
    if (shutdownFailure || safetyFenceReason || supervisor.currentClient) {
      const failureDetail = shutdownFailure
        ? errorMessage(shutdownFailure)
        : safetyFenceReason ?? 'The ACP client remained connected after quarantine.';
      this.preflightState = appendRuntimeDiagnostic(
        this.preflightState,
        errorDiagnostic(
          'RUNTIME_QUARANTINE_INCOMPLETE',
          'SECURITY',
          'ACP process quarantine reported an incomplete shutdown.',
          failureDetail
        ),
        'FAILED'
      );
      this.emitRuntimeUpdate();
      throw new Error(`ACP process quarantine failed: ${failureDetail}`, {
        cause: shutdownFailure
      });
    }
    // Foreground mutations can safely wait for all work that was queued at the
    // fence. An inbound callback cannot await its own queue tail; in that case
    // generation invalidation provides the same logical drain and the callback
    // must unwind before later queued work can execute.
    if (drainInboundBeforeReplacement) await inboundAtFence;
    await this.handleRuntimeLoss(server.id, reason);
    await this.reconcile();
    if (this.supervisor === supervisor) this.supervisor = undefined;
  }

  private latchRuntimeSafetyFence(reason: unknown): Error {
    if (!this.runtimeSafetyFence) {
      this.runtimeSafetyFence = new Error(
        `ACP runtime is safety-fenced until Task Monki restarts. ${this.redactProviderText(
          errorMessage(reason)
        )}`
      );
    }
    return this.runtimeSafetyFence;
  }

  private async handleRuntimeLoss(
    serverInstanceId: string,
    reason = `${this.descriptor.displayName} exited unexpectedly.`
  ): Promise<void> {
    reason = this.redactProviderText(reason);
    try {
      await this.releaseDesignToolGrantsForGeneration(serverInstanceId);
    } catch (cause) {
      reason = `${reason} The Design MCP grant was revoked, but scratch cleanup failed: ${this.redactProviderText(errorMessage(cause))}`;
    }
    const loadedProviderSessionIds = new Set(this.nativeSessions.keys());
    const provisionalLocalSessionIds = new Set(this.provisionalProviderSessionIds.keys());
    const runtimeSnapshot = await this.providerRuntime.snapshot();
    const runtimeSessions = runtimeSnapshot.sessions.filter(
      (session) =>
        session.runtimeId === this.descriptor.id &&
        isAcpReadOnlyRuntimeSession(session, this.profile)
    );
    const runtimeSessionIds = new Set(runtimeSessions.map((session) => session.id));
    const runtimeRuns = runtimeSnapshot.runs.filter(
      (run) =>
        runtimeSessionIds.has(run.sessionId) &&
        run.serverInstanceId === serverInstanceId &&
        ACTIVE_RUN_STATUSES.includes(run.status)
    );
    for (const run of runtimeRuns) {
      try {
        await this.flushRuntimeOutput(run.id, true);
      } catch {
        // Recovery below remains authoritative if buffered output cannot be
        // persisted during process loss.
      }
      await this.markRuntimeRecoveryRequired(
        run.id,
        `${reason} Prompt outcome is ambiguous and will not be replayed.`
      );
    }
    this.preflightState = {
      ...this.preflightState,
      readiness: createRuntimeReadiness(
        'DEGRADED',
        `${reason} Existing turns require recovery; a new session can relaunch the runtime.`,
        {
          checks: {
            ...this.preflightState.readiness.checks,
            initialization: 'FAILED'
          },
          diagnostics: [
            ...this.preflightState.readiness.diagnostics,
            errorDiagnostic(
              'RUNTIME_EXITED',
              'HEALTH',
              reason
            )
          ],
          nextAction: { kind: 'RETRY', label: 'Start a new provider session' }
        }
      )
    };
    this.nativeSessions.clear();
    this.activePromptRunIds.clear();
    this.activeRuntimePromptRunIds.clear();
    this.initializeResponse = undefined;
    this.invalidateBoundClient();
    const snapshot = await this.taskRuntime.snapshot();
    const affectedRuns = snapshot.runs.filter(
      (candidate) =>
        candidate.runtimeId === this.descriptor.id &&
        !runtimeSessionIds.has(candidate.sessionId) &&
        candidate.serverInstanceId === serverInstanceId &&
        ACTIVE_RUN_STATUSES.includes(candidate.status)
    );
    for (const run of affectedRuns) {
      await this.flushRunContent(run.id, true);
      const lossPublished = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
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
            reason: `${reason} Prompt outcome is ambiguous and will not be replayed.`
          }
        }),
        [run.status],
        acpRuntimeOperationId('event/runtime-lost', run.id, serverInstanceId, run.status, reason)
      );
      if (!lossPublished) continue;
      await this.taskRuntime.updateAgentSession(
        run.sessionId,
        { status: 'NOT_LOADED' },
        acpRuntimeOperationId('session/runtime-lost', run.sessionId, serverInstanceId, run.id)
      );
      this.appEvents.emit({
        type: 'run.state.updated',
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
    // Every native session in an application-scoped ACP process becomes
    // unloaded when that process is fenced, including idle sessions without an
    // active run. Persist that boundary so UI and restart recovery cannot
    // mistake an old provider session for a currently attached one.
    for (const session of snapshot.agentSessions.filter(
      (candidate) =>
        candidate.runtimeId === this.descriptor.id &&
        !runtimeSessionIds.has(candidate.id) &&
        (provisionalLocalSessionIds.has(candidate.id) ||
          (candidate.providerSessionId !== undefined &&
            loadedProviderSessionIds.has(candidate.providerSessionId)))
    )) {
      if (session.status !== 'NOT_LOADED') {
        await this.taskRuntime.updateAgentSession(
          session.id,
          { status: 'NOT_LOADED' },
          acpRuntimeOperationId('session/runtime-lost-idle', session.id, serverInstanceId)
        );
      }
    }
    for (const runtimeSession of runtimeSessions) {
      const current = await this.providerRuntime.getSession(runtimeSession.id);
      if (!current || current.status === 'NOT_LOADED') continue;
      await this.updateRuntimeSession(
        current.id,
        { status: 'NOT_LOADED' },
        acpRuntimeOperationId(
          'runtime/session-lost-idle',
          current.id,
          serverInstanceId
        )
      );
    }
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) =>
        candidate.serverInstanceId === serverInstanceId &&
        ['PENDING', 'RESPONDING'].includes(candidate.status)
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
          acpRuntimeOperationId('interaction/runtime-lost', latest.id, latest.status, serverInstanceId, reason)
        );
        this.emitInteractionUpdate(aborted);
      } catch (cause) {
        // A terminal prompt handler can resolve or stale the interaction while
        // process-loss reconciliation is running. That terminal state wins;
        // only propagate a failure if the interaction is still unresolved.
        const raced = await this.taskRuntime.getInteractionRequest(interaction.id);
        if (raced && ['PENDING', 'RESPONDING'].includes(raced.status)) throw cause;
      }
    }
    this.emitRuntimeUpdate();
    this.schedulePendingRuntimeReset();
  }

  private async recoverPersistedRuntimeLosses(): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    for (const server of agentServersRequiringLossRecovery(
      snapshot,
      this.descriptor.id
    )) {
      if (!['EXITED', 'FAILED', 'LOST'].includes(server.status)) {
        await this.providerRuntime.updateAgentServer(server.id, {
          status: 'LOST',
          disconnectedAt: new Date().toISOString(),
          exitedAt: new Date().toISOString(),
          exitReason: 'Task Monki restarted without the prior ACP process.'
        });
      }
      await this.handleRuntimeLoss(server.id);
    }
  }

  private async cancelPendingPermissions(run: RunRecord, client: AcpRpcClient): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    for (const interaction of snapshot.interactionRequests.filter(
      (candidate) => candidate.runId === run.id && candidate.status === 'PENDING'
    )) {
      const responding = await this.taskRuntime.transitionInteractionRequest(
        interaction.id,
        'PENDING',
        {
          status: 'RESPONDING',
          decision: { interactionType: 'COMMAND_APPROVAL', action: 'CANCEL' },
          respondedAt: new Date().toISOString()
        },
        acpRuntimeOperationId('interaction/cancel-intent', interaction.id, interaction.requestedAt)
      );
      const raw = await client.respond(
        responding.providerRequestId,
        { outcome: { outcome: 'cancelled' } },
        async (reference) => {
          await this.taskRuntime.transitionInteractionRequest(responding.id, 'RESPONDING', {
            status: 'RESPONDING',
            responseRawMessage: reference
          }, acpProtocolOperationId('interaction/cancel-sent', reference, responding.id));
        }
      );
      const canceled = await this.taskRuntime.transitionInteractionRequest(
        responding.id,
        'RESPONDING',
        {
          status: 'CANCELED',
          responseRawMessage: raw,
          resolution: { outcome: 'cancelled' },
          resolvedAt: new Date().toISOString()
        },
        acpProtocolOperationId('interaction/cancel-acknowledged', raw, responding.id)
      );
      this.emitInteractionUpdate(canceled);
    }
  }

  private armInterruptDeadline(runId: string): void {
    this.clearInterruptDeadline(runId);
    const timer = setTimeout(() => {
      this.interruptTimers.delete(runId);
      this.enqueueInbound(async () => {
        const run = await this.taskRuntime.getRun(runId);
        if (!run || run.status !== 'INTERRUPTING') return;
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
              operation: 'session/cancel',
              reason: 'ACP agent did not return a cancelled prompt response before the deadline.'
            }
          }),
          acpRuntimeOperationId('event/interrupt-timeout', run.id, run.serverInstanceId)
        );
        await this.quarantineRuntimeAfterAmbiguousMutation(
          'session/cancel',
          `The provider did not confirm cancellation for run ${run.id} before the deadline.`,
          false
        );
        this.appEvents.emit({
          type: 'run.state.updated',
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
    source:
      | 'TASK_MONKI_RESOLUTION'
      | 'THREAD_START_RESPONSE'
      | 'THREAD_RESUME_RESPONSE'
      | 'THREAD_SETTINGS_NOTIFICATION',
    settings: AgentExecutionSettings,
    rawMessage?: AgentProtocolMessageReference,
    detail?: string
  ): Promise<void> {
    await this.taskRuntime.recordAgentSettingsObservation({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runtimeId: this.descriptor.id,
      source,
      settings,
      detail,
      rawMessage
    }, rawMessage
      ? acpProtocolOperationId('settings/observed', rawMessage, session.id, source)
      : acpRuntimeOperationId('settings/observed', session.id, source, settings, detail));
  }

  private async recordRunActivity(
    run: RunRecord,
    eventType: string,
    raw: AgentProtocolMessageReference,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const payload = this.redactProviderValue({ eventType, ...details, rawMessage: raw });
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
        payload
      }),
      acpProtocolOperationId('event/activity', raw, run.id, eventType, details)
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
      ? await this.taskRuntime.getAgentSessionByProviderId(this.descriptor.id, providerSessionId)
      : undefined;
    const run = session ? await this.taskRuntime.getActiveRunForSession(session.id) : undefined;
    if (run) await this.recordRunActivity(run, `extension:${method}`, raw);
  }

  private async recordProtocolIncident(
    detail: string,
    raw: AgentProtocolMessageReference
  ): Promise<void> {
    detail = this.redactProviderText(detail);
    const runs = await this.taskRuntime.getRunsRequiringRecovery({ runtimeId: this.descriptor.id });
    const run = runs[0];
    if (!run) return;
    await this.taskRuntime.applyTaskRuntimeEvent(
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
      }),
      acpProtocolOperationId('event/protocol-incident', raw, run.id, detail)
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
          prompt: this.initializeResponse.agentCapabilities.promptCapabilities
        }
      : undefined;
    const capabilities = acpCapabilities(this.profile, negotiated);
    return {
      ...capabilities,
      extensions: {
        ...capabilities.extensions,
        'task-monki.design-instructions': this.designSkillPack
          ? {
              maturity: 'stable' as const,
              detail: 'Maps the shared Design instruction profile to a bounded app-prepended ACP prompt block.'
            }
          : {
              maturity: 'unsupported' as const,
              detail:
                this.designSkillFailure ??
                'The app-owned Design skill pack has not been validated yet.'
            },
        'task-monki.design-skill-access': this.designSkillPack
          ? {
              maturity: 'stable' as const,
              detail: 'The validated app-owned skill catalog gives exact skill files to the Design agent.'
            }
          : {
              maturity: 'unsupported' as const,
              detail:
                this.designSkillFailure ??
                'The app-owned Design skill pack has not been validated yet.'
            },
        'task-monki.design-browser-verification': this.options.designClientToolBridge
          ? {
              maturity: 'stable' as const,
              detail: 'A generation-bound packaged inspect_design MCP bridge is configured.'
            }
          : {
              maturity: 'unsupported' as const,
              detail: 'The packaged inspect_design MCP bridge has not been configured yet.'
            },
        'task-monki.browser-dev-isolation': {
          maturity: 'unsupported',
          detail: 'ACP negotiation does not attest OS process, filesystem, and network isolation.'
        }
      }
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

  private designSessionContextForCreate(
    input: Pick<CreateAgentSession, 'mode' | 'instructionProfile'>,
    session: AgentSessionRecord
  ): AcpDesignSessionContext | undefined {
    if (input.mode !== 'DESIGN' && input.instructionProfile !== 'DESIGN') return undefined;
    if (input.mode !== 'DESIGN' || input.instructionProfile !== 'DESIGN') {
      throw new Error('The DESIGN instruction profile is valid only for a Design session.');
    }
    return { localSessionId: session.id, worktreeId: session.worktreeId };
  }

  private async designSessionContextForAttach(
    session: AgentSessionRecord
  ): Promise<AcpDesignSessionContext | undefined> {
    const run = await this.taskRuntime.getActiveRunForSession(session.id);
    if (!run || run.mode !== 'DESIGN') return undefined;
    return { localSessionId: session.id, worktreeId: session.worktreeId };
  }

  private async prepareDesignMcpServer(
    context: AcpDesignSessionContext
  ): Promise<AcpStdioMcpServer> {
    const bridge = this.options.designClientToolBridge;
    if (!bridge) {
      throw new Error('The packaged inspect_design MCP bridge is unavailable.');
    }
    const providerGeneration = this.supervisor?.currentServer?.id;
    if (!providerGeneration) throw new Error('ACP runtime is not ready.');
    let grant = this.designToolGrants.get(context.localSessionId);
    if (
      grant &&
      (grant.providerGeneration !== providerGeneration ||
        grant.worktreeId !== context.worktreeId)
    ) {
      await bridge.releaseSessionGrant(grant.grantId);
      this.designToolGrants.delete(context.localSessionId);
      grant = undefined;
    }
    if (!grant) {
      const created = await bridge.createSessionGrant({
        runtimeId: this.descriptor.id,
        sessionId: context.localSessionId,
        worktreeId: context.worktreeId,
        providerGeneration
      });
      grant = {
        grantId: created.id,
        providerGeneration,
        worktreeId: context.worktreeId,
        launch: created.launch
      };
      this.designToolGrants.set(context.localSessionId, grant);
    }
    return {
      name: ACP_DESIGN_MCP_SERVER_NAME,
      command: grant.launch.executablePath,
      args: [...grant.launch.argv],
      env: Object.entries(grant.launch.environment)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => ({ name, value }))
    };
  }

  private async activateDesignToolGrant(
    run: RunRecord,
    providerGeneration: string
  ): Promise<void> {
    if (run.mode !== 'DESIGN') return;
    const bridge = this.options.designClientToolBridge;
    const grant = this.designToolGrants.get(run.sessionId);
    if (!bridge || !grant || grant.providerGeneration !== providerGeneration) {
      throw new Error(
        'The inspect_design MCP grant does not belong to the active ACP generation.'
      );
    }
    await bridge.activateGrant({
      grantId: grant.grantId,
      authority: {
        runtimeId: this.descriptor.id,
        sessionId: run.sessionId,
        runId: run.id,
        worktreeId: run.worktreeId,
        providerGeneration
      }
    });
  }

  private activeInspectDesignTool(
    run: RunRecord,
    toolCall: AcpToolCallUpdate,
    providerGeneration: string
  ): boolean {
    const grant = this.designToolGrants.get(run.sessionId);
    return (
      run.mode === 'DESIGN' &&
      run.serverInstanceId === providerGeneration &&
      grant?.providerGeneration === providerGeneration &&
      isTaskMonkiInspectDesignToolCall(toolCall)
    );
  }

  private async revokeDesignToolGrant(run: RunRecord): Promise<void> {
    if (run.mode !== 'DESIGN') return;
    const grant = this.designToolGrants.get(run.sessionId);
    if (
      !grant ||
      !run.serverInstanceId ||
      grant.providerGeneration !== run.serverInstanceId
    ) {
      return;
    }
    await this.options.designClientToolBridge?.revokeGrant(grant.grantId);
  }

  private async revokeDesignToolGrantSafely(run: RunRecord): Promise<void> {
    try {
      await this.revokeDesignToolGrant(run);
    } catch (cause) {
      this.noteDesignToolCleanupFailure(cause);
    }
  }

  private async releaseDesignToolGrant(
    localSessionId: string,
    providerGeneration?: string
  ): Promise<void> {
    const grant = this.designToolGrants.get(localSessionId);
    if (!grant || (providerGeneration && grant.providerGeneration !== providerGeneration)) return;
    await this.options.designClientToolBridge?.releaseSessionGrant(grant.grantId);
    this.designToolGrants.delete(localSessionId);
  }

  private async releaseDesignToolGrantSafely(localSessionId: string): Promise<void> {
    try {
      await this.releaseDesignToolGrant(localSessionId);
    } catch (cause) {
      this.noteDesignToolCleanupFailure(cause);
    }
  }

  private noteDesignToolCleanupFailure(cause: unknown): void {
    this.preflightState = appendRuntimeDiagnostic(
      this.preflightState,
      warningDiagnostic(
        'DESIGN_TOOL_CREDENTIAL_CLEANUP_FAILED',
        'HEALTH',
        'The Design tool credential was revoked, but its temporary file could not be removed.',
        this.redactProviderText(errorMessage(cause))
      ),
      this.preflightState.readiness.status === 'READY' ? 'DEGRADED' : undefined
    );
    this.emitRuntimeUpdate();
  }

  private async releaseDesignToolGrantsForGeneration(
    providerGeneration: string
  ): Promise<void> {
    await Promise.all(
      [...this.designToolGrants.entries()]
        .filter(([, grant]) => grant.providerGeneration === providerGeneration)
        .map(([sessionId]) =>
          this.releaseDesignToolGrant(sessionId, providerGeneration)
        )
    );
  }

  private async releaseAllDesignToolGrants(): Promise<void> {
    await Promise.all(
      [...this.designToolGrants.keys()].map((sessionId) =>
        this.releaseDesignToolGrant(sessionId)
      )
    );
  }

  private designInstructions(
    input: Pick<StartAgentTurn, 'mode' | 'instructionProfile'>
  ): string | undefined {
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
    return buildDesignAgentDeveloperInstructions(this.designSkillPack.catalog);
  }

  private refreshModels(): void {
    const extension = this.profile.sessionModelExtension;
    const profileModels = this.profileModelState;
    if (extension?.initializeResponseMetaField && profileModels) {
      const models = profileModels.availableModels.flatMap((model): AgentModel[] => {
        if (!isSafeProviderIdentifier(model.modelId, this.sensitiveValues)) return [];
        const supportedReasoningEfforts = (model.reasoningEfforts ?? [])
          .map((effort) => effort.value)
          .filter((effort) =>
            isSafeProviderIdentifier(effort, this.sensitiveValues)
          );
        const advertisedDefaultReasoningEffort = model.reasoningEfforts?.find(
          (effort) => effort.default
        )?.value;
        const providerDefaultReasoningEffort =
          advertisedDefaultReasoningEffort &&
          supportedReasoningEfforts.includes(advertisedDefaultReasoningEffort)
            ? advertisedDefaultReasoningEffort
            : undefined;
        return [{
          id: `${this.descriptor.id}:${this.profile.defaultModelProvider}/${model.modelId}`,
          runtimeId: this.descriptor.id,
          modelProvider: this.profile.defaultModelProvider,
          model: model.modelId,
          displayName: this.redactProviderText(model.name),
          description: model.description
            ? this.redactProviderText(model.description)
            : undefined,
          hidden: false,
          supportedReasoningEfforts,
          defaultReasoningEffort: providerDefaultReasoningEffort,
          serviceTiers: [],
          inputModalities: this.modelInputModalities(model.modelId),
          designSupport: acpDesignSupport({
            profile: this.profile,
            runtimeVersion: this.resolvedRuntime?.version,
            modelId: model.modelId
          }),
          isDefault: model.modelId === profileModels.currentModelId,
          native: {
            source: 'provider-model-extension',
            contractId: extension.contractId,
            ...(supportedReasoningEfforts.length > 0
              ? { advertisedReasoningEfforts: supportedReasoningEfforts }
              : {}),
            ...(providerDefaultReasoningEffort
              ? { providerDefaultReasoningEffort }
              : {})
          }
        }];
      });
      if (
        models.length > 0 &&
        models.some((model) => model.model === profileModels.currentModelId)
      ) {
        this.models = models;
        return;
      }
      this.noteSensitiveIdentifierOmission();
    }
    const parameterizedContract = this.profile.parameterizedModelCatalog;
    if (parameterizedContract && this.parameterizedModelCatalog) {
      this.models = this.parameterizedModelCatalog.models.map((model) => {
        const reasoning = parameterizedModelReasoningSelector(
          model.configOptions ?? []
        );
        const supportedReasoningEfforts = reasoning
          ? flattenSelectOptions(reasoning).map((choice) => choice.value)
          : [];
        const defaultReasoningEffort =
          reasoning && supportedReasoningEfforts.includes(reasoning.currentValue)
            ? reasoning.currentValue
            : undefined;
        return {
          id: `${this.descriptor.id}:${this.profile.defaultModelProvider}/${model.value}`,
          runtimeId: this.descriptor.id,
          modelProvider: this.profile.defaultModelProvider,
          model: model.value,
          displayName: this.redactProviderText(model.name),
          hidden: false,
          supportedReasoningEfforts,
          defaultReasoningEffort,
          serviceTiers: [],
          inputModalities: this.modelInputModalities(model.value),
          designSupport: acpDesignSupport({
            profile: this.profile,
            runtimeVersion: this.resolvedRuntime?.version,
            modelId: model.value
          }),
          isDefault: model.value === this.profile.defaultModel,
          native: {
            source: 'provider-parameterized-model-catalog',
            contractId: parameterizedContract.contractId,
            ...(reasoning ? { reasoningConfigId: reasoning.id } : {})
          }
        };
      });
      return;
    }
    // Stable ACP model selectors remain scoped to the provider session that
    // advertised them. Only an explicit provider catalog contract may populate
    // the application model picker before session creation.
    this.models = [
      {
        ...defaultAcpModel(
          this.profile,
          this.modelInputModalities(this.profile.defaultModel)
        ),
        designSupport: acpDesignSupport({
          profile: this.profile,
          runtimeVersion: this.resolvedRuntime?.version,
          modelId: this.profile.defaultModel
        })
      }
    ];
  }

  private modelInputModalities(modelId: string): string[] {
    return acpModelInputModalities({
      profile: this.profile,
      promptCapabilities:
        this.initializeResponse?.agentCapabilities.promptCapabilities,
      runtimeVersion: this.resolvedRuntime?.version,
      modelId
    });
  }

  private async requireSession(sessionId: string): Promise<AgentSessionRecord> {
    const session = await this.taskRuntime.getAgentSession(sessionId);
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

  private enqueueInbound(operation: () => Promise<void>): Promise<void> {
    const result = this.inboundQueue.then(operation, operation);
    this.inboundQueue = result.catch((cause) => {
      this.preflightState = appendRuntimeDiagnostic(
        this.preflightState,
        warningDiagnostic(
          'EVENT_MATERIALIZATION_FAILED',
          'HEALTH',
          'ACP event materialization failed.',
          this.redactProviderText(errorMessage(cause))
        ),
        this.preflightState.readiness.status === 'READY' ? 'DEGRADED' : undefined
      );
      this.emitRuntimeUpdate();
    });
    return result;
  }

  private emitRuntimeUpdate(): void {
    const nativeSessions = [...this.nativeSessions.values()].flatMap((state) => {
      if (!isSafeProviderIdentifier(state.sessionId, this.sensitiveValues)) {
        this.noteSensitiveIdentifierOmission();
        return [];
      }
      if (hasUnsafeAcpActionableIdentifier(state, this.sensitiveValues)) {
        this.noteSensitiveIdentifierOmission();
      }
      return [sanitizeAcpNativeSession(state, this.sensitiveValues)];
    });
    const payload = this.redactProviderValue({
      preflight: this.preflightState,
      models: this.models,
      nativeSessions
    });
    this.appEvents.emit({
      type: 'runtime.updated',
      taskId: `runtime:${this.descriptor.id}`,
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

  private boundedItemPayload(value: unknown): AgentJsonValue {
    const encoded = JSON.stringify(value);
    if (
      encoded !== undefined &&
      Buffer.byteLength(encoded, 'utf8') <= AGENT_RUNTIME_LIMITS.maxTelemetryPayloadBytes
    ) {
      return value as AgentJsonValue;
    }
    const type = isRecord(value) && typeof value.type === 'string'
      ? this.redactProviderText(value.type)
      : undefined;
    return {
      ...(type ? { type } : {}),
      truncated: true,
      byteLength: encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8')
    };
  }

  private projectObservedSettings(
    state: AcpNativeSessionState,
    requested: AgentExecutionSettings
  ): AgentExecutionSettings {
    const observed = observedSettingsFromAcpState(this.profile, state, requested);
    if (!hasUnsafeAcpActionableIdentifier(state, this.sensitiveValues)) {
      return this.redactProviderValue(observed);
    }
    this.noteSensitiveIdentifierOmission();
    const runtimeOptions = { ...observed.runtimeOptions };
    delete runtimeOptions[this.descriptor.id];
    return {
      ...observed,
      model:
        observed.model && isSafeProviderIdentifier(observed.model, this.sensitiveValues)
          ? observed.model
          : undefined,
      runtimeOptions: Object.keys(runtimeOptions).length > 0 ? runtimeOptions : undefined
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
        'The ACP agent returned an operational identifier matching a runtime credential, so the affected native view or control was omitted.',
        'Exact identifiers remain internal for protocol ownership and are never replaced with redacted placeholders in actionable views.'
      )
    );
  }
}

export function isTaskMonkiInspectDesignToolCall(
  toolCall: Pick<AcpToolCallUpdate, 'title' | 'rawInput'>
): boolean {
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : undefined;
  if (!rawInput) return false;
  const title = toolCall.title?.trim();
  const isCursorTool =
    rawInput.providerIdentifier === ACP_DESIGN_MCP_SERVER_NAME &&
    rawInput.toolName === INSPECT_DESIGN_TOOL_NAME &&
    isRecord(rawInput.args);
  return (
    (title === CURSOR_DESIGN_TOOL_TITLE && isCursorTool) ||
    (title === GROK_DESIGN_TOOL_NAME &&
      rawInput.tool_name === GROK_DESIGN_TOOL_NAME &&
      isRecord(rawInput.tool_input))
  );
}

function acpRuntimeDiagnostics(authenticationAdvertised: boolean): AgentRuntimeDiagnostic[] {
  return [
    infoDiagnostic(
      'ACP_CLIENT_TOOLS_DISABLED',
      'SECURITY',
      'Task Monki exposes no filesystem or terminal client tools to the ACP agent.',
      'Agent-native tools remain inside the provider process.'
    ),
    warningDiagnostic(
      'PROVIDER_PROCESS_NOT_SANDBOXED',
      'SECURITY',
      'The ACP process has no Task Monki-attested workspace or network sandbox.',
      'Access modes govern Task Monki responses to reported requests; they do not confine unreported provider activity.'
    ),
    ...(authenticationAdvertised
      ? [
          infoDiagnostic(
            'PROVIDER_AUTHENTICATION_MANAGED',
            'AUTHENTICATION',
            'Authentication remains owned by the provider runtime.'
          )
        ]
      : [])
  ];
}

function acpFailureReadiness(
  profile: AcpRuntimeProfile,
  cause: unknown,
  sensitiveValues: readonly string[] = []
) {
  const message = redactCredentialText(errorMessage(cause), sensitiveValues);
  if (cause instanceof AcpRuntimeResolutionError) {
    const found = cause.code === 'ACP_RUNTIME_INCOMPATIBLE';
    return createRuntimeReadiness(
      found ? 'INCOMPATIBLE' : 'NOT_INSTALLED',
      found
        ? `${profile.descriptor.displayName} was found, but its ACP launch contract is incompatible.`
        : `${profile.descriptor.displayName} was not found on this computer.`,
      {
        checks: {
          discovery: found ? 'FOUND' : 'NOT_FOUND',
          compatibility: found ? 'INCOMPATIBLE' : 'UNKNOWN',
          initialization: 'NOT_STARTED'
        },
        diagnostics: [
          errorDiagnostic(
            cause.code,
            found ? 'COMPATIBILITY' : 'DISCOVERY',
            message
          ),
          ...cause.diagnostics.probes.map((probe) =>
            errorDiagnostic(
              'ACP_RUNTIME_PROBE_REJECTED',
              'COMPATIBILITY',
              `${probe.executable}: ${probe.detail}`
            )
          )
        ],
        nextAction: {
          kind: found ? 'CONFIGURE' : 'INSTALL',
          label: found ? 'Choose the correct executable' : `Install ${profile.descriptor.displayName}`
        }
      }
    );
  }
  return createRuntimeReadiness('FAILED', message, {
    checks: { initialization: 'FAILED' },
    diagnostics: [
      errorDiagnostic('ACP_RUNTIME_INITIALIZATION_FAILED', 'INITIALIZATION', message)
    ],
    nextAction: { kind: 'RETRY', label: 'Retry runtime discovery' }
  });
}

export function acpSessionFailureReadiness(
  profile: AcpRuntimeProfile,
  cause: unknown,
  checks: AgentPreflight['readiness']['checks'],
  runtimeConnected = true,
  sensitiveValues: readonly string[] = []
) {
  const message = redactCredentialText(errorMessage(cause), sensitiveValues);
  if (cause instanceof AcpSessionContractError) {
    return createRuntimeReadiness(
      'INCOMPATIBLE',
      `${profile.descriptor.displayName} initialized, but its session response is incompatible with the negotiated ACP contract.`,
      {
        checks: {
          ...checks,
          discovery: 'FOUND',
          compatibility: 'INCOMPATIBLE',
          initialization: runtimeConnected ? 'INITIALIZED' : 'FAILED',
          authentication: 'UNKNOWN',
          modelCatalog: 'FAILED'
        },
        diagnostics: [
          ...acpRuntimeDiagnostics(true),
          errorDiagnostic(
            'ACP_SESSION_CONTRACT_INCOMPATIBLE',
            'COMPATIBILITY',
            message
          )
        ],
        nextAction: {
          kind: 'CONFIGURE',
          label: 'Update or choose a compatible runtime'
        }
      }
    );
  }
  if (cause instanceof AgentMutationAmbiguousError) {
    return createRuntimeReadiness(
      'DEGRADED',
      `${profile.descriptor.displayName} returned an ambiguous session mutation. The old process was quarantined; a new session can relaunch it safely.`,
      {
        checks: {
          ...checks,
          discovery: 'FOUND',
          compatibility: 'COMPATIBLE',
          initialization: runtimeConnected ? 'INITIALIZED' : 'FAILED',
          authentication: checks.authentication,
          modelCatalog: 'UNKNOWN'
        },
        diagnostics: [
          ...acpRuntimeDiagnostics(true),
          warningDiagnostic(
            'ACP_SESSION_MUTATION_AMBIGUOUS',
            'HEALTH',
            message,
            'Automatic mutation replay is disabled.'
          )
        ],
        nextAction: { kind: 'RETRY', label: 'Start a new provider session' }
      }
    );
  }
  const authenticationRequired =
    /(?:authentication|authenticate|unauthorized|sign[ -]?in|log[ -]?in|credential|api key)/iu.test(
      message
    );
  const status = authenticationRequired
      ? 'AUTHENTICATION_REQUIRED'
      : 'FAILED';
  const detail = authenticationRequired
      ? `Authenticate ${profile.descriptor.displayName} before starting a task.`
      : `${profile.descriptor.displayName} could not create a provider session.`;
  return createRuntimeReadiness(status, detail, {
    checks: {
      ...checks,
      compatibility: 'COMPATIBLE',
      initialization: runtimeConnected ? 'INITIALIZED' : 'FAILED',
      authentication: authenticationRequired
          ? 'REQUIRED'
          : 'UNKNOWN',
      modelCatalog: authenticationRequired ? 'UNKNOWN' : 'FAILED'
    },
    diagnostics: [
      ...acpRuntimeDiagnostics(true),
      errorDiagnostic(
        authenticationRequired
            ? 'PROVIDER_AUTHENTICATION_REQUIRED'
            : 'PROVIDER_SESSION_CREATION_FAILED',
        authenticationRequired
          ? 'AUTHENTICATION'
          : 'INITIALIZATION',
        message
      )
    ],
    nextAction: {
      kind: authenticationRequired ? 'AUTHENTICATE' : 'RETRY',
      label: authenticationRequired
          ? `Sign in to ${profile.descriptor.displayName}`
          : 'Retry provider session'
    }
  });
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
      `${profile.descriptor.displayName} cannot enforce Task Monki's ${settings.sandbox ?? 'restricted'} filesystem sandbox over ACP. Its process runs with provider-native filesystem permissions.`
    );
  }
  if (settings.networkAccess !== true) {
    throw new Error(
      `${profile.descriptor.displayName} cannot attest network-disabled execution over ACP. Enable network access only if you accept provider-native network permissions.`
    );
  }
  const approvalPolicy = settings.approvalPolicy ?? 'on-request';
  const supportedApprovalPolicies = profile.approvalPolicies ?? ['on-request'];
  if (
    approvalPolicy !== 'NEVER' &&
    !supportedApprovalPolicies.some((candidate) => candidate === approvalPolicy)
  ) {
    throw new Error(
      `${profile.descriptor.displayName} does not support ACP approval policy ${approvalPolicy}.`
    );
  }
  if (approvalPolicy === 'NEVER') {
    const policy = requireAcpReadOnlyTurnPolicy(profile);
    const native = settings.runtimeOptions?.[profile.descriptor.id];
    if (!isRecord(native) || native.modeId !== policy.modeId) {
      throw new Error(
        `${profile.descriptor.displayName} read-only execution requires native mode ${policy.modeId}.`
      );
    }
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

export function requireAcpReadOnlyTurnPolicy(
  profile: AcpRuntimeProfile
): NonNullable<AcpRuntimeProfile['readOnlyTurnPolicy']> {
  if (!profile.readOnlyTurnPolicy) {
    throw new Error(
      profile.readOnlyTurnUnavailableReason ??
        `${profile.descriptor.displayName} has no qualified native read-only policy.`
    );
  }
  return profile.readOnlyTurnPolicy;
}

export function normalizeAcpReadOnlyExecutionSettings(
  profile: AcpRuntimeProfile,
  settings: AgentExecutionSettings
): AgentExecutionSettings {
  return settings.approvalPolicy === 'NEVER' || settings.sandbox === 'READ_ONLY'
    ? acpReadOnlyExecutionSettings(profile, settings)
    : settings;
}

function acpReadOnlyExecutionSettings(
  profile: AcpRuntimeProfile,
  settings: AgentExecutionSettings
): AgentExecutionSettings {
  const policy = requireAcpReadOnlyTurnPolicy(profile);
  const native = settings.runtimeOptions?.[profile.descriptor.id];
  const nativeRecord = isRecord(native) ? native : {};
  return {
    ...settings,
    runtimeId: profile.descriptor.id,
    sandbox: 'DANGER_FULL_ACCESS',
    networkAccess: true,
    approvalPolicy: 'NEVER',
    approvalsReviewer: 'user',
    runtimeOptions: {
      ...settings.runtimeOptions,
      [profile.descriptor.id]: {
        ...nativeRecord,
        modeId: policy.modeId
      }
    }
  };
}

function acpReadOnlyProfileHash(input: {
  runtimeId: string;
  sessionId: string;
  policyId: string;
  primaryCwd: string;
  readRoots: readonly { canonicalPath: string; kind: string; entityId?: string }[];
  modelSettings: AgentExecutionSettings;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        formatVersion: 1,
        runtimeId: input.runtimeId,
        sessionId: input.sessionId,
        policyId: input.policyId,
        primaryCwd: path.resolve(input.primaryCwd),
        readRoots: input.readRoots
          .map((root) => ({ ...root, canonicalPath: path.resolve(root.canonicalPath) }))
          .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath)),
        modelSettings: input.modelSettings,
        clientTools: []
      })
    )
    .digest('hex');
}

function runtimeDeliveryErrorForAcp(
  operation: string,
  cause: unknown
): AgentRuntimeDeliveryError {
  const delivery =
    cause instanceof AcpAmbiguousMutationError ||
    cause instanceof AgentMutationAmbiguousError
      ? 'AMBIGUOUS'
      : 'NOT_DELIVERED';
  return new AgentRuntimeDeliveryError(
    delivery,
    `${operation} failed: ${errorMessage(cause)}`,
    { cause }
  );
}

function providerOptions(interaction: InteractionRequestRecord): AcpPermissionOption[] {
  if (!('providerOptions' in interaction.request) || !interaction.request.providerOptions) {
    throw new Error('ACP permission options are missing from the durable interaction.');
  }
  return interaction.request.providerOptions.map((option) => {
    return {
      optionId: option.id,
      name: option.label,
      kind: acpPermissionKindForAgentAction(
        option.action,
        option.providerRemembersChoice
      )
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

function validateAcpConfigValue(
  state: AcpNativeSessionState,
  configId: string,
  value: string | boolean
): AcpSessionConfigOption {
  const option = state.configOptions.find((candidate) => candidate.id === configId);
  if (!option) throw new Error(`ACP session did not advertise config option ${configId}.`);
  if ((option.type === 'boolean') !== (typeof value === 'boolean')) {
    throw new Error(`ACP config option ${configId} received the wrong value type.`);
  }
  if (option.type === 'select' && !selectHasValue(option, String(value))) {
    throw new Error(`ACP config option ${configId} does not offer value ${String(value)}.`);
  }
  return option;
}

function parameterizedModelReasoningSelector(
  configOptions: readonly AcpSessionConfigOption[]
): Extract<AcpSessionConfigOption, { type: 'select' }> | undefined {
  const selectors = configOptions.filter(
    (
      option
    ): option is Extract<AcpSessionConfigOption, { type: 'select' }> =>
      option.type === 'select' && option.category === 'thought_level'
  );
  return selectors.length === 1 ? selectors[0] : undefined;
}

function acknowledgedConfigOptions(
  result: unknown,
  configId: string,
  requestedValue: string | boolean
): AcpSessionConfigOption[] {
  const record = requireRecord(result, 'ACP config response');
  const configOptions = parseConfigOptions(record.configOptions);
  if (!configOptions) {
    throw new Error('ACP config response did not acknowledge the resulting configOptions.');
  }
  const acknowledged = configOptions.filter((option) => option.id === configId);
  if (
    acknowledged.length !== 1 ||
    acknowledged[0]?.currentValue !== requestedValue
  ) {
    throw new Error(
      `ACP config response did not acknowledge ${configId}=${String(requestedValue)}.`
    );
  }
  return configOptions;
}

function itemText(item: AgentItemRecord | undefined): string {
  return isRecord(item?.payload) && typeof item.payload.text === 'string' ? item.payload.text : '';
}

function redactAcpStreamChunk(
  carry: string,
  text: string,
  sensitiveValues: readonly string[]
): { text: string; carry: string } {
  const combined = carry + text;
  if (!combined) return { text: '', carry: '' };
  const sensitive = [...new Set(sensitiveValues)].filter(Boolean);
  if (
    sensitive.some(
      (value) => Buffer.byteLength(value, 'utf8') > MAX_STREAM_CREDENTIAL_CARRY_BYTES
    )
  ) {
    // Retaining enough prefix state for an unusually large inherited secret
    // would violate the adapter's memory bound. Mask this free-form stream
    // instead of weakening exact-secret protection.
    return { text: REDACTED_CREDENTIAL, carry: '' };
  }

  const redacted = redactCredentialText(combined, sensitive);
  let carryLength = 0;
  for (const secret of sensitive) {
    carryLength = Math.max(carryLength, longestSecretPrefixSuffix(redacted, secret));
  }
  const nextCarry = carryLength === 0 ? '' : redacted.slice(-carryLength);
  const safe = carryLength === 0 ? redacted : redacted.slice(0, -carryLength);
  return {
    text: safe,
    carry: nextCarry
  };
}

/** Longest proper prefix of `secret` that is also a suffix of `value`. */
function longestSecretPrefixSuffix(value: string, secret: string): number {
  if (secret.length <= 1 || value.length === 0) return 0;
  const prefix = new Array<number>(secret.length).fill(0);
  for (let index = 1, matched = 0; index < secret.length; index += 1) {
    while (matched > 0 && secret[index] !== secret[matched]) matched = prefix[matched - 1]!;
    if (secret[index] === secret[matched]) matched += 1;
    prefix[index] = matched;
  }
  const suffix = value.slice(-(secret.length - 1));
  let matched = 0;
  for (let index = 0; index < suffix.length; index += 1) {
    const character = suffix[index]!;
    while (matched > 0 && character !== secret[matched]) matched = prefix[matched - 1]!;
    if (character === secret[matched]) matched += 1;
    if (matched === secret.length) matched = prefix[matched - 1]!;
  }
  return Math.min(matched, secret.length - 1);
}

function splitUtf8Text(value: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let rest = value;
  while (rest) {
    const bytes = Buffer.from(rest, 'utf8');
    if (bytes.byteLength <= maxBytes) {
      parts.push(rest);
      break;
    }
    let end = maxBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    const part = bytes.subarray(0, end).toString('utf8');
    if (!part) break;
    parts.push(part);
    rest = rest.slice(part.length);
  }
  return parts;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return '';
  return splitUtf8Text(value, maxBytes)[0] ?? '';
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
  finalMessage: string,
  failureDiagnostic?: string
): string {
  return [
    `# ${runtimeName} turn`,
    '',
    `ACP stop reason: ${stopReason}`,
    '',
    ...(failureDiagnostic ? [`Failure: ${failureDiagnostic}`, ''] : []),
    finalMessage || '_The agent returned no final text message._',
    ''
  ].join('\n');
}

function acpStopFailureDiagnostic(stopReason: string): string | undefined {
  switch (stopReason) {
    case 'refusal':
      return 'The ACP agent refused the prompt.';
    case 'max_tokens':
      return 'The ACP agent reached its token limit before completing the turn.';
    case 'max_turn_requests':
      return 'The ACP agent reached its turn-request limit before completing the turn.';
    default:
      return undefined;
  }
}

function acpTerminalMessageFailureDiagnostic(
  profile: AcpRuntimeProfile,
  stopReason: string,
  finalMessage: string
): string | undefined {
  const failure = profile.terminalFailureMessage;
  return stopReason === 'end_turn' && failure?.exactText === finalMessage.trim()
    ? failure.diagnostic
    : undefined;
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

function acpSessionControlSet(
  localSessionId: string,
  state: AcpNativeSessionState,
  sensitiveValues: readonly string[] = []
): AgentSessionControlSet | undefined {
  if (!isSafeProviderIdentifier(state.sessionId, sensitiveValues)) return undefined;
  const controls: AgentSessionControl[] = [];
  const modelChoices = (state.models?.availableModels ?? []).flatMap((model) => {
    if (!isSafeProviderIdentifier(model.modelId, sensitiveValues)) return [];
    return [{
      value: model.modelId,
      label: redactCredentialText(model.name, sensitiveValues),
      description: model.description
        ? redactCredentialText(model.description, sensitiveValues)
        : undefined
    }];
  });
  if (
    state.models?.currentModelId &&
    modelChoices.some((choice) => choice.value === state.models?.currentModelId)
  ) {
    controls.push({
      id: 'model',
      label: 'Model',
      group: 'Model',
      kind: 'SELECT',
      value: state.models.currentModelId,
      choices: modelChoices,
      mutable: true
    });
  }
  if (
    state.modes?.currentModeId &&
    isSafeProviderIdentifier(state.modes.currentModeId, sensitiveValues) &&
    state.modes.availableModes.some(
      (mode) =>
        mode.id === state.modes?.currentModeId &&
        isSafeProviderIdentifier(mode.id, sensitiveValues)
    )
  ) {
    controls.push({
      id: 'mode',
      label: 'Mode',
      group: 'Mode',
      kind: 'SELECT',
      value: state.modes.currentModeId,
      choices: state.modes.availableModes.flatMap((mode) =>
        isSafeProviderIdentifier(mode.id, sensitiveValues)
          ? [{
              value: mode.id,
              label: redactCredentialText(mode.name, sensitiveValues),
              description: mode.description
                ? redactCredentialText(mode.description, sensitiveValues)
                : undefined
            }]
          : []
      ),
      mutable: true
    });
  }
  for (const option of state.configOptions) {
    if (
      (option.category === 'model' && controls.some((control) => control.id === 'model')) ||
      (option.category === 'mode' && controls.some((control) => control.id === 'mode'))
    ) continue;
    if (!isSafeProviderIdentifier(option.id, sensitiveValues)) continue;
    const base = {
      id: `config:${option.id}`,
      label: redactCredentialText(option.name, sensitiveValues),
      description: option.description
        ? redactCredentialText(option.description, sensitiveValues)
        : undefined,
      group: option.category
        ? redactCredentialText(option.category, sensitiveValues)
        : 'Configuration',
      mutable: true
    } as const;
    if (option.type === 'boolean') {
      controls.push({ ...base, kind: 'BOOLEAN', value: option.currentValue });
      continue;
    }
    const choices = flattenSelectOptions(option).flatMap((choice) => {
      if (!isSafeProviderIdentifier(choice.value, sensitiveValues)) return [];
      return [{
        value: choice.value,
        label: redactCredentialText(choice.name, sensitiveValues),
        description: choice.description
          ? redactCredentialText(choice.description, sensitiveValues)
          : undefined
      }];
    });
    if (choices.some((choice) => choice.value === option.currentValue)) {
      controls.push({
        ...base,
        kind: 'SELECT',
        value: option.currentValue,
        choices
      });
    }
  }
  const safeControls = structuredClone(controls);
  return {
    localSessionId,
    providerSessionId: state.sessionId,
    revision: createHash('sha256')
      .update(JSON.stringify({ providerSessionId: state.sessionId, controls: safeControls }))
      .digest('hex'),
    controls: safeControls
  };
}

function isSafeProviderIdentifier(
  value: string,
  sensitiveValues: readonly string[]
): boolean {
  return redactCredentialText(value, sensitiveValues) === value;
}

function hasUnsafeAcpActionableIdentifier(
  state: AcpNativeSessionState,
  sensitiveValues: readonly string[]
): boolean {
  return [
    state.sessionId,
    state.models?.currentModelId,
    ...(state.models?.availableModels.map((model) => model.modelId) ?? []),
    ...(state.models?.availableModels.flatMap((model) => [
      model.reasoningEffort,
      ...(model.reasoningEfforts?.flatMap((effort) => [effort.id, effort.value]) ?? [])
    ]) ?? []),
    state.modes?.currentModeId,
    ...(state.modes?.availableModes.map((mode) => mode.id) ?? []),
    ...state.configOptions.flatMap((option) => [
      option.id,
      ...(option.type === 'select'
        ? flattenSelectOptions(option).map((choice) => choice.value)
        : [])
    ])
  ].some(
    (value) =>
      typeof value === 'string' &&
      !isSafeProviderIdentifier(value, sensitiveValues)
  );
}

function containsSensitiveProviderValue(
  value: unknown,
  sensitiveValues: readonly string[]
): boolean {
  if (typeof value === 'string') {
    return redactCredentialText(value, sensitiveValues) !== value;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveProviderValue(entry, sensitiveValues));
  }
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) =>
    containsSensitiveProviderValue(entry, sensitiveValues)
  );
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

function isTerminalRuntimeStatus(status: AgentRuntimeRunRecord['status']): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(status);
}

function isAcpReadOnlyRuntimeSession(
  session: AgentRuntimeSessionRecord,
  profile: AcpRuntimeProfile
): boolean {
  const policy = profile.readOnlyTurnPolicy;
  if (!policy || session.runtimeId !== profile.descriptor.id) return false;
  const native = session.executionContext.modelSettings.runtimeOptions?.[
    profile.descriptor.id
  ];
  return (
    session.executionContext.repositoryAccess === 'READ_ONLY' &&
    session.executionContext.modelSettings.approvalPolicy === 'NEVER' &&
    isRecord(native) &&
    native.modeId === policy.modeId
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function acpRuntimeOperationId(action: string, ...identity: unknown[]): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');
  return `acp:${action}:${fingerprint}`;
}

function acpProtocolOperationId(
  action: string,
  raw: AgentProtocolMessageReference,
  ...identity: unknown[]
): string {
  return acpRuntimeOperationId(
    action,
    raw.serverInstanceId,
    raw.segment ?? 0,
    raw.sequence,
    raw.sha256,
    ...identity
  );
}

function normalizeExecutableOverride(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes('\0')) throw new Error('ACP executable path contains a NUL byte.');
  return value;
}
