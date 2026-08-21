import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HARD_PEER_80_CORPUS_VERSION,
  hardPeer80OracleFixturePath,
  hardPeer80ParticipantFixturePath,
  loadHardPeer80OracleCorpus,
  loadHardPeer80ParticipantCorpus
} from './hardPeer80Corpus';
import { HARD_PEER_80_OUTPUT_SCHEMA_VERSION } from './hardPeer80Contracts';
import {
  HARD_PEER_80_PLAN_VERSION,
  assertHardPeer80Plan,
  type HardPeer80Plan
} from './hardPeer80Plan';
import { HARD_PEER_80_PROMPT_VERSION } from './hardPeer80Prompts';
import { HARD_PEER_80_SCORING_VERSION } from './hardPeer80Scoring';
import { buildH1bSourceLock, type H1bSourceLock } from './h1bSourceLock';
import {
  sha256File,
  sha256Text,
  stableJson,
  type LabComponentLock
} from './ledger';

export const HARD_PEER_80_PREREGISTRATION_VERSION =
  'hard-peer-80-preregistration@v3' as const;
export const HARD_PEER_80_SEAL_VERSION = 'hard-peer-80-seal@v1' as const;
export const HARD_PEER_80_PROTOCOL_VERSION = 'hard-peer-80-terminal-protocol@v5' as const;
export { HARD_PEER_80_SCORING_VERSION } from './hardPeer80Scoring';
export const HARD_PEER_80_SEALED_PLAN_SCHEMA_VERSION =
  'task-monki/discourse-lab-hard-peer-80-sealed-plan@v1' as const;
export const HARD_PEER_80_H0_RECEIPT_SCHEMA_VERSION =
  'task-monki/discourse-lab-hard-peer-80-h0-receipt@v2' as const;

export type HardPeer80SealedAudience =
  | 'PARTICIPANT'
  | 'SCORER_ONLY'
  | 'HARNESS';

interface HardPeer80Seal {
  schemaVersion: 'discourse-lab/hard-peer-80-seal@v1';
  sealVersion: typeof HARD_PEER_80_SEAL_VERSION;
  corpusVersion: typeof HARD_PEER_80_CORPUS_VERSION;
  preregistrationVersion: typeof HARD_PEER_80_PREREGISTRATION_VERSION;
  digestAlgorithm: 'SHA-256';
  partition: 'TERMINAL_DEVELOPMENT_ONLY';
  confirmationStatus: 'ABSENT_CLOSED';
  files: Array<{
    path: string;
    audience: HardPeer80SealedAudience;
    sha256: string;
  }>;
}

interface HardPeer80Preregistration {
  schemaVersion: 'discourse-lab/hard-peer-80-preregistration@v1';
  preregistrationVersion: typeof HARD_PEER_80_PREREGISTRATION_VERSION;
  studyId: 'HARD-PEER-80';
  status: 'AUTHORIZED_TERMINAL_DEVELOPMENT_ONLY';
  question: string;
  hypothesis: Record<string, string>;
  scope: Record<string, unknown>;
  corpus: Record<string, unknown>;
  conditions: Array<Record<string, unknown>>;
  blinding: Record<string, unknown>;
  topology: Record<string, unknown>;
  model: Record<string, unknown>;
  budget: Record<string, unknown>;
  metrics: Record<string, unknown>;
  informativenessGate: Record<string, unknown>;
  peerPilotSuccessGate: Record<string, unknown>;
  stoppingRules: string[];
  terminalDecision: Record<string, unknown>;
  authorization: Record<string, unknown>;
}

export interface HardPeer80ValidationReport {
  valid: true;
  sealVersion: typeof HARD_PEER_80_SEAL_VERSION;
  preregistrationVersion: typeof HARD_PEER_80_PREREGISTRATION_VERSION;
  verifiedFiles: HardPeer80Seal['files'];
  sourceLock: H1bSourceLock;
  locks: LabComponentLock;
}

export interface HardPeer80ValidationOptions {
  /** Defaults to the repository root inferred from evaluation/discourse-lab. */
  projectRoot?: string;
  /** The production caller must use hardPeer80Cli.ts. Tests may bind a fixture entry. */
  sourceEntryFiles?: string[];
}

export interface HardPeer80H0Receipt {
  schemaVersion: typeof HARD_PEER_80_H0_RECEIPT_SCHEMA_VERSION;
  validationVersion: 'hard-peer-80-h0-validation@v2';
  runId: string;
  status: 'PASSED';
  manifestSha256: string;
  reportSha256: string;
  componentLocks: LabComponentLock;
  scheduleSha256: string;
  promptTemplateSetSha256: string;
  providerCallCount: 0;
  semanticCallExpectation: 76;
  evaluationForkExpectation: 30;
  boundaryProbeForkExpectation: 1;
}

export interface HardPeer80SealedPlan {
  schemaVersion: typeof HARD_PEER_80_SEALED_PLAN_SCHEMA_VERSION;
  planVersion: typeof HARD_PEER_80_PLAN_VERSION;
  terminalStudy: true;
  confirmationOpened: false;
  locks: LabComponentLock;
  sourceLock: H1bSourceLock;
  h0Receipt: HardPeer80H0Receipt;
  plan: HardPeer80Plan;
}

const PREREGISTRATION_RELATIVE_PATH =
  'evaluation/discourse-lab/preregistration/hard-peer-80-v1.json';
const SEAL_RELATIVE_PATH = 'evaluation/discourse-lab/seal-hard-peer-80-v1.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Validates all sealed inputs before provider execution. Scorer-only files are
 * parsed here only in provider-free preflight; the terminal executor must not
 * call this function again while a participant driver is live.
 */
export async function validateHardPeer80Inputs(
  fixtureRoot: string,
  options: HardPeer80ValidationOptions = {}
): Promise<HardPeer80ValidationReport> {
  const projectRoot = path.resolve(
    options.projectRoot ?? path.resolve(fixtureRoot, '..', '..')
  );
  const sealPath = path.join(fixtureRoot, 'seal-hard-peer-80-v1.json');
  const seal = await readRealJson<HardPeer80Seal>(sealPath, 'seal');
  if (
    seal.schemaVersion !== 'discourse-lab/hard-peer-80-seal@v1' ||
    seal.sealVersion !== HARD_PEER_80_SEAL_VERSION ||
    seal.corpusVersion !== HARD_PEER_80_CORPUS_VERSION ||
    seal.preregistrationVersion !== HARD_PEER_80_PREREGISTRATION_VERSION ||
    seal.digestAlgorithm !== 'SHA-256' ||
    seal.partition !== 'TERMINAL_DEVELOPMENT_ONLY' ||
    seal.confirmationStatus !== 'ABSENT_CLOSED' ||
    seal.files.length !== 5
  ) {
    throw new Error('HARD-PEER-80 seal header or terminal-development boundary is invalid.');
  }

  const expectedAudiences = expectedSealedAudiences(fixtureRoot, projectRoot);
  const actualPaths = new Set(seal.files.map((entry) => entry.path));
  if (
    actualPaths.size !== expectedAudiences.size ||
    seal.files.some((entry) =>
      expectedAudiences.get(entry.path) !== entry.audience ||
      !SHA256_PATTERN.test(entry.sha256)
    ) ||
    [...expectedAudiences.keys()].some((filePath) => !actualPaths.has(filePath))
  ) {
    throw new Error(
      'HARD-PEER-80 seal must map exactly two participant, two scorer-only, and one harness input to their audiences.'
    );
  }
  for (const entry of seal.files) {
    const resolved = path.resolve(projectRoot, entry.path);
    assertInside(resolved, fixtureRoot, 'sealed input');
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`HARD-PEER-80 sealed input must be a real file: ${entry.path}.`);
    }
    if (await sha256File(resolved) !== entry.sha256) {
      throw new Error(`Sealed HARD-PEER-80 input changed: ${entry.path}.`);
    }
  }

  const preregistration = await readRealJson<HardPeer80Preregistration>(
    path.join(fixtureRoot, 'preregistration', 'hard-peer-80-v1.json'),
    'preregistration'
  );
  const calibrationParticipants = await loadHardPeer80ParticipantCorpus(
    fixtureRoot,
    'CALIBRATION'
  );
  const evaluationParticipants = await loadHardPeer80ParticipantCorpus(
    fixtureRoot,
    'EVALUATION'
  );
  validatePreregistration(
    preregistration,
    calibrationParticipants.records.map(({ caseId }) => caseId),
    evaluationParticipants.records.map(({ caseId }) => caseId)
  );
  await loadHardPeer80OracleCorpus(fixtureRoot, 'CALIBRATION', calibrationParticipants);
  await loadHardPeer80OracleCorpus(fixtureRoot, 'EVALUATION', evaluationParticipants);

  const sourceEntryFiles = options.sourceEntryFiles ?? [
    'src/dev/discourseLab/hardPeer80Cli.ts'
  ];
  const sourceLock = await buildH1bSourceLock(projectRoot, sourceEntryFiles);
  const participantEntries = entriesForAudience(seal.files, 'PARTICIPANT');
  const scorerEntries = entriesForAudience(seal.files, 'SCORER_ONLY');
  const harnessEntry = entriesForAudience(seal.files, 'HARNESS')[0];
  if (participantEntries.length !== 2 || scorerEntries.length !== 2 || !harnessEntry) {
    throw new Error('HARD-PEER-80 seal audience assignment is incomplete.');
  }
  return {
    valid: true,
    sealVersion: seal.sealVersion,
    preregistrationVersion: preregistration.preregistrationVersion,
    verifiedFiles: structuredClone(seal.files),
    sourceLock,
    locks: {
      corpusVersion: HARD_PEER_80_CORPUS_VERSION,
      participantCorpusSha256: aggregateSealedEntries(participantEntries),
      oracleCorpusSha256: aggregateSealedEntries(scorerEntries),
      labSourceSha256: sourceLock.sha256,
      preregistrationVersion: preregistration.preregistrationVersion,
      preregistrationSha256: harnessEntry.sha256,
      promptVersion: HARD_PEER_80_PROMPT_VERSION,
      outputSchemaVersion: HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
      scoringVersion: HARD_PEER_80_SCORING_VERSION,
      protocolVersion: HARD_PEER_80_PROTOCOL_VERSION
    }
  };
}

export function buildHardPeer80SealedPlan(input: {
  validation: HardPeer80ValidationReport;
  h0Receipt: HardPeer80H0Receipt;
  plan: HardPeer80Plan;
}): HardPeer80SealedPlan {
  const result: HardPeer80SealedPlan = {
    schemaVersion: HARD_PEER_80_SEALED_PLAN_SCHEMA_VERSION,
    planVersion: HARD_PEER_80_PLAN_VERSION,
    terminalStudy: true,
    confirmationOpened: false,
    locks: structuredClone(input.validation.locks),
    sourceLock: structuredClone(input.validation.sourceLock),
    h0Receipt: structuredClone(input.h0Receipt),
    plan: structuredClone(input.plan)
  };
  assertHardPeer80SealedPlan(result, input.validation);
  return result;
}

export function assertHardPeer80SealedPlan(
  sealedPlan: HardPeer80SealedPlan,
  validation: HardPeer80ValidationReport
): void {
  const calibrationCaseIds = sealedPlan.plan.schedule.calibrationCaseIds;
  const evaluationCaseIds = uniqueEvaluationCaseIds(sealedPlan.plan);
  const problems: string[] = [];
  if (sealedPlan.schemaVersion !== HARD_PEER_80_SEALED_PLAN_SCHEMA_VERSION) {
    problems.push('schemaVersion');
  }
  if (sealedPlan.planVersion !== HARD_PEER_80_PLAN_VERSION) problems.push('planVersion');
  if (!sealedPlan.terminalStudy || sealedPlan.confirmationOpened) problems.push('terminalBoundary');
  if (stableJson(sealedPlan.locks) !== stableJson(validation.locks)) problems.push('locks');
  if (stableJson(sealedPlan.sourceLock) !== stableJson(validation.sourceLock)) {
    problems.push('sourceLock');
  }
  try {
    assertHardPeer80Plan(sealedPlan.plan, calibrationCaseIds, evaluationCaseIds);
  } catch {
    problems.push('plan');
  }
  const receipt = sealedPlan.h0Receipt;
  if (
    receipt.schemaVersion !== HARD_PEER_80_H0_RECEIPT_SCHEMA_VERSION ||
    receipt.validationVersion !== 'hard-peer-80-h0-validation@v2' ||
    receipt.status !== 'PASSED' ||
    !safeRunId(receipt.runId) ||
    !SHA256_PATTERN.test(receipt.manifestSha256) ||
    !SHA256_PATTERN.test(receipt.reportSha256) ||
    !SHA256_PATTERN.test(receipt.scheduleSha256) ||
    !SHA256_PATTERN.test(receipt.promptTemplateSetSha256) ||
    stableJson(receipt.componentLocks) !== stableJson(validation.locks) ||
    receipt.scheduleSha256 !== sealedPlan.plan.schedule.scheduleSha256 ||
    receipt.providerCallCount !== 0 ||
    receipt.semanticCallExpectation !== 76 ||
    receipt.evaluationForkExpectation !== 30 ||
    receipt.boundaryProbeForkExpectation !== 1
  ) {
    problems.push('h0Receipt');
  }
  if (problems.length > 0) {
    throw new Error(`HARD-PEER-80 sealed plan is invalid: ${problems.join(', ')}.`);
  }
}

export async function persistHardPeer80SealedPlan(
  planPath: string,
  sealedPlan: HardPeer80SealedPlan,
  validation: HardPeer80ValidationReport
): Promise<{ path: string; sha256: string }> {
  assertHardPeer80SealedPlan(sealedPlan, validation);
  await fs.mkdir(path.dirname(planPath), { recursive: true, mode: 0o700 });
  const text = `${stableJson(sealedPlan)}\n`;
  await fs.writeFile(planPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { path: planPath, sha256: sha256Text(text) };
}

export async function loadHardPeer80SealedPlan(
  planPath: string,
  validation: HardPeer80ValidationReport
): Promise<{ plan: HardPeer80SealedPlan; sha256: string }> {
  const plan = await readRealJson<HardPeer80SealedPlan>(planPath, 'sealed plan');
  assertHardPeer80SealedPlan(plan, validation);
  return { plan, sha256: await sha256File(planPath) };
}

function validatePreregistration(
  value: HardPeer80Preregistration,
  calibrationCaseIds: string[],
  evaluationCaseIds: string[]
): void {
  const expected = {
    scope: {
      partition: 'DEVELOPMENT_ONLY_NO_CONFIRMATION',
      ordinaryTextOnly: true,
      toolsBrowsingRepositoriesTasksExternalRetrieval: 'FORBIDDEN',
      hiddenChainOfThoughtRequestedOrStored: false,
      taskMonkiProductBehaviorMayChange: false,
      taskMonkiReviewAuthorityMayChange: false,
      calibrationBatches: 1,
      evaluationRuns: 1,
      followUpExperiments: 0,
      postProviderHarnessChanges: 0,
      retriesRepairsReplacementCases: 0
    },
    corpus: {
      calibrationCases: calibrationCaseIds,
      evaluationCases: evaluationCaseIds,
      domains: [
        'ERDOS_STYLE_MATHEMATICS',
        'RIGOROUS_LOGIC',
        'HIDDEN_ASSUMPTION_REASONING',
        'SELF_CONTAINED_DEBUGGING',
        'TASK_MONKI_TECHNICAL_DECISION'
      ],
      evaluationRepetitionsPerCase: 2,
      repetitionsAreIndependentProblems: false,
      calibrationGate: 'PROCEED_IFF_EXACTLY_2_OR_3_OF_5_INITIAL_ANSWERS_ARE_COMPOSITE_CORRECT'
    },
    conditions: [
      {
        id: 'STRONG_WORKBENCH',
        allocation: 'SHARED_A0_PLUS_TWO_NEUTRAL_SAME_AGENT_CONTINUATIONS'
      },
      {
        id: 'SAME_AGENT_SELF_REVIEW',
        allocation: 'SHARED_A0_PLUS_EXPLICIT_SELF_AUDIT_PLUS_DIRECT_FINALIZATION'
      },
      {
        id: 'ORACLE_BLINDED_PEER_CRITIQUE',
        allocation: 'SHARED_A0_PLUS_ONE_FRESH_TARGETED_PEER_REVIEW_PLUS_ONE_DIRECT_AUTHOR_RESPONSE'
      }
    ],
    blinding: {
      peerSeesA0: true,
      peerBlindToOracle: true,
      peerBlindToAuthorIdentityAndAuthority: true,
      peerBlindToConditionLabelsSiblingBranchesAndOutcomes: true,
      independentlyFormedBlindPeerPosition: false,
      sharedErrorDiscoveryEstimable: false
    },
    topology: {
      semanticModelCalls: 76,
      boundaryProbeCalls: 1,
      calibrationCalls: 5,
      evaluationBlocks: 10,
      semanticCallsPerEvaluationBlock: 7,
      sharedInitialPerEvaluationBlock: 1,
      marginalTurnsPerCondition: 2,
      authorForksPerEvaluationBlock: 3,
      allForksBeforeAnyBranchTurn: true,
      nonModelRpcMutationsCountAsSemanticCalls: false,
      unusedAbsoluteCallMargin: 4
    },
    model: {
      id: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'default',
      samplingSeed: null,
      identicalAcrossAllSemanticCalls: true
    },
    budget: {
      scheduledSemanticCalls: 76,
      absoluteSemanticCallCeiling: 80,
      maximumObservedIncrementalTokens: 1_500_000,
      maximumCallMs: 120_000,
      maximumExperimentMs: 18_000_000,
      targetOutputTokensPerCall: 3_000,
      emergencyOutputTokenSafetyCeilingPerCall: 10_000,
      nextCallObservedTokenReservation: 25_000,
      providerEnforcedAggregateTokenCap: false,
      thresholdCrossingAtomicCallRetained: true
    },
    informativenessGate: {
      minimumWrongInitialBlocks: 3,
      minimumWrongInitialUniqueCases: 2,
      minimumCorrectInitialBlocks: 3,
      minimumCorrectInitialUniqueCases: 2
    },
    peerPilotSuccessGate: {
      minimumIncrementalAttributablePeerCorrections: 3,
      minimumUniqueCasesWithIncrementalCorrection: 2,
      minimumPeerCorrectnessLeadOverEachComparatorInTenBlocks: 2,
      maximumInitialRightToPeerWrong: 0,
      maximumHarmfulInvalidCritiqueAdoptions: 0,
      maximumUnsupportedDefiniteClosures: 0,
      maximumFalseDisagreementResolutions: 0,
      requiredUserRequestsAndUnresolvedStatesPreserved: true,
      allExecutionScoringAncestryAllocationArchiveChecksPass: true,
      maximumPeerTokenRatioToEachComparator: 1.1
    },
    stoppingRules: [
      'STOP_BEFORE_PROVIDER_IF_SEAL_SOURCE_H0_PLAN_OR_AUTH_ROOT_INVALID',
      'STOP_AFTER_FAILED_SINGLE_BOUNDARY_OUTPUT_FORK_PROBE',
      'STOP_AFTER_CALIBRATION_UNLESS_EXACTLY_2_OR_3_OF_5_ARE_CORRECT',
      'STOP_ON_BOUNDARY_SETTINGS_ANCESTRY_ROUTING_CONTEXT_USAGE_TIMEOUT_OR_CLOSE_AMBIGUITY',
      'STOP_BEFORE_NEXT_CALL_IF_25000_TOKEN_RESERVATION_WOULD_CROSS_1500000',
      'STOP_AND_RETAIN_ANY_ATOMIC_CALL_OVERSHOOT',
      'NEVER_RETRY_REPAIR_RESUME_REPLACE_EXCLUDE_OR_REDESIGN'
    ],
    terminalDecision: {
      success: 'RECOMMEND_ONLY_ONE_BOUNDED_ORACLE_BLINDED_PEER_CRITIQUE_AND_DIRECT_AUTHOR_RESPONSE_PRODUCT_PILOT',
      otherwise: 'PERMANENTLY_RECOMMEND_ONE_STRONG_AGENT_WITH_OPTIONAL_ONE_BOUNDED_SAME_AGENT_SELF_REVIEW',
      furtherExperimentAllowed: false
    },
    authorization: {
      providerCallsAuthorized: true,
      reuseCodexAuthenticationAuthorized: true,
      confirmationOpened: false
    }
  } as const;
  const hypotheses = value.hypothesis ?? {};
  const metrics = value.metrics ?? {};
  if (
    value.schemaVersion !== 'discourse-lab/hard-peer-80-preregistration@v1' ||
    value.preregistrationVersion !== HARD_PEER_80_PREREGISTRATION_VERSION ||
    value.studyId !== 'HARD-PEER-80' ||
    value.status !== 'AUTHORIZED_TERMINAL_DEVELOPMENT_ONLY' ||
    !value.question?.trim() ||
    ['mechanism', 'support', 'rejectOrFailToSupport', 'decisionAffected'].some(
      (key) => typeof hypotheses[key] !== 'string' || !hypotheses[key]!.trim()
    ) ||
    stableJson(value.scope) !== stableJson(expected.scope) ||
    stableJson(value.corpus) !== stableJson(expected.corpus) ||
    stableJson(value.conditions) !== stableJson(expected.conditions) ||
    stableJson(value.blinding) !== stableJson(expected.blinding) ||
    stableJson(value.topology) !== stableJson(expected.topology) ||
    stableJson(value.model) !== stableJson(expected.model) ||
    stableJson(value.budget) !== stableJson(expected.budget) ||
    stableJson(value.informativenessGate) !== stableJson(expected.informativenessGate) ||
    stableJson(value.peerPilotSuccessGate) !== stableJson(expected.peerPilotSuccessGate) ||
    stableJson(value.stoppingRules) !== stableJson(expected.stoppingRules) ||
    stableJson(value.terminalDecision) !== stableJson(expected.terminalDecision) ||
    stableJson(value.authorization) !== stableJson(expected.authorization) ||
    !validMetricContract(metrics)
  ) {
    throw new Error('HARD-PEER-80 preregistration contract is invalid.');
  }
}

function validMetricContract(metrics: Record<string, unknown>): boolean {
  return stableJson(metrics) === stableJson({
    critiqueAttributionScope: 'TYPED_PROPOSITION_ANSWER_SELECTION_EPISTEMIC_STATE_AND_CERTIFICATE_ERRORS',
    primary: [
      'COMPOSITE_CORRECTNESS',
      'TYPED_CERTIFICATE_SEMANTIC_VALIDITY',
      'WRONG_TO_RIGHT_CORRECTION',
      'RIGHT_TO_WRONG_CONTAMINATION',
      'CRITIQUE_ATTRIBUTABLE_INCREMENTAL_CORRECTION'
    ],
    critique: [
      'TYPED_TARGET_VALIDITY',
      'VISIBLE_EVIDENCE_VALIDITY',
      'PEER_CORRESPONDING_ASSESSMENT_AND_CERTIFICATE_VALIDITY',
      'INVENTED_OR_FALSE_MATERIAL_CRITICISM',
      'HARMFUL_ADOPTION',
      'DIRECT_RESPONSE_AND_CORRESPONDING_TYPED_TARGET_CHANGE'
    ],
    epistemic: [
      'DISAGREEMENT_PRESERVATION',
      'CORRECT_MINORITY_NOT_ESTIMABLE_A0_ANCHORED_PEER',
      'UNCERTAINTY',
      'ABSTENTION',
      'USER_INFORMATION_REQUEST',
      'CONFIDENCE_BRIER_SCORE'
    ],
    operations: [
      'PROVIDER_REPORTED_INCREMENTAL_TOKENS',
      'LATENCY',
      'FAILURES',
      'EXCLUSIONS',
      'OUTPUT_TARGET_AND_SAFETY_OVERSHOOT'
    ],
    analysisUnits: ['TEN_PAIRED_BLOCKS', 'FIVE_UNIQUE_CASE_CLUSTERS', 'FIVE_DOMAINS'],
    significanceTest: null
  });
}

function expectedSealedAudiences(
  fixtureRoot: string,
  projectRoot: string
): Map<string, HardPeer80SealedAudience> {
  const pairs: Array<[string, HardPeer80SealedAudience]> = [
    [hardPeer80ParticipantFixturePath(fixtureRoot, 'CALIBRATION'), 'PARTICIPANT'],
    [hardPeer80ParticipantFixturePath(fixtureRoot, 'EVALUATION'), 'PARTICIPANT'],
    [hardPeer80OracleFixturePath(fixtureRoot, 'CALIBRATION'), 'SCORER_ONLY'],
    [hardPeer80OracleFixturePath(fixtureRoot, 'EVALUATION'), 'SCORER_ONLY'],
    [path.join(fixtureRoot, 'preregistration', 'hard-peer-80-v1.json'), 'HARNESS']
  ];
  return new Map(pairs.map(([filePath, audience]) => [
    path.relative(projectRoot, filePath).split(path.sep).join('/'),
    audience
  ]));
}

function entriesForAudience(
  files: HardPeer80Seal['files'],
  audience: HardPeer80SealedAudience
): HardPeer80Seal['files'] {
  return files.filter((entry) => entry.audience === audience)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function aggregateSealedEntries(entries: HardPeer80Seal['files']): string {
  return sha256Text(`${stableJson(entries.map(({ path: filePath, sha256 }) => ({
    path: filePath,
    sha256
  })))}\n`);
}

function uniqueEvaluationCaseIds(plan: HardPeer80Plan): string[] {
  const result: string[] = [];
  for (const assignment of plan.assignments) {
    if (
      assignment.phase === 'EVALUATION' &&
      assignment.turnId === 'A0' &&
      assignment.caseId &&
      !result.includes(assignment.caseId)
    ) {
      result.push(assignment.caseId);
    }
  }
  return result;
}

async function readRealJson<T>(filePath: string, label: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`HARD-PEER-80 ${label} must be a real file: ${filePath}.`);
  }
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    throw new Error(`HARD-PEER-80 ${label} is not valid JSON: ${filePath}.`);
  }
}

function assertInside(candidate: string, parent: string, label: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`HARD-PEER-80 ${label} escapes its fixture root: ${candidate}.`);
  }
}

function safeRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== '..';
}

/** Paths are exported only so the terminal coordinator can reject a misplaced seal. */
export const HARD_PEER_80_INPUT_PATHS = {
  preregistration: PREREGISTRATION_RELATIVE_PATH,
  seal: SEAL_RELATIVE_PATH
} as const;
