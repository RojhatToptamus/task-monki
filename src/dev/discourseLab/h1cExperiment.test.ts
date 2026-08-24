import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  h1cOracleFixturePath,
  h1cParticipantFixturePath,
  loadH1cOracleCorpus,
  loadH1cParticipantCorpus,
  type H1cConditionId,
  type H1cOracleProfile,
  type H1cOracleRecord,
  type H1cParticipantRecord
} from './h1cCorpus';
import {
  buildH1cExperimentManifest,
  runH1cExperiment
} from './h1cExperiment';
import {
  buildH1cHarnessValidationManifest,
  loadH1cH0ValidationReceipt,
  runH1cHarnessValidation
} from './h1cHarnessValidation';
import { buildH1cPlan, type H1cPlan } from './h1cPlan';
import {
  H1C_PROBE_DRIVER_ID,
  H1C_PROBE_MODEL,
  H1C_PROBE_REASONING_EFFORT,
  H1C_PROBE_SERVICE_TIER,
  buildH1cProbeManifest,
  loadH1cProbeReceipt,
  runH1cProbe,
  type H1cProbeDriver,
  type H1cProbeReceipt
} from './h1cProbe';
import type { H1cValidationReport } from './h1cValidation';
import { LabArtifactLedger, sha256File } from './ledger';
import {
  LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  type LabPublicOutputV4
} from './outputV4';
import type {
  LabDriverPreflight,
  LabTextCallInput,
  LabTextCallResult,
  LabTokenUsage
} from './textDriver';

const fixtureRoot = path.resolve('evaluation/discourse-lab');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe('H1c live-yoked evaluation runner', () => {
  it('runs the exact 28-call topology, preserves raw and parsed artifacts, and opens truth last', async () => {
    const fixture = await experimentFixture({ withholdRuntimeOracle: true });
    const driver = fixture.driver(async (input, index) => {
      expect(await fileExists(h1cOracleFixturePath(fixture.runtimeFixtureRoot))).toBe(false);
      if (index === 27) await fixture.releaseRuntimeOracle();
      return JSON.stringify(fixture.outputForCall(input));
    });
    const result = await fixture.run(driver);

    expect(result.status).toBe('COMPLETED');
    expect(result.runs).toHaveLength(28);
    expect(result.preparedPrompts).toHaveLength(28);
    expect(result.aggregate).toMatchObject({
      dispatchedCalls: 28,
      providerTurnsStarted: 28,
      usageKnownCalls: 28,
      usageUnknownCalls: 0,
      completeBlocks: 8,
      totalTokens: 28_000
    });
    expect(result.scoringStatus).toBe('SCORED');
    expect(result.interpretationStatus).toBe('AUDITABLE_DEVELOPMENT_RESULT');
    expect(result.interpretation).toMatchObject({
      overall: 'PARTIALLY_QUALIFIED',
      derivableCritique: { status: 'ASSAY_NOT_INFORMATIVE' },
      newEvidence: { status: 'EVIDENCE_ASSAY_QUALIFIED' },
      productClaimAuthorized: false,
      confirmationOpened: false
    });

    const selfReviews = result.runs.filter((item) =>
      item.assignment.conditionId === 'ACTIVE_SELF_REVIEW'
    );
    expect(selfReviews).toHaveLength(8);
    for (const self of selfReviews) {
      const initial = result.runs.find((item) =>
        item.assignment.blockId === self.assignment.blockId &&
        item.assignment.conditionId === 'STRONG_INITIAL'
      )!;
      expect(self.requestedContinuation).toEqual(initial.call.session);
      expect(self.call.session).toEqual(initial.call.session);
      expect(self.call.providerAccounting.threadStartStatus).toBe('NOT_REQUIRED');
    }
    const fresh = result.runs.filter((item) => item.assignment.threadMode === 'FRESH');
    expect(fresh).toHaveLength(20);
    expect(new Set(fresh.map((item) => item.call.session!.providerThreadId)).size).toBe(20);
    expect(result.runs.every((item) =>
      item.outputRecord.repairAttempted === false &&
      item.outputRecord.attempts.length === 1 &&
      item.prompt.prompt.includes('Return only the public JSON object.')
    )).toBe(true);

    const first = result.runs[0]!;
    const rawArtifact = await readArtifact(fixture.ledger, first.callArtifactSha256);
    const parsedArtifact = await readArtifact(fixture.ledger, first.outputArtifactSha256);
    expect(rawArtifact).toMatchObject({
      kind: 'H1C_RAW_CALL',
      call: { rawText: first.call.rawText, usage: first.call.usage }
    });
    expect(parsedArtifact).toMatchObject({
      kind: 'H1C_PARSED_OUTPUT',
      rawCallArtifactSha256: first.callArtifactSha256,
      outputRecord: { status: 'VALID', repairAttempted: false }
    });
    expect(await fileExists(h1cOracleFixturePath(fixture.runtimeFixtureRoot))).toBe(true);
  });

  it('checks retrospective usage only after retaining a complete threshold-crossing block', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async (input) =>
      JSON.stringify(fixture.outputForCall(input)), { totalTokensPerCall: 100_000 });
    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'HARD_TOKEN_CAP_BETWEEN_BLOCKS',
      aggregate: {
        settledAssignments: 4,
        completeBlocks: 1,
        totalTokens: 400_000
      }
    });
    expect(result.runs.map((item) => item.assignment.blockId)).toEqual([
      'H1C-D5:r1', 'H1C-D5:r1', 'H1C-D5:r1', 'H1C-D5:r1'
    ]);
    expect(result.assignmentOutcomes.filter((item) => item.disposition === 'SETTLED'))
      .toHaveLength(4);
  });

  it('fails closed when same-thread self-review returns a different session', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async (input) => JSON.stringify(fixture.outputForCall(input)), {
      mutateResult: (result, input, index) => index === 1
        ? {
            ...result,
            session: {
              driverId: H1C_PROBE_DRIVER_ID,
              providerThreadId: 'illegitimate-fresh-self-thread'
            }
          }
        : result
    });
    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'BOUNDARY_VIOLATION',
      interpretationStatus: 'INVALIDATED_BY_BOUNDARY_OR_CLOSE',
      interpretation: {
        overall: 'INVALIDATED',
        derivableCritique: { status: 'INCONCLUSIVE' },
        newEvidence: { status: 'INCONCLUSIVE' }
      },
      aggregate: { settledAssignments: 2 }
    });
    expect(result.runs[1]!.stoppingReasons).toContain('BOUNDARY_VIOLATION');
    expect(result.runs[1]!.requestedContinuation).toEqual(result.runs[0]!.call.session);
  });

  it('fails closed when the provider replays a turn id across assignments', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async (input) => JSON.stringify(fixture.outputForCall(input)), {
      mutateResult: (result, _input, index) => index === 1
        ? { ...result, providerTurnId: 'h1c-turn-1' }
        : result
    });

    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'BOUNDARY_VIOLATION',
      aggregate: { settledAssignments: 2 }
    });
    expect(result.runs[1]!.stoppingReasons).toContain('BOUNDARY_VIOLATION');
  });

  it('accepts second-granularity provider start timestamps when journals prove ordering', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async (input) => JSON.stringify(fixture.outputForCall(input)), {
      mutateResult: (result) => {
        applyProviderSecondPrecisionTiming(result, 13_000);
        return result;
      }
    });

    const result = await fixture.run(driver);

    expect(result.status).toBe('COMPLETED');
    expect(result.aggregate).toMatchObject({ settledAssignments: 28, providerTurnsStarted: 28 });
    expect(result.runs.every((item) =>
      !item.stoppingReasons.includes('BOUNDARY_VIOLATION')
    )).toBe(true);
  });

  it.each([
    ['timestamp skew beyond provider precision', (result: LabTextCallResult) => {
      applyProviderSecondPrecisionTiming(result, 12_886);
    }],
    ['out-of-order lifecycle events', (result: LabTextCallResult) => {
      applyProviderSecondPrecisionTiming(result, 13_000);
      [result.lifecycle[1], result.lifecycle[2]] = [result.lifecycle[2]!, result.lifecycle[1]!];
    }]
  ] as const)('fails closed on %s', async (_label, mutate) => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async (input) => JSON.stringify(fixture.outputForCall(input)), {
      mutateResult: (result, _input, index) => {
        if (index === 0) mutate(result);
        return result;
      }
    });

    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'PROVIDER_FAILURES',
      aggregate: { settledAssignments: 1 }
    });
    expect(result.runs[0]!.stoppingReasons).toContain('PROVIDER_FAILURES');
  });

  it('stops immediately when a started turn lacks complete provider-reported usage', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async (input) => JSON.stringify(fixture.outputForCall(input)), {
      mutateResult: (result, _input, index) => {
        if (index !== 0) return result;
        const missing = { ...result };
        delete missing.usage;
        delete missing.tokenControl;
        return missing;
      }
    });
    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'MISSING_USAGE',
      aggregate: {
        settledAssignments: 1,
        usageKnownCalls: 0,
        usageUnknownCalls: 1,
        totalTokens: null
      }
    });
    expect(result.runs[0]!.call.rawText.length).toBeGreaterThan(0);
  });

  it('retains invalid primaries without repair and stops at two consecutive schema failures', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async () => 'not-json');
    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'CONSECUTIVE_INVALID_OUTPUTS',
      aggregate: { settledAssignments: 2 }
    });
    expect(result.runs.map((item) => item.assignment.conditionId)).toEqual([
      'STRONG_INITIAL', 'STRONG_INITIAL'
    ]);
    expect(result.runs.every((item) =>
      item.outputRecord.status === 'INVALID' &&
      item.outputRecord.repairAttempted === false &&
      item.outputRecord.attempts[0]!.rawText === 'not-json'
    )).toBe(true);
    expect(result.assignmentOutcomes.filter((item) =>
      item.disposition === 'NOT_STARTED_DUE_TO_BLOCK_DEPENDENCY'
    ).length).toBeGreaterThan(0);
  });

  it('retains typed critique-as-factual-evidence noncompliance without a lexical immediate stop', async () => {
    const fixture = await experimentFixture();
    const critiqueArtifactId = fixture.participants.find(
      (record) => record.caseId === 'H1C-D5'
    )!.validCritique!.artifactId;
    const driver = fixture.driver(async (input) => {
      const output = fixture.outputForCall(input);
      if (conditionFrom(input) === 'VALID_CRITIQUE') {
        output.responses[0]!.factualEvidence = [{
          sourceId: critiqueArtifactId,
          relation: 'SUPPORTS',
          note: 'Invalidly treats a review artifact as factual authority.'
        }];
      }
      return JSON.stringify(output);
    });
    const result = await fixture.run(driver);

    expect(result.aggregate.settledAssignments).toBeGreaterThan(3);
    expect(result.runs[2]!.counterState).toMatchObject({
      provenanceFailure: true,
      validSemanticObservation: false
    });
    expect(result.runs[2]!.outputRecord.attempts[0]!.validationErrors.some((error) =>
      error.path.includes('factualEvidence')
    )).toBe(true);
  });

  it('stops after two clean pre-semantic provider failures without fabricating usage', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async () => '', {
      mutateResult: (result, input) => preTurnProviderFailure(result, input)
    });
    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'PROVIDER_FAILURES',
      aggregate: {
        settledAssignments: 2,
        usageKnownCalls: 0,
        usageUnknownCalls: 2,
        totalTokens: null,
        providerFailuresByKind: { PROVIDER_ERROR: 2 }
      }
    });
    expect(result.runs.map((item) =>
      item.counterState.consecutiveProviderFailuresAfterAssignment
    )).toEqual([1, 2]);
  });

  it('re-estimates the actual live-DRAFT prompt and refuses an oversized response before dispatch', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async (input, index) => {
      const output = fixture.outputForCall(input);
      if (index === 0) inflateValidOutput(output);
      return JSON.stringify(output);
    });
    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'UNANSWERABLE_EXPERIMENT',
      aggregate: { settledAssignments: 1, dispatchedCalls: 1 }
    });
    expect(result.preparedPrompts).toHaveLength(2);
    expect(result.preparedPrompts[1]!.assignment.conditionId).toBe('ACTIVE_SELF_REVIEW');
    expect(result.preparedPrompts[1]!.estimatedPromptTokens).toBeGreaterThan(7_000);
    expect(driver.inputs).toHaveLength(1);
  });

  it('keeps scorer truth closed and invalidates interpretation when driver close fails', async () => {
    const fixture = await experimentFixture({ withholdRuntimeOracle: true });
    const driver = fixture.driver(
      async (input) => JSON.stringify(fixture.outputForCall(input)),
      { closeFailure: new AggregateError([new Error('late MCP boundary')], 'close failed') }
    );
    const result = await fixture.run(driver);

    expect(result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'BOUNDARY_VIOLATION',
      scoringStatus: 'UNAVAILABLE',
      interpretationStatus: 'INVALIDATED_BY_BOUNDARY_OR_CLOSE',
      interpretation: {
        overall: 'INVALIDATED',
        derivableCritique: { status: 'INCONCLUSIVE' },
        newEvidence: { status: 'INCONCLUSIVE' },
        productClaimAuthorized: false,
        confirmationOpened: false
      },
      driverClose: {
        status: 'FAILED',
        failure: {
          name: 'AggregateError',
          message: 'close failed',
          errors: [{ message: 'late MCP boundary' }]
        }
      }
    });
    expect(result.runs).toHaveLength(28);
    expect(result.runs.every((item) => item.score === null)).toBe(true);
    expect(await fileExists(h1cOracleFixturePath(fixture.runtimeFixtureRoot))).toBe(false);
  });

  it('leaves setup-deadline closure to the awaited lifecycle owner', async () => {
    const fixture = await experimentFixture();
    const driver = fixture.driver(async (input) => JSON.stringify(fixture.outputForCall(input)));
    const startedMs = Date.now();
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(startedMs)
      .mockReturnValue(startedMs + fixture.plan.budget.maximumExperimentMs + 1);

    try {
      await expect(fixture.run(driver)).rejects.toThrow(
        'participant corpus loading exceeded the hard experiment deadline'
      );
    } finally {
      now.mockRestore();
    }

    expect(driver.closeCalls).toBe(0);
    await driver.close();
    expect(driver.closeCalls).toBe(1);
  });

  it('rejects a v3/substituted probe receipt before experiment-ledger initialization', async () => {
    const fixture = await experimentFixture();
    const forged = structuredClone(fixture.probeReceipt) as H1cProbeReceipt;
    (forged.report as { publicOutputSchemaVersion: string }).publicOutputSchemaVersion =
      'discourse-protocol-lab/public-output-v3';

    expect(() => buildH1cExperimentManifest({
      runId: 'h1c-reject-v3',
      validation: fixture.validation,
      plan: fixture.plan,
      driver: fixture.driver(async () => ''),
      model: H1C_PROBE_MODEL,
      reasoningEffort: H1C_PROBE_REASONING_EFFORT,
      serviceTier: H1C_PROBE_SERVICE_TIER,
      probeReceipt: forged
    })).toThrow('public-output-v4 probe');
  });
});

interface ExperimentFixture {
  validation: H1cValidationReport;
  plan: H1cPlan;
  probeReceipt: H1cProbeReceipt;
  participants: H1cParticipantRecord[];
  oracles: H1cOracleRecord[];
  runtimeFixtureRoot: string;
  ledger: LabArtifactLedger;
  releaseRuntimeOracle(): Promise<void>;
  outputForCall(input: LabTextCallInput): LabPublicOutputV4;
  driver(
    resolve: (input: LabTextCallInput, index: number) => Promise<string> | string,
    options?: H1cTestDriverOptions
  ): H1cTestDriver;
  run(driver: H1cTestDriver): Promise<Awaited<ReturnType<typeof runH1cExperiment>>>;
}

async function experimentFixture(options: {
  withholdRuntimeOracle?: boolean;
} = {}): Promise<ExperimentFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-experiment-'));
  temporaryRoots.push(root);
  const stateRoot = path.join(root, 'state');
  const validation = await testValidation();
  const participants = await loadH1cParticipantCorpus(fixtureRoot);
  const oracleCorpus = await loadH1cOracleCorpus(fixtureRoot, participants);

  const h0RunId = 'h1c-h0';
  const h0Ledger = new LabArtifactLedger(stateRoot, h0RunId);
  await h0Ledger.initialize(buildH1cHarnessValidationManifest(
    h0RunId,
    validation.locks,
    '2026-08-02T10:00:00.000Z'
  ));
  await runH1cHarnessValidation({ fixtureRoot, validation, ledger: h0Ledger });
  const h0Receipt = await loadH1cH0ValidationReceipt(
    stateRoot,
    h0RunId,
    validation.locks
  );
  const plan = buildH1cPlan({
    cases: participants.records,
    locks: validation.locks,
    h0Validation: h0Receipt,
    createdAt: '2026-08-02T10:01:00.000Z'
  });

  const probeRunId = 'h1c-probe';
  const probeLedger = new LabArtifactLedger(stateRoot, probeRunId);
  await probeLedger.initialize(buildH1cProbeManifest({
    runId: probeRunId,
    componentLocks: validation.locks,
    providerUsageExplicitlyAuthorized: true,
    createdAt: '2026-08-02T10:02:00.000Z'
  }));
  const probeDriver = new H1cTestDriver(async () => JSON.stringify(validProbeOutput()));
  await runH1cProbe({
    runId: probeRunId,
    componentLocks: validation.locks,
    ledger: probeLedger,
    driver: probeDriver
  });
  const probeReceipt = await loadH1cProbeReceipt(stateRoot, probeRunId, validation.locks);

  const runtimeFixtureRoot = path.join(root, 'runtime-fixture');
  const participantTarget = h1cParticipantFixturePath(runtimeFixtureRoot);
  const oracleTarget = h1cOracleFixturePath(runtimeFixtureRoot);
  await fs.mkdir(path.dirname(participantTarget), { recursive: true });
  await fs.mkdir(path.dirname(oracleTarget), { recursive: true });
  await fs.copyFile(h1cParticipantFixturePath(fixtureRoot), participantTarget);
  const releaseRuntimeOracle = async () => {
    if (!await fileExists(oracleTarget)) {
      await fs.copyFile(h1cOracleFixturePath(fixtureRoot), oracleTarget);
    }
  };
  if (!options.withholdRuntimeOracle) await releaseRuntimeOracle();

  const runId = 'h1c-development';
  const ledger = new LabArtifactLedger(stateRoot, runId);
  const recordsByCase = new Map(participants.records.map((record) => [record.caseId, record]));
  const oraclesByCase = new Map(oracleCorpus.records.map((oracle) => [oracle.caseId, oracle]));
  const draftByBlock = new Map<string, LabPublicOutputV4>();
  const fixture: ExperimentFixture = {
    validation,
    plan,
    probeReceipt,
    participants: participants.records,
    oracles: oracleCorpus.records,
    runtimeFixtureRoot,
    ledger,
    releaseRuntimeOracle,
    outputForCall(input) {
      const assignment = assignmentFrom(plan, input.callKey);
      const record = recordsByCase.get(assignment.caseId)!;
      const oracle = oraclesByCase.get(assignment.caseId)!;
      const profile = assignment.conditionId === 'DECISIVE_EVIDENCE'
        ? oracle.treatmentProfile
        : oracle.baseProfile;
      const output = outputFor(record, profile);
      if (assignment.conditionId === 'STRONG_INITIAL') {
        draftByBlock.set(assignment.blockId, structuredClone(output));
      }
      if (
        assignment.conditionId === 'VALID_CRITIQUE' ||
        assignment.conditionId === 'PLACEBO_CRITIQUE'
      ) {
        addCritiqueResponse(output, record, assignment.conditionId);
      }
      return output;
    },
    driver(resolve, driverOptions) {
      return new H1cTestDriver(resolve, driverOptions);
    },
    async run(driver) {
      await ledger.initialize(buildH1cExperimentManifest({
        runId,
        validation,
        plan,
        driver,
        model: H1C_PROBE_MODEL,
        reasoningEffort: H1C_PROBE_REASONING_EFFORT,
        serviceTier: H1C_PROBE_SERVICE_TIER,
        probeReceipt,
        createdAt: '2026-08-02T10:03:00.000Z'
      }));
      return runH1cExperiment({
        fixtureRoot: runtimeFixtureRoot,
        validation,
        plan,
        driver,
        ledger,
        model: H1C_PROBE_MODEL,
        reasoningEffort: H1C_PROBE_REASONING_EFFORT,
        serviceTier: H1C_PROBE_SERVICE_TIER,
        probeReceipt
      });
    }
  };
  return fixture;
}

interface H1cTestDriverOptions {
  totalTokensPerCall?: number;
  closeFailure?: Error;
  mutateResult?: (
    result: LabTextCallResult,
    input: LabTextCallInput,
    index: number
  ) => LabTextCallResult;
}

class H1cTestDriver implements H1cProbeDriver {
  readonly id = H1C_PROBE_DRIVER_ID;
  readonly capabilities = validBoundary().capabilities;
  readonly inputs: LabTextCallInput[] = [];
  closeCalls = 0;
  private nextThread = 1;

  constructor(
    private readonly resolve: (
      input: LabTextCallInput,
      index: number
    ) => Promise<string> | string,
    private readonly options: H1cTestDriverOptions = {}
  ) {}

  preflight(): Promise<LabDriverPreflight> {
    return Promise.resolve(validBoundary());
  }

  async call(input: LabTextCallInput): Promise<LabTextCallResult> {
    const index = this.inputs.length;
    this.inputs.push(structuredClone(input));
    const rawText = await this.resolve(input, index);
    const now = new Date().toISOString();
    const session = input.continuation ?? {
      driverId: this.id,
      providerThreadId: `h1c-thread-${this.nextThread++}`,
      providerSessionTreeId: `h1c-tree-${this.nextThread - 1}`
    };
    const usage = usageFor(this.options.totalTokensPerCall ?? 1_000);
    const result: LabTextCallResult = {
      callKey: input.callKey,
      session,
      providerTurnId: `h1c-turn-${index + 1}`,
      rawText,
      submittedAt: now,
      acknowledgedAt: now,
      startedAt: now,
      ...(rawText ? { firstOutputAt: now } : {}),
      completedAt: now,
      requestedModel: input.model,
      observedModel: input.model,
      observedModelProvider: 'openai',
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: input.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      seed: input.seed ?? null,
      usage: { total: structuredClone(usage), last: structuredClone(usage) },
      tokenControl: {
        targetOutputTokens: input.maximumOutputTokens,
        safetyCeilingOutputTokens:
          input.outputTokenSafetyCeiling ?? input.maximumOutputTokens,
        providerEnforcedLimit: false,
        usageStatus: 'PROVIDER_REPORTED',
        observedOutputTokens: usage.outputTokens,
        targetOvershootTokens: Math.max(0, usage.outputTokens - input.maximumOutputTokens),
        safetyOvershootTokens: Math.max(
          0,
          usage.outputTokens - (input.outputTokenSafetyCeiling ?? input.maximumOutputTokens)
        )
      },
      providerStatus: 'completed',
      providerAccounting: {
        sessionAttestation: 'ATTESTED',
        threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
        providerTurnStarted: 'YES',
        billableModelCall: 'YES'
      },
      violations: [],
      lifecycle: [
        { event: 'submitted', at: now },
        { event: 'acknowledged', at: now },
        { event: 'started', at: now },
        { event: 'provider-usage-observed', at: now },
        { event: 'terminal', at: now, detail: { status: 'completed' } },
        { event: 'result-recorded', at: now }
      ]
    };
    return this.options.mutateResult?.(result, input, index) ?? result;
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return this.options.closeFailure
      ? Promise.reject(this.options.closeFailure)
      : Promise.resolve();
  }

  getProcessBoundaryViolations(): string[] {
    return [];
  }
}

function validBoundary(): LabDriverPreflight {
  const capabilities = {
    textOnlyProviderEnforced: false,
    hardOutputTokenLimit: false,
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: false
  } as const;
  return {
    driverId: H1C_PROBE_DRIVER_ID,
    ready: true,
    accountPresent: true,
    requiresAuthentication: false,
    models: [{
      id: H1C_PROBE_MODEL,
      model: H1C_PROBE_MODEL,
      displayName: 'GPT-5.6-Sol scripted test double',
      isDefault: true,
      supportedReasoningEfforts: [H1C_PROBE_REASONING_EFFORT]
    }],
    capabilities,
    boundary: {
      status: 'ATTESTED',
      requestedModel: H1C_PROBE_MODEL,
      observedModel: H1C_PROBE_MODEL,
      observedModelProvider: 'openai',
      requestedReasoningEffort: H1C_PROBE_REASONING_EFFORT,
      observedReasoningEffort: H1C_PROBE_REASONING_EFFORT,
      requestedServiceTier: H1C_PROBE_SERVICE_TIER,
      observedServiceTier: H1C_PROBE_SERVICE_TIER,
      instructionSources: [],
      mcpStartupEvents: [],
      mismatchFields: []
    },
    limitationNotes: []
  };
}

function usageFor(totalTokens: number): LabTokenUsage {
  const outputTokens = Math.min(200, totalTokens);
  const reasoningOutputTokens = Math.min(100, outputTokens);
  return {
    totalTokens,
    inputTokens: Math.max(0, totalTokens - outputTokens),
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens
  };
}

function assignmentFrom(plan: H1cPlan, callKey: string) {
  const assignment = plan.assignments.find((item) => item.assignmentId === callKey);
  if (!assignment) throw new Error(`Unknown scripted assignment ${callKey}.`);
  return assignment;
}

function conditionFrom(input: LabTextCallInput): H1cConditionId {
  return input.callKey.split(':').at(-1) as H1cConditionId;
}

function outputFor(
  participant: H1cParticipantRecord,
  profile: H1cOracleProfile
): LabPublicOutputV4 {
  const informationRequests = profile.informationRequest
    ? [{
        id: 'request-1',
        kind: profile.informationRequest.kind,
        needed: 'The exact missing predicate identified in the public case.',
        question: 'Please provide the exact missing predicate identified in the public case.',
        source: profile.informationRequest.source,
        blocking: profile.informationRequest.blocking,
        propositionIds: [...profile.informationRequest.requiredPropositionIds]
      }]
    : [];
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    completionDisposition: profile.completionDisposition,
    answer: {
      summary: 'Concise answer matching the scripted public evidence profile.',
      selectedOptionIds: [...profile.selectedOptionIds],
      epistemicState: profile.epistemicState,
      assessmentConfidence: 0.95
    },
    propositionAssessments: profile.claims.map((claim, index) => {
      const proposition = participant.participantCase.propositions.find(
        (item) => item.id === claim.propositionId
      )!;
      return {
        id: `assessment-${index + 1}`,
        propositionId: claim.propositionId,
        topicId: proposition.topicId,
        assessment: claim.assessment,
        statement: proposition.text,
        factualEvidence: claim.requiredEvidenceAlternatives[0]!.map((item) => ({
          sourceId: item.evidenceId,
          relation: item.relation,
          note: 'Exact public factual source and proposition-appropriate direction.'
        })),
        artifactReferences: [],
        assumptionIds: [],
        assessmentConfidence: 0.95
      };
    }),
    assumptions: [],
    issues: [],
    selfCorrections: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: profile.completionDisposition === 'NEEDS_USER_ACTION'
        ? 'NEEDS_USER_ACTION'
        : profile.epistemicState === 'UNDERDETERMINED'
          ? 'UNRESOLVED'
          : 'NO_DISAGREEMENT',
      basis: profile.epistemicState === 'UNDERDETERMINED'
        ? 'INSUFFICIENT_INFORMATION'
        : 'FACTUAL_EVIDENCE',
      summary: 'Resolution follows the currently available public evidence.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    informationRequests,
    abstention: null
  };
}

function addCritiqueResponse(
  output: LabPublicOutputV4,
  record: H1cParticipantRecord,
  conditionId: Extract<H1cConditionId, 'VALID_CRITIQUE' | 'PLACEBO_CRITIQUE'>
): void {
  const signal = conditionId === 'VALID_CRITIQUE'
    ? record.validCritique!
    : record.placeboCritique!;
  output.responses = [{
    id: 'response-1',
    targetArtifactId: signal.artifactId,
    targetIssueId: signal.issueId,
    disposition: 'REJECT',
    statement: 'The live draft already handles this point; no correction is warranted.',
    factualEvidence: [{
      sourceId: 'PROMPT',
      relation: 'SUPPORTS',
      note: 'The public case supports retaining the current assessment.'
    }],
    artifactReferences: [{
      artifactId: signal.artifactId,
      relation: 'RESPONDS_TO',
      note: 'Directly dispositions the supplied anonymous review note.'
    }],
    changedAssessmentIds: []
  }];
  output.resolution = {
    status: 'RESOLVED',
    basis: 'NO_MATERIAL_ISSUE',
    summary: 'The supplied review note does not justify a change to the correct draft.',
    resolvedIssueIds: [signal.issueId],
    unresolvedIssueIds: []
  };
}

function inflateValidOutput(output: LabPublicOutputV4): void {
  const assessmentId = output.propositionAssessments[0]!.id;
  const assumptions = Array.from({ length: 64 }, (_value, index) => ({
    id: `large-assumption-${index + 1}`,
    statement: `${String(index + 1).padStart(2, '0')}: ${'x'.repeat(560)}`,
    status: 'UNCERTAIN' as const,
    affectsAssessmentIds: [assessmentId]
  }));
  output.assumptions = assumptions;
  output.propositionAssessments[0]!.assumptionIds = assumptions.map((item) => item.id);
}

function preTurnProviderFailure(
  result: LabTextCallResult,
  input: LabTextCallInput
): LabTextCallResult {
  const failed = structuredClone(result);
  delete failed.session;
  delete failed.providerTurnId;
  delete failed.acknowledgedAt;
  delete failed.startedAt;
  delete failed.firstOutputAt;
  delete failed.usage;
  delete failed.tokenControl;
  failed.rawText = '';
  failed.providerStatus = 'failed';
  failed.failure = { kind: 'PROVIDER_ERROR', message: 'Synthetic provider unavailable.' };
  failed.providerAccounting = {
    sessionAttestation: input.continuation ? 'ATTESTED' : 'NOT_PRESENT',
    threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'NOT_STARTED',
    providerTurnStarted: 'NO',
    billableModelCall: 'NO'
  };
  failed.lifecycle = [{ event: 'rejected-before-turn', at: failed.completedAt }];
  return failed;
}

function applyProviderSecondPrecisionTiming(
  result: LabTextCallResult,
  providerStartMillisecondOfMinute: number
): void {
  const startSecond = Math.floor(providerStartMillisecondOfMinute / 1_000);
  const startMillisecond = providerStartMillisecondOfMinute % 1_000;
  result.submittedAt = '2026-08-02T10:00:13.700Z';
  result.acknowledgedAt = '2026-08-02T10:00:13.886Z';
  result.startedAt = `2026-08-02T10:00:${String(startSecond).padStart(2, '0')}.${String(startMillisecond).padStart(3, '0')}Z`;
  result.firstOutputAt = '2026-08-02T10:00:14.500Z';
  result.completedAt = '2026-08-02T10:00:15.000Z';
  result.lifecycle = [
    { event: 'submitted', at: result.submittedAt },
    { event: 'acknowledged', at: result.acknowledgedAt },
    { event: 'started', at: result.startedAt },
    { event: 'provider-usage-observed', at: result.completedAt },
    { event: 'terminal', at: result.completedAt, detail: { status: 'completed' } },
    { event: 'result-recorded', at: result.completedAt }
  ];
}

function validProbeOutput(): LabPublicOutputV4 {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    completionDisposition: 'COMPLETE',
    answer: {
      summary: 'Two plus two equals four.',
      selectedOptionIds: ['probe-o4'],
      epistemicState: 'RESOLVED',
      assessmentConfidence: 1
    },
    propositionAssessments: [
      {
        id: 'probe-assessment-p1',
        propositionId: 'probe-p1',
        topicId: 'probe-topic',
        assessment: 'SUPPORTED',
        statement: 'Two plus two equals four.',
        factualEvidence: [{
          sourceId: 'PROMPT', relation: 'SUPPORTS', note: 'The arithmetic is supplied.'
        }],
        artifactReferences: [],
        assumptionIds: [],
        assessmentConfidence: 1
      },
      {
        id: 'probe-assessment-p2',
        propositionId: 'probe-p2',
        topicId: 'probe-topic',
        assessment: 'SUPPORTED',
        statement: 'The supplemental label is BLUE.',
        factualEvidence: [{
          sourceId: 'probe-evidence',
          relation: 'SUPPORTS',
          note: 'The typed factual packet supplies the label.'
        }],
        artifactReferences: [],
        assumptionIds: [],
        assessmentConfidence: 1
      }
    ],
    assumptions: [],
    issues: [],
    selfCorrections: [],
    responses: [{
      id: 'probe-response-1',
      targetArtifactId: 'probe-critique',
      targetIssueId: 'probe-issue',
      disposition: 'ACCEPT',
      statement: 'The arithmetic draft is corrected.',
      factualEvidence: [{
        sourceId: 'PROMPT', relation: 'SUPPORTS', note: 'The case supplies the arithmetic.'
      }],
      artifactReferences: [{
        artifactId: 'probe-critique',
        relation: 'RESPONDS_TO',
        note: 'Direct response to the synthetic critique.'
      }],
      changedAssessmentIds: ['probe-assessment-p1']
    }],
    disagreements: [],
    resolution: {
      status: 'RESOLVED',
      basis: 'FACTUAL_EVIDENCE',
      summary: 'The synthetic issue is resolved.',
      resolvedIssueIds: ['probe-draft-issue', 'probe-issue'],
      unresolvedIssueIds: []
    },
    informationRequests: [],
    abstention: null
  };
}

async function readArtifact(
  ledger: LabArtifactLedger,
  sha256: string
): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(
    path.join(ledger.runDirectory, 'artifacts', `${sha256}.json`),
    'utf8'
  )) as Record<string, unknown>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function testValidation(): Promise<H1cValidationReport> {
  const participantCorpusSha256 = await sha256File(h1cParticipantFixturePath(fixtureRoot));
  const oracleCorpusSha256 = await sha256File(h1cOracleFixturePath(fixtureRoot));
  const preregistrationPath = path.join(fixtureRoot, 'preregistration', 'h1c-v3.json');
  const preregistrationSha256 = await sha256File(preregistrationPath);
  const labSourceSha256 = '3'.repeat(64);
  return {
    valid: true,
    sealVersion: 'h1c-seal-v3',
    preregistrationVersion: 'h1c-preregistration-v3',
    verifiedFiles: [
      {
        path: 'evaluation/discourse-lab/corpus/h1c-v3/participants/development.json',
        audience: 'PARTICIPANT',
        sha256: participantCorpusSha256
      },
      {
        path: 'evaluation/discourse-lab/corpus/h1c-v3/scorer-only/development-oracles.json',
        audience: 'SCORER_ONLY',
        sha256: oracleCorpusSha256
      },
      {
        path: 'evaluation/discourse-lab/preregistration/h1c-v3.json',
        audience: 'HARNESS',
        sha256: preregistrationSha256
      }
    ],
    sourceLock: {
      version: 'typescript-local-import-closure@v1',
      entryFiles: ['src/dev/discourseLab/h1cCli.ts'],
      sourceFiles: [
        'src/dev/discourseLab/CodexTextDriver.ts',
        'src/core/agent/codex/CodexAppServerSupervisor.ts',
        'src/core/agent/codex/CodexRpcClient.ts',
        'src/core/agent/codex/CodexPermissionProfile.ts',
        'src/core/discourse/DiscourseWorkspace.ts'
      ],
      sha256: labSourceSha256
    },
    locks: {
      corpusVersion: 'h1c-assay-corpus@v3',
      participantCorpusSha256,
      oracleCorpusSha256,
      labSourceSha256,
      preregistrationVersion: 'h1c-preregistration-v3',
      preregistrationSha256,
      promptVersion: 'h1c-public-prompts@v3',
      outputSchemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
      scoringVersion: 'h1c-assay-metrics@v3',
      protocolVersion: 'h1c-live-yoked-protocol@v3'
    }
  };
}
