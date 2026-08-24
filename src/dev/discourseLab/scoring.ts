import type {
  LabArtifactRecord,
  LabClaimStance,
  LabOutputScore,
  LabPropositionExpectation,
  LabPublicIssue,
  LabPublicOutput,
  LabRatioMetric,
  LabTrajectoryForScoring,
  LabTrajectoryScore
} from './contracts';
import { acceptedLabOutput, validateLabCasePair } from './outputValidation';

export const LAB_SCORING_VERSION = 'text-lab-metrics-v4' as const;

export function scoreLabArtifact(
  artifact: LabArtifactRecord,
  input: Pick<LabTrajectoryForScoring, 'participantCase' | 'oracleCase'>
): LabOutputScore {
  assertScorableCasePair(input);
  const output = acceptedLabOutput(artifact);
  const failureCount = artifact.output.attempts.filter(
    (attempt) => Boolean(attempt.executionFailure) || !attempt.output
  ).length;
  const invalidAttemptCount = artifact.output.attempts.filter(
    (attempt) => !attempt.executionFailure && !attempt.output
  ).length;

  if (!output) {
    return {
      artifactId: artifact.artifactId,
      validOutput: false,
      answerCorrect: null,
      statusAccepted: null,
      // No public output means the semantic observation is unavailable. It is
      // a recorded execution/schema failure, not a zero-quality answer.
      claimCorrectness: ratio(0, 0),
      evidentialSupport: ratio(0, 0),
      inventedCriticism: ratio(0, 0),
      disagreementPreservation: ratio(0, 0),
      requiredUserQuestionCoverage: ratio(0, 0),
      abstained: null,
      uncertaintyExpressed: null,
      drift: ratio(0, 0),
      duplicateIssueCount: 0,
      failureCount: Math.max(1, failureCount),
      invalidAttemptCount,
      repairAttempted: artifact.output.repairAttempted,
      repairSucceeded: false
    };
  }

  const claimsByProposition = new Map(output.claims.map((claim) => [claim.propositionId, claim]));
  const claimCorrectCount = input.oracleCase.propositionExpectations.filter((expectation) => {
    const claim = claimsByProposition.get(expectation.propositionId);
    return Boolean(claim && expectation.acceptableStances.includes(claim.stance));
  }).length;
  const supportExpectations = input.oracleCase.propositionExpectations.filter(
    (expectation) => expectation.requiredEvidenceSets.length > 0
  );
  const supportedCount = supportExpectations.filter((expectation) => {
    const claim = claimsByProposition.get(expectation.propositionId);
    const proposition = input.participantCase.propositions.find(
      (candidate) => candidate.id === expectation.propositionId
    );
    if (
      !claim ||
      !proposition ||
      claim.topicId !== proposition.topicId ||
      !expectation.acceptableStances.includes(claim.stance)
    ) return false;
    const cited = new Set(claim.evidence.map((reference) => reference.evidenceId));
    return expectation.requiredEvidenceSets.some((set) => set.every((id) => cited.has(id)));
  }).length;
  const inventedIssueCount = output.issues.filter(
    (issue) => !isValidCritique(issue, input.oracleCase.validCritiques)
  ).length;
  const preservedDisagreementCount = input.oracleCase.disagreementRequirements.filter(
    (requirement) =>
      output.disagreements.some(
        (disagreement) =>
          requirement.propositionIds.every((id) => disagreement.propositionIds.includes(id)) &&
          requirement.acceptableStatuses.includes(disagreement.status) &&
          (!requirement.requiredCruxId || disagreement.cruxId === requirement.requiredCruxId)
      )
  ).length;
  const coveredQuestionCount = input.oracleCase.requiredUserQuestionCruxIds.filter((cruxId) =>
    output.userQuestions.some((question) => question.cruxId === cruxId)
  ).length;
  const propositions = new Map(
    input.participantCase.propositions.map((proposition) => [proposition.id, proposition])
  );
  const topicIds = new Set(input.participantCase.topics.map((topic) => topic.id));
  const driftCount = output.claims.filter((claim) => {
    const proposition = propositions.get(claim.propositionId);
    return !proposition || !topicIds.has(claim.topicId) || proposition.topicId !== claim.topicId;
  }).length;

  return {
    artifactId: artifact.artifactId,
    validOutput: true,
    answerCorrect: scoreAnswer(output, input),
    statusAccepted: input.oracleCase.acceptableStatuses.includes(output.status),
    claimCorrectness: ratio(
      claimCorrectCount,
      input.oracleCase.propositionExpectations.length
    ),
    evidentialSupport: ratio(supportedCount, supportExpectations.length),
    inventedCriticism: ratio(inventedIssueCount, output.issues.length),
    disagreementPreservation: ratio(
      preservedDisagreementCount,
      input.oracleCase.disagreementRequirements.length
    ),
    requiredUserQuestionCoverage: ratio(
      coveredQuestionCount,
      input.oracleCase.requiredUserQuestionCruxIds.length
    ),
    abstained: output.status === 'ABSTAIN',
    uncertaintyExpressed:
      output.status === 'UNCERTAIN' ||
      output.status === 'ABSTAIN' ||
      output.status === 'NEEDS_USER_INPUT' ||
      output.status === 'MULTIPLE_DEFENSIBLE',
    drift: ratio(driftCount, output.claims.length),
    duplicateIssueCount: duplicateIssueCount(output.issues),
    failureCount,
    invalidAttemptCount,
    repairAttempted: artifact.output.repairAttempted,
    repairSucceeded: artifact.output.acceptedAttemptNumber === 2
  };
}

export function scoreLabTrajectory(input: LabTrajectoryForScoring): LabTrajectoryScore {
  assertScorableCasePair(input);
  const artifactsById = new Map(input.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  if (artifactsById.size !== input.artifacts.length) {
    throw new Error('Cannot score a trajectory with duplicate artifact ids.');
  }
  if (input.terminalArtifactIds.length === 0) {
    throw new Error('A trajectory must identify at least one terminal artifact.');
  }
  const terminalArtifacts = input.terminalArtifactIds.map((artifactId) => {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) throw new Error(`Terminal artifact ${artifactId} is not present in the trajectory.`);
    return artifact;
  });
  input.initialArtifactIds.forEach((artifactId) => {
    if (!artifactsById.has(artifactId)) {
      throw new Error(`Initial artifact ${artifactId} is not present in the trajectory.`);
    }
  });

  let correctionCount = 0;
  let correctionOpportunities = 0;
  let contaminationCount = 0;
  let contaminationOpportunities = 0;
  input.transitionLinks.forEach((link) => {
    const fromArtifact = requireArtifact(artifactsById, link.fromArtifactId, 'transition source');
    const toArtifact = requireArtifact(artifactsById, link.toArtifactId, 'transition target');
    const from = acceptedLabOutput(fromArtifact);
    const to = acceptedLabOutput(toArtifact);
    // Provider/schema failures are counted below. They do not create a
    // semantic correction or contamination opportunity that can be scored.
    if (!from || !to) return;
    const propositionIds = link.propositionIds ?? input.oracleCase.propositionExpectations.map(
      (expectation) => expectation.propositionId
    );
    propositionIds.forEach((propositionId) => {
      const expectation = expectationFor(input, propositionId);
      const beforeCorrect = outputHasCorrectStance(from, expectation);
      const afterCorrect = outputHasCorrectStance(to, expectation);
      if (!beforeCorrect) {
        correctionOpportunities += 1;
        if (afterCorrect) correctionCount += 1;
      } else {
        contaminationOpportunities += 1;
        if (!afterCorrect) contaminationCount += 1;
      }
    });
  });

  const initialOutputs = input.initialArtifactIds
    .map((artifactId) => acceptedLabOutput(artifactsById.get(artifactId)!))
    .filter((output): output is LabPublicOutput => Boolean(output));
  const terminalOutputs = terminalArtifacts
    .map((artifact) => acceptedLabOutput(artifact))
    .filter((output): output is LabPublicOutput => Boolean(output));
  const initialArtifactIdSet = new Set(input.initialArtifactIds);
  const downstreamTerminalOutputs = terminalArtifacts
    .filter((artifact) => !initialArtifactIdSet.has(artifact.artifactId))
    .map((artifact) => acceptedLabOutput(artifact))
    .filter((output): output is LabPublicOutput => Boolean(output));
  let sharedErrorCount = 0;
  let sharedErrorOpportunities = 0;
  if (initialOutputs.length >= 2 && terminalOutputs.length > 0) {
    input.oracleCase.sharedErrorPropositionIds.forEach((propositionId) => {
      const expectation = expectationFor(input, propositionId);
      if (initialOutputs.every((output) => !outputHasCorrectStance(output, expectation))) {
        sharedErrorOpportunities += 1;
        if (terminalOutputs.some((output) => outputHasCorrectStance(output, expectation))) {
          sharedErrorCount += 1;
        }
      }
    });
  }

  let minorityPreservedCount = 0;
  let minorityOpportunities = 0;
  // Raw blind samples trivially retain themselves when they are also the
  // terminal artifacts. Minority preservation is observable only when a
  // downstream mapper, responder, auditor, or synthesizer could erase it.
  if (initialOutputs.length >= 3 && downstreamTerminalOutputs.length > 0) {
    input.oracleCase.propositionExpectations.forEach((expectation) => {
      const correctCount = initialOutputs.filter((output) =>
        outputHasCorrectStance(output, expectation)
      ).length;
      if (correctCount > 0 && correctCount < initialOutputs.length - correctCount) {
        minorityOpportunities += 1;
        if (downstreamTerminalOutputs.some((output) =>
          outputHasCorrectStance(output, expectation)
        )) {
          minorityPreservedCount += 1;
        }
      }
    });
  }

  const outputScores = input.artifacts.map((artifact) => scoreLabArtifact(artifact, input));
  const terminalDisagreementPreservation = scoreDisagreementsAcross(
    terminalOutputs,
    input.oracleCase.disagreementRequirements
  );
  const repeated = repeatedCriticism(input.artifacts);
  const attempts = input.artifacts.flatMap((artifact) => artifact.output.attempts);
  const chargedAttempts = attempts.filter((attempt) => attempt.charged);

  return {
    outputs: outputScores,
    wrongToRightCorrection: ratio(correctionCount, correctionOpportunities),
    rightToWrongContamination: ratio(contaminationCount, contaminationOpportunities),
    sharedErrorDiscovery: ratio(sharedErrorCount, sharedErrorOpportunities),
    correctMinorityPreservation: ratio(minorityPreservedCount, minorityOpportunities),
    terminalDisagreementPreservation,
    repeatedCriticism: repeated,
    totalChargedCalls: chargedAttempts.length,
    totalInputTokens: sumComplete(chargedAttempts.map((attempt) => attempt.usage?.inputTokens)),
    totalOutputTokens: sumComplete(chargedAttempts.map((attempt) => attempt.usage?.outputTokens)),
    totalReasoningTokens: sumComplete(
      chargedAttempts.map((attempt) => attempt.usage?.reasoningTokens)
    ),
    totalTokens: sumComplete(chargedAttempts.map((attempt) => attempt.usage?.totalTokens)),
    totalLatencyMs: sumComplete(chargedAttempts.map((attempt) => attempt.latencyMs)),
    failureCount: outputScores.reduce((sum, score) => sum + score.failureCount, 0)
  };
}

function scoreDisagreementsAcross(
  outputs: LabPublicOutput[],
  requirements: LabTrajectoryForScoring['oracleCase']['disagreementRequirements']
): LabRatioMetric {
  const preserved = requirements.filter((requirement) =>
    outputs.some((output) =>
      output.disagreements.some(
        (disagreement) =>
          requirement.propositionIds.every((id) => disagreement.propositionIds.includes(id)) &&
          requirement.acceptableStatuses.includes(disagreement.status) &&
          (!requirement.requiredCruxId || disagreement.cruxId === requirement.requiredCruxId)
      )
    )
  ).length;
  return ratio(preserved, requirements.length);
}

function scoreAnswer(
  output: LabPublicOutput,
  input: Pick<LabTrajectoryForScoring, 'participantCase' | 'oracleCase'>
): boolean | null {
  const scoresValues = input.oracleCase.acceptedAnswerValueSets.length > 0;
  const scoresOptions = input.oracleCase.acceptedAnswerOptionSets.length > 0;
  if (!scoresValues && !scoresOptions) return null;
  const valuesMatch =
    !scoresValues ||
    input.oracleCase.acceptedAnswerValueSets.some(
      (accepted) => normalizedValueSet(accepted) === normalizedValueSet(output.answer.values)
    );
  const optionsMatch =
    !scoresOptions ||
    input.oracleCase.acceptedAnswerOptionSets.some(
      (accepted) => normalizedSet(accepted) === normalizedSet(output.answer.selectedOptionIds)
    );
  return valuesMatch && optionsMatch;
}

function outputHasCorrectStance(
  output: LabPublicOutput,
  expectation: LabPropositionExpectation
): boolean {
  const claim = output.claims.find((candidate) => candidate.propositionId === expectation.propositionId);
  return Boolean(claim && expectation.acceptableStances.includes(claim.stance));
}

function expectationFor(
  input: Pick<LabTrajectoryForScoring, 'oracleCase'>,
  propositionId: string
): LabPropositionExpectation {
  const expectation = input.oracleCase.propositionExpectations.find(
    (candidate) => candidate.propositionId === propositionId
  );
  if (!expectation) {
    throw new Error(`Transition references unscored proposition ${propositionId}.`);
  }
  return expectation;
}

function isValidCritique(
  issue: LabPublicIssue,
  validCritiques: LabTrajectoryForScoring['oracleCase']['validCritiques']
): boolean {
  return validCritiques.some(
    (valid) =>
      valid.targetPropositionId === issue.targetPropositionId &&
      valid.kinds.includes(issue.kind) &&
      valid.severities.includes(issue.severity)
  );
}

function duplicateIssueCount(issues: LabPublicIssue[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  issues.forEach((issue) => {
    const fingerprint = issueFingerprint(issue);
    if (seen.has(fingerprint)) duplicates += 1;
    seen.add(fingerprint);
  });
  return duplicates;
}

function repeatedCriticism(artifacts: LabArtifactRecord[]): LabRatioMetric {
  const seen = new Set<string>();
  let issueCount = 0;
  let repeatedCount = 0;
  artifacts.forEach((artifact) => {
    const output = acceptedLabOutput(artifact);
    if (!output) return;
    output.issues.forEach((issue) => {
      issueCount += 1;
      const fingerprint = issueFingerprint(issue);
      if (seen.has(fingerprint)) repeatedCount += 1;
      seen.add(fingerprint);
    });
  });
  return ratio(repeatedCount, issueCount);
}

function issueFingerprint(issue: LabPublicIssue): string {
  return [
    issue.targetPropositionId,
    issue.kind,
    issue.severity,
    issue.statement.toLowerCase().replace(/\s+/g, ' ').trim()
  ].join('|');
}

function requireArtifact(
  artifacts: Map<string, LabArtifactRecord>,
  artifactId: string,
  label: string
): LabArtifactRecord {
  const artifact = artifacts.get(artifactId);
  if (!artifact) throw new Error(`Unknown ${label} artifact ${artifactId}.`);
  return artifact;
}

function assertScorableCasePair(
  input: Pick<LabTrajectoryForScoring, 'participantCase' | 'oracleCase'>
): void {
  const errors = validateLabCasePair(input.participantCase, input.oracleCase);
  if (errors.length > 0) {
    throw new Error(`Invalid lab case pair: ${errors.map((error) => error.message).join(' ')}`);
  }
}

function normalizedSet(values: string[]): string {
  return [...new Set(values)].sort().join('\u0000');
}

export function normalizeLabAnswerValue(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function normalizedValueSet(values: string[]): string {
  return [...new Set(values.map(normalizeLabAnswerValue))].sort().join('\u0000');
}

function ratio(count: number, opportunities: number): LabRatioMetric {
  return {
    count,
    opportunities,
    rate: opportunities === 0 ? null : count / opportunities
  };
}

function sumComplete(values: Array<number | undefined>): number | null {
  if (values.length === 0 || values.some((value) => value === undefined)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

export function stanceIsCorrect(
  stance: LabClaimStance | undefined,
  expectation: LabPropositionExpectation
): boolean {
  return stance !== undefined && expectation.acceptableStances.includes(stance);
}
