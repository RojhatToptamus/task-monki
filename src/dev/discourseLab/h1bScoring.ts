import type { LabProtocolRunResult } from './runner';
import { acceptedLabOutput } from './outputValidation';
import type { LabPublicOutput, LabRatioMetric } from './contracts';
import type {
  H1bConditionId,
  H1bOracleCase,
  H1bOracleProfile,
  H1bParticipantCaseRecord
} from './h1bCorpus';

export const H1B_SCORING_VERSION = 'h1b-contextual-metrics@v1' as const;

export interface H1bAssignmentScore {
  assignmentId: string;
  blockId: string;
  caseId: string;
  stratum: H1bOracleCase['stratum'];
  conditionId: H1bConditionId;
  repetition: 1 | 2 | 3;
  validSemanticObservation: boolean;
  profile: H1bOracleProfile['profile'];
  statusAccepted: boolean | null;
  answerCorrect: boolean | null;
  propositionCorrectness: LabRatioMetric;
  evidentialSupport: LabRatioMetric;
  userQuestionSetCorrect: boolean | null;
  contextualTerminalCorrect: boolean | null;
  targetCorrect: boolean | null;
  guardCorrect: boolean | null;
  targetCorrection: boolean | null;
  guardContamination: boolean | null;
  unsupportedClosure: boolean | null;
  validCritiqueUptake: boolean | null;
  exactEvidenceAttribution: boolean | null;
  critiqueCitedAsEvidence: boolean | null;
  materialIssueSignature: {
    emitted: number;
    matched: number;
    potentiallyInvented: number;
    expectedSignatures: number;
    recalledSignatures: number;
  };
  abstained: boolean | null;
  uncertaintyExpressed: boolean | null;
  driftedInitialClaims: string[];
  changedInitialClaims: string[];
  providerFailureKinds: string[];
  validationErrorCount: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  targetOutputOvershootTokens: number | null;
  safetyOutputOvershootTokens: number | null;
  stopReason?: string;
}

export type H1bSemanticScore = Pick<
  H1bAssignmentScore,
  | 'validSemanticObservation'
  | 'statusAccepted'
  | 'answerCorrect'
  | 'propositionCorrectness'
  | 'evidentialSupport'
  | 'userQuestionSetCorrect'
  | 'contextualTerminalCorrect'
  | 'targetCorrect'
  | 'guardCorrect'
  | 'targetCorrection'
  | 'guardContamination'
  | 'unsupportedClosure'
  | 'validCritiqueUptake'
  | 'exactEvidenceAttribution'
  | 'critiqueCitedAsEvidence'
  | 'materialIssueSignature'
  | 'abstained'
  | 'uncertaintyExpressed'
  | 'driftedInitialClaims'
  | 'changedInitialClaims'
>;

export interface H1bInterpretation {
  overall:
    | 'H1B_MECHANISM_SIGNAL'
    | 'PARTIAL_MECHANISM_SIGNAL'
    | 'NO_MECHANISM_SIGNAL'
    | 'ASSAY_NOT_INFORMATIVE'
    | 'INCONCLUSIVE'
    | 'SAFETY_BLOCK';
  derivable: {
    status:
      | 'DERIVABLE_SIGNAL_SUPPORTED'
      | 'DERIVABLE_MECHANISM_REJECTED'
      | 'ASSAY_NOT_INFORMATIVE'
      | 'INCONCLUSIVE';
    informativeCaseIds: string[];
    ceilingCaseIds: string[];
    strongSingleTargetCorrect: LabRatioMetric;
    reassessmentTargetCorrect: LabRatioMetric;
    critiqueTargetCorrect: LabRatioMetric;
    critiqueUptake: LabRatioMetric;
    guardContaminations: number;
    potentiallyInventedMaterialIssues: number;
    strongSingleCeiling: boolean;
  };
  evidence: {
    status:
      | 'INFORMATION_SIGNAL_SUPPORTED'
      | 'INFORMATION_MECHANISM_REJECTED'
      | 'ASSAY_NOT_INFORMATIVE'
      | 'INCONCLUSIVE';
    strongBaseAppropriate: LabRatioMetric;
    reassessmentBaseAppropriate: LabRatioMetric;
    evidenceResolvedAndAttributed: LabRatioMetric;
    unsupportedClosures: number;
    guardContaminations: number;
  };
  safetyReasons: string[];
  limitations: string[];
  nextDecision: string;
  minorityPreservation: {
    baselineAbsolute: null;
    treatmentAbsolute: null;
    incrementalDelta: null;
    reason: 'NO_MINORITY_CONDITION_IN_H1B';
  };
}

export function scoreH1bAssignment(input: {
  assignmentId: string;
  blockId: string;
  repetition: 1 | 2 | 3;
  conditionId: H1bConditionId;
  record: H1bParticipantCaseRecord;
  oracle: H1bOracleCase;
  run: LabProtocolRunResult;
}): H1bAssignmentScore {
  const profile = profileFor(input.oracle, input.conditionId);
  const terminalArtifact = input.run.terminalArtifactIds
    .map((artifactId) => input.run.artifacts.find((artifact) => artifact.artifactId === artifactId))
    .find(Boolean);
  const output = terminalArtifact ? acceptedLabOutput(terminalArtifact) : undefined;
  const attempts = input.run.artifacts.flatMap((artifact) => artifact.output.attempts);
  const calls = input.run.calls;
  const providerFailureKinds = input.run.callAccounting.flatMap((call) =>
    call.failure ? [call.failure.kind] : []
  );
  const base: Omit<H1bAssignmentScore, keyof H1bSemanticScore> = {
    assignmentId: input.assignmentId,
    blockId: input.blockId,
    caseId: input.record.caseId,
    stratum: input.oracle.stratum,
    conditionId: input.conditionId,
    repetition: input.repetition,
    profile: profile.profile,
    providerFailureKinds,
    validationErrorCount: attempts.reduce(
      (sum, attempt) => sum + attempt.validationErrors.length,
      0
    ),
    inputTokens: sumKnown(calls.map((call) => call.usage?.last.inputTokens)),
    cachedInputTokens: sumKnown(calls.map((call) => call.usage?.last.cachedInputTokens)),
    outputTokens: sumKnown(calls.map((call) => call.usage?.last.outputTokens)),
    reasoningTokens: sumKnown(calls.map((call) => call.usage?.last.reasoningOutputTokens)),
    totalTokens: sumKnown(calls.map((call) => call.usage?.last.totalTokens)),
    latencyMs: sumKnown(calls.map((call) =>
      Date.parse(call.completedAt) - Date.parse(call.submittedAt)
    )),
    targetOutputOvershootTokens: sumKnown(calls.map((call) =>
      call.tokenControl?.targetOvershootTokens ?? undefined
    )),
    safetyOutputOvershootTokens: sumKnown(calls.map((call) =>
      call.tokenControl?.safetyOvershootTokens ?? undefined
    )),
    ...(input.run.stopReason ? { stopReason: input.run.stopReason } : {})
  };
  return {
    ...base,
    ...semanticScore(output, input.record, input.oracle, profile, input.conditionId)
  };
}

export function scoreH1bPublicOutput(input: {
  output: LabPublicOutput | undefined;
  record: H1bParticipantCaseRecord;
  oracle: H1bOracleCase;
  conditionId: H1bConditionId;
}): H1bSemanticScore {
  return semanticScore(
    input.output,
    input.record,
    input.oracle,
    profileFor(input.oracle, input.conditionId),
    input.conditionId
  );
}

function semanticScore(
  output: LabPublicOutput | undefined,
  record: H1bParticipantCaseRecord,
  oracle: H1bOracleCase,
  profile: H1bOracleProfile,
  conditionId: H1bConditionId
): H1bSemanticScore {
  if (!output) return missingSemanticScore(oracle);
  const claimsByProposition = new Map<string, LabPublicOutput['claims'][number][]>();
  output.claims.forEach((claim) => {
    const selected = claimsByProposition.get(claim.propositionId) ?? [];
    selected.push(claim);
    claimsByProposition.set(claim.propositionId, selected);
  });
  const expectationById = new Map(
    profile.propositions.map((expectation) => [expectation.propositionId, expectation])
  );
  const correct = (propositionId: string) => {
    const claims = claimsByProposition.get(propositionId) ?? [];
    const expectation = expectationById.get(propositionId);
    return claims.length === 1 && Boolean(
      expectation?.acceptableStances.includes(claims[0]!.stance)
    );
  };
  const propositionCorrectCount = profile.propositions.filter((item) => correct(item.propositionId)).length;
  const evidenceExpectations = profile.propositions.filter(
    (item) => item.requiredEvidenceSets.length > 0
  );
  const evidenceSupported = (propositionId: string) => {
    const claim = claimsByProposition.get(propositionId)?.[0];
    const expectation = expectationById.get(propositionId);
    if (!claim || !expectation || !correct(propositionId)) return false;
    const cited = new Set(claim.evidence.map((reference) => reference.evidenceId));
    return expectation.requiredEvidenceSets.some((set) => set.every((id) => cited.has(id)));
  };
  const supportedCount = evidenceExpectations.filter((item) =>
    evidenceSupported(item.propositionId)
  ).length;
  const statusAccepted = profile.acceptableStatuses.includes(output.status);
  const answerCorrect =
    output.answer.selectedOptionIds.length === 1 &&
    profile.acceptedAnswerOptionSets.some((accepted) => sameSet(
      accepted,
      output.answer.selectedOptionIds
    ));
  const emittedCruxIds = output.userQuestions.map((question) => question.cruxId);
  const userQuestionSetCorrect = sameSet(
    profile.requiredUserQuestionCruxIds,
    emittedCruxIds
  );
  const targetCorrect = oracle.targetPropositionIds.every(correct);
  const guardCorrect = oracle.guardPropositionIds.every(correct);
  const initialStance = new Map(
    record.fixedInitial.assessments.map((assessment) => [assessment.claimId, assessment.stance])
  );
  const changedInitialClaims = conditionId === 'CONTROL_CASE_ONLY_B1'
    ? []
    : profile.propositions.flatMap((expectation) => {
        const claim = claimsByProposition.get(expectation.propositionId)?.[0];
        return claim && claim.stance !== initialStance.get(expectation.propositionId)
          ? [expectation.propositionId]
          : [];
      });
  const driftedInitialClaims = changedInitialClaims.filter((propositionId) =>
    !correct(propositionId)
  );
  const guardContamination = conditionId === 'CONTROL_CASE_ONLY_B1'
    ? false
    : oracle.guardPropositionIds.some((id) => !correct(id));
  const critiqueSignal = record.stratum === 'DERIVABLE_CRITIQUE'
    ? record.signal.artifacts[0]
    : undefined;
  const evidenceSignal = record.stratum === 'NEW_EVIDENCE'
    ? record.signal.artifacts[0]
    : undefined;
  const changedTargetClaimIds = oracle.targetPropositionIds.flatMap((propositionId) => {
    const claim = claimsByProposition.get(propositionId)?.[0];
    return claim && claim.stance !== initialStance.get(propositionId) ? [claim.id] : [];
  });
  const directResponse = critiqueSignal?.issueId
    ? output.responses.find((response) =>
        response.targetArtifactId === critiqueSignal.artifactId &&
        response.targetIssueId === critiqueSignal.issueId
      )
    : undefined;
  const validCritiqueUptake = conditionId === 'CONTROL_VALID_CRITIQUE_B1'
    ? Boolean(
        directResponse &&
        (directResponse.disposition === 'ACCEPT' || directResponse.disposition === 'PARTIAL') &&
        targetCorrect &&
        changedTargetClaimIds.every((claimId) => directResponse.changedClaimIds.includes(claimId))
      )
    : null;
  const exactEvidenceAttribution = conditionId === 'CONTROL_EVIDENCE_B1'
    ? Boolean(
        evidenceSignal?.evidenceId &&
        oracle.targetPropositionIds.every((propositionId) => {
          const claim = claimsByProposition.get(propositionId)?.[0];
          return claim?.evidence.some((reference) =>
            reference.evidenceId === evidenceSignal.evidenceId
          );
        })
      )
    : null;
  const critiqueEvidenceIds = new Set(
    critiqueSignal
      ? [critiqueSignal.artifactId, critiqueSignal.issueId].filter(
          (value): value is string => Boolean(value)
        )
      : []
  );
  const critiqueCitedAsEvidence = conditionId === 'CONTROL_VALID_CRITIQUE_B1'
    ? output.claims.some((claim) => claim.evidence.some((reference) =>
        critiqueEvidenceIds.has(reference.evidenceId)
      ))
    : null;
  const unsupportedClosure = oracle.stratum === 'NEW_EVIDENCE' && profile.profile === 'BASE'
    ? output.status === 'ANSWER' || !answerCorrect || !targetCorrect
    : null;
  const issueDiagnostic = materialIssueSignature(output, oracle);
  const needsEvidenceAttribution =
    oracle.stratum === 'NEW_EVIDENCE' && profile.profile === 'TREATMENT';
  const contextualTerminalCorrect =
    statusAccepted &&
    answerCorrect &&
    propositionCorrectCount === profile.propositions.length &&
    userQuestionSetCorrect &&
    (!needsEvidenceAttribution || exactEvidenceAttribution === true);
  return {
    validSemanticObservation: true,
    statusAccepted,
    answerCorrect,
    propositionCorrectness: ratio(propositionCorrectCount, profile.propositions.length),
    evidentialSupport: ratio(supportedCount, evidenceExpectations.length),
    userQuestionSetCorrect,
    contextualTerminalCorrect,
    targetCorrect,
    guardCorrect,
    targetCorrection: conditionId === 'CONTROL_CASE_ONLY_B1' ? null : targetCorrect,
    guardContamination,
    unsupportedClosure,
    validCritiqueUptake,
    exactEvidenceAttribution,
    critiqueCitedAsEvidence,
    materialIssueSignature: issueDiagnostic,
    abstained: output.status === 'ABSTAIN',
    uncertaintyExpressed: ['UNCERTAIN', 'NEEDS_USER_INPUT', 'MULTIPLE_DEFENSIBLE'].includes(
      output.status
    ),
    driftedInitialClaims,
    changedInitialClaims
  };
}

function missingSemanticScore(oracle: H1bOracleCase): H1bSemanticScore {
  return {
    validSemanticObservation: false,
    statusAccepted: null,
    answerCorrect: null,
    propositionCorrectness: ratio(0, 0),
    evidentialSupport: ratio(0, 0),
    userQuestionSetCorrect: null,
    contextualTerminalCorrect: null,
    targetCorrect: null,
    guardCorrect: null,
    targetCorrection: null,
    guardContamination: null,
    unsupportedClosure: null,
    validCritiqueUptake: null,
    exactEvidenceAttribution: null,
    critiqueCitedAsEvidence: null,
    materialIssueSignature: {
      emitted: 0,
      matched: 0,
      potentiallyInvented: 0,
      expectedSignatures: oracle.acceptedIssueKindEquivalences.length,
      recalledSignatures: 0
    },
    abstained: null,
    uncertaintyExpressed: null,
    driftedInitialClaims: [],
    changedInitialClaims: []
  };
}

function materialIssueSignature(
  output: LabPublicOutput,
  oracle: H1bOracleCase
): H1bAssignmentScore['materialIssueSignature'] {
  const material = output.issues.filter((issue) => issue.severity === 'MATERIAL');
  const matches = (issue: LabPublicOutput['issues'][number]) =>
    oracle.acceptedIssueKindEquivalences.some((accepted) =>
      accepted.targetPropositionId === issue.targetPropositionId &&
      accepted.acceptedKinds.includes(issue.kind) &&
      accepted.acceptedSeverities.includes(issue.severity)
    );
  const recalledSignatures = oracle.acceptedIssueKindEquivalences.filter((accepted) =>
    material.some((issue) =>
      accepted.targetPropositionId === issue.targetPropositionId &&
      accepted.acceptedKinds.includes(issue.kind) &&
      accepted.acceptedSeverities.includes(issue.severity)
    )
  ).length;
  return {
    emitted: material.length,
    matched: material.filter(matches).length,
    potentiallyInvented: material.filter((issue) => !matches(issue)).length,
    expectedSignatures: oracle.acceptedIssueKindEquivalences.length,
    recalledSignatures
  };
}

function profileFor(oracle: H1bOracleCase, conditionId: H1bConditionId): H1bOracleProfile {
  if (oracle.baseProfile.conditionIds.includes(conditionId)) return oracle.baseProfile;
  if (oracle.treatmentProfile.conditionIds.includes(conditionId)) return oracle.treatmentProfile;
  throw new Error(`Condition ${conditionId} has no sealed H1b profile for ${oracle.caseId}.`);
}

export function interpretH1b(
  scores: readonly H1bAssignmentScore[],
  plannedAssignments = 54
): H1bInterpretation {
  const derivableScores = scores.filter((score) => score.stratum === 'DERIVABLE_CRITIQUE');
  const evidenceScores = scores.filter((score) => score.stratum === 'NEW_EVIDENCE');
  const plannedPerStratum = plannedAssignments / 2;
  const derivableMissing = derivableScores.length !== plannedPerStratum ||
    derivableScores.some((score) => !score.validSemanticObservation);
  const evidenceMissing = evidenceScores.length !== plannedPerStratum ||
    evidenceScores.some((score) => !score.validSemanticObservation);
  const derivableCaseIds = unique(derivableScores.map((score) => score.caseId));
  const informativeCaseIds = derivableCaseIds.filter((caseId) => {
    const reassess = byCaseCondition(
      derivableScores,
      caseId,
      'CONTROL_NO_FEEDBACK_B1'
    );
    return reassess.filter((score) => score.targetCorrect === false).length >= 2;
  });
  const ceilingCaseIds = derivableCaseIds.filter((caseId) => !informativeCaseIds.includes(caseId));
  const critiqueScores = derivableScores.filter(
    (score) => score.conditionId === 'CONTROL_VALID_CRITIQUE_B1'
  );
  const reassessScores = derivableScores.filter(
    (score) => score.conditionId === 'CONTROL_NO_FEEDBACK_B1'
  );
  const strongDerivable = derivableScores.filter(
    (score) => score.conditionId === 'CONTROL_CASE_ONLY_B1'
  );
  const informativeSupport = informativeCaseIds.every((caseId) => {
    const critique = byCaseCondition(
      derivableScores,
      caseId,
      'CONTROL_VALID_CRITIQUE_B1'
    );
    const reassess = byCaseCondition(
      derivableScores,
      caseId,
      'CONTROL_NO_FEEDBACK_B1'
    );
    return critique.filter((score) => score.targetCorrect === true).length >= 2 &&
      reassess.filter((score) => score.targetCorrect === true).length <= 1;
  });
  const treatmentContamination = critiqueScores.filter(
    (score) => score.guardContamination === true
  ).length;
  const potentialInvented = critiqueScores.reduce(
    (sum, score) => sum + score.materialIssueSignature.potentiallyInvented,
    0
  );
  const critiqueUptakeFailures = critiqueScores.filter(
    (score) => score.targetCorrect === true && score.validCritiqueUptake !== true
  ).length;
  let derivableStatus: H1bInterpretation['derivable']['status'];
  if (derivableMissing) {
    derivableStatus = 'INCONCLUSIVE';
  } else if (informativeCaseIds.length < 2) {
    derivableStatus = 'ASSAY_NOT_INFORMATIVE';
  } else if (
    informativeSupport &&
    treatmentContamination === 0 &&
    potentialInvented === 0 &&
    critiqueUptakeFailures === 0
  ) {
    derivableStatus = 'DERIVABLE_SIGNAL_SUPPORTED';
  } else {
    const noBetterCases = informativeCaseIds.filter((caseId) => {
      const critique = byCaseCondition(
        derivableScores,
        caseId,
        'CONTROL_VALID_CRITIQUE_B1'
      ).filter((score) => score.targetCorrect === true).length;
      const reassess = byCaseCondition(
        derivableScores,
        caseId,
        'CONTROL_NO_FEEDBACK_B1'
      ).filter((score) => score.targetCorrect === true).length;
      return critique <= reassess;
    });
    derivableStatus = noBetterCases.length >= 2
      ? 'DERIVABLE_MECHANISM_REJECTED'
      : 'INCONCLUSIVE';
  }

  const strongEvidenceBase = evidenceScores.filter(
    (score) => score.conditionId === 'CONTROL_CASE_ONLY_B1'
  );
  const reassessEvidenceBase = evidenceScores.filter(
    (score) => score.conditionId === 'CONTROL_NO_FEEDBACK_B1'
  );
  const evidenceTreatment = evidenceScores.filter(
    (score) => score.conditionId === 'CONTROL_EVIDENCE_B1'
  );
  const evidenceSuccess = (score: H1bAssignmentScore) =>
    score.contextualTerminalCorrect === true && score.exactEvidenceAttribution === true;
  const evidenceCaseIds = unique(evidenceTreatment.map((score) => score.caseId));
  const everyEvidenceCasePasses = evidenceCaseIds.every((caseId) =>
    byCaseCondition(evidenceScores, caseId, 'CONTROL_EVIDENCE_B1').filter(evidenceSuccess).length >= 2
  );
  const evidenceSuccessCount = evidenceTreatment.filter(evidenceSuccess).length;
  const strongBaseCount = strongEvidenceBase.filter(
    (score) => score.contextualTerminalCorrect === true
  ).length;
  const reassessBaseCount = reassessEvidenceBase.filter(
    (score) => score.contextualTerminalCorrect === true
  ).length;
  const evidenceContamination = evidenceTreatment.filter(
    (score) => score.guardContamination === true
  ).length;
  const unsupportedClosures = [...strongEvidenceBase, ...reassessEvidenceBase].filter(
    (score) => score.unsupportedClosure === true
  ).length;
  let evidenceStatus: H1bInterpretation['evidence']['status'];
  if (evidenceMissing) {
    evidenceStatus = 'INCONCLUSIVE';
  } else if (evidenceCaseIds.length !== 3) {
    evidenceStatus = 'ASSAY_NOT_INFORMATIVE';
  } else if (
    everyEvidenceCasePasses &&
    evidenceSuccessCount >= 8 &&
    strongBaseCount >= 8 &&
    reassessBaseCount >= 8 &&
    evidenceContamination === 0
  ) {
    evidenceStatus = 'INFORMATION_SIGNAL_SUPPORTED';
  } else {
    const failedCases = evidenceCaseIds.filter((caseId) =>
      byCaseCondition(evidenceScores, caseId, 'CONTROL_EVIDENCE_B1').filter(evidenceSuccess).length < 2
    );
    evidenceStatus = failedCases.length >= 2
      ? 'INFORMATION_MECHANISM_REJECTED'
      : 'INCONCLUSIVE';
  }
  const safetyReasons = [
    treatmentContamination + evidenceContamination > 0 ? 'TREATMENT_GUARD_CONTAMINATION' : null,
    critiqueScores.some((score) => score.critiqueCitedAsEvidence === true)
      ? 'CRITIQUE_MISUSED_AS_FACTUAL_EVIDENCE'
      : null
  ].filter((value): value is string => Boolean(value));
  const supportedCount = Number(derivableStatus === 'DERIVABLE_SIGNAL_SUPPORTED') +
    Number(evidenceStatus === 'INFORMATION_SIGNAL_SUPPORTED');
  let overall: H1bInterpretation['overall'];
  if (safetyReasons.length > 0) overall = 'SAFETY_BLOCK';
  else if (supportedCount === 2) overall = 'H1B_MECHANISM_SIGNAL';
  else if (supportedCount === 1) overall = 'PARTIAL_MECHANISM_SIGNAL';
  else if (derivableStatus === 'ASSAY_NOT_INFORMATIVE' || evidenceStatus === 'ASSAY_NOT_INFORMATIVE') {
    overall = 'ASSAY_NOT_INFORMATIVE';
  }
  else if (
    derivableStatus === 'DERIVABLE_MECHANISM_REJECTED' &&
    evidenceStatus === 'INFORMATION_MECHANISM_REJECTED'
  ) overall = 'NO_MECHANISM_SIGNAL';
  else overall = 'INCONCLUSIVE';
  const strongSingleCeiling = ratioOf(strongDerivable, (score) => score.targetCorrect === true).rate === 1;
  return {
    overall,
    derivable: {
      status: derivableStatus,
      informativeCaseIds,
      ceilingCaseIds,
      strongSingleTargetCorrect: ratioOf(strongDerivable, (score) => score.targetCorrect === true),
      reassessmentTargetCorrect: ratioOf(reassessScores, (score) => score.targetCorrect === true),
      critiqueTargetCorrect: ratioOf(critiqueScores, (score) => score.targetCorrect === true),
      critiqueUptake: ratioOf(critiqueScores, (score) => score.validCritiqueUptake === true),
      guardContaminations: treatmentContamination,
      potentiallyInventedMaterialIssues: potentialInvented,
      strongSingleCeiling
    },
    evidence: {
      status: evidenceStatus,
      strongBaseAppropriate: ratioOf(
        strongEvidenceBase,
        (score) => score.contextualTerminalCorrect === true
      ),
      reassessmentBaseAppropriate: ratioOf(
        reassessEvidenceBase,
        (score) => score.contextualTerminalCorrect === true
      ),
      evidenceResolvedAndAttributed: ratioOf(evidenceTreatment, evidenceSuccess),
      unsupportedClosures,
      guardContaminations: evidenceContamination
    },
    safetyReasons,
    limitations: [
      'The fixed initial artifacts and treatment signals are hand-authored instruments, so their generation cost is not part of this mechanism estimate.',
      'Fixed-prefix active reassessment is not a same-thread model reviewing its own live draft.',
      'Case is the generalization unit; three fresh sessions per cell expose limited provider stochasticity without seed control.',
      'Potentially invented criticism is an exact sealed signature diagnostic, not a semantic LLM-judge verdict.',
      'H1b contains no minority condition; absolute and incremental minority preservation are intentionally not estimable.'
    ],
    nextDecision: strongSingleCeiling
      ? 'Even a clean feedback-uptake signal would not show a product advantage over case-only Sol on these derivable cases; pause topology escalation unless a draft-preservation use case is independently valuable.'
      : supportedCount > 0
        ? 'A supported mechanism may justify a separately funded topology study that tests whether agents can generate the useful critique or evidence; confirmation remains sealed.'
        : 'Do not escalate to topology or mixed-model experiments; inspect assay validity and favor the strong single or reassessment baseline.',
    minorityPreservation: {
      baselineAbsolute: null,
      treatmentAbsolute: null,
      incrementalDelta: null,
      reason: 'NO_MINORITY_CONDITION_IN_H1B'
    }
  };
}

function byCaseCondition(
  scores: readonly H1bAssignmentScore[],
  caseId: string,
  conditionId: H1bConditionId
): H1bAssignmentScore[] {
  return scores.filter((score) => score.caseId === caseId && score.conditionId === conditionId);
}

function ratioOf(
  scores: readonly H1bAssignmentScore[],
  predicate: (score: H1bAssignmentScore) => boolean
): LabRatioMetric {
  const observed = scores.filter((score) => score.validSemanticObservation);
  return ratio(observed.filter(predicate).length, observed.length);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function ratio(count: number, opportunities: number): LabRatioMetric {
  return { count, opportunities, rate: opportunities === 0 ? null : count / opportunities };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sumKnown(values: Array<number | undefined>): number | null {
  if (values.length === 0 || values.some((value) => value === undefined)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}
