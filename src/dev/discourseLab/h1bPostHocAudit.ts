import fs from 'node:fs/promises';
import path from 'node:path';
import type { LabPublicOutput } from './contracts';
import {
  loadH1bOracleCorpus,
  loadH1bParticipantCorpus
} from './h1bCorpus';
import { parseLabRawOutputAttemptV3 } from './outputV3';

export const H1B_V3_POST_HOC_AUDIT_VERSION =
  'h1b-v3-post-hoc-engineering-diagnostic@v1' as const;

interface ArchivedRun {
  assignment: {
    assignmentId: string;
    caseId: string;
    stratum: 'DERIVABLE_CRITIQUE' | 'NEW_EVIDENCE';
    conditionId: string;
  };
  run: {
    artifacts: Array<{
      actorId: string;
      output: {
        acceptedAttemptNumber: 1 | 2 | null;
        attempts: Array<{
          attemptNumber: 1 | 2;
          callId: string;
          rawText: string;
          output?: LabPublicOutput;
        }>;
      };
    }>;
  };
  score: {
    answerCorrect: boolean | null;
    materialIssueSignature: { potentiallyInvented: number };
  };
}

interface ArchivedReport {
  hypothesisId: 'H1b';
  interpretation: { overall: string; derivable: { status: string }; evidence: { status: string } };
  runs: ArchivedRun[];
}

export interface H1bV3PostHocAuditReport {
  schemaVersion: typeof H1B_V3_POST_HOC_AUDIT_VERSION;
  classification: 'POST_HOC_ENGINEERING_DIAGNOSTIC_NOT_CAUSAL_EVIDENCE';
  source: {
    reportPath: string;
    hypothesisId: 'H1b';
    preservedFrozenInterpretation: ArchivedReport['interpretation'];
  };
  v3Boundary: {
    archivedTerminalOutputs: number;
    rejectedByV3Parser: number;
    expectedSchemaVersionRejections: number;
    causalResultsRewritten: false;
  };
  decomposedDiagnostics: {
    statuses: Record<string, number>;
    abstentions: number;
    confidence: { minimum: number | null; maximum: number | null; atLeastPoint99: number };
    typedInformationRequestRepresentable: number;
    evidenceBaseOutputs: number;
    evidenceBaseExactUndeterminedAnswers: number;
    evidenceBaseTargetOpen: number;
    evidenceBaseTargetReject: number;
    evidenceBaseUserQuestions: number;
    critiqueOutputs: number;
    critiqueArtifactOrIssueCitedInClaims: number;
    critiqueArtifactOrIssueCitedInIssues: number;
    critiqueArtifactOrIssueCitedInResponses: number;
    critiqueArtifactOrIssueCitedInDisagreements: number;
    frozenPotentiallyInventedSignatureMismatches: number;
    semanticInventedCriticismConclusions: 'NOT_AVAILABLE_FROM_SIGNATURES';
    minorityPreservation: 'NOT_ESTIMABLE_NO_SOCIAL_MINORITY_EXPOSURE';
  };
  explanation: string[];
}

export async function buildH1bV3PostHocAudit(input: {
  fixtureRoot: string;
  archivedReportPath: string;
}): Promise<H1bV3PostHocAuditReport> {
  const archivedText = await fs.readFile(input.archivedReportPath, 'utf8');
  const archived = JSON.parse(archivedText) as ArchivedReport;
  if (archived.hypothesisId !== 'H1b' || archived.runs.length !== 54) {
    throw new Error('The preserved H1b report does not have the expected sealed cohort.');
  }
  const participants = await loadH1bParticipantCorpus(input.fixtureRoot);
  const oracles = await loadH1bOracleCorpus(input.fixtureRoot, participants);
  const participantById = new Map(participants.records.map((record) => [record.caseId, record]));
  const oracleById = new Map(oracles.map((oracle) => [oracle.caseId, oracle]));
  const terminal = archived.runs.map((run) => ({
    run,
    output: terminalOutput(run)
  }));
  const v3Attempts = terminal.map(({ run, output }) =>
    parseLabRawOutputAttemptV3(
      { callId: `${run.assignment.assignmentId}:post-hoc`, rawText: output.rawText },
      'PRIMARY',
      1
    )
  );
  const statusCounts: Record<string, number> = {};
  const confidences: number[] = [];
  for (const { output } of terminal) {
    statusCounts[output.value.status] = (statusCounts[output.value.status] ?? 0) + 1;
    confidences.push(output.value.confidence);
  }

  const evidenceBase = terminal.filter(({ run }) =>
    run.assignment.stratum === 'NEW_EVIDENCE' &&
    (run.assignment.conditionId === 'CONTROL_CASE_ONLY_B1' ||
      run.assignment.conditionId === 'CONTROL_NO_FEEDBACK_B1')
  );
  let targetOpen = 0;
  let targetReject = 0;
  let exactUndetermined = 0;
  let baseUserQuestions = 0;
  for (const { run, output } of evidenceBase) {
    const oracle = oracleById.get(run.assignment.caseId)!;
    const expectedOptions = oracle.baseProfile.acceptedAnswerOptionSets;
    if (expectedOptions.some((set) => sameStringSet(output.value.answer.selectedOptionIds, set))) {
      exactUndetermined += 1;
    }
    for (const targetId of oracle.targetPropositionIds) {
      const stance = output.value.claims.find((claim) => claim.propositionId === targetId)?.stance;
      if (stance === 'OPEN') targetOpen += 1;
      if (stance === 'REJECT') targetReject += 1;
    }
    baseUserQuestions += output.value.userQuestions.length;
  }

  const critiqueRuns = terminal.filter(({ run }) =>
    run.assignment.conditionId === 'CONTROL_VALID_CRITIQUE_B1'
  );
  const critiqueCitationCounts = {
    claims: 0,
    issues: 0,
    responses: 0,
    disagreements: 0
  };
  for (const { run, output } of critiqueRuns) {
    const participant = participantById.get(run.assignment.caseId)!;
    const identifiers = new Set<string>();
    for (const artifact of participant.signal.artifacts) {
      identifiers.add(artifact.artifactId);
      if (artifact.issueId) identifiers.add(artifact.issueId);
    }
    if (output.value.claims.some((item) => citesAny(item.evidence, identifiers))) {
      critiqueCitationCounts.claims += 1;
    }
    if (output.value.issues.some((item) => citesAny(item.evidence, identifiers))) {
      critiqueCitationCounts.issues += 1;
    }
    if (output.value.responses.some((item) => citesAny(item.evidence, identifiers))) {
      critiqueCitationCounts.responses += 1;
    }
    if (output.value.disagreements.some((item) => citesAny(item.evidence, identifiers))) {
      critiqueCitationCounts.disagreements += 1;
    }
  }

  const expectedVersionRejections = v3Attempts.filter((attempt) =>
    attempt.validationErrors.some((error) =>
      error.path === '$.schemaVersion' && error.code === 'INVALID_VALUE'
    )
  ).length;
  return {
    schemaVersion: H1B_V3_POST_HOC_AUDIT_VERSION,
    classification: 'POST_HOC_ENGINEERING_DIAGNOSTIC_NOT_CAUSAL_EVIDENCE',
    source: {
      reportPath: path.resolve(input.archivedReportPath),
      hypothesisId: archived.hypothesisId,
      preservedFrozenInterpretation: structuredClone(archived.interpretation)
    },
    v3Boundary: {
      archivedTerminalOutputs: terminal.length,
      rejectedByV3Parser: v3Attempts.filter((attempt) => !attempt.output).length,
      expectedSchemaVersionRejections: expectedVersionRejections,
      causalResultsRewritten: false
    },
    decomposedDiagnostics: {
      statuses: statusCounts,
      abstentions: terminal.filter(({ output }) => output.value.status === 'ABSTAIN').length,
      confidence: {
        minimum: confidences.length ? Math.min(...confidences) : null,
        maximum: confidences.length ? Math.max(...confidences) : null,
        atLeastPoint99: confidences.filter((value) => value >= 0.99).length
      },
      typedInformationRequestRepresentable: 0,
      evidenceBaseOutputs: evidenceBase.length,
      evidenceBaseExactUndeterminedAnswers: exactUndetermined,
      evidenceBaseTargetOpen: targetOpen,
      evidenceBaseTargetReject: targetReject,
      evidenceBaseUserQuestions: baseUserQuestions,
      critiqueOutputs: critiqueRuns.length,
      critiqueArtifactOrIssueCitedInClaims: critiqueCitationCounts.claims,
      critiqueArtifactOrIssueCitedInIssues: critiqueCitationCounts.issues,
      critiqueArtifactOrIssueCitedInResponses: critiqueCitationCounts.responses,
      critiqueArtifactOrIssueCitedInDisagreements: critiqueCitationCounts.disagreements,
      frozenPotentiallyInventedSignatureMismatches: archived.runs.reduce(
        (sum, run) => sum + run.score.materialIssueSignature.potentiallyInvented,
        0
      ),
      semanticInventedCriticismConclusions: 'NOT_AVAILABLE_FROM_SIGNATURES',
      minorityPreservation: 'NOT_ESTIMABLE_NO_SOCIAL_MINORITY_EXPOSURE'
    },
    explanation: [
      'V2 outputs are expected to fail the closed v3 parser; migration is not silently inferred.',
      'Exact option, proposition assessment, workflow action, factual provenance, request ownership, abstention, and confidence now remain separate diagnostics.',
      'The archived v2 request shape cannot represent needed/source/blocking and therefore cannot validate typed request quality.',
      'Critique citations are counted across every factual-evidence surface; conversational provenance must use v3 artifact references.',
      'Signature mismatch is retained as a mechanical diagnostic and is not renamed semantic invented criticism.',
      'No archived H1b classification, exclusion, score, or causal estimate is changed.'
    ]
  };
}

export async function writeH1bV3PostHocAudit(
  outputPath: string,
  report: H1bV3PostHocAuditReport
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const handle = await fs.open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function terminalOutput(run: ArchivedRun): { rawText: string; value: LabPublicOutput } {
  const artifact = [...run.run.artifacts].reverse().find((item) => item.actorId !== 'SEALED_INITIAL');
  const attempt = artifact?.output.attempts.find(
    (item) => item.attemptNumber === artifact.output.acceptedAttemptNumber
  );
  if (!attempt?.output) {
    throw new Error(`Archived H1b terminal output is unavailable: ${run.assignment.assignmentId}.`);
  }
  return { rawText: attempt.rawText, value: attempt.output };
}

function citesAny(
  references: ReadonlyArray<{ evidenceId: string }>,
  identifiers: ReadonlySet<string>
): boolean {
  return references.some((reference) => identifiers.has(reference.evidenceId));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
