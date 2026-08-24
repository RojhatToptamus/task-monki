import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION
} from './contracts';
import {
  H1B_CORPUS_VERSION,
  h1bPublicIntervention,
  loadH1bOracleCorpus,
  loadH1bParticipantCorpus,
  type H1bParticipantCaseRecord
} from './h1bCorpus';
import {
  H1B_ASSIGNMENT_ORDER_VERSION,
  scheduleH1bAssignments,
  type H1bAssignment,
  type H1bH0ValidationReceipt
} from './h1bPlan';
import { H1B_SCORING_VERSION } from './h1bScoring';
import type { H1bSourceLock } from './h1bSourceLock';
import type { H1bValidationReport } from './h1bValidation';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  sha256File,
  sha256Text,
  stableJson,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import { LAB_PROMPT_VERSION } from './prompts';
import { getLabProtocolPlan, LAB_PROTOCOL_VERSION } from './protocols';
import { materializeInitialLabPrompt } from './runner';

export const H1B_HARNESS_VALIDATION_SCHEMA_VERSION =
  'task-monki/discourse-lab-h1b-h0@v1' as const;
export const H1B_HARNESS_VALIDATION_VERSION = 'h1b-h0-validation@v1' as const;

export interface H1bMaterializedPromptRecord {
  assignmentId: string;
  blockId: string;
  caseId: string;
  repetition: 1 | 2 | 3;
  position: 1 | 2 | 3;
  conditionId: H1bAssignment['conditionId'];
  promptArtifactSha256: string;
  estimatedPromptTokens: number;
  prompt: string;
}

export interface H1bHarnessValidationReport {
  schemaVersion: typeof H1B_HARNESS_VALIDATION_SCHEMA_VERSION;
  validationVersion: typeof H1B_HARNESS_VALIDATION_VERSION;
  hypothesisId: 'H0-H1B';
  status: 'PASSED';
  componentLocks: LabComponentLock;
  scheduleVersion: typeof H1B_ASSIGNMENT_ORDER_VERSION;
  scheduleSha256: string;
  promptSetSha256: string;
  maximumEstimatedPromptTokens: number;
  sourceLock: H1bSourceLock;
  checks: Array<{ checkId: string; status: 'PASSED'; detail: string }>;
}

export interface RunH1bHarnessValidationInput {
  fixtureRoot: string;
  validation: H1bValidationReport;
  ledger?: LabArtifactLedger;
}

const MAXIMUM_PROMPT_TOKENS = 7_000;
const REQUIRED_CHECK_IDS = [
  'SEALED_COMPONENT_AND_TRANSITIVE_SOURCE_LOCKS',
  'SIX_CASE_18_BLOCK_54_ASSIGNMENT_MATRIX',
  'LATIN_POSITION_COUNTERBALANCE',
  'BYTE_IDENTICAL_REPETITIONS',
  'CASE_ONLY_HAS_NO_FIXED_PREFIX_OR_SIGNAL',
  'SCORER_TRUTH_FIREWALL',
  'STRUCTURED_CRITIQUE_TARGET',
  'EVIDENCE_IS_NOT_A_CRITIQUE',
  'PREPARED_PROMPT_CEILING',
  'ZERO_PROVIDER_CALLS'
] as const;
const REQUIRED_BOUNDARY_FILES = [
  'src/dev/discourseLab/CodexTextDriver.ts',
  'src/core/agent/codex/CodexAppServerSupervisor.ts',
  'src/core/agent/codex/CodexRpcClient.ts',
  'src/core/agent/codex/CodexPermissionProfile.ts',
  'src/core/discourse/DiscourseWorkspace.ts'
] as const;

export async function runH1bHarnessValidation(
  input: RunH1bHarnessValidationInput
): Promise<H1bHarnessValidationReport> {
  assertComponentLocks(input.validation);
  input.ledger?.assertRunContext('HARNESS_VALIDATION', input.validation.locks);
  await input.ledger?.append({
    eventType: 'H1B_H0_STARTED',
    occurredAt: new Date().toISOString()
  });

  const participants = await loadH1bParticipantCorpus(input.fixtureRoot);
  const { schedule, assignments } = scheduleH1bAssignments(participants.records);
  assertSchedule(assignments, schedule.blockIds);

  const byCase = new Map(participants.records.map((record) => [record.caseId, record]));
  const prompts = assignments.map((assignment) => {
    const record = byCase.get(assignment.caseId);
    if (!record) throw new Error(`H1b H0 cannot resolve ${assignment.caseId}.`);
    return materializeAssignmentPrompt(record, assignment);
  });
  assertRepeatedCellPrompts(prompts);
  assertCaseOnlyBoundary(prompts, byCase);
  assertMechanismProjection(prompts, byCase);

  // Scorer truth is opened only after every participant prompt is frozen.
  const oracles = await loadH1bOracleCorpus(input.fixtureRoot, participants);
  assertTruthFirewall(prompts, oracles);

  const promptSetArtifact = {
    kind: 'H1B_H0_MATERIALIZED_PROMPT_SET',
    scheduleVersion: schedule.version,
    scheduleSha256: schedule.assignmentOrderSha256,
    prompts
  } as const;
  const promptSetSha256 = sha256Text(`${stableJson(promptSetArtifact)}\n`);
  const storedPromptSet = await input.ledger?.putArtifact(promptSetArtifact);
  if (storedPromptSet && storedPromptSet.sha256 !== promptSetSha256) {
    throw new Error('H1b H0 ledger changed the materialized prompt-set digest.');
  }
  const maximumEstimatedPromptTokens = Math.max(
    ...prompts.map((prompt) => prompt.estimatedPromptTokens)
  );
  if (maximumEstimatedPromptTokens > MAXIMUM_PROMPT_TOKENS) {
    throw new Error('H1b H0 prompt materialization exceeded the prepared-prompt ceiling.');
  }

  const report: H1bHarnessValidationReport = {
    schemaVersion: H1B_HARNESS_VALIDATION_SCHEMA_VERSION,
    validationVersion: H1B_HARNESS_VALIDATION_VERSION,
    hypothesisId: 'H0-H1B',
    status: 'PASSED',
    componentLocks: structuredClone(input.validation.locks),
    scheduleVersion: schedule.version,
    scheduleSha256: schedule.assignmentOrderSha256,
    promptSetSha256,
    maximumEstimatedPromptTokens,
    sourceLock: structuredClone(input.validation.sourceLock),
    checks: [
      {
        checkId: 'SEALED_COMPONENT_AND_TRANSITIVE_SOURCE_LOCKS',
        status: 'PASSED',
        detail: `${input.validation.sourceLock.sourceFiles.length} transitive TypeScript sources include the Codex process, RPC, permission, and workspace boundary; active corpus, prompt, schema, scoring, and protocol locks match.`
      },
      {
        checkId: 'SIX_CASE_18_BLOCK_54_ASSIGNMENT_MATRIX',
        status: 'PASSED',
        detail: 'Three derivable-critique and three new-evidence cases produce 18 complete case/repetition blocks and 54 unique one-call assignments.'
      },
      {
        checkId: 'LATIN_POSITION_COUNTERBALANCE',
        status: 'PASSED',
        detail: 'Within each case, every condition appears exactly once in positions 1, 2, and 3; every block contains its three unique conditions.'
      },
      {
        checkId: 'BYTE_IDENTICAL_REPETITIONS',
        status: 'PASSED',
        detail: 'The three repetitions of every case/condition cell have byte-identical prompts and prompt-artifact digests.'
      },
      {
        checkId: 'CASE_ONLY_HAS_NO_FIXED_PREFIX_OR_SIGNAL',
        status: 'PASSED',
        detail: 'Every case-only prompt omits the controlled-signal section and exposes an empty public-artifact list; no fixed-initial artifact id or authored answer appears.'
      },
      {
        checkId: 'SCORER_TRUTH_FIREWALL',
        status: 'PASSED',
        detail: 'No scorer-only profile, derivation note, audit note, participantAccess marker, internal case id, stratum, or condition id appears in a participant prompt.'
      },
      {
        checkId: 'STRUCTURED_CRITIQUE_TARGET',
        status: 'PASSED',
        detail: 'Every derivable-critique prompt projects exactly its sealed artifact/issue/proposition triple as a valid direct response target.'
      },
      {
        checkId: 'EVIDENCE_IS_NOT_A_CRITIQUE',
        status: 'PASSED',
        detail: 'Every evidence treatment exposes its exact evidence id but an empty structured-response-target list; base controls also expose no critique target.'
      },
      {
        checkId: 'PREPARED_PROMPT_CEILING',
        status: 'PASSED',
        detail: `All 54 prompts were materialized through the production runner path; the maximum UTF-8/4 estimate was ${maximumEstimatedPromptTokens}, within 7,000.`
      },
      {
        checkId: 'ZERO_PROVIDER_CALLS',
        status: 'PASSED',
        detail: 'H0 used fixture loading, protocol lookup, prompt materialization, hashing, and ledger writes only; no text driver or provider API was created or called.'
      }
    ]
  };

  if (input.ledger) {
    await input.ledger.writeReport('h1b-h0-validation', report);
    await input.ledger.append({
      eventType: 'H1B_H0_PASSED',
      occurredAt: new Date().toISOString(),
      artifactSha256: promptSetSha256,
      detail: {
        assignments: assignments.length,
        blocks: schedule.blockIds.length,
        promptSetSha256
      }
    });
  }
  return report;
}

export function buildH1bHarnessValidationManifest(
  runId: string,
  locks: LabComponentLock,
  createdAt = new Date().toISOString()
): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId,
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt,
    driver: {
      id: 'h1b-h0-local-no-provider',
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
    caseIds: ['H1B-D1', 'H1B-D2', 'H1B-D3', 'H1B-G1', 'H1B-G2', 'H1B-G3'],
    conditionIds: [
      'CONTROL_CASE_ONLY_B1',
      'CONTROL_NO_FEEDBACK_B1',
      'CONTROL_VALID_CRITIQUE_B1',
      'CONTROL_EVIDENCE_B1'
    ],
    budgets: {
      maximumCalls: 0,
      maximumRounds: 0,
      maximumOutputTokens: 0,
      maximumOutputTokenSafetyCeiling: 0,
      maximumObservedTotalTokens: 0,
      maximumCallMs: 0,
      maximumExperimentMs: 30_000
    },
    providerUsageExplicitlyAuthorized: false
  };
}

export async function loadH1bH0ValidationReceipt(
  ledgerRoot: string,
  runId: string,
  activeLocks: LabComponentLock
): Promise<H1bH0ValidationReceipt> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) || runId === '..') {
    throw new Error('H1b H0 receipt has an unsafe run id.');
  }
  const runDirectory = path.join(ledgerRoot, 'runs', runId);
  await assertRealDirectory(runDirectory);
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const reportPath = path.join(runDirectory, 'reports', 'h1b-h0-validation.json');
  await Promise.all([assertRealFile(manifestPath), assertRealFile(reportPath)]);
  const [manifestText, reportText] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(reportPath, 'utf8')
  ]);
  let manifest: LabRunManifest;
  let report: H1bHarnessValidationReport;
  try {
    manifest = JSON.parse(manifestText) as LabRunManifest;
    report = JSON.parse(reportText) as H1bHarnessValidationReport;
  } catch {
    throw new Error('H1b H0 receipt contains invalid JSON.');
  }
  const problems: string[] = [];
  if (
    manifest.schemaVersion !== LAB_LEDGER_SCHEMA_VERSION ||
    manifest.runId !== runId ||
    manifest.phase !== 'HARNESS_VALIDATION' ||
    manifest.providerUsageExplicitlyAuthorized ||
    manifest.budgets.maximumCalls !== 0
  ) problems.push('manifest');
  if (stableJson(manifest.locks) !== stableJson(activeLocks)) problems.push('manifestLocks');
  if (
    report.schemaVersion !== H1B_HARNESS_VALIDATION_SCHEMA_VERSION ||
    report.validationVersion !== H1B_HARNESS_VALIDATION_VERSION ||
    report.hypothesisId !== 'H0-H1B' ||
    report.status !== 'PASSED' ||
    report.scheduleVersion !== H1B_ASSIGNMENT_ORDER_VERSION ||
    !/^[a-f0-9]{64}$/u.test(report.scheduleSha256 ?? '') ||
    report.maximumEstimatedPromptTokens > MAXIMUM_PROMPT_TOKENS ||
    report.maximumEstimatedPromptTokens <= 0 ||
    !Array.isArray(report.checks) ||
    report.checks.length !== REQUIRED_CHECK_IDS.length ||
    report.checks.some((check) => check.status !== 'PASSED') ||
    REQUIRED_CHECK_IDS.some(
      (checkId) => !report.checks.some((check) => check.checkId === checkId)
    )
  ) problems.push('report');
  if (stableJson(report.componentLocks) !== stableJson(activeLocks)) problems.push('reportLocks');
  if (!/^[a-f0-9]{64}$/u.test(report.promptSetSha256)) problems.push('promptSetSha256');
  if (report.sourceLock?.sha256 !== activeLocks.labSourceSha256) problems.push('sourceLock');
  const promptSetPath = path.join(runDirectory, 'artifacts', `${report.promptSetSha256}.json`);
  await assertRealFile(promptSetPath).catch(() => problems.push('promptSetArtifact'));
  if (!problems.includes('promptSetArtifact')) {
    if (await sha256File(promptSetPath) !== report.promptSetSha256) {
      problems.push('promptSetArtifactHash');
    }
  }
  if (problems.length > 0) {
    throw new Error(`H1b H0 receipt validation failed: ${problems.join(', ')}.`);
  }
  return {
    runId,
    manifestSha256: sha256Text(manifestText),
    reportSha256: sha256Text(reportText),
    report: structuredClone(report)
  };
}

function materializeAssignmentPrompt(
  record: H1bParticipantCaseRecord,
  assignment: H1bAssignment
): H1bMaterializedPromptRecord {
  const plan = getLabProtocolPlan(assignment.conditionId);
  if (plan.maximumCalls !== 1 || plan.calls.length !== 1 || plan.maximumRounds > 1) {
    throw new Error(`H1b H0 requires a one-call plan for ${assignment.conditionId}.`);
  }
  const intervention = h1bPublicIntervention(record, assignment.conditionId);
  const prepared = materializeInitialLabPrompt({
    participantCase: record.participantCase,
    plan,
    ...(intervention ? { intervention } : {}),
    maximumInputTokensPerCall: MAXIMUM_PROMPT_TOKENS
  });
  return {
    assignmentId: assignment.assignmentId,
    blockId: assignment.blockId,
    caseId: assignment.caseId,
    repetition: assignment.repetition,
    position: assignment.position,
    conditionId: assignment.conditionId,
    promptArtifactSha256: prepared.promptArtifactSha256,
    estimatedPromptTokens: estimatePromptTokens(prepared.prompt),
    prompt: prepared.prompt
  };
}

function assertSchedule(assignments: H1bAssignment[], blockIds: string[]): void {
  if (
    blockIds.length !== 18 ||
    new Set(blockIds).size !== 18 ||
    assignments.length !== 54 ||
    new Set(assignments.map((item) => item.assignmentId)).size !== 54 ||
    new Set(assignments.map((item) => item.caseId)).size !== 6 ||
    assignments.filter((item) => item.stratum === 'DERIVABLE_CRITIQUE').length !== 27 ||
    assignments.filter((item) => item.stratum === 'NEW_EVIDENCE').length !== 27
  ) {
    throw new Error('H1b H0 schedule is not the sealed 18-block/54-assignment matrix.');
  }
  const orderedStrata = blockIds.map(
    (blockId) => assignments.find((item) => item.blockId === blockId)!.stratum
  );
  if (orderedStrata.some((stratum, index) => index > 0 && stratum === orderedStrata[index - 1])) {
    throw new Error('H1b H0 schedule does not interleave its two strata.');
  }
  for (const blockId of blockIds) {
    const block = assignments.filter((item) => item.blockId === blockId);
    if (
      block.length !== 3 ||
      new Set(block.map((item) => item.conditionId)).size !== 3 ||
      stableJson(block.map((item) => item.position)) !== stableJson([1, 2, 3])
    ) {
      throw new Error(`H1b H0 block is incomplete or unordered: ${blockId}.`);
    }
  }
  for (const caseId of new Set(assignments.map((item) => item.caseId))) {
    const cells = assignments.filter((item) => item.caseId === caseId);
    if (cells.length !== 9) throw new Error(`H1b H0 case does not have nine assignments: ${caseId}.`);
    for (const conditionId of new Set(cells.map((item) => item.conditionId))) {
      const positions = cells
        .filter((item) => item.conditionId === conditionId)
        .map((item) => item.position)
        .sort();
      if (stableJson(positions) !== stableJson([1, 2, 3])) {
        throw new Error(`H1b H0 Latin position balance failed for ${caseId}/${conditionId}.`);
      }
    }
  }
}

function assertRepeatedCellPrompts(prompts: H1bMaterializedPromptRecord[]): void {
  const cells = new Map<string, H1bMaterializedPromptRecord[]>();
  for (const prompt of prompts) {
    const key = `${prompt.caseId}:${prompt.conditionId}`;
    cells.set(key, [...(cells.get(key) ?? []), prompt]);
  }
  if (cells.size !== 18) throw new Error('H1b H0 did not materialize all 18 cells.');
  for (const [cell, repetitions] of cells) {
    if (
      repetitions.length !== 3 ||
      new Set(repetitions.map((item) => item.prompt)).size !== 1 ||
      new Set(repetitions.map((item) => item.promptArtifactSha256)).size !== 1
    ) {
      throw new Error(`H1b H0 repetitions are not byte-identical for ${cell}.`);
    }
  }
}

function assertCaseOnlyBoundary(
  prompts: H1bMaterializedPromptRecord[],
  byCase: Map<string, H1bParticipantCaseRecord>
): void {
  for (const item of prompts.filter((prompt) => prompt.conditionId === 'CONTROL_CASE_ONLY_B1')) {
    const record = byCase.get(item.caseId)!;
    if (
      item.prompt.includes('Controlled public signal:') ||
      stableJson(extractJsonSection(item.prompt, 'Visible public artifacts:', 'Valid structured response targets')) !== '[]' ||
      [
        record.fixedInitial.artifactId,
        record.fixedInitial.answer
      ].some((forbidden) => forbidden.length > 0 && item.prompt.includes(forbidden))
    ) {
      throw new Error(`H1b case-only prompt leaked a fixed prefix or signal for ${item.caseId}.`);
    }
  }
}

function assertMechanismProjection(
  prompts: H1bMaterializedPromptRecord[],
  byCase: Map<string, H1bParticipantCaseRecord>
): void {
  for (const item of prompts) {
    const record = byCase.get(item.caseId)!;
    const targets = extractJsonSection(
      item.prompt,
      'Valid structured response targets (exact ids; empty means responses must be []):',
      'Assigned operation:'
    ) as unknown[];
    if (!Array.isArray(targets)) {
      throw new Error(`H1b response-target section is not an array for ${item.assignmentId}.`);
    }
    if (item.conditionId === 'CONTROL_VALID_CRITIQUE_B1') {
      const artifact = record.signal.artifacts[0]!;
      const expected = [{
        targetArtifactId: artifact.artifactId,
        targetIssueId: artifact.issueId,
        targetPropositionId: artifact.targetPropositionId
      }];
      if (stableJson(targets) !== stableJson(expected)) {
        throw new Error(`H1b critique target projection failed for ${item.assignmentId}.`);
      }
    } else if (targets.length !== 0) {
      throw new Error(`H1b non-critique condition exposed a response target: ${item.assignmentId}.`);
    }
    if (item.conditionId === 'CONTROL_EVIDENCE_B1') {
      const evidenceId = record.signal.artifacts[0]?.evidenceId;
      if (!evidenceId || !item.prompt.includes(`\"evidenceId\":\"${evidenceId}\"`)) {
        throw new Error(`H1b evidence prompt omitted its exact evidence id: ${item.assignmentId}.`);
      }
    }
  }
}

function assertTruthFirewall(
  prompts: H1bMaterializedPromptRecord[],
  oracles: Awaited<ReturnType<typeof loadH1bOracleCorpus>>
): void {
  const forbiddenKeys = [
    'acceptedIssueKindEquivalences',
    'auditNotes',
    'baseProfile',
    'derivationNotes',
    'fixedInitialExpectation',
    'guardPropositionIds',
    'participantAccess',
    'targetPropositionIds',
    'treatmentProfile'
  ];
  const forbiddenValues = [
    'FORBIDDEN',
    'DERIVABLE_CRITIQUE',
    'NEW_EVIDENCE',
    ...oracles.flatMap((oracle) => [
      oracle.caseId,
      ...oracle.derivationNotes,
      ...oracle.auditNotes,
      ...oracle.baseProfile.conditionIds,
      ...oracle.treatmentProfile.conditionIds
    ])
  ];
  for (const item of prompts) {
    const leaked = [...forbiddenKeys, ...forbiddenValues].find(
      (value) => value.length > 0 && item.prompt.includes(value)
    );
    if (leaked) throw new Error(`H1b scorer truth leaked into ${item.assignmentId}: ${leaked}`);
  }
}

function assertComponentLocks(validation: H1bValidationReport): void {
  const problems: string[] = [];
  if (validation.locks.corpusVersion !== H1B_CORPUS_VERSION) problems.push('corpusVersion');
  if (validation.locks.promptVersion !== LAB_PROMPT_VERSION) problems.push('promptVersion');
  if (validation.locks.outputSchemaVersion !== LAB_PUBLIC_OUTPUT_SCHEMA_VERSION) {
    problems.push('outputSchemaVersion');
  }
  if (validation.locks.scoringVersion !== H1B_SCORING_VERSION) problems.push('scoringVersion');
  if (validation.locks.protocolVersion !== LAB_PROTOCOL_VERSION) problems.push('protocolVersion');
  if (validation.locks.labSourceSha256 !== validation.sourceLock.sha256) {
    problems.push('sourceLockDigest');
  }
  for (const required of REQUIRED_BOUNDARY_FILES) {
    if (!validation.sourceLock.sourceFiles.includes(required)) problems.push(required);
  }
  if (problems.length > 0) {
    throw new Error(`H1b H0 component/source lock failed: ${problems.join(', ')}.`);
  }
}

function extractJsonSection(prompt: string, heading: string, nextHeading: string): unknown {
  const prefix = `${heading}\n`;
  const start = prompt.indexOf(prefix);
  const end = prompt.indexOf(`\n\n${nextHeading}`, start + prefix.length);
  if (start < 0 || end < 0) throw new Error(`H1b prompt section is missing: ${heading}`);
  return JSON.parse(prompt.slice(start + prefix.length, end));
}

function estimatePromptTokens(prompt: string): number {
  return Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`H1b H0 receipt directory is unavailable or unsafe: ${directory}`);
  }
}

async function assertRealFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`H1b H0 receipt file is unavailable or unsafe: ${filePath}`);
  }
}
