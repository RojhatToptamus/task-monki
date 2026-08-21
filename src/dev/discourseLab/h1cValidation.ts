import fs from 'node:fs/promises';
import path from 'node:path';
import {
  H1C_CORPUS_VERSION,
  h1cOracleFixturePath,
  h1cParticipantFixturePath,
  loadH1cOracleCorpus,
  loadH1cParticipantCorpus
} from './h1cCorpus';
import { H1C_PROMPT_VERSION } from './h1cPrompts';
import { H1C_SCORING_VERSION } from './h1cScoring';
import { buildH1bSourceLock, type H1bSourceLock } from './h1bSourceLock';
import { sha256File, type LabComponentLock } from './ledger';
import { LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION } from './outputV4';

export const H1C_PREREGISTRATION_VERSION = 'h1c-preregistration-v3' as const;
export const H1C_SEAL_VERSION = 'h1c-seal-v3' as const;
export const H1C_RUNNER_VERSION = 'h1c-live-yoked-runner@v3' as const;
export const H1C_PROTOCOL_VERSION = 'h1c-live-yoked-protocol@v3' as const;

interface H1cSeal {
  schemaVersion: 'discourse-lab-h1c-seal@3';
  sealVersion: typeof H1C_SEAL_VERSION;
  corpusVersion: typeof H1C_CORPUS_VERSION;
  preregistrationVersion: typeof H1C_PREREGISTRATION_VERSION;
  digestAlgorithm: 'SHA-256';
  partition: 'DEVELOPMENT_ONLY';
  confirmationStatus: 'ABSENT_CLOSED';
  files: Array<{
    path: string;
    audience: 'PARTICIPANT' | 'SCORER_ONLY' | 'HARNESS';
    sha256: string;
  }>;
}

interface H1cPreregistration {
  schemaVersion: 'discourse-lab-h1c-preregistration@3';
  preregistrationVersion: typeof H1C_PREREGISTRATION_VERSION;
  corpusVersion: typeof H1C_CORPUS_VERSION;
  promptVersion: typeof H1C_PROMPT_VERSION;
  outputSchemaVersion: typeof LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION;
  scoringVersion: typeof H1C_SCORING_VERSION;
  runnerVersion: typeof H1C_RUNNER_VERSION;
  scheduleVersion: 'h1c-yoked-counterbalanced-schedule@v3';
  experiment: {
    experimentId: 'H1c';
    status: 'PROVIDER_FREE_V3_REPAIR_SEALED_FUTURE_EXECUTION_REQUIRES_FRESH_EXACT_MODEL_PROBE_AND_AUTHORIZATION';
    decisionAffected: string;
    hypotheses: Array<{
      hypothesisId: 'H1c-D' | 'H1c-E';
      exactHypothesis: string;
      mechanismIsolated: string;
      expectedDiscriminatingPattern: string;
      supportResult: string;
      rejectResult: string;
      decisionChanged: string;
    }>;
  };
  scope: Record<string, unknown>;
  conditions: string[];
  model: Record<string, unknown>;
  budget: Record<string, unknown>;
  stoppingRules: Array<{ stopId: string; rule: string }>;
  metricDefinitions: Record<string, string>;
  causalLimitations: string[];
  confirmationLock: {
    status: 'ABSENT_CLOSED';
    h1cConfirmationCorpusExists: false;
  };
}

export interface H1cValidationReport {
  valid: true;
  sealVersion: typeof H1C_SEAL_VERSION;
  preregistrationVersion: typeof H1C_PREREGISTRATION_VERSION;
  verifiedFiles: H1cSeal['files'];
  sourceLock: H1bSourceLock;
  locks: LabComponentLock;
}

export async function validateH1cInputs(fixtureRoot: string): Promise<H1cValidationReport> {
  const projectRoot = path.resolve(fixtureRoot, '..', '..');
  const sealPath = path.join(fixtureRoot, 'seal-h1c-v3.json');
  const seal = await readRealJson<H1cSeal>(sealPath);
  if (
    seal.schemaVersion !== 'discourse-lab-h1c-seal@3' ||
    seal.sealVersion !== H1C_SEAL_VERSION ||
    seal.corpusVersion !== H1C_CORPUS_VERSION ||
    seal.preregistrationVersion !== H1C_PREREGISTRATION_VERSION ||
    seal.digestAlgorithm !== 'SHA-256' ||
    seal.partition !== 'DEVELOPMENT_ONLY' ||
    seal.confirmationStatus !== 'ABSENT_CLOSED' ||
    seal.files.length !== 3
  ) {
    throw new Error('H1c seal header or development-only boundary is invalid.');
  }
  const expectedAudiences = new Map([
    [h1cParticipantFixturePath(fixtureRoot), 'PARTICIPANT'],
    [h1cOracleFixturePath(fixtureRoot), 'SCORER_ONLY'],
    [path.join(fixtureRoot, 'preregistration', 'h1c-v3.json'), 'HARNESS']
  ].map(([filePath, audience]) => [
    path.relative(projectRoot, filePath).split(path.sep).join('/'),
    audience
  ] as const));
  if (
    new Set(seal.files.map((entry) => entry.path)).size !== 3 ||
    seal.files.some((entry) =>
      expectedAudiences.get(entry.path) !== entry.audience ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) ||
    expectedAudiences.size !== 3
  ) {
    throw new Error(
      'H1c seal does not exactly map participant, scorer, and preregistration inputs to their audiences.'
    );
  }
  for (const entry of seal.files) {
    const resolved = path.resolve(projectRoot, entry.path);
    assertInside(resolved, fixtureRoot);
    if (await sha256File(resolved) !== entry.sha256) {
      throw new Error(`Sealed H1c input changed: ${entry.path}.`);
    }
  }
  const preregistrationPath = path.join(fixtureRoot, 'preregistration', 'h1c-v3.json');
  const preregistration = await readRealJson<H1cPreregistration>(preregistrationPath);
  validatePreregistration(preregistration);
  const participants = await loadH1cParticipantCorpus(fixtureRoot);
  await loadH1cOracleCorpus(fixtureRoot, participants);
  const sourceLock = await buildH1bSourceLock(
    projectRoot,
    ['src/dev/discourseLab/h1cCli.ts']
  );
  const participantEntry = seal.files.find((entry) => entry.audience === 'PARTICIPANT');
  const scorerEntry = seal.files.find((entry) => entry.audience === 'SCORER_ONLY');
  const preregistrationEntry = seal.files.find((entry) => entry.audience === 'HARNESS');
  if (!participantEntry || !scorerEntry || !preregistrationEntry) {
    throw new Error('H1c seal audience assignment is incomplete.');
  }
  return {
    valid: true,
    sealVersion: seal.sealVersion,
    preregistrationVersion: preregistration.preregistrationVersion,
    verifiedFiles: structuredClone(seal.files),
    sourceLock,
    locks: {
      corpusVersion: H1C_CORPUS_VERSION,
      participantCorpusSha256: participantEntry.sha256,
      oracleCorpusSha256: scorerEntry.sha256,
      labSourceSha256: sourceLock.sha256,
      preregistrationVersion: preregistration.preregistrationVersion,
      preregistrationSha256: preregistrationEntry.sha256,
      promptVersion: H1C_PROMPT_VERSION,
      outputSchemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
      scoringVersion: H1C_SCORING_VERSION,
      protocolVersion: H1C_PROTOCOL_VERSION
    }
  };
}

function validatePreregistration(value: H1cPreregistration): void {
  const requiredStops = [
    'HARD_CALL_CAP',
    'HARD_TOKEN_CAP_BETWEEN_BLOCKS',
    'HARD_CALL_TIME',
    'HARD_EXPERIMENT_TIME',
    'EMERGENCY_OUTPUT_FENCE',
    'BOUNDARY_VIOLATION',
    'MISSING_USAGE',
    'PROVIDER_FAILURES',
    'CONSECUTIVE_INVALID_OUTPUTS',
    'UNANSWERABLE_EXPERIMENT',
    'CEILING',
    'CONFIRMATION_CLOSED'
  ];
  const stopIds = new Set(value.stoppingRules?.map((item) => item.stopId));
  const scope = value.scope;
  const model = value.model;
  const budget = value.budget;
  if (
    value.schemaVersion !== 'discourse-lab-h1c-preregistration@3' ||
    value.preregistrationVersion !== H1C_PREREGISTRATION_VERSION ||
    value.corpusVersion !== H1C_CORPUS_VERSION ||
    value.promptVersion !== H1C_PROMPT_VERSION ||
    value.outputSchemaVersion !== LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION ||
    value.scoringVersion !== H1C_SCORING_VERSION ||
    value.runnerVersion !== H1C_RUNNER_VERSION ||
    value.scheduleVersion !== 'h1c-yoked-counterbalanced-schedule@v3' ||
    value.experiment?.experimentId !== 'H1c' ||
    value.experiment.status !==
      'PROVIDER_FREE_V3_REPAIR_SEALED_FUTURE_EXECUTION_REQUIRES_FRESH_EXACT_MODEL_PROBE_AND_AUTHORIZATION' ||
    !value.experiment.decisionAffected.trim() ||
    value.experiment.hypotheses.length !== 2 ||
    !['H1c-D', 'H1c-E'].every((id) =>
      value.experiment.hypotheses.some((item) => item.hypothesisId === id)
    ) ||
    value.experiment.hypotheses.some((item) =>
      !item.exactHypothesis.trim() ||
      !item.mechanismIsolated.trim() ||
      !item.expectedDiscriminatingPattern.trim() ||
      !item.supportResult.trim() ||
      !item.rejectResult.trim() ||
      !item.decisionChanged.trim()
    ) ||
    scope.allowedContext !== 'ORDINARY_TEXT_ONLY' ||
    scope.toolsBrowsingRepositoriesTasksCode !== 'FORBIDDEN' ||
    scope.participantTruthAccess !== false ||
    scope.hiddenChainOfThoughtRequestedOrStored !== false ||
    scope.productBehaviorMayChange !== false ||
    scope.confirmationOpened !== false ||
    scope.newHeldOutDevelopmentCases !== 4 ||
    scope.repetitionsPerCase !== 2 ||
    scope.liveInitialSharedWithinBlock !== true ||
    scope.activeSelfReviewUsesSameThread !== true ||
    scope.reviewAndEvidenceResponsesUseFreshThreads !== true ||
    scope.critiqueAddsNewFacts !== false ||
    scope.evidenceAddsGenuinelyNewFacts !== true ||
    scope.schemaRepairs !== 0 ||
    scope.signalGenerationCostIncluded !== false ||
    scope.minorityPreservationEstimable !== false ||
    scope.archivedH1cV1OrV2CausallyRescored !== false ||
    scope.answerSummarySemanticsAdjudicated !== false ||
    scope.thisTurnProviderCallsAllowed !== false ||
    scope.futureExecutionAuthorized !== false ||
    scope.futureExecutionRequiresFreshExactModelProbe !== true ||
    scope.futureExecutionRequiresExplicitAuthorization !== true ||
    model.id !== 'gpt-5.6-sol' ||
    model.reasoningEffort !== 'high' ||
    model.serviceTier !== 'default' ||
    model.identicalAcrossPrimaryConditions !== true ||
    model.seedControl !== 'UNSUPPORTED' ||
    budget.maximumPrimaryCalls !== 28 ||
    budget.maximumCalls !== 28 ||
    budget.maximumPreparedPromptEstimateTokensPerCall !== 7000 ||
    budget.targetOutputTokensPerCall !== 900 ||
    budget.targetIsCensoringLimit !== false ||
    budget.emergencyOutputTokenSafetyCeilingPerCall !== 25000 ||
    budget.maximumObservedTotalTokens !== 300000 ||
    budget.maximumCallMs !== 120000 ||
    budget.maximumExperimentMs !== 2400000 ||
    requiredStops.some((id) => !stopIds.has(id)) ||
    Object.keys(value.metricDefinitions ?? {}).length < 8 ||
    value.causalLimitations.length < 4 ||
    value.confirmationLock.status !== 'ABSENT_CLOSED' ||
    value.confirmationLock.h1cConfirmationCorpusExists
  ) {
    throw new Error('H1c preregistration contract is invalid.');
  }
}

async function readRealJson<T>(filePath: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`H1c sealed input must be a real file: ${filePath}.`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function assertInside(candidate: string, parent: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`H1c sealed input escapes its fixture root: ${candidate}.`);
  }
}
