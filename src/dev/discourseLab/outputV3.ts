import type {
  LabIssueKind,
  LabIssueSeverity,
  LabOutputAttemptInput,
  LabParticipantCase,
  LabResponseDisposition,
  LabValidationError
} from './contracts';

export const LAB_PUBLIC_OUTPUT_V3_SCHEMA_VERSION =
  'discourse-protocol-lab/public-output-v3' as const;

export type LabCompletionDispositionV3 = 'COMPLETE' | 'NEEDS_USER_ACTION' | 'ABSTAIN';
export type LabEpistemicStateV3 =
  | 'RESOLVED'
  | 'UNDERDETERMINED'
  | 'MULTIPLE_DEFENSIBLE';
export type LabPropositionAssessmentV3 =
  | 'SUPPORTED'
  | 'CONTRADICTED'
  | 'UNRESOLVED'
  | 'NOT_APPLICABLE';
export type LabFactualEvidenceRelationV3 = 'SUPPORTS' | 'CONTRADICTS' | 'LIMITS';
export type LabArtifactReferenceRelationV3 =
  | 'RESPONDS_TO'
  | 'AGREES_WITH'
  | 'DISAGREES_WITH'
  | 'MENTIONS';

export interface LabFactualEvidenceReferenceV3 {
  /** A case evidence id, PROMPT, or a typed FACTUAL_EVIDENCE evidenceId. */
  sourceId: string;
  /** Direction of this evidence with respect to the containing proposition or assertion. */
  relation: LabFactualEvidenceRelationV3;
  note: string;
}

export interface LabArtifactReferenceV3 {
  /** A visible conversational artifact. This is never factual evidence by itself. */
  artifactId: string;
  relation: LabArtifactReferenceRelationV3;
  note: string;
}

export type LabVisibleInterventionArtifactV3 =
  | {
      artifactKind: 'CRITIQUE';
      artifactId: string;
      issueId: string;
      targetArtifactId: string;
      targetPropositionId: string;
      text: string;
      provenance: { sourceLabel: string; containsNewFacts: false };
    }
  | {
      artifactKind: 'FACTUAL_EVIDENCE';
      artifactId: string;
      evidenceId: string;
      text: string;
      provenance: { sourceLabel: string; containsNewFacts: true };
    }
  | {
      artifactKind: 'POSITION';
      artifactId: string;
      propositionIds: string[];
      text: string;
      provenance: { sourceLabel: string; containsNewFacts: false };
    };

export interface LabPublicOutputV3 {
  schemaVersion: typeof LAB_PUBLIC_OUTPUT_V3_SCHEMA_VERSION;
  completionDisposition: LabCompletionDispositionV3;
  answer: {
    summary: string;
    values: string[];
    selectedOptionIds: string[];
    epistemicState: LabEpistemicStateV3;
    /** Confidence in the public assessment, not confidence that a final answer exists. */
    assessmentConfidence: number;
  };
  propositionAssessments: LabPublicPropositionAssessmentV3[];
  assumptions: LabPublicAssumptionV3[];
  issues: LabPublicIssueV3[];
  responses: LabPublicResponseV3[];
  disagreements: LabPublicDisagreementV3[];
  resolution: LabPublicResolutionV3;
  informationRequests: LabPublicInformationRequestV3[];
  abstention: LabPublicAbstentionV3 | null;
}

export interface LabPublicPropositionAssessmentV3 {
  id: string;
  propositionId: string;
  topicId: string;
  assessment: LabPropositionAssessmentV3;
  statement: string;
  factualEvidence: LabFactualEvidenceReferenceV3[];
  artifactReferences: LabArtifactReferenceV3[];
  assumptionIds: string[];
  assessmentConfidence: number;
}

export interface LabPublicAssumptionV3 {
  id: string;
  statement: string;
  status: 'REQUIRED' | 'UNCERTAIN' | 'TESTABLE';
  affectsAssessmentIds: string[];
}

export interface LabPublicIssueV3 {
  id: string;
  targetArtifactId: string;
  targetPropositionId: string;
  kind: LabIssueKind;
  severity: LabIssueSeverity;
  statement: string;
  factualEvidence: LabFactualEvidenceReferenceV3[];
  artifactReferences: LabArtifactReferenceV3[];
  assessmentConfidence: number;
}

export interface LabPublicResponseV3 {
  id: string;
  targetArtifactId: string;
  targetIssueId: string;
  disposition: LabResponseDisposition;
  statement: string;
  factualEvidence: LabFactualEvidenceReferenceV3[];
  artifactReferences: LabArtifactReferenceV3[];
  changedAssessmentIds: string[];
}

export interface LabPublicDisagreementV3 {
  id: string;
  propositionIds: string[];
  participantArtifactIds: string[];
  status: 'RESOLVED' | 'UNRESOLVED' | 'COMPATIBLE_DIFFERENCE' | 'NEEDS_USER_ACTION';
  summary: string;
  factualEvidence: LabFactualEvidenceReferenceV3[];
  artifactReferences: LabArtifactReferenceV3[];
  informationRequestId: string | null;
}

export interface LabPublicResolutionV3 {
  status:
    | 'RESOLVED'
    | 'PARTIALLY_RESOLVED'
    | 'UNRESOLVED'
    | 'NEEDS_USER_ACTION'
    | 'NO_DISAGREEMENT';
  basis:
    | 'FACTUAL_EVIDENCE'
    | 'ASSUMPTION'
    | 'PREFERENCE'
    | 'INSUFFICIENT_INFORMATION'
    | 'NO_MATERIAL_ISSUE';
  summary: string;
  resolvedIssueIds: string[];
  unresolvedIssueIds: string[];
}

export interface LabPublicInformationRequestV3 {
  id: string;
  kind: 'MISSING_FACT' | 'USER_PREFERENCE' | 'AUTHORIZATION' | 'TEST_OR_CHECK';
  needed: string;
  question: string;
  source: 'USER' | 'DOCUMENT' | 'TOOL' | 'EXPERT' | 'UNKNOWN';
  blocking: boolean;
  propositionIds: string[];
}

export interface LabPublicAbstentionV3 {
  reason:
    | 'INSUFFICIENT_INFORMATION'
    | 'OUTSIDE_CAPABILITY'
    | 'SAFETY'
    | 'USER_OWNED_DECISION';
  summary: string;
  propositionIds: string[];
  whatWouldResolve: string | null;
}

export interface LabPublicOutputV3ValidationContext {
  participantCase: LabParticipantCase;
  visibleInterventionArtifacts: readonly LabVisibleInterventionArtifactV3[];
}

export interface LabRawOutputAttemptV3 {
  attemptNumber: 1 | 2;
  purpose: 'PRIMARY' | 'SCHEMA_REPAIR';
  callId: string;
  rawText: string;
  validationErrors: LabValidationError[];
  output?: LabPublicOutputV3;
}

export interface LabOutputRecordV3 {
  attempts: LabRawOutputAttemptV3[];
  acceptedAttemptNumber: 1 | 2 | null;
  repairAttempted: boolean;
  status: 'VALID' | 'INVALID';
}

const MAX_COLLECTION_LENGTH = 64;
const MAX_SHORT_TEXT_LENGTH = 600;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const COMPLETION_DISPOSITIONS: LabCompletionDispositionV3[] = [
  'COMPLETE',
  'NEEDS_USER_ACTION',
  'ABSTAIN'
];
const EPISTEMIC_STATES: LabEpistemicStateV3[] = [
  'RESOLVED',
  'UNDERDETERMINED',
  'MULTIPLE_DEFENSIBLE'
];
const PROPOSITION_ASSESSMENTS: LabPropositionAssessmentV3[] = [
  'SUPPORTED',
  'CONTRADICTED',
  'UNRESOLVED',
  'NOT_APPLICABLE'
];
const FACTUAL_EVIDENCE_RELATIONS: LabFactualEvidenceRelationV3[] = [
  'SUPPORTS',
  'CONTRADICTS',
  'LIMITS'
];
const ARTIFACT_REFERENCE_RELATIONS: LabArtifactReferenceRelationV3[] = [
  'RESPONDS_TO',
  'AGREES_WITH',
  'DISAGREES_WITH',
  'MENTIONS'
];
const ISSUE_KINDS: LabIssueKind[] = [
  'FACTUAL',
  'EVIDENCE',
  'ASSUMPTION',
  'LOGIC',
  'AMBIGUITY',
  'MISSING_INFORMATION',
  'TRADEOFF',
  'OTHER'
];
const ISSUE_SEVERITIES: LabIssueSeverity[] = ['MATERIAL', 'ADVISORY'];
const RESPONSE_DISPOSITIONS: LabResponseDisposition[] = [
  'ACCEPT',
  'PARTIAL',
  'REJECT',
  'ABSTAIN'
];

type JsonSchema = Record<string, unknown>;

function idSchema(): JsonSchema {
  return { type: 'string', pattern: ID_PATTERN.source, minLength: 1, maxLength: 120 };
}

function shortTextSchema(): JsonSchema {
  return { type: 'string', minLength: 1, maxLength: MAX_SHORT_TEXT_LENGTH };
}

function artifactTextSchema(): JsonSchema {
  return { type: 'string', minLength: 1, maxLength: 20_000 };
}

function confidenceSchema(): JsonSchema {
  return { type: 'number', minimum: 0, maximum: 1 };
}

function closedObjectSchema(
  required: readonly string[],
  properties: Record<string, JsonSchema>
): JsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}

function arraySchema(items: JsonSchema, minItems = 0): JsonSchema {
  return { type: 'array', minItems, maxItems: MAX_COLLECTION_LENGTH, items };
}

function idArraySchema(minItems = 0): JsonSchema {
  return arraySchema(idSchema(), minItems);
}

function factualEvidenceReferenceSchema(): JsonSchema {
  return closedObjectSchema(['sourceId', 'relation', 'note'], {
    sourceId: idSchema(),
    relation: { type: 'string', enum: FACTUAL_EVIDENCE_RELATIONS },
    note: shortTextSchema()
  });
}

function artifactReferenceSchema(): JsonSchema {
  return closedObjectSchema(['artifactId', 'relation', 'note'], {
    artifactId: idSchema(),
    relation: { type: 'string', enum: ARTIFACT_REFERENCE_RELATIONS },
    note: shortTextSchema()
  });
}

function provenanceSchema(containsNewFacts: boolean): JsonSchema {
  return closedObjectSchema(['sourceLabel', 'containsNewFacts'], {
    sourceLabel: shortTextSchema(),
    containsNewFacts: { type: 'boolean', const: containsNewFacts }
  });
}

export const LAB_VISIBLE_INTERVENTION_ARTIFACT_V3_JSON_SCHEMA = {
  oneOf: [
    closedObjectSchema(
      [
        'artifactKind',
        'artifactId',
        'issueId',
        'targetArtifactId',
        'targetPropositionId',
        'text',
        'provenance'
      ],
      {
        artifactKind: { type: 'string', const: 'CRITIQUE' },
        artifactId: idSchema(),
        issueId: idSchema(),
        targetArtifactId: idSchema(),
        targetPropositionId: idSchema(),
        text: artifactTextSchema(),
        provenance: provenanceSchema(false)
      }
    ),
    closedObjectSchema(
      ['artifactKind', 'artifactId', 'evidenceId', 'text', 'provenance'],
      {
        artifactKind: { type: 'string', const: 'FACTUAL_EVIDENCE' },
        artifactId: idSchema(),
        evidenceId: idSchema(),
        text: artifactTextSchema(),
        provenance: provenanceSchema(true)
      }
    ),
    closedObjectSchema(
      ['artifactKind', 'artifactId', 'propositionIds', 'text', 'provenance'],
      {
        artifactKind: { type: 'string', const: 'POSITION' },
        artifactId: idSchema(),
        propositionIds: idArraySchema(1),
        text: artifactTextSchema(),
        provenance: provenanceSchema(false)
      }
    )
  ]
} as const;

/** Strict provider-facing shape. Semantic and visibility rules are validated separately. */
export const LAB_PUBLIC_OUTPUT_V3_JSON_SCHEMA = closedObjectSchema(
  [
    'schemaVersion',
    'completionDisposition',
    'answer',
    'propositionAssessments',
    'assumptions',
    'issues',
    'responses',
    'disagreements',
    'resolution',
    'informationRequests',
    'abstention'
  ],
  {
    schemaVersion: { type: 'string', const: LAB_PUBLIC_OUTPUT_V3_SCHEMA_VERSION },
    completionDisposition: { type: 'string', enum: COMPLETION_DISPOSITIONS },
    answer: closedObjectSchema(
      [
        'summary',
        'values',
        'selectedOptionIds',
        'epistemicState',
        'assessmentConfidence'
      ],
      {
        summary: shortTextSchema(),
        values: arraySchema({ type: 'string', minLength: 1, maxLength: 120 }),
        selectedOptionIds: idArraySchema(),
        epistemicState: { type: 'string', enum: EPISTEMIC_STATES },
        assessmentConfidence: confidenceSchema()
      }
    ),
    propositionAssessments: arraySchema(
      closedObjectSchema(
        [
          'id',
          'propositionId',
          'topicId',
          'assessment',
          'statement',
          'factualEvidence',
          'artifactReferences',
          'assumptionIds',
          'assessmentConfidence'
        ],
        {
          id: idSchema(),
          propositionId: idSchema(),
          topicId: idSchema(),
          assessment: { type: 'string', enum: PROPOSITION_ASSESSMENTS },
          statement: shortTextSchema(),
          factualEvidence: arraySchema(factualEvidenceReferenceSchema()),
          artifactReferences: arraySchema(artifactReferenceSchema()),
          assumptionIds: idArraySchema(),
          assessmentConfidence: confidenceSchema()
        }
      ),
      1
    ),
    assumptions: arraySchema(
      closedObjectSchema(['id', 'statement', 'status', 'affectsAssessmentIds'], {
        id: idSchema(),
        statement: shortTextSchema(),
        status: { type: 'string', enum: ['REQUIRED', 'UNCERTAIN', 'TESTABLE'] },
        affectsAssessmentIds: idArraySchema(1)
      })
    ),
    issues: arraySchema(
      closedObjectSchema(
        [
          'id',
          'targetArtifactId',
          'targetPropositionId',
          'kind',
          'severity',
          'statement',
          'factualEvidence',
          'artifactReferences',
          'assessmentConfidence'
        ],
        {
          id: idSchema(),
          targetArtifactId: idSchema(),
          targetPropositionId: idSchema(),
          kind: { type: 'string', enum: ISSUE_KINDS },
          severity: { type: 'string', enum: ISSUE_SEVERITIES },
          statement: shortTextSchema(),
          factualEvidence: arraySchema(factualEvidenceReferenceSchema()),
          artifactReferences: arraySchema(artifactReferenceSchema()),
          assessmentConfidence: confidenceSchema()
        }
      )
    ),
    responses: arraySchema(
      closedObjectSchema(
        [
          'id',
          'targetArtifactId',
          'targetIssueId',
          'disposition',
          'statement',
          'factualEvidence',
          'artifactReferences',
          'changedAssessmentIds'
        ],
        {
          id: idSchema(),
          targetArtifactId: idSchema(),
          targetIssueId: idSchema(),
          disposition: { type: 'string', enum: RESPONSE_DISPOSITIONS },
          statement: shortTextSchema(),
          factualEvidence: arraySchema(factualEvidenceReferenceSchema()),
          artifactReferences: arraySchema(artifactReferenceSchema(), 1),
          changedAssessmentIds: idArraySchema()
        }
      )
    ),
    disagreements: arraySchema(
      closedObjectSchema(
        [
          'id',
          'propositionIds',
          'participantArtifactIds',
          'status',
          'summary',
          'factualEvidence',
          'artifactReferences',
          'informationRequestId'
        ],
        {
          id: idSchema(),
          propositionIds: idArraySchema(1),
          participantArtifactIds: idArraySchema(1),
          status: {
            type: 'string',
            enum: ['RESOLVED', 'UNRESOLVED', 'COMPATIBLE_DIFFERENCE', 'NEEDS_USER_ACTION']
          },
          summary: shortTextSchema(),
          factualEvidence: arraySchema(factualEvidenceReferenceSchema()),
          artifactReferences: arraySchema(artifactReferenceSchema()),
          informationRequestId: {
            type: ['string', 'null'],
            pattern: ID_PATTERN.source,
            minLength: 1,
            maxLength: 120
          }
        }
      )
    ),
    resolution: closedObjectSchema(
      ['status', 'basis', 'summary', 'resolvedIssueIds', 'unresolvedIssueIds'],
      {
        status: {
          type: 'string',
          enum: [
            'RESOLVED',
            'PARTIALLY_RESOLVED',
            'UNRESOLVED',
            'NEEDS_USER_ACTION',
            'NO_DISAGREEMENT'
          ]
        },
        basis: {
          type: 'string',
          enum: [
            'FACTUAL_EVIDENCE',
            'ASSUMPTION',
            'PREFERENCE',
            'INSUFFICIENT_INFORMATION',
            'NO_MATERIAL_ISSUE'
          ]
        },
        summary: shortTextSchema(),
        resolvedIssueIds: idArraySchema(),
        unresolvedIssueIds: idArraySchema()
      }
    ),
    informationRequests: arraySchema(
      closedObjectSchema(
        ['id', 'kind', 'needed', 'question', 'source', 'blocking', 'propositionIds'],
        {
          id: idSchema(),
          kind: {
            type: 'string',
            enum: ['MISSING_FACT', 'USER_PREFERENCE', 'AUTHORIZATION', 'TEST_OR_CHECK']
          },
          needed: shortTextSchema(),
          question: shortTextSchema(),
          source: { type: 'string', enum: ['USER', 'DOCUMENT', 'TOOL', 'EXPERT', 'UNKNOWN'] },
          blocking: { type: 'boolean' },
          propositionIds: idArraySchema(1)
        }
      )
    ),
    abstention: {
      anyOf: [
        { type: 'null' },
        closedObjectSchema(['reason', 'summary', 'propositionIds', 'whatWouldResolve'], {
          reason: {
            type: 'string',
            enum: [
              'INSUFFICIENT_INFORMATION',
              'OUTSIDE_CAPABILITY',
              'SAFETY',
              'USER_OWNED_DECISION'
            ]
          },
          summary: shortTextSchema(),
          propositionIds: idArraySchema(1),
          whatWouldResolve: {
            type: ['string', 'null'],
            minLength: 1,
            maxLength: MAX_SHORT_TEXT_LENGTH
          }
        })
      ]
    }
  }
);

export type LabValidationResultV3<T> =
  | { ok: true; value: T }
  | { ok: false; errors: LabValidationError[] };

export function validateLabPublicOutputV3Shape(
  value: unknown
): LabValidationResultV3<LabPublicOutputV3> {
  const errors: LabValidationError[] = [];
  validateJsonSchema(value, LAB_PUBLIC_OUTPUT_V3_JSON_SCHEMA, '$', errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as LabPublicOutputV3 };
}

/** Cross-field rules which do not depend on case or visibility context. */
export interface LabPublicOutputV3CrossFieldOptions {
  /** Keep v3's hard directional minimum by default; later contracts may score it semantically. */
  requireDirectionalEvidence?: boolean;
  /** v3 permits only one direction per source; later contracts may type source+direction pairs. */
  factualEvidenceIdentity?: 'SOURCE_ID' | 'SOURCE_ID_AND_RELATION';
}

export function validateLabPublicOutputV3CrossFields(
  output: LabPublicOutputV3,
  options: LabPublicOutputV3CrossFieldOptions = {}
): LabValidationError[] {
  const errors: LabValidationError[] = [];
  const requireDirectionalEvidence = options.requireDirectionalEvidence ?? true;
  const factualEvidenceIdentity = options.factualEvidenceIdentity ?? 'SOURCE_ID';
  const assessmentIds = uniqueObjectIds(
    output.propositionAssessments,
    '$.propositionAssessments',
    errors
  );
  const assumptionIds = uniqueObjectIds(output.assumptions, '$.assumptions', errors);
  uniqueObjectIds(output.issues, '$.issues', errors);
  uniqueObjectIds(output.responses, '$.responses', errors);
  uniqueObjectIds(output.disagreements, '$.disagreements', errors);
  const requestIds = uniqueObjectIds(output.informationRequests, '$.informationRequests', errors);
  uniqueStrings(output.answer.selectedOptionIds, '$.answer.selectedOptionIds', errors);

  output.propositionAssessments.forEach((assessment, index) => {
    uniqueStrings(assessment.assumptionIds, `$.propositionAssessments[${index}].assumptionIds`, errors);
    uniqueEvidenceAndArtifactReferences(
      assessment.factualEvidence,
      assessment.artifactReferences,
      `$.propositionAssessments[${index}]`,
      errors,
      factualEvidenceIdentity
    );
    assessment.assumptionIds.forEach((id, assumptionIndex) => {
      requireKnownReference(
        id,
        assumptionIds,
        `$.propositionAssessments[${index}].assumptionIds[${assumptionIndex}]`,
        'current assumption',
        errors
      );
    });
    const requiredRelation: LabFactualEvidenceRelationV3 | undefined =
      assessment.assessment === 'SUPPORTED'
        ? 'SUPPORTS'
        : assessment.assessment === 'CONTRADICTED'
          ? 'CONTRADICTS'
          : assessment.assessment === 'UNRESOLVED'
            ? 'LIMITS'
            : undefined;
    if (
      requireDirectionalEvidence &&
      requiredRelation &&
      !assessment.factualEvidence.some((reference) => reference.relation === requiredRelation)
    ) {
      addError(
        errors,
        `$.propositionAssessments[${index}].factualEvidence`,
        'INVALID_VALUE',
        `${assessment.assessment} requires at least one ${requiredRelation} factual-evidence relation.`
      );
    }
  });

  output.assumptions.forEach((assumption, index) => {
    uniqueStrings(assumption.affectsAssessmentIds, `$.assumptions[${index}].affectsAssessmentIds`, errors);
    assumption.affectsAssessmentIds.forEach((id, assessmentIndex) => {
      requireKnownReference(
        id,
        assessmentIds,
        `$.assumptions[${index}].affectsAssessmentIds[${assessmentIndex}]`,
        'current proposition assessment',
        errors
      );
    });
  });

  output.issues.forEach((issue, index) =>
    uniqueEvidenceAndArtifactReferences(
      issue.factualEvidence,
      issue.artifactReferences,
      `$.issues[${index}]`,
      errors,
      factualEvidenceIdentity
    )
  );
  const responseTargets = new Set<string>();
  output.responses.forEach((response, index) => {
    const targetKey = `${response.targetArtifactId}\u0000${response.targetIssueId}`;
    if (responseTargets.has(targetKey)) {
      addError(
        errors,
        `$.responses[${index}].targetIssueId`,
        'DUPLICATE_ID',
        'A visible critique issue may receive only one response from this actor.'
      );
    }
    responseTargets.add(targetKey);
    uniqueStrings(response.changedAssessmentIds, `$.responses[${index}].changedAssessmentIds`, errors);
    response.changedAssessmentIds.forEach((id, assessmentIndex) => {
      requireKnownReference(
        id,
        assessmentIds,
        `$.responses[${index}].changedAssessmentIds[${assessmentIndex}]`,
        'current proposition assessment',
        errors
      );
    });
    uniqueEvidenceAndArtifactReferences(
      response.factualEvidence,
      response.artifactReferences,
      `$.responses[${index}]`,
      errors,
      factualEvidenceIdentity
    );
  });

  output.informationRequests.forEach((request, index) => {
    uniqueStrings(request.propositionIds, `$.informationRequests[${index}].propositionIds`, errors);
    if (
      (request.kind === 'USER_PREFERENCE' || request.kind === 'AUTHORIZATION') &&
      request.source !== 'USER'
    ) {
      addError(
        errors,
        `$.informationRequests[${index}].source`,
        'INVALID_VALUE',
        `${request.kind} must be requested from USER.`
      );
    }
  });

  output.disagreements.forEach((disagreement, index) => {
    uniqueStrings(disagreement.propositionIds, `$.disagreements[${index}].propositionIds`, errors);
    uniqueStrings(
      disagreement.participantArtifactIds,
      `$.disagreements[${index}].participantArtifactIds`,
      errors
    );
    uniqueEvidenceAndArtifactReferences(
      disagreement.factualEvidence,
      disagreement.artifactReferences,
      `$.disagreements[${index}]`,
      errors,
      factualEvidenceIdentity
    );
    if (disagreement.status === 'NEEDS_USER_ACTION') {
      if (!disagreement.informationRequestId) {
        addError(
          errors,
          `$.disagreements[${index}].informationRequestId`,
          'MISSING_FIELD',
          'NEEDS_USER_ACTION requires a typed information request.'
        );
      } else {
        requireKnownReference(
          disagreement.informationRequestId,
          requestIds,
          `$.disagreements[${index}].informationRequestId`,
          'current information request',
          errors
        );
        const request = output.informationRequests.find(
          (candidate) => candidate.id === disagreement.informationRequestId
        );
        if (request && (!request.blocking || request.source !== 'USER')) {
          addError(
            errors,
            `$.disagreements[${index}].informationRequestId`,
            'INVALID_VALUE',
            'A user-action disagreement must identify a blocking USER request.'
          );
        }
      }
    } else if (disagreement.informationRequestId !== null) {
      addError(
        errors,
        `$.disagreements[${index}].informationRequestId`,
        'INVALID_VALUE',
        'Only NEEDS_USER_ACTION disagreements may identify an information request.'
      );
    }
  });

  const hasBlockingUserRequest = output.informationRequests.some(
    (request) => request.blocking && request.source === 'USER'
  );
  if (output.completionDisposition === 'NEEDS_USER_ACTION') {
    if (!hasBlockingUserRequest) {
      addError(
        errors,
        '$.informationRequests',
        'MISSING_FIELD',
        'NEEDS_USER_ACTION requires at least one blocking USER request.'
      );
    }
    if (output.resolution.status !== 'NEEDS_USER_ACTION') {
      addError(
        errors,
        '$.resolution.status',
        'INVALID_VALUE',
        'NEEDS_USER_ACTION completion requires NEEDS_USER_ACTION resolution.'
      );
    }
  } else {
    if (hasBlockingUserRequest) {
      addError(
        errors,
        '$.informationRequests',
        'INVALID_VALUE',
        'A blocking USER request requires NEEDS_USER_ACTION completion.'
      );
    }
    if (output.resolution.status === 'NEEDS_USER_ACTION') {
      addError(
        errors,
        '$.resolution.status',
        'INVALID_VALUE',
        'NEEDS_USER_ACTION resolution requires matching completion disposition.'
      );
    }
  }

  const abstained = output.abstention !== null;
  if ((output.completionDisposition === 'ABSTAIN') !== abstained) {
    addError(
      errors,
      '$.abstention',
      'INVALID_VALUE',
      'completionDisposition is ABSTAIN if and only if an abstention object is present.'
    );
  }

  const unresolvedAssessment = output.propositionAssessments.some(
    (assessment) => assessment.assessment === 'UNRESOLVED'
  );
  if (output.answer.epistemicState === 'UNDERDETERMINED' && !unresolvedAssessment) {
    addError(
      errors,
      '$.answer.epistemicState',
      'INVALID_VALUE',
      'UNDERDETERMINED requires at least one UNRESOLVED proposition assessment.'
    );
  }
  if (output.answer.epistemicState === 'RESOLVED' && unresolvedAssessment) {
    addError(
      errors,
      '$.answer.epistemicState',
      'INVALID_VALUE',
      'RESOLVED is inconsistent with an UNRESOLVED proposition assessment.'
    );
  }
  if (
    output.answer.epistemicState === 'MULTIPLE_DEFENSIBLE' &&
    !output.disagreements.some((item) => item.status === 'COMPATIBLE_DIFFERENCE')
  ) {
    addError(
      errors,
      '$.answer.epistemicState',
      'INVALID_VALUE',
      'MULTIPLE_DEFENSIBLE requires a COMPATIBLE_DIFFERENCE disagreement.'
    );
  }

  const resolvedIssueIds = new Set(output.resolution.resolvedIssueIds);
  uniqueStrings(output.resolution.resolvedIssueIds, '$.resolution.resolvedIssueIds', errors);
  uniqueStrings(output.resolution.unresolvedIssueIds, '$.resolution.unresolvedIssueIds', errors);
  output.resolution.unresolvedIssueIds.forEach((issueId, index) => {
    if (resolvedIssueIds.has(issueId)) {
      addError(
        errors,
        `$.resolution.unresolvedIssueIds[${index}]`,
        'INVALID_REFERENCE',
        `Issue ${issueId} cannot be both resolved and unresolved.`
      );
    }
  });
  if (output.resolution.status === 'NO_DISAGREEMENT' && output.disagreements.length > 0) {
    addError(
      errors,
      '$.resolution.status',
      'INVALID_VALUE',
      'NO_DISAGREEMENT is inconsistent with a reported disagreement.'
    );
  }

  return errors;
}

/** Validates evidence provenance and every id against what this actor could see. */
export function validateLabPublicOutputV3Context(
  output: LabPublicOutputV3,
  context: LabPublicOutputV3ValidationContext
): LabValidationError[] {
  const errors: LabValidationError[] = [];
  const propositions = new Map(
    context.participantCase.propositions.map((proposition) => [proposition.id, proposition])
  );
  const propositionIds = new Set(propositions.keys());
  const topicIds = new Set(context.participantCase.topics.map((topic) => topic.id));
  const optionIds = new Set(context.participantCase.options.map((option) => option.id));
  const factualSourceIds = new Set([
    'PROMPT',
    ...context.participantCase.evidence.map((evidence) => evidence.id)
  ]);
  const visibleArtifactIds = new Set<string>(['CASE']);
  const critiqueIssueByArtifactId = new Map<string, string>();
  const visibleIssueIds = new Set<string>();
  const nonFactualIds = new Set<string>();

  context.visibleInterventionArtifacts.forEach((artifact, index) => {
    const artifactErrors: LabValidationError[] = [];
    validateJsonSchema(
      artifact,
      LAB_VISIBLE_INTERVENTION_ARTIFACT_V3_JSON_SCHEMA,
      `$.context.visibleInterventionArtifacts[${index}]`,
      artifactErrors
    );
    errors.push(...artifactErrors);
    if (artifactErrors.length > 0) return;

    if (visibleArtifactIds.has(artifact.artifactId)) {
      addError(
        errors,
        `$.context.visibleInterventionArtifacts[${index}].artifactId`,
        'DUPLICATE_ID',
        `Duplicate visible artifact id ${artifact.artifactId}.`
      );
    }
    visibleArtifactIds.add(artifact.artifactId);
    if (artifact.artifactKind === 'FACTUAL_EVIDENCE') {
      if (factualSourceIds.has(artifact.evidenceId)) {
        addError(
          errors,
          `$.context.visibleInterventionArtifacts[${index}].evidenceId`,
          'DUPLICATE_ID',
          `Duplicate factual evidence id ${artifact.evidenceId}.`
        );
      }
      factualSourceIds.add(artifact.evidenceId);
    } else if (artifact.artifactKind === 'CRITIQUE') {
      nonFactualIds.add(artifact.artifactId);
      nonFactualIds.add(artifact.issueId);
      critiqueIssueByArtifactId.set(artifact.artifactId, artifact.issueId);
      if (visibleIssueIds.has(artifact.issueId)) {
        addError(
          errors,
          `$.context.visibleInterventionArtifacts[${index}].issueId`,
          'DUPLICATE_ID',
          `Duplicate visible issue id ${artifact.issueId}.`
        );
      }
      visibleIssueIds.add(artifact.issueId);
      requireKnownReference(
        artifact.targetPropositionId,
        propositionIds,
        `$.context.visibleInterventionArtifacts[${index}].targetPropositionId`,
        'case proposition',
        errors
      );
    } else {
      nonFactualIds.add(artifact.artifactId);
      artifact.propositionIds.forEach((id, propositionIndex) =>
        requireKnownReference(
          id,
          propositionIds,
          `$.context.visibleInterventionArtifacts[${index}].propositionIds[${propositionIndex}]`,
          'case proposition',
          errors
        )
      );
    }
  });

  context.visibleInterventionArtifacts.forEach((artifact, index) => {
    if (artifact.artifactKind !== 'CRITIQUE') return;
    requireKnownReference(
      artifact.targetArtifactId,
      visibleArtifactIds,
      `$.context.visibleInterventionArtifacts[${index}].targetArtifactId`,
      'visible artifact',
      errors
    );
    if (artifact.targetArtifactId === artifact.artifactId) {
      addError(
        errors,
        `$.context.visibleInterventionArtifacts[${index}].targetArtifactId`,
        'INVALID_REFERENCE',
        'A critique cannot target itself.'
      );
    }
  });

  nonFactualIds.forEach((id) => {
    if (factualSourceIds.has(id)) {
      addError(
        errors,
        '$.context.visibleInterventionArtifacts',
        'DUPLICATE_ID',
        `Conversational id ${id} collides with a factual evidence id.`
      );
    }
  });

  output.answer.selectedOptionIds.forEach((id, index) =>
    requireKnownReference(id, optionIds, `$.answer.selectedOptionIds[${index}]`, 'case option', errors)
  );

  const emittedPropositionIds = new Set<string>();
  output.propositionAssessments.forEach((assessment, index) => {
    const proposition = propositions.get(assessment.propositionId);
    if (!proposition) {
      addError(
        errors,
        `$.propositionAssessments[${index}].propositionId`,
        'INVALID_REFERENCE',
        `Unknown case proposition id ${assessment.propositionId}.`
      );
    } else {
      if (emittedPropositionIds.has(assessment.propositionId)) {
        addError(
          errors,
          `$.propositionAssessments[${index}].propositionId`,
          'DUPLICATE_ID',
          `Case proposition ${assessment.propositionId} must be assessed exactly once.`
        );
      }
      emittedPropositionIds.add(assessment.propositionId);
      if (assessment.topicId !== proposition.topicId) {
        addError(
          errors,
          `$.propositionAssessments[${index}].topicId`,
          'INVALID_REFERENCE',
          `Topic ${assessment.topicId} does not own proposition ${assessment.propositionId}.`
        );
      }
    }
    requireKnownReference(
      assessment.topicId,
      topicIds,
      `$.propositionAssessments[${index}].topicId`,
      'case topic',
      errors
    );
    validateVisibleReferences(
      assessment.factualEvidence,
      assessment.artifactReferences,
      `$.propositionAssessments[${index}]`,
      factualSourceIds,
      visibleArtifactIds,
      errors
    );
  });
  propositions.forEach((_proposition, id) => {
    if (!emittedPropositionIds.has(id)) {
      addError(
        errors,
        '$.propositionAssessments',
        'MISSING_FIELD',
        `Missing the required assessment for case proposition ${id}.`
      );
    }
  });

  output.issues.forEach((issue, index) => {
    requireKnownReference(
      issue.targetArtifactId,
      visibleArtifactIds,
      `$.issues[${index}].targetArtifactId`,
      'visible artifact',
      errors
    );
    requireKnownReference(
      issue.targetPropositionId,
      propositionIds,
      `$.issues[${index}].targetPropositionId`,
      'case proposition',
      errors
    );
    validateVisibleReferences(
      issue.factualEvidence,
      issue.artifactReferences,
      `$.issues[${index}]`,
      factualSourceIds,
      visibleArtifactIds,
      errors
    );
    if (visibleIssueIds.has(issue.id)) {
      addError(
        errors,
        `$.issues[${index}].id`,
        'DUPLICATE_ID',
        `Current issue id ${issue.id} duplicates a visible critique issue.`
      );
    }
    visibleIssueIds.add(issue.id);
  });

  output.responses.forEach((response, index) => {
    const expectedIssueId = critiqueIssueByArtifactId.get(response.targetArtifactId);
    if (!expectedIssueId) {
      addError(
        errors,
        `$.responses[${index}].targetArtifactId`,
        'INVALID_REFERENCE',
        `${response.targetArtifactId} is not a visible CRITIQUE artifact.`
      );
    } else if (expectedIssueId !== response.targetIssueId) {
      addError(
        errors,
        `$.responses[${index}].targetIssueId`,
        'INVALID_REFERENCE',
        `Issue ${response.targetIssueId} does not belong to critique ${response.targetArtifactId}.`
      );
    }
    const responseReference = response.artifactReferences.find(
      (reference) =>
        reference.artifactId === response.targetArtifactId && reference.relation === 'RESPONDS_TO'
    );
    if (!responseReference) {
      addError(
        errors,
        `$.responses[${index}].artifactReferences`,
        'MISSING_FIELD',
        'A response must carry RESPONDS_TO provenance for its target critique.'
      );
    }
    response.artifactReferences.forEach((reference, referenceIndex) => {
      if (
        reference.relation === 'RESPONDS_TO' &&
        reference.artifactId !== response.targetArtifactId
      ) {
        addError(
          errors,
          `$.responses[${index}].artifactReferences[${referenceIndex}].artifactId`,
          'INVALID_REFERENCE',
          'RESPONDS_TO provenance must identify the response target artifact.'
        );
      }
    });
    validateVisibleReferences(
      response.factualEvidence,
      response.artifactReferences,
      `$.responses[${index}]`,
      factualSourceIds,
      visibleArtifactIds,
      errors
    );
  });

  output.disagreements.forEach((disagreement, index) => {
    disagreement.propositionIds.forEach((id, propositionIndex) =>
      requireKnownReference(
        id,
        propositionIds,
        `$.disagreements[${index}].propositionIds[${propositionIndex}]`,
        'case proposition',
        errors
      )
    );
    disagreement.participantArtifactIds.forEach((id, artifactIndex) =>
      requireKnownReference(
        id,
        visibleArtifactIds,
        `$.disagreements[${index}].participantArtifactIds[${artifactIndex}]`,
        'visible artifact',
        errors
      )
    );
    validateVisibleReferences(
      disagreement.factualEvidence,
      disagreement.artifactReferences,
      `$.disagreements[${index}]`,
      factualSourceIds,
      visibleArtifactIds,
      errors
    );
  });

  const informationRequestIds = new Set(output.informationRequests.map((request) => request.id));
  output.disagreements.forEach((disagreement, index) => {
    if (disagreement.informationRequestId) {
      requireKnownReference(
        disagreement.informationRequestId,
        informationRequestIds,
        `$.disagreements[${index}].informationRequestId`,
        'current information request',
        errors
      );
    }
  });
  output.informationRequests.forEach((request, index) =>
    request.propositionIds.forEach((id, propositionIndex) =>
      requireKnownReference(
        id,
        propositionIds,
        `$.informationRequests[${index}].propositionIds[${propositionIndex}]`,
        'case proposition',
        errors
      )
    )
  );
  output.abstention?.propositionIds.forEach((id, index) =>
    requireKnownReference(
      id,
      propositionIds,
      `$.abstention.propositionIds[${index}]`,
      'case proposition',
      errors
    )
  );

  output.resolution.resolvedIssueIds.forEach((id, index) =>
    requireKnownReference(
      id,
      visibleIssueIds,
      `$.resolution.resolvedIssueIds[${index}]`,
      'visible or current issue',
      errors
    )
  );
  output.resolution.unresolvedIssueIds.forEach((id, index) =>
    requireKnownReference(
      id,
      visibleIssueIds,
      `$.resolution.unresolvedIssueIds[${index}]`,
      'visible or current issue',
      errors
    )
  );

  return errors;
}

export function validateLabPublicOutputV3(
  value: unknown,
  context?: LabPublicOutputV3ValidationContext
): LabValidationResultV3<LabPublicOutputV3> {
  const shape = validateLabPublicOutputV3Shape(value);
  if (!shape.ok) return shape;
  const errors = [
    ...validateLabPublicOutputV3CrossFields(shape.value),
    ...(context ? validateLabPublicOutputV3Context(shape.value, context) : [])
  ];
  return errors.length > 0 ? { ok: false, errors } : shape;
}

export function parseLabRawOutputAttemptV3(
  input: Pick<LabOutputAttemptInput, 'callId' | 'rawText'>,
  purpose: LabRawOutputAttemptV3['purpose'],
  attemptNumber: 1 | 2,
  context?: LabPublicOutputV3ValidationContext
): LabRawOutputAttemptV3 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.rawText.trim());
  } catch (error) {
    return {
      attemptNumber,
      purpose,
      callId: input.callId,
      rawText: input.rawText,
      validationErrors: [
        {
          path: '$',
          code: 'INVALID_JSON',
          message: error instanceof Error ? error.message : 'Output is not valid JSON.'
        }
      ]
    };
  }
  const validation = validateLabPublicOutputV3(decoded, context);
  return {
    attemptNumber,
    purpose,
    callId: input.callId,
    rawText: input.rawText,
    validationErrors: validation.ok ? [] : validation.errors,
    output: validation.ok ? validation.value : undefined
  };
}

/** Evaluation-only two-attempt record; it is intentionally not wired to a runner. */
export function createLabOutputRecordV3(
  primary: Pick<LabOutputAttemptInput, 'callId' | 'rawText'>,
  repair?: Pick<LabOutputAttemptInput, 'callId' | 'rawText'>,
  context?: LabPublicOutputV3ValidationContext
): LabOutputRecordV3 {
  const first = parseLabRawOutputAttemptV3(primary, 'PRIMARY', 1, context);
  if (first.output && repair) {
    throw new Error('A schema repair must not run after a valid primary output.');
  }
  const attempts = [first];
  if (!first.output && repair) {
    attempts.push(parseLabRawOutputAttemptV3(repair, 'SCHEMA_REPAIR', 2, context));
  }
  const accepted = attempts.find((attempt) => attempt.output);
  return {
    attempts,
    acceptedAttemptNumber: accepted?.attemptNumber ?? null,
    repairAttempted: attempts.length === 2,
    status: accepted ? 'VALID' : 'INVALID'
  };
}

export function acceptedLabPublicOutputV3(
  record: LabOutputRecordV3
): LabPublicOutputV3 | undefined {
  if (record.acceptedAttemptNumber === null) return undefined;
  return record.attempts.find(
    (attempt) => attempt.attemptNumber === record.acceptedAttemptNumber
  )?.output;
}

function validateVisibleReferences(
  factualEvidence: readonly LabFactualEvidenceReferenceV3[],
  artifactReferences: readonly LabArtifactReferenceV3[],
  path: string,
  factualSourceIds: ReadonlySet<string>,
  visibleArtifactIds: ReadonlySet<string>,
  errors: LabValidationError[]
): void {
  factualEvidence.forEach((reference, index) =>
    requireKnownReference(
      reference.sourceId,
      factualSourceIds,
      `${path}.factualEvidence[${index}].sourceId`,
      'visible factual source',
      errors
    )
  );
  artifactReferences.forEach((reference, index) =>
    requireKnownReference(
      reference.artifactId,
      visibleArtifactIds,
      `${path}.artifactReferences[${index}].artifactId`,
      'visible conversational artifact',
      errors
    )
  );
}

function uniqueEvidenceAndArtifactReferences(
  factualEvidence: readonly LabFactualEvidenceReferenceV3[],
  artifactReferences: readonly LabArtifactReferenceV3[],
  path: string,
  errors: LabValidationError[],
  factualEvidenceIdentity: 'SOURCE_ID' | 'SOURCE_ID_AND_RELATION' = 'SOURCE_ID'
): void {
  uniqueStrings(
    factualEvidence.map((reference) => factualEvidenceIdentity === 'SOURCE_ID'
      ? reference.sourceId
      : `${reference.sourceId}\u0000${reference.relation}`),
    `${path}.factualEvidence`,
    errors
  );
  uniqueStrings(
    artifactReferences.map((reference) => `${reference.artifactId}:${reference.relation}`),
    `${path}.artifactReferences`,
    errors
  );
}

function uniqueObjectIds(
  values: readonly { id: string }[],
  path: string,
  errors: LabValidationError[]
): Set<string> {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id)) {
      addError(errors, `${path}[${index}].id`, 'DUPLICATE_ID', `Duplicate id ${value.id}.`);
    }
    ids.add(value.id);
  });
  return ids;
}

function uniqueStrings(
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

function requireKnownReference(
  id: string,
  known: ReadonlySet<string>,
  path: string,
  label: string,
  errors: LabValidationError[]
): void {
  if (!known.has(id)) {
    addError(errors, path, 'INVALID_REFERENCE', `Unknown ${label} id ${id}.`);
  }
}

export function validateJsonSchema(
  value: unknown,
  rawSchema: unknown,
  path: string,
  errors: LabValidationError[]
): void {
  if (!isRecord(rawSchema)) return;
  const schema = rawSchema;
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    const branchErrors = oneOf.map((branch) => {
      const candidateErrors: LabValidationError[] = [];
      validateJsonSchema(value, branch, path, candidateErrors);
      return candidateErrors;
    });
    if (branchErrors.filter((candidate) => candidate.length === 0).length !== 1) {
      addError(errors, path, 'INVALID_VALUE', 'Value does not match exactly one allowed shape.');
    }
    return;
  }
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const branchErrors = anyOf.map((branch) => {
      const candidateErrors: LabValidationError[] = [];
      validateJsonSchema(value, branch, path, candidateErrors);
      return candidateErrors;
    });
    if (!branchErrors.some((candidate) => candidate.length === 0)) {
      addError(errors, path, 'INVALID_VALUE', 'Value does not match an allowed shape.');
    }
    return;
  }

  const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    expectedTypes[0] !== undefined &&
    !expectedTypes.some((type) => typeof type === 'string' && valueMatchesType(value, type))
  ) {
    addError(
      errors,
      path,
      'INVALID_TYPE',
      `Expected ${expectedTypes.join(' or ')}.`
    );
    return;
  }

  if ('const' in schema && value !== schema.const) {
    addError(errors, path, 'INVALID_VALUE', `Expected constant ${String(schema.const)}.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    addError(errors, path, 'INVALID_VALUE', `Expected one of ${schema.enum.join(', ')}.`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      addError(errors, path, 'OUT_OF_RANGE', `Must contain at least ${schema.minLength} characters.`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      addError(errors, path, 'OUT_OF_RANGE', `Must contain at most ${schema.maxLength} characters.`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      addError(errors, path, 'INVALID_VALUE', 'String does not match the required pattern.');
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      addError(errors, path, 'OUT_OF_RANGE', `Must be at least ${schema.minimum}.`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      addError(errors, path, 'OUT_OF_RANGE', `Must be at most ${schema.maximum}.`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      addError(errors, path, 'OUT_OF_RANGE', `Must contain at least ${schema.minItems} items.`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      addError(errors, path, 'OUT_OF_RANGE', `Must contain at most ${schema.maxItems} items.`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateJsonSchema(item, schema.items, `${path}[${index}]`, errors));
    }
  }

  if (isRecord(value) && !Array.isArray(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    required.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        addError(errors, `${path}.${key}`, 'MISSING_FIELD', `Missing required field ${key}.`);
      }
    });
    if (schema.additionalProperties === false) {
      Object.keys(value).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          addError(errors, `${path}.${key}`, 'UNKNOWN_FIELD', `Unknown field ${key}.`);
        }
      });
    }
    Object.entries(properties).forEach(([key, childSchema]) => {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateJsonSchema(value[key], childSchema, `${path}.${key}`, errors);
      }
    });
  }
}

function valueMatchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value) && !Array.isArray(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addError(
  errors: LabValidationError[],
  path: string,
  code: LabValidationError['code'],
  message: string
): void {
  errors.push({ path, code, message });
}
