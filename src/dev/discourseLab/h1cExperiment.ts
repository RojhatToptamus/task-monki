import {
  loadH1cOracleCorpus,
  loadH1cParticipantCorpus,
  type H1cConditionId,
  type H1cParticipantRecord
} from './h1cCorpus';
import {
  loadH1cH0ValidationReceipt
} from './h1cHarnessValidation';
import { assertH1cPlan, type H1cAssignment, type H1cPlan } from './h1cPlan';
import { buildH1cPrompt, type H1cPreparedPrompt } from './h1cPrompts';
import {
  H1C_PROBE_OUTPUT_SCHEMA_SHA256,
  loadH1cProbeReceipt,
  serializeH1cProbeFailure,
  type H1cProbeFailureDetail,
  type H1cProbeReceipt
} from './h1cProbe';
import {
  interpretH1c,
  scoreH1cOutput,
  type H1cInterpretation,
  type H1cOutputScore,
  type H1cScoredObservation
} from './h1cScoring';
import type { H1cValidationReport } from './h1cValidation';
import { attestSemanticLabDriver } from './driverEligibility';
import {
  stableJson,
  type LabArtifactLedger,
  type LabRunManifest
} from './ledger';
import {
  acceptedLabPublicOutputV4,
  createLabOutputRecordV4,
  LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA,
  LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  validateLabPublicOutputV4ContextDefinition,
  visibleIssueIdsFromLabContextV4,
  type LabOutputRecordV4,
  type LabPublicOutputV4
} from './outputV4';
import type {
  LabDriverSession,
  LabTextCallInput,
  LabTextCallResult,
  LabTextDriver,
  LabTokenUsage
} from './textDriver';

export const H1C_EXPERIMENT_SCHEMA_VERSION =
  'task-monki/discourse-lab-h1c-experiment@v3' as const;
export const H1C_EXPERIMENT_VERSION = 'h1c-live-yoked-development@v3' as const;

export type H1cExperimentStopReason =
  | 'HARD_CALL_CAP'
  | 'HARD_TOKEN_CAP_BETWEEN_BLOCKS'
  | 'HARD_CALL_TIME'
  | 'HARD_EXPERIMENT_TIME'
  | 'EMERGENCY_OUTPUT_FENCE'
  | 'BOUNDARY_VIOLATION'
  | 'MISSING_USAGE'
  | 'PROVIDER_FAILURES'
  | 'CONSECUTIVE_INVALID_OUTPUTS'
  | 'UNANSWERABLE_EXPERIMENT';

export interface H1cPreparedPromptRecord {
  assignment: H1cAssignment;
  prompt: string;
  context: H1cPreparedPrompt['context'];
  estimatedPromptTokens: number;
  promptArtifactSha256: string;
}

export interface H1cRunCounterState {
  retryableProviderInfrastructureFailure: boolean;
  schemaInvalidPrimary: boolean;
  provenanceFailure: boolean;
  validSemanticObservation: boolean;
  consecutiveProviderFailuresAfterAssignment: number;
  consecutiveSchemaFailuresAfterAssignment: number;
}

export interface H1cExperimentAssignmentRun {
  assignment: H1cAssignment;
  prompt: H1cPreparedPromptRecord;
  dispatched: boolean;
  threadStartRequested: boolean;
  requestedContinuation: LabDriverSession | null;
  callArtifactSha256: string;
  outputArtifactSha256: string;
  call: LabTextCallResult;
  outputRecord: LabOutputRecordV4;
  output: LabPublicOutputV4 | null;
  score: H1cOutputScore | null;
  latencyMs: number | null;
  stoppingReasons: H1cExperimentStopReason[];
  counterState: H1cRunCounterState;
}

export interface H1cExperimentAssignmentOutcome {
  assignment: H1cAssignment;
  disposition: 'SETTLED' | 'NOT_STARTED_DUE_TO_BLOCK_DEPENDENCY' |
    'NOT_STARTED_DUE_TO_EXPERIMENT_STOP';
  callArtifactSha256: string | null;
  promptArtifactSha256: string | null;
  outputStatus: LabOutputRecordV4['status'] | null;
  experimentStoppingReasons: H1cExperimentStopReason[];
}

export interface H1cExperimentBlockOutcome {
  blockId: string;
  assignmentIds: string[];
  settledAssignmentIds: string[];
  disposition: 'COMPLETE' | 'INCOMPLETE' | 'NOT_STARTED';
  primaryAnalysisEligible: boolean;
  exclusionReasons: string[];
}

export interface H1cExperimentAggregate {
  plannedAssignments: number;
  settledAssignments: number;
  unstartedAssignments: number;
  completeBlocks: number;
  incompleteBlocks: number;
  unstartedBlocks: number;
  dispatchedCalls: number;
  providerTurnsStarted: number;
  billableModelCalls: number;
  billableModelCallsUnknown: number;
  usageKnownCalls: number;
  usageUnknownCalls: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  knownInputTokens: number;
  knownCachedInputTokens: number;
  knownOutputTokens: number;
  knownReasoningTokens: number;
  knownTotalTokens: number;
  totalLatencyMs: number | null;
  knownLatencyMs: number;
  providerFailuresByKind: Record<string, number>;
  validationErrors: number;
  targetOutputOvershootCalls: number;
  targetOutputOvershootTokens: number;
  safetyOutputOvershootCalls: number;
  safetyOutputOvershootTokens: number;
  experimentStopsByReason: Partial<Record<H1cExperimentStopReason, number>>;
}

export interface H1cExperimentDriverClose {
  status: 'CLEAN' | 'FAILED' | 'TIMED_OUT';
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  maximumMs: number;
  failure?: H1cProbeFailureDetail;
}

export interface H1cExperimentResult {
  schemaVersion: typeof H1C_EXPERIMENT_SCHEMA_VERSION;
  experimentVersion: typeof H1C_EXPERIMENT_VERSION;
  hypothesisId: 'H1c';
  partition: 'DEVELOPMENT';
  confirmationOpened: false;
  status: 'COMPLETED' | 'STOPPED';
  startedAt: string;
  completedAt: string;
  stopReason?: H1cExperimentStopReason;
  stoppingReasons: H1cExperimentStopReason[];
  executionEligibility: {
    planArtifactSha256: string;
    h0ValidationRunId: string;
    h0ValidationManifestSha256: string;
    h0ValidationReportSha256: string;
    probeRunId: string;
    probeManifestSha256: string;
    probeReportSha256: string;
    probePublicOutputSchemaSha256: string;
    driverAttestationArtifactSha256: string;
    driverCloseArtifactSha256: string;
    boundaryClass: LabRunManifest['driver']['boundaryClass'];
    componentLocks: H1cPlan['locks'];
  };
  plan: H1cPlan;
  preparedPrompts: H1cPreparedPromptRecord[];
  runs: H1cExperimentAssignmentRun[];
  assignmentOutcomes: H1cExperimentAssignmentOutcome[];
  blockOutcomes: H1cExperimentBlockOutcome[];
  exclusions: Array<{
    scope: 'ASSIGNMENT' | 'BLOCK';
    assignmentId?: string;
    blockId: string;
    reasons: string[];
  }>;
  scoringStatus: 'SCORED' | 'UNAVAILABLE';
  scoringFailure?: string;
  driverClose: H1cExperimentDriverClose;
  interpretationStatus:
    | 'AUDITABLE_DEVELOPMENT_RESULT'
    | 'INVALIDATED_BY_BOUNDARY_OR_CLOSE'
    | 'UNAVAILABLE_SCORING';
  interpretation: H1cExperimentInterpretation;
  aggregate: H1cExperimentAggregate;
}

export type H1cExperimentInterpretation =
  | H1cInterpretation
  | (Omit<H1cInterpretation, 'overall'> & { overall: 'INVALIDATED' });

interface ParticipantRunRecord extends Omit<H1cExperimentAssignmentRun, 'score'> {
  score: null;
}

interface H1cCallAssessment {
  immediateReasons: H1cExperimentStopReason[];
  retryableProviderInfrastructureFailure: boolean;
  schemaInvalidPrimary: boolean;
  provenanceFailure: boolean;
  validSemanticObservation: boolean;
}

interface H1cExecutedCall {
  call: LabTextCallResult;
  dispatched: boolean;
}

interface H1cExperimentInput {
  fixtureRoot: string;
  validation: H1cValidationReport;
  plan: H1cPlan;
  driver: LabTextDriver;
  ledger: LabArtifactLedger;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  probeReceipt: H1cProbeReceipt;
}

export function buildH1cExperimentManifest(input: {
  runId: string;
  validation: H1cValidationReport;
  plan: H1cPlan;
  driver: LabTextDriver;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  probeReceipt: H1cProbeReceipt;
  createdAt?: string;
}): LabRunManifest {
  assertExactModelConfiguration(input);
  assertEligibleValidation(input.validation, input.plan);
  assertH1cProbe(input.probeReceipt, input.validation, input.plan, input.driver.id);
  const boundaryClass = boundaryClassFor(input.driver);
  return {
    schemaVersion: 'task-monki/discourse-lab-ledger@v5',
    runId: input.runId,
    phase: 'DEVELOPMENT',
    status: 'PLANNED',
    createdAt: input.createdAt ?? new Date().toISOString(),
    driver: manifestDriver(input, boundaryClass),
    locks: structuredClone(input.validation.locks),
    caseIds: unique(input.plan.assignments.map((assignment) => assignment.caseId)),
    conditionIds: unique(input.plan.assignments.map((assignment) => assignment.conditionId)),
    budgets: manifestBudget(input.plan),
    providerUsageExplicitlyAuthorized: true
  };
}

export async function runH1cExperiment(
  input: H1cExperimentInput
): Promise<H1cExperimentResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const deadlineMs = startedMs + input.plan.budget.maximumExperimentMs;
  assertExactModelConfiguration(input);
  assertEligibleValidation(input.validation, input.plan);

  const participants = await withinSetupDeadline(
    loadH1cParticipantCorpus(input.fixtureRoot),
    deadlineMs,
    'participant corpus loading'
  );
  assertH1cPlan(input.plan, participants.records, input.validation.locks);

  const verifiedH0 = await withinSetupDeadline(
    loadH1cH0ValidationReceipt(
      input.ledger.rootDirectory,
      input.plan.h0Validation.runId,
      input.validation.locks
    ),
    deadlineMs,
    'H0 receipt verification'
  );
  if (stableJson(verifiedH0) !== stableJson(input.plan.h0Validation)) {
    throw new Error('H1c plan lock failed: h0ValidationReceipt.');
  }

  const verifiedProbe = await withinSetupDeadline(
    loadH1cProbeReceipt(
      input.ledger.rootDirectory,
      input.probeReceipt.runId,
      input.validation.locks
    ),
    deadlineMs,
    'public-output-v4 probe receipt verification'
  );
  if (stableJson(verifiedProbe) !== stableJson(input.probeReceipt)) {
    throw new Error('H1c public-output-v4 probe receipt changed after caller verification.');
  }
  assertH1cProbe(verifiedProbe, input.validation, input.plan, input.driver.id);

  const boundaryClass = boundaryClassFor(input.driver);
  const runManifestDriver = manifestDriver(input, boundaryClass);
  input.ledger.assertSemanticRunContext({
    phase: 'DEVELOPMENT',
    locks: input.validation.locks,
    driver: runManifestDriver,
    caseIds: unique(input.plan.assignments.map((assignment) => assignment.caseId)),
    conditionIds: unique(input.plan.assignments.map((assignment) => assignment.conditionId)),
    budgets: manifestBudget(input.plan)
  });

  const planArtifact = await withinSetupDeadline(
    input.ledger.putArtifact({ kind: 'H1C_EXPERIMENT_PLAN', plan: input.plan }),
    deadlineMs,
    'plan persistence'
  );
  const h0Artifact = await withinSetupDeadline(
    input.ledger.putArtifact(verifiedH0.report),
    deadlineMs,
    'H0 evidence persistence'
  );
  if (h0Artifact.sha256 !== verifiedH0.reportSha256) {
    throw new Error('H1c plan lock failed: h0ValidationArtifact.');
  }

  const preflight = await attestSemanticLabDriver(input.driver, {
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier
  }, {
    maximumCallMs: input.plan.budget.maximumCallMs,
    experimentDeadlineMs: deadlineMs
  }, boundaryClass === 'PROVIDER_ENFORCED_STRICT'
    ? 'PROVIDER_ENFORCED'
    : 'H1_DEVELOPMENT_HARNESS_VERIFIED');
  const preflightArtifact = await withinSetupDeadline(
    input.ledger.putArtifact({ kind: 'H1C_SEMANTIC_DRIVER_ATTESTATION', preflight }),
    deadlineMs,
    'driver attestation persistence'
  );

  await withinSetupDeadline(input.ledger.append({
    eventType: 'H1C_EXPERIMENT_STARTED',
    occurredAt: startedAt,
    artifactSha256: planArtifact.sha256,
    detail: {
      assignments: input.plan.assignments.length,
      blocks: input.plan.schedule.blockIds.length,
      h0ValidationRunId: verifiedH0.runId,
      probeRunId: verifiedProbe.runId,
      driverAttestationArtifactSha256: preflightArtifact.sha256
    }
  }), deadlineMs, 'experiment start persistence');

  const byCase = new Map(participants.records.map((record) => [record.caseId, record]));
  const participantRuns: ParticipantRunRecord[] = [];
  const preparedPrompts: H1cPreparedPromptRecord[] = [];
  const dependencySkipped = new Set<string>();
  const freshThreadOwners = new Map<string, string>();
  const providerTurnOwners = new Map<string, string>();
  let dispatchedCalls = 0;
  let observedTotalTokens = 0;
  let consecutiveProviderFailures = 0;
  let consecutiveSchemaFailures = 0;
  let status: H1cExperimentResult['status'] = 'COMPLETED';
  let stopReason: H1cExperimentStopReason | undefined;
  const experimentStoppingReasons: H1cExperimentStopReason[] = [];

  blockLoop: for (const blockId of input.plan.schedule.blockIds) {
    const assignments = assignmentsForBlock(input.plan, blockId);
    const record = byCase.get(assignments[0]!.caseId);
    if (!record) throw new Error(`H1c cannot resolve participant case ${assignments[0]!.caseId}.`);
    if (Date.now() >= deadlineMs) {
      ({ status, stopReason } = stopped('HARD_EXPERIMENT_TIME'));
      experimentStoppingReasons.push('HARD_EXPERIMENT_TIME');
      break;
    }

    let initialOutput: LabPublicOutputV4 | null = null;
    let initialSession: LabDriverSession | null = null;
    for (const assignment of assignments) {
      if (assignment.conditionId !== 'STRONG_INITIAL' && !initialOutput) {
        dependencySkipped.add(assignment.assignmentId);
        continue;
      }
      if (dispatchedCalls >= input.plan.budget.maximumCalls) {
        ({ status, stopReason } = stopped('HARD_CALL_CAP'));
        experimentStoppingReasons.push('HARD_CALL_CAP');
        break blockLoop;
      }
      if (Date.now() >= deadlineMs) {
        ({ status, stopReason } = stopped('HARD_EXPERIMENT_TIME'));
        experimentStoppingReasons.push('HARD_EXPERIMENT_TIME');
        break blockLoop;
      }

      const prepared = await preparePrompt(
        input,
        assignment,
        record,
        initialOutput ?? undefined,
        deadlineMs
      );
      preparedPrompts.push(prepared);
      if (
        prepared.estimatedPromptTokens >
        input.plan.budget.maximumPreparedPromptEstimateTokensPerCall
      ) {
        ({ status, stopReason } = stopped('UNANSWERABLE_EXPERIMENT'));
        experimentStoppingReasons.push('UNANSWERABLE_EXPERIMENT');
        break blockLoop;
      }

      const continuation = assignment.threadMode === 'CONTINUE_INITIAL'
        ? initialSession ?? undefined
        : undefined;
      if (assignment.threadMode === 'CONTINUE_INITIAL' && !continuation) {
        ({ status, stopReason } = stopped('UNANSWERABLE_EXPERIMENT'));
        experimentStoppingReasons.push('UNANSWERABLE_EXPERIMENT');
        break blockLoop;
      }

      await input.ledger.append({
        eventType: 'H1C_CALL_SUBMITTED',
        occurredAt: new Date().toISOString(),
        caseId: assignment.caseId,
        conditionId: assignment.conditionId,
        callId: assignment.assignmentId,
        artifactSha256: prepared.promptArtifactSha256,
        detail: {
          blockId,
          serialPosition: assignment.serialPosition,
          threadMode: assignment.threadMode
        }
      });
      const executed = await executeCall(
        input,
        assignment,
        prepared,
        continuation,
        deadlineMs
      );
      const { call } = executed;
      if (executed.dispatched) dispatchedCalls += 1;
      // Persist the provider boundary verbatim before any parser or contextual
      // validator runs, so an instrumentation defect cannot erase raw evidence.
      const callArtifact = await input.ledger.putArtifact({
        kind: 'H1C_RAW_CALL',
        assignment,
        promptArtifactSha256: prepared.promptArtifactSha256,
        dispatched: executed.dispatched,
        threadStartRequested: executed.dispatched && !continuation,
        requestedContinuation: continuation ?? null,
        call,
        latencyMs: callLatencyMs(call)
      });
      let parserFailure = false;
      let outputRecord: LabOutputRecordV4;
      try {
        outputRecord = createLabOutputRecordV4({
          callId: call.providerTurnId ?? call.callKey,
          rawText: call.rawText
        }, undefined, prepared.context);
      } catch (error) {
        parserFailure = true;
        outputRecord = parserFailureRecord(call, error);
      }
      const accepted = acceptedLabPublicOutputV4(outputRecord) ?? null;
      const output = call.failure ? null : accepted;
      const outputArtifact = await input.ledger.putArtifact({
        kind: 'H1C_PARSED_OUTPUT',
        assignment,
        rawCallArtifactSha256: callArtifact.sha256,
        promptArtifactSha256: prepared.promptArtifactSha256,
        outputRecord
      });

      const usage = completeCallUsage(call);
      if (usage) observedTotalTokens += usage.totalTokens;
      const assessment = assessCall({
        assignment,
        call,
        outputRecord,
        output,
        parserFailure,
        requestedContinuation: continuation,
        driver: input.driver,
        model: input.model,
        modelProvider: expectedModelProvider(verifiedProbe),
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        targetOutputTokens: input.plan.budget.targetOutputTokensPerCall,
        safetyOutputTokens:
          input.plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
        maximumCallMs: input.plan.budget.maximumCallMs,
        deadlineMs,
        freshThreadOwners,
        providerTurnOwners
      });
      if (assessment.retryableProviderInfrastructureFailure) {
        consecutiveProviderFailures += 1;
      } else {
        consecutiveProviderFailures = 0;
      }
      if (assessment.schemaInvalidPrimary) {
        consecutiveSchemaFailures += 1;
      } else {
        consecutiveSchemaFailures = 0;
      }
      const stoppingReasons = [...assessment.immediateReasons];
      if (consecutiveProviderFailures >= 2) stoppingReasons.push('PROVIDER_FAILURES');
      if (consecutiveSchemaFailures >= 2) {
        stoppingReasons.push('CONSECUTIVE_INVALID_OUTPUTS');
      }
      const counterState: H1cRunCounterState = {
        retryableProviderInfrastructureFailure:
          assessment.retryableProviderInfrastructureFailure,
        schemaInvalidPrimary: assessment.schemaInvalidPrimary,
        provenanceFailure: assessment.provenanceFailure,
        validSemanticObservation: assessment.validSemanticObservation,
        consecutiveProviderFailuresAfterAssignment: consecutiveProviderFailures,
        consecutiveSchemaFailuresAfterAssignment: consecutiveSchemaFailures
      };
      participantRuns.push({
        assignment: structuredClone(assignment),
        prompt: prepared,
        dispatched: executed.dispatched,
        threadStartRequested: executed.dispatched && !continuation,
        requestedContinuation: continuation ? structuredClone(continuation) : null,
        callArtifactSha256: callArtifact.sha256,
        outputArtifactSha256: outputArtifact.sha256,
        call,
        outputRecord,
        output,
        score: null,
        latencyMs: callLatencyMs(call),
        stoppingReasons: unique(stoppingReasons),
        counterState
      });
      await input.ledger.append({
        eventType: call.failure ? 'H1C_CALL_FAILED' : 'H1C_CALL_COMPLETED',
        occurredAt: call.completedAt,
        caseId: assignment.caseId,
        conditionId: assignment.conditionId,
        callId: assignment.assignmentId,
        artifactSha256: outputArtifact.sha256,
        detail: {
          blockId,
          rawCallArtifactSha256: callArtifact.sha256,
          outputStatus: outputRecord.status,
          stoppingReasons: unique(stoppingReasons),
          observedTotalTokens
        }
      });

      if (assignment.conditionId === 'STRONG_INITIAL') {
        initialOutput = output;
        initialSession = cleanStartedSession(call, input.driver.id) ? call.session! : null;
      }
      if (stoppingReasons.length > 0) {
        status = 'STOPPED';
        stopReason = stoppingReasons[0];
        experimentStoppingReasons.push(...stoppingReasons);
        break blockLoop;
      }
    }

    // Accounting is retrospective and checked only at a block boundary. The
    // threshold-crossing block and every overshoot remain in the report.
    if (observedTotalTokens >= input.plan.budget.maximumObservedTotalTokens) {
      ({ status, stopReason } = stopped('HARD_TOKEN_CAP_BETWEEN_BLOCKS'));
      experimentStoppingReasons.push('HARD_TOKEN_CAP_BETWEEN_BLOCKS');
      break;
    }
  }

  // Close the provider boundary before opening scorer-only truth. This also
  // catches late MCP/tool/compaction evidence that can arrive after a turn's
  // terminal notification. A failed or unconfirmed close invalidates causal
  // interpretation and the oracle remains unopened.
  const driverClose = await closeExperimentDriver(input.driver, 30_000);
  const driverCloseArtifact = await input.ledger.putArtifact({
    kind: 'H1C_DRIVER_CLOSE',
    close: driverClose
  });
  await input.ledger.append({
    eventType: driverClose.status === 'CLEAN'
      ? 'H1C_DRIVER_CLOSED'
      : 'H1C_DRIVER_CLOSE_FAILED',
    occurredAt: driverClose.completedAt,
    artifactSha256: driverCloseArtifact.sha256,
    detail: {
      status: driverClose.status,
      elapsedMs: driverClose.elapsedMs,
      ...(driverClose.failure ? { failure: driverClose.failure } : {})
    }
  });
  if (driverClose.status !== 'CLEAN') {
    status = 'STOPPED';
    stopReason ??= 'BOUNDARY_VIOLATION';
    experimentStoppingReasons.push('BOUNDARY_VIOLATION');
  }

  // No scorer/oracle object exists in the participant phase. Scorer-only truth
  // is opened only after the dispatch loop is irrevocably closed on every path.
  let scoringStatus: H1cExperimentResult['scoringStatus'] = 'SCORED';
  let scoringFailure: string | undefined;
  let runs: H1cExperimentAssignmentRun[];
  let observations: H1cScoredObservation[] = [];
  try {
    if (driverClose.status !== 'CLEAN') {
      throw new Error(
        `H1c scorer truth remained closed because driver close was ${driverClose.status}.`
      );
    }
    const oracles = await loadH1cOracleCorpus(input.fixtureRoot, participants);
    const oracleByCase = new Map(oracles.records.map((oracle) => [oracle.caseId, oracle]));
    runs = participantRuns.map((item) => {
      const oracle = oracleByCase.get(item.assignment.caseId);
      if (!oracle) throw new Error(`H1c scorer cannot resolve ${item.assignment.caseId}.`);
      const score = scoreH1cOutput({
        conditionId: item.assignment.conditionId,
        oracle,
        output: item.output,
        draftOutput: initialOutputForBlock(participantRuns, item.assignment.blockId),
        visibleIssueIds: visibleIssueIdsFromLabContextV4(item.prompt.context)
      });
      observations.push({
        blockId: item.assignment.blockId,
        caseId: item.assignment.caseId,
        repetition: item.assignment.repetition,
        conditionId: item.assignment.conditionId,
        score,
        output: item.output,
        draftOutput: initialOutputForBlock(participantRuns, item.assignment.blockId),
        measurementStatus: measurementStatusForRun(item)
      });
      return { ...item, score };
    });
  } catch (error) {
    scoringStatus = 'UNAVAILABLE';
    scoringFailure = errorMessage(error);
    observations = [];
    runs = participantRuns.map((item) => ({ ...item, score: null }));
    status = 'STOPPED';
    stopReason ??= 'UNANSWERABLE_EXPERIMENT';
    experimentStoppingReasons.push('UNANSWERABLE_EXPERIMENT');
  }

  const outcomes = assignmentOutcomes(
    input.plan,
    preparedPrompts,
    runs,
    dependencySkipped,
    stopReason
  );
  const blocks = blockOutcomes(input.plan, runs);
  const exclusions = exclusionsFor(blocks, runs);
  const completedAt = new Date().toISOString();
  const interpretationStatus: H1cExperimentResult['interpretationStatus'] =
    driverClose.status !== 'CLEAN' ||
      experimentStoppingReasons.includes('BOUNDARY_VIOLATION')
      ? 'INVALIDATED_BY_BOUNDARY_OR_CLOSE'
      : scoringStatus === 'UNAVAILABLE'
        ? 'UNAVAILABLE_SCORING'
        : 'AUDITABLE_DEVELOPMENT_RESULT';
  const interpretation = experimentInterpretation(
    interpretationStatus,
    observations
  );
  const result: H1cExperimentResult = {
    schemaVersion: H1C_EXPERIMENT_SCHEMA_VERSION,
    experimentVersion: H1C_EXPERIMENT_VERSION,
    hypothesisId: 'H1c',
    partition: 'DEVELOPMENT',
    confirmationOpened: false,
    status,
    startedAt,
    completedAt,
    ...(stopReason ? { stopReason } : {}),
    stoppingReasons: unique(experimentStoppingReasons),
    executionEligibility: {
      planArtifactSha256: planArtifact.sha256,
      h0ValidationRunId: verifiedH0.runId,
      h0ValidationManifestSha256: verifiedH0.manifestSha256,
      h0ValidationReportSha256: verifiedH0.reportSha256,
      probeRunId: verifiedProbe.runId,
      probeManifestSha256: verifiedProbe.manifestSha256,
      probeReportSha256: verifiedProbe.reportSha256,
      probePublicOutputSchemaSha256: verifiedProbe.publicOutputSchemaSha256,
      driverAttestationArtifactSha256: preflightArtifact.sha256,
      driverCloseArtifactSha256: driverCloseArtifact.sha256,
      boundaryClass,
      componentLocks: structuredClone(input.validation.locks)
    },
    plan: structuredClone(input.plan),
    preparedPrompts,
    runs,
    assignmentOutcomes: outcomes,
    blockOutcomes: blocks,
    exclusions,
    scoringStatus,
    ...(scoringFailure ? { scoringFailure } : {}),
    driverClose,
    interpretationStatus,
    interpretation,
    aggregate: aggregateResult(runs, outcomes, blocks)
  };
  await input.ledger.writeReport('h1c-development-result', result);
  await input.ledger.append({
    eventType: status === 'COMPLETED' ? 'H1C_EXPERIMENT_COMPLETED' : 'H1C_EXPERIMENT_STOPPED',
    occurredAt: completedAt,
    detail: {
      settledAssignments: runs.length,
      completeBlocks: blocks.filter((block) => block.disposition === 'COMPLETE').length,
      observedTotalTokens,
      scoringStatus,
      ...(stopReason ? { stopReason } : {})
    }
  });
  return result;
}

function experimentInterpretation(
  status: H1cExperimentResult['interpretationStatus'],
  observations: readonly H1cScoredObservation[]
): H1cExperimentInterpretation {
  if (status === 'AUDITABLE_DEVELOPMENT_RESULT') {
    return interpretH1c(observations);
  }
  return {
    ...interpretH1c([]),
    overall: 'INVALIDATED'
  };
}

async function preparePrompt(
  input: H1cExperimentInput,
  assignment: H1cAssignment,
  record: H1cParticipantRecord,
  draft: LabPublicOutputV4 | undefined,
  deadlineMs: number
): Promise<H1cPreparedPromptRecord> {
  const prepared = buildH1cPrompt({
    record,
    conditionId: assignment.conditionId,
    ...(draft ? { draft } : {})
  });
  const contextErrors = validateLabPublicOutputV4ContextDefinition(prepared.context);
  if (contextErrors.length > 0) {
    throw new Error(
      `H1c prompt context is not measurable for ${assignment.assignmentId}: ` +
      contextErrors.map((error) => `${error.ruleId}:${error.message}`).join('; ')
    );
  }
  const estimatedPromptTokens = estimateTokens(prepared.prompt);
  const artifact = await withinSetupDeadline(input.ledger.putArtifact({
    kind: 'H1C_PARTICIPANT_PROMPT',
    assignment,
    prompt: prepared.prompt,
    context: prepared.context,
    estimatedPromptTokens
  }), deadlineMs, `prompt persistence for ${assignment.assignmentId}`);
  return {
    assignment: structuredClone(assignment),
    prompt: prepared.prompt,
    context: structuredClone(prepared.context),
    estimatedPromptTokens,
    promptArtifactSha256: artifact.sha256
  };
}

async function executeCall(
  input: H1cExperimentInput,
  assignment: H1cAssignment,
  prepared: H1cPreparedPromptRecord,
  continuation: LabDriverSession | undefined,
  deadlineMs: number
): Promise<H1cExecutedCall> {
  const callInput: LabTextCallInput = {
    callKey: assignment.assignmentId,
    prompt: prepared.prompt,
    outputSchema: LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA as Record<string, unknown>,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    ...(continuation ? { continuation } : {}),
    maximumOutputTokens: input.plan.budget.targetOutputTokensPerCall,
    outputTokenSafetyCeiling:
      input.plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
    maximumCallMs: input.plan.budget.maximumCallMs,
    experimentDeadlineMs: deadlineMs
  };
  const startedMs = Date.now();
  const remainingMs = Math.min(
    input.plan.budget.maximumCallMs,
    Math.max(0, deadlineMs - startedMs)
  );
  if (remainingMs <= 0) {
    return {
      call: failedCall(input, assignment.assignmentId, 'TIMEOUT',
        'H1c call reached the experiment deadline before dispatch.', false, continuation),
      dispatched: false
    };
  }
  try {
    // The freshly attested driver owns hard call cancellation and returns its
    // partial raw text, usage, interrupt acknowledgement, and lifecycle. An
    // outer race would abandon that evidence exactly when it matters most.
    return { call: await input.driver.call(callInput), dispatched: true };
  } catch (error) {
    return {
      call: failedCall(
        input,
        assignment.assignmentId,
        'PROVIDER_ERROR',
        `Driver threw after dispatch: ${errorMessage(error)}`,
        true,
        continuation
      ),
      dispatched: true
    };
  }
}

function assessCall(input: {
  assignment: H1cAssignment;
  call: LabTextCallResult;
  outputRecord: LabOutputRecordV4;
  output: LabPublicOutputV4 | null;
  parserFailure: boolean;
  requestedContinuation: LabDriverSession | undefined;
  driver: LabTextDriver;
  model: string;
  modelProvider: string;
  reasoningEffort?: string;
  serviceTier?: string;
  targetOutputTokens: number;
  safetyOutputTokens: number;
  maximumCallMs: number;
  deadlineMs: number;
  freshThreadOwners: Map<string, string>;
  providerTurnOwners: Map<string, string>;
}): H1cCallAssessment {
  const reasons: H1cExperimentStopReason[] = [];
  const failure = input.call.failure;
  const failureKind = failure?.kind;
  const providerTurnStarted = input.call.providerAccounting.providerTurnStarted === 'YES';
  const fresh = input.assignment.threadMode === 'FRESH';
  const cleanFreshFailureWithoutThread = fresh &&
    input.call.providerAccounting.threadStartStatus === 'NOT_STARTED' &&
    input.call.providerAccounting.sessionAttestation === 'NOT_PRESENT' &&
    !input.call.session;
  const cleanFreshFailureWithAttestedThread = fresh &&
    input.call.providerAccounting.threadStartStatus === 'ATTESTED' &&
    input.call.providerAccounting.sessionAttestation === 'ATTESTED' &&
    input.call.session?.driverId === input.driver.id;
  const cleanContinuationFailure = !fresh &&
    input.call.providerAccounting.threadStartStatus === 'NOT_REQUIRED' &&
    input.call.providerAccounting.sessionAttestation === 'ATTESTED' &&
    sameSession(input.call.session, input.requestedContinuation);
  const cleanPreTurnProviderFailure =
    failureKind === 'PROVIDER_ERROR' &&
    input.call.providerAccounting.providerTurnStarted === 'NO' &&
    !input.call.providerTurnId &&
    (cleanFreshFailureWithoutThread ||
      cleanFreshFailureWithAttestedThread ||
      cleanContinuationFailure);
  let topologyValid = cleanPreTurnProviderFailure;

  if (
    cleanPreTurnProviderFailure &&
    cleanFreshFailureWithAttestedThread &&
    input.call.session
  ) {
    const threadId = input.call.session.providerThreadId;
    if (input.freshThreadOwners.has(threadId)) topologyValid = false;
    else input.freshThreadOwners.set(threadId, input.assignment.assignmentId);
  }

  if (providerTurnStarted) {
    topologyValid = Boolean(
      input.call.session &&
      input.call.providerTurnId &&
      input.call.providerAccounting.sessionAttestation === 'ATTESTED' &&
      input.call.session.driverId === input.driver.id
    );
    if (fresh) {
      topologyValid = topologyValid &&
        input.call.providerAccounting.threadStartStatus === 'ATTESTED' &&
        !input.requestedContinuation;
      const threadId = input.call.session?.providerThreadId;
      if (topologyValid && threadId) {
        if (input.freshThreadOwners.has(threadId)) topologyValid = false;
        else input.freshThreadOwners.set(threadId, input.assignment.assignmentId);
      }
    } else {
      topologyValid = topologyValid &&
        input.call.providerAccounting.threadStartStatus === 'NOT_REQUIRED' &&
        sameSession(input.call.session, input.requestedContinuation);
    }
    const turnId = input.call.providerTurnId;
    if (!turnId || input.providerTurnOwners.has(turnId)) {
      topologyValid = false;
    } else {
      input.providerTurnOwners.set(turnId, input.assignment.assignmentId);
    }
  }
  if (!topologyValid) reasons.push('BOUNDARY_VIOLATION');
  if (!cleanPreTurnProviderFailure && !cleanStartedLifecycle(input.call)) {
    reasons.push('PROVIDER_FAILURES');
  }

  if (!exactCallSettings(input.call, input, providerTurnStarted)) {
    reasons.push('BOUNDARY_VIOLATION');
  }
  if (
    input.call.callKey !== input.assignment.assignmentId ||
    input.call.violations.length > 0 ||
    failureKind === 'SETTINGS_MISMATCH' ||
    failureKind === 'MODEL_REROUTED' ||
    failureKind === 'TOOL_CONTEXT_VIOLATION'
  ) reasons.push('BOUNDARY_VIOLATION');
  if (
    failureKind === 'AMBIGUOUS_DELIVERY' ||
    failureKind === 'INTERRUPT_UNCONFIRMED'
  ) reasons.push('PROVIDER_FAILURES');
  if (failureKind === 'TIMEOUT' || exceedsCallTime(input.call, input.maximumCallMs)) {
    reasons.push('HARD_CALL_TIME');
  }
  if (Date.now() >= input.deadlineMs) reasons.push('HARD_EXPERIMENT_TIME');
  if (failureKind === 'TOKEN_LIMIT_EXCEEDED') reasons.push('EMERGENCY_OUTPUT_FENCE');
  if (providerTurnStarted && !completeCallUsage(input.call)) reasons.push('MISSING_USAGE');
  if (providerTurnStarted && !exactTokenControl(input.call, input)) {
    reasons.push('BOUNDARY_VIOLATION');
  }
  if ((input.call.tokenControl?.safetyOvershootTokens ?? 0) > 0) {
    reasons.push('EMERGENCY_OUTPUT_FENCE');
  }
  if (input.parserFailure) reasons.push('UNANSWERABLE_EXPERIMENT');

  const provenanceFailure = input.outputRecord.status === 'INVALID' &&
    hasTypedProvenanceFailure(input.outputRecord);
  if (hasMeasurementUnavailableFailure(input.outputRecord)) {
    reasons.push('UNANSWERABLE_EXPERIMENT');
  }
  const validSemanticObservation = !failure &&
    input.outputRecord.status === 'VALID' &&
    Boolean(input.output);
  const schemaInvalidPrimary = !failure && input.outputRecord.status === 'INVALID';
  const retryableProviderInfrastructureFailure = failureKind === 'PROVIDER_ERROR' &&
    topologyValid &&
    reasons.length === 0;
  if (
    failure &&
    !retryableProviderInfrastructureFailure &&
    reasons.length === 0
  ) reasons.push('PROVIDER_FAILURES');
  return {
    immediateReasons: unique(reasons),
    retryableProviderInfrastructureFailure,
    schemaInvalidPrimary,
    provenanceFailure,
    validSemanticObservation
  };
}

function assignmentsForBlock(plan: H1cPlan, blockId: string): H1cAssignment[] {
  const assignments = plan.assignments
    .filter((assignment) => assignment.blockId === blockId)
    .sort((left, right) => left.serialPosition - right.serialPosition);
  const expectedCount = assignments[0]?.stratum === 'DERIVABLE_CRITIQUE' ? 4 : 3;
  if (
    assignments.length !== expectedCount ||
    assignments[0]?.conditionId !== 'STRONG_INITIAL' ||
    assignments.some((assignment, index) => assignment.serialPosition !== index + 1) ||
    plan.budget.maximumRoundsPerBlock !== 2 ||
    assignments.slice(1).some((assignment) => assignment.conditionId === 'STRONG_INITIAL')
  ) {
    throw new Error(`H1c block ${blockId} violates its sealed two-round topology.`);
  }
  return assignments;
}

function assignmentOutcomes(
  plan: H1cPlan,
  prepared: readonly H1cPreparedPromptRecord[],
  runs: readonly H1cExperimentAssignmentRun[],
  dependencySkipped: ReadonlySet<string>,
  stopReason: H1cExperimentStopReason | undefined
): H1cExperimentAssignmentOutcome[] {
  const preparedById = new Map(prepared.map((item) => [item.assignment.assignmentId, item]));
  const runById = new Map(runs.map((item) => [item.assignment.assignmentId, item]));
  return plan.schedule.assignmentIds.map((assignmentId) => {
    const assignment = plan.assignments.find((item) => item.assignmentId === assignmentId)!;
    const prompt = preparedById.get(assignmentId);
    const run = runById.get(assignmentId);
    return {
      assignment: structuredClone(assignment),
      disposition: run
        ? 'SETTLED' as const
        : dependencySkipped.has(assignmentId)
          ? 'NOT_STARTED_DUE_TO_BLOCK_DEPENDENCY' as const
          : 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP' as const,
      callArtifactSha256: run?.callArtifactSha256 ?? null,
      promptArtifactSha256: prompt?.promptArtifactSha256 ?? null,
      outputStatus: run?.outputRecord.status ?? null,
      experimentStoppingReasons: run
        ? [...run.stoppingReasons]
        : stopReason && !dependencySkipped.has(assignmentId)
          ? [stopReason]
          : []
    };
  });
}

function blockOutcomes(
  plan: H1cPlan,
  runs: readonly H1cExperimentAssignmentRun[]
): H1cExperimentBlockOutcome[] {
  const runById = new Map(runs.map((item) => [item.assignment.assignmentId, item]));
  return plan.schedule.blockIds.map((blockId) => {
    const assignments = assignmentsForBlock(plan, blockId);
    const settled = assignments.filter((assignment) => runById.has(assignment.assignmentId));
    const invalid = settled.filter((assignment) =>
      !runById.get(assignment.assignmentId)!.counterState.validSemanticObservation
    );
    const disposition = settled.length === 0
      ? 'NOT_STARTED' as const
      : settled.length === assignments.length
        ? 'COMPLETE' as const
        : 'INCOMPLETE' as const;
    const exclusionReasons = [
      disposition !== 'COMPLETE' ? `BLOCK_${disposition}` : null,
      invalid.length > 0
        ? `INVALID_SEMANTIC_ASSIGNMENTS:${invalid.map((item) => item.assignmentId).join(',')}`
        : null
    ].filter((value): value is string => Boolean(value));
    return {
      blockId,
      assignmentIds: assignments.map((assignment) => assignment.assignmentId),
      settledAssignmentIds: settled.map((assignment) => assignment.assignmentId),
      disposition,
      primaryAnalysisEligible: exclusionReasons.length === 0,
      exclusionReasons
    };
  });
}

function exclusionsFor(
  blocks: readonly H1cExperimentBlockOutcome[],
  runs: readonly H1cExperimentAssignmentRun[]
): H1cExperimentResult['exclusions'] {
  const blockExclusions = blocks.flatMap((block) => block.exclusionReasons.length > 0
    ? [{ scope: 'BLOCK' as const, blockId: block.blockId, reasons: [...block.exclusionReasons] }]
    : []);
  const assignmentExclusions = runs.flatMap((item) => {
    const reasons = [
      !item.counterState.validSemanticObservation ? 'INVALID_SEMANTIC_OBSERVATION' : null,
      ...item.stoppingReasons
    ].filter((value): value is string => Boolean(value));
    return reasons.length > 0 ? [{
      scope: 'ASSIGNMENT' as const,
      assignmentId: item.assignment.assignmentId,
      blockId: item.assignment.blockId,
      reasons: unique(reasons)
    }] : [];
  });
  return [...blockExclusions, ...assignmentExclusions];
}

function aggregateResult(
  runs: readonly H1cExperimentAssignmentRun[],
  outcomes: readonly H1cExperimentAssignmentOutcome[],
  blocks: readonly H1cExperimentBlockOutcome[]
): H1cExperimentAggregate {
  const calls = runs.map((item) => item.call);
  const knownUsage = calls.flatMap((call) => {
    const usage = completeCallUsage(call);
    return usage ? [usage] : [];
  });
  const fullyKnown = knownUsage.length === calls.length;
  const latencies = runs.map((item) => item.latencyMs);
  const allLatencyKnown = latencies.every((value) => value !== null);
  const failureKinds = countStrings(calls.flatMap((call) => call.failure ? [call.failure.kind] : []));
  const stops = countStrings(runs.flatMap((item) => item.stoppingReasons));
  const targetOvershoots = calls.map((call) => call.tokenControl?.targetOvershootTokens ?? 0);
  const safetyOvershoots = calls.map((call) => call.tokenControl?.safetyOvershootTokens ?? 0);
  const sumUsage = (key: keyof LabTokenUsage) =>
    knownUsage.reduce((sum, usage) => sum + usage[key], 0);
  return {
    plannedAssignments: outcomes.length,
    settledAssignments: runs.length,
    unstartedAssignments: outcomes.length - runs.length,
    completeBlocks: blocks.filter((block) => block.disposition === 'COMPLETE').length,
    incompleteBlocks: blocks.filter((block) => block.disposition === 'INCOMPLETE').length,
    unstartedBlocks: blocks.filter((block) => block.disposition === 'NOT_STARTED').length,
    dispatchedCalls: runs.filter((item) => item.dispatched).length,
    providerTurnsStarted: calls.filter((call) =>
      call.providerAccounting.providerTurnStarted === 'YES'
    ).length,
    billableModelCalls: calls.filter((call) =>
      call.providerAccounting.billableModelCall === 'YES'
    ).length,
    billableModelCallsUnknown: calls.filter((call) =>
      call.providerAccounting.billableModelCall === 'UNKNOWN'
    ).length,
    usageKnownCalls: knownUsage.length,
    usageUnknownCalls: calls.length - knownUsage.length,
    inputTokens: fullyKnown ? sumUsage('inputTokens') : null,
    cachedInputTokens: fullyKnown ? sumUsage('cachedInputTokens') : null,
    outputTokens: fullyKnown ? sumUsage('outputTokens') : null,
    reasoningTokens: fullyKnown ? sumUsage('reasoningOutputTokens') : null,
    totalTokens: fullyKnown ? sumUsage('totalTokens') : null,
    knownInputTokens: sumUsage('inputTokens'),
    knownCachedInputTokens: sumUsage('cachedInputTokens'),
    knownOutputTokens: sumUsage('outputTokens'),
    knownReasoningTokens: sumUsage('reasoningOutputTokens'),
    knownTotalTokens: sumUsage('totalTokens'),
    totalLatencyMs: allLatencyKnown
      ? (latencies as number[]).reduce((sum, value) => sum + value, 0)
      : null,
    knownLatencyMs: latencies.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    providerFailuresByKind: failureKinds,
    validationErrors: runs.reduce((sum, item) =>
      sum + item.outputRecord.attempts.reduce(
        (attemptSum, attempt) => attemptSum + attempt.validationErrors.length,
        0
      ), 0),
    targetOutputOvershootCalls: targetOvershoots.filter((value) => value > 0).length,
    targetOutputOvershootTokens: targetOvershoots.reduce((sum, value) => sum + value, 0),
    safetyOutputOvershootCalls: safetyOvershoots.filter((value) => value > 0).length,
    safetyOutputOvershootTokens: safetyOvershoots.reduce((sum, value) => sum + value, 0),
    experimentStopsByReason: stops
  };
}

function assertExactModelConfiguration(
  input: Pick<H1cExperimentInput, 'plan' | 'model' | 'reasoningEffort' | 'serviceTier'>
): void {
  const actual = {
    id: input.model,
    reasoningEffort: input.reasoningEffort ?? null,
    serviceTier: input.serviceTier ?? null,
    samplingSeed: null
  };
  if (stableJson(actual) !== stableJson(input.plan.model)) {
    throw new Error(
      'H1c requires the exact sealed model, reasoning effort, service tier, and null seed.'
    );
  }
  if (input.plan.partition !== 'DEVELOPMENT' || input.plan.confirmationOpened) {
    throw new Error('H1c confirmation remains closed.');
  }
}

function assertEligibleValidation(validation: H1cValidationReport, plan: H1cPlan): void {
  if (
    validation.valid !== true ||
    stableJson(validation.locks) !== stableJson(plan.locks) ||
    validation.sourceLock.sha256 !== validation.locks.labSourceSha256
  ) {
    throw new Error('H1c active validation and component/source locks do not match the plan.');
  }
}

function assertH1cProbe(
  receipt: H1cProbeReceipt,
  validation: H1cValidationReport,
  plan: H1cPlan,
  driverId: string
): void {
  const report = receipt.report;
  if (
    !receipt.runId ||
    receipt.runId !== report.runId ||
    report.status !== 'PASSED' ||
    stableJson(report.componentLocks) !== stableJson(validation.locks) ||
    report.driverId !== driverId ||
    report.model !== plan.model.id ||
    !report.call?.observedModelProvider ||
    report.reasoningEffort !== plan.model.reasoningEffort ||
    report.serviceTier !== plan.model.serviceTier ||
    report.publicOutputSchemaVersion !== LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION ||
    receipt.publicOutputSchemaSha256 !== report.publicOutputSchemaSha256 ||
    receipt.publicOutputSchemaSha256 !== H1C_PROBE_OUTPUT_SCHEMA_SHA256 ||
    report.localValidation.status !== 'PASSED' ||
    report.semanticValidation.status !== 'PASSED' ||
    report.failedChecks.length !== 0 ||
    report.close.status !== 'CLEAN' ||
    !/^[a-f0-9]{64}$/u.test(receipt.manifestSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.reportSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.componentLocksSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.publicOutputSchemaSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.promptSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.contextSha256)
  ) {
    throw new Error('H1c requires the exact PASSED public-output-v4 probe and model settings.');
  }
}

function boundaryClassFor(driver: LabTextDriver): LabRunManifest['driver']['boundaryClass'] {
  const providerEnforced =
    driver.capabilities.textOnlyProviderEnforced && driver.capabilities.hardOutputTokenLimit;
  const harnessVerified =
    driver.capabilities.harnessVerifiedTextIsolation === true &&
    driver.capabilities.streamingOutputTokenInterrupt === true;
  if (!driver.capabilities.hardCallTimeLimit || !driver.capabilities.providerReportedTokenUsage) {
    throw new Error(
      'H1c requires hard call-time control and provider-reported retrospective token usage.'
    );
  }
  if (!driver.capabilities.continuation) {
    throw new Error('H1c requires exact same-session continuation for active self-review.');
  }
  if (providerEnforced) return 'PROVIDER_ENFORCED_STRICT';
  if (harnessVerified) return 'H1_DEVELOPMENT_HARNESS_VERIFIED';
  throw new Error(
    'H1c requires provider-enforced boundaries or verified development isolation with streaming interruption.'
  );
}

function manifestDriver(
  input: Pick<
    H1cExperimentInput,
    'driver' | 'model' | 'reasoningEffort' | 'serviceTier' | 'probeReceipt'
  >,
  boundaryClass: LabRunManifest['driver']['boundaryClass']
): LabRunManifest['driver'] {
  return {
    id: input.driver.id,
    model: input.model,
    modelProvider: expectedModelProvider(input.probeReceipt),
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    seed: null,
    seedControl: input.driver.capabilities.samplingSeed ? 'SUPPORTED' : 'UNSUPPORTED',
    hardOutputTokenLimit: input.driver.capabilities.hardOutputTokenLimit,
    hardCallTimeLimit: input.driver.capabilities.hardCallTimeLimit,
    textOnlyAttestation: input.driver.capabilities.textOnlyProviderEnforced
      ? 'PROVIDER_ENFORCED'
      : 'HARNESS_DETECTED',
    boundaryClass,
    harnessVerifiedTextIsolation:
      input.driver.capabilities.harnessVerifiedTextIsolation === true,
    streamingOutputTokenInterrupt:
      input.driver.capabilities.streamingOutputTokenInterrupt === true,
    providerReportedTokenUsage:
      input.driver.capabilities.providerReportedTokenUsage === true
  };
}

function manifestBudget(plan: H1cPlan): LabRunManifest['budgets'] {
  return {
    maximumCalls: plan.budget.maximumCalls,
    maximumRounds: plan.budget.maximumRoundsPerBlock,
    maximumOutputTokens:
      plan.budget.maximumCalls * plan.budget.targetOutputTokensPerCall,
    maximumOutputTokenSafetyCeiling:
      plan.budget.maximumCalls * plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
    maximumObservedTotalTokens: plan.budget.maximumObservedTotalTokens,
    maximumCallMs: plan.budget.maximumCallMs,
    maximumExperimentMs: plan.budget.maximumExperimentMs
  };
}

function exactCallSettings(
  call: LabTextCallResult,
  input: {
    model: string;
    modelProvider: string;
    reasoningEffort?: string;
    serviceTier?: string;
  },
  requireObserved: boolean
): boolean {
  const requested = call.requestedModel === input.model &&
    (call.requestedReasoningEffort ?? null) === (input.reasoningEffort ?? null) &&
    (call.requestedServiceTier ?? null) === (input.serviceTier ?? null) &&
    call.seed === null;
  if (!requested) return false;
  return !requireObserved || (
    call.observedModel === input.model &&
    call.observedModelProvider === input.modelProvider &&
    (call.observedReasoningEffort ?? null) === (input.reasoningEffort ?? null) &&
    (call.observedServiceTier ?? null) === (input.serviceTier ?? null)
  );
}

function expectedModelProvider(receipt: H1cProbeReceipt): string {
  const provider = receipt.report.call?.observedModelProvider;
  if (!provider) throw new Error('H1c probe did not attest an observed model provider.');
  return provider;
}

function completeCallUsage(call: LabTextCallResult): LabTokenUsage | null {
  const usage = call.usage?.last;
  const total = call.usage?.total;
  if (
    !usage ||
    !total ||
    call.tokenControl?.usageStatus !== 'PROVIDER_REPORTED' ||
    call.tokenControl.observedOutputTokens !== usage.outputTokens ||
    ![usage, total].every((item) =>
      [
        item.inputTokens,
        item.cachedInputTokens,
        item.outputTokens,
        item.reasoningOutputTokens,
        item.totalTokens
      ].every(nonnegativeSafeInteger) &&
      item.totalTokens === item.inputTokens + item.outputTokens &&
      item.cachedInputTokens <= item.inputTokens &&
      item.reasoningOutputTokens <= item.outputTokens
    ) ||
    total.totalTokens < usage.totalTokens ||
    total.inputTokens < usage.inputTokens ||
    total.cachedInputTokens < usage.cachedInputTokens ||
    total.outputTokens < usage.outputTokens ||
    total.reasoningOutputTokens < usage.reasoningOutputTokens
  ) return null;
  return usage;
}

function cleanStartedLifecycle(call: LabTextCallResult): boolean {
  if (
    call.providerAccounting.providerTurnStarted !== 'YES' ||
    !call.providerTurnId ||
    !call.acknowledgedAt ||
    !call.startedAt ||
    !validTimestampOrder(call.submittedAt, call.acknowledgedAt) ||
    !validTimestampOrderWithBackwardTolerance(call.acknowledgedAt, call.startedAt, 999) ||
    !validTimestampOrder(call.startedAt, call.completedAt) ||
    (call.rawText.length > 0 && (
      !call.firstOutputAt ||
      !validTimestampOrder(call.startedAt, call.firstOutputAt) ||
      !validTimestampOrder(call.firstOutputAt, call.completedAt)
    )) ||
    (!call.failure && call.providerStatus !== 'completed')
  ) return false;
  return lifecycleEventsAreOrdered(call.lifecycle.map((item) => item.event));
}

function lifecycleEventsAreOrdered(events: readonly string[]): boolean {
  const firstIndex = new Map<string, number>();
  events.forEach((event, index) => {
    if (!firstIndex.has(event)) firstIndex.set(event, index);
  });
  const before = (left: string, right: string): boolean => {
    const leftIndex = firstIndex.get(left);
    const rightIndex = firstIndex.get(right);
    return leftIndex !== undefined && rightIndex !== undefined && leftIndex < rightIndex;
  };
  return before('submitted', 'acknowledged') &&
    before('acknowledged', 'started') &&
    before('started', 'terminal') &&
    before('terminal', 'result-recorded');
}

function validTimestampOrder(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && rightMs >= leftMs;
}

function validTimestampOrderWithBackwardTolerance(
  left: string,
  right: string,
  maximumBackwardMs: number
): boolean {
  // Codex turn.startedAt is reported in whole seconds. The lifecycle array
  // remains the ordering authority; this permits only its truncation window.
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) &&
    Number.isFinite(rightMs) &&
    rightMs + maximumBackwardMs >= leftMs;
}

function exactTokenControl(
  call: LabTextCallResult,
  expected: { targetOutputTokens: number; safetyOutputTokens: number; driver: LabTextDriver }
): boolean {
  const control = call.tokenControl;
  const usage = call.usage?.last;
  if (!control || !usage) return false;
  const targetOvershoot = Math.max(0, usage.outputTokens - expected.targetOutputTokens);
  const safetyOvershoot = Math.max(0, usage.outputTokens - expected.safetyOutputTokens);
  return control.targetOutputTokens === expected.targetOutputTokens &&
    control.safetyCeilingOutputTokens === expected.safetyOutputTokens &&
    control.providerEnforcedLimit === expected.driver.capabilities.hardOutputTokenLimit &&
    control.usageStatus === 'PROVIDER_REPORTED' &&
    control.observedOutputTokens === usage.outputTokens &&
    control.targetOvershootTokens === targetOvershoot &&
    control.safetyOvershootTokens === safetyOvershoot;
}

function hasTypedProvenanceFailure(outputRecord: LabOutputRecordV4): boolean {
  return outputRecord.attempts[0]!.validationErrors.some((error) =>
    error.measurementEffect === 'OUTPUT_INVALID' &&
    (error.domain === 'FACTUAL_PROVENANCE' ||
      error.domain === 'CONVERSATIONAL_PROVENANCE' ||
      error.domain === 'RESPONSE_PROVENANCE')
  );
}

function hasMeasurementUnavailableFailure(outputRecord: LabOutputRecordV4): boolean {
  return outputRecord.attempts[0]!.validationErrors.some(
    (error) => error.measurementEffect === 'MEASUREMENT_UNAVAILABLE'
  );
}

function measurementStatusForRun(
  run: ParticipantRunRecord
): H1cScoredObservation['measurementStatus'] {
  if (run.counterState.validSemanticObservation) return 'VALID';
  if (run.call.failure || hasMeasurementUnavailableFailure(run.outputRecord)) {
    return 'UNAVAILABLE';
  }
  return 'INVALID';
}

function initialOutputForBlock(
  runs: readonly ParticipantRunRecord[],
  blockId: string
): LabPublicOutputV4 | null {
  return runs.find((item) =>
    item.assignment.blockId === blockId && item.assignment.conditionId === 'STRONG_INITIAL'
  )?.output ?? null;
}

function parserFailureRecord(
  call: LabTextCallResult,
  error: unknown
): LabOutputRecordV4 {
  return {
    attempts: [{
      attemptNumber: 1,
      purpose: 'PRIMARY',
      callId: call.providerTurnId ?? call.callKey,
      rawText: call.rawText,
      validationErrors: [{
        path: '$',
        code: 'INVALID_VALUE',
        message: `H1c parser or contextual validator failed: ${errorMessage(error)}`,
        ruleId: 'H1C_CONTEXT_VALIDATOR_EXCEPTION',
        domain: 'CONTEXT_CONTRACT',
        measurementEffect: 'MEASUREMENT_UNAVAILABLE'
      }]
    }],
    acceptedAttemptNumber: null,
    repairAttempted: false,
    status: 'INVALID'
  };
}

function cleanStartedSession(call: LabTextCallResult, driverId: string): boolean {
  return Boolean(
    !call.failure &&
    call.session?.driverId === driverId &&
    call.providerTurnId &&
    call.providerAccounting.sessionAttestation === 'ATTESTED' &&
    call.providerAccounting.threadStartStatus === 'ATTESTED' &&
    call.providerAccounting.providerTurnStarted === 'YES'
  );
}

function sameSession(
  actual: LabDriverSession | undefined,
  expected: LabDriverSession | undefined
): boolean {
  return Boolean(actual && expected && stableJson(actual) === stableJson(expected));
}

function failedCall(
  input: Pick<H1cExperimentInput, 'model' | 'reasoningEffort' | 'serviceTier'>,
  callKey: string,
  kind: NonNullable<LabTextCallResult['failure']>['kind'],
  message: string,
  dispatched: boolean,
  continuation: LabDriverSession | undefined
): LabTextCallResult {
  const now = new Date().toISOString();
  return {
    callKey,
    rawText: '',
    submittedAt: now,
    completedAt: now,
    requestedModel: input.model,
    requestedReasoningEffort: input.reasoningEffort,
    requestedServiceTier: input.serviceTier ?? null,
    seed: null,
    failure: { kind, message },
    providerAccounting: {
      sessionAttestation: dispatched ? 'UNKNOWN' : continuation ? 'ATTESTED' : 'NOT_PRESENT',
      threadStartStatus: continuation ? 'NOT_REQUIRED' : dispatched ? 'UNKNOWN' : 'NOT_STARTED',
      providerTurnStarted: dispatched ? 'UNKNOWN' : 'NO',
      billableModelCall: dispatched ? 'UNKNOWN' : 'NO'
    },
    violations: [],
    lifecycle: [{
      event: dispatched ? 'harness-call-failed' : 'rejected-before-turn',
      at: now,
      detail: { message }
    }]
  };
}

function exceedsCallTime(call: LabTextCallResult, maximumCallMs: number): boolean {
  const latency = callLatencyMs(call);
  return latency !== null && latency > maximumCallMs;
}

function callLatencyMs(call: LabTextCallResult): number | null {
  const submitted = Date.parse(call.submittedAt);
  const completed = Date.parse(call.completedAt);
  return Number.isFinite(submitted) && Number.isFinite(completed) && completed >= submitted
    ? completed - submitted
    : null;
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 4);
}

function countStrings<T extends string>(values: readonly T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  values.forEach((value) => { result[value] = (result[value] ?? 0) + 1; });
  return result;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function stopped(reason: H1cExperimentStopReason): {
  status: 'STOPPED';
  stopReason: H1cExperimentStopReason;
} {
  return { status: 'STOPPED', stopReason: reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeExperimentDriver(
  driver: LabTextDriver,
  maximumMs: number
): Promise<H1cExperimentDriverClose> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve()
    .then(() => driver.close())
    .then(() => ({ status: 'CLEAN' as const }))
    .catch((error: unknown) => ({
      status: 'FAILED' as const,
      failure: serializeH1cProbeFailure(error)
    }));
  const timeout = new Promise<{
    status: 'TIMED_OUT';
    failure: H1cProbeFailureDetail;
  }>((resolve) => {
    timer = setTimeout(() => resolve({
      status: 'TIMED_OUT',
      failure: {
        name: 'TimeoutError',
        message: `H1c driver close exceeded ${maximumMs} ms.`
      }
    }), maximumMs);
  });
  const outcome = await Promise.race([close, timeout]);
  if (timer) clearTimeout(timer);
  const completedMs = Date.now();
  return {
    ...outcome,
    startedAt,
    completedAt: new Date(completedMs).toISOString(),
    elapsedMs: Math.max(0, completedMs - startedMs),
    maximumMs
  };
}

async function withinSetupDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  label: string
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`H1c ${label} exceeded the hard experiment deadline.`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`H1c ${label} exceeded the hard experiment deadline.`));
      }, remainingMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
