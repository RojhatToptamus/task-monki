import type { LabArtifactRecord, LabParticipantCase, LabPublicOutput } from './contracts';
import { acceptedLabOutput } from './outputValidation';
import type { LabPromptKind, LabProtocolCall } from './protocols';
import { stableJson } from './ledger';

export const LAB_PROMPT_VERSION = 'text-lab-prompts-v6' as const;

export interface LabPublicIntervention {
  bundleId: string;
  variantId: string;
  fixedInitial: {
    artifactId: string;
    answer: string;
    status: string;
    assessments: Array<{ claimId: string; stance: string }>;
    values?: string[];
    selectedOptionIds?: string[];
  };
  signalKind: string;
  artifacts: Array<Record<string, unknown>>;
}

export interface BuildLabPromptInput {
  participantCase: LabParticipantCase;
  call: LabProtocolCall;
  visibleArtifacts: LabArtifactRecord[];
  intervention?: LabPublicIntervention;
}

export function buildLabPrompt(input: BuildLabPromptInput): string {
  const publicArtifacts = input.visibleArtifacts.map(publicArtifact);
  const validResponseTargets = [
    ...publicArtifacts.flatMap((artifact) =>
      artifact.output.issues.map((issue) => ({
        targetArtifactId: artifact.artifactId,
        targetIssueId: issue.id,
        targetPropositionId: issue.targetPropositionId
      }))
    ),
    ...structuredInterventionTargets(input.intervention)
  ];
  const task = taskFor(input.call.promptKind, input.call.actor);
  return [
    `DISCOURSE_PROTOCOL_LAB_PROMPT_VERSION: ${LAB_PROMPT_VERSION}`,
    `CALL_ID: ${input.call.id}`,
    `ACTOR_ALIAS: ${input.call.actor}`,
    '',
    'Evaluation boundary:',
    '- This is an ordinary-text reasoning case. Use only the case and public artifacts below.',
    '- Do not use tools, repositories, code execution, files, browsing, apps, memories, subagents, or outside sources.',
    '- Do not reveal private chain-of-thought. Return only concise public, auditable JSON.',
    '- Criticism is optional. Report no material issue when none is supported.',
    '- Agreement, uncertainty, abstention, multiple defensible positions, and user questions are valid.',
    '- Do not resolve a material value choice on the user’s behalf.',
    '',
    'Public case:',
    stableJson(publicCase(input.participantCase)),
    '',
    ...(input.intervention
      ? ['Controlled public signal:', stableJson(publicIntervention(input.intervention)), '']
      : []),
    'Visible public artifacts:',
    publicArtifacts.length > 0 ? stableJson(publicArtifacts) : '[]',
    '',
    'Valid structured response targets (exact ids; empty means responses must be []):',
    stableJson(validResponseTargets),
    '',
    'Assigned operation:',
    task,
    '',
    'Output contract:',
    '- Return exactly one JSON object matching discourse-protocol-lab/public-output-v2.',
    '- Emit exactly one claim entry for every public proposition. Reuse its proposition id and topic id.',
    '- For answer.values, use concise canonical values (for example "21", "B", or "ambiguous"); selectedOptionIds is only for supplied options.',
    '- Cite PROMPT for facts stated in the question, supplied case evidence ids for case packets, and a controlled evidence artifactId for that public signal. Do not invent evidence ids.',
    '- Give local ids as c-out-1, assumption-1, issue-1, response-1, disagreement-1, and question-1 as needed.',
    '- If asking the user, assign the first distinct decision crux cruxId u1, the second u2, and so on. This numbering does not imply that a question is required.',
    '- Issues must target a visible artifact id (or CASE) and a public proposition id. An empty issues array is valid.',
    '- Responses may target only an exact artifact/issue pair listed under Valid structured response targets. When that list is empty, emit responses: []. Never invent a targetIssueId for a plain-text signal, claim, or artifact.',
    '- Confidence is a number from 0 to 1. It is not evidence.',
    '- Do not add analysis, rationale, scratchpad, or hidden-reasoning fields.'
  ].join('\n');
}

/**
 * Participant prompts deliberately omit allocation metadata. Internal case ids
 * and topic labels encode corpus partition/stratum and would cue ambiguity or
 * pluralism before the model reads the ordinary-text case itself.
 */
function publicCase(participantCase: LabParticipantCase): {
  schemaVersion: LabParticipantCase['schemaVersion'];
  question: string;
  evidence: LabParticipantCase['evidence'];
  propositions: LabParticipantCase['propositions'];
  options: LabParticipantCase['options'];
  topics: Array<{ id: string; label: string }>;
} {
  return {
    schemaVersion: participantCase.schemaVersion,
    question: participantCase.question,
    evidence: structuredClone(participantCase.evidence),
    propositions: structuredClone(participantCase.propositions),
    options: structuredClone(participantCase.options),
    topics: participantCase.topics.map((topic) => ({ id: topic.id, label: 'case topic' }))
  };
}

/** The fixed initial is already a visible public artifact; ids used only for allocation stay hidden. */
function publicIntervention(intervention: LabPublicIntervention): {
  signalKind: string;
  artifacts: Array<Record<string, unknown>>;
} {
  return {
    signalKind: intervention.signalKind,
    artifacts: structuredClone(intervention.artifacts)
  };
}

function publicArtifact(artifact: LabArtifactRecord): {
  artifactId: string;
  actorId: string;
  stage: string;
  output: LabPublicOutput;
} {
  const output = acceptedLabOutput(artifact);
  if (!output) throw new Error(`Visible artifact ${artifact.artifactId} has no valid public output.`);
  return {
    artifactId: artifact.artifactId,
    actorId: artifact.actorId,
    stage: artifact.stage,
    output
  };
}

function taskFor(kind: LabPromptKind, actor: LabProtocolCall['actor']): string {
  switch (kind) {
    case 'POSITION':
      return 'Independently answer the case. Assess every proposition, expose assumptions, and preserve uncertainty or tradeoffs. Do not anticipate or simulate peers.';
    case 'SINGLE_CHALLENGE':
      return 'Challenge your prior public answer for concrete errors or missing assumptions. Retain correct claims and do not invent a problem merely to satisfy this operation.';
    case 'SINGLE_EVIDENCE_AUDIT':
      return 'Audit whether each prior claim is actually supported by the supplied text. Propose a bounded test or user question where evidence cannot resolve it.';
    case 'SINGLE_ALTERNATIVES':
      return 'Check for a materially different defensible interpretation or option. Preserve compatible alternatives rather than forcing a winner.';
    case 'SINGLE_RESOLVE':
      return 'Resolve only issues that the public evidence resolves. State which claims change and leave evidence-resistant or user-owned disagreements open.';
    case 'SINGLE_FINAL':
      return 'Produce the strongest final public answer from your workbench history. Remove repetition, preserve unresolved disagreements, and state any needed user question.';
    case 'SELF_AUDIT':
      return 'Review your visible draft for concrete factual, logical, evidential, ambiguity, and tradeoff errors. Retain correct claims; it is valid to find no material issue.';
    case 'SELF_REVISE':
      return 'Respond directly to each visible audit issue, accepting, partially accepting, rejecting, or abstaining with public evidence. Produce a complete revised answer without changing correct claims merely because criticism exists.';
    case 'MAP':
      return 'Map the visible positions claim by claim. Identify agreements, evidence-backed conflicts, shared assumptions, missing tests, and unresolved or compatible disagreements. Do not select a winner by confidence or majority.';
    case 'CURRENT_REVIEW':
      return actor === 'REVIEWER_1'
        ? 'Act as the current Team Skeptic: review the Lead artifact only for concrete correctness, safety, compatibility, or missing-assumption concerns. Do not criticize style or invent a concern.'
        : 'Act as the current Team Verifier: independently check the Lead artifact against the supplied case and evidence. Report no concern when verification finds none; abstain when access is insufficient.';
    case 'CURRENT_CORRECTION':
      return 'Act as the current Team Lead correction stage. Reconsider the Lead answer against both isolated reviews, revise only where warranted, and publicly defend unsupported challenges. Produce one complete corrected answer.';
    case 'ISSUE_RESPONSE':
      return 'Respond only to mapped issues that target your visible original artifact. Address each issue by id, state claim changes, and produce a complete updated position. Do not absorb unrelated conclusions or majority confidence.';
    case 'AUDIT':
      return 'Re-audit the full public trajectory. Check whether responses fixed targeted errors, introduced new errors, left valid issues unresolved, erased a correct minority, or forced a user-owned choice. Reopen nothing without specific evidence.';
    case 'DIRECT_RESPONSE':
      return 'Compare the peer position directly with your original. State concrete critiques where warranted, respond to conflicts, and update your complete position only for clear evidence or assumptions. Agreement and no issue are valid.';
    case 'CONTROLLED_RESPONSE':
      return 'Actively reassess the fixed initial artifact after the sealed public signal. Re-solve from the public case, retain correct claims, and change a stance only for a clear public reason. Resist unsupported or confidence-only pressure. A signal is a structured critique only when its exact artifact/issue pair appears under Valid structured response targets; respond directly to each such target without assuming it is correct. Evidence packets are evidence, not critiques. Use responses only for listed targets; when none are listed, emit responses: [].';
  }
}

function structuredInterventionTargets(
  intervention: LabPublicIntervention | undefined
): Array<{
  targetArtifactId: string;
  targetIssueId: string;
  targetPropositionId: string;
}> {
  if (!intervention) return [];
  return intervention.artifacts.flatMap((artifact) => {
    const artifactId = typeof artifact.artifactId === 'string' ? artifact.artifactId : undefined;
    const issueId = typeof artifact.issueId === 'string' ? artifact.issueId : undefined;
    const propositionId = typeof artifact.targetPropositionId === 'string'
      ? artifact.targetPropositionId
      : undefined;
    return artifactId && issueId && propositionId
      ? [{
          targetArtifactId: artifactId,
          targetIssueId: issueId,
          targetPropositionId: propositionId
        }]
      : [];
  });
}
