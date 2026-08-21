import { sha256Text, stableJson, type LabComponentLock } from './ledger';
import type { LabConditionId } from './protocols';

export const H1B_PLAN_SCHEMA_VERSION = 'task-monki/discourse-lab-h1b-plan@v1' as const;
export const H1B_PLAN_VERSION = 'h1b-mechanism-plan@v1' as const;
export const H1B_ASSIGNMENT_ORDER_VERSION = 'h1b-latin-block-order@v1' as const;
export const H1B_ASSIGNMENT_ORDER_SEED = 1_517_231_987 as const;

export type H1bStratum = 'DERIVABLE_CRITIQUE' | 'NEW_EVIDENCE';
export type H1bConditionId = Extract<
  LabConditionId,
  | 'CONTROL_CASE_ONLY_B1'
  | 'CONTROL_NO_FEEDBACK_B1'
  | 'CONTROL_VALID_CRITIQUE_B1'
  | 'CONTROL_EVIDENCE_B1'
>;

export interface H1bSchedulableCase {
  caseId: string;
  stratum: H1bStratum;
}

export interface H1bAssignment {
  assignmentId: string;
  blockId: string;
  caseId: string;
  stratum: H1bStratum;
  repetition: 1 | 2 | 3;
  position: 1 | 2 | 3;
  conditionId: H1bConditionId;
}

export interface H1bAssignmentSchedule {
  version: typeof H1B_ASSIGNMENT_ORDER_VERSION;
  seed: typeof H1B_ASSIGNMENT_ORDER_SEED;
  method: 'SEEDED_STRATUM_INTERLEAVED_BLOCKS_WITHIN_CASE_LATIN_ROTATION';
  blockIds: string[];
  assignmentIds: string[];
  assignmentOrderSha256: string;
}

export interface H1bH0ValidationReceipt {
  runId: string;
  manifestSha256: string;
  reportSha256: string;
  report: {
    schemaVersion: 'task-monki/discourse-lab-h1b-h0@v1';
    validationVersion: 'h1b-h0-validation@v1';
    hypothesisId: 'H0-H1B';
    status: 'PASSED';
    componentLocks: LabComponentLock;
    checks: Array<{ checkId: string; status: 'PASSED'; detail: string }>;
  };
}

export interface H1bPlan {
  schemaVersion: typeof H1B_PLAN_SCHEMA_VERSION;
  planVersion: typeof H1B_PLAN_VERSION;
  createdAt: string;
  partition: 'DEVELOPMENT';
  locks: LabComponentLock;
  h0Validation: H1bH0ValidationReceipt;
  schedule: H1bAssignmentSchedule;
  assignments: H1bAssignment[];
  model: {
    id: 'gpt-5.6-sol';
    reasoningEffort: 'high';
    serviceTier: 'default';
    samplingSeed: null;
  };
  budget: {
    maximumPrimaryCalls: 54;
    maximumSchemaRepairCalls: 0;
    maximumCalls: 54;
    maximumRoundsPerAssignment: 1;
    maximumPreparedPromptEstimateTokensPerCall: 7_000;
    targetOutputTokensPerCall: 900;
    emergencyOutputTokenSafetyCeilingPerCall: 25_000;
    maximumObservedTotalTokens: 600_000;
    aggregateStopPolicy: 'BETWEEN_COMPLETE_BLOCKS_RETAIN_THRESHOLD_CROSSING_BLOCK';
    usageAccounting: 'RETROSPECTIVE_PROVIDER_REPORTED_AFTER_ATTEMPT';
    maximumCallMs: 120_000;
    maximumExperimentMs: 7_200_000;
  };
  analysis: {
    unit: 'CASE_REPETITION_BLOCK';
    repetitionsPerCell: 3;
    schemaRepairPolicy: 'NONE_RETAIN_INVALID_PRIMARY';
    realizedTokensUsedForSelection: false;
    incompleteBlocksPrimaryAnalysis: 'EXCLUDED_FROM_BLOCKED_CONTRAST_RETAINED_IN_REPORT';
    confirmationOpened: false;
  };
}

const STRONG: H1bConditionId = 'CONTROL_CASE_ONLY_B1';
const REASSESS: H1bConditionId = 'CONTROL_NO_FEEDBACK_B1';

export function scheduleH1bAssignments(
  cases: readonly H1bSchedulableCase[]
): { schedule: H1bAssignmentSchedule; assignments: H1bAssignment[] } {
  assertCaseMatrix(cases);
  const canonical = [...cases].sort((left, right) => left.caseId.localeCompare(right.caseId));
  const blocks = canonical.flatMap((item) => ([1, 2, 3] as const).map((repetition) => ({
    blockId: `${item.caseId}:r${repetition}`,
    caseId: item.caseId,
    stratum: item.stratum,
    repetition
  })));
  const ranked = (scope: string, id: string) =>
    sha256Text(`${H1B_ASSIGNMENT_ORDER_VERSION}:${H1B_ASSIGNMENT_ORDER_SEED}:${scope}:${id}`);
  const queue = (stratum: H1bStratum) => blocks
    .filter((block) => block.stratum === stratum)
    .sort((left, right) =>
      ranked(stratum, left.blockId).localeCompare(ranked(stratum, right.blockId)) ||
      left.blockId.localeCompare(right.blockId)
    );
  const derivable = queue('DERIVABLE_CRITIQUE');
  const evidence = queue('NEW_EVIDENCE');
  const orderedBlocks = derivable.flatMap((block, index) => [block, evidence[index]!]);
  const assignments = orderedBlocks.flatMap((block) => {
    const treatment: H1bConditionId = block.stratum === 'DERIVABLE_CRITIQUE'
      ? 'CONTROL_VALID_CRITIQUE_B1'
      : 'CONTROL_EVIDENCE_B1';
    const orders: Record<1 | 2 | 3, H1bConditionId[]> = {
      1: [STRONG, REASSESS, treatment],
      2: [REASSESS, treatment, STRONG],
      3: [treatment, STRONG, REASSESS]
    };
    return orders[block.repetition].map((conditionId, index): H1bAssignment => ({
      assignmentId: `${block.blockId}:${conditionId}`,
      blockId: block.blockId,
      caseId: block.caseId,
      stratum: block.stratum,
      repetition: block.repetition,
      position: (index + 1) as 1 | 2 | 3,
      conditionId
    }));
  });
  const payload = {
    version: H1B_ASSIGNMENT_ORDER_VERSION,
    seed: H1B_ASSIGNMENT_ORDER_SEED,
    method: 'SEEDED_STRATUM_INTERLEAVED_BLOCKS_WITHIN_CASE_LATIN_ROTATION' as const,
    blockIds: orderedBlocks.map((block) => block.blockId),
    assignmentIds: assignments.map((assignment) => assignment.assignmentId)
  };
  return {
    schedule: {
      ...payload,
      assignmentOrderSha256: sha256Text(`${stableJson(payload)}\n`)
    },
    assignments
  };
}

export function buildH1bPlan(input: {
  cases: readonly H1bSchedulableCase[];
  locks: LabComponentLock;
  h0Validation: H1bH0ValidationReceipt;
  createdAt?: string;
}): H1bPlan {
  const { schedule, assignments } = scheduleH1bAssignments(input.cases);
  const plan: H1bPlan = {
    schemaVersion: H1B_PLAN_SCHEMA_VERSION,
    planVersion: H1B_PLAN_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    partition: 'DEVELOPMENT',
    locks: structuredClone(input.locks),
    h0Validation: structuredClone(input.h0Validation),
    schedule,
    assignments,
    model: {
      id: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'default',
      samplingSeed: null
    },
    budget: {
      maximumPrimaryCalls: 54,
      maximumSchemaRepairCalls: 0,
      maximumCalls: 54,
      maximumRoundsPerAssignment: 1,
      maximumPreparedPromptEstimateTokensPerCall: 7_000,
      targetOutputTokensPerCall: 900,
      emergencyOutputTokenSafetyCeilingPerCall: 25_000,
      maximumObservedTotalTokens: 600_000,
      aggregateStopPolicy: 'BETWEEN_COMPLETE_BLOCKS_RETAIN_THRESHOLD_CROSSING_BLOCK',
      usageAccounting: 'RETROSPECTIVE_PROVIDER_REPORTED_AFTER_ATTEMPT',
      maximumCallMs: 120_000,
      maximumExperimentMs: 7_200_000
    },
    analysis: {
      unit: 'CASE_REPETITION_BLOCK',
      repetitionsPerCell: 3,
      schemaRepairPolicy: 'NONE_RETAIN_INVALID_PRIMARY',
      realizedTokensUsedForSelection: false,
      incompleteBlocksPrimaryAnalysis: 'EXCLUDED_FROM_BLOCKED_CONTRAST_RETAINED_IN_REPORT',
      confirmationOpened: false
    }
  };
  assertH1bPlan(plan, input.cases, input.locks);
  return plan;
}

export function assertH1bPlan(
  plan: H1bPlan,
  cases: readonly H1bSchedulableCase[],
  locks: LabComponentLock
): void {
  const expected = scheduleH1bAssignments(cases);
  const problems: string[] = [];
  if (plan.schemaVersion !== H1B_PLAN_SCHEMA_VERSION) problems.push('schemaVersion');
  if (plan.planVersion !== H1B_PLAN_VERSION) problems.push('planVersion');
  if (!Number.isFinite(Date.parse(plan.createdAt))) problems.push('createdAt');
  if (plan.partition !== 'DEVELOPMENT') problems.push('partition');
  if (stableJson(plan.locks) !== stableJson(locks)) problems.push('locks');
  if (stableJson(plan.schedule) !== stableJson(expected.schedule)) problems.push('schedule');
  if (stableJson(plan.assignments) !== stableJson(expected.assignments)) problems.push('assignments');
  if (stableJson(plan.model) !== stableJson({
    id: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'default', samplingSeed: null
  })) problems.push('model');
  if (stableJson(plan.budget) !== stableJson(buildH1bPlanBudget())) problems.push('budget');
  if (
    plan.analysis.unit !== 'CASE_REPETITION_BLOCK' ||
    plan.analysis.repetitionsPerCell !== 3 ||
    plan.analysis.schemaRepairPolicy !== 'NONE_RETAIN_INVALID_PRIMARY' ||
    plan.analysis.realizedTokensUsedForSelection ||
    plan.analysis.confirmationOpened
  ) problems.push('analysis');
  if (stableJson(plan.h0Validation.report.componentLocks) !== stableJson(locks)) {
    problems.push('h0Locks');
  }
  if (
    plan.h0Validation.report.status !== 'PASSED' ||
    plan.h0Validation.report.checks.length === 0 ||
    plan.h0Validation.report.checks.some((check) => check.status !== 'PASSED')
  ) problems.push('h0Status');
  if (problems.length > 0) {
    throw new Error(`H1b plan lock failed: ${[...new Set(problems)].join(', ')}.`);
  }
}

export function buildH1bPlanBudget(): H1bPlan['budget'] {
  return {
    maximumPrimaryCalls: 54,
    maximumSchemaRepairCalls: 0,
    maximumCalls: 54,
    maximumRoundsPerAssignment: 1,
    maximumPreparedPromptEstimateTokensPerCall: 7_000,
    targetOutputTokensPerCall: 900,
    emergencyOutputTokenSafetyCeilingPerCall: 25_000,
    maximumObservedTotalTokens: 600_000,
    aggregateStopPolicy: 'BETWEEN_COMPLETE_BLOCKS_RETAIN_THRESHOLD_CROSSING_BLOCK',
    usageAccounting: 'RETROSPECTIVE_PROVIDER_REPORTED_AFTER_ATTEMPT',
    maximumCallMs: 120_000,
    maximumExperimentMs: 7_200_000
  };
}

function assertCaseMatrix(cases: readonly H1bSchedulableCase[]): void {
  const ids = cases.map((item) => item.caseId);
  const counts = (stratum: H1bStratum) => cases.filter((item) => item.stratum === stratum).length;
  if (
    cases.length !== 6 ||
    new Set(ids).size !== 6 ||
    counts('DERIVABLE_CRITIQUE') !== 3 ||
    counts('NEW_EVIDENCE') !== 3
  ) {
    throw new Error('H1b requires six unique cases: three derivable and three new-evidence cases.');
  }
}
