import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHarnessValidation } from './harnessValidation';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  type LabLedgerEvent
} from './ledger';
import { validateLabInputs } from './validation';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Discourse Protocol Lab H0', () => {
  it('validates deterministic harness plumbing without claiming semantic or later-stage readiness', async () => {
    const report = await runHarnessValidation(
      path.join(process.cwd(), 'evaluation', 'discourse-lab')
    );
    expect(report.status).toBe('PASSED');
    expect(report.componentLocks).toMatchObject({
      corpusVersion: 'text-lab-v1',
      preregistrationVersion: 'text-lab-prereg-v8'
    });
    expect(report.checks.every((check) => check.status === 'PASSED')).toBe(true);
    expect(report.trajectories.length).toBeGreaterThanOrEqual(50);
    expect(report.trajectories.every((item) => item.failureCount === 0)).toBe(true);
    expect(report.mechanism).toContain('no provider or model-quality mechanism');
    expect(report.decisionChanged).toContain('H2-H7 remain gated');
    expect(report.scopeLimitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('does not measure model behavior or semantic quality'),
        expect.stringContaining('not construct validity'),
        expect.stringContaining('does not attest a live provider'),
        expect.stringContaining('does not make H2-H7 executable or eligible')
      ])
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ checkId: 'NON_EXECUTABLE_CONDITION_GATES' })
    );
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'PARTICIPANT_PROMPT_SANITIZATION' }),
        expect.objectContaining({
          checkId: 'CONTEXTUAL_REFERENCE_REJECTION_AND_REPAIR',
          detail: expect.stringContaining('NONE, PEER_MESSAGE, PEER_SET, and EVIDENCE_PACKET')
        }),
        expect.objectContaining({
          checkId: 'FAILURE_AND_HARD_LIMIT_INJECTION',
          detail: expect.stringContaining('per-call output-token enforcement')
        })
      ])
    );
  }, 30_000);

  it('does not publish a PASS report before ledger completeness succeeds', async () => {
    const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
    const validation = await validateLabInputs(fixtureRoot);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h0-incomplete-'));
    roots.push(root);
    const ledger = new DroppedSettlementLedger(root, 'h0-incomplete');
    await ledger.initialize({
      schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
      runId: ledger.runId,
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
      locks: validation.locks,
      caseIds: [],
      conditionIds: [],
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
    });

    await expect(runHarnessValidation(fixtureRoot, ledger)).rejects.toThrow(
      'lost an attempted call settlement'
    );
    await expect(
      fs.access(path.join(ledger.runDirectory, 'reports', 'h0-validation.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
});

class DroppedSettlementLedger extends LabArtifactLedger {
  private dropped = false;

  override append(event: LabLedgerEvent): Promise<void> {
    if (!this.dropped && event.eventType === 'CALL_COMPLETED') {
      this.dropped = true;
      return Promise.resolve();
    }
    return super.append(event);
  }
}
