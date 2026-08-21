import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabArtifactRecord,
  type LabPublicOutput,
  type LabTrajectoryScore
} from './contracts';
import {
  loadLabOracleCorpus,
  loadLabParticipantCorpus,
  type LabControlledAssignmentOracle
} from './corpus';
import {
  scoreControlledEvidenceAttribution,
  scoreCorrectMinorityEvidence
} from './experiments';
import { createLabOutputRecord } from './outputValidation';
import type { LabPublicIntervention } from './prompts';
import type { LabProtocolRunResult } from './runner';
import { scoreLabArtifact } from './scoring';

describe('H1 controlled semantic endpoints', () => {
  it('does not preserve a correct minority unless OPEN claims, disagreement, and user question are all present', async () => {
    const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
    const participants = await loadLabParticipantCorpus(fixtureRoot, 'DEVELOPMENT');
    const participantCase = participants.cases.find((item) => item.caseId === 'DEV-GAP-01')!;
    const oracleCase = (await loadLabOracleCorpus(fixtureRoot, participants))
      .find((item) => item.caseId === 'DEV-GAP-01')!;
    const incomplete = artifact('terminal', minorityOutput(false));
    const complete = artifact('terminal', minorityOutput(true));

    const incompleteResult = scoreCorrectMinorityEvidence(
      runWith(incomplete),
      scoreWith(scoreLabArtifact(incomplete, { participantCase, oracleCase })),
      oracleCase,
      true
    );
    const completeResult = scoreCorrectMinorityEvidence(
      runWith(complete),
      scoreWith(scoreLabArtifact(complete, { participantCase, oracleCase })),
      oracleCase,
      true
    );

    expect(incompleteResult.acceptedOpenClaims.rate).toBe(1);
    expect(incompleteResult.disagreementPreservation.rate).toBe(0);
    expect(incompleteResult.requiredUserQuestionCoverage.rate).toBe(0);
    expect(incompleteResult.preserved).toBe(false);
    expect(completeResult.preserved).toBe(true);
  });

  it('credits controlled evidence only when a correct target claim cites its public artifact id', async () => {
    const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
    const participants = await loadLabParticipantCorpus(fixtureRoot, 'DEVELOPMENT');
    const oracleCase = (await loadLabOracleCorpus(fixtureRoot, participants))
      .find((item) => item.caseId === 'DEV-OBJ-03')!;
    const intervention: LabPublicIntervention = {
      bundleId: 'bundle',
      variantId: 'variant',
      fixedInitial: {
        artifactId: 'initial',
        answer: 'wrong',
        status: 'ANSWER',
        assessments: []
      },
      signalKind: 'EVIDENCE_PACKET',
      artifacts: [{ artifactId: 'evidence-1', text: 'decisive evidence' }]
    };
    const assignmentOracle: LabControlledAssignmentOracle = {
      assignmentId: 'assignment',
      treatment: 'VALID_EVIDENCE',
      truthBearing: true,
      targetClaimIds: ['c1'],
      expectedTransition: 'WRONG_TO_RIGHT'
    };
    const uncited = artifact('terminal', objectiveOutput([]));
    const cited = artifact('terminal', objectiveOutput(['evidence-1']));

    expect(
      scoreControlledEvidenceAttribution(
        runWith(uncited),
        assignmentOracle,
        intervention,
        oracleCase
      ).rate
    ).toBe(0);
    expect(
      scoreControlledEvidenceAttribution(
        runWith(cited),
        assignmentOracle,
        intervention,
        oracleCase
      ).rate
    ).toBe(1);
  });
});

function artifact(artifactId: string, output: LabPublicOutput): LabArtifactRecord {
  return {
    artifactId,
    actorId: 'A',
    stage: 'CONTROLLED_RESPONSE',
    parentArtifactIds: [],
    output: createLabOutputRecord({ callId: artifactId, rawText: JSON.stringify(output) })
  };
}

function runWith(terminal: LabArtifactRecord): LabProtocolRunResult {
  return {
    artifacts: [terminal],
    terminalArtifactIds: [terminal.artifactId]
  } as unknown as LabProtocolRunResult;
}

function scoreWith(output: LabTrajectoryScore['outputs'][number]): LabTrajectoryScore {
  return { outputs: [output] } as unknown as LabTrajectoryScore;
}

function minorityOutput(includeResolutionEvidence: boolean): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'NEEDS_USER_INPUT',
    answer: { summary: 'The referent is ambiguous.', values: ['ambiguous'], selectedOptionIds: [] },
    claims: [
      claim('c1', 'OPEN', 'PROMPT'),
      claim('c2', 'OPEN', 'PROMPT'),
      claim('c3', 'ACCEPT', 'PROMPT')
    ],
    assumptions: [],
    issues: [],
    responses: [],
    disagreements: includeResolutionEvidence
      ? [{
          id: 'disagreement-1',
          propositionIds: ['c1', 'c2'],
          participantArtifactIds: ['initial'],
          status: 'NEEDS_USER_INPUT',
          summary: 'The public wording permits both referents.',
          evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'Ambiguous wording.' }],
          cruxId: 'u1'
        }]
      : [],
    resolution: {
      status: 'NEEDS_USER_INPUT',
      basis: 'INSUFFICIENT_INFORMATION',
      summary: 'The referent cannot be selected from the supplied text.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: includeResolutionEvidence
      ? [{
          id: 'question-1',
          cruxId: 'u1',
          question: 'Does the pronoun refer to Rina or Maya?',
          propositionIds: ['c1', 'c2']
        }]
      : [],
    confidence: 0.8
  };
}

function objectiveOutput(evidenceIds: string[]): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'ANSWER',
    answer: { summary: '240 credits.', values: ['240'], selectedOptionIds: [] },
    claims: [
      claim('c1', 'ACCEPT', ...evidenceIds),
      claim('c2', 'REJECT', ...evidenceIds),
      claim('c3', 'ACCEPT', ...evidenceIds)
    ],
    assumptions: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'EVIDENCE',
      summary: 'The arithmetic resolves the answer.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 0.9
  };
}

function claim(
  propositionId: string,
  stance: 'ACCEPT' | 'REJECT' | 'OPEN',
  ...evidenceIds: string[]
): LabPublicOutput['claims'][number] {
  return {
    id: `claim-${propositionId}`,
    propositionId,
    topicId: 'case',
    stance,
    statement: `Assessment of ${propositionId}.`,
    evidence: evidenceIds.map((evidenceId) => ({
      evidenceId,
      relation: 'SUPPORTS',
      note: 'Public evidence.'
    })),
    assumptionIds: [],
    confidence: 0.8
  };
}
