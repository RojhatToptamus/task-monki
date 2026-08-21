import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LAB_PUBLIC_OUTPUT_SCHEMA_VERSION, type LabPublicOutput } from './contracts';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  stableJson,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import {
  LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
  LAB_PUBLIC_SCHEMA_PROBE_MODEL,
  LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
  LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS,
  LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
  LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS,
  LAB_PUBLIC_SCHEMA_PROBE_VERSION,
  buildPublicSchemaProbeReport,
  loadPublicSchemaProbeReceipt,
  publicSchemaProbeManifestBudget,
  type LabPublicSchemaProbeReport
} from './publicSchemaProbe';
import type { LabDriverPreflight, LabTextCallResult } from './textDriver';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('public-schema probe receipt', () => {
  it('accepts a real PASS receipt bound to the active locks and exact runtime', async () => {
    const fixture = await receiptFixture('schema-probe-pass');

    const receipt = await loadPublicSchemaProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    );

    expect(receipt.runId).toBe(fixture.runId);
    expect(receipt.report.status).toBe('PASSED');
    expect(receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.reportSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects a probe whose observed call failed', async () => {
    const fixture = await receiptFixture('schema-probe-failed', (report) => ({
      ...report,
      status: 'FAILED',
      call: {
        ...report.call!,
        failure: { kind: 'PROVIDER_ERROR', message: 'Injected schema rejection.' }
      },
      failedChecks: ['providerAcceptance']
    }));

    await expect(loadPublicSchemaProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    )).rejects.toThrow('status');
  });

  it('rejects a stale receipt from different component locks', async () => {
    const fixture = await receiptFixture('schema-probe-stale');
    const activeLocks = { ...fixture.locks, labSourceSha256: 'f'.repeat(64) };

    await expect(loadPublicSchemaProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      activeLocks
    )).rejects.toThrow('locks');
  });

  it('rejects a substituted report copied from another run', async () => {
    const fixture = await receiptFixture('schema-probe-target', (report) => ({
      ...report,
      runId: 'schema-probe-other'
    }));

    await expect(loadPublicSchemaProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    )).rejects.toThrow('runId');
  });

  it('rejects a missing report instead of inferring probe success', async () => {
    const fixture = await receiptFixture('schema-probe-missing');
    await fs.rm(path.join(
      fixture.stateRoot,
      'runs',
      fixture.runId,
      'reports',
      'public-schema-probe.json'
    ));

    await expect(loadPublicSchemaProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    )).rejects.toThrow('unavailable or unsafe');
  });

  it('rejects a process-lifetime boundary violation observed after the call', async () => {
    const fixture = await receiptFixture('schema-probe-late-boundary', (report) => ({
      ...report,
      status: 'FAILED',
      close: {
        ...report.close,
        boundaryViolations: ['Forbidden MCP startup event: late-mcp/ready']
      },
      failedChecks: ['processBoundaryViolations']
    }));

    await expect(loadPublicSchemaProbeReceipt(
      fixture.stateRoot,
      fixture.runId,
      fixture.locks
    )).rejects.toThrow('status');
  });
});

async function receiptFixture(
  runId: string,
  mutateReport?: (report: LabPublicSchemaProbeReport) => LabPublicSchemaProbeReport
): Promise<{ stateRoot: string; runId: string; locks: LabComponentLock }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-schema-probe-'));
  roots.push(root);
  const stateRoot = path.join(root, 'state');
  const runDirectory = path.join(stateRoot, 'runs', runId);
  const reportDirectory = path.join(runDirectory, 'reports');
  await fs.mkdir(reportDirectory, { recursive: true });
  const locks = activeLocks();
  const now = '2026-08-01T10:00:00.000Z';
  const manifest: LabRunManifest = {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId,
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt: now,
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
    locks,
    caseIds: [],
    conditionIds: [],
    budgets: publicSchemaProbeManifestBudget(),
    providerUsageExplicitlyAuthorized: true
  };
  const report = mutateReport?.(validReport(runId, locks, now)) ?? validReport(runId, locks, now);
  await Promise.all([
    fs.writeFile(path.join(runDirectory, 'manifest.json'), `${stableJson(manifest)}\n`, 'utf8'),
    fs.writeFile(
      path.join(reportDirectory, 'public-schema-probe.json'),
      `${stableJson(report)}\n`,
      'utf8'
    )
  ]);
  return { stateRoot, runId, locks };
}

function validReport(
  runId: string,
  locks: LabComponentLock,
  now: string
): LabPublicSchemaProbeReport {
  return buildPublicSchemaProbeReport({
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
    driverId: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
    ready: true,
    accountPresent: true,
    requiresAuthentication: false,
    models: [{
      id: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      model: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      displayName: 'GPT-5.6-Sol',
      isDefault: true,
      supportedReasoningEfforts: [LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT]
    }],
    capabilities,
    boundary: {
      status: 'ATTESTED',
      requestedModel: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      observedModel: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      observedModelProvider: 'openai',
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
}

function validCall(now: string): LabTextCallResult {
  const output: LabPublicOutput = {
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
      summary: 'The compatibility probe is resolved.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 1
  };
  const usage = {
    totalTokens: 32,
    inputTokens: 20,
    cachedInputTokens: 0,
    outputTokens: 12,
    reasoningOutputTokens: 0
  };
  return {
    callKey: `${LAB_PUBLIC_SCHEMA_PROBE_VERSION}:attempt-1`,
    session: {
      driverId: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
      providerThreadId: 'probe-thread'
    },
    providerTurnId: 'probe-turn',
    rawText: JSON.stringify(output),
    submittedAt: now,
    acknowledgedAt: now,
    startedAt: now,
    firstOutputAt: now,
    completedAt: now,
    requestedModel: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
    observedModel: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
    observedModelProvider: 'openai',
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

function activeLocks(): LabComponentLock {
  return {
    corpusVersion: 'text-lab-v1',
    participantCorpusSha256: '1'.repeat(64),
    oracleCorpusSha256: '2'.repeat(64),
    labSourceSha256: '3'.repeat(64),
    preregistrationVersion: 'text-lab-prereg-v8',
    preregistrationSha256: '4'.repeat(64),
    promptVersion: 'text-lab-prompts-v5',
    outputSchemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    scoringVersion: 'text-lab-metrics-v4',
    protocolVersion: 'text-protocols@v3'
  };
}
