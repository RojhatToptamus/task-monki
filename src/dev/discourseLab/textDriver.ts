import type {
  LabAccountingStatus,
  LabSessionAttestationStatus,
  LabThreadStartStatus
} from './contracts';

export interface LabTokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface LabDriverCapabilities {
  textOnlyProviderEnforced: boolean;
  hardOutputTokenLimit: boolean;
  /**
   * Development-only alternative to provider text-only enforcement. The
   * harness attests an empty/offline context and fails the wave on any
   * observed non-text item or server tool request.
   */
  harnessVerifiedTextIsolation?: boolean;
  /** The driver can request an interrupt after a recorded safety threshold. */
  streamingOutputTokenInterrupt?: boolean;
  /** The driver reports provider token usage rather than estimating it. */
  providerReportedTokenUsage?: boolean;
  /** The driver cancels or otherwise bounds a call at the supplied wall-time/deadline. */
  hardCallTimeLimit: boolean;
  continuation: boolean;
  samplingSeed: boolean;
}

export interface LabBoundaryProbeInput {
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  /** When supplied, the driver must stop boundary work promptly on abort. */
  signal?: AbortSignal;
  /** Hard wall-time ceiling for this preflight operation. */
  maximumCallMs?: number;
  /** Absolute wall-clock deadline shared with the enclosing experiment. */
  experimentDeadlineMs?: number;
}

export interface LabBoundaryProbeReport {
  status: 'ATTESTED' | 'REJECTED' | 'NOT_PROBED';
  requestedModel?: string;
  observedModel?: string;
  observedModelProvider?: string;
  requestedReasoningEffort?: string | null;
  observedReasoningEffort?: string | null;
  requestedServiceTier?: string | null;
  observedServiceTier?: string | null;
  instructionSources: string[];
  mcpStartupEvents: Array<{ name: string; status: string }>;
  mismatchFields: string[];
  failure?: { kind: LabCallFailureKind; message: string };
}

export interface LabDriverPreflight {
  driverId: string;
  ready: boolean;
  accountPresent: boolean;
  requiresAuthentication: boolean;
  models: Array<{
    id: string;
    model: string;
    displayName: string;
    isDefault: boolean;
    supportedReasoningEfforts: string[];
  }>;
  capabilities: LabDriverCapabilities;
  boundary: LabBoundaryProbeReport;
  limitationNotes: string[];
}

export interface LabTextCallInput {
  callKey: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  seed?: number;
  continuation?: LabDriverSession;
  /** Concise-output analysis target. Exceeding it is recorded, not censored. */
  maximumOutputTokens: number;
  /**
   * Emergency execution ceiling. A driver without a provider-side limit may
   * interrupt only after observing this threshold and must preserve overshoot.
   */
  outputTokenSafetyCeiling?: number;
  maximumCallMs: number;
  experimentDeadlineMs: number;
}

export interface LabDriverSession {
  driverId: string;
  providerThreadId: string;
  providerSessionTreeId?: string;
}

export interface LabDriverForkInput {
  forkKey: string;
  sourceSession: LabDriverSession;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  maximumForkMs: number;
  experimentDeadlineMs: number;
}

export interface LabDriverForkResult {
  forkKey: string;
  sourceSession: LabDriverSession;
  session?: LabDriverSession;
  inheritedProviderTurnIds: string[];
  submittedAt: string;
  acknowledgedAt?: string;
  completedAt: string;
  requestedModel: string;
  observedModel?: string;
  observedModelProvider?: string;
  requestedReasoningEffort?: string;
  observedReasoningEffort?: string;
  requestedServiceTier?: string | null;
  observedServiceTier?: string | null;
  failure?: { kind: LabCallFailureKind; message: string };
  providerAccounting: {
    forkMutationSubmitted: LabAccountingStatus;
    forkMutationAcknowledged: LabAccountingStatus;
    providerTurnStarted: 'NO';
    billableModelCall: 'NO';
  };
  violations: string[];
  lifecycle: Array<{ event: string; at: string; detail?: Record<string, unknown> }>;
}

export type LabCallFailureKind =
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'TOKEN_LIMIT_EXCEEDED'
  | 'TOKEN_ACCOUNTING_UNAVAILABLE'
  | 'TOOL_CONTEXT_VIOLATION'
  | 'SETTINGS_MISMATCH'
  | 'MODEL_REROUTED'
  | 'AMBIGUOUS_DELIVERY'
  | 'INTERRUPT_UNCONFIRMED';

export interface LabTextCallResult {
  callKey: string;
  session?: LabDriverSession;
  providerTurnId?: string;
  rawText: string;
  submittedAt: string;
  acknowledgedAt?: string;
  startedAt?: string;
  firstOutputAt?: string;
  completedAt: string;
  requestedModel: string;
  observedModel?: string;
  observedModelProvider?: string;
  requestedReasoningEffort?: string;
  observedReasoningEffort?: string;
  requestedServiceTier?: string | null;
  observedServiceTier?: string | null;
  seed: number | null;
  usage?: {
    total: LabTokenUsage;
    last: LabTokenUsage;
    modelContextWindow?: number;
  };
  tokenControl?: {
    targetOutputTokens: number;
    safetyCeilingOutputTokens: number;
    providerEnforcedLimit: boolean;
    usageStatus: 'PROVIDER_REPORTED' | 'HARNESS_ESTIMATED' | 'UNAVAILABLE';
    observedOutputTokens: number | null;
    targetOvershootTokens: number | null;
    safetyOvershootTokens: number | null;
  };
  providerStatus?: string;
  failure?: { kind: LabCallFailureKind; message: string };
  /**
   * Provider accounting evidence is explicit. The runner must not derive any
   * of these values from session presence, turn ids, timestamps, or each other.
   */
  providerAccounting: {
    sessionAttestation: LabSessionAttestationStatus;
    threadStartStatus: LabThreadStartStatus;
    providerTurnStarted: LabAccountingStatus;
    billableModelCall: LabAccountingStatus;
  };
  violations: string[];
  lifecycle: Array<{ event: string; at: string; detail?: Record<string, unknown> }>;
}

export interface LabTextDriver {
  readonly id: string;
  readonly capabilities: LabDriverCapabilities;
  preflight(input?: LabBoundaryProbeInput): Promise<LabDriverPreflight>;
  call(input: LabTextCallInput): Promise<LabTextCallResult>;
  close(): Promise<void>;
}

/**
 * Optional lab capability for copying one completed provider history into an
 * independently continued branch. A fork is a provider mutation, never a
 * semantic model call.
 */
export interface LabForkableTextDriver extends LabTextDriver {
  fork(input: LabDriverForkInput): Promise<LabDriverForkResult>;
}

export class ScriptedLabTextDriver implements LabForkableTextDriver {
  readonly id = 'scripted-text-v2';
  readonly capabilities: LabDriverCapabilities = {
    textOnlyProviderEnforced: true,
    hardOutputTokenLimit: true,
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: true
  };
  private nextThread = 1;
  private readonly threadTurns = new Map<string, string[]>();

  constructor(
    private readonly resolve: (
      input: LabTextCallInput,
      callIndex: number
    ) => string | Promise<string>
  ) {}

  private callIndex = 0;

  preflight(input?: LabBoundaryProbeInput): Promise<LabDriverPreflight> {
    if (input?.signal?.aborted) {
      return Promise.reject(new Error('Scripted lab preflight was aborted.'));
    }
    return Promise.resolve({
      driverId: this.id,
      ready: true,
      accountPresent: true,
      requiresAuthentication: false,
      models: [{
        id: 'scripted',
        model: 'scripted',
        displayName: 'Deterministic scripted fixture',
        isDefault: true,
        supportedReasoningEfforts: ['none']
      }],
      capabilities: this.capabilities,
      boundary: {
        status: 'ATTESTED',
        requestedModel: 'scripted',
        observedModel: 'scripted',
        requestedReasoningEffort: 'none',
        observedReasoningEffort: 'none',
        requestedServiceTier: null,
        observedServiceTier: null,
        instructionSources: [],
        mcpStartupEvents: [],
        mismatchFields: []
      },
      limitationNotes: []
    });
  }

  async call(input: LabTextCallInput): Promise<LabTextCallResult> {
    const submittedAt = new Date().toISOString();
    const index = this.callIndex++;
    const session = input.continuation ?? this.startScriptedSession();
    const providerTurnId = `scripted-turn-${index + 1}`;
    const turns = this.threadTurns.get(session.providerThreadId);
    if (!turns) {
      throw new Error('The scripted lab continuation or fork is unavailable.');
    }
    turns.push(providerTurnId);
    const maximumWaitMs = Math.max(
      0,
      Math.min(input.maximumCallMs, input.experimentDeadlineMs - Date.now())
    );
    const outcome = await boundedResolve(
      Promise.resolve().then(() => this.resolve(input, index)),
      maximumWaitMs
    );
    const completedAt = new Date().toISOString();
    if (outcome.kind !== 'OUTPUT') {
      return {
        callKey: input.callKey,
        session,
        providerTurnId,
        rawText: '',
        submittedAt,
        acknowledgedAt: submittedAt,
        startedAt: submittedAt,
        completedAt,
        requestedModel: input.model,
        observedModel: input.model,
        requestedReasoningEffort: input.reasoningEffort,
        observedReasoningEffort: input.reasoningEffort,
        requestedServiceTier: input.serviceTier ?? null,
        observedServiceTier: input.serviceTier ?? null,
        seed: input.seed ?? null,
        providerStatus: 'failed',
        failure: {
          kind: outcome.kind === 'TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_ERROR',
          message:
            outcome.kind === 'TIMEOUT'
              ? 'Scripted lab call reached its hard wall-time ceiling.'
              : `Scripted lab provider failed: ${errorMessage(outcome.error)}`
        },
        providerAccounting: {
          sessionAttestation: 'ATTESTED',
          threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
          providerTurnStarted: 'YES',
          billableModelCall: 'NO'
        },
        violations: [],
        lifecycle: [
          { event: 'submitted', at: submittedAt },
          { event: 'started', at: submittedAt },
          { event: outcome.kind === 'TIMEOUT' ? 'timed-out' : 'failed', at: completedAt }
        ]
      };
    }
    const rawText = outcome.value;
    const usage = tokenUsage(rawText);
    if (usage.outputTokens > input.maximumOutputTokens) {
      const limitedRawText = truncateToOutputTokenLimit(rawText, input.maximumOutputTokens);
      const limitedUsage = tokenUsage(limitedRawText);
      return {
        callKey: input.callKey,
        session,
        providerTurnId,
        rawText: limitedRawText,
        submittedAt,
        acknowledgedAt: submittedAt,
        startedAt: submittedAt,
        ...(limitedRawText ? { firstOutputAt: submittedAt } : {}),
        completedAt,
        requestedModel: input.model,
        observedModel: input.model,
        requestedReasoningEffort: input.reasoningEffort,
        observedReasoningEffort: input.reasoningEffort,
        requestedServiceTier: input.serviceTier ?? null,
        observedServiceTier: input.serviceTier ?? null,
        seed: input.seed ?? null,
        providerStatus: 'failed',
        usage: { total: limitedUsage, last: limitedUsage },
        tokenControl: tokenControl(input, limitedUsage.outputTokens, true, 'HARNESS_ESTIMATED'),
        failure: {
          kind: 'TOKEN_LIMIT_EXCEEDED',
          message: `Scripted lab call reached its hard ${input.maximumOutputTokens}-token output ceiling.`
        },
        providerAccounting: {
          sessionAttestation: 'ATTESTED',
          threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
          providerTurnStarted: 'YES',
          billableModelCall: 'NO'
        },
        violations: [],
        lifecycle: [
          { event: 'submitted', at: submittedAt },
          { event: 'started', at: submittedAt },
          {
            event: 'output-token-limit-reached',
            at: completedAt,
            detail: { maximumOutputTokens: input.maximumOutputTokens }
          }
        ]
      };
    }
    return {
      callKey: input.callKey,
      session,
      providerTurnId,
      rawText,
      submittedAt,
      acknowledgedAt: submittedAt,
      startedAt: submittedAt,
      firstOutputAt: submittedAt,
      completedAt,
      requestedModel: input.model,
      observedModel: input.model,
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: input.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      seed: input.seed ?? null,
      providerStatus: 'completed',
      usage: {
        total: usage,
        last: usage
      },
      tokenControl: tokenControl(input, usage.outputTokens, true, 'HARNESS_ESTIMATED'),
      providerAccounting: {
        sessionAttestation: 'ATTESTED',
        threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
        providerTurnStarted: 'YES',
        billableModelCall: 'NO'
      },
      violations: [],
      lifecycle: [
        { event: 'submitted', at: submittedAt },
        { event: 'completed', at: completedAt }
      ]
    };
  }

  fork(input: LabDriverForkInput): Promise<LabDriverForkResult> {
    const submittedAt = new Date().toISOString();
    const inheritedProviderTurnIds = this.threadTurns.get(
      input.sourceSession.providerThreadId
    );
    if (
      input.sourceSession.driverId !== this.id ||
      !inheritedProviderTurnIds ||
      !Number.isFinite(input.maximumForkMs) ||
      !Number.isFinite(input.experimentDeadlineMs) ||
      Date.now() >= input.experimentDeadlineMs ||
      input.maximumForkMs <= 0
    ) {
      return Promise.resolve({
        forkKey: input.forkKey,
        sourceSession: structuredClone(input.sourceSession),
        inheritedProviderTurnIds: [],
        submittedAt,
        completedAt: new Date().toISOString(),
        requestedModel: input.model,
        requestedReasoningEffort: input.reasoningEffort,
        requestedServiceTier: input.serviceTier ?? null,
        failure: {
          kind: Date.now() >= input.experimentDeadlineMs ? 'TIMEOUT' : 'SETTINGS_MISMATCH',
          message: 'The scripted lab fork source or deadline is unavailable.'
        },
        providerAccounting: {
          forkMutationSubmitted: 'NO',
          forkMutationAcknowledged: 'NO',
          providerTurnStarted: 'NO',
          billableModelCall: 'NO'
        },
        violations: [],
        lifecycle: [{ event: 'rejected-before-fork', at: submittedAt }]
      });
    }
    const session = this.startScriptedSession(
      input.sourceSession.providerSessionTreeId
    );
    this.threadTurns.set(
      session.providerThreadId,
      [...inheritedProviderTurnIds]
    );
    const completedAt = new Date().toISOString();
    return Promise.resolve({
      forkKey: input.forkKey,
      sourceSession: structuredClone(input.sourceSession),
      session,
      inheritedProviderTurnIds: [...inheritedProviderTurnIds],
      submittedAt,
      acknowledgedAt: completedAt,
      completedAt,
      requestedModel: input.model,
      observedModel: input.model,
      observedModelProvider: 'scripted',
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: input.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      providerAccounting: {
        forkMutationSubmitted: 'YES',
        forkMutationAcknowledged: 'YES',
        providerTurnStarted: 'NO',
        billableModelCall: 'NO'
      },
      violations: [],
      lifecycle: [
        { event: 'fork-submitted', at: submittedAt },
        { event: 'fork-acknowledged', at: completedAt }
      ]
    });
  }

  private startScriptedSession(
    sessionTreeId = `scripted-session-tree-${this.nextThread}`
  ): LabDriverSession {
    const session = {
      driverId: this.id,
      providerThreadId: `scripted-thread-${this.nextThread++}`,
      providerSessionTreeId: sessionTreeId
    };
    this.threadTurns.set(session.providerThreadId, []);
    return session;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function tokenControl(
  input: LabTextCallInput,
  observedOutputTokens: number | null,
  providerEnforcedLimit: boolean,
  usageStatus: NonNullable<LabTextCallResult['tokenControl']>['usageStatus']
): NonNullable<LabTextCallResult['tokenControl']> {
  const safetyCeilingOutputTokens = input.outputTokenSafetyCeiling ?? input.maximumOutputTokens;
  return {
    targetOutputTokens: input.maximumOutputTokens,
    safetyCeilingOutputTokens,
    providerEnforcedLimit,
    usageStatus,
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

async function boundedResolve<T>(
  operation: Promise<T>,
  maximumWaitMs: number
): Promise<
  | { kind: 'OUTPUT'; value: T }
  | { kind: 'TIMEOUT' }
  | { kind: 'ERROR'; error: unknown }
> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(
        (value) => ({ kind: 'OUTPUT' as const, value }),
        (error: unknown) => ({ kind: 'ERROR' as const, error })
      ),
      new Promise<{ kind: 'TIMEOUT' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'TIMEOUT' }), maximumWaitMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokenUsage(value: string): LabTokenUsage {
  const byteLength = Buffer.byteLength(value, 'utf8');
  const outputTokens = byteLength === 0 ? 0 : Math.ceil(byteLength / 4);
  return {
    totalTokens: outputTokens,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0
  };
}

function truncateToOutputTokenLimit(value: string, maximumOutputTokens: number): string {
  const maximumBytes = Math.max(0, maximumOutputTokens * 4);
  const characters: string[] = [];
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > maximumBytes) break;
    characters.push(character);
    byteLength += characterBytes;
  }
  return characters.join('');
}
