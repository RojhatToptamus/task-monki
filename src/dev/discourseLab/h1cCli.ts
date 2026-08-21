import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CodexLabTextDriver,
  assertCodexLabIsolation
} from './CodexTextDriver';
import { loadH1cParticipantCorpus } from './h1cCorpus';
import {
  buildH1cExperimentManifest,
  runH1cExperiment
} from './h1cExperiment';
import {
  buildH1cHarnessValidationManifest,
  loadH1cH0ValidationReceipt,
  runH1cHarnessValidation
} from './h1cHarnessValidation';
import {
  assertH1cPlan,
  buildH1cPlan,
  type H1cPlan
} from './h1cPlan';
import {
  H1C_PROBE_MODEL,
  H1C_PROBE_REASONING_EFFORT,
  H1C_PROBE_SERVICE_TIER,
  buildH1cProbeManifest,
  closeH1cProbeDriver,
  loadH1cProbeReceipt,
  runH1cProbe,
  serializeH1cProbeFailure,
  type H1cProbeCloseResult
} from './h1cProbe';
import {
  LabArtifactLedger,
  sha256File,
  stableJson
} from './ledger';
import { validateH1cInputs } from './h1cValidation';

const DEFAULT_STATE_ROOT = path.join('.local', 'discourse-protocol-lab-h1c');
const APP_VERSION = '0.2.0-alpha.1-discourse-lab-h1c-v3';
const MAXIMUM_CALLS = 28;
const MAXIMUM_TOTAL_TOKENS = 300_000;
const MAXIMUM_CALL_SECONDS = 120;
const MAXIMUM_EXPERIMENT_SECONDS = 2_400;
const DRIVER_CLOSE_MAXIMUM_MS = 30_000;

type H1cCliCommand = 'h0' | 'plan' | 'probe' | 'run' | 'help';

export interface H1cCliOptions {
  command: H1cCliCommand;
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

export function parseH1cCliArgs(argv: string[], cwd = process.cwd()): H1cCliOptions {
  const command = (argv[0] ?? 'help') as H1cCliCommand;
  if (!['h0', 'plan', 'probe', 'run', 'help'].includes(command)) {
    throw new Error(`Unknown H1c command: ${command}`);
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
    if (!VALUE_OPTIONS.has(argument)) throw new Error(`Unknown H1c option: ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const partition = values.get('--partition');
  if (partition && partition.toLowerCase() !== 'development') {
    throw new Error('H1c confirmation is absent and closed; only development is permitted.');
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

export async function runH1cCli(options: H1cCliOptions): Promise<unknown> {
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

async function h0Command(options: H1cCliOptions): Promise<unknown> {
  requireH0Options(options);
  const validation = await validateH1cInputs(options.fixtureRoot);
  const runId = newRunId('h1c-h0');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  await ledger.initialize(buildH1cHarnessValidationManifest(runId, validation.locks));
  try {
    const report = await runH1cHarnessValidation({
      fixtureRoot: options.fixtureRoot,
      validation,
      ledger
    });
    return { runId, runDirectory: ledger.runDirectory, report };
  } catch (error) {
    await recordCommandFailure(ledger, 'H1C_H0_COMMAND_FAILED', error);
    throw error;
  }
}

async function planCommand(options: H1cCliOptions): Promise<unknown> {
  requirePlanOptions(options);
  const validation = await validateH1cInputs(options.fixtureRoot);
  const h0Validation = await loadH1cH0ValidationReceipt(
    options.stateRoot,
    options.h0RunId!,
    validation.locks
  );
  const participant = await loadH1cParticipantCorpus(options.fixtureRoot);
  const plan = buildH1cPlan({
    cases: participant.records,
    locks: validation.locks,
    h0Validation
  });
  const outputPath = options.outputPath ?? path.join(
    options.stateRoot,
    'plans',
    `h1c-development-${Date.now()}.json`
  );
  await writePrivateExclusiveH1cPlan(outputPath, plan);
  return {
    outputPath,
    sha256: await sha256File(outputPath),
    assignmentCount: plan.assignments.length,
    blockCount: plan.schedule.blockIds.length,
    partition: plan.partition
  };
}

async function probeCommand(options: H1cCliOptions): Promise<unknown> {
  requireProbeOptions(options);
  const validation = await validateH1cInputs(options.fixtureRoot);
  const h0Receipt = await loadH1cH0ValidationReceipt(
    options.stateRoot,
    options.h0RunId!,
    validation.locks
  );
  await assertProviderRootsReady(options);
  const runId = newRunId('h1c-public-schema-probe');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  await ledger.initialize(buildH1cProbeManifest({
    runId,
    componentLocks: validation.locks,
    providerUsageExplicitlyAuthorized: true
  }));
  await ledger.append({
    eventType: 'H1C_H0_RECEIPT_VERIFIED_FOR_PROBE',
    occurredAt: new Date().toISOString(),
    detail: {
      h0RunId: h0Receipt.runId,
      h0ManifestSha256: h0Receipt.manifestSha256,
      h0ReportSha256: h0Receipt.reportSha256
    }
  });
  const driver = new CodexLabTextDriver(driverOptions(options, ledger));
  const result = await runH1cProbe({
    runId,
    componentLocks: validation.locks,
    ledger,
    driver
  });
  if (result.report.status !== 'PASSED') {
    throw new Error(
      `H1c exact-model public-output-v4 probe ${runId} failed: ${result.report.failedChecks.join(', ')}.`
    );
  }
  return result;
}

async function runCommand(options: H1cCliOptions): Promise<unknown> {
  requireRunOptions(options);
  const plan = await readH1cPlan(options.planPath!);
  assertCliBudgetsMatchPlan(options, plan);
  const validation = await validateH1cInputs(options.fixtureRoot);
  const participant = await loadH1cParticipantCorpus(options.fixtureRoot);
  assertH1cPlan(plan, participant.records, validation.locks);
  const h0Receipt = await loadH1cH0ValidationReceipt(
    options.stateRoot,
    plan.h0Validation.runId,
    validation.locks
  );
  if (stableJson(h0Receipt) !== stableJson(plan.h0Validation)) {
    throw new Error('run H0 receipt does not match the private H1c plan.');
  }
  const probeReceipt = await loadH1cProbeReceipt(
    options.stateRoot,
    options.schemaProbeRunId!,
    validation.locks
  );
  await assertProviderRootsReady(options);

  const runId = newRunId('h1c-development');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  const driver = new CodexLabTextDriver(driverOptions(options, ledger));
  let initialized = false;
  let result: Awaited<ReturnType<typeof runH1cExperiment>> | undefined;
  let failure: unknown;
  try {
    await ledger.initialize(buildH1cExperimentManifest({
      runId,
      validation,
      plan,
      driver,
      model: options.model!,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      probeReceipt
    }));
    initialized = true;
    await ledger.append({
      eventType: 'H1C_PROBE_RECEIPT_VERIFIED',
      occurredAt: new Date().toISOString(),
      detail: {
        probeRunId: probeReceipt.runId,
        probeManifestSha256: probeReceipt.manifestSha256,
        probeReportSha256: probeReceipt.reportSha256,
        publicOutputSchemaSha256: probeReceipt.publicOutputSchemaSha256
      }
    });
    result = await runH1cExperiment({
      fixtureRoot: options.fixtureRoot,
      validation,
      plan,
      driver,
      ledger,
      model: options.model!,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      probeReceipt
    });
  } catch (error) {
    failure = error;
    if (initialized) {
      try {
        await recordCommandFailure(ledger, 'H1C_EXPERIMENT_COMMAND_FAILED', error);
      } catch (recordError) {
        failure = new AggregateError(
          [error, recordError],
          'H1c execution failed and its failure event could not be persisted.'
        );
      }
    }
  }

  if (result) {
    if (failure) throw failure;
    return {
      runId,
      runDirectory: ledger.runDirectory,
      result,
      close: result.driverClose
    };
  }

  // CodexLabTextDriver close is idempotent. If the runner failed before it
  // could return its authoritative post-close result, await the same close
  // operation and preserve a fallback close artifact rather than racing a
  // second supervisor shutdown.
  const close = await closeH1cProbeDriver(driver, DRIVER_CLOSE_MAXIMUM_MS);
  if (initialized) {
    try {
      await persistH1cFallbackDriverClose({ ledger, runId, close });
    } catch (recordError) {
      failure = failure
        ? new AggregateError(
            [failure, recordError],
            'H1c execution and close-evidence persistence both failed.'
          )
        : recordError;
    }
  }
  if (close.status !== 'CLEAN' || close.failure || close.boundaryViolations.length > 0) {
    const closeError = new Error(
      close.failure?.message ?? 'H1c experiment driver did not close cleanly.'
    );
    closeError.name = close.failure?.name ?? 'H1cDriverCloseError';
    failure = failure
      ? new AggregateError([failure, closeError], 'H1c execution and driver close both failed.')
      : closeError;
  }
  if (failure) throw failure;
  return { runId, runDirectory: ledger.runDirectory, result, close };
}

/**
 * A run that did not return its normal result still needs durable evidence for
 * the one awaited close operation owned by the CLI. Kept separate so this
 * failure path can be verified without starting a provider runtime.
 */
export async function persistH1cFallbackDriverClose(input: {
  ledger: LabArtifactLedger;
  runId: string;
  close: H1cProbeCloseResult;
}): Promise<string> {
  const closeArtifact = await input.ledger.putArtifact({
    kind: 'H1C_EXPERIMENT_FALLBACK_DRIVER_CLOSE',
    close: input.close
  });
  await input.ledger.writeReport('h1c-driver-close', {
    schemaVersion: 'task-monki/discourse-lab-h1c-driver-close@v1',
    runId: input.runId,
    resultReportWritten: false,
    closeArtifactSha256: closeArtifact.sha256,
    close: input.close
  });
  await input.ledger.append({
    eventType: input.close.status === 'CLEAN'
      ? 'H1C_EXPERIMENT_FALLBACK_DRIVER_CLOSED'
      : 'H1C_EXPERIMENT_FALLBACK_DRIVER_CLOSE_FAILED',
    occurredAt: input.close.completedAt,
    artifactSha256: closeArtifact.sha256,
    detail: {
      status: input.close.status,
      elapsedMs: input.close.elapsedMs,
      maximumMs: input.close.maximumMs,
      boundaryViolations: input.close.boundaryViolations,
      ...(input.close.failure ? { failure: input.close.failure } : {})
    }
  });
  return closeArtifact.sha256;
}

function requireH0Options(options: H1cCliOptions): void {
  if (
    options.confirmProviderUsage ||
    options.outputPath ||
    options.planPath ||
    options.h0RunId ||
    options.schemaProbeRunId ||
    hasProviderOrBudgetOptions(options)
  ) {
    throw new Error('h0 is local-only and does not accept provider, receipt, plan, or live-budget options.');
  }
}

function requirePlanOptions(options: H1cCliOptions): void {
  if (!options.h0RunId) throw new Error('plan requires --h0-run-id from a PASSED H1c h0 run.');
  if (
    options.confirmProviderUsage ||
    options.planPath ||
    options.schemaProbeRunId ||
    hasProviderOrBudgetOptions(options)
  ) {
    throw new Error('plan is local-only and accepts only its H0 receipt and optional --out path.');
  }
}

function requireProbeOptions(options: H1cCliOptions): void {
  if (!options.confirmProviderUsage) throw new Error('probe requires --confirm-provider-usage.');
  if (!options.h0RunId) throw new Error('probe requires --h0-run-id from a PASSED H1c h0 run.');
  requireExactModelSettings(options, 'probe');
  requireDistinctProviderRoots(options, 'probe');
  if (
    options.outputPath ||
    options.planPath ||
    options.schemaProbeRunId ||
    options.maximumCalls ||
    options.maximumTotalTokens ||
    options.maximumCallSeconds ||
    options.maximumExperimentSeconds
  ) {
    throw new Error('probe does not accept plan, probe-receipt, output, or semantic-run budget options.');
  }
}

function requireRunOptions(options: H1cCliOptions): void {
  if (!options.confirmProviderUsage) throw new Error('run requires --confirm-provider-usage.');
  if (!options.planPath) throw new Error('run requires --plan.');
  if (!options.schemaProbeRunId) {
    throw new Error('run requires --schema-probe-run-id from a PASSED H1c public-output-v4 probe.');
  }
  if (options.h0RunId || options.outputPath) {
    throw new Error('run obtains H0 from its sealed plan and does not accept --h0-run-id or --out.');
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
    options.maximumCalls !== MAXIMUM_CALLS ? '--max-calls 28' : null,
    options.maximumTotalTokens !== MAXIMUM_TOTAL_TOKENS
      ? '--max-total-tokens 300000'
      : null,
    options.maximumCallSeconds !== MAXIMUM_CALL_SECONDS ? '--max-call-seconds 120' : null,
    options.maximumExperimentSeconds !== MAXIMUM_EXPERIMENT_SECONDS
      ? '--max-experiment-seconds 2400'
      : null
  ].filter((value): value is string => Boolean(value));
  if (mismatches.length > 0) {
    throw new Error(`run requires the exact sealed budget values: ${mismatches.join(', ')}.`);
  }
}

function hasProviderOrBudgetOptions(options: H1cCliOptions): boolean {
  return Boolean(
    options.model ||
    options.reasoningEffort ||
    options.serviceTier ||
    options.codexHome ||
    options.executionRoot ||
    options.executable ||
    options.maximumCalls ||
    options.maximumTotalTokens ||
    options.maximumCallSeconds ||
    options.maximumExperimentSeconds
  );
}

function requireExactModelSettings(
  options: H1cCliOptions,
  command: 'probe' | 'run'
): void {
  if (
    options.model !== H1C_PROBE_MODEL ||
    options.reasoningEffort !== H1C_PROBE_REASONING_EFFORT ||
    options.serviceTier !== H1C_PROBE_SERVICE_TIER
  ) {
    throw new Error(
      `${command} requires --model ${H1C_PROBE_MODEL} --reasoning-effort ${H1C_PROBE_REASONING_EFFORT} --service-tier ${H1C_PROBE_SERVICE_TIER}.`
    );
  }
}

function requireDistinctProviderRoots(
  options: H1cCliOptions,
  command: 'probe' | 'run'
): void {
  if (!options.codexHome) throw new Error(`${command} requires --codex-home.`);
  if (!options.executionRoot) throw new Error(`${command} requires --execution-root.`);
  if (pathsOverlap(options.codexHome, options.executionRoot)) {
    throw new Error(
      `${command} requires separate, non-overlapping --codex-home and --execution-root paths.`
    );
  }
}

async function assertProviderRootsReady(options: H1cCliOptions): Promise<void> {
  await assertCodexLabIsolation({
    codexHome: options.codexHome!,
    executionRoot: options.executionRoot!,
    repositoryRoot: options.repositoryRoot
  });
}

function assertCliBudgetsMatchPlan(options: H1cCliOptions, plan: H1cPlan): void {
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
    throw new Error(`run CLI budgets do not match the private H1c plan: ${mismatches.join(', ')}.`);
  }
}

async function readH1cPlan(filePath: string): Promise<H1cPlan> {
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
  if (!value || typeof value !== 'object' || !Array.isArray((value as H1cPlan).assignments)) {
    throw new Error('run plan has an invalid shape.');
  }
  return value as H1cPlan;
}

function driverOptions(options: H1cCliOptions, ledger: LabArtifactLedger) {
  return {
    stateRoot: path.join(ledger.runDirectory, 'codex'),
    executionRoot: options.executionRoot!,
    codexHome: options.codexHome!,
    repositoryRoot: options.repositoryRoot,
    appVersion: APP_VERSION,
    executable: options.executable
  };
}

async function recordCommandFailure(
  ledger: LabArtifactLedger,
  eventType: string,
  error: unknown
): Promise<void> {
  await ledger.append({
    eventType,
    occurredAt: new Date().toISOString(),
    detail: serializeH1cProbeFailure(error)
  });
}

export async function writePrivateExclusiveH1cPlan(
  filePath: string,
  plan: H1cPlan
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
    'Evaluation-only H1c Discourse Protocol Lab',
    '',
    'Commands:',
    '  h0 [--state-root PATH] [--fixture-root PATH]',
    '  plan --h0-run-id RUN_ID [--out PATH] [--state-root PATH] [--fixture-root PATH]',
    '  probe --h0-run-id RUN_ID --codex-home PATH --execution-root PATH --model gpt-5.6-sol --reasoning-effort high --service-tier default --confirm-provider-usage [--executable PATH]',
    '  run --plan PATH --schema-probe-run-id RUN_ID --codex-home PATH --execution-root PATH --model gpt-5.6-sol --reasoning-effort high --service-tier default --max-calls 28 --max-total-tokens 300000 --max-call-seconds 120 --max-experiment-seconds 2400 --confirm-provider-usage [--executable PATH]',
    '  help',
    '',
    'H1c v3 is development-only ordinary text. H0 and plan make zero provider calls. Any future probe requires the passed v3 H0 receipt plus explicit provider authorization; any future run requires that sealed plan, a fresh PASSED v3-contract probe, and separate explicit authorization. Confirmation is absent and closed.'
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const result = await runH1cCli(parseH1cCliArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const detail = serializeH1cProbeFailure(error);
    process.stderr.write(`${detail.name}: ${detail.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
