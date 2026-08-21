import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  type LabParticipantCase
} from './contracts';
import { stableJson } from './ledger';
import {
  HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
  type HardPeer80ValidationContext,
  type HardPeer80VisibleArtifact
} from './hardPeer80Contracts';
import type { HardPeer80CallAssignment } from './hardPeer80Plan';

export const HARD_PEER_80_PROMPT_VERSION = 'hard-peer-80-public-prompts@v6' as const;

export interface HardPeer80PreparedPrompt {
  prompt: string;
  context: HardPeer80ValidationContext;
}

export const HARD_PEER_80_PROBE_CASE: LabParticipantCase = {
  schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  caseId: 'HARD-PEER-80-BOUNDARY-PROBE',
  question: 'Select the option that follows from E1 and report the matching proposition.',
  evidence: [{ id: 'E1', text: 'The sealed probe value is seven.' }],
  propositions: [{
    id: 'HP80-PROBE-PROP-1',
    topicId: 'probe',
    text: 'The sealed probe value is seven.'
  }],
  options: [{ id: 'O7', text: 'Seven' }, { id: 'O8', text: 'Eight' }],
  topics: [{ id: 'probe', label: 'Boundary probe' }]
};

export function buildHardPeer80Prompt(input: {
  participantCase: LabParticipantCase;
  assignment: HardPeer80CallAssignment;
  visibleArtifacts: readonly HardPeer80VisibleArtifact[];
}): HardPeer80PreparedPrompt {
  const { assignment } = input;
  if (assignment.stage === 'PROBE') {
    if (input.participantCase.caseId !== HARD_PEER_80_PROBE_CASE.caseId) {
      throw new Error('The boundary probe must use the sealed synthetic probe case.');
    }
  } else if (assignment.caseId !== input.participantCase.caseId) {
    throw new Error('HARD-PEER-80 assignment and participant case do not match.');
  }
  const context: HardPeer80ValidationContext = {
    participantCase: structuredClone(input.participantCase),
    stage: assignment.stage,
    currentArtifactId: assignment.turnId,
    visibleArtifacts: structuredClone(input.visibleArtifacts)
  };
  const publicArtifacts = input.visibleArtifacts.map(({ artifactId, artifactKind, output }) => ({
    artifactId,
    artifactKind,
    publicOutput: output
  }));
  const responseTargets = immediateResponseTargets(assignment.stage, input.visibleArtifacts);
  const prompt = [
    `DISCOURSE_PROTOCOL_LAB_PROMPT_VERSION: ${HARD_PEER_80_PROMPT_VERSION}`,
    `PUBLIC_OUTPUT_SCHEMA_VERSION: ${HARD_PEER_80_OUTPUT_SCHEMA_VERSION}`,
    `OUTPUT_STAGE: ${assignment.stage}`,
    '',
    'You are participating in a sealed, text-only hard-task evaluation.',
    'Use only the case and public artifacts below. Do not use tools, files, repositories, browsing, apps, MCP, external retrieval, memories, subagents, or user interaction.',
    'Return exactly one JSON object matching the supplied schema. Do not expose or request private chain-of-thought, scratch work, or hidden reasoning. Provide only concise, auditable public claims and a checkable certificate.',
    '',
    'PUBLIC CONTRACT:',
    '- selectedOptionIds is the authoritative answer. Assess every listed proposition exactly once in claims. OPEN, UNCERTAIN, ABSTAIN, MULTIPLE_DEFENSIBLE, and a blocking user request are valid when justified.',
    '- certificate is a concise checkable result: a proof sketch, counterexample, trace, tradeoff, direct check, missing-information certificate, or NONE. It is not a private reasoning transcript.',
    '- certificate.payload is public, typed, and deterministically checked. For every non-PROBE ANSWER, select one payload kind and include all numeric values, lists, matching edges, truth assignments, worlds, traces, structural crash scenarios, recovery choices, and other fields required by that kind. Record semantics in typed fields; arbitrary record names are only identifiers and are never hidden answer tokens. Do not hide certificate data in prose. Non-answer uncertainty or abstention may use null.',
    '- For BOOLEAN_TRUTH_TABLE, variableOrder declares bit positions. Exhaustively list every premise-satisfying assignment as a ten-bit string (1=true, 0=false), and partition that same complete set into queryTrueAssignments and queryFalseAssignments. Decisive examples alone are not the typed certificate.',
    '- Factual evidence may cite only PROMPT or an evidence id in the case. Every non-OPEN claim and every MATERIAL issue must cite at least one such visible case source. Relation polarity is typed: ACCEPT uses SUPPORTS, REJECT uses CONTRADICTS, OPEN or NOT_APPLICABLE uses LIMITS, ANSWER_SELECTION or CERTIFICATE corrections use SUPPORTS, and an EPISTEMIC_STATE correction uses SUPPORTS only for ANSWER and LIMITS otherwise. A prior answer, issue, critique, response, artifact id, participant, or confidence score is never factual evidence.',
    '- State assumptions and requests explicitly. NEEDS_USER_INPUT requires a blocking USER request. Do not turn missing document, tool, or expert evidence into a user preference.',
    '- Issues are optional and use one typed targetComponent: PROPOSITION, ANSWER_SELECTION, EPISTEMIC_STATE, or CERTIFICATE. A PROPOSITION issue names targetPropositionId and proposedStance; an ANSWER_SELECTION issue supplies the complete proposedOptionIds set; an EPISTEMIC_STATE issue supplies proposedStatus; a CERTIFICATE issue supplies a complete proposedCertificate payload. All fields for other components are null, and targetPropositionId is null except for PROPOSITION. Report only specific evidence-based defects. Agreement, no material issue, uncertainty, rejection, and abstention are valid; never invent criticism to fill the array.',
    '- In a response stage, answer every listed review issue exactly once with ACCEPT, PARTIAL, REJECT, or ABSTAIN. Cite case evidence, list the exact corresponding changedTargets, and preserve an unresolved disagreement with typed targets rather than silently choosing a winner.',
    '- Account for every issue emitted now, plus every listed review issue, exactly once in resolution.resolvedIssueIds or unresolvedIssueIds. ACCEPT and REJECT resolve their target; PARTIAL and ABSTAIN leave it unresolved.',
    '- Confidence is confidence in the public assessment, not rhetorical force. Keep it calibrated and allow low confidence.',
    '',
    stageInstruction(assignment.stage),
    '',
    'CASE:',
    stableJson(input.participantCase),
    '',
    'PUBLIC ARTIFACTS:',
    stableJson(publicArtifacts),
    '',
    'VALID DIRECT-RESPONSE TARGETS:',
    stableJson(responseTargets),
    '',
    'Return only the public JSON object.'
  ].join('\n');
  return { prompt, context };
}

export function buildHardPeer80BoundaryProbePrompt(
  assignment: HardPeer80CallAssignment
): HardPeer80PreparedPrompt {
  if (assignment.conditionId !== 'BOUNDARY_PROBE' || assignment.turnId !== 'PROBE') {
    throw new Error('The supplied assignment is not the HARD-PEER-80 boundary probe.');
  }
  return buildHardPeer80Prompt({
    participantCase: HARD_PEER_80_PROBE_CASE,
    assignment,
    visibleArtifacts: []
  });
}

function stageInstruction(stage: HardPeer80CallAssignment['stage']): string {
  switch (stage) {
    case 'PROBE':
      return 'TASK: Answer the tiny synthetic case. This call checks the exact model/settings/text/schema boundary, not study performance.';
    case 'INITIAL':
      return 'TASK: Produce your strongest first-pass answer. Check the case carefully and report uncertainty or missing information when appropriate.';
    case 'WORKBENCH_1':
      return 'TASK: Continue the work as a general-purpose problem-solving workbench. Recheck the prior A0 answer and improve it if justified. Do not adopt a critic persona and do not manufacture an issue.';
    case 'WORKBENCH_FINAL':
      return 'TASK: Produce the workbench final answer. Directly disposition every issue in W1, if any; retain correct content and preserve unresolved uncertainty.';
    case 'SELF_REVIEW':
      return 'TASK: Actively audit your own A0 answer against the existing case information. Identify a specific material issue only if one exists; a documented no-issue result is valid.';
    case 'SELF_FINAL':
      return 'TASK: Produce the self-review final answer. Directly disposition every issue in S1, if any, and change position only for a stated evidence-based reason.';
    case 'PEER_CRITIQUE':
      return [
        'TASK: As a fresh reviewer, inspect the supplied A0 answer against the case.',
        'You know no oracle, author identity, sibling answer, study outcome, or authority ranking.',
        'Give your own complete public assessment and report only specific material or advisory issues that the existing case information supports. Agreement or no material issue is valid.'
      ].join(' ');
    case 'AUTHOR_RESPONSE':
      return 'TASK: Respond directly to every P1 issue, then give the author final answer. Accept, partially accept, reject, or abstain issue by issue; retain any material unresolved disagreement explicitly.';
  }
}

function immediateResponseTargets(
  stage: HardPeer80CallAssignment['stage'],
  visibleArtifacts: readonly HardPeer80VisibleArtifact[]
): Array<{
  targetArtifactId: string;
  targetIssueId: string;
  targetComponent: HardPeer80VisibleArtifact['output']['issues'][number]['targetComponent'];
  targetPropositionId: string | null;
}> {
  const targetArtifactId =
    stage === 'WORKBENCH_FINAL'
      ? 'W1'
      : stage === 'SELF_FINAL'
        ? 'S1'
        : stage === 'AUTHOR_RESPONSE'
          ? 'P1'
          : null;
  if (!targetArtifactId) return [];
  const artifact = visibleArtifacts.find((candidate) => candidate.artifactId === targetArtifactId);
  if (!artifact) return [];
  return artifact.output.issues.map((issue) => ({
    targetArtifactId,
    targetIssueId: issue.id,
    targetComponent: issue.targetComponent,
    targetPropositionId: issue.targetPropositionId
  }));
}
