import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadLabOracleCorpus,
  loadLabParticipantCorpus,
  participantFixturePaths,
  planControlledAssignments
} from './corpus';

const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');

describe('sealed Discourse Lab corpus', () => {
  it('keeps participant loading physically outside scorer-only fixtures', async () => {
    expect(
      participantFixturePaths(fixtureRoot, 'CONFIRMATION').every(
        (filePath) => !filePath.split(path.sep).includes('scorer-only')
      )
    ).toBe(true);
    const [development, confirmation] = await Promise.all([
      loadLabParticipantCorpus(fixtureRoot, 'DEVELOPMENT'),
      loadLabParticipantCorpus(fixtureRoot, 'CONFIRMATION')
    ]);
    expect(development.cases).toHaveLength(16);
    expect(confirmation.cases).toHaveLength(16);
    expect(new Set(development.cases.map((item) => item.question))).not.toEqual(
      new Set(confirmation.cases.map((item) => item.question))
    );
  });

  it('loads oracle pairs only in the separate scoring phase', async () => {
    const participants = await loadLabParticipantCorpus(fixtureRoot, 'DEVELOPMENT');
    const oracles = await loadLabOracleCorpus(fixtureRoot, participants);
    expect(oracles).toHaveLength(16);
    expect(oracles.find((item) => item.caseId === 'DEV-EVD-04')?.validCritiques).toEqual([]);
  });

  it('allocates every sealed controlled variant without exposing validity in public ids', async () => {
    const assignments = await planControlledAssignments(fixtureRoot, 'DEVELOPMENT');
    expect(assignments).toHaveLength(14);
    expect(assignments.map((item) => item.conditionId)).toEqual(
      expect.arrayContaining([
        'CONTROL_NO_FEEDBACK_B1',
        'CONTROL_VALID_CRITIQUE_B1',
        'CONTROL_EVIDENCE_B1',
        'CONTROL_INVALID_CRITIQUE_B1',
        'CONTROL_CONFIDENT_WRONG_B1',
        'CONTROL_CORRECT_MINORITY_B1'
      ])
    );
    expect(assignments.every((item) => !/valid|wrong|correct|evidence/iu.test(item.variantId))).toBe(true);
  });
});
