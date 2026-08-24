import fs from 'node:fs/promises';
import path from 'node:path';
import { LAB_PUBLIC_OUTPUT_SCHEMA_VERSION } from './contracts';
import {
  H1B_CORPUS_VERSION,
  h1bParticipantFixturePaths,
  h1bScorerFixturePaths,
  loadH1bOracleCorpus,
  loadH1bParticipantCorpus
} from './h1bCorpus';
import { sha256File, type LabComponentLock } from './ledger';
import { LAB_PROMPT_VERSION } from './prompts';
import { LAB_PROTOCOL_VERSION } from './protocols';
import { LAB_RUNNER_VERSION } from './runner';
import { H1B_SCORING_VERSION } from './h1bScoring';
import { buildH1bSourceLock, type H1bSourceLock } from './h1bSourceLock';

export const H1B_PREREGISTRATION_VERSION = 'h1b-preregistration-v1' as const;
export const H1B_SEAL_VERSION = 'h1b-seal-v1' as const;

interface H1bSeal {
  schemaVersion: 'discourse-lab-h1b-seal@1';
  sealVersion: typeof H1B_SEAL_VERSION;
  corpusVersion: typeof H1B_CORPUS_VERSION;
  preregistrationVersion: typeof H1B_PREREGISTRATION_VERSION;
  digestAlgorithm: 'SHA-256';
  partition: 'DEVELOPMENT_ONLY';
  confirmationStatus: 'ABSENT_CLOSED';
  files: Array<{
    path: string;
    audience: 'PARTICIPANT' | 'SCORER_ONLY' | 'HARNESS';
    sha256: string;
  }>;
}

interface H1bPreregistration {
  schemaVersion: 'discourse-lab-h1b-preregistration@1';
  preregistrationVersion: typeof H1B_PREREGISTRATION_VERSION;
  corpusVersion: typeof H1B_CORPUS_VERSION;
  promptVersion: typeof LAB_PROMPT_VERSION;
  scoringVersion: typeof H1B_SCORING_VERSION;
  protocolVersion: typeof LAB_PROTOCOL_VERSION;
  runnerVersion: typeof LAB_RUNNER_VERSION;
  experiment: {
    experimentId: 'H1b';
    status: 'DEVELOPMENT_ONLY_ELIGIBLE_AFTER_H0_AND_EXACT_MODEL_PROBE';
    hypotheses: Array<{
      hypothesisId: 'H1b-D' | 'H1b-E';
      exactHypothesis: string;
      mechanismIsolated: string;
      supportResult: string;
      rejectResult: string;
      decisionChanged: string;
    }>;
    conditions: string[];
    primaryCalls: 54;
    blocks: 18;
    repetitionsPerCell: 3;
  };
  scope: {
    allowedContext: 'ORDINARY_TEXT_ONLY';
    participantTruthAccess: false;
    hiddenChainOfThoughtRequestedOrStored: false;
    productBehaviorMayChange: false;
    confirmationOpened: false;
    fixedPrefixControlName: 'FIXED_PREFIX_ACTIVE_REASSESSMENT';
    fixedPrefixIsTrueSameThreadSelfReview: false;
    critiqueAddsNewFacts: false;
    evidenceAddsGenuinelyNewFacts: true;
    realizedTokensUsedForSelection: false;
    schemaRepairs: 0;
  };
  model: {
    id: 'gpt-5.6-sol';
    reasoningEffort: 'high';
    serviceTier: 'default';
    identicalAcrossPrimaryConditions: true;
    seedControl: 'UNSUPPORTED';
  };
  budget: {
    maximumPrimaryCalls: 54;
    maximumCalls: 54;
    maximumPreparedPromptEstimateTokensPerCall: 7000;
    targetOutputTokensPerCall: 900;
    targetIsCensoringLimit: false;
    emergencyOutputTokenSafetyCeilingPerCall: 25000;
    maximumObservedTotalTokens: 600000;
    maximumCallMs: 120000;
    maximumExperimentMs: 7200000;
  };
  stoppingRules: Array<{ stopId: string; rule: string }>;
  decisionRules: Record<string, unknown>;
  lunaSolIdea: {
    status: 'DEFERRED_SEPARATE_HYPOTHESIS';
    reason: string;
  };
  confirmationLock: {
    status: 'SEALED_NOT_OPENED';
    h1bConfirmationCorpusExists: false;
  };
}

export interface H1bValidationReport {
  valid: true;
  sealVersion: typeof H1B_SEAL_VERSION;
  preregistrationVersion: typeof H1B_PREREGISTRATION_VERSION;
  verifiedFiles: H1bSeal['files'];
  sourceLock: H1bSourceLock;
  locks: LabComponentLock;
}

export async function validateH1bInputs(fixtureRoot: string): Promise<H1bValidationReport> {
  const projectRoot = path.resolve(fixtureRoot, '..', '..');
  const sealPath = path.join(fixtureRoot, 'seal-h1b-v1.json');
  const seal = await readRealJson<H1bSeal>(sealPath);
  if (
    seal.schemaVersion !== 'discourse-lab-h1b-seal@1' ||
    seal.sealVersion !== H1B_SEAL_VERSION ||
    seal.corpusVersion !== H1B_CORPUS_VERSION ||
    seal.preregistrationVersion !== H1B_PREREGISTRATION_VERSION ||
    seal.digestAlgorithm !== 'SHA-256' ||
    seal.partition !== 'DEVELOPMENT_ONLY' ||
    seal.confirmationStatus !== 'ABSENT_CLOSED' ||
    seal.files.length !== 3
  ) {
    throw new Error('H1b seal header or development-only boundary is invalid.');
  }
  const expectedPaths = new Set([
    ...h1bParticipantFixturePaths(fixtureRoot),
    ...h1bScorerFixturePaths(fixtureRoot),
    path.join(fixtureRoot, 'preregistration', 'h1b-v1.json')
  ].map((filePath) => path.relative(projectRoot, filePath).split(path.sep).join('/')));
  if (
    new Set(seal.files.map((entry) => entry.path)).size !== seal.files.length ||
    seal.files.some((entry) => !expectedPaths.has(entry.path)) ||
    expectedPaths.size !== seal.files.length
  ) {
    throw new Error('H1b seal does not exactly cover the public, scorer-only, and preregistration inputs.');
  }
  for (const entry of seal.files) {
    const resolved = path.resolve(projectRoot, entry.path);
    assertInside(resolved, fixtureRoot);
    if (await sha256File(resolved) !== entry.sha256) {
      throw new Error(`Sealed H1b input changed: ${entry.path}`);
    }
  }
  const preregistrationPath = path.join(fixtureRoot, 'preregistration', 'h1b-v1.json');
  const preregistration = await readRealJson<H1bPreregistration>(preregistrationPath);
  validatePreregistration(preregistration);
  const participants = await loadH1bParticipantCorpus(fixtureRoot);
  await loadH1bOracleCorpus(fixtureRoot, participants);
  const sourceLock = await buildH1bSourceLock(projectRoot);
  const participantEntry = seal.files.find((entry) => entry.audience === 'PARTICIPANT');
  const scorerEntry = seal.files.find((entry) => entry.audience === 'SCORER_ONLY');
  const preregEntry = seal.files.find((entry) => entry.audience === 'HARNESS');
  if (!participantEntry || !scorerEntry || !preregEntry) {
    throw new Error('H1b seal audience assignment is incomplete.');
  }
  return {
    valid: true,
    sealVersion: seal.sealVersion,
    preregistrationVersion: preregistration.preregistrationVersion,
    verifiedFiles: structuredClone(seal.files),
    sourceLock,
    locks: {
      corpusVersion: H1B_CORPUS_VERSION,
      participantCorpusSha256: participantEntry.sha256,
      oracleCorpusSha256: scorerEntry.sha256,
      labSourceSha256: sourceLock.sha256,
      preregistrationVersion: preregistration.preregistrationVersion,
      preregistrationSha256: preregEntry.sha256,
      promptVersion: LAB_PROMPT_VERSION,
      outputSchemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
      scoringVersion: H1B_SCORING_VERSION,
      protocolVersion: LAB_PROTOCOL_VERSION
    }
  };
}

function validatePreregistration(value: H1bPreregistration): void {
  const stopIds = new Set(value.stoppingRules?.map((item) => item.stopId));
  const requiredStops = [
    'HARD_CALL_CAP',
    'HARD_TOKEN_CAP_BETWEEN_BLOCKS',
    'HARD_CALL_TIME',
    'HARD_EXPERIMENT_TIME',
    'BOUNDARY_VIOLATION',
    'MISSING_USAGE',
    'PROVIDER_FAILURES',
    'SCHEMA_FAILURES',
    'UNANSWERABLE_EXPERIMENT'
  ];
  if (
    value.schemaVersion !== 'discourse-lab-h1b-preregistration@1' ||
    value.preregistrationVersion !== H1B_PREREGISTRATION_VERSION ||
    value.corpusVersion !== H1B_CORPUS_VERSION ||
    value.promptVersion !== LAB_PROMPT_VERSION ||
    value.scoringVersion !== H1B_SCORING_VERSION ||
    value.protocolVersion !== LAB_PROTOCOL_VERSION ||
    value.runnerVersion !== LAB_RUNNER_VERSION ||
    value.experiment?.experimentId !== 'H1b' ||
    value.experiment.status !== 'DEVELOPMENT_ONLY_ELIGIBLE_AFTER_H0_AND_EXACT_MODEL_PROBE' ||
    value.experiment.hypotheses.length !== 2 ||
    !['H1b-D', 'H1b-E'].every((id) =>
      value.experiment.hypotheses.some((item) => item.hypothesisId === id)
    ) ||
    value.experiment.hypotheses.some((item) =>
      !item.exactHypothesis.trim() ||
      !item.mechanismIsolated.trim() ||
      !item.supportResult.trim() ||
      !item.rejectResult.trim() ||
      !item.decisionChanged.trim()
    ) ||
    value.experiment.primaryCalls !== 54 ||
    value.experiment.blocks !== 18 ||
    value.experiment.repetitionsPerCell !== 3 ||
    value.scope.allowedContext !== 'ORDINARY_TEXT_ONLY' ||
    value.scope.participantTruthAccess ||
    value.scope.hiddenChainOfThoughtRequestedOrStored ||
    value.scope.productBehaviorMayChange ||
    value.scope.confirmationOpened ||
    value.scope.fixedPrefixControlName !== 'FIXED_PREFIX_ACTIVE_REASSESSMENT' ||
    value.scope.fixedPrefixIsTrueSameThreadSelfReview ||
    value.scope.critiqueAddsNewFacts ||
    !value.scope.evidenceAddsGenuinelyNewFacts ||
    value.scope.realizedTokensUsedForSelection ||
    value.scope.schemaRepairs !== 0 ||
    value.model.id !== 'gpt-5.6-sol' ||
    value.model.reasoningEffort !== 'high' ||
    value.model.serviceTier !== 'default' ||
    !value.model.identicalAcrossPrimaryConditions ||
    value.model.seedControl !== 'UNSUPPORTED' ||
    value.budget.maximumPrimaryCalls !== 54 ||
    value.budget.maximumCalls !== 54 ||
    value.budget.maximumPreparedPromptEstimateTokensPerCall !== 7000 ||
    value.budget.targetOutputTokensPerCall !== 900 ||
    value.budget.targetIsCensoringLimit ||
    value.budget.emergencyOutputTokenSafetyCeilingPerCall !== 25000 ||
    value.budget.maximumObservedTotalTokens !== 600000 ||
    value.budget.maximumCallMs !== 120000 ||
    value.budget.maximumExperimentMs !== 7200000 ||
    requiredStops.some((id) => !stopIds.has(id)) ||
    Object.keys(value.decisionRules ?? {}).length === 0 ||
    value.lunaSolIdea.status !== 'DEFERRED_SEPARATE_HYPOTHESIS' ||
    !value.lunaSolIdea.reason.trim() ||
    value.confirmationLock.status !== 'SEALED_NOT_OPENED' ||
    value.confirmationLock.h1bConfirmationCorpusExists
  ) {
    throw new Error('H1b preregistration contract is invalid.');
  }
}

async function readRealJson<T>(filePath: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`H1b input must be a real file: ${filePath}`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function assertInside(candidate: string, parent: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`H1b sealed input escapes the fixture root: ${candidate}`);
  }
}
