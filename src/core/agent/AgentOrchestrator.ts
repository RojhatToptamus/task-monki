import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentExecutionSettings,
  AgentInstructionProfile,
  AgentRuntimeCatalog,
  AgentRuntimeId,
  AgentRuntimeState,
  AgentReviewTarget,
  AgentRunMode,
  AgentSessionRecord,
  InteractionRequestRecord,
  RespondToInteractionRequest,
  RunRecord,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../shared/contracts';
import type { TaskAttachmentRecord } from '../../shared/attachments';
import type { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import type { FileTaskStore } from '../storage/FileTaskStore';
import { buildAgentReviewPrompt } from '../../shared/promptTemplates';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  AgentRuntimeDeliveryError,
  type AgentRuntimeAdapter
} from './AgentRuntimeAdapter';
import { AgentRuntimeRegistry } from './AgentRuntimeRegistry';
import {
  createRuntimeReadiness,
  errorDiagnostic
} from './AgentRuntimeReadiness';
import { AgentInteractionService } from './AgentInteractionService';
import { toAgentTurnAttachments, type AgentTurnAttachment } from './AgentAttachmentDelivery';
import {
  assertBrowserDevRuntimeIsolation,
  assertBrowserDevSettingsSafe,
  BROWSER_DEV_BOUNDARY_MESSAGE,
  browserDevSettingsViolations
} from './BrowserDevAgentBoundary';
import { agentServersOwnedByPreviousApplication } from './AgentRuntimeRecovery';
import { projectAgentExecutionSupport } from '../../shared/agentExecutionSupport';
import type {
  AgentRuntimeStore,
  TaskAgentRuntimeAccess
} from './AgentRuntimeStore';
import type {
  AgentRuntimeCoordinator,
  AgentRuntimeTurnEvent,
  BuildAgentRuntimeExecutionContextInput,
  PrepareAgentRuntimeTurnInput,
  PreparedAgentRuntimeTurn
} from './AgentRuntimeCoordinator';
import { createAgentSessionAccessEpoch } from './AgentRuntimeOwnership';

const MAX_CONCURRENT_TURNS = 2;
const ACTIVE_RUN_STATUSES: RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
];
const RECOVERABLE_RUN_STATUSES: RunRecord['status'][] = [
  ...ACTIVE_RUN_STATUSES,
  'RECOVERY_REQUIRED'
];

function isTerminalRuntimeRun(
  status: import('../../shared/agent').AgentRunStatus
): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(status);
}

function taskExecutionContext(input: {
  sessionId: string;
  operationId: string;
  worktree: WorktreeRecord;
  settings: AgentExecutionSettings;
  attachments: readonly {
    id: string;
    sha256: string;
    byteCount: number;
  }[];
  allowDynamicTools: boolean;
}): import('../../shared/agentRuntime').AgentExecutionContext {
  const managedAttachments = input.attachments
    .map((attachment) => ({
      attachmentId: attachment.id,
      contentSha256: attachment.sha256,
      byteCount: attachment.byteCount
    }))
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  const permissionProfileHash = createHash('sha256')
    .update(
      JSON.stringify({
        sessionId: input.sessionId,
        runtimeId: input.settings.runtimeId,
        primaryCwd: input.worktree.worktreePath,
        settings: input.settings,
        managedAttachments,
        allowDynamicTools: input.allowDynamicTools
      })
    )
    .digest('hex');
  return {
    attestation: { status: 'ATTESTED' },
    primaryCwd: input.worktree.worktreePath,
    readRoots: [
      {
        canonicalPath: input.worktree.worktreePath,
        kind: 'WORKTREE',
        entityId: input.worktree.id
      }
    ],
    managedAttachments,
    permissionProfileHash,
    modelSettings: { ...input.settings },
    externalTools: {
      network: input.settings.networkAccess === true,
      webSearch: 'disabled',
      mcpServers: false,
      apps: false,
      dynamicTools: input.allowDynamicTools
    },
    clientOperationId: input.operationId
  };
}
export interface StartOrchestratedTurn {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  mode: AgentRunMode;
  prompt: string;
  instructionProfile?: AgentInstructionProfile;
  settings: AgentExecutionSettings;
  generationKey?: string;
  beforeGitSnapshotId?: string;
  sessionId?: string;
  retryOfRunId?: string;
  continuedFromRunId?: string;
}

function assertSessionPostcondition(
  actual: AgentSessionRecord,
  expected: AgentSessionRecord,
  subject: string
): void {
  if (
    actual.id !== expected.id ||
    actual.taskId !== expected.taskId ||
    actual.iterationId !== expected.iterationId ||
    actual.worktreeId !== expected.worktreeId ||
    actual.worktreePath !== expected.worktreePath ||
    actual.runtimeId !== expected.runtimeId ||
    actual.role !== expected.role
  ) {
    throw new Error(
      `${subject} returned by the runtime does not match its Task Monki ownership record.`
    );
  }
  if (!actual.providerSessionId) {
    throw new Error(`${subject} did not return a provider session id.`);
  }
}

export interface StartOrchestratedReview {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  sourceRun: RunRecord;
  target: AgentReviewTarget;
  settings: AgentExecutionSettings;
  generationKey?: string;
  beforeGitSnapshotId?: string;
}

export class AgentOrchestrator implements AgentRuntimeCoordinator {
  private startQueue: Promise<void> = Promise.resolve();
  private persistedServerOwnershipReconciled = false;
  private readonly interactions: AgentInteractionService;
  private readonly runtimes: AgentRuntimeRegistry;
  private readonly taskRuntime: TaskAgentRuntimeAccess;
  private readonly runtimeTurnListeners = new Set<
    (event: AgentRuntimeTurnEvent) => void
  >();
  private readonly disposeRuntimeTurnListeners: Array<() => void> = [];

  constructor(
    private readonly store: FileTaskStore,
    private readonly runtimeStore: AgentRuntimeStore,
    private readonly events: AppEventBus,
    runtimes: AgentRuntimeRegistry | AgentRuntimeAdapter,
    private readonly options: {
      allowNetworkAccess?: boolean;
      providerStartupDisabledReason?: string;
    } = {}
  ) {
    this.runtimes =
      runtimes instanceof AgentRuntimeRegistry
        ? runtimes
        : new AgentRuntimeRegistry([runtimes], runtimes.descriptor.id);
    this.taskRuntime = runtimeStore.taskAgentRuntimeAccess((event, operationId) =>
      store.recordAgentRuntimeEvent(event, operationId)
    );
    this.interactions = new AgentInteractionService(this.taskRuntime, events, (runtimeId) =>
      this.runtimes.require(runtimeId)
    );
    for (const adapter of this.runtimes.list()) {
      if (!adapter.onRuntimeTurnEvent) continue;
      this.disposeRuntimeTurnListeners.push(
        adapter.onRuntimeTurnEvent((event) => {
          for (const listener of this.runtimeTurnListeners) listener(event);
        })
      );
    }
  }

  hasRuntime(runtimeId: string): boolean {
    if (!this.runtimes.has(runtimeId)) return false;
    const adapter = this.runtimes.require(runtimeId);
    return Boolean(
      adapter.buildExecutionContext &&
      adapter.startRuntimeTurn &&
      adapter.onRuntimeTurnEvent
    );
  }

  buildExecutionContext(
    runtimeId: string,
    input: BuildAgentRuntimeExecutionContextInput
  ) {
    const adapter = this.runtimes.require(runtimeId);
    if (!adapter.buildExecutionContext) {
      throw new Error(
        `${adapter.descriptor.displayName} is not configured for this workflow.`
      );
    }
    return adapter.buildExecutionContext(input);
  }

  async prepareTurn(
    input: PrepareAgentRuntimeTurnInput
  ): Promise<PreparedAgentRuntimeTurn> {
    if (!this.hasRuntime(input.runtimeId)) {
      throw new Error(`Runtime ${input.runtimeId} is not configured for this workflow.`);
    }
    if (input.executionContext.modelSettings.runtimeId !== input.runtimeId) {
      throw new Error('Runtime turn settings do not match the selected runtime.');
    }
    const promptArtifactId = `prompt-${input.runId}`;
    const outputArtifactId = `output-${input.runId}`;
    const diagnosticArtifactId = `diagnostic-${input.runId}`;
    return this.runtimeStore.prepareRuntimeTurn({
      session: {
        id: input.sessionId,
        owner: input.owner,
        accessEpoch: createAgentSessionAccessEpoch({
          owner: input.owner,
          sessionId: input.sessionId,
          epoch: 1,
          runtimeId: input.runtimeId,
          model: input.model,
          executionContext: input.executionContext,
          createdAt: input.createdAt
        }),
        executionContext: input.executionContext,
        clientOperationId: `${input.clientOperationId}:session`,
        runtimeId: input.runtimeId,
        role: 'PRIMARY',
        relationshipState: 'ROOT',
        status: 'NOT_MATERIALIZED',
        materialized: false,
        requestedSettings: input.executionContext.modelSettings
      },
      run: {
        id: input.runId,
        owner: input.owner,
        scope: input.scope,
        sessionId: input.sessionId,
        sessionAccessEpoch: 1,
        purpose: input.purpose,
        generationKey: input.generationKey,
        clientOperationId: `${input.clientOperationId}:run`,
        requestedSettings: input.executionContext.modelSettings,
        promptArtifactId,
        outputArtifactId,
        diagnosticArtifactId
      },
      prompt: input.prompt,
      priority: input.priority,
      queueOperationId: `${input.clientOperationId}:enqueue`,
      notBefore: input.notBefore
    });
  }

  async startPreparedTurn(
    queueEntryId: string,
    clientOperationId: string
  ) {
    const snapshot = await this.runtimeStore.snapshot();
    const entry = snapshot.queueEntries.find(
      (candidate) => candidate.id === queueEntryId
    );
    if (!entry || entry.status !== 'LEASED') {
      throw new Error('Only a leased runtime turn can start.');
    }
    let run = snapshot.runs.find((candidate) => candidate.id === entry.runId);
    if (!run) throw new Error(`Agent runtime run not found: ${entry.runId}`);
    let session = snapshot.sessions.find(
      (candidate) => candidate.id === run!.sessionId
    );
    if (!session) throw new Error(`Agent runtime session not found: ${run.sessionId}`);
    if (run.status !== 'QUEUED' || run.delivery !== 'NOT_SENT') {
      if (
        run.status === 'RUNNING' ||
        run.status === 'RECOVERY_REQUIRED' ||
        isTerminalRuntimeRun(run.status)
      ) {
        return run;
      }
      throw new Error(`Runtime turn cannot start from ${run.status}/${run.delivery}.`);
    }
    const adapter = this.runtimes.require(session.runtimeId);
    if (!adapter.startRuntimeTurn) {
      throw new Error(
        `${adapter.descriptor.displayName} is not configured for this workflow.`
      );
    }
    const prompt = await this.runtimeStore.readArtifact(run.promptArtifactId);
    const startedAt = new Date().toISOString();
    run = await this.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt,
        lastEventAt: startedAt
      },
      `${clientOperationId}:runtime-starting`
    );
    try {
      const started = await adapter.startRuntimeTurn({
        session,
        run,
        executionContext: session.executionContext,
        prompt
      });
      const latest = (await this.runtimeStore.getRun(run.id)) ?? run;
      if (
        latest.status === 'RUNNING' &&
        latest.delivery === 'ACKNOWLEDGED'
      ) {
        return latest;
      }
      if (isTerminalRuntimeRun(latest.status)) return latest;
      session = (await this.runtimeStore.getSession(session.id)) ?? session;
      if (
        session.providerSessionId &&
        session.providerSessionId !== started.providerSessionId
      ) {
        throw new Error('Provider acknowledgement changed the session identity.');
      }
      session = await this.runtimeStore.updateSession(
        session.id,
        session.recordRevision,
        {
          providerSessionId: started.providerSessionId,
          providerSessionTreeId: started.providerSessionTreeId,
          status: 'ACTIVE',
          materialized: true,
          lastAttachedAt: started.startedAt
        },
        `${clientOperationId}:session-acknowledged`
      );
      run = await this.runtimeStore.updateRun(
        latest.id,
        latest.recordRevision,
        {
          serverInstanceId: started.serverInstanceId,
          providerTurnId: started.providerTurnId,
          status: 'RUNNING',
          delivery: 'ACKNOWLEDGED',
          lastEventAt: started.startedAt
        },
        `${clientOperationId}:runtime-acknowledged`
      );
      void session;
      return run;
    } catch (error) {
      const latest = (await this.runtimeStore.getRun(run.id)) ?? run;
      if (
        latest.status === 'RUNNING' ||
        isTerminalRuntimeRun(latest.status) ||
        latest.status === 'RECOVERY_REQUIRED'
      ) {
        return latest;
      }
      const delivery =
        error instanceof AgentRuntimeDeliveryError
          ? error.delivery
          : 'AMBIGUOUS';
      const terminal = delivery === 'NOT_DELIVERED';
      const observedAt = new Date().toISOString();
      await this.runtimeStore.updateRun(
        latest.id,
        latest.recordRevision,
        {
          status: terminal ? 'FAILED' : 'RECOVERY_REQUIRED',
          delivery,
          recoveryState: terminal ? 'NONE' : 'REQUIRES_USER_ACTION',
          terminalReason: error instanceof Error ? error.message : String(error),
          lastEventAt: observedAt,
          ...(terminal ? { endedAt: observedAt } : {})
        },
        `${clientOperationId}:runtime-start-failed`
      );
      if (terminal) {
        const currentEntry = (await this.runtimeStore.snapshot()).queueEntries.find(
          (candidate) => candidate.id === entry.id
        );
        if (currentEntry?.status === 'LEASED') {
          await this.runtimeStore.settleQueueEntry(
            currentEntry.id,
            currentEntry.recordRevision,
            `${clientOperationId}:settle-not-delivered`
          );
        }
      }
      throw error;
    }
  }

  async cancelQueuedTurn(
    runId: string,
    reason: string,
    clientOperationId: string
  ) {
    let run = await this.runtimeStore.getRun(runId);
    if (!run) throw new Error(`Agent runtime run not found: ${runId}`);
    if (isTerminalRuntimeRun(run.status)) return run;
    if (run.status !== 'QUEUED' || run.delivery !== 'NOT_SENT') {
      throw new Error('Only a provably unsubmitted runtime turn can be canceled.');
    }
    const endedAt = new Date().toISOString();
    run = await this.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'INTERRUPTED',
        delivery: 'NOT_DELIVERED',
        recoveryState: 'NONE',
        terminalReason: reason,
        lastEventAt: endedAt,
        endedAt
      },
      `${clientOperationId}:runtime-canceled`
    );
    const entry = (await this.runtimeStore.snapshot()).queueEntries.find(
      (candidate) => candidate.runId === run!.id
    );
    if (entry?.status === 'QUEUED') {
      await this.runtimeStore.cancelQueueEntry(
        entry.id,
        entry.recordRevision,
        reason,
        `${clientOperationId}:queue-canceled`
      );
    } else if (entry?.status === 'LEASED') {
      await this.runtimeStore.settleQueueEntry(
        entry.id,
        entry.recordRevision,
        `${clientOperationId}:queue-settled`
      );
    }
    return run;
  }

  async interruptTurn(
    runId: string,
    reason: string,
    clientOperationId: string
  ) {
    let run = await this.runtimeStore.getRun(runId);
    if (!run) throw new Error(`Agent runtime run not found: ${runId}`);
    if (isTerminalRuntimeRun(run.status)) return run;
    if (run.status === 'QUEUED' && run.delivery === 'NOT_SENT') {
      return this.cancelQueuedTurn(run.id, reason, clientOperationId);
    }
    const session = await this.runtimeStore.getSession(run.sessionId);
    if (!session) throw new Error(`Agent runtime session not found: ${run.sessionId}`);
    if (run.status === 'RECOVERY_REQUIRED') {
      if (
        run.interruptDelivery === 'AMBIGUOUS' ||
        run.interruptDelivery === 'SENDING'
      ) {
        return run;
      }
      if (['NOT_SENT', 'NOT_DELIVERED'].includes(run.delivery)) {
        const endedAt = new Date().toISOString();
        return this.runtimeStore.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'INTERRUPTED',
            delivery: 'NOT_DELIVERED',
            recoveryState: 'NONE',
            terminalReason: reason,
            lastEventAt: endedAt,
            endedAt
          },
          `${clientOperationId}:runtime-terminal`
        );
      }
      if (run.delivery === 'ACKNOWLEDGED' && run.providerTurnId) {
        run = await this.runtimeStore.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'RUNNING',
            interruptDelivery: undefined,
            stopRequestedAt: undefined,
            recoveryState: 'NONE',
            lastEventAt: new Date().toISOString()
          },
          `${clientOperationId}:runtime-active`
        );
      }
    }
    if (
      !run.providerTurnId ||
      !['RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(run.status)
    ) {
      throw new Error('Runtime interruption requires an acknowledged active turn.');
    }
    const adapter = this.runtimes.require(session.runtimeId);
    if (!adapter.interruptRuntimeTurn) {
      throw new Error(
        `${adapter.descriptor.displayName} cannot interrupt this workflow.`
      );
    }
    const requestedAt = new Date().toISOString();
    run = await this.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'INTERRUPTING',
        interruptDelivery: 'SENDING',
        stopRequestedAt: requestedAt,
        terminalReason: reason,
        lastEventAt: requestedAt
      },
      `${clientOperationId}:runtime-stop-intent`
    );
    try {
      await adapter.interruptRuntimeTurn({ session, run });
      const latest = (await this.runtimeStore.getRun(run.id)) ?? run;
      if (isTerminalRuntimeRun(latest.status)) return latest;
      if (
        latest.status === 'INTERRUPTING' &&
        latest.interruptDelivery === 'SENDING'
      ) {
        return this.runtimeStore.updateRun(
          latest.id,
          latest.recordRevision,
          {
            interruptDelivery: 'ACKNOWLEDGED',
            lastEventAt: new Date().toISOString()
          },
          `${clientOperationId}:runtime-stop-ack`
        );
      }
      return latest;
    } catch (error) {
      const latest = (await this.runtimeStore.getRun(run.id)) ?? run;
      if (isTerminalRuntimeRun(latest.status)) return latest;
      const interruptDelivery =
        error instanceof AgentRuntimeDeliveryError
          ? error.delivery
          : 'AMBIGUOUS';
      return this.runtimeStore.updateRun(
        latest.id,
        latest.recordRevision,
        {
          status: 'RECOVERY_REQUIRED',
          interruptDelivery,
          recoveryState: 'REQUIRES_USER_ACTION',
          terminalReason: error instanceof Error ? error.message : String(error),
          lastEventAt: new Date().toISOString()
        },
        `${clientOperationId}:runtime-stop-recovery`
      );
    }
  }

  subscribe(listener: (event: AgentRuntimeTurnEvent) => void): () => void {
    this.runtimeTurnListeners.add(listener);
    return () => this.runtimeTurnListeners.delete(listener);
  }

  async initialize(
    requiredRuntimeIds: readonly string[] = [this.runtimes.defaultRuntimeId],
    disabledRuntimeIds: ReadonlySet<AgentRuntimeId> = new Set()
  ): Promise<void> {
    if (this.options.providerStartupDisabledReason) {
      await this.store.reconcileRunAttachments();
      return;
    }
    await this.reconcilePersistedServerOwnership();
    const persisted = await this.taskRuntime.snapshot();
    const recoveryRuntimeIds = new Set(
      persisted.runs
        .filter((run) => RECOVERABLE_RUN_STATUSES.includes(run.status))
        .map((run) => run.runtimeId)
    );
    let runtimeIdsToInitialize = this.runtimes
      .list()
      .filter(
        (adapter) =>
          !disabledRuntimeIds.has(adapter.descriptor.id) &&
          (adapter.descriptor.startupPolicy !== 'ON_DEMAND' ||
            requiredRuntimeIds.includes(adapter.descriptor.id) ||
            recoveryRuntimeIds.has(adapter.descriptor.id))
      )
      .map((adapter) => adapter.descriptor.id);
    let browserUnsafeRuntimeIds = new Set<string>();
    if (this.options.allowNetworkAccess === false) {
      const classification = await this.classifyBrowserRuntimeIsolation();
      runtimeIdsToInitialize = runtimeIdsToInitialize.filter((runtimeId) =>
        classification.safeRuntimeIds.includes(runtimeId)
      );
      browserUnsafeRuntimeIds = classification.unsafeRuntimeIds;
      for (const runtimeId of requiredRuntimeIds) {
        if (browserUnsafeRuntimeIds.has(runtimeId)) {
          const adapter = this.runtimes.require(runtimeId);
          assertBrowserDevRuntimeIsolation(
            adapter.descriptor,
            await adapter.capabilities()
          );
        }
      }
      await this.terminalizeUnsafePersistedRuns(browserUnsafeRuntimeIds);
    }
    await this.store.reconcileRunAttachments();
    const initializationFailures = await this.runtimes.initialize(
      runtimeIdsToInitialize
    );
    if (this.options.allowNetworkAccess === false) {
      const requiredFailure = initializationFailures.find((failure) =>
        requiredRuntimeIds.includes(failure.runtimeId)
      );
      if (requiredFailure) {
        await this.runtimes.shutdownAll().catch(() => undefined);
        throw requiredFailure.error;
      }
      try {
        await Promise.all(
          requiredRuntimeIds.map(async (runtimeId) => {
            const adapter = this.runtimes.require(runtimeId);
            assertBrowserDevRuntimeIsolation(
              adapter.descriptor,
              await adapter.capabilities()
            );
          })
        );
      } catch (error) {
        await this.runtimes.shutdownAll().catch(() => undefined);
        throw error;
      }
    }
    if (this.options.allowNetworkAccess === false) {
      const terminalizedAfterProviderInitialization =
        await this.terminalizeUnsafePersistedRuns();
      if (terminalizedAfterProviderInitialization > 0) {
        await this.runtimes.shutdownAll().catch(() => undefined);
        throw new Error(
          `${BROWSER_DEV_BOUNDARY_MESSAGE} Runtime recovery reported unsafe observed settings, so agent runtimes were stopped before the development API credential was published.`
        );
      }
    }
  }

  private async reconcilePersistedServerOwnership(): Promise<void> {
    if (this.persistedServerOwnershipReconciled) return;
    const snapshot = await this.taskRuntime.snapshot();
    const lostAt = new Date().toISOString();
    for (const server of agentServersOwnedByPreviousApplication(snapshot)) {
      await this.runtimeStore.updateAgentServer(server.id, {
        status: 'LOST',
        disconnectedAt: lostAt,
        exitedAt: lostAt,
        exitReason: 'Task Monki restarted without the prior provider process.'
      });
    }
    this.persistedServerOwnershipReconciled = true;
  }

  async getRuntimeCatalog(
    disabledRuntimeIds: ReadonlySet<AgentRuntimeId> = new Set()
  ): Promise<AgentRuntimeCatalog> {
    if (this.options.providerStartupDisabledReason) {
      const refreshedAt = new Date().toISOString();
      const runtimes = await Promise.all(
        this.runtimes.list().map(async (adapter) => ({
          preflight: {
            runtime: adapter.descriptor,
            readiness: createRuntimeReadiness(
              'DISABLED',
              this.options.providerStartupDisabledReason!,
              {
                diagnostics: [
                  errorDiagnostic(
                    'RUNTIME_DISABLED',
                    'SECURITY',
                    this.options.providerStartupDisabledReason!
                  )
                ]
              }
            ),
            capabilities: await adapter.capabilities(),
          },
          models: [],
          refreshedAt
        }))
      );
      return {
        runtimes,
        models: [],
        defaultRuntimeId: this.runtimes.defaultRuntimeId,
        refreshedAt
      };
    }
    if (this.options.allowNetworkAccess !== false) {
      return this.runtimes.getCatalog({ disabledRuntimeIds });
    }
    const { unsafeRuntimeIds } = await this.classifyBrowserRuntimeIsolation();
    return this.runtimes.getCatalog({
      disabledRuntimeIds,
      excludedRuntimeIds: unsafeRuntimeIds,
      exclusionReason:
        'This runtime is unavailable in browser development because it does not attest the required process, filesystem, and network isolation.'
    });
  }

  async discoverAgentRuntimeModels(
    runtimeId: AgentRuntimeId,
    disabledRuntimeIds: ReadonlySet<AgentRuntimeId> = new Set()
  ): Promise<AgentRuntimeState> {
    this.assertProviderStartupAvailable();
    if (this.options.allowNetworkAccess !== false) {
      return this.runtimes.discoverAgentRuntimeModels(runtimeId, {
        disabledRuntimeIds
      });
    }
    const { unsafeRuntimeIds } = await this.classifyBrowserRuntimeIsolation();
    return this.runtimes.discoverAgentRuntimeModels(runtimeId, {
      disabledRuntimeIds,
      excludedRuntimeIds: unsafeRuntimeIds,
      exclusionReason:
        'This runtime is unavailable in browser development because it does not attest the required process, filesystem, and network isolation.'
    });
  }

  async releaseTask(taskId: string): Promise<void> {
    const results = await Promise.allSettled(
      this.runtimes.list().map((adapter) => adapter.releaseTask?.(taskId))
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more agent runtimes could not release the task.'
      );
    }
  }

  async deleteTaskProviderHistory(task: Task): Promise<void> {
    const adapter = this.runtimes.require(task.runtimeId);
    if (!adapter.deleteTaskProviderHistory) {
      throw new Error(
        `${adapter.descriptor.displayName} cannot delete provider history safely.`
      );
    }
    await adapter.deleteTaskProviderHistory(task.id);
  }

  startTurn(input: StartOrchestratedTurn): Promise<RunRecord> {
    const operation = this.startQueue.then(() => this.startTurnSerially(input));
    this.startQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async startTurnSerially(input: StartOrchestratedTurn): Promise<RunRecord> {
    this.assertProviderStartupAvailable();
    const taskAttachments = await this.store.getTurnAttachments({
      taskId: input.task.id,
      mode: input.mode,
      generationKey: input.generationKey
    });
    const taskRuntimeSnapshot = await this.taskRuntime.snapshot();
    let session: AgentSessionRecord | undefined;
    if (input.sessionId) {
      session = await this.requireSession(input.sessionId);
    } else {
      const primarySessions = taskRuntimeSnapshot.agentSessions.filter(
        (candidate) =>
          candidate.taskId === input.task.id &&
          candidate.iterationId === input.iteration.id &&
          candidate.worktreeId === input.worktree.id &&
          candidate.role === 'PRIMARY'
      );
      if (input.task.currentAgentSessionId) {
        session = primarySessions.find(
          (candidate) => candidate.id === input.task.currentAgentSessionId
        );
        if (!session) {
          throw new Error('Task current agent session ownership is inconsistent.');
        }
      } else {
        session = primarySessions
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.updatedAt.localeCompare(right.updatedAt)
          )
          .at(-1);
      }
    }
    const runtimeId = session?.runtimeId ?? input.task.runtimeId;
    if (input.settings.runtimeId && input.settings.runtimeId !== runtimeId) {
      throw new Error(
        `Task runtime ${runtimeId} cannot start work through ${input.settings.runtimeId}.`
      );
    }
    if (input.task.runtimeId !== runtimeId) {
      throw new Error('Selected agent session runtime does not match its task.');
    }
    const adapter = this.runtimes.require(runtimeId);
    const settings = await this.validateSettings(
      adapter,
      { ...input.settings, runtimeId },
      taskAttachments
    );
    await this.assertCapacity();

    if (!session) {
      const sessionId = randomUUID();
      const operationId = `task-session:${input.task.id}:${input.iteration.id}:${runtimeId}`;
      session = await this.taskRuntime.createTaskSession({
        id: sessionId,
        taskId: input.task.id,
        iterationId: input.iteration.id,
        worktreeId: input.worktree.id,
        worktreePath: input.worktree.worktreePath,
        runtimeId,
        requestedSettings: settings,
        executionContext: taskExecutionContext({
          sessionId,
          operationId,
          worktree: input.worktree,
          settings,
          attachments: taskAttachments,
          allowDynamicTools: input.mode === 'DESIGN'
        }),
        operationId
      });
      await this.store.recordAgentSessionCreated(session);
    }
    if (
      session.taskId !== input.task.id ||
      session.iterationId !== input.iteration.id ||
      session.worktreeId !== input.worktree.id
    ) {
      throw new Error('Selected agent session does not belong to this task iteration.');
    }
    await this.assertBrowserDevSessionHistory(session, 'Selected session');
    await this.assertNoPendingInteractions(session.id);

    const activeSessionRun = await this.taskRuntime.getActiveRunForSession(session.id);
    if (activeSessionRun) {
      throw new Error(
        `Agent session ${session.id} already has active run ${activeSessionRun.id}.`
      );
    }
    const unresolvedRecoveryRun = (await this.taskRuntime.snapshot()).runs.find(
      (run) => run.sessionId === session!.id && run.status === 'RECOVERY_REQUIRED'
    );
    if (
      unresolvedRecoveryRun &&
      input.continuedFromRunId !== unresolvedRecoveryRun.id
    ) {
      throw new Error(
        `Agent session ${session.id} has unresolved recovery run ${unresolvedRecoveryRun.id}; close it or explicitly continue from it before another provider mutation.`
      );
    }

    if (session.runtimeId !== runtimeId) {
      throw new Error('Selected agent session runtime changed unexpectedly.');
    }
    const runId = randomUUID();
    const run = await this.taskRuntime.createTaskRun({
      id: runId,
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      sessionId: session.id,
      mode: input.mode,
      prompt: input.prompt,
      generationKey: input.generationKey,
      requestedSettings: settings,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      retryOfRunId: input.retryOfRunId,
      continuedFromRunId: input.continuedFromRunId,
      instructionProfile: input.instructionProfile,
      operationId: `task-run:${runId}`
    });
    await this.store.recordAgentRunStarted(run);

    let attachments: AgentTurnAttachment[] = [];
    try {
      attachments = toAgentTurnAttachments(
        await this.store.prepareRunAttachments(run.id, input.task.id)
      );
      if (!session.providerSessionId) {
        const localSession = session;
        session = await adapter.createSession({
          runtimeId,
          localSessionId: session.id,
          taskId: input.task.id,
          iterationId: input.iteration.id,
          worktreeId: input.worktree.id,
          worktreePath: input.worktree.worktreePath,
          settings,
          attachments
        });
        assertSessionPostcondition(session, localSession, 'Created session');
        await this.assertBrowserDevSessionHistory(session, 'Created session');
      }
      const submitted = await this.startProviderTurn(
        adapter,
        run,
        session,
        input,
        settings,
        attachments
      );
      if (!submitted) {
        return (await this.taskRuntime.getRun(run.id)) ?? run;
      }
      return (await this.taskRuntime.getRun(run.id)) ?? run;
    } catch (error) {
      if (error instanceof AgentProviderSessionMissingError) {
        return this.replaceUndeliveredTaskTurn({
          adapter,
          sourceSession: session,
          sourceRun: run,
          input,
          settings,
          attachmentRecords: taskAttachments,
          attachments,
          error
        });
      }
      await this.recordStartFailure(run, error);
      throw error;
    }
  }

  startReview(input: StartOrchestratedReview): Promise<RunRecord> {
    const operation = this.startQueue.then(() => this.startReviewSerially(input));
    this.startQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async startReviewSerially(
    input: StartOrchestratedReview
  ): Promise<RunRecord> {
    this.assertProviderStartupAvailable();
    const sourceSession = await this.requireSession(input.sourceRun.sessionId);
    if (input.sourceRun.runtimeId !== sourceSession.runtimeId) {
      throw new Error('Review source runtime ownership is inconsistent.');
    }
    const reviewRuntimeId = input.settings.runtimeId ?? sourceSession.runtimeId;
    const adapter = this.runtimes.require(reviewRuntimeId);
    const capabilities = await adapter.capabilities();
    const reviewSupport = projectAgentExecutionSupport(capabilities, 'REVIEW', {
      sourceRuntimeId: sourceSession.runtimeId
    });
    if (!reviewSupport.supported) throw new Error(reviewSupport.reason);
    const useNativeReview =
      reviewRuntimeId === sourceSession.runtimeId &&
      capabilities.review.maturity !== 'unsupported' &&
      typeof adapter.startReview === 'function';
    const taskAttachments = await this.store.getTaskAttachments(input.task.id);
    const settings = await this.validateSettings(
      adapter,
      { ...input.settings, runtimeId: reviewRuntimeId },
      taskAttachments
    );
    await this.assertCapacity();
    if (useNativeReview) {
      this.assertBrowserDevSettings(input.sourceRun.requestedSettings, 'Review source run');
      if (input.sourceRun.observedSettings) {
        this.assertBrowserDevSettings(
          input.sourceRun.observedSettings,
          'Review source run observed settings'
        );
      }
      await this.assertBrowserDevSessionHistory(sourceSession, 'Review source session');
      await this.assertNoPendingInteractions(sourceSession.id);
    }
    const reviewSessionId = randomUUID();
    const reviewSessionOperationId =
      `review-session:${input.task.id}:${input.sourceRun.id}:${input.generationKey ?? 'current'}:${reviewRuntimeId}`;
    let reviewSession = await this.taskRuntime.createTaskSession({
      id: reviewSessionId,
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      worktreePath: input.worktree.worktreePath,
      runtimeId: reviewRuntimeId,
      role: 'REVIEW',
      requestedSettings: settings,
      parentSessionId: sourceSession.id,
      forkedFromSessionId: useNativeReview ? sourceSession.id : undefined,
      executionContext: taskExecutionContext({
        sessionId: reviewSessionId,
        operationId: reviewSessionOperationId,
        worktree: input.worktree,
        settings,
        attachments: taskAttachments,
        allowDynamicTools: false
      }),
      operationId: reviewSessionOperationId
    });
    await this.store.recordAgentSessionCreated(reviewSession);
    const prompt = buildAgentReviewPrompt({
      task: input.task,
      worktree: input.worktree,
      target: input.target
    });
    const run = await this.taskRuntime.createTaskRun({
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      sessionId: reviewSession.id,
      mode: 'REVIEW',
      prompt,
      generationKey: input.generationKey,
      requestedSettings: settings,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      continuedFromRunId: input.sourceRun.id,
      reviewTarget: input.target,
      operationId: `review-run:${input.task.id}:${input.sourceRun.id}:${input.generationKey ?? randomUUID()}:${reviewRuntimeId}`
    });
    await this.store.recordAgentRunStarted(run);
    let attachments: AgentTurnAttachment[] = [];
    try {
      attachments = toAgentTurnAttachments(
        await this.store.prepareRunAttachments(run.id, input.task.id)
      );
      if (!useNativeReview && !reviewSession.providerSessionId) {
        const localReviewSession = reviewSession;
        reviewSession = await adapter.createSession({
          runtimeId: reviewRuntimeId,
          localSessionId: reviewSession.id,
          taskId: input.task.id,
          iterationId: input.iteration.id,
          worktreeId: input.worktree.id,
          worktreePath: input.worktree.worktreePath,
          settings,
          attachments
        });
        assertSessionPostcondition(
          reviewSession,
          localReviewSession,
          'Created review session'
        );
        await this.assertBrowserDevSessionHistory(
          reviewSession,
          'Created review session'
        );
      }
      if (useNativeReview) {
        await this.startProviderReview(
          adapter,
          run,
          sourceSession,
          reviewSession,
          input.target,
          attachments
        );
      } else {
        await adapter.startTurn({
          localRunId: run.id,
          session: {
            localSessionId: reviewSession.id,
            providerSessionId: reviewSession.providerSessionId
          },
          mode: 'REVIEW',
          prompt,
          authoritativeGoal: input.task.prompt,
          attachments,
          settings
        });
      }
      return (await this.taskRuntime.getRun(run.id)) ?? run;
    } catch (error) {
      if (error instanceof AgentProviderSessionMissingError && useNativeReview) {
        try {
          const recovered = await this.createReplacementReviewSourceSession({
            adapter,
            sourceSession,
            task: input.task,
            iteration: input.iteration,
            worktree: input.worktree,
            settings,
            attachmentRecords: taskAttachments,
            attachments,
            error,
            runId: run.id
          });
          await this.assertBrowserDevSessionHistory(
            recovered,
            'Replacement review source session'
          );
          await this.startProviderReview(
            adapter,
            run,
            recovered,
            reviewSession,
            input.target,
            attachments
          );
          return (await this.taskRuntime.getRun(run.id)) ?? run;
        } catch (retryError) {
          await this.recordStartFailure(run, retryError);
          throw retryError;
        }
      }
      await this.recordStartFailure(run, error);
      throw error;
    }
  }

  async steerRun(runId: string, instruction: string): Promise<void> {
    this.assertProviderStartupAvailable();
    const prompt = instruction.trim();
    if (!prompt) {
      throw new Error('An instruction is required.');
    }
    const run = await this.taskRuntime.getRun(runId);
    if (!run?.providerTurnId || run.status !== 'RUNNING') {
      throw new Error('Only the current running turn can accept an instruction.');
    }
    const session = await this.requireSession(run.sessionId);
    this.assertRunRuntimeOwnership(run, session);
    const adapter = this.runtimes.require(session.runtimeId);
    const capabilities = await adapter.capabilities();
    if (this.options.allowNetworkAccess === false) {
      assertBrowserDevRuntimeIsolation(adapter.descriptor, capabilities);
    }
    const steeringSupport = projectAgentExecutionSupport(
      capabilities,
      'ACTIVE_TURN_STEERING'
    );
    if (!session.providerSessionId || !steeringSupport.supported || !adapter.steerTurn) {
      throw new Error(
        steeringSupport.supported
          ? 'This provider session cannot steer the active turn.'
          : steeringSupport.reason
      );
    }
    try {
      await adapter.steerTurn({
        session: {
          localSessionId: session.id,
          providerSessionId: session.providerSessionId
        },
        providerTurnId: run.providerTurnId,
        prompt,
        clientMessageId: randomUUID()
      });
    } catch (error) {
      if (error instanceof AgentMutationAmbiguousError) {
        await this.recordAmbiguousMutation(run, error);
      }
      throw error;
    }
  }

  async interruptRun(runId: string): Promise<void> {
    this.assertProviderStartupAvailable();
    let run = await this.taskRuntime.getRun(runId);
    if (!run) {
      return;
    }
    if (isTerminalRuntimeRun(run.status)) return;
    if (run.status === 'RECOVERY_REQUIRED') {
      await this.resolveRecoveryRun(
        run,
        'Recovery-required run was explicitly abandoned by the user.'
      );
      return;
    }
    if (run.status === 'QUEUED') {
      const canonical = await this.runtimeStore.getRun(run.id);
      if (
        canonical?.owner.kind === 'TASK' &&
        canonical.status === 'QUEUED' &&
        canonical.delivery === 'NOT_SENT'
      ) {
        const terminalReason = 'Canceled before the turn was sent to the provider.';
        const interrupted = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
          createDomainEvent({
            type: 'AGENT_RUN_INTERRUPTED',
            taskId: run.taskId,
            iterationId: run.iterationId,
            runId: run.id,
            worktreeId: run.worktreeId,
            agentSessionId: run.sessionId,
            source: 'ui',
            payload: { terminalReason }
          }),
          ['QUEUED'],
          `cancel-unsent:${run.id}`
        );
        if (interrupted) {
          this.events.emit({
            type: 'run.terminal',
            taskId: run.taskId,
            iterationId: run.iterationId,
            runId: run.id,
            worktreeId: run.worktreeId,
            payload: { status: 'interrupted', terminalReason },
            at: new Date().toISOString()
          });
          return;
        }
      }
      run = (await this.taskRuntime.getRun(run.id)) ?? run;
      if (isTerminalRuntimeRun(run.status)) return;
    }
    const canonical = await this.runtimeStore.getRun(run.id);
    if (canonical?.delivery === 'SENDING' || !run.providerTurnId) {
      throw new Error(
        'This turn is being sent to the provider. Stop it after the provider acknowledges it.'
      );
    }
    const session = await this.taskRuntime.getAgentSession(run.sessionId);
    if (!session) {
      throw new Error(`Agent session not found: ${run.sessionId}`);
    }
    this.assertRunRuntimeOwnership(run, session);
    const adapter = this.runtimes.require(session.runtimeId);
    const capabilities = await adapter.capabilities();
    if (this.options.allowNetworkAccess === false) {
      assertBrowserDevRuntimeIsolation(adapter.descriptor, capabilities);
    }
    if (
      !session.providerSessionId ||
      capabilities.turnInterruption.maturity === 'unsupported' ||
      !adapter.interruptTurn
    ) {
      throw new Error('This provider session cannot interrupt the active turn.');
    }
    await this.taskRuntime.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'CANCEL_REQUESTED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'ui',
        payload: {}
      }),
      `cancel-requested:${run.id}`
    );
    try {
      await adapter.interruptTurn({
        session: {
          localSessionId: session.id,
          providerSessionId: session.providerSessionId
        },
        providerTurnId: run.providerTurnId
      });
    } catch (error) {
      if (error instanceof AgentMutationAmbiguousError) {
        await this.recordAmbiguousMutation(run, error);
      }
      throw error;
    }
  }

  async respondToInteraction(
    input: RespondToInteractionRequest
  ): Promise<InteractionRequestRecord> {
    this.assertProviderStartupAvailable();
    if (this.options.allowNetworkAccess === false) {
      const interaction = await this.taskRuntime.getInteractionRequest(input.interactionRequestId);
      if (interaction?.taskId === input.taskId && interaction.runId === input.runId) {
        const adapter = this.runtimes.require(interaction.runtimeId);
        assertBrowserDevRuntimeIsolation(
          adapter.descriptor,
          await adapter.capabilities()
        );
      }
      if (
        interaction?.taskId === input.taskId &&
        interaction.runId === input.runId &&
        interaction.type !== 'USER_INPUT' &&
        input.decision.action !== 'DECLINE' &&
        input.decision.action !== 'DECLINE_FOR_SESSION' &&
        input.decision.action !== 'CANCEL'
      ) {
        throw new Error(
          `${BROWSER_DEV_BOUNDARY_MESSAGE} Unexpected provider approval requests can only be declined or canceled.`
        );
      }
    }
    return this.interactions.respond(input);
  }

  async resolveRecoveryRunForReplacement(runId: string): Promise<void> {
    this.assertProviderStartupAvailable();
    const run = await this.taskRuntime.getRun(runId);
    if (!run || run.status !== 'RECOVERY_REQUIRED') return;
    await this.resolveRecoveryRun(
      run,
      'Recovery-required run was superseded by an explicit continue or retry action.'
    );
  }

  async syncGoal(
    task: Task,
    sessionId: string
  ): Promise<import('../../shared/contracts').AgentGoalSnapshotRecord> {
    this.assertProviderStartupAvailable();
    const session = await this.requireSession(sessionId);
    if (session.taskId !== task.id) {
      throw new Error('Agent session does not belong to the selected task.');
    }
    if (session.runtimeId !== task.runtimeId) {
      throw new Error('Agent session runtime does not match the selected task.');
    }
    const adapter = this.runtimes.require(session.runtimeId);
    const capabilities = await adapter.capabilities();
    if (this.options.allowNetworkAccess === false) {
      assertBrowserDevRuntimeIsolation(adapter.descriptor, capabilities);
    }
    if (
      !session.providerSessionId ||
      capabilities.goals.maturity === 'unsupported' ||
      !adapter.syncGoal
    ) {
      throw new Error('This provider session cannot synchronize goals.');
    }
    return adapter.syncGoal({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      authoritativeGoal: task.prompt,
      force: true
    });
  }

  async shutdown(): Promise<void> {
    for (const dispose of this.disposeRuntimeTurnListeners.splice(0)) dispose();
    this.runtimeTurnListeners.clear();
    await this.runtimes.shutdownAll();
  }

  private async startProviderTurn(
    adapter: AgentRuntimeAdapter,
    run: RunRecord,
    session: AgentSessionRecord,
    input: StartOrchestratedTurn,
    settings: AgentExecutionSettings,
    attachments: AgentTurnAttachment[]
  ): Promise<boolean> {
    if (!(await this.claimTaskTurnSubmission(run.id))) return false;
    await adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: input.mode,
      prompt: input.prompt,
      authoritativeGoal: input.task.prompt,
      instructionProfile: input.instructionProfile,
      attachments,
      settings
    });
    return true;
  }

  private async claimTaskTurnSubmission(runId: string): Promise<boolean> {
    const current = await this.runtimeStore.getRun(runId);
    if (!current || current.owner.kind !== 'TASK') {
      throw new Error(`Task agent runtime run not found: ${runId}`);
    }
    if (isTerminalRuntimeRun(current.status)) return false;
    if (current.status !== 'QUEUED' || current.delivery !== 'NOT_SENT') {
      throw new Error(
        `Task turn cannot begin provider submission from ${current.status}/${current.delivery}.`
      );
    }
    const startedAt = new Date().toISOString();
    try {
      await this.runtimeStore.updateRun(
        current.id,
        current.recordRevision,
        {
          status: 'STARTING',
          delivery: 'SENDING',
          startedAt,
          lastEventAt: startedAt
        },
        `task-turn-send-intent:${current.id}`
      );
      return true;
    } catch (error) {
      const latest = await this.runtimeStore.getRun(current.id);
      if (latest && isTerminalRuntimeRun(latest.status)) return false;
      throw error;
    }
  }

  private async startProviderReview(
    adapter: AgentRuntimeAdapter,
    run: RunRecord,
    sourceSession: AgentSessionRecord,
    reviewSession: AgentSessionRecord,
    target: AgentReviewTarget,
    attachments: AgentTurnAttachment[]
  ): Promise<void> {
    if (!adapter.startReview) {
      throw new Error('This provider does not support detached review.');
    }
    await adapter.startReview({
      localRunId: run.id,
      sourceSession: {
        localSessionId: sourceSession.id,
        providerSessionId: sourceSession.providerSessionId
      },
      reviewSessionId: reviewSession.id,
      target,
      attachments
    });
  }

  private async replaceUndeliveredTaskTurn(input: {
    adapter: AgentRuntimeAdapter;
    sourceSession: AgentSessionRecord;
    sourceRun: RunRecord;
    input: StartOrchestratedTurn;
    settings: AgentExecutionSettings;
    attachmentRecords: readonly TaskAttachmentRecord[];
    attachments: AgentTurnAttachment[];
    error: AgentProviderSessionMissingError;
  }): Promise<RunRecord> {
    const current = (await this.taskRuntime.getRun(input.sourceRun.id)) ?? input.sourceRun;
    if (
      current.providerTurnId ||
      current.status === 'RECOVERY_REQUIRED' ||
      !ACTIVE_RUN_STATUSES.includes(current.status)
    ) {
      throw input.error;
    }
    await this.taskRuntime.updateRun(
      current.id,
      {
        status: 'FAILED',
        terminalReason: `${input.adapter.descriptor.displayName} could not resume its provider session during ${input.error.operation}. Task Monki started a replacement session without resending an uncertain turn.`
      },
      `missing-provider-session-run:${current.id}`
    );

    const replacementSessionId = randomUUID();
    const replacementSessionOperation =
      `replacement-session:${input.sourceSession.id}:${current.id}`;
    let replacementSession = await this.taskRuntime.createTaskSession({
      id: replacementSessionId,
      taskId: input.input.task.id,
      iterationId: input.input.iteration.id,
      worktreeId: input.input.worktree.id,
      worktreePath: input.input.worktree.worktreePath,
      runtimeId: input.sourceSession.runtimeId,
      role: input.sourceSession.role,
      requestedSettings: input.settings,
      parentSessionId: input.sourceSession.id,
      forkedFromSessionId:
        input.error.operation === 'thread/fork' && input.adapter.forkSession
          ? input.sourceSession.id
          : undefined,
      executionContext: taskExecutionContext({
        sessionId: replacementSessionId,
        operationId: replacementSessionOperation,
        worktree: input.input.worktree,
        settings: input.settings,
        attachments: input.attachmentRecords,
        allowDynamicTools: input.input.mode === 'DESIGN'
      }),
      operationId: replacementSessionOperation
    });
    await this.store.recordAgentSessionCreated(replacementSession);

    const replacementRun = await this.taskRuntime.createTaskRun({
      id: randomUUID(),
      taskId: input.input.task.id,
      iterationId: input.input.iteration.id,
      worktreeId: input.input.worktree.id,
      sessionId: replacementSession.id,
      mode: input.input.mode,
      prompt: input.input.prompt,
      generationKey: input.input.generationKey,
      requestedSettings: input.settings,
      beforeGitSnapshotId: input.input.beforeGitSnapshotId,
      retryOfRunId: current.id,
      continuedFromRunId: input.input.continuedFromRunId,
      instructionProfile: input.input.instructionProfile,
      operationId: `replacement-run:${current.id}`
    });
    await this.store.recordAgentRunStarted(replacementRun);

    try {
      const replacementAttachments = toAgentTurnAttachments(
        await this.store.prepareRunAttachments(
          replacementRun.id,
          input.input.task.id
        )
      );
      if (
        input.error.operation === 'thread/fork' &&
        input.adapter.forkSession &&
        input.sourceSession.providerSessionId
      ) {
        try {
          replacementSession = await input.adapter.forkSession({
            sourceSession: {
              localSessionId: input.sourceSession.id,
              providerSessionId: input.sourceSession.providerSessionId
            },
            localSessionId: replacementSession.id,
            settings: input.settings,
            attachments: replacementAttachments
          });
        } catch (forkError) {
          if (!(forkError instanceof AgentProviderSessionMissingError)) throw forkError;
          replacementSession = await input.adapter.createSession({
            runtimeId: replacementSession.runtimeId,
            localSessionId: replacementSession.id,
            taskId: replacementSession.taskId,
            iterationId: replacementSession.iterationId,
            worktreeId: replacementSession.worktreeId,
            worktreePath: replacementSession.worktreePath,
            settings: input.settings,
            attachments: replacementAttachments
          });
        }
      } else {
        replacementSession = await input.adapter.createSession({
          runtimeId: replacementSession.runtimeId,
          localSessionId: replacementSession.id,
          taskId: replacementSession.taskId,
          iterationId: replacementSession.iterationId,
          worktreeId: replacementSession.worktreeId,
          worktreePath: replacementSession.worktreePath,
          settings: input.settings,
          attachments: replacementAttachments
        });
      }
      await this.taskRuntime.updateAgentSession(
        replacementSession.id,
        {
          relationshipDetail: `${input.adapter.descriptor.displayName} replaced session ${input.sourceSession.id} after ${input.error.operation} proved that the old provider session could not be used.`
        },
        `replacement-session-detail:${replacementSession.id}`
      );
      assertSessionPostcondition(
        replacementSession,
        await this.requireSession(replacementSession.id),
        'Replacement session'
      );
      await this.assertBrowserDevSessionHistory(
        replacementSession,
        'Replacement session'
      );
      await this.startProviderTurn(
        input.adapter,
        replacementRun,
        replacementSession,
        input.input,
        input.settings,
        replacementAttachments
      );
      return (await this.taskRuntime.getRun(replacementRun.id)) ?? replacementRun;
    } catch (replacementError) {
      await this.recordStartFailure(replacementRun, replacementError);
      throw replacementError;
    }
  }

  private async createReplacementReviewSourceSession(input: {
    adapter: AgentRuntimeAdapter;
    sourceSession: AgentSessionRecord;
    task: Task;
    iteration: TaskIteration;
    worktree: WorktreeRecord;
    settings: AgentExecutionSettings;
    attachmentRecords: readonly TaskAttachmentRecord[];
    attachments: AgentTurnAttachment[];
    error: AgentProviderSessionMissingError;
    runId: string;
  }): Promise<AgentSessionRecord> {
    const sessionId = randomUUID();
    const operationId =
      `review-source-replacement:${input.sourceSession.id}:${input.runId}`;
    const localSession = await this.taskRuntime.createTaskSession({
      id: sessionId,
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      worktreePath: input.worktree.worktreePath,
      runtimeId: input.sourceSession.runtimeId,
      role: 'PRIMARY',
      requestedSettings: input.settings,
      parentSessionId: input.sourceSession.id,
      executionContext: taskExecutionContext({
        sessionId,
        operationId,
        worktree: input.worktree,
        settings: input.settings,
        attachments: input.attachmentRecords,
        allowDynamicTools: false
      }),
      operationId
    });
    await this.store.recordAgentSessionCreated(localSession);
    const replacement = await input.adapter.createSession({
      runtimeId: localSession.runtimeId,
      localSessionId: localSession.id,
      taskId: localSession.taskId,
      iterationId: localSession.iterationId,
      worktreeId: localSession.worktreeId,
      worktreePath: localSession.worktreePath,
      settings: input.settings,
      attachments: input.attachments
    });
    assertSessionPostcondition(replacement, localSession, 'Replacement review source');
    await this.taskRuntime.updateAgentSession(
      replacement.id,
      {
        relationshipDetail: `${input.adapter.descriptor.displayName} replaced review source ${input.sourceSession.id} after ${input.error.operation} proved that its provider session was missing.`
      },
      `review-source-replacement-detail:${replacement.id}`
    );
    return replacement;
  }

  private async validateSettings(
    adapter: AgentRuntimeAdapter,
    settings: AgentExecutionSettings,
    attachments: readonly Pick<AgentTurnAttachment, 'kind'>[] = []
  ): Promise<AgentExecutionSettings> {
    if (this.options.allowNetworkAccess === false) {
      assertBrowserDevRuntimeIsolation(
        adapter.descriptor,
        await adapter.capabilities()
      );
    }
    const resolvedSettings = (await adapter.resolveExecution({ settings, attachments })).settings;
    if (resolvedSettings.runtimeId !== adapter.descriptor.id) {
      throw new Error(
        `Runtime ${adapter.descriptor.id} returned execution settings for ${String(resolvedSettings.runtimeId)}.`
      );
    }
    if (this.options.allowNetworkAccess === false) {
      this.assertBrowserDevSettings(resolvedSettings, 'Requested run');
    }
    return resolvedSettings;
  }

  /**
   * Browser development publishes a loopback credential after service
   * initialization. Persisted turns must therefore be made terminal before
   * the provider starts or resumes any thread; checking only newly submitted
   * turns leaves a cold-start recovery bypass.
   */
  private async terminalizeUnsafePersistedRuns(
    unsafeRuntimeIds: ReadonlySet<string> = new Set()
  ): Promise<number> {
    const snapshot = await this.taskRuntime.snapshot();
    let terminalized = 0;
    const sessions = new Map(snapshot.agentSessions.map((session) => [session.id, session]));
    const latestSettingsObservations = new Map<
      string,
      (typeof snapshot.agentSettingsObservations)[number]
    >();
    for (const observation of snapshot.agentSettingsObservations) {
      const current = latestSettingsObservations.get(observation.sessionId);
      if (
        !current ||
        observation.observedAt > current.observedAt
      ) {
        latestSettingsObservations.set(observation.sessionId, observation);
      }
    }
    for (const run of snapshot.runs.filter((candidate) =>
      RECOVERABLE_RUN_STATUSES.includes(candidate.status)
    )) {
      const runViolations = browserDevSettingsViolations(run.requestedSettings).map(
        (violation) => `run ${violation}`
      );
      if (run.observedSettings) {
        runViolations.push(
          ...browserDevSettingsViolations(run.observedSettings).map(
            (violation) => `run observed settings ${violation}`
          )
        );
      }
      if (
        snapshot.interactionRequests.some(
          (interaction) =>
            interaction.runId === run.id &&
            interaction.type !== 'USER_INPUT' &&
            (interaction.status === 'PENDING' || interaction.status === 'RESPONDING')
        )
      ) {
        runViolations.push('run has a persisted provider approval request');
      }
      const session = sessions.get(run.sessionId);
      const sessionViolations = session
        ? [
            ...browserDevSettingsViolations(session.requestedSettings).map(
              (violation) => `session ${violation}`
            ),
            ...(session.observedSettings
              ? browserDevSettingsViolations(session.observedSettings).map(
                  (violation) => `session observed settings ${violation}`
                )
              : [])
          ]
        : [];
      const latestObservation = latestSettingsObservations.get(run.sessionId);
      const observationViolations = latestObservation
        ? browserDevSettingsViolations(latestObservation.settings).map(
            (violation) => `latest settings observation ${violation}`
          )
        : [];
      const violations = [
        ...new Set([
          ...(unsafeRuntimeIds.has(run.runtimeId)
            ? [`runtime ${run.runtimeId} does not attest the browser development isolation boundary`]
            : []),
          ...runViolations,
          ...sessionViolations,
          ...observationViolations
        ])
      ];
      if (violations.length === 0) continue;

      const reason = `${BROWSER_DEV_BOUNDARY_MESSAGE} The persisted run was not resumed because of: ${violations.join(', ')}.`;
      const finalArtifact = await this.taskRuntime.writeFinalArtifact(
        run.taskId,
        run.id,
        `# Agent turn blocked at startup\n\n${reason}\n`,
        `browser-boundary-final:${run.id}`
      );
      await this.taskRuntime.applyTaskRuntimeEvent(
        createDomainEvent({
          type: 'AGENT_RUN_FAILED',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: run.serverInstanceId,
          source: 'process',
          payload: {
            error: reason,
            terminalReason: reason,
            finalArtifactId: finalArtifact.id,
            securityBoundary: 'BROWSER_DEV'
          }
        }),
        `browser-boundary-failed:${run.id}`
      );
      for (const interaction of snapshot.interactionRequests.filter(
        (candidate) =>
          candidate.runId === run.id &&
          (candidate.status === 'PENDING' || candidate.status === 'RESPONDING')
      )) {
        await this.taskRuntime.transitionInteractionRequest(interaction.id, interaction.status, {
          status: 'STALE',
          resolution: { reason },
          resolvedAt: new Date().toISOString()
        }, `browser-boundary-interaction:${interaction.id}`);
      }
      if (session) {
        await this.taskRuntime.updateAgentSession(
          session.id,
          { status: 'NOT_LOADED' },
          `browser-boundary-session:${session.id}`
        );
      }
      this.events.emit({
        type: 'run.terminal',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: { status: 'failed', error: reason, finalArtifactId: finalArtifact.id },
        at: new Date().toISOString()
      });
      terminalized += 1;
    }
    return terminalized;
  }

  private async classifyBrowserRuntimeIsolation(): Promise<{
    safeRuntimeIds: string[];
    unsafeRuntimeIds: Set<string>;
  }> {
    const safeRuntimeIds: string[] = [];
    const unsafeRuntimeIds = new Set<string>();
    await Promise.all(
      this.runtimes.list().map(async (adapter) => {
        try {
          assertBrowserDevRuntimeIsolation(
            adapter.descriptor,
            await adapter.capabilities()
          );
          safeRuntimeIds.push(adapter.descriptor.id);
        } catch {
          unsafeRuntimeIds.add(adapter.descriptor.id);
        }
      })
    );
    return { safeRuntimeIds, unsafeRuntimeIds };
  }

  private assertBrowserDevSettings(
    settings: AgentExecutionSettings,
    subject: string
  ): void {
    if (this.options.allowNetworkAccess !== false) return;
    assertBrowserDevSettingsSafe(settings, subject);
  }

  private assertProviderStartupAvailable(): void {
    if (this.options.providerStartupDisabledReason) {
      throw new Error(this.options.providerStartupDisabledReason);
    }
  }

  private async assertBrowserDevSessionHistory(
    session: AgentSessionRecord,
    subject: string
  ): Promise<void> {
    if (this.options.allowNetworkAccess !== false) return;
    this.assertBrowserDevSettings(session.requestedSettings, subject);
    if (session.observedSettings) {
      this.assertBrowserDevSettings(session.observedSettings, `${subject} observed settings`);
    }
    const snapshot = await this.taskRuntime.snapshot();
    const latestObservation = snapshot.agentSettingsObservations.find(
      (observation) => observation.sessionId === session.id
    );
    if (latestObservation) {
      this.assertBrowserDevSettings(
        latestObservation.settings,
        `${subject} latest settings observation`
      );
    }
  }

  private async assertCapacity(): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    const activeRunCount = snapshot.runs.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(run.status)
    ).length;
    if (activeRunCount >= MAX_CONCURRENT_TURNS) {
      throw new Error(
        `Task Monki allows at most ${MAX_CONCURRENT_TURNS} active agent turns.`
      );
    }
  }

  private async assertNoPendingInteractions(sessionId: string): Promise<void> {
    const snapshot = await this.taskRuntime.snapshot();
    const pending = snapshot.interactionRequests.find(
      (interaction) =>
        interaction.sessionId === sessionId &&
        ['PENDING', 'RESPONDING'].includes(interaction.status)
    );
    if (pending) {
      throw new Error(
        `Resolve the pending ${pending.type.toLowerCase().replaceAll('_', ' ')} before starting another turn.`
      );
    }
  }

  private async requireSession(sessionId: string) {
    const session = await this.taskRuntime.getAgentSession(sessionId);
    if (!session) {
      throw new Error(`Agent session not found: ${sessionId}`);
    }
    return session;
  }

  private assertRunRuntimeOwnership(
    run: RunRecord,
    session: AgentSessionRecord
  ): void {
    if (run.sessionId !== session.id || run.runtimeId !== session.runtimeId) {
      throw new Error('Agent run runtime ownership is inconsistent.');
    }
  }

  private async recordStartFailure(run: RunRecord, error: unknown): Promise<void> {
    if (error instanceof AgentMutationAmbiguousError) {
      await this.recordAmbiguousMutation(run, error);
      return;
    }
    const current = await this.taskRuntime.getRun(run.id);
    if (!current || !ACTIVE_RUN_STATUSES.includes(current.status)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const recorded = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
      createDomainEvent({
        type: 'AGENT_RUN_FAILED',
        taskId: current.taskId,
        iterationId: current.iterationId,
        runId: current.id,
        worktreeId: current.worktreeId,
        agentSessionId: current.sessionId,
        source: 'provider',
        payload: { error: message }
      }),
      ACTIVE_RUN_STATUSES,
      `start-failed:${current.id}`
    );
    if (!recorded) return;
    let finalArtifactId: string | undefined;
    try {
      const finalArtifact = await this.taskRuntime.writeFinalArtifact(
        current.taskId,
        current.id,
        `# Agent turn failed to start\n\n${message}\n`,
        `start-failed-final:${current.id}`
      );
      finalArtifactId = finalArtifact.id;
      await this.taskRuntime.applyTaskRuntimeEvent(
        createDomainEvent({
          type: 'ARTIFACT_CREATED',
          taskId: current.taskId,
          iterationId: current.iterationId,
          runId: current.id,
          worktreeId: current.worktreeId,
          agentSessionId: current.sessionId,
          source: 'storage',
          payload: {
            artifactId: finalArtifact.id,
            kind: 'agent-final'
          }
        }),
        `start-failed-artifact-link:${current.id}`
      );
    } catch (artifactError) {
      const artifactMessage =
        artifactError instanceof Error ? artifactError.message : String(artifactError);
      await this.taskRuntime
        .appendArtifact(
          current.diagnosticArtifactId,
          `\n[task-monki/start-failure-artifact]\n${artifactMessage}\n`,
          `start-failed-diagnostic:${current.id}`
        )
        .catch(() => undefined);
    }
    this.events.emit({
      type: 'run.terminal',
      taskId: current.taskId,
      iterationId: current.iterationId,
      runId: current.id,
      worktreeId: current.worktreeId,
      payload: {
        status: 'failed',
        error: message,
        ...(finalArtifactId ? { finalArtifactId } : {})
      },
      at: new Date().toISOString()
    });
  }

  private async resolveRecoveryRun(run: RunRecord, terminalReason: string): Promise<void> {
    const finalArtifact = await this.taskRuntime.writeFinalArtifact(
      run.taskId,
      run.id,
      `# Recovery run closed\n\n${terminalReason}\n`,
      `recovery-closed-final:${run.id}`
    );
    await this.taskRuntime.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'AGENT_RUN_INTERRUPTED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'ui',
        payload: { terminalReason, finalArtifactId: finalArtifact.id }
      }),
      `recovery-closed:${run.id}`
    );
    this.events.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: 'interrupted', terminalReason },
      at: new Date().toISOString()
    });
  }

  private async recordAmbiguousMutation(
    run: RunRecord,
    error: AgentMutationAmbiguousError
  ): Promise<void> {
    const current = (await this.taskRuntime.getRun(run.id)) ?? run;
    const recorded = await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
      createDomainEvent({
        type: 'AGENT_MUTATION_AMBIGUOUS',
        taskId: current.taskId,
        iterationId: current.iterationId,
        runId: current.id,
        worktreeId: current.worktreeId,
        agentSessionId: current.sessionId,
        serverInstanceId: current.serverInstanceId,
        source: 'provider',
        payload: {
          operation: error.operation,
          reason: error.message,
          automaticResubmission: false
        }
      }),
      ACTIVE_RUN_STATUSES,
      `mutation-ambiguous:${current.id}:${error.operation}`
    );
    if (!recorded) return;
    this.events.emit({
      type: 'run.state.updated',
      taskId: current.taskId,
      iterationId: current.iterationId,
      runId: current.id,
      worktreeId: current.worktreeId,
      payload: {
        eventType: 'mutation/ambiguous',
        operation: error.operation
      },
      at: new Date().toISOString()
    });
  }
}
