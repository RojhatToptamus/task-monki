import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabParticipantCase,
  type LabPublicOutput
} from './contracts';
import {
  buildH1bExperimentManifest,
  runH1bExperiment
} from './h1bExperiment';
import {
  H1B_HARNESS_VALIDATION_SCHEMA_VERSION,
  H1B_HARNESS_VALIDATION_VERSION,
  buildH1bHarnessValidationManifest,
  loadH1bH0ValidationReceipt,
  type H1bHarnessValidationReport
} from './h1bHarnessValidation';
import {
  buildH1bPlan,
  scheduleH1bAssignments,
  type H1bPlan
} from './h1bPlan';
import {
  h1bPublicIntervention,
  loadH1bParticipantCorpus
} from './h1bCorpus';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  type LabComponentLock
} from './ledger';
import { getLabProtocolPlan } from './protocols';
import {
  LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
  LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS,
  LAB_PUBLIC_SCHEMA_PROBE_MODEL,
  LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
  LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS,
  LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
  LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS,
  LAB_PUBLIC_SCHEMA_PROBE_VERSION,
  buildPublicSchemaProbeReport,
  loadPublicSchemaProbeReceipt,
  publicSchemaProbeManifestBudget,
  type LabPublicSchemaProbeReceipt
} from './publicSchemaProbe';
import { materializeInitialLabPrompt } from './runner';
import type { H1bValidationReport } from './h1bValidation';
import type {
  LabBoundaryProbeInput,
  LabDriverCapabilities,
  LabDriverPreflight,
  LabTextCallInput,
  LabTextCallResult,
  LabTextDriver,
  LabTokenUsage
} from './textDriver';

const sourceFixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('H1b development experiment executor', () => {
  it('runs the sealed schedule sequentially in complete fresh-session blocks and opens truth last', async () => {
    const setup = await experimentSetup({ copyOracle: false });
    const oracleDestination = path.join(
      setup.fixtureRoot,
      'corpus',
      'h1b-v1',
      'scorer-only',
      'development-oracles.json'
    );
    const driver = new H1bTestDriver(setup.cases, {
      afterCall: async (callIndex) => {
        if (callIndex === 54) {
          await fs.mkdir(path.dirname(oracleDestination), { recursive: true });
          await fs.copyFile(
            path.join(
              sourceFixtureRoot,
              'corpus',
              'h1b-v1',
              'scorer-only',
              'development-oracles.json'
            ),
            oracleDestination
          );
        }
      }
    });
    const ledger = await initializedExperimentLedger(setup, driver);

    const result = await execute(setup, driver, ledger);

    expect(result.status).toBe('COMPLETED');
    expect(result.runs).toHaveLength(54);
    expect(driver.calls).toHaveLength(54);
    expect(new Set(result.runs.map((item) =>
      item.run.calls[0]!.session!.providerThreadId
    )).size).toBe(54);
    expect(result.blockOutcomes).toHaveLength(18);
    expect(result.blockOutcomes.every((block) => block.disposition === 'COMPLETE')).toBe(true);
    expect(result.assignmentOutcomes.every((item) => item.disposition === 'SETTLED')).toBe(true);
    expect(result.aggregate).toMatchObject({
      plannedAssignments: 54,
      settledAssignments: 54,
      unstartedAssignments: 0,
      completeBlocks: 18,
      incompleteBlocks: 0,
      dispatchedCalls: 54,
      usageKnownCalls: 54,
      usageUnknownCalls: 0,
      totalTokens: 10_800
    });
    expect(driver.calls.every((call) =>
      call.model === 'gpt-5.6-sol' &&
      call.reasoningEffort === 'high' &&
      call.serviceTier === 'default' &&
      call.seed === undefined &&
      call.continuation === undefined &&
      call.maximumOutputTokens === 900 &&
      call.outputTokenSafetyCeiling === 25_000
    )).toBe(true);
  });

  it('retains the full threshold-crossing block and stops before the next block', async () => {
    const setup = await experimentSetup();
    const driver = new H1bTestDriver(setup.cases, { totalTokensPerCall: 210_000 });
    const ledger = await initializedExperimentLedger(setup, driver);

    const result = await execute(setup, driver, ledger);

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('HARD_TOKEN_CAP_BETWEEN_BLOCKS');
    expect(result.runs).toHaveLength(3);
    expect(result.blockOutcomes[0]).toMatchObject({
      disposition: 'COMPLETE',
      settledAssignmentIds: expect.any(Array)
    });
    expect(result.blockOutcomes[0]!.settledAssignmentIds).toHaveLength(3);
    expect(result.blockOutcomes.slice(1).every((block) => block.disposition === 'NOT_STARTED'))
      .toBe(true);
    expect(result.aggregate).toMatchObject({
      knownTotalTokens: 630_000,
      completeBlocks: 1,
      incompleteBlocks: 0,
      unstartedBlocks: 17,
      unstartedAssignments: 51
    });
  });

  it('stops immediately on fresh-session attestation failure and preserves the incomplete block', async () => {
    const setup = await experimentSetup();
    const driver = new H1bTestDriver(setup.cases, { reuseFirstThreadAtCall: 2 });
    const ledger = await initializedExperimentLedger(setup, driver);

    const result = await execute(setup, driver, ledger);

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('SESSION_ATTESTATION_FAILURE');
    expect(result.runs).toHaveLength(2);
    expect(result.blockOutcomes[0]).toMatchObject({
      disposition: 'INCOMPLETE',
      primaryAnalysisEligible: false
    });
    expect(result.assignmentOutcomes.filter((item) =>
      item.disposition === 'NOT_STARTED_DUE_TO_EXPERIMENT_STOP'
    )).toHaveLength(52);
    expect(result.runs[1]!.stoppingReasons).toContain('SESSION_ATTESTATION_FAILURE');
  });

  it('does not repair an invalid primary and reports its raw schema failure', async () => {
    const setup = await experimentSetup();
    const driver = new H1bTestDriver(setup.cases, { invalidJsonAtCalls: [1, 2] });
    const ledger = await initializedExperimentLedger(setup, driver);

    const result = await execute(setup, driver, ledger);

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('SCHEMA_FAILURES');
    expect(driver.calls).toHaveLength(2);
    expect(result.runs.every((item) =>
      item.run.callAccounting.map((call) => call.purpose).join(',') === 'PRIMARY'
    )).toBe(true);
    expect(result.runs[0]!.run.calls[0]!.rawText).toBe('{not-json');
    expect(result.runs[0]!.score.validSemanticObservation).toBe(false);
    expect(result.aggregate.validationErrors).toBeGreaterThan(0);
  });

  it('uses two consecutive clean pre-turn infrastructure failures without mislabeling usage', async () => {
    const setup = await experimentSetup();
    const driver = new H1bTestDriver(setup.cases, {
      preTurnProviderErrorAtCalls: [1, 2]
    });
    const ledger = await initializedExperimentLedger(setup, driver);

    const result = await execute(setup, driver, ledger);

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('PROVIDER_FAILURES');
    expect(result.runs).toHaveLength(2);
    expect(result.stoppingReasons).not.toContain('MISSING_USAGE');
    expect(result.stoppingReasons).not.toContain('SESSION_ATTESTATION_FAILURE');
    expect(result.runs.map((item) =>
      item.counterState.consecutiveProviderFailuresAfterAssignment
    )).toEqual([1, 2]);
    expect(result.aggregate).toMatchObject({
      providerTurnsStarted: 0,
      usageKnownCalls: 0,
      usageUnknownCalls: 2,
      totalTokens: null
    });
  });

  it('resets both sealed consecutive-failure counters after valid semantic observations', async () => {
    const setup = await experimentSetup();
    const driver = new H1bTestDriver(setup.cases, {
      invalidJsonAtCalls: [1, 3],
      preTurnProviderErrorAtCalls: [4, 6]
    });
    const ledger = await initializedExperimentLedger(setup, driver);

    const result = await execute(setup, driver, ledger);

    expect(result.status).toBe('COMPLETED');
    expect(result.runs[0]!.counterState.consecutiveSchemaFailuresAfterAssignment).toBe(1);
    expect(result.runs[1]!.counterState.consecutiveSchemaFailuresAfterAssignment).toBe(0);
    expect(result.runs[2]!.counterState.consecutiveSchemaFailuresAfterAssignment).toBe(1);
    expect(result.runs[3]!.counterState.consecutiveProviderFailuresAfterAssignment).toBe(1);
    expect(result.runs[4]!.counterState.consecutiveProviderFailuresAfterAssignment).toBe(0);
    expect(result.runs[5]!.counterState.consecutiveProviderFailuresAfterAssignment).toBe(1);
  });

  it('stops on missing provider usage without estimating or dropping the observed call', async () => {
    const setup = await experimentSetup();
    const driver = new H1bTestDriver(setup.cases, { missingUsageAtCall: 1 });
    const ledger = await initializedExperimentLedger(setup, driver);

    const result = await execute(setup, driver, ledger);

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('MISSING_USAGE');
    expect(result.runs).toHaveLength(1);
    expect(result.aggregate).toMatchObject({
      usageKnownCalls: 0,
      usageUnknownCalls: 1,
      totalTokens: null,
      knownTotalTokens: 0
    });
    expect(result.runs[0]!.run.calls[0]!.usage).toBeUndefined();
  });

  it('rejects settings and H0 receipt drift before any provider call', async () => {
    const setup = await experimentSetup();
    const driver = new H1bTestDriver(setup.cases);
    const ledger = await initializedExperimentLedger(setup, driver);

    await expect(runH1bExperiment({
      ...baseInput(setup, driver, ledger),
      reasoningEffort: 'medium'
    })).rejects.toThrow('exact sealed model');
    expect(driver.calls).toHaveLength(0);

    setup.plan.h0Validation.reportSha256 = 'f'.repeat(64);
    await expect(execute(setup, driver, ledger)).rejects.toThrow('h0ValidationReceipt');
    expect(driver.calls).toHaveLength(0);
  });
});

interface ExperimentSetup {
  root: string;
  stateRoot: string;
  fixtureRoot: string;
  validation: H1bValidationReport;
  plan: H1bPlan;
  cases: LabParticipantCase[];
  schemaProbeReceipt: LabPublicSchemaProbeReceipt;
}

async function experimentSetup(options: { copyOracle?: boolean } = {}): Promise<ExperimentSetup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1b-experiment-'));
  temporaryRoots.push(root);
  const fixtureRoot = path.join(root, 'evaluation', 'discourse-lab');
  const participantDestination = path.join(
    fixtureRoot,
    'corpus',
    'h1b-v1',
    'participants',
    'development.json'
  );
  await fs.mkdir(path.dirname(participantDestination), { recursive: true });
  await fs.copyFile(
    path.join(
      sourceFixtureRoot,
      'corpus',
      'h1b-v1',
      'participants',
      'development.json'
    ),
    participantDestination
  );
  if (options.copyOracle !== false) {
    const oracleDestination = path.join(
      fixtureRoot,
      'corpus',
      'h1b-v1',
      'scorer-only',
      'development-oracles.json'
    );
    await fs.mkdir(path.dirname(oracleDestination), { recursive: true });
    await fs.copyFile(
      path.join(
        sourceFixtureRoot,
        'corpus',
        'h1b-v1',
        'scorer-only',
        'development-oracles.json'
      ),
      oracleDestination
    );
  }
  const participants = await loadH1bParticipantCorpus(fixtureRoot);
  const locks = componentLocks();
  const validation: H1bValidationReport = {
    valid: true,
    sealVersion: 'h1b-seal-v1',
    preregistrationVersion: 'h1b-preregistration-v1',
    verifiedFiles: [],
    sourceLock: {
      version: 'typescript-local-import-closure@v1',
      entryFiles: ['src/dev/discourseLab/h1bCli.ts'],
      sourceFiles: ['src/dev/discourseLab/h1bExperiment.ts'],
      sha256: locks.labSourceSha256
    },
    locks
  };
  const stateRoot = path.join(root, 'state');
  const h0RunId = 'h1b-h0-test';
  const h0Ledger = new LabArtifactLedger(stateRoot, h0RunId);
  await h0Ledger.initialize(buildH1bHarnessValidationManifest(
    h0RunId,
    locks,
    '2026-08-01T00:00:00.000Z'
  ));
  const scheduled = scheduleH1bAssignments(participants.records);
  const recordByCase = new Map(participants.records.map((record) => [record.caseId, record]));
  const promptSet = await h0Ledger.putArtifact({
    kind: 'H1B_H0_MATERIALIZED_PROMPT_SET',
    scheduleVersion: scheduled.schedule.version,
    scheduleSha256: scheduled.schedule.assignmentOrderSha256,
    prompts: scheduled.assignments.map((assignment) => {
      const record = recordByCase.get(assignment.caseId)!;
      const intervention = h1bPublicIntervention(record, assignment.conditionId);
      const prepared = materializeInitialLabPrompt({
        participantCase: record.participantCase,
        plan: getLabProtocolPlan(assignment.conditionId),
        ...(intervention ? { intervention } : {}),
        maximumInputTokensPerCall: 7_000
      });
      return {
        assignmentId: assignment.assignmentId,
        blockId: assignment.blockId,
        caseId: assignment.caseId,
        repetition: assignment.repetition,
        position: assignment.position,
        conditionId: assignment.conditionId,
        promptArtifactSha256: prepared.promptArtifactSha256,
        estimatedPromptTokens: Math.ceil(Buffer.byteLength(prepared.prompt, 'utf8') / 4),
        prompt: prepared.prompt
      };
    })
  });
  const report: H1bHarnessValidationReport = {
    schemaVersion: H1B_HARNESS_VALIDATION_SCHEMA_VERSION,
    validationVersion: H1B_HARNESS_VALIDATION_VERSION,
    hypothesisId: 'H0-H1B',
    status: 'PASSED',
    componentLocks: structuredClone(locks),
    scheduleVersion: 'h1b-latin-block-order@v1',
    scheduleSha256: scheduled.schedule.assignmentOrderSha256,
    promptSetSha256: promptSet.sha256,
    maximumEstimatedPromptTokens: 1_000,
    sourceLock: structuredClone(validation.sourceLock),
    checks: h0Checks()
  };
  await h0Ledger.writeReport('h1b-h0-validation', report);
  const receipt = await loadH1bH0ValidationReceipt(stateRoot, h0RunId, locks);
  const plan = buildH1bPlan({
    cases: participants.records,
    locks,
    h0Validation: receipt,
    createdAt: '2026-08-01T00:01:00.000Z'
  });
  const schemaProbeReceipt = await createSchemaProbeReceipt(stateRoot, locks);
  return {
    root,
    stateRoot,
    fixtureRoot,
    validation,
    plan,
    cases: participants.records.map((record) => record.participantCase),
    schemaProbeReceipt
  };
}

async function initializedExperimentLedger(
  setup: ExperimentSetup,
  driver: LabTextDriver
): Promise<LabArtifactLedger> {
  const runId = `h1b-development-${Math.random().toString(16).slice(2)}`;
  const ledger = new LabArtifactLedger(setup.stateRoot, runId);
  await ledger.initialize(buildH1bExperimentManifest({
    runId,
    validation: setup.validation,
    plan: setup.plan,
    driver,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    serviceTier: 'default',
    schemaProbeReceipt: setup.schemaProbeReceipt,
    createdAt: '2026-08-01T00:02:00.000Z'
  }));
  return ledger;
}

function baseInput(
  setup: ExperimentSetup,
  driver: LabTextDriver,
  ledger: LabArtifactLedger
) {
  return {
    fixtureRoot: setup.fixtureRoot,
    validation: setup.validation,
    plan: setup.plan,
    driver,
    ledger,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    serviceTier: 'default',
    schemaProbeReceipt: setup.schemaProbeReceipt
  } as const;
}

function execute(
  setup: ExperimentSetup,
  driver: LabTextDriver,
  ledger: LabArtifactLedger
) {
  return runH1bExperiment(baseInput(setup, driver, ledger));
}

async function createSchemaProbeReceipt(
  stateRoot: string,
  locks: LabComponentLock
): Promise<LabPublicSchemaProbeReceipt> {
  const runId = 'h1b-schema-probe-test';
  const ledger = new LabArtifactLedger(stateRoot, runId);
  await ledger.initialize({
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId,
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt: '2026-08-01T00:00:30.000Z',
    driver: {
      id: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
      model: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      reasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
      serviceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: false,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'HARNESS_DETECTED',
      boundaryClass: 'H1_DEVELOPMENT_HARNESS_VERIFIED',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: true,
      providerReportedTokenUsage: true
    },
    locks: structuredClone(locks),
    caseIds: [],
    conditionIds: [],
    budgets: publicSchemaProbeManifestBudget(),
    providerUsageExplicitlyAuthorized: true
  });
  const at = '2026-08-01T00:00:31.000Z';
  const usage = usageFor(200);
  const boundary: LabDriverPreflight = {
    driverId: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
    ready: true,
    accountPresent: true,
    requiresAuthentication: false,
    models: [{
      id: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      model: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      displayName: 'H1b test Sol',
      isDefault: true,
      supportedReasoningEfforts: [LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT]
    }],
    capabilities: {
      textOnlyProviderEnforced: false,
      hardOutputTokenLimit: false,
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: true,
      providerReportedTokenUsage: true,
      hardCallTimeLimit: true,
      continuation: true,
      samplingSeed: false
    },
    boundary: {
      status: 'ATTESTED',
      requestedModel: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      observedModel: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      requestedReasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
      observedReasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
      requestedServiceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
      observedServiceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
      instructionSources: [],
      mcpStartupEvents: [],
      mismatchFields: []
    },
    limitationNotes: []
  };
  const call: LabTextCallResult = {
    callKey: `${LAB_PUBLIC_SCHEMA_PROBE_VERSION}:attempt-1`,
    session: {
      driverId: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
      providerThreadId: 'schema-probe-thread'
    },
    providerTurnId: 'schema-probe-turn',
    rawText: JSON.stringify(schemaProbeOutput()),
    submittedAt: at,
    acknowledgedAt: at,
    startedAt: at,
    firstOutputAt: at,
    completedAt: at,
    requestedModel: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
    observedModel: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
    requestedReasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
    observedReasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
    requestedServiceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
    observedServiceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
    seed: null,
    usage: { total: usage, last: usage },
    tokenControl: {
      targetOutputTokens: LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS,
      safetyCeilingOutputTokens: LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS,
      providerEnforcedLimit: false,
      usageStatus: 'PROVIDER_REPORTED',
      observedOutputTokens: usage.outputTokens,
      targetOvershootTokens: 0,
      safetyOvershootTokens: 0
    },
    providerStatus: 'completed',
    providerAccounting: {
      sessionAttestation: 'ATTESTED',
      threadStartStatus: 'ATTESTED',
      providerTurnStarted: 'YES',
      billableModelCall: 'YES'
    },
    violations: [],
    lifecycle: [
      { event: 'submitted', at },
      { event: 'acknowledged', at },
      { event: 'started', at },
      { event: 'terminal', at },
      { event: 'provider-usage-observed', at },
      { event: 'result-recorded', at }
    ]
  };
  const report = buildPublicSchemaProbeReport({
    runId,
    startedAt: at,
    completedAt: at,
    componentLocks: locks,
    boundary,
    call,
    close: {
      status: 'CLEAN',
      startedAt: at,
      completedAt: at,
      elapsedMs: 0,
      maximumMs: LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS,
      boundaryViolations: []
    }
  });
  expect(report.status).toBe('PASSED');
  await ledger.writeReport('public-schema-probe', report);
  return loadPublicSchemaProbeReceipt(stateRoot, runId, locks);
}

function schemaProbeOutput(): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'ANSWER',
    answer: { summary: 'Two plus two equals four.', values: ['4'], selectedOptionIds: [] },
    claims: [],
    assumptions: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No material issue.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 1
  };
}

class H1bTestDriver implements LabTextDriver {
  readonly id = LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID;
  readonly capabilities: LabDriverCapabilities = {
    textOnlyProviderEnforced: false,
    hardOutputTokenLimit: false,
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: false,
    samplingSeed: false
  };
  readonly calls: LabTextCallInput[] = [];
  private readonly caseById: Map<string, LabParticipantCase>;
  private firstThreadId: string | undefined;

  constructor(
    cases: readonly LabParticipantCase[],
    private readonly options: {
      totalTokensPerCall?: number;
      invalidJsonAtCalls?: number[];
      missingUsageAtCall?: number;
      reuseFirstThreadAtCall?: number;
      preTurnProviderErrorAtCalls?: number[];
      afterCall?: (callIndex: number) => Promise<void>;
    } = {}
  ) {
    this.caseById = new Map(cases.map((participantCase) => [participantCase.caseId, participantCase]));
  }

  preflight(input?: LabBoundaryProbeInput): Promise<LabDriverPreflight> {
    return Promise.resolve({
      driverId: this.id,
      ready: true,
      accountPresent: true,
      requiresAuthentication: false,
      models: [{
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'H1b test Sol',
        isDefault: true,
        supportedReasoningEfforts: ['high']
      }],
      capabilities: structuredClone(this.capabilities),
      boundary: {
        status: 'ATTESTED',
        requestedModel: input?.model,
        observedModel: input?.model,
        requestedReasoningEffort: input?.reasoningEffort ?? null,
        observedReasoningEffort: input?.reasoningEffort ?? null,
        requestedServiceTier: input?.serviceTier ?? null,
        observedServiceTier: input?.serviceTier ?? null,
        instructionSources: [],
        mcpStartupEvents: [],
        mismatchFields: []
      },
      limitationNotes: ['Deterministic local test double.']
    });
  }

  async call(input: LabTextCallInput): Promise<LabTextCallResult> {
    this.calls.push(structuredClone(input));
    const callIndex = this.calls.length;
    const caseId = [...this.caseById.keys()].find((candidate) =>
      input.callKey.includes(`:${candidate}:`)
    );
    if (!caseId) throw new Error(`Test driver cannot resolve case from ${input.callKey}.`);
    const now = new Date().toISOString();
    const uniqueThreadId = `h1b-test-thread-${callIndex}`;
    this.firstThreadId ??= uniqueThreadId;
    const providerThreadId = callIndex === this.options.reuseFirstThreadAtCall
      ? this.firstThreadId
      : uniqueThreadId;
    const rawText = this.options.invalidJsonAtCalls?.includes(callIndex)
      ? '{not-json'
      : JSON.stringify(validOutput(this.caseById.get(caseId)!));
    const usage = usageFor(this.options.totalTokensPerCall ?? 200);
    await this.options.afterCall?.(callIndex);
    if (this.options.preTurnProviderErrorAtCalls?.includes(callIndex)) {
      return {
        callKey: input.callKey,
        rawText: '',
        submittedAt: now,
        completedAt: now,
        requestedModel: input.model,
        requestedReasoningEffort: input.reasoningEffort,
        requestedServiceTier: input.serviceTier ?? null,
        seed: input.seed ?? null,
        providerStatus: 'failed-before-turn',
        failure: {
          kind: 'PROVIDER_ERROR',
          message: 'Deterministic clean pre-turn infrastructure failure.'
        },
        providerAccounting: {
          sessionAttestation: 'NOT_PRESENT',
          threadStartStatus: 'NOT_STARTED',
          providerTurnStarted: 'NO',
          billableModelCall: 'NO'
        },
        violations: [],
        lifecycle: [
          { event: 'submitted', at: now },
          { event: 'failed-before-turn', at: now }
        ]
      };
    }
    return {
      callKey: input.callKey,
      session: { driverId: this.id, providerThreadId },
      providerTurnId: `h1b-test-turn-${callIndex}`,
      rawText,
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
      seed: input.seed ?? null,
      ...(callIndex === this.options.missingUsageAtCall ? {} : {
        usage: { total: usage, last: usage },
        tokenControl: {
          targetOutputTokens: input.maximumOutputTokens,
          safetyCeilingOutputTokens: input.outputTokenSafetyCeiling!,
          providerEnforcedLimit: false,
          usageStatus: 'PROVIDER_REPORTED' as const,
          observedOutputTokens: usage.outputTokens,
          targetOvershootTokens: Math.max(0, usage.outputTokens - input.maximumOutputTokens),
          safetyOvershootTokens: Math.max(
            0,
            usage.outputTokens - input.outputTokenSafetyCeiling!
          )
        }
      }),
      providerStatus: 'completed',
      providerAccounting: {
        sessionAttestation: 'ATTESTED',
        threadStartStatus: 'ATTESTED',
        providerTurnStarted: 'YES',
        billableModelCall: 'YES'
      },
      violations: [],
      lifecycle: [
        { event: 'submitted', at: now },
        { event: 'started', at: now },
        { event: 'completed', at: now }
      ]
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function validOutput(participantCase: LabParticipantCase): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'ANSWER',
    answer: {
      summary: 'A concise public test answer.',
      values: [],
      selectedOptionIds: participantCase.options[0] ? [participantCase.options[0].id] : []
    },
    claims: participantCase.propositions.map((proposition, index) => ({
      id: `claim-${index + 1}`,
      propositionId: proposition.id,
      topicId: proposition.topicId,
      stance: 'ACCEPT',
      statement: `Public assessment of ${proposition.id}.`,
      evidence: [],
      assumptionIds: [],
      confidence: 0.7
    })),
    assumptions: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No material issue is asserted by this harness output.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 0.7
  };
}

function usageFor(totalTokens: number): LabTokenUsage {
  return {
    inputTokens: totalTokens - 150,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 50,
    totalTokens
  };
}

function componentLocks(): LabComponentLock {
  return {
    corpusVersion: 'h1b-text-corpus-v1',
    participantCorpusSha256: '1'.repeat(64),
    oracleCorpusSha256: '2'.repeat(64),
    labSourceSha256: '3'.repeat(64),
    preregistrationVersion: 'h1b-preregistration-v1',
    preregistrationSha256: '4'.repeat(64),
    promptVersion: 'text-lab-prompts-v6',
    outputSchemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    scoringVersion: 'h1b-contextual-metrics@v1',
    protocolVersion: 'text-protocols@v4'
  };
}

function h0Checks(): H1bHarnessValidationReport['checks'] {
  return [
    'SEALED_COMPONENT_AND_TRANSITIVE_SOURCE_LOCKS',
    'SIX_CASE_18_BLOCK_54_ASSIGNMENT_MATRIX',
    'LATIN_POSITION_COUNTERBALANCE',
    'BYTE_IDENTICAL_REPETITIONS',
    'CASE_ONLY_HAS_NO_FIXED_PREFIX_OR_SIGNAL',
    'SCORER_TRUTH_FIREWALL',
    'STRUCTURED_CRITIQUE_TARGET',
    'EVIDENCE_IS_NOT_A_CRITIQUE',
    'PREPARED_PROMPT_CEILING',
    'ZERO_PROVIDER_CALLS'
  ].map((checkId) => ({ checkId, status: 'PASSED' as const, detail: 'Test receipt.' }));
}
