import { describe, expect, it } from 'vitest';
import {
  assertHardPeer80Plan,
  buildHardPeer80Plan,
  type HardPeer80CallAssignment
} from './hardPeer80Plan';

const calibrationCaseIds = ['CAL-M', 'CAL-L', 'CAL-H', 'CAL-D', 'CAL-T'];
const evaluationCaseIds = ['EVAL-M', 'EVAL-L', 'EVAL-H', 'EVAL-D', 'EVAL-T'];

describe('HARD-PEER-80 sealed topology', () => {
  it('uses exactly one probe, five calibration calls, and seventy evaluation calls', () => {
    const plan = buildPlan();
    expect(plan.assignments).toHaveLength(76);
    expect(plan.assignments.map(({ callNumber }) => callNumber)).toEqual(
      Array.from({ length: 76 }, (_, index) => index + 1)
    );
    expect(plan.assignments.filter(({ phase }) => phase === 'BOUNDARY_PROBE')).toHaveLength(1);
    expect(plan.assignments.filter(({ phase }) => phase === 'CALIBRATION')).toHaveLength(5);
    expect(plan.assignments.filter(({ phase }) => phase === 'EVALUATION')).toHaveLength(70);
    expect(plan.budget).toMatchObject({
      maximumProviderCalls: 76,
      maximumObservedTotalTokens: 1_500_000,
      maximumExperimentMs: 18_000_000,
      targetOutputTokensPerCall: 3_000,
      emergencyOutputTokenSafetyCeilingPerCall: 10_000,
      maximumNextCallObservedTokenReservation: 25_000,
      calibrationBatches: 1,
      evaluationRuns: 1,
      retries: 0,
      repairs: 0,
      followUpExperiments: 0
    });
  });

  it('creates ten shared-A0 blocks with equal two-turn condition funding', () => {
    const plan = buildPlan();
    expect(plan.schedule.evaluationBlockIds).toHaveLength(10);
    expect(new Set(plan.schedule.evaluationBlockIds).size).toBe(10);
    for (const blockId of plan.schedule.evaluationBlockIds) {
      const block = plan.assignments.filter((assignment) => assignment.blockId === blockId);
      expect(block).toHaveLength(7);
      expect(block.filter(({ turnId }) => turnId === 'A0')).toEqual([
        expect.objectContaining({
          conditionId: 'SHARED_INITIAL', threadMode: 'FRESH', stage: 'INITIAL'
        })
      ]);
      expect(turns(block, 'STRONG_WORKBENCH')).toEqual(['W1', 'W2']);
      expect(turns(block, 'SAME_AGENT_SELF_REVIEW')).toEqual(['S1', 'S2']);
      expect(turns(block, 'BLIND_PEER_CRITIQUE')).toEqual(['P1', 'AP1']);
    }
    for (const caseId of evaluationCaseIds) {
      expect(plan.assignments.filter(
        ({ caseId: assigned, turnId }) => assigned === caseId && turnId === 'A0'
      )).toHaveLength(2);
    }
  });

  it('requires all three author forks immediately after A0 and keeps P1 fresh', () => {
    const plan = buildPlan();
    expect(plan.forks).toHaveLength(30);
    for (const blockId of plan.schedule.evaluationBlockIds) {
      const block = plan.assignments.filter((assignment) => assignment.blockId === blockId);
      const a0 = block.find(({ turnId }) => turnId === 'A0')!;
      const forks = plan.forks.filter((fork) => fork.blockId === blockId);
      expect(forks.map(({ branch }) => branch).sort()).toEqual([
        'PEER_RESPONSE_AUTHOR', 'SELF_REVIEW_AUTHOR', 'WORKBENCH_AUTHOR'
      ]);
      expect(forks.every((fork) =>
        fork.sourceCallId === a0.callId &&
        fork.timing === 'AFTER_A0_BEFORE_ANY_BRANCH_CALL' &&
        fork.consumesProviderModelCall === false
      )).toBe(true);

      expect(block.find(({ turnId }) => turnId === 'W1')).toMatchObject({
        threadMode: 'FORK_A0', parentCallId: a0.callId
      });
      expect(block.find(({ turnId }) => turnId === 'S1')).toMatchObject({
        threadMode: 'FORK_A0', parentCallId: a0.callId
      });
      expect(block.find(({ turnId }) => turnId === 'P1')).toMatchObject({
        actor: 'PEER', threadMode: 'FRESH', parentCallId: null
      });
      expect(block.find(({ turnId }) => turnId === 'AP1')).toMatchObject({
        actor: 'AUTHOR', threadMode: 'FORK_A0', parentCallId: `${blockId}:P1`
      });
      expect(forks.find(({ branch }) => branch === 'PEER_RESPONSE_AUTHOR')).toMatchObject({
        firstBranchCallId: `${blockId}:AP1`,
        sessionKey: `${blockId}:peer-author`
      });
    }
  });

  it('counterbalances branch execution order without treating repetitions as independent cases', () => {
    const plan = buildPlan();
    const positionCounts = new Map<string, number>();
    for (const blockId of plan.schedule.evaluationBlockIds) {
      const branchOrder = orderedBranches(
        plan.assignments.filter((assignment) => assignment.blockId === blockId)
      );
      expect(branchOrder).toHaveLength(3);
      branchOrder.forEach((branch, index) => {
        const key = `${branch}:${index + 1}`;
        positionCounts.set(key, (positionCounts.get(key) ?? 0) + 1);
      });
    }
    for (let position = 1; position <= 3; position += 1) {
      const counts = ['W', 'S', 'P'].map((branch) => positionCounts.get(`${branch}:${position}`)!);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
    expect(plan.analysis).toMatchObject({
      repetitionsPerEvaluationCase: 2,
      repetitionsAreIndependentSamples: false,
      peerPositionIndependenceEstimable: false,
      peerBlindness:
        'FRESH_PEER_BLIND_TO_ORACLE_AUTHOR_IDENTITY_SIBLING_BRANCHES_AND_OUTCOMES_BUT_SEES_A0'
    });
  });

  it('is deterministic and rejects topology or budget drift', () => {
    const plan = buildPlan();
    const duplicate = buildPlan();
    expect(duplicate.schedule.scheduleSha256).toBe(plan.schedule.scheduleSha256);
    expect(() => assertHardPeer80Plan(plan, calibrationCaseIds, evaluationCaseIds)).not.toThrow();

    const drift = structuredClone(plan);
    (drift.budget as { maximumProviderCalls: number }).maximumProviderCalls = 77;
    expect(() => assertHardPeer80Plan(drift, calibrationCaseIds, evaluationCaseIds))
      .toThrow('budget');
  });

  it('rejects overlapping, missing, or replacement case ids', () => {
    expect(() => buildHardPeer80Plan({
      calibrationCaseIds: calibrationCaseIds.slice(0, 4),
      evaluationCaseIds
    })).toThrow('exactly five');
    expect(() => buildHardPeer80Plan({
      calibrationCaseIds,
      evaluationCaseIds: [...evaluationCaseIds.slice(0, 4), calibrationCaseIds[0]!]
    })).toThrow('ten unique');
  });
});

function buildPlan() {
  return buildHardPeer80Plan({
    calibrationCaseIds,
    evaluationCaseIds,
    createdAt: '2026-08-03T00:00:00.000Z'
  });
}

function turns(
  assignments: readonly HardPeer80CallAssignment[],
  conditionId: HardPeer80CallAssignment['conditionId']
): string[] {
  return assignments
    .filter((assignment) => assignment.conditionId === conditionId)
    .map(({ turnId }) => turnId);
}

function orderedBranches(assignments: readonly HardPeer80CallAssignment[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const assignment of assignments.filter(({ turnId }) => turnId !== 'A0')) {
    const branch = assignment.turnId.startsWith('W')
      ? 'W'
      : assignment.turnId.startsWith('S')
        ? 'S'
        : 'P';
    if (!seen.has(branch)) {
      seen.add(branch);
      result.push(branch);
    }
  }
  return result;
}
