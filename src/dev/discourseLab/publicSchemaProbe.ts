import fs from 'node:fs/promises';
import path from 'node:path';
import { LAB_PUBLIC_OUTPUT_SCHEMA_VERSION } from './contracts';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  sha256Text,
  stableJson,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import {
  LAB_PUBLIC_OUTPUT_JSON_SCHEMA,
  validateLabPublicOutput
} from './outputValidation';
import type {
  LabDriverPreflight,
  LabTextCallResult
} from './textDriver';
import { CODEX_LAB_TEXT_DRIVER_ID } from './CodexTextDriver';

export const LAB_PUBLIC_SCHEMA_PROBE_REPORT_VERSION =
  'task-monki/discourse-lab-public-schema-probe@v2' as const;
export const LAB_PUBLIC_SCHEMA_PROBE_VERSION = 'public-schema-probe@v2' as const;
export const LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID = CODEX_LAB_TEXT_DRIVER_ID;
export const LAB_PUBLIC_SCHEMA_PROBE_MODEL = 'gpt-5.6-sol' as const;
export const LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT = 'high' as const;
export const LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER = 'default' as const;
export const LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS = 900 as const;
export const LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS = 25_000 as const;
export const LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_CALL_MS = 120_000 as const;
export const LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS = 180_000 as const;
export const LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_OBSERVED_TOTAL_TOKENS = 100_000 as const;

export const LAB_PUBLIC_SCHEMA_PROBE_PROMPT = [
  `DISCOURSE_PROTOCOL_LAB_SCHEMA_PROBE_VERSION: ${LAB_PUBLIC_SCHEMA_PROBE_VERSION}`,
  '',
  'This is a harmless ordinary-text compatibility probe, not a corpus case.',
  'Return exactly one public-output JSON object stating that two plus two equals four.',
  'Use status ANSWER, answer value "4", no issues, no disagreements, no user question,',
  'and a NO_DISAGREEMENT / NO_MATERIAL_ISSUE resolution.',
  'Do not use tools, files, browsing, repositories, outside context, or hidden reasoning.'
].join('\n');

export const LAB_PUBLIC_SCHEMA_PROBE_SCHEMA_SHA256 = sha256Text(
  `${stableJson(LAB_PUBLIC_OUTPUT_JSON_SCHEMA)}\n`
);
export const LAB_PUBLIC_SCHEMA_PROBE_PROMPT_SHA256 = sha256Text(
  LAB_PUBLIC_SCHEMA_PROBE_PROMPT
);

export interface LabPublicSchemaProbeCloseResult {
  status: 'CLEAN' | 'FAILED' | 'TIMED_OUT';
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  maximumMs: number;
  boundaryViolations: string[];
  failure?: LabFailureDetail;
}

/** Bounded recursive diagnostic retained for shutdown and provider failures. */
export interface LabFailureDetail extends Record<string, unknown> {
  name: string;
  message: string;
  cause?: LabFailureDetail;
  errors?: LabFailureDetail[];
  omittedErrors?: number;
  truncated?: true;
}

export interface LabPublicSchemaProbeReport {
  schemaVersion: typeof LAB_PUBLIC_SCHEMA_PROBE_REPORT_VERSION;
  probeVersion: typeof LAB_PUBLIC_SCHEMA_PROBE_VERSION;
  runId: string;
  status: 'PASSED' | 'FAILED';
  startedAt: string;
  completedAt: string;
  componentLocks: LabComponentLock;
  driverId: typeof LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID;
  model: typeof LAB_PUBLIC_SCHEMA_PROBE_MODEL;
  reasoningEffort: typeof LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT;
  serviceTier: typeof LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER;
  publicOutputSchemaVersion: typeof LAB_PUBLIC_OUTPUT_SCHEMA_VERSION;
  publicOutputSchemaSha256: string;
  promptSha256: string;
  budgets: {
    maximumAttempts: 1;
    targetOutputTokens: typeof LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS;
    safetyOutputTokens: typeof LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS;
    maximumCallMs: typeof LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_CALL_MS;
    maximumExperimentMs: typeof LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS;
  };
  boundary: LabDriverPreflight | null;
  call: LabTextCallResult | null;
  localValidation: {
    status: 'PASSED' | 'FAILED' | 'NOT_RUN';
    errors: Array<{ path: string; code: string; message: string }>;
  };
  close: LabPublicSchemaProbeCloseResult;
  latency: {
    probeElapsedMs: number;
    callElapsedMs: number | null;
    closeElapsedMs: number;
  };
  operationFailure?: { name: string; message: string };
  failedChecks: string[];
}

export interface LabPublicSchemaProbeReceipt {
  runId: string;
  manifestSha256: string;
  reportSha256: string;
  publicOutputSchemaSha256: string;
  report: LabPublicSchemaProbeReport;
}

export function publicSchemaProbeManifestBudget(): LabRunManifest['budgets'] {
  return {
    maximumCalls: 1,
    maximumRounds: 1,
    maximumOutputTokens: LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS,
    maximumOutputTokenSafetyCeiling: LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS,
    maximumObservedTotalTokens: LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_OBSERVED_TOTAL_TOKENS,
    maximumCallMs: LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_CALL_MS,
    maximumExperimentMs: LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS
  };
}

export function buildPublicSchemaProbeReport(input: {
  runId: string;
  startedAt: string;
  completedAt: string;
  componentLocks: LabComponentLock;
  boundary: LabDriverPreflight | null;
  call: LabTextCallResult | null;
  close: LabPublicSchemaProbeCloseResult;
  operationFailure?: { name: string; message: string };
}): LabPublicSchemaProbeReport {
  const localValidation = validateProbeRawOutput(input.call?.rawText);
  const partial: Omit<LabPublicSchemaProbeReport, 'status' | 'failedChecks'> = {
    schemaVersion: LAB_PUBLIC_SCHEMA_PROBE_REPORT_VERSION,
    probeVersion: LAB_PUBLIC_SCHEMA_PROBE_VERSION,
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    componentLocks: structuredClone(input.componentLocks),
    driverId: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
    model: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
    reasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
    serviceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
    publicOutputSchemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    publicOutputSchemaSha256: LAB_PUBLIC_SCHEMA_PROBE_SCHEMA_SHA256,
    promptSha256: LAB_PUBLIC_SCHEMA_PROBE_PROMPT_SHA256,
    budgets: {
      maximumAttempts: 1,
      targetOutputTokens: LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS,
      safetyOutputTokens: LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS,
      maximumCallMs: LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_CALL_MS,
      maximumExperimentMs: LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS
    },
    boundary: input.boundary ? structuredClone(input.boundary) : null,
    call: input.call ? structuredClone(input.call) : null,
    localValidation,
    close: structuredClone(input.close),
    latency: {
      probeElapsedMs: elapsedMs(input.startedAt, input.completedAt),
      callElapsedMs: input.call
        ? elapsedMs(input.call.submittedAt, input.call.completedAt)
        : null,
      closeElapsedMs: input.close.elapsedMs
    },
    ...(input.operationFailure
      ? { operationFailure: structuredClone(input.operationFailure) }
      : {})
  };
  const failedChecks = publicSchemaProbeProblems(partial);
  return {
    ...partial,
    status: failedChecks.length === 0 ? 'PASSED' : 'FAILED',
    failedChecks
  };
}

export function publicSchemaProbeBoundaryAllowsDispatch(
  boundary: LabDriverPreflight
): boolean {
  return (
    boundary.driverId === LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID &&
    boundary.ready &&
    boundary.accountPresent &&
    !boundary.requiresAuthentication &&
    boundary.capabilities.textOnlyProviderEnforced === false &&
    boundary.capabilities.hardOutputTokenLimit === false &&
    boundary.capabilities.hardCallTimeLimit === true &&
    boundary.capabilities.harnessVerifiedTextIsolation === true &&
    boundary.capabilities.streamingOutputTokenInterrupt === true &&
    boundary.capabilities.providerReportedTokenUsage === true &&
    boundary.boundary.status === 'ATTESTED' &&
    !boundary.boundary.failure &&
    boundary.boundary.requestedModel === LAB_PUBLIC_SCHEMA_PROBE_MODEL &&
    boundary.boundary.observedModel === LAB_PUBLIC_SCHEMA_PROBE_MODEL &&
    boundary.boundary.requestedReasoningEffort ===
      LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT &&
    boundary.boundary.observedReasoningEffort ===
      LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT &&
    boundary.boundary.requestedServiceTier === LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER &&
    boundary.boundary.observedServiceTier === LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER &&
    boundary.boundary.instructionSources.length === 0 &&
    boundary.boundary.mcpStartupEvents.length === 0 &&
    boundary.boundary.mismatchFields.length === 0 &&
    boundary.models.some(
      (candidate) =>
        (candidate.id === LAB_PUBLIC_SCHEMA_PROBE_MODEL ||
          candidate.model === LAB_PUBLIC_SCHEMA_PROBE_MODEL) &&
        candidate.supportedReasoningEfforts.includes(
          LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT
        )
    )
  );
}

export async function loadPublicSchemaProbeReceipt(
  stateRoot: string,
  runId: string,
  activeLocks: LabComponentLock
): Promise<LabPublicSchemaProbeReceipt> {
  if (!isSafeRunId(runId)) {
    throw new Error('H1 public-schema probe receipt has an unsafe run id.');
  }
  const root = path.resolve(stateRoot);
  const runs = path.join(root, 'runs');
  const runDirectory = path.join(runs, runId);
  const reports = path.join(runDirectory, 'reports');
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const reportPath = path.join(reports, 'public-schema-probe.json');
  await Promise.all([
    assertRealDirectory(root),
    assertRealDirectory(runs),
    assertRealDirectory(runDirectory),
    assertRealDirectory(reports),
    assertRealFile(manifestPath),
    assertRealFile(reportPath)
  ]);
  const [manifestText, reportText] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(reportPath, 'utf8')
  ]);
  let manifest: LabRunManifest;
  let report: LabPublicSchemaProbeReport;
  try {
    manifest = JSON.parse(manifestText) as LabRunManifest;
    report = JSON.parse(reportText) as LabPublicSchemaProbeReport;
  } catch {
    throw new Error('H1 public-schema probe receipt contains invalid JSON.');
  }
  const manifestProblems = publicSchemaProbeManifestProblems(
    manifest,
    runId,
    activeLocks
  );
  if (manifestProblems.length > 0) {
    throw new Error(
      `H1 public-schema probe manifest failed: ${[...new Set(manifestProblems)].join(', ')}.`
    );
  }
  const reportProblems = publicSchemaProbeReceiptProblems(report, runId, activeLocks);
  if (reportProblems.length > 0) {
    throw new Error(
      `H1 public-schema probe report failed: ${[...new Set(reportProblems)].join(', ')}.`
    );
  }
  return {
    runId,
    manifestSha256: sha256Text(manifestText),
    reportSha256: sha256Text(reportText),
    publicOutputSchemaSha256: report.publicOutputSchemaSha256,
    report
  };
}

function publicSchemaProbeManifestProblems(
  manifest: LabRunManifest,
  runId: string,
  activeLocks: LabComponentLock
): string[] {
  const problems: string[] = [];
  if (manifest.schemaVersion !== LAB_LEDGER_SCHEMA_VERSION) problems.push('schemaVersion');
  if (manifest.runId !== runId) problems.push('runId');
  if (manifest.phase !== 'HARNESS_VALIDATION') problems.push('phase');
  if (manifest.status !== 'PLANNED') problems.push('status');
  if (!Number.isFinite(Date.parse(manifest.createdAt))) problems.push('createdAt');
  if (stableJson(manifest.locks) !== stableJson(activeLocks)) problems.push('locks');
  if (manifest.driver?.id !== LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID) problems.push('driverId');
  if (manifest.driver?.model !== LAB_PUBLIC_SCHEMA_PROBE_MODEL) problems.push('model');
  if (manifest.driver?.reasoningEffort !== LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT) {
    problems.push('reasoningEffort');
  }
  if (manifest.driver?.serviceTier !== LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER) {
    problems.push('serviceTier');
  }
  if (
    manifest.driver?.boundaryClass !== 'H1_DEVELOPMENT_HARNESS_VERIFIED' ||
    manifest.driver.hardOutputTokenLimit ||
    !manifest.driver.hardCallTimeLimit ||
    manifest.driver.textOnlyAttestation !== 'HARNESS_DETECTED' ||
    !manifest.driver.harnessVerifiedTextIsolation ||
    !manifest.driver.streamingOutputTokenInterrupt ||
    !manifest.driver.providerReportedTokenUsage ||
    manifest.driver.seed !== null ||
    manifest.driver.seedControl !== 'UNSUPPORTED'
  ) {
    problems.push('driverBoundary');
  }
  if (stableJson(manifest.budgets) !== stableJson(publicSchemaProbeManifestBudget())) {
    problems.push('budgets');
  }
  if (manifest.caseIds.length !== 0 || manifest.conditionIds.length !== 0) {
    problems.push('corpusScope');
  }
  if (!manifest.providerUsageExplicitlyAuthorized) problems.push('providerAuthorization');
  return problems;
}

function publicSchemaProbeReceiptProblems(
  report: LabPublicSchemaProbeReport,
  runId: string,
  activeLocks: LabComponentLock
): string[] {
  const problems: string[] = [];
  if (report.schemaVersion !== LAB_PUBLIC_SCHEMA_PROBE_REPORT_VERSION) {
    problems.push('schemaVersion');
  }
  if (report.probeVersion !== LAB_PUBLIC_SCHEMA_PROBE_VERSION) problems.push('probeVersion');
  if (report.runId !== runId) problems.push('runId');
  if (report.status !== 'PASSED') problems.push('status');
  if (stableJson(report.componentLocks) !== stableJson(activeLocks)) problems.push('locks');
  if (report.driverId !== LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID) problems.push('driverId');
  if (report.model !== LAB_PUBLIC_SCHEMA_PROBE_MODEL) problems.push('model');
  if (report.reasoningEffort !== LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT) {
    problems.push('reasoningEffort');
  }
  if (report.serviceTier !== LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER) problems.push('serviceTier');
  if (report.publicOutputSchemaVersion !== LAB_PUBLIC_OUTPUT_SCHEMA_VERSION) {
    problems.push('outputSchemaVersion');
  }
  if (report.publicOutputSchemaSha256 !== LAB_PUBLIC_SCHEMA_PROBE_SCHEMA_SHA256) {
    problems.push('outputSchemaDigest');
  }
  if (report.promptSha256 !== LAB_PUBLIC_SCHEMA_PROBE_PROMPT_SHA256) {
    problems.push('promptDigest');
  }
  const recomputed = publicSchemaProbeProblems(report);
  if (recomputed.length > 0) problems.push(...recomputed);
  if (stableJson(report.failedChecks) !== stableJson(recomputed)) {
    problems.push('failedChecks');
  }
  return problems;
}

function publicSchemaProbeProblems(
  report: Omit<LabPublicSchemaProbeReport, 'status' | 'failedChecks'> | LabPublicSchemaProbeReport
): string[] {
  const problems: string[] = [];
  const boundary = report.boundary;
  if (!boundary || !boundary.ready || boundary.driverId !== LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID) {
    problems.push('boundaryReady');
  }
  if (!boundary || !publicSchemaProbeBoundaryAllowsDispatch(boundary)) {
    problems.push('boundaryAttestation');
  }
  const call = report.call;
  if (!call) {
    problems.push('oneCall');
  } else {
    if (call.callKey !== `${LAB_PUBLIC_SCHEMA_PROBE_VERSION}:attempt-1`) {
      problems.push('callKey');
    }
    if (
      call.requestedModel !== LAB_PUBLIC_SCHEMA_PROBE_MODEL ||
      call.observedModel !== LAB_PUBLIC_SCHEMA_PROBE_MODEL ||
      call.requestedReasoningEffort !== LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT ||
      call.observedReasoningEffort !== LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT ||
      call.requestedServiceTier !== LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER ||
      call.observedServiceTier !== LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER
    ) {
      problems.push('callSettings');
    }
    if (call.failure) problems.push('providerAcceptance');
    if (call.violations.length !== 0) problems.push('boundaryViolations');
    if (
      !call.session ||
      !call.providerTurnId ||
      !call.acknowledgedAt ||
      !call.startedAt ||
      !call.firstOutputAt ||
      call.providerStatus !== 'completed' ||
      call.providerAccounting.sessionAttestation !== 'ATTESTED' ||
      call.providerAccounting.threadStartStatus !== 'ATTESTED' ||
      call.providerAccounting.providerTurnStarted !== 'YES'
    ) {
      problems.push('cleanTerminalLifecycle');
    }
    if (!completeProviderUsage(call)) problems.push('completeProviderUsage');
    const lifecycleEvents = new Set(call.lifecycle.map((item) => item.event));
    for (const event of [
      'submitted',
      'acknowledged',
      'started',
      'terminal',
      'provider-usage-observed',
      'result-recorded'
    ]) {
      if (!lifecycleEvents.has(event)) problems.push('cleanTerminalLifecycle');
    }
  }
  if (report.localValidation.status !== 'PASSED' || report.localValidation.errors.length !== 0) {
    problems.push('localOutputValidation');
  }
  if (report.close.status !== 'CLEAN' || report.close.failure) problems.push('cleanClose');
  if (
    !Array.isArray(report.close.boundaryViolations) ||
    report.close.boundaryViolations.length !== 0
  ) {
    problems.push('processBoundaryViolations');
  }
  if (report.operationFailure) problems.push('operationFailure');
  if (
    report.budgets.maximumAttempts !== 1 ||
    report.budgets.targetOutputTokens !== LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS ||
    report.budgets.safetyOutputTokens !== LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS ||
    report.budgets.maximumCallMs !== LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_CALL_MS ||
    report.budgets.maximumExperimentMs !== LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS
  ) {
    problems.push('budgets');
  }
  return [...new Set(problems)];
}

function completeProviderUsage(call: LabTextCallResult): boolean {
  if (!call.usage || call.tokenControl?.usageStatus !== 'PROVIDER_REPORTED') return false;
  if (
    call.tokenControl.targetOutputTokens !== LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS ||
    call.tokenControl.safetyCeilingOutputTokens !== LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS ||
    call.tokenControl.observedOutputTokens !== call.usage.last.outputTokens
  ) {
    return false;
  }
  return [call.usage.total, call.usage.last].every((usage) =>
    [
      usage.totalTokens,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.reasoningOutputTokens
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  );
}

function validateProbeRawOutput(
  rawText: string | undefined
): LabPublicSchemaProbeReport['localValidation'] {
  if (rawText === undefined) return { status: 'NOT_RUN', errors: [] };
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch {
    return {
      status: 'FAILED',
      errors: [{ path: '$', code: 'INVALID_JSON', message: 'Probe output is not valid JSON.' }]
    };
  }
  const validation = validateLabPublicOutput(value);
  return validation.ok
    ? { status: 'PASSED', errors: [] }
    : { status: 'FAILED', errors: structuredClone(validation.errors) };
}

function elapsedMs(startedAt: string, completedAt: string): number {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : 0;
}

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) && runId !== '..';
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`H1 public-schema probe receipt directory is unavailable or unsafe: ${directory}`);
  }
}

async function assertRealFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`H1 public-schema probe receipt file is unavailable or unsafe: ${filePath}`);
  }
}
