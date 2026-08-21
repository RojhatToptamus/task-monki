import { describe, expect, it } from 'vitest';
import { scheduleH1bAssignments, type H1bSchedulableCase } from './h1bPlan';

const CASES: H1bSchedulableCase[] = [
  { caseId: 'D1', stratum: 'DERIVABLE_CRITIQUE' },
  { caseId: 'D2', stratum: 'DERIVABLE_CRITIQUE' },
  { caseId: 'D3', stratum: 'DERIVABLE_CRITIQUE' },
  { caseId: 'G1', stratum: 'NEW_EVIDENCE' },
  { caseId: 'G2', stratum: 'NEW_EVIDENCE' },
  { caseId: 'G3', stratum: 'NEW_EVIDENCE' }
];

describe('H1b assignment plan', () => {
  it('builds 18 complete counterbalanced blocks and 54 primary calls', () => {
    const { schedule, assignments } = scheduleH1bAssignments(CASES);
    expect(schedule.blockIds).toHaveLength(18);
    expect(assignments).toHaveLength(54);
    expect(new Set(assignments.map((item) => item.assignmentId)).size).toBe(54);
    for (const blockId of schedule.blockIds) {
      const block = assignments.filter((item) => item.blockId === blockId);
      expect(block.map((item) => item.position)).toEqual([1, 2, 3]);
      expect(new Set(block.map((item) => item.conditionId)).size).toBe(3);
    }
  });

  it('balances every condition across all three positions within each case', () => {
    const { assignments } = scheduleH1bAssignments(CASES);
    for (const caseId of CASES.map((item) => item.caseId)) {
      const cells = assignments.filter((item) => item.caseId === caseId);
      for (const conditionId of new Set(cells.map((item) => item.conditionId))) {
        expect(cells.filter((item) => item.conditionId === conditionId).map((item) => item.position).sort())
          .toEqual([1, 2, 3]);
      }
    }
  });

  it('is independent of fixture input order and interleaves strata', () => {
    const first = scheduleH1bAssignments(CASES);
    const second = scheduleH1bAssignments([...CASES].reverse());
    expect(second).toEqual(first);
    const blockStrata = first.schedule.blockIds.map((blockId) =>
      first.assignments.find((item) => item.blockId === blockId)!.stratum
    );
    expect(blockStrata.every((value, index) =>
      index === 0 || value !== blockStrata[index - 1]
    )).toBe(true);
  });
});
