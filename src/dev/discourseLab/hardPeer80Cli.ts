import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CODEX_LAB_TEXT_DRIVER_ID,
  CodexLabTextDriver,
  assertCodexLabIsolation
} from './CodexTextDriver';
import { auditHardPeer80Archive } from './hardPeer80Archive';
import {
  loadHardPeer80OracleCorpus,
  loadHardPeer80ParticipantCorpus,
  type HardPeer80ParticipantCorpus
} from './hardPeer80Corpus';
import {
  buildHardPeer80Manifest,
  runHardPeer80TerminalStudy,
  type HardPeer80ProviderStage
} from './hardPeer80Experiment';
import {
  buildHardPeer80HarnessValidationManifest,
  executeAndRecordHardPeer80H0,
  loadHardPeer80H0Receipt
} from './hardPeer80HarnessValidation';
import { buildHardPeer80Plan } from './hardPeer80Plan';
import { createHardPeer80Scorer } from './hardPeer80Scoring';
import {
  buildHardPeer80SealedPlan,
  loadHardPeer80SealedPlan,
  persistHardPeer80SealedPlan,
  validateHardPeer80Inputs,
  type HardPeer80H0Receipt
} from './hardPeer80Validation';
import { LabArtifactLedger, stableJson } from './ledger';

const DEFAULT_STATE_ROOT = path.join('.local', 'discourse-protocol-lab-hard-peer-80');
const APP_VERSION = '0.2.0-alpha.1-discourse-lab-hard-peer-80-v1';
const MODEL = 'gpt-5.6-sol';
const REASONING_EFFORT = 'high';
const SERVICE_TIER = 'default';
const MAXIMUM_CALLS = 76;
const MAXIMUM_TOTAL_TOKENS = 1_500_000;
const MAXIMUM_CALL_SECONDS = 120;
const MAXIMUM_EXPERIMENT_SECONDS = 18_000;

const PROVIDER_STAGES: readonly HardPeer80ProviderStage[] = [
  'PROBE',
  'CALIBRATION',
  'EVALUATION'
];

type HardPeer80CliCommand = 'h0' | 'plan' | 'run' | 'help';

export interface HardPeer80CliOptions {
  command: HardPeer80CliCommand;
  stateRoot: string;
  fixtureRoot: string;
  outputPath?: string;
  planPath?: string;
  h0RunId?: string;
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

interface PreparedProviderRoots {
  executionRoots: Record<HardPeer80ProviderStage, string>;
}

const VALUE_OPTIONS = new Set([
  '--state-root',
  '--fixture-root',
  '--out',
  '--plan',
  '--h0-run-id',
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

export function parseHardPeer80CliArgs(
  argv: string[],
  cwd = process.cwd()
): HardPeer80CliOptions {
  const command = (argv[0] ?? 'help') as HardPeer80CliCommand;
  if (!['h0', 'plan', 'run', 'help'].includes(command)) {
    throw new Error(`Unknown HARD-PEER-80 command: ${command}`);
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
    if (!VALUE_OPTIONS.has(argument)) {
      throw new Error(`Unknown HARD-PEER-80 option: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const partition = values.get('--partition');
  if (partition && partition.toLowerCase() !== 'development') {
    throw new Error(
      'HARD-PEER-80 confirmation is absent and closed; only development is permitted.'
    );
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

export async function runHardPeer80Cli(options: HardPeer80CliOptions): Promise<unknown> {
  switch (options.command) {
    case 'help':
      return { help: helpText() };
    case 'h0':
      return h0Command(options);
    case 'plan':
      return planCommand(options);
    case 'run':
      return runCommand(options);
  }
}

async function h0Command(options: HardPeer80CliOptions): Promise<unknown> {
  requireH0Options(options);
  const validation = await validateHardPeer80Inputs(options.fixtureRoot, {
    projectRoot: options.repositoryRoot
  });
  const { calibration, evaluation } = await loadParticipants(options.fixtureRoot);
  const plan = buildHardPeer80Plan({
    calibrationCaseIds: calibration.records.map(({ caseId }) => caseId),
    evaluationCaseIds: evaluation.records.map(({ caseId }) => caseId)
  });
  const runId = newRunId('hard-peer-80-h0');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  await ledger.initialize(buildHardPeer80HarnessValidationManifest(
    runId,
    validation.locks,
    [...plan.schedule.calibrationCaseIds, ...uniqueEvaluationCaseIds(plan)]
  ));
  const receipt = await executeAndRecordHardPeer80H0({
    fixtureRoot: options.fixtureRoot,
    validation,
    plan,
    ledger
  });
  const receiptPath = hardPeer80H0ReceiptPath(options.stateRoot, runId);
  await writePrivateExclusiveHardPeer80Json(receiptPath, receipt);
  return {
    runId,
    runDirectory: ledger.runDirectory,
    receiptPath,
    receipt,
    providerCalls: 0
  };
}

async function planCommand(options: HardPeer80CliOptions): Promise<unknown> {
  requirePlanOptions(options);
  const validation = await validateHardPeer80Inputs(options.fixtureRoot, {
    projectRoot: options.repositoryRoot
  });
  const { calibration, evaluation } = await loadParticipants(options.fixtureRoot);
  const plan = buildHardPeer80Plan({
    calibrationCaseIds: calibration.records.map(({ caseId }) => caseId),
    evaluationCaseIds: evaluation.records.map(({ caseId }) => caseId)
  });
  const receipt = await readHardPeer80H0Receipt(
    hardPeer80H0ReceiptPath(options.stateRoot, options.h0RunId!)
  );
  await loadHardPeer80H0Receipt({
    ledgerRoot: options.stateRoot,
    receipt,
    activeLocks: validation.locks,
    plan
  });
  const sealedPlan = buildHardPeer80SealedPlan({ validation, h0Receipt: receipt, plan });
  const outputPath = options.outputPath ?? path.join(
    options.stateRoot,
    'plans',
    `hard-peer-80-terminal-${Date.now()}.json`
  );
  const persisted = await persistHardPeer80SealedPlan(outputPath, sealedPlan, validation);
  return {
    outputPath: persisted.path,
    sha256: persisted.sha256,
    h0RunId: receipt.runId,
    semanticCallCount: plan.assignments.length,
    nonModelForkCount: plan.forks.length + 1,
    terminalStudy: true,
    confirmationOpened: false,
    providerCalls: 0
  };
}

async function runCommand(options: HardPeer80CliOptions): Promise<unknown> {
  requireRunOptions(options);

  // This is the only provider-free step that opens scorer-only files. The
  // returned report contains hashes and source closure, never oracle values.
  // It must complete before any driver is constructed.
  const validation = await validateHardPeer80Inputs(options.fixtureRoot, {
    projectRoot: options.repositoryRoot
  });
  const loadedPlan = await loadHardPeer80SealedPlan(options.planPath!, validation);
  assertCliBudgetsMatchPlan(options, loadedPlan.plan.plan);
  const { calibration, evaluation } = await loadParticipants(options.fixtureRoot);
  const h0PromptTemplateSetSha256 = (await loadHardPeer80H0Receipt({
    ledgerRoot: options.stateRoot,
    receipt: loadedPlan.plan.h0Receipt,
    activeLocks: validation.locks,
    plan: loadedPlan.plan.plan
  })).promptTemplateSetSha256;

  // The supplied base must itself be empty. It is then split once into three
  // empty, non-overlapping execution roots so no provider process or inert cwd
  // is reused between probe, calibration, and locked evaluation.
  const providerRoots = await prepareHardPeer80ProviderRoots({
    codexHome: options.codexHome!,
    executionRoot: options.executionRoot!,
    repositoryRoot: options.repositoryRoot,
    stateRoot: options.stateRoot
  });

  const runId = newRunId('hard-peer-80-development');
  const ledger = new LabArtifactLedger(options.stateRoot, runId);
  await ledger.initialize(buildHardPeer80Manifest({
    runId,
    plan: loadedPlan.plan.plan,
    locks: validation.locks,
    driverId: CODEX_LAB_TEXT_DRIVER_ID,
    participantCaseIds: [
      ...calibration.records.map(({ caseId }) => caseId),
      ...evaluation.records.map(({ caseId }) => caseId)
    ]
  }));

  const stateRootByStage = await prepareStageStateRoots(ledger.runDirectory);
  const createdStages = new Set<HardPeer80ProviderStage>();
  const scorer = createHardPeer80Scorer();
  const result = await runHardPeer80TerminalStudy({
    runId,
    fixtureRoot: options.fixtureRoot,
    plan: loadedPlan.plan.plan,
    locks: validation.locks,
    eligibility: {
      sealVersion: validation.sealVersion,
      preregistrationVersion: validation.preregistrationVersion,
      sourceLockSha256: validation.sourceLock.sha256,
      sealedPlanSha256: loadedPlan.sha256,
      h0RunId: loadedPlan.plan.h0Receipt.runId,
      h0ManifestSha256: loadedPlan.plan.h0Receipt.manifestSha256,
      h0ReportSha256: loadedPlan.plan.h0Receipt.reportSha256,
      h0PromptTemplateSetSha256,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      serviceTier: SERVICE_TIER,
      authorization: 'EXPLICIT_CONFIRM_PROVIDER_USAGE',
      boundaryProbe: 'ONE_LIVE_OUTPUT_PLUS_ONE_ZERO_MODEL_FORK_INSIDE_THIS_RUN'
    },
    calibrationParticipants: calibration,
    evaluationParticipants: evaluation,
    // Oracle material is reopened only after the corresponding provider stage
    // has closed. No parsed oracle object is captured in a live driver closure.
    loadOracle: async (partition) => loadHardPeer80OracleCorpus(
      options.fixtureRoot,
      partition,
      partition === 'CALIBRATION' ? calibration : evaluation
    ),
    ledger,
    createDriver: (stage) => {
      if (createdStages.has(stage)) {
        throw new Error(`HARD-PEER-80 attempted to recreate the ${stage} driver.`);
      }
      createdStages.add(stage);
      return {
        driver: new CodexLabTextDriver({
          stateRoot: stateRootByStage[stage],
          executionRoot: providerRoots.executionRoots[stage],
          codexHome: options.codexHome!,
          repositoryRoot: options.repositoryRoot,
          appVersion: APP_VERSION,
          executable: options.executable
        }),
        runtimeRoot: stateRootByStage[stage]
      };
    },
    scorer,
    expectedModelProvider: 'openai'
  });
  if (result.stages.some(({ close }) => close.status !== 'CLEAN')) {
    throw new Error(
      'HARD-PEER-80 stopped with an ambiguous provider close; scorer-only archive audit was not opened.'
    );
  }
  // This is an intentionally independent second read after every constructed
  // provider driver has closed. The audit recomputes scores from raw outputs.
  const calibrationOracle = await loadHardPeer80OracleCorpus(
    options.fixtureRoot,
    'CALIBRATION',
    calibration
  );
  const evaluationOracle = await loadHardPeer80OracleCorpus(
    options.fixtureRoot,
    'EVALUATION',
    evaluation
  );
  const audit = await auditHardPeer80Archive({
    ledger,
    result,
    scorer,
    calibrationParticipants: calibration,
    evaluationParticipants: evaluation,
    calibrationOracle,
    evaluationOracle
  });
  return {
    runId,
    runDirectory: ledger.runDirectory,
    sealedPlanSha256: loadedPlan.sha256,
    result,
    audit,
    finalProductDecision: audit.finalProductDecision
  };
}

function requireH0Options(options: HardPeer80CliOptions): void {
  if (
    options.confirmProviderUsage ||
    options.outputPath ||
    options.planPath ||
    options.h0RunId ||
    hasProviderOrBudgetOptions(options)
  ) {
    throw new Error(
      'HARD-PEER-80 h0 is local-only and does not accept provider, plan, receipt, or live-budget options.'
    );
  }
}

function requirePlanOptions(options: HardPeer80CliOptions): void {
  if (!options.h0RunId) {
    throw new Error('HARD-PEER-80 plan requires --h0-run-id from a PASSED local H0 run.');
  }
  if (
    options.confirmProviderUsage ||
    options.planPath ||
    hasProviderOrBudgetOptions(options)
  ) {
    throw new Error(
      'HARD-PEER-80 plan is local-only and accepts only its H0 receipt and optional --out path.'
    );
  }
}

function requireRunOptions(options: HardPeer80CliOptions): void {
  if (!options.confirmProviderUsage) {
    throw new Error('HARD-PEER-80 run requires --confirm-provider-usage.');
  }
  if (!options.planPath) throw new Error('HARD-PEER-80 run requires --plan.');
  if (options.h0RunId || options.outputPath) {
    throw new Error(
      'HARD-PEER-80 run obtains H0 from its sealed plan and does not accept --h0-run-id or --out.'
    );
  }
  requireExactModelSettings(options);
  requireDistinctProviderRoots(options);
  const missing = [
    options.maximumCalls === undefined ? '--max-calls' : null,
    options.maximumTotalTokens === undefined ? '--max-total-tokens' : null,
    options.maximumCallSeconds === undefined ? '--max-call-seconds' : null,
    options.maximumExperimentSeconds === undefined ? '--max-experiment-seconds' : null
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    throw new Error(`HARD-PEER-80 run requires exact CLI budgets: ${missing.join(', ')}.`);
  }
  const mismatches = [
    options.maximumCalls !== MAXIMUM_CALLS ? '--max-calls 76' : null,
    options.maximumTotalTokens !== MAXIMUM_TOTAL_TOKENS
      ? '--max-total-tokens 1500000'
      : null,
    options.maximumCallSeconds !== MAXIMUM_CALL_SECONDS ? '--max-call-seconds 120' : null,
    options.maximumExperimentSeconds !== MAXIMUM_EXPERIMENT_SECONDS
      ? '--max-experiment-seconds 18000'
      : null
  ].filter((value): value is string => Boolean(value));
  if (mismatches.length > 0) {
    throw new Error(
      `HARD-PEER-80 run requires the exact sealed budget values: ${mismatches.join(', ')}.`
    );
  }
}

function requireExactModelSettings(options: HardPeer80CliOptions): void {
  if (
    options.model !== MODEL ||
    options.reasoningEffort !== REASONING_EFFORT ||
    options.serviceTier !== SERVICE_TIER
  ) {
    throw new Error(
      `HARD-PEER-80 run requires --model ${MODEL} --reasoning-effort ${REASONING_EFFORT} --service-tier ${SERVICE_TIER}.`
    );
  }
}

function requireDistinctProviderRoots(options: HardPeer80CliOptions): void {
  if (!options.codexHome) throw new Error('HARD-PEER-80 run requires --codex-home.');
  if (!options.executionRoot) throw new Error('HARD-PEER-80 run requires --execution-root.');
  if (
    pathsOverlap(options.codexHome, options.executionRoot) ||
    pathsOverlap(options.codexHome, options.stateRoot) ||
    pathsOverlap(options.codexHome, options.repositoryRoot) ||
    pathsOverlap(options.executionRoot, options.stateRoot) ||
    pathsOverlap(options.executionRoot, options.repositoryRoot)
  ) {
    throw new Error(
      'HARD-PEER-80 requires separate, non-overlapping Codex-home, external execution, state, and repository roots.'
    );
  }
}

function hasProviderOrBudgetOptions(options: HardPeer80CliOptions): boolean {
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

function assertCliBudgetsMatchPlan(
  options: HardPeer80CliOptions,
  plan: ReturnType<typeof buildHardPeer80Plan>
): void {
  const mismatches = [
    options.maximumCalls !== plan.budget.maximumProviderCalls ? '--max-calls' : null,
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
    throw new Error(
      `HARD-PEER-80 CLI budgets do not match the sealed plan: ${mismatches.join(', ')}.`
    );
  }
}

export async function prepareHardPeer80ProviderRoots(input: {
  codexHome: string;
  executionRoot: string;
  repositoryRoot: string;
  stateRoot: string;
}): Promise<PreparedProviderRoots> {
  if (
    pathsOverlap(input.codexHome, input.executionRoot) ||
    pathsOverlap(input.codexHome, input.stateRoot) ||
    pathsOverlap(input.codexHome, input.repositoryRoot) ||
    pathsOverlap(input.executionRoot, input.repositoryRoot) ||
    pathsOverlap(input.executionRoot, input.stateRoot)
  ) {
    throw new Error(
      'HARD-PEER-80 requires separate, non-overlapping Codex-home, external execution, state, and repository roots.'
    );
  }
  await assertCodexLabIsolation({
    codexHome: input.codexHome,
    executionRoot: input.executionRoot,
    repositoryRoot: input.repositoryRoot
  });
  const executionRoots = Object.fromEntries(PROVIDER_STAGES.map((stage) => [
    stage,
    path.join(input.executionRoot, stage.toLowerCase())
  ])) as Record<HardPeer80ProviderStage, string>;
  for (const stage of PROVIDER_STAGES) {
    await fs.mkdir(executionRoots[stage], { mode: 0o700 });
    await assertCodexLabIsolation({
      codexHome: input.codexHome,
      executionRoot: executionRoots[stage],
      repositoryRoot: input.repositoryRoot
    });
  }
  return { executionRoots };
}

async function prepareStageStateRoots(
  runDirectory: string
): Promise<Record<HardPeer80ProviderStage, string>> {
  const parent = path.join(runDirectory, 'provider-stages');
  await fs.mkdir(parent, { mode: 0o700 });
  const roots = Object.fromEntries(PROVIDER_STAGES.map((stage) => [
    stage,
    path.join(parent, stage.toLowerCase())
  ])) as Record<HardPeer80ProviderStage, string>;
  for (const stage of PROVIDER_STAGES) {
    await fs.mkdir(roots[stage], { mode: 0o700 });
    const entries = await fs.readdir(roots[stage]);
    if (entries.length > 0) {
      throw new Error(`HARD-PEER-80 ${stage} provider state root is not initially empty.`);
    }
  }
  return roots;
}

async function loadParticipants(fixtureRoot: string): Promise<{
  calibration: HardPeer80ParticipantCorpus;
  evaluation: HardPeer80ParticipantCorpus;
}> {
  const calibration = await loadHardPeer80ParticipantCorpus(fixtureRoot, 'CALIBRATION');
  const evaluation = await loadHardPeer80ParticipantCorpus(fixtureRoot, 'EVALUATION');
  return { calibration, evaluation };
}

function uniqueEvaluationCaseIds(plan: ReturnType<typeof buildHardPeer80Plan>): string[] {
  return [...new Set(plan.assignments
    .filter(({ phase, turnId }) => phase === 'EVALUATION' && turnId === 'A0')
    .map(({ caseId }) => caseId)
    .filter((caseId): caseId is string => Boolean(caseId)))];
}

function hardPeer80H0ReceiptPath(stateRoot: string, runId: string): string {
  if (!safeRunId(runId)) throw new Error(`Unsafe HARD-PEER-80 H0 run id: ${runId}.`);
  return path.join(stateRoot, 'receipts', `${runId}.json`);
}

export async function writePrivateExclusiveHardPeer80Json(
  filePath: string,
  value: unknown
): Promise<void> {
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

async function readHardPeer80H0Receipt(filePath: string): Promise<HardPeer80H0Receipt> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`HARD-PEER-80 H0 receipt is unavailable or unsafe: ${filePath}.`);
  }
  let receipt: HardPeer80H0Receipt;
  try {
    receipt = JSON.parse(await fs.readFile(filePath, 'utf8')) as HardPeer80H0Receipt;
  } catch {
    throw new Error(`HARD-PEER-80 H0 receipt is not valid JSON: ${filePath}.`);
  }
  return receipt;
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

function safeRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== '..';
}

function newRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

function helpText(): string {
  return [
    'Evaluation-only terminal HARD-PEER-80 Discourse Protocol Lab',
    '',
    'Commands:',
    '  h0 [--state-root PATH] [--fixture-root PATH]',
    '  plan --h0-run-id RUN_ID [--out PATH] [--state-root PATH] [--fixture-root PATH]',
    `  run --plan PATH --codex-home PATH --execution-root EMPTY_PATH --model ${MODEL} --reasoning-effort ${REASONING_EFFORT} --service-tier ${SERVICE_TIER} --max-calls ${MAXIMUM_CALLS} --max-total-tokens ${MAXIMUM_TOTAL_TOKENS} --max-call-seconds ${MAXIMUM_CALL_SECONDS} --max-experiment-seconds ${MAXIMUM_EXPERIMENT_SECONDS} --confirm-provider-usage [--executable PATH]`,
    '  help',
    '',
    'H0 and plan make zero provider calls. The single run command owns the one live boundary/output/fork probe, the one calibration batch, and—only if calibration passes—the one locked evaluation run. It never retries or repairs a provider output. Confirmation and follow-up studies are absent and closed.'
  ].join('\n');
}

function errorDetail(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

async function main(): Promise<void> {
  try {
    const result = await runHardPeer80Cli(
      parseHardPeer80CliArgs(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const detail = errorDetail(error);
    process.stderr.write(`${detail.name}: ${detail.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
