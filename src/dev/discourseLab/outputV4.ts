import type { LabValidationError } from './contracts';
import {
  LAB_PUBLIC_OUTPUT_V3_JSON_SCHEMA,
  LAB_PUBLIC_OUTPUT_V3_SCHEMA_VERSION,
  LAB_VISIBLE_INTERVENTION_ARTIFACT_V3_JSON_SCHEMA,
  validateJsonSchema,
  validateLabPublicOutputV3CrossFields,
  type LabOutputRecordV3,
  type LabPublicOutputV3,
  type LabRawOutputAttemptV3,
  type LabValidationResultV3,
  type LabVisibleInterventionArtifactV3
} from './outputV3';

export const LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION =
  'discourse-protocol-lab/public-output-v4' as const;

export type LabSelfCorrectionFieldV4 =
  | 'ANSWER_SUMMARY'
  | 'SELECTED_OPTION_IDS'
  | 'EPISTEMIC_STATE'
  | 'COMPLETION_DISPOSITION'
  | 'PROPOSITION_ASSESSMENTS'
  | 'INFORMATION_REQUESTS';

export interface LabPublicSelfCorrectionV4 {
  id: string;
  targetArtifactId: string;
  targetIssueId: string;
  disposition: 'CORRECTED';
  statement: string;
  changedPublicFields: LabSelfCorrectionFieldV4[];
  changedPropositionIds: string[];
}

export interface LabPublicOutputV4 extends Omit<LabPublicOutputV3, 'schemaVersion' | 'answer'> {
  schemaVersion: typeof LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION;
  answer: Omit<LabPublicOutputV3['answer'], 'values'>;
  selfCorrections: LabPublicSelfCorrectionV4[];
}

export type LabInteractionStageV4 =
  | 'INITIAL'
  | 'SELF_REVIEW'
  | 'CRITIQUE_RESPONSE'
  | 'EVIDENCE_RESPONSE';

type LabCritiqueArtifactV4 = Extract<
  LabVisibleInterventionArtifactV3,
  { artifactKind: 'CRITIQUE' }
>;
type LabFactualEvidenceArtifactV4 = Extract<
  LabVisibleInterventionArtifactV3,
  { artifactKind: 'FACTUAL_EVIDENCE' }
>;

export type LabVisibleInterventionArtifactV4 =
  | LabCritiqueArtifactV4
  | LabFactualEvidenceArtifactV4
  | {
      artifactKind: 'POSITION';
      artifactId: string;
      propositionIds: string[];
      /** The sole typed source of truth for the visible prior position. */
      publicOutput: LabPublicOutputV4;
      provenance: { sourceLabel: string; containsNewFacts: false };
    };

export interface LabPublicOutputV4ValidationContext {
  participantCase: import('./contracts').LabParticipantCase;
  visibleInterventionArtifacts: readonly LabVisibleInterventionArtifactV4[];
  interactionStage: LabInteractionStageV4;
}

export interface LabRawOutputAttemptV4
  extends Omit<LabRawOutputAttemptV3, 'output'> {
  output?: LabPublicOutputV4;
}

export interface LabOutputRecordV4 extends Omit<LabOutputRecordV3, 'attempts'> {
  attempts: LabRawOutputAttemptV4[];
}

type JsonSchema = Record<string, unknown>;

const ID_SCHEMA = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$',
  minLength: 1,
  maxLength: 120
} as const;

const SELF_CORRECTION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'targetArtifactId',
    'targetIssueId',
    'disposition',
    'statement',
    'changedPublicFields',
    'changedPropositionIds'
  ],
  properties: {
    id: ID_SCHEMA,
    targetArtifactId: ID_SCHEMA,
    targetIssueId: ID_SCHEMA,
    disposition: { type: 'string', const: 'CORRECTED' },
    statement: { type: 'string', minLength: 1, maxLength: 600 },
    changedPublicFields: {
      type: 'array',
      minItems: 0,
      maxItems: 6,
      items: {
        type: 'string',
        enum: [
          'ANSWER_SUMMARY',
          'SELECTED_OPTION_IDS',
          'EPISTEMIC_STATE',
          'COMPLETION_DISPOSITION',
          'PROPOSITION_ASSESSMENTS',
          'INFORMATION_REQUESTS'
        ]
      }
    },
    changedPropositionIds: {
      type: 'array',
      minItems: 0,
      maxItems: 64,
      items: ID_SCHEMA
    }
  }
};

/**
 * v4 preserves v3's closed public shape, removes the redundant answer.values
 * copy, and adds an explicit same-draft correction record. The clone leaves
 * the frozen v3 schema byte-for-byte and behaviorally unchanged.
 */
export const LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA: JsonSchema = buildV4Schema();

/** Harness-facing typed POSITION shape. This is not part of the provider schema. */
export const LAB_POSITION_ARTIFACT_V4_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['artifactKind', 'artifactId', 'propositionIds', 'publicOutput', 'provenance'],
  properties: {
    artifactKind: { type: 'string', const: 'POSITION' },
    artifactId: ID_SCHEMA,
    propositionIds: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: ID_SCHEMA
    },
    publicOutput: LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA,
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceLabel', 'containsNewFacts'],
      properties: {
        sourceLabel: { type: 'string', minLength: 1, maxLength: 600 },
        containsNewFacts: { type: 'boolean', const: false }
      }
    }
  }
};

export function validateLabPublicOutputV4Shape(
  value: unknown
): LabValidationResultV3<LabPublicOutputV4> {
  const errors: LabValidationError[] = [];
  validateJsonSchema(value, LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA, '$', errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as LabPublicOutputV4 };
}

export function validateLabPublicOutputV4CrossFields(
  output: LabPublicOutputV4
): LabValidationError[] {
  // Directional support is an explicitly prompted, scoreable semantic rule in
  // v4. A parseable omission remains an observation rather than missing data,
  // while evidence identity is the typed source+direction pair.
  const errors = validateLabPublicOutputV3CrossFields(asV3(output), {
    requireDirectionalEvidence: false,
    factualEvidenceIdentity: 'SOURCE_ID_AND_RELATION'
  });
  const correctionIds = new Set<string>();
  const correctionTargets = new Set<string>();
  for (const [index, correction] of output.selfCorrections.entries()) {
    if (correctionIds.has(correction.id)) {
      addError(
        errors,
        `$.selfCorrections[${index}].id`,
        'DUPLICATE_ID',
        `Duplicate self-correction id ${correction.id}.`
      );
    }
    correctionIds.add(correction.id);
    if (correctionTargets.has(correction.targetIssueId)) {
      addError(
        errors,
        `$.selfCorrections[${index}].targetIssueId`,
        'DUPLICATE_ID',
        'A self-found issue may have only one correction record.'
      );
    }
    correctionTargets.add(correction.targetIssueId);
    requireUniqueStrings(
      correction.changedPublicFields,
      `$.selfCorrections[${index}].changedPublicFields`,
      errors
    );
    requireUniqueStrings(
      correction.changedPropositionIds,
      `$.selfCorrections[${index}].changedPropositionIds`,
      errors
    );
  }
  return errors;
}

export function validateLabPublicOutputV4Context(
  output: LabPublicOutputV4,
  context: LabPublicOutputV4ValidationContext
): LabValidationError[] {
  const errors = validateLabPublicOutputV4ContextDefinition(context);
  if (errors.length > 0) return errors;

  const registry = buildContextRegistry(context);
  validateCurrentOutputReferences(output, context, registry, errors);

  if (context.interactionStage !== 'SELF_REVIEW' && output.selfCorrections.length > 0) {
    addContextError(
      errors,
      '$.selfCorrections',
      'INVALID_VALUE',
      'v4.self-correction.stage',
      'CROSS_FIELD',
      'OUTPUT_INVALID',
      'Self-correction records are permitted only during SELF_REVIEW.'
    );
    return errors;
  }
  if (context.interactionStage !== 'SELF_REVIEW') return errors;

  const draft = registry.position!;
  const issueById = new Map(output.issues.map((issue) => [issue.id, issue]));
  for (const [index, correction] of output.selfCorrections.entries()) {
    const issue = issueById.get(correction.targetIssueId);
    if (correction.targetArtifactId !== draft.artifactId) {
      addContextError(
        errors,
        `$.selfCorrections[${index}].targetArtifactId`,
        'INVALID_REFERENCE',
        'v4.self-correction.target-position',
        'ISSUE_LIFECYCLE',
        'OUTPUT_INVALID',
        `A self-correction must target the visible draft ${draft.artifactId}.`
      );
    }
    if (!issue) {
      addContextError(
        errors,
        `$.selfCorrections[${index}].targetIssueId`,
        'INVALID_REFERENCE',
        'v4.self-correction.current-issue',
        'ISSUE_LIFECYCLE',
        'OUTPUT_INVALID',
        'A self-correction must target an issue emitted in the same output.'
      );
    } else if (issue.targetArtifactId !== correction.targetArtifactId) {
      addContextError(
        errors,
        `$.selfCorrections[${index}].targetIssueId`,
        'INVALID_REFERENCE',
        'v4.self-correction.issue-target',
        'ISSUE_LIFECYCLE',
        'OUTPUT_INVALID',
        'The self-found issue and correction must target the same draft artifact.'
      );
    }
  }
  return errors;
}

/**
 * Validates only harness-owned context. Any failure here makes the measurement
 * unavailable; it is never inferred from provider wording or an output path.
 */
export function validateLabPublicOutputV4ContextDefinition(
  context: LabPublicOutputV4ValidationContext
): LabValidationError[] {
  const errors: LabValidationError[] = [];
  const positions = context.visibleInterventionArtifacts.filter(
    (artifact) => artifact.artifactKind === 'POSITION'
  );
  const expectedPositions = context.interactionStage === 'INITIAL' ? 0 : 1;
  if (positions.length !== expectedPositions) {
    addContextError(
      errors,
      '$.context.visibleInterventionArtifacts',
      'INVALID_VALUE',
      'v4.context.position-cardinality',
      'CONTEXT_INTEGRITY',
      'MEASUREMENT_UNAVAILABLE',
      context.interactionStage === 'INITIAL'
        ? 'INITIAL must not expose a POSITION artifact.'
        : `${context.interactionStage} requires exactly one typed POSITION artifact.`
    );
  }

  const propositionIds = new Set(
    context.participantCase.propositions.map((proposition) => proposition.id)
  );
  const factualSourceIds = new Set([
    'PROMPT',
    ...context.participantCase.evidence.map((evidence) => evidence.id)
  ]);
  const artifactIds = new Set<string>(['CASE']);
  const issueIds = new Set<string>();

  context.visibleInterventionArtifacts.forEach((artifact, index) => {
    const path = `$.context.visibleInterventionArtifacts[${index}]`;
    const shapeErrors: LabValidationError[] = [];
    validateJsonSchema(
      artifact,
      artifact.artifactKind === 'POSITION'
        ? LAB_POSITION_ARTIFACT_V4_JSON_SCHEMA
        : LAB_VISIBLE_INTERVENTION_ARTIFACT_V3_JSON_SCHEMA,
      path,
      shapeErrors
    );
    errors.push(...shapeErrors.map((error) => unavailableContextError(
      error,
      'v4.context.artifact-shape'
    )));
    if (shapeErrors.length > 0) return;

    if (artifactIds.has(artifact.artifactId)) {
      addContextError(
        errors,
        `${path}.artifactId`,
        'DUPLICATE_ID',
        'v4.context.artifact-id-unique',
        'CONTEXT_INTEGRITY',
        'MEASUREMENT_UNAVAILABLE',
        `Duplicate visible artifact id ${artifact.artifactId}.`
      );
    }
    artifactIds.add(artifact.artifactId);

    if (artifact.artifactKind === 'FACTUAL_EVIDENCE') {
      if (factualSourceIds.has(artifact.evidenceId)) {
        addContextError(
          errors,
          `${path}.evidenceId`,
          'DUPLICATE_ID',
          'v4.context.factual-id-unique',
          'CONTEXT_INTEGRITY',
          'MEASUREMENT_UNAVAILABLE',
          `Duplicate factual evidence id ${artifact.evidenceId}.`
        );
      }
      factualSourceIds.add(artifact.evidenceId);
      return;
    }
    if (artifact.artifactKind === 'CRITIQUE') {
      if (!propositionIds.has(artifact.targetPropositionId)) {
        addContextError(
          errors,
          `${path}.targetPropositionId`,
          'INVALID_REFERENCE',
          'v4.context.critique-proposition',
          'CONTEXT_INTEGRITY',
          'MEASUREMENT_UNAVAILABLE',
          `Unknown case proposition id ${artifact.targetPropositionId}.`
        );
      }
      if (issueIds.has(artifact.issueId)) {
        addContextError(
          errors,
          `${path}.issueId`,
          'DUPLICATE_ID',
          'v4.context.visible-issue-unique',
          'CONTEXT_INTEGRITY',
          'MEASUREMENT_UNAVAILABLE',
          `Duplicate visible issue id ${artifact.issueId}.`
        );
      }
      issueIds.add(artifact.issueId);
      return;
    }

    requireContextSetEquality(
      artifact.propositionIds,
      propositionIds,
      `${path}.propositionIds`,
      'v4.context.position-case-propositions',
      errors
    );
    const assessmentIds = new Set(
      artifact.publicOutput.propositionAssessments.map((assessment) => assessment.propositionId)
    );
    requireContextSetEquality(
      artifact.propositionIds,
      assessmentIds,
      `${path}.propositionIds`,
      'v4.context.position-output-propositions',
      errors
    );
    const draftValidation = validateLabPublicOutputV4(artifact.publicOutput, {
      participantCase: context.participantCase,
      visibleInterventionArtifacts: [],
      interactionStage: 'INITIAL'
    });
    if (!draftValidation.ok) {
      draftValidation.errors.forEach((error) => {
        errors.push(unavailableContextError({
          ...error,
          path: `${path}.publicOutput${error.path.slice(1)}`
        }, 'v4.context.position-public-output'));
      });
    }
    artifact.publicOutput.issues.forEach((issue, issueIndex) => {
      if (issueIds.has(issue.id)) {
        addContextError(
          errors,
          `${path}.publicOutput.issues[${issueIndex}].id`,
          'DUPLICATE_ID',
          'v4.context.visible-issue-unique',
          'CONTEXT_INTEGRITY',
          'MEASUREMENT_UNAVAILABLE',
          `Duplicate visible issue id ${issue.id}.`
        );
      }
      issueIds.add(issue.id);
    });
  });

  context.visibleInterventionArtifacts.forEach((artifact, index) => {
    if (artifact.artifactKind !== 'CRITIQUE') return;
    const path = `$.context.visibleInterventionArtifacts[${index}].targetArtifactId`;
    if (!artifactIds.has(artifact.targetArtifactId) || artifact.targetArtifactId === artifact.artifactId) {
      addContextError(
        errors,
        path,
        'INVALID_REFERENCE',
        'v4.context.critique-target',
        'CONTEXT_INTEGRITY',
        'MEASUREMENT_UNAVAILABLE',
        'A critique must target another visible conversational artifact.'
      );
    }
  });

  for (const artifact of context.visibleInterventionArtifacts) {
    for (const id of [artifact.artifactId]) {
      if (factualSourceIds.has(id)) {
        addContextError(
          errors,
          '$.context.visibleInterventionArtifacts',
          'DUPLICATE_ID',
          'v4.context.namespace-separation',
          'CONTEXT_INTEGRITY',
          'MEASUREMENT_UNAVAILABLE',
          `Conversational id ${id} collides with a factual evidence id.`
        );
      }
    }
  }
  for (const id of issueIds) {
    if (factualSourceIds.has(id)) {
      addContextError(
        errors,
        '$.context.visibleInterventionArtifacts',
        'DUPLICATE_ID',
        'v4.context.namespace-separation',
        'CONTEXT_INTEGRITY',
        'MEASUREMENT_UNAVAILABLE',
        `Conversational issue id ${id} collides with a factual evidence id.`
      );
    }
  }
  return errors;
}

interface LabContextRegistryV4 {
  position?: Extract<LabVisibleInterventionArtifactV4, { artifactKind: 'POSITION' }>;
  artifactIds: Set<string>;
  factualSourceIds: Set<string>;
  critiqueIssueByArtifactId: Map<string, string>;
  critiqueIssueIds: Set<string>;
  draftIssueById: Map<string, LabPublicOutputV4['issues'][number]>;
}

/** Issue ids visible to a responder, independent of condition and oracle labels. */
export function visibleIssueIdsFromLabContextV4(
  context: LabPublicOutputV4ValidationContext
): string[] {
  const issueIds = new Set<string>();
  for (const artifact of context.visibleInterventionArtifacts) {
    if (artifact.artifactKind === 'CRITIQUE') issueIds.add(artifact.issueId);
    if (artifact.artifactKind === 'POSITION') {
      artifact.publicOutput.issues.forEach((issue) => issueIds.add(issue.id));
    }
  }
  return [...issueIds].sort();
}

function buildContextRegistry(
  context: LabPublicOutputV4ValidationContext
): LabContextRegistryV4 {
  const registry: LabContextRegistryV4 = {
    artifactIds: new Set(['CASE']),
    factualSourceIds: new Set([
      'PROMPT',
      ...context.participantCase.evidence.map((evidence) => evidence.id)
    ]),
    critiqueIssueByArtifactId: new Map(),
    critiqueIssueIds: new Set(),
    draftIssueById: new Map()
  };
  for (const artifact of context.visibleInterventionArtifacts) {
    registry.artifactIds.add(artifact.artifactId);
    if (artifact.artifactKind === 'FACTUAL_EVIDENCE') {
      registry.factualSourceIds.add(artifact.evidenceId);
    } else if (artifact.artifactKind === 'CRITIQUE') {
      registry.critiqueIssueByArtifactId.set(artifact.artifactId, artifact.issueId);
      registry.critiqueIssueIds.add(artifact.issueId);
    } else {
      registry.position = artifact;
      for (const issue of artifact.publicOutput.issues) {
        registry.draftIssueById.set(issue.id, issue);
      }
    }
  }
  return registry;
}

function validateCurrentOutputReferences(
  output: LabPublicOutputV4,
  context: LabPublicOutputV4ValidationContext,
  registry: LabContextRegistryV4,
  errors: LabValidationError[]
): void {
  const propositions = new Map(
    context.participantCase.propositions.map((proposition) => [proposition.id, proposition])
  );
  const propositionIds = new Set(propositions.keys());
  const topicIds = new Set(context.participantCase.topics.map((topic) => topic.id));
  const optionIds = new Set(context.participantCase.options.map((option) => option.id));

  output.answer.selectedOptionIds.forEach((id, index) => {
    requireOutputReference(
      id,
      optionIds,
      `$.answer.selectedOptionIds[${index}]`,
      'v4.case.option-reference',
      'CASE_REFERENCE',
      'case option',
      errors
    );
  });

  const emittedPropositionIds = new Set<string>();
  output.propositionAssessments.forEach((assessment, index) => {
    const path = `$.propositionAssessments[${index}]`;
    const proposition = propositions.get(assessment.propositionId);
    if (!proposition) {
      addContextError(
        errors,
        `${path}.propositionId`,
        'INVALID_REFERENCE',
        'v4.case.proposition-reference',
        'CASE_REFERENCE',
        'OUTPUT_INVALID',
        `Unknown case proposition id ${assessment.propositionId}.`
      );
    } else {
      if (emittedPropositionIds.has(assessment.propositionId)) {
        addContextError(
          errors,
          `${path}.propositionId`,
          'DUPLICATE_ID',
          'v4.case.proposition-exactly-once',
          'CASE_REFERENCE',
          'OUTPUT_INVALID',
          `Case proposition ${assessment.propositionId} must be assessed exactly once.`
        );
      }
      emittedPropositionIds.add(assessment.propositionId);
      if (assessment.topicId !== proposition.topicId) {
        addContextError(
          errors,
          `${path}.topicId`,
          'INVALID_REFERENCE',
          'v4.case.proposition-topic-owner',
          'CASE_REFERENCE',
          'OUTPUT_INVALID',
          `Topic ${assessment.topicId} does not own proposition ${assessment.propositionId}.`
        );
      }
    }
    requireOutputReference(
      assessment.topicId,
      topicIds,
      `${path}.topicId`,
      'v4.case.topic-reference',
      'CASE_REFERENCE',
      'case topic',
      errors
    );
    validateCurrentVisibleReferences(
      assessment.factualEvidence,
      assessment.artifactReferences,
      path,
      registry,
      errors
    );
  });
  propositions.forEach((_proposition, id) => {
    if (!emittedPropositionIds.has(id)) {
      addContextError(
        errors,
        '$.propositionAssessments',
        'MISSING_FIELD',
        'v4.case.proposition-exactly-once',
        'CASE_REFERENCE',
        'OUTPUT_INVALID',
        `Missing the required assessment for case proposition ${id}.`
      );
    }
  });

  output.issues.forEach((issue, index) => {
    const path = `$.issues[${index}]`;
    requireOutputReference(
      issue.targetArtifactId,
      registry.artifactIds,
      `${path}.targetArtifactId`,
      'v4.issue.target-artifact',
      'CONVERSATIONAL_PROVENANCE',
      'visible artifact',
      errors
    );
    requireOutputReference(
      issue.targetPropositionId,
      propositionIds,
      `${path}.targetPropositionId`,
      'v4.issue.target-proposition',
      'CASE_REFERENCE',
      'case proposition',
      errors
    );
    validateCurrentVisibleReferences(
      issue.factualEvidence,
      issue.artifactReferences,
      path,
      registry,
      errors
    );
    if (registry.critiqueIssueIds.has(issue.id)) {
      addContextError(
        errors,
        `${path}.id`,
        'DUPLICATE_ID',
        'v4.issue.no-critique-shadow',
        'ISSUE_LIFECYCLE',
        'OUTPUT_INVALID',
        `Current issue id ${issue.id} shadows a visible critique issue.`
      );
    }
    const draftIssue = registry.draftIssueById.get(issue.id);
    if (draftIssue && !sameStableIssueIdentity(issue, draftIssue)) {
      addContextError(
        errors,
        `${path}.id`,
        'INVALID_REFERENCE',
        'v4.issue.draft-identity-retention',
        'ISSUE_LIFECYCLE',
        'OUTPUT_INVALID',
        `Retained draft issue ${issue.id} changed a stable identity field.`
      );
    }
  });

  output.responses.forEach((response, index) => {
    const path = `$.responses[${index}]`;
    const expectedIssueId = registry.critiqueIssueByArtifactId.get(response.targetArtifactId);
    if (!expectedIssueId) {
      addContextError(
        errors,
        `${path}.targetArtifactId`,
        'INVALID_REFERENCE',
        'v4.response.critique-target',
        'RESPONSE_PROVENANCE',
        'OUTPUT_INVALID',
        `${response.targetArtifactId} is not a visible CRITIQUE artifact.`
      );
    } else if (expectedIssueId !== response.targetIssueId) {
      addContextError(
        errors,
        `${path}.targetIssueId`,
        'INVALID_REFERENCE',
        'v4.response.exact-issue',
        'RESPONSE_PROVENANCE',
        'OUTPUT_INVALID',
        `Issue ${response.targetIssueId} does not belong to critique ${response.targetArtifactId}.`
      );
    }
    if (!response.artifactReferences.some(
      (reference) => reference.artifactId === response.targetArtifactId &&
        reference.relation === 'RESPONDS_TO'
    )) {
      addContextError(
        errors,
        `${path}.artifactReferences`,
        'MISSING_FIELD',
        'v4.response.responds-to-required',
        'RESPONSE_PROVENANCE',
        'OUTPUT_INVALID',
        'A response must carry RESPONDS_TO provenance for its target critique.'
      );
    }
    response.artifactReferences.forEach((reference, referenceIndex) => {
      if (
        reference.relation === 'RESPONDS_TO' &&
        reference.artifactId !== response.targetArtifactId
      ) {
        addContextError(
          errors,
          `${path}.artifactReferences[${referenceIndex}].artifactId`,
          'INVALID_REFERENCE',
          'v4.response.responds-to-exact-target',
          'RESPONSE_PROVENANCE',
          'OUTPUT_INVALID',
          'RESPONDS_TO provenance must identify the response target critique.'
        );
      }
    });
    validateCurrentVisibleReferences(
      response.factualEvidence,
      response.artifactReferences,
      path,
      registry,
      errors
    );
  });

  output.disagreements.forEach((disagreement, index) => {
    const path = `$.disagreements[${index}]`;
    disagreement.propositionIds.forEach((id, propositionIndex) => {
      requireOutputReference(
        id,
        propositionIds,
        `${path}.propositionIds[${propositionIndex}]`,
        'v4.disagreement.proposition-reference',
        'CASE_REFERENCE',
        'case proposition',
        errors
      );
    });
    disagreement.participantArtifactIds.forEach((id, artifactIndex) => {
      requireOutputReference(
        id,
        registry.artifactIds,
        `${path}.participantArtifactIds[${artifactIndex}]`,
        'v4.disagreement.participant-artifact',
        'CONVERSATIONAL_PROVENANCE',
        'visible artifact',
        errors
      );
    });
    validateCurrentVisibleReferences(
      disagreement.factualEvidence,
      disagreement.artifactReferences,
      path,
      registry,
      errors
    );
  });

  const requestIds = new Set(output.informationRequests.map((request) => request.id));
  output.disagreements.forEach((disagreement, index) => {
    if (!disagreement.informationRequestId) return;
    requireOutputReference(
      disagreement.informationRequestId,
      requestIds,
      `$.disagreements[${index}].informationRequestId`,
      'v4.disagreement.information-request',
      'CROSS_FIELD',
      'current information request',
      errors
    );
  });
  output.informationRequests.forEach((request, index) => {
    request.propositionIds.forEach((id, propositionIndex) => {
      requireOutputReference(
        id,
        propositionIds,
        `$.informationRequests[${index}].propositionIds[${propositionIndex}]`,
        'v4.request.proposition-reference',
        'CASE_REFERENCE',
        'case proposition',
        errors
      );
    });
  });
  output.abstention?.propositionIds.forEach((id, index) => {
    requireOutputReference(
      id,
      propositionIds,
      `$.abstention.propositionIds[${index}]`,
      'v4.abstention.proposition-reference',
      'CASE_REFERENCE',
      'case proposition',
      errors
    );
  });

  const knownIssueIds = new Set([
    ...registry.draftIssueById.keys(),
    ...registry.critiqueIssueIds,
    ...output.issues.map((issue) => issue.id)
  ]);
  output.resolution.resolvedIssueIds.forEach((id, index) => {
    requireOutputReference(
      id,
      knownIssueIds,
      `$.resolution.resolvedIssueIds[${index}]`,
      'v4.resolution.issue-reference',
      'ISSUE_LIFECYCLE',
      'visible or current issue',
      errors
    );
  });
  output.resolution.unresolvedIssueIds.forEach((id, index) => {
    requireOutputReference(
      id,
      knownIssueIds,
      `$.resolution.unresolvedIssueIds[${index}]`,
      'v4.resolution.issue-reference',
      'ISSUE_LIFECYCLE',
      'visible or current issue',
      errors
    );
  });
}

function validateCurrentVisibleReferences(
  factualEvidence: Readonly<
    LabPublicOutputV4['propositionAssessments'][number]['factualEvidence']
  >,
  artifactReferences: Readonly<
    LabPublicOutputV4['propositionAssessments'][number]['artifactReferences']
  >,
  path: string,
  registry: LabContextRegistryV4,
  errors: LabValidationError[]
): void {
  factualEvidence.forEach((reference, index) => {
    requireOutputReference(
      reference.sourceId,
      registry.factualSourceIds,
      `${path}.factualEvidence[${index}].sourceId`,
      'v4.provenance.factual-source',
      'FACTUAL_PROVENANCE',
      'visible factual source',
      errors
    );
  });
  artifactReferences.forEach((reference, index) => {
    requireOutputReference(
      reference.artifactId,
      registry.artifactIds,
      `${path}.artifactReferences[${index}].artifactId`,
      'v4.provenance.conversational-artifact',
      'CONVERSATIONAL_PROVENANCE',
      'visible conversational artifact',
      errors
    );
  });
}

function sameStableIssueIdentity(
  current: LabPublicOutputV4['issues'][number],
  draft: LabPublicOutputV4['issues'][number]
): boolean {
  return current.targetArtifactId === draft.targetArtifactId &&
    current.targetPropositionId === draft.targetPropositionId &&
    current.kind === draft.kind &&
    current.severity === draft.severity;
}

export function validateLabPublicOutputV4(
  value: unknown,
  context?: LabPublicOutputV4ValidationContext
): LabValidationResultV3<LabPublicOutputV4> {
  const shape = validateLabPublicOutputV4Shape(value);
  if (!shape.ok) return shape;
  const errors = [
    ...validateLabPublicOutputV4CrossFields(shape.value),
    ...(context ? validateLabPublicOutputV4Context(shape.value, context) : [])
  ];
  return errors.length > 0 ? { ok: false, errors } : shape;
}

export function parseLabRawOutputAttemptV4(
  input: { callId: string; rawText: string },
  purpose: LabRawOutputAttemptV4['purpose'],
  attemptNumber: 1 | 2,
  context?: LabPublicOutputV4ValidationContext
): LabRawOutputAttemptV4 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.rawText.trim());
  } catch (error) {
    return {
      attemptNumber,
      purpose,
      callId: input.callId,
      rawText: input.rawText,
      validationErrors: [{
        path: '$',
        code: 'INVALID_JSON',
        message: error instanceof Error ? error.message : 'Output is not valid JSON.'
      }]
    };
  }
  const validation = validateLabPublicOutputV4(decoded, context);
  return {
    attemptNumber,
    purpose,
    callId: input.callId,
    rawText: input.rawText,
    validationErrors: validation.ok ? [] : validation.errors,
    output: validation.ok ? validation.value : undefined
  };
}

export function createLabOutputRecordV4(
  primary: { callId: string; rawText: string },
  repair?: { callId: string; rawText: string },
  context?: LabPublicOutputV4ValidationContext
): LabOutputRecordV4 {
  const first = parseLabRawOutputAttemptV4(primary, 'PRIMARY', 1, context);
  if (first.output && repair) {
    throw new Error('A schema repair must not run after a valid primary output.');
  }
  const attempts = [first];
  if (!first.output && repair) {
    attempts.push(parseLabRawOutputAttemptV4(repair, 'SCHEMA_REPAIR', 2, context));
  }
  const accepted = attempts.find((attempt) => attempt.output);
  return {
    attempts,
    acceptedAttemptNumber: accepted?.attemptNumber ?? null,
    repairAttempted: attempts.length === 2,
    status: accepted ? 'VALID' : 'INVALID'
  };
}

export function acceptedLabPublicOutputV4(
  record: LabOutputRecordV4
): LabPublicOutputV4 | undefined {
  if (record.acceptedAttemptNumber === null) return undefined;
  return record.attempts.find(
    (attempt) => attempt.attemptNumber === record.acceptedAttemptNumber
  )?.output;
}

function buildV4Schema(): JsonSchema {
  const schema = structuredClone(LAB_PUBLIC_OUTPUT_V3_JSON_SCHEMA) as JsonSchema;
  const required = schema.required as string[];
  const properties = schema.properties as Record<string, JsonSchema>;
  required.push('selfCorrections');
  properties.schemaVersion = { type: 'string', const: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION };
  properties.selfCorrections = {
    type: 'array',
    minItems: 0,
    maxItems: 64,
    items: SELF_CORRECTION_SCHEMA
  };
  const answer = properties.answer;
  const answerRequired = answer.required as string[];
  const answerProperties = answer.properties as Record<string, JsonSchema>;
  answer.required = answerRequired.filter((field) => field !== 'values');
  delete answerProperties.values;
  return schema;
}

function asV3(output: LabPublicOutputV4): LabPublicOutputV3 {
  const { selfCorrections: _selfCorrections, answer, ...rest } = output;
  return {
    ...rest,
    schemaVersion: LAB_PUBLIC_OUTPUT_V3_SCHEMA_VERSION,
    answer: { ...answer, values: [] }
  };
}

export function substantiveSelfReviewChangesV4(
  before: LabPublicOutputV4,
  after: LabPublicOutputV4
): { fields: Set<LabSelfCorrectionFieldV4>; propositionIds: Set<string> } {
  const fields = new Set<LabSelfCorrectionFieldV4>();
  if (before.answer.summary !== after.answer.summary) fields.add('ANSWER_SUMMARY');
  if (!sameStringSet(before.answer.selectedOptionIds, after.answer.selectedOptionIds)) {
    fields.add('SELECTED_OPTION_IDS');
  }
  if (before.answer.epistemicState !== after.answer.epistemicState) {
    fields.add('EPISTEMIC_STATE');
  }
  if (before.completionDisposition !== after.completionDisposition) {
    fields.add('COMPLETION_DISPOSITION');
  }
  if (requestSignature(before) !== requestSignature(after)) {
    fields.add('INFORMATION_REQUESTS');
  }
  const beforeAssessments = new Map(
    before.propositionAssessments.map((assessment) => [
      assessment.propositionId,
      assessment.assessment
    ])
  );
  const propositionIds = new Set<string>();
  for (const assessment of after.propositionAssessments) {
    if (beforeAssessments.get(assessment.propositionId) !== assessment.assessment) {
      propositionIds.add(assessment.propositionId);
    }
  }
  if (propositionIds.size > 0) fields.add('PROPOSITION_ASSESSMENTS');
  return { fields, propositionIds };
}

function requestSignature(output: LabPublicOutputV4): string {
  return JSON.stringify(output.informationRequests.map((request) => ({
    kind: request.kind,
    source: request.source,
    blocking: request.blocking,
    propositionIds: [...request.propositionIds].sort()
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function requireUniqueStrings(
  values: readonly string[],
  path: string,
  errors: LabValidationError[]
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      addError(errors, `${path}[${index}]`, 'DUPLICATE_ID', `Duplicate value ${value}.`);
    }
    seen.add(value);
  });
}

function sameStringSet(
  left: ReadonlySet<string> | readonly string[],
  right: ReadonlySet<string> | readonly string[]
): boolean {
  const leftValues = [...left].sort();
  const rightValues = [...right].sort();
  return leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

function requireContextSetEquality(
  actual: readonly string[],
  expected: ReadonlySet<string>,
  path: string,
  ruleId: string,
  errors: LabValidationError[]
): void {
  const actualSet = new Set(actual);
  if (
    actual.length !== expected.size ||
    actualSet.size !== expected.size ||
    [...expected].some((id) => !actualSet.has(id))
  ) {
    addContextError(
      errors,
      path,
      'INVALID_REFERENCE',
      ruleId,
      'CONTEXT_INTEGRITY',
      'MEASUREMENT_UNAVAILABLE',
      'The typed position proposition set does not match its authoritative source.'
    );
  }
}

function requireOutputReference(
  id: string,
  known: ReadonlySet<string>,
  path: string,
  ruleId: string,
  domain: NonNullable<LabValidationError['domain']>,
  label: string,
  errors: LabValidationError[]
): void {
  if (!known.has(id)) {
    addContextError(
      errors,
      path,
      'INVALID_REFERENCE',
      ruleId,
      domain,
      'OUTPUT_INVALID',
      `Unknown ${label} id ${id}.`
    );
  }
}

function unavailableContextError(
  error: LabValidationError,
  ruleId: string
): LabValidationError {
  return {
    ...error,
    ruleId,
    domain: 'CONTEXT_INTEGRITY',
    measurementEffect: 'MEASUREMENT_UNAVAILABLE'
  };
}

function addContextError(
  errors: LabValidationError[],
  path: string,
  code: LabValidationError['code'],
  ruleId: string,
  domain: NonNullable<LabValidationError['domain']>,
  measurementEffect: NonNullable<LabValidationError['measurementEffect']>,
  message: string
): void {
  errors.push({ path, code, message, ruleId, domain, measurementEffect });
}

function addError(
  errors: LabValidationError[],
  path: string,
  code: LabValidationError['code'],
  message: string
): void {
  errors.push({ path, code, message });
}
