import {
  LAB_INITIAL_ARTIFACT_ID,
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabAccountingStatus,
  type LabArtifactRecord,
  type LabArtifactCallProvenance,
  type LabCallPurpose,
  type LabExecutionFailure,
  type LabOutputAttemptInput,
  type LabOutputRecord,
  type LabParticipantCase,
  type LabPublicOutput,
  type LabSessionAttestationStatus,
  type LabThreadStartStatus,
  type LabTokenUsage,
  type LabTransitionLink
} from './contracts';
import { LabArtifactLedger, sha256Text, stableJson } from './ledger';
import {
  LAB_PUBLIC_OUTPUT_JSON_SCHEMA,
  createLabOutputRecord,
  type LabPublicOutputValidationContext
} from './outputValidation';
import { buildLabPrompt, type LabPublicIntervention } from './prompts';
import {
  assertFiniteProtocolPlan,
  type LabProtocolCall,
  type LabProtocolPlan,
  type LabVisibilityRef
} from './protocols';
import type { LabTextCallInput, LabTextCallResult, LabTextDriver } from './textDriver';

export const LAB_RUNNER_VERSION = 'finite-text-runner@v5' as const;

export interface LabRunnerLimits {
  maximumCalls: number;
  maximumRounds: number;
  maximumInputTokensPerCall: number;
  /** Optional emergency ceiling distinct from each call's concise-output target. */
  outputTokenSafetyCeilingPerCall?: number;
  maximumObservedTotalTokens: number;
  maximumCallMs: number;
  maximumExperimentMs: number;
  maximumConcurrency: number;
}

export interface LabModelConfiguration {
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  seed?: number;
}

export interface LabParticipantPromptArtifact {
  kind: 'PARTICIPANT_PROMPT';
  caseId: string;
  conditionId: string;
  callId: string;
  prompt: string;
}

export interface LabPreparedPrompt {
  callId: string;
  prompt: string;
  promptArtifactSha256: string;
  artifact: LabParticipantPromptArtifact;
}

export interface LabCallAccountingRecord {
  assignedCallId: string;
  purpose: LabCallPurpose;
  callKey: string;
  promptArtifactSha256: string;
  transitionArtifactSha256?: string;
  dispatched: boolean;
  threadStartRequested: boolean;
  threadStartStatus: LabThreadStartStatus;
  sessionAttestation: LabSessionAttestationStatus;
  providerThreadId: string | null;
  providerTurnStarted: LabAccountingStatus;
  providerTurnId: string | null;
  billableModelCall: LabAccountingStatus;
  failure: LabExecutionFailure | null;
  violations: string[];
  lifecycle: LabTextCallResult['lifecycle'];
}

export interface LabCallAccountingSummary {
  assignedCalls: number;
  dispatchedCalls: number;
  threadStartRequests: number;
  providerThreadsAttested: number;
  providerThreadsCreatedUnattested: number;
  providerThreadStartsNotStarted: number;
  threadStartUnknown: number;
  providerTurnsStarted: number;
  providerTurnsNotStarted: number;
  providerTurnStartUnknown: number;
  billableModelCalls: number;
  nonBillableModelCalls: number;
  billableModelCallsUnknown: number;
}

export interface LabProtocolRunResult {
  schemaVersion: 'task-monki/discourse-lab-run@v5';
  runnerVersion: typeof LAB_RUNNER_VERSION;
  caseId: string;
  conditionId: string;
  /** Controlled-corpus execution identity; absent for non-assignment harness runs. */
  assignmentId?: string;
  startedAt: string;
  completedAt: string;
  status: 'COMPLETED' | 'STOPPED' | 'FAILED';
  stopReason?: string;
  plan: LabProtocolPlan;
  modelConfiguration: LabModelConfiguration;
  maximumBudget: {
    calls: number;
    rounds: number;
    outputTokens: number;
    outputTokenSafetyCeiling?: number;
    observedTotalTokens: number;
    callMs: number;
    experimentMs: number;
  };
  realizedBudget: {
    /** Backward-readable alias for dispatchedCalls, not provider billing. */
    calls: number;
    assignedCalls: number;
    dispatchedCalls: number;
    threadStartRequests: number;
    providerThreadsAttested: number;
    providerThreadsCreatedUnattested: number;
    providerThreadStartsNotStarted: number;
    threadStartUnknown: number;
    providerTurnsStarted: number;
    providerTurnsNotStarted: number;
    providerTurnStartUnknown: number;
    billableModelCalls: number;
    nonBillableModelCalls: number;
    billableModelCallsUnknown: number;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    elapsedMs: number;
  };
  calls: LabTextCallResult[];
  callAccounting: LabCallAccountingRecord[];
  artifacts: LabArtifactRecord[];
  initialArtifactIds: string[];
  terminalArtifactIds: string[];
  transitionLinks: LabTransitionLink[];
}

export interface RunLabProtocolInput {
  participantCase: LabParticipantCase;
  plan: LabProtocolPlan;
  driver: LabTextDriver;
  modelConfiguration: LabModelConfiguration;
  limits: LabRunnerLimits;
  ledger?: LabArtifactLedger;
  intervention?: LabPublicIntervention;
  /** Isolates repeated case/condition cells belonging to different sealed bundles. */
  assignmentId?: string;
  /** Optional immutable prompt records created before an experiment dispatches. */
  preparedPrompts?: readonly LabPreparedPrompt[];
}

interface PreparedCall {
  call: LabProtocolCall;
  parents: LabArtifactRecord[];
  preparedPrompt: LabPreparedPrompt;
}

interface ExecutedAttempt {
  result: LabTextCallResult;
  accounting: LabCallAccountingRecord;
}

export function materializeInitialLabPrompt(input: {
  participantCase: LabParticipantCase;
  plan: LabProtocolPlan;
  intervention?: LabPublicIntervention;
  maximumInputTokensPerCall: number;
}): LabPreparedPrompt {
  assertFiniteProtocolPlan(input.plan);
  if (input.plan.calls.length !== 1) {
    throw new Error('Pre-dispatch materialization currently requires a one-call protocol plan.');
  }
  const initialArtifacts = input.intervention
    ? [sealedInitialArtifact(input.participantCase, input.intervention)]
    : [];
  const call = input.plan.calls[0]!;
  const prompt = promptForCall(
    input.participantCase,
    call,
    initialArtifacts,
    input.intervention,
    input.maximumInputTokensPerCall
  );
  return preparedPrompt(input.participantCase.caseId, input.plan.conditionId, call.id, prompt);
}

export async function runLabProtocol(input: RunLabProtocolInput): Promise<LabProtocolRunResult> {
  assertFiniteProtocolPlan(input.plan);
  assertRunnerLimits(input);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const deadlineMs = startedMs + input.limits.maximumExperimentMs;
  const artifacts: LabArtifactRecord[] = [];
  const results: LabTextCallResult[] = [];
  const accounting: LabCallAccountingRecord[] = [];
  const sessions = new Map<string, NonNullable<LabTextCallResult['session']>>();
  const suppliedPrompts = preparedPromptMap(input);
  let status: LabProtocolRunResult['status'] = 'COMPLETED';
  let stopReason: string | undefined;
  let nextIndex = 0;

  if (input.intervention) {
    artifacts.push(sealedInitialArtifact(input.participantCase, input.intervention));
  }

  await input.ledger?.append({
    eventType: 'CONDITION_STARTED',
    occurredAt: startedAt,
    caseId: input.participantCase.caseId,
    conditionId: input.plan.conditionId,
    detail: {
      ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
      maximumBudget: input.plan,
      runnerVersion: LAB_RUNNER_VERSION
    }
  });

  while (nextIndex < input.plan.calls.length) {
    const dispatched = dispatchedCount(accounting);
    if (dispatched >= input.limits.maximumCalls || Date.now() >= deadlineMs) {
      status = 'STOPPED';
      stopReason = dispatched >= input.limits.maximumCalls ? 'HARD_CALL_CAP' : 'HARD_TIME_CAP';
      break;
    }
    const first = input.plan.calls[nextIndex]!;
    const group = first.blindGroup
      ? prefixWhile(
          input.plan.calls.slice(nextIndex),
          (candidate) => candidate.blindGroup === first.blindGroup
        )
      : [first];
    if (dispatched + group.length > input.limits.maximumCalls) {
      status = 'STOPPED';
      stopReason = 'HARD_CALL_CAP';
      break;
    }

    let prepared: PreparedCall[];
    try {
      prepared = [];
      for (const call of group) {
        const parents = resolveVisibleArtifacts(call, artifacts);
        const prompt = promptForCall(
          input.participantCase,
          call,
          artifacts,
          input.intervention,
          input.limits.maximumInputTokensPerCall
        );
        const materialized = preparedPrompt(
          input.participantCase.caseId,
          input.plan.conditionId,
          call.id,
          prompt
        );
        const supplied = suppliedPrompts.get(call.id);
        if (supplied) assertPreparedPromptMatches(supplied, materialized);
        const selected = supplied ?? materialized;
        if (!supplied) await persistPreparedPrompt(input.ledger, selected);
        prepared.push({ call, parents, preparedPrompt: selected });
      }
    } catch (error) {
      status = 'FAILED';
      stopReason = `PROMPT_OR_VISIBILITY_FAILURE: ${errorMessage(error)}`;
      break;
    }

    // Every prompt in a blind group is frozen before any sibling is dispatched.
    const groupExecutions = await mapWithConcurrency(
      prepared,
      input.limits.maximumConcurrency,
      async (item) => {
        const continuation = item.call.continueFrom
          ? sessions.get(item.call.continueFrom)
          : undefined;
        return executeAttempt({
          input,
          call: item.call,
          purpose: 'PRIMARY',
          callKey: primaryCallKey(input, item.call),
          prompt: item.preparedPrompt.prompt,
          promptArtifactSha256: item.preparedPrompt.promptArtifactSha256,
          continuation,
          continuationRequired: Boolean(item.call.continueFrom),
          deadlineMs
        });
      }
    );

    let groupFailure: { status: LabProtocolRunResult['status']; reason: string } | undefined;
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!;
      const primary = groupExecutions[index]!;
      results.push(primary.result);
      accounting.push(primary.accounting);
      if (primary.result.session) sessions.set(item.call.id, primary.result.session);

      let repair: ExecutedAttempt | undefined;
      const outputContext = validationContext(input, item.call, item.parents);
      let output = createLabOutputRecord(
        attemptFrom(primary.result, primary.accounting.dispatched),
        undefined,
        outputContext
      );
      const primaryUsageUnavailable = providerUsageUnavailable(primary.result);
      if (primaryUsageUnavailable) {
        groupFailure ??= { status: 'STOPPED', reason: 'TOKEN_ACCOUNTING_UNAVAILABLE' };
      }
      if (!primary.result.failure && !primaryUsageUnavailable && output.status === 'INVALID') {
        const inability = schemaRepairInability(input, accounting, results, deadlineMs, primary);
        if (inability) {
          groupFailure ??= inability;
        } else {
          const repairPrompt = buildSchemaRepairPrompt(item.call, output);
          assertPromptTokenCeiling(
            `${item.call.id}:schema-repair`,
            repairPrompt,
            input.limits.maximumInputTokensPerCall
          );
          const repairMaterialized = preparedPrompt(
            input.participantCase.caseId,
            input.plan.conditionId,
            `${item.call.id}:schema-repair`,
            repairPrompt
          );
          await persistPreparedPrompt(input.ledger, repairMaterialized);
          repair = await executeAttempt({
            input,
            call: item.call,
            purpose: 'SCHEMA_REPAIR',
            callKey: repairCallKey(input, item.call),
            prompt: repairPrompt,
            promptArtifactSha256: repairMaterialized.promptArtifactSha256,
            continuation: primary.result.session,
            continuationRequired: true,
            deadlineMs
          });
          results.push(repair.result);
          accounting.push(repair.accounting);
          if (repair.result.session) sessions.set(item.call.id, repair.result.session);
          output = createLabOutputRecord(
            attemptFrom(primary.result, primary.accounting.dispatched),
            attemptFrom(repair.result, repair.accounting.dispatched),
            outputContext
          );
          if (repair.result.failure) {
            groupFailure ??= failureOutcome(repair.result, 'SCHEMA_REPAIR_CALL_FAILURE');
          } else if (providerUsageUnavailable(repair.result)) {
            groupFailure ??= { status: 'STOPPED', reason: 'TOKEN_ACCOUNTING_UNAVAILABLE' };
          } else if (output.status === 'INVALID') {
            groupFailure ??= { status: 'FAILED', reason: 'SCHEMA_FAILURE_AFTER_REPAIR' };
          }
        }
      } else if (primary.result.failure) {
        groupFailure ??= failureOutcome(primary.result, 'CALL_FAILURE');
      }

      const artifact = providerArtifact(
        input,
        item.call,
        primary,
        repair,
        item.parents,
        output
      );
      artifacts.push(artifact);
      const stored = await input.ledger?.putArtifact({
        kind: 'CALL_TRANSITION',
        caseId: input.participantCase.caseId,
        conditionId: input.plan.conditionId,
        call: item.call,
        primary: primary.result,
        repair: repair?.result ?? null,
        artifact
      });
      for (const attempt of [primary, repair].filter(
        (candidate): candidate is ExecutedAttempt => Boolean(candidate)
      )) {
        if (stored) attempt.accounting.transitionArtifactSha256 = stored.sha256;
        await appendAttemptSettlement(input, item.call, attempt, stored?.sha256);
      }
    }

    nextIndex += group.length;
    if (groupFailure) {
      status = groupFailure.status;
      stopReason = groupFailure.reason;
      break;
    }
    const observedTotal = sumKnown(results.map((item) => item.usage?.last.totalTokens));
    if (observedTotal !== null && observedTotal >= input.limits.maximumObservedTotalTokens) {
      status = nextIndex >= input.plan.calls.length ? status : 'STOPPED';
      stopReason ??= nextIndex >= input.plan.calls.length ? undefined : 'HARD_TOKEN_CAP';
      if (stopReason) break;
    }
    if (hasRepeatedTerminalBehavior(artifacts)) {
      status = nextIndex >= input.plan.calls.length ? status : 'STOPPED';
      stopReason ??= nextIndex >= input.plan.calls.length ? undefined : 'REPEATED_BEHAVIOR';
      if (stopReason) break;
    }
  }

  const completedAt = new Date().toISOString();
  const initialArtifactIds = input.intervention
    ? [LAB_INITIAL_ARTIFACT_ID]
    : artifacts
        .filter((artifact) => artifact.stage === 'POSITION')
        .map((artifact) => artifact.artifactId);
  const plannedTerminals = new Set(input.plan.terminalArtifacts);
  let terminalArtifactIds = artifacts
    .filter((artifact) => plannedTerminals.has(callIdFromArtifact(artifact)))
    .map((artifact) => artifact.artifactId);
  if (terminalArtifactIds.length === 0 && artifacts.length > 0) {
    terminalArtifactIds = [artifacts.at(-1)!.artifactId];
  }
  const transitionLinks = buildTransitionLinks(input.plan, artifacts, input.intervention);
  const realized = realizedBudget(input.plan, results, accounting, Date.now() - startedMs);
  const run: LabProtocolRunResult = {
    schemaVersion: 'task-monki/discourse-lab-run@v5',
    runnerVersion: LAB_RUNNER_VERSION,
    caseId: input.participantCase.caseId,
    conditionId: input.plan.conditionId,
    ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
    startedAt,
    completedAt,
    status,
    ...(stopReason ? { stopReason } : {}),
    plan: structuredClone(input.plan),
    modelConfiguration: { ...input.modelConfiguration },
    maximumBudget: {
      calls: input.limits.maximumCalls,
      rounds: input.limits.maximumRounds,
      outputTokens: maximumOutputTokenBudget(input),
      ...(input.limits.outputTokenSafetyCeilingPerCall
        ? {
            outputTokenSafetyCeiling:
              input.limits.outputTokenSafetyCeilingPerCall * input.limits.maximumCalls
          }
        : {}),
      observedTotalTokens: input.limits.maximumObservedTotalTokens,
      callMs: input.limits.maximumCallMs,
      experimentMs: input.limits.maximumExperimentMs
    },
    realizedBudget: realized,
    calls: results,
    callAccounting: accounting,
    artifacts,
    initialArtifactIds,
    terminalArtifactIds,
    transitionLinks
  };
  const report = await input.ledger?.putArtifact(run);
  await input.ledger?.append({
    eventType: 'CONDITION_SETTLED',
    occurredAt: completedAt,
    caseId: input.participantCase.caseId,
    conditionId: input.plan.conditionId,
    artifactSha256: report?.sha256,
    detail: {
      ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
      status,
      stopReason,
      realizedBudget: realized
    }
  });
  return run;
}

function failureOutcome(
  result: LabTextCallResult,
  fallbackReason: string
): { status: LabProtocolRunResult['status']; reason: string } {
  if (result.failure?.kind === 'TIMEOUT') {
    return { status: 'STOPPED', reason: 'HARD_TIME_CAP' };
  }
  if (result.failure?.kind === 'TOKEN_LIMIT_EXCEEDED') {
    return { status: 'STOPPED', reason: 'HARD_TOKEN_CAP' };
  }
  return { status: 'FAILED', reason: fallbackReason };
}

function providerUsageUnavailable(result: LabTextCallResult): boolean {
  return (
    result.providerAccounting.providerTurnStarted !== 'NO' &&
    result.tokenControl?.usageStatus === 'UNAVAILABLE'
  );
}

function sealedInitialArtifact(
  participantCase: LabParticipantCase,
  intervention: LabPublicIntervention
): LabArtifactRecord {
  const assessmentByClaim = new Map(
    intervention.fixedInitial.assessments.map((item) => [item.claimId, item.stance])
  );
  const output: LabPublicOutput = {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: normalizeFixtureStatus(intervention.fixedInitial.status),
    answer: {
      summary: intervention.fixedInitial.answer,
      values: intervention.fixedInitial.values ?? [intervention.fixedInitial.answer],
      selectedOptionIds: intervention.fixedInitial.selectedOptionIds ?? []
    },
    claims: participantCase.propositions.map((proposition, index) => ({
      id: `fixture-claim-${index + 1}`,
      propositionId: proposition.id,
      topicId: proposition.topicId,
      stance: normalizeFixtureStance(assessmentByClaim.get(proposition.id)),
      statement: proposition.text,
      evidence: [],
      assumptionIds: [],
      confidence: 0.8
    })),
    assumptions: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'Sealed initial artifact before the controlled signal.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 0.8
  };
  return {
    artifactId: LAB_INITIAL_ARTIFACT_ID,
    actorId: 'SEALED_INITIAL',
    stage: 'SEALED_INITIAL',
    parentArtifactIds: [],
    output: createLabOutputRecord(
      {
        callId: `${intervention.bundleId}:fixed-initial`,
        rawText: JSON.stringify(output),
        charged: false
      },
      undefined,
      { participantCase, visibleArtifacts: [] }
    )
  };
}

function providerArtifact(
  input: RunLabProtocolInput,
  call: LabProtocolCall,
  primary: ExecutedAttempt,
  repair: ExecutedAttempt | undefined,
  parents: LabArtifactRecord[],
  output: LabOutputRecord
): LabArtifactRecord {
  const attempts = [primary, repair].filter(
    (candidate): candidate is ExecutedAttempt => Boolean(candidate)
  );
  const callProvenance: LabArtifactCallProvenance = {
    assignedCallId: call.id,
    primaryCallKey: primary.result.callKey,
    repairCallKey: repair?.result.callKey ?? null,
    promptArtifactSha256: primary.accounting.promptArtifactSha256,
    repairPromptArtifactSha256: repair?.accounting.promptArtifactSha256 ?? null,
    providerThreadId:
      repair?.accounting.providerThreadId ?? primary.accounting.providerThreadId,
    providerTurnIds: attempts.flatMap((attempt) =>
      attempt.accounting.providerTurnId ? [attempt.accounting.providerTurnId] : []
    ),
    failures: attempts.flatMap((attempt) =>
      attempt.accounting.failure
        ? [{
            attempt: attempt.accounting.purpose,
            kind: attempt.accounting.failure.kind,
            message: attempt.accounting.failure.message,
            phase: attempt.accounting.failure.phase
          }]
        : []
    )
  };
  return {
    artifactId: call.id,
    actorId: call.actor,
    stage: call.promptKind,
    parentArtifactIds: parents.map((artifact) => artifact.artifactId),
    output,
    call: callProvenance
  };
}

function attemptFrom(result: LabTextCallResult, dispatched: boolean): LabOutputAttemptInput {
  return {
    callId: result.callKey,
    rawText: result.rawText,
    charged: dispatched,
    latencyMs:
      Date.parse(result.completedAt) - Date.parse(result.submittedAt),
    ...(result.usage ? { usage: usageFrom(result) } : {}),
    ...(result.failure ? { executionFailure: executionFailure(result) } : {})
  };
}

function usageFrom(result: LabTextCallResult): LabTokenUsage {
  const usage = result.usage!.last;
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens
  };
}

function executionFailure(result: LabTextCallResult): LabExecutionFailure {
  const phase: LabExecutionFailure['phase'] =
    result.providerAccounting.providerTurnStarted === 'YES'
      ? 'TURN_EXECUTION'
      : result.providerAccounting.threadStartStatus === 'CREATED_UNATTESTED' ||
          result.providerAccounting.sessionAttestation === 'UNATTESTED'
      ? 'THREAD_ATTESTATION'
      : result.lifecycle.some((item) => item.event === 'rejected-before-turn')
        ? 'PRE_TURN'
        : 'UNKNOWN';
  return {
    kind: result.failure!.kind,
    message: result.failure!.message,
    phase,
    providerThreadId: result.session?.providerThreadId ?? null,
    providerTurnId: result.providerTurnId ?? null
  };
}

function promptForCall(
  participantCase: LabParticipantCase,
  call: LabProtocolCall,
  artifacts: LabArtifactRecord[],
  intervention: LabPublicIntervention | undefined,
  maximumInputTokensPerCall: number
): string {
  const prompt = buildLabPrompt({
    participantCase,
    call,
    visibleArtifacts: resolveVisibleArtifacts(call, artifacts),
    intervention: call.visible.includes('INTERVENTION') ? intervention : undefined
  });
  assertPromptTokenCeiling(call.id, prompt, maximumInputTokensPerCall);
  return prompt;
}

function validationContext(
  input: RunLabProtocolInput,
  call: LabProtocolCall,
  visibleArtifacts: readonly LabArtifactRecord[]
): LabPublicOutputValidationContext {
  return {
    participantCase: input.participantCase,
    visibleArtifacts,
    ...(call.visible.includes('INTERVENTION') && input.intervention
      ? { intervention: input.intervention }
      : {})
  };
}

function assertPromptTokenCeiling(callId: string, prompt: string, ceiling: number): void {
  const estimatedInputTokens = estimateTokens(prompt);
  if (estimatedInputTokens > ceiling) {
    throw new Error(
      `Prompt ${callId} requires approximately ${estimatedInputTokens} tokens, above the ${ceiling} input ceiling.`
    );
  }
}

function preparedPrompt(
  caseId: string,
  conditionId: string,
  callId: string,
  prompt: string
): LabPreparedPrompt {
  const artifact: LabParticipantPromptArtifact = {
    kind: 'PARTICIPANT_PROMPT',
    caseId,
    conditionId,
    callId,
    prompt
  };
  return {
    callId,
    prompt,
    promptArtifactSha256: sha256Text(`${stableJson(artifact)}\n`),
    artifact
  };
}

function preparedPromptMap(input: RunLabProtocolInput): Map<string, LabPreparedPrompt> {
  const supplied = new Map<string, LabPreparedPrompt>();
  for (const prompt of input.preparedPrompts ?? []) {
    if (supplied.has(prompt.callId)) {
      throw new Error(`Duplicate prepared prompt for ${prompt.callId}.`);
    }
    const expected = preparedPrompt(
      input.participantCase.caseId,
      input.plan.conditionId,
      prompt.callId,
      prompt.prompt
    );
    assertPreparedPromptMatches(prompt, expected);
    supplied.set(prompt.callId, prompt);
  }
  return supplied;
}

function assertPreparedPromptMatches(
  supplied: LabPreparedPrompt,
  expected: LabPreparedPrompt
): void {
  if (
    supplied.callId !== expected.callId ||
    supplied.prompt !== expected.prompt ||
    supplied.promptArtifactSha256 !== expected.promptArtifactSha256 ||
    stableJson(supplied.artifact) !== stableJson(expected.artifact)
  ) {
    throw new Error(`Prepared prompt mismatch for ${expected.callId}.`);
  }
}

async function persistPreparedPrompt(
  ledger: LabArtifactLedger | undefined,
  prompt: LabPreparedPrompt
): Promise<void> {
  const stored = await ledger?.putArtifact(prompt.artifact);
  if (stored && stored.sha256 !== prompt.promptArtifactSha256) {
    throw new Error(`Prompt artifact hash mismatch for ${prompt.callId}.`);
  }
}

async function executeAttempt(args: {
  input: RunLabProtocolInput;
  call: LabProtocolCall;
  purpose: LabCallPurpose;
  callKey: string;
  prompt: string;
  promptArtifactSha256: string;
  continuation: LabTextCallInput['continuation'];
  continuationRequired: boolean;
  deadlineMs: number;
}): Promise<ExecutedAttempt> {
  const threadStartRequested = !args.continuation && !args.continuationRequired;
  if (args.continuationRequired && !args.continuation) {
    const result = failedDriverResult(
      args.input,
      args.callKey,
      'PROVIDER_ERROR',
      `Continuation for ${args.call.id} is unavailable.`,
      {
        sessionAttestation: 'NOT_PRESENT',
        threadStartStatus: 'NOT_REQUIRED',
        providerTurnStarted: 'NO',
        billableModelCall: 'NO'
      }
    );
    const failure: LabExecutionFailure = {
      kind: 'CONTINUATION_UNAVAILABLE',
      message: result.failure!.message,
      phase: 'PRE_TURN',
      providerThreadId: null,
      providerTurnId: null
    };
    return {
      result,
      accounting: accountingFor(
        args.call,
        args.purpose,
        args.promptArtifactSha256,
        result,
        false,
        false,
        failure
      )
    };
  }

  await args.input.ledger?.append({
    eventType: 'CALL_SUBMITTED',
    occurredAt: new Date().toISOString(),
    caseId: args.input.participantCase.caseId,
    conditionId: args.input.plan.conditionId,
    callId: callEventId(args.input, args.call, args.purpose),
    artifactSha256: args.promptArtifactSha256,
    detail: { purpose: args.purpose }
  });
  const callInput: LabTextCallInput = {
    callKey: args.callKey,
    prompt: args.prompt,
    outputSchema: LAB_PUBLIC_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    model: args.input.modelConfiguration.model,
    reasoningEffort: args.input.modelConfiguration.reasoningEffort,
    serviceTier: args.input.modelConfiguration.serviceTier,
    seed: args.input.modelConfiguration.seed,
    continuation: args.continuation,
    maximumOutputTokens: args.call.maxOutputTokens,
    outputTokenSafetyCeiling: args.input.limits.outputTokenSafetyCeilingPerCall,
    maximumCallMs: args.input.limits.maximumCallMs,
    experimentDeadlineMs: args.deadlineMs
  };
  let result: LabTextCallResult;
  try {
    result = await args.input.driver.call(callInput);
  } catch (error) {
    result = failedDriverResult(
      args.input,
      args.callKey,
      'PROVIDER_ERROR',
      `Driver threw after dispatch: ${errorMessage(error)}`,
      {
        sessionAttestation: 'UNKNOWN',
        threadStartStatus: threadStartRequested ? 'UNKNOWN' : 'NOT_REQUIRED',
        providerTurnStarted: 'UNKNOWN',
        billableModelCall: 'UNKNOWN'
      }
    );
  }
  return {
    result,
    accounting: accountingFor(
      args.call,
      args.purpose,
      args.promptArtifactSha256,
      result,
      true,
      threadStartRequested
    )
  };
}

function accountingFor(
  call: LabProtocolCall,
  purpose: LabCallPurpose,
  promptArtifactSha256: string,
  result: LabTextCallResult,
  dispatched: boolean,
  threadStartRequested: boolean,
  failureOverride?: LabExecutionFailure
): LabCallAccountingRecord {
  const failure = failureOverride ?? (result.failure ? executionFailure(result) : null);
  const providerTurnStarted = result.providerAccounting.providerTurnStarted;
  const threadStartStatus = result.providerAccounting.threadStartStatus;
  return {
    assignedCallId: call.id,
    purpose,
    callKey: result.callKey,
    promptArtifactSha256,
    dispatched,
    threadStartRequested,
    threadStartStatus,
    sessionAttestation: result.providerAccounting.sessionAttestation,
    providerThreadId: result.session?.providerThreadId ?? null,
    providerTurnStarted,
    providerTurnId: result.providerTurnId ?? null,
    billableModelCall: result.providerAccounting.billableModelCall,
    failure,
    violations: [...result.violations],
    lifecycle: structuredClone(result.lifecycle)
  };
}

function buildSchemaRepairPrompt(call: LabProtocolCall, output: LabOutputRecord): string {
  return [
    'DISCOURSE_PROTOCOL_LAB_SCHEMA_REPAIR: v1',
    `CALL_ID: ${call.id}:schema-repair`,
    '',
    'Your immediately preceding response did not satisfy the public JSON output contract.',
    'Re-emit exactly one JSON object matching the supplied schema.',
    'Preserve the preceding response’s substantive claims; repair structure and references only.',
    'Do not add analysis, rationale, scratchpad, markdown, or commentary.',
    '',
    'Validation errors:',
    stableJson(output.attempts[0]?.validationErrors ?? [])
  ].join('\n');
}

function schemaRepairInability(
  input: RunLabProtocolInput,
  accounting: LabCallAccountingRecord[],
  results: LabTextCallResult[],
  deadlineMs: number,
  primary: ExecutedAttempt
): { status: LabProtocolRunResult['status']; reason: string } | undefined {
  if (!input.driver.capabilities.continuation || !primary.result.session) {
    return { status: 'FAILED', reason: 'SCHEMA_REPAIR_UNAVAILABLE' };
  }
  if (dispatchedCount(accounting) >= input.limits.maximumCalls) {
    return { status: 'STOPPED', reason: 'HARD_CALL_CAP' };
  }
  if (Date.now() >= deadlineMs) return { status: 'STOPPED', reason: 'HARD_TIME_CAP' };
  const observed = sumKnown(results.map((item) => item.usage?.last.totalTokens));
  if (observed === null) {
    return { status: 'STOPPED', reason: 'TOKEN_ACCOUNTING_UNAVAILABLE' };
  }
  if (observed >= input.limits.maximumObservedTotalTokens) {
    return { status: 'STOPPED', reason: 'HARD_TOKEN_CAP' };
  }
  return undefined;
}

async function appendAttemptSettlement(
  input: RunLabProtocolInput,
  call: LabProtocolCall,
  attempt: ExecutedAttempt,
  transitionArtifactSha256: string | undefined
): Promise<void> {
  await input.ledger?.append({
    eventType: attempt.result.failure ? 'CALL_FAILED' : 'CALL_COMPLETED',
    occurredAt: attempt.result.completedAt,
    caseId: input.participantCase.caseId,
    conditionId: input.plan.conditionId,
    callId: callEventId(input, call, attempt.accounting.purpose),
    artifactSha256: transitionArtifactSha256,
    detail: {
      purpose: attempt.accounting.purpose,
      dispatched: attempt.accounting.dispatched,
      providerThreadId: attempt.accounting.providerThreadId,
      sessionAttestation: attempt.accounting.sessionAttestation,
      threadStartStatus: attempt.accounting.threadStartStatus,
      providerTurnId: attempt.accounting.providerTurnId,
      providerTurnStarted: attempt.accounting.providerTurnStarted,
      billableModelCall: attempt.accounting.billableModelCall,
      failure: attempt.accounting.failure,
      violations: attempt.accounting.violations
    }
  });
}

function primaryCallKey(input: RunLabProtocolInput, call: LabProtocolCall): string {
  const scope = input.assignmentId
    ? `assignment:${input.assignmentId}`
    : `case:${input.participantCase.caseId}`;
  return `${scope}:${input.participantCase.caseId}:${input.plan.conditionId}:${call.id}`;
}

function repairCallKey(input: RunLabProtocolInput, call: LabProtocolCall): string {
  return `${primaryCallKey(input, call)}:schema-repair`;
}

function callEventId(
  input: RunLabProtocolInput,
  call: LabProtocolCall,
  purpose: LabCallPurpose
): string {
  const callId = purpose === 'PRIMARY' ? call.id : `${call.id}:schema-repair`;
  return input.assignmentId ? `${input.assignmentId}:${callId}` : callId;
}

function resolveVisibleArtifacts(
  call: LabProtocolCall,
  artifacts: LabArtifactRecord[]
): LabArtifactRecord[] {
  const selected = new Map<string, LabArtifactRecord>();
  const add = (artifact: LabArtifactRecord | undefined) => {
    if (artifact) selected.set(artifact.artifactId, artifact);
  };
  for (const reference of call.visible) {
    if (reference === 'CASE' || reference === 'INTERVENTION') continue;
    if (reference === 'PRIOR_SELF') {
      artifacts.filter((artifact) => artifact.actorId === call.actor).forEach(add);
      continue;
    }
    const target = callIdForVisibility(reference);
    add(
      [...artifacts].reverse().find(
        (artifact) =>
          callIdFromArtifact(artifact) === target ||
          (reference === 'C' && artifact.actorId === 'C')
      )
    );
  }
  if (call.promptKind === 'CONTROLLED_RESPONSE') {
    add(artifacts.find((artifact) => artifact.stage === 'SEALED_INITIAL'));
  }
  const requiredReferences = call.visible.filter(
    (reference) => reference !== 'CASE' && reference !== 'INTERVENTION' && reference !== 'PRIOR_SELF'
  );
  if (selected.size < requiredReferences.length) {
    throw new Error(`Call ${call.id} cannot resolve every declared public artifact.`);
  }
  return [...selected.values()];
}

function callIdForVisibility(reference: Exclude<LabVisibilityRef, 'CASE' | 'INTERVENTION' | 'PRIOR_SELF'>): string {
  switch (reference) {
    case 'REVIEW_1':
      return 'review-1';
    case 'REVIEW_2':
      return 'review-2';
    default:
      return reference;
  }
}

function buildTransitionLinks(
  plan: LabProtocolPlan,
  artifacts: LabArtifactRecord[],
  intervention?: LabPublicIntervention
): LabTransitionLink[] {
  const byCall = new Map(artifacts.map((artifact) => [callIdFromArtifact(artifact), artifact]));
  const links: LabTransitionLink[] = [];
  if (intervention) {
    const response = byCall.get('response');
    if (response) {
      links.push({
        fromArtifactId: LAB_INITIAL_ARTIFACT_ID,
        toArtifactId: response.artifactId
      });
    }
  }
  for (const call of plan.calls) {
    const to = byCall.get(call.id);
    if (!to) continue;
    if (call.promptKind === 'AUDIT') {
      for (const source of ['A_RESPONSE', 'B_RESPONSE']) {
        const from = byCall.get(source);
        if (from) links.push({ fromArtifactId: from.artifactId, toArtifactId: to.artifactId });
      }
    } else if (call.continueFrom) {
      const from = byCall.get(call.continueFrom);
      if (from) links.push({ fromArtifactId: from.artifactId, toArtifactId: to.artifactId });
    }
  }
  return links;
}

function callIdFromArtifact(artifact: LabArtifactRecord): string {
  if (artifact.stage === 'SEALED_INITIAL') return 'SEALED_INITIAL';
  return artifact.artifactId;
}

function realizedBudget(
  plan: LabProtocolPlan,
  results: LabTextCallResult[],
  accounting: LabCallAccountingRecord[],
  elapsedMs: number
): LabProtocolRunResult['realizedBudget'] {
  const summary = summarizeAccounting(accounting);
  return {
    calls: summary.dispatchedCalls,
    ...summary,
    assignedCalls:
      plan.calls.length + accounting.filter((item) => item.purpose === 'SCHEMA_REPAIR').length,
    inputTokens: sumKnown(results.map((item) => item.usage?.last.inputTokens)),
    cachedInputTokens: sumKnown(results.map((item) => item.usage?.last.cachedInputTokens)),
    outputTokens: sumKnown(results.map((item) => item.usage?.last.outputTokens)),
    reasoningTokens: sumKnown(results.map((item) => item.usage?.last.reasoningOutputTokens)),
    totalTokens: sumKnown(results.map((item) => item.usage?.last.totalTokens)),
    elapsedMs
  };
}

function summarizeAccounting(
  accounting: readonly LabCallAccountingRecord[]
): LabCallAccountingSummary {
  const count = (predicate: (item: LabCallAccountingRecord) => boolean) =>
    accounting.filter(predicate).length;
  return {
    assignedCalls: accounting.length,
    dispatchedCalls: count((item) => item.dispatched),
    threadStartRequests: count((item) => item.threadStartRequested),
    providerThreadsAttested: count((item) => item.threadStartStatus === 'ATTESTED'),
    providerThreadsCreatedUnattested: count(
      (item) => item.threadStartStatus === 'CREATED_UNATTESTED'
    ),
    providerThreadStartsNotStarted: count(
      (item) => item.threadStartStatus === 'NOT_STARTED'
    ),
    threadStartUnknown: count((item) => item.threadStartStatus === 'UNKNOWN'),
    providerTurnsStarted: count((item) => item.providerTurnStarted === 'YES'),
    providerTurnsNotStarted: count((item) => item.providerTurnStarted === 'NO'),
    providerTurnStartUnknown: count((item) => item.providerTurnStarted === 'UNKNOWN'),
    billableModelCalls: count((item) => item.billableModelCall === 'YES'),
    nonBillableModelCalls: count((item) => item.billableModelCall === 'NO'),
    billableModelCallsUnknown: count((item) => item.billableModelCall === 'UNKNOWN')
  };
}

function dispatchedCount(accounting: readonly LabCallAccountingRecord[]): number {
  return accounting.filter((item) => item.dispatched).length;
}

function maximumOutputTokenBudget(input: RunLabProtocolInput): number {
  const repairSlots = Math.max(
    0,
    Math.min(
      input.plan.calls.length,
      input.limits.maximumCalls - input.plan.maximumCalls
    )
  );
  const repairCeilings = input.plan.calls
    .map((call) => call.maxOutputTokens)
    .sort((left, right) => right - left)
    .slice(0, repairSlots)
    .reduce((sum, value) => sum + value, 0);
  return input.plan.maximumOutputTokens + repairCeilings;
}

function hasRepeatedTerminalBehavior(artifacts: LabArtifactRecord[]): boolean {
  const valid = artifacts
    .filter((artifact) => artifact.output.status === 'VALID')
    .slice(-3)
    .map((artifact) => artifact.output.attempts.find((attempt) => attempt.output)?.rawText.trim());
  return valid.length === 3 && valid[0] === valid[1] && valid[1] === valid[2];
}

function assertRunnerLimits(input: RunLabProtocolInput): void {
  const limits = input.limits;
  for (const [label, value] of Object.entries(limits)) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Discourse Lab ${label} must be a positive finite integer.`);
    }
  }
  if (limits.maximumCalls < input.plan.maximumCalls) {
    throw new Error('Runner call ceiling is lower than the preregistered condition plan.');
  }
  if (limits.maximumRounds < input.plan.maximumRounds) {
    throw new Error('Runner round ceiling is lower than the preregistered condition plan.');
  }
  if (input.modelConfiguration.seed !== undefined && !input.driver.capabilities.samplingSeed) {
    throw new Error('Selected lab driver cannot honor the recorded sampling seed.');
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await operation(values[index]!);
      }
    })
  );
  return results;
}

function failedDriverResult(
  input: RunLabProtocolInput,
  callKey: string,
  kind: NonNullable<LabTextCallResult['failure']>['kind'],
  message: string,
  providerAccounting: LabTextCallResult['providerAccounting'] = {
    sessionAttestation: 'NOT_PRESENT',
    threadStartStatus: 'NOT_STARTED',
    providerTurnStarted: 'NO',
    billableModelCall: 'NO'
  }
): LabTextCallResult {
  const now = new Date().toISOString();
  return {
    callKey,
    rawText: '',
    submittedAt: now,
    completedAt: now,
    requestedModel: input.modelConfiguration.model,
    requestedReasoningEffort: input.modelConfiguration.reasoningEffort,
    seed: input.modelConfiguration.seed ?? null,
    failure: { kind, message },
    providerAccounting,
    violations: [],
    lifecycle: [{ event: 'rejected-before-turn', at: now, detail: { message } }]
  };
}

function normalizeFixtureStatus(value: string): LabPublicOutput['status'] {
  return ['ANSWER', 'UNCERTAIN', 'ABSTAIN', 'NEEDS_USER_INPUT', 'MULTIPLE_DEFENSIBLE'].includes(value)
    ? (value as LabPublicOutput['status'])
    : 'UNCERTAIN';
}

function normalizeFixtureStance(value: string | undefined): LabPublicOutput['claims'][number]['stance'] {
  return ['ACCEPT', 'REJECT', 'OPEN', 'NOT_APPLICABLE'].includes(value ?? '')
    ? (value as LabPublicOutput['claims'][number]['stance'])
    : 'OPEN';
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 4);
}

function sumKnown(values: Array<number | undefined>): number | null {
  if (values.some((value) => value === undefined)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prefixWhile<T>(values: readonly T[], predicate: (value: T) => boolean): T[] {
  const prefix: T[] = [];
  for (const value of values) {
    if (!predicate(value)) break;
    prefix.push(value);
  }
  return prefix;
}
