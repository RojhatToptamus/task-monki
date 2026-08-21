import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LAB_CONTROLLED_MAXIMUM_EXPERIMENT_MS,
  LAB_CONTROLLED_PLAN_SCHEMA_VERSION,
  LAB_CONTROLLED_PLAN_VERSION,
  assertControlledPlan,
  buildControlledPlan,
  h0ReportSha256,
  loadH0ValidationReceipt,
  type LabControlledAssignmentSchedule
} from './controlledPlan';
import type { LabControlledAssignment } from './corpus';
import type { LabHarnessValidationReport } from './harnessValidation';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const locks: LabComponentLock = {
  corpusVersion: 'corpus',
  participantCorpusSha256: 'participants',
  oracleCorpusSha256: 'oracles',
  labSourceSha256: 'source',
  preregistrationVersion: 'preregistration',
  preregistrationSha256: 'preregistration-sha',
  promptVersion: 'prompts',
  outputSchemaVersion: 'output',
  scoringVersion: 'scoring',
  protocolVersion: 'protocol'
};
const assignments: LabControlledAssignment[] = [{
  assignmentId: 'A:V0',
  partition: 'DEVELOPMENT',
  caseId: 'CASE',
  bundleId: 'A',
  variantId: 'V0',
  conditionId: 'CONTROL_NO_FEEDBACK_B1'
}];
const schedule: LabControlledAssignmentSchedule = {
  version: 'sealed-counterbalanced-order@v1',
  seed: 1,
  method: 'SEEDED_BUNDLE_SHUFFLE_BASELINE_POSITION_COUNTERBALANCE_ROUND_ROBIN',
  assignmentOrderSha256: 'order',
  assignmentIds: ['A:V0'],
  bundleOrder: ['A'],
  baselinePositionByBundle: { A: 0 }
};
const h0Report: LabHarnessValidationReport = {
  schemaVersion: 'task-monki/discourse-lab-h0@v6',
  validationVersion: 'h0-validation@v6',
  hypothesisId: 'H0',
  hypothesis: 'fixture',
  mechanism: 'fixture',
  supportCriterion: 'fixture',
  rejectCriterion: 'fixture',
  decisionChanged: 'fixture',
  startedAt: '2026-07-31T00:00:00.000Z',
  completedAt: '2026-07-31T00:00:01.000Z',
  status: 'PASSED',
  componentLocks: structuredClone(locks),
  scopeLimitations: [],
  checks: [
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
  ].map((checkId) => ({ checkId, status: 'PASSED' as const, detail: 'fixture' })),
  trajectories: [{
    caseId: 'CASE',
    conditionId: 'CONTROL_NO_FEEDBACK_B1',
    status: 'COMPLETED',
    chargedCalls: 1,
    failureCount: 0
  }]
};
const h0Validation = {
  runId: 'h0-fixture',
  manifestSha256: 'a'.repeat(64),
  reportSha256: h0ReportSha256(h0Report),
  report: h0Report
};

describe('controlled H1 plan lock', () => {
  it('builds and validates one exact active-input plan', () => {
    const plan = buildControlledPlan({
      partition: 'DEVELOPMENT',
      locks,
      h0Validation,
      assignmentSchedule: schedule,
      assignments,
      createdAt: '2026-07-31T00:00:00.000Z'
    });
    expect(() =>
      assertControlledPlan(plan, 'DEVELOPMENT', locks, schedule, assignments)
    ).not.toThrow();
    expect(plan).toMatchObject({
      schemaVersion: LAB_CONTROLLED_PLAN_SCHEMA_VERSION,
      planVersion: LAB_CONTROLLED_PLAN_VERSION,
      confirmationInputsUninspected: false,
      budget: {
        assignments: 1,
        maximumPrimaryCalls: 1,
        maximumSchemaRepairCalls: 1,
        maximumCalls: 2,
        maximumRoundsPerAssignment: 1,
        maximumPreparedPromptEstimateTokensPerCall: 7_000,
        targetOutputTokensPerCall: 900,
        emergencyOutputTokenSafetyCeilingPerCall: 25_000,
        maximumObservedTotalTokens: 300_000,
        usageAccounting: 'RETROSPECTIVE_PROVIDER_REPORTED_AFTER_ATTEMPT',
        aggregateStopPolicy: 'BETWEEN_ATTEMPTS_RETAIN_ATOMIC_OVERSHOOT',
        maximumCallMs: 120_000,
        maximumExperimentMs: LAB_CONTROLLED_MAXIMUM_EXPERIMENT_MS
      }
    });
  });

  it.each([
    ['maximumPreparedPromptEstimateTokensPerCall', 7_001],
    ['targetOutputTokensPerCall', 901],
    ['emergencyOutputTokenSafetyCeilingPerCall', 24_999],
    ['maximumObservedTotalTokens', 299_999],
    ['usageAccounting', 'PROVIDER_CAP'],
    ['aggregateStopPolicy', 'STRICT_NO_OVERSHOOT']
  ] as const)('locks each active natural-completion budget field %s', (field, value) => {
    const plan = buildControlledPlan({
      partition: 'DEVELOPMENT',
      locks,
      h0Validation,
      assignmentSchedule: schedule,
      assignments,
      createdAt: '2026-07-31T00:00:00.000Z'
    });
    plan.budget[field] = value as never;

    expect(() =>
      assertControlledPlan(plan, 'DEVELOPMENT', locks, schedule, assignments)
    ).toThrow('budget');
  });

  it.each([
    'componentLocks',
    'h0ValidationStatus',
    'h0ValidationLocks',
    'h0ValidationDigest',
    'h0ValidationManifestDigest',
    'assignmentSchedule',
    'assignmentOrder',
    'completeAssignments',
    'budget'
  ])(
    'fails closed on a changed %s',
    (field) => {
      const plan = buildControlledPlan({
        partition: 'DEVELOPMENT',
        locks,
        h0Validation,
        assignmentSchedule: schedule,
        assignments,
        createdAt: '2026-07-31T00:00:00.000Z'
      });
      if (field === 'componentLocks') plan.locks.promptVersion = 'changed';
      if (field === 'h0ValidationStatus') {
        (plan.h0Validation.report as { status: string }).status = 'FAILED';
      }
      if (field === 'h0ValidationLocks') {
        plan.h0Validation.report.componentLocks.promptVersion = 'changed';
      }
      if (field === 'h0ValidationDigest') plan.h0Validation.reportSha256 = 'changed';
      if (field === 'h0ValidationManifestDigest') {
        plan.h0Validation.manifestSha256 = 'changed';
      }
      if (field === 'assignmentSchedule') plan.assignmentSchedule.seed = 2;
      if (field === 'assignmentOrder') plan.assignments[0]!.assignmentId = 'changed';
      if (field === 'budget') plan.budget.maximumCalls += 1;
      const expectedAssignments = field === 'completeAssignments'
        ? [{ ...assignments[0]!, caseId: 'OTHER_CASE' }]
        : assignments;
      expect(() =>
        assertControlledPlan(plan, 'DEVELOPMENT', locks, schedule, expectedAssignments)
      ).toThrow(field);
    }
  );

  it('loads only a real same-root H0 ledger manifest and report', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h0-receipt-'));
    roots.push(root);
    const ledger = new LabArtifactLedger(root, 'h0-valid');
    await ledger.initialize(h0Manifest('h0-valid'));
    await ledger.writeReport('h0-validation', h0Report);

    const receipt = await loadH0ValidationReceipt(root, 'h0-valid', locks);

    expect(receipt).toMatchObject({
      runId: 'h0-valid',
      reportSha256: h0ReportSha256(h0Report),
      report: h0Report
    });
    expect(receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(loadH0ValidationReceipt(root, '../h0-valid', locks)).rejects.toThrow(
      'unsafe run id'
    );
  });

  it('rejects a symlinked H0 report', async () => {
    if (process.platform === 'win32') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h0-symlink-'));
    roots.push(root);
    const ledger = new LabArtifactLedger(root, 'h0-symlink');
    await ledger.initialize(h0Manifest('h0-symlink'));
    const outsideReport = path.join(root, 'outside-report.json');
    await fs.writeFile(outsideReport, `${JSON.stringify(h0Report)}\n`, 'utf8');
    await fs.symlink(
      outsideReport,
      path.join(ledger.runDirectory, 'reports', 'h0-validation.json')
    );

    await expect(loadH0ValidationReceipt(root, 'h0-symlink', locks)).rejects.toThrow(
      'unavailable or unsafe'
    );
  });
});

function h0Manifest(runId: string): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId,
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt: '2026-07-31T00:00:00.000Z',
    driver: {
      id: 'scripted-text-v2',
      model: 'scripted',
      seed: 17,
      seedControl: 'SUPPORTED',
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'PROVIDER_ENFORCED',
      boundaryClass: 'PROVIDER_ENFORCED_STRICT',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: true,
      providerReportedTokenUsage: true
    },
    locks,
    caseIds: ['CASE'],
    conditionIds: ['CONTROL_NO_FEEDBACK_B1'],
    budgets: {
      maximumCalls: 1,
      maximumRounds: 1,
      maximumOutputTokens: 900,
      maximumOutputTokenSafetyCeiling: 900,
      maximumObservedTotalTokens: 10_000,
      maximumCallMs: 2_000,
      maximumExperimentMs: 30_000
    },
    providerUsageExplicitlyAuthorized: false
  };
}
