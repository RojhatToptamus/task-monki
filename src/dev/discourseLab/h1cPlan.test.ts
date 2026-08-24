import { describe, expect, it } from 'vitest';
import {
  assertH1cPlan,
  buildH1cPlan,
  scheduleH1cAssignments,
  type H1cH0Receipt
} from './h1cPlan';
import type { LabComponentLock } from './ledger';

const cases = [
  { caseId: 'H1C-D5', stratum: 'DERIVABLE_CRITIQUE' as const },
  { caseId: 'H1C-D6', stratum: 'DERIVABLE_CRITIQUE' as const },
  { caseId: 'H1C-E5', stratum: 'NEW_EVIDENCE' as const },
  { caseId: 'H1C-E6', stratum: 'NEW_EVIDENCE' as const }
];

describe('H1c sealed schedule', () => {
  it('creates eight live-draft blocks and exactly 28 bounded calls', () => {
    const { schedule, assignments } = scheduleH1cAssignments(cases);
    expect(schedule.blockIds).toHaveLength(8);
    expect(assignments).toHaveLength(28);
    expect(new Set(assignments.map((item) => item.assignmentId)).size).toBe(28);
    for (const blockId of schedule.blockIds) {
      const block = assignments.filter((item) => item.blockId === blockId);
      expect(block[0]).toMatchObject({
        conditionId: 'STRONG_INITIAL', threadMode: 'FRESH', serialPosition: 1
      });
      expect(block.filter((item) => item.conditionId === 'ACTIVE_SELF_REVIEW')).toEqual([
        expect.objectContaining({ threadMode: 'CONTINUE_INITIAL' })
      ]);
      expect(block.filter((item) => item.threadMode === 'CONTINUE_INITIAL')).toHaveLength(1);
    }
  });

  it('counterbalances every two-arm evidence response order and nearly balances critique order', () => {
    const { schedule, assignments } = scheduleH1cAssignments(cases);
    const positions = (conditionId: string, prefix: string) => assignments
      .filter((item) => item.caseId.startsWith(prefix) && item.conditionId === conditionId)
      .map((item) => item.serialPosition - 1)
      .sort();
    expect(positions('ACTIVE_SELF_REVIEW', 'H1C-E')).toEqual([1, 1, 2, 2]);
    expect(positions('DECISIVE_EVIDENCE', 'H1C-E')).toEqual([1, 1, 2, 2]);
    for (const conditionId of [
      'ACTIVE_SELF_REVIEW', 'VALID_CRITIQUE', 'PLACEBO_CRITIQUE'
    ]) {
      const counts = new Map<number, number>();
      positions(conditionId, 'H1C-D').forEach((position) =>
        counts.set(position, (counts.get(position) ?? 0) + 1)
      );
      expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(1);
    }
    expect(schedule.scheduleSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('binds the analysis policy and a passed H0 receipt into the private plan', () => {
    const locks = componentLocks();
    const plan = buildH1cPlan({
      cases,
      locks,
      h0Validation: h0Receipt(locks),
      createdAt: '2026-08-02T00:00:00.000Z'
    });
    expect(() => assertH1cPlan(plan, cases, locks)).not.toThrow();

    const altered = structuredClone(plan);
    (altered.analysis as { generatedSignalCostIncluded: boolean })
      .generatedSignalCostIncluded = true;
    expect(() => assertH1cPlan(altered, cases, locks)).toThrow('analysis');

    const staleReceipt = structuredClone(plan);
    staleReceipt.h0Validation.report.componentLocks.promptVersion = 'stale';
    expect(() => assertH1cPlan(staleReceipt, cases, locks)).toThrow('h0Validation');
  });
});

function componentLocks(): LabComponentLock {
  return {
    corpusVersion: 'h1c-assay-corpus@v3',
    participantCorpusSha256: '1'.repeat(64),
    oracleCorpusSha256: '2'.repeat(64),
    labSourceSha256: '3'.repeat(64),
    preregistrationVersion: 'h1c-preregistration-v3',
    preregistrationSha256: '4'.repeat(64),
    promptVersion: 'h1c-public-prompts@v3',
    outputSchemaVersion: 'discourse-protocol-lab/public-output-v4',
    scoringVersion: 'h1c-assay-metrics@v3',
    protocolVersion: 'h1c-live-yoked-protocol@v3'
  };
}

function h0Receipt(locks: LabComponentLock): H1cH0Receipt {
  return {
    runId: 'h1c-h0-test',
    manifestSha256: '5'.repeat(64),
    reportSha256: '6'.repeat(64),
    report: {
      schemaVersion: 'task-monki/discourse-lab-h1c-h0@v3',
      validationVersion: 'h1c-h0-validation@v3',
      hypothesisId: 'H0-H1C',
      status: 'PASSED',
      componentLocks: structuredClone(locks),
      promptTemplateSetSha256: '7'.repeat(64),
      checks: [{ checkId: 'ZERO_PROVIDER_CALLS', status: 'PASSED', detail: 'No calls.' }]
    }
  };
}
