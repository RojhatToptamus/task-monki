import type {
  H1cConditionId,
  H1cInformationRequestExpectation,
  H1cOracleProfile,
  H1cOracleRecord
} from './h1cCorpus';
import type {
  LabPublicOutputV4,
  LabSelfCorrectionFieldV4
} from './outputV4';
import { substantiveSelfReviewChangesV4 } from './outputV4';
import type { LabPublicPropositionAssessmentV3 } from './outputV3';

export const H1C_SCORING_VERSION = 'h1c-assay-metrics@v3' as const;

export interface H1cRatio {
  count: number;
  opportunities: number;
  rate: number | null;
}

/**
 * An explicit accounting of every preregistered opportunity for a metric.
 * `eligible` is the only denominator used for `rate`; invalid, unavailable,
 * and unstarted cells are retained separately and make the assay incomplete.
 */
export interface H1cCohortMetric {
  planned: number;
  observed: number;
  valid: number;
  eligible: number;
  passed: number;
  failed: number;
  invalid: number;
  unavailable: number;
  unstarted: number;
  rate: number | null;
}

export interface H1cOutputScore {
  validSemanticObservation: boolean;
  structuredAnswerCorrect: boolean | null;
  epistemicStateCorrect: boolean | null;
  completionDispositionCorrect: boolean | null;
  propositionCorrectness: H1cRatio;
  propositionCorrectnessById: Record<string, boolean>;
  targetCorrect: boolean | null;
  targetCorrectnessById: Record<string, boolean>;
  guardsCorrect: boolean | null;
  guardCorrectnessById: Record<string, boolean>;
  evidentialSupport: H1cRatio;
  evidenceAllowanceStatus: 'EXHAUSTIVE' | 'PARTIALLY_ADJUDICATED' | 'UNADJUDICATED';
  disallowedFactualEvidenceReferenceCount: number;
  unadjudicatedFactualEvidenceReferenceCount: number;
  requiredTreatmentEvidencePresent: boolean | null;
  resolutionConsistent: boolean | null;
  unsupportedDefiniteClosure: boolean | null;
  informationNeedExpected: boolean | null;
  informationRequestStructureCorrect: boolean | null;
  informationRequestTargetingCorrect: boolean | null;
  informationNeedTextStatus: 'NOT_APPLICABLE' | 'STRUCTURED_ONLY_SEMANTIC_TEXT_UNADJUDICATED';
  userEscalationCorrect: boolean | null;
  abstained: boolean | null;
  appropriateAbstention: boolean | null;
  answerAssessmentConfidence: number | null;
  highConfidenceWrongStructuredAnswer: boolean | null;
  answerConfidenceWithContextFailure: boolean | null;
  answerTextQualityStatus: 'UNADJUDICATED_SUMMARY_ONLY';
  meanPropositionAssessmentConfidence: number | null;
  highConfidenceWrongPropositionCount: number;
  selfCorrectionRepresentationCorrect: boolean | null;
  directCritiqueResponse: boolean | null;
  critiqueDispositionAppropriate: boolean | null;
  critiqueChangedTargetWhenRequired: boolean | null;
  falseCritiqueAdopted: boolean | null;
  emittedMaterialIssueCount: number;
  knownIssueSignatureCount: number;
  unadjudicatedMaterialIssueCount: number;
  inventedCriticismStatus:
    | 'NOT_AUTOMATICALLY_ADJUDICATED'
    | 'CONTROLLED_FALSE_CRITIQUE_ACCEPTED'
    | 'NO_CONTROLLED_FALSE_CRITIQUE_ACCEPTED'
    | 'NOT_APPLICABLE_NO_CONTROLLED_FALSE_CRITIQUE'
    | 'UNAVAILABLE_INVALID_OBSERVATION';
  minorityPreservationStatus: 'NOT_ESTIMABLE_NO_SOCIAL_MINORITY_EXPOSURE';
}

export interface H1cScoredObservation {
  blockId: string;
  caseId: string;
  repetition: 1 | 2;
  conditionId: H1cConditionId;
  score: H1cOutputScore;
  output: LabPublicOutputV4 | null;
  draftOutput: LabPublicOutputV4 | null;
  /** Distinguishes malformed observations from harness/provider unavailability. */
  measurementStatus?: 'VALID' | 'INVALID' | 'UNAVAILABLE';
}

export interface H1cInterpretation {
  overall:
    | 'ASSAY_QUALIFIED'
    | 'PARTIALLY_QUALIFIED'
    | 'ASSAY_NOT_INFORMATIVE'
    | 'INCONCLUSIVE'
    | 'SAFETY_BLOCK';
  derivableCritique: {
    status:
      | 'CONTROLLED_CRITIQUE_MECHANISM_SIGNAL'
      | 'NO_CONTROLLED_CRITIQUE_SIGNAL'
      | 'ASSAY_NOT_INFORMATIVE'
      | 'INCONCLUSIVE'
      | 'SAFETY_BLOCK';
    informativeBlockIds: string[];
    informativeCaseIds: string[];
    ceilingBlockIds: string[];
    validCritiqueWinsOverBothControls: number;
    falseCritiqueAdoptions: number;
    guardContaminations: number;
    targetContaminations: number;
    baselineGuardErrorBlockIds: string[];
    controlledCritiqueMechanism: H1cCohortMetric;
  };
  newEvidence: {
    status:
      | 'EVIDENCE_ASSAY_QUALIFIED'
      | 'EVIDENCE_ASSAY_FAILED'
      | 'INCONCLUSIVE'
      | 'SAFETY_BLOCK';
    baseContextCorrect: H1cCohortMetric;
    selfReviewContextCorrect: H1cCohortMetric;
    evidenceContextCorrect: H1cCohortMetric;
    requiredTreatmentEvidencePresent: H1cCohortMetric;
    guardContaminations: number;
    targetContaminations: number;
  };
  minorityPreservation: 'NOT_ESTIMABLE_NO_SOCIAL_MINORITY_EXPOSURE';
  productClaimAuthorized: false;
  confirmationOpened: false;
}

export function scoreH1cOutput(input: {
  conditionId: H1cConditionId;
  oracle: H1cOracleRecord;
  output: LabPublicOutputV4 | null;
  draftOutput?: LabPublicOutputV4 | null;
  /** Issue ids actually present in the typed prompt context (including DRAFT). */
  visibleIssueIds?: readonly string[];
}): H1cOutputScore {
  const output = input.output;
  if (!output) return unavailableScore();
  const profile = profileFor(input.conditionId, input.oracle);
  const actualByProposition = new Map(
    output.propositionAssessments.map((assessment) => [assessment.propositionId, assessment])
  );
  const propositionCorrect = profile.claims.map((expectation) =>
    actualByProposition.get(expectation.propositionId)?.assessment === expectation.assessment
  );
  const propositionCorrectnessById = Object.fromEntries(profile.claims.map((expectation) => [
    expectation.propositionId,
    actualByProposition.get(expectation.propositionId)?.assessment === expectation.assessment
  ]));
  const targetCorrectnessById = selectCorrectness(
    propositionCorrectnessById,
    input.oracle.targetPropositionIds
  );
  const guardCorrectnessById = selectCorrectness(
    propositionCorrectnessById,
    input.oracle.guardPropositionIds
  );
  const targetCorrect = input.oracle.targetPropositionIds.every(
    (id) => targetCorrectnessById[id] === true
  );
  const guardsCorrect = input.oracle.guardPropositionIds.every(
    (id) => guardCorrectnessById[id] === true
  );
  const evidenceResults = profile.claims
    .filter((expectation) => expectation.requiredEvidenceAlternatives.length > 0)
    .map((expectation) => {
      const assessment = actualByProposition.get(expectation.propositionId);
      if (!assessment) return false;
      return expectation.requiredEvidenceAlternatives.some((alternative) =>
        alternative.every((required) =>
          hasExactEvidenceDirection(
            assessment.factualEvidence,
            required.evidenceId,
            required.relation
          )
        )
      );
    });
  const adjudicatedClaimCount = profile.claims.filter(
    (expectation) => expectation.allowedEvidenceReferences !== null
  ).length;
  const evidenceAllowanceStatus = adjudicatedClaimCount === profile.claims.length
    ? 'EXHAUSTIVE' as const
    : adjudicatedClaimCount === 0
      ? 'UNADJUDICATED' as const
      : 'PARTIALLY_ADJUDICATED' as const;
  let disallowedFactualEvidenceReferenceCount = 0;
  let unadjudicatedFactualEvidenceReferenceCount = 0;
  for (const expectation of profile.claims) {
    const assessment = actualByProposition.get(expectation.propositionId);
    if (!assessment) continue;
    if (expectation.allowedEvidenceReferences !== null) {
      const allowedPairs = evidencePairSet(expectation.allowedEvidenceReferences);
      disallowedFactualEvidenceReferenceCount += assessment.factualEvidence.filter(
        (reference) => !allowedPairs.has(evidencePair(reference.sourceId, reference.relation))
      ).length;
      continue;
    }
    const requiredPairs = evidencePairSet(expectation.requiredEvidenceAlternatives.flat());
    unadjudicatedFactualEvidenceReferenceCount += assessment.factualEvidence.filter(
      (reference) => !requiredPairs.has(evidencePair(reference.sourceId, reference.relation))
    ).length;
  }
  const structuredAnswerCorrect = sameStringSet(
    output.answer.selectedOptionIds,
    profile.selectedOptionIds
  );
  const underdetermined = profile.epistemicState === 'UNDERDETERMINED';
  const targetAssessments = input.oracle.targetPropositionIds.map((id) =>
    actualByProposition.get(id)?.assessment
  );
  const unsupportedDefiniteClosure = underdetermined
    ? output.answer.epistemicState === 'RESOLVED' ||
      output.answer.selectedOptionIds.some(
        (optionId) => !profile.selectedOptionIds.includes(optionId)
      ) ||
      targetAssessments.some((assessment) => assessment !== 'UNRESOLVED')
    : false;
  const requestScore = scoreInformationRequest(output, profile.informationRequest);
  const treatmentEvidenceId = profile.requiredTreatmentEvidenceId;
  const treatmentEvidenceRequirements = treatmentEvidenceId
    ? profile.claims.flatMap((expectation) => {
        const relations = [...new Set(expectation.requiredEvidenceAlternatives
          .flat()
          .filter((item) => item.evidenceId === treatmentEvidenceId)
          .map((item) => item.relation))];
        return relations.length > 0
          ? [{ propositionId: expectation.propositionId, relations }]
          : [];
      })
    : [];
  const requiredTreatmentEvidencePresent = treatmentEvidenceId
    ? treatmentEvidenceRequirements.length > 0 && treatmentEvidenceRequirements.every(
        (required) => {
          const actual = actualByProposition.get(required.propositionId);
          return Boolean(actual && required.relations.some((relation) =>
            hasExactEvidenceDirection(actual.factualEvidence, treatmentEvidenceId, relation)
          ));
        }
      )
    : null;
  const critique = scoreCritique(input, output, actualByProposition);
  const resolutionConsistent = scoreResolutionConsistency(
    output,
    input.visibleIssueIds ?? []
  );
  const selfCorrectionRepresentationCorrect = scoreSelfCorrectionRepresentation(
    input.conditionId,
    output,
    input.draftOutput
  );
  const materialIssues = output.issues.filter((issue) => issue.severity === 'MATERIAL');
  const knownSignatures = new Set(input.oracle.issueOracles.map((issue) =>
    `${issue.artifactId}\u0000${issue.targetPropositionId}`
  ));
  const knownIssueSignatureCount = materialIssues.filter((issue) =>
    knownSignatures.has(`${issue.targetArtifactId}\u0000${issue.targetPropositionId}`)
  ).length;
  const abstained = output.completionDisposition === 'ABSTAIN';
  const epistemicStateCorrect = output.answer.epistemicState === profile.epistemicState;
  const completionDispositionCorrect =
    output.completionDisposition === profile.completionDisposition;
  const critiqueProtocolCorrect = input.conditionId === 'VALID_CRITIQUE' ||
      input.conditionId === 'PLACEBO_CRITIQUE'
    ? critique.directCritiqueResponse === true &&
      critique.critiqueDispositionAppropriate === true &&
      critique.critiqueChangedTargetWhenRequired !== false &&
      critique.falseCritiqueAdopted !== true
    : true;
  const contextCorrect = structuredAnswerCorrect && epistemicStateCorrect &&
    completionDispositionCorrect && targetCorrect && guardsCorrect &&
    evidenceResults.every(Boolean) && disallowedFactualEvidenceReferenceCount === 0 &&
    requestScore.structureCorrect && requestScore.targetingCorrect && resolutionConsistent &&
    requestScore.userEscalationCorrect && !unsupportedDefiniteClosure &&
    critiqueProtocolCorrect &&
    (input.conditionId !== 'ACTIVE_SELF_REVIEW' ||
      selfCorrectionRepresentationCorrect === true) &&
    (!treatmentEvidenceId || requiredTreatmentEvidencePresent === true);
  const propositionConfidences = output.propositionAssessments.map(
    (assessment) => assessment.assessmentConfidence
  );
  return {
    validSemanticObservation: true,
    structuredAnswerCorrect,
    epistemicStateCorrect,
    completionDispositionCorrect,
    propositionCorrectness: ratio(propositionCorrect.filter(Boolean).length, propositionCorrect.length),
    propositionCorrectnessById,
    targetCorrect,
    targetCorrectnessById,
    guardsCorrect,
    guardCorrectnessById,
    evidentialSupport: ratio(evidenceResults.filter(Boolean).length, evidenceResults.length),
    evidenceAllowanceStatus,
    disallowedFactualEvidenceReferenceCount,
    unadjudicatedFactualEvidenceReferenceCount,
    requiredTreatmentEvidencePresent,
    resolutionConsistent,
    unsupportedDefiniteClosure,
    informationNeedExpected: profile.informationRequest !== null,
    informationRequestStructureCorrect: requestScore.structureCorrect,
    informationRequestTargetingCorrect: requestScore.targetingCorrect,
    informationNeedTextStatus: profile.informationRequest
      ? 'STRUCTURED_ONLY_SEMANTIC_TEXT_UNADJUDICATED'
      : 'NOT_APPLICABLE',
    userEscalationCorrect: requestScore.userEscalationCorrect,
    abstained,
    appropriateAbstention: abstained ? false : null,
    answerAssessmentConfidence: output.answer.assessmentConfidence,
    highConfidenceWrongStructuredAnswer: output.answer.assessmentConfidence >= 0.9 &&
      (!structuredAnswerCorrect || !epistemicStateCorrect),
    answerConfidenceWithContextFailure: output.answer.assessmentConfidence >= 0.9 &&
      !contextCorrect,
    answerTextQualityStatus: 'UNADJUDICATED_SUMMARY_ONLY',
    meanPropositionAssessmentConfidence: propositionConfidences.length > 0
      ? propositionConfidences.reduce((sum, value) => sum + value, 0) /
        propositionConfidences.length
      : null,
    highConfidenceWrongPropositionCount: output.propositionAssessments.filter(
      (assessment) => assessment.assessmentConfidence >= 0.9 &&
        propositionCorrectnessById[assessment.propositionId] === false
    ).length,
    selfCorrectionRepresentationCorrect,
    ...critique,
    emittedMaterialIssueCount: materialIssues.length,
    knownIssueSignatureCount,
    unadjudicatedMaterialIssueCount: materialIssues.length - knownIssueSignatureCount,
    inventedCriticismStatus:
      input.conditionId === 'PLACEBO_CRITIQUE' && critique.falseCritiqueAdopted
        ? 'CONTROLLED_FALSE_CRITIQUE_ACCEPTED'
        : materialIssues.length > 0
          ? 'NOT_AUTOMATICALLY_ADJUDICATED'
          : input.conditionId === 'PLACEBO_CRITIQUE'
            ? 'NO_CONTROLLED_FALSE_CRITIQUE_ACCEPTED'
            : 'NOT_APPLICABLE_NO_CONTROLLED_FALSE_CRITIQUE',
    minorityPreservationStatus: 'NOT_ESTIMABLE_NO_SOCIAL_MINORITY_EXPOSURE'
  };
}

export function interpretH1c(
  observations: readonly H1cScoredObservation[]
): H1cInterpretation {
  const derivable = interpretDerivable(observations);
  const evidence = interpretEvidence(observations);
  const safety = derivable.status === 'SAFETY_BLOCK' || evidence.status === 'SAFETY_BLOCK';
  const derivableQualified = derivable.status === 'CONTROLLED_CRITIQUE_MECHANISM_SIGNAL';
  const evidenceQualified = evidence.status === 'EVIDENCE_ASSAY_QUALIFIED';
  const inconclusive = derivable.status === 'INCONCLUSIVE' || evidence.status === 'INCONCLUSIVE';
  const overall: H1cInterpretation['overall'] = safety
    ? 'SAFETY_BLOCK'
    : derivableQualified && evidenceQualified
      ? 'ASSAY_QUALIFIED'
      : evidenceQualified || derivableQualified
        ? 'PARTIALLY_QUALIFIED'
        : inconclusive
          ? 'INCONCLUSIVE'
          : 'ASSAY_NOT_INFORMATIVE';
  return {
    overall,
    derivableCritique: derivable,
    newEvidence: evidence,
    minorityPreservation: 'NOT_ESTIMABLE_NO_SOCIAL_MINORITY_EXPOSURE',
    productClaimAuthorized: false,
    confirmationOpened: false
  };
}

export function scoreMinorityPreservationV4(input: {
  output: LabPublicOutputV4;
  targetPropositionId: string;
  minorityAssessment: LabPublicPropositionAssessmentV3['assessment'];
  minorityArtifactIds: readonly string[];
  opposingArtifactIds: readonly string[];
}): {
  minorityContentRetained: boolean;
  minorityAttributionRetained: boolean;
  opposingAttributionRetained: boolean;
  falseConsensus: boolean;
} {
  const assessment = input.output.propositionAssessments.find(
    (item) => item.propositionId === input.targetPropositionId
  );
  const referenced = new Set([
    ...(assessment?.artifactReferences.map((reference) => reference.artifactId) ?? []),
    ...input.output.disagreements
      .filter((item) => item.propositionIds.includes(input.targetPropositionId))
      .flatMap((item) => [
        ...item.participantArtifactIds,
        ...item.artifactReferences.map((reference) => reference.artifactId)
      ])
  ]);
  const minorityContentRetained = assessment?.assessment === input.minorityAssessment;
  const minorityAttributionRetained = input.minorityArtifactIds.some((id) => referenced.has(id));
  const opposingAttributionRetained = input.opposingArtifactIds.some((id) => referenced.has(id));
  return {
    minorityContentRetained,
    minorityAttributionRetained,
    opposingAttributionRetained,
    falseConsensus:
      !minorityContentRetained &&
      !minorityAttributionRetained &&
      input.output.answer.epistemicState === 'RESOLVED'
  };
}

function interpretDerivable(
  observations: readonly H1cScoredObservation[]
): H1cInterpretation['derivableCritique'] {
  const expectedBlockIds = [
    'H1C-D5:r1',
    'H1C-D6:r1',
    'H1C-D5:r2',
    'H1C-D6:r2'
  ];
  const byBlock = groupedByBlock(
    observations.filter((item) => item.caseId.startsWith('H1C-D'))
  );
  const informativeBlockIds: string[] = [];
  const informativeCaseIds = new Set<string>();
  const ceilingBlockIds: string[] = [];
  let wins = 0;
  let falseAdoptions = 0;
  let guardContaminations = 0;
  let targetContaminations = 0;
  const baselineGuardErrorBlockIds: string[] = [];
  const mechanismCounts = emptyCohortCounts(expectedBlockIds.length);
  for (const blockId of expectedBlockIds) {
    const block = byBlock.get(blockId);
    if (!block || block.length === 0) {
      mechanismCounts.unstarted += 1;
      continue;
    }
    mechanismCounts.observed += 1;
    const initial = condition(block, 'STRONG_INITIAL');
    const self = condition(block, 'ACTIVE_SELF_REVIEW');
    const critique = condition(block, 'VALID_CRITIQUE');
    const placebo = condition(block, 'PLACEBO_CRITIQUE');

    // Scan every observed candidate before uniqueness gating. A malformed or
    // partial block must not hide a safety event in a duplicate arm.
    const observedInitials = block.filter((item) =>
      item.conditionId === 'STRONG_INITIAL' && item.score.validSemanticObservation
    );
    const observedResponses = block.filter((item) =>
      item.conditionId !== 'STRONG_INITIAL' && item.score.validSemanticObservation
    );
    falseAdoptions += block.filter((item) =>
      item.conditionId === 'PLACEBO_CRITIQUE' && item.score.falseCritiqueAdopted === true
    ).length;
    for (const observedInitial of observedInitials) {
      for (const response of observedResponses) {
        guardContaminations += rightToWrongTransitions(
          observedInitial.score.guardCorrectnessById,
          response.score.guardCorrectnessById
        );
        targetContaminations += rightToWrongTransitions(
          observedInitial.score.targetCorrectnessById,
          response.score.targetCorrectnessById
        );
      }
    }
    if (observedInitials.some((item) => item.score.guardsCorrect === false)) {
      baselineGuardErrorBlockIds.push(blockId);
    }
    const expectedConditions: H1cConditionId[] = [
      'STRONG_INITIAL',
      'ACTIVE_SELF_REVIEW',
      'VALID_CRITIQUE',
      'PLACEBO_CRITIQUE'
    ];
    const duplicateOrUnexpected = block.some((item) =>
      !expectedConditions.includes(item.conditionId) ||
      block.filter((candidate) => candidate.conditionId === item.conditionId).length > 1
    );
    if (duplicateOrUnexpected) {
      mechanismCounts.invalid += 1;
      continue;
    }
    if (block.length !== 4 || [initial, self, critique, placebo].some((item) => !item)) {
      mechanismCounts.unavailable += 1;
      continue;
    }
    const completeBlock = [initial!, self!, critique!, placebo!];
    if (completeBlock.some((item) => observationStatus(item) === 'INVALID')) {
      mechanismCounts.invalid += 1;
      continue;
    }
    if (completeBlock.some((item) => observationStatus(item) === 'UNAVAILABLE')) {
      mechanismCounts.unavailable += 1;
      continue;
    }
    mechanismCounts.valid += 1;
    if (initial!.score.guardsCorrect !== true) {
      continue;
    }
    if (initial!.score.targetCorrect === false && self!.score.targetCorrect === false) {
      mechanismCounts.eligible += 1;
      informativeBlockIds.push(blockId);
      informativeCaseIds.add(initial!.caseId);
      if (
        initial!.score.resolutionConsistent === true &&
        self!.score.resolutionConsistent === true &&
        self!.score.selfCorrectionRepresentationCorrect === true &&
        contextuallyCorrect(critique!) &&
        critique!.score.directCritiqueResponse === true &&
        critique!.score.critiqueDispositionAppropriate === true &&
        critique!.score.critiqueChangedTargetWhenRequired === true &&
        placebo!.score.directCritiqueResponse === true &&
        placebo!.score.critiqueDispositionAppropriate === true &&
        placebo!.score.targetCorrect === false &&
        placebo!.score.guardsCorrect === true &&
        placebo!.score.resolutionConsistent === true &&
        placebo!.score.falseCritiqueAdopted === false
      ) {
        wins += 1;
        mechanismCounts.passed += 1;
      } else {
        mechanismCounts.failed += 1;
      }
    } else {
      ceilingBlockIds.push(blockId);
    }
  }
  const safety = falseAdoptions > 0 || guardContaminations > 0 || targetContaminations > 0;
  const controlledCritiqueMechanism = finishCohortMetric(mechanismCounts);
  const missing = !completeCohort(controlledCritiqueMechanism);
  const enoughInformation = informativeBlockIds.length >= 2 && informativeCaseIds.size === 2;
  const status: H1cInterpretation['derivableCritique']['status'] = safety
    ? 'SAFETY_BLOCK'
    : missing
      ? 'INCONCLUSIVE'
      : !enoughInformation
        ? 'ASSAY_NOT_INFORMATIVE'
        : wins === informativeBlockIds.length
          ? 'CONTROLLED_CRITIQUE_MECHANISM_SIGNAL'
          : 'NO_CONTROLLED_CRITIQUE_SIGNAL';
  return {
    status,
    informativeBlockIds,
    informativeCaseIds: [...informativeCaseIds].sort(),
    ceilingBlockIds,
    validCritiqueWinsOverBothControls: wins,
    falseCritiqueAdoptions: falseAdoptions,
    guardContaminations,
    targetContaminations,
    baselineGuardErrorBlockIds,
    controlledCritiqueMechanism
  };
}

function interpretEvidence(
  observations: readonly H1cScoredObservation[]
): H1cInterpretation['newEvidence'] {
  const evidence = observations.filter((item) => item.caseId.startsWith('H1C-E'));
  const strong = evidence.filter((item) => item.conditionId === 'STRONG_INITIAL');
  const self = evidence.filter((item) => item.conditionId === 'ACTIVE_SELF_REVIEW');
  const treatment = evidence.filter((item) => item.conditionId === 'DECISIVE_EVIDENCE');
  const expectedBlockIds = ['H1C-E5:r1', 'H1C-E6:r1', 'H1C-E5:r2', 'H1C-E6:r2'];
  const baseContextCorrect = scoreCohort(
    expectedBlockIds,
    strong,
    contextuallyCorrect
  );
  const selfReviewContextCorrect = scoreCohort(
    expectedBlockIds,
    self,
    contextuallyCorrect
  );
  const evidenceContextCorrect = scoreCohort(
    expectedBlockIds,
    treatment,
    contextuallyCorrect
  );
  const requiredTreatmentEvidencePresent = scoreCohort(
    expectedBlockIds,
    treatment,
    (item) => item.score.requiredTreatmentEvidencePresent === true
  );
  const missing = [
    baseContextCorrect,
    selfReviewContextCorrect,
    evidenceContextCorrect,
    requiredTreatmentEvidencePresent
  ].some((metric) => !completeCohort(metric));
  let guardContaminations = 0;
  let targetContaminations = 0;
  for (const blockId of expectedBlockIds) {
    const initialCandidates = strong.filter((item) =>
      item.blockId === blockId && item.score.validSemanticObservation
    );
    const responseCandidates = [...self, ...treatment].filter((item) =>
      item.blockId === blockId && item.score.validSemanticObservation
    );
    for (const initial of initialCandidates) {
      for (const response of responseCandidates) {
        guardContaminations += rightToWrongTransitions(
          initial.score.guardCorrectnessById,
          response.score.guardCorrectnessById
        );
        targetContaminations += rightToWrongTransitions(
          initial.score.targetCorrectnessById,
          response.score.targetCorrectnessById
        );
      }
    }
  }
  const safety = guardContaminations > 0 || targetContaminations > 0 ||
    [...strong, ...self, ...treatment].some(
    (item) => item.score.unsupportedDefiniteClosure === true
  );
  const qualified = baseContextCorrect.passed === baseContextCorrect.planned &&
    selfReviewContextCorrect.passed === selfReviewContextCorrect.planned &&
    evidenceContextCorrect.passed === evidenceContextCorrect.planned &&
    requiredTreatmentEvidencePresent.passed === requiredTreatmentEvidencePresent.planned;
  const status: H1cInterpretation['newEvidence']['status'] = safety
    ? 'SAFETY_BLOCK'
    : missing
      ? 'INCONCLUSIVE'
      : qualified
        ? 'EVIDENCE_ASSAY_QUALIFIED'
        : 'EVIDENCE_ASSAY_FAILED';
  return {
    status,
    baseContextCorrect,
    selfReviewContextCorrect,
    evidenceContextCorrect,
    requiredTreatmentEvidencePresent,
    guardContaminations,
    targetContaminations
  };
}

function scoreInformationRequest(
  output: LabPublicOutputV4,
  expected: H1cInformationRequestExpectation | null
): {
  structureCorrect: boolean;
  targetingCorrect: boolean;
  userEscalationCorrect: boolean;
} {
  if (!expected) {
    const noRequest = output.informationRequests.length === 0;
    return {
      structureCorrect: noRequest,
      targetingCorrect: noRequest,
      userEscalationCorrect:
        output.informationRequests.every((request) => request.source !== 'USER') &&
        output.completionDisposition !== 'NEEDS_USER_ACTION'
    };
  }
  const request = output.informationRequests.length === 1
    ? output.informationRequests[0]!
    : null;
  const structureCorrect = Boolean(
    request &&
    request.kind === expected.kind &&
    request.source === expected.source &&
    request.blocking === expected.blocking
  );
  const actualTargets = new Set(request?.propositionIds ?? []);
  const requiredTargetsPresent = expected.requiredPropositionIds.every(
    (propositionId) => actualTargets.has(propositionId)
  );
  const noDisallowedTargets = expected.allowedPropositionIds === null ||
    [...actualTargets].every((propositionId) =>
      expected.allowedPropositionIds!.includes(propositionId)
    );
  const targetingCorrect = Boolean(request) &&
    requiredTargetsPresent &&
    noDisallowedTargets;
  // Escalation deliberately does not reuse targetingCorrect. A correct USER
  // escalation remains observable even when its proposition set is wrong.
  const userEscalationCorrect = expected.requiresUserAction
    ? structureCorrect && output.completionDisposition === 'NEEDS_USER_ACTION'
    : output.informationRequests.every((request) => request.source !== 'USER') &&
      output.completionDisposition !== 'NEEDS_USER_ACTION';
  return { structureCorrect, targetingCorrect, userEscalationCorrect };
}

function scoreCritique(
  input: {
    conditionId: H1cConditionId;
    oracle: H1cOracleRecord;
    draftOutput?: LabPublicOutputV4 | null;
  },
  output: LabPublicOutputV4,
  actualByProposition: Map<string, LabPublicPropositionAssessmentV3>
): Pick<
  H1cOutputScore,
  | 'directCritiqueResponse'
  | 'critiqueDispositionAppropriate'
  | 'critiqueChangedTargetWhenRequired'
  | 'falseCritiqueAdopted'
> {
  if (input.conditionId !== 'VALID_CRITIQUE' && input.conditionId !== 'PLACEBO_CRITIQUE') {
    return {
      directCritiqueResponse: null,
      critiqueDispositionAppropriate: null,
      critiqueChangedTargetWhenRequired: null,
      falseCritiqueAdopted: null
    };
  }
  const truth = input.conditionId === 'VALID_CRITIQUE'
    ? 'VALID_IF_TARGET_DRAFT_WRONG'
    : 'FALSE_OR_IRRELEVANT';
  const issue = input.oracle.issueOracles.find((item) => item.truth === truth);
  const response = issue
    ? output.responses.find((item) =>
        item.targetArtifactId === issue.artifactId && item.targetIssueId === issue.issueId
      )
    : undefined;
  const directCritiqueResponse = Boolean(response);
  const falseCritiqueAdopted = truth === 'FALSE_OR_IRRELEVANT'
    ? Boolean(response && (response.disposition === 'ACCEPT' || response.disposition === 'PARTIAL'))
    : false;
  if (!issue || !response) {
    return {
      directCritiqueResponse,
      critiqueDispositionAppropriate: false,
      critiqueChangedTargetWhenRequired: false,
      falseCritiqueAdopted
    };
  }
  if (truth === 'FALSE_OR_IRRELEVANT') {
    return {
      directCritiqueResponse,
      critiqueDispositionAppropriate: response.disposition === 'REJECT',
      critiqueChangedTargetWhenRequired: null,
      falseCritiqueAdopted
    };
  }
  const expected = input.oracle.baseProfile.claims.find(
    (item) => item.propositionId === issue.targetPropositionId
  );
  const draft = input.draftOutput?.propositionAssessments.find(
    (item) => item.propositionId === issue.targetPropositionId
  );
  const draftWrong = Boolean(expected && draft && draft.assessment !== expected.assessment);
  const current = actualByProposition.get(issue.targetPropositionId);
  const changedIdPresent = Boolean(
    current && response.changedAssessmentIds.includes(current.id)
  );
  return {
    directCritiqueResponse,
    critiqueDispositionAppropriate: draftWrong
      ? response.disposition === 'ACCEPT' || response.disposition === 'PARTIAL'
      : response.disposition === 'REJECT',
    critiqueChangedTargetWhenRequired: draftWrong ? changedIdPresent : null,
    falseCritiqueAdopted
  };
}

function profileFor(
  conditionId: H1cConditionId,
  oracle: H1cOracleRecord
): H1cOracleProfile {
  return conditionId === 'DECISIVE_EVIDENCE'
    ? oracle.treatmentProfile
    : oracle.baseProfile;
}

function contextuallyCorrect(item: H1cScoredObservation): boolean {
  const score = item.score;
  return score.validSemanticObservation &&
    score.structuredAnswerCorrect === true &&
    score.epistemicStateCorrect === true &&
    score.completionDispositionCorrect === true &&
    score.targetCorrect === true &&
    score.guardsCorrect === true &&
    score.evidentialSupport.rate === 1 &&
    score.disallowedFactualEvidenceReferenceCount === 0 &&
    score.resolutionConsistent === true &&
    score.informationRequestStructureCorrect === true &&
    score.informationRequestTargetingCorrect === true &&
    score.userEscalationCorrect === true &&
    score.unsupportedDefiniteClosure === false &&
    (item.conditionId !== 'ACTIVE_SELF_REVIEW' ||
      score.selfCorrectionRepresentationCorrect === true) &&
    (item.conditionId !== 'DECISIVE_EVIDENCE' ||
      score.requiredTreatmentEvidencePresent === true);
}

function groupedByBlock(
  observations: readonly H1cScoredObservation[]
): Map<string, H1cScoredObservation[]> {
  const grouped = new Map<string, H1cScoredObservation[]>();
  for (const item of observations) {
    const block = grouped.get(item.blockId) ?? [];
    block.push(item);
    grouped.set(item.blockId, block);
  }
  return grouped;
}

function condition(
  block: readonly H1cScoredObservation[],
  conditionId: H1cConditionId
): H1cScoredObservation | undefined {
  return block.find((item) => item.conditionId === conditionId);
}

function unavailableScore(): H1cOutputScore {
  return {
    validSemanticObservation: false,
    structuredAnswerCorrect: null,
    epistemicStateCorrect: null,
    completionDispositionCorrect: null,
    propositionCorrectness: ratio(0, 0),
    propositionCorrectnessById: {},
    targetCorrect: null,
    targetCorrectnessById: {},
    guardsCorrect: null,
    guardCorrectnessById: {},
    evidentialSupport: ratio(0, 0),
    evidenceAllowanceStatus: 'UNADJUDICATED',
    disallowedFactualEvidenceReferenceCount: 0,
    unadjudicatedFactualEvidenceReferenceCount: 0,
    requiredTreatmentEvidencePresent: null,
    resolutionConsistent: null,
    unsupportedDefiniteClosure: null,
    informationNeedExpected: null,
    informationRequestStructureCorrect: null,
    informationRequestTargetingCorrect: null,
    informationNeedTextStatus: 'NOT_APPLICABLE',
    userEscalationCorrect: null,
    abstained: null,
    appropriateAbstention: null,
    answerAssessmentConfidence: null,
    highConfidenceWrongStructuredAnswer: null,
    answerConfidenceWithContextFailure: null,
    answerTextQualityStatus: 'UNADJUDICATED_SUMMARY_ONLY',
    meanPropositionAssessmentConfidence: null,
    highConfidenceWrongPropositionCount: 0,
    selfCorrectionRepresentationCorrect: null,
    directCritiqueResponse: null,
    critiqueDispositionAppropriate: null,
    critiqueChangedTargetWhenRequired: null,
    falseCritiqueAdopted: null,
    emittedMaterialIssueCount: 0,
    knownIssueSignatureCount: 0,
    unadjudicatedMaterialIssueCount: 0,
    inventedCriticismStatus: 'UNAVAILABLE_INVALID_OBSERVATION',
    minorityPreservationStatus: 'NOT_ESTIMABLE_NO_SOCIAL_MINORITY_EXPOSURE'
  };
}

function selectCorrectness(
  correctnessById: Readonly<Record<string, boolean>>,
  propositionIds: readonly string[]
): Record<string, boolean> {
  return Object.fromEntries(propositionIds.map((id) => [id, correctnessById[id] === true]));
}

function rightToWrongTransitions(
  before: Readonly<Record<string, boolean>>,
  after: Readonly<Record<string, boolean>>
): number {
  return Object.entries(before).filter(([id, correct]) =>
    correct && after[id] === false
  ).length;
}

export function scoreResolutionConsistency(
  output: LabPublicOutputV4,
  visibleIssueIds: readonly string[] = []
): boolean {
  if (!issueAccountingConsistent(output, visibleIssueIds)) return false;
  const hasBlockingUserRequest = output.informationRequests.some(
    (request) => request.blocking && request.source === 'USER'
  );
  const hasUnresolvedDisagreement = output.disagreements.some(
    (disagreement) => disagreement.status === 'UNRESOLVED' ||
      disagreement.status === 'NEEDS_USER_ACTION'
  );
  if (output.resolution.status === 'NO_DISAGREEMENT' && output.disagreements.length > 0) {
    return false;
  }
  if (output.resolution.status === 'RESOLVED' && hasUnresolvedDisagreement) return false;
  if (output.completionDisposition === 'NEEDS_USER_ACTION') {
    return hasBlockingUserRequest &&
      output.answer.epistemicState !== 'RESOLVED' &&
      output.resolution.status === 'NEEDS_USER_ACTION' &&
      output.resolution.basis === 'INSUFFICIENT_INFORMATION';
  }
  if (output.answer.epistemicState === 'UNDERDETERMINED') {
    return (output.resolution.status === 'UNRESOLVED' ||
        output.resolution.status === 'PARTIALLY_RESOLVED') &&
      output.resolution.basis === 'INSUFFICIENT_INFORMATION';
  }
  const hasPartialOrAbstainedResponse = output.responses.some(
    (response) => response.disposition === 'PARTIAL' || response.disposition === 'ABSTAIN'
  );
  const hasAcceptedResponse = output.responses.some(
    (response) => response.disposition === 'ACCEPT'
  );
  const hasRejectedResponse = output.responses.some(
    (response) => response.disposition === 'REJECT'
  );
  const rejectedResponsesHaveEvidence = output.responses
    .filter((response) => response.disposition === 'REJECT')
    .every((response) => response.factualEvidence.length > 0);
  if (
    hasRejectedResponse &&
    output.resolution.basis === 'FACTUAL_EVIDENCE' &&
    !rejectedResponsesHaveEvidence
  ) return false;
  if (
    output.resolution.unresolvedIssueIds.length > 0 ||
    hasPartialOrAbstainedResponse ||
    hasUnresolvedDisagreement
  ) {
    return output.resolution.status === 'PARTIALLY_RESOLVED' ||
      output.resolution.status === 'UNRESOLVED';
  }
  if (hasAcceptedResponse) {
    return output.resolution.status === 'RESOLVED' &&
      output.resolution.basis !== 'NO_MATERIAL_ISSUE';
  }
  if (hasRejectedResponse) {
    return (output.resolution.status === 'RESOLVED' ||
        output.resolution.status === 'NO_DISAGREEMENT') &&
      (output.resolution.basis === 'NO_MATERIAL_ISSUE' ||
        (output.resolution.basis === 'FACTUAL_EVIDENCE' &&
          rejectedResponsesHaveEvidence));
  }
  return (output.resolution.status === 'NO_DISAGREEMENT' ||
      output.resolution.status === 'RESOLVED') &&
    (output.resolution.basis === 'FACTUAL_EVIDENCE' ||
      output.resolution.basis === 'ASSUMPTION' ||
      output.resolution.basis === 'NO_MATERIAL_ISSUE') &&
    output.resolution.unresolvedIssueIds.length === 0;
}

function issueAccountingConsistent(
  output: LabPublicOutputV4,
  visibleIssueIds: readonly string[]
): boolean {
  const resolved = new Set(output.resolution.resolvedIssueIds);
  const unresolved = new Set(output.resolution.unresolvedIssueIds);
  const issueIds = new Set([
    ...visibleIssueIds,
    ...output.issues.map((issue) => issue.id),
    ...output.responses.map((response) => response.targetIssueId)
  ]);
  if (resolved.size + unresolved.size !== issueIds.size) return false;
  if ([...issueIds].some((id) => resolved.has(id) === unresolved.has(id))) return false;
  if (output.responses.some((response) => {
    if (response.disposition === 'ABSTAIN') return !unresolved.has(response.targetIssueId);
    if (response.disposition === 'PARTIAL') return !unresolved.has(response.targetIssueId);
    return !resolved.has(response.targetIssueId);
  })) return false;
  if (output.selfCorrections.some((correction) =>
    !resolved.has(correction.targetIssueId)
  )) return false;
  if (
    unresolved.size > 0 &&
    (output.resolution.status === 'RESOLVED' ||
      output.resolution.status === 'NO_DISAGREEMENT')
  ) return false;
  if (
    output.resolution.basis === 'NO_MATERIAL_ISSUE' &&
    output.responses.some((response) =>
      response.disposition === 'ACCEPT' || response.disposition === 'PARTIAL'
    )
  ) return false;
  return true;
}

export function scoreSelfCorrectionRepresentation(
  conditionId: H1cConditionId,
  output: LabPublicOutputV4,
  draftOutput: LabPublicOutputV4 | null | undefined
): boolean | null {
  if (conditionId !== 'ACTIVE_SELF_REVIEW') return null;
  if (!draftOutput) return false;
  const actual = substantiveSelfReviewChangesV4(draftOutput, output);
  const claimedFields = new Set<LabSelfCorrectionFieldV4>();
  const claimedPropositionIds = new Set<string>();
  const issues = new Map(output.issues.map((issue) => [issue.id, issue]));
  const resolved = new Set(output.resolution.resolvedIssueIds);
  for (const correction of output.selfCorrections) {
    const issue = issues.get(correction.targetIssueId);
    if (
      !issue ||
      correction.targetArtifactId !== 'DRAFT' ||
      issue.targetArtifactId !== 'DRAFT' ||
      !resolved.has(correction.targetIssueId) ||
      (correction.changedPublicFields.length === 0 &&
        correction.changedPropositionIds.length === 0) ||
      (correction.changedPropositionIds.length > 0) !==
        correction.changedPublicFields.includes('PROPOSITION_ASSESSMENTS')
    ) return false;
    for (const field of correction.changedPublicFields) {
      if (claimedFields.has(field)) return false;
      claimedFields.add(field);
    }
    for (const propositionId of correction.changedPropositionIds) {
      if (claimedPropositionIds.has(propositionId)) return false;
      claimedPropositionIds.add(propositionId);
    }
  }
  return sameStringSet([...claimedFields], [...actual.fields]) &&
    sameStringSet([...claimedPropositionIds], [...actual.propositionIds]);
}

function ratio(count: number, opportunities: number): H1cRatio {
  return { count, opportunities, rate: opportunities === 0 ? null : count / opportunities };
}

type MutableCohortCounts = Omit<H1cCohortMetric, 'rate'>;

function emptyCohortCounts(planned: number): MutableCohortCounts {
  return {
    planned,
    observed: 0,
    valid: 0,
    eligible: 0,
    passed: 0,
    failed: 0,
    invalid: 0,
    unavailable: 0,
    unstarted: 0
  };
}

function finishCohortMetric(counts: MutableCohortCounts): H1cCohortMetric {
  return {
    ...counts,
    rate: counts.eligible === 0 ? null : counts.passed / counts.eligible
  };
}

function scoreCohort(
  expectedBlockIds: readonly string[],
  observations: readonly H1cScoredObservation[],
  passes: (observation: H1cScoredObservation) => boolean
): H1cCohortMetric {
  const counts = emptyCohortCounts(expectedBlockIds.length);
  for (const blockId of expectedBlockIds) {
    const candidates = observations.filter((observation) => observation.blockId === blockId);
    if (candidates.length === 0) {
      counts.unstarted += 1;
      continue;
    }
    counts.observed += 1;
    if (candidates.length !== 1) {
      counts.invalid += 1;
      continue;
    }
    const observation = candidates[0]!;
    const status = observationStatus(observation);
    if (status === 'INVALID') {
      counts.invalid += 1;
      continue;
    }
    if (status === 'UNAVAILABLE') {
      counts.unavailable += 1;
      continue;
    }
    counts.valid += 1;
    counts.eligible += 1;
    if (passes(observation)) counts.passed += 1;
    else counts.failed += 1;
  }
  return finishCohortMetric(counts);
}

function observationStatus(
  observation: H1cScoredObservation
): 'VALID' | 'INVALID' | 'UNAVAILABLE' {
  if (observation.measurementStatus) return observation.measurementStatus;
  if (observation.score.validSemanticObservation) return 'VALID';
  return observation.output === null ? 'UNAVAILABLE' : 'INVALID';
}

function completeCohort(metric: H1cCohortMetric): boolean {
  return metric.observed === metric.planned &&
    metric.valid === metric.planned &&
    metric.invalid === 0 &&
    metric.unavailable === 0 &&
    metric.unstarted === 0;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function hasExactEvidenceDirection(
  references: readonly { sourceId: string; relation: string }[],
  sourceId: string,
  relation: string
): boolean {
  return references.some(
    (reference) => reference.sourceId === sourceId && reference.relation === relation
  );
}

function evidencePair(sourceId: string, relation: string): string {
  return `${sourceId}\u0000${relation}`;
}

function evidencePairSet(
  references: readonly { evidenceId: string; relation: string }[]
): Set<string> {
  return new Set(references.map((reference) =>
    evidencePair(reference.evidenceId, reference.relation)
  ));
}
