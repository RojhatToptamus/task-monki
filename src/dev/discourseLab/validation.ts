import fs from 'node:fs/promises';
import path from 'node:path';
import { LAB_PUBLIC_OUTPUT_SCHEMA_VERSION } from './contracts';
import { LAB_CORPUS_VERSION } from './corpus';
import type { LabComponentLock } from './ledger';
import { sha256File, sha256Text } from './ledger';
import {
  assertFiniteProtocolPlan,
  listLabConditionDeclarations,
  listLabProtocolPlans,
  type LabConditionDeclaration
} from './protocols';
import { LAB_SCORING_VERSION } from './scoring';

// V8 is an immutable historical cohort. Its validator intentionally retains
// the component versions recorded in seal-v8 even while newer H1b components
// live beside it. H1b has its own validator and seal.
const V8_PROMPT_VERSION = 'text-lab-prompts-v5';
const V8_PROTOCOL_VERSION = 'text-protocols@v3';

interface LabSeal {
  schemaVersion: string;
  sealVersion: string;
  corpusVersion: string;
  preregistrationVersion: string;
  digestAlgorithm: string;
  confirmationAuthorComplete: boolean;
  files: Array<{
    path: string;
    audience: 'PARTICIPANT' | 'SCORER_ONLY' | 'HARNESS';
    sha256: string;
  }>;
}

interface LabPreregistration {
  schemaVersion: string;
  preregistrationVersion: string;
  corpusVersion: string;
  promptVersion: string;
  metricVersion: string;
  componentVersions: {
    protocolVersion: string;
    runnerVersion: string;
    harnessValidationVersion: string;
    controlledExperimentVersion: string;
    controlledPlanVersion: string;
    assignmentOrderVersion: string;
    ledgerSchemaVersion: string;
    publicOutputSchemaVersion: string;
  };
  scope: {
    allowedContext: string;
    participantTruthAccess: boolean;
    hiddenChainOfThoughtRequestedOrStored: boolean;
    productBehaviorMayChange: boolean;
    h1DevelopmentEstimand: string;
    h1DevelopmentOutputPolicy: {
      conciseOutputTargetTokensPerAttempt: number;
      targetIsCensoringLimit: boolean;
      emergencyStreamingInterruptThresholdTokensPerAttempt: number;
      preserveThresholdCrossingAndOvershoot: boolean;
      providerUsageRequiredBeforeNextDispatch: boolean;
      missingUsageStopsWave: boolean;
    };
    h1DevelopmentAnalysisPolicy: {
      primaryPopulation: string;
      excludeForTargetOvershoot: boolean;
      matchOrConditionOnRealizedTokensForPrimaryContrast: boolean;
      realizedTokensLatencyOvershootAndFailuresAreOutcomes: boolean;
    };
    h1DevelopmentAccountingPolicy: {
      preparedPromptEstimateCeilingTokensPerAttempt: number;
      providerReportedInputTokensAreRetrospective: boolean;
      providerReportedOutputTokensAreRetrospective: boolean;
      providerInputTokensCapped: boolean;
      providerOutputTokensCapped: boolean;
      aggregateObservedTotalTokenCandidate: number;
      aggregateStopCheckedBetweenAttempts: boolean;
      retainAtomicAttemptOvershoot: boolean;
    };
    h1ControlledResponseTargetPolicy: {
      controlledSignalsAreStructuredIssueTargets: boolean;
      validTargetsProjectedFromVisibleStructuredIssues: boolean;
      emptyTargetListRequiresEmptyResponses: boolean;
      inventedTargetIssueIdsRejected: boolean;
    };
    h1DevelopmentBoundaryPolicy: {
      acceptedBoundaryClasses: string[];
      fallbackPhase: string;
      freshPreflightRequired: boolean;
      emptyInheritedInstructionsRequired: boolean;
      noToolOrMcpContextRequired: boolean;
      launchDisabledFeatures: string[];
      launchDisabledMcpServers: string[];
      launchMcpDisableConfigKeys: string[];
      rejectAnyMcpStartupEvent: boolean;
      strictBoundaryRequiredForConfirmation: boolean;
      strictBoundaryRequiredForH2Plus: boolean;
    };
    h1PrimaryModelPolicy: {
      model: string;
      reasoningEffort: string;
      serviceTier: string;
      identicalAcrossPrimaryConditions: boolean;
      smallerModelsOnlyAsSeparatelyLabeledHarnessTests: boolean;
    };
  };
  confirmationLock: { status: string; unlockRequires: string[] };
  budgetClasses: Record<string, Record<string, unknown>>;
  globalStoppingRules: Array<{ stopId: string; rule: string }>;
  metrics: Record<string, unknown>;
  experiments: Array<{
    experimentId: string;
    status: string;
    exactHypothesis: string;
    mechanismIsolated: string;
    supportResult: string;
    rejectResult: string;
    decisionChanged: string;
    budgetClass: string;
    conditions: string[];
    primaryMetrics: string[];
    stoppingConditions: string[];
    eligibilityGate: string;
  }>;
}

export interface LabValidationReport {
  valid: true;
  sealVersion: string;
  preregistrationVersion: string;
  verifiedFiles: Array<{ path: string; audience: string; sha256: string }>;
  preregisteredExperimentIds: string[];
  executableProtocolConditionIds: string[];
  nonExecutableProtocolConditions: Array<{
    conditionId: string;
    preregisteredLabel: string;
    executionStatus: 'REQUIRES_FROZEN_PREFIX_REPLAY' | 'DEFERRED_PREREG_ONLY';
  }>;
  locks: LabComponentLock;
}

export async function validateLabInputs(fixtureRoot: string): Promise<LabValidationReport> {
  const projectRoot = path.resolve(fixtureRoot, '..', '..');
  const sealPath = path.join(fixtureRoot, 'seal-v8.json');
  const seal = await readRealJson<LabSeal>(sealPath);
  if (
    seal.schemaVersion !== 'discourse-lab-seal@1' ||
    seal.sealVersion !== 'text-lab-seal-v8' ||
    seal.corpusVersion !== LAB_CORPUS_VERSION ||
    seal.preregistrationVersion !== 'text-lab-prereg-v8' ||
    seal.digestAlgorithm !== 'SHA-256' ||
    !seal.confirmationAuthorComplete ||
    seal.files.length !== 7
  ) {
    throw new Error('Discourse Lab seal header or confirmation-authorship flag is invalid.');
  }
  const verifiedFiles: LabValidationReport['verifiedFiles'] = [];
  for (const entry of seal.files) {
    const resolved = path.resolve(projectRoot, entry.path);
    if (!isInside(resolved, fixtureRoot)) {
      throw new Error(`Sealed lab input escapes the fixture root: ${entry.path}`);
    }
    const actual = await sha256File(resolved);
    if (actual !== entry.sha256) {
      throw new Error(`Sealed lab input changed: ${entry.path}`);
    }
    verifiedFiles.push({ ...entry });
  }
  const preregistrationPath = path.join(fixtureRoot, 'preregistration', 'v8.json');
  const preregistration = await readRealJson<LabPreregistration>(preregistrationPath);
  validatePreregistration(preregistration, seal.preregistrationVersion);
  const plans = listLabProtocolPlans();
  plans.forEach(assertFiniteProtocolPlan);
  const nonExecutableProtocolConditions = listLabConditionDeclarations().filter(
    (
      condition
    ): condition is LabConditionDeclaration & {
      executionStatus: 'REQUIRES_FROZEN_PREFIX_REPLAY' | 'DEFERRED_PREREG_ONLY';
    } => condition.executionStatus !== 'EXECUTABLE_FULL_LIVE'
  );
  const preregisteredConditionLabels = new Set(
    preregistration.experiments.flatMap((experiment) => experiment.conditions)
  );
  for (const condition of nonExecutableProtocolConditions) {
    if (!preregisteredConditionLabels.has(condition.preregisteredLabel)) {
      throw new Error(
        `Non-executable condition ${condition.conditionId} is not traceable to its preregistered label.`
      );
    }
  }

  const participantHashes = seal.files
    .filter((entry) => entry.audience === 'PARTICIPANT')
    .map((entry) => entry.sha256);
  const oracleHashes = seal.files
    .filter((entry) => entry.audience === 'SCORER_ONLY')
    .map((entry) => entry.sha256);
  const preregistrationHash = seal.files.find(
    (entry) => entry.path.endsWith('/preregistration/v8.json')
  )?.sha256;
  if (!preregistrationHash) throw new Error('Seal omits the preregistration input.');
  return {
    valid: true,
    sealVersion: seal.sealVersion,
    preregistrationVersion: preregistration.preregistrationVersion,
    verifiedFiles,
    preregisteredExperimentIds: preregistration.experiments.map((item) => item.experimentId),
    executableProtocolConditionIds: plans.map((item) => item.conditionId),
    nonExecutableProtocolConditions: nonExecutableProtocolConditions.map((condition) => ({
      conditionId: condition.conditionId,
      preregisteredLabel: condition.preregisteredLabel,
      executionStatus: condition.executionStatus
    })),
    locks: {
      corpusVersion: LAB_CORPUS_VERSION,
      participantCorpusSha256: sha256Text(participantHashes.join('\n')),
      oracleCorpusSha256: sha256Text(oracleHashes.join('\n')),
      labSourceSha256: await labSourceDigest(projectRoot),
      preregistrationVersion: preregistration.preregistrationVersion,
      preregistrationSha256: preregistrationHash,
      promptVersion: V8_PROMPT_VERSION,
      outputSchemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
      scoringVersion: LAB_SCORING_VERSION,
      protocolVersion: V8_PROTOCOL_VERSION
    }
  };
}

async function labSourceDigest(projectRoot: string): Promise<string> {
  const sourceRoot = path.join(projectRoot, 'src', 'dev', 'discourseLab');
  const names = (await fs.readdir(sourceRoot))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
  if (names.length === 0) throw new Error('Discourse Lab runtime source set is empty.');
  const entries = await Promise.all(
    names.map(async (name) => `${name}:${await sha256File(path.join(sourceRoot, name))}`)
  );
  return sha256Text(entries.join('\n'));
}

function validatePreregistration(
  value: LabPreregistration,
  sealedVersion: string
): void {
  if (
    value.schemaVersion !== 'discourse-lab-preregistration@1' ||
    value.preregistrationVersion !== sealedVersion ||
    value.corpusVersion !== LAB_CORPUS_VERSION ||
    value.promptVersion !== V8_PROMPT_VERSION ||
    value.metricVersion !== LAB_SCORING_VERSION ||
    value.componentVersions.protocolVersion !== V8_PROTOCOL_VERSION ||
    value.componentVersions.runnerVersion !== 'finite-text-runner@v5' ||
    value.componentVersions.harnessValidationVersion !== 'h0-validation@v6' ||
    value.componentVersions.controlledExperimentVersion !== 'controlled-selective-updating@v5' ||
    value.componentVersions.controlledPlanVersion !== 'h1-controlled-plan@v6' ||
    value.componentVersions.assignmentOrderVersion !== 'sealed-counterbalanced-order@v1' ||
    value.componentVersions.ledgerSchemaVersion !== 'task-monki/discourse-lab-ledger@v5' ||
    value.componentVersions.publicOutputSchemaVersion !== LAB_PUBLIC_OUTPUT_SCHEMA_VERSION ||
    value.scope.allowedContext !== 'ORDINARY_TEXT_ONLY' ||
    value.scope.participantTruthAccess ||
    value.scope.hiddenChainOfThoughtRequestedOrStored ||
    value.scope.productBehaviorMayChange ||
    !validH1DevelopmentContract(value)
  ) {
    throw new Error('Discourse Lab preregistration scope or component version is invalid.');
  }
  const experimentIds = value.experiments.map((item) => item.experimentId);
  if (
    experimentIds.length !== 8 ||
    new Set(experimentIds).size !== 8 ||
    !['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7'].every((id) =>
      experimentIds.includes(id)
    )
  ) {
    throw new Error('Preregistration must contain exactly decision-changing H0-H7 experiments.');
  }
  for (const experiment of value.experiments) {
    if (
      !experiment.exactHypothesis.trim() ||
      !experiment.mechanismIsolated.trim() ||
      !experiment.supportResult.trim() ||
      !experiment.rejectResult.trim() ||
      !experiment.decisionChanged.trim() ||
      !experiment.budgetClass.trim() ||
      experiment.primaryMetrics.length === 0 ||
      experiment.stoppingConditions.length === 0
    ) {
      throw new Error(`Preregistered experiment ${experiment.experimentId} cannot change a documented decision.`);
    }
  }
  const stopIds = new Set(value.globalStoppingRules.map((item) => item.stopId));
  for (const required of [
    'HARD_CALL_CAP',
    'HARD_ROUND_CAP',
    'HARD_TOKEN_CAP',
    'MISSING_PROVIDER_USAGE',
    'HARD_TIME_CAP',
    'NO_NEW_EVIDENCE',
    'REPEATED_BEHAVIOR',
    'UNANSWERABLE_EXPERIMENT'
  ]) {
    if (!stopIds.has(required)) throw new Error(`Preregistration omits stopping rule ${required}.`);
  }
  if (
    value.confirmationLock.status !== 'SEALED_NOT_YET_RUN' ||
    value.confirmationLock.unlockRequires.length === 0
  ) {
    throw new Error('Confirmation cases are not correctly sealed before development inspection.');
  }
}

function validH1DevelopmentContract(value: LabPreregistration): boolean {
  const scope = value.scope;
  const output = scope.h1DevelopmentOutputPolicy;
  const analysis = scope.h1DevelopmentAnalysisPolicy;
  const accounting = scope.h1DevelopmentAccountingPolicy;
  const responseTargets = scope.h1ControlledResponseTargetPolicy;
  const boundary = scope.h1DevelopmentBoundaryPolicy;
  const model = scope.h1PrimaryModelPolicy;
  const b1 = value.budgetClasses.B1 as Record<string, unknown> | undefined;
  const h1 = value.experiments.find((experiment) => experiment.experimentId === 'H1');
  const laterExperiments = value.experiments.filter(
    (experiment) => experiment.experimentId !== 'H0' && experiment.experimentId !== 'H1'
  );
  return (
    scope.h1DevelopmentEstimand?.trim().length > 0 &&
    output?.conciseOutputTargetTokensPerAttempt === 900 &&
    output.targetIsCensoringLimit === false &&
    output.emergencyStreamingInterruptThresholdTokensPerAttempt === 25_000 &&
    output.preserveThresholdCrossingAndOvershoot === true &&
    output.providerUsageRequiredBeforeNextDispatch === true &&
    output.missingUsageStopsWave === true &&
    analysis?.primaryPopulation === 'INTENTION_TO_TREAT_ALL_ASSIGNED_VARIANTS' &&
    analysis.excludeForTargetOvershoot === false &&
    analysis.matchOrConditionOnRealizedTokensForPrimaryContrast === false &&
    analysis.realizedTokensLatencyOvershootAndFailuresAreOutcomes === true &&
    accounting?.preparedPromptEstimateCeilingTokensPerAttempt === 7_000 &&
    accounting.providerReportedInputTokensAreRetrospective === true &&
    accounting.providerReportedOutputTokensAreRetrospective === true &&
    accounting.providerInputTokensCapped === false &&
    accounting.providerOutputTokensCapped === false &&
    accounting.aggregateObservedTotalTokenCandidate === 300_000 &&
    accounting.aggregateStopCheckedBetweenAttempts === true &&
    accounting.retainAtomicAttemptOvershoot === true &&
    responseTargets?.controlledSignalsAreStructuredIssueTargets === false &&
    responseTargets.validTargetsProjectedFromVisibleStructuredIssues === true &&
    responseTargets.emptyTargetListRequiresEmptyResponses === true &&
    responseTargets.inventedTargetIssueIdsRejected === true &&
    boundary?.acceptedBoundaryClasses.length === 2 &&
    boundary.acceptedBoundaryClasses.includes('PROVIDER_ENFORCED_STRICT') &&
    boundary.acceptedBoundaryClasses.includes('H1_DEVELOPMENT_HARNESS_VERIFIED') &&
    boundary.fallbackPhase === 'DEVELOPMENT_ONLY' &&
    boundary.freshPreflightRequired === true &&
    boundary.emptyInheritedInstructionsRequired === true &&
    boundary.noToolOrMcpContextRequired === true &&
    boundary.launchDisabledFeatures.length === 2 &&
    boundary.launchDisabledFeatures[0] === 'plugins' &&
    boundary.launchDisabledFeatures[1] === 'remote_plugin' &&
    boundary.launchDisabledMcpServers.length === 1 &&
    boundary.launchDisabledMcpServers[0] === 'openai-api-key-local-confirmation' &&
    boundary.launchMcpDisableConfigKeys.length === 1 &&
    boundary.launchMcpDisableConfigKeys[0] ===
      'plugins.openai-developers.mcp_servers.openai-api-key-local-confirmation.enabled' &&
    boundary.rejectAnyMcpStartupEvent === true &&
    boundary.strictBoundaryRequiredForConfirmation === true &&
    boundary.strictBoundaryRequiredForH2Plus === true &&
    model?.model === 'gpt-5.6-sol' &&
    model.reasoningEffort === 'high' &&
    model.serviceTier === 'default' &&
    model.identicalAcrossPrimaryConditions === true &&
    model.smallerModelsOnlyAsSeparatelyLabeledHarnessTests === true &&
    b1 !== undefined &&
    b1.maxPreparedPromptEstimateTokensPerCall === 7_000 &&
    b1.providerInputUsagePolicy === 'RETROSPECTIVE_NOT_CAPPED' &&
    b1.targetOutputTokensPerCall === 900 &&
    b1.outputCompletionPolicy === 'NATURAL_COMPLETION_TARGET_NOT_CENSOR' &&
    b1.emergencyOutputTokenSafetyCeilingPerCall === 25_000 &&
    b1.targetTotalOutputTokens === 1_800 &&
    b1.maxTotalEmergencyOutputTokenSafetyCeiling === 50_000 &&
    !('maxOutputTokensPerCall' in b1) &&
    h1?.status === 'ELIGIBLE_AFTER_H0' &&
    h1.budgetClass === 'B1' &&
    laterExperiments.every((experiment) => /^(BLOCKED|DEFERRED)/u.test(experiment.status))
  );
}

async function readRealJson<T>(filePath: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Discourse Lab input must be a real file: ${filePath}`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}
