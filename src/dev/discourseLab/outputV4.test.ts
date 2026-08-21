import { describe, expect, it } from 'vitest';
import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  type LabParticipantCase
} from './contracts';
import {
  LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  validateLabPublicOutputV4,
  validateLabPublicOutputV4Shape,
  type LabPublicOutputV4,
  type LabPublicOutputV4ValidationContext,
  type LabVisibleInterventionArtifactV4
} from './outputV4';
import {
  scoreResolutionConsistency,
  scoreSelfCorrectionRepresentation
} from './h1cScoring';

describe('Discourse Protocol Lab public-output-v4', () => {
  it('makes selected option ids authoritative by rejecting the removed answer.values field', () => {
    const output = initialOutput() as LabPublicOutputV4 & {
      answer: LabPublicOutputV4['answer'] & { values?: string[] };
    };
    output.answer.values = ['redundant copy'];

    expect(validateLabPublicOutputV4Shape(output)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ path: '$.answer.values', code: 'UNKNOWN_FIELD' })
      ])
    }));
  });

  it('accepts CASE as an issue target and rejects PROMPT as an artifact target', () => {
    const valid = initialOutput();
    valid.issues = [caseIssue()];
    valid.resolution.resolvedIssueIds = ['case-issue'];
    expect(validateLabPublicOutputV4(valid, context('INITIAL'))).toEqual(
      expect.objectContaining({ ok: true })
    );

    const wrongTarget = structuredClone(valid);
    wrongTarget.issues[0]!.targetArtifactId = 'PROMPT';
    expect(validateLabPublicOutputV4(wrongTarget, context('INITIAL'))).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.issues[0].targetArtifactId',
            code: 'INVALID_REFERENCE'
          })
        ])
      })
    );

    const wrongSource = structuredClone(valid);
    wrongSource.issues[0]!.factualEvidence[0]!.sourceId = 'CASE';
    expect(validateLabPublicOutputV4(wrongSource, context('INITIAL'))).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: '$.issues[0].factualEvidence[0].sourceId',
            code: 'INVALID_REFERENCE'
          })
        ])
      })
    );
  });

  it('keeps directional evidence omissions parseable for semantic scoring', () => {
    for (const [assessment, relation] of [
      ['SUPPORTED', 'SUPPORTS'],
      ['CONTRADICTED', 'CONTRADICTS'],
      ['UNRESOLVED', 'LIMITS']
    ] as const) {
      const output = initialOutput();
      output.propositionAssessments[0]!.assessment = assessment;
      output.propositionAssessments[0]!.factualEvidence = [];
      if (assessment === 'UNRESOLVED') {
        output.answer.epistemicState = 'UNDERDETERMINED';
        output.resolution.status = 'UNRESOLVED';
        output.resolution.basis = 'INSUFFICIENT_INFORMATION';
      }
      expect(relation).toBeTruthy();
      expect(validateLabPublicOutputV4(output, context('INITIAL'))).toEqual(
        expect.objectContaining({ ok: true })
      );
    }
  });

  it('permits two directions from one source but rejects an exact duplicate pair', () => {
    const twoDirections = initialOutput();
    twoDirections.propositionAssessments[0]!.factualEvidence.push({
      sourceId: 'PROMPT',
      relation: 'LIMITS',
      note: 'The same source can support one aspect while limiting the conclusion.'
    });
    expect(validateLabPublicOutputV4(twoDirections, context('INITIAL'))).toEqual(
      expect.objectContaining({ ok: true })
    );

    const duplicate = structuredClone(twoDirections);
    duplicate.propositionAssessments[0]!.factualEvidence.push({
      sourceId: 'PROMPT',
      relation: 'SUPPORTS',
      note: 'This duplicates the exact source and relation pair.'
    });
    expect(validateLabPublicOutputV4(duplicate, context('INITIAL'))).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ code: 'DUPLICATE_ID' })
        ])
      })
    );
  });

  it('accepts both coherent rejected-critique resolution encodings', () => {
    const rejected = critiqueRejection();
    expect(validateLabPublicOutputV4(rejected, critiqueContext())).toEqual(
      expect.objectContaining({ ok: true })
    );

    const resolved = structuredClone(rejected);
    resolved.resolution.status = 'RESOLVED';
    expect(validateLabPublicOutputV4(resolved, critiqueContext())).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('requires every externally answered issue to be accounted exactly once', () => {
    const omitted = critiqueRejection();
    omitted.resolution.resolvedIssueIds = [];
    expect(validateLabPublicOutputV4(omitted, critiqueContext())).toEqual(
      expect.objectContaining({ ok: true })
    );
    expect(scoreResolutionConsistency(omitted, ['critique-issue'])).toBe(false);

    const both = critiqueRejection();
    both.resolution.unresolvedIssueIds = ['critique-issue'];
    expect(validateLabPublicOutputV4(both, critiqueContext())).toEqual(
      expect.objectContaining({ ok: false })
    );
  });

  it('represents a self-found correction without weakening external response provenance', () => {
    const prior = initialOutput();
    const revised = structuredClone(prior);
    revised.answer.summary = 'Corrected concise public wording.';
    revised.issues = [{
      id: 'self-issue',
      targetArtifactId: 'DRAFT',
      targetPropositionId: 'p1',
      kind: 'OTHER',
      severity: 'ADVISORY',
      statement: 'The draft summary contained malformed wording.',
      factualEvidence: [{
        sourceId: 'PROMPT',
        relation: 'SUPPORTS',
        note: 'The public option text supplies the correct wording.'
      }],
      artifactReferences: [{
        artifactId: 'DRAFT',
        relation: 'MENTIONS',
        note: 'The issue concerns this exact prior draft.'
      }],
      assessmentConfidence: 0.95
    }];
    revised.selfCorrections = [{
      id: 'self-correction',
      targetArtifactId: 'DRAFT',
      targetIssueId: 'self-issue',
      disposition: 'CORRECTED',
      statement: 'Corrected the malformed public summary.',
      changedPublicFields: ['ANSWER_SUMMARY'],
      changedPropositionIds: []
    }];
    revised.resolution = {
      status: 'RESOLVED',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'The advisory wording issue was corrected.',
      resolvedIssueIds: ['self-issue'],
      unresolvedIssueIds: []
    };
    const selfContext = context('SELF_REVIEW', prior);
    expect(validateLabPublicOutputV4(revised, selfContext)).toEqual(
      expect.objectContaining({ ok: true })
    );

    const unlinked = structuredClone(revised);
    unlinked.selfCorrections = [];
    expect(validateLabPublicOutputV4(unlinked, selfContext)).toEqual(
      expect.objectContaining({ ok: true })
    );
    expect(scoreSelfCorrectionRepresentation('ACTIVE_SELF_REVIEW', unlinked, prior)).toBe(false);

    const falseLink = structuredClone(revised);
    falseLink.selfCorrections[0]!.changedPublicFields = ['SELECTED_OPTION_IDS'];
    expect(validateLabPublicOutputV4(falseLink, selfContext)).toEqual(
      expect.objectContaining({ ok: true })
    );
    expect(scoreSelfCorrectionRepresentation('ACTIVE_SELF_REVIEW', falseLink, prior)).toBe(false);

    const selfResponse = structuredClone(revised);
    selfResponse.responses = [{
      id: 'invalid-self-response',
      targetArtifactId: 'DRAFT',
      targetIssueId: 'self-issue',
      disposition: 'ACCEPT',
      statement: 'Invalidly responds to a non-critique artifact.',
      factualEvidence: [],
      artifactReferences: [{
        artifactId: 'DRAFT',
        relation: 'RESPONDS_TO',
        note: 'This must remain invalid.'
      }],
      changedAssessmentIds: []
    }];
    expect(validateLabPublicOutputV4(selfResponse, selfContext)).toEqual(
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

  it('accepts an exact no-change self-review with no invented issue', () => {
    const prior = initialOutput();
    const reviewed = structuredClone(prior);
    reviewed.resolution = {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No correction was justified by the existing information.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    };
    expect(validateLabPublicOutputV4(reviewed, context('SELF_REVIEW', prior))).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it.each([
    'SELF_REVIEW',
    'CRITIQUE_RESPONSE',
    'EVIDENCE_RESPONSE'
  ] as const)('makes typed DRAFT issues visible during %s', (stage) => {
    const draft = draftWithIssue();
    const output = initialOutput();
    output.resolution.resolvedIssueIds = ['draft-issue'];
    const extras = stage === 'CRITIQUE_RESPONSE'
      ? [critiqueArtifact()]
      : stage === 'EVIDENCE_RESPONSE'
        ? [evidenceArtifact()]
        : [];

    expect(validateLabPublicOutputV4(output, stagedContext(stage, draft, extras))).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('permits stable DRAFT issue retention and rejects identity mutation', () => {
    const draft = draftWithIssue();
    const retained = initialOutput();
    retained.issues = [structuredClone(draft.issues[0]!)];
    retained.resolution.resolvedIssueIds = ['draft-issue'];
    const validationContext = stagedContext('SELF_REVIEW', draft);
    expect(validateLabPublicOutputV4(retained, validationContext)).toEqual(
      expect.objectContaining({ ok: true })
    );

    const mutated = structuredClone(retained);
    mutated.issues[0]!.severity = 'MATERIAL';
    expect(validateLabPublicOutputV4(mutated, validationContext)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'v4.issue.draft-identity-retention',
            domain: 'ISSUE_LIFECYCLE',
            measurementEffect: 'OUTPUT_INVALID'
          })
        ])
      })
    );
  });

  it('rejects current issue shadowing of a visible critique issue', () => {
    const output = initialOutput();
    output.issues = [{ ...caseIssue(), id: 'critique-issue' }];
    output.resolution.resolvedIssueIds = ['critique-issue'];
    expect(validateLabPublicOutputV4(output, critiqueContext())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'v4.issue.no-critique-shadow',
            domain: 'ISSUE_LIFECYCLE',
            measurementEffect: 'OUTPUT_INVALID'
          })
        ])
      })
    );
  });

  it('rejects unknown issue resolution with typed output-invalid metadata', () => {
    const output = initialOutput();
    output.resolution.resolvedIssueIds = ['not-visible'];
    expect(validateLabPublicOutputV4(output, context('INITIAL'))).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'v4.resolution.issue-reference',
            domain: 'ISSUE_LIFECYCLE',
            measurementEffect: 'OUTPUT_INVALID'
          })
        ])
      })
    );
  });

  it('keeps response provenance critique-only and exact', () => {
    const output = critiqueRejection();
    output.responses[0]!.artifactReferences = [{
      artifactId: 'DRAFT',
      relation: 'RESPONDS_TO',
      note: 'Wrong conversational target.'
    }];
    expect(validateLabPublicOutputV4(output, critiqueContext())).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'v4.response.responds-to-required',
            domain: 'RESPONSE_PROVENANCE',
            measurementEffect: 'OUTPUT_INVALID'
          }),
          expect.objectContaining({
            ruleId: 'v4.response.responds-to-exact-target',
            domain: 'RESPONSE_PROVENANCE',
            measurementEffect: 'OUTPUT_INVALID'
          })
        ])
      })
    );
  });

  it('types malformed or stage-invalid context as measurement unavailable', () => {
    const missingPosition: LabPublicOutputV4ValidationContext = {
      participantCase: participantCase(),
      interactionStage: 'SELF_REVIEW',
      visibleInterventionArtifacts: []
    };
    expect(validateLabPublicOutputV4(initialOutput(), missingPosition)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'v4.context.position-cardinality',
            domain: 'CONTEXT_INTEGRITY',
            measurementEffect: 'MEASUREMENT_UNAVAILABLE'
          })
        ])
      })
    );

    const initialWithPosition = stagedContext('SELF_REVIEW', initialOutput());
    initialWithPosition.interactionStage = 'INITIAL';
    expect(validateLabPublicOutputV4(initialOutput(), initialWithPosition)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'v4.context.position-cardinality',
            measurementEffect: 'MEASUREMENT_UNAVAILABLE'
          })
        ])
      })
    );

    const legacyTextContext = structuredClone(
      stagedContext('SELF_REVIEW', initialOutput())
    ) as unknown as {
      visibleInterventionArtifacts: Array<Record<string, unknown>>;
    } & LabPublicOutputV4ValidationContext;
    const legacyPosition = legacyTextContext.visibleInterventionArtifacts[0]!;
    delete legacyPosition.publicOutput;
    legacyPosition.text = JSON.stringify(initialOutput());
    expect(validateLabPublicOutputV4(initialOutput(), legacyTextContext)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'v4.context.artifact-shape',
            domain: 'CONTEXT_INTEGRITY',
            measurementEffect: 'MEASUREMENT_UNAVAILABLE'
          })
        ])
      })
    );

    const malformedDraft = initialOutput();
    malformedDraft.completionDisposition = 'NEEDS_USER_ACTION';
    const malformedContext = stagedContext('SELF_REVIEW', malformedDraft);
    expect(validateLabPublicOutputV4(initialOutput(), malformedContext)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
          ruleId: 'v4.context.position-public-output',
            domain: 'CONTEXT_INTEGRITY',
            measurementEffect: 'MEASUREMENT_UNAVAILABLE'
          })
        ])
      })
    );
  });
});

function participantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'output-v4-regression',
    question: 'Choose the supported option and assess both propositions.',
    evidence: [],
    propositions: [
      { id: 'p1', topicId: 'topic', text: 'The prompt supports proposition one.' },
      { id: 'p2', topicId: 'topic', text: 'The prompt supports proposition two.' }
    ],
    options: [{ id: 'option-a', text: 'Choose A.' }],
    topics: [{ id: 'topic', label: 'Decision' }]
  };
}

function context(
  interactionStage: LabPublicOutputV4ValidationContext['interactionStage'],
  priorOutput?: LabPublicOutputV4
): LabPublicOutputV4ValidationContext {
  return {
    participantCase: participantCase(),
    visibleInterventionArtifacts: interactionStage === 'SELF_REVIEW'
      ? [{
          artifactKind: 'POSITION',
          artifactId: 'DRAFT',
          propositionIds: ['p1', 'p2'],
          publicOutput: structuredClone(priorOutput ?? initialOutput()),
          provenance: { sourceLabel: 'prior draft', containsNewFacts: false }
        }]
      : [],
    interactionStage
  };
}

function critiqueContext(): LabPublicOutputV4ValidationContext {
  return {
    participantCase: participantCase(),
    interactionStage: 'CRITIQUE_RESPONSE',
    visibleInterventionArtifacts: [
      {
        artifactKind: 'POSITION',
        artifactId: 'DRAFT',
        propositionIds: ['p1', 'p2'],
        publicOutput: initialOutput(),
        provenance: { sourceLabel: 'prior draft', containsNewFacts: false }
      },
      {
        artifactKind: 'CRITIQUE',
        artifactId: 'critique',
        issueId: 'critique-issue',
        targetArtifactId: 'DRAFT',
        targetPropositionId: 'p1',
        text: 'An unfounded review note.',
        provenance: { sourceLabel: 'anonymous review', containsNewFacts: false }
      }
    ]
  };
}

function stagedContext(
  interactionStage: Exclude<
    LabPublicOutputV4ValidationContext['interactionStage'],
    'INITIAL'
  >,
  draft: LabPublicOutputV4,
  extras: LabVisibleInterventionArtifactV4[] = []
): LabPublicOutputV4ValidationContext {
  return {
    participantCase: participantCase(),
    interactionStage,
    visibleInterventionArtifacts: [{
      artifactKind: 'POSITION',
      artifactId: 'DRAFT',
      propositionIds: ['p1', 'p2'],
      publicOutput: structuredClone(draft),
      provenance: { sourceLabel: 'prior draft', containsNewFacts: false }
    }, ...extras]
  };
}

function critiqueArtifact(): Extract<
  LabVisibleInterventionArtifactV4,
  { artifactKind: 'CRITIQUE' }
> {
  return {
    artifactKind: 'CRITIQUE',
    artifactId: 'critique',
    issueId: 'critique-issue',
    targetArtifactId: 'DRAFT',
    targetPropositionId: 'p1',
    text: 'An unfounded review note.',
    provenance: { sourceLabel: 'anonymous review', containsNewFacts: false }
  };
}

function evidenceArtifact(): Extract<
  LabVisibleInterventionArtifactV4,
  { artifactKind: 'FACTUAL_EVIDENCE' }
> {
  return {
    artifactKind: 'FACTUAL_EVIDENCE',
    artifactId: 'evidence-packet',
    evidenceId: 'new-evidence',
    text: 'A typed factual evidence packet.',
    provenance: { sourceLabel: 'sealed packet', containsNewFacts: true }
  };
}

function draftWithIssue(): LabPublicOutputV4 {
  const draft = initialOutput();
  draft.issues = [{
    id: 'draft-issue',
    targetArtifactId: 'CASE',
    targetPropositionId: 'p1',
    kind: 'OTHER',
    severity: 'ADVISORY',
    statement: 'The draft records an issue that remains visible to the next stage.',
    factualEvidence: [{
      sourceId: 'PROMPT',
      relation: 'LIMITS',
      note: 'The prompt limits this aspect of the conclusion.'
    }],
    artifactReferences: [],
    assessmentConfidence: 0.8
  }];
  draft.resolution.resolvedIssueIds = ['draft-issue'];
  return draft;
}

function caseIssue(): LabPublicOutputV4['issues'][number] {
  return {
    id: 'case-issue',
    targetArtifactId: 'CASE',
    targetPropositionId: 'p1',
    kind: 'OTHER',
    severity: 'ADVISORY',
    statement: 'A case-level issue with explicit namespace use.',
    factualEvidence: [{
      sourceId: 'PROMPT',
      relation: 'SUPPORTS',
      note: 'The prompt is a factual source, not the issue target.'
    }],
    artifactReferences: [],
    assessmentConfidence: 0.9
  };
}

function critiqueRejection(): LabPublicOutputV4 {
  const output = initialOutput();
  output.responses = [{
    id: 'response',
    targetArtifactId: 'critique',
    targetIssueId: 'critique-issue',
    disposition: 'REJECT',
    statement: 'The draft already handles the point.',
    factualEvidence: [{
      sourceId: 'PROMPT',
      relation: 'SUPPORTS',
      note: 'The prompt supports the unchanged assessment.'
    }],
    artifactReferences: [{
      artifactId: 'critique',
      relation: 'RESPONDS_TO',
      note: 'Direct response to the exact review note.'
    }],
    changedAssessmentIds: []
  }];
  output.resolution = {
    status: 'NO_DISAGREEMENT',
    basis: 'NO_MATERIAL_ISSUE',
    summary: 'The exact review issue was rejected as unfounded.',
    resolvedIssueIds: ['critique-issue'],
    unresolvedIssueIds: []
  };
  return output;
}

function initialOutput(): LabPublicOutputV4 {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    completionDisposition: 'COMPLETE',
    answer: {
      summary: 'Option A is supported.',
      selectedOptionIds: ['option-a'],
      epistemicState: 'RESOLVED',
      assessmentConfidence: 0.95
    },
    propositionAssessments: ['p1', 'p2'].map((propositionId, index) => ({
      id: `assessment-${index + 1}`,
      propositionId,
      topicId: 'topic',
      assessment: 'SUPPORTED' as const,
      statement: `The prompt supports ${propositionId}.`,
      factualEvidence: [{
        sourceId: 'PROMPT',
        relation: 'SUPPORTS' as const,
        note: 'The case prompt directly supports this proposition.'
      }],
      artifactReferences: [],
      assumptionIds: [],
      assessmentConfidence: 0.95
    })),
    assumptions: [],
    issues: [],
    responses: [],
    selfCorrections: [],
    disagreements: [],
    resolution: {
      status: 'RESOLVED',
      basis: 'FACTUAL_EVIDENCE',
      summary: 'The answer is resolved by the prompt.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    informationRequests: [],
    abstention: null
  };
}
