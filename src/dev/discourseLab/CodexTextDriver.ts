import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS,
  CodexAppServerSupervisor,
  type CodexAppServerSupervisorOptions
} from '../../core/agent/codex/CodexAppServerSupervisor';
import {
  CodexAmbiguousMutationError,
  type CodexRpcClient
} from '../../core/agent/codex/CodexRpcClient';
import {
  assertCodexActivePermissionProfileId,
  codexReadOnlyScopeProfile,
  type CodexReadOnlyScopeProfile
} from '../../core/agent/codex/CodexPermissionProfile';
import type { ServerNotification } from '../../core/agent/codex/protocol/generated/ServerNotification';
import type { ThreadStartResponse } from '../../core/agent/codex/protocol/generated/v2/ThreadStartResponse';
import type { ThreadForkResponse } from '../../core/agent/codex/protocol/generated/v2/ThreadForkResponse';
import type { ThreadItem } from '../../core/agent/codex/protocol/generated/v2/ThreadItem';
import type { ThreadTokenUsage } from '../../core/agent/codex/protocol/generated/v2/ThreadTokenUsage';
import { DiscourseWorkspace } from '../../core/discourse/DiscourseWorkspace';
import { LabProviderRuntimeStore } from './LabProviderRuntimeStore';
import type {
  LabBoundaryProbeInput,
  LabBoundaryProbeReport,
  LabCallFailureKind,
  LabDriverForkInput,
  LabDriverForkResult,
  LabDriverPreflight,
  LabDriverSession,
  LabForkableTextDriver,
  LabTextCallInput,
  LabTextCallResult,
  LabTextDriver,
  LabTokenUsage
} from './textDriver';

const BASE_INSTRUCTIONS = [
  'You are a participant in a sealed, ordinary-text reasoning evaluation.',
  'Use only text present in the current request and explicitly supplied public artifacts.',
  'Do not use tools, files, repositories, browsing, apps, MCP, external knowledge retrieval, subagents, memories, or user interaction.',
  'Return only the requested public JSON. Do not reveal or describe private chain-of-thought.'
].join(' ');

const DEVELOPER_INSTRUCTIONS = [
  'This is an evaluation, not a Task Monki Task or product Discourse conversation.',
  'Concise public claims, cited evidence ids, assumptions, critiques, responses, confidence, and resolution states are auditable; hidden reasoning is not.',
  'Agreement, uncertainty, no issue, abstention, and a request for missing user information are valid outcomes.'
].join(' ');

const LAB_NOTIFICATION_OPT_OUTS = CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS.filter(
  (method) => method !== 'item/agentMessage/delta'
);
const LAB_BOUNDARY_CONFIG_OVERRIDES = [
  'features.plugins=false',
  'features.remote_plugin=false',
  'plugins.openai-developers.mcp_servers.openai-api-key-local-confirmation.enabled=false'
] as const;
const GLOBAL_MCP_EVENT_KEY = '__global__';
const TERMINAL_USAGE_GRACE_MS = 500;
const INTERRUPT_REQUEST_MAXIMUM_MS = 5_000;
const POST_DEADLINE_EVIDENCE_RECOVERY_MS =
  INTERRUPT_REQUEST_MAXIMUM_MS + TERMINAL_USAGE_GRACE_MS;
const MAX_PROCESS_BOUNDARY_VIOLATIONS = 64;
const MAX_PROCESS_BOUNDARY_VIOLATION_LENGTH = 300;
const TRUNCATED_PROCESS_BOUNDARY_VIOLATIONS =
  'Additional process-boundary violations were omitted.';
const ALLOWED_ITEM_TYPES = new Set<ThreadItem['type']>([
  'userMessage',
  'agentMessage',
  'reasoning'
]);

export interface CodexTextDriverOptions {
  stateRoot: string;
  executionRoot: string;
  codexHome: string;
  repositoryRoot: string;
  appVersion: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  runtimeResolver?: CodexAppServerSupervisorOptions['runtimeResolver'];
  argvResolver?: CodexAppServerSupervisorOptions['argvResolver'];
}

interface ActiveCall {
  input: LabTextCallInput;
  threadId: string;
  turnId: string;
  submittedAt: string;
  acknowledgedAt: string;
  startedAt?: string;
  firstOutputAt?: string;
  messages: string[];
  deltas: string;
  usage?: ThreadTokenUsage;
  usageUpdatedAt?: number;
  usageObserved: Promise<void>;
  resolveUsage: () => void;
  terminalObservedAt?: number;
  violations: string[];
  lifecycle: LabTextCallResult['lifecycle'];
  observedModel?: string;
  observedModelProvider?: string;
  observedReasoningEffort?: string;
  serviceTier?: string;
  providerStatus?: string;
  providerError?: string;
  failureKind?: LabCallFailureKind;
  interruptPromise?: Promise<void>;
  resolve: (notification: Extract<ServerNotification, { method: 'turn/completed' }>) => void;
}

interface ThreadAttestation {
  profile: CodexReadOnlyScopeProfile;
  requestedModel: string;
  observedModel: string;
  observedModelProvider: string;
  requestedReasoningEffort?: string;
  observedReasoningEffort?: string;
  requestedServiceTier?: string;
  observedServiceTier?: string;
  session: LabDriverSession;
}

type McpStartupEvent = Extract<
  ServerNotification,
  { method: 'mcpServer/startupStatus/updated' }
>['params'];

type ThreadStartEvidence = ThreadStartResponse & {
  runtimeWorkspaceRoots?: unknown;
  activePermissionProfile?: { id?: unknown; extends?: unknown } | null;
};

type ThreadForkEvidence = ThreadForkResponse & {
  runtimeWorkspaceRoots?: unknown;
  activePermissionProfile?: { id?: unknown; extends?: unknown } | null;
};

export interface CodexLabThreadStartExpectation {
  cwd: string;
  profileId: string;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

export interface CodexLabThreadStartAttestation {
  model: string;
  modelProvider: string;
  reasoningEffort?: string;
  serviceTier?: string;
  instructionSources: string[];
}

export interface CodexLabThreadForkExpectation
  extends CodexLabThreadStartExpectation {
  sourceSession: LabDriverSession;
  inheritedProviderTurnIds: readonly string[];
  modelProvider: string;
}

export interface CodexLabThreadForkAttestation
  extends CodexLabThreadStartAttestation {
  session: LabDriverSession;
  inheritedProviderTurnIds: string[];
}

export class CodexLabSettingsMismatchError extends Error {
  constructor(
    readonly mismatchFields: string[],
    readonly requested: Record<string, unknown>,
    readonly observed: Record<string, unknown>
  ) {
    super(`Codex text-lab boundary mismatch: ${mismatchFields.join(', ')}.`);
    this.name = 'CodexLabSettingsMismatchError';
  }
}

class CodexLabAbsoluteCallDeadlineError extends Error {
  constructor() {
    super('Codex lab operation crossed the absolute call deadline.');
    this.name = 'CodexLabAbsoluteCallDeadlineError';
  }
}

export const CODEX_LAB_TEXT_DRIVER_ID = 'codex-app-server-harness-isolated-v6' as const;

/**
 * Development-only Codex driver. It detects and terminates tool use but cannot
 * claim provider-enforced text-only or provider-side output-token ceilings.
 */
export class CodexLabTextDriver implements LabForkableTextDriver {
  readonly id = CODEX_LAB_TEXT_DRIVER_ID;
  readonly capabilities = {
    textOnlyProviderEnforced: false,
    hardOutputTokenLimit: false,
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: false
  } as const;

  private readonly runtimeStore: LabProviderRuntimeStore;
  private readonly workspace: DiscourseWorkspace;
  private readonly supervisor: CodexAppServerSupervisor;
  private client?: CodexRpcClient;
  private cwd?: string;
  private listenersAttached = false;
  private fatalError?: Error;
  private readonly calls = new Map<string, ActiveCall>();
  private readonly completed = new Map<
    string,
    Extract<ServerNotification, { method: 'turn/completed' }>
  >();
  private readonly retiredTurnIds = new Set<string>();
  private readonly earlyNotifications = new Map<string, ServerNotification[]>();
  private readonly threadAttestations = new Map<string, ThreadAttestation>();
  private readonly completedThreadTurnIds = new Map<string, string[]>();
  private readonly mcpStartupEvents = new Map<string, McpStartupEvent[]>();
  private readonly threadBoundaryViolations = new Map<string, string[]>();
  private readonly processBoundaryViolationLog: string[] = [];
  private isolationValidated = false;
  private boundaryKey?: string;
  private boundaryFailure?: LabBoundaryProbeReport['failure'];
  private closePromise?: Promise<void>;

  constructor(private readonly options: CodexTextDriverOptions) {
    this.runtimeStore = new LabProviderRuntimeStore(path.join(options.stateRoot, 'provider-runtime'));
    this.workspace = new DiscourseWorkspace(options.executionRoot);
    this.supervisor = new CodexAppServerSupervisor(this.runtimeStore, {
      executable: options.executable,
      cwd: options.executionRoot,
      appVersion: options.appVersion,
      environment: {
        ...(options.environment ?? process.env),
        CODEX_HOME: options.codexHome
      },
      toolSettings: { webSearchMode: 'disabled', mcpServers: 'disabled', apps: 'disabled' },
      additionalConfigOverrides: LAB_BOUNDARY_CONFIG_OVERRIDES,
      failClosedMcpDiscovery: true,
      notificationOptOutMethods: LAB_NOTIFICATION_OPT_OUTS,
      runtimeResolver: options.runtimeResolver,
      argvResolver: options.argvResolver,
      requestTimeoutMs: 30_000
    });
  }

  async preflight(input?: LabBoundaryProbeInput): Promise<LabDriverPreflight> {
    const abortBoundary = () => {
      void this.fence('Codex lab preflight was aborted at its hard deadline.');
    };
    if (input?.signal?.aborted) {
      abortBoundary();
      throw new Error('Codex lab preflight was aborted before it started.');
    }
    input?.signal?.addEventListener('abort', abortBoundary, { once: true });
    try {
    const client = await abortableBoundaryOperation(this.ensureClient(), input?.signal);
    const account = await abortableBoundaryOperation(
      client.request(
        'account/read',
        { refreshToken: false },
        boundaryOperationTimeoutMs(input)
      ),
      input?.signal
    );
    const models: LabDriverPreflight['models'] = [];
    let cursor: string | null | undefined;
    do {
      const page = await abortableBoundaryOperation(
        client.request(
          'model/list',
          { cursor, limit: 100, includeHidden: true },
          boundaryOperationTimeoutMs(input)
        ),
        input?.signal
      );
      for (const model of page.data) {
        models.push({
          id: model.id,
          model: model.model,
          displayName: model.displayName,
          isDefault: model.isDefault,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map(
            (option) => option.reasoningEffort
          )
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    const accountReady = Boolean(account.account || !account.requiresOpenaiAuth);
    let boundary: LabBoundaryProbeReport = {
      status: 'NOT_PROBED',
      ...(input
        ? {
            requestedModel: input.model,
            requestedReasoningEffort: input.reasoningEffort ?? null,
            requestedServiceTier: input.serviceTier ?? null
          }
        : {}),
      instructionSources: [],
      mcpStartupEvents: [],
      mismatchFields: []
    };
    if (!input) {
      boundary.failure = {
        kind: 'SETTINGS_MISMATCH',
        message: 'A model-specific zero-turn boundary probe was not requested.'
      };
    } else if (!accountReady) {
      boundary.failure = {
        kind: 'PROVIDER_ERROR',
        message: 'The isolated Codex home is not authenticated.'
      };
    } else if (!models.some((candidate) => candidate.id === input.model || candidate.model === input.model)) {
      boundary.status = 'REJECTED';
      boundary.failure = {
        kind: 'SETTINGS_MISMATCH',
        message: `Requested probe model is not in the isolated runtime catalog: ${input.model}`
      };
    } else {
      try {
        const attestation = await abortableBoundaryOperation(
          this.startThread(client, input),
          input.signal
        );
        this.threadAttestations.delete(attestation.session.providerThreadId);
        this.completedThreadTurnIds.delete(attestation.session.providerThreadId);
        this.boundaryKey = boundaryKey(input);
        this.boundaryFailure = undefined;
        boundary = {
          status: 'ATTESTED',
          requestedModel: input.model,
          observedModel: attestation.observedModel,
          observedModelProvider: attestation.observedModelProvider,
          requestedReasoningEffort: input.reasoningEffort ?? null,
          observedReasoningEffort: attestation.observedReasoningEffort ?? null,
          requestedServiceTier: input.serviceTier ?? null,
          observedServiceTier: attestation.observedServiceTier ?? null,
          instructionSources: [],
          mcpStartupEvents: [],
          mismatchFields: []
        };
      } catch (error) {
        boundary = rejectedBoundaryReport(input, error);
        this.boundaryKey = undefined;
        this.boundaryFailure = boundary.failure;
      }
    }
    return {
      driverId: this.id,
      ready: accountReady && models.length > 0 && boundary.status === 'ATTESTED',
      accountPresent: Boolean(account.account),
      requiresAuthentication: account.requiresOpenaiAuth && !account.account,
      models,
      capabilities: this.capabilities,
      boundary,
      limitationNotes: [
        'Codex exposes no provider-side maximum output token field for turn/start.',
        'Codex exposes no sampling seed for turn/start.',
        'App Server does not expose a general tool_choice:none control; H1 development may use only the separately versioned harness-attested fallback estimand.',
        'Streaming interruption is an emergency safety threshold, not an exact provider token cap; provider-reported usage and every overshoot remain outcomes.'
      ]
    };
    } finally {
      input?.signal?.removeEventListener('abort', abortBoundary);
    }
  }

  async call(input: LabTextCallInput): Promise<LabTextCallResult> {
    const submittedMs = Date.now();
    const submittedAt = new Date(submittedMs).toISOString();
    const callDeadlineMs = Math.min(
      submittedMs + input.maximumCallMs,
      input.experimentDeadlineMs
    );
    const evidenceRecoveryDeadlineMs =
      callDeadlineMs + POST_DEADLINE_EVIDENCE_RECOVERY_MS;
    const deadlineBoundInput: LabTextCallInput = {
      ...input,
      experimentDeadlineMs: callDeadlineMs
    };
    if (
      !this.capabilities.harnessVerifiedTextIsolation ||
      !this.capabilities.streamingOutputTokenInterrupt ||
      !this.capabilities.providerReportedTokenUsage
    ) {
      return failedBeforeSubmission(
        input,
        submittedAt,
        'The Codex App Server driver cannot attest the H1 development fallback boundary.',
        'SETTINGS_MISMATCH'
      );
    }
    const processBoundaryViolations = this.getProcessBoundaryViolations();
    if (processBoundaryViolations.length > 0) {
      return failedBeforeSubmission(
        input,
        submittedAt,
        `The Codex lab process boundary was already violated: ${processBoundaryViolations.join('; ')}`,
        'TOOL_CONTEXT_VIOLATION'
      );
    }
    if (this.fatalError) return failedBeforeSubmission(input, submittedAt, this.fatalError.message);
    if (input.seed !== undefined) {
      return failedBeforeSubmission(input, submittedAt, 'Codex does not support controlled sampling seeds.');
    }
    if (Date.now() >= callDeadlineMs) {
      return failedBeforeSubmission(input, submittedAt, 'The experiment wall-time budget is exhausted.', 'TIMEOUT');
    }
    if (this.boundaryKey !== boundaryKey(input)) {
      return failedBeforeSubmission(
        input,
        submittedAt,
        this.boundaryFailure?.message ??
          'A matching zero-turn Codex boundary probe has not passed.',
        this.boundaryFailure?.kind ?? 'SETTINGS_MISMATCH'
      );
    }

    let client: CodexRpcClient;
    try {
      client = await beforeAbsoluteCallDeadline(
        () => this.ensureClient(),
        callDeadlineMs,
        () => {
          void this.fence('Codex lab client startup crossed the absolute call deadline.');
        }
      );
    } catch (error) {
      return failedBeforeSubmission(
        input,
        submittedAt,
        errorMessage(error),
        error instanceof CodexLabAbsoluteCallDeadlineError ? 'TIMEOUT' : 'PROVIDER_ERROR'
      );
    }

    let attestation: ThreadAttestation;
    try {
      attestation = input.continuation
        ? this.requireContinuation(input.continuation, input)
        : await this.startThread(client, deadlineBoundInput);
    } catch (error) {
      return failedBeforeSubmission(
        input,
        submittedAt,
        errorMessage(error),
        error instanceof CodexAmbiguousMutationError
          ? 'AMBIGUOUS_DELIVERY'
          : Date.now() >= callDeadlineMs || error instanceof CodexLabAbsoluteCallDeadlineError
            ? 'TIMEOUT'
            : 'SETTINGS_MISMATCH',
        {
          ...(input.continuation ? { session: input.continuation } : {}),
          providerAccounting: {
            sessionAttestation: input.continuation ? 'UNKNOWN' : 'NOT_PRESENT',
            threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'UNKNOWN',
            providerTurnStarted: 'NO',
            billableModelCall: 'NO'
          }
        }
      );
    }

    let response;
    const turnStartRemainingMs = callDeadlineMs - Date.now();
    if (turnStartRemainingMs <= 0) {
      return failedBeforeSubmission(
        input,
        submittedAt,
        'The absolute call deadline was exhausted before turn/start.',
        'TIMEOUT',
        {
          session: attestation.session,
          providerAccounting: {
            sessionAttestation: 'ATTESTED',
            threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
            providerTurnStarted: 'NO',
            billableModelCall: 'NO'
          }
        }
      );
    }
    try {
      response = await client.requestMutation(
        'turn/start',
        {
          threadId: attestation.session.providerThreadId,
          clientUserMessageId: input.callKey,
          input: [{ type: 'text', text: input.prompt, text_elements: [] }],
          cwd: this.cwd!,
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          model: input.model,
          serviceTier: input.serviceTier ?? null,
          effort: (input.reasoningEffort as never) ?? null,
          summary: null,
          personality: null,
          outputSchema: input.outputSchema as never
        },
        Math.max(1, turnStartRemainingMs)
      );
    } catch (error) {
      const ambiguous = error instanceof CodexAmbiguousMutationError;
      const deadlineExhausted = Date.now() >= callDeadlineMs;
      return failedBeforeSubmission(
        input,
        submittedAt,
        errorMessage(error),
        ambiguous
          ? 'AMBIGUOUS_DELIVERY'
          : deadlineExhausted
            ? 'TIMEOUT'
            : 'PROVIDER_ERROR',
        {
          session: attestation.session,
          providerAccounting: {
            sessionAttestation: 'ATTESTED',
            threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
            providerTurnStarted: ambiguous ? 'UNKNOWN' : 'NO',
            billableModelCall: ambiguous ? 'UNKNOWN' : 'NO'
          }
        }
      );
    }

    const acknowledgedAt = new Date().toISOString();
    const active = await this.createActiveCall(
      input,
      attestation,
      response.turn.id,
      submittedAt,
      acknowledgedAt
    );
    active.lifecycle.push({
      event: 'absolute-call-deadline-established',
      at: submittedAt,
      detail: {
        deadlineAt: new Date(callDeadlineMs).toISOString(),
        maximumCallMs: input.maximumCallMs,
        postDeadlineEvidenceRecoveryMs: POST_DEADLINE_EVIDENCE_RECOVERY_MS
      }
    });
    const alreadyCompleted = this.completed.get(response.turn.id);
    if (alreadyCompleted) {
      active.terminalObservedAt = Date.now();
      active.lifecycle.push({
        event: 'terminal',
        at: new Date(active.terminalObservedAt).toISOString(),
        detail: { status: alreadyCompleted.params.turn.status }
      });
      active.resolve(alreadyCompleted);
    }

    const timeoutMs = Math.max(1, callDeadlineMs - Date.now());
    let terminal: Extract<ServerNotification, { method: 'turn/completed' }> | undefined;
    try {
      try {
        terminal = await withTimeout(active, timeoutMs);
      } catch {
        active.failureKind = 'TIMEOUT';
        active.providerError = `Call exceeded ${timeoutMs} ms.`;
        this.interrupt(active, 'Call wall-time ceiling reached.');
        // The semantic-call deadline is absolute from harness submission.
        // After requesting interruption, retain a separately bounded terminal
        // evidence window; this never authorizes another semantic turn.
        terminal = await this.waitForTerminal(
          active,
          remainingBefore(evidenceRecoveryDeadlineMs)
        );
        if (!terminal) {
          active.failureKind = 'INTERRUPT_UNCONFIRMED';
          active.providerError = 'Codex did not confirm the bounded lab interrupt.';
          void this.fence(active.providerError);
        }
      }
      if (terminal) {
        // Usage is a separate notification with no documented ordering against
        // turn/completed. Keep the call correlated for a bounded grace period on
        // normal completion and interrupted completion alike.
        await this.waitForTerminalAdjacentUsage(active, evidenceRecoveryDeadlineMs);
      }
      // Notification handlers can request an interrupt and then observe the
      // terminal event before App Server acknowledges turn/interrupt. Keep the
      // call live until that mutation settles so an unconfirmed interrupt
      // cannot be reported as a successfully bounded result.
      if (active.interruptPromise) {
        const interruptSettled = await settlesBefore(
          active.interruptPromise,
          evidenceRecoveryDeadlineMs
        );
        if (!interruptSettled) {
          active.failureKind = 'INTERRUPT_UNCONFIRMED';
          active.providerError = 'Codex did not confirm the bounded lab interrupt.';
          void this.fence(active.providerError);
        }
      }
    } finally {
      this.retiredTurnIds.add(response.turn.id);
      this.calls.delete(response.turn.id);
      this.completed.delete(response.turn.id);
    }

    const completedAt = new Date().toISOString();
    const rawText = active.messages.length > 0
      ? active.messages.join('\n')
      : active.deltas;
    const observedOutputTokens = active.usage?.last.outputTokens;
    const safetyCeiling = outputTokenSafetyCeiling(input);
    if (
      observedOutputTokens !== undefined &&
      observedOutputTokens > safetyCeiling &&
      !active.failureKind
    ) {
      active.failureKind = 'TOKEN_LIMIT_EXCEEDED';
      active.providerError = `Observed ${observedOutputTokens} output tokens after the ${safetyCeiling}-token streaming safety threshold.`;
    }
    if (terminal) {
      active.providerStatus = terminal.params.turn.status;
      if (terminal.params.turn.error && !active.providerError) {
        active.providerError = terminal.params.turn.error.message;
      }
      if (terminal.params.turn.status !== 'completed' && !active.failureKind) {
        active.failureKind = 'PROVIDER_ERROR';
        active.providerError ??=
          `Codex turn ended with unexpected terminal status: ${terminal.params.turn.status}.`;
      }
    }
    if (terminal?.params.turn.status === 'completed' && !active.failureKind) {
      const completedTurns = this.completedThreadTurnIds.get(active.threadId);
      if (!completedTurns) {
        active.failureKind = 'SETTINGS_MISMATCH';
        active.providerError = 'Codex lab lost the attested thread history.';
      } else if (completedTurns.includes(response.turn.id)) {
        active.failureKind = 'SETTINGS_MISMATCH';
        active.providerError = 'Codex lab observed a duplicate provider turn id.';
      } else {
        completedTurns.push(response.turn.id);
      }
    }
    return {
      callKey: input.callKey,
      session: attestation.session,
      providerTurnId: response.turn.id,
      rawText,
      submittedAt,
      acknowledgedAt,
      startedAt: active.startedAt,
      firstOutputAt: active.firstOutputAt,
      completedAt,
      requestedModel: input.model,
      observedModel: active.observedModel ?? attestation.requestedModel,
      observedModelProvider:
        active.observedModelProvider ?? attestation.observedModelProvider,
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort:
        active.observedReasoningEffort ?? attestation.observedReasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier:
        active.serviceTier ?? attestation.observedServiceTier ?? null,
      seed: null,
      usage: active.usage ? mapUsage(active.usage) : undefined,
      tokenControl: codexTokenControl(input, observedOutputTokens ?? null),
      providerStatus: active.providerStatus,
      ...(active.failureKind
        ? {
            failure: {
              kind: active.failureKind,
              message: active.providerError ?? active.failureKind
            }
          }
        : {}),
      providerAccounting: {
        sessionAttestation: 'ATTESTED',
        threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
        providerTurnStarted: active.startedAt ? 'YES' : 'UNKNOWN',
        // Codex reports turns and token usage, but this integration has no
        // provider billing acknowledgement. Do not alias execution to billing.
        billableModelCall: 'UNKNOWN'
      },
      violations: [...active.violations],
      lifecycle: [...active.lifecycle, { event: 'result-recorded', at: completedAt }]
    };
  }

  async fork(input: LabDriverForkInput): Promise<LabDriverForkResult> {
    const submittedMs = Date.now();
    const submittedAt = new Date(submittedMs).toISOString();
    if (
      !Number.isFinite(input.maximumForkMs) ||
      input.maximumForkMs <= 0 ||
      !Number.isFinite(input.experimentDeadlineMs)
    ) {
      return failedFork(
        input,
        submittedAt,
        'SETTINGS_MISMATCH',
        'The lab fork requires finite positive time bounds.'
      );
    }
    const forkDeadlineMs = Math.min(
      submittedMs + input.maximumForkMs,
      input.experimentDeadlineMs
    );
    const processBoundaryViolations = this.getProcessBoundaryViolations();
    if (processBoundaryViolations.length > 0) {
      return failedFork(
        input,
        submittedAt,
        'TOOL_CONTEXT_VIOLATION',
        `The Codex lab process boundary was already violated: ${processBoundaryViolations.join('; ')}`
      );
    }
    if (this.fatalError) {
      return failedFork(input, submittedAt, 'PROVIDER_ERROR', this.fatalError.message);
    }
    if (Date.now() >= forkDeadlineMs) {
      return failedFork(
        input,
        submittedAt,
        'TIMEOUT',
        'The lab fork wall-time budget is exhausted.'
      );
    }
    if (this.boundaryKey !== boundaryKey(input)) {
      return failedFork(
        input,
        submittedAt,
        this.boundaryFailure?.kind ?? 'SETTINGS_MISMATCH',
        this.boundaryFailure?.message ??
          'A matching zero-turn Codex boundary probe has not passed.'
      );
    }

    let source: ThreadAttestation;
    const inheritedProviderTurnIds = this.completedThreadTurnIds.get(
      input.sourceSession.providerThreadId
    );
    try {
      source = this.requireContinuation(input.sourceSession, input);
      if (!inheritedProviderTurnIds) {
        throw new Error('The requested lab fork source history is unavailable.');
      }
    } catch (error) {
      return failedFork(
        input,
        submittedAt,
        'SETTINGS_MISMATCH',
        errorMessage(error)
      );
    }

    let client: CodexRpcClient;
    try {
      client = await beforeAbsoluteCallDeadline(
        () => this.ensureClient(),
        forkDeadlineMs,
        () => {
          void this.fence('Codex lab client startup crossed the absolute fork deadline.');
        }
      );
    } catch (error) {
      return failedFork(
        input,
        submittedAt,
        error instanceof CodexLabAbsoluteCallDeadlineError ? 'TIMEOUT' : 'PROVIDER_ERROR',
        errorMessage(error)
      );
    }

    const forkStartRemainingMs = forkDeadlineMs - Date.now();
    if (forkStartRemainingMs <= 0) {
      return failedFork(
        input,
        submittedAt,
        'TIMEOUT',
        'The absolute fork deadline was exhausted before thread/fork.'
      );
    }
    let response: ThreadForkResponse;
    try {
      response = await client.requestMutation('thread/fork', {
        threadId: input.sourceSession.providerThreadId,
        model: input.model,
        modelProvider: null,
        serviceTier: input.serviceTier ?? null,
        cwd: this.cwd!,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        config: labThreadConfig(source.profile),
        baseInstructions: BASE_INSTRUCTIONS,
        developerInstructions: DEVELOPER_INSTRUCTIONS,
        ephemeral: true,
        threadSource: null
      }, forkStartRemainingMs);
    } catch (error) {
      const ambiguous = error instanceof CodexAmbiguousMutationError;
      const timedOut = Date.now() >= forkDeadlineMs ||
        error instanceof CodexLabAbsoluteCallDeadlineError;
      if (ambiguous) {
        await this.fence(`Codex lab fork delivery is ambiguous: ${errorMessage(error)}`);
      }
      return failedFork(
        input,
        submittedAt,
        ambiguous ? 'AMBIGUOUS_DELIVERY' : timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR',
        errorMessage(error),
        {
          forkMutationSubmitted: 'YES',
          forkMutationAcknowledged: ambiguous ? 'UNKNOWN' : 'NO'
        }
      );
    }

    const acknowledgedAt = new Date().toISOString();
    let observed: CodexLabThreadForkAttestation;
    try {
      observed = attestCodexLabThreadFork(response as ThreadForkEvidence, {
        cwd: this.cwd!,
        profileId: source.profile.profileId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        sourceSession: input.sourceSession,
        inheritedProviderTurnIds,
        modelProvider: source.observedModelProvider
      });
      if (
        this.threadAttestations.has(observed.session.providerThreadId) ||
        this.completedThreadTurnIds.has(observed.session.providerThreadId)
      ) {
        throw new CodexLabSettingsMismatchError(
          ['threadId'],
          { threadId: 'new unique provider thread id' },
          { threadId: observed.session.providerThreadId }
        );
      }
      await boundedDelay(Math.min(100, Math.max(0, forkDeadlineMs - Date.now())));
      const mcpEvents = [
        ...(this.mcpStartupEvents.get(observed.session.providerThreadId) ?? []),
        ...(this.mcpStartupEvents.get(GLOBAL_MCP_EVENT_KEY) ?? [])
      ];
      if (mcpEvents.length > 0) {
        throw new CodexLabSettingsMismatchError(
          ['mcpStartupEvents'],
          { mcpStartupEvents: [] },
          {
            mcpStartupEvents: mcpEvents.map((event) => ({
              name: event.name,
              status: event.status
            }))
          }
        );
      }
    } catch (error) {
      await this.fence(`Codex lab fork attestation failed: ${errorMessage(error)}`);
      return failedFork(
        input,
        submittedAt,
        'SETTINGS_MISMATCH',
        errorMessage(error),
        {
          forkMutationSubmitted: 'YES',
          forkMutationAcknowledged: 'YES',
          acknowledgedAt
        }
      );
    }

    const attestation: ThreadAttestation = {
      profile: source.profile,
      requestedModel: input.model,
      observedModel: observed.model,
      observedModelProvider: observed.modelProvider,
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: observed.reasoningEffort,
      requestedServiceTier: input.serviceTier,
      observedServiceTier: observed.serviceTier,
      session: observed.session
    };
    this.threadAttestations.set(observed.session.providerThreadId, attestation);
    this.completedThreadTurnIds.set(
      observed.session.providerThreadId,
      [...observed.inheritedProviderTurnIds]
    );
    const completedAt = new Date().toISOString();
    return {
      forkKey: input.forkKey,
      sourceSession: structuredClone(input.sourceSession),
      session: structuredClone(observed.session),
      inheritedProviderTurnIds: [...observed.inheritedProviderTurnIds],
      submittedAt,
      acknowledgedAt,
      completedAt,
      requestedModel: input.model,
      observedModel: observed.model,
      observedModelProvider: observed.modelProvider,
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: observed.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: observed.serviceTier ?? null,
      providerAccounting: {
        forkMutationSubmitted: 'YES',
        forkMutationAcknowledged: 'YES',
        providerTurnStarted: 'NO',
        billableModelCall: 'NO'
      },
      violations: [],
      lifecycle: [
        { event: 'fork-submitted', at: submittedAt },
        { event: 'fork-acknowledged', at: acknowledgedAt },
        { event: 'fork-attested', at: completedAt }
      ]
    };
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    const failures: unknown[] = [];
    await this.supervisor.shutdown().catch((error) => failures.push(error));
    const boundaryViolations = this.getProcessBoundaryViolations();
    if (boundaryViolations.length > 0) {
      failures.push(
        new Error(
          `Codex lab process observed forbidden boundary events: ${boundaryViolations.join('; ')}`
        )
      );
    }
    await this.runtimeStore.assertProviderOnlyState().catch((error) => failures.push(error));
    await this.runtimeStore.close().catch((error) => failures.push(error));
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Discourse Lab Codex driver did not close cleanly: ${failures.map(errorMessage).join('; ')}`
      );
    }
  }

  getProcessBoundaryViolations(): string[] {
    return [...this.processBoundaryViolationLog];
  }

  private async ensureClient(): Promise<CodexRpcClient> {
    if (this.fatalError) throw this.fatalError;
    if (!this.isolationValidated) {
      await assertCodexLabIsolation({
        codexHome: this.options.codexHome,
        executionRoot: this.options.executionRoot,
        repositoryRoot: this.options.repositoryRoot
      });
      this.isolationValidated = true;
    }
    await fs.mkdir(this.options.stateRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(this.options.stateRoot, 0o700);
    await this.runtimeStore.init();
    await this.runtimeStore.assertProviderOnlyState();
    this.cwd ??= await this.workspace.prepareEmptyReadOnlyWorkspace();
    const client = await this.supervisor.start();
    if (!this.listenersAttached) {
      this.attachListeners(client);
      this.listenersAttached = true;
    }
    this.client = client;
    return client;
  }

  private attachListeners(client: CodexRpcClient): void {
    client.events.on('notification', (notification) => {
      void this.handleNotification(notification).catch((error) => {
        void this.fence(errorMessage(error));
      });
    });
    client.events.on('serverRequest', (request) => {
      const violation =
        `Forbidden server request: ${safeBoundaryIdentifier(request.method)}`;
      this.recordProcessBoundaryViolation(violation);
      void client.respondError(request.id, {
        code: -32001,
        message: 'Discourse Protocol Lab forbids tools, approvals, and user-input requests.'
      });
      const turnId = requestTurnId(request.params);
      const call = turnId ? this.calls.get(turnId) : undefined;
      if (call) {
        this.failForViolation(call, violation);
      } else {
        void this.fence(
          `Uncorrelated forbidden server request: ${safeBoundaryIdentifier(request.method)}`
        );
      }
    });
    client.events.on('unsupportedServerRequest', (request) => {
      this.recordProcessBoundaryViolation(
        `Unsupported server request: ${safeBoundaryIdentifier(request.method)}`
      );
      void this.fence(`Unsupported server request in text-only lab: ${request.method}`);
    });
    client.events.on('protocolError', (error) => {
      this.recordProcessBoundaryViolation('Codex protocol error.');
      void this.fence(`Codex protocol error: ${error.message}`);
    });
  }

  private async startThread(
    client: CodexRpcClient,
    input: LabBoundaryProbeInput
  ): Promise<ThreadAttestation> {
    const profile = await codexReadOnlyScopeProfile({
      sessionId: `lab_${randomUUID().replaceAll('-', '')}`,
      scope: { primaryCwd: this.cwd!, readOnlyRoots: [] },
      reasoningEffort: input.reasoningEffort
    });
    const threadStartParams = {
      model: input.model,
      modelProvider: null,
      serviceTier: input.serviceTier ?? null,
      cwd: this.cwd!,
      approvalPolicy: 'never' as const,
      approvalsReviewer: 'user' as const,
      config: labThreadConfig(profile),
      baseInstructions: BASE_INSTRUCTIONS,
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      personality: null,
      ephemeral: true,
      sessionStartSource: null,
      threadSource: null,
      // The installed App Server accepts these optional fields, although the
      // older generated bindings do not yet expose or echo them.
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: []
    };
    const response = await abortableBoundaryOperation(
      client.requestMutation('thread/start', threadStartParams, boundaryOperationTimeoutMs(input)),
      input.signal
    );
    let observed: CodexLabThreadStartAttestation | undefined;
    let mismatch: CodexLabSettingsMismatchError | undefined;
    try {
      observed = attestCodexLabThreadStart(response as ThreadStartEvidence, {
        cwd: this.cwd!,
        profileId: profile.profileId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier
      });
    } catch (error) {
      if (!(error instanceof CodexLabSettingsMismatchError)) throw error;
      mismatch = error;
    }
    await abortableBoundaryOperation(
      boundedDelay(Math.min(100, boundaryOperationTimeoutMs(input))),
      input.signal
    );
    const mcpEvents = [
      ...(this.mcpStartupEvents.get(response.thread.id) ?? []),
      ...(this.mcpStartupEvents.get(GLOBAL_MCP_EVENT_KEY) ?? [])
    ];
    if (mcpEvents.length > 0) {
      mismatch = mergeBoundaryMismatch(mismatch, {
        field: 'mcpStartupEvents',
        requested: [],
        observed: mcpEvents.map((event) => ({ name: event.name, status: event.status }))
      });
    }
    if (mismatch) throw mismatch;
    if (!observed) throw new Error('Codex boundary attestation was unexpectedly unavailable.');
    const session: LabDriverSession = {
      driverId: this.id,
      providerThreadId: response.thread.id,
      providerSessionTreeId: response.thread.sessionId
    };
    const attestation: ThreadAttestation = {
      profile,
      requestedModel: input.model,
      observedModel: observed.model,
      observedModelProvider: observed.modelProvider,
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: observed.reasoningEffort,
      requestedServiceTier: input.serviceTier,
      observedServiceTier: observed.serviceTier,
      session
    };
    this.threadAttestations.set(response.thread.id, attestation);
    this.completedThreadTurnIds.set(response.thread.id, []);
    return attestation;
  }

  private requireContinuation(
    session: LabDriverSession,
    input: Pick<LabTextCallInput, 'model' | 'reasoningEffort' | 'serviceTier'>
  ): ThreadAttestation {
    if (session.driverId !== this.id) {
      throw new Error('A lab continuation belongs to a different text driver.');
    }
    const attestation = this.threadAttestations.get(session.providerThreadId);
    if (!attestation) throw new Error('The requested live lab continuation is unavailable.');
    const boundaryViolations = this.threadBoundaryViolations.get(session.providerThreadId) ?? [];
    if (boundaryViolations.length > 0) {
      throw new Error(`The continued lab actor lost its boundary: ${boundaryViolations.join('; ')}`);
    }
    if (
      attestation.requestedModel !== input.model ||
      attestation.requestedReasoningEffort !== input.reasoningEffort ||
      attestation.requestedServiceTier !== input.serviceTier
    ) {
      throw new Error('A continued lab actor cannot change model, effort, or service tier.');
    }
    return attestation;
  }

  private async createActiveCall(
    input: LabTextCallInput,
    attestation: ThreadAttestation,
    turnId: string,
    submittedAt: string,
    acknowledgedAt: string
  ): Promise<ActiveCall> {
    let resolve!: ActiveCall['resolve'];
    let resolveUsage!: ActiveCall['resolveUsage'];
    const terminal = new Promise<Extract<ServerNotification, { method: 'turn/completed' }>>(
      (settle) => {
        resolve = settle;
      }
    );
    const usageObserved = new Promise<void>((settle) => {
      resolveUsage = settle;
    });
    const active: ActiveCall & { terminal: typeof terminal } = {
        input,
        threadId: attestation.session.providerThreadId,
        turnId,
        submittedAt,
        acknowledgedAt,
        messages: [],
        deltas: '',
        usageObserved,
        resolveUsage,
        violations: [],
        lifecycle: [
          { event: 'submitted', at: submittedAt },
          { event: 'acknowledged', at: acknowledgedAt }
        ],
        resolve,
        terminal
    };
    this.calls.set(turnId, active);
    const mcpEvents = [
      ...(this.mcpStartupEvents.get(active.threadId) ?? []),
      ...(this.mcpStartupEvents.get(GLOBAL_MCP_EVENT_KEY) ?? [])
    ];
    for (const event of mcpEvents) {
      this.failForViolation(
        active,
        `Forbidden MCP startup event: ${safeBoundaryIdentifier(event.name)}/${safeBoundaryIdentifier(event.status)}`
      );
    }
    const queued = this.earlyNotifications.get(turnId) ?? [];
    this.earlyNotifications.delete(turnId);
    for (const notification of queued) {
      await this.handleNotification(notification);
    }
    return active;
  }

  private async waitForTerminalAdjacentUsage(
    call: ActiveCall,
    evidenceDeadlineMs?: number
  ): Promise<void> {
    if (call.usage) return;
    const startedAt = Date.now();
    const remainingExperimentMs = Math.max(0, call.input.experimentDeadlineMs - startedAt);
    const remainingEvidenceMs = evidenceDeadlineMs === undefined
      ? TERMINAL_USAGE_GRACE_MS
      : Math.max(0, evidenceDeadlineMs - startedAt);
    const graceMs = Math.min(
      TERMINAL_USAGE_GRACE_MS,
      remainingExperimentMs,
      remainingEvidenceMs
    );
    if (graceMs > 0) {
      await Promise.race([
        call.usageObserved,
        boundedDelay(graceMs)
      ]);
    }
    if (!call.usage) {
      call.lifecycle.push({
        event: 'provider-usage-unavailable',
        at: new Date().toISOString(),
        detail: { graceMs, terminalObserved: call.terminalObservedAt !== undefined }
      });
    }
  }

  private async handleNotification(notification: ServerNotification): Promise<void> {
    const earlyTurnId = notificationTurnId(notification);
    if (earlyTurnId && this.retiredTurnIds.has(earlyTurnId)) {
      const violation =
        `Late event after completed call: ${safeBoundaryIdentifier(notification.method)}`;
      this.recordProcessBoundaryViolation(violation);
      void this.fence(violation);
      return;
    }
    if (
      earlyTurnId &&
      !this.calls.has(earlyTurnId) &&
      notification.method !== 'turn/completed'
    ) {
      const queued = this.earlyNotifications.get(earlyTurnId) ?? [];
      if (queued.length >= 1_000) {
        throw new Error(`Codex emitted too many pre-acknowledgement events for ${earlyTurnId}.`);
      }
      queued.push(notification);
      this.earlyNotifications.set(earlyTurnId, queued);
      return;
    }
    switch (notification.method) {
      case 'turn/started': {
        const call = this.calls.get(notification.params.turn.id);
        if (call) {
          call.startedAt = isoFromSeconds(notification.params.turn.startedAt) ?? new Date().toISOString();
          call.lifecycle.push({ event: 'started', at: call.startedAt });
        }
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const call = this.calls.get(notification.params.turnId);
        const item = notification.params.item;
        if (!ALLOWED_ITEM_TYPES.has(item.type)) {
          const violation = `Forbidden item type: ${safeBoundaryIdentifier(item.type)}`;
          this.recordProcessBoundaryViolation(violation);
          if (call) this.failForViolation(call, violation);
          return;
        }
        if (!call) return;
        if (notification.method === 'item/completed' && item.type === 'agentMessage') {
          call.firstOutputAt ??= new Date().toISOString();
          call.messages.push(item.text);
        }
        return;
      }
      case 'item/agentMessage/delta': {
        const call = this.calls.get(notification.params.turnId);
        if (!call) return;
        call.firstOutputAt ??= new Date().toISOString();
        call.deltas += notification.params.delta;
        if (estimatedTokens(call.deltas) > outputTokenSafetyCeiling(call.input)) {
          call.failureKind = 'TOKEN_LIMIT_EXCEEDED';
          call.providerError = `Streaming output crossed the ${outputTokenSafetyCeiling(call.input)}-token safety threshold.`;
          if (call.terminalObservedAt === undefined) {
            await this.interrupt(call, call.providerError);
          }
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        const call = this.calls.get(notification.params.turnId);
        if (call) {
          call.usage = notification.params.tokenUsage;
          call.usageUpdatedAt = Date.now();
          call.resolveUsage();
          call.lifecycle.push({
            event: 'provider-usage-observed',
            at: new Date().toISOString(),
            detail: {
              outputTokens: notification.params.tokenUsage.last.outputTokens,
              reasoningOutputTokens:
                notification.params.tokenUsage.last.reasoningOutputTokens,
              totalTokens: notification.params.tokenUsage.last.totalTokens
            }
          });
          if (
            notification.params.tokenUsage.last.outputTokens >
            outputTokenSafetyCeiling(call.input)
          ) {
            call.failureKind = 'TOKEN_LIMIT_EXCEEDED';
            call.providerError = `Observed output usage crossed the ${outputTokenSafetyCeiling(call.input)}-token streaming safety threshold.`;
            if (call.terminalObservedAt === undefined) {
              await this.interrupt(call, call.providerError);
            }
          }
        }
        return;
      }
      case 'mcpServer/startupStatus/updated': {
        const threadKey = notification.params.threadId ?? GLOBAL_MCP_EVENT_KEY;
        const events = this.mcpStartupEvents.get(threadKey) ?? [];
        events.push(notification.params);
        this.mcpStartupEvents.set(threadKey, events);
        const violation = `Forbidden MCP startup event: ${safeBoundaryIdentifier(notification.params.name)}/${safeBoundaryIdentifier(notification.params.status)}`;
        this.recordProcessBoundaryViolation(violation);
        let matchedActiveCall = false;
        if (notification.params.threadId) {
          for (const call of this.calls.values()) {
            if (call.threadId === notification.params.threadId) {
              matchedActiveCall = true;
              this.failForViolation(call, violation);
            }
          }
        }
        if (!matchedActiveCall) void this.fence(violation);
        return;
      }
      case 'thread/settings/updated': {
        const attestation = this.threadAttestations.get(notification.params.threadId);
        if (!attestation) return;
        const settings = notification.params.threadSettings;
        let profileMismatch: string | undefined;
        try {
          assertCodexActivePermissionProfileId(
            attestation.profile.profileId,
            settings.activePermissionProfile
          );
        } catch (error) {
          profileMismatch = errorMessage(error);
        }
        const settingsMismatch =
          path.resolve(settings.cwd) !== path.resolve(this.cwd!) ||
          settings.approvalPolicy !== 'never' ||
          settings.approvalsReviewer !== 'user' ||
          settings.sandboxPolicy.type !== 'readOnly' ||
          settings.sandboxPolicy.networkAccess !== false ||
          settings.model !== attestation.requestedModel ||
          settings.effort !== ((attestation.requestedReasoningEffort as never) ?? null) ||
          settings.serviceTier !== (attestation.requestedServiceTier ?? null);
        if (profileMismatch || settingsMismatch) {
          const message = profileMismatch ?? 'Codex changed an attested text-lab setting.';
          this.recordProcessBoundaryViolation('Thread settings drift detected.');
          this.recordThreadBoundaryViolation(notification.params.threadId, message);
          for (const call of this.calls.values()) {
            if (call.threadId === notification.params.threadId) {
              this.failForSettingsDrift(call, message);
            }
          }
          return;
        }
        for (const call of this.calls.values()) {
          if (call.threadId === notification.params.threadId) {
            call.observedModel = settings.model;
            call.observedModelProvider = settings.modelProvider;
            call.observedReasoningEffort = settings.effort ?? undefined;
            call.serviceTier = settings.serviceTier ?? undefined;
          }
        }
        return;
      }
      case 'model/rerouted': {
        const call = this.calls.get(notification.params.turnId);
        this.recordProcessBoundaryViolation('Model reroute detected.');
        if (call) {
          call.failureKind = 'MODEL_REROUTED';
          call.providerError = `Model rerouted from ${notification.params.fromModel} to ${notification.params.toModel}.`;
          await this.interrupt(call, call.providerError);
        }
        return;
      }
      case 'thread/compacted': {
        const call = this.calls.get(notification.params.turnId);
        this.recordProcessBoundaryViolation('Context compacted.');
        if (call) {
          this.failForViolation(call, 'Context compacted; the public trajectory is no longer exact.');
        }
        return;
      }
      case 'error': {
        const call = this.calls.get(notification.params.turnId);
        if (call && !notification.params.willRetry) {
          call.providerError = notification.params.error.message;
        }
        return;
      }
      case 'turn/completed': {
        const call = this.calls.get(notification.params.turn.id);
        if (call) {
          call.terminalObservedAt = Date.now();
          call.lifecycle.push({ event: 'terminal', at: new Date(call.terminalObservedAt).toISOString(), detail: { status: notification.params.turn.status } });
          call.resolve(notification);
        } else {
          this.completed.set(notification.params.turn.id, notification);
        }
        return;
      }
      default:
        return;
    }
  }

  private failForViolation(call: ActiveCall, message: string): void {
    this.recordProcessBoundaryViolation(message);
    if (!call.violations.includes(message)) call.violations.push(message);
    call.failureKind = 'TOOL_CONTEXT_VIOLATION';
    call.providerError = message;
    if (call.terminalObservedAt === undefined) void this.interrupt(call, message);
  }

  private failForSettingsDrift(call: ActiveCall, message: string): void {
    this.recordProcessBoundaryViolation('Thread settings drift detected.');
    if (!call.violations.includes(message)) call.violations.push(message);
    call.failureKind = 'SETTINGS_MISMATCH';
    call.providerError = message;
    if (call.terminalObservedAt === undefined) void this.interrupt(call, message);
  }

  private recordThreadBoundaryViolation(threadId: string, message: string): void {
    const violations = this.threadBoundaryViolations.get(threadId) ?? [];
    if (!violations.includes(message)) violations.push(message);
    this.threadBoundaryViolations.set(threadId, violations);
  }

  private recordProcessBoundaryViolation(message: string): void {
    const bounded = message.slice(0, MAX_PROCESS_BOUNDARY_VIOLATION_LENGTH);
    if (this.processBoundaryViolationLog.includes(bounded)) return;
    if (this.processBoundaryViolationLog.length < MAX_PROCESS_BOUNDARY_VIOLATIONS - 1) {
      this.processBoundaryViolationLog.push(bounded);
      return;
    }
    if (!this.processBoundaryViolationLog.includes(TRUNCATED_PROCESS_BOUNDARY_VIOLATIONS)) {
      this.processBoundaryViolationLog.push(TRUNCATED_PROCESS_BOUNDARY_VIOLATIONS);
    }
  }

  private interrupt(call: ActiveCall, reason: string): Promise<void> {
    if (call.interruptPromise) return call.interruptPromise;
    call.lifecycle.push({
      event: 'interrupt-submitted',
      at: new Date().toISOString(),
      detail: { reason }
    });
    call.interruptPromise = this.submitInterrupt(call);
    return call.interruptPromise;
  }

  private async submitInterrupt(call: ActiveCall): Promise<void> {
    try {
      await this.client!.requestMutation(
        'turn/interrupt',
        {
          threadId: call.threadId,
          turnId: call.turnId
        },
        INTERRUPT_REQUEST_MAXIMUM_MS
      );
      call.lifecycle.push({ event: 'interrupt-acknowledged', at: new Date().toISOString() });
    } catch (error) {
      call.failureKind = 'INTERRUPT_UNCONFIRMED';
      call.providerError = `Lab interrupt could not be confirmed: ${errorMessage(error)}`;
      await this.fence(call.providerError);
    }
  }

  private waitForTerminal(
    call: ActiveCall,
    timeoutMs: number
  ): Promise<Extract<ServerNotification, { method: 'turn/completed' }> | undefined> {
    return raceWithTimeout(
      terminalPromise(call),
      timeoutMs,
      () => undefined
    );
  }

  private async fence(reason: string): Promise<void> {
    if (!this.fatalError) this.fatalError = new Error(reason);
    await this.supervisor.terminateAndFence(reason).catch(() => undefined);
  }
}

function terminalPromise(
  call: ActiveCall
): Promise<Extract<ServerNotification, { method: 'turn/completed' }>> {
  const candidate = call as ActiveCall & {
    terminal?: Promise<Extract<ServerNotification, { method: 'turn/completed' }>>;
  };
  if (!candidate.terminal) throw new Error('Lab active call lost its terminal signal.');
  return candidate.terminal;
}

function withTimeout(
  call: ActiveCall,
  timeoutMs: number
): Promise<Extract<ServerNotification, { method: 'turn/completed' }>> {
  return raceWithTimeout(
    terminalPromise(call),
    timeoutMs,
    () => {
      throw new Error('timeout');
    }
  );
}

function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function beforeAbsoluteCallDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
  onTimeout: () => void
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    onTimeout();
    return Promise.reject(new CodexLabAbsoluteCallDeadlineError());
  }
  return raceWithTimeout(operation(), remainingMs, () => {
    onTimeout();
    throw new CodexLabAbsoluteCallDeadlineError();
  });
}

function remainingBefore(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function settlesBefore(operation: Promise<void>, deadlineMs: number): Promise<boolean> {
  const remainingMs = remainingBefore(deadlineMs);
  if (remainingMs <= 0) return false;
  return raceWithTimeout(
    operation.then(() => true),
    remainingMs,
    () => false
  );
}

function labThreadConfig(profile: CodexReadOnlyScopeProfile) {
  const profileFeatures =
    profile.config.features &&
    typeof profile.config.features === 'object' &&
    !Array.isArray(profile.config.features)
      ? profile.config.features
      : {};
  return {
    ...profile.config,
    project_doc_max_bytes: 0,
    features: {
      ...profileFeatures,
      apps: false,
      goals: false,
      hooks: false,
      memories: false,
      multi_agent: false,
      multi_agent_v2: false,
      remote_plugin: false,
      shell_tool: false,
      skill_mcp_dependency_install: false,
      unified_exec: false
    }
  };
}

function failedFork(
  input: LabDriverForkInput,
  submittedAt: string,
  kind: LabCallFailureKind,
  message: string,
  evidence: {
    forkMutationSubmitted?: 'YES' | 'NO' | 'UNKNOWN';
    forkMutationAcknowledged?: 'YES' | 'NO' | 'UNKNOWN';
    acknowledgedAt?: string;
  } = {}
): LabDriverForkResult {
  const completedAt = new Date().toISOString();
  return {
    forkKey: input.forkKey,
    sourceSession: structuredClone(input.sourceSession),
    inheritedProviderTurnIds: [],
    submittedAt,
    ...(evidence.acknowledgedAt ? { acknowledgedAt: evidence.acknowledgedAt } : {}),
    completedAt,
    requestedModel: input.model,
    requestedReasoningEffort: input.reasoningEffort,
    requestedServiceTier: input.serviceTier ?? null,
    failure: { kind, message },
    providerAccounting: {
      forkMutationSubmitted: evidence.forkMutationSubmitted ?? 'NO',
      forkMutationAcknowledged: evidence.forkMutationAcknowledged ?? 'NO',
      providerTurnStarted: 'NO',
      billableModelCall: 'NO'
    },
    violations: [],
    lifecycle: [{
      event: evidence.forkMutationSubmitted === 'YES'
        ? 'fork-failed'
        : 'rejected-before-fork',
      at: completedAt,
      detail: { kind, message }
    }]
  };
}

function failedBeforeSubmission(
  input: LabTextCallInput,
  submittedAt: string,
  message: string,
  kind: LabCallFailureKind = 'PROVIDER_ERROR',
  evidence: {
    session?: LabDriverSession;
    providerAccounting?: LabTextCallResult['providerAccounting'];
  } = {}
): LabTextCallResult {
  return {
    callKey: input.callKey,
    ...(evidence.session ? { session: evidence.session } : {}),
    rawText: '',
    submittedAt,
    completedAt: new Date().toISOString(),
    requestedModel: input.model,
    requestedReasoningEffort: input.reasoningEffort,
    requestedServiceTier: input.serviceTier ?? null,
    observedServiceTier: null,
    seed: null,
    failure: { kind, message },
    providerAccounting: evidence.providerAccounting ?? {
      sessionAttestation: 'NOT_PRESENT',
      threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'NOT_STARTED',
      providerTurnStarted: 'NO',
      billableModelCall: 'NO'
    },
    violations: [],
    lifecycle: [{ event: 'rejected-before-turn', at: submittedAt, detail: { message } }]
  };
}

function mapUsage(value: ThreadTokenUsage): NonNullable<LabTextCallResult['usage']> {
  return {
    total: mapTokenBreakdown(value.total),
    last: mapTokenBreakdown(value.last),
    ...(value.modelContextWindow === null ? {} : { modelContextWindow: value.modelContextWindow })
  };
}

function mapTokenBreakdown(value: LabTokenUsage): LabTokenUsage {
  return {
    totalTokens: value.totalTokens,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    reasoningOutputTokens: value.reasoningOutputTokens
  };
}

function estimatedTokens(value: string): number {
  return Math.max(0, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
}

function outputTokenSafetyCeiling(input: LabTextCallInput): number {
  return input.outputTokenSafetyCeiling ?? input.maximumOutputTokens;
}

function codexTokenControl(
  input: LabTextCallInput,
  observedOutputTokens: number | null
): NonNullable<LabTextCallResult['tokenControl']> {
  const safetyCeilingOutputTokens = outputTokenSafetyCeiling(input);
  return {
    targetOutputTokens: input.maximumOutputTokens,
    safetyCeilingOutputTokens,
    providerEnforcedLimit: false,
    usageStatus: observedOutputTokens === null ? 'UNAVAILABLE' : 'PROVIDER_REPORTED',
    observedOutputTokens,
    targetOvershootTokens:
      observedOutputTokens === null
        ? null
        : Math.max(0, observedOutputTokens - input.maximumOutputTokens),
    safetyOvershootTokens:
      observedOutputTokens === null
        ? null
        : Math.max(0, observedOutputTokens - safetyCeilingOutputTokens)
  };
}

function isoFromSeconds(value: number | null): string | undefined {
  return value === null ? undefined : new Date(value * 1_000).toISOString();
}

function requestTurnId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const turnId = (value as Record<string, unknown>).turnId;
  return typeof turnId === 'string' ? turnId : undefined;
}

function notificationTurnId(notification: ServerNotification): string | undefined {
  switch (notification.method) {
    case 'turn/started':
    case 'turn/completed':
      return notification.params.turn.id;
    case 'item/started':
    case 'item/completed':
    case 'item/agentMessage/delta':
    case 'thread/tokenUsage/updated':
    case 'model/rerouted':
    case 'thread/compacted':
    case 'error':
      return notification.params.turnId;
    default:
      return undefined;
  }
}

export function attestCodexLabThreadStart(
  response: ThreadStartEvidence,
  expected: CodexLabThreadStartExpectation
): CodexLabThreadStartAttestation {
  const requested = {
    cwd: path.resolve(expected.cwd),
    profileId: expected.profileId,
    model: expected.model,
    reasoningEffort: expected.reasoningEffort ?? null,
    serviceTier: expected.serviceTier ?? null,
    instructionSources: [] as string[],
    ephemeral: true,
    parentThreadId: null,
    forkedFromId: null,
    gitInfo: null,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    allowedRuntimeWorkspaceRoots: [
      [],
      [path.resolve(expected.cwd)]
    ]
  };
  const active = response.activePermissionProfile;
  const rawRoots = response.runtimeWorkspaceRoots;
  const observedRoots = Array.isArray(rawRoots)
    ? rawRoots.map((candidate) =>
        typeof candidate === 'string' && path.isAbsolute(candidate)
          ? path.resolve(candidate)
          : candidate
      )
    : rawRoots;
  const observed = {
    cwd: path.resolve(response.cwd),
    profileId: active?.id ?? null,
    profileExtends: active?.extends ?? null,
    model: response.model,
    modelProvider: response.modelProvider,
    reasoningEffort: response.reasoningEffort,
    serviceTier: response.serviceTier,
    instructionSources: response.instructionSources.map(String),
    ephemeral: response.thread.ephemeral,
    parentThreadId: response.thread.parentThreadId,
    forkedFromId: response.thread.forkedFromId,
    gitInfo: response.thread.gitInfo,
    approvalPolicy: response.approvalPolicy,
    approvalsReviewer: response.approvalsReviewer,
    sandbox: response.sandbox,
    runtimeWorkspaceRoots: observedRoots
  };
  const mismatches: string[] = [];
  if (observed.cwd !== requested.cwd) mismatches.push('cwd');
  if (observed.profileId !== requested.profileId || observed.profileExtends !== null) {
    mismatches.push('activePermissionProfile');
  }
  if (observed.model !== requested.model) mismatches.push('model');
  if (observed.reasoningEffort !== requested.reasoningEffort) {
    mismatches.push('reasoningEffort');
  }
  if (observed.serviceTier !== requested.serviceTier) mismatches.push('serviceTier');
  if (observed.instructionSources.length !== 0) mismatches.push('instructionSources');
  if (observed.ephemeral !== true) mismatches.push('ephemeral');
  if (observed.parentThreadId !== null) mismatches.push('parentThreadId');
  if (observed.forkedFromId !== null) mismatches.push('forkedFromId');
  if (observed.gitInfo !== null) mismatches.push('gitInfo');
  if (observed.approvalPolicy !== 'never') mismatches.push('approvalPolicy');
  if (observed.approvalsReviewer !== 'user') mismatches.push('approvalsReviewer');
  if (
    observed.sandbox.type !== 'readOnly' ||
    observed.sandbox.networkAccess !== false
  ) {
    mismatches.push('sandbox');
  }
  if (
    !Array.isArray(observedRoots) ||
    !(
      observedRoots.length === 0 ||
      (observedRoots.length === 1 && observedRoots[0] === path.resolve(expected.cwd))
    )
  ) {
    mismatches.push('runtimeWorkspaceRoots');
  }
  if (mismatches.length > 0) {
    throw new CodexLabSettingsMismatchError(mismatches, requested, observed);
  }
  return {
    model: response.model,
    modelProvider: response.modelProvider,
    reasoningEffort: response.reasoningEffort ?? undefined,
    serviceTier: response.serviceTier ?? undefined,
    instructionSources: []
  };
}

export function attestCodexLabThreadFork(
  response: ThreadForkEvidence,
  expected: CodexLabThreadForkExpectation
): CodexLabThreadForkAttestation {
  const requestedRoots = [[], [path.resolve(expected.cwd)]];
  const requestedTurns = [...expected.inheritedProviderTurnIds];
  const requested = {
    cwd: path.resolve(expected.cwd),
    profileId: expected.profileId,
    model: expected.model,
    modelProvider: expected.modelProvider,
    reasoningEffort: expected.reasoningEffort ?? null,
    serviceTier: expected.serviceTier ?? null,
    instructionSources: [] as string[],
    ephemeral: true,
    parentThreadId: null,
    forkedFromId: expected.sourceSession.providerThreadId,
    sessionId: expected.sourceSession.providerSessionTreeId ?? null,
    inheritedProviderTurnIds: requestedTurns,
    gitInfo: null,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    allowedRuntimeWorkspaceRoots: requestedRoots
  };
  const active = response.activePermissionProfile;
  const rawRoots = response.runtimeWorkspaceRoots;
  const observedRoots = Array.isArray(rawRoots)
    ? rawRoots.map((candidate) =>
        typeof candidate === 'string' && path.isAbsolute(candidate)
          ? path.resolve(candidate)
          : candidate
      )
    : rawRoots;
  const inheritedProviderTurnIds = response.thread.turns.map((turn) => turn.id);
  const observed = {
    cwd: path.resolve(response.cwd),
    profileId: active?.id ?? null,
    profileExtends: active?.extends ?? null,
    model: response.model,
    modelProvider: response.modelProvider,
    reasoningEffort: response.reasoningEffort,
    serviceTier: response.serviceTier,
    instructionSources: response.instructionSources.map(String),
    threadId: response.thread.id,
    sessionId: response.thread.sessionId,
    inheritedProviderTurnIds,
    ephemeral: response.thread.ephemeral,
    parentThreadId: response.thread.parentThreadId,
    forkedFromId: response.thread.forkedFromId,
    gitInfo: response.thread.gitInfo,
    approvalPolicy: response.approvalPolicy,
    approvalsReviewer: response.approvalsReviewer,
    sandbox: response.sandbox,
    runtimeWorkspaceRoots: observedRoots
  };
  const mismatches: string[] = [];
  if (observed.cwd !== requested.cwd) mismatches.push('cwd');
  if (observed.profileId !== requested.profileId || observed.profileExtends !== null) {
    mismatches.push('activePermissionProfile');
  }
  if (observed.model !== requested.model) mismatches.push('model');
  if (observed.modelProvider !== requested.modelProvider) mismatches.push('modelProvider');
  if (observed.reasoningEffort !== requested.reasoningEffort) {
    mismatches.push('reasoningEffort');
  }
  if (observed.serviceTier !== requested.serviceTier) mismatches.push('serviceTier');
  if (observed.instructionSources.length !== 0) mismatches.push('instructionSources');
  if (observed.threadId === expected.sourceSession.providerThreadId) {
    mismatches.push('threadId');
  }
  if (!requested.sessionId || observed.sessionId !== requested.sessionId) {
    mismatches.push('sessionId');
  }
  if (observed.ephemeral !== true) mismatches.push('ephemeral');
  if (observed.parentThreadId !== null) mismatches.push('parentThreadId');
  if (observed.forkedFromId !== requested.forkedFromId) mismatches.push('forkedFromId');
  if (
    new Set(inheritedProviderTurnIds).size !== inheritedProviderTurnIds.length ||
    stableStringArray(inheritedProviderTurnIds) !== stableStringArray(requestedTurns)
  ) {
    mismatches.push('inheritedProviderTurnIds');
  }
  if (observed.gitInfo !== null) mismatches.push('gitInfo');
  if (observed.approvalPolicy !== 'never') mismatches.push('approvalPolicy');
  if (observed.approvalsReviewer !== 'user') mismatches.push('approvalsReviewer');
  if (
    observed.sandbox.type !== 'readOnly' ||
    observed.sandbox.networkAccess !== false
  ) {
    mismatches.push('sandbox');
  }
  if (
    !Array.isArray(observedRoots) ||
    !(
      observedRoots.length === 0 ||
      (observedRoots.length === 1 && observedRoots[0] === path.resolve(expected.cwd))
    )
  ) {
    mismatches.push('runtimeWorkspaceRoots');
  }
  if (mismatches.length > 0) {
    throw new CodexLabSettingsMismatchError(mismatches, requested, observed);
  }
  return {
    model: response.model,
    modelProvider: response.modelProvider,
    reasoningEffort: response.reasoningEffort ?? undefined,
    serviceTier: response.serviceTier ?? undefined,
    instructionSources: [],
    session: {
      driverId: CODEX_LAB_TEXT_DRIVER_ID,
      providerThreadId: response.thread.id,
      providerSessionTreeId: response.thread.sessionId
    },
    inheritedProviderTurnIds: [...inheritedProviderTurnIds]
  };
}

function stableStringArray(values: readonly string[]): string {
  return JSON.stringify(values);
}

export async function assertCodexLabIsolation(input: {
  codexHome: string;
  executionRoot: string;
  repositoryRoot: string;
}): Promise<void> {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const codexHome = await requireExternalRealDirectory(
    input.codexHome,
    repositoryRoot,
    'isolated Codex home'
  );
  const executionRoot = await requireExternalRealDirectory(
    input.executionRoot,
    repositoryRoot,
    'lab execution root'
  );
  if (isSameOrInside(codexHome, executionRoot) || isSameOrInside(executionRoot, codexHome)) {
    throw new Error('The isolated Codex home and lab execution root must not overlap.');
  }
  const executionEntries = await fs.readdir(executionRoot);
  if (executionEntries.length > 0) {
    throw new Error('The external lab execution root must be empty before startup.');
  }
  const homeEntries = await fs.readdir(codexHome);
  if (homeEntries.some((entry) => /^AGENTS(?:\.override)?\.md$/iu.test(entry))) {
    throw new Error('The isolated Codex home must not contain global AGENTS instructions.');
  }
  const pluginRoot = path.join(codexHome, 'plugins');
  if (await pathHasEntries(pluginRoot)) {
    throw new Error('The isolated Codex home must not contain installed plugins.');
  }
  const configPath = path.join(codexHome, 'config.toml');
  const config = await readOptionalRealFile(configPath);
  if (
    config !== undefined &&
    /(^|\n)\s*\[(?:mcp_servers(?:\.|\])|plugins(?:\.|\]))|(^|\n)\s*mcp_servers\s*=/imu.test(
      config
    )
  ) {
    throw new Error('The isolated Codex home contains plugin or MCP configuration.');
  }
}

function rejectedBoundaryReport(
  input: LabBoundaryProbeInput,
  error: unknown
): LabBoundaryProbeReport {
  if (error instanceof CodexLabSettingsMismatchError) {
    const instructionSources = Array.isArray(error.observed.instructionSources)
      ? error.observed.instructionSources.filter(
          (candidate): candidate is string => typeof candidate === 'string'
        )
      : [];
    const mcpStartupEvents = Array.isArray(error.observed.mcpStartupEvents)
      ? error.observed.mcpStartupEvents.flatMap((candidate) => {
          if (!candidate || typeof candidate !== 'object') return [];
          const value = candidate as Record<string, unknown>;
          return typeof value.name === 'string' && typeof value.status === 'string'
            ? [{ name: value.name, status: value.status }]
            : [];
        })
      : [];
    return {
      status: 'REJECTED',
      requestedModel: input.model,
      observedModel:
        typeof error.observed.model === 'string' ? error.observed.model : undefined,
      observedModelProvider:
        typeof error.observed.modelProvider === 'string'
          ? error.observed.modelProvider
          : undefined,
      requestedReasoningEffort: input.reasoningEffort ?? null,
      observedReasoningEffort:
        typeof error.observed.reasoningEffort === 'string'
          ? error.observed.reasoningEffort
          : null,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier:
        typeof error.observed.serviceTier === 'string'
          ? error.observed.serviceTier
          : null,
      instructionSources,
      mcpStartupEvents,
      mismatchFields: [...error.mismatchFields],
      failure: { kind: 'SETTINGS_MISMATCH', message: error.message }
    };
  }
  return {
    status: 'REJECTED',
    requestedModel: input.model,
    requestedReasoningEffort: input.reasoningEffort ?? null,
    requestedServiceTier: input.serviceTier ?? null,
    instructionSources: [],
    mcpStartupEvents: [],
    mismatchFields: [],
    failure: { kind: 'PROVIDER_ERROR', message: errorMessage(error) }
  };
}

function mergeBoundaryMismatch(
  current: CodexLabSettingsMismatchError | undefined,
  addition: { field: string; requested: unknown; observed: unknown }
): CodexLabSettingsMismatchError {
  return new CodexLabSettingsMismatchError(
    [...(current?.mismatchFields ?? []), addition.field],
    { ...(current?.requested ?? {}), [addition.field]: addition.requested },
    { ...(current?.observed ?? {}), [addition.field]: addition.observed }
  );
}

function boundaryKey(input: Pick<LabBoundaryProbeInput, 'model' | 'reasoningEffort' | 'serviceTier'>): string {
  return JSON.stringify([
    input.model,
    input.reasoningEffort ?? null,
    input.serviceTier ?? null
  ]);
}

function boundaryOperationTimeoutMs(input: LabBoundaryProbeInput | undefined): number {
  const remainingExperimentMs = input?.experimentDeadlineMs === undefined
    ? 30_000
    : input.experimentDeadlineMs - Date.now();
  const remainingCallMs = input?.maximumCallMs ?? 30_000;
  const timeoutMs = Math.min(remainingCallMs, remainingExperimentMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Codex lab preflight exhausted its hard deadline.');
  }
  return Math.max(1, timeoutMs);
}

function abortableBoundaryOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error('Codex lab preflight was aborted.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Codex lab preflight was aborted.'));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

async function requireExternalRealDirectory(
  candidate: string,
  repositoryRoot: string,
  label: string
): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new Error(`The ${label} must be an absolute path.`);
  const resolved = path.resolve(candidate);
  const stat = await fs.lstat(resolved).catch(() => {
    throw new Error(`The ${label} must be an existing real directory.`);
  });
  const canonical = await fs.realpath(resolved).catch(() => '');
  if (stat.isSymbolicLink() || !stat.isDirectory() || canonical !== resolved) {
    throw new Error(`The ${label} must be an existing real directory without aliases.`);
  }
  if (isSameOrInside(resolved, repositoryRoot)) {
    throw new Error(`The ${label} must stay outside the Task Monki repository.`);
  }
  return resolved;
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathHasEntries(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
    return (await fs.readdir(candidate)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readOptionalRealFile(candidate: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('The isolated Codex config must be a real file.');
    }
    return fs.readFile(candidate, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function safeBoundaryIdentifier(value: unknown): string {
  const normalized = typeof value === 'string' ? value : 'unknown';
  return normalized.replace(/[^A-Za-z0-9._:/-]/g, '?').slice(0, 120) || 'unknown';
}

function boundedDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
