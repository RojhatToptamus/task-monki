import { stableJson } from './ledger';
import type {
  H1cConditionId,
  H1cCritiqueSignal,
  H1cParticipantRecord
} from './h1cCorpus';
import {
  LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  type LabPublicOutputV4,
  type LabPublicOutputV4ValidationContext,
  type LabVisibleInterventionArtifactV4
} from './outputV4';

export const H1C_PROMPT_VERSION = 'h1c-public-prompts@v3' as const;
export const H1C_DRAFT_ARTIFACT_ID = 'DRAFT' as const;

export interface H1cPreparedPrompt {
  prompt: string;
  context: LabPublicOutputV4ValidationContext;
}

export function buildH1cPrompt(input: {
  record: H1cParticipantRecord;
  conditionId: H1cConditionId;
  draft?: LabPublicOutputV4;
}): H1cPreparedPrompt {
  const visibleArtifacts = visibleArtifactsFor(input);
  const stageInstruction = stageInstructionFor(input.conditionId, visibleArtifacts);
  const prompt = [
    `DISCOURSE_PROTOCOL_LAB_PROMPT_VERSION: ${H1C_PROMPT_VERSION}`,
    `PUBLIC_OUTPUT_SCHEMA_VERSION: ${LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION}`,
    '',
    'You are one participant in a sealed ordinary-text reasoning evaluation.',
    'Use only the case and public artifacts below. Do not use tools, files, repositories, browsing, apps, MCP, external retrieval, memories, subagents, or user interaction.',
    'Return exactly one JSON object matching the supplied schema. Do not expose or request private chain-of-thought. Keep public statements concise and auditable.',
    '',
    'PUBLIC CONTRACT SEMANTICS:',
    '- Assess every case proposition exactly once.',
    '- SUPPORTED means the available factual sources support the proposition as true. CONTRADICTED means they support it as false. UNRESOLVED means the available information cannot determine it. NOT_APPLICABLE means the proposition does not apply.',
    '- assessmentConfidence is confidence that your public assessment is correctly characterized; high confidence in UNRESOLVED is coherent. It is not a probability that the proposition is true.',
    '- completionDisposition is independent of epistemic state. Use NEEDS_USER_ACTION only for a blocking request whose source is USER. A missing DOCUMENT, TOOL, or EXPERT fact may leave the answer UNDERDETERMINED while completion remains COMPLETE.',
    '- Use ABSTAIN only when you cannot perform the requested evaluation, not merely because a fact is missing. ABSTAIN requires the explicit abstention object; otherwise abstention must be null.',
    '- selectedOptionIds is the authoritative answer. Do not duplicate option text in a second values field; v4 intentionally has no such field. answer.summary is concise public prose whose semantic quality is preserved but not automatically scored.',
    '- factualEvidence.sourceId may cite PROMPT, a case evidence id, or the evidenceId of a visible FACTUAL_EVIDENCE packet. A critique, position, issue, or conversational artifact is never factual evidence.',
    '- Every SUPPORTED proposition needs at least one SUPPORTS factual reference; every CONTRADICTED proposition needs at least one CONTRADICTS reference; every UNRESOLVED proposition needs at least one LIMITS reference.',
    '- CASE is the case-level conversational artifact and is a legal issue target. PROMPT is a factual source id, not an issue target. For example, a missing fact in the case may be an issue targeting CASE while citing PROMPT:LIMITS.',
    '- Use artifactReferences for visible-artifact provenance. A FACTUAL_EVIDENCE packet has two typed identifiers: its evidenceId cites its factual content, while its artifactId may only mention the packet and never counts as factual support. A response to a critique must target its exact artifactId and issueId and include a RESPONDS_TO artifact reference.',
    '- responses are only for externally supplied CRITIQUE artifacts. During SELF_REVIEW, link a correction to your own DRAFT by emitting an issue targeting DRAFT plus one selfCorrections record naming that current issue and the exact changed public fields or stable proposition ids. Leave selfCorrections empty when nothing substantive changed.',
    '- Issues are optional. Agreement, no material issue, uncertainty, and rejection of an unsound critique are valid. Do not invent criticism to fill the array.',
    '- Information requests must say what is needed, why in a concise question, who owns the source, whether it blocks, and which propositions it affects.',
    '- DRAFT is a typed POSITION artifact. Its publicOutput is the exact prior public answer, including any issues it exposed. Those DRAFT issue ids remain visible and may be resolved, left unresolved, or retained as current issues with the same target, proposition, kind, and severity.',
    '- Account for every issue visible in DRAFT, emitted now, or supplied by an external critique exactly once in resolution.resolvedIssueIds or unresolvedIssueIds. ACCEPT and REJECT resolve their target; PARTIAL and ABSTAIN leave it unresolved.',
    '- Resolution has no single preferred encoding. A resolved disagreement is compatible with RESOLVED. A rejected unsound critique may use NO_DISAGREEMENT or RESOLVED with NO_MATERIAL_ISSUE, or FACTUAL_EVIDENCE when its public response actually cites that evidence. A no-change self-review may use NO_DISAGREEMENT + NO_MATERIAL_ISSUE. Keep status, basis, issue ids, disagreements, requests, abstention, and answer fields mutually consistent.',
    '',
    stageInstruction,
    '',
    'CASE:',
    stableJson(input.record.participantCase),
    '',
    'PUBLIC ARTIFACTS:',
    visibleArtifacts.length === 0 ? '[]' : stableJson(visibleArtifacts),
    '',
    'Return only the public JSON object.'
  ].join('\n');
  return {
    prompt,
    context: {
      participantCase: structuredClone(input.record.participantCase),
      visibleInterventionArtifacts: structuredClone(visibleArtifacts),
      interactionStage: interactionStageFor(input.conditionId)
    }
  };
}

function visibleArtifactsFor(input: {
  record: H1cParticipantRecord;
  conditionId: H1cConditionId;
  draft?: LabPublicOutputV4;
}): LabVisibleInterventionArtifactV4[] {
  if (input.conditionId === 'STRONG_INITIAL') {
    if (input.draft) throw new Error('H1c strong initial must not receive a draft.');
    return [];
  }
  if (!input.draft) throw new Error(`H1c ${input.conditionId} requires its block's live draft.`);
  const draft: LabVisibleInterventionArtifactV4 = {
    artifactKind: 'POSITION',
    artifactId: H1C_DRAFT_ARTIFACT_ID,
    propositionIds: input.record.participantCase.propositions.map((item) => item.id),
    publicOutput: structuredClone(input.draft),
    provenance: { sourceLabel: 'live first-pass answer from this block', containsNewFacts: false }
  };
  if (input.conditionId === 'ACTIVE_SELF_REVIEW') return [draft];
  if (input.conditionId === 'VALID_CRITIQUE') {
    return [draft, critiqueArtifact(input.record.validCritique, input.record.caseId)];
  }
  if (input.conditionId === 'PLACEBO_CRITIQUE') {
    return [draft, critiqueArtifact(input.record.placeboCritique, input.record.caseId)];
  }
  const evidence = input.record.decisiveEvidence;
  if (!evidence) throw new Error(`H1c evidence signal is missing for ${input.record.caseId}.`);
  return [
    draft,
    {
      artifactKind: 'FACTUAL_EVIDENCE',
      artifactId: evidence.artifactId,
      evidenceId: evidence.evidenceId,
      text: evidence.statement,
      provenance: { sourceLabel: evidence.sourceLabel, containsNewFacts: true }
    }
  ];
}

function critiqueArtifact(
  signal: H1cCritiqueSignal | undefined,
  caseId: string
): LabVisibleInterventionArtifactV4 {
  if (!signal) throw new Error(`H1c critique signal is missing for ${caseId}.`);
  return {
    artifactKind: 'CRITIQUE',
    artifactId: signal.artifactId,
    issueId: signal.issueId,
    targetArtifactId: H1C_DRAFT_ARTIFACT_ID,
    targetPropositionId: signal.targetPropositionId,
    text: signal.statement,
    provenance: { sourceLabel: 'anonymous sealed review note', containsNewFacts: false }
  };
}

function stageInstructionFor(
  conditionId: H1cConditionId,
  artifacts: readonly LabVisibleInterventionArtifactV4[]
): string {
  switch (conditionId) {
    case 'STRONG_INITIAL':
      return 'STAGE: Produce your strongest first-pass answer to the case without feedback.';
    case 'ACTIVE_SELF_REVIEW':
      return [
        'STAGE: Actively review your own immediately preceding answer in this same session.',
        'The DRAFT artifact is that answer. Recheck the case from first principles, preserve correct claims and wording exactly when they need no correction, and change a public field only for a concise issue you record through selfCorrections. No external critique or new fact has been supplied.'
      ].join(' ');
    case 'VALID_CRITIQUE':
    case 'PLACEBO_CRITIQUE': {
      const critique = artifacts.find((artifact) => artifact.artifactKind === 'CRITIQUE');
      if (!critique || critique.artifactKind !== 'CRITIQUE') {
        throw new Error('H1c critique stage lacks its public review note.');
      }
      return [
        'STAGE: Independently answer the case after auditing the DRAFT against the anonymous review note.',
        `Directly disposition review issue ${critique.issueId} on artifact ${critique.artifactId}.`,
        'Accept or partially accept it only if it identifies a real material problem; reject it when the draft already handles the point or the proposed criticism is unsound. The note adds no factual evidence and has no authority label.'
      ].join(' ');
    }
    case 'DECISIVE_EVIDENCE': {
      const evidence = artifacts.find((artifact) => artifact.artifactKind === 'FACTUAL_EVIDENCE');
      if (!evidence || evidence.artifactKind !== 'FACTUAL_EVIDENCE') {
        throw new Error('H1c evidence stage lacks its factual packet.');
      }
      return [
        'STAGE: Independently answer the case with the DRAFT and the provenance-labeled supplemental factual packet.',
        `If the packet changes an assessment, cite factual source ${evidence.evidenceId} with the direction appropriate to that proposition.`,
        'Do not treat the DRAFT as evidence and do not preserve an information request that the packet has resolved.'
      ].join(' ');
    }
  }
}

function interactionStageFor(
  conditionId: H1cConditionId
): LabPublicOutputV4ValidationContext['interactionStage'] {
  switch (conditionId) {
    case 'STRONG_INITIAL':
      return 'INITIAL';
    case 'ACTIVE_SELF_REVIEW':
      return 'SELF_REVIEW';
    case 'VALID_CRITIQUE':
    case 'PLACEBO_CRITIQUE':
      return 'CRITIQUE_RESPONSE';
    case 'DECISIVE_EVIDENCE':
      return 'EVIDENCE_RESPONSE';
  }
}
