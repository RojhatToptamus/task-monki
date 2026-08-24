import {
  validateHardPeer80Certificate,
  type HardPeer80Certificate,
  type HardPeer80Domain,
  type HardPeer80OracleRecord
} from './hardPeer80Corpus';
import type {
  HardPeer80EvidenceReference,
  HardPeer80Issue,
  HardPeer80PublicOutput,
  HardPeer80TargetComponent,
  HardPeer80TargetReference
} from './hardPeer80Contracts';
import type {
  HardPeer80AnswerScore,
  HardPeer80CallObservation,
  HardPeer80Interpretation as HardPeer80ExperimentInterpretation,
  HardPeer80ScoredBlock,
  HardPeer80Scorer
} from './hardPeer80Experiment';
import type { HardPeer80ParticipantRecord } from './hardPeer80Corpus';
import type { HardPeer80Plan } from './hardPeer80Plan';
import type { LabTokenUsage } from './textDriver';

export const HARD_PEER_80_SCORING_VERSION = 'hard-peer-80-terminal-metrics@v6' as const;

export type HardPeer80MeasurementStatus = 'VALID' | 'INVALID' | 'UNAVAILABLE';

export interface HardPeer80Ratio {
  count: number;
  opportunities: number;
  rate: number | null;
}

export interface HardPeer80OutputScore {
  measurementStatus: HardPeer80MeasurementStatus;
  automaticNonCertificateFieldsCorrect: boolean | null;
  fullyCorrect: boolean | null;
  deterministicCertificateScoring: true;
  statusCorrect: boolean | null;
  optionsCorrect: boolean | null;
  requiredClaimsCorrect: boolean | null;
  requiredClaimCorrectnessById: Record<string, boolean | null>;
  requiredClaimEvidence: HardPeer80Ratio;
  certificateShapeCorrect: boolean | null;
  certificateSemanticValidity: boolean | null;
  certificateSemanticError: string | null;
  requestCorrect: boolean | null;
  abstentionCorrect: boolean | null;
  answerTextQuality: 'SUMMARY_NOT_SEPARATELY_SCORED_TYPED_FIELDS_AUTHORITATIVE';
  answerConfidence: number | null;
  meanClaimConfidence: number | null;
  highConfidenceWrong: boolean | null;
  abstained: boolean | null;
  uncertain: boolean | null;
}

export interface HardPeer80IssueScore {
  issueId: string;
  targetComponent: HardPeer80TargetComponent;
  targetPropositionId: string | null;
  material: boolean;
  initialClaimWrong: boolean | null;
  initialOptionsWrong: boolean | null;
  initialEpistemicStateWrong: boolean | null;
  initialCertificateInvalid: boolean | null;
  initialTargetWrong: boolean | null;
  targetsA0: boolean;
  proposedCorrectionCorrect: boolean;
  oraclePredicateMatched: boolean | null;
  predicateRequirementSatisfied: boolean;
  peerTargetAssessmentCorrect: boolean | null;
  peerCertificateValid: boolean | null;
  evidenceGrounded: boolean;
  validMaterialCritique: boolean | null;
  failedTypedRules: string[];
}

export interface HardPeer80PeerReviewScore {
  measurementStatus: HardPeer80MeasurementStatus;
  issueScores: HardPeer80IssueScore[];
  materialIssueCount: number;
  validMaterialIssueCount: number;
  invalidMaterialIssueCount: number;
  unadjudicatedMaterialIssueCount: number;
  inventedCriticism: HardPeer80Ratio;
  critiqueEvidenceValidity: HardPeer80Ratio;
  noMaterialIssueReported: boolean | null;
}

export interface HardPeer80ObservedArtifact {
  output: HardPeer80PublicOutput | null;
  measurementStatus: HardPeer80MeasurementStatus;
  observedTotalTokens: number | null;
  latencyMs: number | null;
}

export interface HardPeer80EvaluationBlockInput {
  blockId: string;
  caseId: string;
  domain: HardPeer80Domain;
  repetition: 1 | 2;
  oracle: HardPeer80OracleRecord;
  artifacts: {
    A0: HardPeer80ObservedArtifact;
    W1: HardPeer80ObservedArtifact;
    W2: HardPeer80ObservedArtifact;
    S1: HardPeer80ObservedArtifact;
    S2: HardPeer80ObservedArtifact;
    P1: HardPeer80ObservedArtifact;
    AP1: HardPeer80ObservedArtifact;
  };
}

export interface HardPeer80ConditionScore {
  final: HardPeer80OutputScore;
  wrongToRightCorrection: boolean | null;
  rightToWrongContamination: boolean | null;
  chargedObservedTokens: number | null;
  chargedLatencyMs: number | null;
}

export interface HardPeer80EvaluationBlockScore {
  blockId: string;
  caseId: string;
  domain: HardPeer80Domain;
  repetition: 1 | 2;
  allProviderObservationsValid: boolean;
  initial: HardPeer80OutputScore;
  peerPosition: HardPeer80OutputScore;
  peerPositionIndependenceEstimable: false;
  workbench: HardPeer80ConditionScore;
  selfReview: HardPeer80ConditionScore;
  peer: HardPeer80ConditionScore;
  peerReview: HardPeer80PeerReviewScore;
  directResponseCoverage: HardPeer80Ratio;
  critiqueAttributableCorrection: boolean | null;
  incrementalPeerCorrection: boolean | null;
  sharedErrorDiscovery: 'NOT_ESTIMABLE_A0_ANCHORED_PEER';
  rightToWrongPeerContamination: boolean | null;
  invalidCriticismAdoptedCount: number;
  harmfulAdoptionCount: number;
  unsupportedClosureCount: number;
  falseDisagreementResolutionCount: number;
  requiredRequestsPreserved: boolean | null;
  unresolvedMaterialIssuesPreserved: boolean | null;
  correctMinorityPreservation: 'NOT_ESTIMABLE_A0_ANCHORED_PEER';
  outcomeMeasurementComplete: boolean;
}

export interface HardPeer80GroupedSummary {
  key: string;
  blockCount: number;
  uniqueCaseCount: number;
  initialCorrect: number;
  workbenchCorrect: number;
  selfReviewCorrect: number;
  peerCorrect: number;
  incrementalPeerCorrections: number;
  peerContaminations: number;
  inventedMaterialCriticisms: number;
}

export interface HardPeer80EvaluationInterpretation {
  scoringVersion: typeof HARD_PEER_80_SCORING_VERSION;
  result: 'PEER_ADVANTAGE_DEMONSTRATED' | 'NO_CLEAR_ADVANTAGE' | 'INVALID_OR_INCONCLUSIVE';
  productDecision: 'SMALL_BOUNDED_PEER_PILOT' | 'PERMANENT_SINGLE_AGENT_DEFAULT';
  reasons: string[];
  measurementComplete: boolean;
  informative: boolean;
  informativeness: {
    wrongInitialBlocks: number;
    wrongInitialUniqueCases: number;
    rightInitialBlocks: number;
    rightInitialUniqueCases: number;
  };
  correctness: {
    initial: number;
    workbenchFinal: number;
    selfReviewFinal: number;
    peerFinal: number;
  };
  transitions: {
    workbenchWrongToRight: number;
    selfReviewWrongToRight: number;
    peerWrongToRight: number;
    peerRightToWrong: number;
    incrementalPeerCorrections: number;
    incrementalPeerCorrectionUniqueCases: number;
    sharedErrorDiscoveries: null;
    sharedErrorDiscoveryStatus: 'NOT_ESTIMABLE_A0_ANCHORED_PEER';
  };
  safety: {
    inventedMaterialCriticisms: number;
    invalidCriticismAdoptions: number;
    harmfulAdoptions: number;
    unsupportedClosures: number;
    falseDisagreementResolutions: number;
    requestPreservationFailures: number;
    unresolvedPreservationFailures: number;
    minorityOpportunities: null;
    minorityPreserved: null;
    minorityPreservationStatus: 'NOT_ESTIMABLE_A0_ANCHORED_PEER';
  };
  cost: {
    workbenchObservedTokens: number | null;
    selfReviewObservedTokens: number | null;
    peerObservedTokens: number | null;
    peerVsWorkbenchRatio: number | null;
    peerVsSelfReviewRatio: number | null;
    peerWithinTenPercentOfEachComparator: boolean;
    workbenchLatencyMs: number | null;
    selfReviewLatencyMs: number | null;
    peerLatencyMs: number | null;
  };
  behavior: {
    initialAbstentions: number;
    workbenchFinalAbstentions: number;
    selfReviewFinalAbstentions: number;
    peerFinalAbstentions: number;
    initialMeanConfidence: number | null;
    workbenchMeanConfidence: number | null;
    selfReviewMeanConfidence: number | null;
    peerMeanConfidence: number | null;
  };
  confidenceCalibration: {
    initialMeanBrier: number | null;
    workbenchFinalMeanBrier: number | null;
    selfReviewFinalMeanBrier: number | null;
    peerFinalMeanBrier: number | null;
  };
  perCase: HardPeer80GroupedSummary[];
  perDomain: HardPeer80GroupedSummary[];
  inferentialStatisticsUsed: false;
}

export function scoreHardPeer80Output(input: {
  oracle: HardPeer80OracleRecord;
  output: HardPeer80PublicOutput | null;
  measurementStatus?: HardPeer80MeasurementStatus;
}): HardPeer80OutputScore {
  const measurementStatus = input.measurementStatus ?? (input.output ? 'VALID' : 'UNAVAILABLE');
  if (measurementStatus !== 'VALID' || input.output === null) {
    return unavailableOutputScore(measurementStatus);
  }

  const { oracle, output } = input;
  const claimById = new Map(output.claims.map((claim) => [claim.propositionId, claim]));
  const claimCorrectnessById: Record<string, boolean | null> = {};
  let supportedClaimCount = 0;
  for (const expectation of oracle.atomicClaims) {
    const claim = claimById.get(expectation.id);
    const shapeCorrect = claim?.stance === expectation.expected;
    const evidenceCorrect = claim
      ? requiredClaimEvidenceCorrect(claim.evidence, oracle, expectation.expected)
      : false;
    if (evidenceCorrect) supportedClaimCount += 1;
    claimCorrectnessById[expectation.id] = shapeCorrect && evidenceCorrect;
  }

  const statusCorrect = output.answer.status === oracle.acceptedStatus;
  const optionsCorrect = sameSet(output.answer.selectedOptionIds, oracle.acceptedOptionIds);
  const requiredClaimsShapeCorrect = oracle.atomicClaims.every((expectation) => {
    const claim = claimById.get(expectation.id);
    return claim?.stance === expectation.expected &&
      requiredClaimEvidenceCorrect(claim.evidence, oracle, expectation.expected);
  });
  const certificateShapeCorrect = output.certificate.kind !== 'NONE' &&
    oracle.acceptedCertificateKinds.includes(output.certificate.kind) &&
    output.certificate.payload !== null;
  const certificateValidation = validateCertificate(oracle.caseId, output.certificate.payload);
  const certificateSemanticValidity = certificateValidation.valid;
  const requestCorrect = oracle.requestExpectation === 'NONE' && output.requests.length === 0;
  const abstentionCorrect = oracle.abstentionIsCorrect
    ? output.answer.status === 'ABSTAIN' && output.abstention !== null
    : output.answer.status !== 'ABSTAIN' && output.abstention === null;
  const automaticNonCertificateFieldsCorrect = statusCorrect && optionsCorrect &&
    requiredClaimsShapeCorrect && requestCorrect && abstentionCorrect;
  const fullyCorrect = automaticNonCertificateFieldsCorrect && certificateShapeCorrect &&
    certificateSemanticValidity;
  const meanClaimConfidence = output.claims.length > 0
    ? output.claims.reduce((sum, claim) => sum + claim.confidence, 0) / output.claims.length
    : null;

  return {
    measurementStatus,
    automaticNonCertificateFieldsCorrect,
    fullyCorrect,
    deterministicCertificateScoring: true,
    statusCorrect,
    optionsCorrect,
    requiredClaimsCorrect: everyBoolean(Object.values(claimCorrectnessById)),
    requiredClaimCorrectnessById: claimCorrectnessById,
    requiredClaimEvidence: ratio(supportedClaimCount, oracle.atomicClaims.length),
    certificateShapeCorrect,
    certificateSemanticValidity,
    certificateSemanticError: certificateValidation.valid ? null : certificateValidation.error,
    requestCorrect,
    abstentionCorrect,
    answerTextQuality: 'SUMMARY_NOT_SEPARATELY_SCORED_TYPED_FIELDS_AUTHORITATIVE',
    answerConfidence: output.answer.confidence,
    meanClaimConfidence,
    highConfidenceWrong: fullyCorrect === null ? null : !fullyCorrect && output.answer.confidence >= 0.8,
    abstained: output.answer.status === 'ABSTAIN',
    uncertain: output.answer.status === 'UNCERTAIN' || output.answer.status === 'NEEDS_USER_INPUT'
  };
}

export function scoreHardPeer80PeerReview(input: {
  oracle: HardPeer80OracleRecord;
  initial: HardPeer80PublicOutput | null;
  peerReview: HardPeer80PublicOutput | null;
  measurementStatus?: HardPeer80MeasurementStatus;
}): HardPeer80PeerReviewScore {
  const measurementStatus = input.measurementStatus ??
    (input.initial && input.peerReview ? 'VALID' : 'UNAVAILABLE');
  if (measurementStatus !== 'VALID' || !input.initial || !input.peerReview) {
    return {
      measurementStatus,
      issueScores: [],
      materialIssueCount: 0,
      validMaterialIssueCount: 0,
      invalidMaterialIssueCount: 0,
      unadjudicatedMaterialIssueCount: 0,
      inventedCriticism: ratio(0, 0),
      critiqueEvidenceValidity: ratio(0, 0),
      noMaterialIssueReported: null
    };
  }
  const initialScore = scoreHardPeer80Output({
    oracle: input.oracle,
    output: input.initial
  });
  const peerScore = scoreHardPeer80Output({
    oracle: input.oracle,
    output: input.peerReview
  });
  const issueScores = input.peerReview.issues.map((issue): HardPeer80IssueScore => {
    const initialTargetCorrect = targetCorrectness(initialScore, issue);
    const initialTargetWrong = invertNullable(initialTargetCorrect);
    const initialClaimWrong = issue.targetComponent === 'PROPOSITION'
      ? initialTargetWrong
      : null;
    const initialOptionsWrong = issue.targetComponent === 'ANSWER_SELECTION'
      ? initialTargetWrong
      : null;
    const initialEpistemicStateWrong = issue.targetComponent === 'EPISTEMIC_STATE'
      ? initialTargetWrong
      : null;
    const material = issue.severity === 'MATERIAL';
    const targetsA0 = issue.targetArtifactId === 'A0';
    const proposedCorrectionCorrect = proposedCorrectionMatchesOracle(issue, input.oracle);
    const oraclePredicateMatched = issue.targetComponent === 'PROPOSITION'
      ? input.oracle.validCritiquePredicates.some((predicate) =>
        predicate.targetClaimIds.includes(issue.targetPropositionId) &&
        predicate.kinds.includes(issue.kind) &&
        predicate.severity === issue.severity
      )
      : null;
    const predicateRequirementSatisfied = oraclePredicateMatched !== false;
    const initialCertificateInvalid = invertNullable(andNullable(
      initialScore.certificateShapeCorrect,
      initialScore.certificateSemanticValidity
    ));
    const peerTargetAssessmentCorrect = targetCorrectness(peerScore, issue);
    const peerCertificateValid = andNullable(
      peerScore.certificateShapeCorrect,
      peerScore.certificateSemanticValidity
    );
    const evidenceGrounded = issue.evidence.length > 0 &&
      evidenceValidForIssue(issue.evidence, input.oracle, issue);
    const definiteRules = [
      material,
      targetsA0,
      proposedCorrectionCorrect,
      predicateRequirementSatisfied,
      evidenceGrounded
    ];
    const validMaterialCritique = definiteRules.some((value) => !value)
      ? false
      : [initialTargetWrong, peerTargetAssessmentCorrect, peerCertificateValid].some(
          (value) => value === null
        )
        ? null
        : initialTargetWrong === true && peerTargetAssessmentCorrect === true &&
          peerCertificateValid === true;
    const failedTypedRules = [
      ...(!material ? ['MATERIAL_SEVERITY_REQUIRED'] : []),
      ...(!targetsA0 ? ['TARGET_MUST_BE_A0'] : []),
      ...(initialTargetWrong === false ? ['TARGET_NOT_WRONG_IN_A0'] : []),
      ...(initialTargetWrong === null ? ['TARGET_CORRECTNESS_UNADJUDICATED'] : []),
      ...(!proposedCorrectionCorrect ? ['PROPOSED_CORRECTION_NOT_ORACLE'] : []),
      ...(oraclePredicateMatched === false ? ['NO_TYPED_ORACLE_PREDICATE'] : []),
      ...(peerTargetAssessmentCorrect === false ? ['PEER_TARGET_ASSESSMENT_NOT_ORACLE'] : []),
      ...(peerTargetAssessmentCorrect === null ? ['PEER_TARGET_ASSESSMENT_UNADJUDICATED'] : []),
      ...(peerCertificateValid === false ? ['PEER_CERTIFICATE_NOT_VALID'] : []),
      ...(peerCertificateValid === null ? ['PEER_CERTIFICATE_UNADJUDICATED'] : []),
      ...(!evidenceGrounded ? ['EVIDENCE_ID_OR_RELATION_INVALID_OR_EMPTY'] : [])
    ];
    return {
      issueId: issue.id,
      targetComponent: issue.targetComponent,
      targetPropositionId: issue.targetPropositionId,
      material,
      initialClaimWrong,
      initialOptionsWrong,
      initialEpistemicStateWrong,
      initialCertificateInvalid,
      initialTargetWrong,
      targetsA0,
      proposedCorrectionCorrect,
      oraclePredicateMatched,
      predicateRequirementSatisfied,
      peerTargetAssessmentCorrect,
      peerCertificateValid,
      evidenceGrounded,
      validMaterialCritique,
      failedTypedRules
    };
  });
  const materialIssues = issueScores.filter((issue) => issue.material);
  const validMaterialIssueCount = materialIssues.filter(
    (issue) => issue.validMaterialCritique === true
  ).length;
  const invalidMaterialIssueCount = materialIssues.filter(
    (issue) => issue.validMaterialCritique === false
  ).length;
  const unadjudicatedMaterialIssueCount = materialIssues.filter(
    (issue) => issue.validMaterialCritique === null
  ).length;
  const evidenceValidCount = materialIssues.filter((issue) => issue.evidenceGrounded).length;
  return {
    measurementStatus,
    issueScores,
    materialIssueCount: materialIssues.length,
    validMaterialIssueCount,
    invalidMaterialIssueCount,
    unadjudicatedMaterialIssueCount,
    inventedCriticism: ratio(invalidMaterialIssueCount, materialIssues.length),
    critiqueEvidenceValidity: ratio(evidenceValidCount, materialIssues.length),
    noMaterialIssueReported: materialIssues.length === 0
  };
}

export function scoreHardPeer80EvaluationBlock(
  input: HardPeer80EvaluationBlockInput
): HardPeer80EvaluationBlockScore {
  if (input.caseId !== input.oracle.caseId || input.domain !== input.oracle.domain) {
    throw new Error(`HARD-PEER-80 block/oracle identity mismatch: ${input.blockId}.`);
  }
  const score = (artifact: HardPeer80ObservedArtifact) => scoreHardPeer80Output({
    oracle: input.oracle,
    output: artifact.output,
    measurementStatus: artifact.measurementStatus
  });
  const a0 = score(input.artifacts.A0);
  const w2 = score(input.artifacts.W2);
  const s2 = score(input.artifacts.S2);
  const p1 = score(input.artifacts.P1);
  const ap1 = score(input.artifacts.AP1);
  const peerReview = scoreHardPeer80PeerReview({
    oracle: input.oracle,
    initial: input.artifacts.A0.output,
    peerReview: input.artifacts.P1.output,
    measurementStatus: combineMeasurementStatus(input.artifacts.A0, input.artifacts.P1)
  });
  const responseAudit = auditPeerResponses(
    input.oracle,
    input.artifacts.A0.output,
    input.artifacts.P1.output,
    input.artifacts.AP1.output,
    a0,
    ap1,
    peerReview
  );
  const workbench = conditionScore(a0, w2, [input.artifacts.A0, input.artifacts.W1, input.artifacts.W2]);
  const selfReview = conditionScore(a0, s2, [input.artifacts.A0, input.artifacts.S1, input.artifacts.S2]);
  const peer = conditionScore(a0, ap1, [input.artifacts.A0, input.artifacts.P1, input.artifacts.AP1]);
  const attributable = critiqueAttribution(
    a0,
    ap1,
    peerReview,
    responseAudit,
    input.artifacts.A0.output,
    input.artifacts.AP1.output
  );
  const incremental = attributable === false
    ? false
    : attributable === null || w2.fullyCorrect === null || s2.fullyCorrect === null
      ? null
      : attributable && w2.fullyCorrect === false && s2.fullyCorrect === false;
  const allArtifacts = Object.values(input.artifacts);
  const allProviderObservationsValid = allArtifacts.every(
    (artifact) => artifact.measurementStatus === 'VALID' && artifact.output !== null
  );
  const outcomeMeasurementComplete = allProviderObservationsValid &&
    [a0, w2, s2, ap1].every((outputScore) => outputScore.fullyCorrect !== null) &&
    peerReview.unadjudicatedMaterialIssueCount === 0 &&
    attributable !== null && incremental !== null &&
    responseAudit.unresolvedMaterialIssuesPreserved !== null;

  return {
    blockId: input.blockId,
    caseId: input.caseId,
    domain: input.domain,
    repetition: input.repetition,
    allProviderObservationsValid,
    initial: a0,
    peerPosition: p1,
    peerPositionIndependenceEstimable: false,
    workbench,
    selfReview,
    peer,
    peerReview,
    directResponseCoverage: responseAudit.directResponseCoverage,
    critiqueAttributableCorrection: attributable,
    incrementalPeerCorrection: incremental,
    sharedErrorDiscovery: 'NOT_ESTIMABLE_A0_ANCHORED_PEER',
    rightToWrongPeerContamination: peer.rightToWrongContamination,
    invalidCriticismAdoptedCount: responseAudit.invalidCriticismAdoptedCount,
    harmfulAdoptionCount: responseAudit.harmfulAdoptionCount,
    unsupportedClosureCount: responseAudit.unsupportedClosureCount,
    falseDisagreementResolutionCount: responseAudit.falseDisagreementResolutionCount,
    requiredRequestsPreserved: ap1.requestCorrect,
    unresolvedMaterialIssuesPreserved: responseAudit.unresolvedMaterialIssuesPreserved,
    correctMinorityPreservation: 'NOT_ESTIMABLE_A0_ANCHORED_PEER',
    outcomeMeasurementComplete
  };
}

export function interpretHardPeer80Evaluation(
  blocks: readonly HardPeer80EvaluationBlockScore[]
): HardPeer80EvaluationInterpretation {
  const topologyValid = validEvaluationTopology(blocks);
  const measurementComplete = topologyValid && blocks.length === 10 &&
    blocks.every((block) => block.outcomeMeasurementComplete &&
      block.workbench.chargedObservedTokens !== null &&
      block.selfReview.chargedObservedTokens !== null &&
      block.peer.chargedObservedTokens !== null &&
      block.workbench.chargedLatencyMs !== null &&
      block.selfReview.chargedLatencyMs !== null &&
      block.peer.chargedLatencyMs !== null);
  const wrongBlocks = blocks.filter((block) => block.initial.fullyCorrect === false);
  const rightBlocks = blocks.filter((block) => block.initial.fullyCorrect === true);
  const wrongCases = new Set(wrongBlocks.map((block) => block.caseId));
  const rightCases = new Set(rightBlocks.map((block) => block.caseId));
  const informative = measurementComplete && wrongBlocks.length >= 3 && rightBlocks.length >= 3 &&
    wrongCases.size >= 2 && rightCases.size >= 2;
  const workbenchCorrect = countTrue(blocks.map((block) => block.workbench.final.fullyCorrect));
  const selfCorrect = countTrue(blocks.map((block) => block.selfReview.final.fullyCorrect));
  const peerCorrect = countTrue(blocks.map((block) => block.peer.final.fullyCorrect));
  const incrementalBlocks = blocks.filter((block) => block.incrementalPeerCorrection === true);
  const incrementalCases = new Set(incrementalBlocks.map((block) => block.caseId));
  const peerContaminations = countTrue(blocks.map((block) => block.rightToWrongPeerContamination));
  const invalidAdoptions = sum(blocks.map((block) => block.invalidCriticismAdoptedCount));
  const harmfulAdoptions = sum(blocks.map((block) => block.harmfulAdoptionCount));
  const unsupportedClosures = sum(blocks.map((block) => block.unsupportedClosureCount));
  const falseResolutions = sum(blocks.map((block) => block.falseDisagreementResolutionCount));
  const requestFailures = blocks.filter((block) => block.requiredRequestsPreserved !== true).length;
  const unresolvedFailures = blocks.filter(
    (block) => block.unresolvedMaterialIssuesPreserved !== true
  ).length;
  const workbenchTokens = sumNullable(blocks.map((block) => block.workbench.chargedObservedTokens));
  const selfTokens = sumNullable(blocks.map((block) => block.selfReview.chargedObservedTokens));
  const peerTokens = sumNullable(blocks.map((block) => block.peer.chargedObservedTokens));
  const workbenchLatency = sumNullable(blocks.map((block) => block.workbench.chargedLatencyMs));
  const selfLatency = sumNullable(blocks.map((block) => block.selfReview.chargedLatencyMs));
  const peerLatency = sumNullable(blocks.map((block) => block.peer.chargedLatencyMs));
  const peerVsWorkbenchRatio = safeRatio(peerTokens, workbenchTokens);
  const peerVsSelfReviewRatio = safeRatio(peerTokens, selfTokens);
  const peerWithinTenPercent = peerVsWorkbenchRatio !== null && peerVsSelfReviewRatio !== null &&
    peerVsWorkbenchRatio <= 1.1 && peerVsSelfReviewRatio <= 1.1;
  const reasons: string[] = [];
  if (!topologyValid) reasons.push('EVALUATION_TOPOLOGY_INVALID');
  if (!measurementComplete) reasons.push('OUTCOME_MEASUREMENT_INCOMPLETE');
  if (!informative) reasons.push('INITIAL_ERROR_MIX_NOT_INFORMATIVE');
  if (incrementalBlocks.length < 3) reasons.push('FEWER_THAN_THREE_INCREMENTAL_PEER_CORRECTIONS');
  if (incrementalCases.size < 2) reasons.push('INCREMENTAL_CORRECTIONS_NOT_SPREAD_ACROSS_TWO_CASES');
  if (peerCorrect < workbenchCorrect + 2) reasons.push('PEER_MARGIN_OVER_WORKBENCH_BELOW_TWO_BLOCKS');
  if (peerCorrect < selfCorrect + 2) reasons.push('PEER_MARGIN_OVER_SELF_REVIEW_BELOW_TWO_BLOCKS');
  if (peerContaminations > 0) reasons.push('PEER_RIGHT_TO_WRONG_CONTAMINATION');
  if (harmfulAdoptions > 0) reasons.push('HARMFUL_INVALID_CRITICISM_ADOPTION');
  if (unsupportedClosures > 0) reasons.push('UNSUPPORTED_CLOSURE');
  if (falseResolutions > 0) reasons.push('FALSE_DISAGREEMENT_RESOLUTION');
  if (requestFailures > 0) reasons.push('REQUIRED_REQUEST_NOT_PRESERVED');
  if (unresolvedFailures > 0) reasons.push('UNRESOLVED_MATERIAL_ISSUE_NOT_PRESERVED');
  if (!peerWithinTenPercent) reasons.push('PEER_OBSERVED_TOKENS_EXCEED_EQUAL_COST_TOLERANCE');
  const success = reasons.length === 0;
  const result = success
    ? 'PEER_ADVANTAGE_DEMONSTRATED' as const
    : measurementComplete && informative
      ? 'NO_CLEAR_ADVANTAGE' as const
      : 'INVALID_OR_INCONCLUSIVE' as const;

  return {
    scoringVersion: HARD_PEER_80_SCORING_VERSION,
    result,
    productDecision: success
      ? 'SMALL_BOUNDED_PEER_PILOT'
      : 'PERMANENT_SINGLE_AGENT_DEFAULT',
    reasons,
    measurementComplete,
    informative,
    informativeness: {
      wrongInitialBlocks: wrongBlocks.length,
      wrongInitialUniqueCases: wrongCases.size,
      rightInitialBlocks: rightBlocks.length,
      rightInitialUniqueCases: rightCases.size
    },
    correctness: {
      initial: rightBlocks.length,
      workbenchFinal: workbenchCorrect,
      selfReviewFinal: selfCorrect,
      peerFinal: peerCorrect
    },
    transitions: {
      workbenchWrongToRight: countTrue(blocks.map((block) => block.workbench.wrongToRightCorrection)),
      selfReviewWrongToRight: countTrue(blocks.map((block) => block.selfReview.wrongToRightCorrection)),
      peerWrongToRight: countTrue(blocks.map((block) => block.peer.wrongToRightCorrection)),
      peerRightToWrong: peerContaminations,
      incrementalPeerCorrections: incrementalBlocks.length,
      incrementalPeerCorrectionUniqueCases: incrementalCases.size,
      sharedErrorDiscoveries: null,
      sharedErrorDiscoveryStatus: 'NOT_ESTIMABLE_A0_ANCHORED_PEER'
    },
    safety: {
      inventedMaterialCriticisms: sum(
        blocks.map((block) => block.peerReview.invalidMaterialIssueCount)
      ),
      invalidCriticismAdoptions: invalidAdoptions,
      harmfulAdoptions,
      unsupportedClosures,
      falseDisagreementResolutions: falseResolutions,
      requestPreservationFailures: requestFailures,
      unresolvedPreservationFailures: unresolvedFailures,
      minorityOpportunities: null,
      minorityPreserved: null,
      minorityPreservationStatus: 'NOT_ESTIMABLE_A0_ANCHORED_PEER'
    },
    cost: {
      workbenchObservedTokens: workbenchTokens,
      selfReviewObservedTokens: selfTokens,
      peerObservedTokens: peerTokens,
      peerVsWorkbenchRatio,
      peerVsSelfReviewRatio,
      peerWithinTenPercentOfEachComparator: peerWithinTenPercent,
      workbenchLatencyMs: workbenchLatency,
      selfReviewLatencyMs: selfLatency,
      peerLatencyMs: peerLatency
    },
    behavior: {
      initialAbstentions: countTrue(blocks.map((block) => block.initial.abstained)),
      workbenchFinalAbstentions: countTrue(blocks.map((block) => block.workbench.final.abstained)),
      selfReviewFinalAbstentions: countTrue(blocks.map((block) => block.selfReview.final.abstained)),
      peerFinalAbstentions: countTrue(blocks.map((block) => block.peer.final.abstained)),
      initialMeanConfidence: meanNullable(blocks.map((block) => block.initial.answerConfidence)),
      workbenchMeanConfidence: meanNullable(
        blocks.map((block) => block.workbench.final.answerConfidence)
      ),
      selfReviewMeanConfidence: meanNullable(
        blocks.map((block) => block.selfReview.final.answerConfidence)
      ),
      peerMeanConfidence: meanNullable(blocks.map((block) => block.peer.final.answerConfidence))
    },
    confidenceCalibration: {
      initialMeanBrier: meanBrier(blocks.map((block) => block.initial)),
      workbenchFinalMeanBrier: meanBrier(blocks.map((block) => block.workbench.final)),
      selfReviewFinalMeanBrier: meanBrier(blocks.map((block) => block.selfReview.final)),
      peerFinalMeanBrier: meanBrier(blocks.map((block) => block.peer.final))
    },
    perCase: groupedSummaries(blocks, (block) => block.caseId),
    perDomain: groupedSummaries(blocks, (block) => block.domain),
    inferentialStatisticsUsed: false
  };
}

/** Adapter used by the terminal runner; it contains no provider or artifact I/O. */
export function createHardPeer80Scorer(): HardPeer80Scorer {
  return {
    scoreAnswer(oracle, output) {
      return toExperimentAnswerScore(scoreHardPeer80Output({ oracle, output }));
    },
    scoreBlocks(input) {
      const scores = scoreRunnerBlocks(input.plan, input.records, input.oracles, input.calls);
      const interpretation = interpretHardPeer80Evaluation(scores.internal);
      return {
        blocks: scores.external,
        interpretation: toExperimentInterpretation(interpretation)
      };
    }
  };
}

function scoreRunnerBlocks(
  plan: HardPeer80Plan,
  records: readonly HardPeer80ParticipantRecord[],
  oracles: readonly HardPeer80OracleRecord[],
  calls: readonly HardPeer80CallObservation[]
): { internal: HardPeer80EvaluationBlockScore[]; external: HardPeer80ScoredBlock[] } {
  const recordsById = new Map(records.map((record) => [record.caseId, record]));
  const oraclesById = new Map(oracles.map((oracle) => [oracle.caseId, oracle]));
  const callsById = new Map(calls.map((call) => [call.assignment.callId, call]));
  const internal: HardPeer80EvaluationBlockScore[] = [];
  const external: HardPeer80ScoredBlock[] = [];
  for (const blockId of plan.schedule.evaluationBlockIds) {
    const assignments = plan.assignments.filter((assignment) => assignment.blockId === blockId);
    const a0Assignment = assignments.find((assignment) => assignment.turnId === 'A0');
    if (!a0Assignment?.caseId) continue;
    const record = recordsById.get(a0Assignment.caseId);
    const oracle = oraclesById.get(a0Assignment.caseId);
    if (!record || !oracle) continue;
    const callByTurn = new Map(assignments.map((assignment) => [
      assignment.turnId,
      callsById.get(assignment.callId)
    ]));
    const observed = (turn: 'A0' | 'W1' | 'W2' | 'S1' | 'S2' | 'P1' | 'AP1') =>
      observedArtifact(callByTurn.get(turn));
    const input: HardPeer80EvaluationBlockInput = {
      blockId,
      caseId: record.caseId,
      domain: record.domain,
      repetition: a0Assignment.repetition as 1 | 2,
      oracle,
      artifacts: {
        A0: observed('A0'), W1: observed('W1'), W2: observed('W2'),
        S1: observed('S1'), S2: observed('S2'), P1: observed('P1'), AP1: observed('AP1')
      }
    };
    const block = scoreHardPeer80EvaluationBlock(input);
    internal.push(block);
    const call = (turn: 'A0' | 'W1' | 'W2' | 'S1' | 'S2' | 'P1' | 'AP1') =>
      callByTurn.get(turn);
    external.push({
      blockId,
      caseId: record.caseId,
      repetition: input.repetition,
      domain: record.domain,
      initial: toExperimentAnswerScore(block.initial),
      workbench: toExperimentAnswerScore(block.workbench.final),
      selfReview: toExperimentAnswerScore(block.selfReview.final),
      peer: toExperimentAnswerScore(block.peer.final),
      peerReview: structuredClone(block.peerReview) as unknown as Record<string, unknown>,
      critiqueAttributableCorrection: block.critiqueAttributableCorrection === true,
      incrementalPeerCorrection: block.incrementalPeerCorrection === true,
      rightToWrongPeerContamination: block.rightToWrongPeerContamination === true,
      inventedMaterialCriticism: block.peerReview.invalidMaterialIssueCount,
      harmfulInvalidCritiqueAdoption: block.harmfulAdoptionCount > 0,
      unsupportedDefiniteClosure: block.unsupportedClosureCount > 0,
      falseDisagreementResolution: block.falseDisagreementResolutionCount > 0,
      requiredUnresolvedOrRequestPreserved:
        block.requiredRequestsPreserved === true &&
        block.unresolvedMaterialIssuesPreserved === true,
      conditionUsage: {
        WORKBENCH: sumCallUsage([call('A0'), call('W1'), call('W2')]),
        SELF_REVIEW: sumCallUsage([call('A0'), call('S1'), call('S2')]),
        PEER: sumCallUsage([call('A0'), call('P1'), call('AP1')])
      },
      conditionLatencyMs: {
        WORKBENCH: sumCallLatency([call('A0'), call('W1'), call('W2')]),
        SELF_REVIEW: sumCallLatency([call('A0'), call('S1'), call('S2')]),
        PEER: sumCallLatency([call('A0'), call('P1'), call('AP1')])
      }
    });
  }
  return { internal, external };
}

function observedArtifact(
  observation: HardPeer80CallObservation | undefined
): HardPeer80ObservedArtifact {
  const usage = observation?.call.usage?.last;
  const completeUsage = usage && Object.values(usage).every(
    (value) => Number.isSafeInteger(value) && value >= 0
  ) ? usage : null;
  return {
    output: observation?.output ?? null,
    measurementStatus: observation?.output ? 'VALID' : observation ? 'INVALID' : 'UNAVAILABLE',
    observedTotalTokens: completeUsage?.totalTokens ?? null,
    latencyMs: observation?.latencyMs ?? null
  };
}

function toExperimentAnswerScore(score: HardPeer80OutputScore): HardPeer80AnswerScore {
  const correct = score.fullyCorrect === true;
  return {
    outputValid: score.measurementStatus === 'VALID',
    statusCorrect: score.statusCorrect === true,
    optionsCorrect: score.optionsCorrect === true,
    claimsCorrect: score.requiredClaimsCorrect === true,
    evidenceValid: score.requiredClaimEvidence.opportunities > 0 &&
      score.requiredClaimEvidence.count === score.requiredClaimEvidence.opportunities,
    certificateEligible: score.certificateShapeCorrect === true &&
      score.certificateSemanticValidity === true,
    requestCorrect: score.requestCorrect === true,
    abstentionCorrect: score.abstentionCorrect === true,
    compositeCorrect: correct,
    confidence: score.answerConfidence,
    brier: score.answerConfidence === null
      ? null
      : (score.answerConfidence - (correct ? 1 : 0)) ** 2
  };
}

function toExperimentInterpretation(
  interpretation: HardPeer80EvaluationInterpretation
): HardPeer80ExperimentInterpretation {
  return {
    status: interpretation.result === 'PEER_ADVANTAGE_DEMONSTRATED'
      ? 'PEER_PILOT_SUPPORTED'
      : interpretation.result === 'NO_CLEAR_ADVANTAGE'
        ? 'SINGLE_AGENT_DEFAULT'
        : 'INCONCLUSIVE',
    informative: interpretation.informative,
    productPilotAuthorized: interpretation.productDecision === 'SMALL_BOUNDED_PEER_PILOT',
    failedGates: [...interpretation.reasons],
    metrics: structuredClone(interpretation) as unknown as Record<string, unknown>
  };
}

function sumCallUsage(
  calls: readonly (HardPeer80CallObservation | undefined)[]
): LabTokenUsage {
  return calls.reduce<LabTokenUsage>((total, observation) => {
    const usage = observation?.call.usage?.last;
    if (!usage) return total;
    return {
      totalTokens: total.totalTokens + usage.totalTokens,
      inputTokens: total.inputTokens + usage.inputTokens,
      cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      reasoningOutputTokens: total.reasoningOutputTokens + usage.reasoningOutputTokens
    };
  }, zeroTokenUsage());
}

function sumCallLatency(calls: readonly (HardPeer80CallObservation | undefined)[]): number {
  return calls.reduce<number>((total, observation) => total + (observation?.latencyMs ?? 0), 0);
}

function zeroTokenUsage(): LabTokenUsage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}

interface PeerResponseAudit {
  directResponseCoverage: HardPeer80Ratio;
  invalidCriticismAdoptedCount: number;
  harmfulAdoptionCount: number;
  unsupportedClosureCount: number;
  falseDisagreementResolutionCount: number;
  unresolvedMaterialIssuesPreserved: boolean | null;
  attributableIssueIds: Set<string>;
}

function auditPeerResponses(
  oracle: HardPeer80OracleRecord,
  initial: HardPeer80PublicOutput | null,
  peerReviewOutput: HardPeer80PublicOutput | null,
  final: HardPeer80PublicOutput | null,
  initialScore: HardPeer80OutputScore,
  finalScore: HardPeer80OutputScore,
  peerReviewScore: HardPeer80PeerReviewScore
): PeerResponseAudit {
  if (!initial || !peerReviewOutput || !final || peerReviewScore.measurementStatus !== 'VALID') {
    return {
      directResponseCoverage: ratio(0, 0),
      invalidCriticismAdoptedCount: 0,
      harmfulAdoptionCount: 0,
      unsupportedClosureCount: 0,
      falseDisagreementResolutionCount: 0,
      unresolvedMaterialIssuesPreserved: null,
      attributableIssueIds: new Set()
    };
  }
  const responseByIssue = new Map(final.responses.map((response) => [response.targetIssueId, response]));
  const finalDisagreements = final.disagreements;
  let direct = 0;
  let invalidAdopted = 0;
  let harmful = 0;
  let unsupported = 0;
  let falseResolution = 0;
  let preservationUnknown = false;
  let allRequiredUnresolvedPreserved = true;
  const attributableIssueIds = new Set<string>();

  for (const issueScore of peerReviewScore.issueScores) {
    if (!issueScore.material) continue;
    const issue = peerReviewOutput.issues.find((candidate) => candidate.id === issueScore.issueId);
    if (!issue) {
      preservationUnknown = true;
      continue;
    }
    const target = issueTarget(issue);
    const response = responseByIssue.get(issueScore.issueId);
    const directResponse = response !== undefined && response.targetArtifactId === 'P1';
    if (directResponse) direct += 1;
    const accepted = response?.disposition === 'ACCEPT' || response?.disposition === 'PARTIAL';
    const changedTarget = response !== undefined && includesTarget(response.changedTargets, target);
    const responseEvidenceValid = response !== undefined && response.evidence.length > 0 &&
      evidenceValidForIssue(response.evidence, oracle, issue);
    const initialTarget = targetCorrectness(initialScore, issue);
    const finalTarget = targetCorrectness(finalScore, issue);
    if (
      issueScore.validMaterialCritique === true && directResponse && accepted && changedTarget &&
      responseEvidenceValid && issueScore.initialTargetWrong === true && finalTarget === true &&
      finalScore.fullyCorrect === true
    ) {
      attributableIssueIds.add(issueScore.issueId);
    }
    // ACCEPT/PARTIAL is itself an adoption signal. Do not let an author hide a
    // harmful transition by omitting the corresponding self-reported target.
    // `changedTargets` remains mandatory for positive critique attribution.
    if (issueScore.validMaterialCritique === false && accepted) {
      invalidAdopted += 1;
      if (initialTarget === true && finalTarget === false) harmful += 1;
    }

    const dispositionRequiresOpen = response?.disposition === 'PARTIAL' ||
      response?.disposition === 'ABSTAIN';
    const correctnessRequiresOpen = issueScore.validMaterialCritique === true &&
      finalTarget === false;
    const correctnessUnknown = issueScore.validMaterialCritique === true &&
      finalTarget === null;
    if (correctnessUnknown) preservationUnknown = true;
    const shouldRemainOpen = dispositionRequiresOpen || correctnessRequiresOpen;
    if (!shouldRemainOpen) continue;
    const issueListedUnresolved = final.resolution.unresolvedIssueIds.includes(issueScore.issueId);
    const explicitDisagreement = finalDisagreements.some((disagreement) =>
      includesTarget(disagreement.targets, target) &&
      disagreement.participantArtifactIds.includes('A0') &&
      disagreement.participantArtifactIds.includes('P1') &&
      disagreement.participantArtifactIds.includes('AP1') &&
      (disagreement.status === 'UNRESOLVED' ||
        (oracle.disagreementPolicy.userOwnedCrux && disagreement.status === 'NEEDS_USER_INPUT'))
    );
    if (!issueListedUnresolved || !explicitDisagreement) {
      allRequiredUnresolvedPreserved = false;
      falseResolution += 1;
    }
    const claimsClosure = final.resolution.resolvedIssueIds.includes(issueScore.issueId) ||
      final.resolution.status === 'RESOLVED' || final.resolution.status === 'NO_DISAGREEMENT';
    if (claimsClosure) unsupported += 1;
  }

  return {
    directResponseCoverage: ratio(direct, peerReviewScore.materialIssueCount),
    invalidCriticismAdoptedCount: invalidAdopted,
    harmfulAdoptionCount: harmful,
    unsupportedClosureCount: unsupported,
    falseDisagreementResolutionCount: falseResolution,
    unresolvedMaterialIssuesPreserved: preservationUnknown
      ? null
      : allRequiredUnresolvedPreserved,
    attributableIssueIds
  };
}

function critiqueAttribution(
  initial: HardPeer80OutputScore,
  final: HardPeer80OutputScore,
  peerReview: HardPeer80PeerReviewScore,
  responseAudit: PeerResponseAudit,
  initialOutput: HardPeer80PublicOutput | null,
  finalOutput: HardPeer80PublicOutput | null
): boolean | null {
  if (!initialOutput || !finalOutput || initial.fullyCorrect === null || final.fullyCorrect === null) {
    return null;
  }
  if (initial.fullyCorrect !== false || final.fullyCorrect !== true) return false;
  if (peerReview.unadjudicatedMaterialIssueCount > 0) return null;
  return responseAudit.attributableIssueIds.size > 0;
}

function conditionScore(
  initial: HardPeer80OutputScore,
  final: HardPeer80OutputScore,
  chargedArtifacts: readonly HardPeer80ObservedArtifact[]
): HardPeer80ConditionScore {
  return {
    final,
    wrongToRightCorrection: transition(initial.fullyCorrect, final.fullyCorrect, false, true),
    rightToWrongContamination: transition(initial.fullyCorrect, final.fullyCorrect, true, false),
    chargedObservedTokens: sumNullable(chargedArtifacts.map((artifact) => artifact.observedTotalTokens)),
    chargedLatencyMs: sumNullable(chargedArtifacts.map((artifact) => artifact.latencyMs))
  };
}

function requiredClaimEvidenceCorrect(
  evidence: readonly HardPeer80EvidenceReference[],
  oracle: HardPeer80OracleRecord,
  stance: HardPeer80OracleRecord['atomicClaims'][number]['expected']
): boolean {
  return evidence.length > 0 && evidenceValidForStance(evidence, oracle, stance) &&
    oracle.requiredEvidenceIds.every((requiredId) => evidence.some(
      (reference) => reference.evidenceId === requiredId
    ));
}

function targetCorrectness(
  score: HardPeer80OutputScore,
  issue: HardPeer80Issue
): boolean | null {
  switch (issue.targetComponent) {
    case 'PROPOSITION': {
      const correctness = score.requiredClaimCorrectnessById[issue.targetPropositionId];
      return correctness === undefined ? null : correctness;
    }
    case 'ANSWER_SELECTION':
      return score.optionsCorrect;
    case 'EPISTEMIC_STATE':
      return andNullable(score.statusCorrect, andNullable(score.requestCorrect, score.abstentionCorrect));
    case 'CERTIFICATE':
      return andNullable(score.certificateShapeCorrect, score.certificateSemanticValidity);
  }
}

function proposedCorrectionMatchesOracle(
  issue: HardPeer80Issue,
  oracle: HardPeer80OracleRecord
): boolean {
  switch (issue.targetComponent) {
    case 'PROPOSITION':
      return oracle.atomicClaims.some((claim) =>
        claim.id === issue.targetPropositionId && claim.expected === issue.proposedStance
      );
    case 'ANSWER_SELECTION':
      return sameSet(issue.proposedOptionIds, oracle.acceptedOptionIds);
    case 'EPISTEMIC_STATE':
      return issue.proposedStatus === oracle.acceptedStatus;
    case 'CERTIFICATE':
      return validateHardPeer80Certificate(oracle.caseId, issue.proposedCertificate).valid;
  }
}

function evidenceValidForIssue(
  evidence: readonly HardPeer80EvidenceReference[],
  oracle: HardPeer80OracleRecord,
  issue: HardPeer80Issue
): boolean {
  return issue.targetComponent === 'PROPOSITION'
    ? evidenceValidForStance(evidence, oracle, issue.proposedStance)
    : issue.targetComponent === 'EPISTEMIC_STATE' && issue.proposedStatus !== 'ANSWER'
      ? evidenceValidForRelation(evidence, oracle, 'LIMITS')
      : evidenceValidForRelation(evidence, oracle, 'SUPPORTS');
}

function issueTarget(issue: HardPeer80Issue): HardPeer80TargetReference {
  return issue.targetComponent === 'PROPOSITION'
    ? { component: 'PROPOSITION', propositionId: issue.targetPropositionId }
    : { component: issue.targetComponent, propositionId: null };
}

function includesTarget(
  targets: readonly HardPeer80TargetReference[],
  expected: HardPeer80TargetReference
): boolean {
  return targets.some((target) =>
    target.component === expected.component && target.propositionId === expected.propositionId
  );
}

function invertNullable(value: boolean | null): boolean | null {
  return value === null ? null : !value;
}

function andNullable(left: boolean | null, right: boolean | null): boolean | null {
  if (left === false || right === false) return false;
  return left === null || right === null ? null : true;
}

function validateCertificate(
  caseId: string,
  payload: HardPeer80Certificate | null
): { valid: true } | { valid: false; error: string } {
  return payload === null
    ? { valid: false, error: 'A typed certificate payload is absent.' }
    : validateHardPeer80Certificate(caseId, payload);
}

function evidenceValidForStance(
  evidence: readonly HardPeer80EvidenceReference[],
  oracle: HardPeer80OracleRecord,
  stance: HardPeer80PublicOutput['claims'][number]['stance']
): boolean {
  const expectedRelation = stance === 'ACCEPT'
    ? 'SUPPORTS'
    : stance === 'REJECT'
      ? 'CONTRADICTS'
      : 'LIMITS';
  return evidenceValidForRelation(evidence, oracle, expectedRelation);
}

function evidenceValidForRelation(
  evidence: readonly HardPeer80EvidenceReference[],
  oracle: HardPeer80OracleRecord,
  expectedRelation: HardPeer80EvidenceReference['relation']
): boolean {
  const allowed = new Set<string>(oracle.requiredEvidenceIds);
  return evidence.every((reference) =>
    allowed.has(reference.evidenceId) && reference.relation === expectedRelation
  );
}

function unavailableOutputScore(status: HardPeer80MeasurementStatus): HardPeer80OutputScore {
  return {
    measurementStatus: status,
    automaticNonCertificateFieldsCorrect: null,
    fullyCorrect: null,
    deterministicCertificateScoring: true,
    statusCorrect: null,
    optionsCorrect: null,
    requiredClaimsCorrect: null,
    requiredClaimCorrectnessById: {},
    requiredClaimEvidence: ratio(0, 0),
    certificateShapeCorrect: null,
    certificateSemanticValidity: null,
    certificateSemanticError: null,
    requestCorrect: null,
    abstentionCorrect: null,
    answerTextQuality: 'SUMMARY_NOT_SEPARATELY_SCORED_TYPED_FIELDS_AUTHORITATIVE',
    answerConfidence: null,
    meanClaimConfidence: null,
    highConfidenceWrong: null,
    abstained: null,
    uncertain: null
  };
}

function validEvaluationTopology(blocks: readonly HardPeer80EvaluationBlockScore[]): boolean {
  if (blocks.length !== 10 || new Set(blocks.map((block) => block.blockId)).size !== 10) return false;
  const byCase = new Map<string, HardPeer80EvaluationBlockScore[]>();
  for (const block of blocks) {
    const values = byCase.get(block.caseId) ?? [];
    values.push(block);
    byCase.set(block.caseId, values);
  }
  if (byCase.size !== 5) return false;
  const domains = new Set<HardPeer80Domain>();
  for (const values of byCase.values()) {
    if (values.length !== 2 || values[0]!.domain !== values[1]!.domain ||
      !sameSet(values.map((value) => String(value.repetition)), ['1', '2'])) return false;
    domains.add(values[0]!.domain);
  }
  return domains.size === 5;
}

function groupedSummaries(
  blocks: readonly HardPeer80EvaluationBlockScore[],
  keyOf: (block: HardPeer80EvaluationBlockScore) => string
): HardPeer80GroupedSummary[] {
  const groups = new Map<string, HardPeer80EvaluationBlockScore[]>();
  for (const block of blocks) {
    const key = keyOf(block);
    groups.set(key, [...(groups.get(key) ?? []), block]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => ({
      key,
      blockCount: values.length,
      uniqueCaseCount: new Set(values.map((value) => value.caseId)).size,
      initialCorrect: countTrue(values.map((value) => value.initial.fullyCorrect)),
      workbenchCorrect: countTrue(values.map((value) => value.workbench.final.fullyCorrect)),
      selfReviewCorrect: countTrue(values.map((value) => value.selfReview.final.fullyCorrect)),
      peerCorrect: countTrue(values.map((value) => value.peer.final.fullyCorrect)),
      incrementalPeerCorrections: countTrue(values.map((value) => value.incrementalPeerCorrection)),
      peerContaminations: countTrue(values.map((value) => value.rightToWrongPeerContamination)),
      inventedMaterialCriticisms: sum(values.map(
        (value) => value.peerReview.invalidMaterialIssueCount
      ))
    }));
}

function combineMeasurementStatus(
  ...artifacts: readonly HardPeer80ObservedArtifact[]
): HardPeer80MeasurementStatus {
  if (artifacts.some((artifact) => artifact.measurementStatus === 'INVALID')) return 'INVALID';
  if (artifacts.some((artifact) => artifact.measurementStatus === 'UNAVAILABLE')) return 'UNAVAILABLE';
  return 'VALID';
}

function transition(
  initial: boolean | null,
  final: boolean | null,
  expectedInitial: boolean,
  expectedFinal: boolean
): boolean | null {
  if (initial === null || final === null) return null;
  return initial === expectedInitial && final === expectedFinal;
}

function everyBoolean(values: readonly (boolean | null)[]): boolean | null {
  if (values.some((value) => value === false)) return false;
  return values.some((value) => value === null) ? null : true;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && sameArray([...left].sort(), [...right].sort());
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ratio(count: number, opportunities: number): HardPeer80Ratio {
  return { count, opportunities, rate: opportunities === 0 ? null : count / opportunities };
}

function countTrue(values: readonly (boolean | null)[]): number {
  return values.filter((value) => value === true).length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumNullable(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function safeRatio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  return values.length === 0 || values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0) / values.length;
}

function meanBrier(scores: readonly HardPeer80OutputScore[]): number | null {
  return meanNullable(scores.map((score) =>
    score.answerConfidence === null || score.fullyCorrect === null
      ? null
      : (score.answerConfidence - (score.fullyCorrect ? 1 : 0)) ** 2
  ));
}
