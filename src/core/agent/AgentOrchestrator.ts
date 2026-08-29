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
import {
  toAgentTurnAttachments,
  verifyAgentTurnAttachments,
  type AgentTurnAttachment
} from './AgentAttachmentDelivery';
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
import {
  assertReadOnlyExecutionContext,
  createAgentSessionAccessEpoch
} from './AgentRuntimeOwnership';
import { inspectGitWorkingTreeFingerprint } from '../git/GitSnapshotService';
import {
  agentReviewStatusFromResult,
  parseAgentReviewResult
} from '../review/AgentReviewContract';

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

function isReadOnlyRuntimePurpose(
  purpose: import('../../shared/agentRuntime').AgentRuntimePurpose
): boolean {
  return (
    purpose === 'TASK_REVIEW' ||
    purpose === 'PROMPT_REFINEMENT' ||
    purpose.startsWith('DISCOURSE_')
  );
}

async function inspectReadOnlyRepositoryState(
  context: import('../../shared/agentRuntime').AgentExecutionContext
): Promise<string | undefined> {
  const roots = context.readRoots
    .filter((root) => root.kind === 'WORKTREE' || root.kind === 'REPOSITORY')
    .map((root) => root.canonicalPath)
    .sort();
  if (roots.length === 0) return undefined;
  const fingerprints = await Promise.all(
    roots.map(async (root) => ({
      root,
      fingerprint: await inspectGitWorkingTreeFingerprint(root)
    }))
  );
  const hash = createHash('sha256');
  for (const entry of fingerprints) {
    hash.update(entry.root);
    hash.update('\0');
    hash.update(entry.fingerprint);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function verifyRuntimeTurnAttachments(
  context: import('../../shared/agentRuntime').AgentExecutionContext,
  attachments: readonly AgentTurnAttachment[]
): Promise<AgentTurnAttachment[]> {
  const verified = await verifyAgentTurnAttachments(attachments);
  const expected = [...context.managedAttachments].sort((left, right) =>
    left.attachmentId.localeCompare(right.attachmentId)
  );
  const actual = verified
    .map((attachment) => ({
      attachmentId: attachment.attachmentId,
      contentSha256: attachment.sha256,
      byteCount: attachment.byteCount
    }))
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      'Runtime turn attachments do not match the attested execution context.'
    );
  }
  return verified;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    repositoryAccess: 'WRITE',
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
  private runtimeTurnEventQueue: Promise<void> = Promise.resolve();

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
          this.enqueueRuntimeTurnEvent(event);
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
        role: input.role ?? 'PRIMARY',
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.forkedFromSessionId
          ? { forkedFromSessionId: input.forkedFromSessionId }
          : {}),
        relationshipState: 'ROOT',
        status: 'NOT_MATERIALIZED',
        materialized: false,
        requestedSettings: input.executionContext.modelSettings,
        ...(input.taskContext ? { taskContext: input.taskContext } : {})
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
        diagnosticArtifactId,
        ...(input.taskDetails ? { taskDetails: input.taskDetails } : {}),
        ...(input.taskReviewTarget
          ? { taskReviewTarget: input.taskReviewTarget }
          : {})
      },
      prompt: input.prompt,
      priority: input.priority,
      queueOperationId: `${input.clientOperationId}:enqueue`,
      notBefore: input.notBefore
    });
  }

  async startPreparedTurn(
    queueEntryId: string,
    clientOperationId: string,
    attachments: readonly AgentTurnAttachment[] = []
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
    const verifiedAttachments = await verifyRuntimeTurnAttachments(
      session.executionContext,
      attachments
    );
    if (isReadOnlyRuntimePurpose(run.purpose)) {
      assertReadOnlyExecutionContext(session.executionContext);
      try {
        const beforeFingerprint = await inspectReadOnlyRepositoryState(
          session.executionContext
        );
        run = await this.runtimeStore.updateRun(
          run.id,
          run.recordRevision,
          {
            repositoryIntegrity: {
              ...(beforeFingerprint ? { beforeFingerprint } : {}),
              status: 'PENDING'
            }
          },
          `${clientOperationId}:repository-before`
        );
      } catch (error) {
        const endedAt = new Date().toISOString();
        const detail = `Task Monki could not inspect the repository before the read-only turn: ${errorMessage(error)}`;
        run = await this.runtimeStore.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'FAILED',
            delivery: 'NOT_DELIVERED',
            recoveryState: 'NONE',
            repositoryIntegrity: {
              status: 'UNVERIFIABLE',
              checkedAt: endedAt,
              detail
            },
            terminalReason: detail,
            providerTerminalSource: 'REPOSITORY_INTEGRITY',
            lastEventAt: endedAt,
            endedAt
          },
          `${clientOperationId}:repository-before-failed`
        );
        await this.settleRuntimeQueueEntry(entry.id, `${clientOperationId}:settle-before-failed`);
        throw new Error(detail, { cause: error });
      }
    }
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
        prompt,
        attachments: verifiedAttachments
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
          ...(started.attachmentSubmissions
            ? { attachmentSubmissions: started.attachmentSubmissions }
            : {}),
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
      run = await this.runtimeStore.updateRun(
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
        if (isReadOnlyRuntimePurpose(run.purpose)) {
          await this.verifyReadOnlyRuntimeBoundary({
            type: 'TERMINAL',
            runId: run.id,
            providerTurnId: run.providerTurnId ?? run.id,
            status: 'failed',
            error: run.terminalReason,
            completedAt: run.endedAt ?? observedAt
          });
        }
      }
      throw error;
    }
  }

  async startPreparedTurnNow(
    queueEntryId: string,
    clientOperationId: string,
    attachments: readonly AgentTurnAttachment[] = []
  ) {
    const entry = (await this.runtimeStore.snapshot()).queueEntries.find(
      (candidate) => candidate.id === queueEntryId
    );
    if (!entry) throw new Error(`Agent runtime queue entry not found: ${queueEntryId}`);
    if (entry.status === 'QUEUED') {
      await this.runtimeStore.leaseQueueEntry(
        entry.id,
        entry.recordRevision,
        `${clientOperationId}:lease`
      );
    } else if (entry.status !== 'LEASED') {
      const run = await this.runtimeStore.getRun(entry.runId);
      if (run && isTerminalRuntimeRun(run.status)) return run;
      throw new Error(`Runtime turn cannot start from queue state ${entry.status}.`);
    }
    return this.startPreparedTurn(queueEntryId, clientOperationId, attachments);
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
        ...(isReadOnlyRuntimePurpose(run.purpose)
          ? {
              repositoryIntegrity: {
                status: 'UNCHANGED' as const,
                checkedAt: endedAt
              }
            }
          : {}),
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
      if (
        isTerminalRuntimeRun(latest.status) ||
        latest.status === 'RECOVERY_REQUIRED'
      ) {
        return latest;
      }
      const interruptDelivery =
        error instanceof AgentRuntimeDeliveryError
          ? error.delivery
          : 'AMBIGUOUS';
      const terminalReason = error instanceof Error ? error.message : String(error);
      if (interruptDelivery === 'AMBIGUOUS') {
        return this.runtimeStore.updateRun(
          latest.id,
          latest.recordRevision,
          {
            status: 'INTERRUPTING',
            interruptDelivery,
            recoveryState: 'NONE',
            terminalReason,
            lastEventAt: new Date().toISOString()
          },
          `${clientOperationId}:runtime-stop-ambiguous`
        );
      }
      return this.runtimeStore.updateRun(
        latest.id,
        latest.recordRevision,
        {
          status: 'RECOVERY_REQUIRED',
          interruptDelivery,
          recoveryState: 'REQUIRES_USER_ACTION',
          terminalReason,
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

  async releaseRuntimeSession(sessionId: string): Promise<void> {
    await this.runtimeTurnEventQueue;
    await this.releaseRuntimeSessionNow(sessionId);
  }

  async finishRuntimeTurn(runId: string): Promise<void> {
    await this.runtimeTurnEventQueue;
    const run = await this.runtimeStore.getRun(runId);
    if (!run || !isTerminalRuntimeRun(run.status)) return;
    await this.settleRuntimeQueueEntryForRun(
      run.id,
      `runtime-finish-settle:${run.id}`
    );
    const released = await this.releaseTerminalRuntimeSession(run);
    if (released && run.owner.kind === 'PROMPT_REFINEMENT') {
      await this.runtimeStore
        .purgePromptRefinement(run.owner.requestId)
        .catch((error) =>
          this.appendRuntimeDiagnostic(
            run,
            `Task Monki could not clean up prompt-refinement records: ${errorMessage(error)}`
          )
        );
    }
  }

  private async releaseRuntimeSessionNow(sessionId: string): Promise<void> {
    const session = await this.runtimeStore.getSession(sessionId);
    if (!session) return;
    const activeRun = await this.runtimeStore.getActiveRunForSession(session.id);
    if (activeRun) {
      throw new Error(
        `Cannot release runtime session ${session.id} while run ${activeRun.id} is ${activeRun.status}.`
      );
    }
    const adapter = this.runtimes.require(session.runtimeId);
    await adapter.releaseSession?.({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
  }

  private async releaseTerminalRuntimeSession(
    run: import('../../shared/agentRuntime').AgentRuntimeRunRecord
  ): Promise<boolean> {
    try {
      await this.releaseRuntimeSessionNow(run.sessionId);
      return true;
    } catch (error) {
      const reason = `Task Monki could not release the provider session: ${errorMessage(error)}`;
      await this.appendRuntimeDiagnostic(run, reason).catch(() => undefined);
      const session = await this.runtimeStore.getSession(run.sessionId).catch(() => undefined);
      if (session && session.status !== 'SYSTEM_ERROR') {
        await this.runtimeStore
          .updateSession(
            session.id,
            session.recordRevision,
            { status: 'SYSTEM_ERROR' },
            `runtime-release-failed:${run.id}`
          )
          .catch(() => undefined);
      }
      return false;
    }
  }

  async waitForRuntimeTurn(
    runId: string,
    timeoutMs: number
  ): Promise<{
    run: import('../../shared/agentRuntime').AgentRuntimeRunRecord;
    output: string;
  }> {
    const readTerminal = async () => {
      const run = await this.runtimeStore.getRun(runId);
      if (!run) return undefined;
      if (run.status === 'RECOVERY_REQUIRED') {
        throw new Error(
          run.terminalReason ?? 'The agent runtime turn requires recovery.'
        );
      }
      if (!isTerminalRuntimeRun(run.status)) return undefined;
      if (isReadOnlyRuntimePurpose(run.purpose)) {
        const integrity = run.repositoryIntegrity;
        if (!integrity || integrity.status === 'PENDING') return undefined;
        if (integrity.status !== 'UNCHANGED' && run.status !== 'FAILED') {
          return undefined;
        }
      }
      return {
        run,
        output: await this.runtimeStore.readArtifact(run.outputArtifactId)
      };
    };
    const existing = await readTerminal();
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        operation();
      };
      const unsubscribe = this.subscribe((event) => {
        if (event.runId !== runId) return;
        if (event.type === 'RECOVERY_REQUIRED') {
          finish(() => reject(new Error(event.reason)));
          return;
        }
        if (event.type !== 'TERMINAL') return;
        void readTerminal().then(
          (result) => {
            if (!result) {
              finish(() =>
                reject(new Error('The provider reported completion without durable state.'))
              );
              return;
            }
            finish(() => resolve(result));
          },
          (error) => finish(() => reject(error))
        );
      });
      const timer = setTimeout(() => {
        finish(() => reject(new Error('The agent runtime turn timed out.')));
      }, timeoutMs);
      timer.unref();
      // A provider can settle between the first read and listener registration.
      // Re-read after subscribing so a fast terminal event cannot be missed.
      void readTerminal().then(
        (result) => {
          if (result) finish(() => resolve(result));
        },
        (error) => finish(() => reject(error))
      );
    });
  }

  private enqueueRuntimeTurnEvent(event: AgentRuntimeTurnEvent): void {
    const operation = this.runtimeTurnEventQueue.then(() =>
      this.processRuntimeTurnEvent(event)
    );
    this.runtimeTurnEventQueue = operation
      .catch((error) => this.recoverRuntimeTurnEventProcessing(event, error))
      .catch(() => undefined);
  }

  private async processRuntimeTurnEvent(event: AgentRuntimeTurnEvent): Promise<void> {
    const verifiedEvent =
      event.type === 'TERMINAL' || event.type === 'RECOVERY_REQUIRED'
        ? await this.verifyReadOnlyRuntimeBoundary(event)
        : event;
    await this.projectTaskReadOnlyRuntimeEvent(verifiedEvent);
    for (const listener of this.runtimeTurnListeners) {
      try {
        listener(verifiedEvent);
      } catch (error) {
        const run = await this.runtimeStore.getRun(verifiedEvent.runId);
        if (run) {
          await this.appendRuntimeDiagnostic(
            run,
            `A runtime event listener failed: ${errorMessage(error)}`
          ).catch(() => undefined);
        }
      }
    }
  }

  private async recoverRuntimeTurnEventProcessing(
    event: AgentRuntimeTurnEvent,
    error: unknown
  ): Promise<void> {
    const reason = `Task Monki could not finish runtime event processing: ${errorMessage(error)}`;
    let run = await this.runtimeStore.getRun(event.runId).catch(() => undefined);
    if (run) {
      await this.appendRuntimeDiagnostic(run, reason).catch(() => undefined);
      if (run.status !== 'RECOVERY_REQUIRED') {
        const update = {
          status: 'RECOVERY_REQUIRED' as const,
          recoveryState: 'RECONCILING' as const,
          terminalReason: reason,
          lastEventAt: new Date().toISOString(),
          ...(isTerminalRuntimeRun(run.status) ? { endedAt: undefined } : {})
        };
        run = await this.runtimeStore
          .updateRun(
            run.id,
            run.recordRevision,
            update,
            `runtime-event-recovery:${run.id}:${event.type}`
          )
          .catch(() => run);
      }
    }
    const recoveryEvent: AgentRuntimeTurnEvent = {
      type: 'RECOVERY_REQUIRED',
      runId: event.runId,
      ...(run?.providerTurnId ? { providerTurnId: run.providerTurnId } : {}),
      reason,
      observedAt: new Date().toISOString()
    };
    await this.projectTaskReadOnlyRuntimeEvent(recoveryEvent).catch(() => undefined);
    for (const listener of this.runtimeTurnListeners) {
      try {
        listener(recoveryEvent);
      } catch {
        // One consumer must not prevent other workflows from seeing recovery.
      }
    }
  }

  private async verifyReadOnlyRuntimeBoundary(
    event:
      | Extract<AgentRuntimeTurnEvent, { type: 'TERMINAL' }>
      | Extract<AgentRuntimeTurnEvent, { type: 'RECOVERY_REQUIRED' }>
  ): Promise<AgentRuntimeTurnEvent> {
    let run = await this.runtimeStore.getRun(event.runId);
    if (!run || !isReadOnlyRuntimePurpose(run.purpose)) return event;
    if (run.repositoryIntegrity?.status === 'UNCHANGED') return event;
    if (
      run.repositoryIntegrity &&
      run.repositoryIntegrity.status !== 'PENDING'
    ) {
      return {
        type: 'TERMINAL',
        runId: event.runId,
        providerTurnId: run.providerTurnId ?? event.providerTurnId ?? run.id,
        status: 'failed',
        error:
          run.repositoryIntegrity.detail ??
          'Task Monki could not verify the repository boundary for this read-only turn.',
        completedAt:
          event.type === 'TERMINAL' ? event.completedAt : event.observedAt
      };
    }
    const session = await this.runtimeStore.getSession(run.sessionId);
    if (!session) return event;
    const repositoryRoots = session.executionContext.readRoots.filter(
      (root) => root.kind === 'WORKTREE' || root.kind === 'REPOSITORY'
    );
    const boundaryAt =
      event.type === 'TERMINAL' ? event.completedAt : event.observedAt;
    if (repositoryRoots.length === 0) {
      await this.runtimeStore.updateRun(
        run.id,
        run.recordRevision,
        {
          repositoryIntegrity: {
            status: 'UNCHANGED',
            checkedAt: boundaryAt
          }
        },
        `repository-integrity:${run.id}:${boundaryAt}`
      );
      return event;
    }

    let afterFingerprint: string | undefined;
    let failure: string | undefined;
    let status: NonNullable<
      import('../../shared/agentRuntime').AgentRuntimeRunRecord['repositoryIntegrity']
    >['status'];
    try {
      afterFingerprint = await inspectReadOnlyRepositoryState(
        session.executionContext
      );
      if (!run.repositoryIntegrity?.beforeFingerprint || !afterFingerprint) {
        status = 'UNVERIFIABLE';
        failure =
          'Task Monki could not verify the repository boundary for this read-only turn.';
      } else if (
        run.repositoryIntegrity.beforeFingerprint !== afterFingerprint
      ) {
        status = 'CHANGED';
        failure =
          'Repository state changed during the read-only turn. The changes were left in place as evidence.';
      } else {
        status = 'UNCHANGED';
      }
    } catch (error) {
      status = 'UNVERIFIABLE';
      failure = `Task Monki could not inspect the repository after the read-only turn: ${errorMessage(error)}`;
    }

    const integrity = {
      ...(run.repositoryIntegrity?.beforeFingerprint
        ? { beforeFingerprint: run.repositoryIntegrity.beforeFingerprint }
        : {}),
      ...(afterFingerprint ? { afterFingerprint } : {}),
      status,
      checkedAt: new Date().toISOString(),
      ...(failure ? { detail: failure } : {})
    };
    run = await this.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      { repositoryIntegrity: integrity },
      `repository-integrity:${run.id}:${boundaryAt}`
    );
    if (!failure) return event;

    await this.appendRuntimeDiagnostic(run, failure);
    await this.failRuntimeRunAfterIntegrityViolation(run, failure, boundaryAt);
    return {
      type: 'TERMINAL',
      runId: event.runId,
      providerTurnId: run.providerTurnId ?? event.providerTurnId ?? run.id,
      status: 'failed',
      error: failure,
      completedAt:
        event.type === 'TERMINAL' ? event.completedAt : event.observedAt
    };
  }

  private async projectTaskReadOnlyRuntimeEvent(
    event: AgentRuntimeTurnEvent
  ): Promise<void> {
    if (event.type === 'DELTA') return;
    const runtimeRun = await this.runtimeStore.getRun(event.runId);
    if (
      !runtimeRun ||
      runtimeRun.owner.kind !== 'TASK' ||
      runtimeRun.purpose !== 'TASK_REVIEW'
    ) {
      return;
    }
    const run = await this.taskRuntime.getRun(runtimeRun.id);
    if (!run) return;
    if (event.type === 'RECOVERY_REQUIRED') {
      await this.taskRuntime.applyTaskRuntimeEvent(
        createDomainEvent({
          type: 'AGENT_RUNTIME_LOST',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: run.serverInstanceId,
          source: 'provider',
          payload: { reason: event.reason }
        }),
        `shared-review-recovery:${run.id}:${event.observedAt}`
      );
      this.events.emit({
        type: 'run.state.updated',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: { eventType: 'runtime/recovery-required' },
        at: event.observedAt
      });
      return;
    }

    const output = await this.runtimeStore.readArtifact(runtimeRun.outputArtifactId);
    const finalArtifact = await this.taskRuntime.writeFinalArtifact(
      run.taskId,
      run.id,
      output.trim() || event.error || 'The review returned no final response.',
      `shared-review-final:${run.id}`
    );
    await this.taskRuntime.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'ARTIFACT_CREATED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'storage',
        payload: {
          artifactId: finalArtifact.id,
          kind: 'agent-final'
        }
      }),
      `shared-review-final-link:${run.id}`
    );
    const reviewResult =
      event.status === 'completed' ? parseAgentReviewResult(output) : undefined;
    const reviewStatus = agentReviewStatusFromResult(reviewResult);
    const type =
      event.status === 'completed'
        ? 'AGENT_RUN_COMPLETED'
        : event.status === 'interrupted'
          ? 'AGENT_RUN_INTERRUPTED'
          : 'AGENT_RUN_FAILED';
    await this.taskRuntime.applyTaskRuntimeEvent(
      createDomainEvent({
        type,
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: {
          terminalStatus: event.status,
          error: event.error,
          terminalReason: event.error,
          finalArtifactId: finalArtifact.id,
          agentReviewStatus: reviewStatus,
          agentReviewResult: reviewResult
        }
      }),
      `shared-review-terminal:${run.id}:${event.completedAt}`
    );
    await this.settleRuntimeQueueEntryForRun(
      run.id,
      `shared-review-settle:${run.id}`
    );
    await this.releaseTerminalRuntimeSession(runtimeRun);
    this.events.emit({
      type: 'run.terminal',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { status: event.status, finalArtifactId: finalArtifact.id },
      at: event.completedAt
    });
  }

  private async appendRuntimeDiagnostic(
    run: import('../../shared/agentRuntime').AgentRuntimeRunRecord,
    message: string
  ): Promise<void> {
    const artifact = await this.runtimeStore.getArtifact(run.diagnosticArtifactId);
    if (!artifact) return;
    const current = await this.runtimeStore.readArtifact(artifact.id);
    await this.runtimeStore.updateArtifact({
      artifactId: artifact.id,
      expectedRevision: artifact.recordRevision,
      clientOperationId: `repository-integrity-diagnostic:${run.id}`,
      content: `${current}${current ? '\n' : ''}${message}`
    });
  }

  private async failRuntimeRunAfterIntegrityViolation(
    run: import('../../shared/agentRuntime').AgentRuntimeRunRecord,
    reason: string,
    completedAt: string
  ): Promise<void> {
    let current = (await this.runtimeStore.getRun(run.id)) ?? run;
    if (current.status === 'FAILED') {
      await this.runtimeStore.updateRun(
        current.id,
        current.recordRevision,
        {
          terminalReason: reason,
          providerTerminalSource: 'REPOSITORY_INTEGRITY'
        },
        `repository-integrity-failed:${run.id}`
      );
      return;
    }
    if (isTerminalRuntimeRun(current.status)) {
      current = await this.runtimeStore.updateRun(
        current.id,
        current.recordRevision,
        {
          status: 'RECOVERY_REQUIRED',
          recoveryState: 'REQUIRES_USER_ACTION',
          terminalReason: reason,
          providerTerminalSource: 'REPOSITORY_INTEGRITY',
          endedAt: undefined
        },
        `repository-integrity-reopen:${run.id}`
      );
    }
    await this.runtimeStore.updateRun(
      current.id,
      current.recordRevision,
      {
        status: 'FAILED',
        delivery: current.providerTurnId ? 'TERMINAL' : 'NOT_DELIVERED',
        recoveryState: 'NONE',
        terminalReason: reason,
        providerTerminalSource: 'REPOSITORY_INTEGRITY',
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      `repository-integrity-terminal:${run.id}`
    );
  }

  private async settleRuntimeQueueEntry(
    queueEntryId: string,
    operationId: string
  ): Promise<void> {
    const entry = (await this.runtimeStore.snapshot()).queueEntries.find(
      (candidate) => candidate.id === queueEntryId
    );
    if (entry?.status === 'LEASED') {
      await this.runtimeStore.settleQueueEntry(
        entry.id,
        entry.recordRevision,
        operationId
      );
    }
  }

  private async settleRuntimeQueueEntryForRun(
    runId: string,
    operationId: string
  ): Promise<void> {
    const entry = (await this.runtimeStore.snapshot()).queueEntries.find(
      (candidate) => candidate.runId === runId
    );
    if (entry?.status === 'LEASED') {
      await this.runtimeStore.settleQueueEntry(
        entry.id,
        entry.recordRevision,
        operationId
      );
    }
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
    const persisted = await this.runtimeStore.snapshot();
    const runtimeIdBySessionId = new Map(
      persisted.sessions.map((session) => [session.id, session.runtimeId])
    );
    const recoveryRuntimeIds = new Set(
      persisted.runs
        .filter((run) => RECOVERABLE_RUN_STATUSES.includes(run.status))
        .flatMap((run) => {
          const runtimeId = runtimeIdBySessionId.get(run.sessionId);
          return runtimeId ? [runtimeId] : [];
        })
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
    await this.runtimeTurnEventQueue;
    await this.reconcileSettledReadOnlyTurns();
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

  private async reconcileSettledReadOnlyTurns(): Promise<void> {
    const snapshot = await this.runtimeStore.snapshot();
    const taskSnapshot = await this.store.snapshot();
    const publishedTaskRuntimeOperations = new Set(
      taskSnapshot.events
        .map((event) => {
          const operationId = (event.payload as { runtimeOperationId?: unknown })
            .runtimeOperationId;
          return typeof operationId === 'string' ? operationId : undefined;
        })
        .filter((operationId): operationId is string => operationId !== undefined)
    );
    for (const run of snapshot.runs) {
      const terminal = isTerminalRuntimeRun(run.status);
      const observedAt = run.endedAt ?? run.lastEventAt ?? run.createdAt;
      const taskProjectionOperationId = terminal
        ? `shared-review-terminal:${run.id}:${observedAt}`
        : `shared-review-recovery:${run.id}:${observedAt}`;
      const taskProjectionNeedsReconciliation =
        run.owner.kind === 'TASK' &&
        run.purpose === 'TASK_REVIEW' &&
        !publishedTaskRuntimeOperations.has(taskProjectionOperationId);
      const promptRefinementNeedsCleanup =
        run.owner.kind === 'PROMPT_REFINEMENT' && terminal;
      const queueEntry = snapshot.queueEntries.find(
        (candidate) => candidate.runId === run.id
      );
      const terminalQueueNeedsSettlement = terminal && queueEntry?.status === 'LEASED';
      if (
        !isReadOnlyRuntimePurpose(run.purpose) ||
        ![
          'COMPLETED',
          'FAILED',
          'INTERRUPTED',
          'LOST',
          'RECOVERY_REQUIRED'
        ].includes(run.status) ||
        !(
          run.repositoryIntegrity?.status === 'PENDING' ||
          taskProjectionNeedsReconciliation ||
          promptRefinementNeedsCleanup ||
          terminalQueueNeedsSettlement
        )
      ) {
        continue;
      }
      const event: AgentRuntimeTurnEvent = isTerminalRuntimeRun(run.status)
        ? {
            type: 'TERMINAL',
            runId: run.id,
            providerTurnId: run.providerTurnId ?? run.id,
            status:
              run.status === 'COMPLETED'
                ? 'completed'
                : run.status === 'INTERRUPTED'
                  ? 'interrupted'
                  : 'failed',
            ...(run.terminalReason ? { error: run.terminalReason } : {}),
            completedAt: observedAt
          }
        : {
            type: 'RECOVERY_REQUIRED',
            runId: run.id,
            ...(run.providerTurnId ? { providerTurnId: run.providerTurnId } : {}),
            reason:
              run.terminalReason ??
              'The provider turn requires recovery before Task Monki can trust its result.',
            observedAt
          };
      const needsEventProcessing =
        run.repositoryIntegrity?.status === 'PENDING' ||
        taskProjectionNeedsReconciliation;
      if (needsEventProcessing) {
        if (!run.providerTurnId && event.type === 'TERMINAL') {
          const verified = await this.verifyReadOnlyRuntimeBoundary(event);
          await this.projectTaskReadOnlyRuntimeEvent(verified);
        } else {
          await this.processRuntimeTurnEvent(event);
        }
      }
      if (event.type === 'TERMINAL') {
        if (run.owner.kind === 'PROMPT_REFINEMENT') {
          await this.finishRuntimeTurn(run.id);
        } else if (run.owner.kind === 'TASK' && run.purpose === 'TASK_REVIEW') {
          if (!needsEventProcessing && terminalQueueNeedsSettlement) {
            await this.finishRuntimeTurn(run.id);
          }
        } else {
          await this.settleRuntimeQueueEntryForRun(
            run.id,
            `startup-read-only-settle:${run.id}`
          );
        }
      }
    }
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
    const reviewSupport = projectAgentExecutionSupport(
      await adapter.capabilities(),
      'REVIEW'
    );
    if (!reviewSupport.supported) throw new Error(reviewSupport.reason);
    const taskAttachments = await this.store.getTaskAttachments(input.task.id);
    const settings = await this.validateSettings(
      adapter,
      { ...input.settings, runtimeId: reviewRuntimeId },
      taskAttachments
    );
    await this.assertCapacity();
    const preflightAttachments = toAgentTurnAttachments(
      await this.store.verifyTaskAttachments(input.task.id)
    );
    const reviewSessionId = randomUUID();
    const reviewSessionOperationId =
      `review-session:${input.task.id}:${input.sourceRun.id}:${input.generationKey ?? 'current'}:${reviewRuntimeId}`;
    const prompt = buildAgentReviewPrompt({
      task: input.task,
      worktree: input.worktree,
      target: input.target
    });
    const executionContext = await this.buildExecutionContext(reviewRuntimeId, {
      sessionId: reviewSessionId,
      primaryCwd: input.worktree.worktreePath,
      readRoots: [
        {
          canonicalPath: input.worktree.worktreePath,
          kind: 'WORKTREE',
          entityId: input.worktree.id
        }
      ],
      modelSettings: settings,
      clientOperationId: reviewSessionOperationId,
      attachments: preflightAttachments
    });
    const runId = randomUUID();
    const prepared = await this.prepareTurn({
      sessionId: reviewSessionId,
      runId,
      owner: { kind: 'TASK', taskId: input.task.id },
      scope: {
        kind: 'TASK',
        taskId: input.task.id,
        iterationId: input.iteration.id,
        worktreeId: input.worktree.id
      },
      runtimeId: reviewRuntimeId,
      model: settings.model ?? reviewRuntimeId,
      purpose: 'TASK_REVIEW',
      generationKey: input.generationKey ?? input.beforeGitSnapshotId ?? runId,
      executionContext,
      prompt,
      priority: 'TASK_FOREGROUND',
      clientOperationId: `review-run:${input.task.id}:${input.sourceRun.id}:${input.generationKey ?? runId}:${reviewRuntimeId}`,
      createdAt: new Date().toISOString(),
      role: 'REVIEW',
      parentSessionId: sourceSession.id,
      taskContext: {
        iterationId: input.iteration.id,
        worktreeId: input.worktree.id,
        worktreePath: input.worktree.worktreePath
      },
      taskDetails: {
        continuedFromRunId: input.sourceRun.id,
        beforeGitSnapshotId: input.beforeGitSnapshotId,
        eventCount: 0
      },
      taskReviewTarget: input.target
    });
    const reviewSession = await this.taskRuntime.getAgentSession(prepared.session.id);
    const reviewRun = await this.taskRuntime.getRun(prepared.run.id);
    if (!reviewSession || !reviewRun) {
      throw new Error('Prepared review did not project into its Task owner.');
    }
    await this.store.recordAgentSessionCreated(reviewSession);
    await this.store.recordAgentRunStarted(reviewRun);
    try {
      const attachments = toAgentTurnAttachments(
        await this.store.prepareRunAttachments(prepared.run.id, input.task.id)
      );
      await this.startPreparedTurnNow(
        prepared.queueEntry.id,
        `review-start:${prepared.run.id}`,
        attachments
      );
      return (await this.taskRuntime.getRun(prepared.run.id)) ?? reviewRun;
    } catch (error) {
      await this.runtimeTurnEventQueue;
      const canonical = await this.runtimeStore.getRun(prepared.run.id);
      if (canonical?.status === 'RECOVERY_REQUIRED') {
        await this.processRuntimeTurnEvent({
          type: 'RECOVERY_REQUIRED',
          runId: canonical.id,
          ...(canonical.providerTurnId
            ? { providerTurnId: canonical.providerTurnId }
            : {}),
          reason:
            canonical.terminalReason ??
            'Task Monki could not confirm whether the review started.',
          observedAt: canonical.lastEventAt ?? new Date().toISOString()
        });
        throw error;
      }
      const projected = (await this.taskRuntime.getRun(prepared.run.id)) ?? reviewRun;
      await this.recordStartFailure(projected, error);
      if (canonical && isTerminalRuntimeRun(canonical.status)) {
        await this.finishRuntimeTurn(canonical.id);
      }
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
    const canonical = await this.runtimeStore.getRun(run.id);
    if (canonical?.purpose === 'TASK_REVIEW') {
      const interrupted = await this.interruptTurn(
        run.id,
        'The review was canceled.',
        `cancel-shared-review:${run.id}`
      );
      if (interrupted.status === 'RECOVERY_REQUIRED') {
        // Provider adapters publish recovery only after their process boundary
        // is settled. Do not synthesize that event from a failed interrupt:
        // the provider may still be able to change the repository.
        await this.runtimeTurnEventQueue;
        return;
      }
      if (isTerminalRuntimeRun(interrupted.status)) {
        await this.runtimeTurnEventQueue;
        const latest = (await this.runtimeStore.getRun(interrupted.id)) ?? interrupted;
        const projected = await this.store.getRun(run.id);
        if (
          latest.repositoryIntegrity?.status === 'PENDING' ||
          (projected && !isTerminalRuntimeRun(projected.status))
        ) {
          await this.processRuntimeTurnEvent({
            type: 'TERMINAL',
            runId: latest.id,
            providerTurnId: latest.providerTurnId ?? latest.id,
            status:
              latest.status === 'COMPLETED'
                ? 'completed'
                : latest.status === 'INTERRUPTED'
                  ? 'interrupted'
                  : 'failed',
            ...(latest.terminalReason
              ? { error: latest.terminalReason }
              : {}),
            completedAt: latest.endedAt ?? new Date().toISOString()
          });
        }
      }
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
    if (
      !current ||
      (!ACTIVE_RUN_STATUSES.includes(current.status) &&
        !(current.status === 'FAILED' && !current.finalArtifactId))
    ) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failureEvent = createDomainEvent({
      type: 'AGENT_RUN_FAILED',
      taskId: current.taskId,
      iterationId: current.iterationId,
      runId: current.id,
      worktreeId: current.worktreeId,
      agentSessionId: current.sessionId,
      source: 'provider',
      payload: { error: message }
    });
    const recorded = ACTIVE_RUN_STATUSES.includes(current.status)
      ? await this.taskRuntime.applyTaskRuntimeEventIfRunStatus(
          failureEvent,
          ACTIVE_RUN_STATUSES,
          `start-failed:${current.id}`
        )
      : await this.taskRuntime
          .applyTaskRuntimeEvent(failureEvent, `start-failed:${current.id}`)
          .then(() => true);
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
