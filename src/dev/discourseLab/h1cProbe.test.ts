import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LabArtifactLedger,
  stableJson,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import {
  H1C_PROBE_CONTEXT_SHA256,
  H1C_PROBE_DRIVER_ID,
  H1C_PROBE_MODEL,
  H1C_PROBE_OUTPUT_SCHEMA_SHA256,
  H1C_PROBE_PROMPT,
  H1C_PROBE_PROMPT_SHA256,
  H1C_PROBE_REASONING_EFFORT,
  H1C_PROBE_REPORT_NAME,
  H1C_PROBE_SAFETY_OUTPUT_TOKENS,
  H1C_PROBE_SERVICE_TIER,
  H1C_PROBE_TARGET_OUTPUT_TOKENS,
  H1C_PROBE_VERSION,
  buildH1cProbeManifest,
  buildH1cProbeReport,
  h1cProbeManifestBudget,
  loadH1cProbeReceipt,
  runH1cProbe,
  serializeH1cProbeFailure,
  type H1cProbeDriver,
  type H1cProbeReport
} from './h1cProbe';
import {
  LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA,
  LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  type LabPublicOutputV4
} from './outputV4';
import type { LabDriverPreflight, LabTextCallInput, LabTextCallResult } from './textDriver';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('H1c exact-model public-output-v4 probe', () => {
  it('runs one synthetic call with the exact schema/settings and retains its complete receipt', async () => {
    const root = await temporaryRoot();
    const locks = activeLocks();
    const runId = 'h1c-probe-run';
    const ledger = new LabArtifactLedger(path.join(root, 'state'), runId);
    await ledger.initialize(buildH1cProbeManifest({
      runId,
      componentLocks: locks,
      providerUsageExplicitlyAuthorized: true,
      createdAt: '2026-08-02T10:00:00.000Z'
    }));
    const call = vi.fn(async (_input: LabTextCallInput) => validCall(new Date().toISOString()));
    const close = vi.fn(async () => undefined);
    const driver: H1cProbeDriver = {
      id: H1C_PROBE_DRIVER_ID,
      capabilities: validBoundary().capabilities,
      preflight: vi.fn(async () => validBoundary()),
      call,
      close,
      getProcessBoundaryViolations: () => []
    };

    const result = await runH1cProbe({
      runId,
      componentLocks: locks,
      ledger,
      driver
    });

    expect(result.report.status).toBe('PASSED');
    expect(h1cProbeManifestBudget()).toMatchObject({
      maximumCalls: 1,
      maximumOutputTokens: 900,
      maximumOutputTokenSafetyCeiling: 25_000
    });
    expect(result.report.call).toMatchObject({
      rawText: JSON.stringify(validOutput()),
      usage: { total: expect.objectContaining({ totalTokens: 1_120 }) },
      tokenControl: { targetOvershootTokens: 200, safetyOvershootTokens: 0 }
    });
    expect(result.report.latency.callElapsedMs).not.toBeNull();
    expect(result.report.close.status).toBe('CLEAN');
    expect(close).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]![0]).toMatchObject({
      callKey: `${H1C_PROBE_VERSION}:attempt-1`,
      prompt: H1C_PROBE_PROMPT,
      model: H1C_PROBE_MODEL,
      reasoningEffort: H1C_PROBE_REASONING_EFFORT,
      serviceTier: H1C_PROBE_SERVICE_TIER,
      maximumOutputTokens: H1C_PROBE_TARGET_OUTPUT_TOKENS,
      outputTokenSafetyCeiling: H1C_PROBE_SAFETY_OUTPUT_TOKENS
    });
    expect(stableJson(call.mock.calls[0]![0].outputSchema)).toBe(
      stableJson(LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA)
    );

    const receipt = await loadH1cProbeReceipt(path.join(root, 'state'), runId, locks);
    expect(receipt).toMatchObject({
      runId,
      publicOutputSchemaSha256: H1C_PROBE_OUTPUT_SCHEMA_SHA256,
      promptSha256: H1C_PROBE_PROMPT_SHA256,
      contextSha256: H1C_PROBE_CONTEXT_SHA256,
      report: { status: 'PASSED' }
    });
    expect(receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.reportSha256).toMatch(/^[a-f0-9]{64}$/u);

    const artifacts = await readLedgerArtifacts(ledger);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        'H1C_PROBE_BOUNDARY',
        'H1C_PROBE_RAW_CALL',
        'H1C_PROBE_CLOSE'
      ])
    );
    expect(
      artifacts.find((artifact) => artifact.kind === 'H1C_PROBE_RAW_CALL')
    ).toMatchObject({
      call: {
        rawText: JSON.stringify(validOutput()),
        usage: { total: expect.objectContaining({ totalTokens: 1_120 }) },
        lifecycle: expect.arrayContaining([
          { event: 'result-recorded', at: expect.any(String) }
        ])
      }
    });
    const events = await readLedgerEvents(ledger);
    expect(events.map((event) => event.eventType)).toEqual([
      'H1C_PROBE_BOUNDARY_RECORDED',
      'H1C_PROBE_CALL_SUBMITTED',
      'H1C_PROBE_CALL_COMPLETED',
      'H1C_PROBE_DRIVER_CLOSED'
    ]);
    expect(events.filter((event) => event.artifactSha256)).toHaveLength(3);
  });

  it('accepts a second-granularity provider start when the observed lifecycle is ordered', () => {
    const locks = activeLocks();
    const call = validCall('2026-08-02T10:00:15.000Z');
    applyProviderSecondPrecisionTiming(call, 13_000);

    const report = buildH1cProbeReport({
      runId: 'second-precision-start',
      startedAt: '2026-08-02T10:00:13.700Z',
      completedAt: '2026-08-02T10:00:16.000Z',
      componentLocks: locks,
      boundary: validBoundary(),
      call,
      close: {
        status: 'CLEAN',
        startedAt: '2026-08-02T10:00:16.000Z',
        completedAt: '2026-08-02T10:00:16.001Z',
        elapsedMs: 1,
        maximumMs: 30_000,
        boundaryViolations: []
      }
    });

    expect(report).toMatchObject({ status: 'PASSED', failedChecks: [] });
  });

  it.each([
    ['a provider start at least one second before acknowledgement', (call: LabTextCallResult) => {
      applyProviderSecondPrecisionTiming(call, 12_886);
    }],
    ['an out-of-order lifecycle journal', (call: LabTextCallResult) => {
      applyProviderSecondPrecisionTiming(call, 13_000);
      [call.lifecycle[1], call.lifecycle[2]] = [call.lifecycle[2]!, call.lifecycle[1]!];
    }]
  ] as const)('rejects %s', (_label, mutate) => {
    const locks = activeLocks();
    const call = validCall('2026-08-02T10:00:15.000Z');
    mutate(call);
    const report = buildH1cProbeReport({
      runId: 'invalid-lifecycle',
      startedAt: '2026-08-02T10:00:12.000Z',
      completedAt: '2026-08-02T10:00:16.000Z',
      componentLocks: locks,
      boundary: validBoundary(),
      call,
      close: {
        status: 'CLEAN',
        startedAt: '2026-08-02T10:00:16.000Z',
        completedAt: '2026-08-02T10:00:16.001Z',
        elapsedMs: 1,
        maximumMs: 30_000,
        boundaryViolations: []
      }
    });

    expect(report.status).toBe('FAILED');
    expect(report.failedChecks).toContain('cleanTerminalLifecycle');
  });

  it('retains the raw call artifact and clean close when report persistence fails', async () => {
    const root = await temporaryRoot();
    const locks = activeLocks();
    const runId = 'h1c-report-failure';
    const ledger = new LabArtifactLedger(path.join(root, 'state'), runId);
    await ledger.initialize(buildH1cProbeManifest({
      runId,
      componentLocks: locks,
      providerUsageExplicitlyAuthorized: true
    }));
    const close = vi.fn(async () => undefined);
    const driver: H1cProbeDriver = {
      id: H1C_PROBE_DRIVER_ID,
      capabilities: validBoundary().capabilities,
      preflight: vi.fn(async () => validBoundary()),
      call: vi.fn(async () => validCall(new Date().toISOString())),
      close,
      getProcessBoundaryViolations: () => []
    };
    vi.spyOn(ledger, 'writeReport').mockRejectedValueOnce(new Error('report unavailable'));

    await expect(runH1cProbe({ runId, componentLocks: locks, ledger, driver }))
      .rejects.toThrow('report unavailable');

    expect(close).toHaveBeenCalledOnce();
    const artifacts = await readLedgerArtifacts(ledger);
    expect(
      artifacts.find((artifact) => artifact.kind === 'H1C_PROBE_RAW_CALL')
    ).toMatchObject({
      call: {
        rawText: JSON.stringify(validOutput()),
        usage: { total: expect.objectContaining({ totalTokens: 1_120 }) },
        lifecycle: expect.any(Array)
      }
    });
    expect(
      artifacts.find((artifact) => artifact.kind === 'H1C_PROBE_CLOSE')
    ).toMatchObject({ close: { status: 'CLEAN' } });
  });

  it('retains a thrown provider failure before building the failed report', async () => {
    const root = await temporaryRoot();
    const locks = activeLocks();
    const runId = 'h1c-provider-throw';
    const ledger = new LabArtifactLedger(path.join(root, 'state'), runId);
    await ledger.initialize(buildH1cProbeManifest({
      runId,
      componentLocks: locks,
      providerUsageExplicitlyAuthorized: true
    }));
    const driver: H1cProbeDriver = {
      id: H1C_PROBE_DRIVER_ID,
      capabilities: validBoundary().capabilities,
      preflight: vi.fn(async () => validBoundary()),
      call: vi.fn(async () => {
        throw new Error('synthetic provider failure');
      }),
      close: vi.fn(async () => undefined),
      getProcessBoundaryViolations: () => []
    };

    const result = await runH1cProbe({ runId, componentLocks: locks, ledger, driver });

    expect(result.report).toMatchObject({
      status: 'FAILED',
      operationFailure: { message: 'synthetic provider failure' }
    });
    expect(await readLedgerArtifacts(ledger)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'H1C_PROBE_OPERATION_FAILURE',
          failure: expect.objectContaining({ message: 'synthetic provider failure' })
        })
      ])
    );
    expect((await readLedgerEvents(ledger)).map((event) => event.eventType)).toContain(
      'H1C_PROBE_OPERATION_FAILED'
    );
  });

  it('recomputes v4 validation from raw output instead of trusting forged PASS fields', async () => {
    const fixture = await receiptFixture('forged-validation', (report) => ({
      ...report,
      status: 'PASSED',
      call: { ...report.call!, rawText: JSON.stringify({ schemaVersion: 'v2' }) },
      localValidation: { status: 'PASSED', errors: [] },
      semanticValidation: { status: 'PASSED', failedChecks: [] },
      failedChecks: []
    }));

    await expect(loadH1cProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    )).rejects.toThrow(/localValidationRecord|report failed/u);
  });

  it('rejects shape-valid output that fails the exact probe semantics', async () => {
    const wrong = validOutput();
    wrong.answer.selectedOptionIds = [];
    const fixture = await receiptFixture('forged-semantics', (report) => ({
      ...report,
      status: 'PASSED',
      call: { ...report.call!, rawText: JSON.stringify(wrong) },
      localValidation: { status: 'PASSED', errors: [] },
      semanticValidation: { status: 'PASSED', failedChecks: [] },
      failedChecks: []
    }));

    await expect(loadH1cProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    )).rejects.toThrow(/semanticValidationRecord|report failed/u);
  });

  it.each([
    ['stale locks', (report: H1cProbeReport) => report, (locks: LabComponentLock) => ({
      ...locks,
      labSourceSha256: 'f'.repeat(64)
    })],
    ['substituted run', (report: H1cProbeReport) => ({ ...report, runId: 'another-run' }), undefined],
    ['schema digest', (report: H1cProbeReport) => ({
      ...report,
      publicOutputSchemaSha256: '0'.repeat(64)
    }), undefined],
    ['prompt digest', (report: H1cProbeReport) => ({
      ...report,
      promptSha256: '0'.repeat(64)
    }), undefined],
    ['context digest', (report: H1cProbeReport) => ({
      ...report,
      contextSha256: '0'.repeat(64)
    }), undefined]
  ] as const)('rejects receipt binding drift: %s', async (_label, mutate, mutateLocks) => {
    const fixture = await receiptFixture('binding-drift', mutate);
    const locks = mutateLocks?.(fixture.locks) ?? fixture.locks;
    await expect(loadH1cProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      locks
    )).rejects.toThrow();
  });

  it.each([
    ['model drift', (report: H1cProbeReport) => {
      report.boundary!.boundary.observedModel = 'other-model';
    }],
    ['inherited instruction', (report: H1cProbeReport) => {
      report.boundary!.boundary.instructionSources = ['AGENTS.md'];
    }],
    ['late MCP', (report: H1cProbeReport) => {
      report.close.boundaryViolations = ['Forbidden MCP startup event: late-mcp/ready'];
    }],
    ['missing usage', (report: H1cProbeReport) => {
      delete report.call!.usage;
    }],
    ['safety overshoot', (report: H1cProbeReport) => {
      const usage = report.call!.usage!;
      usage.total.outputTokens = 25_001;
      usage.total.totalTokens = 25_021;
      usage.last = structuredClone(usage.total);
      report.call!.tokenControl!.observedOutputTokens = 25_001;
      report.call!.tokenControl!.targetOvershootTokens = 24_101;
      report.call!.tokenControl!.safetyOvershootTokens = 1;
    }]
  ] as const)('rejects an unsafe boundary/result: %s', async (_label, mutate) => {
    const fixture = await receiptFixture('unsafe-result', (original) => {
      const report = structuredClone(original);
      mutate(report);
      report.status = 'PASSED';
      report.failedChecks = [];
      return report;
    });
    await expect(loadH1cProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    )).rejects.toThrow();
  });

  it('allows natural-completion target overshoot but requires a clean close', async () => {
    const targetOvershoot = await receiptFixture('target-overshoot');
    await expect(loadH1cProbeReceipt(
      targetOvershoot.stateRoot,
      targetOvershoot.runId,
      targetOvershoot.locks
    )).resolves.toMatchObject({ report: { status: 'PASSED' } });

    const closeFailure = await receiptFixture('failed-close', (report) => ({
      ...report,
      status: 'PASSED',
      close: {
        ...report.close,
        status: 'FAILED',
        failure: { name: 'AggregateError', message: 'close failed' }
      },
      failedChecks: []
    }));
    await expect(loadH1cProbeReceipt(
      closeFailure.stateRoot,
      closeFailure.runId,
      closeFailure.locks
    )).rejects.toThrow(/cleanClose|status/u);
  });

  it('preserves bounded nested operation and close failure details', () => {
    const leaf = new Error('provider leaf');
    const caused = new Error('provider failed', { cause: leaf });
    const failure = new AggregateError([caused, new Error('close failed')], 'both failed');

    expect(serializeH1cProbeFailure(failure)).toMatchObject({
      name: 'AggregateError',
      message: 'both failed',
      errors: [
        {
          name: 'Error',
          message: 'provider failed',
          cause: { name: 'Error', message: 'provider leaf' }
        },
        { name: 'Error', message: 'close failed' }
      ]
    });
  });

  it('rejects an unsafe run id and a symlinked report', async () => {
    await expect(loadH1cProbeReceipt('/tmp/unused-h1c-probe', '../escape', activeLocks()))
      .rejects.toThrow('unsafe run id');
    if (process.platform === 'win32') return;

    const fixture = await receiptFixture('symlink-report');
    const reportPath = path.join(
      fixture.stateRoot,
      'runs',
      fixture.runId,
      'reports',
      `${H1C_PROBE_REPORT_NAME}.json`
    );
    const targetPath = path.join(path.dirname(reportPath), 'target.json');
    await fs.rename(reportPath, targetPath);
    await fs.symlink(targetPath, reportPath);
    await expect(loadH1cProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    )).rejects.toThrow('unavailable or unsafe');
  });
});

async function receiptFixture(
  runId: string,
  mutateReport?: (report: H1cProbeReport) => H1cProbeReport,
  mutateManifest?: (manifest: LabRunManifest) => LabRunManifest
): Promise<{ stateRoot: string; runId: string; locks: LabComponentLock }> {
  const root = await temporaryRoot();
  const stateRoot = path.join(root, 'state');
  const runDirectory = path.join(stateRoot, 'runs', runId);
  const reportDirectory = path.join(runDirectory, 'reports');
  await fs.mkdir(reportDirectory, { recursive: true });
  const locks = activeLocks();
  const now = '2026-08-02T10:00:00.000Z';
  const manifest = buildH1cProbeManifest({
    runId,
    componentLocks: locks,
    providerUsageExplicitlyAuthorized: true,
    createdAt: now
  });
  const report = mutateReport?.(validReport(runId, locks, now)) ?? validReport(runId, locks, now);
  await Promise.all([
    fs.writeFile(
      path.join(runDirectory, 'manifest.json'),
      `${stableJson(mutateManifest?.(manifest) ?? manifest)}\n`,
      'utf8'
    ),
    fs.writeFile(
      path.join(reportDirectory, `${H1C_PROBE_REPORT_NAME}.json`),
      `${stableJson(report)}\n`,
      'utf8'
    )
  ]);
  return { stateRoot, runId, locks };
}

function validReport(runId: string, locks: LabComponentLock, now: string): H1cProbeReport {
  return buildH1cProbeReport({
    runId,
    startedAt: now,
    completedAt: now,
    componentLocks: locks,
    boundary: validBoundary(),
    call: validCall(now),
    close: {
      status: 'CLEAN',
      startedAt: now,
      completedAt: now,
      elapsedMs: 0,
      maximumMs: 30_000,
      boundaryViolations: []
    }
  });
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
      displayName: 'GPT-5.6-Sol',
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

function validCall(now: string): LabTextCallResult {
  const usage = {
    totalTokens: 1_120,
    inputTokens: 20,
    cachedInputTokens: 0,
    outputTokens: 1_100,
    reasoningOutputTokens: 100
  };
  return {
    callKey: `${H1C_PROBE_VERSION}:attempt-1`,
    session: { driverId: H1C_PROBE_DRIVER_ID, providerThreadId: 'probe-thread' },
    providerTurnId: 'probe-turn',
    rawText: JSON.stringify(validOutput()),
    submittedAt: now,
    acknowledgedAt: now,
    startedAt: now,
    firstOutputAt: now,
    completedAt: now,
    requestedModel: H1C_PROBE_MODEL,
    observedModel: H1C_PROBE_MODEL,
    observedModelProvider: 'openai',
    requestedReasoningEffort: H1C_PROBE_REASONING_EFFORT,
    observedReasoningEffort: H1C_PROBE_REASONING_EFFORT,
    requestedServiceTier: H1C_PROBE_SERVICE_TIER,
    observedServiceTier: H1C_PROBE_SERVICE_TIER,
    seed: null,
    usage: { total: usage, last: structuredClone(usage) },
    tokenControl: {
      targetOutputTokens: H1C_PROBE_TARGET_OUTPUT_TOKENS,
      safetyCeilingOutputTokens: H1C_PROBE_SAFETY_OUTPUT_TOKENS,
      providerEnforcedLimit: false,
      usageStatus: 'PROVIDER_REPORTED',
      observedOutputTokens: usage.outputTokens,
      targetOvershootTokens: 200,
      safetyOvershootTokens: 0
    },
    providerStatus: 'completed',
    providerAccounting: {
      sessionAttestation: 'ATTESTED',
      threadStartStatus: 'ATTESTED',
      providerTurnStarted: 'YES',
      billableModelCall: 'UNKNOWN'
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
}

function applyProviderSecondPrecisionTiming(
  call: LabTextCallResult,
  providerStartMillisecondOfMinute: number
): void {
  const startSecond = Math.floor(providerStartMillisecondOfMinute / 1_000);
  const startMillisecond = providerStartMillisecondOfMinute % 1_000;
  const startedAt = `2026-08-02T10:00:${String(startSecond).padStart(2, '0')}.${String(startMillisecond).padStart(3, '0')}Z`;
  call.submittedAt = '2026-08-02T10:00:13.700Z';
  call.acknowledgedAt = '2026-08-02T10:00:13.886Z';
  call.startedAt = startedAt;
  call.firstOutputAt = '2026-08-02T10:00:14.500Z';
  call.completedAt = '2026-08-02T10:00:15.000Z';
  call.lifecycle = [
    { event: 'submitted', at: call.submittedAt },
    { event: 'acknowledged', at: call.acknowledgedAt },
    { event: 'started', at: call.startedAt },
    { event: 'provider-usage-observed', at: call.completedAt },
    { event: 'terminal', at: call.completedAt, detail: { status: 'completed' } },
    { event: 'result-recorded', at: call.completedAt }
  ];
}

function validOutput(): LabPublicOutputV4 {
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
        factualEvidence: [{ sourceId: 'PROMPT', relation: 'SUPPORTS', note: 'The case states the arithmetic question.' }],
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
        factualEvidence: [{ sourceId: 'probe-evidence', relation: 'SUPPORTS', note: 'The typed evidence packet supplies the label.' }],
        artifactReferences: [],
        assumptionIds: [],
        assessmentConfidence: 1
      }
    ],
    assumptions: [],
    issues: [],
    selfCorrections: [],
    responses: [
      {
        id: 'probe-response-1',
        targetArtifactId: 'probe-critique',
        targetIssueId: 'probe-issue',
        disposition: 'ACCEPT',
        statement: 'The draft arithmetic was incorrect; the assessment is corrected.',
        factualEvidence: [{ sourceId: 'PROMPT', relation: 'SUPPORTS', note: 'The case supplies the arithmetic problem.' }],
        artifactReferences: [{ artifactId: 'probe-critique', relation: 'RESPONDS_TO', note: 'Direct response to the synthetic critique.' }],
        changedAssessmentIds: ['probe-assessment-p1']
      }
    ],
    disagreements: [],
    resolution: {
      status: 'RESOLVED',
      basis: 'FACTUAL_EVIDENCE',
      summary: 'The synthetic critique issue is resolved by the supplied facts.',
      resolvedIssueIds: ['probe-draft-issue', 'probe-issue'],
      unresolvedIssueIds: []
    },
    informationRequests: [],
    abstention: null
  };
}

function activeLocks(): LabComponentLock {
  return {
    corpusVersion: 'h1c-assay-corpus@v3',
    participantCorpusSha256: '1'.repeat(64),
    oracleCorpusSha256: '2'.repeat(64),
    labSourceSha256: '3'.repeat(64),
    preregistrationVersion: 'h1c-preregistration-v3',
    preregistrationSha256: '4'.repeat(64),
    promptVersion: 'h1c-public-prompts@v3',
    outputSchemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    scoringVersion: 'h1c-assay-metrics@v3',
    protocolVersion: 'h1c-live-yoked-protocol@v3'
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-probe-'));
  roots.push(root);
  return root;
}

async function readLedgerArtifacts(
  ledger: LabArtifactLedger
): Promise<Array<Record<string, unknown>>> {
  const directory = path.join(ledger.runDirectory, 'artifacts');
  const names = (await fs.readdir(directory)).sort();
  return Promise.all(
    names.map(async (name) =>
      JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as Record<
        string,
        unknown
      >
    )
  );
}

async function readLedgerEvents(
  ledger: LabArtifactLedger
): Promise<Array<Record<string, unknown>>> {
  const directory = path.join(ledger.runDirectory, 'events');
  const names = (await fs.readdir(directory)).sort();
  return Promise.all(
    names.map(async (name) =>
      JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as Record<
        string,
        unknown
      >
    )
  );
}
