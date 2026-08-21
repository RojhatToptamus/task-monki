import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HARD_PEER_80_DOMAINS,
  loadHardPeer80OracleCorpus,
  loadHardPeer80ParticipantCorpus,
  type HardPeer80OracleRecord,
  type HardPeer80ParticipantCorpus,
  type HardPeer80ParticipantRecord
} from './hardPeer80Corpus';
import {
  HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
  validateHardPeer80Output,
  type HardPeer80PublicOutput,
  type HardPeer80Stage,
  type HardPeer80TargetReference,
  type HardPeer80ValidationContext,
  type HardPeer80VisibleArtifact
} from './hardPeer80Contracts';
import {
  HARD_PEER_80_SCHEDULE_VERSION,
  assertHardPeer80Plan,
  type HardPeer80CallAssignment,
  type HardPeer80Plan
} from './hardPeer80Plan';
import {
  HARD_PEER_80_PROBE_CASE,
  HARD_PEER_80_PROMPT_VERSION,
  buildHardPeer80Prompt
} from './hardPeer80Prompts';
import { scoreHardPeer80Output } from './hardPeer80Scoring';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  sha256File,
  sha256Text,
  stableJson,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import {
  HARD_PEER_80_H0_RECEIPT_SCHEMA_VERSION,
  type HardPeer80H0Receipt,
  type HardPeer80ValidationReport
} from './hardPeer80Validation';

export const HARD_PEER_80_HARNESS_VALIDATION_SCHEMA_VERSION =
  'task-monki/discourse-lab-hard-peer-80-h0@v2' as const;
export const HARD_PEER_80_HARNESS_VALIDATION_VERSION =
  'hard-peer-80-h0-validation@v2' as const;

export interface HardPeer80H0PromptSummary {
  callNumber: number;
  callId: string;
  phase: HardPeer80CallAssignment['phase'];
  caseId: string;
  blockId: string | null;
  stage: HardPeer80Stage;
  threadMode: HardPeer80CallAssignment['threadMode'];
  visibleArtifactIds: HardPeer80VisibleArtifact['artifactId'][];
  promptSha256: string;
  estimatedPromptTokens: number;
}

export interface HardPeer80H0ContractFixture {
  fixtureId: string;
  stage: HardPeer80Stage;
  concern:
    | 'STAGE'
    | 'SCHEMA'
    | 'EVIDENCE_PROVENANCE'
    | 'CRITIQUE_TARGETING'
    | 'DIRECT_RESPONSE'
    | 'RESOLUTION_ACCOUNTING'
    | 'DISAGREEMENT_PRESERVATION'
    | 'UNCERTAINTY_ABSTENTION'
    | 'CERTIFICATE_PAYLOAD';
  expectedAccepted: boolean;
  observedAccepted: boolean;
  observedErrorCodes: string[];
  status: 'PASSED';
}

export interface HardPeer80H0OracleVerification {
  caseId: string;
  domain: HardPeer80OracleRecord['domain'];
  certificateKind: HardPeer80OracleRecord['certificate']['kind'];
  independentlyVerified: true;
  validTypedCertificateAccepted: true;
  falseTypedCertificateRejected: true;
}

export interface HardPeer80HarnessValidationReport {
  schemaVersion: typeof HARD_PEER_80_HARNESS_VALIDATION_SCHEMA_VERSION;
  validationVersion: typeof HARD_PEER_80_HARNESS_VALIDATION_VERSION;
  hypothesisId: 'H0-HARD-PEER-80';
  status: 'PASSED';
  componentLocks: LabComponentLock;
  scheduleVersion: typeof HARD_PEER_80_SCHEDULE_VERSION;
  scheduleSha256: string;
  promptTemplateSetSha256: string;
  providerCallCount: 0;
  semanticCallExpectation: 76;
  calibrationCallExpectation: 5;
  evaluationBlockExpectation: 10;
  evaluationForkExpectation: 30;
  boundaryProbeForkExpectation: 1;
  totalNonModelForkExpectation: 31;
  prompts: HardPeer80H0PromptSummary[];
  contractFixtures: HardPeer80H0ContractFixture[];
  oracleVerifications: HardPeer80H0OracleVerification[];
  checks: Array<{ checkId: string; status: 'PASSED'; detail: string }>;
}

export interface RunHardPeer80HarnessValidationInput {
  fixtureRoot: string;
  validation: HardPeer80ValidationReport;
  plan: HardPeer80Plan;
  ledger?: LabArtifactLedger;
}

interface MaterializedPrompt extends HardPeer80H0PromptSummary {
  prompt: string;
  context: HardPeer80ValidationContext;
  syntheticOutput: HardPeer80PublicOutput;
}

const REQUIRED_CHECK_IDS = [
  'SEALED_COMPONENT_LOCKS',
  'EXACT_76_CALL_PLAN',
  'EXACT_30_EVALUATION_FORKS',
  'ONE_BOUNDARY_PROBE_FORK',
  'ALL_FORKS_BEFORE_BRANCH_TURNS',
  'EVERY_PROMPT_MATERIALIZED',
  'SYNTHETIC_OUTPUTS_CONTEXT_VALID',
  'PARTICIPANT_BEFORE_SCORER_TRUTH_FIREWALL',
  'BOTH_ORACLE_PARTITIONS_INDEPENDENTLY_VERIFIED',
  'STAGE_SCHEMA_PROVENANCE_BOUNDARIES',
  'CRITIQUE_AND_DIRECT_RESPONSE_BOUNDARIES',
  'DISAGREEMENT_PRESERVATION_BOUNDARY',
  'UNCERTAINTY_AND_ABSTENTION_ALLOWED',
  'TYPED_CERTIFICATE_SCHEMA_BOUNDARY',
  'DETERMINISTIC_CERTIFICATE_SEMANTICS',
  'TYPED_COMPONENT_TARGETS_DISCLOSED',
  'NO_HIDDEN_REASONING_FIELD',
  'ZERO_PROVIDER_BEHAVIOR'
] as const;

const REQUIRED_FIXTURE_IDS = [
  'PROBE_NULL_CERTIFICATE_PAYLOAD_ACCEPTED',
  'INITIAL_SCHEMA_VALID_FALSE_CERTIFICATE_ACCEPTED',
  'INITIAL_NULL_CERTIFICATE_PAYLOAD_REJECTED',
  'INITIAL_ISSUE_REJECTED',
  'INITIAL_UNKNOWN_SCHEMA_FIELD_REJECTED',
  'INITIAL_WRONG_STAGE_REJECTED',
  'WORKBENCH_NO_ISSUE_ACCEPTED',
  'SELF_REVIEW_NO_ISSUE_ACCEPTED',
  'PEER_NO_ISSUE_ACCEPTED',
  'PEER_MATERIAL_ISSUE_ACCEPTED',
  'PEER_ANSWER_SELECTION_ISSUE_ACCEPTED',
  'PEER_EPISTEMIC_STATE_ISSUE_ACCEPTED',
  'PEER_CERTIFICATE_ISSUE_ACCEPTED',
  'PEER_COMPONENT_PROPOSITION_MISMATCH_REJECTED',
  'PEER_CASE_TARGET_REJECTED',
  'PEER_ARTIFACT_AS_FACTUAL_EVIDENCE_REJECTED',
  'PEER_MATERIAL_ISSUE_WITHOUT_EVIDENCE_REJECTED',
  'AUTHOR_ACCEPT_RESPONSE_ACCEPTED',
  'AUTHOR_CERTIFICATE_CHANGED_TARGET_ACCEPTED',
  'AUTHOR_DUPLICATE_CHANGED_TARGET_REJECTED',
  'AUTHOR_MISSING_DIRECT_RESPONSE_REJECTED',
  'AUTHOR_WRONG_ARTIFACT_RESPONSE_REJECTED',
  'AUTHOR_DUPLICATE_RESPONSE_REJECTED',
  'AUTHOR_ACCEPT_MARKED_UNRESOLVED_REJECTED',
  'AUTHOR_NEW_ISSUE_REJECTED',
  'AUTHOR_PARTIAL_PRESERVES_DISAGREEMENT_ACCEPTED',
  'AUTHOR_PARTIAL_SILENT_RESOLUTION_REJECTED',
  'INITIAL_UNCERTAIN_NULL_CERTIFICATE_PAYLOAD_ACCEPTED',
  'INITIAL_EXPLICIT_ABSTENTION_ACCEPTED',
  'INITIAL_ABSTENTION_WITHOUT_RECORD_REJECTED'
] as const;

/** Provider-free H0. It accepts no driver and imports no provider implementation. */
export async function runHardPeer80HarnessValidation(
  input: RunHardPeer80HarnessValidationInput
): Promise<HardPeer80HarnessValidationReport> {
  input.ledger?.assertRunContext('HARNESS_VALIDATION', input.validation.locks);
  await input.ledger?.append({
    eventType: 'HARD_PEER_80_H0_STARTED',
    occurredAt: new Date().toISOString()
  });

  const calibration = await loadHardPeer80ParticipantCorpus(input.fixtureRoot, 'CALIBRATION');
  const evaluation = await loadHardPeer80ParticipantCorpus(input.fixtureRoot, 'EVALUATION');
  const calibrationIds = calibration.records.map(({ caseId }) => caseId);
  const evaluationIds = evaluation.records.map(({ caseId }) => caseId);
  assertHardPeer80Plan(input.plan, calibrationIds, evaluationIds);
  assertPlanTopology(input.plan);

  // The complete participant-facing matrix is built before either scorer-only
  // file is opened. This ordering is the H0 truth-firewall assertion.
  const promptMatrix = materializePromptMatrix(input.plan, calibration, evaluation);
  if (promptMatrix.some(({ prompt }) =>
    !prompt.includes('PROPOSITION, ANSWER_SELECTION, EPISTEMIC_STATE, or CERTIFICATE') ||
    !prompt.includes('targetPropositionId is null except for PROPOSITION') ||
    !prompt.includes('exact corresponding changedTargets')
  )) {
    throw new Error('HARD-PEER-80 prompt does not disclose its typed component target contract.');
  }
  const promptArtifact = {
    kind: 'HARD_PEER_80_H0_MATERIALIZED_PROMPT_SET',
    promptVersion: HARD_PEER_80_PROMPT_VERSION,
    outputSchemaVersion: HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
    scheduleVersion: HARD_PEER_80_SCHEDULE_VERSION,
    scheduleSha256: input.plan.schedule.scheduleSha256,
    prompts: promptMatrix
  } as const;
  const promptTemplateSetSha256 = sha256Text(`${stableJson(promptArtifact)}\n`);
  const promptLedgerArtifact = await input.ledger?.putArtifact(promptArtifact);
  if (promptLedgerArtifact && promptLedgerArtifact.sha256 !== promptTemplateSetSha256) {
    throw new Error('HARD-PEER-80 H0 prompt-set digest changed in the ledger.');
  }

  const calibrationOracles = await loadHardPeer80OracleCorpus(
    input.fixtureRoot,
    'CALIBRATION',
    calibration
  );
  const evaluationOracles = await loadHardPeer80OracleCorpus(
    input.fixtureRoot,
    'EVALUATION',
    evaluation
  );
  const oracleVerifications = [
    ...independentlyVerifyOraclePartition(calibration, calibrationOracles.records),
    ...independentlyVerifyOraclePartition(evaluation, evaluationOracles.records)
  ];
  const contractFixtures = buildAdversarialFixtures(evaluation.records[0]!);
  const prompts = promptMatrix.map(
    ({ prompt: _prompt, context: _context, syntheticOutput: _output, ...summary }) => summary
  );

  const report: HardPeer80HarnessValidationReport = {
    schemaVersion: HARD_PEER_80_HARNESS_VALIDATION_SCHEMA_VERSION,
    validationVersion: HARD_PEER_80_HARNESS_VALIDATION_VERSION,
    hypothesisId: 'H0-HARD-PEER-80',
    status: 'PASSED',
    componentLocks: structuredClone(input.validation.locks),
    scheduleVersion: HARD_PEER_80_SCHEDULE_VERSION,
    scheduleSha256: input.plan.schedule.scheduleSha256,
    promptTemplateSetSha256,
    providerCallCount: 0,
    semanticCallExpectation: 76,
    calibrationCallExpectation: 5,
    evaluationBlockExpectation: 10,
    evaluationForkExpectation: 30,
    boundaryProbeForkExpectation: 1,
    totalNonModelForkExpectation: 31,
    prompts,
    contractFixtures,
    oracleVerifications,
    checks: [
      pass('SEALED_COMPONENT_LOCKS', 'The H0 report is bound to the active five-file seal and transitive executable source lock.'),
      pass('EXACT_76_CALL_PLAN', 'One probe, five calibration initials, and ten seven-call evaluation blocks total exactly 76 semantic calls.'),
      pass('EXACT_30_EVALUATION_FORKS', 'Every evaluation block forks A0 into exactly three author branches, for 30 non-model evaluation forks.'),
      pass('ONE_BOUNDARY_PROBE_FORK', 'Execution must make exactly one zero-model fork of the completed one-call boundary probe to attest ancestry and inherited history.'),
      pass('ALL_FORKS_BEFORE_BRANCH_TURNS', 'Each block declares all three A0 forks before any branch call is eligible.'),
      pass('EVERY_PROMPT_MATERIALIZED', 'All 76 prompt/context pairs were materialized from the frozen schedule.'),
      pass('SYNTHETIC_OUTPUTS_CONTEXT_VALID', 'Every prompt stage accepted one locally generated contract-valid public output without repair.'),
      pass('PARTICIPANT_BEFORE_SCORER_TRUTH_FIREWALL', 'Both participant partitions and all prompts were materialized before scorer-only files were deserialized.'),
      pass('BOTH_ORACLE_PARTITIONS_INDEPENDENTLY_VERIFIED', 'All ten certificates were recomputed by a second implementation, not merely shape-checked.'),
      pass('STAGE_SCHEMA_PROVENANCE_BOUNDARIES', 'Adversarial fixtures reject wrong stages, extra schema fields, illegal issue targets, and conversational artifacts used as factual evidence.'),
      pass('CRITIQUE_AND_DIRECT_RESPONSE_BOUNDARIES', 'No-issue review is valid; real critique is optional; every visible issue requires exactly one direct response.'),
      pass('DISAGREEMENT_PRESERVATION_BOUNDARY', 'Partial or abstaining responses remain unresolved and cannot be silently marked resolved.'),
      pass('UNCERTAINTY_AND_ABSTENTION_ALLOWED', 'Explicit uncertainty and abstention are contract-valid and missing abstention metadata is rejected.'),
      pass('TYPED_CERTIFICATE_SCHEMA_BOUNDARY', 'Probe and non-answer outputs may use null; every non-probe ANSWER requires one closed, typed public certificate payload, without checking oracle truth during participant execution.'),
      pass('DETERMINISTIC_CERTIFICATE_SEMANTICS', 'After scorer-only files open, every sealed certificate receives full credit and a schema-valid false certificate receives none.'),
      pass('TYPED_COMPONENT_TARGETS_DISCLOSED', 'Every participant prompt discloses proposition, answer-selection, epistemic-state, and certificate issue targets plus exact changed-target responses.'),
      pass('NO_HIDDEN_REASONING_FIELD', 'The closed schema exposes concise claims, evidence, issues, responses, and resolution only; no scratchpad or reasoning field exists.'),
      pass('ZERO_PROVIDER_BEHAVIOR', 'H0 has no driver parameter and consumed zero provider calls.')
    ]
  };
  assertHardPeer80HarnessValidationReport(report, input.validation.locks, input.plan);
  return report;
}

export function buildHardPeer80HarnessValidationManifest(
  runId: string,
  locks: LabComponentLock,
  caseIds: readonly string[],
  createdAt = new Date().toISOString()
): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId,
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt,
    driver: {
      id: 'hard-peer-80-h0-local-no-provider',
      model: 'none',
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'PROVIDER_ENFORCED',
      boundaryClass: 'PROVIDER_ENFORCED_STRICT',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: false,
      providerReportedTokenUsage: false
    },
    locks: structuredClone(locks),
    caseIds: [...caseIds],
    conditionIds: [
      'BOUNDARY_PROBE',
      'CALIBRATION_INITIAL',
      'SHARED_INITIAL',
      'STRONG_WORKBENCH',
      'SAME_AGENT_SELF_REVIEW',
      'BLIND_PEER_CRITIQUE'
    ],
    budgets: {
      maximumCalls: 0,
      maximumRounds: 0,
      maximumOutputTokens: 0,
      maximumOutputTokenSafetyCeiling: 0,
      maximumObservedTotalTokens: 0,
      maximumCallMs: 0,
      maximumExperimentMs: 60_000
    },
    providerUsageExplicitlyAuthorized: false
  };
}

export async function executeAndRecordHardPeer80H0(input: {
  fixtureRoot: string;
  validation: HardPeer80ValidationReport;
  plan: HardPeer80Plan;
  ledger: LabArtifactLedger;
}): Promise<HardPeer80H0Receipt> {
  const report = await runHardPeer80HarnessValidation(input);
  const reportArtifact = await input.ledger.putArtifact(report);
  const reportPath = await input.ledger.writeReport('hard-peer-80-h0-validation', report);
  if (await sha256File(reportPath) !== reportArtifact.sha256) {
    throw new Error('HARD-PEER-80 H0 named report and content-addressed report differ.');
  }
  await input.ledger.append({
    eventType: 'HARD_PEER_80_H0_PASSED',
    occurredAt: new Date().toISOString(),
    artifactSha256: reportArtifact.sha256,
    detail: {
      semanticCallExpectation: 76,
      totalNonModelForkExpectation: 31,
      promptTemplateSetSha256: report.promptTemplateSetSha256
    }
  });
  const manifestSha256 = await sha256File(
    path.join(input.ledger.runDirectory, 'manifest.json')
  );
  return {
    schemaVersion: HARD_PEER_80_H0_RECEIPT_SCHEMA_VERSION,
    validationVersion: HARD_PEER_80_HARNESS_VALIDATION_VERSION,
    runId: input.ledger.runId,
    status: 'PASSED',
    manifestSha256,
    reportSha256: reportArtifact.sha256,
    componentLocks: structuredClone(report.componentLocks),
    scheduleSha256: report.scheduleSha256,
    promptTemplateSetSha256: report.promptTemplateSetSha256,
    providerCallCount: 0,
    semanticCallExpectation: 76,
    evaluationForkExpectation: 30,
    boundaryProbeForkExpectation: 1
  };
}

export async function loadHardPeer80H0Receipt(input: {
  ledgerRoot: string;
  receipt: HardPeer80H0Receipt;
  activeLocks: LabComponentLock;
  plan: HardPeer80Plan;
}): Promise<HardPeer80HarnessValidationReport> {
  if (!safeRunId(input.receipt.runId)) throw new Error('Unsafe HARD-PEER-80 H0 run id.');
  const runDirectory = path.join(input.ledgerRoot, 'runs', input.receipt.runId);
  await assertRealDirectory(runDirectory);
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const reportPath = path.join(runDirectory, 'reports', 'hard-peer-80-h0-validation.json');
  const reportArtifactPath = path.join(
    runDirectory,
    'artifacts',
    `${input.receipt.reportSha256}.json`
  );
  const promptArtifactPath = path.join(
    runDirectory,
    'artifacts',
    `${input.receipt.promptTemplateSetSha256}.json`
  );
  await Promise.all([
    assertRealFile(manifestPath),
    assertRealFile(reportPath),
    assertRealFile(reportArtifactPath),
    assertRealFile(promptArtifactPath)
  ]);
  if (
    await sha256File(manifestPath) !== input.receipt.manifestSha256 ||
    await sha256File(reportPath) !== input.receipt.reportSha256 ||
    await sha256File(reportArtifactPath) !== input.receipt.reportSha256 ||
    await sha256File(promptArtifactPath) !== input.receipt.promptTemplateSetSha256
  ) {
    throw new Error('HARD-PEER-80 H0 receipt hash verification failed.');
  }
  const manifest = await readRealJson<LabRunManifest>(manifestPath, 'H0 manifest');
  const report = await readRealJson<HardPeer80HarnessValidationReport>(
    reportPath,
    'H0 report'
  );
  assertH0Manifest(manifest, input.receipt.runId, input.activeLocks, input.plan);
  assertHardPeer80HarnessValidationReport(report, input.activeLocks, input.plan);
  if (
    stableJson(report.componentLocks) !== stableJson(input.receipt.componentLocks) ||
    report.scheduleSha256 !== input.receipt.scheduleSha256 ||
    report.promptTemplateSetSha256 !== input.receipt.promptTemplateSetSha256 ||
    report.providerCallCount !== input.receipt.providerCallCount ||
    report.semanticCallExpectation !== input.receipt.semanticCallExpectation ||
    report.evaluationForkExpectation !== input.receipt.evaluationForkExpectation ||
    report.boundaryProbeForkExpectation !== input.receipt.boundaryProbeForkExpectation
  ) {
    throw new Error('HARD-PEER-80 H0 receipt does not describe its verified report.');
  }
  const entries = await fs.readdir(runDirectory);
  if (stableJson(entries.sort()) !== stableJson(['artifacts', 'events', 'manifest.json', 'reports'])) {
    throw new Error('HARD-PEER-80 H0 archive contains an unexpected entry.');
  }
  const [events, artifacts, reports] = await Promise.all([
    fs.readdir(path.join(runDirectory, 'events')),
    fs.readdir(path.join(runDirectory, 'artifacts')),
    fs.readdir(path.join(runDirectory, 'reports'))
  ]);
  if (
    events.length !== 2 ||
    artifacts.length !== 2 ||
    reports.length !== 1 ||
    !events.some((name) => name.endsWith('-hard_peer_80_h0_started.json')) ||
    !events.some((name) => name.endsWith('-hard_peer_80_h0_passed.json'))
  ) {
    throw new Error('HARD-PEER-80 H0 archive set is not exact.');
  }
  return report;
}

function materializePromptMatrix(
  plan: HardPeer80Plan,
  calibration: HardPeer80ParticipantCorpus,
  evaluation: HardPeer80ParticipantCorpus
): MaterializedPrompt[] {
  const records = new Map<string, HardPeer80ParticipantRecord>([
    ...calibration.records.map((record) => [record.caseId, record] as const),
    ...evaluation.records.map((record) => [record.caseId, record] as const)
  ]);
  const blockArtifacts = new Map<string, Map<string, HardPeer80VisibleArtifact>>();
  const prompts: MaterializedPrompt[] = [];
  for (const assignment of plan.assignments) {
    const participantCase = assignment.phase === 'BOUNDARY_PROBE'
      ? HARD_PEER_80_PROBE_CASE
      : records.get(assignment.caseId ?? '')?.participantCase;
    if (!participantCase) throw new Error(`Unknown H0 case ${assignment.caseId}.`);
    const artifacts = assignment.blockId
      ? blockArtifacts.get(assignment.blockId) ?? new Map<string, HardPeer80VisibleArtifact>()
      : new Map<string, HardPeer80VisibleArtifact>();
    if (assignment.blockId && !blockArtifacts.has(assignment.blockId)) {
      blockArtifacts.set(assignment.blockId, artifacts);
    }
    const visibleArtifacts = visibleForStage(assignment.stage, artifacts);
    const prepared = buildHardPeer80Prompt({ participantCase, assignment, visibleArtifacts });
    const syntheticOutput = buildValidSyntheticHardPeer80Output(
      participantCase,
      assignment.stage
    );
    const validation = validateHardPeer80Output(syntheticOutput, prepared.context);
    if (!validation.ok) {
      throw new Error(
        `Synthetic H0 output failed ${assignment.callId}: ${validation.errors[0]?.message}.`
      );
    }
    prompts.push({
      callNumber: assignment.callNumber,
      callId: assignment.callId,
      phase: assignment.phase,
      caseId: participantCase.caseId,
      blockId: assignment.blockId,
      stage: assignment.stage,
      threadMode: assignment.threadMode,
      visibleArtifactIds: visibleArtifacts.map(({ artifactId }) => artifactId),
      promptSha256: sha256Text(prepared.prompt),
      estimatedPromptTokens: Math.ceil(prepared.prompt.length / 4),
      prompt: prepared.prompt,
      context: prepared.context,
      syntheticOutput
    });
    const artifact = visibleArtifactForCurrent(assignment.stage, syntheticOutput);
    if (artifact) artifacts.set(artifact.artifactId, artifact);
  }
  if (prompts.length !== 76 || prompts.some((item, index) => item.callNumber !== index + 1)) {
    throw new Error('HARD-PEER-80 H0 did not materialize the exact 76-call schedule.');
  }
  return prompts;
}

export function buildValidSyntheticHardPeer80Output(
  participantCase: HardPeer80ValidationContext['participantCase'],
  stage: HardPeer80Stage
): HardPeer80PublicOutput {
  return {
    schemaVersion: HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
    stage,
    answer: {
      status: 'ANSWER',
      summary: 'Synthetic H0 answer for contract and prompt materialization only.',
      selectedOptionIds: [participantCase.options[0]!.id],
      confidence: 0.5
    },
    certificate: {
      kind: 'DIRECT',
      statement: 'Synthetic H0 certificate cites only the participant prompt.',
      evidence: [promptEvidence()],
      payload: stage === 'PROBE' ? null : falseTypedCertificatePayload()
    },
    claims: participantCase.propositions.map((proposition, index) => ({
      id: `claim-${index + 1}`,
      propositionId: proposition.id,
      stance: 'ACCEPT' as const,
      statement: 'Synthetic H0 proposition assessment.',
      evidence: [promptEvidence()],
      assumptionIds: [],
      confidence: 0.5
    })),
    assumptions: [],
    requests: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No issue is introduced in the synthetic happy path.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    abstention: null
  };
}

function falseTypedCertificatePayload(): NonNullable<HardPeer80PublicOutput['certificate']['payload']> {
  return {
    kind: 'BOOLEAN_TRUTH_TABLE',
    variableOrder: ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'],
    satisfyingAssignments: ['0000000000'],
    queryTrueAssignments: [],
    queryFalseAssignments: ['0000000000'],
    classification: 'CONTRADICTED'
  };
}

function buildAdversarialFixtures(
  record: HardPeer80ParticipantRecord
): HardPeer80H0ContractFixture[] {
  const participantCase = record.participantCase;
  const initial = buildValidSyntheticHardPeer80Output(participantCase, 'INITIAL');
  const a0 = artifact('A0', 'POSITION', 'AUTHOR', initial);
  const initialContext = context(participantCase, 'INITIAL', 'A0', []);
  const workbenchContext = context(participantCase, 'WORKBENCH_1', 'W1', [a0]);
  const selfContext = context(participantCase, 'SELF_REVIEW', 'S1', [a0]);
  const peerContext = context(participantCase, 'PEER_CRITIQUE', 'P1', [a0]);
  const peerIssue = withIssue(
    buildValidSyntheticHardPeer80Output(participantCase, 'PEER_CRITIQUE'),
    participantCase
  );
  const p1 = artifact('P1', 'REVIEW', 'PEER', peerIssue);
  const authorContext = context(participantCase, 'AUTHOR_RESPONSE', 'AP1', [a0, p1]);
  const authorAccept = withResponse(
    buildValidSyntheticHardPeer80Output(participantCase, 'AUTHOR_RESPONSE'),
    participantCase,
    'ACCEPT',
    false
  );
  const fixtures: HardPeer80H0ContractFixture[] = [];
  const add = (
    fixtureId: string,
    concern: HardPeer80H0ContractFixture['concern'],
    fixtureContext: HardPeer80ValidationContext,
    output: unknown,
    expectedAccepted: boolean
  ) => fixtures.push(evaluateFixture(
    fixtureId,
    concern,
    fixtureContext,
    output,
    expectedAccepted
  ));

  add('PROBE_NULL_CERTIFICATE_PAYLOAD_ACCEPTED', 'CERTIFICATE_PAYLOAD', context(
    HARD_PEER_80_PROBE_CASE, 'PROBE', 'PROBE', []
  ), buildValidSyntheticHardPeer80Output(HARD_PEER_80_PROBE_CASE, 'PROBE'), true);
  add('INITIAL_SCHEMA_VALID_FALSE_CERTIFICATE_ACCEPTED', 'CERTIFICATE_PAYLOAD',
    initialContext, initial, true);
  const nullCertificate = structuredClone(initial);
  nullCertificate.certificate.payload = null;
  add('INITIAL_NULL_CERTIFICATE_PAYLOAD_REJECTED', 'CERTIFICATE_PAYLOAD',
    initialContext, nullCertificate, false);
  const initialIssue = structuredClone(initial);
  initialIssue.issues = [issue(participantCase, 'CASE')];
  initialIssue.resolution = unresolvedResolution('issue-1');
  add('INITIAL_ISSUE_REJECTED', 'CRITIQUE_TARGETING', initialContext, initialIssue, false);
  add('INITIAL_UNKNOWN_SCHEMA_FIELD_REJECTED', 'SCHEMA', initialContext, {
    ...initial, hiddenReasoning: 'forbidden'
  }, false);
  add('INITIAL_WRONG_STAGE_REJECTED', 'STAGE', initialContext, {
    ...initial, stage: 'SELF_REVIEW'
  }, false);
  add('WORKBENCH_NO_ISSUE_ACCEPTED', 'CRITIQUE_TARGETING', workbenchContext,
    buildValidSyntheticHardPeer80Output(participantCase, 'WORKBENCH_1'), true);
  add('SELF_REVIEW_NO_ISSUE_ACCEPTED', 'CRITIQUE_TARGETING', selfContext,
    buildValidSyntheticHardPeer80Output(participantCase, 'SELF_REVIEW'), true);
  add('PEER_NO_ISSUE_ACCEPTED', 'CRITIQUE_TARGETING', peerContext,
    buildValidSyntheticHardPeer80Output(participantCase, 'PEER_CRITIQUE'), true);
  add('PEER_MATERIAL_ISSUE_ACCEPTED', 'CRITIQUE_TARGETING', peerContext, peerIssue, true);
  const optionIssue = withSpecificIssue(
    buildValidSyntheticHardPeer80Output(participantCase, 'PEER_CRITIQUE'),
    answerSelectionIssue(participantCase)
  );
  add('PEER_ANSWER_SELECTION_ISSUE_ACCEPTED', 'CRITIQUE_TARGETING', peerContext,
    optionIssue, true);
  const stateIssue = withSpecificIssue(
    buildValidSyntheticHardPeer80Output(participantCase, 'PEER_CRITIQUE'),
    epistemicStateIssue()
  );
  add('PEER_EPISTEMIC_STATE_ISSUE_ACCEPTED', 'CRITIQUE_TARGETING', peerContext,
    stateIssue, true);
  const typedCertificateIssue = withSpecificIssue(
    buildValidSyntheticHardPeer80Output(participantCase, 'PEER_CRITIQUE'),
    certificateIssue()
  );
  add('PEER_CERTIFICATE_ISSUE_ACCEPTED', 'CRITIQUE_TARGETING', peerContext,
    typedCertificateIssue, true);
  const mismatchedComponent = structuredClone(peerIssue) as unknown as {
    issues: Array<Record<string, unknown>>;
  };
  mismatchedComponent.issues[0]!.targetPropositionId = null;
  add('PEER_COMPONENT_PROPOSITION_MISMATCH_REJECTED', 'CRITIQUE_TARGETING', peerContext,
    mismatchedComponent, false);
  const caseTarget = structuredClone(peerIssue);
  caseTarget.issues[0]!.targetArtifactId = 'CASE';
  add('PEER_CASE_TARGET_REJECTED', 'CRITIQUE_TARGETING', peerContext, caseTarget, false);
  const artifactEvidence = structuredClone(peerIssue);
  artifactEvidence.issues[0]!.evidence[0]!.evidenceId = 'A0';
  add('PEER_ARTIFACT_AS_FACTUAL_EVIDENCE_REJECTED', 'EVIDENCE_PROVENANCE', peerContext,
    artifactEvidence, false);
  const noEvidence = structuredClone(peerIssue);
  noEvidence.issues[0]!.evidence = [];
  add('PEER_MATERIAL_ISSUE_WITHOUT_EVIDENCE_REJECTED', 'EVIDENCE_PROVENANCE', peerContext,
    noEvidence, false);
  add('AUTHOR_ACCEPT_RESPONSE_ACCEPTED', 'DIRECT_RESPONSE', authorContext, authorAccept, true);
  const certificateP1 = artifact('P1', 'REVIEW', 'PEER', typedCertificateIssue);
  const certificateAuthorContext = context(
    participantCase,
    'AUTHOR_RESPONSE',
    'AP1',
    [a0, certificateP1]
  );
  const certificateAuthorAccept = withResponse(
    buildValidSyntheticHardPeer80Output(participantCase, 'AUTHOR_RESPONSE'),
    participantCase,
    'ACCEPT',
    false,
    { component: 'CERTIFICATE', propositionId: null }
  );
  add('AUTHOR_CERTIFICATE_CHANGED_TARGET_ACCEPTED', 'DIRECT_RESPONSE',
    certificateAuthorContext, certificateAuthorAccept, true);
  const duplicateChangedTarget = structuredClone(authorAccept);
  duplicateChangedTarget.responses[0]!.changedTargets.push(
    structuredClone(duplicateChangedTarget.responses[0]!.changedTargets[0]!)
  );
  add('AUTHOR_DUPLICATE_CHANGED_TARGET_REJECTED', 'DIRECT_RESPONSE', authorContext,
    duplicateChangedTarget, false);
  add('AUTHOR_MISSING_DIRECT_RESPONSE_REJECTED', 'DIRECT_RESPONSE', authorContext,
    buildValidSyntheticHardPeer80Output(participantCase, 'AUTHOR_RESPONSE'), false);
  const wrongArtifact = structuredClone(authorAccept);
  wrongArtifact.responses[0]!.targetArtifactId = 'A0';
  add('AUTHOR_WRONG_ARTIFACT_RESPONSE_REJECTED', 'DIRECT_RESPONSE', authorContext,
    wrongArtifact, false);
  const duplicate = structuredClone(authorAccept);
  duplicate.responses.push({ ...structuredClone(duplicate.responses[0]!), id: 'response-2' });
  add('AUTHOR_DUPLICATE_RESPONSE_REJECTED', 'DIRECT_RESPONSE', authorContext, duplicate, false);
  const acceptUnresolved = structuredClone(authorAccept);
  acceptUnresolved.resolution = unresolvedResolution('issue-1');
  add('AUTHOR_ACCEPT_MARKED_UNRESOLVED_REJECTED', 'RESOLUTION_ACCOUNTING', authorContext,
    acceptUnresolved, false);
  const finalNewIssue = structuredClone(authorAccept);
  finalNewIssue.issues = [issue(participantCase, 'A0')];
  add('AUTHOR_NEW_ISSUE_REJECTED', 'CRITIQUE_TARGETING', authorContext, finalNewIssue, false);
  const partial = withResponse(
    buildValidSyntheticHardPeer80Output(participantCase, 'AUTHOR_RESPONSE'),
    participantCase,
    'PARTIAL',
    true
  );
  add('AUTHOR_PARTIAL_PRESERVES_DISAGREEMENT_ACCEPTED', 'DISAGREEMENT_PRESERVATION',
    authorContext, partial, true);
  const silentPartial = structuredClone(partial);
  silentPartial.disagreements = [];
  silentPartial.resolution = resolvedResolution('issue-1');
  add('AUTHOR_PARTIAL_SILENT_RESOLUTION_REJECTED', 'DISAGREEMENT_PRESERVATION',
    authorContext, silentPartial, false);
  const uncertain = structuredClone(initial);
  uncertain.answer.status = 'UNCERTAIN';
  uncertain.answer.selectedOptionIds = [];
  uncertain.certificate.payload = null;
  uncertain.claims.forEach((claim) => {
    claim.stance = 'OPEN';
    claim.evidence = [];
  });
  add('INITIAL_UNCERTAIN_NULL_CERTIFICATE_PAYLOAD_ACCEPTED', 'UNCERTAINTY_ABSTENTION',
    initialContext, uncertain, true);
  const abstain = structuredClone(uncertain);
  abstain.answer.status = 'ABSTAIN';
  abstain.abstention = {
    reason: 'OUTSIDE_CAPABILITY',
    summary: 'The synthetic actor explicitly abstains.',
    propositionIds: [participantCase.propositions[0]!.id],
    whatWouldResolve: null
  };
  add('INITIAL_EXPLICIT_ABSTENTION_ACCEPTED', 'UNCERTAINTY_ABSTENTION', initialContext,
    abstain, true);
  const missingAbstention = structuredClone(abstain);
  missingAbstention.abstention = null;
  add('INITIAL_ABSTENTION_WITHOUT_RECORD_REJECTED', 'UNCERTAINTY_ABSTENTION', initialContext,
    missingAbstention, false);
  if (
    fixtures.length !== REQUIRED_FIXTURE_IDS.length ||
    REQUIRED_FIXTURE_IDS.some((id) => !fixtures.some((fixture) => fixture.fixtureId === id))
  ) {
    throw new Error('HARD-PEER-80 adversarial H0 fixture set is incomplete.');
  }
  return fixtures;
}

function independentlyVerifyOraclePartition(
  participants: HardPeer80ParticipantCorpus,
  oracles: readonly HardPeer80OracleRecord[]
): HardPeer80H0OracleVerification[] {
  const participantMap = new Map(participants.records.map((record) => [record.caseId, record]));
  return oracles.map((oracle) => {
    const participant = participantMap.get(oracle.caseId);
    if (!participant) throw new Error(`Independent verifier has no case ${oracle.caseId}.`);
    verifyAtomicClaimBinding(participant, oracle);
    const acceptedOption = participant.participantCase.options.find(
      ({ id }) => id === oracle.acceptedOptionIds[0]
    );
    if (!acceptedOption) throw new Error(`Independent verifier has no accepted option for ${oracle.caseId}.`);
    switch (oracle.certificate.kind) {
      case 'FORBIDDEN_DIFFERENCE_MATCHING':
        verifyForbiddenDifferenceCertificate(oracle.certificate);
        break;
      case 'BOOLEAN_TRUTH_TABLE':
        verifyBooleanCertificate(oracle.caseId, oracle.certificate);
        break;
      case 'CLOCK_OFFSET_WITNESSES':
        verifyClockCertificate(oracle.certificate);
        break;
      case 'CONTINGENCY_EXPECTATION_BOUNDS':
        verifyContingencyCertificate(oracle.certificate);
        break;
      case 'SCOPED_REVISION_TRACE':
        verifyScopedRevisionCertificate(oracle.certificate);
        break;
      case 'RUN_PROJECTION_TRACES':
        verifyRunProjectionCertificate(oracle.certificate);
        break;
      case 'IDEMPOTENT_CREATE_CRASH_TABLE':
        verifyIdempotentCreateCertificate(oracle.certificate);
        break;
      case 'INDISTINGUISHABLE_CRASH_WORLDS':
        verifyIndistinguishableWorldsCertificate(oracle.certificate, acceptedOption.text);
        break;
    }
    independentlyVerifyCertificateRepresentation(participant, oracle, acceptedOption.text);
    const validCertificateOutput = buildOracleScoringOutput(participant, oracle);
    const contractValidation = validateHardPeer80Output(
      validCertificateOutput,
      context(participant.participantCase, 'INITIAL', 'A0', [])
    );
    if (!contractValidation.ok) {
      throw new Error(`Typed oracle certificate output is contract-invalid for ${oracle.caseId}.`);
    }
    const validScore = scoreHardPeer80Output({
      oracle,
      output: validCertificateOutput
    });
    const falseCertificateOutput = structuredClone(validCertificateOutput);
    falseCertificateOutput.certificate.payload = falseTypedCertificatePayload();
    const falseContractValidation = validateHardPeer80Output(
      falseCertificateOutput,
      context(participant.participantCase, 'INITIAL', 'A0', [])
    );
    const falseScore = scoreHardPeer80Output({
      oracle,
      output: falseCertificateOutput
    });
    if (
      validScore.fullyCorrect !== true ||
      validScore.certificateSemanticValidity !== true ||
      !falseContractValidation.ok ||
      falseScore.fullyCorrect !== false ||
      falseScore.certificateSemanticValidity !== false
    ) {
      throw new Error(`Deterministic typed-certificate scoring failed for ${oracle.caseId}.`);
    }
    return {
      caseId: oracle.caseId,
      domain: oracle.domain,
      certificateKind: oracle.certificate.kind,
      independentlyVerified: true,
      validTypedCertificateAccepted: true,
      falseTypedCertificateRejected: true
    };
  });
}

function independentlyVerifyCertificateRepresentation(
  participant: HardPeer80ParticipantRecord,
  oracle: HardPeer80OracleRecord,
  acceptedOptionText: string
): void {
  const certificate = structuredClone(oracle.certificate);
  switch (certificate.kind) {
    case 'BOOLEAN_TRUTH_TABLE': {
      if (
        !participant.participantCase.question.includes('exhaustively list every premise-satisfying') ||
        !participant.participantCase.question.includes('encode true as 1 and false as 0')
      ) {
        throw new Error('Independent Boolean verifier found an undisclosed certificate encoding.');
      }
      certificate.satisfyingAssignments.pop();
      expectIndependentCertificateRejection(
        () => verifyBooleanCertificate(oracle.caseId, certificate),
        'decisive-only Boolean table'
      );
      return;
    }
    case 'CLOCK_OFFSET_WITNESSES':
      certificate.worlds.forEach((world, index) => { world.name = `independent-world-${index}`; });
      verifyClockCertificate(certificate);
      return;
    case 'SCOPED_REVISION_TRACE':
      certificate.repair.scopeUpdatesToRequestedSessionBeforeLatestSelection = false;
      expectIndependentCertificateRejection(
        () => verifyScopedRevisionCertificate(certificate),
        'false scoped-revision repair'
      );
      return;
    case 'RUN_PROJECTION_TRACES':
      certificate.repair.deriveStatusAfterEvidenceAccumulation = false;
      expectIndependentCertificateRejection(
        () => verifyRunProjectionCertificate(certificate),
        'false run-projection repair'
      );
      return;
    case 'IDEMPOTENT_CREATE_CRASH_TABLE': {
      certificate.crashScenarios.reverse();
      verifyIdempotentCreateCertificate(certificate);
      certificate.crashScenarios[0]!.remoteIdEventuallyRecoverable = false;
      expectIndependentCertificateRejection(
        () => verifyIdempotentCreateCertificate(certificate),
        'false idempotent-create scenario'
      );
      return;
    }
    case 'INDISTINGUISHABLE_CRASH_WORLDS': {
      const oldNames = certificate.worlds.map(({ name }) => name);
      certificate.worlds.forEach((world, index) => {
        world.name = `independent-world-${index}`;
        world.durableLocalState = 'independent-shared-observation';
      });
      certificate.recoveryChoices.forEach((choice, index) => {
        choice.choice = `independent-choice-${index}`;
        choice.world = choice.world === oldNames[0]
          ? certificate.worlds[0]!.name
          : certificate.worlds[1]!.name;
      });
      verifyIndistinguishableWorldsCertificate(certificate, acceptedOptionText);
      certificate.recoveryChoices[0]!.sendsInterrupt =
        certificate.recoveryChoices[1]!.sendsInterrupt;
      expectIndependentCertificateRejection(
        () => verifyIndistinguishableWorldsCertificate(certificate, acceptedOptionText),
        'false indistinguishable-world recovery semantics'
      );
      return;
    }
    case 'FORBIDDEN_DIFFERENCE_MATCHING':
    case 'CONTINGENCY_EXPECTATION_BOUNDS':
      return;
  }
}

function expectIndependentCertificateRejection(check: () => void, label: string): void {
  try {
    check();
  } catch {
    return;
  }
  throw new Error(`Independent certificate verifier accepted ${label}.`);
}

function buildOracleScoringOutput(
  participant: HardPeer80ParticipantRecord,
  oracle: HardPeer80OracleRecord
): HardPeer80PublicOutput {
  const output = buildValidSyntheticHardPeer80Output(participant.participantCase, 'INITIAL');
  const expectedById = new Map(oracle.atomicClaims.map((claim) => [claim.id, claim.expected]));
  output.answer.status = oracle.acceptedStatus;
  output.answer.selectedOptionIds = [...oracle.acceptedOptionIds];
  output.certificate.kind = oracle.acceptedCertificateKinds[0]!;
  output.certificate.payload = structuredClone(oracle.certificate);
  output.claims.forEach((claim) => {
    const expected = expectedById.get(claim.propositionId);
    if (!expected) throw new Error(`Missing atomic claim ${oracle.caseId}/${claim.propositionId}.`);
    claim.stance = expected;
    claim.evidence.forEach((reference) => {
      reference.relation = expected === 'ACCEPT'
        ? 'SUPPORTS'
        : expected === 'REJECT'
          ? 'CONTRADICTS'
          : 'LIMITS';
    });
  });
  return output;
}

function verifyAtomicClaimBinding(
  participant: HardPeer80ParticipantRecord,
  oracle: HardPeer80OracleRecord
): void {
  const expectedStances: Record<string, Array<'ACCEPT' | 'REJECT'>> = {
    'HP80-CAL-MATH-01': ['ACCEPT', 'ACCEPT', 'ACCEPT', 'ACCEPT'],
    'HP80-CAL-LOGIC-01': ['ACCEPT', 'ACCEPT', 'ACCEPT'],
    'HP80-CAL-HIDDEN-01': ['REJECT', 'REJECT', 'ACCEPT'],
    'HP80-CAL-DEBUG-01': ['ACCEPT', 'ACCEPT', 'REJECT', 'REJECT', 'ACCEPT'],
    'HP80-CAL-TECH-01': ['ACCEPT', 'ACCEPT', 'ACCEPT', 'ACCEPT'],
    'HP80-EVAL-MATH-01': ['ACCEPT', 'ACCEPT', 'ACCEPT', 'ACCEPT'],
    'HP80-EVAL-LOGIC-01': ['ACCEPT', 'REJECT', 'ACCEPT'],
    'HP80-EVAL-HIDDEN-01': ['REJECT', 'REJECT', 'ACCEPT', 'ACCEPT'],
    'HP80-EVAL-DEBUG-01': ['ACCEPT', 'ACCEPT', 'REJECT', 'REJECT', 'REJECT', 'ACCEPT'],
    'HP80-EVAL-TECH-01': ['REJECT', 'REJECT', 'REJECT', 'ACCEPT']
  };
  const expected = expectedStances[oracle.caseId];
  if (!expected || expected.length !== participant.participantCase.propositions.length) {
    throw new Error(`Independent atomic-claim verifier has no contract for ${oracle.caseId}.`);
  }
  for (const [index, proposition] of participant.participantCase.propositions.entries()) {
    const atomic = oracle.atomicClaims.find(({ id }) => id === proposition.id);
    if (atomic?.text !== proposition.text || atomic.expected !== expected[index]) {
      throw new Error(
        `Oracle atomic claim drifts from participant proposition ${oracle.caseId}/${proposition.id}.`
      );
    }
  }
}

function verifyForbiddenDifferenceCertificate(
  certificate: Extract<HardPeer80OracleRecord['certificate'], {
    kind: 'FORBIDDEN_DIFFERENCE_MATCHING'
  }>
): void {
  const construction = new Set(certificate.construction);
  const special = new Set(certificate.specialElements);
  const matchingVertices = new Set<number>();
  const validConstruction =
    construction.size === certificate.optimum &&
    [...construction].every((value) => value >= 1 && value <= certificate.universeSize) &&
    [...construction].filter((value) => special.has(value)).length === certificate.exactSpecialCount &&
    [...construction].every((left) => [...construction].every((right) =>
      left === right || !certificate.forbiddenDifferences.includes(Math.abs(left - right))
    ));
  let validMatching = true;
  for (const [left, right] of certificate.upperBoundMatching) {
    if (
      left < 1 || right > certificate.universeSize || left === right ||
      matchingVertices.has(left) || matchingVertices.has(right) ||
      !certificate.forbiddenDifferences.includes(Math.abs(left - right))
    ) validMatching = false;
    matchingVertices.add(left);
    matchingVertices.add(right);
  }
  const upperBound = certificate.universeSize - certificate.upperBoundMatching.length;
  if (!validConstruction || !validMatching || upperBound !== certificate.optimum) {
    throw new Error('Independent forbidden-difference certificate verification failed.');
  }
}

function verifyBooleanCertificate(
  caseId: string,
  certificate: Extract<HardPeer80OracleRecord['certificate'], { kind: 'BOOLEAN_TRUTH_TABLE' }>
): void {
  const assignments: string[] = [];
  const queryTrue: string[] = [];
  const queryFalse: string[] = [];
  const variables = certificate.variableOrder;
  for (let mask = 0; mask < 2 ** variables.length; mask += 1) {
    const bits = variables.map((_, index) => Boolean(mask & (1 << (variables.length - index - 1))));
    const values = Object.fromEntries(variables.map((variable, index) => [variable, bits[index]!])) as Record<string, boolean>;
    const { premises, query } = evaluateBooleanCase(caseId, values);
    if (!premises) continue;
    const encoded = bits.map((value) => value ? '1' : '0').join('');
    assignments.push(encoded);
    (query ? queryTrue : queryFalse).push(encoded);
  }
  const classification = queryTrue.length === 0
    ? 'CONTRADICTED'
    : queryFalse.length === 0
      ? 'ENTAILED'
      : 'OPEN';
  if (
    stableJson(assignments) !== stableJson(certificate.satisfyingAssignments) ||
    stableJson(queryTrue) !== stableJson(certificate.queryTrueAssignments) ||
    stableJson(queryFalse) !== stableJson(certificate.queryFalseAssignments) ||
    classification !== certificate.classification
  ) {
    throw new Error(`Independent Boolean enumeration failed for ${caseId}.`);
  }
}

function evaluateBooleanCase(
  caseId: string,
  v: Record<string, boolean>
): { premises: boolean; query: boolean } {
  const xor = (left: boolean, right: boolean) => left !== right;
  const iff = (left: boolean, right: boolean) => left === right;
  const implies = (left: boolean, right: boolean) => !left || right;
  const exactly = (count: number, values: boolean[]) => values.filter(Boolean).length === count;
  if (caseId === 'HP80-CAL-LOGIC-01') {
    const premises = [
      exactly(2, [v.A!, v.B!, v.C!, v.D!]),
      iff(v.E!, xor(v.A!, v.C!)),
      iff(v.F!, (v.B! && !v.D!) || (v.C! && v.D!)),
      implies(v.G!, xor(v.E!, v.F!)),
      iff(v.H!, v.G! || (v.A! && !v.F!)),
      iff(v.I!, xor(v.H!, v.D!)),
      iff(v.J!, (v.I! && v.B!) || (!v.H! && v.C!)),
      exactly(2, [v.E!, v.F!, v.G!, v.I!, v.J!]),
      implies(v.A!, !v.B!),
      implies(v.C!, v.G! || v.J!)
    ].every(Boolean);
    return { premises, query: v.D! && !v.F! };
  }
  if (caseId === 'HP80-EVAL-LOGIC-01') {
    const premises = [
      exactly(2, [v.P!, v.Q!, v.R!, v.S!]),
      iff(v.T!, xor(v.P!, v.R!)),
      implies(v.U!, v.Q! && !v.S!),
      iff(v.V!, (v.T! && v.U!) || (v.S! && !v.Q!)),
      implies(v.W!, xor(v.V!, v.R!)),
      v.W! || v.U!,
      implies(v.P!, !v.Q!),
      iff(v.X!, xor(v.P!, v.V!)),
      iff(v.Y!, (v.W! && !v.U!) || v.Q!)
    ].every(Boolean);
    return { premises, query: implies(v.T! && v.Y!, v.Q!) };
  }
  throw new Error(`No independent Boolean verifier for ${caseId}.`);
}

function verifyClockCertificate(
  certificate: Extract<HardPeer80OracleRecord['certificate'], { kind: 'CLOCK_OFFSET_WITNESSES' }>
): void {
  const observedRelativeRange: [number, number] = [2, 6];
  if (stableJson(certificate.relativeOffsetRange) !== stableJson(observedRelativeRange)) {
    throw new Error('Independent clock relative-offset bound failed.');
  }
  const truthValues = new Set<boolean>();
  for (const world of certificate.worlds) {
    const latency = (31 - world.offsetB) - (24 - world.offsetA);
    const leaseA: [number, number] = [12 - world.offsetA, 26 - world.offsetA];
    const leaseB: [number, number] = [32 - world.offsetB, 46 - world.offsetB];
    const noOverlap = leaseA[1] < leaseB[0] || leaseB[1] < leaseA[0];
    if (
      world.offsetA < certificate.offsetRange[0] || world.offsetA > certificate.offsetRange[1] ||
      world.offsetB < certificate.offsetRange[0] || world.offsetB > certificate.offsetRange[1] ||
      latency !== world.latency || latency < certificate.latencyRange[0] ||
      latency > certificate.latencyRange[1] ||
      stableJson(leaseA) !== stableJson(world.leaseAUtc) ||
      stableJson(leaseB) !== stableJson(world.leaseBUtc) ||
      noOverlap !== world.claimTrue
    ) throw new Error('Independent clock witness verification failed.');
    truthValues.add(noOverlap);
  }
  if (truthValues.size !== 2) throw new Error('Clock witnesses do not establish OPEN.');
}

function verifyContingencyCertificate(
  certificate: Extract<HardPeer80OracleRecord['certificate'], {
    kind: 'CONTINGENCY_EXPECTATION_BOUNDS'
  }>
): void {
  const lower = Math.max(0, certificate.initialPositive + certificate.flagged - certificate.population);
  const upper = Math.min(certificate.initialPositive, certificate.flagged);
  const expected = (intersection: number) =>
    certificate.initialPositive - certificate.repairProbability * intersection +
    certificate.damageProbability * (certificate.flagged - intersection);
  const range = [expected(upper), expected(lower)];
  const threshold = Math.floor(
    (certificate.finalExpectationIntercept - certificate.initialPositive) /
    -certificate.finalExpectationSlope
  ) + 1;
  if (
    stableJson([lower, upper]) !== stableJson(certificate.intersectionRange) ||
    stableJson(range) !== stableJson(certificate.finalExpectationRange) ||
    threshold !== certificate.strictImprovementMinimumIntegerIntersection ||
    certificate.witnessTables.some((table) =>
      table.flaggedGood !== certificate.flagged - table.intersection ||
      table.unflaggedDefective !== certificate.initialPositive - table.intersection ||
      table.unflaggedGood !== certificate.population - certificate.initialPositive - table.flaggedGood ||
      table.finalExpectation !== expected(table.intersection)
    )
  ) throw new Error('Independent contingency-table verification failed.');
}

function verifyScopedRevisionCertificate(
  certificate: Extract<HardPeer80OracleRecord['certificate'], { kind: 'SCOPED_REVISION_TRACE' }>
): void {
  const current = new Map<string, (typeof certificate.updates)[number]>();
  for (const update of certificate.updates) {
    const old = current.get(update.item);
    if (!old || update.revision > old.revision) current.set(update.item, update);
  }
  const currentOutput = [...current.values()]
    .filter((update) => update.session === certificate.requestedSession && update.state === 'done')
    .map(({ item }) => item)
    .sort();
  const scoped = new Map<string, (typeof certificate.updates)[number]>();
  for (const update of certificate.updates.filter(
    ({ session }) => session === certificate.requestedSession
  )) {
    const old = scoped.get(update.item);
    if (!old || BigInt(update.revision) > BigInt(old.revision)) scoped.set(update.item, update);
  }
  const requiredOutput = [...scoped.values()]
    .filter(({ state }) => state === 'done')
    .map(({ item }) => item)
    .sort();
  if (
    stableJson(currentOutput) !== stableJson(certificate.currentOutput) ||
    stableJson(requiredOutput) !== stableJson(certificate.requiredOutput) ||
    !certificate.repair.scopeUpdatesToRequestedSessionBeforeLatestSelection ||
    !certificate.repair.compareRevisionsAsExactNonnegativeIntegers
  ) throw new Error('Independent scoped-revision trace verification failed.');
}

function verifyRunProjectionCertificate(
  certificate: Extract<HardPeer80OracleRecord['certificate'], { kind: 'RUN_PROJECTION_TRACES' }>
): void {
  for (const trace of certificate.traces) {
    let lastOrdinal = 0;
    let providerDone = false;
    let status: 'running' | 'interrupted' | 'completed' = 'running';
    for (const [runId, ordinal, kind] of trace.events) {
      if (ordinal <= lastOrdinal) continue;
      lastOrdinal = ordinal;
      if (runId !== certificate.activeRunId) continue;
      if (kind === 'provider-completed') providerDone = true;
      else if (kind === 'process-exit' && !providerDone) status = 'interrupted';
      else if (kind === 'report-verified' && status === 'running') status = 'completed';
    }
    const active = trace.events.filter(([runId]) => runId === certificate.activeRunId);
    const sawVerified = active.some(([, , kind]) => kind === 'report-verified');
    const sawExit = active.some(([, , kind]) => kind === 'process-exit');
    const required = sawVerified ? 'completed' : sawExit ? 'interrupted' : 'running';
    if (status !== trace.current || required !== trace.required) {
      throw new Error(`Independent run projection trace ${trace.name} failed.`);
    }
  }
  if (
    !certificate.repair.scopeOrdinalFilteringToActiveRun ||
    !certificate.repair.treatProviderCompletionAsTelemetryOnly ||
    !certificate.repair.deriveStatusAfterEvidenceAccumulation
  ) throw new Error('Independent run-projection repair verification failed.');
}

function verifyIdempotentCreateCertificate(
  certificate: Extract<HardPeer80OracleRecord['certificate'], {
    kind: 'IDEMPOTENT_CREATE_CRASH_TABLE'
  }>
): void {
  const progressStates = certificate.crashScenarios.map((scenario) => [
    scenario.providerCreateAppliedBeforeCrash,
    scenario.createReplyReceivedBeforeCrash,
    scenario.remoteIdPersistedBeforeCrash
  ].map((value) => value ? '1' : '0').join('')).sort();
  if (
    !certificate.durableKeyBeforeCall ||
    !certificate.sameKeyOnRecovery ||
    !certificate.providerIdempotentByKey ||
    !certificate.providerLookupByKey ||
    !certificate.workflowRequiresLocalVerification ||
    stableJson(progressStates) !== stableJson(['000', '100', '110', '111']) ||
    certificate.crashScenarios.some((scenario) =>
      scenario.recoveryContactsProvider !== !scenario.remoteIdPersistedBeforeCrash ||
      !scenario.recoveryUsesPersistedKey ||
      !scenario.atMostOneRemoteTurn ||
      !scenario.remoteIdEventuallyRecoverable
    )
  ) throw new Error('Independent idempotent-create crash-table verification failed.');
}

function verifyIndistinguishableWorldsCertificate(
  certificate: Extract<HardPeer80OracleRecord['certificate'], {
    kind: 'INDISTINGUISHABLE_CRASH_WORLDS'
  }>,
  acceptedOptionText: string
): void {
  const worldNames = new Set(certificate.worlds.map(({ name }) => name));
  const choiceNames = new Set(certificate.recoveryChoices.map(({ choice }) => choice));
  const states = new Set(certificate.worlds.map(({ durableLocalState }) => durableLocalState));
  const appliedCounts = new Set(certificate.worlds.map(({ providerAppliedCount }) => providerAppliedCount));
  const sends = certificate.recoveryChoices.find(({ sendsInterrupt }) => sendsInterrupt);
  const doesNotSend = certificate.recoveryChoices.find(({ sendsInterrupt }) => !sendsInterrupt);
  const sendsWorld = certificate.worlds.find(({ name }) => name === sends?.world);
  const doesNotSendWorld = certificate.worlds.find(({ name }) => name === doesNotSend?.world);
  if (
    acceptedOptionText !== 'IMPOSSIBLE' ||
    certificate.worlds.length !== 2 ||
    worldNames.size !== 2 ||
    certificate.worlds.some(({ name, durableLocalState }) =>
      !name.trim() || !durableLocalState.trim()
    ) ||
    states.size !== 1 ||
    stableJson([...appliedCounts].sort()) !== stableJson([0, 1]) ||
    certificate.recoveryChoices.length !== 2 ||
    choiceNames.size !== 2 ||
    certificate.recoveryChoices.some(({ choice, world }) =>
      !choice.trim() || !worldNames.has(world)
    ) ||
    sends?.violates !== 'SAFETY' ||
    sendsWorld?.providerAppliedCount !== 1 ||
    doesNotSend?.violates !== 'LIVENESS' ||
    doesNotSendWorld?.providerAppliedCount !== 0
  ) throw new Error('Independent indistinguishable-worlds verification failed.');
}

function assertPlanTopology(plan: HardPeer80Plan): void {
  const evaluationBlocks = new Set(
    plan.assignments.filter(({ phase }) => phase === 'EVALUATION').map(({ blockId }) => blockId)
  );
  if (
    plan.assignments.length !== 76 ||
    plan.assignments.filter(({ phase }) => phase === 'BOUNDARY_PROBE').length !== 1 ||
    plan.assignments.filter(({ phase }) => phase === 'CALIBRATION').length !== 5 ||
    plan.assignments.filter(({ phase }) => phase === 'EVALUATION').length !== 70 ||
    evaluationBlocks.size !== 10 ||
    plan.forks.length !== 30 ||
    plan.forks.some(({ timing, consumesProviderModelCall }) =>
      timing !== 'AFTER_A0_BEFORE_ANY_BRANCH_CALL' || consumesProviderModelCall
    )
  ) throw new Error('HARD-PEER-80 H0 topology does not match the terminal 76-call plan.');
  for (const blockId of evaluationBlocks) {
    const blockForks = plan.forks.filter((fork) => fork.blockId === blockId);
    const blockCalls = plan.assignments.filter((assignment) => assignment.blockId === blockId);
    if (
      blockForks.length !== 3 ||
      blockCalls.length !== 7 ||
      blockForks.some((fork) => fork.sourceCallId !== `${blockId}:A0`)
    ) throw new Error(`HARD-PEER-80 H0 fork topology failed for ${blockId}.`);
  }
}

function assertHardPeer80HarnessValidationReport(
  report: HardPeer80HarnessValidationReport,
  locks: LabComponentLock,
  plan: HardPeer80Plan
): void {
  if (
    report.schemaVersion !== HARD_PEER_80_HARNESS_VALIDATION_SCHEMA_VERSION ||
    report.validationVersion !== HARD_PEER_80_HARNESS_VALIDATION_VERSION ||
    report.hypothesisId !== 'H0-HARD-PEER-80' ||
    report.status !== 'PASSED' ||
    stableJson(report.componentLocks) !== stableJson(locks) ||
    report.scheduleVersion !== HARD_PEER_80_SCHEDULE_VERSION ||
    report.scheduleSha256 !== plan.schedule.scheduleSha256 ||
    !/^[a-f0-9]{64}$/u.test(report.promptTemplateSetSha256) ||
    report.providerCallCount !== 0 ||
    report.semanticCallExpectation !== 76 ||
    report.calibrationCallExpectation !== 5 ||
    report.evaluationBlockExpectation !== 10 ||
    report.evaluationForkExpectation !== 30 ||
    report.boundaryProbeForkExpectation !== 1 ||
    report.totalNonModelForkExpectation !== 31 ||
    report.prompts.length !== 76 ||
    new Set(report.prompts.map(({ callId }) => callId)).size !== 76 ||
    report.prompts.some((prompt, index) =>
      prompt.callNumber !== index + 1 ||
      !/^[a-f0-9]{64}$/u.test(prompt.promptSha256) ||
      prompt.estimatedPromptTokens <= 0
    ) ||
    report.contractFixtures.length !== REQUIRED_FIXTURE_IDS.length ||
    REQUIRED_FIXTURE_IDS.some((id) => !report.contractFixtures.some((fixture) =>
      fixture.fixtureId === id &&
      fixture.status === 'PASSED' &&
      fixture.expectedAccepted === fixture.observedAccepted
    )) ||
    report.oracleVerifications.length !== 10 ||
    new Set(report.oracleVerifications.map(({ caseId }) => caseId)).size !== 10 ||
    report.oracleVerifications.some(({
      independentlyVerified,
      validTypedCertificateAccepted,
      falseTypedCertificateRejected
    }) => !independentlyVerified ||
      !validTypedCertificateAccepted || !falseTypedCertificateRejected) ||
    new Set(report.oracleVerifications.map(({ domain }) => domain)).size !== HARD_PEER_80_DOMAINS.length ||
    report.checks.length !== REQUIRED_CHECK_IDS.length ||
    REQUIRED_CHECK_IDS.some((id) => !report.checks.some((check) =>
      check.checkId === id && check.status === 'PASSED'
    ))
  ) throw new Error('HARD-PEER-80 H0 report failed independent receipt validation.');
}

function assertH0Manifest(
  manifest: LabRunManifest,
  runId: string,
  locks: LabComponentLock,
  plan: HardPeer80Plan
): void {
  const caseIds = [
    ...plan.schedule.calibrationCaseIds,
    ...new Set(plan.assignments.filter(({ phase }) => phase === 'EVALUATION')
      .map(({ caseId }) => caseId).filter((id): id is string => Boolean(id)))
  ];
  const expected = buildHardPeer80HarnessValidationManifest(
    runId,
    locks,
    caseIds,
    manifest.createdAt
  );
  if (stableJson(manifest) !== stableJson(expected)) {
    throw new Error('HARD-PEER-80 H0 manifest does not match the local-only contract.');
  }
}

function visibleForStage(
  stage: HardPeer80Stage,
  artifacts: Map<string, HardPeer80VisibleArtifact>
): HardPeer80VisibleArtifact[] {
  const ids: HardPeer80VisibleArtifact['artifactId'][] =
    stage === 'WORKBENCH_1' || stage === 'SELF_REVIEW' || stage === 'PEER_CRITIQUE'
      ? ['A0']
      : stage === 'WORKBENCH_FINAL'
        ? ['A0', 'W1']
        : stage === 'SELF_FINAL'
          ? ['A0', 'S1']
          : stage === 'AUTHOR_RESPONSE'
            ? ['A0', 'P1']
            : [];
  return ids.map((id) => {
    const value = artifacts.get(id);
    if (!value) throw new Error(`H0 stage ${stage} is missing visible artifact ${id}.`);
    return structuredClone(value);
  });
}

function visibleArtifactForCurrent(
  stage: HardPeer80Stage,
  output: HardPeer80PublicOutput
): HardPeer80VisibleArtifact | null {
  if (stage === 'INITIAL') return artifact('A0', 'POSITION', 'AUTHOR', output);
  if (stage === 'WORKBENCH_1') return artifact('W1', 'REVIEW', 'AUTHOR', output);
  if (stage === 'SELF_REVIEW') return artifact('S1', 'REVIEW', 'AUTHOR', output);
  if (stage === 'PEER_CRITIQUE') return artifact('P1', 'REVIEW', 'PEER', output);
  return null;
}

function artifact(
  artifactId: HardPeer80VisibleArtifact['artifactId'],
  artifactKind: HardPeer80VisibleArtifact['artifactKind'],
  actor: HardPeer80VisibleArtifact['actor'],
  output: HardPeer80PublicOutput
): HardPeer80VisibleArtifact {
  return { artifactId, artifactKind, actor, output: structuredClone(output) };
}

function context(
  participantCase: HardPeer80ValidationContext['participantCase'],
  stage: HardPeer80Stage,
  currentArtifactId: HardPeer80ValidationContext['currentArtifactId'],
  visibleArtifacts: HardPeer80VisibleArtifact[]
): HardPeer80ValidationContext {
  return { participantCase, stage, currentArtifactId, visibleArtifacts };
}

function withIssue(
  output: HardPeer80PublicOutput,
  participantCase: HardPeer80ValidationContext['participantCase']
): HardPeer80PublicOutput {
  const result = structuredClone(output);
  result.issues = [issue(participantCase, 'A0')];
  result.resolution = unresolvedResolution('issue-1');
  return result;
}

function withSpecificIssue(
  output: HardPeer80PublicOutput,
  candidate: HardPeer80PublicOutput['issues'][number]
): HardPeer80PublicOutput {
  const result = structuredClone(output);
  result.issues = [structuredClone(candidate)];
  result.resolution = unresolvedResolution(candidate.id);
  return result;
}

function issue(
  participantCase: HardPeer80ValidationContext['participantCase'],
  targetArtifactId: string
): HardPeer80PublicOutput['issues'][number] {
  return {
    id: 'issue-1',
    targetArtifactId,
    targetComponent: 'PROPOSITION',
    targetPropositionId: participantCase.propositions[0]!.id,
    kind: 'LOGIC',
    severity: 'MATERIAL',
    proposedStance: 'REJECT',
    proposedStatus: null,
    proposedOptionIds: null,
    proposedCertificate: null,
    statement: 'The targeted proposition conflicts with the cited prompt information.',
    evidence: [promptEvidence()],
    confidence: 0.8
  };
}

function answerSelectionIssue(
  participantCase: HardPeer80ValidationContext['participantCase']
): HardPeer80PublicOutput['issues'][number] {
  return {
    id: 'issue-1',
    targetArtifactId: 'A0',
    targetComponent: 'ANSWER_SELECTION',
    targetPropositionId: null,
    kind: 'LOGIC',
    severity: 'MATERIAL',
    proposedStance: null,
    proposedStatus: null,
    proposedOptionIds: [participantCase.options[1]?.id ?? participantCase.options[0]!.id],
    proposedCertificate: null,
    statement: 'The selected answer does not match the cited prompt information.',
    evidence: [promptEvidence()],
    confidence: 0.8
  };
}

function epistemicStateIssue(): HardPeer80PublicOutput['issues'][number] {
  return {
    id: 'issue-1',
    targetArtifactId: 'A0',
    targetComponent: 'EPISTEMIC_STATE',
    targetPropositionId: null,
    kind: 'MISSING_INFORMATION',
    severity: 'MATERIAL',
    proposedStance: null,
    proposedStatus: 'ANSWER',
    proposedOptionIds: null,
    proposedCertificate: null,
    statement: 'The prompt contains enough information for an answer.',
    evidence: [promptEvidence()],
    confidence: 0.8
  };
}

function certificateIssue(): HardPeer80PublicOutput['issues'][number] {
  return {
    id: 'issue-1',
    targetArtifactId: 'A0',
    targetComponent: 'CERTIFICATE',
    targetPropositionId: null,
    kind: 'EVIDENCE',
    severity: 'MATERIAL',
    proposedStance: null,
    proposedStatus: null,
    proposedOptionIds: null,
    proposedCertificate: falseTypedCertificatePayload(),
    statement: 'The public certificate should be replaced with this complete typed payload.',
    evidence: [promptEvidence()],
    confidence: 0.8
  };
}

function withResponse(
  output: HardPeer80PublicOutput,
  participantCase: HardPeer80ValidationContext['participantCase'],
  disposition: HardPeer80PublicOutput['responses'][number]['disposition'],
  preserveDisagreement: boolean,
  changedTarget: HardPeer80TargetReference = {
    component: 'PROPOSITION',
    propositionId: participantCase.propositions[0]!.id
  }
): HardPeer80PublicOutput {
  const result = structuredClone(output);
  result.responses = [{
    id: 'response-1',
    targetArtifactId: 'P1',
    targetIssueId: 'issue-1',
    disposition,
    statement: 'The author directly addresses the peer issue using the participant prompt.',
    evidence: [promptEvidence()],
    changedTargets: disposition === 'ACCEPT' ? [changedTarget] : []
  }];
  result.resolution = disposition === 'ACCEPT' || disposition === 'REJECT'
    ? resolvedResolution('issue-1')
    : unresolvedResolution('issue-1');
  if (preserveDisagreement) {
    result.disagreements = [{
      id: 'disagreement-1',
      targets: [changedTarget],
      participantArtifactIds: ['A0', 'P1', 'AP1'],
      status: 'UNRESOLVED',
      summary: 'The material issue remains unresolved after the partial response.',
      evidence: [promptEvidence()],
      requestId: null
    }];
  }
  return result;
}

function resolvedResolution(issueId: string): HardPeer80PublicOutput['resolution'] {
  return {
    status: 'RESOLVED',
    basis: 'EVIDENCE',
    summary: 'The issue is directly resolved by visible case evidence.',
    resolvedIssueIds: [issueId],
    unresolvedIssueIds: []
  };
}

function unresolvedResolution(issueId: string): HardPeer80PublicOutput['resolution'] {
  return {
    status: 'UNRESOLVED',
    basis: 'INSUFFICIENT_INFORMATION',
    summary: 'The material issue remains explicit and unresolved.',
    resolvedIssueIds: [],
    unresolvedIssueIds: [issueId]
  };
}

function evaluateFixture(
  fixtureId: string,
  concern: HardPeer80H0ContractFixture['concern'],
  fixtureContext: HardPeer80ValidationContext,
  output: unknown,
  expectedAccepted: boolean
): HardPeer80H0ContractFixture {
  const result = validateHardPeer80Output(output, fixtureContext);
  const observedAccepted = result.ok;
  if (observedAccepted !== expectedAccepted) {
    throw new Error(`HARD-PEER-80 H0 fixture ${fixtureId} did not produce its expected result.`);
  }
  return {
    fixtureId,
    stage: fixtureContext.stage,
    concern,
    expectedAccepted,
    observedAccepted,
    observedErrorCodes: result.ok ? [] : [...new Set(result.errors.map(({ code }) => code))],
    status: 'PASSED'
  };
}

function promptEvidence(): HardPeer80PublicOutput['certificate']['evidence'][number] {
  return {
    evidenceId: 'PROMPT',
    relation: 'SUPPORTS',
    note: 'The participant prompt is the only factual source used by this synthetic fixture.'
  };
}

function pass(checkId: string, detail: string): HardPeer80HarnessValidationReport['checks'][number] {
  return { checkId, status: 'PASSED', detail };
}

async function readRealJson<T>(filePath: string, label: string): Promise<T> {
  await assertRealFile(filePath);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    throw new Error(`HARD-PEER-80 ${label} is not valid JSON.`);
  }
}

async function assertRealFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`HARD-PEER-80 archive input must be a real file: ${filePath}.`);
  }
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`HARD-PEER-80 archive input must be a real directory: ${directory}.`);
  }
}

function safeRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== '..';
}
