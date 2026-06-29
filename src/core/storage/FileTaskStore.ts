import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentExecutionSettings,
  AgentGoalSnapshotRecord,
  AgentItemRecord,
  AgentItemStatus,
  AgentProtocolMessageReference,
  AgentPlanRevisionRecord,
  AgentRunMode,
  AgentServerInstance,
  AgentServerStatus,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentSubagentObservationRecord,
  AgentSubagentStatus,
  AgentUsageSnapshotRecord,
  ArtifactKind,
  ArtifactRecord,
  BranchPublicationRecord,
  CiRollupRecord,
  CodexReviewGateStatus,
  CreateTaskRequest,
  DomainEvent,
  GitSnapshotRecord,
  GitHubRepositoryRecord,
  InteractionRequestRecord,
  InteractionRequestStatus,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  RunRecord,
  StatusProjection,
  Task,
  TaskManagerAppSettings,
  TaskIteration,
  TaskSnapshot,
  TestRunRecord,
  UpdateAppSettingsRequest,
  WorktreeRecord
} from '../../shared/contracts';
import {
  DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  TASK_STORE_SCHEMA_VERSION,
  createInitialProjection,
  type CodexExternalToolSettings
} from '../../shared/contracts';
import { AgentProtocolJournal } from '../agent/journal/AgentProtocolJournal';
import { applyEventToState, createEmptyState, type StoreState } from '../projection/reducer';
import { createDomainEvent } from './domainEvent';
import {
  codexReviewStatusFromResult,
  parseCodexReviewResult
} from '../review/CodexReviewContract';

export interface CreateAgentSessionInput {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  provider: string;
  role?: AgentSessionRecord['role'];
  requestedSettings?: AgentExecutionSettings;
  parentSessionId?: string;
  forkedFromSessionId?: string;
}

export interface CreateRunInput {
  task: Task;
  session: AgentSessionRecord;
  mode: AgentRunMode;
  prompt: string;
  serverInstanceId?: string;
  generationKey?: string;
  retryOfRunId?: string;
  continuedFromRunId?: string;
  requestedSettings?: AgentExecutionSettings;
  beforeGitSnapshotId?: string;
}

export interface CreateForkedAlternativeTaskInput extends CreateTaskRequest {
  sourceTaskId: string;
  sourceRunId: string;
}

export interface CreateObservedSubagentRunInput {
  session: AgentSessionRecord;
  providerTurnId: string;
  serverInstanceId: string;
  parentRunId?: string;
  prompt?: string;
  requestedSettings?: AgentExecutionSettings;
}

export interface ObserveSubagentInput {
  parentSessionId: string;
  parentRunId?: string;
  providerChildSessionId: string;
  providerParentSessionId?: string;
  providerForkedFromSessionId?: string;
  source: AgentSubagentObservationRecord['source'];
  status?: AgentSubagentStatus;
  delegatedPrompt?: string;
  requestedSettings?: AgentExecutionSettings;
  providerSessionTreeId?: string;
  providerNickname?: string;
  providerRole?: string;
  agentPath?: string;
  materialized?: boolean;
  rawMessage: AgentProtocolMessageReference;
}

export interface CreateAgentServerInput {
  provider: string;
  runtimeKind: AgentServerInstance['runtimeKind'];
  transport: AgentServerInstance['transport'];
  executable: string;
  argv: string[];
  runtimeVersion?: string;
  schemaVersion?: string;
  schemaHash?: string;
}

interface CreateTestRunInput {
  task: Task;
  worktree: WorktreeRecord;
  gitSnapshot: GitSnapshotRecord;
  commandLine: string;
  executable: string;
  argv: string[];
}

interface PrSyncInput {
  pullRequest: Omit<PullRequestSnapshotRecord, 'id' | 'observedAt'>;
  ci: Omit<CiRollupRecord, 'id' | 'observedAt'>;
  reviews: Omit<ReviewRollupRecord, 'id' | 'observedAt'>;
  merge: Omit<MergeSnapshotRecord, 'id' | 'observedAt'>;
}

interface PersistedState extends StoreState {}

export class FileTaskStore {
  private readonly storePath: string;
  private readonly appSettingsPath: string;
  private readonly artifactsDir: string;
  private readonly protocolJournal: AgentProtocolJournal;
  private state: StoreState = createEmptyState();
  private appSettings: TaskManagerAppSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS;
  private loaded = false;
  private appSettingsLoaded = false;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private appSettingsWriteQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly baseDir: string) {
    this.storePath = path.join(baseDir, 'store.json');
    this.appSettingsPath = path.join(baseDir, 'app-settings.json');
    this.artifactsDir = path.join(baseDir, 'artifacts');
    this.protocolJournal = new AgentProtocolJournal(path.join(baseDir, 'protocol-journals'));
  }

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await fs.mkdir(this.artifactsDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      const normalized = normalizeLoadedState(
        requireCurrentState(JSON.parse(raw) as PersistedState)
      );
      this.state = normalized.state;
      if (normalized.changed) {
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.state = createEmptyState();
      await this.persist();
    }

    this.loaded = true;
  }

  private async initAppSettings(): Promise<void> {
    if (this.appSettingsLoaded) {
      return;
    }

    try {
      const raw = await fs.readFile(this.appSettingsPath, 'utf8');
      this.appSettings = normalizeLoadedAppSettings(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.appSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS;
    }

    this.appSettingsLoaded = true;
  }

  async snapshot(): Promise<TaskSnapshot> {
    await this.init();
    return clone(this.state);
  }

  async getAppSettings(): Promise<TaskManagerAppSettings> {
    await this.initAppSettings();
    return clone(this.appSettings);
  }

  async updateAppSettings(
    input: UpdateAppSettingsRequest
  ): Promise<TaskManagerAppSettings> {
    await this.initAppSettings();
    this.appSettings = normalizeLoadedAppSettings({
      ...this.appSettings,
      ...input
    });
    await this.persistAppSettingsQueued();
    return clone(this.appSettings);
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    await this.init();
    return clone(this.state.tasks.find((task) => task.id === taskId));
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    await this.init();
    return clone(this.state.runs.find((run) => run.id === runId));
  }

  async getRunByProviderTurnId(providerTurnId: string): Promise<RunRecord | undefined> {
    await this.init();
    return clone(this.state.runs.find((run) => run.providerTurnId === providerTurnId));
  }

  async getActiveRunForSession(sessionId: string): Promise<RunRecord | undefined> {
    await this.init();
    return clone(
      this.state.runs.find(
        (run) =>
          run.sessionId === sessionId &&
          [
            'QUEUED',
            'STARTING',
            'RUNNING',
            'AWAITING_APPROVAL',
            'AWAITING_USER_INPUT',
            'INTERRUPTING'
          ].includes(run.status)
      )
    );
  }

  async updateRun(
    runId: string,
    update: Partial<
      Pick<
        RunRecord,
        | 'providerTurnId'
        | 'serverInstanceId'
        | 'status'
        | 'observedSettings'
        | 'recoveryState'
        | 'afterGitSnapshotId'
        | 'terminalReason'
        | 'providerTerminalSource'
        | 'providerTerminalRawMessage'
        | 'lastEventAt'
        | 'endedAt'
        | 'finalArtifactId'
        | 'finalMessage'
      >
    >
  ): Promise<RunRecord> {
    await this.init();
    const existing = this.state.runs.find((run) => run.id === runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }
    const stored = { ...existing, ...update };
    this.state = {
      ...this.state,
      runs: this.state.runs.map((run) => (run.id === runId ? stored : run))
    };
    await this.persistQueued();
    return clone(stored);
  }

  async getAgentServer(serverInstanceId: string): Promise<AgentServerInstance | undefined> {
    await this.init();
    return clone(this.state.agentServers.find((server) => server.id === serverInstanceId));
  }

  async getAgentSession(sessionId: string): Promise<AgentSessionRecord | undefined> {
    await this.init();
    return clone(this.state.agentSessions.find((session) => session.id === sessionId));
  }

  async getAgentSessionByProviderId(
    providerSessionId: string
  ): Promise<AgentSessionRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentSessions.find(
        (session) => session.providerSessionId === providerSessionId
      )
    );
  }

  async getInteractionRequestByProviderId(
    serverInstanceId: string,
    providerRequestId: string | number
  ): Promise<InteractionRequestRecord | undefined> {
    await this.init();
    return clone(
      this.state.interactionRequests.find(
        (request) =>
          request.serverInstanceId === serverInstanceId &&
          request.providerRequestId === providerRequestId
      )
    );
  }

  async getInteractionRequest(
    interactionRequestId: string
  ): Promise<InteractionRequestRecord | undefined> {
    await this.init();
    return clone(
      this.state.interactionRequests.find(
        (request) => request.id === interactionRequestId
      )
    );
  }

  async getAgentItemsForRun(runId: string): Promise<AgentItemRecord[]> {
    await this.init();
    return clone(this.state.agentItems.filter((item) => item.runId === runId));
  }

  async getAgentItemByProviderId(
    runId: string,
    providerItemId: string
  ): Promise<AgentItemRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentItems.find(
        (item) => item.runId === runId && item.providerItemId === providerItemId
      )
    );
  }

  async getRunsRequiringRecovery(): Promise<RunRecord[]> {
    await this.init();
    return clone(
      this.state.runs.filter((run) =>
        ['RECOVERY_REQUIRED', 'RUNNING', 'STARTING', 'INTERRUPTING'].includes(run.status)
      )
    );
  }

  async getIteration(iterationId: string): Promise<TaskIteration | undefined> {
    await this.init();
    return clone(this.state.iterations.find((iteration) => iteration.id === iterationId));
  }

  async getWorktree(worktreeId: string): Promise<WorktreeRecord | undefined> {
    await this.init();
    return clone(this.state.worktrees.find((worktree) => worktree.id === worktreeId));
  }

  async getPrimaryAgentSession(
    taskId: string,
    iterationId: string
  ): Promise<AgentSessionRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentSessions.find(
        (session) =>
          session.taskId === taskId &&
          session.iterationId === iterationId &&
          session.role === 'PRIMARY'
      )
    );
  }

  async getCurrentIteration(taskId: string): Promise<TaskIteration | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    return clone(this.state.iterations.find((iteration) => iteration.id === task?.currentIterationId));
  }

  async getCurrentWorktree(taskId: string): Promise<WorktreeRecord | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    return clone(this.state.worktrees.find((worktree) => worktree.id === task?.currentWorktreeId));
  }

  async getLatestGitSnapshot(taskId: string): Promise<GitSnapshotRecord | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    const iterationId = task?.currentIterationId;
    return clone(
      this.state.gitSnapshots
        .filter((snapshot) => snapshot.taskId === taskId && snapshot.iterationId === iterationId)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0]
    );
  }

  async getLatestPullRequest(taskId: string): Promise<PullRequestSnapshotRecord | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    return clone(
      this.state.pullRequests
        .filter((pr) => pr.taskId === taskId && pr.iterationId === task?.currentIterationId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
    );
  }

  async createTask(input: CreateTaskRequest): Promise<Task> {
    return this.createTaskRecord(input, 'ui');
  }

  async createForkedAlternativeTask(input: CreateForkedAlternativeTaskInput): Promise<Task> {
    return this.createTaskRecord(input, 'ui', {
      sourceTaskId: input.sourceTaskId,
      sourceRunId: input.sourceRunId
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.init();

    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const runIds = new Set(
      this.state.runs.filter((run) => run.taskId === taskId).map((run) => run.id)
    );
    const sessionIds = new Set(
      this.state.agentSessions
        .filter((session) => session.taskId === taskId)
        .map((session) => session.id)
    );
    const worktreeIds = new Set(
      this.state.worktrees
        .filter((worktree) => worktree.taskId === taskId)
        .map((worktree) => worktree.id)
    );
    const testRunIds = new Set(
      this.state.testRuns
        .filter((testRun) => testRun.taskId === taskId)
        .map((testRun) => testRun.id)
    );
    const artifactsToDelete = this.state.artifacts.filter(
      (artifact) =>
        artifact.taskId === taskId ||
        (artifact.runId ? runIds.has(artifact.runId) : false) ||
        (artifact.testRunId ? testRunIds.has(artifact.testRunId) : false)
    );
    const artifactIds = new Set(artifactsToDelete.map((artifact) => artifact.id));
    const now = new Date().toISOString();

    this.state = {
      ...this.state,
      tasks: this.state.tasks
        .filter((candidate) => candidate.id !== taskId)
        .map((candidate) => removeTaskLink(candidate, taskId, now)),
      iterations: this.state.iterations.filter((iteration) => iteration.taskId !== taskId),
      worktrees: this.state.worktrees.filter((worktree) => worktree.taskId !== taskId),
      gitSnapshots: this.state.gitSnapshots.filter((snapshot) => snapshot.taskId !== taskId),
      testRuns: this.state.testRuns.filter((testRun) => testRun.taskId !== taskId),
      githubRepositories: this.state.githubRepositories.filter(
        (record) => record.taskId !== taskId
      ),
      branchPublications: this.state.branchPublications.filter(
        (record) => record.taskId !== taskId
      ),
      pullRequests: this.state.pullRequests.filter((record) => record.taskId !== taskId),
      ciRollups: this.state.ciRollups.filter((record) => record.taskId !== taskId),
      reviewRollups: this.state.reviewRollups.filter((record) => record.taskId !== taskId),
      mergeSnapshots: this.state.mergeSnapshots.filter((record) => record.taskId !== taskId),
      runs: this.state.runs.filter((run) => run.taskId !== taskId),
      agentSessions: this.state.agentSessions.filter((session) => session.taskId !== taskId),
      agentItems: this.state.agentItems.filter(
        (item) =>
          item.taskId !== taskId &&
          !runIds.has(item.runId) &&
          !sessionIds.has(item.sessionId)
      ),
      agentGoalSnapshots: this.state.agentGoalSnapshots.filter(
        (goal) => goal.taskId !== taskId && !sessionIds.has(goal.sessionId)
      ),
      agentPlanRevisions: this.state.agentPlanRevisions.filter(
        (plan) =>
          plan.taskId !== taskId &&
          !runIds.has(plan.runId) &&
          !sessionIds.has(plan.sessionId)
      ),
      agentUsageSnapshots: this.state.agentUsageSnapshots.filter(
        (usage) =>
          usage.taskId !== taskId &&
          (usage.runId ? !runIds.has(usage.runId) : true) &&
          !sessionIds.has(usage.sessionId)
      ),
      agentSettingsObservations: this.state.agentSettingsObservations.filter(
        (observation) =>
          observation.taskId !== taskId && !sessionIds.has(observation.sessionId)
      ),
      agentSubagentObservations: this.state.agentSubagentObservations.filter(
        (observation) =>
          observation.taskId !== taskId &&
          !sessionIds.has(observation.sessionId) &&
          !sessionIds.has(observation.parentSessionId)
      ),
      interactionRequests: this.state.interactionRequests.filter(
        (request) =>
          request.taskId !== taskId &&
          !runIds.has(request.runId) &&
          !sessionIds.has(request.sessionId)
      ),
      events: this.state.events.filter(
        (event) =>
          !eventBelongsToDeletedTask(event, taskId, {
            runIds,
            sessionIds,
            worktreeIds,
            testRunIds
          })
      ),
      artifacts: this.state.artifacts.filter((artifact) => !artifactIds.has(artifact.id))
    };

    await this.persistQueued();
    await Promise.all(artifactsToDelete.map((artifact) => unlinkIfExists(artifact.path)));
  }

  private async createTaskRecord(
    input: CreateTaskRequest,
    source: DomainEvent['source'],
    fork?: { sourceTaskId: string; sourceRunId: string }
  ): Promise<Task> {
    await this.init();

    const now = new Date().toISOString();
    const sourceTask = fork
      ? this.state.tasks.find((candidate) => candidate.id === fork.sourceTaskId)
      : undefined;
    const sourceRun = fork
      ? this.state.runs.find(
          (candidate) =>
            candidate.id === fork.sourceRunId && candidate.taskId === fork.sourceTaskId
        )
      : undefined;
    if (fork && (!sourceTask || !sourceRun)) {
      throw new Error('Fork source task or run was not found.');
    }
    const task: Task = {
      id: randomUUID(),
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      repositoryPath: input.repositoryPath.trim(),
      workflowPhase: 'READY',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 1,
      testCommand: input.testCommand?.trim() || 'npm test',
      forkedAlternativeTaskIds: [],
      forkedFromTaskId: fork?.sourceTaskId,
      forkedFromRunId: fork?.sourceRunId,
      agentSettings: input.agentSettings ?? {},
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };

    if (!task.title) {
      throw new Error('Task title is required.');
    }
    if (!task.prompt) {
      throw new Error('Task prompt is required.');
    }
    if (!task.repositoryPath) {
      throw new Error('Repository path is required.');
    }

    this.state = {
      ...this.state,
      tasks: [
        task,
        ...this.state.tasks.map((existing) =>
          fork && existing.id === fork.sourceTaskId
            ? {
                ...existing,
                forkedAlternativeTaskIds: uniqueIds([
                  ...(existing.forkedAlternativeTaskIds ?? []),
                  task.id
                ]),
                updatedAt: now
              }
            : existing
        )
      ]
    };

    this.state = applyEventToState(
      this.state,
      createDomainEvent({
        type: 'TASK_CREATED',
        taskId: task.id,
        source,
        payload: {
          title: task.title,
          repositoryPath: task.repositoryPath,
          testCommand: task.testCommand,
          forkedFromTaskId: task.forkedFromTaskId,
          forkedFromRunId: task.forkedFromRunId
        }
      })
    );

    if (fork) {
      this.state = applyEventToState(
        this.state,
        createDomainEvent({
          type: 'TASK_ALTERNATIVE_CREATED',
          taskId: fork.sourceTaskId,
          runId: fork.sourceRunId,
          source,
          payload: {
            alternativeTaskId: task.id,
            alternativeTitle: task.title
          }
        })
      );
    }

    await this.persistQueued();
    return clone(task);
  }

  async createAgentServer(input: CreateAgentServerInput): Promise<AgentServerInstance> {
    await this.init();

    const now = new Date().toISOString();
    const id = randomUUID();
    const server: AgentServerInstance = {
      id,
      provider: input.provider,
      runtimeKind: input.runtimeKind,
      transport: input.transport,
      status: 'STARTING',
      executable: input.executable,
      argv: [...input.argv],
      runtimeVersion: input.runtimeVersion,
      schemaVersion: input.schemaVersion,
      schemaHash: input.schemaHash,
      protocolJournalPath: this.protocolJournal.pathFor(id),
      startedAt: now
    };

    this.state = {
      ...this.state,
      agentServers: [server, ...this.state.agentServers]
    };
    await this.persistQueued();
    return clone(server);
  }

  async updateAgentServer(
    serverInstanceId: string,
    update: Partial<
      Pick<
        AgentServerInstance,
        | 'status'
        | 'pid'
        | 'runtimeVersion'
        | 'schemaVersion'
        | 'schemaHash'
        | 'initializedAt'
        | 'lastHealthAt'
        | 'disconnectedAt'
        | 'exitedAt'
        | 'exitCode'
        | 'signal'
        | 'exitReason'
      >
    >
  ): Promise<AgentServerInstance> {
    await this.init();
    const existing = this.state.agentServers.find((server) => server.id === serverInstanceId);
    if (!existing) {
      throw new Error(`Agent server instance not found: ${serverInstanceId}`);
    }
    validateAgentServerTransition(existing.status, update.status);
    const stored = { ...existing, ...update };
    this.state = {
      ...this.state,
      agentServers: this.state.agentServers.map((server) =>
        server.id === serverInstanceId ? stored : server
      )
    };
    await this.persistQueued();
    return clone(stored);
  }

  appendProtocolMessage(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    return this.protocolJournal.append(serverInstanceId, direction, raw, metadata);
  }

  async readProtocolMessage(reference: AgentProtocolMessageReference) {
    await this.init();
    if (
      !Number.isInteger(reference.sequence) ||
      reference.sequence <= 0 ||
      !Number.isInteger(reference.byteOffset) ||
      reference.byteOffset < 0 ||
      !Number.isInteger(reference.byteLength) ||
      reference.byteLength <= 0 ||
      reference.byteLength > 10 * 1024 * 1024
    ) {
      throw new Error('Protocol journal reference is invalid.');
    }
    if (!this.state.agentServers.some((server) => server.id === reference.serverInstanceId)) {
      throw new Error('Protocol journal server instance is not owned by this store.');
    }
    return this.protocolJournal.read(reference);
  }

  async getLatestAgentGoalSnapshot(
    sessionId: string
  ): Promise<AgentGoalSnapshotRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentGoalSnapshots
        .filter((record) => record.sessionId === sessionId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
    );
  }

  async recordAgentGoalSnapshot(
    record: Omit<AgentGoalSnapshotRecord, 'id' | 'observedAt'>
  ): Promise<AgentGoalSnapshotRecord> {
    await this.init();
    const stored: AgentGoalSnapshotRecord = {
      ...record,
      id: randomUUID(),
      observedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentGoalSnapshots: [stored, ...this.state.agentGoalSnapshots]
    };
    await this.appendEvent(
      createDomainEvent({
        type:
          stored.source === 'PROVIDER_CLEARED'
            ? 'AGENT_GOAL_CLEARED'
            : stored.source === 'SYNC_ERROR'
              ? 'AGENT_GOAL_SYNC_FAILED'
              : 'AGENT_GOAL_UPDATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        agentSessionId: stored.sessionId,
        source: 'provider',
        payload: {
          syncState: stored.syncState,
          providerStatus: stored.providerStatus,
          source: stored.source
        }
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async recordAgentPlanRevision(
    record: Omit<AgentPlanRevisionRecord, 'id' | 'revision' | 'observedAt'>
  ): Promise<AgentPlanRevisionRecord> {
    await this.init();
    const revision =
      this.state.agentPlanRevisions.filter((item) => item.runId === record.runId)
        .length + 1;
    const stored: AgentPlanRevisionRecord = {
      ...record,
      id: randomUUID(),
      revision,
      observedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentPlanRevisions: [stored, ...this.state.agentPlanRevisions]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_PLAN_REVISED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        agentSessionId: stored.sessionId,
        source: 'provider',
        payload: { revision: stored.revision, stepCount: stored.steps.length }
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async recordAgentUsageSnapshot(
    record: Omit<AgentUsageSnapshotRecord, 'id' | 'observedAt'>
  ): Promise<AgentUsageSnapshotRecord> {
    await this.init();
    const stored: AgentUsageSnapshotRecord = {
      ...record,
      id: randomUUID(),
      observedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentUsageSnapshots: [stored, ...this.state.agentUsageSnapshots]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_USAGE_UPDATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        agentSessionId: stored.sessionId,
        source: 'provider',
        payload: {
          totalTokens: stored.total.totalTokens,
          modelContextWindow: stored.modelContextWindow
        }
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async recordAgentSettingsObservation(
    record: Omit<AgentSettingsObservationRecord, 'id' | 'observedAt'>
  ): Promise<AgentSettingsObservationRecord> {
    await this.init();
    const stored: AgentSettingsObservationRecord = {
      ...record,
      id: randomUUID(),
      observedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentSettingsObservations: [
        stored,
        ...this.state.agentSettingsObservations
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_SETTINGS_OBSERVED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        agentSessionId: stored.sessionId,
        source: 'provider',
        payload: { source: stored.source, settings: stored.settings }
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async createAgentSession(input: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    await this.init();
    if (input.iteration.taskId !== input.task.id || input.worktree.taskId !== input.task.id) {
      throw new Error('Agent session task, iteration, and worktree must have the same owner.');
    }
    if (input.worktree.iterationId !== input.iteration.id) {
      throw new Error('Agent session worktree must belong to the selected iteration.');
    }

    const role = input.role ?? 'PRIMARY';
    const existing =
      role === 'PRIMARY'
        ? this.state.agentSessions.find(
            (session) =>
              session.taskId === input.task.id &&
              session.iterationId === input.iteration.id &&
              session.role === 'PRIMARY'
          )
        : undefined;
    if (existing) {
      return clone(existing);
    }

    const now = new Date().toISOString();
    const session: AgentSessionRecord = {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      provider: input.provider,
      role,
      parentSessionId: input.parentSessionId,
      forkedFromSessionId: input.forkedFromSessionId,
      relationshipState:
        role === 'SUBAGENT'
          ? input.parentSessionId
            ? 'RESOLVED'
            : 'UNRESOLVED'
          : input.parentSessionId || input.forkedFromSessionId
            ? 'RESOLVED'
            : 'ROOT',
      worktreePath: input.worktree.worktreePath,
      status: 'NOT_MATERIALIZED',
      materialized: false,
      requestedSettings: input.requestedSettings ?? {},
      ownership: 'TASK_MONKI',
      createdAt: now,
      updatedAt: now
    };

    this.state = {
      ...this.state,
      agentSessions: [session, ...this.state.agentSessions],
      tasks: this.state.tasks.map((task) =>
        task.id === input.task.id && role === 'PRIMARY'
          ? { ...task, currentAgentSessionId: session.id, updatedAt: now }
          : task
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_SESSION_CREATED',
        taskId: input.task.id,
        iterationId: input.iteration.id,
        worktreeId: input.worktree.id,
        agentSessionId: session.id,
        source: 'provider',
        payload: {
          provider: session.provider,
          role: session.role,
          worktreePath: session.worktreePath
        }
      }),
      false
    );
    await this.persistQueued();
    return clone(session);
  }

  async updateAgentSession(
    sessionId: string,
    update: Partial<
      Pick<
        AgentSessionRecord,
        | 'providerSessionId'
        | 'providerSessionTreeId'
        | 'parentSessionId'
        | 'forkedFromSessionId'
        | 'providerParentSessionId'
        | 'providerForkedFromSessionId'
        | 'parentRunId'
        | 'relationshipState'
        | 'relationshipDetail'
        | 'providerNickname'
        | 'providerRole'
        | 'delegatedPrompt'
        | 'agentPath'
        | 'subagentStatus'
        | 'status'
        | 'materialized'
        | 'observedSettings'
        | 'requestedSettings'
        | 'lastAttachedAt'
      >
    >
  ): Promise<AgentSessionRecord> {
    await this.init();
    const existing = this.state.agentSessions.find((session) => session.id === sessionId);
    if (!existing) {
      throw new Error(`Agent session not found: ${sessionId}`);
    }
    const stored: AgentSessionRecord = {
      ...existing,
      ...update,
      updatedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentSessions: this.state.agentSessions.map((session) =>
        session.id === sessionId ? stored : session
      )
    };
    await this.persistQueued();
    return clone(stored);
  }

  async observeSubagent(
    input: ObserveSubagentInput
  ): Promise<{
    session: AgentSessionRecord;
    observation: AgentSubagentObservationRecord;
  }> {
    await this.init();
    const parent = this.state.agentSessions.find(
      (session) => session.id === input.parentSessionId
    );
    if (!parent) {
      throw new Error(`Parent agent session not found: ${input.parentSessionId}`);
    }

    const existing = this.state.agentSessions.find(
      (session) => session.providerSessionId === input.providerChildSessionId
    );
    if (existing && existing.taskId !== parent.taskId) {
      throw new Error(
        `Provider child thread ${input.providerChildSessionId} is already owned by another task.`
      );
    }

    const relationshipProblems = [
      input.providerChildSessionId === parent.providerSessionId
        ? 'Provider reported a thread as its own child.'
        : undefined,
      input.providerParentSessionId &&
      parent.providerSessionId &&
      input.providerParentSessionId !== parent.providerSessionId
        ? `Supplied parent thread ${input.providerParentSessionId} does not match local parent ${parent.providerSessionId}.`
        : undefined,
      existing?.parentSessionId && existing.parentSessionId !== parent.id
        ? `Child was already linked to local parent ${existing.parentSessionId}.`
        : undefined,
      existing?.parentRunId &&
      input.parentRunId &&
      existing.parentRunId !== input.parentRunId
        ? `Child was already linked to parent run ${existing.parentRunId}.`
        : undefined
    ].filter((problem): problem is string => Boolean(problem));
    const relationshipState =
      relationshipProblems.length > 0 ? 'CONTRADICTORY' : 'RESOLVED';
    const now = new Date().toISOString();
    const requestedSettings = {
      ...(existing?.requestedSettings ?? {}),
      ...(input.requestedSettings ?? {})
    };
    const stored: AgentSessionRecord = existing
      ? {
          ...existing,
          role: 'SUBAGENT',
          providerSessionTreeId:
            input.providerSessionTreeId ?? existing.providerSessionTreeId,
          parentSessionId:
            relationshipState === 'RESOLVED'
              ? existing.parentSessionId ?? parent.id
              : existing.parentSessionId,
          providerParentSessionId:
            input.providerParentSessionId ?? existing.providerParentSessionId,
          providerForkedFromSessionId:
            input.providerForkedFromSessionId ??
            existing.providerForkedFromSessionId,
          parentRunId:
            relationshipState === 'RESOLVED'
              ? existing.parentRunId ?? input.parentRunId
              : existing.parentRunId,
          relationshipState,
          relationshipDetail:
            relationshipProblems.join(' ') || existing.relationshipDetail,
          providerNickname: input.providerNickname ?? existing.providerNickname,
          providerRole: input.providerRole ?? existing.providerRole,
          delegatedPrompt:
            existing.delegatedPrompt ?? input.delegatedPrompt,
          agentPath: input.agentPath ?? existing.agentPath,
          subagentStatus: input.status ?? existing.subagentStatus,
          status:
            input.status === 'RUNNING'
              ? 'ACTIVE'
              : input.status === 'ERRORED'
                ? 'SYSTEM_ERROR'
                : existing.status,
          materialized: input.materialized ?? existing.materialized,
          requestedSettings,
          updatedAt: now
        }
      : {
          id: randomUUID(),
          taskId: parent.taskId,
          iterationId: parent.iterationId,
          worktreeId: parent.worktreeId,
          provider: parent.provider,
          role: 'SUBAGENT',
          providerSessionId: input.providerChildSessionId,
          providerSessionTreeId: input.providerSessionTreeId,
          parentSessionId: relationshipState === 'RESOLVED' ? parent.id : undefined,
          providerParentSessionId: input.providerParentSessionId,
          providerForkedFromSessionId: input.providerForkedFromSessionId,
          parentRunId:
            relationshipState === 'RESOLVED' ? input.parentRunId : undefined,
          relationshipState,
          relationshipDetail: relationshipProblems.join(' ') || undefined,
          providerNickname: input.providerNickname,
          providerRole: input.providerRole,
          delegatedPrompt: input.delegatedPrompt,
          agentPath: input.agentPath,
          subagentStatus: input.status,
          worktreePath: parent.worktreePath,
          status:
            input.status === 'RUNNING'
              ? 'ACTIVE'
              : input.status === 'ERRORED'
                ? 'SYSTEM_ERROR'
                : 'UNKNOWN',
          materialized: input.materialized ?? false,
          requestedSettings,
          ownership: 'TASK_MONKI',
          createdAt: now,
          updatedAt: now
        };

    const observation: AgentSubagentObservationRecord = {
      id: randomUUID(),
      taskId: stored.taskId,
      iterationId: stored.iterationId,
      sessionId: stored.id,
      parentSessionId: parent.id,
      parentRunId: input.parentRunId,
      providerChildSessionId: input.providerChildSessionId,
      providerParentSessionId: input.providerParentSessionId,
      providerForkedFromSessionId: input.providerForkedFromSessionId,
      source: input.source,
      relationshipState,
      status: input.status,
      delegatedPrompt: input.delegatedPrompt,
      requestedSettings: input.requestedSettings,
      providerNickname: input.providerNickname,
      providerRole: input.providerRole,
      agentPath: input.agentPath,
      detail: relationshipProblems.join(' ') || undefined,
      rawMessage: input.rawMessage,
      observedAt: now
    };

    this.state = {
      ...this.state,
      agentSessions: existing
        ? this.state.agentSessions.map((session) =>
            session.id === existing.id ? stored : session
          )
        : [stored, ...this.state.agentSessions],
      agentSubagentObservations: [
        observation,
        ...this.state.agentSubagentObservations
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type:
          relationshipState === 'CONTRADICTORY'
            ? 'AGENT_SUBAGENT_RELATIONSHIP_UNRESOLVED'
            : existing
              ? 'AGENT_SUBAGENT_UPDATED'
              : 'AGENT_SUBAGENT_DISCOVERED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: input.parentRunId,
        worktreeId: stored.worktreeId,
        agentSessionId: stored.id,
        source: 'provider',
        payload: {
          parentSessionId: parent.id,
          providerChildSessionId: input.providerChildSessionId,
          providerParentSessionId: input.providerParentSessionId,
          source: input.source,
          relationshipState,
          status: input.status,
          detail: observation.detail
        }
      }),
      false
    );
    await this.persistQueued();
    return { session: clone(stored), observation: clone(observation) };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    await this.init();

    if (input.session.taskId !== input.task.id) {
      throw new Error('Run session must belong to the task.');
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const promptArtifact = await this.createArtifactRecord(input.task.id, 'agent-prompt', { runId });
    const outputArtifact = await this.createArtifactRecord(input.task.id, 'agent-output', { runId });
    const diagnosticArtifact = await this.createArtifactRecord(input.task.id, 'agent-diagnostics', {
      runId
    });
    await Promise.all([
      fs.writeFile(promptArtifact.path, input.prompt, { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(outputArtifact.path, '', { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(diagnosticArtifact.path, '', { encoding: 'utf8', mode: 0o600 })
    ]);
    promptArtifact.byteCount = Buffer.byteLength(input.prompt);

    const run: RunRecord = {
      id: runId,
      taskId: input.task.id,
      iterationId: input.session.iterationId,
      worktreeId: input.session.worktreeId,
      sessionId: input.session.id,
      serverInstanceId: input.serverInstanceId,
      mode: input.mode,
      origin: 'TASK_MONKI',
      generationKey: input.generationKey,
      retryOfRunId: input.retryOfRunId,
      continuedFromRunId: input.continuedFromRunId,
      status: 'QUEUED',
      recoveryState: 'NONE',
      requestedSettings: input.requestedSettings ?? input.session.requestedSettings,
      promptArtifactId: promptArtifact.id,
      outputArtifactId: outputArtifact.id,
      diagnosticArtifactId: diagnosticArtifact.id,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      startedAt: now,
      eventCount: 0
    };
    const startsWorkflow = input.mode !== 'REVIEW';
    const reviewedSnapshot = input.beforeGitSnapshotId
      ? this.state.gitSnapshots.find((snapshot) => snapshot.id === input.beforeGitSnapshotId)
      : undefined;

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((existing) =>
        existing.id === input.task.id
          ? {
              ...existing,
              workflowPhase: startsWorkflow ? 'IN_PROGRESS' : existing.workflowPhase,
              currentRunId: startsWorkflow ? run.id : existing.currentRunId,
              currentAgentSessionId: startsWorkflow
                ? input.session.id
                : existing.currentAgentSessionId,
              currentIterationId: startsWorkflow
                ? input.session.iterationId
                : existing.currentIterationId,
              currentWorktreeId: startsWorkflow
                ? input.session.worktreeId
                : existing.currentWorktreeId,
              phaseVersion: startsWorkflow ? existing.phaseVersion + 1 : existing.phaseVersion,
              updatedAt: now
            }
          : existing
      ),
      runs: [run, ...this.state.runs],
      artifacts: [
        promptArtifact,
        outputArtifact,
        diagnosticArtifact,
        ...this.state.artifacts
      ]
    };

    if (startsWorkflow) {
      await this.appendEvent(
        createDomainEvent({
          type: 'TRANSITION_REQUESTED',
          taskId: input.task.id,
          iterationId: input.session.iterationId,
          runId: run.id,
          worktreeId: input.session.worktreeId,
          agentSessionId: input.session.id,
          serverInstanceId: input.serverInstanceId,
          source: 'ui',
          payload: { fromPhase: input.task.workflowPhase, toPhase: 'IN_PROGRESS' }
        }),
        false
      );
    }

    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_STARTED',
        taskId: input.task.id,
        iterationId: input.session.iterationId,
        runId: run.id,
        worktreeId: input.session.worktreeId,
        agentSessionId: input.session.id,
        serverInstanceId: input.serverInstanceId,
        source: 'provider',
        payload: {
          mode: run.mode,
          generationKey: run.generationKey,
          requestedSettings: run.requestedSettings,
          beforeGitSnapshotId: run.beforeGitSnapshotId,
          reviewedHeadSha: reviewedSnapshot?.headSha,
          reviewedDirtyFingerprint: reviewedSnapshot?.dirtyFingerprint
        }
      }),
      false
    );

    await this.persistQueued();
    return clone(run);
  }

  async createObservedSubagentRun(
    input: CreateObservedSubagentRunInput
  ): Promise<RunRecord> {
    await this.init();
    const existing = this.state.runs.find(
      (run) => run.providerTurnId === input.providerTurnId
    );
    if (existing) {
      return clone(existing);
    }
    if (input.session.role !== 'SUBAGENT') {
      throw new Error('Only observed subagent sessions may create observed child runs.');
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const prompt =
      input.prompt ??
      input.session.delegatedPrompt ??
      'Provider-observed subagent turn.';
    const promptArtifact = await this.createArtifactRecord(
      input.session.taskId,
      'agent-prompt',
      { runId }
    );
    const outputArtifact = await this.createArtifactRecord(
      input.session.taskId,
      'agent-output',
      { runId }
    );
    const diagnosticArtifact = await this.createArtifactRecord(
      input.session.taskId,
      'agent-diagnostics',
      { runId }
    );
    await Promise.all([
      fs.writeFile(promptArtifact.path, prompt, { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(outputArtifact.path, '', { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(diagnosticArtifact.path, '', { encoding: 'utf8', mode: 0o600 })
    ]);
    promptArtifact.byteCount = Buffer.byteLength(prompt);

    const run: RunRecord = {
      id: runId,
      taskId: input.session.taskId,
      iterationId: input.session.iterationId,
      worktreeId: input.session.worktreeId,
      sessionId: input.session.id,
      serverInstanceId: input.serverInstanceId,
      providerTurnId: input.providerTurnId,
      mode: 'SUBAGENT',
      origin: 'PROVIDER_SUBAGENT',
      parentRunId: input.parentRunId ?? input.session.parentRunId,
      status: 'RUNNING',
      recoveryState: 'NONE',
      requestedSettings:
        input.requestedSettings ?? input.session.requestedSettings,
      promptArtifactId: promptArtifact.id,
      outputArtifactId: outputArtifact.id,
      diagnosticArtifactId: diagnosticArtifact.id,
      startedAt: now,
      lastEventAt: now,
      eventCount: 0
    };
    this.state = {
      ...this.state,
      runs: [run, ...this.state.runs],
      artifacts: [
        promptArtifact,
        outputArtifact,
        diagnosticArtifact,
        ...this.state.artifacts
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_STARTED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: {
          mode: run.mode,
          origin: run.origin,
          parentRunId: run.parentRunId,
          providerTurnId: run.providerTurnId,
          observedSubagent: true,
          requestedSettings: run.requestedSettings
        }
      }),
      false
    );
    await this.persistQueued();
    return clone(run);
  }

  async upsertAgentItem(
    item: Omit<AgentItemRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ): Promise<AgentItemRecord> {
    await this.init();
    const run = this.state.runs.find((candidate) => candidate.id === item.runId);
    if (
      !run ||
      run.taskId !== item.taskId ||
      run.iterationId !== item.iterationId ||
      run.sessionId !== item.sessionId
    ) {
      throw new Error('Agent item ownership does not match its run.');
    }

    const existing = this.state.agentItems.find(
      (candidate) =>
        candidate.runId === item.runId &&
        candidate.providerItemId === item.providerItemId
    );
    if (existing) {
      validateAgentItemTransition(existing.status, item.status);
    }
    const now = new Date().toISOString();
    const stored: AgentItemRecord = existing
      ? {
          ...existing,
          ...item,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: now
        }
      : {
          ...item,
          id: item.id ?? randomUUID(),
          createdAt: now,
          updatedAt: now
        };

    this.state = {
      ...this.state,
      agentItems: existing
        ? this.state.agentItems.map((candidate) =>
            candidate.id === existing.id ? stored : candidate
          )
        : [stored, ...this.state.agentItems]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_ITEM_UPDATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        worktreeId: run.worktreeId,
        agentSessionId: stored.sessionId,
        agentItemId: stored.id,
        source: 'provider',
        payload: {
          providerItemId: stored.providerItemId,
          type: stored.type,
          status: stored.status
        }
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async createInteractionRequest(
    input: Omit<InteractionRequestRecord, 'id' | 'status' | 'requestedAt'>
  ): Promise<InteractionRequestRecord> {
    await this.init();
    const run = this.state.runs.find((candidate) => candidate.id === input.runId);
    if (
      !run ||
      run.taskId !== input.taskId ||
      run.iterationId !== input.iterationId ||
      run.sessionId !== input.sessionId ||
      run.serverInstanceId !== input.serverInstanceId
    ) {
      throw new Error('Interaction request ownership does not match its run.');
    }
    const duplicate = this.state.interactionRequests.find(
      (request) =>
        request.serverInstanceId === input.serverInstanceId &&
        request.providerRequestId === input.providerRequestId
    );
    if (duplicate) {
      return clone(duplicate);
    }

    const stored: InteractionRequestRecord = {
      ...input,
      id: randomUUID(),
      status: 'PENDING',
      requestedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      interactionRequests: [stored, ...this.state.interactionRequests]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_INTERACTION_REQUESTED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        worktreeId: run.worktreeId,
        agentSessionId: stored.sessionId,
        serverInstanceId: stored.serverInstanceId,
        interactionRequestId: stored.id,
        source: 'provider',
        payload: { type: stored.type, providerRequestId: stored.providerRequestId }
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async transitionInteractionRequest(
    interactionRequestId: string,
    expectedStatus: InteractionRequestStatus,
    update: Partial<
      Pick<
        InteractionRequestRecord,
        | 'status'
        | 'decision'
        | 'responseRawMessage'
        | 'resolution'
        | 'respondedAt'
        | 'resolvedAt'
      >
    >
  ): Promise<InteractionRequestRecord> {
    await this.init();
    const existing = this.state.interactionRequests.find(
      (request) => request.id === interactionRequestId
    );
    if (!existing) {
      throw new Error(`Interaction request not found: ${interactionRequestId}`);
    }
    if (existing.status !== expectedStatus) {
      throw new Error(
        `Interaction request ${interactionRequestId} is ${existing.status}; expected ${expectedStatus}.`
      );
    }
    const nextStatus = update.status ?? existing.status;
    validateInteractionTransition(existing.status, nextStatus);
    const stored: InteractionRequestRecord = { ...existing, ...update, status: nextStatus };
    this.state = {
      ...this.state,
      interactionRequests: this.state.interactionRequests.map((request) =>
        request.id === interactionRequestId ? stored : request
      )
    };

    if (isInteractionTerminal(nextStatus)) {
      const run = this.state.runs.find((candidate) => candidate.id === stored.runId);
      await this.appendEvent(
        createDomainEvent({
          type: 'AGENT_INTERACTION_RESOLVED',
          taskId: stored.taskId,
          iterationId: stored.iterationId,
          runId: stored.runId,
          worktreeId: run?.worktreeId,
          agentSessionId: stored.sessionId,
          serverInstanceId: stored.serverInstanceId,
          interactionRequestId: stored.id,
          source: 'provider',
          payload: { type: stored.type, status: stored.status }
        }),
        false
      );
    }

    await this.persistQueued();
    return clone(stored);
  }

  async createIterationAndWorktree(input: {
    task: Task;
    branchName: string;
    worktreePath: string;
    baseRef?: string;
    baseSha: string;
  }): Promise<{ iteration: TaskIteration; worktree: WorktreeRecord }> {
    await this.init();

    const now = new Date().toISOString();
    const iteration: TaskIteration = {
      id: randomUUID(),
      taskId: input.task.id,
      actionRequestId: randomUUID(),
      generationKey: randomUUID(),
      status: 'ACTIVE',
      branchName: input.branchName,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      createdAt: now,
      updatedAt: now
    };
    const worktree: WorktreeRecord = {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: iteration.id,
      repositoryPath: input.task.repositoryPath,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      status: 'CREATING',
      createdAt: now,
      updatedAt: now
    };
    const storedIteration = { ...iteration, worktreeId: worktree.id };

    this.state = {
      ...this.state,
      iterations: [storedIteration, ...this.state.iterations],
      worktrees: [worktree, ...this.state.worktrees],
      tasks: this.state.tasks.map((existing) =>
        existing.id === input.task.id
          ? {
              ...existing,
              currentIterationId: storedIteration.id,
              currentWorktreeId: worktree.id,
              updatedAt: now
            }
          : existing
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TASK_ITERATION_CREATED',
        taskId: input.task.id,
        iterationId: storedIteration.id,
        worktreeId: worktree.id,
        source: 'ui',
        payload: {
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          baseSha: input.baseSha
        }
      }),
      false
    );

    await this.appendEvent(
      createDomainEvent({
        type: 'WORKTREE_CREATE_REQUESTED',
        taskId: input.task.id,
        iterationId: storedIteration.id,
        worktreeId: worktree.id,
        source: 'git',
        payload: {
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          baseSha: input.baseSha
        }
      }),
      false
    );

    await this.persistQueued();
    return { iteration: clone(storedIteration), worktree: clone(worktree) };
  }

  async updateWorktree(worktree: WorktreeRecord, eventType: 'WORKTREE_CREATED' | 'WORKTREE_VERIFIED' | 'WORKTREE_FAILED'): Promise<WorktreeRecord> {
    await this.init();
    const now = new Date().toISOString();
    const stored: WorktreeRecord = {
      ...worktree,
      updatedAt: now,
      lastVerifiedAt: eventType === 'WORKTREE_FAILED' ? worktree.lastVerifiedAt : now
    };

    this.state = {
      ...this.state,
      worktrees: this.state.worktrees.map((candidate) =>
        candidate.id === stored.id ? stored : candidate
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: eventType,
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.id,
        source: 'git',
        payload: {
          status: stored.status,
          branchName: stored.branchName,
          worktreePath: stored.worktreePath,
          headSha: stored.headSha,
          error: stored.error
        }
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async recordGitSnapshot(snapshot: Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>, diffEvidence: string): Promise<GitSnapshotRecord> {
    await this.init();

    const diffArtifact = await this.writeTextArtifact(snapshot.taskId, 'diff', diffEvidence);
    const stored: GitSnapshotRecord = {
      id: randomUUID(),
      ...snapshot,
      capturedAt: new Date().toISOString(),
      diffArtifactId: diffArtifact.id
    };

    this.state = {
      ...this.state,
      gitSnapshots: [stored, ...this.state.gitSnapshots]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'DIFF_ARTIFACT_CREATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'storage',
        payload: { artifactId: diffArtifact.id, byteCount: diffArtifact.byteCount }
      }),
      false
    );

    await this.appendEvent(
      createDomainEvent({
        type: 'GIT_SNAPSHOT_CAPTURED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'git',
        payload: stored
      }),
      false
    );

    await this.markStaleTestsForSnapshot(stored, false);
    await this.persistQueued();
    return clone(stored);
  }

  async createTestRun(input: CreateTestRunInput): Promise<TestRunRecord> {
    await this.init();

    const now = new Date().toISOString();
    const testRunId = randomUUID();
    const stdoutArtifact = await this.createArtifactRecord(input.task.id, 'test-stdout', {
      testRunId
    });
    const stderrArtifact = await this.createArtifactRecord(input.task.id, 'test-stderr', {
      testRunId
    });
    await Promise.all([
      fs.writeFile(stdoutArtifact.path, '', 'utf8'),
      fs.writeFile(stderrArtifact.path, '', 'utf8')
    ]);

    const testRun: TestRunRecord = {
      id: testRunId,
      taskId: input.task.id,
      iterationId: input.worktree.iterationId,
      worktreeId: input.worktree.id,
      generationKey: input.gitSnapshot.dirtyFingerprint,
      command: input.commandLine,
      executable: input.executable,
      argv: input.argv,
      cwd: input.worktree.worktreePath,
      status: 'QUEUED',
      processStatus: 'CREATED',
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      startedAt: now,
      testedHeadSha: input.gitSnapshot.headSha,
      testedDirtyFingerprint: input.gitSnapshot.dirtyFingerprint
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((existing) =>
        existing.id === input.task.id
          ? {
              ...existing,
              currentTestRunId: testRun.id,
              updatedAt: now
            }
          : existing
      ),
      testRuns: [testRun, ...this.state.testRuns],
      artifacts: [stdoutArtifact, stderrArtifact, ...this.state.artifacts]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TEST_RUN_STARTED',
        taskId: input.task.id,
        iterationId: input.worktree.iterationId,
        worktreeId: input.worktree.id,
        testRunId: testRun.id,
        source: 'test',
        payload: {
          command: input.commandLine,
          cwd: input.worktree.worktreePath,
          testedHeadSha: input.gitSnapshot.headSha,
          testedDirtyFingerprint: input.gitSnapshot.dirtyFingerprint
        }
      }),
      false
    );

    await this.persistQueued();
    return clone(testRun);
  }

  async transitionTask(taskId: string, toPhase: Task['workflowPhase'], reason: string): Promise<Task> {
    await this.init();

    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) =>
        candidate.id === taskId
          ? {
              ...candidate,
              workflowPhase: toPhase,
              resolution: toPhase === 'DONE' ? 'COMPLETED' : candidate.resolution,
              phaseVersion: candidate.phaseVersion + 1,
              updatedAt: now
            }
          : candidate
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TRANSITION_COMPLETED',
        taskId,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'ui',
        payload: { fromPhase: task.workflowPhase, toPhase, reason }
      }),
      false
    );
    await this.persistQueued();

    const updated = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!updated) {
      throw new Error(`Task not found after transition: ${taskId}`);
    }
    return clone(updated);
  }

  async recordBlockedTransition(task: Task, toPhase: Task['workflowPhase'], reason: string): Promise<void> {
    await this.appendEvent(
      createDomainEvent({
        type: 'TRANSITION_BLOCKED',
        taskId: task.id,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'projection',
        payload: { fromPhase: task.workflowPhase, toPhase, reason }
      })
    );
  }

  async recordGitHubPreflight(
    record: Omit<GitHubRepositoryRecord, 'id' | 'checkedAt'>
  ): Promise<GitHubRepositoryRecord> {
    await this.init();
    const stored: GitHubRepositoryRecord = {
      id: randomUUID(),
      ...record,
      checkedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      githubRepositories: [stored, ...this.state.githubRepositories]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'GITHUB_PREFLIGHT_COMPLETED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'github',
        payload: stored
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async recordBranchPublishRequested(task: Task, worktree: WorktreeRecord): Promise<void> {
    await this.appendEvent(
      createDomainEvent({
        type: 'BRANCH_PUBLISH_REQUESTED',
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        source: 'github',
        payload: { branchName: worktree.branchName }
      })
    );
  }

  async recordBranchPublication(
    record: Omit<BranchPublicationRecord, 'id' | 'requestedAt' | 'updatedAt'>
  ): Promise<BranchPublicationRecord> {
    await this.init();
    const now = new Date().toISOString();
    const stored: BranchPublicationRecord = {
      id: randomUUID(),
      ...record,
      requestedAt: now,
      updatedAt: now
    };
    this.state = {
      ...this.state,
      branchPublications: [stored, ...this.state.branchPublications]
    };
    await this.appendEvent(
      createDomainEvent({
        type: stored.status === 'PUSHED' ? 'BRANCH_PUBLISHED' : 'BRANCH_PUBLISH_FAILED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'github',
        payload: stored
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async recordPullRequestCreateRequested(task: Task, worktree: WorktreeRecord): Promise<void> {
    await this.appendEvent(
      createDomainEvent({
        type: 'PR_CREATE_REQUESTED',
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        source: 'github',
        payload: { branchName: worktree.branchName }
      })
    );
  }

  async recordPullRequestBodyArtifact(task: Task, content: string): Promise<ArtifactRecord> {
    const artifact = await this.writeTextArtifact(task.id, 'pr-body', content);
    await this.appendEvent(
      createDomainEvent({
        type: 'PR_BODY_ARTIFACT_CREATED',
        taskId: task.id,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'storage',
        payload: { artifactId: artifact.id, byteCount: artifact.byteCount }
      })
    );
    return artifact;
  }

  async recordPullRequestSync(input: PrSyncInput): Promise<PullRequestSnapshotRecord> {
    await this.init();
    const observedAt = new Date().toISOString();
    const pullRequest: PullRequestSnapshotRecord = {
      id: randomUUID(),
      ...input.pullRequest,
      observedAt
    };
    const ci: CiRollupRecord = {
      id: randomUUID(),
      ...input.ci,
      observedAt
    };
    const reviews: ReviewRollupRecord = {
      id: randomUUID(),
      ...input.reviews,
      observedAt
    };
    const merge: MergeSnapshotRecord = {
      id: randomUUID(),
      ...input.merge,
      observedAt
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((task) =>
        task.id === pullRequest.taskId && pullRequest.status !== 'UNLINKED'
          ? {
              ...task,
              completionPolicy: 'MERGED'
            }
          : task
      ),
      pullRequests: [pullRequest, ...this.state.pullRequests],
      ciRollups: [ci, ...this.state.ciRollups],
      reviewRollups: [reviews, ...this.state.reviewRollups],
      mergeSnapshots: [merge, ...this.state.mergeSnapshots]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'PR_SNAPSHOT_CAPTURED',
        taskId: pullRequest.taskId,
        iterationId: pullRequest.iterationId,
        worktreeId: pullRequest.worktreeId,
        source: 'github',
        payload: pullRequest
      }),
      false
    );
    await this.appendEvent(
      createDomainEvent({
        type: 'CI_ROLLUP_CAPTURED',
        taskId: ci.taskId,
        iterationId: ci.iterationId,
        worktreeId: ci.worktreeId,
        source: 'github',
        payload: ci
      }),
      false
    );
    await this.appendEvent(
      createDomainEvent({
        type: 'REVIEW_ROLLUP_CAPTURED',
        taskId: reviews.taskId,
        iterationId: reviews.iterationId,
        worktreeId: reviews.worktreeId,
        source: 'github',
        payload: reviews
      }),
      false
    );
    await this.appendEvent(
      createDomainEvent({
        type: 'MERGE_SNAPSHOT_CAPTURED',
        taskId: merge.taskId,
        iterationId: merge.iterationId,
        worktreeId: merge.worktreeId,
        source: 'github',
        payload: merge
      }),
      false
    );

    if (merge.status === 'MERGED') {
      const now = new Date().toISOString();
      this.state = {
        ...this.state,
        tasks: this.state.tasks.map((task) =>
          task.id === merge.taskId
            ? {
                ...task,
                workflowPhase: 'DONE',
                resolution: 'COMPLETED',
                updatedAt: now,
                phaseVersion: task.phaseVersion + 1
              }
            : task
        )
      };
    }

    await this.persistQueued();
    return clone(pullRequest);
  }

  async appendEvent(event: DomainEvent, persist = true): Promise<void> {
    await this.init();
    this.state = applyEventToState(this.state, event);
    if (persist) {
      await this.persistQueued();
    }
  }

  async appendArtifact(artifactId: string, chunk: string): Promise<void> {
    await this.init();

    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    await fs.mkdir(path.dirname(artifact.path), { recursive: true });
    await fs.appendFile(artifact.path, chunk, 'utf8');

    const byteCount = Buffer.byteLength(chunk);
    const updatedAt = new Date().toISOString();
    this.state = {
      ...this.state,
      artifacts: this.state.artifacts.map((candidate) =>
        candidate.id === artifactId
          ? { ...candidate, byteCount: candidate.byteCount + byteCount, updatedAt }
          : candidate
      )
    };
  }

  async writeFinalArtifact(taskId: string, runId: string, content: string): Promise<ArtifactRecord> {
    await this.init();

    const artifact = await this.createArtifactRecord(taskId, 'agent-final', { runId });
    await fs.writeFile(artifact.path, content, 'utf8');

    const hash = createHash('sha256').update(content).digest('hex');
    const stored: ArtifactRecord = {
      ...artifact,
      byteCount: Buffer.byteLength(content),
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      artifacts: [stored, ...this.state.artifacts]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'ARTIFACT_CREATED',
        taskId,
        runId,
        source: 'storage',
        payload: { artifactId: stored.id, kind: stored.kind, hash }
      }),
      false
    );

    await this.persistQueued();
    return clone(stored);
  }

  async writeTextArtifact(taskId: string, kind: ArtifactKind, content: string): Promise<ArtifactRecord> {
    await this.init();

    const artifact = await this.createArtifactRecord(taskId, kind);
    await fs.writeFile(artifact.path, content, 'utf8');

    const stored: ArtifactRecord = {
      ...artifact,
      byteCount: Buffer.byteLength(content),
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      artifacts: [stored, ...this.state.artifacts]
    };

    await this.persistQueued();
    return clone(stored);
  }

  async readArtifact(artifactId: string): Promise<string> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    try {
      return await fs.readFile(artifact.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  async getArtifactPath(artifactId: string): Promise<string> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    return artifact.path;
  }

  private async createArtifactRecord(
    taskId: string,
    kind: ArtifactKind,
    ids: { runId?: string; testRunId?: string } = {}
  ): Promise<ArtifactRecord> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const ownerId = ids.runId ?? ids.testRunId ?? 'task';
    const fileName = `${taskId}-${ownerId}-${kind}-${id}.log`;
    return {
      id,
      taskId,
      runId: ids.runId,
      testRunId: ids.testRunId,
      kind,
      path: path.join(this.artifactsDir, fileName),
      byteCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  private async markStaleTestsForSnapshot(
    snapshot: GitSnapshotRecord,
    persist: boolean
  ): Promise<void> {
    const staleRuns = this.state.testRuns.filter(
      (testRun) =>
        testRun.taskId === snapshot.taskId &&
        testRun.iterationId === snapshot.iterationId &&
        ['PASSED', 'FAILED'].includes(testRun.status) &&
        (testRun.testedHeadSha !== snapshot.headSha ||
          testRun.testedDirtyFingerprint !== snapshot.dirtyFingerprint)
    );

    for (const testRun of staleRuns) {
      const reason = 'Git generation changed after this test run completed.';
      this.state = {
        ...this.state,
        testRuns: this.state.testRuns.map((candidate) =>
          candidate.id === testRun.id
            ? {
                ...candidate,
                status: 'STALE',
                staleReason: reason
              }
            : candidate
        )
      };

      await this.appendEvent(
        createDomainEvent({
          type: 'TEST_RESULT_STALE',
          taskId: testRun.taskId,
          iterationId: testRun.iterationId,
          worktreeId: testRun.worktreeId,
          testRunId: testRun.id,
          source: 'test',
          payload: {
            reason,
            testedHeadSha: testRun.testedHeadSha,
            currentHeadSha: snapshot.headSha,
            testedDirtyFingerprint: testRun.testedDirtyFingerprint,
            currentDirtyFingerprint: snapshot.dirtyFingerprint
          }
        }),
        false
      );
    }

    if (persist && staleRuns.length > 0) {
      await this.persistQueued();
    }
  }

  private async persistQueued(): Promise<void> {
    const operation = this.writeQueue.catch(() => undefined).then(() => this.persist());
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async persistAppSettingsQueued(): Promise<void> {
    const operation = this.appSettingsWriteQueue
      .catch(() => undefined)
      .then(() => this.persistAppSettings());
    this.appSettingsWriteQueue = operation.catch(() => undefined);
    await operation;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const tmpPath = `${this.storePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, this.storePath);
  }

  private async persistAppSettings(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const tmpPath = `${this.appSettingsPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.appSettings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, this.appSettingsPath);
  }
}

function requireCurrentState(state: PersistedState): StoreState {
  if (state.schemaVersion !== TASK_STORE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Task Monki store schema ${String(state.schemaVersion)}. ` +
        `Delete the local store and restart; migrations are intentionally not supported.`
    );
  }
  const requiredCollections: Array<keyof StoreState> = [
    'tasks',
    'iterations',
    'worktrees',
    'gitSnapshots',
    'testRuns',
    'githubRepositories',
    'branchPublications',
    'pullRequests',
    'ciRollups',
    'reviewRollups',
    'mergeSnapshots',
    'runs',
    'agentServers',
    'agentSessions',
    'agentItems',
    'agentGoalSnapshots',
    'agentPlanRevisions',
    'agentUsageSnapshots',
    'agentSettingsObservations',
    'agentSubagentObservations',
    'interactionRequests',
    'events',
    'artifacts'
  ];
  for (const key of requiredCollections) {
    if (!Array.isArray(state[key])) {
      throw new Error(`Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: ${key} is missing.`);
    }
  }
  return state;
}

function normalizeLoadedState(state: StoreState): { state: StoreState; changed: boolean } {
  let changed = false;
  const activeRunStatuses: RunRecord['status'][] = [
    'QUEUED',
    'STARTING',
    'RUNNING',
    'AWAITING_APPROVAL',
    'AWAITING_USER_INPUT',
    'INTERRUPTING'
  ];
  const runs = state.runs.map((run) => {
    if (isStaleIdleReviewRun(run, state.agentSessions)) {
      changed = true;
      return {
        ...run,
        status: 'RECOVERY_REQUIRED' as const,
        recoveryState: 'REQUIRES_USER_ACTION' as const,
        terminalReason:
          run.terminalReason ??
          'Codex review stopped sending updates before Task Monki received a terminal event.'
      };
    }
    if (!isStaleInterruptingReviewRun(run, state.agentSessions)) {
      return run;
    }
    changed = true;
    return {
      ...run,
      status: 'INTERRUPTED' as const,
      recoveryState: 'NONE' as const,
      endedAt: run.endedAt ?? run.lastEventAt ?? run.startedAt,
      terminalReason:
        run.terminalReason ??
        'Codex review stop was reconciled after the provider reported no active turn.'
    };
  });
  const tasks = state.tasks.map((task) => {
    const taskWithDefaults =
      Array.isArray(task.forkedAlternativeTaskIds)
        ? task
        : {
            ...task,
            forkedAlternativeTaskIds: []
          };
    if (taskWithDefaults !== task) {
      changed = true;
    }
    const taskCurrentRun = task.currentRunId
      ? runs.find((run) => run.id === task.currentRunId)
      : undefined;
    const currentRun = findReviewRunForRepair(taskWithDefaults, runs);
    if (!currentRun) {
      return taskWithDefaults;
    }

    const isActiveReview = activeRunStatuses.includes(currentRun.status);
    const hasActiveNonReviewRun =
      taskCurrentRun !== undefined &&
      taskCurrentRun.mode !== 'REVIEW' &&
      activeRunStatuses.includes(taskCurrentRun.status);
    const shouldRepairPhase =
      !hasActiveNonReviewRun &&
      taskWithDefaults.workflowPhase !== 'REVIEW' &&
      taskWithDefaults.workflowPhase !== 'IN_REVIEW' &&
      taskWithDefaults.workflowPhase !== 'DONE' &&
      taskWithDefaults.workflowPhase !== 'CANCELED' &&
      taskWithDefaults.workflowPhase !== 'ARCHIVED';
    const currentReview = taskWithDefaults.projection.codexReview;
    const sameProjectedReview = currentReview?.runId === currentRun.id;
    const reviewResult =
      parseCodexReviewResult(currentRun.finalMessage) ??
      (sameProjectedReview ? currentReview?.result : undefined);
    const projectedReviewStatus =
      sameProjectedReview && currentReview?.status !== 'RUNNING'
        ? currentReview?.status
        : undefined;
    const reviewStatus: CodexReviewGateStatus =
      (sameProjectedReview && currentReview?.status === 'STALE'
        ? 'STALE'
        : codexReviewStatusFromResult(reviewResult)) ??
      projectedReviewStatus ??
      (currentRun.status === 'COMPLETED'
        ? 'INCONCLUSIVE'
        : currentRun.status === 'INTERRUPTED'
          ? 'CANCELED'
          : ['FAILED', 'RECOVERY_REQUIRED', 'LOST'].includes(currentRun.status)
            ? 'FAILED'
            : 'RUNNING');
    const repairedSourceRun =
      taskCurrentRun?.mode === 'REVIEW'
        ? findSourceRunForReviewRepair(currentRun, runs)
        : undefined;
    const shouldRepairCurrentRun = Boolean(repairedSourceRun);
    const shouldRepairReview =
      !currentReview ||
      currentReview.runId !== currentRun.id ||
      currentReview.status !== reviewStatus ||
      (!currentReview.result && Boolean(reviewResult));

    if (!shouldRepairPhase && !shouldRepairReview && !shouldRepairCurrentRun) {
      return taskWithDefaults;
    }

    changed = true;
    const reviewedSnapshot = currentRun.beforeGitSnapshotId
      ? state.gitSnapshots.find((snapshot) => snapshot.id === currentRun.beforeGitSnapshotId)
      : undefined;
    const repairedAgentRun = repairedSourceRun?.status as
      | StatusProjection['agentRun']
      | undefined;
    return {
      ...taskWithDefaults,
      workflowPhase: shouldRepairPhase ? 'REVIEW' : taskWithDefaults.workflowPhase,
      currentRunId: repairedSourceRun?.id ?? taskWithDefaults.currentRunId,
      currentAgentSessionId: repairedSourceRun?.sessionId ?? taskWithDefaults.currentAgentSessionId,
      currentIterationId: repairedSourceRun?.iterationId ?? taskWithDefaults.currentIterationId,
      currentWorktreeId: repairedSourceRun?.worktreeId ?? taskWithDefaults.currentWorktreeId,
      projection: {
        ...taskWithDefaults.projection,
        agentRun: repairedAgentRun ?? taskWithDefaults.projection.agentRun,
        codexReview: {
          ...currentReview,
          status: reviewStatus,
          runId: currentRun.id,
          sourceRunId: currentRun.continuedFromRunId ?? currentReview?.sourceRunId,
          reviewedGitSnapshotId:
            currentRun.beforeGitSnapshotId ?? currentReview?.reviewedGitSnapshotId,
          reviewedHeadSha: reviewedSnapshot?.headSha ?? currentReview?.reviewedHeadSha,
          reviewedDirtyFingerprint:
            reviewedSnapshot?.dirtyFingerprint ?? currentReview?.reviewedDirtyFingerprint,
          finalArtifactId: currentRun.finalArtifactId ?? currentReview?.finalArtifactId,
          result: reviewResult ?? currentReview?.result,
          summary:
            reviewStatus === 'STALE'
              ? currentReview?.summary
              : (reviewResult?.summary ??
                (reviewStatus === 'RUNNING'
                  ? 'Codex is reviewing the current diff.'
                  : reviewStatus === 'CANCELED'
                    ? 'Codex review was stopped before completion.'
                    : reviewStatus === 'FAILED'
                      ? currentRun.terminalReason ??
                        'Codex review needs attention before it can be accepted.'
                      : currentReview?.summary)),
          updatedAt: currentRun.lastEventAt ?? currentRun.startedAt ?? currentReview?.updatedAt
        }
      },
      updatedAt: currentRun.lastEventAt ?? currentRun.startedAt ?? taskWithDefaults.updatedAt
    };
  });

  return changed ? { state: { ...state, runs, tasks }, changed } : { state, changed };
}

function removeTaskLink(task: Task, deletedTaskId: string, now: string): Task {
  const forkedAlternativeTaskIds = (task.forkedAlternativeTaskIds ?? []).filter(
    (alternativeTaskId) => alternativeTaskId !== deletedTaskId
  );
  const removedAlternative =
    forkedAlternativeTaskIds.length !== (task.forkedAlternativeTaskIds ?? []).length;
  const removedSource = task.forkedFromTaskId === deletedTaskId;

  if (!removedAlternative && !removedSource) {
    return task;
  }

  return {
    ...task,
    forkedAlternativeTaskIds,
    forkedFromTaskId: removedSource ? undefined : task.forkedFromTaskId,
    forkedFromRunId: removedSource ? undefined : task.forkedFromRunId,
    updatedAt: now
  };
}

function eventBelongsToDeletedTask(
  event: DomainEvent,
  taskId: string,
  ids: {
    runIds: Set<string>;
    sessionIds: Set<string>;
    worktreeIds: Set<string>;
    testRunIds: Set<string>;
  }
): boolean {
  if (event.taskId === taskId) {
    return true;
  }
  if (event.runId && ids.runIds.has(event.runId)) {
    return true;
  }
  if (event.agentSessionId && ids.sessionIds.has(event.agentSessionId)) {
    return true;
  }
  if (event.worktreeId && ids.worktreeIds.has(event.worktreeId)) {
    return true;
  }
  if (event.testRunId && ids.testRunIds.has(event.testRunId)) {
    return true;
  }
  return false;
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function isStaleIdleReviewRun(
  run: RunRecord,
  sessions: AgentSessionRecord[]
): boolean {
  if (
    run.mode !== 'REVIEW' ||
    !['STARTING', 'RUNNING'].includes(run.status)
  ) {
    return false;
  }
  const session = sessions.find((candidate) => candidate.id === run.sessionId);
  return (
    session?.role === 'REVIEW' &&
    ['IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED'].includes(
      session.status
    )
  );
}

function isStaleInterruptingReviewRun(
  run: RunRecord,
  sessions: AgentSessionRecord[]
): boolean {
  if (run.mode !== 'REVIEW' || run.status !== 'INTERRUPTING') {
    return false;
  }
  const session = sessions.find((candidate) => candidate.id === run.sessionId);
  return (
    session?.role === 'REVIEW' &&
    ['IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED'].includes(
      session.status
    )
  );
}

function findReviewRunForRepair(task: Task, runs: RunRecord[]): RunRecord | undefined {
  const projectedRunId = task.projection.codexReview?.runId;
  if (projectedRunId) {
    const projectedRun = runs.find((run) => run.id === projectedRunId && run.mode === 'REVIEW');
    if (projectedRun) {
      return projectedRun;
    }
  }
  if (task.currentRunId) {
    const currentRun = runs.find(
      (run) => run.id === task.currentRunId && run.mode === 'REVIEW'
    );
    if (currentRun) {
      return currentRun;
    }
  }
  return runs
    .filter(
      (run) =>
        run.taskId === task.id &&
        run.mode === 'REVIEW' &&
        (!task.currentIterationId || run.iterationId === task.currentIterationId)
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function findSourceRunForReviewRepair(
  reviewRun: RunRecord,
  runs: RunRecord[]
): RunRecord | undefined {
  if (reviewRun.continuedFromRunId) {
    const sourceRun = runs.find(
      (run) =>
        run.id === reviewRun.continuedFromRunId &&
        run.taskId === reviewRun.taskId &&
        run.mode !== 'REVIEW'
    );
    if (sourceRun) {
      return sourceRun;
    }
  }
  return runs
    .filter(
      (run) =>
        run.taskId === reviewRun.taskId &&
        run.iterationId === reviewRun.iterationId &&
        run.mode !== 'REVIEW'
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function normalizeLoadedAppSettings(value: unknown): TaskManagerAppSettings {
  const record = objectRecord(value);
  return {
    codexExternalTools: normalizeCodexExternalToolSettings(
      record?.codexExternalTools
    )
  };
}

function normalizeCodexExternalToolSettings(value: unknown): CodexExternalToolSettings {
  const record = objectRecord(value);
  return {
    webSearchMode: isCodexWebSearchMode(record?.webSearchMode)
      ? record.webSearchMode
      : DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS.webSearchMode,
    mcpServers: isCodexMcpServersMode(record?.mcpServers)
      ? record.mcpServers
      : DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS.mcpServers,
    apps: isCodexAppsMode(record?.apps)
      ? record.apps
      : DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS.apps
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCodexWebSearchMode(
  value: unknown
): value is CodexExternalToolSettings['webSearchMode'] {
  return value === 'disabled' || value === 'cached' || value === 'live';
}

function isCodexMcpServersMode(
  value: unknown
): value is CodexExternalToolSettings['mcpServers'] {
  return value === 'disabled' || value === 'all';
}

function isCodexAppsMode(value: unknown): value is CodexExternalToolSettings['apps'] {
  return value === 'disabled' || value === 'enabled';
}

function clone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values)];
}

function validateAgentServerTransition(
  current: AgentServerStatus,
  next: AgentServerStatus | undefined
): void {
  if (!next || next === current) {
    return;
  }
  const allowed: Record<AgentServerStatus, AgentServerStatus[]> = {
    STARTING: ['READY', 'RUNNING', 'FAILED', 'EXITED', 'LOST'],
    READY: ['RUNNING', 'DEGRADED', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
    RUNNING: ['READY', 'DEGRADED', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
    DEGRADED: ['READY', 'RUNNING', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
    STOPPING: ['EXITED', 'FAILED', 'LOST'],
    EXITED: [],
    FAILED: [],
    LOST: []
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid agent server transition: ${current} -> ${next}`);
  }
}

function validateInteractionTransition(
  current: InteractionRequestStatus,
  next: InteractionRequestStatus
): void {
  if (current === next) {
    return;
  }
  const allowed: Record<InteractionRequestStatus, InteractionRequestStatus[]> = {
    PENDING: [
      'RESPONDING',
      'DECLINED',
      'CANCELED',
      'ABORTED_SERVER_LOST',
      'STALE'
    ],
    RESPONDING: [
      'RESOLVED',
      'DECLINED',
      'CANCELED',
      'ABORTED_SERVER_LOST',
      'STALE'
    ],
    RESOLVED: [],
    DECLINED: [],
    CANCELED: [],
    ABORTED_SERVER_LOST: [],
    STALE: []
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid interaction transition: ${current} -> ${next}`);
  }
}

function validateAgentItemTransition(current: AgentItemStatus, next: AgentItemStatus): void {
  if (current === next) {
    return;
  }
  const allowed: Record<AgentItemStatus, AgentItemStatus[]> = {
    STARTED: ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED', 'UNKNOWN'],
    IN_PROGRESS: ['COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED', 'UNKNOWN'],
    COMPLETED: [],
    FAILED: [],
    DECLINED: [],
    INTERRUPTED: [],
    UNKNOWN: ['STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED']
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid agent item transition: ${current} -> ${next}`);
  }
}

function isInteractionTerminal(status: InteractionRequestStatus): boolean {
  return !['PENDING', 'RESPONDING'].includes(status);
}
