import {
  h1bPublicIntervention,
  loadH1bOracleCorpus,
  loadH1bParticipantCorpus,
  type H1bParticipantCaseRecord
} from './h1bCorpus';
import {
  loadH1bH0ValidationReceipt,
  type H1bHarnessValidationReport,
  type H1bMaterializedPromptRecord
} from './h1bHarnessValidation';
import {
  assertH1bPlan,
  type H1bAssignment,
  type H1bPlan
} from './h1bPlan';
import {
  interpretH1b,
  scoreH1bAssignment,
  type H1bAssignmentScore,
  type H1bInterpretation
} from './h1bScoring';
import { attestSemanticLabDriver } from './driverEligibility';
import {
  stableJson,
  type LabArtifactLedger,
  type LabRunManifest
} from './ledger';
import { getLabProtocolPlan } from './protocols';
import {
  loadPublicSchemaProbeReceipt,
  type LabPublicSchemaProbeReceipt
} from './publicSchemaProbe';
import {
  materializeInitialLabPrompt,
  runLabProtocol,
  type LabPreparedPrompt,
  type LabProtocolRunResult
} from './runner';
import type { LabTextCallResult, LabTextDriver, LabTokenUsage } from './textDriver';
import type { H1bValidationReport } from './h1bValidation';

export const H1B_EXPERIMENT_SCHEMA_VERSION =
  'task-monki/discourse-lab-h1b-experiment@v1' as const;
export const H1B_EXPERIMENT_VERSION = 'h1b-mechanism-development@v1' as const;

export type H1bExperimentStopReason =
  | 'HARD_CALL_CAP'
  | 'HARD_TOKEN_CAP_BETWEEN_BLOCKS'
  | 'HARD_CALL_TIME'
  | 'HARD_EXPERIMENT_TIME'
  | 'EMERGENCY_OUTPUT_FENCE'
  | 'BOUNDARY_VIOLATION'
  | 'SESSION_ATTESTATION_FAILURE'
  | 'PROVIDER_LIFECYCLE_FAILURE'
  | 'PROVIDER_FAILURES'
  | 'MISSING_USAGE'
  | 'SCHEMA_FAILURES'
  | 'SCHEMA_REPAIR_ATTEMPTED'
  | 'UNANSWERABLE_EXPERIMENT';

export interface H1bExperimentAssignmentRun {
  assignment: H1bAssignment;
  promptArtifactSha256: string;
  runArtifactSha256: string;
  run: LabProtocolRunResult;
  score: H1bAssignmentScore;
  stoppingReasons: H1bExperimentStopReason[];
  counterState: H1bRunCounterState;
}

export interface H1bRunCounterState {
  retryableProviderInfrastructureFailure: boolean;
  schemaInvalidPrimary: boolean;
  validSemanticObservation: boolean;
  consecutiveProviderFailuresAfterAssignment: number;
  consecutiveSchemaFailuresAfterAssignment: number;
}

export interface H1bExperimentAssignmentOutcome {
  assignment: H1bAssignment;
  disposition: 'SETTLED' | 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP';
  runStatus: LabProtocolRunResult['status'] | null;
  runStopReason: string | null;
  experimentStoppingReasons: H1bExperimentStopReason[];
  promptArtifactSha256: string;
  runArtifactSha256: string | null;
}

export interface H1bExperimentBlockOutcome {
  blockId: string;
  assignmentIds: string[];
  settledAssignmentIds: string[];
  disposition: 'COMPLETE' | 'INCOMPLETE' | 'NOT_STARTED';
  primaryAnalysisEligible: boolean;
  exclusionReasons: string[];
}

export interface H1bExperimentAggregate {
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
  runStatuses: Record<LabProtocolRunResult['status'], number>;
  validationErrors: number;
  targetOutputOvershootCalls: number;
  targetOutputOvershootTokens: number;
  safetyOutputOvershootCalls: number;
  safetyOutputOvershootTokens: number;
  experimentStopsByReason: Partial<Record<H1bExperimentStopReason, number>>;
}

export interface H1bExperimentResult {
  schemaVersion: typeof H1B_EXPERIMENT_SCHEMA_VERSION;
  experimentVersion: typeof H1B_EXPERIMENT_VERSION;
  hypothesisId: 'H1b';
  partition: 'DEVELOPMENT';
  status: 'COMPLETED' | 'STOPPED';
  startedAt: string;
  completedAt: string;
  stopReason?: H1bExperimentStopReason;
  stoppingReasons: H1bExperimentStopReason[];
  executionEligibility: {
    planArtifactSha256: string;
    h0ValidationRunId: string;
    h0ValidationManifestSha256: string;
    h0ValidationReportSha256: string;
    promptSetSha256: string;
    schemaProbeRunId: string;
    schemaProbeManifestSha256: string;
    schemaProbeReportSha256: string;
    publicOutputSchemaSha256: string;
    driverAttestationArtifactSha256: string;
    boundaryClass: LabRunManifest['driver']['boundaryClass'];
    componentLocks: H1bPlan['locks'];
  };
  plan: H1bPlan;
  runs: H1bExperimentAssignmentRun[];
  assignmentOutcomes: H1bExperimentAssignmentOutcome[];
  blockOutcomes: H1bExperimentBlockOutcome[];
  exclusions: Array<{
    scope: 'ASSIGNMENT' | 'BLOCK';
    assignmentId?: string;
    blockId: string;
    reasons: string[];
  }>;
  interpretation: H1bInterpretation;
  aggregate: H1bExperimentAggregate;
}

interface PreparedAssignment {
  assignment: H1bAssignment;
  record: H1bParticipantCaseRecord;
  intervention: ReturnType<typeof h1bPublicIntervention>;
  prompt: LabPreparedPrompt;
}

interface ParticipantRunRecord {
  assignment: H1bAssignment;
  promptArtifactSha256: string;
  runArtifactSha256: string;
  run: LabProtocolRunResult;
  stoppingReasons: H1bExperimentStopReason[];
  counterState: H1bRunCounterState;
}

interface H1bRunAssessment {
  immediateReasons: H1bExperimentStopReason[];
  retryableProviderInfrastructureFailure: boolean;
  schemaInvalidPrimary: boolean;
  validSemanticObservation: boolean;
}

export function buildH1bExperimentManifest(input: {
  runId: string;
  validation: H1bValidationReport;
  plan: H1bPlan;
  driver: LabTextDriver;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  schemaProbeReceipt: LabPublicSchemaProbeReceipt;
  createdAt?: string;
}): LabRunManifest {
  assertExactModelConfiguration(input);
  assertEligibleValidation(input.validation, input.plan);
  assertSchemaProbeReceipt(
    input.schemaProbeReceipt,
    input.validation.locks,
    input.plan,
    input.driver.id
  );
  const boundaryClass = boundaryClassFor(input.driver);
  return {
    schemaVersion: 'task-monki/discourse-lab-ledger@v5',
    runId: input.runId,
    phase: 'DEVELOPMENT',
    status: 'PLANNED',
    createdAt: input.createdAt ?? new Date().toISOString(),
    driver: manifestDriver(input, boundaryClass),
    locks: structuredClone(input.validation.locks),
    caseIds: [...new Set(input.plan.assignments.map((assignment) => assignment.caseId))],
    conditionIds: [
      ...new Set(input.plan.assignments.map((assignment) => assignment.conditionId))
    ],
    budgets: manifestBudget(input.plan),
    providerUsageExplicitlyAuthorized: true
  };
}

export async function runH1bExperiment(input: {
  fixtureRoot: string;
  validation: H1bValidationReport;
  plan: H1bPlan;
  driver: LabTextDriver;
  ledger: LabArtifactLedger;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  schemaProbeReceipt: LabPublicSchemaProbeReceipt;
}): Promise<H1bExperimentResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const deadlineMs = startedMs + input.plan.budget.maximumExperimentMs;
  assertExactModelConfiguration(input);
  assertEligibleValidation(input.validation, input.plan);

  const participants = await withinSetupDeadline(
    loadH1bParticipantCorpus(input.fixtureRoot),
    deadlineMs,
    input.driver,
    'participant corpus loading'
  );
  assertH1bPlan(input.plan, participants.records, input.validation.locks);
  const verifiedH0 = await withinSetupDeadline(
    loadH1bH0ValidationReceipt(
      input.ledger.rootDirectory,
      input.plan.h0Validation.runId,
      input.validation.locks
    ),
    deadlineMs,
    input.driver,
    'H0 receipt verification'
  );
  if (stableJson(verifiedH0) !== stableJson(input.plan.h0Validation)) {
    throw new Error('H1b plan lock failed: h0ValidationReceipt.');
  }

  const boundaryClass = boundaryClassFor(input.driver);
  const runManifestDriver = manifestDriver(input, boundaryClass);
  input.ledger.assertSemanticRunContext({
    phase: 'DEVELOPMENT',
    locks: input.validation.locks,
    driver: runManifestDriver,
    caseIds: [...new Set(input.plan.assignments.map((assignment) => assignment.caseId))],
    conditionIds: [
      ...new Set(input.plan.assignments.map((assignment) => assignment.conditionId))
    ],
    budgets: manifestBudget(input.plan)
  });

  const planArtifact = await withinSetupDeadline(
    input.ledger.putArtifact({ kind: 'H1B_EXPERIMENT_PLAN', plan: input.plan }),
    deadlineMs,
    input.driver,
    'plan persistence'
  );
  const h0Artifact = await withinSetupDeadline(
    input.ledger.putArtifact(verifiedH0.report),
    deadlineMs,
    input.driver,
    'H0 evidence persistence'
  );
  if (h0Artifact.sha256 !== verifiedH0.reportSha256) {
    throw new Error('H1b plan lock failed: h0ValidationArtifact.');
  }

  // Freeze and persist the entire randomized participant prompt set before
  // any semantic driver preflight or call can observe the experiment.
  const preparedAssignments = await prepareAssignments(
    input,
    participants.records,
    deadlineMs
  );
  const promptSet = h1bPromptSetArtifact(input.plan, preparedAssignments);
  const promptSetArtifact = await withinSetupDeadline(
    input.ledger.putArtifact(promptSet),
    deadlineMs,
    input.driver,
    'prompt-set persistence'
  );
  const h0Report = verifiedH0.report as unknown as H1bHarnessValidationReport;
  if (
    h0Report.scheduleSha256 !== input.plan.schedule.assignmentOrderSha256 ||
    h0Report.promptSetSha256 !== promptSetArtifact.sha256
  ) {
    throw new Error('H1b prompt set does not byte-match the H0-frozen prompt set.');
  }

  const verifiedSchemaProbe = await withinSetupDeadline(
    loadPublicSchemaProbeReceipt(
      input.ledger.rootDirectory,
      input.schemaProbeReceipt.runId,
      input.validation.locks
    ),
    deadlineMs,
    input.driver,
    'public-schema probe receipt verification'
  );
  if (stableJson(verifiedSchemaProbe) !== stableJson(input.schemaProbeReceipt)) {
    throw new Error('H1b public-schema probe receipt changed after CLI verification.');
  }
  assertSchemaProbeReceipt(
    verifiedSchemaProbe,
    input.validation.locks,
    input.plan,
    input.driver.id
  );

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
    input.ledger.putArtifact({ kind: 'H1B_SEMANTIC_DRIVER_ATTESTATION', preflight }),
    deadlineMs,
    input.driver,
    'driver attestation persistence'
  );

  await withinSetupDeadline(input.ledger.append({
    eventType: 'H1B_EXPERIMENT_STARTED',
    occurredAt: startedAt,
    artifactSha256: planArtifact.sha256,
    detail: {
      assignments: input.plan.assignments.length,
      blocks: input.plan.schedule.blockIds.length,
      h0ValidationRunId: verifiedH0.runId,
      promptSetSha256: promptSetArtifact.sha256,
      schemaProbeRunId: verifiedSchemaProbe.runId,
      schemaProbeManifestSha256: verifiedSchemaProbe.manifestSha256,
      schemaProbeReportSha256: verifiedSchemaProbe.reportSha256,
      driverAttestationArtifactSha256: preflightArtifact.sha256
    }
  }), deadlineMs, input.driver, 'experiment start persistence');

  // The participant phase owns no scorer/oracle object. The oracle loader is
  // invoked only after this entire dispatch loop closes, including on stops.
  const participantRuns: ParticipantRunRecord[] = [];
  const providerThreadOwner = new Map<string, string>();
  let dispatchedCalls = 0;
  let observedTotalTokens = 0;
  let consecutiveProviderFailures = 0;
  let consecutiveSchemaFailures = 0;
  let status: H1bExperimentResult['status'] = 'COMPLETED';
  let stopReason: H1bExperimentStopReason | undefined;
  const experimentStoppingReasons: H1bExperimentStopReason[] = [];

  blockLoop: for (const blockId of input.plan.schedule.blockIds) {
    const block = preparedAssignments.filter((item) => item.assignment.blockId === blockId);
    if (block.length !== 3) throw new Error(`H1b block ${blockId} is not a sealed three-call block.`);
    if (dispatchedCalls + block.length > input.plan.budget.maximumCalls) {
      ({ status, stopReason } = stopped('HARD_CALL_CAP'));
      experimentStoppingReasons.push('HARD_CALL_CAP');
      break;
    }
    if (Date.now() >= deadlineMs) {
      ({ status, stopReason } = stopped('HARD_EXPERIMENT_TIME'));
      experimentStoppingReasons.push('HARD_EXPERIMENT_TIME');
      break;
    }

    for (const prepared of block) {
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
      const run = await runLabProtocol({
        participantCase: prepared.record.participantCase,
        plan: getLabProtocolPlan(prepared.assignment.conditionId),
        driver: input.driver,
        modelConfiguration: {
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          serviceTier: input.serviceTier
        },
        limits: {
          maximumCalls: 1,
          maximumRounds: input.plan.budget.maximumRoundsPerAssignment,
          maximumInputTokensPerCall:
            input.plan.budget.maximumPreparedPromptEstimateTokensPerCall,
          outputTokenSafetyCeilingPerCall:
            input.plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
          maximumObservedTotalTokens: Math.max(
            1,
            input.plan.budget.maximumObservedTotalTokens - observedTotalTokens
          ),
          maximumCallMs: input.plan.budget.maximumCallMs,
          maximumExperimentMs: Math.max(1, deadlineMs - Date.now()),
          maximumConcurrency: 1
        },
        ledger: input.ledger,
        intervention: prepared.intervention ?? undefined,
        assignmentId: prepared.assignment.assignmentId,
        preparedPrompts: [prepared.prompt]
      });
      const runArtifact = await input.ledger.putArtifact({
        kind: 'H1B_ASSIGNMENT_RUN',
        assignmentId: prepared.assignment.assignmentId,
        run
      });
      dispatchedCalls += run.realizedBudget.dispatchedCalls;
      const usage = completeProviderUsage(run);
      if (usage) observedTotalTokens += usage.totalTokens;
      const assessment = assessRun(
        prepared.assignment,
        run,
        input,
        providerThreadOwner,
        deadlineMs
      );
      if (assessment.retryableProviderInfrastructureFailure) {
        consecutiveProviderFailures += 1;
      } else if (assessment.validSemanticObservation) {
        consecutiveProviderFailures = 0;
      }
      if (assessment.schemaInvalidPrimary) {
        consecutiveSchemaFailures += 1;
      } else if (assessment.validSemanticObservation) {
        consecutiveSchemaFailures = 0;
      }
      const stoppingReasons = [...assessment.immediateReasons];
      if (consecutiveProviderFailures >= 2) stoppingReasons.push('PROVIDER_FAILURES');
      if (consecutiveSchemaFailures >= 2) stoppingReasons.push('SCHEMA_FAILURES');
      const counterState: H1bRunCounterState = {
        retryableProviderInfrastructureFailure:
          assessment.retryableProviderInfrastructureFailure,
        schemaInvalidPrimary: assessment.schemaInvalidPrimary,
        validSemanticObservation: assessment.validSemanticObservation,
        consecutiveProviderFailuresAfterAssignment: consecutiveProviderFailures,
        consecutiveSchemaFailuresAfterAssignment: consecutiveSchemaFailures
      };
      participantRuns.push({
        assignment: structuredClone(prepared.assignment),
        promptArtifactSha256: prepared.prompt.promptArtifactSha256,
        runArtifactSha256: runArtifact.sha256,
        run,
        stoppingReasons: unique(stoppingReasons),
        counterState
      });
      if (stoppingReasons.length > 0) {
        status = 'STOPPED';
        stopReason = stoppingReasons[0];
        experimentStoppingReasons.push(...stoppingReasons);
        break blockLoop;
      }
    }

    // Retrospective aggregate accounting is deliberately checked only after
    // all three randomized assignments in the block have settled. The block
    // that crosses the cap remains in the record and primary block table.
    if (observedTotalTokens >= input.plan.budget.maximumObservedTotalTokens) {
      ({ status, stopReason } = stopped('HARD_TOKEN_CAP_BETWEEN_BLOCKS'));
      experimentStoppingReasons.push('HARD_TOKEN_CAP_BETWEEN_BLOCKS');
      break;
    }
  }

  // Scorer-only truth is opened only after participant dispatch is irrevocably closed.
  const oracles = await loadH1bOracleCorpus(input.fixtureRoot, participants);
  const recordByCase = new Map(participants.records.map((record) => [record.caseId, record]));
  const oracleByCase = new Map(oracles.map((oracle) => [oracle.caseId, oracle]));
  const runs: H1bExperimentAssignmentRun[] = participantRuns.map((item) => {
    const record = recordByCase.get(item.assignment.caseId);
    const oracle = oracleByCase.get(item.assignment.caseId);
    if (!record || !oracle) throw new Error(`H1b scorer cannot resolve ${item.assignment.caseId}.`);
    return {
      ...item,
      score: scoreH1bAssignment({
        assignmentId: item.assignment.assignmentId,
        blockId: item.assignment.blockId,
        repetition: item.assignment.repetition,
        conditionId: item.assignment.conditionId,
        record,
        oracle,
        run: item.run
      })
    };
  });
  const outcomes = assignmentOutcomes(input.plan, preparedAssignments, runs, stopReason);
  const blocks = blockOutcomes(input.plan, runs);
  const exclusions = exclusionsFor(blocks, runs);
  const completedAt = new Date().toISOString();
  const result: H1bExperimentResult = {
    schemaVersion: H1B_EXPERIMENT_SCHEMA_VERSION,
    experimentVersion: H1B_EXPERIMENT_VERSION,
    hypothesisId: 'H1b',
    partition: 'DEVELOPMENT',
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
      promptSetSha256: promptSetArtifact.sha256,
      schemaProbeRunId: verifiedSchemaProbe.runId,
      schemaProbeManifestSha256: verifiedSchemaProbe.manifestSha256,
      schemaProbeReportSha256: verifiedSchemaProbe.reportSha256,
      publicOutputSchemaSha256: verifiedSchemaProbe.publicOutputSchemaSha256,
      driverAttestationArtifactSha256: preflightArtifact.sha256,
      boundaryClass,
      componentLocks: structuredClone(input.validation.locks)
    },
    plan: structuredClone(input.plan),
    runs,
    assignmentOutcomes: outcomes,
    blockOutcomes: blocks,
    exclusions,
    interpretation: interpretH1b(runs.map((item) => item.score), input.plan.assignments.length),
    aggregate: aggregateResult(runs, outcomes, blocks)
  };
  await input.ledger.writeReport('h1b-development-result', result);
  await input.ledger.append({
    eventType: status === 'COMPLETED' ? 'H1B_EXPERIMENT_COMPLETED' : 'H1B_EXPERIMENT_STOPPED',
    occurredAt: completedAt,
    detail: {
      settledAssignments: runs.length,
      completeBlocks: blocks.filter((block) => block.disposition === 'COMPLETE').length,
      observedTotalTokens,
      ...(stopReason ? { stopReason } : {})
    }
  });
  return result;
}

async function prepareAssignments(
  input: Parameters<typeof runH1bExperiment>[0],
  records: readonly H1bParticipantCaseRecord[],
  deadlineMs: number
): Promise<PreparedAssignment[]> {
  const byCase = new Map(records.map((record) => [record.caseId, record]));
  const prepared: PreparedAssignment[] = [];
  for (const assignmentId of input.plan.schedule.assignmentIds) {
    const assignment = input.plan.assignments.find((item) => item.assignmentId === assignmentId);
    if (!assignment) throw new Error(`H1b schedule references unknown assignment ${assignmentId}.`);
    const record = byCase.get(assignment.caseId);
    if (!record) throw new Error(`H1b assignment case is unavailable: ${assignment.caseId}.`);
    const intervention = h1bPublicIntervention(record, assignment.conditionId);
    const shouldHaveIntervention = assignment.conditionId !== 'CONTROL_CASE_ONLY_B1';
    if (Boolean(intervention) !== shouldHaveIntervention) {
      throw new Error(`H1b intervention projection is invalid for ${assignment.assignmentId}.`);
    }
    const protocol = getLabProtocolPlan(assignment.conditionId);
    if (
      protocol.calls.length !== 1 ||
      protocol.maximumCalls !== 1 ||
      protocol.calls[0]?.continueFrom ||
      protocol.calls[0]?.maxOutputTokens !== input.plan.budget.targetOutputTokensPerCall
    ) {
      throw new Error(`H1b protocol is not an exact fresh one-call plan: ${assignment.conditionId}.`);
    }
    const prompt = materializeInitialLabPrompt({
      participantCase: record.participantCase,
      plan: protocol,
      intervention: intervention ?? undefined,
      maximumInputTokensPerCall:
        input.plan.budget.maximumPreparedPromptEstimateTokensPerCall
    });
    const stored = await withinSetupDeadline(
      input.ledger.putArtifact(prompt.artifact),
      deadlineMs,
      input.driver,
      `prompt persistence for ${assignment.assignmentId}`
    );
    if (stored.sha256 !== prompt.promptArtifactSha256) {
      throw new Error(`H1b prepared-prompt hash mismatch: ${assignment.assignmentId}.`);
    }
    prepared.push({ assignment, record, intervention, prompt });
  }
  if (prepared.length !== input.plan.budget.maximumPrimaryCalls) {
    throw new Error('H1b did not materialize the exact sealed primary-call matrix.');
  }
  return prepared;
}

function h1bPromptSetArtifact(
  plan: H1bPlan,
  prepared: readonly PreparedAssignment[]
): {
  kind: 'H1B_H0_MATERIALIZED_PROMPT_SET';
  scheduleVersion: H1bPlan['schedule']['version'];
  scheduleSha256: string;
  prompts: H1bMaterializedPromptRecord[];
} {
  return {
    kind: 'H1B_H0_MATERIALIZED_PROMPT_SET',
    scheduleVersion: plan.schedule.version,
    scheduleSha256: plan.schedule.assignmentOrderSha256,
    prompts: prepared.map(({ assignment, prompt }) => ({
      assignmentId: assignment.assignmentId,
      blockId: assignment.blockId,
      caseId: assignment.caseId,
      repetition: assignment.repetition,
      position: assignment.position,
      conditionId: assignment.conditionId,
      promptArtifactSha256: prompt.promptArtifactSha256,
      estimatedPromptTokens: Math.ceil(Buffer.byteLength(prompt.prompt, 'utf8') / 4),
      prompt: prompt.prompt
    }))
  };
}

function assertExactModelConfiguration(
  input: Pick<Parameters<typeof runH1bExperiment>[0], 'plan' | 'model' | 'reasoningEffort' | 'serviceTier'>
): void {
  const actual = {
    id: input.model,
    reasoningEffort: input.reasoningEffort ?? null,
    serviceTier: input.serviceTier ?? null,
    samplingSeed: null
  };
  const expected = {
    id: input.plan.model.id,
    reasoningEffort: input.plan.model.reasoningEffort,
    serviceTier: input.plan.model.serviceTier,
    samplingSeed: input.plan.model.samplingSeed
  };
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error('H1b requires the exact sealed model, reasoning effort, service tier, and null seed.');
  }
  if (input.plan.partition !== 'DEVELOPMENT' || input.plan.analysis.confirmationOpened) {
    throw new Error('H1b confirmation remains closed.');
  }
}

function assertEligibleValidation(validation: H1bValidationReport, plan: H1bPlan): void {
  if (
    validation.valid !== true ||
    stableJson(validation.locks) !== stableJson(plan.locks) ||
    validation.sourceLock.sha256 !== validation.locks.labSourceSha256
  ) {
    throw new Error('H1b active validation and component/source locks do not match the plan.');
  }
}

function assertSchemaProbeReceipt(
  receipt: LabPublicSchemaProbeReceipt,
  locks: H1bPlan['locks'],
  plan: H1bPlan,
  driverId: string
): void {
  const report = receipt.report;
  if (
    !receipt.runId ||
    receipt.runId !== report.runId ||
    report.status !== 'PASSED' ||
    report.failedChecks.length !== 0 ||
    stableJson(report.componentLocks) !== stableJson(locks) ||
    report.driverId !== driverId ||
    report.model !== plan.model.id ||
    report.reasoningEffort !== plan.model.reasoningEffort ||
    report.serviceTier !== plan.model.serviceTier ||
    receipt.publicOutputSchemaSha256 !== report.publicOutputSchemaSha256 ||
    !/^[a-f0-9]{64}$/u.test(receipt.manifestSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.reportSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.publicOutputSchemaSha256)
  ) {
    throw new Error('H1b requires the exact PASSED public-schema probe receipt and model settings.');
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
      'H1b requires hard call-time control and provider-reported retrospective token usage.'
    );
  }
  if (providerEnforced) return 'PROVIDER_ENFORCED_STRICT';
  if (harnessVerified) return 'H1_DEVELOPMENT_HARNESS_VERIFIED';
  throw new Error(
    'H1b requires either provider-enforced text/token boundaries or the verified development isolation and streaming-interrupt boundary.'
  );
}

function manifestDriver(
  input: {
    driver: LabTextDriver;
    model: string;
    reasoningEffort?: string;
    serviceTier?: string;
  },
  boundaryClass: LabRunManifest['driver']['boundaryClass']
): LabRunManifest['driver'] {
  return {
    id: input.driver.id,
    model: input.model,
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

function manifestBudget(plan: H1bPlan): LabRunManifest['budgets'] {
  return {
    maximumCalls: plan.budget.maximumCalls,
    maximumRounds: plan.budget.maximumRoundsPerAssignment,
    maximumOutputTokens:
      plan.budget.maximumCalls * plan.budget.targetOutputTokensPerCall,
    maximumOutputTokenSafetyCeiling:
      plan.budget.maximumCalls * plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
    maximumObservedTotalTokens: plan.budget.maximumObservedTotalTokens,
    maximumCallMs: plan.budget.maximumCallMs,
    maximumExperimentMs: plan.budget.maximumExperimentMs
  };
}

function assessRun(
  assignment: H1bAssignment,
  run: LabProtocolRunResult,
  input: Parameters<typeof runH1bExperiment>[0],
  threadOwners: Map<string, string>,
  deadlineMs: number
): H1bRunAssessment {
  const reasons: H1bExperimentStopReason[] = [];
  const repairs = run.callAccounting.filter((call) => call.purpose === 'SCHEMA_REPAIR');
  if (repairs.length > 0) reasons.push('SCHEMA_REPAIR_ATTEMPTED');
  const primaries = run.callAccounting.filter((call) => call.purpose === 'PRIMARY');
  const calls = run.calls;
  const failures = run.callAccounting.flatMap((call) => call.failure ? [call.failure] : []);
  const providerError = failures.some((failure) => failure.kind === 'PROVIDER_ERROR');
  const timeout = failures.some((failure) => failure.kind === 'TIMEOUT');
  const emergencyFence = failures.some((failure) => failure.kind === 'TOKEN_LIMIT_EXCEEDED');
  if (
    failures.some((failure) =>
      failure.kind === 'SETTINGS_MISMATCH' ||
      failure.kind === 'MODEL_REROUTED' ||
      failure.kind === 'TOOL_CONTEXT_VIOLATION'
    ) ||
    calls.some((call) => call.violations.length > 0)
  ) reasons.push('BOUNDARY_VIOLATION');

  let cleanLifecycle = false;
  let providerTurnStarted = false;
  if (primaries.length !== 1 || calls.length !== 1) {
    reasons.push('PROVIDER_LIFECYCLE_FAILURE');
  } else {
    const primary = primaries[0]!;
    const call = calls[0]!;
    const threadId = primary.providerThreadId;
    providerTurnStarted = primary.providerTurnStarted === 'YES';
    const cleanPreTurnFailure =
      primary.dispatched &&
      primary.threadStartRequested &&
      (providerError || timeout) &&
      primary.providerTurnStarted === 'NO' &&
      primary.threadStartStatus === 'NOT_STARTED' &&
      primary.sessionAttestation === 'NOT_PRESENT' &&
      !primary.providerTurnId &&
      !threadId &&
      !call.session;
    const attestedStartedTurn =
      primary.dispatched &&
      primary.threadStartRequested &&
      primary.threadStartStatus === 'ATTESTED' &&
      primary.sessionAttestation === 'ATTESTED' &&
      primary.providerTurnStarted === 'YES' &&
      Boolean(primary.providerTurnId) &&
      Boolean(threadId) &&
      call.session?.driverId === input.driver.id &&
      call.session?.providerThreadId === threadId;
    cleanLifecycle = cleanPreTurnFailure || attestedStartedTurn;
    if (!cleanLifecycle) {
      reasons.push('SESSION_ATTESTATION_FAILURE');
    } else if (attestedStartedTurn && threadId) {
      const owner = threadOwners.get(threadId);
      if (owner) reasons.push('SESSION_ATTESTATION_FAILURE');
      else threadOwners.set(threadId, assignment.assignmentId);
    }
    if (!exactCallSettings(call, input, providerTurnStarted)) {
      reasons.push('BOUNDARY_VIOLATION');
    }
  }

  if (
    timeout ||
    calls.some((call) => callLatencyMs(call) !== null && callLatencyMs(call)! > input.plan.budget.maximumCallMs)
  ) reasons.push('HARD_CALL_TIME');
  if (Date.now() >= deadlineMs || run.stopReason === 'HARD_TIME_CAP') {
    reasons.push('HARD_EXPERIMENT_TIME');
  }
  if (emergencyFence) reasons.push('EMERGENCY_OUTPUT_FENCE');
  // A clean failure before a provider turn starts has no usage to report and
  // feeds the sealed provider-infrastructure counter. Once a turn starts,
  // every attempt must have complete provider-reported usage before dispatch continues.
  if (providerTurnStarted && !completeProviderUsage(run)) reasons.push('MISSING_USAGE');
  if (failures.some((failure) =>
    failure.kind === 'AMBIGUOUS_DELIVERY' ||
    failure.kind === 'INTERRUPT_UNCONFIRMED'
  )) reasons.push('PROVIDER_LIFECYCLE_FAILURE');
  const terminalArtifacts = run.terminalArtifactIds.flatMap((artifactId) => {
    const artifact = run.artifacts.find((candidate) => candidate.artifactId === artifactId);
    return artifact ? [artifact] : [];
  });
  if (failures.length === 0 && terminalArtifacts.length !== 1) {
    reasons.push('UNANSWERABLE_EXPERIMENT');
  }
  const invalidOutput = failures.length === 0 &&
    terminalArtifacts.length === 1 &&
    terminalArtifacts[0]!.output.status !== 'VALID';
  if (run.stopReason === 'HARD_CALL_CAP' && run.realizedBudget.dispatchedCalls === 0) {
    reasons.push('HARD_CALL_CAP');
  }
  const validSemanticObservation =
    failures.length === 0 &&
    run.status === 'COMPLETED' &&
    terminalArtifacts.length === 1 &&
    terminalArtifacts[0]!.output.status === 'VALID';
  const retryableProviderInfrastructureFailure =
    providerError &&
    cleanLifecycle &&
    !reasons.some((reason) =>
      reason === 'BOUNDARY_VIOLATION' ||
      reason === 'SESSION_ATTESTATION_FAILURE' ||
      reason === 'PROVIDER_LIFECYCLE_FAILURE' ||
      reason === 'HARD_CALL_TIME' ||
      reason === 'HARD_EXPERIMENT_TIME' ||
      reason === 'EMERGENCY_OUTPUT_FENCE' ||
      reason === 'MISSING_USAGE'
    );
  if (
    run.status !== 'COMPLETED' &&
    reasons.length === 0 &&
    !retryableProviderInfrastructureFailure &&
    !invalidOutput
  ) {
    reasons.push('PROVIDER_LIFECYCLE_FAILURE');
  }
  return {
    immediateReasons: unique(reasons),
    retryableProviderInfrastructureFailure,
    schemaInvalidPrimary: invalidOutput,
    validSemanticObservation
  };
}

function exactCallSettings(
  call: LabTextCallResult,
  input: Pick<Parameters<typeof runH1bExperiment>[0], 'model' | 'reasoningEffort' | 'serviceTier'>,
  requireObserved: boolean
): boolean {
  const requested = call.requestedModel === input.model &&
    (call.requestedReasoningEffort ?? null) === (input.reasoningEffort ?? null) &&
    (call.requestedServiceTier ?? null) === (input.serviceTier ?? null) &&
    call.seed === null;
  if (!requested) return false;
  return !requireObserved || (
    call.observedModel === input.model &&
    (call.observedReasoningEffort ?? null) === (input.reasoningEffort ?? null) &&
    (call.observedServiceTier ?? null) === (input.serviceTier ?? null)
  );
}

function completeProviderUsage(run: LabProtocolRunResult): LabTokenUsage | null {
  if (run.calls.length !== 1) return null;
  return completeCallUsage(run.calls[0]!);
}

function completeCallUsage(call: LabTextCallResult): LabTokenUsage | null {
  const usage = call.usage?.last;
  const total = call.usage?.total;
  if (
    !usage ||
    !total ||
    call.tokenControl?.usageStatus !== 'PROVIDER_REPORTED' ||
    call.tokenControl.observedOutputTokens !== usage.outputTokens ||
    ![usage, total].every((item) => [
      item.inputTokens,
      item.cachedInputTokens,
      item.outputTokens,
      item.reasoningOutputTokens,
      item.totalTokens
    ].every(nonnegativeSafeInteger))
  ) return null;
  return usage;
}

function assignmentOutcomes(
  plan: H1bPlan,
  prepared: readonly PreparedAssignment[],
  runs: readonly H1bExperimentAssignmentRun[],
  stopReason: H1bExperimentStopReason | undefined
): H1bExperimentAssignmentOutcome[] {
  const preparedById = new Map(prepared.map((item) => [item.assignment.assignmentId, item]));
  const runById = new Map(runs.map((item) => [item.assignment.assignmentId, item]));
  return plan.schedule.assignmentIds.map((assignmentId) => {
    const item = preparedById.get(assignmentId)!;
    const settled = runById.get(assignmentId);
    return {
      assignment: structuredClone(item.assignment),
      disposition: settled ? 'SETTLED' : 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP',
      runStatus: settled?.run.status ?? null,
      runStopReason: settled?.run.stopReason ?? (settled ? null : stopReason ?? 'EXPERIMENT_STOPPED'),
      experimentStoppingReasons: settled ? [...settled.stoppingReasons] : [],
      promptArtifactSha256: item.prompt.promptArtifactSha256,
      runArtifactSha256: settled?.runArtifactSha256 ?? null
    };
  });
}

function blockOutcomes(
  plan: H1bPlan,
  runs: readonly H1bExperimentAssignmentRun[]
): H1bExperimentBlockOutcome[] {
  const runById = new Map(runs.map((item) => [item.assignment.assignmentId, item]));
  return plan.schedule.blockIds.map((blockId) => {
    const assignments = plan.assignments.filter((assignment) => assignment.blockId === blockId);
    const settled = assignments.filter((assignment) => runById.has(assignment.assignmentId));
    const invalid = settled.flatMap((assignment) => {
      const run = runById.get(assignment.assignmentId)!;
      return run.score.validSemanticObservation ? [] : [assignment.assignmentId];
    });
    const disposition = settled.length === 0
      ? 'NOT_STARTED' as const
      : settled.length === assignments.length
        ? 'COMPLETE' as const
        : 'INCOMPLETE' as const;
    const exclusionReasons = [
      disposition !== 'COMPLETE' ? `BLOCK_${disposition}` : null,
      invalid.length > 0 ? `INVALID_SEMANTIC_ASSIGNMENTS:${invalid.join(',')}` : null
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
  blocks: readonly H1bExperimentBlockOutcome[],
  runs: readonly H1bExperimentAssignmentRun[]
): H1bExperimentResult['exclusions'] {
  const blockExclusions = blocks.flatMap((block) => block.exclusionReasons.length > 0
    ? [{ scope: 'BLOCK' as const, blockId: block.blockId, reasons: [...block.exclusionReasons] }]
    : []);
  const assignmentExclusions = runs.flatMap((item) => {
    const reasons = [
      !item.score.validSemanticObservation ? 'INVALID_SEMANTIC_OBSERVATION' : null,
      item.run.status !== 'COMPLETED' ? `RUN_${item.run.status}` : null,
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
  runs: readonly H1bExperimentAssignmentRun[],
  outcomes: readonly H1bExperimentAssignmentOutcome[],
  blocks: readonly H1bExperimentBlockOutcome[]
): H1bExperimentAggregate {
  const calls = runs.flatMap((item) => item.run.calls);
  const accounting = runs.flatMap((item) => item.run.callAccounting);
  const knownUsage = calls.flatMap((call) => {
    const usage = completeCallUsage(call);
    return usage ? [usage] : [];
  });
  const fullyKnown = knownUsage.length === calls.length;
  const latencies = calls.map(callLatencyMs);
  const allLatencyKnown = latencies.every((value) => value !== null);
  const failures = accounting.flatMap((call) => call.failure ? [call.failure] : []);
  const failureKinds = countStrings(failures.map((failure) => failure.kind));
  const stops = countStrings(runs.flatMap((item) => item.stoppingReasons));
  const targetOvershoots = calls.map((call) => call.tokenControl?.targetOvershootTokens ?? 0);
  const safetyOvershoots = calls.map((call) => call.tokenControl?.safetyOvershootTokens ?? 0);
  const sumUsage = (key: keyof (typeof knownUsage)[number]) =>
    knownUsage.reduce((sum, usage) => sum + usage[key], 0);
  return {
    plannedAssignments: outcomes.length,
    settledAssignments: runs.length,
    unstartedAssignments: outcomes.filter((item) =>
      item.disposition === 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP'
    ).length,
    completeBlocks: blocks.filter((block) => block.disposition === 'COMPLETE').length,
    incompleteBlocks: blocks.filter((block) => block.disposition === 'INCOMPLETE').length,
    unstartedBlocks: blocks.filter((block) => block.disposition === 'NOT_STARTED').length,
    dispatchedCalls: accounting.filter((call) => call.dispatched).length,
    providerTurnsStarted: accounting.filter((call) => call.providerTurnStarted === 'YES').length,
    billableModelCalls: accounting.filter((call) => call.billableModelCall === 'YES').length,
    billableModelCallsUnknown:
      accounting.filter((call) => call.billableModelCall === 'UNKNOWN').length,
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
    runStatuses: {
      COMPLETED: runs.filter((item) => item.run.status === 'COMPLETED').length,
      STOPPED: runs.filter((item) => item.run.status === 'STOPPED').length,
      FAILED: runs.filter((item) => item.run.status === 'FAILED').length
    },
    validationErrors: runs.reduce((sum, item) => sum + item.score.validationErrorCount, 0),
    targetOutputOvershootCalls: targetOvershoots.filter((value) => value > 0).length,
    targetOutputOvershootTokens: targetOvershoots.reduce((sum, value) => sum + value, 0),
    safetyOutputOvershootCalls: safetyOvershoots.filter((value) => value > 0).length,
    safetyOutputOvershootTokens: safetyOvershoots.reduce((sum, value) => sum + value, 0),
    experimentStopsByReason: stops
  };
}

function callLatencyMs(call: LabTextCallResult): number | null {
  const started = Date.parse(call.submittedAt);
  const completed = Date.parse(call.completedAt);
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
    ? completed - started
    : null;
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

function stopped(reason: H1bExperimentStopReason): {
  status: 'STOPPED';
  stopReason: H1bExperimentStopReason;
} {
  return { status: 'STOPPED', stopReason: reason };
}

async function withinSetupDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  driver: LabTextDriver,
  label: string
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    await closeWithoutMasking(driver);
    throw new Error(`H1b ${label} exceeded the hard experiment deadline.`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void closeWithoutMasking(driver);
        reject(new Error(`H1b ${label} exceeded the hard experiment deadline.`));
      }, remainingMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function closeWithoutMasking(driver: LabTextDriver): Promise<void> {
  try {
    await driver.close();
  } catch {
    // The deadline failure remains authoritative.
  }
}
