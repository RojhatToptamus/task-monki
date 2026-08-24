import { describe, expect, it } from 'vitest';
import {
  HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
  type HardPeer80PublicOutput
} from './hardPeer80Contracts';
import type {
  HardPeer80Certificate,
  HardPeer80Domain,
  HardPeer80OracleRecord
} from './hardPeer80Corpus';
import {
  createHardPeer80Scorer,
  interpretHardPeer80Evaluation,
  scoreHardPeer80EvaluationBlock,
  scoreHardPeer80Output,
  scoreHardPeer80PeerReview,
  type HardPeer80EvaluationBlockInput,
  type HardPeer80EvaluationBlockScore,
  type HardPeer80ObservedArtifact
} from './hardPeer80Scoring';

describe('HARD-PEER-80 frozen structured scoring', () => {
  it('requires exact answer fields and a deterministically valid typed certificate', () => {
    const score = scoreHardPeer80Output({ oracle: oracle(), output: answer('INITIAL', true) });

    expect(score).toMatchObject({
      measurementStatus: 'VALID',
      automaticNonCertificateFieldsCorrect: true,
      fullyCorrect: true,
      statusCorrect: true,
      optionsCorrect: true,
      requiredClaimsCorrect: true,
      certificateShapeCorrect: true,
      certificateSemanticValidity: true,
      certificateSemanticError: null,
      requestCorrect: true,
      abstentionCorrect: true,
      answerTextQuality: 'SUMMARY_NOT_SEPARATELY_SCORED_TYPED_FIELDS_AUTHORITATIVE'
    });
    expect(score.requiredClaimEvidence).toEqual({ count: 2, opportunities: 2, rate: 1 });
    expect(score.answerConfidence).toBe(0.9);

    const malformed = answer('INITIAL', true);
    malformed.answer.selectedOptionIds = ['bad-option'];
    malformed.claims[0]!.evidence = [];
    malformed.certificate = { kind: 'NONE', statement: 'No certificate.', evidence: [], payload: null };
    malformed.requests = [{
      id: 'spurious-request',
      kind: 'MISSING_FACT',
      question: 'Please supply a fact already present.',
      source: 'USER',
      blocking: true,
      propositionIds: ['p1']
    }];
    const failed = scoreHardPeer80Output({ oracle: oracle(), output: malformed });
    expect(failed).toMatchObject({
      fullyCorrect: false,
      optionsCorrect: false,
      requiredClaimsCorrect: false,
      certificateShapeCorrect: false,
      requestCorrect: false,
      highConfidenceWrong: true
    });
    expect(failed.requiredClaimEvidence).toEqual({ count: 1, opportunities: 2, rate: 0.5 });
  });

  it('rejects right labels backed by a false, wrong-kind, or absent typed certificate', () => {
    const falseCertificate = answer('INITIAL', true);
    const falsePayload = structuredClone(validCertificatePayload());
    if (falsePayload.kind !== 'BOOLEAN_TRUTH_TABLE') throw new Error('wrong test payload');
    falsePayload.queryFalseAssignments = [];
    falseCertificate.certificate.payload = falsePayload;
    expect(scoreHardPeer80Output({ oracle: oracle(), output: falseCertificate })).toMatchObject({
      automaticNonCertificateFieldsCorrect: true,
      certificateShapeCorrect: true,
      certificateSemanticValidity: false,
      fullyCorrect: false
    });

    const wrongKind = answer('INITIAL', true);
    wrongKind.certificate.payload = {
      kind: 'IDEMPOTENT_CREATE_CRASH_TABLE',
      durableKeyBeforeCall: true,
      sameKeyOnRecovery: true,
      providerIdempotentByKey: true,
      providerLookupByKey: true,
      workflowRequiresLocalVerification: true,
      crashScenarios: [{
        providerCreateAppliedBeforeCrash: false,
        createReplyReceivedBeforeCrash: false,
        remoteIdPersistedBeforeCrash: false,
        recoveryContactsProvider: true,
        recoveryUsesPersistedKey: true,
        atMostOneRemoteTurn: true,
        remoteIdEventuallyRecoverable: true
      }]
    };
    expect(scoreHardPeer80Output({ oracle: oracle(), output: wrongKind })).toMatchObject({
      certificateShapeCorrect: true,
      certificateSemanticValidity: false,
      fullyCorrect: false
    });

    const absent = answer('INITIAL', true);
    absent.certificate.payload = null;
    expect(scoreHardPeer80Output({ oracle: oracle(), output: absent })).toMatchObject({
      certificateShapeCorrect: false,
      certificateSemanticValidity: false,
      fullyCorrect: false
    });
  });

  it('rejects an inverted evidence relation even when the source id and stance are correct', () => {
    const inverted = answer('INITIAL', true);
    inverted.claims[0]!.evidence[0]!.relation = 'CONTRADICTS';

    const score = scoreHardPeer80Output({ oracle: oracle(), output: inverted });
    expect(score).toMatchObject({
      automaticNonCertificateFieldsCorrect: false,
      fullyCorrect: false,
      requiredClaimsCorrect: false,
      requiredClaimEvidence: { count: 1, opportunities: 2, rate: 0.5 }
    });

    const aligned = scoreHardPeer80Output({ oracle: oracle(), output: answer('INITIAL', true) });
    expect(aligned).toMatchObject({
      fullyCorrect: true,
      requiredClaimsCorrect: true,
      requiredClaimEvidence: { count: 2, opportunities: 2, rate: 1 }
    });
  });

  it('retains invalid and unavailable observations instead of scoring them as wrong answers', () => {
    expect(scoreHardPeer80Output({
      oracle: oracle(), output: answer('INITIAL', true), measurementStatus: 'INVALID'
    })).toMatchObject({ measurementStatus: 'INVALID', fullyCorrect: null });
    expect(scoreHardPeer80Output({ oracle: oracle(), output: null })).toMatchObject({
      measurementStatus: 'UNAVAILABLE', fullyCorrect: null, answerConfidence: null
    });
  });

  it('matches critique validity only through frozen typed rules, never issue prose', () => {
    const initial = answer('INITIAL', false);
    const peer = peerCritique();
    peer.issues[0]!.statement = 'Arbitrary prose is deliberately not semantically guessed by the scorer.';

    const score = scoreHardPeer80PeerReview({ oracle: oracle(), initial, peerReview: peer });
    expect(score).toMatchObject({
      materialIssueCount: 1,
      validMaterialIssueCount: 1,
      invalidMaterialIssueCount: 0,
      unadjudicatedMaterialIssueCount: 0,
      critiqueEvidenceValidity: { count: 1, opportunities: 1, rate: 1 }
    });
    expect(score.issueScores[0]).toMatchObject({
      targetComponent: 'PROPOSITION',
      initialTargetWrong: true,
      targetsA0: true,
      proposedCorrectionCorrect: true,
      oraclePredicateMatched: true,
      peerTargetAssessmentCorrect: true,
      peerCertificateValid: true,
      evidenceGrounded: true,
      validMaterialCritique: true,
      failedTypedRules: []
    });
  });

  it('does not manufacture an invented-criticism opportunity when the peer reports no issue', () => {
    const initial = answer('INITIAL', true);
    const peer = answer('PEER_CRITIQUE', true);
    const score = scoreHardPeer80PeerReview({ oracle: oracle(), initial, peerReview: peer });

    expect(score).toMatchObject({
      noMaterialIssueReported: true,
      materialIssueCount: 0,
      validMaterialIssueCount: 0,
      invalidMaterialIssueCount: 0,
      inventedCriticism: { count: 0, opportunities: 0, rate: null }
    });
  });

  it('records uncertainty and abstention without treating either as a parser failure', () => {
    const uncertain = answer('INITIAL', true);
    uncertain.answer.status = 'UNCERTAIN';
    const uncertainScore = scoreHardPeer80Output({ oracle: oracle(), output: uncertain });
    expect(uncertainScore).toMatchObject({
      measurementStatus: 'VALID', fullyCorrect: false, uncertain: true, abstained: false
    });

    const abstained = answer('INITIAL', true);
    abstained.answer.status = 'ABSTAIN';
    abstained.abstention = {
      reason: 'INSUFFICIENT_INFORMATION',
      summary: 'I cannot establish the answer.',
      propositionIds: ['p1'],
      whatWouldResolve: 'More information.'
    };
    const abstentionScore = scoreHardPeer80Output({ oracle: oracle(), output: abstained });
    expect(abstentionScore).toMatchObject({
      measurementStatus: 'VALID', fullyCorrect: false, abstained: true, abstentionCorrect: false
    });
  });

  it.each([
    ['correct A0 target', (initial: HardPeer80PublicOutput) => overwriteWithCorrect(initial),
      'TARGET_NOT_WRONG_IN_A0'],
    ['wrong proposed stance', (_initial: HardPeer80PublicOutput, peer: HardPeer80PublicOutput) => {
      peer.issues[0]!.proposedStance = 'REJECT';
    }, 'PROPOSED_CORRECTION_NOT_ORACLE'],
    ['unpermitted kind', (_initial: HardPeer80PublicOutput, peer: HardPeer80PublicOutput) => {
      peer.issues[0]!.kind = 'TRADEOFF';
    }, 'NO_TYPED_ORACLE_PREDICATE'],
    ['empty evidence', (_initial: HardPeer80PublicOutput, peer: HardPeer80PublicOutput) => {
      peer.issues[0]!.evidence = [];
    }, 'EVIDENCE_ID_OR_RELATION_INVALID_OR_EMPTY'],
    ['inverted evidence relation', (_initial: HardPeer80PublicOutput, peer: HardPeer80PublicOutput) => {
      peer.issues[0]!.evidence[0]!.relation = 'CONTRADICTS';
    }, 'EVIDENCE_ID_OR_RELATION_INVALID_OR_EMPTY']
  ])('rejects a material issue with %s', (_label, mutate, expectedRule) => {
    const initial = answer('INITIAL', false);
    const peer = peerCritique();
    mutate(initial, peer);
    const score = scoreHardPeer80PeerReview({ oracle: oracle(), initial, peerReview: peer });
    expect(score.invalidMaterialIssueCount).toBe(1);
    expect(score.inventedCriticism).toEqual({ count: 1, opportunities: 1, rate: 1 });
    expect(score.issueScores[0]!.failedTypedRules).toContain(expectedRule);
  });

  it('attributes a peer-only correction only after a direct accepted response changes its target', () => {
    const score = scoreHardPeer80EvaluationBlock(correctionBlock());

    expect(score).toMatchObject({
      allProviderObservationsValid: true,
      outcomeMeasurementComplete: true,
      critiqueAttributableCorrection: true,
      incrementalPeerCorrection: true,
      sharedErrorDiscovery: 'NOT_ESTIMABLE_A0_ANCHORED_PEER',
      rightToWrongPeerContamination: false,
      invalidCriticismAdoptedCount: 0,
      harmfulAdoptionCount: 0,
      unsupportedClosureCount: 0,
      falseDisagreementResolutionCount: 0,
      requiredRequestsPreserved: true,
      unresolvedMaterialIssuesPreserved: true,
      correctMinorityPreservation: 'NOT_ESTIMABLE_A0_ANCHORED_PEER'
    });
    expect(score.directResponseCoverage).toEqual({ count: 1, opportunities: 1, rate: 1 });

    const noChange = correctionBlock();
    noChange.artifacts.AP1.output!.responses[0]!.changedTargets = [];
    expect(scoreHardPeer80EvaluationBlock(noChange).critiqueAttributableCorrection).toBe(false);

    const invertedResponseEvidence = correctionBlock();
    invertedResponseEvidence.artifacts.AP1.output!.responses[0]!.evidence[0]!.relation =
      'CONTRADICTS';
    expect(scoreHardPeer80EvaluationBlock(invertedResponseEvidence)).toMatchObject({
      critiqueAttributableCorrection: false,
      incrementalPeerCorrection: false
    });

    const falseFinalCertificate = correctionBlock();
    const falseFinalPayload = structuredClone(validCertificatePayload());
    if (falseFinalPayload.kind !== 'BOOLEAN_TRUTH_TABLE') throw new Error('wrong test payload');
    falseFinalPayload.queryFalseAssignments = [];
    falseFinalCertificate.artifacts.AP1.output!.certificate.payload = falseFinalPayload;
    expect(scoreHardPeer80EvaluationBlock(falseFinalCertificate)).toMatchObject({
      critiqueAttributableCorrection: false,
      incrementalPeerCorrection: false,
      peer: { final: { certificateSemanticValidity: false, fullyCorrect: false } }
    });
  });

  it('attributes a certificate-only repair through a typed certificate issue', () => {
    const proofRepair = correctionBlock();
    const initial = answer('INITIAL', true);
    const falsePayload = structuredClone(validCertificatePayload());
    if (falsePayload.kind !== 'BOOLEAN_TRUTH_TABLE') throw new Error('wrong test payload');
    falsePayload.queryFalseAssignments = [];
    initial.certificate.payload = falsePayload;
    proofRepair.artifacts.A0 = observed(initial);
    proofRepair.artifacts.P1.output!.issues = [certificateIssue()];
    proofRepair.artifacts.AP1.output!.responses[0]!.changedTargets = [
      { component: 'CERTIFICATE', propositionId: null }
    ];

    const repaired = scoreHardPeer80EvaluationBlock(proofRepair);
    expect(repaired.peerReview.issueScores[0]).toMatchObject({
      targetComponent: 'CERTIFICATE',
      initialClaimWrong: null,
      initialCertificateInvalid: true,
      initialTargetWrong: true,
      oraclePredicateMatched: null,
      proposedCorrectionCorrect: true,
      peerTargetAssessmentCorrect: true,
      peerCertificateValid: true,
      validMaterialCritique: true,
      failedTypedRules: []
    });
    expect(repaired).toMatchObject({
      critiqueAttributableCorrection: true,
      incrementalPeerCorrection: true,
      peer: { final: { certificateSemanticValidity: true, fullyCorrect: true } }
    });

    const wrongProposal = structuredClone(proofRepair);
    const proposedPayload = wrongProposal.artifacts.P1.output!.issues[0]!.proposedCertificate;
    if (proposedPayload?.kind !== 'BOOLEAN_TRUTH_TABLE') throw new Error('wrong test payload');
    proposedPayload.queryFalseAssignments = [];
    const rejected = scoreHardPeer80EvaluationBlock(wrongProposal);
    expect(rejected.peerReview.issueScores[0]).toMatchObject({
      proposedCorrectionCorrect: false,
      validMaterialCritique: false,
      failedTypedRules: expect.arrayContaining(['PROPOSED_CORRECTION_NOT_ORACLE'])
    });
    expect(rejected.critiqueAttributableCorrection).toBe(false);
  });

  it('attributes a selected-option-only repair through a typed answer-selection issue', () => {
    const optionRepair = correctionBlock();
    const initial = answer('INITIAL', true);
    initial.answer.selectedOptionIds = ['bad'];
    optionRepair.artifacts.A0 = observed(initial);
    optionRepair.artifacts.P1.output!.issues = [answerSelectionIssue()];
    optionRepair.artifacts.AP1.output!.responses[0]!.changedTargets = [
      { component: 'ANSWER_SELECTION', propositionId: null }
    ];

    const repaired = scoreHardPeer80EvaluationBlock(optionRepair);
    expect(repaired.peerReview.issueScores[0]).toMatchObject({
      targetComponent: 'ANSWER_SELECTION',
      initialClaimWrong: null,
      initialOptionsWrong: true,
      initialTargetWrong: true,
      proposedCorrectionCorrect: true,
      peerTargetAssessmentCorrect: true,
      validMaterialCritique: true,
      failedTypedRules: []
    });
    expect(repaired).toMatchObject({
      critiqueAttributableCorrection: true,
      incrementalPeerCorrection: true,
      peer: { final: { optionsCorrect: true, fullyCorrect: true } }
    });

    const mismatchedChange = structuredClone(optionRepair);
    mismatchedChange.artifacts.AP1.output!.responses[0]!.changedTargets = [
      { component: 'PROPOSITION', propositionId: 'p1' }
    ];
    expect(scoreHardPeer80EvaluationBlock(mismatchedChange)).toMatchObject({
      critiqueAttributableCorrection: false,
      incrementalPeerCorrection: false
    });
  });

  it('attributes a typed epistemic-state correction while rejecting a hollow peer', () => {
    const stateRepair = correctionBlock();
    const initial = answer('INITIAL', true);
    initial.answer.status = 'UNCERTAIN';
    stateRepair.artifacts.A0 = observed(initial);
    stateRepair.artifacts.P1.output!.issues = [epistemicStateIssue()];
    stateRepair.artifacts.AP1.output!.responses[0]!.changedTargets = [
      { component: 'EPISTEMIC_STATE', propositionId: null }
    ];

    expect(scoreHardPeer80EvaluationBlock(stateRepair)).toMatchObject({
      critiqueAttributableCorrection: true,
      incrementalPeerCorrection: true,
      peerReview: {
        issueScores: [expect.objectContaining({
          targetComponent: 'EPISTEMIC_STATE',
          initialEpistemicStateWrong: true,
          validMaterialCritique: true
        })]
      }
    });

    const hollow = structuredClone(stateRepair);
    hollow.artifacts.P1.output!.answer.status = 'UNCERTAIN';
    const rejected = scoreHardPeer80EvaluationBlock(hollow);
    expect(rejected.peerReview.issueScores[0]).toMatchObject({
      peerTargetAssessmentCorrect: false,
      validMaterialCritique: false,
      failedTypedRules: expect.arrayContaining(['PEER_TARGET_ASSESSMENT_NOT_ORACLE'])
    });
    expect(rejected.critiqueAttributableCorrection).toBe(false);
  });

  it('rejects attribution when the peer complaint has a wrong typed certificate', () => {
    const input = correctionBlock();
    const falsePayload = structuredClone(validCertificatePayload());
    if (falsePayload.kind !== 'BOOLEAN_TRUTH_TABLE') throw new Error('wrong test payload');
    falsePayload.queryFalseAssignments = [];
    input.artifacts.P1.output!.certificate.payload = falsePayload;

    const score = scoreHardPeer80EvaluationBlock(input);
    expect(score.peerReview.issueScores[0]).toMatchObject({
      peerCertificateValid: false,
      validMaterialCritique: false,
      failedTypedRules: expect.arrayContaining(['PEER_CERTIFICATE_NOT_VALID'])
    });
    expect(score.critiqueAttributableCorrection).toBe(false);
  });

  it('separates invented criticism, harmful adoption, and right-to-wrong contamination', () => {
    const input = correctionBlock();
    input.artifacts.A0 = observed(answer('INITIAL', true));
    input.artifacts.W1 = observed(answer('WORKBENCH_1', true));
    input.artifacts.W2 = observed(answer('WORKBENCH_FINAL', true));
    input.artifacts.S1 = observed(answer('SELF_REVIEW', true));
    input.artifacts.S2 = observed(answer('SELF_FINAL', true));
    input.artifacts.AP1 = observed(authorFinal(false, 'ACCEPT', true));

    const score = scoreHardPeer80EvaluationBlock(input);
    expect(score.peerReview.invalidMaterialIssueCount).toBe(1);
    expect(score.invalidCriticismAdoptedCount).toBe(1);
    expect(score.harmfulAdoptionCount).toBe(1);
    expect(score.rightToWrongPeerContamination).toBe(true);
    expect(score.critiqueAttributableCorrection).toBe(false);
  });

  it('derives harmful invalid adoption from the target transition, not self-reported changes', () => {
    const input = correctionBlock();
    const initiallyCompositeWrong = answer('INITIAL', true);
    const falsePayload = structuredClone(validCertificatePayload());
    if (falsePayload.kind !== 'BOOLEAN_TRUTH_TABLE') throw new Error('wrong test payload');
    falsePayload.queryFalseAssignments = [];
    initiallyCompositeWrong.certificate.payload = falsePayload;
    input.artifacts.A0 = observed(initiallyCompositeWrong);
    input.artifacts.AP1 = observed(authorFinal(false, 'ACCEPT', false));

    const score = scoreHardPeer80EvaluationBlock(input);
    expect(score.initial).toMatchObject({ fullyCorrect: false, requiredClaimsCorrect: true });
    expect(score.peerReview.invalidMaterialIssueCount).toBe(1);
    expect(score.invalidCriticismAdoptedCount).toBe(1);
    expect(score.harmfulAdoptionCount).toBe(1);
    expect(score.rightToWrongPeerContamination).toBe(false);
    expect(score.critiqueAttributableCorrection).toBe(false);
  });

  it('flags a valid rejected issue that remains wrong but is silently declared resolved', () => {
    const input = correctionBlock();
    input.artifacts.AP1 = observed(authorFinal(false, 'REJECT', false));

    const score = scoreHardPeer80EvaluationBlock(input);
    expect(score.unsupportedClosureCount).toBe(1);
    expect(score.falseDisagreementResolutionCount).toBe(1);
    expect(score.unresolvedMaterialIssuesPreserved).toBe(false);
  });

  it('preserves a partial material disagreement only when it remains explicit and unresolved', () => {
    const input = correctionBlock();
    const final = authorFinal(false, 'PARTIAL', false);
    final.resolution = {
      status: 'PARTIALLY_RESOLVED',
      basis: 'EVIDENCE',
      summary: 'The material issue remains open.',
      resolvedIssueIds: [],
      unresolvedIssueIds: ['peer-issue']
    };
    final.disagreements = [{
      id: 'd1',
      targets: [{ component: 'PROPOSITION', propositionId: 'p1' }],
      participantArtifactIds: ['A0', 'P1', 'AP1'],
      status: 'UNRESOLVED',
      summary: 'The author and peer still disagree on p1.',
      evidence: [{ evidenceId: 'PROMPT', relation: 'LIMITS', note: 'The response did not resolve it.' }],
      requestId: null
    }];
    input.artifacts.AP1 = observed(final);

    const score = scoreHardPeer80EvaluationBlock(input);
    expect(score.unresolvedMaterialIssuesPreserved).toBe(true);
    expect(score.falseDisagreementResolutionCount).toBe(0);
    expect(score.unsupportedClosureCount).toBe(0);
  });

  it('applies the terminal descriptive gate over clustered case repetitions without p-values', () => {
    const blocks = successfulStudyBlocks();
    const result = interpretHardPeer80Evaluation(blocks);

    expect(result).toMatchObject({
      result: 'PEER_ADVANTAGE_DEMONSTRATED',
      productDecision: 'SMALL_BOUNDED_PEER_PILOT',
      reasons: [],
      measurementComplete: true,
      informative: true,
      informativeness: {
        wrongInitialBlocks: 3,
        wrongInitialUniqueCases: 2,
        rightInitialBlocks: 7,
        rightInitialUniqueCases: 4
      },
      correctness: { initial: 7, workbenchFinal: 7, selfReviewFinal: 7, peerFinal: 10 },
      transitions: {
        incrementalPeerCorrections: 3,
        incrementalPeerCorrectionUniqueCases: 2
      },
      cost: {
        peerVsWorkbenchRatio: 1.05,
        peerVsSelfReviewRatio: 1.05,
        peerWithinTenPercentOfEachComparator: true
      },
      inferentialStatisticsUsed: false
    });
    expect(result.perCase).toHaveLength(5);
    expect(result.perDomain).toHaveLength(5);
    expect(result.confidenceCalibration.initialMeanBrier).toBeCloseTo(0.25);
    expect(result.confidenceCalibration.workbenchFinalMeanBrier).toBeCloseTo(0.25);
    expect(result.confidenceCalibration.selfReviewFinalMeanBrier).toBeCloseTo(0.25);
    expect(result.confidenceCalibration.peerFinalMeanBrier).toBeCloseTo(0.01);
  });

  it('permanently defaults on contamination, insufficient spread, excess cost, or incomplete metrics', () => {
    const contamination = successfulStudyBlocks();
    contamination[0]!.rightToWrongPeerContamination = true;
    expect(interpretHardPeer80Evaluation(contamination)).toMatchObject({
      result: 'NO_CLEAR_ADVANTAGE',
      productDecision: 'PERMANENT_SINGLE_AGENT_DEFAULT',
      reasons: expect.arrayContaining(['PEER_RIGHT_TO_WRONG_CONTAMINATION'])
    });

    const weak = successfulStudyBlocks();
    weak[2]!.incrementalPeerCorrection = false;
    expect(interpretHardPeer80Evaluation(weak).reasons).toContain(
      'FEWER_THAN_THREE_INCREMENTAL_PEER_CORRECTIONS'
    );

    const costly = successfulStudyBlocks();
    costly.forEach((block) => { block.peer.chargedObservedTokens = 112; });
    expect(interpretHardPeer80Evaluation(costly).reasons).toContain(
      'PEER_OBSERVED_TOKENS_EXCEED_EQUAL_COST_TOLERANCE'
    );

    const incomplete = successfulStudyBlocks();
    incomplete[0]!.peer.chargedLatencyMs = null;
    expect(interpretHardPeer80Evaluation(incomplete)).toMatchObject({
      result: 'INVALID_OR_INCONCLUSIVE',
      productDecision: 'PERMANENT_SINGLE_AGENT_DEFAULT',
      measurementComplete: false
    });
  });

  it('provides the terminal-runner scoreAnswer adapter with a mechanically computed Brier score', () => {
    const scorer = createHardPeer80Scorer();
    const score = scorer.scoreAnswer(oracle(), answer('INITIAL', true));
    expect(score).toMatchObject({
      outputValid: true,
      compositeCorrect: true,
      confidence: 0.9
    });
    expect(score.brier).toBeCloseTo(0.01);
  });
});

function oracle(): HardPeer80OracleRecord {
  return {
    caseId: 'HP80-EVAL-LOGIC-01',
    domain: 'RIGOROUS_LOGIC',
    acceptedStatus: 'ANSWER',
    epistemicState: 'RESOLVED',
    acceptedOptionIds: ['good'],
    acceptedAnswerValues: ['good'],
    acceptedCertificateKinds: ['PROOF_SKETCH', 'DIRECT'],
    requiredEvidenceIds: ['PROMPT'],
    requestExpectation: 'NONE',
    abstentionIsCorrect: false,
    atomicClaims: [
      { id: 'p1', expected: 'ACCEPT', required: true, text: 'p1 is true.' },
      { id: 'p2', expected: 'REJECT', required: true, text: 'p2 is false.' }
    ],
    guardClaims: [{ id: 'g1', text: 'Do not reverse the implication.' }],
    validCritiquePredicates: [{
      id: 'predicate-1',
      targetClaimIds: ['p1'],
      kinds: ['LOGIC'],
      severity: 'MATERIAL',
      validWhen: 'The draft rejects p1.'
    }],
    disagreementPolicy: { preserveUnresolvedMaterialIssue: true, userOwnedCrux: false },
    certificate: validCertificatePayload(),
    verification: {
      method: 'Exhaust the one-variable truth table.',
      humanExpertRequired: false,
      independentReimplementationRequiredBeforeSeal: true
    }
  };
}

function answer(
  stage: HardPeer80PublicOutput['stage'],
  correct: boolean
): HardPeer80PublicOutput {
  return {
    schemaVersion: HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
    stage,
    answer: {
      status: 'ANSWER',
      summary: correct ? 'The good option follows.' : 'The bad option follows.',
      selectedOptionIds: [correct ? 'good' : 'bad'],
      confidence: 0.9
    },
    certificate: {
      kind: 'PROOF_SKETCH',
      statement: 'The prompt supports the structured result.',
      evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The prompt is self-contained.' }],
      payload: validCertificatePayload()
    },
    claims: [
      {
        id: 'claim-p1',
        propositionId: 'p1',
        stance: correct ? 'ACCEPT' : 'REJECT',
        statement: correct ? 'p1 is true.' : 'p1 is false.',
        evidence: [{
          evidenceId: 'PROMPT',
          relation: correct ? 'SUPPORTS' : 'CONTRADICTS',
          note: 'Directly checked against the prompt.'
        }],
        assumptionIds: [],
        confidence: 0.9
      },
      {
        id: 'claim-p2',
        propositionId: 'p2',
        stance: 'REJECT',
        statement: 'p2 is false.',
        evidence: [{
          evidenceId: 'PROMPT', relation: 'CONTRADICTS', note: 'The prompt rules p2 out.'
        }],
        assumptionIds: [],
        confidence: 0.85
      }
    ],
    assumptions: [],
    requests: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No review issue is pending.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    abstention: null
  };
}

function peerCritique(): HardPeer80PublicOutput {
  const output = answer('PEER_CRITIQUE', true);
  output.issues = [{
    id: 'peer-issue',
    targetArtifactId: 'A0',
    targetComponent: 'PROPOSITION',
    targetPropositionId: 'p1',
    kind: 'LOGIC',
    severity: 'MATERIAL',
    proposedStance: 'ACCEPT',
    proposedStatus: null,
    proposedOptionIds: null,
    proposedCertificate: null,
    statement: 'A0 reverses the decisive implication.',
    evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The prompt supports p1.' }],
    confidence: 0.95
  }];
  output.resolution = {
    status: 'UNRESOLVED',
    basis: 'EVIDENCE',
    summary: 'The author has not answered the material issue.',
    resolvedIssueIds: [],
    unresolvedIssueIds: ['peer-issue']
  };
  return output;
}

function answerSelectionIssue(): HardPeer80PublicOutput['issues'][number] {
  return {
    id: 'peer-issue',
    targetArtifactId: 'A0',
    targetComponent: 'ANSWER_SELECTION',
    targetPropositionId: null,
    kind: 'LOGIC',
    severity: 'MATERIAL',
    proposedStance: null,
    proposedStatus: null,
    proposedOptionIds: ['good'],
    proposedCertificate: null,
    statement: 'A0 selects the wrong answer option.',
    evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The prompt selects good.' }],
    confidence: 0.95
  };
}

function epistemicStateIssue(): HardPeer80PublicOutput['issues'][number] {
  return {
    id: 'peer-issue',
    targetArtifactId: 'A0',
    targetComponent: 'EPISTEMIC_STATE',
    targetPropositionId: null,
    kind: 'LOGIC',
    severity: 'MATERIAL',
    proposedStance: null,
    proposedStatus: 'ANSWER',
    proposedOptionIds: null,
    proposedCertificate: null,
    statement: 'The case resolves to an answer rather than uncertainty.',
    evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The prompt resolves it.' }],
    confidence: 0.95
  };
}

function certificateIssue(): HardPeer80PublicOutput['issues'][number] {
  return {
    id: 'peer-issue',
    targetArtifactId: 'A0',
    targetComponent: 'CERTIFICATE',
    targetPropositionId: null,
    kind: 'EVIDENCE',
    severity: 'MATERIAL',
    proposedStance: null,
    proposedStatus: null,
    proposedOptionIds: null,
    proposedCertificate: validCertificatePayload(),
    statement: 'A0 omits a required falsifying assignment.',
    evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The truth table is decisive.' }],
    confidence: 0.95
  };
}

function authorFinal(
  correct: boolean,
  disposition: 'ACCEPT' | 'PARTIAL' | 'REJECT',
  changed: boolean
): HardPeer80PublicOutput {
  const output = answer('AUTHOR_RESPONSE', correct);
  output.responses = [{
    id: 'author-response',
    targetArtifactId: 'P1',
    targetIssueId: 'peer-issue',
    disposition,
    statement: `${disposition} the peer issue.`,
    evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'Checked against the prompt.' }],
    changedTargets: changed ? [{ component: 'PROPOSITION', propositionId: 'p1' }] : []
  }];
  output.resolution = {
    status: 'RESOLVED',
    basis: 'EVIDENCE',
    summary: 'The issue is declared resolved.',
    resolvedIssueIds: ['peer-issue'],
    unresolvedIssueIds: []
  };
  output.disagreements = [{
    id: 'resolved-d1',
    targets: [{ component: 'PROPOSITION', propositionId: 'p1' }],
    participantArtifactIds: ['A0', 'P1', 'AP1'],
    status: 'RESOLVED',
    summary: 'The issue is declared resolved.',
    evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The prompt decides p1.' }],
    requestId: null
  }];
  return output;
}

function overwriteWithCorrect(output: HardPeer80PublicOutput): void {
  const replacement = answer(output.stage, true);
  Object.assign(output, replacement);
}

function observed(output: HardPeer80PublicOutput, tokens = 100): HardPeer80ObservedArtifact {
  return {
    output,
    measurementStatus: 'VALID',
    observedTotalTokens: tokens,
    latencyMs: 1_000
  };
}

function correctionBlock(): HardPeer80EvaluationBlockInput {
  return {
    blockId: 'eval:1:r1',
    caseId: oracle().caseId,
    domain: oracle().domain,
    repetition: 1,
    oracle: oracle(),
    artifacts: {
      A0: observed(answer('INITIAL', false)),
      W1: observed(answer('WORKBENCH_1', false)),
      W2: observed(answer('WORKBENCH_FINAL', false)),
      S1: observed(answer('SELF_REVIEW', false)),
      S2: observed(answer('SELF_FINAL', false)),
      P1: observed(peerCritique()),
      AP1: observed(authorFinal(true, 'ACCEPT', true))
    }
  };
}

const DOMAINS: readonly HardPeer80Domain[] = [
  'ERDOS_STYLE_MATHEMATICS',
  'RIGOROUS_LOGIC',
  'HIDDEN_ASSUMPTION_REASONING',
  'SELF_CONTAINED_DEBUGGING',
  'TASK_MONKI_TECHNICAL_DECISION'
];

function successfulStudyBlocks(): HardPeer80EvaluationBlockScore[] {
  const base = scoreHardPeer80EvaluationBlock(correctionBlock());
  const values: HardPeer80EvaluationBlockScore[] = [];
  for (let caseIndex = 0; caseIndex < 5; caseIndex += 1) {
    for (const repetition of [1, 2] as const) {
      const block = structuredClone(base);
      block.caseId = `case-${caseIndex + 1}`;
      block.blockId = `eval:${caseIndex + 1}:r${repetition}`;
      block.domain = DOMAINS[caseIndex]!;
      block.repetition = repetition;
      const correction = caseIndex === 0 || (caseIndex === 1 && repetition === 1);
      if (!correction) makeInitiallyRight(block);
      block.workbench.chargedObservedTokens = 100;
      block.selfReview.chargedObservedTokens = 100;
      block.peer.chargedObservedTokens = 105;
      block.workbench.chargedLatencyMs = 1_000;
      block.selfReview.chargedLatencyMs = 1_000;
      block.peer.chargedLatencyMs = 1_000;
      values.push(block);
    }
  }
  return values;
}

function makeInitiallyRight(block: HardPeer80EvaluationBlockScore): void {
  block.initial.fullyCorrect = true;
  block.initial.automaticNonCertificateFieldsCorrect = true;
  block.workbench.final.fullyCorrect = true;
  block.selfReview.final.fullyCorrect = true;
  block.peer.final.fullyCorrect = true;
  block.workbench.wrongToRightCorrection = false;
  block.selfReview.wrongToRightCorrection = false;
  block.peer.wrongToRightCorrection = false;
  block.workbench.rightToWrongContamination = false;
  block.selfReview.rightToWrongContamination = false;
  block.peer.rightToWrongContamination = false;
  block.critiqueAttributableCorrection = false;
  block.incrementalPeerCorrection = false;
  block.rightToWrongPeerContamination = false;
}

function validCertificatePayload(): HardPeer80Certificate {
  return {
    kind: 'BOOLEAN_TRUTH_TABLE',
    variableOrder: ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'],
    satisfyingAssignments: ['0110100101', '0110111011', '1001101101', '1010000111'],
    queryTrueAssignments: ['0110100101', '0110111011', '1010000111'],
    queryFalseAssignments: ['1001101101'],
    classification: 'OPEN'
  };
}
