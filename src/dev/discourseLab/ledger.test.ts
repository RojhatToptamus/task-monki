import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  type LabRunManifest,
  type LabSemanticRunContext
} from './ledger';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('LabArtifactLedger', () => {
  it('writes private immutable manifests, events, and content-addressed artifacts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lab-ledger-'));
    roots.push(root);
    const ledger = new LabArtifactLedger(root, 'run-1');
    await ledger.initialize(manifest());
    const first = await ledger.putArtifact({ b: 2, a: 1 });
    const second = await ledger.putArtifact({ a: 1, b: 2 });
    expect(second.sha256).toBe(first.sha256);
    await ledger.append({ eventType: 'CALL_COMPLETED', occurredAt: '2026-07-31T00:00:01.000Z' });
    expect(await fs.readdir(path.join(ledger.runDirectory, 'events'))).toEqual([
      '000001-call_completed.json'
    ]);
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(ledger.runDirectory, 'manifest.json'))).mode & 0o077).toBe(0);
    }
    await expect(ledger.initialize(manifest())).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('accepts only an explicitly authorized, exactly aligned semantic run context', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lab-ledger-semantic-'));
    roots.push(root);
    const runManifest = semanticManifest();
    const ledger = new LabArtifactLedger(root, runManifest.runId);
    await ledger.initialize(runManifest);

    expect(() => ledger.assertSemanticRunContext(semanticContext(runManifest))).not.toThrow();

    const mismatches: Array<[string, (context: LabSemanticRunContext) => void]> = [
      ['driver', (context) => { context.driver.model = 'other-model'; }],
      ['caseIds', (context) => { context.caseIds = ['D-O1']; }],
      ['conditionIds', (context) => { context.conditionIds = ['CONTROL_BASELINE']; }],
      ['budgets', (context) => { context.budgets.maximumCallMs -= 1; }]
    ];
    for (const [problem, mutate] of mismatches) {
      const context = semanticContext(runManifest);
      mutate(context);
      expect(() => ledger.assertSemanticRunContext(context)).toThrow(problem);
    }
  });

  it('rejects semantic provider use unless the immutable manifest authorizes it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lab-ledger-unauthorized-'));
    roots.push(root);
    const runManifest = semanticManifest();
    runManifest.providerUsageExplicitlyAuthorized = false;
    const ledger = new LabArtifactLedger(root, runManifest.runId);
    await ledger.initialize(runManifest);

    expect(() => ledger.assertSemanticRunContext(semanticContext(runManifest))).toThrow(
      'providerUsageExplicitlyAuthorized'
    );
  });

  it('allows the harness-verified natural-completion boundary only for development', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lab-ledger-fallback-'));
    roots.push(root);
    const runManifest = semanticManifest();
    runManifest.driver = {
      ...runManifest.driver,
      hardOutputTokenLimit: false,
      textOnlyAttestation: 'HARNESS_DETECTED',
      boundaryClass: 'H1_DEVELOPMENT_HARNESS_VERIFIED',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: true,
      providerReportedTokenUsage: true
    };
    runManifest.budgets.maximumOutputTokenSafetyCeiling = 125_000;
    const ledger = new LabArtifactLedger(root, runManifest.runId);
    await ledger.initialize(runManifest);

    expect(() => ledger.assertSemanticRunContext(semanticContext(runManifest))).not.toThrow();
  });

  it('fails closed on an incomplete fallback boundary and never permits it for confirmation', async () => {
    for (const mutate of [
      (manifest: LabRunManifest) => {
        manifest.driver.providerReportedTokenUsage = false;
      },
      (manifest: LabRunManifest) => {
        manifest.driver.streamingOutputTokenInterrupt = false;
      },
      (manifest: LabRunManifest) => {
        manifest.phase = 'CONFIRMATION';
      }
    ]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lab-ledger-gate-'));
      roots.push(root);
      const runManifest = semanticManifest();
      runManifest.driver = {
        ...runManifest.driver,
        hardOutputTokenLimit: false,
        textOnlyAttestation: 'HARNESS_DETECTED',
        boundaryClass: 'H1_DEVELOPMENT_HARNESS_VERIFIED',
        harnessVerifiedTextIsolation: true,
        streamingOutputTokenInterrupt: true,
        providerReportedTokenUsage: true
      };
      runManifest.budgets.maximumOutputTokenSafetyCeiling = 125_000;
      mutate(runManifest);
      const ledger = new LabArtifactLedger(root, runManifest.runId);
      await ledger.initialize(runManifest);
      const context = semanticContext(runManifest);
      context.phase = runManifest.phase as LabSemanticRunContext['phase'];

      expect(() => ledger.assertSemanticRunContext(context)).toThrow(
        'Semantic Discourse Lab run context failed'
      );
    }
  });
});

function semanticManifest(): LabRunManifest {
  return {
    ...manifest(),
    runId: 'semantic-run',
    phase: 'DEVELOPMENT',
    driver: {
      id: 'provider-text-v1',
      model: 'strong-model',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'PROVIDER_ENFORCED',
      boundaryClass: 'PROVIDER_ENFORCED_STRICT',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: false,
      providerReportedTokenUsage: true
    },
    caseIds: ['D-O2', 'D-O1'],
    conditionIds: ['CONTROL_VALID_EVIDENCE', 'CONTROL_BASELINE'],
    providerUsageExplicitlyAuthorized: true
  };
}

function semanticContext(runManifest: LabRunManifest): LabSemanticRunContext {
  return {
    phase: 'DEVELOPMENT',
    locks: structuredClone(runManifest.locks),
    driver: structuredClone(runManifest.driver),
    caseIds: [...runManifest.caseIds].reverse(),
    conditionIds: [...runManifest.conditionIds].reverse(),
    budgets: structuredClone(runManifest.budgets)
  };
}

function manifest(): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId: 'run-1',
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt: '2026-07-31T00:00:00.000Z',
    driver: {
      id: 'scripted',
      model: 'fixture',
      seed: 1,
      seedControl: 'SUPPORTED',
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'PROVIDER_ENFORCED',
      boundaryClass: 'PROVIDER_ENFORCED_STRICT',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: false,
      providerReportedTokenUsage: true
    },
    locks: {
      corpusVersion: 'v1',
      participantCorpusSha256: 'a'.repeat(64),
      oracleCorpusSha256: 'b'.repeat(64),
      labSourceSha256: 'd'.repeat(64),
      preregistrationVersion: 'v1',
      preregistrationSha256: 'c'.repeat(64),
      promptVersion: 'v1',
      outputSchemaVersion: 'v1',
      scoringVersion: 'v1',
      protocolVersion: 'v1'
    },
    caseIds: ['D-O1'],
    conditionIds: ['ABC_B5'],
    budgets: {
      maximumCalls: 5,
      maximumRounds: 1,
      maximumOutputTokens: 4_500,
      maximumOutputTokenSafetyCeiling: 4_500,
      maximumObservedTotalTokens: 20_000,
      maximumCallMs: 120_000,
      maximumExperimentMs: 720_000
    },
    providerUsageExplicitlyAuthorized: false
  };
}
