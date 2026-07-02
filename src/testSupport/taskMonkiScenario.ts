import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentModel,
  AgentPreflight,
  AgentProviderCapabilities,
  AgentSessionRecord,
  AgentSessionSnapshot,
  AppUpdateEvent,
  DomainEvent,
  RunRecord,
  Task,
  TaskSnapshot
} from '../shared/contracts';
import { AgentMutationAmbiguousError } from '../core/agent/AgentProviderAdapter';
import type {
  AgentProviderAdapter,
  AgentReconciliationResult,
  AgentSessionRef,
  AgentTurn,
  CreateAgentSession,
  InterruptAgentTurn,
  StartAgentReview,
  StartAgentTurn,
  SteerAgentTurn
} from '../core/agent/AgentProviderAdapter';
import { codexCapabilities } from '../core/agent/codex/codexCapabilities';
import { git } from '../core/git/gitCli';
import { AppEventBus } from '../core/runner/AppEventBus';
import { createDomainEvent } from '../core/storage/domainEvent';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { TaskManagerService } from '../core/app/TaskManagerService';

interface ScenarioOptions {
  name?: string;
}

interface CreateScenarioTaskInput {
  title?: string;
  prompt?: string;
  agentSettings?: Task['agentSettings'];
}

export interface TaskMonkiScenario {
  rootDir: string;
  repositoryPath: string;
  worktreeRoot: string;
  store: FileTaskStore;
  events: AppEventBus;
  agent: ScriptedAgentProviderAdapter;
  service: TaskManagerService;
  createTask(input?: CreateScenarioTaskInput): Promise<Task>;
  commitFile(relativePath: string, content: string, message?: string): Promise<string>;
  completeRun(runId: string, finalMessage?: string): Promise<RunRecord>;
  waitForEvent(
    predicate: (event: AppUpdateEvent) => boolean,
    timeoutMs?: number
  ): Promise<AppUpdateEvent>;
  waitForSnapshot(
    predicate: (snapshot: TaskSnapshot) => boolean,
    timeoutMs?: number
  ): Promise<TaskSnapshot>;
}

export async function createTaskMonkiScenario(
  options: ScenarioOptions = {}
): Promise<TaskMonkiScenario> {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `${options.name ?? 'task-monki-scenario'}-`)
  );
  const repositoryPath = path.join(rootDir, 'repo');
  const worktreeRoot = path.join(rootDir, 'worktrees');
  await fs.mkdir(repositoryPath, { recursive: true });
  await initRepository(repositoryPath);

  const store = new FileTaskStore(path.join(rootDir, 'store'));
  const events = new AppEventBus();
  const agent = new ScriptedAgentProviderAdapter(store);
  const service = new TaskManagerService(store, repositoryPath, events, {
    worktreeRoot,
    agentProviderAdapter: agent
  });
  await service.init();

  return {
    rootDir,
    repositoryPath,
    worktreeRoot,
    store,
    events,
    agent,
    service,
    createTask(input = {}) {
      return service.createTask({
        title: input.title ?? 'Scenario task',
        prompt: input.prompt ?? 'Exercise the task workflow.',
        repositoryPath,
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
      const run = await requireRun(store, runId);
      const artifact = await store.writeFinalArtifact(run.taskId, run.id, finalMessage);
      await appendRunEvent(store, run, 'AGENT_RUN_COMPLETED', {
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
      return requireRun(store, runId);
    },
    waitForEvent(predicate, timeoutMs = 3_000) {
      return waitForEvent(events, predicate, timeoutMs);
    },
    waitForSnapshot(predicate, timeoutMs = 3_000) {
      return waitForSnapshot(store, predicate, timeoutMs);
    }
  };
}

export function commandLine(...argv: string[]): string {
  return argv.map(quoteCommandLineArg).join(' ');
}

export class ScriptedAgentProviderAdapter implements AgentProviderAdapter {
  readonly startedTurns: StartAgentTurn[] = [];
  readonly startedReviews: StartAgentReview[] = [];
  ambiguousStart = false;
  ambiguousInterrupt = false;
  private threadCounter = 0;
  private turnCounter = 0;

  constructor(private readonly store: FileTaskStore) {}

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  preflight(): Promise<AgentPreflight> {
    return Promise.resolve({
      provider: 'codex',
      ready: true,
      capabilities: codexCapabilities(),
      problems: [],
      warnings: []
    });
  }

  capabilities(): Promise<AgentProviderCapabilities> {
    return Promise.resolve(codexCapabilities());
  }

  listModels(): Promise<AgentModel[]> {
    return Promise.resolve([
      {
        id: 'scenario-model',
        provider: 'codex',
        model: 'scenario-model',
        displayName: 'Scenario model',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'low',
        serviceTiers: [],
        inputModalities: ['text'],
        isDefault: true
      }
    ]);
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    this.threadCounter += 1;
    return this.store.updateAgentSession(input.localSessionId, {
      providerSessionId: `scenario-thread-${this.threadCounter}`,
      providerSessionTreeId: `scenario-thread-${this.threadCounter}`,
      status: 'IDLE',
      materialized: true,
      requestedSettings: input.settings
    });
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    const session = await this.store.getAgentSession(ref.localSessionId);
    if (!session) {
      throw new Error(`Agent session not found: ${ref.localSessionId}`);
    }
    return session;
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot> {
    const session = await this.attachSession(ref);
    const snapshot = await this.store.snapshot();
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

  steerTurn(_input: SteerAgentTurn): Promise<void> {
    return Promise.resolve();
  }

  async interruptTurn(input: InterruptAgentTurn): Promise<void> {
    if (this.ambiguousInterrupt) {
      throw new AgentMutationAmbiguousError(
        'turn/interrupt',
        'Scenario provider lost the interrupt response.'
      );
    }
    const run = await this.store.getRunByProviderTurnId(input.providerTurnId);
    if (run) {
      await appendRunEvent(this.store, run, 'AGENT_RUN_INTERRUPTED', {
        terminalReason: 'interrupted'
      });
    }
  }

  async startReview(input: StartAgentReview): Promise<AgentTurn> {
    this.startedReviews.push(input);
    this.threadCounter += 1;
    await this.store.updateAgentSession(input.reviewSessionId, {
      providerSessionId: `scenario-review-thread-${this.threadCounter}`,
      providerSessionTreeId: `scenario-review-thread-${this.threadCounter}`,
      status: 'ACTIVE',
      materialized: true
    });
    return this.startRun(input.localRunId, input.reviewSessionId, 'scenario-review');
  }

  respondToInteraction(): Promise<void> {
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
    const run = await requireRun(this.store, localRunId);
    await this.store.updateAgentSession(localSessionId, { status: 'ACTIVE' });
    await this.store.updateRun(localRunId, {
      providerTurnId,
      status: 'RUNNING',
      lastEventAt: new Date().toISOString()
    });
    await appendRunEvent(this.store, run, 'PROCESS_STARTED', {
      pid: 10_000 + this.turnCounter
    });
    return { localRunId, providerTurnId };
  }
}

async function initRepository(repositoryPath: string): Promise<void> {
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Scenario\n', 'utf8');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial scenario commit']);
}

async function requireRun(store: FileTaskStore, runId: string): Promise<RunRecord> {
  const run = await store.getRun(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }
  return run;
}

async function appendRunEvent(
  store: FileTaskStore,
  run: RunRecord,
  type: Extract<
    DomainEvent['type'],
    'PROCESS_STARTED' | 'AGENT_RUN_COMPLETED' | 'AGENT_RUN_INTERRUPTED'
  >,
  payload: Record<string, unknown>
): Promise<void> {
  await store.appendEvent(
    createDomainEvent({
      type,
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      agentSessionId: run.sessionId,
      serverInstanceId: run.serverInstanceId,
      source: type === 'PROCESS_STARTED' ? 'process' : 'provider',
      payload
    })
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
