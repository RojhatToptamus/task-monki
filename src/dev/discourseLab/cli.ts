import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexLabTextDriver } from './CodexTextDriver';
import {
  buildControlledPlan,
  loadH0ValidationReceipt,
  type LabControlledPlan
} from './controlledPlan';
import { planControlledAssignments } from './corpus';
import { runHarnessValidation } from './harnessValidation';
import { runControlledExperiment, scheduleControlledAssignments } from './experiments';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  stableJson,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import { listLabProtocolPlans } from './protocols';
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
  type LabPublicSchemaProbeCloseResult
} from './publicSchemaProbe';
import { LAB_PUBLIC_OUTPUT_JSON_SCHEMA } from './outputValidation';
import type { LabTextCallResult } from './textDriver';
import { validateLabInputs } from './validation';

const DEFAULT_STATE_ROOT = path.join('.local', 'discourse-protocol-lab');
const APP_VERSION = '0.2.0-alpha.1-discourse-lab-v8';
const H1_PRIMARY_MODEL = 'gpt-5.6-sol';
const H1_PRIMARY_REASONING_EFFORT = 'high';
const H1_PRIMARY_SERVICE_TIER = 'default';

type CliCommand = 'help' | 'validate' | 'plan-controlled' | 'preflight' | 'pilot-controlled';

export interface LabCliOptions {
  command: CliCommand;
  stateRoot: string;
  fixtureRoot: string;
  partition: 'DEVELOPMENT' | 'CONFIRMATION';
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
  probePublicSchema: boolean;
}

export function parseLabCliArgs(argv: string[], cwd = process.cwd()): LabCliOptions {
  const command = (argv[0] ?? 'help') as CliCommand;
  if (!['help', 'validate', 'plan-controlled', 'preflight', 'pilot-controlled'].includes(command)) {
    throw new Error(`Unknown Discourse Lab command: ${command}`);
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    if (argument === '--allow-detected-text-boundary') {
      throw new Error(
        '--allow-detected-text-boundary is obsolete: the v8 H1 development fallback is source-locked and cannot be enabled by a CLI override.'
      );
    }
    if (argument === '--confirm-provider-usage' || argument === '--probe-public-schema') {
      flags.add(argument);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const partitionValue = (values.get('--partition') ?? 'development').toUpperCase();
  if (partitionValue !== 'DEVELOPMENT' && partitionValue !== 'CONFIRMATION') {
    throw new Error('Partition must be development or confirmation.');
  }
  return {
    command,
    stateRoot: path.resolve(cwd, values.get('--state-root') ?? DEFAULT_STATE_ROOT),
    fixtureRoot: path.resolve(
      cwd,
      values.get('--fixture-root') ?? path.join('evaluation', 'discourse-lab')
    ),
    repositoryRoot: path.resolve(cwd),
    partition: partitionValue,
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
    confirmProviderUsage: flags.has('--confirm-provider-usage'),
    probePublicSchema: flags.has('--probe-public-schema')
  };
}

export async function runLabCli(options: LabCliOptions): Promise<unknown> {
  switch (options.command) {
    case 'help':
      return { help: helpText() };
    case 'validate':
      return runValidationCommand(options);
    case 'plan-controlled':
      return planControlledCommand(options);
    case 'preflight':
      return preflightCommand(options);
    case 'pilot-controlled':
      return pilotControlledCommand(options);
  }
}

async function runValidationCommand(options: LabCliOptions): Promise<unknown> {
  const validation = await validateLabInputs(options.fixtureRoot);
  const runId = newRunId('h0');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  const plans = listLabProtocolPlans();
  const maximumCalls = plans.reduce(
    (sum, plan) =>
      sum + (plan.conditionId.startsWith('CONTROL_') ? 1 : plan.maximumCalls * 4),
    0
  );
  await ledger.initialize(
    manifest({
      runId,
      phase: 'HARNESS_VALIDATION',
      locks: validation.locks,
      driver: {
        id: 'scripted-text-v2',
        model: 'scripted',
        seed: 17,
        seedControl: 'SUPPORTED',
        hardOutputTokenLimit: true,
        hardCallTimeLimit: true,
        textOnlyAttestation: 'PROVIDER_ENFORCED',
        boundaryClass: 'PROVIDER_ENFORCED_STRICT',
        harnessVerifiedTextIsolation: true,
        streamingOutputTokenInterrupt: true,
        providerReportedTokenUsage: true
      },
      caseIds: ['DEV-OBJ-03', 'DEV-EVD-04', 'DEV-GAP-01', 'DEV-DEC-01'],
      conditionIds: plans.map((item) => item.conditionId),
      budgets: {
        maximumCalls,
        maximumRounds: 2,
        maximumOutputTokens: plans.reduce(
          (sum, plan) => sum + plan.maximumOutputTokens * (plan.conditionId.startsWith('CONTROL_') ? 1 : 4),
          0
        ),
        maximumOutputTokenSafetyCeiling: plans.reduce(
          (sum, plan) => sum + plan.maximumOutputTokens * (plan.conditionId.startsWith('CONTROL_') ? 1 : 4),
          0
        ),
        maximumObservedTotalTokens: 2_000_000,
        maximumCallMs: 2_000,
        maximumExperimentMs: 30_000
      },
      providerUsageExplicitlyAuthorized: false
    })
  );
  const report = await runHarnessValidation(options.fixtureRoot, ledger);
  return { runId, runDirectory: ledger.runDirectory, report };
}

async function planControlledCommand(options: LabCliOptions): Promise<unknown> {
  const validation = await validateLabInputs(options.fixtureRoot);
  if (!options.h0RunId) {
    throw new Error('plan-controlled requires --h0-run-id from a completed validate run.');
  }
  const h0Validation = await loadH0ValidationReceipt(
    options.stateRoot,
    options.h0RunId,
    validation.locks
  );
  const plannedAssignments = await planControlledAssignments(options.fixtureRoot, options.partition);
  const assignmentSchedule = scheduleControlledAssignments(plannedAssignments, options.partition);
  const assignmentById = new Map(plannedAssignments.map((item) => [item.assignmentId, item]));
  const assignments = assignmentSchedule.assignmentIds.map((assignmentId) =>
    assignmentById.get(assignmentId)!
  );
  const outputPath = options.outputPath ?? path.join(
    options.stateRoot,
    'plans',
    `h1-${options.partition.toLowerCase()}-${Date.now()}.json`
  );
  const value = buildControlledPlan({
    partition: options.partition,
    locks: validation.locks,
    h0Validation,
    assignmentSchedule,
    assignments
  });
  await writePrivateExclusive(outputPath, value);
  return { outputPath, assignmentCount: assignments.length, partition: options.partition };
}

async function preflightCommand(options: LabCliOptions): Promise<unknown> {
  requireDiagnosticOptions(options);
  if (options.probePublicSchema) requirePublicSchemaProbeOptions(options);
  const validation = await validateLabInputs(options.fixtureRoot);
  const runId = newRunId(options.probePublicSchema ? 'public-schema-probe' : 'preflight');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  await ledger.initialize(
    manifest({
      runId,
      phase: 'HARNESS_VALIDATION',
      locks: validation.locks,
      driver: {
        id: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
        model: options.model!,
        reasoningEffort: options.reasoningEffort,
        serviceTier: options.serviceTier,
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
      caseIds: [],
      conditionIds: [],
      budgets: options.probePublicSchema
        ? publicSchemaProbeManifestBudget()
        : {
            maximumCalls: 0,
            maximumRounds: 0,
            maximumOutputTokens: 0,
            maximumOutputTokenSafetyCeiling: 0,
            maximumObservedTotalTokens: 0,
            maximumCallMs: 30_000,
            maximumExperimentMs: 60_000
          },
      providerUsageExplicitlyAuthorized: options.probePublicSchema
    })
  );
  const driver = new CodexLabTextDriver({
    stateRoot: path.join(ledger.runDirectory, 'codex'),
    executionRoot: options.executionRoot!,
    codexHome: options.codexHome!,
    repositoryRoot: options.repositoryRoot,
    appVersion: APP_VERSION,
    executable: options.executable
  });
  if (options.probePublicSchema) {
    return runPublicSchemaProbeCommand(validation.locks, runId, ledger, driver);
  }
  try {
    const preflightStartedMs = Date.now();
    const report = await driver.preflight({
      model: options.model!,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      maximumCallMs: 30_000,
      experimentDeadlineMs: preflightStartedMs + 60_000
    });
    await ledger.writeReport('provider-preflight', report);
    return { runId, runDirectory: ledger.runDirectory, report };
  } finally {
    await driver.close();
  }
}

async function runPublicSchemaProbeCommand(
  locks: LabComponentLock,
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
    await recordCommandFailure(ledger, 'PUBLIC_SCHEMA_PROBE_OPERATION_FAILED', error);
  }

  const close = await closePublicSchemaProbeDriver(driver, deadlineMs);
  if (close.failure) {
    await ledger.append({
      eventType: 'PUBLIC_SCHEMA_PROBE_CLOSE_FAILED',
      occurredAt: close.completedAt,
      detail: close.failure
    });
  }
  const completedAt = new Date().toISOString();
  const report = buildPublicSchemaProbeReport({
    runId,
    startedAt,
    completedAt,
    componentLocks: locks,
    boundary,
    call,
    close,
    operationFailure
  });
  await ledger.writeReport('public-schema-probe', report);
  return { runId, runDirectory: ledger.runDirectory, report };
}

async function closePublicSchemaProbeDriver(
  driver: CodexLabTextDriver,
  experimentDeadlineMs: number
): Promise<LabPublicSchemaProbeCloseResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const maximumMs = Math.max(1, Math.min(30_000, experimentDeadlineMs - startedMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve()
    .then(() => driver.close())
    .then(() => ({ status: 'CLEAN' as const }))
    .catch((error) => ({ status: 'FAILED' as const, failure: simpleFailure(error) }));
  const timeout = new Promise<{ status: 'TIMED_OUT'; failure: { name: string; message: string } }>(
    (resolve) => {
      timer = setTimeout(() => resolve({
        status: 'TIMED_OUT',
        failure: {
          name: 'TimeoutError',
          message: `Codex schema-probe driver close exceeded ${maximumMs} ms.`
        }
      }), maximumMs);
    }
  );
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

function simpleFailure(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : safeFailureText(error)
  };
}

async function pilotControlledCommand(options: LabCliOptions): Promise<unknown> {
  requirePilotOptions(options);
  if (options.partition !== 'DEVELOPMENT') {
    throw new Error(
      'The Codex harness-verified boundary is development-only. H1 confirmation remains sealed and requires a separately preregistered provider boundary.'
    );
  }
  requirePilotRuntimeOptions(options);
  if (
    options.model !== H1_PRIMARY_MODEL ||
    options.reasoningEffort !== H1_PRIMARY_REASONING_EFFORT ||
    options.serviceTier !== H1_PRIMARY_SERVICE_TIER
  ) {
    throw new Error(
      `H1 v8 primary conditions require --model ${H1_PRIMARY_MODEL} --reasoning-effort ${H1_PRIMARY_REASONING_EFFORT} --service-tier ${H1_PRIMARY_SERVICE_TIER}.`
    );
  }
  const plan = await readControlledPlan(options.planPath!);
  assertCliBudgetsMatchPlan(options, plan);
  const validation = await validateLabInputs(options.fixtureRoot);
  const schemaProbeReceipt = await loadPublicSchemaProbeReceipt(
    options.stateRoot,
    options.schemaProbeRunId!,
    validation.locks
  );
  const runId = newRunId('h1-development');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  const driverManifest: LabRunManifest['driver'] = {
    id: LAB_PUBLIC_SCHEMA_PROBE_DRIVER_ID,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    serviceTier: options.serviceTier,
    seed: null,
    seedControl: 'UNSUPPORTED',
    hardOutputTokenLimit: false,
    hardCallTimeLimit: true,
    textOnlyAttestation: 'HARNESS_DETECTED',
    boundaryClass: 'H1_DEVELOPMENT_HARNESS_VERIFIED',
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true
  };
  await ledger.initialize(manifest({
    runId,
    phase: 'DEVELOPMENT',
    locks: validation.locks,
    driver: driverManifest,
    caseIds: [...new Set(plan.assignments.map((item) => item.caseId))],
    conditionIds: [...new Set(plan.assignments.map((item) => item.conditionId))],
    budgets: {
      maximumCalls: plan.budget.maximumCalls,
      maximumRounds: plan.budget.maximumRoundsPerAssignment,
      maximumOutputTokens:
        plan.budget.maximumCalls * plan.budget.targetOutputTokensPerCall,
      maximumOutputTokenSafetyCeiling:
        plan.budget.maximumCalls * plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
      maximumObservedTotalTokens: plan.budget.maximumObservedTotalTokens,
      maximumCallMs: plan.budget.maximumCallMs,
      maximumExperimentMs: plan.budget.maximumExperimentMs
    },
    providerUsageExplicitlyAuthorized: true
  }));
  await ledger.append({
    eventType: 'SCHEMA_PROBE_RECEIPT_VERIFIED',
    occurredAt: new Date().toISOString(),
    detail: {
      schemaProbeRunId: schemaProbeReceipt.runId,
      schemaProbeManifestSha256: schemaProbeReceipt.manifestSha256,
      schemaProbeReportSha256: schemaProbeReceipt.reportSha256,
      publicOutputSchemaSha256: schemaProbeReceipt.publicOutputSchemaSha256
    }
  });
  const driver = new CodexLabTextDriver({
    stateRoot: path.join(ledger.runDirectory, 'codex'),
    executionRoot: options.executionRoot!,
    codexHome: options.codexHome!,
    repositoryRoot: options.repositoryRoot,
    appVersion: APP_VERSION,
    executable: options.executable
  });
  let result: Awaited<ReturnType<typeof runControlledExperiment>> | undefined;
  let failure: unknown;
  try {
    result = await runControlledExperiment({
      fixtureRoot: options.fixtureRoot,
      partition: 'DEVELOPMENT',
      plan,
      driver,
      ledger,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier
    });
  } catch (error) {
    failure = error;
    await recordCommandFailure(ledger, 'EXPERIMENT_COMMAND_FAILED', error);
  }
  try {
    await driver.close();
  } catch (error) {
    await recordCommandFailure(ledger, 'DRIVER_CLOSE_FAILED', error);
    failure = failure
      ? new AggregateError([failure, error], 'H1 development execution and driver close both failed.')
      : error;
  }
  if (failure) throw failure;
  return {
    runId,
    runDirectory: ledger.runDirectory,
    result
  };
}

function requireDiagnosticOptions(options: LabCliOptions): void {
  if (!options.codexHome) throw new Error('preflight requires --codex-home.');
  if (!options.executionRoot) throw new Error('preflight requires --execution-root.');
  if (!options.model) throw new Error('preflight requires --model.');
}

function requirePublicSchemaProbeOptions(options: LabCliOptions): void {
  if (!options.confirmProviderUsage) {
    throw new Error('preflight --probe-public-schema requires --confirm-provider-usage.');
  }
  if (
    options.model !== LAB_PUBLIC_SCHEMA_PROBE_MODEL ||
    options.reasoningEffort !== LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT ||
    options.serviceTier !== LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER
  ) {
    throw new Error(
      `preflight --probe-public-schema requires --model ${LAB_PUBLIC_SCHEMA_PROBE_MODEL} --reasoning-effort ${LAB_PUBLIC_SCHEMA_PROBE_REASONING_EFFORT} --service-tier ${LAB_PUBLIC_SCHEMA_PROBE_SERVICE_TIER}.`
    );
  }
}

function requirePilotOptions(options: LabCliOptions): void {
  if (!options.confirmProviderUsage) {
    throw new Error('pilot-controlled requires --confirm-provider-usage.');
  }
  if (!options.schemaProbeRunId) {
    throw new Error('pilot-controlled requires --schema-probe-run-id from a PASSED public-schema probe.');
  }
  if (!options.planPath) throw new Error('pilot-controlled requires --plan.');
  if (!options.model) throw new Error('pilot-controlled requires --model.');
  if (!options.maximumCalls) throw new Error('pilot-controlled requires --max-calls.');
  if (!options.maximumTotalTokens) {
    throw new Error('pilot-controlled requires --max-total-tokens.');
  }
  if (!options.maximumCallSeconds) {
    throw new Error('pilot-controlled requires --max-call-seconds.');
  }
  if (!options.maximumExperimentSeconds) {
    throw new Error('pilot-controlled requires --max-experiment-seconds.');
  }
}

function requirePilotRuntimeOptions(options: LabCliOptions): void {
  if (!options.codexHome) throw new Error('pilot-controlled requires --codex-home.');
  if (!options.executionRoot) throw new Error('pilot-controlled requires --execution-root.');
}

async function readControlledPlan(filePath: string): Promise<LabControlledPlan> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`pilot-controlled plan is unavailable or unsafe: ${filePath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new Error('pilot-controlled plan is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { assignments?: unknown }).assignments)) {
    throw new Error('pilot-controlled plan has an invalid shape.');
  }
  return value as LabControlledPlan;
}

function assertCliBudgetsMatchPlan(options: LabCliOptions, plan: LabControlledPlan): void {
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
    throw new Error(`pilot-controlled CLI budgets do not match the sealed plan: ${mismatches.join(', ')}.`);
  }
}

const MAX_FAILURE_DETAIL_DEPTH = 8;
const MAX_FAILURE_DETAIL_NODES = 32;
const MAX_FAILURE_DETAIL_TEXT = 4_096;

export async function recordCommandFailure(
  ledger: LabArtifactLedger,
  eventType: string,
  error: unknown
): Promise<void> {
  await ledger.append({
    eventType,
    occurredAt: new Date().toISOString(),
    detail: serializeFailure(error)
  });
}

interface FailureDetail extends Record<string, unknown> {
  name: string;
  message: string;
  cause?: FailureDetail;
  errors?: FailureDetail[];
  omittedErrors?: number;
  truncated?: true;
}

function serializeFailure(error: unknown): FailureDetail {
  return serializeFailureNode(error, {
    remainingNodes: MAX_FAILURE_DETAIL_NODES,
    ancestors: new Set<object>()
  }, 0);
}

function serializeFailureNode(
  error: unknown,
  state: { remainingNodes: number; ancestors: Set<object> },
  depth: number
): FailureDetail {
  if (depth >= MAX_FAILURE_DETAIL_DEPTH || state.remainingNodes <= 0) {
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
  const detail: FailureDetail = {
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

function boundedFailureText(value: string): string {
  return value.length <= MAX_FAILURE_DETAIL_TEXT
    ? value
    : `${value.slice(0, MAX_FAILURE_DETAIL_TEXT)}…`;
}

function safeFailureText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[Unprintable failure]';
  }
}

function manifest(
  value: Omit<LabRunManifest, 'schemaVersion' | 'status' | 'createdAt'>
): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    status: 'PLANNED',
    createdAt: new Date().toISOString(),
    ...value
  };
}

async function writePrivateExclusive(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(path.dirname(filePath), 0o700);
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${stableJson(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function newRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
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

function helpText(): string {
  return [
    'Evaluation-only Discourse Protocol Lab',
    '',
    'Commands:',
    '  validate',
    '  plan-controlled --h0-run-id RUN_ID --partition development|confirmation [--out PATH]',
    '  preflight --codex-home PATH --execution-root PATH --model MODEL [--reasoning-effort EFFORT] [--service-tier TIER] [--executable PATH]',
    '  preflight --probe-public-schema --codex-home PATH --execution-root PATH --model gpt-5.6-sol --reasoning-effort high --service-tier default --confirm-provider-usage [--executable PATH]',
    '  pilot-controlled --partition development --plan PATH --schema-probe-run-id RUN_ID --codex-home PATH --execution-root PATH --model gpt-5.6-sol --reasoning-effort high --service-tier default --max-calls N --max-total-tokens N --max-call-seconds N --max-experiment-seconds N --confirm-provider-usage',
    '',
    'Codex semantic execution is permitted only for the source-locked H1 v8 development estimand. It uses harness-verified isolation, a 25k emergency streaming threshold, and complete retrospective provider usage; prepared-prompt estimates, output targets, and the between-attempt 300k observed-total stop are not provider caps or equal-compute controls. Confirmation remains sealed.'
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const options = parseLabCliArgs(process.argv.slice(2));
    const result = await runLabCli(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
