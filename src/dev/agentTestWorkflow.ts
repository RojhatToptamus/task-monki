import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { AcpRuntimeAdapter } from '../core/agent/acp/AcpRuntimeAdapter';
import type { AcpRuntimeProfile } from '../core/agent/acp/AcpRuntimeProfiles';
import { git } from '../core/git/gitCli';
import {
  spawnPortable,
  terminatePortableProcessTree,
  waitForPortableProcessTreeExit
} from '../core/process/portableChildProcess';
import { AppEventBus } from '../core/runner/AppEventBus';
import { MemoryAppSettingsStore } from '../core/settings/AppSettingsStore';
import { FileAgentRuntimeStore } from '../core/storage/FileAgentRuntimeStore';
import { FileDiscourseStore } from '../core/storage/FileDiscourseStore';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import type {
  AgentItemRecord,
  AgentRunStatus,
  GitSnapshotRecord,
  RunRecord,
  Task,
  TaskSnapshot,
  WorktreeRecord
} from '../shared/contracts';
import {
  createDevApiTokenLease,
  devApiExpectedHost,
  devRendererOrigin,
  type DevApiTokenLease
} from './devApiSecurity';
import { createDevHttpServer, type DevHttpServer } from './devHttpServer';

const REPORT_SCHEMA_VERSION = 'task-monki/agent-test-workflow@v1' as const;
const RUNTIME_ID = 'deterministic-acp';
const TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 20;
const MAX_DIAGNOSTIC_TAIL = 8_000;
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TERMINAL_STATUSES = new Set<AgentRunStatus>([
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
  'LOST'
]);

type ScenarioKind = 'complete' | 'fail' | 'cancel';

export interface AgentTestScenarioReport {
  kind: ScenarioKind;
  taskId: string;
  runId: string;
  runStatus: AgentRunStatus;
  workflowPhase: Task['workflowPhase'];
  worktreePath: string;
  providerTurnId?: string;
  providerActivityTypes: string[];
  providerItemTypes: AgentItemRecord['type'][];
  planSteps: string[];
  finalMessage?: string;
  diagnostic?: string;
  git: {
    status: GitSnapshotRecord['status'];
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
    changedPaths: string[];
    expectedChangeObserved: boolean;
  };
}

export interface AgentTestWorkflowReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  verdict: 'PASSED';
  rootDir: string;
  sourceRepository: {
    path: string;
    initialHead: string;
    finalHead: string;
    clean: boolean;
    unchanged: boolean;
    localRemotePath: string;
    localRemoteHead: string;
  };
  runtime: {
    runtimeId: typeof RUNTIME_ID;
    serverCount: number;
    providerStartCount: number;
    processIds: number[];
    processWasObserved: boolean;
    processJoined: boolean;
    protocolMethods: string[];
    providerLogTail: string;
  };
  scenarios: AgentTestScenarioReport[];
  timingsMs: {
    setup: number;
    execution: number;
    cleanup: number;
    total: number;
  };
  cleanup: {
    serviceStopped: boolean;
    uiStopped: boolean;
    rootRemoved: boolean;
  };
}

interface AgentTestEnvironment {
  rootDir: string;
  sourceRepositoryPath: string;
  localRemotePath: string;
  worktreeRoot: string;
  providerLogPath: string;
  initialHead: string;
  store: FileTaskStore;
  service: TaskManagerService;
  repositoryId: string;
}

interface UiHost {
  rendererUrl: string;
  processIds: number[];
  stop(): Promise<void>;
}

interface AgentTestCleanupResult {
  serviceStopped: boolean;
  uiStopped: boolean;
  rootRemoved: boolean;
  processJoined: boolean;
  errors: string[];
}

interface WorkflowCliOptions {
  ui: boolean;
  help: boolean;
}

export async function runAgentTestWorkflow(): Promise<AgentTestWorkflowReport> {
  const totalStartedAt = performance.now();
  const setupStartedAt = performance.now();
  const environment = await createAgentTestEnvironment();
  const setup = elapsed(setupStartedAt);
  let serviceStopped = false;
  let runtimeProcessIds: number[] = [];
  let runtimeReport: Omit<AgentTestWorkflowReport['runtime'], 'processJoined'> | undefined;
  let scenarios: AgentTestScenarioReport[] = [];
  let sourceRepository: AgentTestWorkflowReport['sourceRepository'] | undefined;
  let execution = 0;
  const cleanupStartedAt = { value: 0 };
  let workflowError: Error | undefined;
  let cleanupResult: AgentTestCleanupResult | undefined;

  try {
    const executionStartedAt = performance.now();
    scenarios = await exerciseRepresentativeScenarios(environment);
    const snapshot = await environment.store.snapshot();
    runtimeReport = await collectRuntimeReport(snapshot, environment.providerLogPath);
    runtimeProcessIds = runtimeReport.processIds;
    sourceRepository = await inspectSourceRepository(environment);
    assertWorkflowProof(scenarios, runtimeReport, sourceRepository);
    execution = elapsed(executionStartedAt);
  } catch (cause) {
    const diagnostics = await collectFailureDiagnostics(environment, cause);
    workflowError = new Error(
      `Deterministic agent workflow failed.\n${JSON.stringify(diagnostics, null, 2)}`
    );
  } finally {
    cleanupStartedAt.value = performance.now();
    cleanupResult = await cleanupAgentTestEnvironment(environment, {
      processIds: runtimeProcessIds
    });
    serviceStopped = cleanupResult.serviceStopped;
  }

  const cleanup = elapsed(cleanupStartedAt.value);
  if (!cleanupResult) {
    throw new Error('Agent workflow cleanup did not run.');
  }
  if (!cleanupSucceeded(cleanupResult)) {
    const cleanupError = `Agent workflow cleanup was incomplete: ${JSON.stringify(cleanupResult)}`;
    throw workflowError
      ? new Error(`${workflowError.message}\n${cleanupError}`)
      : new Error(cleanupError);
  }
  if (workflowError) {
    throw workflowError;
  }
  if (!runtimeReport || !sourceRepository) {
    throw new Error('Agent workflow report was not materialized before cleanup.');
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    verdict: 'PASSED',
    rootDir: environment.rootDir,
    sourceRepository,
    runtime: {
      ...runtimeReport,
      processJoined: cleanupResult.processJoined
    },
    scenarios,
    timingsMs: {
      setup,
      execution,
      cleanup,
      total: elapsed(totalStartedAt)
    },
    cleanup: {
      serviceStopped,
      uiStopped: true,
      rootRemoved: cleanupResult.rootRemoved
    }
  };
}

async function runUiWorkflow(): Promise<void> {
  const totalStartedAt = performance.now();
  const setupStartedAt = performance.now();
  const environment = await createAgentTestEnvironment();
  const setup = elapsed(setupStartedAt);
  let ui: UiHost | undefined;
  let processIds: number[] = [];
  let serviceStopped = false;
  let uiStopped = false;
  let workflowError: unknown;
  let cleanupResult: AgentTestCleanupResult | undefined;
  const executionStartedAt = performance.now();

  try {
    const scenarios = await exerciseRepresentativeScenarios(environment);
    const snapshot = await environment.store.snapshot();
    const runtime = await collectRuntimeReport(snapshot, environment.providerLogPath);
    processIds = runtime.processIds;
    const sourceRepository = await inspectSourceRepository(environment);
    assertWorkflowProof(scenarios, runtime, sourceRepository);
    const execution = elapsed(executionStartedAt);
    ui = await startUiHost(environment);

    console.log(`[agent-test] Renderer: ${ui.rendererUrl}`);
    console.log('[agent-test] The environment is inspect-only except for the deterministic local runtime.');
    console.log('[agent-test] Press Ctrl-C to stop and prove cleanup.');
    console.log(
      JSON.stringify(
        {
          schemaVersion: REPORT_SCHEMA_VERSION,
          verdict: 'PASSED',
          rootDir: environment.rootDir,
          rendererUrl: ui.rendererUrl,
          sourceRepository,
          runtime,
          scenarios,
          timingsMs: {
            setup,
            execution,
            uiStartup: elapsed(executionStartedAt) - execution
          },
          cleanup: 'PENDING_SIGNAL'
        },
        null,
        2
      )
    );

    await waitForTerminationSignal();
  } catch (cause) {
    console.error(
      JSON.stringify(await collectFailureDiagnostics(environment, cause), null, 2)
    );
    workflowError = cause;
  } finally {
    const cleanupStartedAt = performance.now();
    cleanupResult = await cleanupAgentTestEnvironment(environment, {
      ui,
      processIds
    });
    serviceStopped = cleanupResult.serviceStopped;
    uiStopped = cleanupResult.uiStopped;
    const cleanup = elapsed(cleanupStartedAt);
    console.log(
      JSON.stringify(
        {
          schemaVersion: REPORT_SCHEMA_VERSION,
          cleanup: {
            serviceStopped,
            uiStopped,
            rootRemoved: cleanupResult.rootRemoved,
            processJoined: cleanupResult.processJoined,
            errors: cleanupResult.errors
          },
          timingsMs: {
            cleanup,
            total: elapsed(totalStartedAt)
          }
        },
        null,
        2
      )
    );
  }
  if (!cleanupResult || !cleanupSucceeded(cleanupResult)) {
    const cleanupError = `Agent workflow UI cleanup was incomplete: ${JSON.stringify(cleanupResult)}`;
    throw workflowError
      ? new Error(`${errorMessage(workflowError)}\n${cleanupError}`)
      : new Error(cleanupError);
  }
  if (workflowError) {
    throw workflowError;
  }
}

async function createAgentTestEnvironment(): Promise<AgentTestEnvironment> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-test-'));
  const sourceRepositoryPath = path.join(rootDir, 'source');
  const localRemotePath = path.join(rootDir, 'remote.git');
  const worktreeRoot = path.join(rootDir, 'worktrees');
  const runtimeRoot = path.join(rootDir, 'runtime');
  const runtimeHome = path.join(runtimeRoot, 'home');
  const temporaryDir = path.join(rootDir, 'tmp');
  const providerScriptPath = path.join(runtimeRoot, 'deterministic-acp.cjs');
  const providerLogPath = path.join(runtimeRoot, 'provider.log');
  let service: TaskManagerService | undefined;

  try {
    await Promise.all([
      fs.mkdir(sourceRepositoryPath, { recursive: true }),
      fs.mkdir(worktreeRoot, { recursive: true }),
      fs.mkdir(runtimeHome, { recursive: true }),
      fs.mkdir(temporaryDir, { recursive: true })
    ]);
    await initializeRepositoryFixture(sourceRepositoryPath, localRemotePath);
    await fs.writeFile(
      providerScriptPath,
      deterministicAcpSource(rootDir, providerLogPath),
      { encoding: 'utf8', mode: 0o600 }
    );

    const store = new FileTaskStore(path.join(rootDir, 'store'));
    const appSettingsStore = new MemoryAppSettingsStore({
      firstLaunchSetupCompleted: true,
      defaultRuntimeId: RUNTIME_ID,
      defaultModel: 'deterministic',
      defaultModelProvider: 'task-monki-test'
    });
    const events = new AppEventBus();
    const profile = deterministicAcpProfile(providerScriptPath);
    const adapter = new AcpRuntimeAdapter(store, events, profile, {
      cwd: rootDir,
      environment: {
        PATH: process.env.PATH,
        HOME: runtimeHome,
        USER: 'task-monki-agent-test',
        LOGNAME: 'task-monki-agent-test',
        TMPDIR: temporaryDir,
        TMP: temporaryDir,
        TEMP: temporaryDir
      },
      requestTimeoutMs: 3_000,
      interruptCompletionTimeoutMs: 3_000,
      runtimeResolver: async () => ({
        executable: process.execPath,
        version: process.version,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'deterministic developer workflow',
          selectedVersion: process.version,
          selectedLaunchArgv: [providerScriptPath],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      })
    });
    service = new TaskManagerService(store, sourceRepositoryPath, events, {
      worktreeRoot,
      appSettingsStore,
      agentRuntimeAdapters: [adapter],
      agentRuntimeStore: new FileAgentRuntimeStore(path.join(rootDir, 'agent-runtime')),
      discourseStore: new FileDiscourseStore(path.join(rootDir, 'discourse')),
      discourseWorkspaceRoot: path.join(rootDir, 'discourse-workspaces'),
      defaultAgentRuntimeId: RUNTIME_ID,
      previewEnabled: false
    });

    await service.init();
    const repository = await service.addRepository(sourceRepositoryPath);
    await appSettingsStore.update({ selectedRepositoryId: repository.id });
    return {
      rootDir,
      sourceRepositoryPath,
      localRemotePath,
      worktreeRoot,
      providerLogPath,
      initialHead: (await git(sourceRepositoryPath, ['rev-parse', 'HEAD'])).trim(),
      store,
      service,
      repositoryId: repository.id
    };
  } catch (cause) {
    const cleanupErrors: unknown[] = [];
    if (service) {
      const initializedService = service;
      await attemptCleanup(() => initializedService.shutdown(), cleanupErrors);
    }
    await attemptCleanup(() => removeOwnedRoot(rootDir), cleanupErrors);
    const rootRemoved = !(await pathExists(rootDir));
    if (cleanupErrors.length > 0 || !rootRemoved) {
      throw new Error(
        `Could not create the agent workflow environment: ${errorMessage(cause)}\n` +
          `Setup cleanup was incomplete: ${JSON.stringify({
            rootRemoved,
            errors: cleanupErrors.map(errorMessage)
          })}`
      );
    }
    throw cause;
  }
}

async function exerciseRepresentativeScenarios(
  environment: AgentTestEnvironment
): Promise<AgentTestScenarioReport[]> {
  const reports: AgentTestScenarioReport[] = [];
  for (const kind of ['complete', 'fail', 'cancel'] as const) {
    const task = await environment.service.createTask({
      title: scenarioTitle(kind),
      prompt: `[agent-test:${kind}] ${scenarioPrompt(kind)}`,
      repositoryId: environment.repositoryId,
      runtimeId: RUNTIME_ID,
      agentSettings: {
        runtimeId: RUNTIME_ID,
        modelProvider: 'task-monki-test',
        model: 'deterministic',
        sandbox: 'DANGER_FULL_ACCESS',
        // ACP has no network-isolation attestation, so its production policy
        // requires this capability flag. The fixed child installs its own
        // network guard before it accepts any protocol input.
        networkAccess: true,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    });
    const worktree = await environment.service.prepareWorktree({ taskId: task.id });
    const started = await environment.service.startRun({ taskId: task.id });
    if (kind === 'cancel') {
      await waitForSnapshot(environment.store, (snapshot) => {
        const run = snapshot.runs.find((candidate) => candidate.id === started.id);
        return run?.status === 'RUNNING' &&
          snapshot.agentPlanRevisions.some((revision) => revision.runId === started.id);
      });
      await environment.service.cancelRun({ runId: started.id });
    }
    const snapshot = await waitForSnapshot(environment.store, (candidate) => {
      const run = candidate.runs.find((record) => record.id === started.id);
      return Boolean(
        run &&
          TERMINAL_STATUSES.has(run.status) &&
          run.afterGitSnapshotId &&
          candidate.tasks.find((record) => record.id === task.id)
      );
    });
    reports.push(
      await buildScenarioReport(kind, task.id, worktree, started.id, snapshot)
    );
  }
  return reports;
}

async function buildScenarioReport(
  kind: ScenarioKind,
  taskId: string,
  worktree: WorktreeRecord,
  runId: string,
  snapshot: TaskSnapshot
): Promise<AgentTestScenarioReport> {
  const task = requireValue(
    snapshot.tasks.find((candidate) => candidate.id === taskId),
    `Task ${taskId} is missing from the scenario snapshot.`
  );
  const run = requireValue(
    snapshot.runs.find((candidate) => candidate.id === runId),
    `Run ${runId} is missing from the scenario snapshot.`
  );
  const gitSnapshot = requireValue(
    snapshot.gitSnapshots.find((candidate) => candidate.id === run.afterGitSnapshotId),
    `Run ${runId} has no final Git snapshot.`
  );
  const items = snapshot.agentItems.filter((item) => item.runId === runId);
  const plan = snapshot.agentPlanRevisions
    .filter((revision) => revision.runId === runId)
    .at(-1);
  const activity = snapshot.events
    .filter((event) => event.runId === runId)
    .map((event) => event.type);
  const changedPaths = await observedGitPaths(worktree.worktreePath);
  const expectedChangeObserved =
    kind === 'complete'
      ? changedPaths.includes('agent-output.txt') && gitSnapshot.untrackedCount === 1
      : changedPaths.length === 0;
  const diagnostic =
    kind === 'fail'
      ? run.finalMessage?.split('\n').find((line) => /token/i.test(line))
      : undefined;

  return {
    kind,
    taskId,
    runId,
    runStatus: run.status,
    workflowPhase: task.workflowPhase,
    worktreePath: worktree.worktreePath,
    providerTurnId: run.providerTurnId,
    providerActivityTypes: [...new Set(activity)].sort(),
    providerItemTypes: [...new Set(items.map((item) => item.type))].sort(),
    planSteps: plan?.steps.map((step) => step.step) ?? [],
    finalMessage: run.finalMessage,
    diagnostic,
    git: {
      status: gitSnapshot.status,
      stagedCount: gitSnapshot.stagedCount,
      unstagedCount: gitSnapshot.unstagedCount,
      untrackedCount: gitSnapshot.untrackedCount,
      changedPaths,
      expectedChangeObserved
    }
  };
}

async function collectRuntimeReport(
  snapshot: TaskSnapshot,
  providerLogPath: string
): Promise<Omit<AgentTestWorkflowReport['runtime'], 'processJoined'>> {
  const providerLog = await fs.readFile(providerLogPath, 'utf8').catch(() => '');
  const processIds = [
    ...new Set([
      ...snapshot.agentServers.flatMap((server) =>
        typeof server.pid === 'number' ? [server.pid] : []
      ),
      ...providerProcessIds(providerLog)
    ])
  ].sort((left, right) => left - right);
  const protocolMethods = [
    ...new Set(
      (
        await Promise.all(
          snapshot.agentServers.map(async (server) => {
            const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
            return journal
              .split('\n')
              .filter(Boolean)
              .flatMap((line): string[] => {
                const envelope = JSON.parse(line) as { raw?: string };
                const message = envelope.raw
                  ? (JSON.parse(envelope.raw) as { method?: unknown })
                  : undefined;
                return typeof message?.method === 'string' ? [message.method] : [];
              });
          })
        )
      ).flat()
    )
  ].sort();
  return {
    runtimeId: RUNTIME_ID,
    serverCount: snapshot.agentServers.length,
    providerStartCount: providerEventCount(providerLog, 'started'),
    processIds,
    processWasObserved: processIds.length > 0,
    protocolMethods,
    providerLogTail: boundedTail(providerLog, MAX_DIAGNOSTIC_TAIL)
  };
}

async function inspectSourceRepository(
  environment: AgentTestEnvironment
): Promise<AgentTestWorkflowReport['sourceRepository']> {
  const finalHead = (await git(environment.sourceRepositoryPath, ['rev-parse', 'HEAD'])).trim();
  const status = await git(environment.sourceRepositoryPath, ['status', '--porcelain']);
  const localRemoteHead = (
    await git(environment.localRemotePath, ['rev-parse', 'refs/heads/main'])
  ).trim();
  return {
    path: environment.sourceRepositoryPath,
    initialHead: environment.initialHead,
    finalHead,
    clean: status.trim() === '',
    unchanged: finalHead === environment.initialHead,
    localRemotePath: environment.localRemotePath,
    localRemoteHead
  };
}

function assertWorkflowProof(
  scenarios: readonly AgentTestScenarioReport[],
  runtime: Omit<AgentTestWorkflowReport['runtime'], 'processJoined'>,
  source: AgentTestWorkflowReport['sourceRepository']
): void {
  const complete = requireScenario(scenarios, 'complete');
  const failed = requireScenario(scenarios, 'fail');
  const canceled = requireScenario(scenarios, 'cancel');
  assert(complete.runStatus === 'COMPLETED', 'Completion scenario did not complete.');
  assert(complete.workflowPhase === 'REVIEW', 'Completion scenario did not advance to review.');
  assert(complete.git.expectedChangeObserved, 'Completion Git change was not independently observed.');
  assert(
    complete.providerItemTypes.includes('FILE_CHANGE') &&
      complete.providerItemTypes.includes('AGENT_MESSAGE'),
    'Completion scenario did not retain structured file and message activity.'
  );
  assert(complete.planSteps.includes('Create deterministic worktree output'), 'Plan activity missing.');
  assert(failed.runStatus === 'FAILED', 'Failure scenario did not fail.');
  assert(failed.workflowPhase === 'IN_PROGRESS', 'Failure scenario left the wrong workflow phase.');
  assert(Boolean(failed.diagnostic), 'Failure scenario did not expose a token-limit diagnostic.');
  assert(failed.git.expectedChangeObserved, 'Failure scenario unexpectedly changed Git state.');
  assert(canceled.runStatus === 'INTERRUPTED', 'Cancellation scenario was not interrupted.');
  assert(
    canceled.workflowPhase === 'IN_PROGRESS',
    'Cancellation scenario left the wrong workflow phase.'
  );
  assert(canceled.git.expectedChangeObserved, 'Cancellation scenario unexpectedly changed Git state.');
  for (const method of ['initialize', 'session/new', 'session/prompt', 'session/cancel']) {
    assert(runtime.protocolMethods.includes(method), `ACP method ${method} was not observed.`);
  }
  assert(runtime.serverCount === 1, 'The workflow did not retain exactly one ACP server.');
  assert(runtime.providerStartCount === 1, 'The ACP provider process restarted unexpectedly.');
  assert(
    runtime.providerLogTail.includes('"event":"network-guard-installed"'),
    'Deterministic ACP network guard was not observed.'
  );
  assert(runtime.processWasObserved, 'No provider child process was observed.');
  assert(source.clean && source.unchanged, 'The source repository was modified.');
  assert(source.localRemoteHead === source.initialHead, 'The local bare remote changed unexpectedly.');
}

async function collectFailureDiagnostics(
  environment: AgentTestEnvironment,
  cause: unknown
): Promise<Record<string, unknown>> {
  const snapshot = await environment.store.snapshot().catch(() => undefined);
  const runtime = snapshot
    ? await collectRuntimeReport(snapshot, environment.providerLogPath).catch(
        (error: unknown) => ({ error: errorMessage(error) })
      )
    : undefined;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    verdict: 'FAILED',
    error: errorMessage(cause),
    rootDir: environment.rootDir,
    tasks: snapshot?.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      workflowPhase: task.workflowPhase,
      currentRunId: task.currentRunId
    })),
    runs: snapshot?.runs.map((run) => ({
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      recoveryState: run.recoveryState,
      finalMessage: run.finalMessage,
      terminalReason: run.terminalReason
    })),
    events: snapshot?.events.slice(-30).map((event) => ({
      type: event.type,
      taskId: event.taskId,
      runId: event.runId,
      payload: event.payload
    })),
    runtime
  };
}

async function initializeRepositoryFixture(
  sourceRepositoryPath: string,
  localRemotePath: string
): Promise<void> {
  await git(path.dirname(localRemotePath), ['init', '--bare', '--initial-branch=main', localRemotePath]);
  await git(sourceRepositoryPath, ['init', '--initial-branch=main']);
  await git(sourceRepositoryPath, [
    'config',
    'user.email',
    'task-monki-agent-test@example.invalid'
  ]);
  await git(sourceRepositoryPath, ['config', 'user.name', 'Task Monki Agent Test']);
  await fs.writeFile(
    path.join(sourceRepositoryPath, 'README.md'),
    '# Task Monki agent test fixture\n',
    'utf8'
  );
  await git(sourceRepositoryPath, ['add', 'README.md']);
  await git(sourceRepositoryPath, ['commit', '-m', 'Initial agent test fixture']);
  await git(sourceRepositoryPath, ['remote', 'add', 'origin', localRemotePath]);
  await git(sourceRepositoryPath, ['push', '--set-upstream', 'origin', 'main']);
}

function deterministicAcpProfile(providerScriptPath: string): AcpRuntimeProfile {
  return {
    descriptor: {
      id: RUNTIME_ID,
      displayName: 'Deterministic ACP test runtime',
      kind: 'ACP_AGENT',
      transport: 'STDIO',
      lifecycleScope: 'APPLICATION',
      startupPolicy: 'ON_DEMAND'
    },
    executableEnvironmentKey: 'TASK_MONKI_DETERMINISTIC_ACP_BIN',
    executableCandidates: [process.execPath],
    argv: [providerScriptPath],
    versionArgv: ['--version'],
    launchContractProbe: {
      argv: ['--version'],
      description: 'Node runtime used by the deterministic ACP test child',
      requiredOutput: [{ pattern: /^v\d+/u, description: 'Node version' }]
    },
    defaultModelProvider: 'task-monki-test',
    defaultModel: 'deterministic',
    environmentPolicy: {
      contractId: 'task-monki/deterministic-acp-environment@v1',
      allowedKeys: [],
      sensitiveKeys: []
    },
    approvalPolicies: ['never'],
    extensions: {
      deterministicTestRuntime: {
        maturity: 'stable',
        detail: 'Local developer-only ACP subprocess with fixed scenario behavior.'
      }
    }
  };
}

function deterministicAcpSource(ownedRoot: string, providerLogPath: string): string {
  return `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const readline = require('node:readline');
const ownedRoot = ${JSON.stringify(path.resolve(ownedRoot))};
const logPath = ${JSON.stringify(providerLogPath)};
const sessions = new Map();
const pendingPrompts = new Map();
let sessionCounter = 0;

const log = (event, detail = {}) => {
  fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail }) + '\\n');
};
const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/^(?:node:)?(?:net|http|https|http2|tls|dgram|dns)(?:\\/|$)|^undici(?:\\/|$)/u.test(request)) {
    log('network-access-rejected', { request });
    throw new Error('The deterministic ACP runtime cannot load network modules.');
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: () => {
    throw new Error('The deterministic ACP runtime cannot use fetch.');
  }
});
for (const key of ['WebSocket', 'EventSource']) {
  if (key in globalThis) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('The deterministic ACP runtime cannot create network clients.');
        }
      }
    });
  }
}
log('network-guard-installed');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const update = (sessionId, value) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: value }
});
const insideOwnedRoot = (candidate) => {
  const resolved = path.resolve(candidate);
  return resolved === ownedRoot || resolved.startsWith(ownedRoot + path.sep);
};
const promptText = (message) => JSON.stringify(message.params?.prompt ?? []);
const finish = (id, stopReason) => send({
  jsonrpc: '2.0',
  id,
  result: { stopReason }
});

for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY']) {
  if (process.env[key] !== undefined) {
    log('credential-environment-rejected', { key });
    process.exit(91);
  }
}

log('started');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  log('received', { method: message.method });
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: {},
          sessionCapabilities: { resume: {}, close: {} }
        },
        agentInfo: {
          name: 'task-monki-deterministic-acp',
          title: 'Deterministic ACP test runtime',
          version: '1.0.0'
        }
      }
    });
    return;
  }
  if (message.method === 'session/new') {
    const cwd = message.params?.cwd;
    if (typeof cwd !== 'string' || !insideOwnedRoot(cwd)) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'cwd is outside the owned test root' } });
      return;
    }
    const sessionId = 'deterministic-session-' + (++sessionCounter);
    sessions.set(sessionId, { cwd });
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId,
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'deterministic',
        options: [{ value: 'deterministic', name: 'Deterministic' }]
      }]
    } });
    return;
  }
  if (message.method === 'session/resume' || message.method === 'session/load') {
    const sessionId = message.params?.sessionId;
    if (!sessions.has(sessionId)) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'unknown deterministic session' } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId,
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'deterministic',
        options: [{ value: 'deterministic', name: 'Deterministic' }]
      }]
    } });
    return;
  }
  if (message.method === 'session/close') {
    sessions.delete(message.params?.sessionId);
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/prompt') {
    const sessionId = message.params?.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'unknown deterministic session' } });
      return;
    }
    const prompt = promptText(message);
    if (prompt.includes('[agent-test:complete]')) {
      update(sessionId, {
        sessionUpdate: 'plan',
        entries: [{ content: 'Create deterministic worktree output', priority: 'high', status: 'in_progress' }]
      });
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'deterministic-file-change',
        title: 'Write agent-output.txt',
        kind: 'edit',
        status: 'in_progress',
        rawInput: { path: 'agent-output.txt' }
      });
      fs.writeFileSync(path.join(session.cwd, 'agent-output.txt'), 'TASK_MONKI_DETERMINISTIC_AGENT_OK\\n');
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'deterministic-file-change',
        kind: 'edit',
        status: 'completed',
        rawOutput: { path: 'agent-output.txt', bytes: 35 }
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'deterministic-complete-message',
        content: { type: 'text', text: 'Created deterministic worktree output.' }
      });
      finish(message.id, 'end_turn');
      return;
    }
    if (prompt.includes('[agent-test:fail]')) {
      update(sessionId, {
        sessionUpdate: 'plan',
        entries: [{ content: 'Report a deterministic provider failure', priority: 'high', status: 'in_progress' }]
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'deterministic-failure-message',
        content: { type: 'text', text: 'Deterministic runtime reached its configured token limit.' }
      });
      finish(message.id, 'max_tokens');
      return;
    }
    if (prompt.includes('[agent-test:cancel]')) {
      update(sessionId, {
        sessionUpdate: 'plan',
        entries: [{ content: 'Wait for Task Monki cancellation', priority: 'high', status: 'in_progress' }]
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'deterministic-cancel-message',
        content: { type: 'text', text: 'Waiting for Task Monki cancellation.' }
      });
      pendingPrompts.set(sessionId, message.id);
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown deterministic scenario' } });
    return;
  }
  if (message.method === 'session/cancel') {
    const sessionId = message.params?.sessionId;
    const promptId = pendingPrompts.get(sessionId);
    if (promptId !== undefined) {
      pendingPrompts.delete(sessionId);
      finish(promptId, 'cancelled');
    }
  }
});
input.on('close', () => {
  log('stdin-closed');
});
process.on('SIGTERM', () => {
  log('sigterm');
  process.exit(0);
});
process.on('SIGINT', () => {
  log('sigint');
  process.exit(0);
});
`;
}

async function startUiHost(environment: AgentTestEnvironment): Promise<UiHost> {
  const rendererPort = await reserveLoopbackPort();
  const security = {
    token: '',
    expectedHost: '',
    expectedOrigin: devRendererOrigin(rendererPort)
  };
  const devServer = createDevHttpServer({
    service: environment.service,
    security,
    chooseRepositoryFolder: async () => undefined
  });
  let tokenLease: DevApiTokenLease | undefined;
  let vite: ChildProcess | undefined;
  let apiPort = 0;
  try {
    apiPort = await listenOnAvailablePort(devServer.server);
    security.expectedHost = devApiExpectedHost(apiPort);
    tokenLease = await createDevApiTokenLease(apiPort);
    security.token = tokenLease.token;
    const viteExecutable = path.join(
      PROJECT_ROOT,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'vite.cmd' : 'vite'
    );
    const sharedTemporaryDirectory = os.tmpdir();
    vite = spawnPortable(
      viteExecutable,
      ['--host', '127.0.0.1', '--port', String(rendererPort), '--strictPort'],
      {
        cwd: PROJECT_ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(environment.rootDir, 'runtime', 'home'),
          USER: 'task-monki-agent-test',
          LOGNAME: 'task-monki-agent-test',
          // The existing token lease and Vite proxy deliberately rendezvous
          // through the current user's private OS temp directory.
          TMPDIR: sharedTemporaryDirectory,
          TMP: sharedTemporaryDirectory,
          TEMP: sharedTemporaryDirectory,
          TASK_MANAGER_API_PORT: String(apiPort),
          TASK_MANAGER_RENDERER_PORT: String(rendererPort)
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      }
    );
    const viteDiagnostics: string[] = [];
    vite.stdout?.on('data', (chunk: Buffer) => {
      appendBoundedDiagnostic(viteDiagnostics, chunk.toString('utf8'));
    });
    vite.stderr?.on('data', (chunk: Buffer) => {
      appendBoundedDiagnostic(viteDiagnostics, chunk.toString('utf8'));
    });
    const rendererUrl = devRendererOrigin(rendererPort);
    await waitForHttp(rendererUrl, vite, viteDiagnostics);
    let stopped = false;
    return {
      rendererUrl,
      processIds: typeof vite.pid === 'number' ? [vite.pid] : [],
      async stop() {
        if (stopped) return;
        stopped = true;
        security.token = '';
        const errors: unknown[] = [];
        await attemptCleanup(() => stopChild(vite!), errors);
        await attemptCleanup(() => tokenLease?.dispose(), errors);
        await attemptCleanup(() => devServer.closeEventStreams(), errors);
        await attemptCleanup(() => closeHttpServer(devServer.server), errors);
        await attemptCleanup(() => devServer.dispose(), errors);
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Agent workflow UI host cleanup failed.');
        }
      }
    };
  } catch (cause) {
    security.token = '';
    const cleanupErrors: unknown[] = [];
    if (vite) await attemptCleanup(() => stopChild(vite!), cleanupErrors);
    await attemptCleanup(() => tokenLease?.dispose(), cleanupErrors);
    await attemptCleanup(() => devServer.closeEventStreams(), cleanupErrors);
    await attemptCleanup(() => closeHttpServer(devServer.server), cleanupErrors);
    await attemptCleanup(() => devServer.dispose(), cleanupErrors);
    throw new Error(
      `Could not start the agent workflow renderer on API port ${apiPort} and renderer port ${rendererPort}: ${errorMessage(cause)}` +
        (cleanupErrors.length > 0
          ? `\nRenderer startup cleanup errors: ${JSON.stringify(cleanupErrors.map(errorMessage))}`
          : '')
    );
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (await waitForPortableProcessTreeExit(child, 0)) return;
  await terminatePortableProcessTree(child, 'SIGTERM');
  if (await waitForPortableProcessTreeExit(child, 5_000)) return;
  await terminatePortableProcessTree(child, 'SIGKILL');
  if (!(await waitForPortableProcessTreeExit(child, 5_000))) {
    throw new Error(`Vite process tree ${child.pid ?? '<unknown>'} did not exit.`);
  }
}

async function listenOnAvailablePort(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  return (server.address() as AddressInfo).port;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await closeNetServer(server);
  return port;
}

function closeNetServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
    server.closeAllConnections();
  });
}

async function waitForHttp(
  url: string,
  child: ChildProcess,
  diagnostics: readonly string[]
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Vite exited before becoming ready (${child.exitCode ?? child.signalCode}). ${diagnostics.join('')}`
      );
    }
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${url}. ${diagnostics.join('')}`);
}

function waitForTerminationSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

async function waitForSnapshot(
  store: FileTaskStore,
  predicate: (snapshot: TaskSnapshot) => boolean,
  timeoutMs = TIMEOUT_MS
): Promise<TaskSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskSnapshot | undefined;
  while (Date.now() < deadline) {
    last = await store.snapshot();
    if (predicate(last)) return last;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for deterministic workflow state. ${JSON.stringify({
      tasks: last?.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        phase: task.workflowPhase
      })),
      runs: last?.runs.map((run) => ({
        id: run.id,
        taskId: run.taskId,
        status: run.status,
        afterGitSnapshotId: run.afterGitSnapshotId
      }))
    })}`
  );
}

async function observedGitPaths(worktreePath: string): Promise<string[]> {
  const status = await git(worktreePath, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  ]);
  return status
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(3);
      const renameSeparator = value.indexOf(' -> ');
      return renameSeparator >= 0 ? value.slice(renameSeparator + 4) : value;
    })
    .sort();
}

function scenarioTitle(kind: ScenarioKind): string {
  return {
    complete: '[agent-test:complete] Deterministic completion',
    fail: '[agent-test:fail] Deterministic failure',
    cancel: '[agent-test:cancel] Deterministic cancellation'
  }[kind];
}

function scenarioPrompt(kind: ScenarioKind): string {
  return {
    complete: 'Create the known test output and finish.',
    fail: 'Emit the known provider failure.',
    cancel: 'Wait until Task Monki interrupts this turn.'
  }[kind];
}

function requireScenario(
  scenarios: readonly AgentTestScenarioReport[],
  kind: ScenarioKind
): AgentTestScenarioReport {
  return requireValue(
    scenarios.find((scenario) => scenario.kind === kind),
    `Scenario report ${kind} is missing.`
  );
}

async function cleanupAgentTestEnvironment(
  environment: AgentTestEnvironment,
  options: {
    ui?: UiHost;
    processIds: readonly number[];
  }
): Promise<AgentTestCleanupResult> {
  const errors: unknown[] = [];
  const processIds = new Set(options.processIds);
  let serviceStopped = false;
  let uiStopped = options.ui === undefined;

  for (const pid of options.ui?.processIds ?? []) processIds.add(pid);
  await attemptCleanup(async () => {
    const snapshot = await environment.store.snapshot();
    for (const server of snapshot.agentServers) {
      if (typeof server.pid === 'number') processIds.add(server.pid);
    }
    const providerLog = await fs
      .readFile(environment.providerLogPath, 'utf8')
      .catch(() => '');
    for (const pid of providerProcessIds(providerLog)) processIds.add(pid);
  }, errors);
  if (options.ui) {
    await attemptCleanup(async () => {
      await options.ui!.stop();
      uiStopped = true;
    }, errors);
  }
  await attemptCleanup(async () => {
    await environment.service.shutdown();
    serviceStopped = true;
  }, errors);
  await attemptCleanup(async () => {
    const providerLog = await fs
      .readFile(environment.providerLogPath, 'utf8')
      .catch(() => '');
    for (const pid of providerProcessIds(providerLog)) processIds.add(pid);
  }, errors);
  await attemptCleanup(() => removeOwnedRoot(environment.rootDir), errors);

  const rootRemoved = !(await pathExists(environment.rootDir));
  const processJoined = [...processIds].every((pid) => !processIsRunning(pid));
  return {
    serviceStopped,
    uiStopped,
    rootRemoved,
    processJoined,
    errors: errors.map(errorMessage)
  };
}

function cleanupSucceeded(result: AgentTestCleanupResult): boolean {
  return (
    result.serviceStopped &&
    result.uiStopped &&
    result.rootRemoved &&
    result.processJoined &&
    result.errors.length === 0
  );
}

async function removeOwnedRoot(rootDir: string): Promise<void> {
  const resolved = path.resolve(rootDir);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, resolved);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !path.basename(resolved).startsWith('task-monki-agent-test-')
  ) {
    throw new Error(`Refusing to remove non-owned agent test root: ${rootDir}`);
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseArgs(args: readonly string[]): WorkflowCliOptions {
  const options: WorkflowCliOptions = { ui: false, help: false };
  for (const arg of args) {
    if (arg === '--ui') {
      options.ui = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return `Usage:
  npm run test:agent-workflow
  npm run test:agent-workflow -- --ui

The default command runs complete, failed, and canceled workflows through a
local ACP subprocess, prints structured proof, and removes every owned resource.
--ui serves the completed environment through the existing loopback development
API and Vite renderer until Ctrl-C; cleanup is verified after the signal.`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.ui) {
    await runUiWorkflow();
    return;
  }
  console.log(JSON.stringify(await runAgentTestWorkflow(), null, 2));
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function elapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function boundedTail(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(-maxLength);
}

function providerProcessIds(providerLog: string): number[] {
  return [
    ...new Set(
      providerLog
        .split('\n')
        .filter(Boolean)
        .flatMap((line): number[] => {
          try {
            const entry = JSON.parse(line) as { pid?: unknown };
            return typeof entry.pid === 'number' &&
              Number.isInteger(entry.pid) &&
              entry.pid > 0
              ? [entry.pid]
              : [];
          } catch {
            return [];
          }
        })
    )
  ];
}

function providerEventCount(providerLog: string, event: string): number {
  return providerLog
    .split('\n')
    .filter(Boolean)
    .reduce((count, line) => {
      try {
        const entry = JSON.parse(line) as { event?: unknown };
        return count + (entry.event === event ? 1 : 0);
      } catch {
        return count;
      }
    }, 0);
}

function appendBoundedDiagnostic(values: string[], next: string): void {
  values.push(next);
  const combined = boundedTail(values.join(''), MAX_DIAGNOSTIC_TAIL);
  values.splice(0, values.length, combined);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(
    () => true,
    () => false
  );
}

async function attemptCleanup(
  cleanup: () => void | Promise<void>,
  errors: unknown[]
): Promise<void> {
  try {
    await cleanup();
  } catch (cause) {
    errors.push(cause);
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

if (require.main === module) {
  void main().catch((cause: unknown) => {
    console.error(`[agent-test] ${errorMessage(cause)}`);
    process.exitCode = 1;
  });
}
