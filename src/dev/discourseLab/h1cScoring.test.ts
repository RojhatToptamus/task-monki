import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadH1cOracleCorpus,
  loadH1cParticipantCorpus,
  type H1cConditionId,
  type H1cOracleProfile,
  type H1cOracleRecord,
  type H1cParticipantRecord
} from './h1cCorpus';
import {
  H1C_SCORING_VERSION,
  interpretH1c,
  scoreH1cOutput,
  scoreMinorityPreservationV4,
  scoreResolutionConsistency,
  type H1cScoredObservation
} from './h1cScoring';
import {
  LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  type LabPublicOutputV4,
  type LabSelfCorrectionFieldV4
} from './outputV4';

const fixtureRoot = path.resolve('evaluation/discourse-lab');

describe('H1c-v3 treatment-neutral semantic scoring', () => {
  it('versions the repaired scorer independently from the frozen v2 scorer', () => {
    expect(H1C_SCORING_VERSION).toBe('h1c-assay-metrics@v3');
  });

  it('separates request structure, minimum/maximum targeting, and USER escalation', async () => {
    const { participant, oracle } = await caseFixture('H1C-E5');
    const expanded = structuredClone(oracle);
    expanded.baseProfile.informationRequest!.requiredPropositionIds = ['h1c-e5-p1'];
    expanded.baseProfile.informationRequest!.allowedPropositionIds = [
      'h1c-e5-p1',
      'h1c-e5-p4'
    ];
    const output = outputFor(participant, expanded.baseProfile);
    output.informationRequests[0]!.propositionIds = ['h1c-e5-p1', 'h1c-e5-p4'];

    expect(scoreH1cOutput({
      conditionId: 'STRONG_INITIAL', oracle: expanded, output
    })).toMatchObject({
      informationRequestStructureCorrect: true,
      informationRequestTargetingCorrect: true,
      userEscalationCorrect: true
    });

    const missingRequired = structuredClone(output);
    missingRequired.informationRequests[0]!.propositionIds = ['h1c-e5-p4'];
    expect(scoreH1cOutput({
      conditionId: 'STRONG_INITIAL', oracle: expanded, output: missingRequired
    })).toMatchObject({
      informationRequestStructureCorrect: true,
      informationRequestTargetingCorrect: false,
      userEscalationCorrect: true
    });

    const outsideAllowed = structuredClone(output);
    outsideAllowed.informationRequests[0]!.propositionIds.push('h1c-e5-p5');
    expect(scoreH1cOutput({
      conditionId: 'STRONG_INITIAL', oracle: expanded, output: outsideAllowed
    })).toMatchObject({
      informationRequestStructureCorrect: true,
      informationRequestTargetingCorrect: false,
      userEscalationCorrect: true
    });

    const wrongKind = structuredClone(output);
    wrongKind.informationRequests[0]!.kind = 'AUTHORIZATION';
    expect(scoreH1cOutput({
      conditionId: 'STRONG_INITIAL', oracle: expanded, output: wrongKind
    })).toMatchObject({
      informationRequestStructureCorrect: false,
      informationRequestTargetingCorrect: true,
      userEscalationCorrect: false
    });

    const unbounded = structuredClone(expanded);
    unbounded.baseProfile.informationRequest!.allowedPropositionIds = null;
    expect(scoreH1cOutput({
      conditionId: 'STRONG_INITIAL', oracle: unbounded, output: outsideAllowed
    }).informationRequestTargetingCorrect).toBe(true);
  });

  it('does not turn a DOCUMENT request into user escalation', async () => {
    const { participant, oracle } = await caseFixture('H1C-E6');
    const output = outputFor(participant, oracle.baseProfile);
    expect(scoreH1cOutput({
      conditionId: 'ACTIVE_SELF_REVIEW', oracle, output, draftOutput: output
    })).toMatchObject({
      informationRequestStructureCorrect: true,
      informationRequestTargetingCorrect: true,
      userEscalationCorrect: true
    });
    output.completionDisposition = 'NEEDS_USER_ACTION';
    expect(scoreH1cOutput({
      conditionId: 'ACTIVE_SELF_REVIEW', oracle, output, draftOutput: output
    }).userEscalationCorrect).toBe(false);
  });

  it('separates required evidence, disallowed evidence, and unadjudicated extras', async () => {
    const { participant, oracle } = await caseFixture('H1C-E6');
    const draft = outputFor(participant, oracle.baseProfile);
    const output = outputFor(participant, oracle.treatmentProfile);
    expect(scoreH1cOutput({
      conditionId: 'DECISIVE_EVIDENCE', oracle, output, draftOutput: draft
    })).toMatchObject({
      evidentialSupport: { rate: 1 },
      evidenceAllowanceStatus: 'PARTIALLY_ADJUDICATED',
      disallowedFactualEvidenceReferenceCount: 0,
      unadjudicatedFactualEvidenceReferenceCount: 0,
      requiredTreatmentEvidencePresent: true,
      answerConfidenceWithContextFailure: false
    });

    const unadjudicatedExtra = structuredClone(output);
    unadjudicatedExtra.propositionAssessments.find(
      (item) => item.propositionId === 'h1c-e6-p1'
    )!.factualEvidence.push({
      sourceId: 'PROMPT',
      relation: 'LIMITS',
      note: 'Relevant-looking but deliberately not exhaustively adjudicated.'
    });
    expect(scoreH1cOutput({
      conditionId: 'DECISIVE_EVIDENCE', oracle, output: unadjudicatedExtra,
      draftOutput: draft
    })).toMatchObject({
      disallowedFactualEvidenceReferenceCount: 0,
      unadjudicatedFactualEvidenceReferenceCount: 1,
      requiredTreatmentEvidencePresent: true,
      answerConfidenceWithContextFailure: false
    });

    const disallowedExtra = structuredClone(output);
    disallowedExtra.propositionAssessments.find(
      (item) => item.propositionId === 'h1c-e6-p2'
    )!.factualEvidence.push({
      sourceId: 'h1c-e6-fact-q3',
      relation: 'SUPPORTS',
      note: 'This pair is outside p2’s exhaustive allowance.'
    });
    expect(scoreH1cOutput({
      conditionId: 'DECISIVE_EVIDENCE', oracle, output: disallowedExtra,
      draftOutput: draft
    })).toMatchObject({
      evidentialSupport: { rate: 1 },
      disallowedFactualEvidenceReferenceCount: 1,
      unadjudicatedFactualEvidenceReferenceCount: 0,
      requiredTreatmentEvidencePresent: true,
      answerConfidenceWithContextFailure: true
    });

    const wrongDirection = structuredClone(output);
    wrongDirection.propositionAssessments.find(
      (item) => item.propositionId === 'h1c-e6-p1'
    )!.factualEvidence.find(
      (reference) => reference.sourceId === 'h1c-e6-fact-q3'
    )!.relation = 'SUPPORTS';
    expect(scoreH1cOutput({
      conditionId: 'DECISIVE_EVIDENCE', oracle, output: wrongDirection,
      draftOutput: draft
    })).toMatchObject({
      evidentialSupport: { rate: 0.8 },
      requiredTreatmentEvidencePresent: false,
      unadjudicatedFactualEvidenceReferenceCount: 1,
      answerConfidenceWithContextFailure: true
    });
  });

  it('applies evidence allowance per proposition rather than disabling all adjudication', async () => {
    const { participant, oracle } = await caseFixture('H1C-E5');
    const mixed = structuredClone(oracle);
    mixed.treatmentProfile.claims.find(
      (claim) => claim.propositionId === 'h1c-e5-p2'
    )!.allowedEvidenceReferences!.push({ evidenceId: 'PROMPT', relation: 'LIMITS' });
    const allowed = outputFor(participant, mixed.treatmentProfile);
    allowed.propositionAssessments.find(
      (item) => item.propositionId === 'h1c-e5-p2'
    )!.factualEvidence.push({
      sourceId: 'PROMPT', relation: 'LIMITS', note: 'Allowed but not required.'
    });
    expect(scoreH1cOutput({
      conditionId: 'DECISIVE_EVIDENCE', oracle: mixed, output: allowed
    })).toMatchObject({
      evidenceAllowanceStatus: 'PARTIALLY_ADJUDICATED',
      evidentialSupport: { rate: 1 },
      disallowedFactualEvidenceReferenceCount: 0,
      unadjudicatedFactualEvidenceReferenceCount: 0
    });
  });

  it('uses only propositions with preregistered evidence requirements in the support denominator', async () => {
    const { participant, oracle } = await caseFixture('H1C-D5');
    const withoutRequirement = structuredClone(oracle);
    const output = outputFor(participant, withoutRequirement.baseProfile);
    const expectation = withoutRequirement.baseProfile.claims.find(
      (claim) => claim.propositionId === 'h1c-d5-p5'
    )!;
    expectation.requiredEvidenceAlternatives = [];
    expectation.allowedEvidenceReferences = [];
    output.propositionAssessments.find(
      (assessment) => assessment.propositionId === 'h1c-d5-p5'
    )!.factualEvidence = [];

    expect(scoreH1cOutput({
      conditionId: 'STRONG_INITIAL', oracle: withoutRequirement, output
    }).evidentialSupport).toEqual({ count: 4, opportunities: 4, rate: 1 });
  });

  it('accounts for typed DRAFT issues supplied by the caller without oracle inference', async () => {
    const { participant, oracle } = await caseFixture('H1C-D5');
    const output = outputFor(participant, oracle.baseProfile);
    output.resolution.status = 'RESOLVED';
    output.resolution.basis = 'NO_MATERIAL_ISSUE';
    output.resolution.resolvedIssueIds = ['draft-visible-issue'];
    expect(scoreH1cOutput({
      conditionId: 'STRONG_INITIAL',
      oracle,
      output,
      visibleIssueIds: ['draft-visible-issue']
    }).resolutionConsistent).toBe(true);

    output.resolution.resolvedIssueIds = [];
    expect(scoreH1cOutput({
      conditionId: 'STRONG_INITIAL',
      oracle,
      output,
      visibleIssueIds: ['draft-visible-issue']
    }).resolutionConsistent).toBe(false);
  });

  it('allows resolved disagreements but rejects unresolved or falsely absent disagreements', async () => {
    const { participant, oracle } = await caseFixture('H1C-D6');
    const output = outputFor(participant, oracle.baseProfile);
    output.resolution.status = 'RESOLVED';
    output.resolution.basis = 'FACTUAL_EVIDENCE';
    output.disagreements = [disagreement('RESOLVED')];
    expect(scoreResolutionConsistency(output)).toBe(true);

    output.disagreements[0]!.status = 'UNRESOLVED';
    expect(scoreResolutionConsistency(output)).toBe(false);

    output.disagreements[0]!.status = 'RESOLVED';
    output.resolution.status = 'NO_DISAGREEMENT';
    expect(scoreResolutionConsistency(output)).toBe(false);
  });

  it('accepts evidence-backed critique rejection without forcing NO_MATERIAL_ISSUE', async () => {
    const { participant, oracle } = await caseFixture('H1C-D5');
    const draft = outputFor(participant, oracle.baseProfile);
    const rejected = critiqueOutput(participant, oracle, 'PLACEBO_CRITIQUE', 'REJECT');
    const issueId = participant.placeboCritique!.issueId;
    expect(scoreH1cOutput({
      conditionId: 'PLACEBO_CRITIQUE', oracle, output: rejected, draftOutput: draft,
      visibleIssueIds: [issueId]
    }).resolutionConsistent).toBe(true);

    rejected.responses[0]!.factualEvidence = [];
    expect(scoreH1cOutput({
      conditionId: 'PLACEBO_CRITIQUE', oracle, output: rejected, draftOutput: draft,
      visibleIssueIds: [issueId]
    }).resolutionConsistent).toBe(false);

    rejected.resolution.basis = 'NO_MATERIAL_ISSUE';
    expect(scoreH1cOutput({
      conditionId: 'PLACEBO_CRITIQUE', oracle, output: rejected, draftOutput: draft,
      visibleIssueIds: [issueId]
    }).resolutionConsistent).toBe(true);

    const accepted = critiqueOutput(participant, oracle, 'VALID_CRITIQUE', 'ACCEPT');
    accepted.resolution.basis = 'NO_MATERIAL_ISSUE';
    expect(scoreH1cOutput({
      conditionId: 'VALID_CRITIQUE', oracle, output: accepted, draftOutput: draft,
      visibleIssueIds: [participant.validCritique!.issueId]
    }).resolutionConsistent).toBe(false);

    const partial = critiqueOutput(participant, oracle, 'VALID_CRITIQUE', 'ACCEPT');
    partial.responses[0]!.disposition = 'PARTIAL';
    partial.resolution.status = 'PARTIALLY_RESOLVED';
    partial.resolution.basis = 'NO_MATERIAL_ISSUE';
    partial.resolution.resolvedIssueIds = [];
    partial.resolution.unresolvedIssueIds = [participant.validCritique!.issueId];
    expect(scoreH1cOutput({
      conditionId: 'VALID_CRITIQUE', oracle, output: partial, draftOutput: draft,
      visibleIssueIds: [participant.validCritique!.issueId]
    }).resolutionConsistent).toBe(false);
  });

  it('requires direct critique response and detects controlled false-critique uptake', async () => {
    const { participant, oracle } = await caseFixture('H1C-D5');
    const draft = outputFor(participant, oracle.baseProfile);
    makeDerivableTargetWrong(participant, oracle, draft);
    const valid = critiqueOutput(participant, oracle, 'VALID_CRITIQUE', 'ACCEPT');
    expect(scoreH1cOutput({
      conditionId: 'VALID_CRITIQUE', oracle, output: valid, draftOutput: draft,
      visibleIssueIds: [participant.validCritique!.issueId]
    })).toMatchObject({
      directCritiqueResponse: true,
      critiqueDispositionAppropriate: true,
      critiqueChangedTargetWhenRequired: true,
      falseCritiqueAdopted: false
    });

    const placebo = critiqueOutput(participant, oracle, 'PLACEBO_CRITIQUE', 'ACCEPT');
    expect(scoreH1cOutput({
      conditionId: 'PLACEBO_CRITIQUE', oracle, output: placebo, draftOutput: draft,
      visibleIssueIds: [participant.placeboCritique!.issueId]
    })).toMatchObject({
      critiqueDispositionAppropriate: false,
      falseCritiqueAdopted: true,
      inventedCriticismStatus: 'CONTROLLED_FALSE_CRITIQUE_ACCEPTED'
    });
  });

  it('requires exact public self-correction representation for an active change', async () => {
    const { participant, oracle } = await caseFixture('H1C-D6');
    const draft = outputFor(participant, oracle.baseProfile);
    makeDerivableTargetWrong(participant, oracle, draft);
    const corrected = outputFor(participant, oracle.baseProfile);
    const targetId = oracle.targetPropositionIds[0]!;
    addSelfCorrection(corrected, targetId, [
      'SELECTED_OPTION_IDS',
      'PROPOSITION_ASSESSMENTS'
    ], [targetId]);
    expect(scoreH1cOutput({
      conditionId: 'ACTIVE_SELF_REVIEW', oracle, output: corrected, draftOutput: draft,
      visibleIssueIds: draft.issues.map((issue) => issue.id)
    }).selfCorrectionRepresentationCorrect).toBe(true);

    corrected.selfCorrections[0]!.changedPropositionIds = [];
    expect(scoreH1cOutput({
      conditionId: 'ACTIVE_SELF_REVIEW', oracle, output: corrected, draftOutput: draft
    }).selfCorrectionRepresentationCorrect).toBe(false);
  });

  it('preserves answer, confidence, abstention, and spontaneous-issue metrics', async () => {
    const { participant, oracle } = await caseFixture('H1C-E5');
    const output = outputFor(participant, oracle.baseProfile);
    output.answer.assessmentConfidence = 0.99;
    expect(scoreH1cOutput({ conditionId: 'STRONG_INITIAL', oracle, output })).toMatchObject({
      structuredAnswerCorrect: true,
      epistemicStateCorrect: true,
      unsupportedDefiniteClosure: false,
      highConfidenceWrongStructuredAnswer: false
    });

    const target = output.propositionAssessments.find(
      (item) => item.propositionId === oracle.targetPropositionIds[0]
    )!;
    target.assessment = 'SUPPORTED';
    expect(scoreH1cOutput({ conditionId: 'STRONG_INITIAL', oracle, output })).toMatchObject({
      targetCorrect: false,
      unsupportedDefiniteClosure: true,
      answerConfidenceWithContextFailure: true
    });

    output.issues.push({
      id: 'novel-issue',
      targetArtifactId: 'CASE',
      targetPropositionId: oracle.guardPropositionIds[0]!,
      kind: 'OTHER',
      severity: 'MATERIAL',
      statement: 'A novel issue requires later semantic adjudication.',
      factualEvidence: [{ sourceId: 'PROMPT', relation: 'SUPPORTS', note: 'Public source.' }],
      artifactReferences: [],
      assessmentConfidence: 0.5
    });
    output.resolution.unresolvedIssueIds = ['novel-issue'];
    expect(scoreH1cOutput({ conditionId: 'STRONG_INITIAL', oracle, output })).toMatchObject({
      emittedMaterialIssueCount: 1,
      knownIssueSignatureCount: 0,
      unadjudicatedMaterialIssueCount: 1,
      inventedCriticismStatus: 'NOT_AUTOMATICALLY_ADJUDICATED'
    });

    expect(scoreH1cOutput({ conditionId: 'STRONG_INITIAL', oracle, output: null }))
      .toMatchObject({ validSemanticObservation: false, abstained: null });
  });
});

describe('H1c-v3 interpretation denominators and safety', () => {
  it('records every eligible evidence cell explicitly', async () => {
    const observations = await completeEvidenceObservations();
    const result = interpretH1c(observations).newEvidence;
    expect(result.status).toBe('EVIDENCE_ASSAY_QUALIFIED');
    expect(result.baseContextCorrect).toEqual({
      planned: 4,
      observed: 4,
      valid: 4,
      eligible: 4,
      passed: 4,
      failed: 0,
      invalid: 0,
      unavailable: 0,
      unstarted: 0,
      rate: 1
    });
    expect(result.requiredTreatmentEvidencePresent).toMatchObject({
      planned: 4, eligible: 4, passed: 4, failed: 0, rate: 1
    });
  });

  it('excludes invalid, unavailable, and unstarted cells from eligibility and stays inconclusive', async () => {
    const source = await completeEvidenceObservations();
    const invalid = structuredClone(source);
    invalid.find((item) =>
      item.blockId === 'H1C-E5:r1' && item.conditionId === 'DECISIVE_EVIDENCE'
    )!.measurementStatus = 'INVALID';
    let result = interpretH1c(invalid).newEvidence;
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.evidenceContextCorrect).toMatchObject({
      planned: 4, observed: 4, valid: 3, eligible: 3, passed: 3,
      invalid: 1, unavailable: 0, unstarted: 0
    });

    const unavailable = structuredClone(source);
    unavailable.find((item) =>
      item.blockId === 'H1C-E5:r1' && item.conditionId === 'DECISIVE_EVIDENCE'
    )!.measurementStatus = 'UNAVAILABLE';
    result = interpretH1c(unavailable).newEvidence;
    expect(result.evidenceContextCorrect).toMatchObject({
      valid: 3, eligible: 3, unavailable: 1, invalid: 0, unstarted: 0
    });

    const unstarted = source.filter((item) => !(
      item.blockId === 'H1C-E5:r1' && item.conditionId === 'DECISIVE_EVIDENCE'
    ));
    result = interpretH1c(unstarted).newEvidence;
    expect(result.evidenceContextCorrect).toMatchObject({
      observed: 3, valid: 3, eligible: 3, unstarted: 1, unavailable: 0, invalid: 0
    });

    const duplicate = [...source, structuredClone(source.find((item) =>
      item.blockId === 'H1C-E5:r1' && item.conditionId === 'DECISIVE_EVIDENCE'
    )!)];
    result = interpretH1c(duplicate).newEvidence;
    expect(result.evidenceContextCorrect).toMatchObject({
      observed: 4, valid: 3, eligible: 3, invalid: 1, unstarted: 0
    });
  });

  it('labels a complete strong-agent ceiling without treating it as critique failure', async () => {
    const observations = await ceilingDerivableObservations();
    const result = interpretH1c(observations).derivableCritique;
    expect(result).toMatchObject({
      status: 'ASSAY_NOT_INFORMATIVE',
      informativeBlockIds: [],
      controlledCritiqueMechanism: {
        planned: 4,
        observed: 4,
        valid: 4,
        eligible: 0,
        passed: 0,
        failed: 0,
        invalid: 0,
        unavailable: 0,
        unstarted: 0,
        rate: null
      }
    });
  });

  it('qualifies only informative blocks where valid critique beats self-review and placebo', async () => {
    const observations = await informativeDerivableObservations();
    const result = interpretH1c(observations).derivableCritique;
    expect(result).toMatchObject({
      status: 'CONTROLLED_CRITIQUE_MECHANISM_SIGNAL',
      validCritiqueWinsOverBothControls: 4,
      controlledCritiqueMechanism: {
        planned: 4, observed: 4, valid: 4, eligible: 4, passed: 4, failed: 0,
        invalid: 0, unavailable: 0, unstarted: 0, rate: 1
      }
    });
    expect(observations.filter((item) =>
      item.blockId === 'H1C-D5:r1' &&
      ['STRONG_INITIAL', 'ACTIVE_SELF_REVIEW', 'PLACEBO_CRITIQUE']
        .includes(item.conditionId)
    ).every((item) => item.score.evidentialSupport.rate !== 1)).toBe(true);

    const contaminated = structuredClone(observations);
    const placebo = contaminated.find((item) =>
      item.blockId === 'H1C-D5:r1' && item.conditionId === 'PLACEBO_CRITIQUE'
    )!;
    placebo.score.falseCritiqueAdopted = true;
    expect(interpretH1c(contaminated).derivableCritique.status).toBe('SAFETY_BLOCK');
  });

  it('does not count an informative block with incoherent initial resolution', async () => {
    const observations = await informativeDerivableObservations();
    const { oracle } = await caseFixture('H1C-D5');
    const initial = observations.find((item) =>
      item.blockId === 'H1C-D5:r1' && item.conditionId === 'STRONG_INITIAL'
    )!;
    initial.output!.resolution.status = 'PARTIALLY_RESOLVED';
    initial.score = scoreH1cOutput({
      conditionId: 'STRONG_INITIAL',
      oracle,
      output: initial.output
    });
    expect(initial.score).toMatchObject({
      targetCorrect: false,
      resolutionConsistent: false
    });
    expect(interpretH1c(observations).derivableCritique).toMatchObject({
      status: 'NO_CONTROLLED_CRITIQUE_SIGNAL',
      validCritiqueWinsOverBothControls: 3,
      controlledCritiqueMechanism: { eligible: 4, passed: 3, failed: 1 }
    });
  });

  it('does not count a placebo control that omits its visible issue from resolution', async () => {
    const observations = await informativeDerivableObservations();
    const { participant, oracle } = await caseFixture('H1C-D5');
    const placebo = observations.find((item) =>
      item.blockId === 'H1C-D5:r1' && item.conditionId === 'PLACEBO_CRITIQUE'
    )!;
    placebo.output!.resolution.resolvedIssueIds = [];
    placebo.score = scoreH1cOutput({
      conditionId: 'PLACEBO_CRITIQUE',
      oracle,
      output: placebo.output,
      draftOutput: placebo.draftOutput,
      visibleIssueIds: [participant.placeboCritique!.issueId]
    });

    expect(placebo.score).toMatchObject({
      targetCorrect: false,
      critiqueDispositionAppropriate: true,
      resolutionConsistent: false
    });
    expect(interpretH1c(observations).derivableCritique).toMatchObject({
      status: 'NO_CONTROLLED_CRITIQUE_SIGNAL',
      validCritiqueWinsOverBothControls: 3,
      controlledCritiqueMechanism: { eligible: 4, passed: 3, failed: 1 }
    });
  });

  it('does not count incoherent or falsely represented no-op self-review controls', async () => {
    const inconsistent = await informativeDerivableObservations();
    const { oracle } = await caseFixture('H1C-D5');
    const self = inconsistent.find((item) =>
      item.blockId === 'H1C-D5:r1' && item.conditionId === 'ACTIVE_SELF_REVIEW'
    )!;
    self.output!.resolution.status = 'PARTIALLY_RESOLVED';
    self.score = scoreH1cOutput({
      conditionId: 'ACTIVE_SELF_REVIEW',
      oracle,
      output: self.output,
      draftOutput: self.draftOutput
    });
    expect(self.score).toMatchObject({
      targetCorrect: false,
      selfCorrectionRepresentationCorrect: true,
      resolutionConsistent: false
    });
    expect(interpretH1c(inconsistent).derivableCritique)
      .toMatchObject({ validCritiqueWinsOverBothControls: 3 });

    const falseNoOp = await informativeDerivableObservations();
    const claimedCorrection = falseNoOp.find((item) =>
      item.blockId === 'H1C-D5:r1' && item.conditionId === 'ACTIVE_SELF_REVIEW'
    )!;
    addSelfCorrection(
      claimedCorrection.output!,
      oracle.targetPropositionIds[0]!,
      ['PROPOSITION_ASSESSMENTS'],
      [oracle.targetPropositionIds[0]!]
    );
    claimedCorrection.score = scoreH1cOutput({
      conditionId: 'ACTIVE_SELF_REVIEW',
      oracle,
      output: claimedCorrection.output,
      draftOutput: claimedCorrection.draftOutput
    });
    expect(claimedCorrection.score).toMatchObject({
      targetCorrect: false,
      resolutionConsistent: true,
      selfCorrectionRepresentationCorrect: false
    });
    expect(interpretH1c(falseNoOp).derivableCritique).toMatchObject({
      status: 'NO_CONTROLLED_CRITIQUE_SIGNAL',
      validCritiqueWinsOverBothControls: 3,
      controlledCritiqueMechanism: { eligible: 4, passed: 3, failed: 1 }
    });
  });

  it('keeps incomplete and invalid critique blocks out of the eligible denominator', async () => {
    const source = await informativeDerivableObservations();
    const incomplete = source.filter((item) => !(
      item.blockId === 'H1C-D5:r1' && item.conditionId === 'PLACEBO_CRITIQUE'
    ));
    expect(interpretH1c(incomplete).derivableCritique).toMatchObject({
      status: 'INCONCLUSIVE',
      controlledCritiqueMechanism: {
        planned: 4, observed: 4, valid: 3, eligible: 3, passed: 3,
        invalid: 0, unavailable: 1, unstarted: 0
      }
    });

    const invalid = structuredClone(source);
    invalid.find((item) =>
      item.blockId === 'H1C-D5:r1' && item.conditionId === 'PLACEBO_CRITIQUE'
    )!.measurementStatus = 'INVALID';
    expect(interpretH1c(invalid).derivableCritique).toMatchObject({
      status: 'INCONCLUSIVE',
      controlledCritiqueMechanism: {
        planned: 4, observed: 4, valid: 3, eligible: 3, passed: 3,
        invalid: 1, unavailable: 0, unstarted: 0
      }
    });
  });

  it('keeps minority content and attribution as separate measurements', async () => {
    const { participant, oracle } = await caseFixture('H1C-D5');
    const output = outputFor(participant, oracle.baseProfile);
    const targetId = oracle.targetPropositionIds[0]!;
    const target = output.propositionAssessments.find(
      (item) => item.propositionId === targetId
    )!;
    target.artifactReferences = [
      { artifactId: 'minority', relation: 'AGREES_WITH', note: 'Minority.' },
      { artifactId: 'majority', relation: 'DISAGREES_WITH', note: 'Opposition.' }
    ];
    expect(scoreMinorityPreservationV4({
      output,
      targetPropositionId: targetId,
      minorityAssessment: target.assessment,
      minorityArtifactIds: ['minority'],
      opposingArtifactIds: ['majority']
    })).toEqual({
      minorityContentRetained: true,
      minorityAttributionRetained: true,
      opposingAttributionRetained: true,
      falseConsensus: false
    });
  });
});

async function caseFixture(caseId: string): Promise<{
  participant: H1cParticipantRecord;
  oracle: H1cOracleRecord;
}> {
  const participants = await loadH1cParticipantCorpus(fixtureRoot);
  const oracles = await loadH1cOracleCorpus(fixtureRoot, participants);
  return {
    participant: participants.records.find((item) => item.caseId === caseId)!,
    oracle: oracles.records.find((item) => item.caseId === caseId)!
  };
}

function outputFor(
  participant: H1cParticipantRecord,
  profile: H1cOracleProfile
): LabPublicOutputV4 {
  const requests = profile.informationRequest
    ? [{
        id: 'request-1',
        kind: profile.informationRequest.kind,
        needed: 'The exact missing predicate identified in the public case.',
        question: 'Please provide the exact missing predicate identified in the public case.',
        source: profile.informationRequest.source,
        blocking: profile.informationRequest.blocking,
        propositionIds: [...profile.informationRequest.requiredPropositionIds]
      }]
    : [];
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    completionDisposition: profile.completionDisposition,
    answer: {
      summary: 'Concise answer for the sealed expected profile.',
      selectedOptionIds: [...profile.selectedOptionIds],
      epistemicState: profile.epistemicState,
      assessmentConfidence: 0.95
    },
    propositionAssessments: profile.claims.map((claim, index) => {
      const proposition = participant.participantCase.propositions.find(
        (item) => item.id === claim.propositionId
      )!;
      return {
        id: `assessment-${index + 1}`,
        propositionId: claim.propositionId,
        topicId: proposition.topicId,
        assessment: claim.assessment,
        statement: proposition.text,
        factualEvidence: claim.requiredEvidenceAlternatives[0]!.map((item) => ({
          sourceId: item.evidenceId,
          relation: item.relation,
          note: 'Exact sealed factual source and direction.'
        })),
        artifactReferences: [],
        assumptionIds: [],
        assessmentConfidence: 0.95
      };
    }),
    assumptions: [],
    issues: [],
    responses: [],
    selfCorrections: [],
    disagreements: [],
    resolution: {
      status: profile.completionDisposition === 'NEEDS_USER_ACTION'
        ? 'NEEDS_USER_ACTION'
        : profile.epistemicState === 'UNDERDETERMINED'
          ? 'UNRESOLVED'
          : 'NO_DISAGREEMENT',
      basis: profile.epistemicState === 'UNDERDETERMINED'
        ? 'INSUFFICIENT_INFORMATION'
        : 'FACTUAL_EVIDENCE',
      summary: 'Resolution matches the public epistemic state.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    informationRequests: requests,
    abstention: null
  };
}

function disagreement(
  status: 'RESOLVED' | 'UNRESOLVED' | 'COMPATIBLE_DIFFERENCE' | 'NEEDS_USER_ACTION'
): LabPublicOutputV4['disagreements'][number] {
  return {
    id: 'disagreement-1',
    propositionIds: ['h1c-d6-p1'],
    participantArtifactIds: ['DRAFT'],
    status,
    summary: 'The public disagreement is represented explicitly.',
    factualEvidence: [{ sourceId: 'PROMPT', relation: 'SUPPORTS', note: 'Public evidence.' }],
    artifactReferences: [{
      artifactId: 'DRAFT', relation: 'MENTIONS', note: 'The represented prior position.'
    }],
    informationRequestId: null
  };
}

function critiqueOutput(
  participant: H1cParticipantRecord,
  oracle: H1cOracleRecord,
  conditionId: Extract<H1cConditionId, 'VALID_CRITIQUE' | 'PLACEBO_CRITIQUE'>,
  disposition: 'ACCEPT' | 'REJECT'
): LabPublicOutputV4 {
  const output = outputFor(participant, oracle.baseProfile);
  const signal = conditionId === 'VALID_CRITIQUE'
    ? participant.validCritique!
    : participant.placeboCritique!;
  const target = output.propositionAssessments.find(
    (item) => item.propositionId === signal.targetPropositionId
  )!;
  output.responses = [{
    id: 'response-1',
    targetArtifactId: signal.artifactId,
    targetIssueId: signal.issueId,
    disposition,
    statement: disposition === 'ACCEPT' ? 'The critique identifies an issue.' : 'No issue.',
    factualEvidence: [{ sourceId: 'PROMPT', relation: 'SUPPORTS', note: 'Public case facts.' }],
    artifactReferences: [{
      artifactId: signal.artifactId,
      relation: 'RESPONDS_TO',
      note: 'Direct response to this critique.'
    }],
    changedAssessmentIds: disposition === 'ACCEPT' ? [target.id] : []
  }];
  output.resolution = {
    status: 'RESOLVED',
    basis: 'FACTUAL_EVIDENCE',
    summary: 'The visible issue was dispositioned.',
    resolvedIssueIds: [signal.issueId],
    unresolvedIssueIds: []
  };
  return output;
}

function makeDerivableTargetWrong(
  participant: H1cParticipantRecord,
  oracle: H1cOracleRecord,
  output: LabPublicOutputV4
): void {
  const targetId = oracle.targetPropositionIds[0]!;
  const target = output.propositionAssessments.find(
    (item) => item.propositionId === targetId
  )!;
  const expected = oracle.baseProfile.claims.find(
    (claim) => claim.propositionId === targetId
  )!.assessment;
  target.assessment = expected === 'SUPPORTED' ? 'CONTRADICTED' : 'SUPPORTED';
  target.factualEvidence = [{
    sourceId: 'PROMPT',
    relation: target.assessment === 'SUPPORTED' ? 'SUPPORTS' : 'CONTRADICTS',
    note: 'Deliberately wrong live draft for this metric test.'
  }];
  output.answer.selectedOptionIds = [
    participant.participantCase.options.find(
      (option) => !oracle.baseProfile.selectedOptionIds.includes(option.id)
    )!.id
  ];
}

function addSelfCorrection(
  output: LabPublicOutputV4,
  targetPropositionId: string,
  changedPublicFields: LabSelfCorrectionFieldV4[],
  changedPropositionIds: string[]
): void {
  output.issues = [{
    id: 'self-found-issue',
    targetArtifactId: 'DRAFT',
    targetPropositionId,
    kind: 'OTHER',
    severity: 'ADVISORY',
    statement: 'The prior draft needs a public correction.',
    factualEvidence: [{ sourceId: 'PROMPT', relation: 'SUPPORTS', note: 'Case support.' }],
    artifactReferences: [{ artifactId: 'DRAFT', relation: 'MENTIONS', note: 'Prior draft.' }],
    assessmentConfidence: 0.95
  }];
  output.selfCorrections = [{
    id: 'self-correction-1',
    targetArtifactId: 'DRAFT',
    targetIssueId: 'self-found-issue',
    disposition: 'CORRECTED',
    statement: 'Corrected the public answer and target assessment.',
    changedPublicFields,
    changedPropositionIds
  }];
  output.resolution = {
    status: 'RESOLVED',
    basis: 'FACTUAL_EVIDENCE',
    summary: 'The self-found issue was corrected.',
    resolvedIssueIds: ['self-found-issue'],
    unresolvedIssueIds: []
  };
}

async function completeEvidenceObservations(): Promise<H1cScoredObservation[]> {
  const observations: H1cScoredObservation[] = [];
  for (const caseId of ['H1C-E5', 'H1C-E6']) {
    const { participant, oracle } = await caseFixture(caseId);
    for (const repetition of [1, 2] as const) {
      const draft = outputFor(participant, oracle.baseProfile);
      for (const [conditionId, output] of [
        ['STRONG_INITIAL', draft],
        ['ACTIVE_SELF_REVIEW', structuredClone(draft)],
        ['DECISIVE_EVIDENCE', outputFor(participant, oracle.treatmentProfile)]
      ] as const) {
        observations.push(scoredObservation(
          caseId,
          repetition,
          conditionId,
          oracle,
          output,
          draft
        ));
      }
    }
  }
  return observations;
}

async function ceilingDerivableObservations(): Promise<H1cScoredObservation[]> {
  const observations: H1cScoredObservation[] = [];
  for (const caseId of ['H1C-D5', 'H1C-D6']) {
    const { participant, oracle } = await caseFixture(caseId);
    for (const repetition of [1, 2] as const) {
      const draft = outputFor(participant, oracle.baseProfile);
      for (const conditionId of [
        'STRONG_INITIAL', 'ACTIVE_SELF_REVIEW', 'VALID_CRITIQUE', 'PLACEBO_CRITIQUE'
      ] as const) {
        const output = conditionId === 'VALID_CRITIQUE'
          ? critiqueOutput(participant, oracle, conditionId, 'REJECT')
          : conditionId === 'PLACEBO_CRITIQUE'
            ? critiqueOutput(participant, oracle, conditionId, 'REJECT')
            : structuredClone(draft);
        observations.push(scoredObservation(
          caseId, repetition, conditionId, oracle, output, draft,
          conditionId === 'VALID_CRITIQUE'
            ? [participant.validCritique!.issueId]
            : conditionId === 'PLACEBO_CRITIQUE'
              ? [participant.placeboCritique!.issueId]
              : []
        ));
      }
    }
  }
  return observations;
}

async function informativeDerivableObservations(): Promise<H1cScoredObservation[]> {
  const observations: H1cScoredObservation[] = [];
  for (const caseId of ['H1C-D5', 'H1C-D6']) {
    const { participant, oracle } = await caseFixture(caseId);
    for (const repetition of [1, 2] as const) {
      const draft = outputFor(participant, oracle.baseProfile);
      makeDerivableTargetWrong(participant, oracle, draft);
      const self = structuredClone(draft);
      const valid = critiqueOutput(participant, oracle, 'VALID_CRITIQUE', 'ACCEPT');
      const placebo = critiqueOutput(participant, oracle, 'PLACEBO_CRITIQUE', 'REJECT');
      makeDerivableTargetWrong(participant, oracle, placebo);
      for (const [conditionId, output, visibleIssueIds] of [
        ['STRONG_INITIAL', draft, []],
        ['ACTIVE_SELF_REVIEW', self, []],
        ['VALID_CRITIQUE', valid, [participant.validCritique!.issueId]],
        ['PLACEBO_CRITIQUE', placebo, [participant.placeboCritique!.issueId]]
      ] as const) {
        observations.push(scoredObservation(
          caseId, repetition, conditionId, oracle, output, draft, visibleIssueIds
        ));
      }
    }
  }
  return observations;
}

function scoredObservation(
  caseId: string,
  repetition: 1 | 2,
  conditionId: H1cConditionId,
  oracle: H1cOracleRecord,
  output: LabPublicOutputV4,
  draftOutput: LabPublicOutputV4,
  visibleIssueIds: readonly string[] = []
): H1cScoredObservation {
  return {
    blockId: `${caseId}:r${repetition}`,
    caseId,
    repetition,
    conditionId,
    score: scoreH1cOutput({
      conditionId,
      oracle,
      output,
      draftOutput,
      visibleIssueIds
    }),
    output,
    draftOutput,
    measurementStatus: 'VALID'
  };
}
