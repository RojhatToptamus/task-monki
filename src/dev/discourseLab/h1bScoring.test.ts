import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LabPublicOutput } from './contracts';
import { LAB_PUBLIC_OUTPUT_SCHEMA_VERSION } from './contracts';
import {
  type H1bConditionId,
  type H1bOracleCase,
  type H1bParticipantCaseRecord,
  loadH1bOracleCorpus,
  loadH1bParticipantCorpus
} from './h1bCorpus';
import { scoreH1bPublicOutput } from './h1bScoring';

const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
let records: H1bParticipantCaseRecord[];
let oracles: H1bOracleCase[];

beforeAll(async () => {
  const corpus = await loadH1bParticipantCorpus(fixtureRoot);
  records = corpus.records;
  oracles = await loadH1bOracleCorpus(fixtureRoot, corpus);
});

describe('H1b context-aware scoring', () => {
  it('scores answer options exactly and does not use free-form value aliases as authority', () => {
    const { record, oracle } = pair('H1B-D1');
    const output = perfectOutput(record, oracle, 'CONTROL_CASE_ONLY_B1');
    output.answer.values = ['anything semantically plausible'];
    expect(score(record, oracle, 'CONTROL_CASE_ONLY_B1', output)).toMatchObject({
      answerCorrect: true,
      contextualTerminalCorrect: true
    });

    output.answer.selectedOptionIds = ['d1-o80'];
    expect(score(record, oracle, 'CONTROL_CASE_ONLY_B1', output)).toMatchObject({
      answerCorrect: false,
      contextualTerminalCorrect: false
    });
  });

  it('keeps an information gap open under BASE and detects unsupported closure', () => {
    const { record, oracle } = pair('H1B-G1');
    const open = perfectOutput(record, oracle, 'CONTROL_NO_FEEDBACK_B1');
    expect(score(record, oracle, 'CONTROL_NO_FEEDBACK_B1', open)).toMatchObject({
      answerCorrect: true,
      targetCorrect: true,
      unsupportedClosure: false,
      contextualTerminalCorrect: true
    });

    open.status = 'ANSWER';
    open.answer.selectedOptionIds = ['g1-yes'];
    open.claims.find((claim) => claim.propositionId === 'g1-p1')!.stance = 'ACCEPT';
    const closed = score(record, oracle, 'CONTROL_NO_FEEDBACK_B1', open);
    expect(closed.unsupportedClosure).toBe(true);
    expect(closed.contextualTerminalCorrect).toBe(false);
  });

  it('requires genuinely new evidence by exact id and never aliases it to PROMPT', () => {
    const { record, oracle } = pair('H1B-G2');
    const output = perfectOutput(record, oracle, 'CONTROL_EVIDENCE_B1');
    expect(score(record, oracle, 'CONTROL_EVIDENCE_B1', output)).toMatchObject({
      exactEvidenceAttribution: true,
      contextualTerminalCorrect: true
    });

    for (const claim of output.claims) {
      claim.evidence = claim.evidence.filter((reference) => reference.evidenceId !== 'g2-e1');
    }
    const missing = score(record, oracle, 'CONTROL_EVIDENCE_B1', output);
    expect(missing.exactEvidenceAttribution).toBe(false);
    expect(missing.contextualTerminalCorrect).toBe(false);
  });

  it('requires a direct critique response and treats critique text as non-factual evidence', () => {
    const { record, oracle } = pair('H1B-D3');
    const output = perfectOutput(record, oracle, 'CONTROL_VALID_CRITIQUE_B1');
    expect(score(record, oracle, 'CONTROL_VALID_CRITIQUE_B1', output)).toMatchObject({
      targetCorrect: true,
      validCritiqueUptake: true,
      critiqueCitedAsEvidence: false
    });

    output.responses = [];
    expect(score(record, oracle, 'CONTROL_VALID_CRITIQUE_B1', output).validCritiqueUptake)
      .toBe(false);
    output.claims[0]!.evidence.push({
      evidenceId: 'd3-s1',
      relation: 'SUPPORTS',
      note: 'Incorrectly treated critique as factual evidence.'
    });
    expect(score(record, oracle, 'CONTROL_VALID_CRITIQUE_B1', output).critiqueCitedAsEvidence)
      .toBe(true);
  });

  it('separates target correction from right-to-wrong guard contamination', () => {
    const { record, oracle } = pair('H1B-D2');
    const output = perfectOutput(record, oracle, 'CONTROL_VALID_CRITIQUE_B1');
    const guard = output.claims.find((claim) => claim.propositionId === 'd2-p1')!;
    guard.stance = 'REJECT';
    expect(score(record, oracle, 'CONTROL_VALID_CRITIQUE_B1', output)).toMatchObject({
      targetCorrect: true,
      guardCorrect: false,
      guardContamination: true,
      contextualTerminalCorrect: false
    });
  });
});

function pair(caseId: string): { record: H1bParticipantCaseRecord; oracle: H1bOracleCase } {
  return {
    record: records.find((item) => item.caseId === caseId)!,
    oracle: oracles.find((item) => item.caseId === caseId)!
  };
}

function score(
  record: H1bParticipantCaseRecord,
  oracle: H1bOracleCase,
  conditionId: H1bConditionId,
  output: LabPublicOutput
) {
  return scoreH1bPublicOutput({ output, record, oracle, conditionId });
}

function perfectOutput(
  record: H1bParticipantCaseRecord,
  oracle: H1bOracleCase,
  conditionId: H1bConditionId
): LabPublicOutput {
  const profile = oracle.baseProfile.conditionIds.includes(conditionId)
    ? oracle.baseProfile
    : oracle.treatmentProfile;
  const claims = profile.propositions.map((expectation, index) => ({
    id: `c-out-${index + 1}`,
    propositionId: expectation.propositionId,
    topicId: record.participantCase.propositions.find(
      (item) => item.id === expectation.propositionId
    )!.topicId,
    stance: expectation.acceptableStances[0]!,
    statement: `Assessment for ${expectation.propositionId}.`,
    evidence: (expectation.requiredEvidenceSets[0] ?? []).map((evidenceId) => ({
      evidenceId,
      relation: 'SUPPORTS' as const,
      note: `Public support for ${expectation.propositionId}.`
    })),
    assumptionIds: [],
    confidence: 0.8
  }));
  const signal = record.signal.artifacts[0]!;
  const changedClaimIds = oracle.targetPropositionIds.map((propositionId) =>
    claims.find((claim) => claim.propositionId === propositionId)!.id
  );
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: profile.acceptableStatuses[0]!,
    answer: {
      summary: 'Sealed expected public answer.',
      values: [],
      selectedOptionIds: [...profile.acceptedAnswerOptionSets[0]!]
    },
    claims,
    assumptions: [],
    issues: [],
    responses: conditionId === 'CONTROL_VALID_CRITIQUE_B1'
      ? [{
          id: 'response-1',
          targetArtifactId: signal.artifactId,
          targetIssueId: signal.issueId!,
          disposition: 'ACCEPT',
          statement: 'The public case supports the correction.',
          evidence: [{
            evidenceId: 'PROMPT',
            relation: 'SUPPORTS',
            note: 'The supplied case supports this response.'
          }],
          changedClaimIds
        }]
      : [],
    disagreements: [],
    resolution: {
      status: profile.requiredUserQuestionCruxIds.length > 0
        ? 'NEEDS_USER_INPUT'
        : 'NO_DISAGREEMENT',
      basis: profile.requiredUserQuestionCruxIds.length > 0
        ? 'INSUFFICIENT_INFORMATION'
        : 'EVIDENCE',
      summary: 'Sealed expected resolution.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: profile.requiredUserQuestionCruxIds.map((cruxId, index) => ({
      id: `question-${index + 1}`,
      cruxId,
      question: 'What is the missing decisive fact?',
      whyNeeded: 'The current record cannot resolve the target.',
      propositionIds: [...oracle.targetPropositionIds]
    })),
    confidence: 0.8
  };
}
