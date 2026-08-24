import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  H1B_CORPUS_VERSION,
  h1bParticipantFixturePaths,
  h1bPublicIntervention,
  h1bScorerFixturePaths,
  loadH1bOracleCorpus,
  loadH1bParticipantCorpus
} from './h1bCorpus';

const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');

describe('H1b development corpus', () => {
  it('loads six public development records without scorer truth', async () => {
    const corpus = await loadH1bParticipantCorpus(fixtureRoot);

    expect(corpus.corpusVersion).toBe(H1B_CORPUS_VERSION);
    expect(corpus.partition).toBe('DEVELOPMENT');
    expect(corpus.records.map((record) => record.caseId)).toEqual([
      'H1B-D1',
      'H1B-D2',
      'H1B-D3',
      'H1B-G1',
      'H1B-G2',
      'H1B-G3'
    ]);
    expect(
      corpus.records.filter((record) => record.stratum === 'DERIVABLE_CRITIQUE')
    ).toHaveLength(3);
    expect(corpus.records.filter((record) => record.stratum === 'NEW_EVIDENCE')).toHaveLength(3);

    const publicJson = JSON.stringify(corpus);
    for (const scorerOnlyKey of [
      'baseProfile',
      'treatmentProfile',
      'derivationNotes',
      'auditNotes',
      'fixedInitialExpectation',
      'acceptedIssueKindEquivalences'
    ]) {
      expect(publicJson).not.toContain(scorerOnlyKey);
    }
    expect(
      h1bParticipantFixturePaths(fixtureRoot).every(
        (filePath) => !filePath.split(path.sep).includes('scorer-only')
      )
    ).toBe(true);
    expect(
      h1bScorerFixturePaths(fixtureRoot).every((filePath) =>
        filePath.split(path.sep).includes('scorer-only')
      )
    ).toBe(true);
  });

  it('pairs BASE and TREATMENT truth with exact targets, guards, and evidence', async () => {
    const participants = await loadH1bParticipantCorpus(fixtureRoot);
    const oracles = await loadH1bOracleCorpus(fixtureRoot, participants);

    expect(oracles).toHaveLength(6);
    for (const oracle of oracles) {
      const participant = participants.records.find((record) => record.caseId === oracle.caseId)!;
      const publicPropositions = participant.participantCase.propositions.map((item) => item.id);
      expect(
        new Set([...oracle.targetPropositionIds, ...oracle.guardPropositionIds])
      ).toEqual(new Set(publicPropositions));
      expect(
        oracle.targetPropositionIds.some((id) => oracle.guardPropositionIds.includes(id))
      ).toBe(false);
      expect(oracle.baseProfile.conditionIds).toEqual([
        'CONTROL_CASE_ONLY_B1',
        'CONTROL_NO_FEEDBACK_B1'
      ]);
      expect(oracle.acceptedIssueKindEquivalences.length).toBeGreaterThan(0);

      const treatmentEvidence = new Set(
        oracle.treatmentProfile.propositions.flatMap((expectation) =>
          expectation.requiredEvidenceSets.flat()
        )
      );
      const signal = participant.signal.artifacts[0]!;
      if (oracle.stratum === 'DERIVABLE_CRITIQUE') {
        expect(oracle.fixedInitialExpectation).toBe('WRONG');
        expect(oracle.treatmentProfile.conditionIds).toEqual([
          'CONTROL_VALID_CRITIQUE_B1'
        ]);
        expect(signal.issueId).toBeTruthy();
        expect(oracle.targetPropositionIds).toContain(signal.targetPropositionId);
        expect(treatmentEvidence).not.toContain(signal.artifactId);
      } else {
        expect(oracle.fixedInitialExpectation).toBe('APPROPRIATELY_OPEN');
        expect(oracle.treatmentProfile.conditionIds).toEqual(['CONTROL_EVIDENCE_B1']);
        expect(signal.evidenceId).toBe(signal.artifactId);
        expect(treatmentEvidence).toContain(signal.evidenceId);
      }
    }
    const gapTargetStances = oracles
      .filter((oracle) => oracle.stratum === 'NEW_EVIDENCE')
      .flatMap((oracle) =>
        oracle.targetPropositionIds.flatMap(
          (targetId) =>
            oracle.treatmentProfile.propositions.find(
              (expectation) => expectation.propositionId === targetId
            )?.acceptableStances ?? []
        )
      );
    expect(new Set(gapTargetStances)).toEqual(new Set(['ACCEPT', 'REJECT']));
  });

  it('projects only the intervention applicable to a case and condition', async () => {
    const { records } = await loadH1bParticipantCorpus(fixtureRoot);
    const derivable = records.find((record) => record.caseId === 'H1B-D1')!;
    const gap = records.find((record) => record.caseId === 'H1B-G1')!;

    expect(h1bPublicIntervention(derivable, 'CONTROL_CASE_ONLY_B1')).toBeNull();
    expect(h1bPublicIntervention(derivable, 'CONTROL_EVIDENCE_B1')).toBeNull();
    expect(h1bPublicIntervention(gap, 'CONTROL_VALID_CRITIQUE_B1')).toBeNull();

    const baseline = h1bPublicIntervention(derivable, 'CONTROL_NO_FEEDBACK_B1');
    expect(baseline).toMatchObject({ signalKind: 'NONE', artifacts: [] });
    expect(baseline?.fixedInitial.assessments).toEqual(derivable.fixedInitial.assessments);

    const critique = h1bPublicIntervention(derivable, 'CONTROL_VALID_CRITIQUE_B1');
    expect(critique?.signalKind).toBe('PEER_MESSAGE');
    expect(critique?.artifacts[0]).toMatchObject({
      artifactId: 'd1-s1',
      issueId: 'd1-i1',
      targetPropositionId: 'd1-p1',
      kind: 'LOGIC',
      severity: 'MATERIAL'
    });

    const evidence = h1bPublicIntervention(gap, 'CONTROL_EVIDENCE_B1');
    expect(evidence?.signalKind).toBe('EVIDENCE_PACKET');
    expect(evidence?.artifacts[0]).toMatchObject({
      artifactId: 'g1-e1',
      evidenceId: 'g1-e1'
    });
  });

  it('refuses scorer pairing when the sealed public case set changes', async () => {
    const participants = await loadH1bParticipantCorpus(fixtureRoot);
    const incomplete = structuredClone(participants);
    incomplete.records.pop();

    await expect(loadH1bOracleCorpus(fixtureRoot, incomplete)).rejects.toThrow(
      'exactly the six development cases'
    );
  });
});
