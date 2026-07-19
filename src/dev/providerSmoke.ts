import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentModel,
  AgentObservationSource,
  AgentRunStatus,
  AgentRuntimeCatalog,
  AgentRuntimeReadinessStatus,
  AgentRuntimeState
} from '../shared/agent';
import type {
  GitSnapshotRecord,
  GitStatus,
  RunRecord,
  TaskSnapshot
} from '../shared/contracts';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { git } from '../core/git/gitCli';
import { FileTaskStore } from '../core/storage/FileTaskStore';

const REPORT_SCHEMA_VERSION = 'task-monki/provider-smoke@v1' as const;
const SMOKE_SENTINEL = 'TASK_MONKI_PROVIDER_SMOKE_OK';
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const CANCEL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const MAX_MODELS = 256;
const TERMINAL_STATUSES = new Set<AgentRunStatus>([
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
  'LOST'
]);
const CONTAINED_TERMINAL_STATUSES = new Set<AgentRunStatus>([
  'COMPLETED',
  'FAILED',
  'INTERRUPTED'
]);
const PROVIDER_DERIVED_OBSERVATION_SOURCES = new Set<AgentObservationSource>([
  'THREAD_START_RESPONSE',
  'THREAD_RESUME_RESPONSE',
  'THREAD_FORK_RESPONSE',
  'THREAD_SETTINGS_NOTIFICATION',
  'MODEL_REROUTED_NOTIFICATION',
  'RECOVERY_RESUME_RESPONSE'
]);

export interface ProviderSmokeOptions {
  repositoryPath: string;
  stateRoot?: string;
  runtimeIds: string[];
  modelIds: string[];
  timeoutMs: number;
  confirmThrowaway: boolean;
  confirmProviderUsage: boolean;
  help: boolean;
}

export interface ProviderSmokeTarget {
  runtimeId: string;
  runtimeStatus: AgentRuntimeReadinessStatus;
  model: AgentModel;
  reasoningEffort?: string;
}

export interface ProviderSmokeResult {
  runtimeId: string;
  runtimeStatus: AgentRuntimeReadinessStatus;
  modelId: string;
  modelProvider?: string;
  model: string;
  displayName: string;
  reasoningEffort?: string;
  verdict: 'PASSED' | 'FAILED' | 'INTERRUPTED' | 'UNATTESTED';
  taskId?: string;
  runId?: string;
  runStatus?: AgentRunStatus;
  gitStatus?: GitStatus;
  gitSnapshotId?: string;
  repositoryClean: boolean;
  repositoryIdentityUnchanged: boolean;
  receivedSentinel: boolean;
  selectionAttestation?:
    | 'PROVIDER_CONFIRMED'
    | 'PROVIDER_DEFAULT_CONFIRMED'
    | 'ADAPTER_RESOLVED'
    | 'REQUESTED_ONLY'
    | 'OBSERVED_MISMATCH';
  observedModel?: string;
  observedModelProvider?: string;
  observedReasoningEffort?: string;
  observationSource?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface ProviderSmokeReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  completionStatus: 'COMPLETED' | 'STOPPED_EARLY';
  authoritative: boolean;
  errors: string[];
  repositoryPath: string;
  repositoryClean: boolean;
  repositoryIdentityUnchanged: boolean;
  expectedRepositoryHead: string;
  actualRepositoryHead?: string;
  expectedRepositoryRef?: string;
  actualRepositoryRef?: string;
  stateRoot: string;
  startedAt: string;
  completedAt: string;
  runtimes: Array<{
    runtimeId: string;
    displayName: string;
    status: AgentRuntimeReadinessStatus;
    canStart: boolean;
    visibleModelCount: number;
    summary: string;
    skipReason?: string;
    models: Array<{
      modelId: string;
      displayName: string;
      hidden: boolean;
      outcome: ProviderSmokeResult['verdict'] | 'SKIPPED' | 'NOT_REACHED';
      reason?: string;
    }>;
  }>;
  results: ProviderSmokeResult[];
  selection: {
    requestedRuntimeIds: string[];
    requestedModelIds: string[];
    eligibleModelIds: string[];
    executedModelIds: string[];
    unmatchedRuntimeIds: string[];
    unmatchedModelIds: string[];
    unavailableRuntimeIds: string[];
    unavailableModelIds: string[];
    notExecutedModelIds: string[];
  };
}

export type ProviderSmokeService = Pick<
  TaskManagerService,
  | 'init'
  | 'getAgentRuntimeCatalog'
  | 'discoverAgentRuntimeModels'
  | 'getDefaultRepositoryPath'
  | 'createTask'
  | 'startRun'
  | 'listTasks'
  | 'refreshEvidence'
  | 'cancelRun'
  | 'shutdown'
>;

export interface ProviderSmokeDependencies {
  createService?: (input: {
    repositoryPath: string;
    stateRoot: string;
  }) => ProviderSmokeService;
  pollIntervalMs?: number;
  cancelTimeoutMs?: number;
  maxModels?: number;
}

interface RepositoryBaseline {
  path: string;
  head: string;
  ref?: string;
}

interface RepositoryState {
  clean: boolean;
  identityUnchanged: boolean;
  head?: string;
  ref?: string;
  error?: string;
}

export function parseProviderSmokeArguments(args: readonly string[]): ProviderSmokeOptions {
  const options: ProviderSmokeOptions = {
    repositoryPath: '',
    runtimeIds: [],
    modelIds: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    confirmThrowaway: false,
    confirmProviderUsage: false,
    help: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    switch (argument) {
      case '--repository':
        options.repositoryPath = argumentValue(args, ++index, argument);
        break;
      case '--state-root':
        options.stateRoot = argumentValue(args, ++index, argument);
        break;
      case '--runtime':
        options.runtimeIds.push(argumentValue(args, ++index, argument));
        break;
      case '--model':
        options.modelIds.push(argumentValue(args, ++index, argument));
        break;
      case '--timeout-seconds': {
        const seconds = Number(argumentValue(args, ++index, argument));
        if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 3_600) {
          throw new Error('--timeout-seconds must be an integer from 10 through 3600.');
        }
        options.timeoutMs = seconds * 1_000;
        break;
      }
      case '--confirm-throwaway':
        options.confirmThrowaway = true;
        break;
      case '--confirm-provider-usage':
        options.confirmProviderUsage = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown provider smoke option: ${argument}`);
    }
  }
  options.runtimeIds = uniqueValues(options.runtimeIds, '--runtime');
  options.modelIds = uniqueValues(options.modelIds, '--model');
  if (!options.help && !options.repositoryPath.trim()) {
    throw new Error('--repository is required.');
  }
  if (!options.help && !options.confirmThrowaway) {
    throw new Error(
      '--confirm-throwaway is required because provider runs create task branches and worktrees.'
    );
  }
  if (!options.help && !options.confirmProviderUsage) {
    throw new Error(
      '--confirm-provider-usage is required because this command sends one billable prompt to every selected model.'
    );
  }
  return options;
}

export function selectLowestReasoningEffort(model: AgentModel): string | undefined {
  const choices = model.supportedReasoningEfforts.map((value, index) => ({
    value,
    index,
    rank: reasoningRank(value)
  }));
  if (choices.length > 0 && choices.every((choice) => choice.rank !== undefined)) {
    return choices.sort(
      (left, right) => left.rank! - right.rank! || left.index - right.index
    )[0]!.value;
  }
  if (
    model.defaultReasoningEffort &&
    model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
  ) {
    return model.defaultReasoningEffort;
  }
  // Runtime-native choices do not have a portable cost ordering. An arbitrary
  // first choice could be more expensive than the provider default, so omit the
  // override unless the catalog supplies an explicit default.
  return undefined;
}

export function discoverProviderSmokeTargets(
  catalog: AgentRuntimeCatalog,
  options: Pick<ProviderSmokeOptions, 'runtimeIds' | 'modelIds'>,
  excludedModelIds: ReadonlySet<string> = new Set()
): ProviderSmokeTarget[] {
  const runtimeFilter = new Set(options.runtimeIds);
  const modelFilter = new Set(options.modelIds);
  return catalog.runtimes
    .filter(
      ({ preflight }) =>
        preflight.readiness.canStart &&
        (runtimeFilter.size === 0 || runtimeFilter.has(preflight.runtime.id))
    )
    .flatMap((runtime) =>
      runtime.models
        .filter(
          (model) =>
            !model.hidden &&
            !excludedModelIds.has(model.id) &&
            (modelFilter.size === 0 || modelFilter.has(model.id))
        )
        .map((model) => ({
          runtimeId: runtime.preflight.runtime.id,
          runtimeStatus: runtime.preflight.readiness.status,
          model,
          reasoningEffort: selectLowestReasoningEffort(model)
        }))
    )
    .sort(
      (left, right) =>
        left.runtimeId.localeCompare(right.runtimeId) ||
        left.model.id.localeCompare(right.model.id)
    );
}

export async function runProviderSmoke(
  options: ProviderSmokeOptions,
  dependencies: ProviderSmokeDependencies = {}
): Promise<ProviderSmokeReport> {
  const repository = await requireThrowawayRepository(options.repositoryPath);
  const repositoryPath = repository.path;
  const stateRoot = await createStateRoot(options.stateRoot, repositoryPath);
  const service = dependencies.createService?.({ repositoryPath, stateRoot }) ??
    new TaskManagerService(
      new FileTaskStore(path.join(stateRoot, 'store')),
      repositoryPath,
      undefined,
      { worktreeRoot: path.join(stateRoot, 'worktrees'), agentCwd: repositoryPath }
    );
  const pollIntervalMs = dependencies.pollIntervalMs ?? POLL_INTERVAL_MS;
  const cancelTimeoutMs = dependencies.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
  const maxModels = dependencies.maxModels ?? MAX_MODELS;
  const startedAt = new Date().toISOString();
  const results: ProviderSmokeResult[] = [];
  const errors: string[] = [];
  const completedModelIds = new Set<string>();
  const queuedModelIds = new Set<string>();
  const eligibleModelIds = new Set<string>();
  const queue: ProviderSmokeTarget[] = [];
  const discoveredModels = new Map<string, AgentModel>();
  const discoveredRuntimes = new Map<string, AgentRuntimeState>();
  let stopRequested = false;
  let activeRunId: string | undefined;
  const stop = (signal?: NodeJS.Signals) => {
    stopRequested = true;
    if (signal) appendUnique(errors, `Provider smoke interrupted by ${signal}.`);
    if (activeRunId) void service.cancelRun({ runId: activeRunId }).catch(() => undefined);
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    try {
      await service.init();
      let catalog = await service.getAgentRuntimeCatalog();
      if (await activateSelectedModelCatalogs(service, catalog, options)) {
        catalog = await service.getAgentRuntimeCatalog();
      }
      rememberCatalog(catalog, discoveredRuntimes, discoveredModels);
      enqueueTargets(
        catalog,
        options,
        completedModelIds,
        queuedModelIds,
        eligibleModelIds,
        queue
      );
      // One immediate retry makes on-demand catalog activation observable while
      // retaining an honest unmatched selector when no model ever appears.
      if (queue.length === 0) {
        catalog = await service.getAgentRuntimeCatalog();
        rememberCatalog(catalog, discoveredRuntimes, discoveredModels);
        enqueueTargets(
          catalog,
          options,
          completedModelIds,
          queuedModelIds,
          eligibleModelIds,
          queue
        );
      }

      while (queue.length > 0 && !stopRequested) {
        if (results.length >= maxModels) {
          appendUnique(
            errors,
            `Provider discovery exceeded the ${maxModels}-model safety limit.`
          );
          stopRequested = true;
          break;
        }
        const target = queue.shift()!;
        queuedModelIds.delete(target.model.id);
        if (completedModelIds.has(target.model.id)) continue;
        console.log(
          `[provider-smoke] ${target.runtimeId} / ${target.model.displayName} / reasoning=${target.reasoningEffort ?? 'provider-default'}`
        );
        const execution = await runTarget(
          service,
          target,
          options.timeoutMs,
          pollIntervalMs,
          cancelTimeoutMs,
          () => stopRequested,
          (_taskId, runId) => {
            activeRunId = runId;
          }
        );
        const result = execution.result;
        if (
          execution.lifecycleSettled &&
          (!result.runStatus || CONTAINED_TERMINAL_STATUSES.has(result.runStatus))
        ) {
          activeRunId = undefined;
        }
        const repositoryState = await inspectRepositoryState(repository);
        result.repositoryClean = repositoryState.clean;
        result.repositoryIdentityUnchanged = repositoryState.identityUnchanged;
        if (!repositoryState.clean || !repositoryState.identityUnchanged) {
          result.verdict = 'FAILED';
          result.error = joinErrors(
            result.error,
            repositoryState.error ??
              'The original throwaway repository changed; remaining models were not started.'
          );
          stopRequested = true;
        }
        if (!execution.lifecycleSettled) {
          result.verdict = 'FAILED';
          result.error = joinErrors(
            result.error,
            'The provider lifecycle did not settle into a safely contained terminal state; remaining models were not started.'
          );
          appendUnique(errors, result.error);
          stopRequested = true;
        }
        if (result.runStatus && !TERMINAL_STATUSES.has(result.runStatus)) {
          result.error = joinErrors(
            result.error,
            'The run remained active after cancellation; remaining models were not started.'
          );
          result.verdict = 'FAILED';
          stopRequested = true;
        }
        results.push(result);
        completedModelIds.add(target.model.id);
        if (stopRequested) break;

        catalog = await service.getAgentRuntimeCatalog();
        rememberCatalog(catalog, discoveredRuntimes, discoveredModels);
        enqueueTargets(
          catalog,
          options,
          completedModelIds,
          queuedModelIds,
          eligibleModelIds,
          queue
        );
      }
      if (results.length === 0 && !stopRequested) {
        appendUnique(
          errors,
          'No startable runtime has a visible model matching the selection.'
        );
        stopRequested = true;
      }
    } catch (error) {
      appendUnique(errors, `Provider smoke stopped: ${errorMessage(error)}`);
      stopRequested = true;
    }
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (activeRunId) {
      await within(
        service.cancelRun({ runId: activeRunId }).catch(() => undefined),
        cancelTimeoutMs
      );
    }
    const shutdown = await within(service.shutdown(), cancelTimeoutMs);
    if (!shutdown.settled) {
      appendUnique(errors, 'Runtime shutdown did not settle before its safety deadline.');
      stopRequested = true;
    } else if (shutdown.error) {
      appendUnique(errors, `Runtime shutdown failed: ${errorMessage(shutdown.error)}`);
      stopRequested = true;
    }
  }
  const repositoryState = await inspectRepositoryState(repository);
  if (repositoryState.error) appendUnique(errors, repositoryState.error);
  if (!repositoryState.clean || !repositoryState.identityUnchanged) stopRequested = true;
  const resultByModel = new Map(results.map((result) => [result.modelId, result]));
  const selection = buildSelectionAudit({
    options,
    runtimes: discoveredRuntimes,
    models: discoveredModels,
    eligibleModelIds,
    results
  });
  const completionStatus = stopRequested || errors.length > 0
    ? 'STOPPED_EARLY'
    : 'COMPLETED';
  const selectionIncomplete = [
    selection.unmatchedRuntimeIds,
    selection.unmatchedModelIds,
    selection.unavailableRuntimeIds,
    selection.unavailableModelIds,
    selection.notExecutedModelIds
  ].some((values) => values.length > 0);
  const authoritative =
    completionStatus === 'COMPLETED' &&
    errors.length === 0 &&
    results.length > 0 &&
    results.every((result) => result.verdict === 'PASSED') &&
    !selectionIncomplete &&
    repositoryState.clean &&
    repositoryState.identityUnchanged;
  const report: ProviderSmokeReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    completionStatus,
    authoritative,
    errors,
    repositoryPath,
    repositoryClean: repositoryState.clean,
    repositoryIdentityUnchanged: repositoryState.identityUnchanged,
    expectedRepositoryHead: repository.head,
    actualRepositoryHead: repositoryState.head,
    expectedRepositoryRef: repository.ref,
    actualRepositoryRef: repositoryState.ref,
    stateRoot,
    startedAt,
    completedAt: new Date().toISOString(),
    runtimes: [...discoveredRuntimes.values()].sort((left, right) =>
      left.preflight.runtime.id.localeCompare(right.preflight.runtime.id)
    ).map((runtime) => {
      const runtimeId = runtime.preflight.runtime.id;
      const models = [...discoveredModels.values()].filter(
        (model) => model.runtimeId === runtimeId
      ).sort((left, right) => left.id.localeCompare(right.id));
      return {
        runtimeId,
        displayName: runtime.preflight.runtime.displayName,
        status: runtime.preflight.readiness.status,
        canStart: runtime.preflight.readiness.canStart,
        visibleModelCount: models.filter((model) => !model.hidden).length,
        summary: runtime.preflight.readiness.summary,
        skipReason: runtimeSkipReason(runtime, models, options),
        models: models.map((model) =>
          modelAudit(model, runtime, options, resultByModel, stopRequested)
        )
      };
    }),
    results,
    selection
  };
  const reportPath = path.join(stateRoot, 'report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  console.log(`[provider-smoke] Report: ${reportPath}`);
  return report;
}

async function activateSelectedModelCatalogs(
  service: ProviderSmokeService,
  catalog: AgentRuntimeCatalog,
  options: Pick<ProviderSmokeOptions, 'runtimeIds' | 'modelIds'>
): Promise<boolean> {
  const selectedRuntimeIds = new Set(options.runtimeIds);
  const selectedModelRuntimeIds = new Set(
    options.modelIds.map((modelId) => modelId.split(':', 1)[0]!)
  );
  const runtimes = catalog.runtimes.filter(({ preflight }) => {
    const runtimeId = preflight.runtime.id;
    if (
      !preflight.readiness.canStart ||
      preflight.capabilities.modelCatalog.activation !== 'EXPLICIT'
    ) {
      return false;
    }
    if (selectedRuntimeIds.size > 0) return selectedRuntimeIds.has(runtimeId);
    return selectedModelRuntimeIds.size === 0 || selectedModelRuntimeIds.has(runtimeId);
  });
  for (const runtime of runtimes) {
    await service.discoverAgentRuntimeModels(runtime.preflight.runtime.id);
  }
  return runtimes.length > 0;
}

async function runTarget(
  service: ProviderSmokeService,
  target: ProviderSmokeTarget,
  timeoutMs: number,
  pollIntervalMs: number,
  cancelTimeoutMs: number,
  isStopping: () => boolean,
  setActiveRun: (taskId: string | undefined, runId: string | undefined) => void
): Promise<{ result: ProviderSmokeResult; lifecycleSettled: boolean }> {
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  let taskId: string | undefined;
  let runId: string | undefined;
  let snapshot: TaskSnapshot | undefined;
  let gitSnapshot: GitSnapshotRecord | undefined;
  let timedOut = false;
  let unexpectedInteraction = false;
  let failure: string | undefined;
  let lifecycleSettled = false;
  let cancellationSafe = true;
  let cancellationApplied = false;
  let cancellationPhase:
    | {
        deadline: number;
        result: Promise<CancelTaskRunResult>;
      }
    | undefined;
  const ensureCancellation = () => {
    if (!cancellationPhase) {
      const cancellationDeadline = Date.now() + cancelTimeoutMs;
      cancellationPhase = {
        deadline: cancellationDeadline,
        result: cancelTaskRunBestEffort({
          service,
          taskId,
          runId,
          deadline: cancellationDeadline,
          pollIntervalMs
        })
      };
    }
    return cancellationPhase;
  };
  const applyCancellation = (canceled: CancelTaskRunResult) => {
    snapshot = canceled.snapshot ?? snapshot;
    runId = canceled.runId ?? runId;
    setActiveRun(taskId, runId);
    cancellationSafe &&= canceled.safe;
    if (cancellationApplied) return;
    cancellationApplied = true;
    if (canceled.error) failure = joinErrors(failure, canceled.error);
    if (!canceled.safe) {
      failure = joinErrors(
        failure,
        'Cancellation did not settle and reach a terminal run state before its safety deadline.'
      );
    }
  };

  const lifecycle = (async () => {
    try {
      const task = await service.createTask({
        title: `Provider smoke: ${target.runtimeId} / ${target.model.displayName}`,
        prompt:
          `This is a provider connectivity smoke test. Do not inspect the repository, call tools, execute commands, or modify files. Reply with exactly: ${SMOKE_SENTINEL}`,
        repositoryPath: service.getDefaultRepositoryPath(),
        runtimeId: target.runtimeId,
        agentSettings: {
          runtimeId: target.runtimeId,
          model: target.model.model,
          modelProvider: target.model.modelProvider,
          reasoningEffort: target.reasoningEffort
        }
      });
      taskId = task.id;
      setActiveRun(taskId, undefined);
      if (isStopping()) return;
      if (Date.now() >= deadline) {
        timedOut = true;
        return;
      }
      const started = await service.startRun({ taskId, mode: 'IMPLEMENTATION' });
      runId = started.id;
      setActiveRun(taskId, runId);
      const terminal = await waitForTerminalRun(
        service,
        runId,
        deadline,
        pollIntervalMs,
        isStopping,
        (value) => {
          snapshot = value;
        }
      );
      timedOut ||= terminal.timedOut;
      unexpectedInteraction ||= terminal.unexpectedInteraction;
      if (terminal.timedOut || terminal.unexpectedInteraction || terminal.interrupted) {
        applyCancellation(await ensureCancellation().result);
        if (!cancellationSafe) return;
      }
      snapshot ??= await service.listTasks();
      try {
        gitSnapshot = await service.refreshEvidence({ taskId });
        snapshot = await service.listTasks();
      } catch (error) {
        failure = joinErrors(
          failure,
          `Post-run Git evidence failed: ${errorMessage(error)}`
        );
      }
    } catch (error) {
      failure = joinErrors(failure, errorMessage(error));
    } finally {
      lifecycleSettled = true;
    }
  })();

  const boundary = await waitForLifecycleBoundary(
    lifecycle,
    Math.max(0, deadline - Date.now()),
    pollIntervalMs,
    isStopping
  );
  if (boundary !== 'SETTLED') {
    timedOut ||= boundary === 'TIMED_OUT';
    const cancellation = ensureCancellation();
    applyCancellation(await cancellation.result);
    const settled = await within(
      lifecycle,
      Math.max(0, cancellation.deadline - Date.now())
    );
    lifecycleSettled ||= settled.settled;
    if (!lifecycleSettled) {
      failure = joinErrors(
        failure,
        'The provider lifecycle did not settle before the cancellation deadline.'
      );
    }
  }

  if (!snapshot) {
    const finalSnapshot = await within(service.listTasks(), cancelTimeoutMs);
    if (finalSnapshot.settled && !finalSnapshot.error) snapshot = finalSnapshot.value;
  }
  const run = runId
    ? snapshot?.runs.find((candidate) => candidate.id === runId)
    : taskId
      ? latestTaskRun(snapshot, taskId)
      : undefined;
  if (
    run &&
    TERMINAL_STATUSES.has(run.status) &&
    !CONTAINED_TERMINAL_STATUSES.has(run.status)
  ) {
    failure = joinErrors(failure, uncontainedRunReason(run.status));
  }
  const runContained = run
    ? CONTAINED_TERMINAL_STATUSES.has(run.status)
    : !runId;
  const safeToRelease = lifecycleSettled && cancellationSafe && runContained;
  setActiveRun(safeToRelease ? undefined : taskId, safeToRelease ? undefined : runId);
  return {
    lifecycleSettled: safeToRelease,
    result: evaluateResult({
      target,
      startedAt,
      taskId,
      run,
      snapshot,
      gitSnapshot,
      interrupted: isStopping() || boundary === 'INTERRUPTED',
      errors: [
        failure,
        timedOut
          ? `Target lifecycle exceeded the ${Math.round(timeoutMs / 1_000)}-second timeout.`
          : undefined,
        unexpectedInteraction
          ? 'The provider requested an interaction; Task Monki canceled without approving it.'
          : undefined
      ]
    })
  };
}

async function waitForTerminalRun(
  service: ProviderSmokeService,
  runId: string,
  deadline: number,
  pollIntervalMs: number,
  isStopping: () => boolean,
  rememberSnapshot: (snapshot: TaskSnapshot) => void
): Promise<{
  timedOut: boolean;
  unexpectedInteraction: boolean;
  interrupted: boolean;
}> {
  while (Date.now() < deadline) {
    const snapshot = await service.listTasks();
    rememberSnapshot(snapshot);
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Smoke run ${runId} disappeared from the task store.`);
    if (snapshot.interactionRequests.some((request) => request.runId === runId)) {
      return { timedOut: false, unexpectedInteraction: true, interrupted: false };
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      return { timedOut: false, unexpectedInteraction: false, interrupted: false };
    }
    if (isStopping()) {
      return { timedOut: false, unexpectedInteraction: false, interrupted: true };
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  return { timedOut: true, unexpectedInteraction: false, interrupted: false };
}

function evaluateResult(input: {
  target: ProviderSmokeTarget;
  startedAt: string;
  taskId?: string;
  run?: RunRecord;
  snapshot?: TaskSnapshot;
  gitSnapshot?: GitSnapshotRecord;
  interrupted: boolean;
  errors: Array<string | undefined>;
}): ProviderSmokeResult {
  const { target, run, snapshot } = input;
  const receivedSentinel = run?.finalMessage?.trim() === SMOKE_SENTINEL;
  const interactionRequested = Boolean(
    run && snapshot?.interactionRequests.some((request) => request.runId === run.id)
  );
  const selection = selectionAttestation(target, run, snapshot);
  const worktreeMatchesBase = Boolean(
    input.gitSnapshot?.headSha &&
      input.gitSnapshot.baseSha &&
      input.gitSnapshot.headSha === input.gitSnapshot.baseSha &&
      input.gitSnapshot.commitsAheadOfBase === 0 &&
      input.gitSnapshot.committedDiffFileCount === 0
  );
  const baseErrors = [
    ...input.errors,
    !run ? 'Task Monki did not create a provider run.' : undefined,
    run && run.status !== 'COMPLETED'
      ? run.terminalReason ?? `Run ended with ${run.status}.`
      : undefined,
    run?.status === 'COMPLETED' && !receivedSentinel
      ? `The provider did not return ${SMOKE_SENTINEL}.`
      : undefined,
    interactionRequested
      ? 'The provider created an interaction request during the no-tool smoke prompt.'
      : undefined,
    !input.gitSnapshot ? 'Task Monki did not capture exact post-run Git evidence.' : undefined,
    input.gitSnapshot && input.gitSnapshot.status !== 'CLEAN'
      ? `The no-edit worktree ended with Git status ${input.gitSnapshot.status}.`
      : undefined,
    input.gitSnapshot && !worktreeMatchesBase
      ? `The no-edit worktree no longer matches its base commit (base=${input.gitSnapshot.baseSha ?? 'missing'}, head=${input.gitSnapshot.headSha ?? 'missing'}, commitsAhead=${input.gitSnapshot.commitsAheadOfBase}, committedFiles=${input.gitSnapshot.committedDiffFileCount}).`
      : undefined,
    selection.attestation === 'OBSERVED_MISMATCH'
      ? `The observed selection ${formatObservedSelection(selection)} did not match ${formatTargetSelection(target)}.`
      : undefined
  ].filter((value): value is string => Boolean(value));
  const basePassed =
    run?.status === 'COMPLETED' &&
    receivedSentinel &&
    input.gitSnapshot?.status === 'CLEAN' &&
    worktreeMatchesBase &&
    !interactionRequested &&
    baseErrors.length === 0;
  const unattested = selection.attestation === 'REQUESTED_ONLY';
  const errors = [
    ...baseErrors,
    unattested
      ? `No provider observation or exact adapter resolution attested ${formatTargetSelection(target)}.`
      : undefined
  ].filter((value): value is string => Boolean(value));
  const verdict = input.interrupted
    ? 'INTERRUPTED'
    : basePassed && unattested
      ? 'UNATTESTED'
      : basePassed
        ? 'PASSED'
        : 'FAILED';
  return {
    runtimeId: target.runtimeId,
    runtimeStatus: target.runtimeStatus,
    modelId: target.model.id,
    modelProvider: target.model.modelProvider,
    model: target.model.model,
    displayName: target.model.displayName,
    reasoningEffort: target.reasoningEffort,
    verdict,
    taskId: input.taskId,
    runId: run?.id,
    runStatus: run?.status,
    gitStatus: input.gitSnapshot?.status,
    gitSnapshotId: input.gitSnapshot?.id,
    repositoryClean: true,
    repositoryIdentityUnchanged: true,
    receivedSentinel,
    selectionAttestation: selection.attestation,
    observedModel: selection.observedModel,
    observedModelProvider: selection.observedModelProvider,
    observedReasoningEffort: selection.observedReasoningEffort,
    observationSource: selection.observationSource,
    error: errors.length > 0 ? [...new Set(errors)].join(' ') : undefined,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString()
  };
}

function selectionAttestation(
  target: ProviderSmokeTarget,
  run: RunRecord | undefined,
  snapshot: TaskSnapshot | undefined
): {
  attestation: ProviderSmokeResult['selectionAttestation'];
  observedModel?: string;
  observedModelProvider?: string;
  observedReasoningEffort?: string;
  observationSource?: string;
} {
  if (!run || !snapshot) return { attestation: 'REQUESTED_ONLY' };
  const observations = snapshot.agentSettingsObservations
    .filter(
      (candidate) =>
        candidate.sessionId === run.sessionId &&
        (candidate.runId === run.id ||
          (!candidate.runId && candidate.observedAt >= run.startedAt))
    )
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const providerObservation = observations.find((candidate) =>
    PROVIDER_DERIVED_OBSERVATION_SOURCES.has(candidate.source)
  );
  const acknowledgedConfigurationResolution = observations.find(
    (candidate) =>
      candidate.source === 'TASK_MONKI_RESOLUTION' &&
      observationMatchesTarget(target, candidate.settings) &&
      providerObservation?.source === 'THREAD_START_RESPONSE' &&
      !observationMatchesTarget(target, providerObservation.settings) &&
      responseFollowsObservation(candidate.rawMessage, providerObservation.rawMessage)
  );
  const observation =
    acknowledgedConfigurationResolution ??
    providerObservation ??
    observations.find((candidate) => candidate.source === 'TASK_MONKI_RESOLUTION');
  if (!observation) return { attestation: 'REQUESTED_ONLY' };
  const observedModel = observation.settings.model;
  const observedModelProvider = observation.settings.modelProvider;
  const observedReasoningEffort = observation.settings.reasoningEffort;
  const details = {
    observedModel,
    observedModelProvider,
    observedReasoningEffort,
    observationSource: String(observation.source)
  };
  if (!observedModel) {
    return { attestation: 'REQUESTED_ONLY', ...details };
  }
  if (
    !observedModelProvider &&
    (target.model.modelProvider !== undefined ||
      PROVIDER_DERIVED_OBSERVATION_SOURCES.has(observation.source))
  ) {
    return { attestation: 'REQUESTED_ONLY', ...details };
  }
  const modelMatches =
    target.model.model === 'default' || observedModel === target.model.model;
  const providerMatches =
    target.model.modelProvider === undefined ||
    observedModelProvider === target.model.modelProvider;
  if (!modelMatches || !providerMatches) {
    return { attestation: 'OBSERVED_MISMATCH', ...details };
  }
  if (target.reasoningEffort) {
    if (!observedReasoningEffort) {
      return { attestation: 'REQUESTED_ONLY', ...details };
    }
    if (observedReasoningEffort !== target.reasoningEffort) {
      return { attestation: 'OBSERVED_MISMATCH', ...details };
    }
  }
  if (observation.source === 'TASK_MONKI_RESOLUTION') {
    return { attestation: 'ADAPTER_RESOLVED', ...details };
  }
  if (!PROVIDER_DERIVED_OBSERVATION_SOURCES.has(observation.source)) {
    return { attestation: 'REQUESTED_ONLY', ...details };
  }
  return {
    attestation:
      target.model.model === 'default'
        ? 'PROVIDER_DEFAULT_CONFIRMED'
        : 'PROVIDER_CONFIRMED',
    ...details
  };
}

function observationMatchesTarget(
  target: ProviderSmokeTarget,
  settings: TaskSnapshot['agentSettingsObservations'][number]['settings']
): boolean {
  if (!settings.model) return false;
  if (target.model.model !== 'default' && settings.model !== target.model.model) {
    return false;
  }
  if (
    target.model.modelProvider !== undefined &&
    settings.modelProvider !== target.model.modelProvider
  ) return false;
  return !target.reasoningEffort || settings.reasoningEffort === target.reasoningEffort;
}

function responseFollowsObservation(
  response: TaskSnapshot['agentSettingsObservations'][number]['rawMessage'],
  observation: TaskSnapshot['agentSettingsObservations'][number]['rawMessage']
): boolean {
  return Boolean(
    response?.direction === 'INBOUND' &&
      observation?.direction === 'INBOUND' &&
      response.serverInstanceId === observation.serverInstanceId &&
      response.sequence > observation.sequence
  );
}

async function requireThrowawayRepository(
  repositoryPath: string
): Promise<RepositoryBaseline> {
  const canonical = await fs.realpath(path.resolve(repositoryPath)).catch(() => undefined);
  if (!canonical) throw new Error(`Throwaway repository does not exist: ${repositoryPath}`);
  const root = await fs.realpath((await git(canonical, ['rev-parse', '--show-toplevel'])).trim());
  if (root !== canonical) {
    throw new Error(`--repository must name the Git worktree root exactly: ${root}`);
  }
  const head = (await git(canonical, ['rev-parse', '--verify', 'HEAD'])).trim();
  const ref = await repositoryRef(canonical);
  if ((await git(canonical, ['remote'])).trim()) {
    throw new Error(
      'Provider smoke repositories must not have remotes. Use a fresh local throwaway repository, not a clone or seeded repository.'
    );
  }
  if (!(await repositoryIsClean(canonical))) {
    throw new Error('Commit the throwaway fixture before running provider smoke tests.');
  }
  return { path: canonical, head, ref };
}

async function createStateRoot(
  configuredRoot: string | undefined,
  repositoryPath: string
): Promise<string> {
  const root = configuredRoot
    ? path.resolve(configuredRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-provider-smoke-'));
  if (configuredRoot) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if ((await fs.readdir(root)).length > 0) throw new Error(`--state-root must be empty: ${root}`);
  }
  const canonical = await fs.realpath(root);
  if (pathIsInside(repositoryPath, canonical)) {
    throw new Error('--state-root must be outside the throwaway Git repository.');
  }
  await fs.chmod(canonical, 0o700);
  return canonical;
}

async function repositoryIsClean(repositoryPath: string): Promise<boolean> {
  return !(
    await git(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all'])
  ).trim();
}

async function inspectRepositoryState(
  baseline: RepositoryBaseline
): Promise<RepositoryState> {
  try {
    const [clean, head, ref] = await Promise.all([
      repositoryIsClean(baseline.path),
      git(baseline.path, ['rev-parse', '--verify', 'HEAD']).then((value) => value.trim()),
      repositoryRef(baseline.path)
    ]);
    const identityUnchanged = head === baseline.head && ref === baseline.ref;
    return {
      clean,
      identityUnchanged,
      head,
      ref,
      error:
        clean && identityUnchanged
          ? undefined
          : `The original throwaway repository changed (clean=${String(clean)}, head=${head}, ref=${ref ?? 'detached'}); remaining models were not started.`
    };
  } catch (error) {
    return {
      clean: false,
      identityUnchanged: false,
      error: `The original throwaway repository could not be verified: ${errorMessage(error)}`
    };
  }
}

async function repositoryRef(repositoryPath: string): Promise<string | undefined> {
  return git(repositoryPath, ['symbolic-ref', '--quiet', 'HEAD'])
    .then((value) => value.trim() || undefined)
    .catch(() => undefined);
}

function enqueueTargets(
  catalog: AgentRuntimeCatalog,
  options: ProviderSmokeOptions,
  completed: ReadonlySet<string>,
  queued: Set<string>,
  eligible: Set<string>,
  queue: ProviderSmokeTarget[]
): void {
  for (const target of discoverProviderSmokeTargets(catalog, options, completed)) {
    eligible.add(target.model.id);
    if (queued.has(target.model.id)) continue;
    queued.add(target.model.id);
    queue.push(target);
  }
  queue.sort(
    (left, right) =>
      left.runtimeId.localeCompare(right.runtimeId) || left.model.id.localeCompare(right.model.id)
  );
}

function rememberCatalog(
  catalog: AgentRuntimeCatalog,
  runtimes: Map<string, AgentRuntimeState>,
  models: Map<string, AgentModel>
): void {
  for (const runtime of catalog.runtimes) {
    runtimes.set(runtime.preflight.runtime.id, runtime);
  }
  for (const model of catalog.models) models.set(model.id, model);
}

function runtimeSkipReason(
  runtime: AgentRuntimeState,
  models: readonly AgentModel[],
  options: ProviderSmokeOptions
): string | undefined {
  if (!runtime.preflight.readiness.canStart) return runtime.preflight.readiness.detail;
  if (options.runtimeIds.length && !options.runtimeIds.includes(runtime.preflight.runtime.id)) {
    return 'Excluded by the --runtime filter.';
  }
  const visible = models.filter((model) => !model.hidden);
  if (!visible.length) return 'The runtime reported no visible models.';
  if (options.modelIds.length && !visible.some((model) => options.modelIds.includes(model.id))) {
    return 'No visible model matched the --model filter.';
  }
  return undefined;
}

function modelAudit(
  model: AgentModel,
  runtime: AgentRuntimeState,
  options: ProviderSmokeOptions,
  results: ReadonlyMap<string, ProviderSmokeResult>,
  stoppedEarly: boolean
): ProviderSmokeReport['runtimes'][number]['models'][number] {
  const result = results.get(model.id);
  if (result) {
    return {
      modelId: model.id,
      displayName: model.displayName,
      hidden: model.hidden,
      outcome: result.verdict,
      reason: result.error
    };
  }
  let reason: string;
  if (model.hidden) reason = 'Hidden by the runtime catalog.';
  else if (!runtime.preflight.readiness.canStart) reason = runtime.preflight.readiness.detail;
  else if (options.runtimeIds.length && !options.runtimeIds.includes(model.runtimeId)) {
    reason = 'Excluded by the --runtime filter.';
  } else if (options.modelIds.length && !options.modelIds.includes(model.id)) {
    reason = 'Excluded by the --model filter.';
  } else {
    reason = stoppedEarly
      ? 'Not reached because the smoke pass stopped early.'
      : 'The model was discovered but did not become eligible for execution.';
  }
  return {
    modelId: model.id,
    displayName: model.displayName,
    hidden: model.hidden,
    outcome:
      stoppedEarly &&
      !model.hidden &&
      runtime.preflight.readiness.canStart &&
      (!options.runtimeIds.length || options.runtimeIds.includes(model.runtimeId)) &&
      (!options.modelIds.length || options.modelIds.includes(model.id))
        ? 'NOT_REACHED'
        : 'SKIPPED',
    reason
  };
}

function buildSelectionAudit(input: {
  options: ProviderSmokeOptions;
  runtimes: ReadonlyMap<string, AgentRuntimeState>;
  models: ReadonlyMap<string, AgentModel>;
  eligibleModelIds: ReadonlySet<string>;
  results: readonly ProviderSmokeResult[];
}): ProviderSmokeReport['selection'] {
  const executedModelIds = new Set(input.results.map((result) => result.modelId));
  const unmatchedRuntimeIds = input.options.runtimeIds.filter(
    (runtimeId) => !input.runtimes.has(runtimeId)
  );
  const unmatchedModelIds = input.options.modelIds.filter(
    (modelId) => !input.models.has(modelId)
  );
  const unavailableRuntimeIds = input.options.runtimeIds.filter((runtimeId) => {
    const runtime = input.runtimes.get(runtimeId);
    return Boolean(runtime && !runtime.preflight.readiness.canStart);
  });
  const unavailableModelIds = input.options.modelIds.filter((modelId) => {
    const model = input.models.get(modelId);
    return Boolean(
      model &&
        !executedModelIds.has(modelId) &&
        (!input.runtimes.get(model.runtimeId)?.preflight.readiness.canStart || model.hidden)
    );
  });
  return {
    requestedRuntimeIds: [...input.options.runtimeIds],
    requestedModelIds: [...input.options.modelIds],
    eligibleModelIds: [...input.eligibleModelIds].sort(),
    executedModelIds: [...executedModelIds].sort(),
    unmatchedRuntimeIds,
    unmatchedModelIds,
    unavailableRuntimeIds,
    unavailableModelIds,
    notExecutedModelIds: [...input.eligibleModelIds]
      .filter((modelId) => !executedModelIds.has(modelId))
      .sort()
  };
}

function latestTaskRun(
  snapshot: TaskSnapshot | undefined,
  taskId: string
): RunRecord | undefined {
  return snapshot?.runs
    .filter((run) => run.taskId === taskId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

async function cancelTaskRunBestEffort(input: {
  service: ProviderSmokeService;
  taskId?: string;
  runId?: string;
  deadline: number;
  pollIntervalMs: number;
}): Promise<CancelTaskRunResult> {
  let snapshot: TaskSnapshot | undefined;
  let runId = input.runId;
  let cancellationStarted = false;
  let cancellationSettled = false;
  let error: string | undefined;

  while (Date.now() < input.deadline) {
    const observed = await within(
      input.service.listTasks(),
      Math.max(0, input.deadline - Date.now())
    );
    if (!observed.settled) break;
    if (observed.error) {
      error = joinErrors(
        error,
        `Cancellation reconciliation failed: ${errorMessage(observed.error)}`
      );
    } else if (observed.value) {
      snapshot = observed.value;
    }
    const run = runId
      ? snapshot?.runs.find((candidate) => candidate.id === runId)
      : input.taskId
        ? latestTaskRun(snapshot, input.taskId)
        : undefined;
    if (run) runId = run.id;
    const terminal = Boolean(run && TERMINAL_STATUSES.has(run.status));
    const contained = Boolean(
      run && CONTAINED_TERMINAL_STATUSES.has(run.status)
    );
    if (run && terminal && !contained) {
      return {
        snapshot,
        runId,
        safe: false,
        error: joinErrors(error, uncontainedRunReason(run.status))
      };
    }
    if (contained && (!cancellationStarted || cancellationSettled)) {
      return { snapshot, runId, safe: true, error };
    }
    if (run && !terminal && !cancellationStarted) {
      cancellationStarted = true;
      void Promise.resolve().then(() => input.service.cancelRun({ runId: run.id })).then(
        () => {
          cancellationSettled = true;
        },
        (cause) => {
          cancellationSettled = true;
          error = joinErrors(
            error,
            `Cancellation request failed: ${errorMessage(cause)}`
          );
        }
      );
    }
    const remaining = Math.max(0, input.deadline - Date.now());
    if (remaining === 0) break;
    await delay(Math.min(input.pollIntervalMs, remaining));
  }

  const run = runId
    ? snapshot?.runs.find((candidate) => candidate.id === runId)
    : input.taskId
      ? latestTaskRun(snapshot, input.taskId)
      : undefined;
  return {
    snapshot,
    runId: run?.id ?? runId,
    safe:
      Boolean(run && CONTAINED_TERMINAL_STATUSES.has(run.status)) &&
      (!cancellationStarted || cancellationSettled),
    error:
      run && TERMINAL_STATUSES.has(run.status) &&
        !CONTAINED_TERMINAL_STATUSES.has(run.status)
        ? joinErrors(error, uncontainedRunReason(run.status))
        : error
  };
}

function uncontainedRunReason(status: AgentRunStatus): string {
  return `Run reached ${status}, which does not prove that provider execution is contained.`;
}

interface CancelTaskRunResult {
  snapshot?: TaskSnapshot;
  runId?: string;
  safe: boolean;
  error?: string;
}

function waitForLifecycleBoundary(
  lifecycle: Promise<void>,
  timeoutMs: number,
  pollIntervalMs: number,
  isStopping: () => boolean
): Promise<'SETTLED' | 'TIMED_OUT' | 'INTERRUPTED'> {
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let interval: NodeJS.Timeout | undefined;
    const finish = (result: 'SETTLED' | 'TIMED_OUT' | 'INTERRUPTED') => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      resolve(result);
    };
    lifecycle.then(
      () => finish('SETTLED'),
      () => finish('SETTLED')
    );
    timer = setTimeout(() => finish('TIMED_OUT'), timeoutMs);
    interval = setInterval(() => {
      if (isStopping()) finish('INTERRUPTED');
    }, Math.max(1, Math.min(pollIntervalMs, timeoutMs || pollIntervalMs)));
  });
}

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<{ settled: boolean; value?: T; error?: unknown }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: { settled: boolean; value?: T; error?: unknown }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ settled: false }), Math.max(0, timeoutMs));
    operation.then(
      (value) => finish({ settled: true, value }),
      (error) => finish({ settled: true, error })
    );
  });
}

function formatTargetSelection(target: ProviderSmokeTarget): string {
  return `${target.model.modelProvider ?? 'provider-default'}/${target.model.model}${
    target.reasoningEffort ? ` at reasoning ${target.reasoningEffort}` : ''
  }`;
}

function formatObservedSelection(input: {
  observedModel?: string;
  observedModelProvider?: string;
  observedReasoningEffort?: string;
}): string {
  return `${input.observedModelProvider ?? 'unknown'}/${input.observedModel ?? 'unknown'}${
    input.observedReasoningEffort ? ` at reasoning ${input.observedReasoningEffort}` : ''
  }`;
}

function reasoningRank(value: string): number | undefined {
  return {
    none: 0,
    off: 0,
    disabled: 0,
    minimal: 1,
    min: 1,
    low: 2,
    medium: 3,
    med: 3,
    high: 4,
    xhigh: 5,
    max: 5,
    maximum: 5
  }[value.trim().toLowerCase().replace(/[\s_-]+/gu, '')];
}

function uniqueValues(values: readonly string[], option: string): string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) throw new Error(`${option} values must not be empty.`);
  return [...new Set(normalized)];
}

function argumentValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function joinErrors(...values: Array<string | undefined>): string | undefined {
  const errors = values.filter((value): value is string => Boolean(value));
  return errors.length ? errors.join(' ') : undefined;
}

function appendUnique(values: string[], value: string | undefined): void {
  if (value && !values.includes(value)) values.push(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function usage(): string {
  return `Usage:
  npm run smoke:providers -- \\
    --repository /absolute/path/to/throwaway-repository \\
    --confirm-throwaway \\
    --confirm-provider-usage

Optional repeatable filters: --runtime <runtime-id>, --model <qualified-model-id>
Other options: --timeout-seconds <10-3600>, --state-root <empty-path>, --help

The repository must be a clean Git root with a commit and no remotes. Runs are
sequential, interactions are never approved, and report.json retains the result.`;
}

async function main(): Promise<void> {
  const options = parseProviderSmokeArguments(process.argv.slice(2));
  if (options.help) return console.log(usage());
  const report = await runProviderSmoke(options);
  const passed = report.results.filter((result) => result.verdict === 'PASSED').length;
  console.log(`[provider-smoke] ${passed}/${report.results.length} models passed.`);
  if (!providerSmokeSucceeded(report)) process.exitCode = 1;
}

export function providerSmokeSucceeded(report: ProviderSmokeReport): boolean {
  return report.authoritative;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`[provider-smoke] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
