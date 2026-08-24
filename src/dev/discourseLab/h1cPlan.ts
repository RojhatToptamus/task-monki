import { sha256Text, stableJson, type LabComponentLock } from './ledger';
import type { H1cConditionId, H1cStratum } from './h1cCorpus';

export const H1C_PLAN_SCHEMA_VERSION = 'task-monki/discourse-lab-h1c-plan@v3' as const;
export const H1C_PLAN_VERSION = 'h1c-assay-plan@v3' as const;
export const H1C_SCHEDULE_VERSION = 'h1c-yoked-counterbalanced-schedule@v3' as const;

export interface H1cH0Receipt {
  runId: string;
  manifestSha256: string;
  reportSha256: string;
  report: {
    schemaVersion: 'task-monki/discourse-lab-h1c-h0@v3';
    validationVersion: 'h1c-h0-validation@v3';
    hypothesisId: 'H0-H1C';
    status: 'PASSED';
    componentLocks: LabComponentLock;
    promptTemplateSetSha256: string;
    checks: Array<{ checkId: string; status: 'PASSED'; detail: string }>;
  };
}

export interface H1cAssignment {
  assignmentId: string;
  blockId: string;
  caseId: string;
  stratum: H1cStratum;
  repetition: 1 | 2;
  serialPosition: number;
  conditionId: H1cConditionId;
  threadMode: 'FRESH' | 'CONTINUE_INITIAL';
}

export interface H1cSchedule {
  version: typeof H1C_SCHEDULE_VERSION;
  method: 'INTERLEAVED_CASE_REPETITION_BLOCKS_WITH_COUNTERBALANCED_RESPONSE_ORDER';
  blockIds: string[];
  assignmentIds: string[];
  scheduleSha256: string;
}

export interface H1cPlan {
  schemaVersion: typeof H1C_PLAN_SCHEMA_VERSION;
  planVersion: typeof H1C_PLAN_VERSION;
  createdAt: string;
  partition: 'DEVELOPMENT';
  confirmationOpened: false;
  locks: LabComponentLock;
  h0Validation: H1cH0Receipt;
  schedule: H1cSchedule;
  assignments: H1cAssignment[];
  model: {
    id: 'gpt-5.6-sol';
    reasoningEffort: 'high';
    serviceTier: 'default';
    samplingSeed: null;
  };
  budget: {
    maximumPrimaryCalls: 28;
    maximumSchemaRepairCalls: 0;
    maximumCalls: 28;
    maximumRoundsPerBlock: 2;
    maximumPreparedPromptEstimateTokensPerCall: 7_000;
    targetOutputTokensPerCall: 900;
    emergencyOutputTokenSafetyCeilingPerCall: 25_000;
    maximumObservedTotalTokens: 300_000;
    maximumCallMs: 120_000;
    maximumExperimentMs: 2_400_000;
    aggregateStopPolicy: 'BETWEEN_COMPLETE_BLOCKS_RETAIN_THRESHOLD_CROSSING_BLOCK';
  };
  analysis: {
    unit: 'LIVE_DRAFT_CASE_REPETITION_BLOCK';
    repetitionsPerCase: 2;
    sharedLiveInitialWithinBlock: true;
    selfReviewUsesExactInitialThread: true;
    critiqueAndEvidenceResponsesUseFreshThreads: true;
    schemaRepairPolicy: 'NONE_RETAIN_INVALID_PRIMARY';
    generatedSignalCostIncluded: false;
    realizedTokensUsedForSelection: false;
    minorityPreservationEstimable: false;
  };
}

const BLOCK_ORDER = [
  ['H1C-D5', 1],
  ['H1C-E5', 1],
  ['H1C-D6', 1],
  ['H1C-E6', 1],
  ['H1C-D5', 2],
  ['H1C-E6', 2],
  ['H1C-D6', 2],
  ['H1C-E5', 2]
] as const;

const RESPONSE_ORDER: Record<string, H1cConditionId[]> = {
  'H1C-D5:r1': ['ACTIVE_SELF_REVIEW', 'VALID_CRITIQUE', 'PLACEBO_CRITIQUE'],
  'H1C-D6:r1': ['VALID_CRITIQUE', 'PLACEBO_CRITIQUE', 'ACTIVE_SELF_REVIEW'],
  'H1C-D5:r2': ['PLACEBO_CRITIQUE', 'ACTIVE_SELF_REVIEW', 'VALID_CRITIQUE'],
  'H1C-D6:r2': ['ACTIVE_SELF_REVIEW', 'PLACEBO_CRITIQUE', 'VALID_CRITIQUE'],
  'H1C-E5:r1': ['ACTIVE_SELF_REVIEW', 'DECISIVE_EVIDENCE'],
  'H1C-E6:r1': ['DECISIVE_EVIDENCE', 'ACTIVE_SELF_REVIEW'],
  'H1C-E5:r2': ['DECISIVE_EVIDENCE', 'ACTIVE_SELF_REVIEW'],
  'H1C-E6:r2': ['ACTIVE_SELF_REVIEW', 'DECISIVE_EVIDENCE']
};

export function scheduleH1cAssignments(
  cases: ReadonlyArray<{ caseId: string; stratum: H1cStratum }>
): { schedule: H1cSchedule; assignments: H1cAssignment[] } {
  const expected = new Map(cases.map((item) => [item.caseId, item.stratum]));
  if (
    expected.size !== 4 ||
    ['H1C-D5', 'H1C-D6'].some((id) => expected.get(id) !== 'DERIVABLE_CRITIQUE') ||
    ['H1C-E5', 'H1C-E6'].some((id) => expected.get(id) !== 'NEW_EVIDENCE')
  ) {
    throw new Error('H1c schedule requires the exact four sealed development cases.');
  }
  const assignments: H1cAssignment[] = [];
  for (const [caseId, repetition] of BLOCK_ORDER) {
    const blockId = `${caseId}:r${repetition}`;
    const stratum = expected.get(caseId)!;
    const conditions = ['STRONG_INITIAL', ...RESPONSE_ORDER[blockId]!] as H1cConditionId[];
    conditions.forEach((conditionId, index) => {
      assignments.push({
        assignmentId: `${blockId}:${conditionId}`,
        blockId,
        caseId,
        stratum,
        repetition,
        serialPosition: index + 1,
        conditionId,
        threadMode: conditionId === 'ACTIVE_SELF_REVIEW' ? 'CONTINUE_INITIAL' : 'FRESH'
      });
    });
  }
  const payload = {
    version: H1C_SCHEDULE_VERSION,
    method: 'INTERLEAVED_CASE_REPETITION_BLOCKS_WITH_COUNTERBALANCED_RESPONSE_ORDER' as const,
    blockIds: BLOCK_ORDER.map(([caseId, repetition]) => `${caseId}:r${repetition}`),
    assignmentIds: assignments.map((assignment) => assignment.assignmentId)
  };
  return {
    schedule: {
      ...payload,
      scheduleSha256: sha256Text(`${stableJson(payload)}\n`)
    },
    assignments
  };
}

export function buildH1cPlan(input: {
  cases: ReadonlyArray<{ caseId: string; stratum: H1cStratum }>;
  locks: LabComponentLock;
  h0Validation: H1cH0Receipt;
  createdAt?: string;
}): H1cPlan {
  const { schedule, assignments } = scheduleH1cAssignments(input.cases);
  const plan: H1cPlan = {
    schemaVersion: H1C_PLAN_SCHEMA_VERSION,
    planVersion: H1C_PLAN_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    partition: 'DEVELOPMENT',
    confirmationOpened: false,
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
      maximumPrimaryCalls: 28,
      maximumSchemaRepairCalls: 0,
      maximumCalls: 28,
      maximumRoundsPerBlock: 2,
      maximumPreparedPromptEstimateTokensPerCall: 7_000,
      targetOutputTokensPerCall: 900,
      emergencyOutputTokenSafetyCeilingPerCall: 25_000,
      maximumObservedTotalTokens: 300_000,
      maximumCallMs: 120_000,
      maximumExperimentMs: 2_400_000,
      aggregateStopPolicy: 'BETWEEN_COMPLETE_BLOCKS_RETAIN_THRESHOLD_CROSSING_BLOCK'
    },
    analysis: {
      unit: 'LIVE_DRAFT_CASE_REPETITION_BLOCK',
      repetitionsPerCase: 2,
      sharedLiveInitialWithinBlock: true,
      selfReviewUsesExactInitialThread: true,
      critiqueAndEvidenceResponsesUseFreshThreads: true,
      schemaRepairPolicy: 'NONE_RETAIN_INVALID_PRIMARY',
      generatedSignalCostIncluded: false,
      realizedTokensUsedForSelection: false,
      minorityPreservationEstimable: false
    }
  };
  assertH1cPlan(plan, input.cases, input.locks);
  return plan;
}

export function assertH1cPlan(
  plan: H1cPlan,
  cases: ReadonlyArray<{ caseId: string; stratum: H1cStratum }>,
  locks: LabComponentLock
): void {
  const expected = scheduleH1cAssignments(cases);
  const problems: string[] = [];
  if (plan.schemaVersion !== H1C_PLAN_SCHEMA_VERSION) problems.push('schemaVersion');
  if (plan.planVersion !== H1C_PLAN_VERSION) problems.push('planVersion');
  if (!Number.isFinite(Date.parse(plan.createdAt))) problems.push('createdAt');
  if (plan.partition !== 'DEVELOPMENT' || plan.confirmationOpened) problems.push('partition');
  if (stableJson(plan.locks) !== stableJson(locks)) problems.push('locks');
  if (stableJson(plan.schedule) !== stableJson(expected.schedule)) problems.push('schedule');
  if (stableJson(plan.assignments) !== stableJson(expected.assignments)) problems.push('assignments');
  if (stableJson(plan.model) !== stableJson({
    id: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'default', samplingSeed: null
  })) problems.push('model');
  if (stableJson(plan.budget) !== stableJson({
    maximumPrimaryCalls: 28,
    maximumSchemaRepairCalls: 0,
    maximumCalls: 28,
    maximumRoundsPerBlock: 2,
    maximumPreparedPromptEstimateTokensPerCall: 7_000,
    targetOutputTokensPerCall: 900,
    emergencyOutputTokenSafetyCeilingPerCall: 25_000,
    maximumObservedTotalTokens: 300_000,
    maximumCallMs: 120_000,
    maximumExperimentMs: 2_400_000,
    aggregateStopPolicy: 'BETWEEN_COMPLETE_BLOCKS_RETAIN_THRESHOLD_CROSSING_BLOCK'
  })) problems.push('budget');
  if (stableJson(plan.analysis) !== stableJson({
    unit: 'LIVE_DRAFT_CASE_REPETITION_BLOCK',
    repetitionsPerCase: 2,
    sharedLiveInitialWithinBlock: true,
    selfReviewUsesExactInitialThread: true,
    critiqueAndEvidenceResponsesUseFreshThreads: true,
    schemaRepairPolicy: 'NONE_RETAIN_INVALID_PRIMARY',
    generatedSignalCostIncluded: false,
    realizedTokensUsedForSelection: false,
    minorityPreservationEstimable: false
  })) problems.push('analysis');
  if (
    !plan.h0Validation.runId ||
    !/^[a-f0-9]{64}$/u.test(plan.h0Validation.manifestSha256) ||
    !/^[a-f0-9]{64}$/u.test(plan.h0Validation.reportSha256) ||
    plan.h0Validation.report.schemaVersion !== 'task-monki/discourse-lab-h1c-h0@v3' ||
    plan.h0Validation.report.validationVersion !== 'h1c-h0-validation@v3' ||
    plan.h0Validation.report.hypothesisId !== 'H0-H1C' ||
    plan.h0Validation.report.status !== 'PASSED' ||
    stableJson(plan.h0Validation.report.componentLocks) !== stableJson(locks) ||
    !/^[a-f0-9]{64}$/u.test(plan.h0Validation.report.promptTemplateSetSha256)
  ) problems.push('h0Validation');
  if (plan.assignments.length !== 28 || plan.schedule.blockIds.length !== 8) {
    problems.push('matrix');
  }
  if (problems.length > 0) {
    throw new Error(`H1c plan does not match the sealed design: ${problems.join(', ')}.`);
  }
}
