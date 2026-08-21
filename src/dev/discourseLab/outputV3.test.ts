import { describe, expect, it } from 'vitest';
import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  type LabParticipantCase
} from './contracts';
import {
  LAB_PUBLIC_OUTPUT_V3_JSON_SCHEMA,
  LAB_PUBLIC_OUTPUT_V3_SCHEMA_VERSION,
  acceptedLabPublicOutputV3,
  createLabOutputRecordV3,
  validateLabPublicOutputV3,
  validateLabPublicOutputV3Context,
  validateLabPublicOutputV3Shape,
  type LabPublicOutputV3,
  type LabPublicOutputV3ValidationContext,
  type LabVisibleInterventionArtifactV3
} from './outputV3';

describe('Discourse Protocol Lab public-output-v3 shape', () => {
  it('uses a closed JSON schema and rejects unknown top-level and nested fields', () => {
    expect(allObjectSchemasAreClosed(LAB_PUBLIC_OUTPUT_V3_JSON_SCHEMA)).toBe(true);
    expect(schemaContainsKeyword(LAB_PUBLIC_OUTPUT_V3_JSON_SCHEMA, 'oneOf')).toBe(false);
    expect(strictStructuredOutputSchemaErrors(LAB_PUBLIC_OUTPUT_V3_JSON_SCHEMA)).toEqual([]);

    const topLevel = structuredClone(validOutput()) as LabPublicOutputV3 & {
      rationale?: string;
    };
    topLevel.rationale = 'Private reasoning must not enter the public contract.';
    expect(validateLabPublicOutputV3Shape(topLevel)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.rationale', code: 'UNKNOWN_FIELD' })
        ])
      })
    );

    const nested = structuredClone(validOutput()) as LabPublicOutputV3 & {
      answer: LabPublicOutputV3['answer'] & { analysis?: string };
    };
    nested.answer.analysis = 'Also forbidden.';
    expect(validateLabPublicOutputV3Shape(nested)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.answer.analysis', code: 'UNKNOWN_FIELD' })
        ])
      })
    );
  });

  it('accepts high-confidence underdetermination and rejects out-of-range confidence', () => {
    const output = validOutput();
    output.answer.assessmentConfidence = 0.99;
    output.propositionAssessments[0]!.assessmentConfidence = 0.99;
    expect(validateLabPublicOutputV3(output, context())).toEqual(
      expect.objectContaining({ ok: true })
    );

    output.propositionAssessments[0]!.assessmentConfidence = 1.01;
    expect(validateLabPublicOutputV3(output, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.propositionAssessments[0].assessmentConfidence',
            code: 'OUT_OF_RANGE'
          })
        ])
      })
    );
  });
});

describe('Discourse Protocol Lab public-output-v3 semantics', () => {
  it('separates completion, epistemic state, user action, and information requests', () => {
    const userAction = validOutput();
    expect(validateLabPublicOutputV3(userAction, context())).toEqual(
      expect.objectContaining({ ok: true })
    );

    const completeButUnderdetermined = structuredClone(userAction);
    completeButUnderdetermined.completionDisposition = 'COMPLETE';
    completeButUnderdetermined.resolution.status = 'UNRESOLVED';
    completeButUnderdetermined.informationRequests[0]!.source = 'DOCUMENT';
    completeButUnderdetermined.informationRequests[0]!.blocking = false;
    completeButUnderdetermined.disagreements[0]!.status = 'UNRESOLVED';
    completeButUnderdetermined.disagreements[0]!.informationRequestId = null;
    expect(validateLabPublicOutputV3(completeButUnderdetermined, context())).toEqual(
      expect.objectContaining({ ok: true })
    );

    const actionWithoutRequest = structuredClone(userAction);
    actionWithoutRequest.informationRequests = [];
    actionWithoutRequest.disagreements[0]!.status = 'UNRESOLVED';
    actionWithoutRequest.disagreements[0]!.informationRequestId = null;
    expect(validateLabPublicOutputV3(actionWithoutRequest, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.informationRequests', code: 'MISSING_FIELD' })
        ])
      })
    );

    const falselyResolved = structuredClone(userAction);
    falselyResolved.answer.epistemicState = 'RESOLVED';
    expect(validateLabPublicOutputV3(falselyResolved, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.answer.epistemicState', code: 'INVALID_VALUE' })
        ])
      })
    );
  });

  it('rejects unknown proposition and information-request references', () => {
    const wrongProposition = validOutput();
    wrongProposition.informationRequests[0]!.propositionIds = ['unknown-proposition'];
    expect(validateLabPublicOutputV3(wrongProposition, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.informationRequests[0].propositionIds[0]',
            code: 'INVALID_REFERENCE'
          })
        ])
      })
    );

    const wrongRequest = validOutput();
    wrongRequest.disagreements[0]!.informationRequestId = 'unknown-request';
    expect(validateLabPublicOutputV3(wrongRequest, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.disagreements[0].informationRequestId',
            code: 'INVALID_REFERENCE'
          })
        ])
      })
    );
  });

  it('rejects duplicate assessments of one proposition instead of using the last value', () => {
    const duplicate = validOutput();
    duplicate.propositionAssessments[1] = {
      ...structuredClone(duplicate.propositionAssessments[0]!),
      id: 'assessment-duplicate'
    };

    expect(validateLabPublicOutputV3(duplicate, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.propositionAssessments[1].propositionId',
            code: 'DUPLICATE_ID'
          }),
          expect.objectContaining({
            path: '$.propositionAssessments',
            code: 'MISSING_FIELD'
          })
        ])
      })
    );
  });

  it('requires proposition assessments to use evidence in the asserted direction', () => {
    const wrongDirection = validOutput();
    wrongDirection.propositionAssessments[1]!.factualEvidence[0]!.relation = 'LIMITS';
    expect(validateLabPublicOutputV3(wrongDirection, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.propositionAssessments[1].factualEvidence',
            code: 'INVALID_VALUE'
          })
        ])
      })
    );

    const typedEvidence = validOutput();
    typedEvidence.propositionAssessments[1]!.factualEvidence = [
      { sourceId: 'evidence-1', relation: 'SUPPORTS', note: 'The evidence packet supports p2.' }
    ];
    expect(validateLabPublicOutputV3(typedEvidence, context())).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('rejects duplicate answers, conflicting directions for one source, and duplicate critique responses', () => {
    const duplicateOption = validOutput();
    duplicateOption.answer.selectedOptionIds.push('option-1');
    expect(validateLabPublicOutputV3(duplicateOption, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.answer.selectedOptionIds[1]', code: 'DUPLICATE_ID' })
        ])
      })
    );

    const conflictingEvidence = validOutput();
    conflictingEvidence.propositionAssessments[1]!.factualEvidence.push({
      sourceId: 'case-evidence-1',
      relation: 'CONTRADICTS',
      note: 'The same source cannot be assigned two directions in one assertion.'
    });
    expect(validateLabPublicOutputV3(conflictingEvidence, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.propositionAssessments[1].factualEvidence[1]',
            code: 'DUPLICATE_ID'
          })
        ])
      })
    );

    const duplicateResponse = validOutput();
    duplicateResponse.responses.push({
      ...structuredClone(duplicateResponse.responses[0]!),
      id: 'response-duplicate'
    });
    expect(validateLabPublicOutputV3(duplicateResponse, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.responses[1].targetIssueId',
            code: 'DUPLICATE_ID'
          })
        ])
      })
    );
  });

  it('requires an explicit abstention object exactly when completion abstains', () => {
    const missingObject = validOutput();
    missingObject.completionDisposition = 'ABSTAIN';
    missingObject.resolution.status = 'UNRESOLVED';
    missingObject.informationRequests[0]!.source = 'DOCUMENT';
    missingObject.informationRequests[0]!.blocking = false;
    missingObject.disagreements[0]!.status = 'UNRESOLVED';
    missingObject.disagreements[0]!.informationRequestId = null;
    expect(validateLabPublicOutputV3(missingObject, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.abstention', code: 'INVALID_VALUE' })
        ])
      })
    );

    const coherent = structuredClone(missingObject);
    coherent.abstention = {
      reason: 'INSUFFICIENT_INFORMATION',
      summary: 'The missing source cannot be inferred safely.',
      propositionIds: ['p1'],
      whatWouldResolve: 'Obtain the missing document.'
    };
    expect(validateLabPublicOutputV3(coherent, context())).toEqual(
      expect.objectContaining({ ok: true })
    );

    const unexpectedObject = validOutput();
    unexpectedObject.abstention = coherent.abstention;
    expect(validateLabPublicOutputV3(unexpectedObject, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.abstention', code: 'INVALID_VALUE' })
        ])
      })
    );
  });
});

describe('Discourse Protocol Lab public-output-v3 provenance', () => {
  it('keeps critique ids invalid as factual evidence in every assertion surface', () => {
    const mutations: Array<{
      path: string;
      mutate: (output: LabPublicOutputV3) => void;
    }> = [
      {
        path: '$.propositionAssessments[0].factualEvidence[0].sourceId',
        mutate: (output) => { output.propositionAssessments[0]!.factualEvidence[0]!.sourceId = 'critique-1'; }
      },
      {
        path: '$.issues[0].factualEvidence[0].sourceId',
        mutate: (output) => { output.issues[0]!.factualEvidence[0]!.sourceId = 'critique-1'; }
      },
      {
        path: '$.responses[0].factualEvidence[0].sourceId',
        mutate: (output) => { output.responses[0]!.factualEvidence[0]!.sourceId = 'critique-1'; }
      },
      {
        path: '$.disagreements[0].factualEvidence[0].sourceId',
        mutate: (output) => { output.disagreements[0]!.factualEvidence[0]!.sourceId = 'critique-1'; }
      }
    ];

    for (const mutation of mutations) {
      const output = validOutput();
      mutation.mutate(output);
      expect(validateLabPublicOutputV3Context(output, context())).toContainEqual(
        expect.objectContaining({ path: mutation.path, code: 'INVALID_REFERENCE' })
      );
    }

    // The same critique remains valid as a conversational reference and exact response target.
    expect(validateLabPublicOutputV3(validOutput(), context())).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('requires response provenance and permits responses only to typed critiques', () => {
    const missingProvenance = validOutput();
    missingProvenance.responses[0]!.artifactReferences = [
      { artifactId: 'critique-1', relation: 'MENTIONS', note: 'Mentions but does not respond.' }
    ];
    expect(validateLabPublicOutputV3(missingProvenance, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.responses[0].artifactReferences',
            code: 'MISSING_FIELD'
          })
        ])
      })
    );

    const evidenceAsTarget = validOutput();
    evidenceAsTarget.responses[0]!.targetArtifactId = 'evidence-artifact-1';
    evidenceAsTarget.responses[0]!.targetIssueId = 'critique-issue-1';
    evidenceAsTarget.responses[0]!.artifactReferences[0]!.artifactId = 'evidence-artifact-1';
    expect(validateLabPublicOutputV3(evidenceAsTarget, context())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.responses[0].targetArtifactId',
            code: 'INVALID_REFERENCE'
          })
        ])
      })
    );
  });

  it('parses, context-validates, repairs once, and returns only the accepted output', () => {
    const invalid = validOutput();
    invalid.responses[0]!.factualEvidence[0]!.sourceId = 'critique-1';
    const record = createLabOutputRecordV3(
      { callId: 'primary-call', rawText: JSON.stringify(invalid) },
      { callId: 'repair-call', rawText: JSON.stringify(validOutput()) },
      context()
    );

    expect(record).toMatchObject({
      status: 'VALID',
      acceptedAttemptNumber: 2,
      repairAttempted: true
    });
    expect(record.attempts[0]!.validationErrors).toContainEqual(
      expect.objectContaining({
        path: '$.responses[0].factualEvidence[0].sourceId',
        code: 'INVALID_REFERENCE'
      })
    );
    expect(acceptedLabPublicOutputV3(record)).toEqual(validOutput());
  });
});

function participantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'public-output-v3-case',
    question: 'Assess both propositions and identify the information needed to resolve p1.',
    evidence: [{ id: 'case-evidence-1', text: 'The supplied record directly supports p2.' }],
    propositions: [
      { id: 'p1', topicId: 'topic-main', text: 'The missing fact establishes the outcome.' },
      { id: 'p2', topicId: 'topic-main', text: 'The supplied record supports p2.' }
    ],
    options: [{ id: 'option-1', text: 'Use the supported portion only.' }],
    topics: [{ id: 'topic-main', label: 'Main topic' }]
  };
}

function visibleArtifacts(): LabVisibleInterventionArtifactV3[] {
  return [
    {
      artifactKind: 'POSITION',
      artifactId: 'INITIAL',
      propositionIds: ['p1', 'p2'],
      text: 'The initial position resolves both propositions.',
      provenance: { sourceLabel: 'initial-answer', containsNewFacts: false }
    },
    {
      artifactKind: 'CRITIQUE',
      artifactId: 'critique-1',
      issueId: 'critique-issue-1',
      targetArtifactId: 'INITIAL',
      targetPropositionId: 'p1',
      text: 'The initial position assumes a missing fact.',
      provenance: { sourceLabel: 'controlled-critique', containsNewFacts: false }
    },
    {
      artifactKind: 'FACTUAL_EVIDENCE',
      artifactId: 'evidence-artifact-1',
      evidenceId: 'evidence-1',
      text: 'A controlled factual packet supports p2.',
      provenance: { sourceLabel: 'controlled-evidence', containsNewFacts: true }
    }
  ];
}

function context(): LabPublicOutputV3ValidationContext {
  return {
    participantCase: participantCase(),
    visibleInterventionArtifacts: visibleArtifacts()
  };
}

function validOutput(): LabPublicOutputV3 {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_V3_SCHEMA_VERSION,
    completionDisposition: 'NEEDS_USER_ACTION',
    answer: {
      summary: 'p2 is supported, while p1 needs a missing user-supplied fact.',
      values: [],
      selectedOptionIds: ['option-1'],
      epistemicState: 'UNDERDETERMINED',
      assessmentConfidence: 0.95
    },
    propositionAssessments: [
      {
        id: 'assessment-1',
        propositionId: 'p1',
        topicId: 'topic-main',
        assessment: 'UNRESOLVED',
        statement: 'p1 cannot be resolved from the supplied information.',
        factualEvidence: [
          { sourceId: 'PROMPT', relation: 'LIMITS', note: 'The prompt omits the decisive fact.' }
        ],
        artifactReferences: [
          { artifactId: 'critique-1', relation: 'AGREES_WITH', note: 'The critique finds the same gap.' }
        ],
        assumptionIds: ['assumption-1'],
        assessmentConfidence: 0.95
      },
      {
        id: 'assessment-2',
        propositionId: 'p2',
        topicId: 'topic-main',
        assessment: 'SUPPORTED',
        statement: 'p2 is supported by the case record.',
        factualEvidence: [
          {
            sourceId: 'case-evidence-1',
            relation: 'SUPPORTS',
            note: 'The supplied record directly supports p2.'
          }
        ],
        artifactReferences: [],
        assumptionIds: [],
        assessmentConfidence: 0.9
      }
    ],
    assumptions: [
      {
        id: 'assumption-1',
        statement: 'The omitted fact cannot safely be inferred.',
        status: 'UNCERTAIN',
        affectsAssessmentIds: ['assessment-1']
      }
    ],
    issues: [
      {
        id: 'local-issue-1',
        targetArtifactId: 'INITIAL',
        targetPropositionId: 'p1',
        kind: 'MISSING_INFORMATION',
        severity: 'MATERIAL',
        statement: 'The initial position relies on an unavailable fact.',
        factualEvidence: [
          { sourceId: 'PROMPT', relation: 'LIMITS', note: 'The required fact is absent.' }
        ],
        artifactReferences: [
          { artifactId: 'INITIAL', relation: 'MENTIONS', note: 'This is the affected position.' }
        ],
        assessmentConfidence: 0.9
      }
    ],
    responses: [
      {
        id: 'response-1',
        targetArtifactId: 'critique-1',
        targetIssueId: 'critique-issue-1',
        disposition: 'ACCEPT',
        statement: 'The critique correctly identifies the missing fact.',
        factualEvidence: [
          { sourceId: 'PROMPT', relation: 'LIMITS', note: 'The fact is absent from the prompt.' }
        ],
        artifactReferences: [
          {
            artifactId: 'critique-1',
            relation: 'RESPONDS_TO',
            note: 'This response directly addresses the critique.'
          }
        ],
        changedAssessmentIds: ['assessment-1']
      }
    ],
    disagreements: [
      {
        id: 'disagreement-1',
        propositionIds: ['p1'],
        participantArtifactIds: ['INITIAL', 'critique-1'],
        status: 'NEEDS_USER_ACTION',
        summary: 'The missing fact prevents evidence-based resolution of p1.',
        factualEvidence: [
          { sourceId: 'PROMPT', relation: 'LIMITS', note: 'The decisive fact is not provided.' }
        ],
        artifactReferences: [
          { artifactId: 'critique-1', relation: 'MENTIONS', note: 'The critique exposes the gap.' }
        ],
        informationRequestId: 'request-1'
      }
    ],
    resolution: {
      status: 'NEEDS_USER_ACTION',
      basis: 'INSUFFICIENT_INFORMATION',
      summary: 'p2 is resolved; p1 awaits the explicitly requested fact.',
      resolvedIssueIds: ['critique-issue-1'],
      unresolvedIssueIds: ['local-issue-1']
    },
    informationRequests: [
      {
        id: 'request-1',
        kind: 'MISSING_FACT',
        needed: 'The decisive fact for p1.',
        question: 'What is the decisive fact governing p1?',
        source: 'USER',
        blocking: true,
        propositionIds: ['p1']
      }
    ],
    abstention: null
  };
}

function allObjectSchemasAreClosed(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(allObjectSchemasAreClosed);
  if (typeof value !== 'object' || value === null) return true;
  const record = value as Record<string, unknown>;
  if (record.type === 'object' && record.additionalProperties !== false) return false;
  return Object.values(record).every(allObjectSchemasAreClosed);
}

function schemaContainsKeyword(value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) return value.some((item) => schemaContainsKeyword(item, keyword));
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, keyword) ||
    Object.values(record).some((item) => schemaContainsKeyword(item, keyword));
}

function strictStructuredOutputSchemaErrors(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      strictStructuredOutputSchemaErrors(item, `${path}[${index}]`)
    );
  }
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  const objectType = record.type === 'object' ||
    (Array.isArray(record.type) && record.type.includes('object'));
  if (objectType) {
    const properties = record.properties;
    if (record.additionalProperties !== false) {
      errors.push(`${path} must set additionalProperties:false`);
    }
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      errors.push(`${path} must declare properties`);
    } else {
      const propertyKeys = Object.keys(properties);
      const required = Array.isArray(record.required)
        ? record.required.filter((key): key is string => typeof key === 'string')
        : [];
      for (const key of propertyKeys) {
        if (!required.includes(key)) errors.push(`${path}.required is missing ${key}`);
      }
      for (const key of required) {
        if (!propertyKeys.includes(key)) errors.push(`${path}.required has unknown ${key}`);
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    errors.push(...strictStructuredOutputSchemaErrors(child, `${path}.${key}`));
  }
  return errors;
}
