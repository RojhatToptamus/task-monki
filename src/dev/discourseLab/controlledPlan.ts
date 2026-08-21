import fs from 'node:fs/promises';
import path from 'node:path';
import type { LabCasePartition } from './contracts';
import type { LabControlledAssignment } from './corpus';
import type { LabHarnessValidationReport } from './harnessValidation';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  sha256Text,
  stableJson,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';

export const LAB_CONTROLLED_PLAN_SCHEMA_VERSION =
  'task-monki/discourse-lab-controlled-plan@v6' as const;
export const LAB_CONTROLLED_PLAN_VERSION = 'h1-controlled-plan@v6' as const;
export const LAB_CONTROLLED_ASSIGNMENT_ORDER_VERSION =
  'sealed-counterbalanced-order@v1' as const;
export const LAB_CONTROLLED_MAXIMUM_EXPERIMENT_MS = 1_200_000 as const;

export interface LabControlledAssignmentSchedule {
  version: typeof LAB_CONTROLLED_ASSIGNMENT_ORDER_VERSION;
  seed: number;
  method: 'SEEDED_BUNDLE_SHUFFLE_BASELINE_POSITION_COUNTERBALANCE_ROUND_ROBIN';
  assignmentOrderSha256: string;
  assignmentIds: string[];
  bundleOrder: string[];
  baselinePositionByBundle: Record<string, number>;
}

export interface LabControlledPlan {
  schemaVersion: typeof LAB_CONTROLLED_PLAN_SCHEMA_VERSION;
  planVersion: typeof LAB_CONTROLLED_PLAN_VERSION;
  createdAt: string;
  partition: LabCasePartition;
  locks: LabComponentLock;
  h0Validation: LabH0ValidationReceipt;
  assignmentOrderVersion: typeof LAB_CONTROLLED_ASSIGNMENT_ORDER_VERSION;
  assignmentSchedule: LabControlledAssignmentSchedule;
  assignments: LabControlledAssignment[];
  budget: {
    assignments: number;
    maximumPrimaryCalls: number;
    maximumSchemaRepairCalls: number;
    maximumCalls: number;
    maximumRoundsPerAssignment: 1;
    /** Local estimate of the prepared public prompt; not provider-reported input usage. */
    maximumPreparedPromptEstimateTokensPerCall: 7_000;
    /** Concise natural-completion target; not a provider-enforced output limit. */
    targetOutputTokensPerCall: 900;
    /** Development-only streaming safety threshold; interruption can overshoot. */
    emergencyOutputTokenSafetyCeilingPerCall: 25_000;
    /** Checked between complete attempts from retrospective provider usage. */
    maximumObservedTotalTokens: 300_000;
    usageAccounting: 'RETROSPECTIVE_PROVIDER_REPORTED_AFTER_ATTEMPT';
    aggregateStopPolicy: 'BETWEEN_ATTEMPTS_RETAIN_ATOMIC_OVERSHOOT';
    maximumCallMs: 120_000;
    maximumExperimentMs: typeof LAB_CONTROLLED_MAXIMUM_EXPERIMENT_MS;
  };
  confirmationInputsUninspected: boolean;
}

export interface LabH0ValidationReceipt {
  runId: string;
  manifestSha256: string;
  reportSha256: string;
  report: LabHarnessValidationReport;
}

export function buildControlledPlan(input: {
  partition: LabCasePartition;
  locks: LabComponentLock;
  h0Validation: LabH0ValidationReceipt;
  assignmentSchedule: LabControlledAssignmentSchedule;
  assignments: LabControlledAssignment[];
  createdAt?: string;
}): LabControlledPlan {
  const plan: LabControlledPlan = {
    schemaVersion: LAB_CONTROLLED_PLAN_SCHEMA_VERSION,
    planVersion: LAB_CONTROLLED_PLAN_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    partition: input.partition,
    locks: structuredClone(input.locks),
    h0Validation: structuredClone(input.h0Validation),
    assignmentOrderVersion: LAB_CONTROLLED_ASSIGNMENT_ORDER_VERSION,
    assignmentSchedule: structuredClone(input.assignmentSchedule),
    assignments: structuredClone(input.assignments),
    budget: controlledPlanBudget(input.assignments.length),
    confirmationInputsUninspected: input.partition === 'CONFIRMATION'
  };
  assertControlledPlan(
    plan,
    input.partition,
    input.locks,
    input.assignmentSchedule,
    input.assignments
  );
  return plan;
}

export function assertControlledPlan(
  plan: LabControlledPlan,
  partition: LabCasePartition,
  activeLocks: LabComponentLock,
  expectedSchedule: LabControlledAssignmentSchedule,
  expectedAssignments: readonly LabControlledAssignment[]
): void {
  const problems: string[] = [];
  if (plan.schemaVersion !== LAB_CONTROLLED_PLAN_SCHEMA_VERSION) problems.push('schemaVersion');
  if (plan.planVersion !== LAB_CONTROLLED_PLAN_VERSION) problems.push('planVersion');
  if (!Number.isFinite(Date.parse(plan.createdAt))) problems.push('createdAt');
  if (plan.partition !== partition) problems.push('partition');
  if (plan.assignmentOrderVersion !== LAB_CONTROLLED_ASSIGNMENT_ORDER_VERSION) {
    problems.push('assignmentOrderVersion');
  }
  if (stableJson(plan.locks) !== stableJson(activeLocks)) problems.push('componentLocks');
  problems.push(...h0ReceiptProblems(plan.h0Validation, activeLocks));
  if (stableJson(plan.assignmentSchedule) !== stableJson(expectedSchedule)) {
    problems.push('assignmentSchedule');
  }
  const assignmentIds = plan.assignments.map((item) => item.assignmentId);
  if (new Set(assignmentIds).size !== assignmentIds.length) problems.push('duplicateAssignments');
  if (plan.assignments.some((item) => item.partition !== partition)) {
    problems.push('assignmentPartition');
  }
  if (stableJson(assignmentIds) !== stableJson(plan.assignmentSchedule.assignmentIds)) {
    problems.push('assignmentOrder');
  }
  if (
    stableJson(canonicalAssignments(plan.assignments)) !==
    stableJson(canonicalAssignments(expectedAssignments))
  ) {
    problems.push('completeAssignments');
  }
  if (stableJson(plan.budget) !== stableJson(controlledPlanBudget(plan.assignments.length))) {
    problems.push('budget');
  }
  if (plan.confirmationInputsUninspected !== (partition === 'CONFIRMATION')) {
    problems.push('confirmationInspectionFlag');
  }
  if (problems.length > 0) {
    throw new Error(`Controlled H1 plan lock failed: ${[...new Set(problems)].join(', ')}.`);
  }
}

export function h0ReportSha256(report: LabHarnessValidationReport | undefined): string {
  return report ? sha256Text(`${stableJson(report)}\n`) : '';
}

export async function loadH0ValidationReceipt(
  stateRoot: string,
  runId: string,
  activeLocks: LabComponentLock
): Promise<LabH0ValidationReceipt> {
  if (!isSafeRunId(runId)) {
    throw new Error('Controlled H1 H0 receipt has an unsafe run id.');
  }
  const resolvedRoot = path.resolve(stateRoot);
  const runsDirectory = path.join(resolvedRoot, 'runs');
  const runDirectory = path.join(runsDirectory, runId);
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const reportPath = path.join(runDirectory, 'reports', 'h0-validation.json');
  await Promise.all([
    assertRealDirectory(resolvedRoot),
    assertRealDirectory(runsDirectory),
    assertRealDirectory(runDirectory),
    assertRealDirectory(path.join(runDirectory, 'reports')),
    assertRealFile(manifestPath),
    assertRealFile(reportPath)
  ]);
  const [manifestText, reportText] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(reportPath, 'utf8')
  ]);
  let manifest: LabRunManifest;
  let report: LabHarnessValidationReport;
  try {
    manifest = JSON.parse(manifestText) as LabRunManifest;
    report = JSON.parse(reportText) as LabHarnessValidationReport;
  } catch {
    throw new Error('Controlled H1 H0 receipt contains invalid JSON.');
  }
  const manifestProblems: string[] = [];
  if (manifest.schemaVersion !== LAB_LEDGER_SCHEMA_VERSION) manifestProblems.push('schemaVersion');
  if (manifest.runId !== runId) manifestProblems.push('runId');
  if (manifest.phase !== 'HARNESS_VALIDATION') manifestProblems.push('phase');
  if (manifest.status !== 'PLANNED') manifestProblems.push('status');
  if (stableJson(manifest.locks) !== stableJson(activeLocks)) manifestProblems.push('locks');
  if (manifest.driver?.id !== 'scripted-text-v2' || manifest.driver.model !== 'scripted') {
    manifestProblems.push('scriptedDriver');
  }
  if (manifest.providerUsageExplicitlyAuthorized !== false) {
    manifestProblems.push('providerAuthorization');
  }
  if (manifestProblems.length > 0) {
    throw new Error(
      `Controlled H1 H0 manifest failed: ${[...new Set(manifestProblems)].join(', ')}.`
    );
  }
  const receipt: LabH0ValidationReceipt = {
    runId,
    manifestSha256: sha256Text(manifestText),
    reportSha256: sha256Text(reportText),
    report
  };
  const reportProblems = h0ReceiptProblems(receipt, activeLocks);
  if (reportProblems.length > 0) {
    throw new Error(
      `Controlled H1 H0 report failed: ${[...new Set(reportProblems)].join(', ')}.`
    );
  }
  return receipt;
}

const REQUIRED_H0_CHECK_IDS = [
  'SEALED_INPUTS_TWICE',
  'TRUTH_FIREWALL_AND_IMPORT_BOUNDARY',
  'PARTICIPANT_PROMPT_SANITIZATION',
  'CONTEXTUAL_REFERENCE_REJECTION_AND_REPAIR',
  'FINITE_PROTOCOL_MATRIX',
  'FROZEN_PREFIX_CONSTRUCTION',
  'AUDITOR_SESSION_IDENTITY',
  'DETERMINISTIC_SCORING_AND_LEDGER',
  'NON_EXECUTABLE_CONDITION_GATES',
  'FAILURE_AND_HARD_LIMIT_INJECTION'
] as const;

function h0ReceiptProblems(
  receipt: LabH0ValidationReceipt | undefined,
  activeLocks: LabComponentLock
): string[] {
  const problems: string[] = [];
  if (!receipt || !isSafeRunId(receipt.runId)) problems.push('h0ValidationRunId');
  const report = receipt?.report;
  if (
    report?.schemaVersion !== 'task-monki/discourse-lab-h0@v6' ||
    report.validationVersion !== 'h0-validation@v6' ||
    report.hypothesisId !== 'H0' ||
    report.status !== 'PASSED'
  ) {
    problems.push('h0ValidationStatus');
  }
  if (stableJson(report?.componentLocks) !== stableJson(activeLocks)) {
    problems.push('h0ValidationLocks');
  }
  if (receipt?.reportSha256 !== h0ReportSha256(report)) {
    problems.push('h0ValidationDigest');
  }
  if (!/^[a-f0-9]{64}$/u.test(receipt?.manifestSha256 ?? '')) {
    problems.push('h0ValidationManifestDigest');
  }
  const checkIds = report?.checks.map((check) => check.checkId) ?? [];
  if (
    new Set(checkIds).size !== checkIds.length ||
    REQUIRED_H0_CHECK_IDS.some((checkId) => !checkIds.includes(checkId)) ||
    report?.checks.some((check) => check.status !== 'PASSED') ||
    !report || report.trajectories.length === 0 ||
    report.trajectories.some(
      (trajectory) => trajectory.status !== 'COMPLETED' || trajectory.failureCount !== 0
    )
  ) {
    problems.push('h0ValidationEvidence');
  }
  return problems;
}

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) && runId !== '..';
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Controlled H1 H0 receipt directory is unavailable or unsafe: ${directory}`);
  }
}

async function assertRealFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Controlled H1 H0 receipt file is unavailable or unsafe: ${filePath}`);
  }
}

function canonicalAssignments(
  assignments: readonly LabControlledAssignment[]
): LabControlledAssignment[] {
  return structuredClone([...assignments]).sort((left, right) =>
    left.assignmentId.localeCompare(right.assignmentId)
  );
}

function controlledPlanBudget(assignments: number): LabControlledPlan['budget'] {
  return {
    assignments,
    maximumPrimaryCalls: assignments,
    maximumSchemaRepairCalls: assignments,
    maximumCalls: assignments * 2,
    maximumRoundsPerAssignment: 1,
    maximumPreparedPromptEstimateTokensPerCall: 7_000,
    targetOutputTokensPerCall: 900,
    emergencyOutputTokenSafetyCeilingPerCall: 25_000,
    maximumObservedTotalTokens: 300_000,
    usageAccounting: 'RETROSPECTIVE_PROVIDER_REPORTED_AFTER_ATTEMPT',
    aggregateStopPolicy: 'BETWEEN_ATTEMPTS_RETAIN_ATOMIC_OVERSHOOT',
    maximumCallMs: 120_000,
    maximumExperimentMs: LAB_CONTROLLED_MAXIMUM_EXPERIMENT_MS
  };
}
