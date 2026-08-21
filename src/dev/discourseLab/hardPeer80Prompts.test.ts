import { describe, expect, it } from 'vitest';
import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  type LabParticipantCase
} from './contracts';
import {
  HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
  type HardPeer80PublicOutput,
  type HardPeer80VisibleArtifact
} from './hardPeer80Contracts';
import { buildHardPeer80Plan, type HardPeer80TurnId } from './hardPeer80Plan';
import {
  HARD_PEER_80_PROBE_CASE,
  buildHardPeer80BoundaryProbePrompt,
  buildHardPeer80Prompt
} from './hardPeer80Prompts';

describe('HARD-PEER-80 participant prompts', () => {
  it('gives initial answers no feedback or response target', () => {
    const prepared = buildHardPeer80Prompt({
      participantCase: participantCase(),
      assignment: assignment('A0'),
      visibleArtifacts: []
    });
    expect(prepared.context.visibleArtifacts).toEqual([]);
    expect(section(prepared.prompt, 'PUBLIC ARTIFACTS:')).toEqual([]);
    expect(section(prepared.prompt, 'VALID DIRECT-RESPONSE TARGETS:')).toEqual([]);
    expect(prepared.prompt).toContain('strongest first-pass answer');
    expect(prepared.prompt).toContain(
      'ACCEPT uses SUPPORTS, REJECT uses CONTRADICTS, OPEN or NOT_APPLICABLE uses LIMITS'
    );
    expect(prepared.prompt).not.toContain('oracleAnswer');
  });

  it('shows a fresh peer only A0 without identity, authority, or sibling branch labels', () => {
    const prepared = buildHardPeer80Prompt({
      participantCase: participantCase(),
      assignment: assignment('P1'),
      visibleArtifacts: [artifact('A0', 'POSITION', 'AUTHOR', answer('INITIAL'))]
    });
    expect(prepared.prompt).toContain('As a fresh reviewer');
    expect(prepared.prompt).toContain('Agreement or no material issue is valid');
    expect(prepared.prompt).toContain('names targetPropositionId and proposedStance');
    expect(prepared.prompt).toContain('complete proposedOptionIds set');
    expect(prepared.prompt).not.toContain('BLIND_PEER_CRITIQUE');
    expect(prepared.prompt).not.toContain('STRONG_WORKBENCH');
    expect(prepared.prompt).not.toContain('SAME_AGENT_SELF_REVIEW');
    expect(prepared.prompt).not.toContain('"actor":"AUTHOR"');
    expect(prepared.prompt).not.toContain('W1');
    expect(prepared.prompt).not.toContain('S1');
    expect(section(prepared.prompt, 'PUBLIC ARTIFACTS:')).toEqual([
      expect.objectContaining({ artifactId: 'A0', artifactKind: 'POSITION' })
    ]);
    expect(section(prepared.prompt, 'VALID DIRECT-RESPONSE TARGETS:')).toEqual([]);
  });

  it('enumerates exact P1 issue targets for the direct author response', () => {
    const peer = answer('PEER_CRITIQUE');
    peer.issues = [{
      id: 'peer-issue',
      targetArtifactId: 'A0',
      targetComponent: 'PROPOSITION',
      targetPropositionId: 'p1',
      kind: 'LOGIC',
      severity: 'MATERIAL',
      proposedStance: 'REJECT',
      proposedStatus: null,
      proposedOptionIds: null,
      proposedCertificate: null,
      statement: 'The trace reaches the second option.',
      evidence: [{ evidenceId: 'E1', relation: 'CONTRADICTS', note: 'E1 contradicts A0.' }],
      confidence: 0.9
    }];
    peer.resolution = {
      status: 'UNRESOLVED',
      basis: 'EVIDENCE',
      summary: 'The author has not responded.',
      resolvedIssueIds: [],
      unresolvedIssueIds: ['peer-issue']
    };
    const prepared = buildHardPeer80Prompt({
      participantCase: participantCase(),
      assignment: assignment('AP1'),
      visibleArtifacts: [
        artifact('A0', 'POSITION', 'AUTHOR', answer('INITIAL')),
        artifact('P1', 'REVIEW', 'PEER', peer)
      ]
    });
    expect(section(prepared.prompt, 'VALID DIRECT-RESPONSE TARGETS:')).toEqual([{
      targetArtifactId: 'P1',
      targetIssueId: 'peer-issue',
      targetComponent: 'PROPOSITION',
      targetPropositionId: 'p1'
    }]);
    expect(prepared.prompt).toContain('Accept, partially accept, reject, or abstain issue by issue');
  });

  it('states the public audit contract without requesting hidden reasoning', () => {
    const prompt = buildHardPeer80Prompt({
      participantCase: participantCase(),
      assignment: assignment('S1'),
      visibleArtifacts: [artifact('A0', 'POSITION', 'AUTHOR', answer('INITIAL'))]
    }).prompt;
    expect(prompt).toContain('Do not expose or request private chain-of-thought');
    expect(prompt).toContain('prior answer, issue, critique, response');
    expect(prompt).toContain('never invent criticism');
    expect(prompt).toContain('PROPOSITION, ANSWER_SELECTION, EPISTEMIC_STATE, or CERTIFICATE');
    expect(prompt).toContain('targetPropositionId is null except for PROPOSITION');
    expect(prompt).toContain('complete proposedCertificate payload');
    expect(prompt).toContain('exact corresponding changedTargets');
    expect(prompt).toContain('documented no-issue result is valid');
    expect(prompt).toContain('certificate.payload is public, typed, and deterministically checked');
    expect(prompt).toContain('all numeric values, lists, matching edges, truth assignments, worlds, traces');
    expect(prompt).toContain('Do not hide certificate data in prose');
    expect(prompt).not.toContain('show your reasoning');
  });

  it('builds the single sealed boundary-probe prompt', () => {
    const prepared = buildHardPeer80BoundaryProbePrompt(assignment('PROBE'));
    expect(prepared.context.participantCase).toEqual(HARD_PEER_80_PROBE_CASE);
    expect(prepared.context.stage).toBe('PROBE');
    expect(prepared.prompt).toContain('tiny synthetic case');
  });
});

function participantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'EVAL-M',
    question: 'Which option follows from the supplied trace?',
    evidence: [{ id: 'E1', text: 'The trace reaches option one.' }],
    propositions: [{ id: 'p1', topicId: 'trace', text: 'The trace reaches option one.' }],
    options: [{ id: 'o1', text: 'Option one' }, { id: 'o2', text: 'Option two' }],
    topics: [{ id: 'trace', label: 'Trace result' }]
  };
}

function answer(stage: HardPeer80PublicOutput['stage']): HardPeer80PublicOutput {
  return {
    schemaVersion: HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
    stage,
    answer: { status: 'ANSWER', summary: 'Option one.', selectedOptionIds: ['o1'], confidence: 0.8 },
    certificate: {
      kind: 'TRACE',
      statement: 'E1 reaches option one.',
      evidence: [{ evidenceId: 'E1', relation: 'SUPPORTS', note: 'E1 supplies the trace.' }],
      payload: {
        kind: 'BOOLEAN_TRUTH_TABLE',
        variableOrder: ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'],
        satisfyingAssignments: ['1000000000'],
        queryTrueAssignments: ['1000000000'],
        queryFalseAssignments: [],
        classification: 'ENTAILED'
      }
    },
    claims: [{
      id: 'claim-1',
      propositionId: 'p1',
      stance: 'ACCEPT',
      statement: 'The trace reaches option one.',
      evidence: [{ evidenceId: 'E1', relation: 'SUPPORTS', note: 'E1 supplies the trace.' }],
      assumptionIds: [],
      confidence: 0.8
    }],
    assumptions: [],
    requests: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No material issue.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    abstention: null
  };
}

function artifact(
  artifactId: HardPeer80VisibleArtifact['artifactId'],
  artifactKind: HardPeer80VisibleArtifact['artifactKind'],
  actor: HardPeer80VisibleArtifact['actor'],
  output: HardPeer80PublicOutput
): HardPeer80VisibleArtifact {
  return { artifactId, artifactKind, actor, output };
}

function assignment(turnId: HardPeer80TurnId) {
  const plan = buildHardPeer80Plan({
    calibrationCaseIds: ['CAL-1', 'CAL-2', 'CAL-3', 'CAL-4', 'CAL-5'],
    evaluationCaseIds: ['EVAL-M', 'EVAL-L', 'EVAL-H', 'EVAL-D', 'EVAL-T'],
    createdAt: '2026-08-03T00:00:00.000Z'
  });
  const found = plan.assignments.find((item) => item.turnId === turnId && (
    turnId === 'PROBE' || item.caseId === 'EVAL-M'
  ));
  if (!found) throw new Error(`Missing assignment ${turnId}.`);
  return found;
}

function section(prompt: string, heading: string): unknown {
  const lines = prompt.split('\n');
  const index = lines.indexOf(heading);
  if (index < 0) return undefined;
  return JSON.parse(lines[index + 1]!);
}
