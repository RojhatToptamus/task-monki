import {
  LAB_ORACLE_CASE_SCHEMA_VERSION,
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  LAB_INITIAL_ARTIFACT_ID,
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabArtifactRecord,
  type LabAssumptionStatus,
  type LabClaimStance,
  type LabDisagreementStatus,
  type LabEvaluationKind,
  type LabEvidenceRelation,
  type LabIssueKind,
  type LabIssueSeverity,
  type LabOracleCase,
  type LabOutputAttemptInput,
  type LabOutputRecord,
  type LabOutputStatus,
  type LabParticipantCase,
  type LabPublicOutput,
  type LabRawOutputAttempt,
  type LabResolutionBasis,
  type LabResolutionStatus,
  type LabResponseDisposition,
  type LabValidationError
} from './contracts';

const OUTPUT_STATUSES: LabOutputStatus[] = [
  'ANSWER',
  'UNCERTAIN',
  'ABSTAIN',
  'NEEDS_USER_INPUT',
  'MULTIPLE_DEFENSIBLE'
];
const CLAIM_STANCES: LabClaimStance[] = ['ACCEPT', 'REJECT', 'OPEN', 'NOT_APPLICABLE'];
const EVIDENCE_RELATIONS: LabEvidenceRelation[] = ['SUPPORTS', 'CONTRADICTS', 'LIMITS'];
const ASSUMPTION_STATUSES: LabAssumptionStatus[] = ['REQUIRED', 'UNCERTAIN', 'TESTABLE'];
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
const DISAGREEMENT_STATUSES: LabDisagreementStatus[] = [
  'RESOLVED',
  'UNRESOLVED',
  'COMPATIBLE_DIFFERENCE',
  'NEEDS_USER_INPUT'
];
const RESOLUTION_STATUSES: LabResolutionStatus[] = [
  'RESOLVED',
  'PARTIALLY_RESOLVED',
  'UNRESOLVED',
  'NEEDS_USER_INPUT',
  'NO_DISAGREEMENT'
];
const RESOLUTION_BASES: LabResolutionBasis[] = [
  'EVIDENCE',
  'ASSUMPTION',
  'PREFERENCE',
  'INSUFFICIENT_INFORMATION',
  'NO_MATERIAL_ISSUE'
];
const EVALUATION_KINDS: LabEvaluationKind[] = [
  'OBJECTIVE',
  'MISSING_INFORMATION',
  'PLURALISTIC'
];

const MAX_COLLECTION_LENGTH = 64;
const MAX_SHORT_TEXT_LENGTH = 600;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export type LabValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: LabValidationError[] };

/**
 * Public information available to the actor for this exact call. Contextual
 * validation is deliberately separate from the reusable JSON shape: a
 * syntactically valid id is not necessarily an id the actor was allowed to
 * cite or target.
 */
export interface LabPublicOutputValidationContext {
  participantCase: LabParticipantCase;
  visibleArtifacts: readonly LabArtifactRecord[];
  intervention?: {
    fixedInitial: { artifactId: string };
    artifacts: readonly Record<string, unknown>[];
  };
}

/**
 * Provider-facing JSON Schema for the public contract. Every object is closed,
 * so analysis/rationale/scratchpad fields cannot silently become part of the
 * stored evaluation artifact.
 */
export const LAB_PUBLIC_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'status',
    'answer',
    'claims',
    'assumptions',
    'issues',
    'responses',
    'disagreements',
    'resolution',
    'userQuestions',
    'confidence'
  ],
  properties: {
    schemaVersion: { type: 'string', const: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION },
    status: { type: 'string', enum: OUTPUT_STATUSES },
    answer: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'values', 'selectedOptionIds'],
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: MAX_SHORT_TEXT_LENGTH },
        values: {
          type: 'array',
          maxItems: MAX_COLLECTION_LENGTH,
          items: { type: 'string', minLength: 1, maxLength: 120 }
        },
        selectedOptionIds: { type: 'array', maxItems: MAX_COLLECTION_LENGTH, items: idSchema() }
      }
    },
    claims: {
      type: 'array',
      maxItems: MAX_COLLECTION_LENGTH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'propositionId',
          'topicId',
          'stance',
          'statement',
          'evidence',
          'assumptionIds',
          'confidence'
        ],
        properties: {
          id: idSchema(),
          propositionId: idSchema(),
          topicId: idSchema(),
          stance: { type: 'string', enum: CLAIM_STANCES },
          statement: shortTextSchema(),
          evidence: evidenceArraySchema(),
          assumptionIds: idArraySchema(),
          confidence: confidenceSchema()
        }
      }
    },
    assumptions: {
      type: 'array',
      maxItems: MAX_COLLECTION_LENGTH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'statement', 'status', 'affectsClaimIds'],
        properties: {
          id: idSchema(),
          statement: shortTextSchema(),
          status: { type: 'string', enum: ASSUMPTION_STATUSES },
          affectsClaimIds: idArraySchema()
        }
      }
    },
    issues: {
      type: 'array',
      maxItems: MAX_COLLECTION_LENGTH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'targetArtifactId',
          'targetPropositionId',
          'kind',
          'severity',
          'statement',
          'evidence',
          'confidence'
        ],
        properties: {
          id: idSchema(),
          targetArtifactId: idSchema(),
          targetPropositionId: idSchema(),
          kind: { type: 'string', enum: ISSUE_KINDS },
          severity: { type: 'string', enum: ISSUE_SEVERITIES },
          statement: shortTextSchema(),
          evidence: evidenceArraySchema(),
          confidence: confidenceSchema()
        }
      }
    },
    responses: {
      type: 'array',
      maxItems: MAX_COLLECTION_LENGTH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'targetArtifactId',
          'targetIssueId',
          'disposition',
          'statement',
          'evidence',
          'changedClaimIds'
        ],
        properties: {
          id: idSchema(),
          targetArtifactId: idSchema(),
          targetIssueId: idSchema(),
          disposition: { type: 'string', enum: RESPONSE_DISPOSITIONS },
          statement: shortTextSchema(),
          evidence: evidenceArraySchema(),
          changedClaimIds: idArraySchema()
        }
      }
    },
    disagreements: {
      type: 'array',
      maxItems: MAX_COLLECTION_LENGTH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'propositionIds',
          'participantArtifactIds',
          'status',
          'summary',
          'evidence',
          'cruxId'
        ],
        properties: {
          id: idSchema(),
          propositionIds: idArraySchema(),
          participantArtifactIds: idArraySchema(),
          status: { type: 'string', enum: DISAGREEMENT_STATUSES },
          summary: shortTextSchema(),
          evidence: evidenceArraySchema(),
          cruxId: {
            type: ['string', 'null'],
            pattern: ID_PATTERN.source,
            maxLength: 120,
            description:
              'Matching userQuestions[].cruxId for NEEDS_USER_INPUT; otherwise null.'
          }
        }
      }
    },
    resolution: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'basis', 'summary', 'resolvedIssueIds', 'unresolvedIssueIds'],
      properties: {
        status: { type: 'string', enum: RESOLUTION_STATUSES },
        basis: { type: 'string', enum: RESOLUTION_BASES },
        summary: shortTextSchema(),
        resolvedIssueIds: idArraySchema(),
        unresolvedIssueIds: idArraySchema()
      }
    },
    userQuestions: {
      type: 'array',
      maxItems: MAX_COLLECTION_LENGTH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'cruxId', 'question', 'propositionIds'],
        properties: {
          id: idSchema(),
          cruxId: idSchema(),
          question: shortTextSchema(),
          propositionIds: idArraySchema()
        }
      }
    },
    confidence: confidenceSchema()
  }
} as const;

export function validateLabPublicOutput(value: unknown): LabValidationResult<LabPublicOutput> {
  const errors: LabValidationError[] = [];
  const root = requireRecord(
    value,
    '$',
    [
      'schemaVersion',
      'status',
      'answer',
      'claims',
      'assumptions',
      'issues',
      'responses',
      'disagreements',
      'resolution',
      'userQuestions',
      'confidence'
    ],
    [],
    errors
  );
  if (!root) return invalid(errors);

  requireConstant(root.schemaVersion, LAB_PUBLIC_OUTPUT_SCHEMA_VERSION, '$.schemaVersion', errors);
  requireEnum(root.status, OUTPUT_STATUSES, '$.status', errors);
  validateAnswer(root.answer, errors);
  validateClaims(root.claims, errors);
  validateAssumptions(root.assumptions, errors);
  validateIssues(root.issues, errors);
  validateResponses(root.responses, errors);
  validateDisagreements(root.disagreements, errors);
  validateResolution(root.resolution, errors);
  validateUserQuestions(root.userQuestions, errors);
  requireConfidence(root.confidence, '$.confidence', errors);
  validatePublicOutputReferences(root, errors);

  return errors.length > 0
    ? invalid(errors)
    : { ok: true, value: value as LabPublicOutput };
}

/**
 * Validates every externally meaningful id against the exact case and public
 * artifacts visible to one call. This prevents well-shaped hallucinated
 * references from entering scoring or a later participant prompt.
 */
export function validateLabPublicOutputContext(
  output: LabPublicOutput,
  context: LabPublicOutputValidationContext
): LabValidationError[] {
  const errors: LabValidationError[] = [];
  const propositions = new Map(
    context.participantCase.propositions.map((proposition) => [proposition.id, proposition])
  );
  const topicIds = new Set(context.participantCase.topics.map((topic) => topic.id));
  const optionIds = new Set(context.participantCase.options.map((option) => option.id));
  const evidenceIds = new Set(context.participantCase.evidence.map((evidence) => evidence.id));
  evidenceIds.add('PROMPT');

  const visibleArtifactIds = new Set<string>(['CASE']);
  const issueIdsByArtifactId = new Map<string, Set<string>>();
  const allVisibleIssueIds = new Set<string>();
  for (const artifact of context.visibleArtifacts) {
    visibleArtifactIds.add(artifact.artifactId);
    const visibleOutput = acceptedLabOutput(artifact);
    const issueIds = new Set(visibleOutput?.issues.map((issue) => issue.id) ?? []);
    issueIdsByArtifactId.set(artifact.artifactId, issueIds);
    issueIds.forEach((id) => allVisibleIssueIds.add(id));
  }

  if (context.intervention) {
    visibleArtifactIds.add(LAB_INITIAL_ARTIFACT_ID);
    issueIdsByArtifactId.set(LAB_INITIAL_ARTIFACT_ID, new Set());
    for (const artifact of context.intervention.artifacts) {
      const artifactId = validContextId(artifact.artifactId);
      const explicitEvidenceId = validContextId(artifact.evidenceId);
      const explicitIssueId = validContextId(artifact.issueId);
      if (artifactId) {
        visibleArtifactIds.add(artifactId);
        // Controlled critique/evidence packets are atomic public artifacts. An
        // actor may address one directly by using its artifact id as the issue
        // id when the fixture does not provide a separate issueId.
        const issueIds = new Set([explicitIssueId ?? artifactId]);
        issueIdsByArtifactId.set(artifactId, issueIds);
        issueIds.forEach((id) => allVisibleIssueIds.add(id));
        evidenceIds.add(artifactId);
      }
      if (explicitEvidenceId) evidenceIds.add(explicitEvidenceId);
    }
  }

  output.answer.selectedOptionIds.forEach((optionId, index) => {
    requireKnownReference(
      optionId,
      optionIds,
      `$.answer.selectedOptionIds[${index}]`,
      'case option',
      errors
    );
  });

  const emittedPropositionIds = new Set<string>();
  const claimIds = new Set(output.claims.map((claim) => claim.id));
  output.claims.forEach((claim, index) => {
    const proposition = propositions.get(claim.propositionId);
    if (!proposition) {
      addError(
        errors,
        `$.claims[${index}].propositionId`,
        'INVALID_REFERENCE',
        `Unknown case proposition id ${claim.propositionId}.`
      );
    } else {
      emittedPropositionIds.add(claim.propositionId);
      if (claim.topicId !== proposition.topicId) {
        addError(
          errors,
          `$.claims[${index}].topicId`,
          'INVALID_REFERENCE',
          `Topic ${claim.topicId} does not own proposition ${claim.propositionId}; expected ${proposition.topicId}.`
        );
      }
    }
    requireKnownReference(
      claim.topicId,
      topicIds,
      `$.claims[${index}].topicId`,
      'case topic',
      errors
    );
    validateContextEvidence(claim.evidence, `$.claims[${index}].evidence`, evidenceIds, errors);
  });
  for (const propositionId of propositions.keys()) {
    if (!emittedPropositionIds.has(propositionId)) {
      addError(
        errors,
        '$.claims',
        'MISSING_FIELD',
        `Missing the required claim for case proposition ${propositionId}.`
      );
    }
  }

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
      new Set(propositions.keys()),
      `$.issues[${index}].targetPropositionId`,
      'case proposition',
      errors
    );
    validateContextEvidence(issue.evidence, `$.issues[${index}].evidence`, evidenceIds, errors);
  });

  output.responses.forEach((response, index) => {
    const targetPath = `$.responses[${index}].targetArtifactId`;
    requireKnownReference(
      response.targetArtifactId,
      visibleArtifactIds,
      targetPath,
      'visible artifact',
      errors
    );
    const targetIssues = issueIdsByArtifactId.get(response.targetArtifactId);
    if (!targetIssues?.has(response.targetIssueId)) {
      addError(
        errors,
        `$.responses[${index}].targetIssueId`,
        'INVALID_REFERENCE',
        `Issue ${response.targetIssueId} is not present in visible artifact ${response.targetArtifactId}.`
      );
    }
    response.changedClaimIds.forEach((claimId, claimIndex) => {
      requireKnownReference(
        claimId,
        claimIds,
        `$.responses[${index}].changedClaimIds[${claimIndex}]`,
        'current output claim',
        errors
      );
    });
    validateContextEvidence(
      response.evidence,
      `$.responses[${index}].evidence`,
      evidenceIds,
      errors
    );
  });

  output.disagreements.forEach((disagreement, index) => {
    disagreement.propositionIds.forEach((propositionId, propositionIndex) => {
      requireKnownReference(
        propositionId,
        new Set(propositions.keys()),
        `$.disagreements[${index}].propositionIds[${propositionIndex}]`,
        'case proposition',
        errors
      );
    });
    disagreement.participantArtifactIds.forEach((artifactId, artifactIndex) => {
      requireKnownReference(
        artifactId,
        visibleArtifactIds,
        `$.disagreements[${index}].participantArtifactIds[${artifactIndex}]`,
        'visible artifact',
        errors
      );
    });
    validateContextEvidence(
      disagreement.evidence,
      `$.disagreements[${index}].evidence`,
      evidenceIds,
      errors
    );
  });

  const resolvableIssueIds = new Set([
    ...allVisibleIssueIds,
    ...output.issues.map((issue) => issue.id)
  ]);
  output.resolution.resolvedIssueIds.forEach((issueId, index) => {
    requireKnownReference(
      issueId,
      resolvableIssueIds,
      `$.resolution.resolvedIssueIds[${index}]`,
      'visible or current issue',
      errors
    );
  });
  const resolvedIssueIds = new Set(output.resolution.resolvedIssueIds);
  output.resolution.unresolvedIssueIds.forEach((issueId, index) => {
    requireKnownReference(
      issueId,
      resolvableIssueIds,
      `$.resolution.unresolvedIssueIds[${index}]`,
      'visible or current issue',
      errors
    );
    if (resolvedIssueIds.has(issueId)) {
      addError(
        errors,
        `$.resolution.unresolvedIssueIds[${index}]`,
        'INVALID_REFERENCE',
        `Issue ${issueId} cannot be both resolved and unresolved.`
      );
    }
  });

  output.userQuestions.forEach((question, index) => {
    question.propositionIds.forEach((propositionId, propositionIndex) => {
      requireKnownReference(
        propositionId,
        new Set(propositions.keys()),
        `$.userQuestions[${index}].propositionIds[${propositionIndex}]`,
        'case proposition',
        errors
      );
    });
  });

  return errors;
}

export function validateLabParticipantCase(value: unknown): LabValidationResult<LabParticipantCase> {
  const errors: LabValidationError[] = [];
  const root = requireRecord(
    value,
    '$',
    ['schemaVersion', 'caseId', 'question', 'evidence', 'propositions', 'options', 'topics'],
    [],
    errors
  );
  if (!root) return invalid(errors);
  requireConstant(
    root.schemaVersion,
    LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    '$.schemaVersion',
    errors
  );
  requireId(root.caseId, '$.caseId', errors);
  requireString(root.question, '$.question', errors, 2_000);
  validateSimpleIdTextArray(root.evidence, '$.evidence', 'text', errors, true);
  validatePropositions(root.propositions, errors);
  validateSimpleIdTextArray(root.options, '$.options', 'text', errors, true);
  validateSimpleIdTextArray(root.topics, '$.topics', 'label', errors, false);
  validateParticipantReferences(root, errors);
  return errors.length > 0
    ? invalid(errors)
    : { ok: true, value: value as LabParticipantCase };
}

export function validateLabOracleCase(value: unknown): LabValidationResult<LabOracleCase> {
  const errors: LabValidationError[] = [];
  const root = requireRecord(
    value,
    '$',
    [
      'schemaVersion',
      'caseId',
      'partition',
      'domain',
      'evaluationKind',
      'mechanismTags',
      'acceptableStatuses',
      'acceptedAnswerValueSets',
      'acceptedAnswerOptionSets',
      'propositionExpectations',
      'validCritiques',
      'sharedErrorPropositionIds',
      'disagreementRequirements',
      'requiredUserQuestionCruxIds'
    ],
    [],
    errors
  );
  if (!root) return invalid(errors);
  requireConstant(root.schemaVersion, LAB_ORACLE_CASE_SCHEMA_VERSION, '$.schemaVersion', errors);
  requireId(root.caseId, '$.caseId', errors);
  requireEnum(root.partition, ['DEVELOPMENT', 'CONFIRMATION'], '$.partition', errors);
  requireString(root.domain, '$.domain', errors, 120);
  requireEnum(root.evaluationKind, EVALUATION_KINDS, '$.evaluationKind', errors);
  validateStringArray(root.mechanismTags, '$.mechanismTags', errors, false);
  validateEnumArray(root.acceptableStatuses, OUTPUT_STATUSES, '$.acceptableStatuses', errors, false);
  validateNestedStringArrays(
    root.acceptedAnswerValueSets,
    '$.acceptedAnswerValueSets',
    errors,
    true
  );
  validateNestedIdArrays(root.acceptedAnswerOptionSets, '$.acceptedAnswerOptionSets', errors, true);
  validatePropositionExpectations(root.propositionExpectations, errors);
  validateValidCritiques(root.validCritiques, errors);
  validateIdArray(root.sharedErrorPropositionIds, '$.sharedErrorPropositionIds', errors);
  validateDisagreementRequirements(root.disagreementRequirements, errors);
  validateIdArray(
    root.requiredUserQuestionCruxIds,
    '$.requiredUserQuestionCruxIds',
    errors
  );
  return errors.length > 0
    ? invalid(errors)
    : { ok: true, value: value as LabOracleCase };
}

export function validateLabCasePair(
  participantCase: LabParticipantCase,
  oracleCase: LabOracleCase
): LabValidationError[] {
  const errors: LabValidationError[] = [];
  if (participantCase.caseId !== oracleCase.caseId) {
    addError(errors, '$.caseId', 'INVALID_REFERENCE', 'Participant and oracle case ids differ.');
  }
  const propositionIds = new Set(participantCase.propositions.map((item) => item.id));
  const evidenceIds = new Set(participantCase.evidence.map((item) => item.id));
  const optionIds = new Set(participantCase.options.map((item) => item.id));
  const expectationIds = oracleCase.propositionExpectations.map((item) => item.propositionId);
  for (const propositionId of propositionIds) {
    if (!expectationIds.includes(propositionId)) {
      addError(
        errors,
        '$.propositionExpectations',
        'INVALID_REFERENCE',
        `No oracle expectation exists for proposition ${propositionId}.`
      );
    }
  }
  expectationIds.forEach((propositionId, index) => {
    if (!propositionIds.has(propositionId)) {
      addError(
        errors,
        `$.propositionExpectations[${index}].propositionId`,
        'INVALID_REFERENCE',
        `Unknown participant proposition ${propositionId}.`
      );
    }
  });
  oracleCase.propositionExpectations.forEach((expectation, expectationIndex) => {
    expectation.requiredEvidenceSets.forEach((set, setIndex) => {
      set.forEach((evidenceId, evidenceIndex) => {
        if (!evidenceIds.has(evidenceId)) {
          addError(
            errors,
            `$.propositionExpectations[${expectationIndex}].requiredEvidenceSets[${setIndex}][${evidenceIndex}]`,
            'INVALID_REFERENCE',
            `Unknown participant evidence ${evidenceId}.`
          );
        }
      });
    });
  });
  oracleCase.acceptedAnswerOptionSets.forEach((set, setIndex) => {
    set.forEach((optionId, optionIndex) => {
      if (!optionIds.has(optionId)) {
        addError(
          errors,
          `$.acceptedAnswerOptionSets[${setIndex}][${optionIndex}]`,
          'INVALID_REFERENCE',
          `Unknown participant option ${optionId}.`
        );
      }
    });
  });
  oracleCase.validCritiques.forEach((critique, index) => {
    if (!propositionIds.has(critique.targetPropositionId)) {
      addError(
        errors,
        `$.validCritiques[${index}].targetPropositionId`,
        'INVALID_REFERENCE',
        `Unknown participant proposition ${critique.targetPropositionId}.`
      );
    }
  });
  oracleCase.sharedErrorPropositionIds.forEach((propositionId, index) => {
    if (!propositionIds.has(propositionId)) {
      addError(
        errors,
        `$.sharedErrorPropositionIds[${index}]`,
        'INVALID_REFERENCE',
        `Unknown participant proposition ${propositionId}.`
      );
    }
  });
  oracleCase.disagreementRequirements.forEach((requirement, requirementIndex) => {
    requirement.propositionIds.forEach((propositionId, propositionIndex) => {
      if (!propositionIds.has(propositionId)) {
        addError(
          errors,
          `$.disagreementRequirements[${requirementIndex}].propositionIds[${propositionIndex}]`,
          'INVALID_REFERENCE',
          `Unknown participant proposition ${propositionId}.`
        );
      }
    });
    if (
      requirement.requiredCruxId &&
      !oracleCase.requiredUserQuestionCruxIds.includes(requirement.requiredCruxId)
    ) {
      addError(
        errors,
        `$.disagreementRequirements[${requirementIndex}].requiredCruxId`,
        'INVALID_REFERENCE',
        `Crux ${requirement.requiredCruxId} is not a required user-question crux.`
      );
    }
  });
  return errors;
}

export function parseLabRawOutputAttempt(
  input: LabOutputAttemptInput,
  purpose: LabRawOutputAttempt['purpose'],
  attemptNumber: 1 | 2,
  context?: LabPublicOutputValidationContext
): LabRawOutputAttempt {
  if (input.executionFailure) {
    return {
      attemptNumber,
      purpose,
      callId: input.callId,
      rawText: input.rawText,
      charged: input.charged ?? true,
      usage: input.usage,
      latencyMs: input.latencyMs,
      executionFailure: input.executionFailure,
      validationErrors: []
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(input.rawText.trim());
  } catch (error) {
    return {
      attemptNumber,
      purpose,
      callId: input.callId,
      rawText: input.rawText,
      charged: input.charged ?? true,
      usage: input.usage,
      latencyMs: input.latencyMs,
      validationErrors: [
        {
          path: '$',
          code: 'INVALID_JSON',
          message: error instanceof Error ? error.message : 'Output is not valid JSON.'
        }
      ]
    };
  }

  const validation = validateLabPublicOutput(decoded);
  const contextualErrors = validation.ok && context
    ? validateLabPublicOutputContext(validation.value, context)
    : [];
  const valid = validation.ok && contextualErrors.length === 0;
  return {
    attemptNumber,
    purpose,
    callId: input.callId,
    rawText: input.rawText,
    charged: input.charged ?? true,
    usage: input.usage,
    latencyMs: input.latencyMs,
    validationErrors: validation.ok ? contextualErrors : validation.errors,
    output: valid ? validation.value : undefined
  };
}

/**
 * Records one primary call and, only when primary output is unusable, at most
 * one separately charged schema-repair call.
 */
export function createLabOutputRecord(
  primary: LabOutputAttemptInput,
  repair?: LabOutputAttemptInput,
  context?: LabPublicOutputValidationContext
): LabOutputRecord {
  const first = parseLabRawOutputAttempt(primary, 'PRIMARY', 1, context);
  if (first.output && repair) {
    throw new Error('A schema repair must not run after a valid primary output.');
  }
  const attempts: LabRawOutputAttempt[] = [first];
  if (!first.output && repair) {
    if (repair.charged === false) {
      throw new Error('A schema-repair attempt is a provider call and must be charged.');
    }
    attempts.push(parseLabRawOutputAttempt(repair, 'SCHEMA_REPAIR', 2, context));
  }
  const accepted = attempts.find((attempt) => attempt.output);
  return {
    attempts,
    acceptedAttemptNumber: accepted?.attemptNumber ?? null,
    chargedCalls: attempts.filter((attempt) => attempt.charged).length,
    repairAttempted: attempts.length === 2,
    status: accepted ? 'VALID' : 'INVALID'
  };
}

export function acceptedLabOutput(
  artifact: Pick<LabArtifactRecord, 'output'>
): LabPublicOutput | undefined {
  if (artifact.output.acceptedAttemptNumber === null) return undefined;
  return artifact.output.attempts.find(
    (attempt) => attempt.attemptNumber === artifact.output.acceptedAttemptNumber
  )?.output;
}

function validateAnswer(value: unknown, errors: LabValidationError[]): void {
  const record = requireRecord(
    value,
    '$.answer',
    ['summary', 'values', 'selectedOptionIds'],
    [],
    errors
  );
  if (!record) return;
  requireString(record.summary, '$.answer.summary', errors);
  validateStringArray(record.values, '$.answer.values', errors, true);
  validateIdArray(record.selectedOptionIds, '$.answer.selectedOptionIds', errors);
}

function validateClaims(value: unknown, errors: LabValidationError[]): void {
  const items = requireArray(value, '$.claims', errors);
  if (!items) return;
  const ids: string[] = [];
  const propositionIds: string[] = [];
  items.forEach((item, index) => {
    const path = `$.claims[${index}]`;
    const record = requireRecord(
      item,
      path,
      [
        'id',
        'propositionId',
        'topicId',
        'stance',
        'statement',
        'evidence',
        'assumptionIds',
        'confidence'
      ],
      [],
      errors
    );
    if (!record) return;
    requireId(record.id, `${path}.id`, errors);
    requireId(record.propositionId, `${path}.propositionId`, errors);
    requireId(record.topicId, `${path}.topicId`, errors);
    requireEnum(record.stance, CLAIM_STANCES, `${path}.stance`, errors);
    requireString(record.statement, `${path}.statement`, errors);
    validateEvidenceReferences(record.evidence, `${path}.evidence`, errors);
    validateIdArray(record.assumptionIds, `${path}.assumptionIds`, errors);
    requireConfidence(record.confidence, `${path}.confidence`, errors);
    if (typeof record.id === 'string') ids.push(record.id);
    if (typeof record.propositionId === 'string') propositionIds.push(record.propositionId);
  });
  reportDuplicates(ids, '$.claims', 'claim id', errors);
  reportDuplicates(propositionIds, '$.claims', 'proposition id', errors);
}

function validateAssumptions(value: unknown, errors: LabValidationError[]): void {
  const items = requireArray(value, '$.assumptions', errors);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    const path = `$.assumptions[${index}]`;
    const record = requireRecord(
      item,
      path,
      ['id', 'statement', 'status', 'affectsClaimIds'],
      [],
      errors
    );
    if (!record) return;
    requireId(record.id, `${path}.id`, errors);
    requireString(record.statement, `${path}.statement`, errors);
    requireEnum(record.status, ASSUMPTION_STATUSES, `${path}.status`, errors);
    validateIdArray(record.affectsClaimIds, `${path}.affectsClaimIds`, errors);
    if (typeof record.id === 'string') ids.push(record.id);
  });
  reportDuplicates(ids, '$.assumptions', 'assumption id', errors);
}

function validateIssues(value: unknown, errors: LabValidationError[]): void {
  const items = requireArray(value, '$.issues', errors);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    const path = `$.issues[${index}]`;
    const record = requireRecord(
      item,
      path,
      [
        'id',
        'targetArtifactId',
        'targetPropositionId',
        'kind',
        'severity',
        'statement',
        'evidence',
        'confidence'
      ],
      [],
      errors
    );
    if (!record) return;
    requireId(record.id, `${path}.id`, errors);
    requireId(record.targetArtifactId, `${path}.targetArtifactId`, errors);
    requireId(record.targetPropositionId, `${path}.targetPropositionId`, errors);
    requireEnum(record.kind, ISSUE_KINDS, `${path}.kind`, errors);
    requireEnum(record.severity, ISSUE_SEVERITIES, `${path}.severity`, errors);
    requireString(record.statement, `${path}.statement`, errors);
    validateEvidenceReferences(record.evidence, `${path}.evidence`, errors);
    requireConfidence(record.confidence, `${path}.confidence`, errors);
    if (typeof record.id === 'string') ids.push(record.id);
  });
  reportDuplicates(ids, '$.issues', 'issue id', errors);
}

function validateResponses(value: unknown, errors: LabValidationError[]): void {
  const items = requireArray(value, '$.responses', errors);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    const path = `$.responses[${index}]`;
    const record = requireRecord(
      item,
      path,
      [
        'id',
        'targetArtifactId',
        'targetIssueId',
        'disposition',
        'statement',
        'evidence',
        'changedClaimIds'
      ],
      [],
      errors
    );
    if (!record) return;
    requireId(record.id, `${path}.id`, errors);
    requireId(record.targetArtifactId, `${path}.targetArtifactId`, errors);
    requireId(record.targetIssueId, `${path}.targetIssueId`, errors);
    requireEnum(record.disposition, RESPONSE_DISPOSITIONS, `${path}.disposition`, errors);
    requireString(record.statement, `${path}.statement`, errors);
    validateEvidenceReferences(record.evidence, `${path}.evidence`, errors);
    validateIdArray(record.changedClaimIds, `${path}.changedClaimIds`, errors);
    if (typeof record.id === 'string') ids.push(record.id);
  });
  reportDuplicates(ids, '$.responses', 'response id', errors);
}

function validateDisagreements(value: unknown, errors: LabValidationError[]): void {
  const items = requireArray(value, '$.disagreements', errors);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    const path = `$.disagreements[${index}]`;
    const record = requireRecord(
      item,
      path,
      [
        'id',
        'propositionIds',
        'participantArtifactIds',
        'status',
        'summary',
        'evidence',
        'cruxId'
      ],
      [],
      errors
    );
    if (!record) return;
    requireId(record.id, `${path}.id`, errors);
    validateIdArray(record.propositionIds, `${path}.propositionIds`, errors, false);
    validateIdArray(record.participantArtifactIds, `${path}.participantArtifactIds`, errors, false);
    requireEnum(record.status, DISAGREEMENT_STATUSES, `${path}.status`, errors);
    requireString(record.summary, `${path}.summary`, errors);
    validateEvidenceReferences(record.evidence, `${path}.evidence`, errors);
    if (record.cruxId !== null) requireId(record.cruxId, `${path}.cruxId`, errors);
    if (typeof record.id === 'string') ids.push(record.id);
  });
  reportDuplicates(ids, '$.disagreements', 'disagreement id', errors);
}

function validateResolution(value: unknown, errors: LabValidationError[]): void {
  const record = requireRecord(
    value,
    '$.resolution',
    ['status', 'basis', 'summary', 'resolvedIssueIds', 'unresolvedIssueIds'],
    [],
    errors
  );
  if (!record) return;
  requireEnum(record.status, RESOLUTION_STATUSES, '$.resolution.status', errors);
  requireEnum(record.basis, RESOLUTION_BASES, '$.resolution.basis', errors);
  requireString(record.summary, '$.resolution.summary', errors);
  validateIdArray(record.resolvedIssueIds, '$.resolution.resolvedIssueIds', errors);
  validateIdArray(record.unresolvedIssueIds, '$.resolution.unresolvedIssueIds', errors);
}

function validateUserQuestions(value: unknown, errors: LabValidationError[]): void {
  const items = requireArray(value, '$.userQuestions', errors);
  if (!items) return;
  const ids: string[] = [];
  const cruxIds: string[] = [];
  items.forEach((item, index) => {
    const path = `$.userQuestions[${index}]`;
    const record = requireRecord(
      item,
      path,
      ['id', 'cruxId', 'question', 'propositionIds'],
      [],
      errors
    );
    if (!record) return;
    requireId(record.id, `${path}.id`, errors);
    requireId(record.cruxId, `${path}.cruxId`, errors);
    requireString(record.question, `${path}.question`, errors);
    validateIdArray(record.propositionIds, `${path}.propositionIds`, errors, false);
    if (typeof record.id === 'string') ids.push(record.id);
    if (typeof record.cruxId === 'string') cruxIds.push(record.cruxId);
  });
  reportDuplicates(ids, '$.userQuestions', 'question id', errors);
  reportDuplicates(cruxIds, '$.userQuestions', 'crux id', errors);
}

function validateEvidenceReferences(
  value: unknown,
  path: string,
  errors: LabValidationError[]
): void {
  const items = requireArray(value, path, errors);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = requireRecord(
      item,
      itemPath,
      ['evidenceId', 'relation', 'note'],
      [],
      errors
    );
    if (!record) return;
    requireId(record.evidenceId, `${itemPath}.evidenceId`, errors);
    requireEnum(record.relation, EVIDENCE_RELATIONS, `${itemPath}.relation`, errors);
    requireString(record.note, `${itemPath}.note`, errors, 300);
    if (typeof record.evidenceId === 'string') ids.push(record.evidenceId);
  });
  reportDuplicates(ids, path, 'evidence id', errors);
}

function validateContextEvidence(
  references: readonly { evidenceId: string }[],
  path: string,
  allowedEvidenceIds: ReadonlySet<string>,
  errors: LabValidationError[]
): void {
  references.forEach((reference, index) => {
    requireKnownReference(
      reference.evidenceId,
      allowedEvidenceIds,
      `${path}[${index}].evidenceId`,
      'supplied evidence',
      errors
    );
  });
}

function requireKnownReference(
  value: string,
  allowed: ReadonlySet<string>,
  path: string,
  label: string,
  errors: LabValidationError[]
): void {
  if (!allowed.has(value)) {
    addError(errors, path, 'INVALID_REFERENCE', `Unknown ${label} id ${value}.`);
  }
}

function validContextId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}

function validatePublicOutputReferences(
  root: Record<string, unknown>,
  errors: LabValidationError[]
): void {
  if (!Array.isArray(root.claims) || !Array.isArray(root.assumptions)) return;
  const claimIds = new Set(
    root.claims
      .filter(isRecord)
      .map((claim) => claim.id)
      .filter((id): id is string => typeof id === 'string')
  );
  const assumptionIds = new Set(
    root.assumptions
      .filter(isRecord)
      .map((assumption) => assumption.id)
      .filter((id): id is string => typeof id === 'string')
  );
  root.claims.forEach((claim, claimIndex) => {
    if (!isRecord(claim) || !Array.isArray(claim.assumptionIds)) return;
    claim.assumptionIds.forEach((id, idIndex) => {
      if (typeof id === 'string' && !assumptionIds.has(id)) {
        addError(
          errors,
          `$.claims[${claimIndex}].assumptionIds[${idIndex}]`,
          'INVALID_REFERENCE',
          `Unknown assumption id ${id}.`
        );
      }
    });
  });
  root.assumptions.forEach((assumption, assumptionIndex) => {
    if (!isRecord(assumption) || !Array.isArray(assumption.affectsClaimIds)) return;
    assumption.affectsClaimIds.forEach((id, idIndex) => {
      if (typeof id === 'string' && !claimIds.has(id)) {
        addError(
          errors,
          `$.assumptions[${assumptionIndex}].affectsClaimIds[${idIndex}]`,
          'INVALID_REFERENCE',
          `Unknown claim id ${id}.`
        );
      }
    });
  });
}

function validatePropositions(value: unknown, errors: LabValidationError[]): void {
  const items = requireArray(value, '$.propositions', errors, false);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    const path = `$.propositions[${index}]`;
    const record = requireRecord(item, path, ['id', 'topicId', 'text'], [], errors);
    if (!record) return;
    requireId(record.id, `${path}.id`, errors);
    requireId(record.topicId, `${path}.topicId`, errors);
    requireString(record.text, `${path}.text`, errors);
    if (typeof record.id === 'string') ids.push(record.id);
  });
  reportDuplicates(ids, '$.propositions', 'proposition id', errors);
}

function validateParticipantReferences(
  root: Record<string, unknown>,
  errors: LabValidationError[]
): void {
  if (!Array.isArray(root.topics) || !Array.isArray(root.propositions)) return;
  const topicIds = new Set(
    root.topics
      .filter(isRecord)
      .map((topic) => topic.id)
      .filter((id): id is string => typeof id === 'string')
  );
  root.propositions.forEach((proposition, index) => {
    if (!isRecord(proposition) || typeof proposition.topicId !== 'string') return;
    if (!topicIds.has(proposition.topicId)) {
      addError(
        errors,
        `$.propositions[${index}].topicId`,
        'INVALID_REFERENCE',
        `Unknown topic id ${proposition.topicId}.`
      );
    }
  });
}

function validatePropositionExpectations(
  value: unknown,
  errors: LabValidationError[]
): void {
  const items = requireArray(value, '$.propositionExpectations', errors, false);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    const path = `$.propositionExpectations[${index}]`;
    const record = requireRecord(
      item,
      path,
      ['propositionId', 'acceptableStances', 'requiredEvidenceSets'],
      [],
      errors
    );
    if (!record) return;
    requireId(record.propositionId, `${path}.propositionId`, errors);
    validateEnumArray(
      record.acceptableStances,
      CLAIM_STANCES,
      `${path}.acceptableStances`,
      errors,
      false
    );
    validateNestedIdArrays(
      record.requiredEvidenceSets,
      `${path}.requiredEvidenceSets`,
      errors,
      true
    );
    if (typeof record.propositionId === 'string') ids.push(record.propositionId);
  });
  reportDuplicates(ids, '$.propositionExpectations', 'proposition id', errors);
}

function validateValidCritiques(value: unknown, errors: LabValidationError[]): void {
  const items = requireArray(value, '$.validCritiques', errors);
  if (!items) return;
  items.forEach((item, index) => {
    const path = `$.validCritiques[${index}]`;
    const record = requireRecord(
      item,
      path,
      ['targetPropositionId', 'kinds', 'severities'],
      [],
      errors
    );
    if (!record) return;
    requireId(record.targetPropositionId, `${path}.targetPropositionId`, errors);
    validateEnumArray(record.kinds, ISSUE_KINDS, `${path}.kinds`, errors, false);
    validateEnumArray(record.severities, ISSUE_SEVERITIES, `${path}.severities`, errors, false);
  });
}

function validateDisagreementRequirements(
  value: unknown,
  errors: LabValidationError[]
): void {
  const items = requireArray(value, '$.disagreementRequirements', errors);
  if (!items) return;
  items.forEach((item, index) => {
    const path = `$.disagreementRequirements[${index}]`;
    const record = requireRecord(
      item,
      path,
      ['propositionIds', 'acceptableStatuses'],
      ['requiredCruxId'],
      errors
    );
    if (!record) return;
    validateIdArray(record.propositionIds, `${path}.propositionIds`, errors, false);
    validateEnumArray(
      record.acceptableStatuses,
      DISAGREEMENT_STATUSES,
      `${path}.acceptableStatuses`,
      errors,
      false
    );
    if (record.requiredCruxId !== undefined) {
      requireId(record.requiredCruxId, `${path}.requiredCruxId`, errors);
    }
  });
}

function validateSimpleIdTextArray(
  value: unknown,
  path: string,
  textKey: 'text' | 'label',
  errors: LabValidationError[],
  allowEmpty: boolean
): void {
  const items = requireArray(value, path, errors, allowEmpty);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = requireRecord(item, itemPath, ['id', textKey], [], errors);
    if (!record) return;
    requireId(record.id, `${itemPath}.id`, errors);
    requireString(record[textKey], `${itemPath}.${textKey}`, errors);
    if (typeof record.id === 'string') ids.push(record.id);
  });
  reportDuplicates(ids, path, 'id', errors);
}

function requireRecord(
  value: unknown,
  path: string,
  requiredKeys: string[],
  optionalKeys: string[],
  errors: LabValidationError[]
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    addError(errors, path, 'INVALID_TYPE', 'Expected an object.');
    return undefined;
  }
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  requiredKeys.forEach((key) => {
    if (!(key in value)) {
      addError(errors, `${path}.${key}`, 'MISSING_FIELD', `Missing required field ${key}.`);
    }
  });
  Object.keys(value).forEach((key) => {
    if (!allowedKeys.has(key)) {
      addError(errors, `${path}.${key}`, 'UNKNOWN_FIELD', `Unknown field ${key}.`);
    }
  });
  return value;
}

function requireArray(
  value: unknown,
  path: string,
  errors: LabValidationError[],
  allowEmpty = true
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, 'INVALID_TYPE', 'Expected an array.');
    return undefined;
  }
  if (!allowEmpty && value.length === 0) {
    addError(errors, path, 'OUT_OF_RANGE', 'Array must contain at least one item.');
  }
  if (value.length > MAX_COLLECTION_LENGTH) {
    addError(
      errors,
      path,
      'OUT_OF_RANGE',
      `Array may contain at most ${MAX_COLLECTION_LENGTH} items.`
    );
  }
  return value;
}

function requireId(value: unknown, path: string, errors: LabValidationError[]): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    addError(errors, path, 'INVALID_VALUE', 'Expected a stable id of at most 120 characters.');
  }
}

function requireString(
  value: unknown,
  path: string,
  errors: LabValidationError[],
  maxLength = MAX_SHORT_TEXT_LENGTH
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    addError(errors, path, 'INVALID_TYPE', 'Expected a non-empty string.');
    return;
  }
  if (value.length > maxLength) {
    addError(errors, path, 'OUT_OF_RANGE', `String may contain at most ${maxLength} characters.`);
  }
}

function requireConfidence(value: unknown, path: string, errors: LabValidationError[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addError(errors, path, 'INVALID_TYPE', 'Expected a finite confidence number.');
  } else if (value < 0 || value > 1) {
    addError(errors, path, 'OUT_OF_RANGE', 'Confidence must be between 0 and 1.');
  }
}

function requireConstant(
  value: unknown,
  expected: string,
  path: string,
  errors: LabValidationError[]
): void {
  if (value !== expected) {
    addError(errors, path, 'INVALID_VALUE', `Expected ${expected}.`);
  }
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: LabValidationError[]
): void {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    addError(errors, path, 'INVALID_VALUE', `Expected one of: ${allowed.join(', ')}.`);
  }
}

function validateIdArray(
  value: unknown,
  path: string,
  errors: LabValidationError[],
  allowEmpty = true
): void {
  const items = requireArray(value, path, errors, allowEmpty);
  if (!items) return;
  const ids: string[] = [];
  items.forEach((item, index) => {
    requireId(item, `${path}[${index}]`, errors);
    if (typeof item === 'string') ids.push(item);
  });
  reportDuplicates(ids, path, 'id', errors);
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: LabValidationError[],
  allowEmpty: boolean
): void {
  const items = requireArray(value, path, errors, allowEmpty);
  if (!items) return;
  const values: string[] = [];
  items.forEach((item, index) => {
    requireString(item, `${path}[${index}]`, errors, 120);
    if (typeof item === 'string') values.push(item);
  });
  reportDuplicates(values, path, 'value', errors);
}

function validateEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: LabValidationError[],
  allowEmpty: boolean
): void {
  const items = requireArray(value, path, errors, allowEmpty);
  if (!items) return;
  const values: string[] = [];
  items.forEach((item, index) => {
    requireEnum(item, allowed, `${path}[${index}]`, errors);
    if (typeof item === 'string') values.push(item);
  });
  reportDuplicates(values, path, 'value', errors);
}

function validateNestedIdArrays(
  value: unknown,
  path: string,
  errors: LabValidationError[],
  allowOuterEmpty: boolean
): void {
  const sets = requireArray(value, path, errors, allowOuterEmpty);
  if (!sets) return;
  sets.forEach((set, index) => validateIdArray(set, `${path}[${index}]`, errors, false));
}

function validateNestedStringArrays(
  value: unknown,
  path: string,
  errors: LabValidationError[],
  allowOuterEmpty: boolean
): void {
  const sets = requireArray(value, path, errors, allowOuterEmpty);
  if (!sets) return;
  sets.forEach((set, index) => validateStringArray(set, `${path}[${index}]`, errors, false));
}

function reportDuplicates(
  values: string[],
  path: string,
  label: string,
  errors: LabValidationError[]
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      addError(errors, `${path}[${index}]`, 'DUPLICATE_ID', `Duplicate ${label} ${value}.`);
    }
    seen.add(value);
  });
}

function addError(
  errors: LabValidationError[],
  path: string,
  code: LabValidationError['code'],
  message: string
): void {
  errors.push({ path, code, message });
}

function invalid<T>(errors: LabValidationError[]): LabValidationResult<T> {
  return { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idSchema() {
  return { type: 'string', pattern: ID_PATTERN.source, maxLength: 120 } as const;
}

function shortTextSchema() {
  return { type: 'string', minLength: 1, maxLength: MAX_SHORT_TEXT_LENGTH } as const;
}

function idArraySchema() {
  return {
    type: 'array',
    maxItems: MAX_COLLECTION_LENGTH,
    items: idSchema()
  } as const;
}

function confidenceSchema() {
  return { type: 'number', minimum: 0, maximum: 1 } as const;
}

function evidenceArraySchema() {
  return {
    type: 'array',
    maxItems: MAX_COLLECTION_LENGTH,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['evidenceId', 'relation', 'note'],
      properties: {
        evidenceId: idSchema(),
        relation: { type: 'string', enum: EVIDENCE_RELATIONS },
        note: { type: 'string', minLength: 1, maxLength: 300 }
      }
    }
  } as const;
}
