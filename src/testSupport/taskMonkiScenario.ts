import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentExecutionSettings,
  AgentModel,
  AgentPreflight,
  AgentReviewTarget,
  AgentRunMode,
  AgentRuntimeCapabilities,
  AgentSessionRecord,
  AgentSessionSnapshot,
  AppUpdateEvent,
  DomainEvent,
  RunRecord,
  Task,
  TaskIteration,
  TaskSnapshot,
  WorktreeRecord
} from '../shared/contracts';
import { AgentMutationAmbiguousError } from '../core/agent/AgentRuntimeAdapter';
import { createRuntimeReadiness } from '../core/agent/AgentRuntimeReadiness';
import type {
  AgentRuntimeAdapter,
  AgentReconciliationResult,
  AgentSessionRef,
  AgentTurn,
  CreateAgentSession,
  InterruptAgentTurn,
  StartAgentReview,
  StartAgentTurn,
  SteerAgentTurn,
  ResolveAgentExecution,
  ResolvedAgentExecution
} from '../core/agent/AgentRuntimeAdapter';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../core/agent/codex/codexCapabilities';
import { git } from '../core/git/gitCli';
import { AppEventBus } from '../core/runner/AppEventBus';
import { createDomainEvent } from '../core/storage/domainEvent';
import type { TaskAgentRuntimeAccess } from '../core/agent/AgentRuntimeStore';
import { FileAgentRuntimeStore } from '../core/storage/FileAgentRuntimeStore';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { assertModelSupportsAttachments } from '../core/agent/AgentAttachmentDelivery';
import type { PreviewRecipeGenerationService } from '../core/preview/generation/PreviewRecipeGenerationService';

export interface ScenarioOptions {
  name?: string;
  ghPath?: string;
  previewEnabled?: boolean;
  previewOciExecutablePath?: string;
  previewOciContextName?: string;
  previewOciEnv?: NodeJS.ProcessEnv;
  previewRecipeGenerator?: PreviewRecipeGenerationService;
  designMode?: boolean;
}

interface CreateScenarioTaskInput {
  title?: string;
  prompt?: string;
  agentSettings?: Task['agentSettings'];
}

export interface TaskMonkiScenario {
  rootDir: string;
  repositoryPath: string;
  repositoryId: string;
  worktreeRoot: string;
  previewRoot: string;
  store: FileTaskStore;
  runtimeStore: FileAgentRuntimeStore;
  taskRuntime: TaskAgentRuntimeAccess;
  events: AppEventBus;
  agent: ScriptedAgentRuntimeAdapter;
  service: TaskManagerService;
  dispose(): Promise<void>;
  createTask(input?: CreateScenarioTaskInput): Promise<Task>;
  commitFile(relativePath: string, content: string, message?: string): Promise<string>;
  completeRun(runId: string, finalMessage?: string): Promise<RunRecord>;
  transitionRun(
    runId: string,
    update: Partial<RunRecord> & { status: RunRecord['status'] },
    operationId?: string
  ): Promise<RunRecord>;
  waitForEvent(
    predicate: (event: AppUpdateEvent) => boolean,
    timeoutMs?: number
  ): Promise<AppUpdateEvent>;
  waitForSnapshot(
    predicate: (snapshot: TaskSnapshot) => boolean,
    timeoutMs?: number
  ): Promise<TaskSnapshot>;
}

export interface ScriptedAgentRuntimeFixture {
  adapter: ScriptedAgentRuntimeAdapter;
  runtimeStore: FileAgentRuntimeStore;
  taskRuntime: TaskAgentRuntimeAccess;
  serviceOptions: {
    agentRuntimeAdapters: readonly AgentRuntimeAdapter[];
    agentRuntimeStore: FileAgentRuntimeStore;
    taskRuntimeAccess: TaskAgentRuntimeAccess;
  };
  createSession(input: {
    task: Task;
    iteration: TaskIteration;
    worktree: WorktreeRecord;
    runtimeId?: string;
    role?: AgentSessionRecord['role'];
    settings?: AgentExecutionSettings;
  }): Promise<AgentSessionRecord>;
  createRun(input: {
    task: Task;
    session: AgentSessionRecord;
    mode: AgentRunMode;
    prompt: string;
    generationKey?: string;
    settings?: AgentExecutionSettings;
    beforeGitSnapshotId?: string;
    reviewTarget?: AgentReviewTarget;
  }): Promise<RunRecord>;
  transitionRun(
    runId: string,
    update: Partial<RunRecord> & { status: RunRecord['status'] },
    operationId?: string
  ): Promise<RunRecord>;
}

/** One canonical runtime store and Task view for tests that use the scripted provider. */
export function createScriptedAgentRuntimeFixture(
  store: FileTaskStore
): ScriptedAgentRuntimeFixture {
  const runtimeStore = new FileAgentRuntimeStore(
    path.join(store.getStorageRoot(), 'agent-runtime')
  );
  const taskRuntime = runtimeStore.taskAgentRuntimeAccess((event, operationId) =>
    store.recordAgentRuntimeEvent(event, operationId)
  );
  store.bindAgentRuntime(taskRuntime);
  const adapter = new ScriptedAgentRuntimeAdapter(taskRuntime);
  return {
    adapter,
    runtimeStore,
    taskRuntime,
    serviceOptions: {
      agentRuntimeAdapters: [adapter],
      agentRuntimeStore: runtimeStore,
      taskRuntimeAccess: taskRuntime
    },
    async createSession(input) {
      const id = randomUUID();
      const runtimeId = input.runtimeId ?? input.task.runtimeId;
      const settings = {
        model: 'scenario-model',
        reasoningEffort: 'low' as const,
        ...input.task.agentSettings,
        ...input.settings,
        runtimeId
      };
      const operationId = `scenario-fixture-session:${id}`;
      const executionContext = {
        attestation: { status: 'ATTESTED' as const },
        primaryCwd: input.worktree.worktreePath,
        readRoots: [
          {
            canonicalPath: input.worktree.worktreePath,
            kind: 'WORKTREE' as const,
            entityId: input.worktree.id
          }
        ],
        managedAttachments: [],
        permissionProfileHash: createHash('sha256')
          .update(
            JSON.stringify({
              id,
              runtimeId,
              worktreePath: input.worktree.worktreePath,
              settings
            })
          )
          .digest('hex'),
        modelSettings: settings,
        externalTools: {
          network: settings.networkAccess === true,
          webSearch: 'disabled' as const,
          mcpServers: false,
          apps: false,
          dynamicTools: false
        },
        clientOperationId: operationId
      };
      const session = await taskRuntime.createTaskSession({
        id,
        taskId: input.task.id,
        iterationId: input.iteration.id,
        worktreeId: input.worktree.id,
        worktreePath: input.worktree.worktreePath,
        runtimeId,
        role: input.role,
        requestedSettings: settings,
        executionContext,
        operationId
      });
      await store.recordAgentSessionCreated(session);
      return session;
    },
    async createRun(input) {
      const run = await taskRuntime.createTaskRun({
        id: randomUUID(),
        taskId: input.task.id,
        iterationId: input.session.iterationId,
        worktreeId: input.session.worktreeId,
        sessionId: input.session.id,
        mode: input.mode,
        prompt: input.prompt,
        generationKey: input.generationKey,
        requestedSettings: input.settings,
        beforeGitSnapshotId: input.beforeGitSnapshotId,
        reviewTarget:
          input.mode === 'REVIEW'
            ? input.reviewTarget ?? { type: 'UNCOMMITTED_CHANGES' }
            : undefined,
        operationId: `scenario-fixture-run:${randomUUID()}`
      });
      await store.recordAgentRunStarted(run);
      return run;
    },
    transitionRun(runId, update, operationId) {
      return transitionScriptedRun(
        taskRuntime,
        runId,
        update,
        operationId ?? `scenario-fixture-run-transition:${runId}:${randomUUID()}`
      );
    }
  };
}

export class TaskMonkiScenarioRegistry {
  private readonly scenarios = new Set<TaskMonkiScenario>();

  async create(options: ScenarioOptions = {}): Promise<TaskMonkiScenario> {
    const scenario = await createTaskMonkiScenario(options);
    this.scenarios.add(scenario);
    return scenario;
  }

  async dispose(): Promise<void> {
    const scenarios = [...this.scenarios];
    this.scenarios.clear();
    const results = await Promise.allSettled(
      scenarios.map((scenario) => scenario.dispose())
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Multiple Task Monki scenarios failed to dispose.');
    }
  }
}

export async function createTaskMonkiScenario(
  options: ScenarioOptions = {}
): Promise<TaskMonkiScenario> {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `${options.name ?? 'task-monki-scenario'}-`)
  );
  const repositoryPath = path.join(rootDir, 'repo');
  const worktreeRoot = path.join(rootDir, 'worktrees');
  const previewRoot = path.join(rootDir, 'preview-runtime');
  const designRepositoryRoot = path.join(rootDir, 'design-repositories');
  const designWorktreeRoot = path.join(rootDir, 'design-worktrees');
  try {
    await fs.mkdir(repositoryPath, { recursive: true });
    await initRepository(repositoryPath);
  } catch (error) {
    return cleanupFailedScenarioCreation(undefined, rootDir, error);
  }

  const store = new FileTaskStore(path.join(rootDir, 'store'));
  const scriptedRuntime = createScriptedAgentRuntimeFixture(store);
  const { adapter: agent, taskRuntime } = scriptedRuntime;
  const events = new AppEventBus();
  let service: TaskManagerService | undefined;
  let repository: Awaited<ReturnType<TaskManagerService['addRepository']>> | undefined;
  try {
    service = new TaskManagerService(store, repositoryPath, events, {
      worktreeRoot,
      ghPath: options.ghPath,
      ...scriptedRuntime.serviceOptions,
      previewRecipeGenerator: options.previewRecipeGenerator,
      previewEnabled: options.previewEnabled,
      previewRoot,
      previewLauncherPath: path.join(
        process.cwd(),
        'src/core/preview/runtime/native-preview-launcher.mjs'
      ),
      managedDesignStaticServerPath: path.join(
        process.cwd(),
        'src/core/preview/runtime/managed-design-static-server.mjs'
      ),
      previewOciExecutablePath: options.previewOciExecutablePath,
      previewOciContextName: options.previewOciContextName,
      previewOciEnv: options.previewOciEnv,
      ...(options.designMode
        ? {
            designRepositoryRoot,
            designWorktreeRoot,
            designBrowserRuntime: {
              async attest() {},
              async recover() {},
              async openCandidate() {
                return {
                  snapshot: 'test page',
                  console: '(no output)',
                  errors: '(no output)'
                };
              },
              async inspect() {
                return { text: 'test page' };
              },
              abortRun() {},
              async closeRun() {},
              async shutdown() {}
            },
            designCanvasFence: {
              async begin() {
                return {
                  async commit() {},
                  async rollback() {}
                };
              }
            }
          }
        : {})
    });
    await service.init();
    repository = await service.addRepository(repositoryPath);
  } catch (error) {
    return cleanupFailedScenarioCreation(service, rootDir, error);
  }
  if (!service || !repository) {
    return cleanupFailedScenarioCreation(
      service,
      rootDir,
      new Error('Scenario initialization did not produce a service and repository.')
    );
  }
  let disposeWork: Promise<void> | undefined;

  return {
    rootDir,
    repositoryPath,
    repositoryId: repository.id,
    worktreeRoot,
    previewRoot,
    store,
    runtimeStore: scriptedRuntime.runtimeStore,
    taskRuntime,
    events,
    agent,
    service,
    dispose() {
      disposeWork ??= disposeScenario(service, rootDir);
      return disposeWork;
    },
    createTask(input = {}) {
      return service.createTask({
        title: input.title ?? 'Scenario task',
        prompt: input.prompt ?? 'Exercise the task workflow.',
        repositoryId: repository.id,
        agentSettings: input.agentSettings ?? {
          model: 'scenario-model',
          reasoningEffort: 'low'
        }
      });
    },
    async commitFile(relativePath, content, message = `Update ${relativePath}`) {
      const filePath = path.join(repositoryPath, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
      await git(repositoryPath, ['add', relativePath]);
      await git(repositoryPath, ['commit', '-m', message]);
      return (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim();
    },
    async completeRun(runId, finalMessage = 'Scenario run completed.') {
      const run = await requireRun(taskRuntime, runId);
      if (run.mode === 'DESIGN') {
        const detail = await store.getDesignDetail(run.taskId);
        const worktree = await store.getWorktree(run.worktreeId);
        const sourceChanged = worktree
          ? (await git(worktree.worktreePath, [
              'status',
              '--porcelain=v1',
              '--untracked-files=all'
            ])).trim().length > 0
          : false;
        if (detail.revisions.length === 0 || sourceChanged) {
          await inspectDesignCandidateForScriptedRun(service, runId).catch(() => undefined);
        }
      }
      const artifact = await taskRuntime.writeFinalArtifact(
        run.taskId,
        run.id,
        finalMessage,
        `scenario-final-artifact:${run.id}`
      );
      await appendRunEvent(taskRuntime, run, 'AGENT_RUN_COMPLETED', {
        terminalStatus: 'completed',
        finalArtifactId: artifact.id
      });
      events.emit({
        type: 'run.terminal',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: { status: 'COMPLETED' },
        at: new Date().toISOString()
      });
      return requireRun(taskRuntime, runId);
    },
    transitionRun(runId, update, operationId) {
      return scriptedRuntime.transitionRun(runId, update, operationId);
    },
    waitForEvent(predicate, timeoutMs = 3_000) {
      return waitForEvent(events, predicate, timeoutMs);
    },
    waitForSnapshot(predicate, timeoutMs = 3_000) {
      return waitForSnapshot(store, predicate, timeoutMs);
    }
  };
}

async function disposeScenario(service: TaskManagerService, rootDir: string): Promise<void> {
  let shutdownError: unknown;
  try {
    await service.shutdown();
  } catch (error) {
    shutdownError = error;
  }

  try {
    await removeScenarioRoot(rootDir);
  } catch (cleanupError) {
    if (shutdownError) {
      throw new AggregateError(
        [shutdownError, cleanupError],
        `Scenario shutdown and cleanup failed for ${rootDir}.`
      );
    }
    throw cleanupError;
  }

  if (shutdownError) throw shutdownError;
}

async function cleanupFailedScenarioCreation(
  service: TaskManagerService | undefined,
  rootDir: string,
  creationError: unknown
): Promise<never> {
  try {
    if (service) await disposeScenario(service, rootDir);
    else await removeScenarioRoot(rootDir);
  } catch (cleanupError) {
    throw new AggregateError(
      [creationError, cleanupError],
      `Scenario creation and cleanup failed for ${rootDir}.`
    );
  }
  throw creationError;
}

function removeScenarioRoot(rootDir: string): Promise<void> {
  return fs.rm(rootDir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 1,
    retryDelay: 50
  });
}

/** Models the custom tool call that the scripted runtime cannot issue itself. */
function inspectDesignCandidateForScriptedRun(
  service: TaskManagerService,
  runId: string
): Promise<unknown> {
  return (
    service as unknown as {
      inspectDesignForAgent(input: {
        runId: string;
        operation: { operation: 'open_candidate' };
      }): Promise<unknown>;
    }
  ).inspectDesignForAgent({ runId, operation: { operation: 'open_candidate' } });
}

export function commandLine(...argv: string[]): string {
  return argv.map(quoteCommandLineArg).join(' ');
}

export class ScriptedAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly descriptor = CODEX_RUNTIME_DESCRIPTOR;
  readonly startedTurns: StartAgentTurn[] = [];
  readonly startedReviews: StartAgentReview[] = [];
  readonly steeredTurns: SteerAgentTurn[] = [];
  ambiguousStart = false;
  ambiguousInterrupt = false;
  private threadCounter = 0;
  private turnCounter = 0;

  constructor(private readonly runtime: TaskAgentRuntimeAccess) {}

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  preflight(): Promise<AgentPreflight> {
    return Promise.resolve({
      runtime: this.descriptor,
      readiness: createRuntimeReadiness('READY', 'Scenario runtime is ready.'),
      capabilities: codexCapabilities(),
    });
  }

  capabilities(): Promise<AgentRuntimeCapabilities> {
    return Promise.resolve(codexCapabilities());
  }

  listModels(): Promise<AgentModel[]> {
    return Promise.resolve([
      {
        id: 'codex:openai/scenario-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'scenario-model',
        displayName: 'Scenario model',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'low',
        serviceTiers: [],
        inputModalities: ['text', 'image'],
        isDefault: true
      }
    ]);
  }

  async resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution> {
    const model = (await this.listModels())[0];
    assertModelSupportsAttachments(model, input.attachments);
    return {
      model,
      settings: {
        ...input.settings,
        runtimeId: this.descriptor.id,
        model: model.model,
        modelProvider: model.modelProvider,
        reasoningEffort: input.settings.reasoningEffort ?? model.defaultReasoningEffort
      }
    };
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    this.threadCounter += 1;
    return this.runtime.updateAgentSession(
      input.localSessionId,
      {
        providerSessionId: `scenario-thread-${this.threadCounter}`,
        providerSessionTreeId: `scenario-thread-${this.threadCounter}`,
        status: 'IDLE',
        materialized: true,
        requestedSettings: input.settings
      },
      `scenario-session-materialized:${input.localSessionId}`
    );
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    const session = await this.runtime.getAgentSession(ref.localSessionId);
    if (!session) {
      throw new Error(`Agent session not found: ${ref.localSessionId}`);
    }
    return session;
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot> {
    const session = await this.attachSession(ref);
    const snapshot = await this.runtime.snapshot();
    return {
      session,
      runs: snapshot.runs
        .filter((run) => run.sessionId === session.id)
        .map((run) => ({
          id: run.id,
          providerTurnId: run.providerTurnId,
          status: run.status
        }))
    };
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    this.startedTurns.push(input);
    if (this.ambiguousStart) {
      throw new AgentMutationAmbiguousError(
        'turn/start',
        'Scenario provider lost the start response.'
      );
    }
    return this.startRun(input.localRunId, input.session.localSessionId, 'scenario-turn');
  }

  steerTurn(input: SteerAgentTurn): Promise<void> {
    this.steeredTurns.push(input);
    return Promise.resolve();
  }

  async interruptTurn(input: InterruptAgentTurn): Promise<void> {
    if (this.ambiguousInterrupt) {
      throw new AgentMutationAmbiguousError(
        'turn/interrupt',
        'Scenario provider lost the interrupt response.'
      );
    }
    const run = await this.runtime.getRunByProviderTurnId(
      this.descriptor.id,
      input.providerTurnId
    );
    if (run) {
      await appendRunEvent(this.runtime, run, 'AGENT_RUN_INTERRUPTED', {
        terminalReason: 'interrupted'
      });
    }
  }

  async startReview(input: StartAgentReview): Promise<AgentTurn> {
    this.startedReviews.push(input);
    this.threadCounter += 1;
    await this.runtime.updateAgentSession(
      input.reviewSessionId,
      {
        providerSessionId: `scenario-review-thread-${this.threadCounter}`,
        providerSessionTreeId: `scenario-review-thread-${this.threadCounter}`,
        status: 'ACTIVE',
        materialized: true
      },
      `scenario-review-session-materialized:${input.reviewSessionId}`
    );
    return this.startRun(input.localRunId, input.reviewSessionId, 'scenario-review');
  }

  respondToInteraction(): Promise<void> {
    return Promise.resolve();
  }

  deleteTaskProviderHistory(): Promise<void> {
    return Promise.resolve();
  }

  reconcile(): Promise<AgentReconciliationResult> {
    return Promise.resolve({
      reconciledSessionIds: [],
      recoveryRequiredSessionIds: []
    });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  private async startRun(
    localRunId: string,
    localSessionId: string,
    prefix: string
  ): Promise<AgentTurn> {
    this.turnCounter += 1;
    const providerTurnId = `${prefix}-${this.turnCounter}`;
    const run = await requireRun(this.runtime, localRunId);
    await this.runtime.updateAgentSession(
      localSessionId,
      { status: 'ACTIVE' },
      `scenario-session-active:${localSessionId}:${localRunId}`
    );
    await this.runtime.updateRun(
      localRunId,
      {
        providerTurnId,
        status: 'STARTING',
        lastEventAt: new Date().toISOString()
      },
      `scenario-run-starting:${localRunId}`
    );
    await appendRunEvent(this.runtime, run, 'PROCESS_STARTED', {
      pid: 10_000 + this.turnCounter
    });
    return { localRunId, providerTurnId };
  }
}

async function transitionScriptedRun(
  runtime: TaskAgentRuntimeAccess,
  runId: string,
  update: Partial<RunRecord> & { status: RunRecord['status'] },
  operationId: string
): Promise<RunRecord> {
  const { status, endedAt: _endedAt, recoveryState: _recoveryState, ...fields } =
    update;
  let run = await requireRun(runtime, runId);
  if (status === 'COMPLETED' && !run.providerTurnId && !fields.providerTurnId) {
    fields.providerTurnId = `scenario-turn-${runId}`;
  }
  if (Object.keys(fields).length > 0) {
    run = await runtime.updateRun(runId, fields, `${operationId}:fields`);
  }
  if (status === 'STARTING') {
    return runtime.updateRun(runId, { status }, `${operationId}:starting`);
  }
  if (
    run.status === 'QUEUED' &&
    (status === 'RUNNING' || status === 'COMPLETED')
  ) {
    run = await runtime.updateRun(
      runId,
      { status: 'STARTING' },
      `${operationId}:starting`
    );
  }

  const type =
    status === 'RUNNING'
      ? 'PROCESS_STARTED'
      : status === 'COMPLETED'
        ? 'AGENT_RUN_COMPLETED'
        : status === 'FAILED'
          ? 'AGENT_RUN_FAILED'
          : status === 'INTERRUPTED'
            ? 'AGENT_RUN_INTERRUPTED'
            : status === 'RECOVERY_REQUIRED'
              ? update.recoveryState === 'REQUIRES_USER_ACTION'
                ? 'AGENT_MUTATION_AMBIGUOUS'
                : 'AGENT_RUNTIME_LOST'
              : undefined;
  if (!type) {
    return runtime.updateRun(runId, { status }, `${operationId}:status`);
  }
  const event = createDomainEvent({
    type,
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    worktreeId: run.worktreeId,
    agentSessionId: run.sessionId,
    serverInstanceId: run.serverInstanceId,
    source: type === 'PROCESS_STARTED' ? 'process' : 'provider',
    payload: {
      ...(type === 'PROCESS_STARTED' ? { pid: 10_000 } : {}),
      ...(update.finalArtifactId ? { finalArtifactId: update.finalArtifactId } : {}),
      ...(update.terminalReason
        ? type === 'AGENT_RUN_FAILED'
          ? { error: update.terminalReason }
          : { terminalReason: update.terminalReason, reason: update.terminalReason }
        : {})
    }
  });
  await runtime.applyTaskRuntimeEvent(event, `${operationId}:event`);
  return requireRun(runtime, runId);
}

async function initRepository(repositoryPath: string): Promise<void> {
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Scenario\n', 'utf8');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial scenario commit']);
}

async function requireRun(
  runtime: TaskAgentRuntimeAccess,
  runId: string
): Promise<RunRecord> {
  const run = await runtime.getRun(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }
  return run;
}

async function appendRunEvent(
  runtime: TaskAgentRuntimeAccess,
  run: RunRecord,
  type: Extract<
    DomainEvent['type'],
    'PROCESS_STARTED' | 'AGENT_RUN_COMPLETED' | 'AGENT_RUN_INTERRUPTED'
  >,
  payload: Record<string, unknown>
): Promise<void> {
  const event = createDomainEvent({
    type,
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    worktreeId: run.worktreeId,
    agentSessionId: run.sessionId,
    serverInstanceId: run.serverInstanceId,
    source: type === 'PROCESS_STARTED' ? 'process' : 'provider',
    payload
  });
  await runtime.applyTaskRuntimeEvent(
    event,
    `scenario-run-event:${run.id}:${type}:${event.id}`
  );
}

function waitForEvent(
  events: AppEventBus,
  predicate: (event: AppUpdateEvent) => boolean,
  timeoutMs: number
): Promise<AppUpdateEvent> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for app event.`));
    }, timeoutMs);

    unsubscribe = events.on((event) => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

function waitForSnapshot(
  store: FileTaskStore,
  predicate: (snapshot: TaskSnapshot) => boolean,
  timeoutMs: number
): Promise<TaskSnapshot> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const snapshot = await store.snapshot();
        if (predicate(snapshot)) {
          resolve(snapshot);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting ${timeoutMs}ms for store state.`));
          return;
        }
        setTimeout(() => void check(), 10);
      } catch (error) {
        reject(error);
      }
    };
    void check();
  });
}

function quoteCommandLineArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}
