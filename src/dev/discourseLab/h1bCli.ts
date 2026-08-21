import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CodexLabTextDriver,
  assertCodexLabIsolation
} from './CodexTextDriver';
import {
  loadH1bParticipantCorpus
} from './h1bCorpus';
import {
  buildH1bExperimentManifest,
  runH1bExperiment
} from './h1bExperiment';
import {
  buildH1bHarnessValidationManifest,
  loadH1bH0ValidationReceipt,
  runH1bHarnessValidation
} from './h1bHarnessValidation';
import {
  assertH1bPlan,
  buildH1bPlan,
  type H1bPlan
} from './h1bPlan';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  sha256File,
  stableJson,
  type LabRunManifest
} from './ledger';
import {
  LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
  LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_CALL_MS,
  LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS,
  LAB_PUBLIC_SCHEMA_PROBE_MODEL,
  LAB_PUBLIC_SCHEMA_PROBE_PROMPT,
  LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
  LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS,
  LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
  LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS,
  LAB_PUBLIC_SCHEMA_PROBE_VERSION,
  buildPublicSchemaProbeReport,
  loadPublicSchemaProbeReceipt,
  publicSchemaProbeBoundaryAllowsDispatch,
  publicSchemaProbeManifestBudget,
  type LabFailureDetail,
  type LabPublicSchemaProbeCloseResult
} from './publicSchemaProbe';
import { LAB_PUBLIC_OUTPUT_JSON_SCHEMA } from './outputValidation';
import type { LabTextCallResult } from './textDriver';
import { validateH1bInputs } from './h1bValidation';

const DEFAULT_STATE_ROOT = path.join('.local', 'discourse-protocol-lab-h1b');
const APP_VERSION = '0.2.0-alpha.1-discourse-lab-h1b-v1';
const PRIMARY_MODEL = 'gpt-5.6-sol';
const PRIMARY_REASONING_EFFORT = 'high';
const PRIMARY_SERVICE_TIER = 'default';
const MAXIMUM_CALLS = 54;
const MAXIMUM_TOTAL_TOKENS = 600_000;
const MAXIMUM_CALL_SECONDS = 120;
const MAXIMUM_EXPERIMENT_SECONDS = 7_200;
const DRIVER_CLOSE_MAXIMUM_MS = 30_000;

type H1bCliCommand = 'h0' | 'plan' | 'probe' | 'run' | 'help';

export interface H1bCliOptions {
  command: H1bCliCommand;
  stateRoot: string;
  fixtureRoot: string;
  outputPath?: string;
  planPath?: string;
  h0RunId?: string;
  schemaProbeRunId?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  executable?: string;
  codexHome?: string;
  executionRoot?: string;
  repositoryRoot: string;
  maximumCalls?: number;
  maximumTotalTokens?: number;
  maximumCallSeconds?: number;
  maximumExperimentSeconds?: number;
  confirmProviderUsage: boolean;
}

const VALUE_OPTIONS = new Set([
  '--state-root',
  '--fixture-root',
  '--out',
  '--plan',
  '--h0-run-id',
  '--schema-probe-run-id',
  '--model',
  '--reasoning-effort',
  '--service-tier',
  '--executable',
  '--codex-home',
  '--execution-root',
  '--max-calls',
  '--max-total-tokens',
  '--max-call-seconds',
  '--max-experiment-seconds',
  '--partition'
]);

export function parseH1bCliArgs(argv: string[], cwd = process.cwd()): H1bCliOptions {
  const command = (argv[0] ?? 'help') as H1bCliCommand;
  if (!['h0', 'plan', 'probe', 'run', 'help'].includes(command)) {
    throw new Error(`Unknown H1b command: ${command}`);
  }
  const values = new Map<string, string>();
  let confirmProviderUsage = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--confirm-provider-usage') {
      if (confirmProviderUsage) throw new Error('Duplicate option: --confirm-provider-usage');
      confirmProviderUsage = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) throw new Error(`Unknown H1b option: ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const partition = values.get('--partition');
  if (partition && partition.toLowerCase() !== 'development') {
    throw new Error('H1b confirmation is absent and closed; only development is permitted.');
  }
  return {
    command,
    stateRoot: path.resolve(cwd, values.get('--state-root') ?? DEFAULT_STATE_ROOT),
    fixtureRoot: path.resolve(
      cwd,
      values.get('--fixture-root') ?? path.join('evaluation', 'discourse-lab')
    ),
    outputPath: optionalAbsolute(cwd, values.get('--out')),
    planPath: optionalAbsolute(cwd, values.get('--plan')),
    h0RunId: values.get('--h0-run-id'),
    schemaProbeRunId: values.get('--schema-probe-run-id'),
    model: values.get('--model'),
    reasoningEffort: values.get('--reasoning-effort'),
    serviceTier: values.get('--service-tier'),
    executable: values.get('--executable'),
    codexHome: optionalAbsolute(cwd, values.get('--codex-home')),
    executionRoot: optionalAbsolute(cwd, values.get('--execution-root')),
    repositoryRoot: path.resolve(cwd),
    maximumCalls: optionalPositiveInteger(values.get('--max-calls'), '--max-calls'),
    maximumTotalTokens: optionalPositiveInteger(
      values.get('--max-total-tokens'),
      '--max-total-tokens'
    ),
    maximumCallSeconds: optionalPositiveInteger(
      values.get('--max-call-seconds'),
      '--max-call-seconds'
    ),
    maximumExperimentSeconds: optionalPositiveInteger(
      values.get('--max-experiment-seconds'),
      '--max-experiment-seconds'
    ),
    confirmProviderUsage
  };
}

export async function runH1bCli(options: H1bCliOptions): Promise<unknown> {
  switch (options.command) {
    case 'help':
      return { help: helpText() };
    case 'h0':
      return h0Command(options);
    case 'plan':
      return planCommand(options);
    case 'probe':
      return probeCommand(options);
    case 'run':
      return runCommand(options);
  }
}

async function h0Command(options: H1bCliOptions): Promise<unknown> {
  requireNoProviderOptions(options, 'h0');
  const validation = await validateH1bInputs(options.fixtureRoot);
  const runId = newRunId('h1b-h0');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  await ledger.initialize(buildH1bHarnessValidationManifest(runId, validation.locks));
  try {
    const report = await runH1bHarnessValidation({
      fixtureRoot: options.fixtureRoot,
      validation,
      ledger
    });
    return { runId, runDirectory: ledger.runDirectory, report };
  } catch (error) {
    await recordH1bCommandFailure(ledger, 'H1B_H0_COMMAND_FAILED', error);
    throw error;
  }
}

async function planCommand(options: H1bCliOptions): Promise<unknown> {
  requireNoProviderOptions(options, 'plan');
  if (!options.h0RunId) throw new Error('plan requires --h0-run-id from a PASSED H1b h0 run.');
  if (options.planPath) throw new Error('plan accepts --out, not --plan.');
  const validation = await validateH1bInputs(options.fixtureRoot);
  const h0Validation = await loadH1bH0ValidationReceipt(
    options.stateRoot,
    options.h0RunId,
    validation.locks
  );
  const participant = await loadH1bParticipantCorpus(options.fixtureRoot);
  const plan = buildH1bPlan({
    cases: participant.records,
    locks: validation.locks,
    h0Validation
  });
  const outputPath = options.outputPath ?? path.join(
    options.stateRoot,
    'plans',
    `h1b-development-${Date.now()}.json`
  );
  await writePrivateExclusiveH1bPlan(outputPath, plan);
  return {
    outputPath,
    sha256: await sha256File(outputPath),
    assignmentCount: plan.assignments.length,
    blockCount: plan.schedule.blockIds.length,
    partition: plan.partition
  };
}

async function probeCommand(options: H1bCliOptions): Promise<unknown> {
  requireProbeOptions(options);
  await assertProviderRootsReady(options);
  const validation = await validateH1bInputs(options.fixtureRoot);
  const runId = newRunId('h1b-public-schema-probe');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  await ledger.initialize(publicSchemaProbeManifest(runId, validation.locks));
  const driver = new CodexLabTextDriver(driverOptions(options, ledger));
  return runPublicSchemaProbe(validation.locks, runId, ledger, driver);
}

async function runCommand(options: H1bCliOptions): Promise<unknown> {
  requireRunOptions(options);
  const plan = await readH1bPlan(options.planPath!);
  assertCliBudgetsMatchPlan(options, plan);
  const validation = await validateH1bInputs(options.fixtureRoot);
  const participant = await loadH1bParticipantCorpus(options.fixtureRoot);
  assertH1bPlan(plan, participant.records, validation.locks);
  const h0Receipt = await loadH1bH0ValidationReceipt(
    options.stateRoot,
    plan.h0Validation.runId,
    validation.locks
  );
  if (stableJson(h0Receipt) !== stableJson(plan.h0Validation)) {
    throw new Error('run H0 receipt does not match the private H1b plan.');
  }
  const schemaProbeReceipt = await loadPublicSchemaProbeReceipt(
    options.stateRoot,
    options.schemaProbeRunId!,
    validation.locks
  );
  await assertProviderRootsReady(options);

  const runId = newRunId('h1b-development');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  const driver = new CodexLabTextDriver(driverOptions(options, ledger));
  let initialized = false;
  let result: Awaited<ReturnType<typeof runH1bExperiment>> | undefined;
  let failure: unknown;
  try {
    await ledger.initialize(buildH1bExperimentManifest({
      runId,
      validation,
      plan,
      driver,
      model: options.model!,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      schemaProbeReceipt
    }));
    initialized = true;
    await ledger.append({
      eventType: 'H1B_SCHEMA_PROBE_RECEIPT_VERIFIED',
      occurredAt: new Date().toISOString(),
      detail: {
        schemaProbeRunId: schemaProbeReceipt.runId,
        schemaProbeManifestSha256: schemaProbeReceipt.manifestSha256,
        schemaProbeReportSha256: schemaProbeReceipt.reportSha256,
        publicOutputSchemaSha256: schemaProbeReceipt.publicOutputSchemaSha256
      }
    });
    result = await runH1bExperiment({
      fixtureRoot: options.fixtureRoot,
      validation,
      plan,
      driver,
      ledger,
      model: options.model!,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      schemaProbeReceipt
    });
  } catch (error) {
    failure = error;
    if (initialized) {
      try {
        await recordH1bCommandFailure(ledger, 'H1B_EXPERIMENT_COMMAND_FAILED', error);
      } catch (recordError) {
        failure = new AggregateError(
          [error, recordError],
          'H1b execution failed and its failure event could not be persisted.'
        );
      }
    }
  }

  const close = await closeCodexDriver(driver, DRIVER_CLOSE_MAXIMUM_MS);
  if (initialized) {
    try {
      await ledger.append({
        eventType: close.failure ? 'H1B_DRIVER_CLOSE_FAILED' : 'H1B_DRIVER_CLOSED',
        occurredAt: close.completedAt,
        detail: {
          status: close.status,
          elapsedMs: close.elapsedMs,
          maximumMs: close.maximumMs,
          boundaryViolations: close.boundaryViolations,
          ...(close.failure ? { failure: close.failure } : {})
        }
      });
    } catch (recordError) {
      failure = failure
        ? new AggregateError(
            [failure, recordError],
            'H1b execution and close-event persistence both failed.'
          )
        : recordError;
    }
  }
  if (close.failure) {
    const closeError = new Error(close.failure.message);
    closeError.name = close.failure.name;
    failure = failure
      ? new AggregateError([failure, closeError], 'H1b execution and driver close both failed.')
      : closeError;
  }
  if (failure) throw failure;
  return { runId, runDirectory: ledger.runDirectory, result, close };
}

function requireNoProviderOptions(options: H1bCliOptions, command: 'h0' | 'plan'): void {
  if (
    options.confirmProviderUsage ||
    options.model ||
    options.reasoningEffort ||
    options.serviceTier ||
    options.codexHome ||
    options.executionRoot ||
    options.executable ||
    options.schemaProbeRunId ||
    options.maximumCalls ||
    options.maximumTotalTokens ||
    options.maximumCallSeconds ||
    options.maximumExperimentSeconds
  ) {
    throw new Error(`${command} is local-only and does not accept provider or live-budget options.`);
  }
}

function requireProbeOptions(options: H1bCliOptions): void {
  if (!options.confirmProviderUsage) {
    throw new Error('probe requires --confirm-provider-usage.');
  }
  requireExactModelSettings(options, 'probe');
  requireDistinctProviderRoots(options, 'probe');
  if (
    options.planPath ||
    options.h0RunId ||
    options.schemaProbeRunId ||
    options.maximumCalls ||
    options.maximumTotalTokens ||
    options.maximumCallSeconds ||
    options.maximumExperimentSeconds
  ) {
    throw new Error('probe does not accept plan, receipt, or H1b-run budget options.');
  }
}

function requireRunOptions(options: H1bCliOptions): void {
  if (!options.confirmProviderUsage) throw new Error('run requires --confirm-provider-usage.');
  if (!options.planPath) throw new Error('run requires --plan.');
  if (!options.schemaProbeRunId) {
    throw new Error('run requires --schema-probe-run-id from a PASSED exact-model probe.');
  }
  requireExactModelSettings(options, 'run');
  requireDistinctProviderRoots(options, 'run');
  const missing = [
    options.maximumCalls === undefined ? '--max-calls' : null,
    options.maximumTotalTokens === undefined ? '--max-total-tokens' : null,
    options.maximumCallSeconds === undefined ? '--max-call-seconds' : null,
    options.maximumExperimentSeconds === undefined ? '--max-experiment-seconds' : null
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) throw new Error(`run requires exact CLI budgets: ${missing.join(', ')}.`);
  const mismatches = [
    options.maximumCalls !== MAXIMUM_CALLS ? '--max-calls 54' : null,
    options.maximumTotalTokens !== MAXIMUM_TOTAL_TOKENS
      ? '--max-total-tokens 600000'
      : null,
    options.maximumCallSeconds !== MAXIMUM_CALL_SECONDS ? '--max-call-seconds 120' : null,
    options.maximumExperimentSeconds !== MAXIMUM_EXPERIMENT_SECONDS
      ? '--max-experiment-seconds 7200'
      : null
  ].filter((value): value is string => Boolean(value));
  if (mismatches.length > 0) {
    throw new Error(`run requires the exact sealed budget values: ${mismatches.join(', ')}.`);
  }
}

function requireExactModelSettings(options: H1bCliOptions, command: 'probe' | 'run'): void {
  if (
    options.model !== PRIMARY_MODEL ||
    options.reasoningEffort !== PRIMARY_REASONING_EFFORT ||
    options.serviceTier !== PRIMARY_SERVICE_TIER
  ) {
    throw new Error(
      `${command} requires --model ${PRIMARY_MODEL} --reasoning-effort ${PRIMARY_REASONING_EFFORT} --service-tier ${PRIMARY_SERVICE_TIER}.`
    );
  }
}

function requireDistinctProviderRoots(options: H1bCliOptions, command: 'probe' | 'run'): void {
  if (!options.codexHome) throw new Error(`${command} requires --codex-home.`);
  if (!options.executionRoot) throw new Error(`${command} requires --execution-root.`);
  if (pathsOverlap(options.codexHome, options.executionRoot)) {
    throw new Error(`${command} requires separate, non-overlapping --codex-home and --execution-root paths.`);
  }
}

async function assertProviderRootsReady(options: H1bCliOptions): Promise<void> {
  await assertCodexLabIsolation({
    codexHome: options.codexHome!,
    executionRoot: options.executionRoot!,
    repositoryRoot: options.repositoryRoot
  });
}

function assertCliBudgetsMatchPlan(options: H1bCliOptions, plan: H1bPlan): void {
  const mismatches = [
    options.maximumCalls !== plan.budget.maximumCalls ? '--max-calls' : null,
    options.maximumTotalTokens !== plan.budget.maximumObservedTotalTokens
      ? '--max-total-tokens'
      : null,
    options.maximumCallSeconds! * 1_000 !== plan.budget.maximumCallMs
      ? '--max-call-seconds'
      : null,
    options.maximumExperimentSeconds! * 1_000 !== plan.budget.maximumExperimentMs
      ? '--max-experiment-seconds'
      : null
  ].filter((value): value is string => Boolean(value));
  if (mismatches.length > 0) {
    throw new Error(`run CLI budgets do not match the private H1b plan: ${mismatches.join(', ')}.`);
  }
}

async function readH1bPlan(filePath: string): Promise<H1bPlan> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`run plan is unavailable or unsafe: ${filePath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new Error('run plan is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as H1bPlan).assignments)) {
    throw new Error('run plan has an invalid shape.');
  }
  return value as H1bPlan;
}

function publicSchemaProbeManifest(
  runId: string,
  locks: LabRunManifest['locks']
): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId,
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt: new Date().toISOString(),
    driver: {
      id: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
      model: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      reasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
      serviceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: false,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'HARNESS_DETECTED',
      boundaryClass: 'H1_DEVELOPMENT_HARNESS_VERIFIED',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: true,
      providerReportedTokenUsage: true
    },
    locks: structuredClone(locks),
    caseIds: [],
    conditionIds: [],
    budgets: publicSchemaProbeManifestBudget(),
    providerUsageExplicitlyAuthorized: true
  };
}

async function runPublicSchemaProbe(
  locks: LabRunManifest['locks'],
  runId: string,
  ledger: LabArtifactLedger,
  driver: CodexLabTextDriver
): Promise<unknown> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const deadlineMs = startedMs + LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_EXPERIMENT_MS;
  let boundary: Awaited<ReturnType<CodexLabTextDriver['preflight']>> | null = null;
  let call: LabTextCallResult | null = null;
  let operationFailure: { name: string; message: string } | undefined;
  try {
    boundary = await driver.preflight({
      model: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
      reasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
      serviceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
      maximumCallMs: 30_000,
      experimentDeadlineMs: deadlineMs
    });
    if (publicSchemaProbeBoundaryAllowsDispatch(boundary)) {
      call = await driver.call({
        callKey: `${LAB_PUBLIC_SCHEMA_PROBE_VERSION}:attempt-1`,
        prompt: LAB_PUBLIC_SCHEMA_PROBE_PROMPT,
        outputSchema: LAB_PUBLIC_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
        model: LAB_PUBLIC_SCHEMA_PROBE_MODEL,
        reasoningEffort: LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT,
        serviceTier: LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER,
        maximumOutputTokens: LAB_PUBLIC_SCHEMA_PROBE_TARGET_OUTPUT_TOKENS,
        outputTokenSafetyCeiling: LAB_PUBLIC_SCHEMA_PROBE_SAFETY_OUTPUT_TOKENS,
        maximumCallMs: LAB_PUBLIC_SCHEMA_PROBE_MAXIMUM_CALL_MS,
        experimentDeadlineMs: deadlineMs
      });
    }
  } catch (error) {
    operationFailure = simpleFailure(error);
    await recordH1bCommandFailure(ledger, 'H1B_PUBLIC_SCHEMA_PROBE_OPERATION_FAILED', error);
  }
  const close = await closeCodexDriver(
    driver,
    Math.max(1, Math.min(DRIVER_CLOSE_MAXIMUM_MS, deadlineMs - Date.now()))
  );
  if (close.failure) {
    await ledger.append({
      eventType: 'H1B_PUBLIC_SCHEMA_PROBE_CLOSE_FAILED',
      occurredAt: close.completedAt,
      detail: {
        status: close.status,
        elapsedMs: close.elapsedMs,
        maximumMs: close.maximumMs,
        boundaryViolations: close.boundaryViolations,
        failure: close.failure
      }
    });
  }
  const report = buildPublicSchemaProbeReport({
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    componentLocks: locks,
    boundary,
    call,
    close,
    operationFailure
  });
  await ledger.writeReport('public-schema-probe', report);
  return { runId, runDirectory: ledger.runDirectory, report };
}

function driverOptions(options: H1bCliOptions, ledger: LabArtifactLedger) {
  return {
    stateRoot: path.join(ledger.runDirectory, 'codex'),
    executionRoot: options.executionRoot!,
    codexHome: options.codexHome!,
    repositoryRoot: options.repositoryRoot,
    appVersion: APP_VERSION,
    executable: options.executable
  };
}

export async function closeCodexDriver(
  driver: CodexLabTextDriver,
  maximumMs: number
): Promise<LabPublicSchemaProbeCloseResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve()
    .then(() => driver.close())
    .then(() => ({ status: 'CLEAN' as const }))
    .catch((error) => ({ status: 'FAILED' as const, failure: serializeH1bFailure(error) }));
  const timeout = new Promise<{
    status: 'TIMED_OUT';
    failure: { name: string; message: string };
  }>((resolve) => {
    timer = setTimeout(() => resolve({
      status: 'TIMED_OUT',
      failure: {
        name: 'TimeoutError',
        message: `Codex H1b driver close exceeded ${maximumMs} ms.`
      }
    }), maximumMs);
  });
  const outcome = await Promise.race([close, timeout]);
  if (timer) clearTimeout(timer);
  const completedMs = Date.now();
  return {
    ...outcome,
    startedAt,
    completedAt: new Date(completedMs).toISOString(),
    elapsedMs: Math.max(0, completedMs - startedMs),
    maximumMs,
    boundaryViolations: driver.getProcessBoundaryViolations()
  };
}

export async function recordH1bCommandFailure(
  ledger: LabArtifactLedger,
  eventType: string,
  error: unknown
): Promise<void> {
  await ledger.append({
    eventType,
    occurredAt: new Date().toISOString(),
    detail: serializeH1bFailure(error)
  });
}

export function serializeH1bFailure(error: unknown): LabFailureDetail {
  return serializeFailureNode(error, {
    remainingNodes: 32,
    ancestors: new Set<object>()
  }, 0);
}

function serializeFailureNode(
  error: unknown,
  state: { remainingNodes: number; ancestors: Set<object> },
  depth: number
): LabFailureDetail {
  if (depth >= 8 || state.remainingNodes <= 0) {
    return {
      name: 'TruncatedFailure',
      message: 'Nested failure detail exceeded the bounded ledger limit.',
      truncated: true
    };
  }
  if (typeof error === 'object' && error !== null) {
    if (state.ancestors.has(error)) {
      return {
        name: 'CircularFailure',
        message: 'Nested failure detail contains a cycle.',
        truncated: true
      };
    }
    state.ancestors.add(error);
  }
  state.remainingNodes -= 1;
  const detail: LabFailureDetail = {
    name: boundedFailureText(error instanceof Error ? error.name : 'UnknownError'),
    message: boundedFailureText(error instanceof Error ? error.message : safeFailureText(error))
  };
  if (error instanceof Error && error.cause !== undefined) {
    detail.cause = serializeFailureNode(error.cause, state, depth + 1);
  }
  if (error instanceof AggregateError) {
    const nested = Array.from(error.errors);
    const available = Math.max(0, state.remainingNodes);
    detail.errors = nested
      .slice(0, available)
      .map((candidate) => serializeFailureNode(candidate, state, depth + 1));
    if (nested.length > detail.errors.length) {
      detail.omittedErrors = nested.length - detail.errors.length;
      detail.truncated = true;
    }
  }
  if (typeof error === 'object' && error !== null) state.ancestors.delete(error);
  return detail;
}

export async function writePrivateExclusiveH1bPlan(
  filePath: string,
  plan: H1bPlan
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(path.dirname(filePath), 0o700);
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${stableJson(plan)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(path.resolve(left), path.resolve(right));
  const rightToLeft = path.relative(path.resolve(right), path.resolve(left));
  return isInsideOrEqual(leftToRight) || isInsideOrEqual(rightToLeft);
}

function isInsideOrEqual(relative: string): boolean {
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function simpleFailure(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : safeFailureText(error)
  };
}

function boundedFailureText(value: string): string {
  return value.length <= 4_096 ? value : `${value.slice(0, 4_096)}…`;
}

function safeFailureText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[Unprintable failure]';
  }
}

function optionalAbsolute(cwd: string, value: string | undefined): string | undefined {
  return value ? path.resolve(cwd, value) : undefined;
}

function optionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function newRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

function helpText(): string {
  return [
    'Evaluation-only H1b Discourse Protocol Lab',
    '',
    'Commands:',
    '  h0 [--state-root PATH] [--fixture-root PATH]',
    '  plan --h0-run-id RUN_ID [--out PATH] [--state-root PATH] [--fixture-root PATH]',
    '  probe --codex-home PATH --execution-root PATH --model gpt-5.6-sol --reasoning-effort high --service-tier default --confirm-provider-usage [--executable PATH]',
    '  run --plan PATH --schema-probe-run-id RUN_ID --codex-home PATH --execution-root PATH --model gpt-5.6-sol --reasoning-effort high --service-tier default --max-calls 54 --max-total-tokens 600000 --max-call-seconds 120 --max-experiment-seconds 7200 --confirm-provider-usage [--executable PATH]',
    '  help',
    '',
    'H1b is development-only ordinary text. H0 and plan make zero provider calls. Probe and run require explicit provider authorization, exact Sol/high/default settings, and separate Codex-home and execution roots. Confirmation is absent and closed.'
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const result = await runH1bCli(parseH1bCliArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : safeFailureText(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
