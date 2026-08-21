import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  LabCasePartition,
  LabOracleCase,
  LabOutputScore,
  LabRatioMetric,
  LabTrajectoryScore
} from './contracts';
import {
  LAB_CONTROLLED_MAXIMUM_EXPERIMENT_MS,
  assertControlledPlan,
  loadH0ValidationReceipt,
  type LabControlledAssignmentSchedule,
  type LabControlledPlan
} from './controlledPlan';
import {
  loadLabControlledAssignmentOracles,
  loadLabOracleCorpus,
  loadLabParticipantCorpus,
  loadLabPublicIntervention,
  planControlledAssignments,
  type LabControlledAssignment,
  type LabControlledAssignmentOracle
} from './corpus';
import { sha256Text, stableJson, type LabArtifactLedger } from './ledger';
import { acceptedLabOutput } from './outputValidation';
import { getLabProtocolPlan } from './protocols';
import {
  materializeInitialLabPrompt,
  runLabProtocol,
  type LabPreparedPrompt,
  type LabProtocolRunResult
} from './runner';
import { scoreLabTrajectory, stanceIsCorrect } from './scoring';
import { attestSemanticLabDriver } from './driverEligibility';
import type { LabDriverPreflight, LabTextDriver } from './textDriver';
import { validateLabInputs } from './validation';

export const H1_EXPERIMENT_VERSION = 'controlled-selective-updating@v5' as const;
export const H1_ASSIGNMENT_ORDER_VERSION = 'sealed-counterbalanced-order@v1' as const;

const H1_ASSIGNMENT_ORDER_SEEDS: Record<LabCasePartition, number> = {
  DEVELOPMENT: 0x51a7c0de,
  CONFIRMATION: 0xc04f1a7
};

export type ControlledAssignmentSchedule = LabControlledAssignmentSchedule;

export interface ControlledExperimentPreregistration {
  experimentVersion: typeof H1_EXPERIMENT_VERSION;
  hypothesisId: 'H1';
  partition: LabCasePartition;
  exactHypothesis: string;
  mechanismIsolated: string;
  supportResult: string;
  rejectResult: string;
  decisionChanged: string;
  executionEligibility: {
    planArtifactSha256: string;
    h0ValidationRunId: string;
    h0ValidationManifestSha256: string;
    h0ValidationArtifactSha256: string;
    driverAttestationArtifactSha256: string;
    planSchemaVersion: LabControlledPlan['schemaVersion'];
    planVersion: LabControlledPlan['planVersion'];
    componentLocks: LabControlledPlan['locks'];
    boundaryStatus: 'ATTESTED';
  };
  sealedContract: {
    preregistrationVersion: string;
    preregistrationSha256: string;
    sourcePath: string;
    experiment: SealedH1ExperimentContract;
  };
  budget: LabControlledPlan['budget'];
  metrics: string[];
  stoppingConditions: string[];
  assignments: LabControlledAssignment[];
  assignmentSchedule: ControlledAssignmentSchedule;
  promptArtifacts: Array<{
    assignmentId: string;
    callId: string;
    sha256: string;
  }>;
  modelConfiguration: {
    driverId: string;
    model: string;
    reasoningEffort?: string;
    serviceTier?: string;
    seed: number | null;
    seedControl: 'SUPPORTED' | 'UNSUPPORTED';
    hardOutputTokenLimit: boolean;
    hardCallTimeLimit: boolean;
    textOnlyProviderEnforced: boolean;
    harnessVerifiedTextIsolation: boolean;
    streamingOutputTokenInterrupt: boolean;
    providerReportedTokenUsage: boolean;
    boundaryClass: 'PROVIDER_ENFORCED_STRICT' | 'H1_DEVELOPMENT_HARNESS_VERIFIED';
  };
}

export interface ControlledExperimentResult {
  schemaVersion: 'task-monki/discourse-lab-h1@v5';
  experimentVersion: typeof H1_EXPERIMENT_VERSION;
  hypothesisId: 'H1';
  partition: LabCasePartition;
  status: 'COMPLETED' | 'STOPPED';
  startedAt: string;
  completedAt: string;
  stopReason?: string;
  preregistration: ControlledExperimentPreregistration;
  runs: Array<{
    assignment: LabControlledAssignment;
    run: LabProtocolRunResult;
    score: LabTrajectoryScore;
    domain: string;
    controlledEvidenceAttribution: LabRatioMetric;
    correctMinorityEvidence: ControlledMinorityEvidence;
  }>;
  assignmentOutcomes: Array<{
    assignment: LabControlledAssignment;
    disposition: 'SETTLED' | 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP';
    runStatus: LabProtocolRunResult['status'] | null;
    stopReason: string | null;
    promptArtifactSha256: string;
  }>;
  perCondition: ControlledConditionSummary[];
  pairedContrasts: ControlledPairedContrast[];
  perDomain: ControlledDomainSummary[];
  tokenControl: ControlledTokenControlSummary;
  metricQualifications: {
    caseEvidentialSupport: 'CASE_ORACLE_REQUIRED_EVIDENCE_ONLY';
    controlledEvidenceAttribution:
      'VALID_EVIDENCE_TARGET_CLAIM_MUST_BE_CORRECT_AND_CITE_PUBLIC_INTERVENTION_ARTIFACT_ID';
  };
  interpretation: {
    result: 'DIRECTIONALLY_SUPPORTED' | 'REJECTED' | 'INCONCLUSIVE' | 'NOT_ESTIMABLE';
    learned: string[];
    unknown: string[];
    harnessDecision: string;
    nextExperiment: string;
  };
}

export interface ControlledConditionSummary {
  conditionId: string;
  assignments: number;
  startedAssignments: number;
  notStartedAssignments: number;
  wrongToRightCorrection: LabRatioMetric;
  rightToWrongContamination: LabRatioMetric;
  evidentialSupport: LabRatioMetric;
  evidentialSupportScope: 'CASE_ORACLE_REQUIRED_EVIDENCE_ONLY';
  controlledEvidenceAttribution: LabRatioMetric;
  inventedCriticism: LabRatioMetric;
  disagreementPreservation: LabRatioMetric;
  abstentions: number;
  dispatchedAttempts: number;
  providerTurnsStarted: number;
  billableModelCalls: number;
  billableModelCallsUnknown: number;
  totalTokens: number | null;
  totalLatencyMs: number | null;
  failures: number;
  tokenControl: ControlledTokenControlSummary;
}

export interface ControlledTokenControlSummary {
  providerTurns: number;
  usageKnownCalls: number;
  usageUnknownCalls: number;
  providerReportedCalls: number;
  targetOutputOvershootCalls: number;
  targetOutputOvershootTokens: number;
  safetyOutputOvershootCalls: number;
  safetyOutputOvershootTokens: number;
}

export interface ControlledMinorityEvidence {
  acceptedOpenClaims: LabRatioMetric;
  acceptedStatus: LabRatioMetric;
  disagreementPreservation: LabRatioMetric;
  requiredUserQuestionCoverage: LabRatioMetric;
  preserved: boolean | null;
}

export interface ControlledPairedRatioContrast {
  baseline: LabRatioMetric;
  treatment: LabRatioMetric;
  delta: number | null;
  eligible: boolean;
  nonEstimableReasons: Array<
    | 'BASELINE_METRIC_UNAVAILABLE'
    | 'TREATMENT_METRIC_UNAVAILABLE'
    | 'BASELINE_HAS_NO_ELIGIBLE_OPPORTUNITIES'
    | 'TREATMENT_HAS_NO_ELIGIBLE_OPPORTUNITIES'
  >;
}

export interface SealedH1ExperimentContract {
  experimentId: 'H1';
  title: string;
  status: string;
  exactHypothesis: string;
  mechanismIsolated: string;
  conditions: string[];
  developmentCases: string[];
  confirmationCases: string[];
  budgetClass: string;
  primaryMetrics: string[];
  secondaryMetrics: string[];
  supportResult: string;
  rejectResult: string;
  decisionChanged: string;
  eligibilityGate: string;
  stoppingConditions: string[];
}

export interface ControlledPairedContrast {
  bundleId: string;
  caseId: string;
  domain: string;
  baselineAssignmentId: string;
  treatmentAssignmentId: string;
  treatmentConditionId: string;
  estimable: boolean;
  nonEstimableReasons: string[];
  wrongToRightCorrection: ControlledPairedRatioContrast;
  rightToWrongContamination: ControlledPairedRatioContrast;
  answerCorrectness: ControlledPairedRatioContrast;
  claimCorrectness: ControlledPairedRatioContrast;
  caseEvidentialSupport: ControlledPairedRatioContrast;
  inventedCriticism: ControlledPairedRatioContrast;
  disagreementPreservation: ControlledPairedRatioContrast;
  requiredUserQuestionCoverage: ControlledPairedRatioContrast;
  drift: ControlledPairedRatioContrast;
  controlledEvidenceAttribution: LabRatioMetric;
  correctMinorityEvidence: {
    baseline: boolean | null;
    treatment: boolean | null;
    delta: number | null;
  };
}

export interface ControlledDomainSummary {
  domain: string;
  assignments: number;
  startedAssignments: number;
  notStartedAssignments: number;
  failedAssignments: number;
  answerCorrectness: LabRatioMetric;
  statusAcceptance: LabRatioMetric;
  claimCorrectness: LabRatioMetric;
  caseEvidentialSupport: LabRatioMetric;
  controlledEvidenceAttribution: LabRatioMetric;
  wrongToRightCorrection: LabRatioMetric;
  rightToWrongContamination: LabRatioMetric;
  inventedCriticism: LabRatioMetric;
  sharedErrorDiscovery: LabRatioMetric;
  correctMinorityPreservation: LabRatioMetric;
  disagreementPreservation: LabRatioMetric;
  requiredUserQuestionCoverage: LabRatioMetric;
  abstention: LabRatioMetric;
  uncertaintyExpression: LabRatioMetric;
  drift: LabRatioMetric;
  repeatedCriticism: LabRatioMetric;
  duplicateIssueCount: number;
  dispatchedAttempts: number;
  providerTurnsStarted: number;
  billableModelCalls: number;
  billableModelCallsUnknown: number;
  chargedCalls: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalReasoningTokens: number | null;
  totalTokens: number | null;
  totalLatencyMs: number | null;
  failures: number;
  invalidAttempts: number;
  repairAttempts: number;
  repairSuccesses: number;
  runStatuses: Record<string, number>;
  stopReasons: Record<string, number>;
  executionFailuresByKind: Record<string, number>;
  tokenControl: ControlledTokenControlSummary;
}

/**
 * Produces a source-locked order without reading participant or oracle content.
 * Bundles and treatments are hash-shuffled, the no-feedback position rotates
 * across bundles, and bundle queues are emitted round-robin to reduce temporal
 * clustering. Input array order therefore cannot change the realized schedule.
 */
export function scheduleControlledAssignments(
  assignments: readonly LabControlledAssignment[],
  partition: LabCasePartition
): ControlledAssignmentSchedule {
  if (assignments.length === 0) throw new Error('H1 requires at least one sealed assignment.');
  const ids = assignments.map((item) => item.assignmentId);
  if (new Set(ids).size !== ids.length) throw new Error('H1 assignment ids must be unique.');
  if (assignments.some((item) => item.partition !== partition)) {
    throw new Error('H1 schedule cannot cross the selected partition.');
  }
  const seed = H1_ASSIGNMENT_ORDER_SEEDS[partition];
  const byBundle = new Map<string, LabControlledAssignment[]>();
  assignments.forEach((assignment) => {
    const selected = byBundle.get(assignment.bundleId) ?? [];
    selected.push(assignment);
    byBundle.set(assignment.bundleId, selected);
  });
  const rank = (scope: string, id: string) =>
    sha256Text(`${H1_ASSIGNMENT_ORDER_VERSION}:${seed}:${scope}:${id}`);
  const bundleOrder = [...byBundle.keys()].sort((left, right) =>
    rank('bundle', left).localeCompare(rank('bundle', right)) || left.localeCompare(right)
  );
  const baselinePositionByBundle: Record<string, number> = {};
  const queues = new Map<string, LabControlledAssignment[]>();
  bundleOrder.forEach((bundleId, bundleIndex) => {
    const bundle = byBundle.get(bundleId)!;
    const baselines = bundle.filter((item) => item.conditionId === 'CONTROL_NO_FEEDBACK_B1');
    if (baselines.length !== 1) {
      throw new Error(`H1 bundle ${bundleId} must have exactly one no-feedback baseline.`);
    }
    const treatments = bundle
      .filter((item) => item.conditionId !== 'CONTROL_NO_FEEDBACK_B1')
      .sort((left, right) =>
        rank(bundleId, left.assignmentId).localeCompare(rank(bundleId, right.assignmentId)) ||
        left.assignmentId.localeCompare(right.assignmentId)
      );
    const baselinePosition = bundleIndex % bundle.length;
    baselinePositionByBundle[bundleId] = baselinePosition;
    treatments.splice(baselinePosition, 0, baselines[0]!);
    queues.set(bundleId, treatments);
  });
  const assignmentOrder: LabControlledAssignment[] = [];
  const maximumBundleSize = Math.max(...[...queues.values()].map((items) => items.length));
  for (let round = 0; round < maximumBundleSize; round += 1) {
    const rotatedBundles = [
      ...bundleOrder.slice(round % bundleOrder.length),
      ...bundleOrder.slice(0, round % bundleOrder.length)
    ];
    rotatedBundles.forEach((bundleId) => {
      const assignment = queues.get(bundleId)?.[round];
      if (assignment) assignmentOrder.push(assignment);
    });
  }
  const assignmentIds = assignmentOrder.map((item) => item.assignmentId);
  const schedulePayload = {
    version: H1_ASSIGNMENT_ORDER_VERSION,
    seed,
    method: 'SEEDED_BUNDLE_SHUFFLE_BASELINE_POSITION_COUNTERBALANCE_ROUND_ROBIN' as const,
    assignmentIds,
    bundleOrder,
    baselinePositionByBundle
  };
  return {
    ...schedulePayload,
    assignmentOrderSha256: sha256Text(`${stableJson(schedulePayload)}\n`)
  };
}

export async function runControlledExperiment(input: {
  fixtureRoot: string;
  partition: LabCasePartition;
  plan: LabControlledPlan;
  driver: LabTextDriver;
  ledger: LabArtifactLedger;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
}): Promise<ControlledExperimentResult> {
  const experimentStartedMs = Date.now();
  const startedAt = new Date(experimentStartedMs).toISOString();
  const deadlineMs = experimentStartedMs + LAB_CONTROLLED_MAXIMUM_EXPERIMENT_MS;
  const providerEnforcedBoundary =
    input.driver.capabilities.textOnlyProviderEnforced &&
    input.driver.capabilities.hardOutputTokenLimit;
  const harnessVerifiedDevelopmentBoundary =
    input.driver.capabilities.harnessVerifiedTextIsolation === true &&
    input.driver.capabilities.streamingOutputTokenInterrupt === true &&
    input.driver.capabilities.providerReportedTokenUsage === true;
  const missingCapabilities = [
    !providerEnforcedBoundary && !harnessVerifiedDevelopmentBoundary
      ? 'either provider enforcement or the versioned H1 development harness boundary'
      : null,
    !input.driver.capabilities.hardCallTimeLimit ? 'hard per-call wall-time limits' : null
  ].filter((value): value is string => Boolean(value));
  if (missingCapabilities.length > 0) {
    throw new Error(
      `H1 is ineligible because the driver lacks ${missingCapabilities.join(', ')}.`
    );
  }
  if (input.partition === 'CONFIRMATION') {
    throw new Error(
      'H1 confirmation remains sealed; a new preregistration version must explicitly unlock it after development inspection.'
    );
  }
  const validation = await withinH1SetupDeadline(
    validateLabInputs(input.fixtureRoot),
    deadlineMs,
    input.driver,
    'input validation'
  );
  const expectedAssignments = await withinH1SetupDeadline(
    planControlledAssignments(input.fixtureRoot, input.partition),
    deadlineMs,
    input.driver,
    'assignment planning'
  );
  const assignmentSchedule = scheduleControlledAssignments(
    expectedAssignments,
    input.partition
  );
  assertControlledPlan(
    input.plan,
    input.partition,
    validation.locks,
    assignmentSchedule,
    expectedAssignments
  );
  const assignments = input.plan.assignments;
  const waveBudget = input.plan.budget;
  input.ledger.assertSemanticRunContext({
    phase: 'DEVELOPMENT',
    locks: validation.locks,
    driver: {
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
      boundaryClass: providerEnforcedBoundary
        ? 'PROVIDER_ENFORCED_STRICT'
        : 'H1_DEVELOPMENT_HARNESS_VERIFIED',
      harnessVerifiedTextIsolation:
        input.driver.capabilities.harnessVerifiedTextIsolation === true,
      streamingOutputTokenInterrupt:
        input.driver.capabilities.streamingOutputTokenInterrupt === true,
      providerReportedTokenUsage:
        input.driver.capabilities.providerReportedTokenUsage === true
    },
    caseIds: [...new Set(assignments.map((item) => item.caseId))],
    conditionIds: [...new Set(assignments.map((item) => item.conditionId))],
    budgets: {
      maximumCalls: waveBudget.maximumCalls,
      maximumRounds: waveBudget.maximumRoundsPerAssignment,
      maximumOutputTokens:
        waveBudget.maximumCalls * waveBudget.targetOutputTokensPerCall,
      maximumOutputTokenSafetyCeiling:
        waveBudget.maximumCalls * waveBudget.emergencyOutputTokenSafetyCeilingPerCall,
      maximumObservedTotalTokens: waveBudget.maximumObservedTotalTokens,
      maximumCallMs: waveBudget.maximumCallMs,
      maximumExperimentMs: waveBudget.maximumExperimentMs
    }
  });
  const verifiedH0Validation = await withinH1SetupDeadline(
    loadH0ValidationReceipt(
      input.ledger.rootDirectory,
      input.plan.h0Validation.runId,
      validation.locks
    ),
    deadlineMs,
    input.driver,
    'H0 receipt verification'
  );
  if (stableJson(verifiedH0Validation) !== stableJson(input.plan.h0Validation)) {
    throw new Error('Controlled H1 plan lock failed: h0ValidationReceipt.');
  }
  const planArtifact = await withinH1SetupDeadline(
    input.ledger.putArtifact({
      kind: 'CONTROLLED_EXPERIMENT_PLAN',
      plan: input.plan
    }),
    deadlineMs,
    input.driver,
    'plan persistence'
  );
  const h0ValidationArtifact = await withinH1SetupDeadline(
    input.ledger.putArtifact(verifiedH0Validation.report),
    deadlineMs,
    input.driver,
    'H0 evidence persistence'
  );
  if (h0ValidationArtifact.sha256 !== input.plan.h0Validation.reportSha256) {
    throw new Error('Controlled H1 plan lock failed: h0ValidationArtifact.');
  }
  const driverPreflight = await attestSemanticLabDriver(input.driver, {
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier
  }, {
    maximumCallMs: waveBudget.maximumCallMs,
    experimentDeadlineMs: deadlineMs
  }, providerEnforcedBoundary
    ? 'PROVIDER_ENFORCED'
    : 'H1_DEVELOPMENT_HARNESS_VERIFIED');
  const driverAttestationArtifact = await withinH1SetupDeadline(
    input.ledger.putArtifact({
      kind: 'SEMANTIC_DRIVER_ATTESTATION',
      preflight: driverPreflight
    }),
    deadlineMs,
    input.driver,
    'driver attestation persistence'
  );
  await withinH1SetupDeadline(
    input.ledger.append({
      eventType: 'EXECUTION_ELIGIBILITY_ATTESTED',
      occurredAt: new Date().toISOString(),
      artifactSha256: driverAttestationArtifact.sha256,
      detail: {
        planArtifactSha256: planArtifact.sha256,
        h0ValidationRunId: verifiedH0Validation.runId,
        h0ValidationManifestSha256: verifiedH0Validation.manifestSha256,
        h0ValidationArtifactSha256: h0ValidationArtifact.sha256,
        driverId: driverPreflight.driverId,
        model: input.model,
        partition: input.partition
      }
    }),
    deadlineMs,
    input.driver,
    'eligibility persistence'
  );
  const assignmentById = new Map(assignments.map((item) => [item.assignmentId, item]));
  const scheduledAssignments = assignmentSchedule.assignmentIds.map((assignmentId) =>
    assignmentById.get(assignmentId)!
  );
  const participants = await withinH1SetupDeadline(
    loadLabParticipantCorpus(input.fixtureRoot, input.partition),
    deadlineMs,
    input.driver,
    'participant loading'
  );
  const participantByCase = new Map(participants.cases.map((item) => [item.caseId, item]));
  const preparedByAssignment = new Map<
    string,
    { prompt: LabPreparedPrompt; intervention: Awaited<ReturnType<typeof loadLabPublicIntervention>> }
  >();
  for (const assignment of scheduledAssignments) {
    const participantCase = participantByCase.get(assignment.caseId);
    if (!participantCase) throw new Error(`Assignment case is unavailable: ${assignment.caseId}`);
    const intervention = await withinH1SetupDeadline(
      loadLabPublicIntervention(input.fixtureRoot, assignment),
      deadlineMs,
      input.driver,
      `intervention loading for ${assignment.assignmentId}`
    );
    const prompt = materializeInitialLabPrompt({
      participantCase,
      plan: getLabProtocolPlan(assignment.conditionId),
      intervention,
      maximumInputTokensPerCall: waveBudget.maximumPreparedPromptEstimateTokensPerCall
    });
    const stored = await withinH1SetupDeadline(
      input.ledger.putArtifact(prompt.artifact),
      deadlineMs,
      input.driver,
      `prompt persistence for ${assignment.assignmentId}`
    );
    if (stored.sha256 !== prompt.promptArtifactSha256) {
      throw new Error(`Pre-dispatch prompt hash mismatch: ${assignment.assignmentId}`);
    }
    preparedByAssignment.set(assignment.assignmentId, { prompt, intervention });
  }
  if (preparedByAssignment.size !== assignments.length) {
    throw new Error('H1 is ineligible because every assigned prompt was not materialized.');
  }
  const sealedContract = await withinH1SetupDeadline(
    loadSealedH1Contract(input.fixtureRoot),
    deadlineMs,
    input.driver,
    'sealed contract loading'
  );
  const preregistration = controlledPreregistration(
    input,
    scheduledAssignments,
    assignmentSchedule,
    preparedByAssignment,
    sealedContract,
    planArtifact.sha256,
    h0ValidationArtifact.sha256,
    driverAttestationArtifact.sha256,
    driverPreflight
  );
  const preregArtifact = await withinH1SetupDeadline(
    input.ledger.putArtifact({
      kind: 'EXPERIMENT_PREREGISTRATION',
      preregistration
    }),
    deadlineMs,
    input.driver,
    'preregistration persistence'
  );
  await withinH1SetupDeadline(
    input.ledger.append({
      eventType: 'EXPERIMENT_PREREGISTERED',
      occurredAt: new Date().toISOString(),
      artifactSha256: preregArtifact.sha256,
      detail: { hypothesisId: 'H1', partition: input.partition }
    }),
    deadlineMs,
    input.driver,
    'preregistration event persistence'
  );
  // Truth remains unloaded until every participant call below has settled.
  const runRecords: Array<{
    assignment: LabControlledAssignment;
    run: LabProtocolRunResult;
  }> = [];
  let observedTokens = 0;
  let dispatchedAttempts = 0;
  let consecutiveProviderFailures = 0;
  let consecutiveSchemaFailuresAfterRepair = 0;
  let status: ControlledExperimentResult['status'] = 'COMPLETED';
  let stopReason: string | undefined;
  const providerThreadOwner = new Map<string, string>();

  for (const assignment of scheduledAssignments) {
    if (dispatchedAttempts >= waveBudget.maximumCalls) {
      status = 'STOPPED';
      stopReason = 'HARD_CALL_CAP';
      break;
    }
    if (Date.now() >= deadlineMs) {
      status = 'STOPPED';
      stopReason = 'HARD_TIME_CAP';
      break;
    }
    if (observedTokens >= waveBudget.maximumObservedTotalTokens) {
      status = 'STOPPED';
      stopReason = 'HARD_TOKEN_CAP';
      break;
    }
    const participantCase = participantByCase.get(assignment.caseId);
    if (!participantCase) throw new Error(`Assignment case is unavailable: ${assignment.caseId}`);
    const prepared = preparedByAssignment.get(assignment.assignmentId)!;
    const intervention = prepared.intervention;
    const plan = getLabProtocolPlan(assignment.conditionId);
    const run = await runLabProtocol({
      participantCase,
      plan,
      driver: input.driver,
      modelConfiguration: {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier
      },
      limits: {
        maximumCalls: 2,
        maximumRounds: 1,
        maximumInputTokensPerCall: waveBudget.maximumPreparedPromptEstimateTokensPerCall,
        outputTokenSafetyCeilingPerCall:
          waveBudget.emergencyOutputTokenSafetyCeilingPerCall,
        maximumObservedTotalTokens: Math.max(
          1,
          waveBudget.maximumObservedTotalTokens - observedTokens
        ),
        maximumCallMs: waveBudget.maximumCallMs,
        maximumExperimentMs: Math.max(1, deadlineMs - Date.now()),
        maximumConcurrency: 1
      },
      ledger: input.ledger,
      intervention,
      assignmentId: assignment.assignmentId,
      preparedPrompts: [prepared.prompt]
    });
    runRecords.push({ assignment, run });
    dispatchedAttempts += run.realizedBudget.dispatchedCalls;
    if (run.realizedBudget.totalTokens === null) {
      status = 'STOPPED';
      stopReason = 'TOKEN_ACCOUNTING_UNAVAILABLE';
    } else {
      observedTokens += run.realizedBudget.totalTokens;
    }
    const failures = run.callAccounting.flatMap((item) => item.failure ? [item.failure] : []);
    if (failures.some((failure) =>
      failure.kind === 'SETTINGS_MISMATCH' || failure.kind === 'TOOL_CONTEXT_VIOLATION'
    )) {
      status = 'STOPPED';
      stopReason = 'PROVIDER_BOUNDARY_INVALID';
      break;
    }
    if (stopReason === 'TOKEN_ACCOUNTING_UNAVAILABLE') break;
    const sessionIsolationProblem = controlledSessionIsolationProblem(
      assignment.assignmentId,
      run,
      providerThreadOwner
    );
    if (sessionIsolationProblem) {
      status = 'STOPPED';
      stopReason = 'PROVIDER_SESSION_ISOLATION_VIOLATION';
      break;
    }
    const schemaFailed = run.stopReason === 'SCHEMA_FAILURE_AFTER_REPAIR';
    consecutiveSchemaFailuresAfterRepair = schemaFailed
      ? consecutiveSchemaFailuresAfterRepair + 1
      : 0;
    const providerFailed = failures.some((failure) =>
      failure.kind === 'PROVIDER_ERROR' ||
      failure.kind === 'AMBIGUOUS_DELIVERY' ||
      failure.kind === 'INTERRUPT_UNCONFIRMED'
    );
    consecutiveProviderFailures = providerFailed ? consecutiveProviderFailures + 1 : 0;
    if (consecutiveSchemaFailuresAfterRepair > 2) {
      status = 'STOPPED';
      stopReason = 'THREE_CONSECUTIVE_SCHEMA_FAILURES_AFTER_REPAIR';
      break;
    }
    if (consecutiveProviderFailures >= 2) {
      status = 'STOPPED';
      stopReason = 'TWO_CONSECUTIVE_PROVIDER_INFRASTRUCTURE_FAILURES';
      break;
    }
  }

  // Scorer-only truth is loaded only after the participant phase is closed.
  const oracles = await loadLabOracleCorpus(input.fixtureRoot, participants);
  const interventionOracles = await loadLabControlledAssignmentOracles(
    input.fixtureRoot,
    scheduledAssignments
  );
  const oracleByCase = new Map(oracles.map((item) => [item.caseId, item]));
  const interventionOracleByAssignment = new Map(
    interventionOracles.map((item) => [item.assignmentId, item])
  );
  const correctMinorityBundles = new Set(
    scheduledAssignments
      .filter((assignment) =>
        interventionOracleByAssignment.get(assignment.assignmentId)?.treatment ===
        'CORRECT_MINORITY_AGAINST_WRONG_MAJORITY'
      )
      .map((assignment) => assignment.bundleId)
  );
  const runs = runRecords.map(({ assignment, run }) => {
    const participantCase = participantByCase.get(assignment.caseId)!;
    const oracleCase = oracleByCase.get(assignment.caseId)!;
    const interventionOracle = interventionOracleByAssignment.get(assignment.assignmentId)!;
    const intervention = preparedByAssignment.get(assignment.assignmentId)!.intervention;
    const score = scoreLabTrajectory({
      participantCase,
      oracleCase,
      artifacts: run.artifacts,
      initialArtifactIds: run.initialArtifactIds,
      terminalArtifactIds: run.terminalArtifactIds,
      transitionLinks: run.transitionLinks
    });
    return {
      assignment,
      run,
      score,
      domain: oracleCase.domain,
      controlledEvidenceAttribution: scoreControlledEvidenceAttribution(
        run,
        interventionOracle,
        intervention,
        oracleCase
      ),
      correctMinorityEvidence: scoreCorrectMinorityEvidence(
        run,
        score,
        oracleCase,
        correctMinorityBundles.has(assignment.bundleId)
      )
    };
  });
  const assignmentOutcomes = scheduledAssignments.map((assignment) => {
    const settled = runs.find((item) => item.assignment.assignmentId === assignment.assignmentId);
    return {
      assignment: structuredClone(assignment),
      disposition: settled
        ? 'SETTLED' as const
        : 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP' as const,
      runStatus: settled?.run.status ?? null,
      stopReason: settled?.run.stopReason ?? (settled ? null : stopReason ?? 'EXPERIMENT_STOPPED'),
      promptArtifactSha256: preparedByAssignment.get(assignment.assignmentId)!.prompt.promptArtifactSha256
    };
  });
  const perCondition = aggregateConditions(runs, assignmentOutcomes);
  const domainByCase = new Map(oracles.map((item) => [item.caseId, item.domain]));
  const pairedContrasts = buildPairedContrasts(runs, assignmentOutcomes);
  const perDomain = aggregateDomains(runs, assignmentOutcomes, domainByCase);
  const interpretation = interpretControlled(
    pairedContrasts,
    runs,
    scheduledAssignments.length,
    status === 'COMPLETED'
  );
  const completedAt = new Date().toISOString();
  const result: ControlledExperimentResult = {
    schemaVersion: 'task-monki/discourse-lab-h1@v5',
    experimentVersion: H1_EXPERIMENT_VERSION,
    hypothesisId: 'H1',
    partition: input.partition,
    status,
    startedAt,
    completedAt,
    ...(stopReason ? { stopReason } : {}),
    preregistration,
    runs,
    assignmentOutcomes,
    perCondition,
    pairedContrasts,
    perDomain,
    tokenControl: summarizeTokenControl(runs),
    metricQualifications: {
      caseEvidentialSupport: 'CASE_ORACLE_REQUIRED_EVIDENCE_ONLY',
      controlledEvidenceAttribution:
        'VALID_EVIDENCE_TARGET_CLAIM_MUST_BE_CORRECT_AND_CITE_PUBLIC_INTERVENTION_ARTIFACT_ID'
    },
    interpretation
  };
  await input.ledger.writeReport(
    `h1-${input.partition.toLowerCase()}-result`,
    result
  );
  return result;
}

function controlledPreregistration(
  input: {
    partition: LabCasePartition;
    plan: LabControlledPlan;
    driver: LabTextDriver;
    model: string;
    reasoningEffort?: string;
    serviceTier?: string;
  },
  scheduledAssignments: LabControlledAssignment[],
  assignmentSchedule: ControlledAssignmentSchedule,
  prepared: Map<string, { prompt: LabPreparedPrompt }>,
  sealedContract: ControlledExperimentPreregistration['sealedContract'],
  planArtifactSha256: string,
  h0ValidationArtifactSha256: string,
  driverAttestationArtifactSha256: string,
  driverPreflight: LabDriverPreflight
): ControlledExperimentPreregistration {
  const contract = sealedContract.experiment;
  return {
    experimentVersion: H1_EXPERIMENT_VERSION,
    hypothesisId: 'H1',
    partition: input.partition,
    exactHypothesis: contract.exactHypothesis,
    mechanismIsolated: contract.mechanismIsolated,
    supportResult: contract.supportResult,
    rejectResult: contract.rejectResult,
    decisionChanged: contract.decisionChanged,
    executionEligibility: {
      planArtifactSha256,
      h0ValidationRunId: input.plan.h0Validation.runId,
      h0ValidationManifestSha256: input.plan.h0Validation.manifestSha256,
      h0ValidationArtifactSha256,
      driverAttestationArtifactSha256,
      planSchemaVersion: input.plan.schemaVersion,
      planVersion: input.plan.planVersion,
      componentLocks: structuredClone(input.plan.locks),
      boundaryStatus: driverPreflight.boundary.status as 'ATTESTED'
    },
    sealedContract: structuredClone(sealedContract),
    budget: structuredClone(input.plan.budget),
    metrics: [...contract.primaryMetrics, ...contract.secondaryMetrics],
    stoppingConditions: structuredClone(contract.stoppingConditions),
    assignments: structuredClone(scheduledAssignments),
    assignmentSchedule: structuredClone(assignmentSchedule),
    promptArtifacts: scheduledAssignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      callId: prepared.get(assignment.assignmentId)!.prompt.callId,
      sha256: prepared.get(assignment.assignmentId)!.prompt.promptArtifactSha256
    })),
    modelConfiguration: {
      driverId: input.driver.id,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      seed: null,
      seedControl: input.driver.capabilities.samplingSeed ? 'SUPPORTED' : 'UNSUPPORTED',
      hardOutputTokenLimit: input.driver.capabilities.hardOutputTokenLimit,
      hardCallTimeLimit: input.driver.capabilities.hardCallTimeLimit,
      textOnlyProviderEnforced: input.driver.capabilities.textOnlyProviderEnforced,
      harnessVerifiedTextIsolation:
        input.driver.capabilities.harnessVerifiedTextIsolation === true,
      streamingOutputTokenInterrupt:
        input.driver.capabilities.streamingOutputTokenInterrupt === true,
      providerReportedTokenUsage:
        input.driver.capabilities.providerReportedTokenUsage === true,
      boundaryClass:
        input.driver.capabilities.textOnlyProviderEnforced &&
        input.driver.capabilities.hardOutputTokenLimit
          ? 'PROVIDER_ENFORCED_STRICT'
          : 'H1_DEVELOPMENT_HARNESS_VERIFIED'
    }
  };
}

async function loadSealedH1Contract(
  fixtureRoot: string
): Promise<ControlledExperimentPreregistration['sealedContract']> {
  const preregistrationPath = path.join(fixtureRoot, 'preregistration', 'v8.json');
  const sealPath = path.join(fixtureRoot, 'seal-v8.json');
  const [preregistrationText, sealText] = await Promise.all([
    fs.readFile(preregistrationPath, 'utf8'),
    fs.readFile(sealPath, 'utf8')
  ]);
  const preregistration = JSON.parse(preregistrationText) as {
    preregistrationVersion?: unknown;
    componentVersions?: { controlledExperimentVersion?: unknown };
    experiments?: unknown;
  };
  const seal = JSON.parse(sealText) as {
    preregistrationVersion?: unknown;
    files?: Array<{ path?: unknown; sha256?: unknown }>;
  };
  const sourcePath = 'evaluation/discourse-lab/preregistration/v8.json';
  const sealedFile = seal.files?.find((item) => item.path === sourcePath);
  const preregistrationSha256 = sha256Text(preregistrationText);
  if (
    typeof preregistration.preregistrationVersion !== 'string' ||
    preregistration.preregistrationVersion !== seal.preregistrationVersion ||
    preregistration.componentVersions?.controlledExperimentVersion !== H1_EXPERIMENT_VERSION ||
    typeof sealedFile?.sha256 !== 'string' ||
    sealedFile.sha256 !== preregistrationSha256 ||
    !Array.isArray(preregistration.experiments)
  ) {
    throw new Error('H1 sealed preregistration reference is invalid or no longer matches its seal.');
  }
  const h1Entries = preregistration.experiments.filter(
    (item) =>
      Boolean(
        item &&
        typeof item === 'object' &&
        (item as Record<string, unknown>).experimentId === 'H1'
      )
  );
  if (h1Entries.length !== 1 || !isSealedH1ExperimentContract(h1Entries[0])) {
    throw new Error('The sealed preregistration does not contain exactly one valid H1 contract.');
  }
  return {
    preregistrationVersion: preregistration.preregistrationVersion,
    preregistrationSha256,
    sourcePath,
    experiment: structuredClone(h1Entries[0])
  };
}

function isSealedH1ExperimentContract(value: unknown): value is SealedH1ExperimentContract {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const strings = [
    'title',
    'status',
    'exactHypothesis',
    'mechanismIsolated',
    'budgetClass',
    'supportResult',
    'rejectResult',
    'decisionChanged',
    'eligibilityGate'
  ];
  const arrays = [
    'conditions',
    'developmentCases',
    'confirmationCases',
    'primaryMetrics',
    'secondaryMetrics',
    'stoppingConditions'
  ];
  return (
    candidate.experimentId === 'H1' &&
    strings.every((key) => typeof candidate[key] === 'string') &&
    arrays.every(
      (key) =>
        Array.isArray(candidate[key]) &&
        candidate[key].every((item) => typeof item === 'string')
    )
  );
}

function aggregateConditions(
  runs: ControlledExperimentResult['runs'],
  outcomes: ControlledExperimentResult['assignmentOutcomes']
): ControlledConditionSummary[] {
  const conditionIds = [...new Set(outcomes.map((item) => item.assignment.conditionId))].sort();
  return conditionIds.map((conditionId) => {
    const selected = runs.filter((item) => item.assignment.conditionId === conditionId);
    const terminalScores = selected.flatMap((item) =>
      item.score.outputs.filter((score) => item.run.terminalArtifactIds.includes(score.artifactId))
    );
    return {
      conditionId,
      assignments: outcomes.filter((item) => item.assignment.conditionId === conditionId).length,
      startedAssignments: selected.length,
      notStartedAssignments: outcomes.filter(
        (item) =>
          item.assignment.conditionId === conditionId &&
          item.disposition === 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP'
      ).length,
      wrongToRightCorrection: sumRatios(selected.map((item) => item.score.wrongToRightCorrection)),
      rightToWrongContamination: sumRatios(
        selected.map((item) => item.score.rightToWrongContamination)
      ),
      evidentialSupport: sumRatios(terminalScores.map((item) => item.evidentialSupport)),
      evidentialSupportScope: 'CASE_ORACLE_REQUIRED_EVIDENCE_ONLY',
      controlledEvidenceAttribution: sumRatios(
        selected.map((item) => item.controlledEvidenceAttribution)
      ),
      inventedCriticism: sumRatios(terminalScores.map((item) => item.inventedCriticism)),
      disagreementPreservation: sumRatios(
        selected.map((item) => item.score.terminalDisagreementPreservation)
      ),
      abstentions: terminalScores.filter((item) => item.abstained).length,
      dispatchedAttempts: selected.reduce(
        (sum, item) => sum + item.run.realizedBudget.dispatchedCalls,
        0
      ),
      providerTurnsStarted: selected.reduce(
        (sum, item) => sum + item.run.realizedBudget.providerTurnsStarted,
        0
      ),
      billableModelCalls: selected.reduce(
        (sum, item) => sum + item.run.realizedBudget.billableModelCalls,
        0
      ),
      billableModelCallsUnknown: selected.reduce(
        (sum, item) => sum + item.run.realizedBudget.billableModelCallsUnknown,
        0
      ),
      totalTokens: sumNullable(selected.map((item) => item.score.totalTokens)),
      totalLatencyMs: sumNullable(selected.map((item) => item.score.totalLatencyMs)),
      failures: selected.reduce((sum, item) => sum + item.score.failureCount, 0),
      tokenControl: summarizeTokenControl(selected)
    };
  });
}

function buildPairedContrasts(
  runs: ControlledExperimentResult['runs'],
  outcomes: ControlledExperimentResult['assignmentOutcomes']
): ControlledPairedContrast[] {
  const runByAssignment = new Map(
    runs.map((item) => [item.assignment.assignmentId, item])
  );
  const assignmentsByBundle = new Map<string, LabControlledAssignment[]>();
  outcomes.forEach(({ assignment }) => {
    const selected = assignmentsByBundle.get(assignment.bundleId) ?? [];
    selected.push(assignment);
    assignmentsByBundle.set(assignment.bundleId, selected);
  });
  const contrasts: ControlledPairedContrast[] = [];
  [...assignmentsByBundle.entries()].sort(([left], [right]) => left.localeCompare(right))
    .forEach(([bundleId, assignments]) => {
      const baseline = assignments.find(
        (item) => item.conditionId === 'CONTROL_NO_FEEDBACK_B1'
      );
      if (!baseline) return;
      assignments
        .filter((item) => item.assignmentId !== baseline.assignmentId)
        .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId))
        .forEach((treatment) => {
          const baselineRun = runByAssignment.get(baseline.assignmentId);
          const treatmentRun = runByAssignment.get(treatment.assignmentId);
          const reasons: string[] = [];
          if (!baselineRun) reasons.push('BASELINE_NOT_STARTED');
          if (!treatmentRun) reasons.push('TREATMENT_NOT_STARTED');
          if (baselineRun && (baselineRun.run.status !== 'COMPLETED' || baselineRun.score.failureCount > 0)) {
            reasons.push('BASELINE_FAILED');
          }
          if (treatmentRun && (treatmentRun.run.status !== 'COMPLETED' || treatmentRun.score.failureCount > 0)) {
            reasons.push('TREATMENT_FAILED');
          }
          const baselineTerminal = terminalMetricSummary(baselineRun);
          const treatmentTerminal = terminalMetricSummary(treatmentRun);
          contrasts.push({
            bundleId,
            caseId: treatment.caseId,
            domain: treatmentRun?.domain ?? baselineRun?.domain ?? 'unknown',
            baselineAssignmentId: baseline.assignmentId,
            treatmentAssignmentId: treatment.assignmentId,
            treatmentConditionId: treatment.conditionId,
            estimable: reasons.length === 0,
            nonEstimableReasons: reasons,
            wrongToRightCorrection: pairedRatio(
              baselineRun?.score.wrongToRightCorrection,
              treatmentRun?.score.wrongToRightCorrection
            ),
            rightToWrongContamination: pairedRatio(
              baselineRun?.score.rightToWrongContamination,
              treatmentRun?.score.rightToWrongContamination
            ),
            answerCorrectness: pairedRatio(
              baselineTerminal.answerCorrectness,
              treatmentTerminal.answerCorrectness
            ),
            claimCorrectness: pairedRatio(
              baselineTerminal.claimCorrectness,
              treatmentTerminal.claimCorrectness
            ),
            caseEvidentialSupport: pairedRatio(
              baselineTerminal.caseEvidentialSupport,
              treatmentTerminal.caseEvidentialSupport
            ),
            inventedCriticism: pairedRatio(
              baselineTerminal.inventedCriticism,
              treatmentTerminal.inventedCriticism
            ),
            disagreementPreservation: pairedRatio(
              baselineRun?.score.terminalDisagreementPreservation,
              treatmentRun?.score.terminalDisagreementPreservation
            ),
            requiredUserQuestionCoverage: pairedRatio(
              baselineTerminal.requiredUserQuestionCoverage,
              treatmentTerminal.requiredUserQuestionCoverage
            ),
            drift: pairedRatio(baselineTerminal.drift, treatmentTerminal.drift),
            controlledEvidenceAttribution:
              treatmentRun?.controlledEvidenceAttribution ?? emptyRatio(),
            correctMinorityEvidence: pairedBoolean(
              baselineRun?.correctMinorityEvidence.preserved ?? null,
              treatmentRun?.correctMinorityEvidence.preserved ?? null
            )
          });
        });
    });
  return contrasts;
}

function aggregateDomains(
  runs: ControlledExperimentResult['runs'],
  outcomes: ControlledExperimentResult['assignmentOutcomes'],
  domainByCase: ReadonlyMap<string, string>
): ControlledDomainSummary[] {
  return [...new Set(outcomes.map((item) => domainByCase.get(item.assignment.caseId)!))]
    .sort()
    .map((domain) => {
      const selected = runs.filter((item) => item.domain === domain);
      const selectedOutcomes = outcomes.filter(
        (item) => domainByCase.get(item.assignment.caseId) === domain
      );
      const terminalScores = selected.flatMap((item) => terminalScoresFor(item));
      const allScores = selected.flatMap((item) => item.score.outputs);
      return {
        domain,
        assignments: selectedOutcomes.length,
        startedAssignments: selected.length,
        notStartedAssignments: selectedOutcomes.filter(
          (item) => item.disposition === 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP'
        ).length,
        failedAssignments: selected.filter(
          (item) => item.run.status !== 'COMPLETED' || item.score.failureCount > 0
        ).length,
        answerCorrectness: booleanRatio(terminalScores.map((item) => item.answerCorrect)),
        statusAcceptance: booleanRatio(terminalScores.map((item) => item.statusAccepted)),
        claimCorrectness: sumRatios(terminalScores.map((item) => item.claimCorrectness)),
        caseEvidentialSupport: sumRatios(terminalScores.map((item) => item.evidentialSupport)),
        controlledEvidenceAttribution: sumRatios(
          selected.map((item) => item.controlledEvidenceAttribution)
        ),
        wrongToRightCorrection: sumRatios(
          selected.map((item) => item.score.wrongToRightCorrection)
        ),
        rightToWrongContamination: sumRatios(
          selected.map((item) => item.score.rightToWrongContamination)
        ),
        inventedCriticism: sumRatios(terminalScores.map((item) => item.inventedCriticism)),
        sharedErrorDiscovery: sumRatios(selected.map((item) => item.score.sharedErrorDiscovery)),
        correctMinorityPreservation: sumRatios(
          selected.map((item) => item.score.correctMinorityPreservation)
        ),
        disagreementPreservation: sumRatios(
          selected.map((item) => item.score.terminalDisagreementPreservation)
        ),
        requiredUserQuestionCoverage: sumRatios(
          terminalScores.map((item) => item.requiredUserQuestionCoverage)
        ),
        abstention: booleanRatio(terminalScores.map((item) => item.abstained)),
        uncertaintyExpression: booleanRatio(
          terminalScores.map((item) => item.uncertaintyExpressed)
        ),
        drift: sumRatios(terminalScores.map((item) => item.drift)),
        repeatedCriticism: sumRatios(selected.map((item) => item.score.repeatedCriticism)),
        duplicateIssueCount: terminalScores.reduce(
          (sum, item) => sum + item.duplicateIssueCount,
          0
        ),
        dispatchedAttempts: selected.reduce(
          (sum, item) => sum + item.run.realizedBudget.dispatchedCalls,
          0
        ),
        providerTurnsStarted: selected.reduce(
          (sum, item) => sum + item.run.realizedBudget.providerTurnsStarted,
          0
        ),
        billableModelCalls: selected.reduce(
          (sum, item) => sum + item.run.realizedBudget.billableModelCalls,
          0
        ),
        billableModelCallsUnknown: selected.reduce(
          (sum, item) => sum + item.run.realizedBudget.billableModelCallsUnknown,
          0
        ),
        chargedCalls: selected.reduce((sum, item) => sum + item.score.totalChargedCalls, 0),
        totalInputTokens: sumNullable(selected.map((item) => item.score.totalInputTokens)),
        totalOutputTokens: sumNullable(selected.map((item) => item.score.totalOutputTokens)),
        totalReasoningTokens: sumNullable(selected.map((item) => item.score.totalReasoningTokens)),
        totalTokens: sumNullable(selected.map((item) => item.score.totalTokens)),
        totalLatencyMs: sumNullable(selected.map((item) => item.score.totalLatencyMs)),
        failures: selected.reduce((sum, item) => sum + item.score.failureCount, 0),
        invalidAttempts: allScores.reduce((sum, item) => sum + item.invalidAttemptCount, 0),
        repairAttempts: allScores.filter((item) => item.repairAttempted).length,
        repairSuccesses: allScores.filter((item) => item.repairSucceeded).length,
        runStatuses: countStrings(selected.map((item) => item.run.status)),
        stopReasons: countStrings(selected.flatMap((item) => item.run.stopReason ?? [])),
        executionFailuresByKind: countStrings(
          selected.flatMap((item) =>
            item.run.callAccounting.flatMap((call) => call.failure?.kind ?? [])
          )
        ),
        tokenControl: summarizeTokenControl(selected)
      };
    });
}

function summarizeTokenControl(
  runs: ControlledExperimentResult['runs']
): ControlledTokenControlSummary {
  const calls = runs.flatMap((item) => item.run.calls);
  const providerCalls = calls.filter(
    (call) => call.providerAccounting.providerTurnStarted === 'YES'
  );
  const known = providerCalls.filter(
    (call) => call.tokenControl && call.tokenControl.usageStatus !== 'UNAVAILABLE'
  );
  return {
    providerTurns: providerCalls.length,
    usageKnownCalls: known.length,
    usageUnknownCalls: providerCalls.length - known.length,
    providerReportedCalls: known.filter(
      (call) => call.tokenControl?.usageStatus === 'PROVIDER_REPORTED'
    ).length,
    targetOutputOvershootCalls: known.filter(
      (call) => (call.tokenControl?.targetOvershootTokens ?? 0) > 0
    ).length,
    targetOutputOvershootTokens: known.reduce(
      (sum, call) => sum + (call.tokenControl?.targetOvershootTokens ?? 0),
      0
    ),
    safetyOutputOvershootCalls: known.filter(
      (call) => (call.tokenControl?.safetyOvershootTokens ?? 0) > 0
    ).length,
    safetyOutputOvershootTokens: known.reduce(
      (sum, call) => sum + (call.tokenControl?.safetyOvershootTokens ?? 0),
      0
    )
  };
}

export function controlledSessionIsolationProblem(
  assignmentId: string,
  run: LabProtocolRunResult,
  providerThreadOwner: Map<string, string>
): string | undefined {
  const primaryAttempts = run.callAccounting.filter((item) => item.purpose === 'PRIMARY');
  if (primaryAttempts.length !== 1) {
    return `${assignmentId} has ${primaryAttempts.length} primary attempts.`;
  }
  const primary = primaryAttempts[0]!;
  if (!primary.dispatched) return undefined;
  const providerThreadId = primary.providerThreadId;
  if (!primary.failure && (
    !primary.threadStartRequested ||
    primary.threadStartStatus !== 'ATTESTED' ||
    primary.sessionAttestation !== 'ATTESTED' ||
    primary.providerTurnStarted !== 'YES' ||
    !providerThreadId
  )) {
    return `${assignmentId} lacks an attested fresh primary provider session.`;
  }
  if (!providerThreadId) return undefined;
  const priorAssignment = providerThreadOwner.get(providerThreadId);
  if (priorAssignment) {
    return `${assignmentId} reused provider thread ${providerThreadId} from ${priorAssignment}.`;
  }
  providerThreadOwner.set(providerThreadId, assignmentId);
  return undefined;
}

export function interpretControlled(
  contrasts: ControlledPairedContrast[],
  runs: ControlledExperimentResult['runs'],
  assigned: number,
  executionBoundaryValid = true
): ControlledExperimentResult['interpretation'] {
  const failures = runs.reduce((sum, item) => sum + item.score.failureCount, 0);
  const requiredConditions = [
    'CONTROL_VALID_CRITIQUE_B1',
    'CONTROL_EVIDENCE_B1',
    'CONTROL_INVALID_CRITIQUE_B1',
    'CONTROL_CONFIDENT_WRONG_B1',
    'CONTROL_CORRECT_MINORITY_B1'
  ];
  if (
    !executionBoundaryValid ||
    runs.length !== assigned ||
    failures > 0 ||
    contrasts.some((item) => !item.estimable) ||
    requiredConditions.some(
      (conditionId) => !contrasts.some((item) => item.treatmentConditionId === conditionId)
    )
  ) {
    return {
      result: 'NOT_ESTIMABLE',
      learned: ['The paired intervention matrix did not produce a complete failure-free estimate.'],
      unknown: ['Selective correction and contamination direction remain unknown.'],
      harnessDecision: 'Inspect failures and change only the implicated development component before any retry.',
      nextExperiment: 'Repeat H1 development only after the task, prompt, model, metric, or harness failure is identified.'
    };
  }
  const transitionPairs = (
    conditionId: string,
    metric: 'wrongToRightCorrection' | 'rightToWrongContamination'
  ) => {
    const selected = contrasts.filter((item) => item.treatmentConditionId === conditionId);
    return {
      eligible: selected.filter((item) => item[metric].eligible),
      nonEstimable: selected.filter((item) => !item[metric].eligible)
    };
  };
  const validPairs = transitionPairs('CONTROL_VALID_CRITIQUE_B1', 'wrongToRightCorrection');
  const evidenceCorrectionPairs = transitionPairs(
    'CONTROL_EVIDENCE_B1',
    'wrongToRightCorrection'
  );
  const invalidPairs = transitionPairs(
    'CONTROL_INVALID_CRITIQUE_B1',
    'rightToWrongContamination'
  );
  const confidentWrongPairs = transitionPairs(
    'CONTROL_CONFIDENT_WRONG_B1',
    'rightToWrongContamination'
  );
  const directionalPairGroups = [
    {
      label: 'CONTROL_VALID_CRITIQUE_B1:WRONG_TO_RIGHT',
      metric: 'wrongToRightCorrection',
      pairs: validPairs
    },
    {
      label: 'CONTROL_EVIDENCE_B1:WRONG_TO_RIGHT',
      metric: 'wrongToRightCorrection',
      pairs: evidenceCorrectionPairs
    },
    {
      label: 'CONTROL_INVALID_CRITIQUE_B1:RIGHT_TO_WRONG',
      metric: 'rightToWrongContamination',
      pairs: invalidPairs
    },
    {
      label: 'CONTROL_CONFIDENT_WRONG_B1:RIGHT_TO_WRONG',
      metric: 'rightToWrongContamination',
      pairs: confidentWrongPairs
    }
  ] as const;
  const missingDirectionalMetrics = directionalPairGroups
    .filter(({ pairs }) => pairs.eligible.length === 0)
    .map(({ label }) => label);
  const correctnessNotEstimable = contrasts.filter(
    (item) => !item.claimCorrectness.eligible
  );
  if (missingDirectionalMetrics.length > 0 || correctnessNotEstimable.length > 0) {
    return {
      result: 'NOT_ESTIMABLE',
      learned: [
        'Execution completed, but at least one preregistered directional metric or all-pair correctness guard had no eligible observations.'
      ],
      unknown: [
        `Directional metrics without an eligible pair: ${missingDirectionalMetrics.join(', ') || 'none'}.`,
        `Pairs without an estimable claim-correctness guard: ${correctnessNotEstimable.map((item) => item.treatmentAssignmentId).join(', ') || 'none'}.`
      ],
      harnessDecision:
        'Do not interpret absent metric opportunities as zero; revise the development corpus or endpoint definition under a new version.',
      nextExperiment:
        'Repeat H1 development only after every required directional metric has at least one eligible pair and every treatment pair has an estimable correctness guard.'
    };
  }
  const deltas = (
    pairs: { eligible: ControlledPairedContrast[] },
    metric: 'wrongToRightCorrection' | 'rightToWrongContamination'
  ): number[] => pairs.eligible.map((item) => item[metric].delta!);
  const validDeltas = deltas(validPairs, 'wrongToRightCorrection');
  const evidenceDeltas = deltas(evidenceCorrectionPairs, 'wrongToRightCorrection');
  const invalidDeltas = deltas(invalidPairs, 'rightToWrongContamination');
  const confidentWrongDeltas = deltas(confidentWrongPairs, 'rightToWrongContamination');
  const evidencePairs = contrasts.filter(
    (item) => item.treatmentConditionId === 'CONTROL_EVIDENCE_B1'
  );
  const minorityPairs = contrasts.filter(
    (item) => item.treatmentConditionId === 'CONTROL_CORRECT_MINORITY_B1'
  );
  const validImproves = validDeltas.every((value) => value > 0);
  const evidenceImproves = evidenceDeltas.every((value) => value > 0);
  const evidenceAttributed = evidencePairs.length > 0 && evidencePairs.every(
    (item) => item.controlledEvidenceAttribution.rate === 1
  );
  const contaminationBounded = [...invalidDeltas, ...confidentWrongDeltas].every(
    (value) => value <= 0
  );
  const allPairCorrectnessPreserved = contrasts.every(
    (item) => item.claimCorrectness.delta! >= 0
  );
  const absoluteTreatmentCorrectnessPreserved = contrasts.every((item) => {
    const treatment = item.rightToWrongContamination.treatment;
    return treatment.opportunities === 0 || treatment.rate === 0;
  });
  const minorityPreserved = minorityPairs.length > 0 && minorityPairs.every(
    (item) =>
      item.correctMinorityEvidence.baseline === false &&
      item.correctMinorityEvidence.treatment === true &&
      item.correctMinorityEvidence.delta === 1
  );
  const supported =
    validImproves &&
    evidenceImproves &&
    evidenceAttributed &&
    contaminationBounded &&
    allPairCorrectnessPreserved &&
    absoluteTreatmentCorrectnessPreserved &&
    minorityPreserved;
  const contradicted =
    [...invalidDeltas, ...confidentWrongDeltas].some(
      (value) => value > 0
    ) ||
    !allPairCorrectnessPreserved ||
    !absoluteTreatmentCorrectnessPreserved ||
    minorityPairs.some((item) => item.correctMinorityEvidence.treatment === false);
  const transitionEligibility = directionalPairGroups.map(({ label, pairs }) =>
    `${label}=${pairs.eligible.length}/${pairs.eligible.length + pairs.nonEstimable.length}`
  );
  const transitionNonEstimable = directionalPairGroups.flatMap(({ label, metric, pairs }) =>
    pairs.nonEstimable.map(
      (item) =>
        `${label}:${item.treatmentAssignmentId}[${item[metric].nonEstimableReasons.join('+')}]`
    )
  );
  return {
    result: supported
      ? 'DIRECTIONALLY_SUPPORTED'
      : contradicted
        ? 'REJECTED'
        : 'INCONCLUSIVE',
    learned: [
      `Transition metric eligibility (eligible/assigned): ${transitionEligibility.join(', ')}.`,
      `Within-bundle valid-critique correction improved: ${validImproves}.`,
      `Within-bundle evidence correction improved: ${evidenceImproves}.`,
      `Correct target claims attributed the controlled evidence artifact: ${evidenceAttributed}.`,
      `Within-bundle invalid/confident-wrong contamination stayed bounded: ${contaminationBounded}.`,
      `All treatment pairs preserved or improved terminal claim correctness versus their own no-feedback baseline: ${allPairCorrectnessPreserved}.`,
      `Every treatment arm preserved all initially correct claims: ${absoluteTreatmentCorrectnessPreserved}.`,
      `Correct-minority output contained accepted OPEN claims, disagreement, and the required user question: ${minorityPreserved}.`
    ],
    unknown: [
      `Transition endpoints with no eligible opportunities were reported as non-estimable and evaluated only by the all-pair correctness guard: ${transitionNonEstimable.join(', ') || 'none'}.`,
      'Pooled condition rates are descriptive and cannot substitute for the within-bundle contrasts.',
      'This small development set is not powered for a product claim.',
      'Generalization to topology, technical work, repository context, or other model families is unknown.'
    ],
    harnessDecision: supported
      ? 'Freeze this development prompt/schema/metric version only if manual raw-artifact inspection finds no construct failure.'
      : 'Do not open confirmation; inspect raw paired transitions and revise only the implicated development component.',
    nextExperiment: supported
      ? 'After a valid provider with hard text/token controls and confirmation lock is available, run untouched H1 confirmation; H2 remains gated on that signal.'
      : 'Rerun decision-changing H1 development after one documented harness or prompt revision; do not accumulate topology results.'
  };
}

export function scoreControlledEvidenceAttribution(
  run: LabProtocolRunResult,
  interventionOracle: LabControlledAssignmentOracle,
  intervention: Awaited<ReturnType<typeof loadLabPublicIntervention>>,
  oracleCase: LabOracleCase
): LabRatioMetric {
  if (interventionOracle.treatment !== 'VALID_EVIDENCE') return emptyRatio();
  const evidenceArtifactIds = new Set(
    intervention.artifacts.flatMap((artifact) =>
      typeof artifact.artifactId === 'string' ? [artifact.artifactId] : []
    )
  );
  const terminalOutputs = run.terminalArtifactIds.flatMap((artifactId) => {
    const artifact = run.artifacts.find((item) => item.artifactId === artifactId);
    const output = artifact ? acceptedLabOutput(artifact) : undefined;
    return output ? [output] : [];
  });
  let count = 0;
  interventionOracle.targetClaimIds.forEach((propositionId) => {
    const expectation = oracleCase.propositionExpectations.find(
      (item) => item.propositionId === propositionId
    );
    if (!expectation) {
      throw new Error(`Controlled evidence targets unscored proposition ${propositionId}.`);
    }
    if (terminalOutputs.some((output) => {
      const claim = output.claims.find((item) => item.propositionId === propositionId);
      return Boolean(
        claim &&
        stanceIsCorrect(claim.stance, expectation) &&
        claim.evidence.some((reference) => evidenceArtifactIds.has(reference.evidenceId))
      );
    })) count += 1;
  });
  return ratio(count, interventionOracle.targetClaimIds.length);
}

export function scoreCorrectMinorityEvidence(
  run: LabProtocolRunResult,
  score: LabTrajectoryScore,
  oracleCase: LabOracleCase,
  isCorrectMinorityBundle: boolean
): ControlledMinorityEvidence {
  if (!isCorrectMinorityBundle) {
    return {
      acceptedOpenClaims: emptyRatio(),
      acceptedStatus: emptyRatio(),
      disagreementPreservation: emptyRatio(),
      requiredUserQuestionCoverage: emptyRatio(),
      preserved: null
    };
  }
  const terminalArtifacts = run.terminalArtifactIds.flatMap((artifactId) => {
    const artifact = run.artifacts.find((item) => item.artifactId === artifactId);
    return artifact ? [artifact] : [];
  });
  const terminalOutputs = terminalArtifacts.flatMap((artifact) => {
    const output = acceptedLabOutput(artifact);
    return output ? [output] : [];
  });
  const terminalScores = score.outputs.filter((item) =>
    run.terminalArtifactIds.includes(item.artifactId)
  );
  const openExpectations = oracleCase.propositionExpectations.filter(
    (item) => item.acceptableStances.includes('OPEN')
  );
  const acceptedOpenClaims = ratio(
    openExpectations.filter((expectation) =>
      terminalOutputs.some((output) =>
        output.claims.some(
          (claim) =>
            claim.propositionId === expectation.propositionId && claim.stance === 'OPEN'
        )
      )
    ).length,
    openExpectations.length
  );
  const acceptedStatus = booleanRatio(terminalScores.map((item) => item.statusAccepted));
  const disagreementPreservation = sumRatios(
    terminalScores.map((item) => item.disagreementPreservation)
  );
  const requiredUserQuestionCoverage = sumRatios(
    terminalScores.map((item) => item.requiredUserQuestionCoverage)
  );
  const required = [
    acceptedOpenClaims,
    acceptedStatus,
    disagreementPreservation,
    requiredUserQuestionCoverage
  ];
  return {
    acceptedOpenClaims,
    acceptedStatus,
    disagreementPreservation,
    requiredUserQuestionCoverage,
    preserved: required.every(
      (metric) => metric.opportunities > 0 && metric.rate === 1
    )
  };
}

function terminalScoresFor(
  run: ControlledExperimentResult['runs'][number]
): LabOutputScore[] {
  return run.score.outputs.filter((score) =>
    run.run.terminalArtifactIds.includes(score.artifactId)
  );
}

function terminalMetricSummary(run: ControlledExperimentResult['runs'][number] | undefined) {
  const scores = run ? terminalScoresFor(run) : [];
  return {
    answerCorrectness: booleanRatio(scores.map((item) => item.answerCorrect)),
    claimCorrectness: sumRatios(scores.map((item) => item.claimCorrectness)),
    caseEvidentialSupport: sumRatios(scores.map((item) => item.evidentialSupport)),
    inventedCriticism: sumRatios(scores.map((item) => item.inventedCriticism)),
    requiredUserQuestionCoverage: sumRatios(
      scores.map((item) => item.requiredUserQuestionCoverage)
    ),
    drift: sumRatios(scores.map((item) => item.drift))
  };
}

export function pairedRatio(
  baseline: LabRatioMetric | undefined,
  treatment: LabRatioMetric | undefined
): ControlledPairedRatioContrast {
  const left = baseline ?? emptyRatio();
  const right = treatment ?? emptyRatio();
  const nonEstimableReasons: ControlledPairedRatioContrast['nonEstimableReasons'] = [];
  if (!baseline) nonEstimableReasons.push('BASELINE_METRIC_UNAVAILABLE');
  else if (baseline.opportunities === 0) {
    nonEstimableReasons.push('BASELINE_HAS_NO_ELIGIBLE_OPPORTUNITIES');
  }
  if (!treatment) nonEstimableReasons.push('TREATMENT_METRIC_UNAVAILABLE');
  else if (treatment.opportunities === 0) {
    nonEstimableReasons.push('TREATMENT_HAS_NO_ELIGIBLE_OPPORTUNITIES');
  }
  return {
    baseline: left,
    treatment: right,
    delta: left.rate === null || right.rate === null ? null : right.rate - left.rate,
    eligible: nonEstimableReasons.length === 0,
    nonEstimableReasons
  };
}

function pairedBoolean(baseline: boolean | null, treatment: boolean | null) {
  return {
    baseline,
    treatment,
    delta: baseline === null || treatment === null
      ? null
      : Number(treatment) - Number(baseline)
  };
}

function booleanRatio(values: Array<boolean | null>): LabRatioMetric {
  const observed = values.filter((value): value is boolean => value !== null);
  return ratio(observed.filter(Boolean).length, observed.length);
}

function emptyRatio(): LabRatioMetric {
  return ratio(0, 0);
}

function ratio(count: number, opportunities: number): LabRatioMetric {
  return { count, opportunities, rate: opportunities === 0 ? null : count / opportunities };
}

function countStrings(values: string[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [
      value,
      values.filter((candidate) => candidate === value).length
    ])
  );
}

function sumRatios(values: LabRatioMetric[]): LabRatioMetric {
  const count = values.reduce((sum, item) => sum + item.count, 0);
  const opportunities = values.reduce((sum, item) => sum + item.opportunities, 0);
  return { count, opportunities, rate: opportunities === 0 ? null : count / opportunities };
}

function sumNullable(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : (values as number[]).reduce((sum, value) => sum + value, 0);
}

async function withinH1SetupDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  driver: LabTextDriver,
  stage: string
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    closeDriverWithoutWaiting(driver);
    throw new Error(`H1 exhausted its total time budget during ${stage}.`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          closeDriverWithoutWaiting(driver);
          reject(new Error(`H1 exhausted its total time budget during ${stage}.`));
        }, remainingMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeDriverWithoutWaiting(driver: LabTextDriver): void {
  try {
    void driver.close().catch(() => undefined);
  } catch {
    // A broken close path must not extend or mask the hard experiment timeout.
  }
}
