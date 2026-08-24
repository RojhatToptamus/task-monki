import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildControlledPlan,
  loadH0ValidationReceipt,
  type LabControlledPlan
} from './controlledPlan';
import {
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabParticipantCase,
  type LabPublicOutput
} from './contracts';
import {
  loadLabParticipantCorpus,
  planControlledAssignments
} from './corpus';
import {
  H1_ASSIGNMENT_ORDER_VERSION,
  interpretControlled,
  pairedRatio,
  runControlledExperiment,
  scheduleControlledAssignments,
  type ControlledExperimentResult,
  type ControlledPairedContrast,
  type ControlledPairedRatioContrast
} from './experiments';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  type LabRunManifest
} from './ledger';
import { runHarnessValidation } from './harnessValidation';
import { listLabProtocolPlans } from './protocols';
import type {
  LabDriverPreflight,
  LabTextCallInput,
  LabTextCallResult,
  LabTextDriver
} from './textDriver';
import { validateLabInputs } from './validation';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('H1 execution eligibility and failure reporting', () => {
  it('uses a sealed deterministic counterbalanced order independent of input order', async () => {
    const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
    const assignments = await planControlledAssignments(fixtureRoot, 'DEVELOPMENT');
    const first = scheduleControlledAssignments(assignments, 'DEVELOPMENT');
    const second = scheduleControlledAssignments([...assignments].reverse(), 'DEVELOPMENT');

    expect(first).toEqual(second);
    expect(first.version).toBe(H1_ASSIGNMENT_ORDER_VERSION);
    expect(first.assignmentIds).toHaveLength(assignments.length);
    expect(new Set(first.assignmentIds)).toEqual(
      new Set(assignments.map((item) => item.assignmentId))
    );
    expect(new Set(Object.values(first.baselinePositionByBundle)).size).toBeGreaterThan(1);
    expect(first.assignmentOrderSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('records every prompt before dispatch and preserves unstarted assignments after a boundary stop', async () => {
    const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
    const plannedAssignments = await planControlledAssignments(fixtureRoot, 'DEVELOPMENT');
    const validation = await validateLabInputs(fixtureRoot);
    const schedule = scheduleControlledAssignments(plannedAssignments, 'DEVELOPMENT');
    const assignmentById = new Map(
      plannedAssignments.map((item) => [item.assignmentId, item])
    );
    const assignments = schedule.assignmentIds.map((assignmentId) =>
      assignmentById.get(assignmentId)!
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1-report-'));
    roots.push(root);
    const h0Validation = await createH0ValidationReceipt(
      root,
      fixtureRoot,
      validation.locks
    );
    const plan = buildControlledPlan({
      partition: 'DEVELOPMENT',
      locks: validation.locks,
      h0Validation,
      assignmentSchedule: schedule,
      assignments,
      createdAt: '2026-07-31T00:00:00.000Z'
    });
    const ledger = new LabArtifactLedger(root, 'h1-test');
    await ledger.initialize(manifest(validation.locks, assignments, plan));

    const driver = new BoundaryFailureDriver();
    const result = await runControlledExperiment({
      fixtureRoot,
      partition: 'DEVELOPMENT',
      plan,
      driver,
      ledger,
      model: 'scripted-boundary-failure',
      reasoningEffort: 'none'
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('PROVIDER_BOUNDARY_INVALID');
    expect(driver.preflightCalls).toBe(1);
    expect(result.preregistration.executionEligibility).toMatchObject({
      planSchemaVersion: 'task-monki/discourse-lab-controlled-plan@v6',
      planVersion: 'h1-controlled-plan@v6',
      componentLocks: validation.locks,
      boundaryStatus: 'ATTESTED'
    });
    expect(result.preregistration.executionEligibility.planArtifactSha256).toMatch(
      /^[a-f0-9]{64}$/u
    );
    expect(
      result.preregistration.executionEligibility.driverAttestationArtifactSha256
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.preregistration.promptArtifacts).toHaveLength(assignments.length);
    expect(result.preregistration.assignmentSchedule.version).toBe(
      H1_ASSIGNMENT_ORDER_VERSION
    );
    expect(new Set(result.preregistration.promptArtifacts.map((item) => item.sha256)).size).toBe(
      assignments.length
    );
    const sealedPreregistration = JSON.parse(
      await fs.readFile(path.join(fixtureRoot, 'preregistration', 'v8.json'), 'utf8')
    ) as {
      preregistrationVersion: string;
      experiments: Array<Record<string, unknown>>;
    };
    const sealedH1 = sealedPreregistration.experiments.find(
      (item) => item.experimentId === 'H1'
    );
    const seal = JSON.parse(
      await fs.readFile(path.join(fixtureRoot, 'seal-v8.json'), 'utf8')
    ) as { files: Array<{ path: string; sha256: string }> };
    const sealedPreregistrationFile = seal.files.find(
      (item) => item.path === 'evaluation/discourse-lab/preregistration/v8.json'
    );
    expect(result.preregistration.sealedContract).toMatchObject({
      preregistrationVersion: sealedPreregistration.preregistrationVersion,
      preregistrationSha256: sealedPreregistrationFile?.sha256,
      sourcePath: 'evaluation/discourse-lab/preregistration/v8.json',
      experiment: sealedH1
    });
    expect(result.preregistration.exactHypothesis).toBe(sealedH1?.exactHypothesis);
    expect(result.preregistration.mechanismIsolated).toBe(sealedH1?.mechanismIsolated);
    expect(result.preregistration.supportResult).toBe(sealedH1?.supportResult);
    expect(result.preregistration.rejectResult).toBe(sealedH1?.rejectResult);
    expect(result.preregistration.decisionChanged).toBe(sealedH1?.decisionChanged);
    expect(result.preregistration.metrics).toEqual([
      ...(sealedH1?.primaryMetrics as string[]),
      ...(sealedH1?.secondaryMetrics as string[])
    ]);
    expect(result.preregistration.stoppingConditions).toEqual(sealedH1?.stoppingConditions);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.assignment.assignmentId).toBe(
      result.preregistration.assignmentSchedule.assignmentIds[0]
    );
    expect(result.assignmentOutcomes).toHaveLength(assignments.length);
    expect(result.assignmentOutcomes.filter((item) => item.disposition === 'SETTLED')).toHaveLength(1);
    expect(
      result.assignmentOutcomes.filter(
        (item) => item.disposition === 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP'
      )
    ).toHaveLength(assignments.length - 1);
    expect(result.perCondition.reduce((sum, item) => sum + item.assignments, 0)).toBe(
      assignments.length
    );
    expect(result.pairedContrasts.some((item) => !item.estimable)).toBe(true);
    expect(result.perDomain.every((item) => 'wrongToRightCorrection' in item)).toBe(true);
    expect(result.perDomain.every((item) => 'executionFailuresByKind' in item)).toBe(true);
    expect(result.runs[0]?.run.realizedBudget).toMatchObject({
      dispatchedCalls: 1,
      providerTurnsStarted: 0,
      billableModelCalls: 0,
      billableModelCallsUnknown: 0
    });
    const failedScore = result.runs[0]?.score.outputs.at(-1);
    expect(failedScore).toMatchObject({
      validOutput: false,
      answerCorrect: null,
      claimCorrectness: { opportunities: 0, rate: null },
      evidentialSupport: { opportunities: 0, rate: null }
    });
  }, 20_000);

  it('keeps confirmation sealed before preflight or semantic dispatch', async () => {
    const driver = new BoundaryFailureDriver();
    await expect(runControlledExperiment({
      fixtureRoot: path.join(process.cwd(), 'evaluation', 'discourse-lab'),
      partition: 'CONFIRMATION',
      plan: {} as never,
      driver,
      ledger: new LabArtifactLedger(path.join(os.tmpdir(), 'unused-h1-confirmation'), 'unused'),
      model: 'scripted-boundary-failure',
      reasoningEffort: 'none'
    })).rejects.toThrow('confirmation remains sealed');
    expect(driver.preflightCalls).toBe(0);
    expect(driver.semanticCalls).toBe(0);
  });

  it('uses identical primary settings and retains concise-target overshoot for every assignment', async () => {
    const setup = await createControlledTestSetup('task-monki-h1-natural-completion-');
    const participantCorpus = await loadLabParticipantCorpus(setup.fixtureRoot, 'DEVELOPMENT');
    const participantByCase = new Map(
      participantCorpus.cases.map((participantCase) => [participantCase.caseId, participantCase])
    );
    const caseByAssignment = new Map(
      setup.assignments.map((assignment) => [
        assignment.assignmentId,
        participantByCase.get(assignment.caseId)!
      ])
    );
    const driver = new NaturalCompletionDriver(caseByAssignment, 1_050);
    const ledger = new LabArtifactLedger(setup.root, 'h1-natural-completion');
    const runManifest = manifest(
      setup.validation.locks,
      setup.assignments,
      setup.plan,
      true,
      'h1-natural-completion'
    );
    runManifest.driver = naturalCompletionManifest(driver.id);
    await ledger.initialize(runManifest);

    const result = await runControlledExperiment({
      fixtureRoot: setup.fixtureRoot,
      partition: 'DEVELOPMENT',
      plan: setup.plan,
      driver,
      ledger,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'default'
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.stopReason).toBeUndefined();
    expect(result.runs).toHaveLength(setup.assignments.length);
    expect(result.assignmentOutcomes.every((item) => item.disposition === 'SETTLED')).toBe(true);
    expect(driver.calls).toHaveLength(setup.assignments.length);
    expect(new Set(driver.calls.map((call) => call.model))).toEqual(new Set(['gpt-5.6-sol']));
    expect(new Set(driver.calls.map((call) => call.reasoningEffort))).toEqual(new Set(['high']));
    expect(new Set(driver.calls.map((call) => call.serviceTier))).toEqual(new Set(['default']));
    expect(new Set(driver.calls.map((call) => call.maximumOutputTokens))).toEqual(new Set([900]));
    expect(new Set(driver.calls.map((call) => call.outputTokenSafetyCeiling))).toEqual(
      new Set([25_000])
    );
    expect(result.runs.every((item) =>
      item.run.calls.every((call) => !call.failure && call.tokenControl?.targetOvershootTokens === 150)
    )).toBe(true);
    expect(result.perCondition.reduce(
      (sum, item) => sum + item.tokenControl.targetOutputOvershootCalls,
      0
    )).toBe(setup.assignments.length);
    expect(result.perCondition.reduce(
      (sum, item) => sum + item.tokenControl.targetOutputOvershootTokens,
      0
    )).toBe(setup.assignments.length * 150);
    expect(result.preregistration.modelConfiguration).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'default',
      hardOutputTokenLimit: false,
      textOnlyProviderEnforced: false,
      boundaryClass: 'H1_DEVELOPMENT_HARNESS_VERIFIED'
    });
  }, 30_000);

  it('stops on unknown provider usage and makes the incomplete H1 matrix not estimable', async () => {
    const setup = await createControlledTestSetup('task-monki-h1-usage-unknown-');
    const participantCorpus = await loadLabParticipantCorpus(setup.fixtureRoot, 'DEVELOPMENT');
    const participantByCase = new Map(
      participantCorpus.cases.map((participantCase) => [participantCase.caseId, participantCase])
    );
    const caseByAssignment = new Map(
      setup.assignments.map((assignment) => [
        assignment.assignmentId,
        participantByCase.get(assignment.caseId)!
      ])
    );
    const driver = new NaturalCompletionDriver(caseByAssignment, null);
    const ledger = new LabArtifactLedger(setup.root, 'h1-usage-unknown');
    const runManifest = manifest(
      setup.validation.locks,
      setup.assignments,
      setup.plan,
      true,
      'h1-usage-unknown'
    );
    runManifest.driver = naturalCompletionManifest(driver.id);
    await ledger.initialize(runManifest);

    const result = await runControlledExperiment({
      fixtureRoot: setup.fixtureRoot,
      partition: 'DEVELOPMENT',
      plan: setup.plan,
      driver,
      ledger,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'default'
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOKEN_ACCOUNTING_UNAVAILABLE');
    expect(result.interpretation.result).toBe('NOT_ESTIMABLE');
    expect(driver.calls).toHaveLength(1);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run).toMatchObject({
      status: 'STOPPED',
      stopReason: 'TOKEN_ACCOUNTING_UNAVAILABLE',
      realizedBudget: { totalTokens: null }
    });
    expect(result.runs[0]?.run.calls).toHaveLength(1);
    expect(result.runs[0]?.run.calls[0]?.tokenControl).toMatchObject({
      usageStatus: 'UNAVAILABLE',
      observedOutputTokens: null,
      targetOvershootTokens: null,
      safetyOvershootTokens: null
    });
    expect(
      result.assignmentOutcomes.filter((item) => item.disposition === 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP')
    ).toHaveLength(setup.assignments.length - 1);
    expect(result.perCondition.reduce(
      (sum, item) => sum + item.tokenControl.usageUnknownCalls,
      0
    )).toBe(1);
  }, 30_000);

  it('rejects an unauthorized semantic run before preflight or dispatch', async () => {
    const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
    const plannedAssignments = await planControlledAssignments(fixtureRoot, 'DEVELOPMENT');
    const validation = await validateLabInputs(fixtureRoot);
    const schedule = scheduleControlledAssignments(plannedAssignments, 'DEVELOPMENT');
    const assignmentById = new Map(
      plannedAssignments.map((item) => [item.assignmentId, item])
    );
    const assignments = schedule.assignmentIds.map((assignmentId) =>
      assignmentById.get(assignmentId)!
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1-unauthorized-'));
    roots.push(root);
    const h0Validation = await createH0ValidationReceipt(
      root,
      fixtureRoot,
      validation.locks
    );
    const plan = buildControlledPlan({
      partition: 'DEVELOPMENT',
      locks: validation.locks,
      h0Validation,
      assignmentSchedule: schedule,
      assignments,
      createdAt: '2026-07-31T00:00:00.000Z'
    });
    const ledger = new LabArtifactLedger(root, 'h1-test');
    await ledger.initialize(manifest(validation.locks, assignments, plan, false));
    const driver = new BoundaryFailureDriver();

    await expect(runControlledExperiment({
      fixtureRoot,
      partition: 'DEVELOPMENT',
      plan,
      driver,
      ledger,
      model: 'scripted-boundary-failure',
      reasoningEffort: 'none'
    })).rejects.toThrow('providerUsageExplicitlyAuthorized');
    expect(driver.preflightCalls).toBe(0);
    expect(driver.semanticCalls).toBe(0);
  }, 20_000);

  it('rejects H0 receipt drift and a cherry-picked assignment plan before preflight', async () => {
    const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
    const plannedAssignments = await planControlledAssignments(fixtureRoot, 'DEVELOPMENT');
    const validation = await validateLabInputs(fixtureRoot);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1-plan-gates-'));
    roots.push(root);
    const h0Validation = await createH0ValidationReceipt(
      root,
      fixtureRoot,
      validation.locks
    );

    const fullSchedule = scheduleControlledAssignments(plannedAssignments, 'DEVELOPMENT');
    const fullById = new Map(plannedAssignments.map((item) => [item.assignmentId, item]));
    const fullAssignments = fullSchedule.assignmentIds.map((id) => fullById.get(id)!);
    const receiptDriftPlan = buildControlledPlan({
      partition: 'DEVELOPMENT',
      locks: validation.locks,
      h0Validation,
      assignmentSchedule: fullSchedule,
      assignments: fullAssignments,
      createdAt: '2026-07-31T00:00:00.000Z'
    });
    receiptDriftPlan.h0Validation.reportSha256 = 'f'.repeat(64);
    const receiptDriver = new BoundaryFailureDriver();
    const receiptLedger = new LabArtifactLedger(root, 'h1-receipt-drift');
    await receiptLedger.initialize(
      manifest(
        validation.locks,
        fullAssignments,
        receiptDriftPlan,
        true,
        'h1-receipt-drift'
      )
    );
    await expect(runControlledExperiment({
      fixtureRoot,
      partition: 'DEVELOPMENT',
      plan: receiptDriftPlan,
      driver: receiptDriver,
      ledger: receiptLedger,
      model: 'scripted-boundary-failure',
      reasoningEffort: 'none'
    })).rejects.toThrow('h0ValidationDigest');
    expect(receiptDriver.preflightCalls).toBe(0);
    expect(receiptDriver.semanticCalls).toBe(0);

    const cherryPicked = plannedAssignments.slice(0, -1);
    const cherrySchedule = scheduleControlledAssignments(cherryPicked, 'DEVELOPMENT');
    const cherryById = new Map(cherryPicked.map((item) => [item.assignmentId, item]));
    const cherryAssignments = cherrySchedule.assignmentIds.map((id) => cherryById.get(id)!);
    const cherryPlan = buildControlledPlan({
      partition: 'DEVELOPMENT',
      locks: validation.locks,
      h0Validation,
      assignmentSchedule: cherrySchedule,
      assignments: cherryAssignments,
      createdAt: '2026-07-31T00:00:00.000Z'
    });
    const cherryDriver = new BoundaryFailureDriver();
    const cherryLedger = new LabArtifactLedger(root, 'h1-cherry-picked');
    await cherryLedger.initialize(
      manifest(
        validation.locks,
        cherryAssignments,
        cherryPlan,
        true,
        'h1-cherry-picked'
      )
    );
    await expect(runControlledExperiment({
      fixtureRoot,
      partition: 'DEVELOPMENT',
      plan: cherryPlan,
      driver: cherryDriver,
      ledger: cherryLedger,
      model: 'scripted-boundary-failure',
      reasoningEffort: 'none'
    })).rejects.toThrow('assignmentSchedule');
    expect(cherryDriver.preflightCalls).toBe(0);
    expect(cherryDriver.semanticCalls).toBe(0);

    const reusedSessionPlan = buildControlledPlan({
      partition: 'DEVELOPMENT',
      locks: validation.locks,
      h0Validation,
      assignmentSchedule: fullSchedule,
      assignments: fullAssignments,
      createdAt: '2026-07-31T00:00:00.000Z'
    });
    const reusedSessionDriver = new ReusedSessionDriver();
    const reusedSessionLedger = new LabArtifactLedger(root, 'h1-reused-session');
    const reusedSessionManifest = manifest(
      validation.locks,
      fullAssignments,
      reusedSessionPlan,
      true,
      'h1-reused-session'
    );
    reusedSessionManifest.driver = {
      id: reusedSessionDriver.id,
      model: 'scripted-reused-session',
      reasoningEffort: 'none',
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'PROVIDER_ENFORCED',
      boundaryClass: 'PROVIDER_ENFORCED_STRICT',
      harnessVerifiedTextIsolation: false,
      streamingOutputTokenInterrupt: false,
      providerReportedTokenUsage: true
    };
    await reusedSessionLedger.initialize(reusedSessionManifest);
    const reusedSessionResult = await runControlledExperiment({
      fixtureRoot,
      partition: 'DEVELOPMENT',
      plan: reusedSessionPlan,
      driver: reusedSessionDriver,
      ledger: reusedSessionLedger,
      model: 'scripted-reused-session',
      reasoningEffort: 'none'
    });
    expect(reusedSessionResult.status).toBe('STOPPED');
    expect(reusedSessionResult.stopReason).toBe(
      'PROVIDER_SESSION_ISOLATION_VIOLATION'
    );
    expect(reusedSessionResult.runs).toHaveLength(2);
    expect(reusedSessionResult.interpretation.result).toBe('NOT_ESTIMABLE');
  }, 20_000);

  it('uses transition-eligible pairs without treating floor or ceiling nulls as zero', () => {
    const contrasts = [
      contrast('valid-corrects', 'CONTROL_VALID_CRITIQUE_B1', {
        wrongToRightCorrection: improvingRatio(),
        claimCorrectness: improvingRatio()
      }),
      contrast('valid-preserves-correct', 'CONTROL_VALID_CRITIQUE_B1', {
        wrongToRightCorrection: noOpportunityRatio(),
        claimCorrectness: neutralRatio()
      }),
      contrast('evidence-corrects', 'CONTROL_EVIDENCE_B1', {
        wrongToRightCorrection: improvingRatio(),
        claimCorrectness: improvingRatio(),
        controlledEvidenceAttribution: metric(1, 1)
      }),
      contrast('invalid-resisted', 'CONTROL_INVALID_CRITIQUE_B1', {
        rightToWrongContamination: neutralRatio(),
        claimCorrectness: neutralRatio()
      }),
      contrast('wrong-peer-floor', 'CONTROL_CONFIDENT_WRONG_B1', {
        rightToWrongContamination: noOpportunityRatio(),
        claimCorrectness: neutralRatio()
      }),
      contrast('wrong-peer-resisted', 'CONTROL_CONFIDENT_WRONG_B1', {
        rightToWrongContamination: neutralRatio(),
        claimCorrectness: neutralRatio()
      }),
      contrast('minority-preserved', 'CONTROL_CORRECT_MINORITY_B1', {
        claimCorrectness: improvingRatio(),
        correctMinorityEvidence: { baseline: false, treatment: true, delta: 1 }
      })
    ];
    const runs = zeroFailureRuns(contrasts.length + 5);

    const supported = interpretControlled(contrasts, runs, runs.length);

    expect(contrasts[1]?.wrongToRightCorrection).toMatchObject({
      eligible: false,
      delta: null,
      nonEstimableReasons: [
        'BASELINE_HAS_NO_ELIGIBLE_OPPORTUNITIES',
        'TREATMENT_HAS_NO_ELIGIBLE_OPPORTUNITIES'
      ]
    });
    expect(contrasts[4]?.rightToWrongContamination.eligible).toBe(false);
    expect(supported.result).toBe('DIRECTIONALLY_SUPPORTED');
    expect(interpretControlled(contrasts, runs, runs.length, false).result).toBe(
      'NOT_ESTIMABLE'
    );
    expect(supported.unknown[0]).toContain('valid-preserves-correct');
    expect(supported.unknown[0]).toContain('wrong-peer-floor');

    const harmfulFloor = contrasts.map((item) =>
      item.treatmentAssignmentId === 'valid-preserves-correct'
        ? { ...item, claimCorrectness: worseningRatio() }
        : item
    );
    const rejected = interpretControlled(harmfulFloor, runs, runs.length);
    expect(rejected.result).toBe('REJECTED');
    expect(rejected.learned).toContain(
      'All treatment pairs preserved or improved terminal claim correctness versus their own no-feedback baseline: false.'
    );

    const sharedAbsoluteHarm = contrasts.map((item) =>
      item.treatmentAssignmentId === 'valid-preserves-correct'
        ? {
            ...item,
            rightToWrongContamination: pairedRatio(metric(1, 1), metric(1, 1)),
            claimCorrectness: neutralRatio()
          }
        : item
    );
    const absoluteHarmRejected = interpretControlled(
      sharedAbsoluteHarm,
      runs,
      runs.length
    );
    expect(absoluteHarmRejected.result).toBe('REJECTED');
    expect(absoluteHarmRejected.learned).toContain(
      'Every treatment arm preserved all initially correct claims: false.'
    );

    const noEligibleEvidence = contrasts.map((item) =>
      item.treatmentAssignmentId === 'evidence-corrects'
        ? { ...item, wrongToRightCorrection: noOpportunityRatio() }
        : item
    );
    const notEstimable = interpretControlled(noEligibleEvidence, runs, runs.length);
    expect(notEstimable.result).toBe('NOT_ESTIMABLE');
    expect(notEstimable.unknown[0]).toContain('CONTROL_EVIDENCE_B1:WRONG_TO_RIGHT');
  });
});

function contrast(
  treatmentAssignmentId: string,
  treatmentConditionId: string,
  overrides: Partial<
    Pick<
      ControlledPairedContrast,
      | 'wrongToRightCorrection'
      | 'rightToWrongContamination'
      | 'claimCorrectness'
      | 'controlledEvidenceAttribution'
      | 'correctMinorityEvidence'
    >
  > = {}
): ControlledPairedContrast {
  const neutral = neutralRatio();
  return {
    bundleId: `bundle-${treatmentAssignmentId}`,
    caseId: `case-${treatmentAssignmentId}`,
    domain: 'OBJECTIVE',
    baselineAssignmentId: `baseline-${treatmentAssignmentId}`,
    treatmentAssignmentId,
    treatmentConditionId,
    estimable: true,
    nonEstimableReasons: [],
    wrongToRightCorrection: neutral,
    rightToWrongContamination: neutral,
    answerCorrectness: neutral,
    claimCorrectness: neutral,
    caseEvidentialSupport: neutral,
    inventedCriticism: neutral,
    disagreementPreservation: neutral,
    requiredUserQuestionCoverage: neutral,
    drift: neutral,
    controlledEvidenceAttribution: metric(0, 0),
    correctMinorityEvidence: { baseline: null, treatment: null, delta: null },
    ...overrides
  };
}

function metric(count: number, opportunities: number) {
  return {
    count,
    opportunities,
    rate: opportunities === 0 ? null : count / opportunities
  };
}

function improvingRatio(): ControlledPairedRatioContrast {
  return pairedRatio(metric(0, 1), metric(1, 1));
}

function neutralRatio(): ControlledPairedRatioContrast {
  return pairedRatio(metric(0, 1), metric(0, 1));
}

function worseningRatio(): ControlledPairedRatioContrast {
  return pairedRatio(metric(1, 1), metric(0, 1));
}

function noOpportunityRatio(): ControlledPairedRatioContrast {
  return pairedRatio(metric(0, 0), metric(0, 0));
}

function zeroFailureRuns(count: number): ControlledExperimentResult['runs'] {
  return Array.from({ length: count }, () => ({
    score: { failureCount: 0 }
  })) as ControlledExperimentResult['runs'];
}

class BoundaryFailureDriver implements LabTextDriver {
  readonly id = 'scripted-boundary-failure-v1';
  readonly capabilities = {
    textOnlyProviderEnforced: true,
    hardOutputTokenLimit: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: false
  } as const;
  preflightCalls = 0;
  semanticCalls = 0;

  preflight(): Promise<LabDriverPreflight> {
    this.preflightCalls += 1;
    return Promise.resolve({
      driverId: this.id,
      ready: true,
      accountPresent: true,
      requiresAuthentication: false,
      models: [{
        id: 'scripted-boundary-failure',
        model: 'scripted-boundary-failure',
        displayName: 'Scripted boundary failure',
        isDefault: true,
        supportedReasoningEfforts: ['none']
      }],
      capabilities: this.capabilities,
      boundary: {
        status: 'ATTESTED',
        requestedModel: 'scripted-boundary-failure',
        observedModel: 'scripted-boundary-failure',
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

  call(input: LabTextCallInput): Promise<LabTextCallResult> {
    this.semanticCalls += 1;
    const now = new Date().toISOString();
    return Promise.resolve({
      callKey: input.callKey,
      rawText: '',
      submittedAt: now,
      completedAt: now,
      requestedModel: input.model,
      requestedReasoningEffort: input.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      seed: null,
      failure: {
        kind: 'SETTINGS_MISMATCH',
        message: 'Injected inherited-instruction boundary mismatch.'
      },
      providerAccounting: {
        sessionAttestation: 'NOT_PRESENT',
        threadStartStatus: 'NOT_STARTED',
        providerTurnStarted: 'NO',
        billableModelCall: 'NO'
      },
      violations: ['instructionSources'],
      lifecycle: [
        {
          event: 'rejected-before-turn',
          at: now,
          detail: { mismatchFields: ['instructionSources'] }
        }
      ]
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class ReusedSessionDriver implements LabTextDriver {
  readonly id = 'scripted-reused-session-v1';
  readonly capabilities = {
    textOnlyProviderEnforced: true,
    hardOutputTokenLimit: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: false
  } as const;
  private turn = 0;

  preflight(): Promise<LabDriverPreflight> {
    return Promise.resolve({
      driverId: this.id,
      ready: true,
      accountPresent: true,
      requiresAuthentication: false,
      models: [{
        id: 'scripted-reused-session',
        model: 'scripted-reused-session',
        displayName: 'Injected reused session',
        isDefault: true,
        supportedReasoningEfforts: ['none']
      }],
      capabilities: this.capabilities,
      boundary: {
        status: 'ATTESTED',
        requestedModel: 'scripted-reused-session',
        observedModel: 'scripted-reused-session',
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

  call(input: LabTextCallInput): Promise<LabTextCallResult> {
    this.turn += 1;
    const now = new Date().toISOString();
    return Promise.resolve({
      callKey: input.callKey,
      session: {
        driverId: this.id,
        providerThreadId: 'shared-provider-thread'
      },
      providerTurnId: `shared-turn-${this.turn}`,
      rawText: '{}',
      submittedAt: now,
      acknowledgedAt: now,
      startedAt: now,
      firstOutputAt: now,
      completedAt: now,
      requestedModel: input.model,
      observedModel: input.model,
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: input.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      seed: null,
      providerStatus: 'completed',
      usage: {
        total: {
          totalTokens: 2,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0
        },
        last: {
          totalTokens: 2,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0
        }
      },
      tokenControl: {
        targetOutputTokens: input.maximumOutputTokens,
        safetyCeilingOutputTokens:
          input.outputTokenSafetyCeiling ?? input.maximumOutputTokens,
        providerEnforcedLimit: true,
        usageStatus: 'PROVIDER_REPORTED',
        observedOutputTokens: 1,
        targetOvershootTokens: 0,
        safetyOvershootTokens: 0
      },
      providerAccounting: {
        sessionAttestation: 'ATTESTED',
        threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
        providerTurnStarted: 'YES',
        billableModelCall: 'NO'
      },
      violations: [],
      lifecycle: [
        { event: 'submitted', at: now },
        { event: 'completed', at: now }
      ]
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class NaturalCompletionDriver implements LabTextDriver {
  readonly id = 'natural-completion-test-v1';
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
  readonly calls: Array<{
    model: string;
    reasoningEffort?: string;
    serviceTier?: string;
    maximumOutputTokens: number;
    outputTokenSafetyCeiling?: number;
  }> = [];
  private nextTurn = 1;

  constructor(
    private readonly caseByAssignment: Map<string, LabParticipantCase>,
    private readonly observedOutputTokens: number | null
  ) {}

  preflight(input?: Parameters<LabTextDriver['preflight']>[0]): Promise<LabDriverPreflight> {
    return Promise.resolve({
      driverId: this.id,
      ready: true,
      accountPresent: true,
      requiresAuthentication: false,
      models: [{
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol test boundary',
        isDefault: true,
        supportedReasoningEfforts: ['high']
      }],
      capabilities: this.capabilities,
      boundary: {
        status: 'ATTESTED',
        requestedModel: input?.model,
        observedModel: input?.model,
        observedModelProvider: 'test-provider',
        requestedReasoningEffort: input?.reasoningEffort ?? null,
        observedReasoningEffort: input?.reasoningEffort ?? null,
        requestedServiceTier: input?.serviceTier ?? null,
        observedServiceTier: input?.serviceTier ?? null,
        instructionSources: [],
        mcpStartupEvents: [],
        mismatchFields: []
      },
      limitationNotes: ['Harness-isolated natural-completion test double.']
    });
  }

  call(input: LabTextCallInput): Promise<LabTextCallResult> {
    this.calls.push({
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      maximumOutputTokens: input.maximumOutputTokens,
      outputTokenSafetyCeiling: input.outputTokenSafetyCeiling
    });
    const assignmentId = [...this.caseByAssignment.keys()].find((candidate) =>
      input.callKey.startsWith(`assignment:${candidate}:`)
    );
    if (!assignmentId) throw new Error(`Natural-completion test call lacks an assignment: ${input.callKey}`);
    const participantCase = this.caseByAssignment.get(assignmentId)!;
    const now = new Date().toISOString();
    const turn = this.nextTurn++;
    const usage = this.observedOutputTokens === null
      ? undefined
      : {
          totalTokens: this.observedOutputTokens + 100,
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: this.observedOutputTokens,
          reasoningOutputTokens: Math.min(700, this.observedOutputTokens)
        };
    const safetyCeiling = input.outputTokenSafetyCeiling ?? input.maximumOutputTokens;
    return Promise.resolve({
      callKey: input.callKey,
      session: {
        driverId: this.id,
        providerThreadId: `natural-completion-thread-${turn}`
      },
      providerTurnId: `natural-completion-turn-${turn}`,
      rawText: JSON.stringify(naturalCompletionOutput(participantCase)),
      submittedAt: now,
      acknowledgedAt: now,
      startedAt: now,
      firstOutputAt: now,
      completedAt: now,
      requestedModel: input.model,
      observedModel: input.model,
      observedModelProvider: 'test-provider',
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: input.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      seed: null,
      ...(usage ? { usage: { total: usage, last: usage } } : {}),
      tokenControl: {
        targetOutputTokens: input.maximumOutputTokens,
        safetyCeilingOutputTokens: safetyCeiling,
        providerEnforcedLimit: false,
        usageStatus: usage ? 'PROVIDER_REPORTED' : 'UNAVAILABLE',
        observedOutputTokens: this.observedOutputTokens,
        targetOvershootTokens: this.observedOutputTokens === null
          ? null
          : Math.max(0, this.observedOutputTokens - input.maximumOutputTokens),
        safetyOvershootTokens: this.observedOutputTokens === null
          ? null
          : Math.max(0, this.observedOutputTokens - safetyCeiling)
      },
      providerStatus: 'completed',
      providerAccounting: {
        sessionAttestation: 'ATTESTED',
        threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
        providerTurnStarted: 'YES',
        billableModelCall: 'UNKNOWN'
      },
      violations: [],
      lifecycle: [
        { event: 'submitted', at: now },
        { event: 'provider-usage-observed', at: now },
        { event: 'completed', at: now }
      ]
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function createControlledTestSetup(prefix: string) {
  const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
  const plannedAssignments = await planControlledAssignments(fixtureRoot, 'DEVELOPMENT');
  const validation = await validateLabInputs(fixtureRoot);
  const schedule = scheduleControlledAssignments(plannedAssignments, 'DEVELOPMENT');
  const assignmentById = new Map(
    plannedAssignments.map((assignment) => [assignment.assignmentId, assignment])
  );
  const assignments = schedule.assignmentIds.map((assignmentId) =>
    assignmentById.get(assignmentId)!
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const h0Validation = await createH0ValidationReceipt(root, fixtureRoot, validation.locks);
  const plan = buildControlledPlan({
    partition: 'DEVELOPMENT',
    locks: validation.locks,
    h0Validation,
    assignmentSchedule: schedule,
    assignments,
    createdAt: '2026-08-01T00:00:00.000Z'
  });
  return { fixtureRoot, validation, assignments, root, plan };
}

function naturalCompletionManifest(driverId: string): LabRunManifest['driver'] {
  return {
    id: driverId,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    serviceTier: 'default',
    seed: null,
    seedControl: 'UNSUPPORTED',
    hardOutputTokenLimit: false,
    hardCallTimeLimit: true,
    textOnlyAttestation: 'HARNESS_DETECTED',
    boundaryClass: 'H1_DEVELOPMENT_HARNESS_VERIFIED',
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true
  };
}

function naturalCompletionOutput(participantCase: LabParticipantCase): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'UNCERTAIN',
    answer: {
      summary: 'The available public evidence does not resolve every proposition.',
      values: [],
      selectedOptionIds: []
    },
    claims: participantCase.propositions.map((proposition, index) => ({
      id: `natural-claim-${index + 1}`,
      propositionId: proposition.id,
      topicId: proposition.topicId,
      stance: 'OPEN',
      statement: proposition.text,
      evidence: [],
      assumptionIds: [],
      confidence: 0.4
    })),
    assumptions: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'INSUFFICIENT_INFORMATION',
      summary: 'No participant disagreement is asserted.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 0.4
  };
}

function manifest(
  locks: LabRunManifest['locks'],
  assignments: LabControlledPlan['assignments'],
  plan: LabControlledPlan,
  providerUsageExplicitlyAuthorized = true,
  runId = 'h1-test'
): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId,
    phase: 'DEVELOPMENT',
    status: 'PLANNED',
    createdAt: '2026-07-31T00:00:00.000Z',
    driver: {
      id: 'scripted-boundary-failure-v1',
      model: 'scripted-boundary-failure',
      reasoningEffort: 'none',
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'PROVIDER_ENFORCED',
      boundaryClass: 'PROVIDER_ENFORCED_STRICT',
      harnessVerifiedTextIsolation: false,
      streamingOutputTokenInterrupt: false,
      providerReportedTokenUsage: true
    },
    locks,
    caseIds: [...new Set(assignments.map((item) => item.caseId))],
    conditionIds: [...new Set(assignments.map((item) => item.conditionId))],
    budgets: {
      maximumCalls: plan.budget.maximumCalls,
      maximumRounds: plan.budget.maximumRoundsPerAssignment,
      maximumOutputTokens:
        plan.budget.maximumCalls * plan.budget.targetOutputTokensPerCall,
      maximumOutputTokenSafetyCeiling:
        plan.budget.maximumCalls * plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
      maximumObservedTotalTokens: plan.budget.maximumObservedTotalTokens,
      maximumCallMs: plan.budget.maximumCallMs,
      maximumExperimentMs: plan.budget.maximumExperimentMs
    },
    providerUsageExplicitlyAuthorized
  };
}

async function createH0ValidationReceipt(
  root: string,
  fixtureRoot: string,
  locks: LabRunManifest['locks']
): Promise<LabControlledPlan['h0Validation']> {
  const plans = listLabProtocolPlans();
  const maximumCalls = plans.reduce(
    (sum, plan) =>
      sum + (plan.conditionId.startsWith('CONTROL_') ? 1 : plan.maximumCalls * 4),
    0
  );
  const h0Ledger = new LabArtifactLedger(root, 'h0-test');
  await h0Ledger.initialize({
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId: 'h0-test',
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
    caseIds: ['DEV-OBJ-03', 'DEV-EVD-04', 'DEV-GAP-01', 'DEV-DEC-01'],
    conditionIds: plans.map((item) => item.conditionId),
    budgets: {
      maximumCalls,
      maximumRounds: 2,
      maximumOutputTokens: plans.reduce(
        (sum, plan) =>
          sum + plan.maximumOutputTokens * (plan.conditionId.startsWith('CONTROL_') ? 1 : 4),
        0
      ),
      maximumOutputTokenSafetyCeiling: plans.reduce(
        (sum, plan) =>
          sum + plan.maximumOutputTokens * (plan.conditionId.startsWith('CONTROL_') ? 1 : 4),
        0
      ),
      maximumObservedTotalTokens: 2_000_000,
      maximumCallMs: 2_000,
      maximumExperimentMs: 30_000
    },
    providerUsageExplicitlyAuthorized: false
  });
  await runHarnessValidation(fixtureRoot, h0Ledger);
  return loadH0ValidationReceipt(root, h0Ledger.runId, locks);
}
