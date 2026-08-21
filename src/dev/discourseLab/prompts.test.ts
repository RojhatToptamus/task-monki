import { describe, expect, it } from 'vitest';
import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabArtifactRecord,
  type LabParticipantCase,
  type LabPublicOutput
} from './contracts';
import { createLabOutputRecord } from './outputValidation';
import { buildLabPrompt, type LabPublicIntervention } from './prompts';
import { getLabProtocolPlan } from './protocols';

describe('Discourse Protocol Lab participant prompts', () => {
  it('hides corpus allocation labels while retaining the ordinary-text case', () => {
    const prompt = buildLabPrompt({
      participantCase: participantCase(),
      call: getLabProtocolPlan('CONTROL_EVIDENCE_B1').calls[0]!,
      visibleArtifacts: [],
      intervention: intervention()
    });

    expect(prompt).toContain('Which answer follows from the supplied text?');
    expect(prompt).toContain('decisive arithmetic check');
    expect(prompt).toContain('EVIDENCE_PACKET');
    expect(prompt).not.toContain('DEV-GAP-01');
    expect(prompt).not.toContain('epistemic gap');
    expect(prompt).not.toContain('DEV-I-01');
    expect(prompt).not.toContain('DEV-I-01-V2');
    expect(prompt).not.toContain('known wrong initial');
  });

  it.each([
    {
      conditionId: 'CONTROL_NO_FEEDBACK_B1',
      signalKind: 'NONE',
      artifacts: []
    },
    {
      conditionId: 'CONTROL_VALID_CRITIQUE_B1',
      signalKind: 'PEER_MESSAGE',
      artifacts: [{ artifactId: 'peer-1', text: 'The arithmetic should be checked.' }]
    },
    {
      conditionId: 'CONTROL_CORRECT_MINORITY_B1',
      signalKind: 'PEER_SET',
      artifacts: [
        { artifactId: 'peer-1', text: 'Majority view.' },
        { artifactId: 'peer-2', text: 'Minority view.' }
      ]
    },
    {
      conditionId: 'CONTROL_EVIDENCE_B1',
      signalKind: 'EVIDENCE_PACKET',
      artifacts: [{ artifactId: 'evidence-1', text: 'A supplied calculation.' }]
    }
  ] as const)(
    'makes plain $signalKind controlled signals non-response targets',
    ({ conditionId, signalKind, artifacts }) => {
      const prompt = buildLabPrompt({
        participantCase: participantCase(),
        call: getLabProtocolPlan(conditionId).calls[0]!,
        visibleArtifacts: [visibleArtifact([])],
        intervention: { ...intervention(), signalKind, artifacts: [...artifacts] }
      });

      expect(promptJsonSection(prompt, 'Valid structured response targets (exact ids; empty means responses must be []):'))
        .toEqual([]);
      expect(prompt).toContain('A signal is a structured critique only when its exact artifact/issue pair appears');
      expect(prompt).toContain('When that list is empty, emit responses: [].');
      for (const artifact of artifacts) expect(prompt).toContain(artifact.artifactId);
    }
  );

  it('enumerates only exact issue ids from structured visible artifacts as response targets', () => {
    const prompt = buildLabPrompt({
      participantCase: participantCase(),
      call: getLabProtocolPlan('SELF_REVIEW_B3').calls[2]!,
      visibleArtifacts: [visibleArtifact(['issue-visible'])]
    });

    expect(promptJsonSection(prompt, 'Valid structured response targets (exact ids; empty means responses must be []):'))
      .toEqual([{
        targetArtifactId: 'INITIAL',
        targetIssueId: 'issue-visible',
        targetPropositionId: 'c1'
      }]);
  });

  it('exposes only explicitly structured intervention critiques as response targets', () => {
    const prompt = buildLabPrompt({
      participantCase: participantCase(),
      call: getLabProtocolPlan('CONTROL_VALID_CRITIQUE_B1').calls[0]!,
      visibleArtifacts: [visibleArtifact([])],
      intervention: {
        ...intervention(),
        signalKind: 'STRUCTURED_CRITIQUE',
        artifacts: [{
          artifactId: 'critique-1',
          issueId: 'critique-issue-1',
          targetPropositionId: 'c1',
          text: 'Check the stated denominator.'
        }]
      }
    });

    expect(promptJsonSection(prompt, 'Valid structured response targets (exact ids; empty means responses must be []):'))
      .toEqual([{
        targetArtifactId: 'critique-1',
        targetIssueId: 'critique-issue-1',
        targetPropositionId: 'c1'
      }]);
  });
});

function promptJsonSection(prompt: string, heading: string): unknown {
  const lines = prompt.split('\n');
  const index = lines.indexOf(heading);
  return index === -1 ? undefined : JSON.parse(lines[index + 1]!);
}

function participantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'DEV-GAP-01',
    question: 'Which answer follows from the supplied text?',
    evidence: [{ id: 'PROMPT', text: 'Facts stated in the question.' }],
    propositions: [{ id: 'c1', topicId: 'case', text: 'The answer is unresolved.' }],
    options: [],
    topics: [{ id: 'case', label: 'epistemic gap' }]
  };
}

function intervention(): LabPublicIntervention {
  return {
    bundleId: 'DEV-I-01',
    variantId: 'DEV-I-01-V2',
    fixedInitial: {
      artifactId: 'initial-1',
      answer: 'known wrong initial',
      status: 'ANSWER',
      assessments: [{ claimId: 'c1', stance: 'REJECT' }]
    },
    signalKind: 'EVIDENCE_PACKET',
    artifacts: [{ artifactId: 'evidence-1', text: 'decisive arithmetic check' }]
  };
}

function visibleArtifact(issueIds: string[]): LabArtifactRecord {
  const output: LabPublicOutput = {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'ANSWER',
    answer: { summary: 'Visible answer.', values: [], selectedOptionIds: [] },
    claims: [{
      id: 'visible-claim',
      propositionId: 'c1',
      topicId: 'case',
      stance: 'OPEN',
      statement: 'The answer may be unresolved.',
      evidence: [],
      assumptionIds: [],
      confidence: 0.5
    }],
    assumptions: [],
    issues: issueIds.map((id) => ({
      id,
      targetArtifactId: 'CASE',
      targetPropositionId: 'c1',
      kind: 'EVIDENCE',
      severity: 'MATERIAL',
      statement: 'The supplied evidence is incomplete.',
      evidence: [],
      confidence: 0.5
    })),
    responses: [],
    disagreements: [],
    resolution: {
      status: 'UNRESOLVED',
      basis: 'INSUFFICIENT_INFORMATION',
      summary: 'The evidence is incomplete.',
      resolvedIssueIds: [],
      unresolvedIssueIds: issueIds
    },
    userQuestions: [],
    confidence: 0.5
  };
  return {
    artifactId: 'INITIAL',
    actorId: 'A',
    stage: 'POSITION',
    parentArtifactIds: [],
    output: createLabOutputRecord({
      callId: 'visible',
      rawText: JSON.stringify(output),
      charged: false
    })
  };
}
