import crypto, { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentGoalSnapshotRecord,
  AgentItemRecord,
  AgentProtocolMessageReference,
  AgentRunMode,
  AgentPlanRevisionRecord,
  AgentServerInstance,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentSubagentObservationRecord,
  AgentUsageSnapshotRecord,
  InteractionRequestRecord
} from '../../shared/agent';
import {
  AGENT_RUNTIME_LIMITS,
  AGENT_RUNTIME_STORE_SCHEMA_VERSION,
  agentOwnerScopeKey,
  type AgentOwnerScope,
  type AgentRuntimeArtifactKind,
  type AgentRuntimeArtifactRecord,
  type AgentRuntimeEventRecord,
  type AgentRuntimeGoalSnapshotRecord,
  type AgentRuntimeInteractionRecord,
  type AgentRuntimeItemRecord,
  type AgentRuntimePlanRevisionRecord,
  type AgentRuntimeRunRecord,
  type AgentRuntimeSessionRecord,
  type AgentRuntimeSettingsObservationRecord,
  type AgentRuntimeStoreState,
  type AgentRuntimeSubagentObservationRecord,
  type AgentRuntimeTelemetryKind,
  type AgentRuntimeTelemetryRecord,
  type AgentRuntimeUsageSnapshotRecord,
  type AgentSchedulerPriority,
  type AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';
import {
  assertAccessEpochMatches,
  assertAgentOwnerScope,
  assertAgentRuntimePurposeScope,
  assertAgentRunScope,
  createAgentSessionAccessEpoch
} from '../agent/AgentRuntimeOwnership';
import { validateAgentServerTransition } from '../agent/AgentServerLifecycle';
import { AgentProtocolJournal } from '../agent/journal/AgentProtocolJournal';
import type {
  AgentRuntimeStore,
  CreateTaskRuntimeRunInput,
  CreateTaskRuntimeSessionInput,
  CreateRuntimeGoalSnapshotInput,
  CreateRuntimeInteractionInput,
  CreateRuntimeItemInput,
  CreateRuntimePlanRevisionInput,
  CreateAgentRuntimeServerInput,
  CreateObservedRuntimeRunInput,
  PreparedRuntimeTurnRecords,
  PrepareRuntimeTurnStoreInput,
  CreateRuntimeRunInput,
  CreateRuntimeSessionInput,
  CreateRuntimeSettingsObservationInput,
  CreateRuntimeSubagentObservationInput,
  CreateRuntimeUsageSnapshotInput,
  RuntimeInteractionUpdate,
  TaskAgentRuntimeAccess,
  TaskAgentRuntimeSnapshot,
  TaskCreateObservedSubagentRunInput,
  TaskObserveSubagentInput,
  TaskRuntimeEventSink
} from '../agent/AgentRuntimeStore';
import { AgentRuntimeArtifactMutationAmbiguousError } from '../agent/AgentRuntimeStore';
import type { ArtifactRecord, DomainEvent, RunRecord } from '../../shared/contracts';
import { reduceRun } from '../projection/reducer';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../filesystem/secureFilesystem';

const RUNTIME_FILE_NAME = 'runtime.json';
const ARTIFACT_DIRECTORY = 'artifacts';
const MAX_UNREFERENCED_TERMINAL_AGENT_SERVERS = 8;
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ARTIFACT_FILE = /^([A-Za-z0-9_-]{1,128})-r(\d+)\.txt$/u;
const TELEMETRY_KINDS = new Set<AgentRuntimeTelemetryKind>([
  'SERVER',
  'ITEM',
  'INTERACTION',
  'GOAL',
  'PLAN',
  'USAGE',
  'SETTINGS',
  'SUBAGENT',
  'PROTOCOL_REFERENCE'
]);
const SERVER_STATUSES = new Set<AgentServerInstance['status']>([
  'STARTING',
  'READY',
  'RUNNING',
  'DEGRADED',
  'STOPPING',
  'EXITED',
  'FAILED',
  'LOST'
]);
const ATTACHMENT_TRANSPORTS = new Set([
  'native-image',
  'native-file',
  'embedded-resource',
  'text-block',
  'managed-path'
] as const);
const ATTACHMENT_CORRELATION_KINDS = new Set([
  'provider-turn',
  'provider-message',
  'client-request'
] as const);

const RUN_STATUS_TRANSITIONS: Record<AgentRuntimeRunRecord['status'], readonly AgentRuntimeRunRecord['status'][]> = {
  QUEUED: ['STARTING', 'INTERRUPTED', 'FAILED', 'RECOVERY_REQUIRED'],
  STARTING: ['RUNNING', 'INTERRUPTING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  RUNNING: ['AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  AWAITING_APPROVAL: ['RUNNING', 'INTERRUPTING', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  AWAITING_USER_INPUT: ['RUNNING', 'INTERRUPTING', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  INTERRUPTING: ['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  RECOVERY_REQUIRED: ['STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'],
  LOST: ['RECOVERY_REQUIRED', 'COMPLETED', 'FAILED', 'INTERRUPTED'],
  COMPLETED: ['RECOVERY_REQUIRED'],
  FAILED: ['RECOVERY_REQUIRED'],
  INTERRUPTED: ['RECOVERY_REQUIRED']
};

const DELIVERY_TRANSITIONS: Record<AgentRuntimeRunRecord['delivery'], readonly AgentRuntimeRunRecord['delivery'][]> = {
  NOT_SENT: ['SENDING', 'NOT_DELIVERED'],
  SENDING: ['ACKNOWLEDGED', 'NOT_DELIVERED', 'AMBIGUOUS', 'TERMINAL'],
  ACKNOWLEDGED: ['TERMINAL', 'AMBIGUOUS'],
  AMBIGUOUS: ['ACKNOWLEDGED', 'TERMINAL', 'NOT_DELIVERED'],
  NOT_DELIVERED: [],
  TERMINAL: []
};
const SESSION_STATUS_TRANSITIONS: Record<
  AgentRuntimeSessionRecord['status'],
  readonly AgentRuntimeSessionRecord['status'][]
> = {
  NOT_MATERIALIZED: ['NOT_LOADED', 'IDLE', 'ACTIVE', 'SYSTEM_ERROR', 'DELETED'],
  NOT_LOADED: ['IDLE', 'ACTIVE', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED'],
  IDLE: ['ACTIVE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED'],
  ACTIVE: [
    'IDLE',
    'AWAITING_APPROVAL',
    'AWAITING_USER_INPUT',
    'NOT_LOADED',
    'SYSTEM_ERROR',
    'DELETED'
  ],
  AWAITING_APPROVAL: ['ACTIVE', 'IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'DELETED'],
  AWAITING_USER_INPUT: ['ACTIVE', 'IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'DELETED'],
  SYSTEM_ERROR: ['IDLE', 'ACTIVE', 'NOT_LOADED', 'DELETED'],
  ARCHIVED: ['IDLE', 'DELETED'],
  DELETED: [],
  UNKNOWN: ['IDLE', 'ACTIVE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED']
};

export interface FileAgentRuntimeStoreOptions {
  now?: () => string;
  createId?: () => string;
  afterFileSync?: () => Promise<void>;
  afterRename?: () => Promise<void>;
  syncDirectory?: (directory: string) => Promise<void>;
}

export class AgentRuntimeStorePublishedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentRuntimeStorePublishedError';
  }
}

export class FileAgentRuntimeStore implements AgentRuntimeStore {
  private readonly storePath: string;
  private readonly artifactsDir: string;
  private readonly protocolJournal: AgentProtocolJournal;
  private state = emptyState();
  private initPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly activeProtocolOperations = new Set<Promise<unknown>>();
  private publishedFailure = false;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly afterFileSync: () => Promise<void>;
  private readonly afterRename: () => Promise<void>;
  private readonly syncDirectoryHook: (directory: string) => Promise<void>;

  constructor(
    private readonly rootDir: string,
    options: FileAgentRuntimeStoreOptions = {}
  ) {
    this.storePath = path.join(rootDir, RUNTIME_FILE_NAME);
    this.artifactsDir = path.join(rootDir, ARTIFACT_DIRECTORY);
    this.protocolJournal = new AgentProtocolJournal(
      path.join(rootDir, 'protocol-journals')
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
    this.afterFileSync = options.afterFileSync ?? (async () => undefined);
    this.afterRename = options.afterRename ?? (async () => undefined);
    this.syncDirectoryHook = options.syncDirectory ?? syncDirectoryIfSupported;
  }

  async init(): Promise<void> {
    if (this.closePromise) {
      throw new Error('Agent runtime store is closed.');
    }
    return this.ensureInitialized();
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeOwnedResources();
    }
    return this.closePromise;
  }

  private async closeOwnedResources(): Promise<void> {
    await this.initPromise?.catch(() => undefined);
    await this.operationQueue.catch(() => undefined);
    await Promise.allSettled([...this.activeProtocolOperations]);
    await this.protocolJournal.close();
  }

  async snapshot(): Promise<AgentRuntimeStoreState> {
    await this.init();
    return clone(this.state);
  }

  async createAgentServer(
    input: CreateAgentRuntimeServerInput
  ): Promise<AgentServerInstance> {
    return this.mutate((draft) => {
      if (draft.servers.length >= AGENT_RUNTIME_LIMITS.maxServerInstances) {
        throw new Error('Agent runtime server-instance limit reached.');
      }
      const id = this.createId();
      requireSafeId(id, 'server id');
      if (draft.servers.some((server) => server.id === id)) {
        throw new Error(`Agent runtime server already exists: ${id}`);
      }
      const server: AgentServerInstance = {
        ...clone(input),
        id,
        status: 'STARTING',
        argv: [...input.argv],
        protocolJournalPath: this.protocolJournal.pathFor(id),
        startedAt: this.now()
      };
      assertAgentServer(server);
      draft.servers.unshift(server);
      return server;
    });
  }

  async getAgentServer(
    serverInstanceId: string
  ): Promise<AgentServerInstance | undefined> {
    await this.init();
    return clone(
      this.state.servers.find((server) => server.id === serverInstanceId)
    );
  }

  async listAgentServers(): Promise<AgentServerInstance[]> {
    await this.init();
    return clone(this.state.servers);
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
    return this.mutate((draft) => {
      const index = draft.servers.findIndex(
        (server) => server.id === serverInstanceId
      );
      if (index < 0) {
        throw new Error(`Agent runtime server not found: ${serverInstanceId}`);
      }
      const existing = draft.servers[index]!;
      validateAgentServerTransition(existing.status, update.status);
      const stored = { ...existing, ...clone(update) };
      assertAgentServer(stored);
      draft.servers[index] = stored;
      return stored;
    }, true);
  }

  async appendProtocolMessage(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    return this.withProtocolJournal(() => {
      if (!this.state.servers.some((server) => server.id === serverInstanceId)) {
        throw new Error('Protocol journal server instance is not owned by this runtime.');
      }
      return this.protocolJournal.append(serverInstanceId, direction, raw, metadata);
    });
  }

  async readProtocolMessage(reference: AgentProtocolMessageReference) {
    return this.withProtocolJournal(() => {
      if (
        !this.state.servers.some(
          (server) => server.id === reference.serverInstanceId
        )
      ) {
        throw new Error('Protocol journal server instance is not owned by this runtime.');
      }
      return this.protocolJournal.read(reference);
    });
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<AgentRuntimeSessionRecord> {
    return this.mutate((draft) =>
      insertRuntimeSession(draft, input, this.now(), this.createId)
    );
  }

  async createRun(input: CreateRuntimeRunInput): Promise<AgentRuntimeRunRecord> {
    return this.createRunWithLifecycle(input, {
      status: 'QUEUED',
      delivery: 'NOT_SENT',
      recoveryState: 'NONE',
      providerObserved: false
    });
  }

  async createObservedRun(
    input: CreateObservedRuntimeRunInput
  ): Promise<AgentRuntimeRunRecord> {
    if (!input.providerTurnId || !input.serverInstanceId) {
      throw new Error('An observed agent runtime run requires provider delivery evidence.');
    }
    requireTimestamp(input.startedAt);
    return this.createRunWithLifecycle(input, {
      status: 'RUNNING',
      delivery: 'ACKNOWLEDGED',
      recoveryState: 'NONE',
      startedAt: input.startedAt,
      providerObserved: true
    });
  }

  async prepareRuntimeTurn(
    input: PrepareRuntimeTurnStoreInput
  ): Promise<PreparedRuntimeTurnRecords> {
    return this.mutate(async (draft) => {
      const now = this.now();
      const session = insertRuntimeSession(
        draft,
        input.session,
        now,
        this.createId
      );
      const run = insertRuntimeRun(
        draft,
        input.run,
        {
          status: 'QUEUED',
          delivery: 'NOT_SENT',
          recoveryState: 'NONE',
          providerObserved: false
        },
        now,
        this.createId
      );
      const artifacts = draft.artifacts.filter((artifact) => artifact.runId === run.id);
      if (artifacts.length === 0) {
        await appendInitialRunArtifacts({
          draft,
          run,
          artifactsDir: this.artifactsDir,
          syncDirectory: this.syncDirectoryHook,
          createId: this.createId,
          now,
          operationId: input.run.clientOperationId,
          prompt: input.prompt
        });
      } else {
        assertCompleteInitialRunArtifacts(artifacts, run, input.prompt);
      }
      const queueEntry = insertQueueEntry(
        draft,
        run,
        input.priority,
        input.queueOperationId,
        input.notBefore,
        now,
        this.createId
      );
      return { session, run, queueEntry };
    });
  }

  private createRunWithLifecycle(
    input: CreateRuntimeRunInput,
    initial: Pick<
      AgentRuntimeRunRecord,
      'status' | 'delivery' | 'recoveryState' | 'startedAt'
    > & { providerObserved: boolean }
  ): Promise<AgentRuntimeRunRecord> {
    return this.mutate((draft) =>
      insertRuntimeRun(draft, input, initial, this.now(), this.createId)
    );
  }

  async getSession(sessionId: string): Promise<AgentRuntimeSessionRecord | undefined> {
    await this.init();
    return clone(this.state.sessions.find((session) => session.id === sessionId));
  }

  async getSessionByProviderId(
    providerSessionId: string,
    runtimeId?: string
  ): Promise<AgentRuntimeSessionRecord | undefined> {
    await this.init();
    return clone(
      [...this.state.sessions].reverse().find(
        (session) =>
          session.providerSessionId === providerSessionId &&
          (runtimeId === undefined || session.runtimeId === runtimeId)
      )
    );
  }

  async updateSession(
    sessionId: string,
    expectedRevision: number,
    update: Partial<
      Pick<
        AgentRuntimeSessionRecord,
        | 'providerSessionId'
        | 'providerSessionTreeId'
        | 'executionContext'
        | 'accessEpoch'
        | 'parentSessionId'
        | 'forkedFromSessionId'
        | 'providerParentSessionId'
        | 'providerForkedFromSessionId'
        | 'parentRunId'
        | 'status'
        | 'materialized'
        | 'requestedSettings'
        | 'observedSettings'
        | 'relationshipState'
        | 'relationshipDetail'
        | 'providerNickname'
        | 'providerRole'
        | 'delegatedPrompt'
        | 'agentPath'
        | 'subagentStatus'
        | 'lastAttachedAt'
      >
    >,
    operationId: string
  ): Promise<AgentRuntimeSessionRecord> {
    return this.mutate((draft) => {
      requireOperationId(operationId);
      const fingerprint = requestFingerprint({ sessionId, update });
      const replay = replayedOperation(draft, {
        operationId,
        type: 'SESSION_UPDATED',
        sessionId,
        requestFingerprint: fingerprint
      });
      if (replay) return requireSession(draft, sessionId);
      const index = draft.sessions.findIndex((session) => session.id === sessionId);
      if (index < 0) throw new Error(`Agent runtime session not found: ${sessionId}`);
      const existing = draft.sessions[index]!;
      if (existing.recordRevision !== expectedRevision) {
        throw new Error('Agent runtime session changed before the requested update.');
      }
      const changesAccessIdentity =
        update.executionContext !== undefined || update.accessEpoch !== undefined;
      if (
        changesAccessIdentity &&
        (update.executionContext === undefined || update.accessEpoch === undefined)
      ) {
        throw new Error(
          'Agent runtime execution context and access epoch must change together.'
        );
      }
      if (
        changesAccessIdentity &&
        (existing.materialized ||
          draft.runs.some(
            (run) =>
              run.sessionId === existing.id &&
              // A new Task can create its first provider session while its
              // exact selected run is still QUEUED/NOT_SENT. Shared turns can
              // already be STARTING/SENDING. Both states precede admission.
              (run.providerTurnId !== undefined ||
                (run.delivery !== 'NOT_SENT' &&
                  !(run.delivery === 'SENDING' && run.status === 'STARTING')))
          ))
      ) {
        throw new Error(
          'Agent runtime access identity is immutable after provider delivery.'
        );
      }
      const canReplaceReviewSessionIdentity =
        existing.owner.kind === 'TASK' &&
        existing.role === 'REVIEW' &&
        draft.runs
          .filter((run) => run.sessionId === existing.id)
          .every((run) => run.providerTurnId === undefined);
      if (
        update.status &&
        update.status !== existing.status &&
        !SESSION_STATUS_TRANSITIONS[existing.status].includes(update.status)
      ) {
        throw new Error(
          `Invalid agent runtime session transition: ${existing.status} -> ${update.status}`
        );
      }
      if (
        update.providerSessionId !== undefined &&
        existing.providerSessionId !== undefined &&
        update.providerSessionId !== existing.providerSessionId &&
        !canReplaceReviewSessionIdentity
      ) {
        throw new Error('Agent runtime provider session identity is immutable.');
      }
      const providerSessionOwners = update.providerSessionId === undefined
        ? []
        : draft.sessions.filter(
            (session) =>
              session.id !== existing.id &&
              session.runtimeId === existing.runtimeId &&
              session.providerSessionId === update.providerSessionId
          );
      const replacedProviderSessionOwner =
        providerSessionOwners.length === 1 &&
        isUndeliveredSessionReplacement(
          draft,
          existing,
          providerSessionOwners[0]!
        )
          ? providerSessionOwners[0]
          : undefined;
      if (
        providerSessionOwners.length > 0 &&
        !replacedProviderSessionOwner
      ) {
        throw new Error('Agent runtime provider session identity is already assigned.');
      }
      if (
        update.providerSessionTreeId !== undefined &&
        existing.providerSessionTreeId !== undefined &&
        update.providerSessionTreeId !== existing.providerSessionTreeId &&
        !canReplaceReviewSessionIdentity
      ) {
        throw new Error('Agent runtime provider session tree identity is immutable.');
      }
      if (update.lastAttachedAt) requireTimestamp(update.lastAttachedAt);
      const stored: AgentRuntimeSessionRecord = {
        ...existing,
        ...clone(update),
        requestedSettings: update.requestedSettings
          ? { ...clone(update.requestedSettings), runtimeId: existing.runtimeId }
          : existing.requestedSettings,
        observedSettings: update.observedSettings
          ? { ...clone(update.observedSettings), runtimeId: existing.runtimeId }
          : 'observedSettings' in update
            ? undefined
            : existing.observedSettings,
        recordRevision: existing.recordRevision + 1,
        updatedAt: this.now()
      };
      if (changesAccessIdentity) {
        if (
          stored.accessEpoch.epoch !== existing.accessEpoch.epoch ||
          stored.accessEpoch.createdAt !== existing.accessEpoch.createdAt
        ) {
          throw new Error(
            'Agent runtime access identity cannot change its durable epoch.'
          );
        }
        assertAccessEpochMatches({
          epoch: stored.accessEpoch,
          owner: stored.owner,
          sessionId: stored.id
        });
        assertExecutionContextMatchesEpoch(stored);
      }
      const canClearMaterializationFence =
        existing.materialized &&
        !stored.materialized &&
        draft.runs.some((run) => run.sessionId === existing.id) &&
        !draft.runs.some(
          (run) => run.sessionId === existing.id && run.providerTurnId !== undefined
        );
      if (
        typeof stored.materialized !== 'boolean' ||
        (existing.materialized && !stored.materialized && !canClearMaterializationFence)
      ) {
        throw new Error('Agent runtime session materialization cannot be reversed.');
      }
      draft.sessions[index] = stored;
      if (replacedProviderSessionOwner) {
        const replacedIndex = draft.sessions.findIndex(
          (session) => session.id === replacedProviderSessionOwner.id
        );
        const released: AgentRuntimeSessionRecord = {
          ...replacedProviderSessionOwner,
          providerSessionId: undefined,
          providerSessionTreeId: undefined,
          status: 'NOT_LOADED',
          recordRevision: replacedProviderSessionOwner.recordRevision + 1,
          updatedAt: stored.updatedAt
        };
        draft.sessions[replacedIndex] = released;
        appendEvent(draft, this.createId, released.updatedAt, {
          type: 'SESSION_UPDATED',
          owner: released.owner,
          sessionId: released.id,
          operationId: `${operationId}:release-replaced-provider-session`,
          payload: {
            status: released.status,
            materialized: released.materialized,
            requestFingerprint: requestFingerprint({
              sessionId: released.id,
              replacedBySessionId: stored.id
            })
          }
        });
      }
      appendEvent(draft, this.createId, stored.updatedAt, {
        type: 'SESSION_UPDATED',
        owner: stored.owner,
        sessionId: stored.id,
        operationId,
        payload: {
          status: stored.status,
          materialized: stored.materialized,
          requestFingerprint: fingerprint
        }
      });
      return stored;
    });
  }

  async getRun(runId: string): Promise<AgentRuntimeRunRecord | undefined> {
    await this.init();
    return clone(this.state.runs.find((run) => run.id === runId));
  }

  async getRunByProviderTurnId(
    providerTurnId: string,
    runtimeId?: string
  ): Promise<AgentRuntimeRunRecord | undefined> {
    await this.init();
    return clone(
      this.state.runs.find(
        (run) =>
          run.providerTurnId === providerTurnId &&
          (runtimeId === undefined || this.runtimeIdForRun(run) === runtimeId)
      )
    );
  }

  async listRunsByOwner(owner: AgentOwnerScope): Promise<AgentRuntimeRunRecord[]> {
    await this.init();
    assertAgentOwnerScope(owner);
    const key = agentOwnerScopeKey(owner);
    return clone(this.state.runs.filter((run) => agentOwnerScopeKey(run.owner) === key));
  }

  async getActiveRunForSession(
    sessionId: string
  ): Promise<AgentRuntimeRunRecord | undefined> {
    await this.init();
    return clone(
      this.state.runs.find(
        (run) => run.sessionId === sessionId && isActiveRuntimeStatus(run.status)
      )
    );
  }

  async getRunsRequiringRecovery(
    options: {
      includeQueued?: boolean;
      runtimeId?: string;
      owner?: AgentOwnerScope;
    } = {}
  ): Promise<AgentRuntimeRunRecord[]> {
    await this.init();
    const ownerKey = options.owner ? agentOwnerScopeKey(options.owner) : undefined;
    return clone(
      this.state.runs.filter((run) => {
        const requiresRecovery =
          run.status === 'RECOVERY_REQUIRED' ||
          isActiveRuntimeStatus(run.status) ||
          (options.includeQueued === true && run.status === 'QUEUED');
        return (
          requiresRecovery &&
          (ownerKey === undefined || agentOwnerScopeKey(run.owner) === ownerKey) &&
          (options.runtimeId === undefined ||
            this.runtimeIdForRun(run) === options.runtimeId)
        );
      })
    );
  }

  async createArtifact(input: {
    id: string;
    owner: AgentOwnerScope;
    runId: string;
    kind: AgentRuntimeArtifactKind;
    clientOperationId: string;
    content: string;
  }): Promise<AgentRuntimeArtifactRecord> {
    return this.mutate(async (draft) => {
      requireSafeId(input.id, 'artifact id');
      requireOperationId(input.clientOperationId);
      assertAgentOwnerScope(input.owner);
      const run = requireRun(draft, input.runId);
      assertArtifactBelongsToRun(input, run);
      const content = encodeArtifactContent(input.content);
      const fingerprint = requestFingerprint({
        id: input.id,
        owner: input.owner,
        runId: input.runId,
        kind: input.kind,
        contentSha256: content.sha256,
        byteCount: content.bytes.byteLength
      });
      const replay = replayedOperation(draft, {
        operationId: input.clientOperationId,
        type: 'ARTIFACT_CREATED',
        artifactId: input.id,
        requestFingerprint: fingerprint
      });
      if (replay) return requireArtifact(draft, input.id);
      if (draft.artifacts.some((artifact) => artifact.id === input.id)) {
        throw new Error(`Agent runtime artifact already exists: ${input.id}`);
      }
      if (draft.artifacts.length >= AGENT_RUNTIME_LIMITS.maxArtifacts) {
        throw new Error('Agent runtime artifact limit reached.');
      }
      const storageKey = artifactStorageKey(input.id, 1);
      await writeImmutableArtifact(
        this.artifactsDir,
        storageKey,
        content.bytes,
        this.syncDirectoryHook
      );
      const now = this.now();
      const artifact: AgentRuntimeArtifactRecord = {
        id: input.id,
        owner: clone(input.owner),
        runId: input.runId,
        kind: input.kind,
        clientOperationId: input.clientOperationId,
        requestFingerprint: fingerprint,
        storageKey,
        contentSha256: content.sha256,
        byteCount: content.bytes.byteLength,
        recordRevision: 1,
        createdAt: now,
        updatedAt: now
      };
      draft.artifacts.push(artifact);
      appendEvent(draft, this.createId, now, {
        type: 'ARTIFACT_CREATED',
        owner: artifact.owner,
        runId: artifact.runId,
        artifactId: artifact.id,
        operationId: input.clientOperationId,
        payload: {
          kind: artifact.kind,
          contentSha256: artifact.contentSha256,
          byteCount: artifact.byteCount,
          requestFingerprint: fingerprint
        }
      });
      return artifact;
    });
  }

  async updateArtifact(input: {
    artifactId: string;
    expectedRevision: number;
    clientOperationId: string;
    content: string;
  }): Promise<AgentRuntimeArtifactRecord> {
    const artifact = await this.mutate(async (draft) => {
      requireOperationId(input.clientOperationId);
      const content = encodeArtifactContent(input.content);
      const fingerprint = requestFingerprint({
        artifactId: input.artifactId,
        expectedRevision: input.expectedRevision,
        contentSha256: content.sha256,
        byteCount: content.bytes.byteLength
      });
      const replay = replayedOperation(draft, {
        operationId: input.clientOperationId,
        type: 'ARTIFACT_UPDATED',
        artifactId: input.artifactId,
        requestFingerprint: fingerprint
      });
      if (replay) return requireArtifact(draft, input.artifactId);
      const index = draft.artifacts.findIndex(
        (candidate) => candidate.id === input.artifactId
      );
      if (index < 0) throw new Error(`Agent runtime artifact not found: ${input.artifactId}`);
      const existing = draft.artifacts[index]!;
      if (existing.recordRevision !== input.expectedRevision) {
        throw new Error('Agent runtime artifact changed before the requested update.');
      }
      const revision = existing.recordRevision + 1;
      const storageKey = artifactStorageKey(existing.id, revision);
      await writeImmutableArtifact(
        this.artifactsDir,
        storageKey,
        content.bytes,
        this.syncDirectoryHook
      );
      const stored: AgentRuntimeArtifactRecord = {
        ...existing,
        clientOperationId: input.clientOperationId,
        requestFingerprint: fingerprint,
        storageKey,
        contentSha256: content.sha256,
        byteCount: content.bytes.byteLength,
        recordRevision: revision,
        updatedAt: this.now()
      };
      draft.artifacts[index] = stored;
      appendEvent(draft, this.createId, stored.updatedAt, {
        type: 'ARTIFACT_UPDATED',
        owner: stored.owner,
        runId: stored.runId,
        artifactId: stored.id,
        operationId: input.clientOperationId,
        payload: {
          kind: stored.kind,
          contentSha256: stored.contentSha256,
          byteCount: stored.byteCount,
          requestFingerprint: fingerprint
        }
      });
      return stored;
    });
    await this.cleanupUnreferencedArtifactFiles();
    return artifact;
  }

  async appendArtifact(
    artifactId: string,
    chunk: string,
    operationId: string
  ): Promise<AgentRuntimeArtifactRecord> {
    const artifact = await this.mutate(async (draft) => {
      requireOperationId(operationId);
      const bytes = Buffer.from(chunk, 'utf8');
      const fingerprint = requestFingerprint({
        artifactId,
        chunkSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        byteCount: bytes.byteLength
      });
      if (
        replayedOperation(draft, {
          operationId,
          type: 'ARTIFACT_UPDATED',
          artifactId,
          requestFingerprint: fingerprint
        })
      ) {
        return requireArtifact(draft, artifactId);
      }
      const index = draft.artifacts.findIndex((candidate) => candidate.id === artifactId);
      if (index < 0) throw new Error(`Agent runtime artifact not found: ${artifactId}`);
      const existing = draft.artifacts[index]!;
      const current = Buffer.from(await readVerifiedArtifact(this.artifactsDir, existing));
      const combined = Buffer.concat([current, bytes]);
      if (combined.byteLength > AGENT_RUNTIME_LIMITS.maxArtifactBytes) {
        throw new Error('Agent runtime artifact exceeds its safety limit.');
      }
      const revision = existing.recordRevision + 1;
      const storageKey = artifactStorageKey(existing.id, revision);
      await writeImmutableArtifact(
        this.artifactsDir,
        storageKey,
        combined,
        this.syncDirectoryHook
      );
      const stored: AgentRuntimeArtifactRecord = {
        ...existing,
        clientOperationId: operationId,
        requestFingerprint: fingerprint,
        storageKey,
        contentSha256: crypto.createHash('sha256').update(combined).digest('hex'),
        byteCount: combined.byteLength,
        recordRevision: revision,
        updatedAt: this.now()
      };
      draft.artifacts[index] = stored;
      appendEvent(draft, this.createId, stored.updatedAt, {
        type: 'ARTIFACT_UPDATED',
        owner: stored.owner,
        runId: stored.runId,
        artifactId: stored.id,
        operationId,
        payload: {
          kind: stored.kind,
          appendedByteCount: bytes.byteLength,
          contentSha256: stored.contentSha256,
          byteCount: stored.byteCount,
          requestFingerprint: fingerprint
        }
      });
      return stored;
    });
    await this.cleanupUnreferencedArtifactFiles();
    return artifact;
  }

  async writeFinalArtifact(input: {
    artifactId: string;
    owner: AgentOwnerScope;
    runId: string;
    clientOperationId: string;
    content: string;
  }): Promise<AgentRuntimeArtifactRecord> {
    const artifact = await this.mutate(async (draft) => {
      requireSafeId(input.artifactId, 'artifact id');
      requireOperationId(input.clientOperationId);
      const run = requireRun(draft, input.runId);
      if (agentOwnerScopeKey(run.owner) !== agentOwnerScopeKey(input.owner)) {
        throw new Error('Agent runtime final artifact ownership does not match its run.');
      }
      const content = encodeArtifactContent(input.content);
      const fingerprint = requestFingerprint({
        artifactId: input.artifactId,
        owner: input.owner,
        runId: input.runId,
        contentSha256: content.sha256,
        byteCount: content.bytes.byteLength
      });
      if (
        replayedOperation(draft, {
          operationId: input.clientOperationId,
          type: 'ARTIFACT_CREATED',
          runId: input.runId,
          artifactId: input.artifactId,
          requestFingerprint: fingerprint
        })
      ) {
        return requireArtifact(draft, input.artifactId);
      }
      if (run.finalArtifactId) {
        const existing = requireArtifact(draft, run.finalArtifactId);
        if (existing.contentSha256 !== content.sha256) {
          throw new Error('Agent runtime final artifact already exists with different content.');
        }
        return existing;
      }
      if (draft.artifacts.some((candidate) => candidate.id === input.artifactId)) {
        throw new Error(`Agent runtime artifact already exists: ${input.artifactId}`);
      }
      if (draft.artifacts.length >= AGENT_RUNTIME_LIMITS.maxArtifacts) {
        throw new Error('Agent runtime artifact limit reached.');
      }
      const storageKey = artifactStorageKey(input.artifactId, 1);
      await writeImmutableArtifact(
        this.artifactsDir,
        storageKey,
        content.bytes,
        this.syncDirectoryHook
      );
      const now = this.now();
      const stored: AgentRuntimeArtifactRecord = {
        id: input.artifactId,
        owner: clone(input.owner),
        runId: input.runId,
        kind: 'FINAL',
        clientOperationId: input.clientOperationId,
        requestFingerprint: fingerprint,
        storageKey,
        contentSha256: content.sha256,
        byteCount: content.bytes.byteLength,
        recordRevision: 1,
        createdAt: now,
        updatedAt: now
      };
      draft.artifacts.push(stored);
      replaceRun(draft, {
        ...run,
        finalArtifactId: stored.id,
        recordRevision: run.recordRevision + 1
      });
      appendEvent(draft, this.createId, now, {
        type: 'ARTIFACT_CREATED',
        owner: stored.owner,
        runId: stored.runId,
        artifactId: stored.id,
        operationId: input.clientOperationId,
        payload: {
          kind: stored.kind,
          contentSha256: stored.contentSha256,
          byteCount: stored.byteCount,
          requestFingerprint: fingerprint
        }
      });
      return stored;
    });
    await this.cleanupUnreferencedArtifactFiles();
    return artifact;
  }

  async getArtifact(artifactId: string): Promise<AgentRuntimeArtifactRecord | undefined> {
    await this.init();
    return clone(this.state.artifacts.find((artifact) => artifact.id === artifactId));
  }

  async readArtifact(artifactId: string): Promise<string> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) throw new Error(`Agent runtime artifact not found: ${artifactId}`);
    return readVerifiedArtifact(this.artifactsDir, artifact);
  }

  async recordTelemetry(input: {
    id: string;
    kind: AgentRuntimeTelemetryKind;
    owner?: AgentOwnerScope;
    sessionId?: string;
    runId?: string;
    serverInstanceId?: string;
    providerIdentity?: string;
    clientOperationId: string;
    payload: unknown;
    observedAt: string;
  }): Promise<AgentRuntimeTelemetryRecord> {
    return this.mutate((draft) => {
      requireSafeId(input.id, 'telemetry id');
      requireOperationId(input.clientOperationId);
      requireTimestamp(input.observedAt);
      assertTelemetryPayload(input.payload);
      if (input.owner) assertAgentOwnerScope(input.owner);
      const fingerprint = requestFingerprint(input);
      const operationOwner = input.owner ? agentOwnerScopeKey(input.owner) : 'app';
      const existing = draft.telemetryRecords.find(
        (record) =>
          `${record.owner ? agentOwnerScopeKey(record.owner) : 'app'}:${record.clientOperationId}` ===
          `${operationOwner}:${input.clientOperationId}`
      );
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new Error('Agent runtime telemetry operation conflicts with its durable request.');
        }
        return existing;
      }
      if (draft.telemetryRecords.some((record) => record.id === input.id)) {
        throw new Error(`Agent runtime telemetry already exists: ${input.id}`);
      }
      if (draft.telemetryRecords.length >= AGENT_RUNTIME_LIMITS.maxTelemetryRecords) {
        throw new Error('Agent runtime telemetry limit reached.');
      }
      assertTelemetryReferences(draft, input);
      const record: AgentRuntimeTelemetryRecord = {
        ...clone(input),
        requestFingerprint: fingerprint,
        createdAt: this.now()
      };
      draft.telemetryRecords.push(record);
      appendEvent(draft, this.createId, record.createdAt, {
        type: 'TELEMETRY_RECORDED',
        owner: record.owner,
        runId: record.runId,
        sessionId: record.sessionId,
        operationId: record.clientOperationId,
        payload: {
          telemetryId: record.id,
          kind: record.kind,
          requestFingerprint: record.requestFingerprint
        }
      });
      return record;
    });
  }

  async listTelemetryByOwner(owner: AgentOwnerScope): Promise<AgentRuntimeTelemetryRecord[]> {
    await this.init();
    const ownerKey = agentOwnerScopeKey(owner);
    return clone(
      this.state.telemetryRecords.filter(
        (record) => record.owner && agentOwnerScopeKey(record.owner) === ownerKey
      )
    );
  }

  async updateRun(
    runId: string,
    expectedRevision: number,
    update: Partial<
      Pick<
        AgentRuntimeRunRecord,
        | 'serverInstanceId'
        | 'providerTurnId'
        | 'status'
        | 'delivery'
        | 'interruptDelivery'
        | 'recoveryState'
        | 'observedSettings'
        | 'terminalReason'
        | 'providerTerminalSource'
        | 'contextFreshnessAtCompletion'
        | 'repositoryIntegrity'
        | 'finalArtifactId'
        | 'startedAt'
        | 'stopRequestedAt'
        | 'lastEventAt'
        | 'endedAt'
        | 'attachmentSubmissions'
        | 'providerTerminalRawMessage'
        | 'taskDetails'
      >
    >,
    operationId: string
  ): Promise<AgentRuntimeRunRecord> {
    return this.mutate((draft) =>
      updateRuntimeRunRecord(
        draft,
        runId,
        expectedRevision,
        update,
        operationId,
        this.now(),
        this.createId
      )
    );
  }

  async upsertItem(input: CreateRuntimeItemInput): Promise<AgentRuntimeItemRecord> {
    return this.mutate((draft) => {
      requireOperationId(input.clientOperationId);
      const run = requireOwnedRun(draft, input.owner, input.runId, input.sessionId);
      const fingerprint = requestFingerprint(input);
      if (
        replayedOperation(draft, {
          operationId: input.clientOperationId,
          type: 'ITEM_UPSERTED',
          runId: input.runId,
          requestFingerprint: fingerprint
        })
      ) {
        return requireItemByProviderId(draft, input.runId, input.providerItemId);
      }
      const index = draft.items.findIndex(
        (item) =>
          item.runId === input.runId &&
          item.providerItemId === input.providerItemId
      );
      const existing = index >= 0 ? draft.items[index] : undefined;
      if (existing && input.id && input.id !== existing.id) {
        throw new Error('Agent runtime item identity changed across observations.');
      }
      if (!existing && draft.items.length >= AGENT_RUNTIME_LIMITS.maxTypedRecords) {
        throw new Error('Agent runtime typed-record limit reached.');
      }
      if (existing) validateItemTransition(existing.status, input.status);
      if (input.outputArtifactId) {
        const artifact = requireArtifact(draft, input.outputArtifactId);
        if (artifact.runId !== run.id || artifact.owner.kind !== run.owner.kind ||
          agentOwnerScopeKey(artifact.owner) !== agentOwnerScopeKey(run.owner)) {
          throw new Error('Agent runtime item output artifact does not match its run.');
        }
      }
      assertOptionalProtocolReference(draft, input.rawMessage, run, 'item');
      const now = this.now();
      const stored: AgentRuntimeItemRecord = existing
        ? {
            ...existing,
            ...clone(input),
            id: existing.id,
            requestFingerprint: fingerprint,
            recordRevision: existing.recordRevision + 1,
            createdAt: existing.createdAt,
            updatedAt: now
          }
        : {
            ...clone(input),
            id: input.id ?? this.createId(),
            requestFingerprint: fingerprint,
            recordRevision: 1,
            createdAt: now,
            updatedAt: now
          };
      requireSafeId(stored.id, 'item id');
      if (existing) draft.items[index] = stored;
      else draft.items.push(stored);
      appendEvent(draft, this.createId, now, {
        type: 'ITEM_UPSERTED',
        owner: stored.owner,
        sessionId: stored.sessionId,
        runId: stored.runId,
        operationId: stored.clientOperationId,
        payload: {
          recordId: stored.id,
          providerItemId: stored.providerItemId,
          status: stored.status,
          requestFingerprint: fingerprint
        }
      });
      return stored;
    });
  }

  async listItemsForRun(runId: string): Promise<AgentRuntimeItemRecord[]> {
    await this.init();
    return clone(this.state.items.filter((item) => item.runId === runId));
  }

  async getItemByProviderId(
    runId: string,
    providerItemId: string
  ): Promise<AgentRuntimeItemRecord | undefined> {
    await this.init();
    return clone(
      this.state.items.find(
        (item) => item.runId === runId && item.providerItemId === providerItemId
      )
    );
  }

  async createInteraction(
    input: CreateRuntimeInteractionInput
  ): Promise<AgentRuntimeInteractionRecord> {
    return this.mutate((draft) => {
      requireOperationId(input.clientOperationId);
      const run = requireOwnedRun(draft, input.owner, input.runId, input.sessionId);
      const session = requireSession(draft, input.sessionId);
      if (run.serverInstanceId !== input.serverInstanceId) {
        throw new Error('Agent runtime interaction server does not match its run.');
      }
      assertProtocolReference(
        draft,
        input.requestRawMessage,
        run,
        input.serverInstanceId,
        'interaction request'
      );
      const fingerprint = requestFingerprint(input);
      const sameOccurrence = draft.interactions.find(
        (interaction) =>
          interaction.serverInstanceId === input.serverInstanceId &&
          interaction.providerRequestId === input.providerRequestId &&
          interaction.requestRawMessage.sequence === input.requestRawMessage.sequence
      );
      if (sameOccurrence) {
        if (
          replayedOperation(draft, {
            operationId: input.clientOperationId,
            type: 'INTERACTION_CREATED',
            runId: input.runId,
            requestFingerprint: fingerprint
          })
        ) {
          return sameOccurrence;
        }
        throw new Error('Duplicate agent runtime interaction conflicts with its first occurrence.');
      }
      if (
        draft.interactions.some(
          (interaction) =>
            interaction.serverInstanceId === input.serverInstanceId &&
            interaction.providerRequestId === input.providerRequestId &&
            isActiveInteractionStatus(interaction.status)
        )
      ) {
        throw new Error('Provider reused an active agent runtime interaction id.');
      }
      if (draft.interactions.length >= AGENT_RUNTIME_LIMITS.maxTypedRecords) {
        throw new Error('Agent runtime typed-record limit reached.');
      }
      const now = this.now();
      const stored: AgentRuntimeInteractionRecord = {
        ...clone(input),
        id: this.createId(),
        status: 'PENDING',
        requestFingerprint: fingerprint,
        recordRevision: 1,
        requestedAt: now
      };
      requireSafeId(stored.id, 'interaction id');
      draft.interactions.push(stored);
      const awaiting =
        stored.type === 'USER_INPUT' ? 'AWAITING_USER_INPUT' : 'AWAITING_APPROVAL';
      if (run.status === 'RUNNING') {
        replaceRun(draft, {
          ...run,
          status: awaiting,
          recordRevision: run.recordRevision + 1,
          lastEventAt: now
        });
      } else if (run.status !== awaiting) {
        throw new Error('Agent runtime interaction requires an active provider run.');
      }
      if (['ACTIVE', 'IDLE', 'NOT_LOADED'].includes(session.status)) {
        replaceSession(draft, {
          ...session,
          status: awaiting,
          recordRevision: session.recordRevision + 1,
          updatedAt: now
        });
      } else if (session.status !== awaiting && session.status !== 'NOT_LOADED') {
        throw new Error('Agent runtime interaction requires an active provider session.');
      }
      appendEvent(draft, this.createId, now, {
        type: 'INTERACTION_CREATED',
        owner: stored.owner,
        sessionId: stored.sessionId,
        runId: stored.runId,
        operationId: stored.clientOperationId,
        payload: {
          recordId: stored.id,
          type: stored.type,
          requestFingerprint: fingerprint
        }
      });
      return stored;
    });
  }

  async getInteraction(
    id: string
  ): Promise<AgentRuntimeInteractionRecord | undefined> {
    await this.init();
    return clone(this.state.interactions.find((interaction) => interaction.id === id));
  }

  async getInteractionByProviderId(
    serverInstanceId: string,
    providerRequestId: string | number
  ): Promise<AgentRuntimeInteractionRecord | undefined> {
    await this.init();
    return clone(
      this.state.interactions.find(
        (interaction) =>
          interaction.serverInstanceId === serverInstanceId &&
          interaction.providerRequestId === providerRequestId &&
          isActiveInteractionStatus(interaction.status)
      ) ??
        [...this.state.interactions]
          .reverse()
          .find(
            (interaction) =>
              interaction.serverInstanceId === serverInstanceId &&
              interaction.providerRequestId === providerRequestId
          )
    );
  }

  async updateInteraction(
    id: string,
    expectedRevision: number,
    expectedStatus: AgentRuntimeInteractionRecord['status'],
    update: RuntimeInteractionUpdate,
    operationId: string
  ): Promise<AgentRuntimeInteractionRecord> {
    return this.mutate((draft) => {
      requireOperationId(operationId);
      const fingerprint = requestFingerprint({ id, expectedStatus, update });
      if (
        replayedOperation(draft, {
          operationId,
          type: 'INTERACTION_UPDATED',
          requestFingerprint: fingerprint
        })
      ) {
        return requireInteraction(draft, id);
      }
      const index = draft.interactions.findIndex((interaction) => interaction.id === id);
      if (index < 0) throw new Error(`Agent runtime interaction not found: ${id}`);
      const existing = draft.interactions[index]!;
      if (existing.recordRevision !== expectedRevision) {
        throw new Error('Agent runtime interaction changed before the requested update.');
      }
      if (existing.status !== expectedStatus) {
        throw new Error(
          `Agent runtime interaction is ${existing.status}; expected ${expectedStatus}.`
        );
      }
      const status = update.status ?? existing.status;
      validateInteractionTransition(existing.status, status);
      const run = requireOwnedRun(
        draft,
        existing.owner,
        existing.runId,
        existing.sessionId
      );
      assertOptionalProtocolReference(
        draft,
        update.responseRawMessage,
        run,
        'interaction response',
        existing.serverInstanceId
      );
      const stored: AgentRuntimeInteractionRecord = {
        ...existing,
        ...clone(update),
        status,
        clientOperationId: operationId,
        requestFingerprint: fingerprint,
        recordRevision: existing.recordRevision + 1
      };
      draft.interactions[index] = stored;
      appendEvent(draft, this.createId, this.now(), {
        type: 'INTERACTION_UPDATED',
        owner: stored.owner,
        sessionId: stored.sessionId,
        runId: stored.runId,
        operationId,
        payload: {
          recordId: stored.id,
          fromStatus: existing.status,
          status: stored.status,
          requestFingerprint: fingerprint
        }
      });
      return stored;
    });
  }

  async listInteractionsByOwner(
    owner: AgentOwnerScope
  ): Promise<AgentRuntimeInteractionRecord[]> {
    await this.init();
    const ownerKey = agentOwnerScopeKey(owner);
    return clone(
      this.state.interactions.filter(
        (interaction) => agentOwnerScopeKey(interaction.owner) === ownerKey
      )
    );
  }

  async recordGoalSnapshot(
    input: CreateRuntimeGoalSnapshotInput
  ): Promise<AgentRuntimeGoalSnapshotRecord> {
    return this.mutate((draft) => {
      const session = requireOwnedSession(draft, input.owner, input.sessionId);
      const fingerprint = requestFingerprint(input);
      const replay = replayImmutableRecord(
        draft.goalSnapshots,
        input.owner,
        input.clientOperationId,
        fingerprint,
        'goal snapshot'
      );
      if (replay) return replay;
      assertOptionalProtocolReference(draft, input.rawMessage, undefined, 'goal snapshot', undefined, session);
      const stored = immutableObservation(
        input,
        this.createId(),
        fingerprint,
        this.now()
      ) as AgentRuntimeGoalSnapshotRecord;
      draft.goalSnapshots.push(stored);
      appendTypedRecordEvent(draft, this.createId, stored, 'GOAL_RECORDED');
      return stored;
    });
  }

  async getLatestGoalSnapshot(
    sessionId: string
  ): Promise<AgentRuntimeGoalSnapshotRecord | undefined> {
    await this.init();
    return clone(
      this.state.goalSnapshots
        .filter((record) => record.sessionId === sessionId)
        .sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0]
    );
  }

  async recordPlanRevision(
    input: CreateRuntimePlanRevisionInput
  ): Promise<AgentRuntimePlanRevisionRecord> {
    return this.mutate((draft) => {
      const run = requireOwnedRun(draft, input.owner, input.runId, input.sessionId);
      const fingerprint = requestFingerprint(input);
      const replay = replayImmutableRecord(
        draft.planRevisions,
        input.owner,
        input.clientOperationId,
        fingerprint,
        'plan revision'
      );
      if (replay) return replay;
      assertProtocolReference(draft, input.rawMessage, run, undefined, 'plan revision');
      const stored: AgentRuntimePlanRevisionRecord = {
        ...clone(input),
        id: this.createId(),
        revision:
          draft.planRevisions.filter((record) => record.runId === input.runId).length + 1,
        requestFingerprint: fingerprint,
        recordRevision: 1,
        observedAt: this.now()
      };
      requireSafeId(stored.id, 'plan revision id');
      draft.planRevisions.push(stored);
      appendTypedRecordEvent(draft, this.createId, stored, 'PLAN_RECORDED');
      return stored;
    });
  }

  async recordUsageSnapshot(
    input: CreateRuntimeUsageSnapshotInput
  ): Promise<AgentRuntimeUsageSnapshotRecord> {
    return this.mutate((draft) => {
      const session = requireOwnedSession(draft, input.owner, input.sessionId);
      const run = input.runId
        ? requireOwnedRun(draft, input.owner, input.runId, input.sessionId)
        : undefined;
      const fingerprint = requestFingerprint(input);
      const replay = replayImmutableRecord(
        draft.usageSnapshots,
        input.owner,
        input.clientOperationId,
        fingerprint,
        'usage snapshot'
      );
      if (replay) return replay;
      assertProtocolReference(draft, input.rawMessage, run, undefined, 'usage snapshot', session);
      const stored = immutableObservation(
        input,
        this.createId(),
        fingerprint,
        this.now()
      ) as AgentRuntimeUsageSnapshotRecord;
      draft.usageSnapshots.push(stored);
      appendTypedRecordEvent(draft, this.createId, stored, 'USAGE_RECORDED');
      return stored;
    });
  }

  async recordSettingsObservation(
    input: CreateRuntimeSettingsObservationInput
  ): Promise<AgentRuntimeSettingsObservationRecord> {
    return this.mutate((draft) => {
      const session = requireOwnedSession(draft, input.owner, input.sessionId);
      const run = input.runId
        ? requireOwnedRun(draft, input.owner, input.runId, input.sessionId)
        : undefined;
      const normalized = {
        ...input,
        settings: { ...input.settings, runtimeId: session.runtimeId }
      };
      const fingerprint = requestFingerprint(normalized);
      const replay = replayImmutableRecord(
        draft.settingsObservations,
        input.owner,
        input.clientOperationId,
        fingerprint,
        'settings observation'
      );
      if (replay) return replay;
      assertOptionalProtocolReference(
        draft,
        input.rawMessage,
        run,
        'settings observation',
        undefined,
        session
      );
      const stored = immutableObservation(
        normalized,
        this.createId(),
        fingerprint,
        this.now()
      ) as AgentRuntimeSettingsObservationRecord;
      draft.settingsObservations.push(stored);
      appendTypedRecordEvent(draft, this.createId, stored, 'SETTINGS_RECORDED');
      return stored;
    });
  }

  async recordSubagentObservation(
    input: CreateRuntimeSubagentObservationInput
  ): Promise<AgentRuntimeSubagentObservationRecord> {
    return this.mutate((draft) => {
      const session = requireOwnedSession(draft, input.owner, input.sessionId);
      const parent = requireOwnedSession(draft, input.owner, input.parentSessionId);
      const parentRun = input.parentRunId
        ? requireOwnedRun(draft, input.owner, input.parentRunId, parent.id)
        : undefined;
      const fingerprint = requestFingerprint(input);
      const replay = replayImmutableRecord(
        draft.subagentObservations,
        input.owner,
        input.clientOperationId,
        fingerprint,
        'subagent observation'
      );
      if (replay) return replay;
      assertProtocolReference(
        draft,
        input.rawMessage,
        parentRun,
        undefined,
        'subagent observation',
        parent
      );
      if (session.runtimeId !== parent.runtimeId) {
        throw new Error('Agent runtime subagent observation crosses runtimes.');
      }
      const stored = immutableObservation(
        input,
        this.createId(),
        fingerprint,
        this.now()
      ) as AgentRuntimeSubagentObservationRecord;
      draft.subagentObservations.push(stored);
      appendTypedRecordEvent(draft, this.createId, stored, 'SUBAGENT_RECORDED');
      return stored;
    });
  }

  taskAgentRuntimeAccess(eventSink?: TaskRuntimeEventSink): TaskAgentRuntimeAccess {
    const store = this;
    return {
      async snapshot() {
        await store.init();
        return projectTaskRuntimeSnapshot(store.state, store.artifactsDir);
      },
      createTaskSession(input) {
        return store.createTaskSession(input);
      },
      createTaskRun(input) {
        return store.createTaskRun(input);
      },
      async getAgentSession(sessionId) {
        const session = await store.getSession(sessionId);
        return session?.owner.kind === 'TASK' ? projectTaskSession(session) : undefined;
      },
      async getAgentSessionByProviderId(runtimeId, providerSessionId) {
        const session = await store.getSessionByProviderId(providerSessionId, runtimeId);
        return session?.owner.kind === 'TASK' ? projectTaskSession(session) : undefined;
      },
      async updateAgentSession(sessionId, update, operationId) {
        const existing = await store.requireTaskSession(sessionId);
        const stored = await store.updateSession(
          sessionId,
          existing.recordRevision,
          runtimeSessionUpdate(update),
          operationId
        );
        return projectTaskSession(stored);
      },
      async updateAgentSessionAccess(sessionId, update, operationId) {
        const existing = await store.requireTaskSession(sessionId);
        const stored = await store.updateSession(
          sessionId,
          existing.recordRevision,
          clone(update),
          operationId
        );
        return projectTaskSession(stored);
      },
      async getRun(runId) {
        const run = await store.getRun(runId);
        return run?.owner.kind === 'TASK'
          ? projectTaskRun(run, store.state)
          : undefined;
      },
      async getRunByProviderTurnId(runtimeId, providerTurnId) {
        const run = await store.getRunByProviderTurnId(providerTurnId, runtimeId);
        return run?.owner.kind === 'TASK'
          ? projectTaskRun(run, store.state)
          : undefined;
      },
      async getActiveRunForSession(sessionId) {
        await store.init();
        const run = [...store.state.runs]
          .reverse()
          .find(
            (candidate) =>
              candidate.owner.kind === 'TASK' &&
              candidate.sessionId === sessionId &&
              (candidate.status === 'QUEUED' || isActiveRuntimeStatus(candidate.status))
          );
        return run?.owner.kind === 'TASK'
          ? projectTaskRun(run, store.state)
          : undefined;
      },
      async getRunsRequiringRecovery(options) {
        const runs = await store.getRunsRequiringRecovery(options);
        return runs
          .reverse()
          .filter((run) => run.owner.kind === 'TASK')
          .map((run) => projectTaskRun(run, store.state));
      },
      async updateRun(runId, update, operationId) {
        const existing = await store.requireTaskRun(runId);
        const stored = await store.updateRun(
          runId,
          existing.recordRevision,
          runtimeRunUpdate(existing, update, store.now()),
          operationId
        );
        return projectTaskRun(stored, store.state);
      },
      async getAgentItemsForRun(runId) {
        const run = await store.requireTaskRun(runId);
        return (await store.listItemsForRun(runId)).map((item) =>
          projectTaskItem(item, run)
        );
      },
      async getAgentItemByProviderId(runId, providerItemId) {
        const run = await store.requireTaskRun(runId);
        const item = await store.getItemByProviderId(runId, providerItemId);
        return item ? projectTaskItem(item, run) : undefined;
      },
      async upsertAgentItem(item, operationId) {
        const run = await store.requireTaskRun(item.runId);
        assertProjectedItemOwnership(item, run);
        const stored = await store.upsertItem({
          ...clone(item),
          owner: clone(run.owner),
          clientOperationId: operationId
        });
        return projectTaskItem(stored, run);
      },
      async getInteractionRequest(id) {
        const interaction = await store.getInteraction(id);
        if (!interaction || interaction.owner.kind !== 'TASK') return undefined;
        return projectTaskInteraction(interaction, store.state);
      },
      async getInteractionRequestByProviderId(serverInstanceId, providerRequestId) {
        const interaction = await store.getInteractionByProviderId(
          serverInstanceId,
          providerRequestId
        );
        if (!interaction || interaction.owner.kind !== 'TASK') return undefined;
        return projectTaskInteraction(interaction, store.state);
      },
      async createInteractionRequest(input, operationId) {
        const run = await store.requireTaskRun(input.runId);
        assertProjectedInteractionOwnership(input, run);
        const stored = await store.createInteraction({
          ...clone(input),
          owner: clone(run.owner),
          clientOperationId: operationId
        });
        return projectTaskInteraction(stored, store.state);
      },
      async transitionInteractionRequest(
        id,
        expectedStatus,
        update,
        operationId
      ) {
        const existing = await store.getInteraction(id);
        if (!existing || existing.owner.kind !== 'TASK') {
          throw new Error(`Task agent runtime interaction not found: ${id}`);
        }
        const stored = await store.updateInteraction(
          id,
          existing.recordRevision,
          expectedStatus,
          update,
          operationId
        );
        return projectTaskInteraction(stored, store.state);
      },
      async getLatestAgentGoalSnapshot(sessionId) {
        const session = await store.requireTaskSession(sessionId);
        const record = await store.getLatestGoalSnapshot(session.id);
        return record ? projectTaskGoal(record, session) : undefined;
      },
      async recordAgentGoalSnapshot(record, operationId) {
        const session = await store.requireTaskSession(record.sessionId);
        assertProjectedSessionObservation(record, session);
        const stored = await store.recordGoalSnapshot({
          ...clone(record),
          owner: clone(session.owner),
          clientOperationId: operationId
        });
        return projectTaskGoal(stored, session);
      },
      async recordAgentPlanRevision(record, operationId) {
        const run = await store.requireTaskRun(record.runId);
        assertProjectedRunObservation(record, run);
        const stored = await store.recordPlanRevision({
          ...clone(record),
          owner: clone(run.owner),
          clientOperationId: operationId
        });
        return projectTaskPlan(stored, run);
      },
      async recordAgentUsageSnapshot(record, operationId) {
        const session = await store.requireTaskSession(record.sessionId);
        assertProjectedSessionObservation(record, session);
        if (record.runId) await store.requireTaskRun(record.runId);
        const stored = await store.recordUsageSnapshot({
          ...clone(record),
          owner: clone(session.owner),
          clientOperationId: operationId
        });
        return projectTaskUsage(stored, session);
      },
      async recordAgentSettingsObservation(record, operationId) {
        const session = await store.requireTaskSession(record.sessionId);
        assertProjectedSessionObservation(record, session);
        if (record.runId) await store.requireTaskRun(record.runId);
        const stored = await store.recordSettingsObservation({
          ...clone(record),
          owner: clone(session.owner),
          clientOperationId: operationId
        });
        return projectTaskSettings(stored, session);
      },
      async recordAgentSubagentObservation(record, operationId) {
        const session = await store.requireTaskSession(record.sessionId);
        assertProjectedSessionObservation(record, session);
        const stored = await store.recordSubagentObservation({
          ...clone(record),
          owner: clone(session.owner),
          clientOperationId: operationId
        });
        return projectTaskSubagent(stored, session);
      },
      observeSubagent(input, operationId) {
        return store.observeTaskSubagent(input, operationId);
      },
      createObservedSubagentRun(input, operationId) {
        return store.createTaskObservedSubagentRun(input, operationId);
      },
      async appendArtifact(artifactId, chunk, operationId) {
        try {
          return await store.appendArtifact(artifactId, chunk, operationId);
        } catch (cause) {
          throw translateArtifactMutationError(cause);
        }
      },
      async writeFinalArtifact(taskId, runId, content, operationId) {
        const run = await store.requireTaskRun(runId);
        if (run.owner.taskId !== taskId) {
          throw new Error('Task final artifact does not match its run owner.');
        }
        try {
          return await store.writeFinalArtifact({
            artifactId: run.finalArtifactId ?? store.createId(),
            owner: run.owner,
            runId,
            clientOperationId: operationId,
            content
          });
        } catch (cause) {
          throw translateArtifactMutationError(cause);
        }
      },
      async applyTaskRuntimeEvent(event, operationId) {
        await store.applyTaskRuntimeEventInternal(event, undefined, operationId);
        try {
          await eventSink?.(event, operationId);
        } catch (cause) {
          await store.markTaskTerminalPublicationForRecovery(event, operationId);
          throw cause;
        }
      },
      async applyTaskRuntimeEventIfRunStatus(event, statuses, operationId) {
        const applied = await store.applyTaskRuntimeEventInternal(
          event,
          statuses,
          operationId
        );
        if (applied) {
          try {
            await eventSink?.(event, operationId);
          } catch (cause) {
            await store.markTaskTerminalPublicationForRecovery(event, operationId);
            throw cause;
          }
        }
        return applied;
      }
    };
  }

  private async requireTaskSession(
    sessionId: string
  ): Promise<AgentRuntimeSessionRecord & { owner: Extract<AgentOwnerScope, { kind: 'TASK' }> }> {
    const session = await this.getSession(sessionId);
    if (!session || session.owner.kind !== 'TASK') {
      throw new Error(`Task agent runtime session not found: ${sessionId}`);
    }
    return session as AgentRuntimeSessionRecord & {
      owner: Extract<AgentOwnerScope, { kind: 'TASK' }>;
    };
  }

  private async requireTaskRun(
    runId: string
  ): Promise<AgentRuntimeRunRecord & { owner: Extract<AgentOwnerScope, { kind: 'TASK' }> }> {
    const run = await this.getRun(runId);
    if (!run || run.owner.kind !== 'TASK') {
      throw new Error(`Task agent runtime run not found: ${runId}`);
    }
    return run as AgentRuntimeRunRecord & {
      owner: Extract<AgentOwnerScope, { kind: 'TASK' }>;
    };
  }

  private async createTaskSession(
    input: CreateTaskRuntimeSessionInput
  ): Promise<AgentSessionRecord> {
    if (
      input.executionContext.primaryCwd !== input.worktreePath ||
      input.executionContext.clientOperationId !== input.operationId
    ) {
      throw new Error('Task session execution context does not match its creation request.');
    }
    const now = this.now();
    const owner = { kind: 'TASK' as const, taskId: input.taskId };
    const requestedSettings = {
      ...clone(input.requestedSettings),
      runtimeId: input.runtimeId
    };
    const model = requestedSettings.model;
    if (!model) throw new Error('Task agent session requires a resolved model.');
    const role = input.role ?? 'PRIMARY';
    const session = await this.createSession({
      id: input.id,
      owner,
      accessEpoch: createAgentSessionAccessEpoch({
        owner,
        sessionId: input.id,
        epoch: 1,
        runtimeId: input.runtimeId,
        model,
        executionContext: input.executionContext,
        createdAt: now
      }),
      executionContext: clone(input.executionContext),
      clientOperationId: input.operationId,
      runtimeId: input.runtimeId,
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
      status: 'NOT_MATERIALIZED',
      materialized: false,
      requestedSettings,
      taskContext: {
        iterationId: input.iterationId,
        worktreeId: input.worktreeId,
        worktreePath: input.worktreePath
      }
    });
    return projectTaskSession(session);
  }

  private async createTaskRun(input: CreateTaskRuntimeRunInput): Promise<RunRecord> {
    const stored = await this.mutate(async (draft) => {
      requireOperationId(input.operationId);
      const session = requireSession(draft, input.sessionId);
      if (
        session.owner.kind !== 'TASK' ||
        session.owner.taskId !== input.taskId ||
        session.taskContext?.iterationId !== input.iterationId ||
        session.taskContext.worktreeId !== input.worktreeId
      ) {
        throw new Error('Task run does not match its canonical session generation.');
      }
      if (input.mode === 'SUBAGENT') {
        throw new Error('Provider-observed subagent runs use their dedicated creation path.');
      }
      const run = insertRuntimeRun(
        draft,
        {
          id: input.id,
          owner: clone(session.owner),
          scope: {
            kind: 'TASK',
            taskId: input.taskId,
            iterationId: input.iterationId,
            worktreeId: input.worktreeId
          },
          sessionId: session.id,
          sessionAccessEpoch: session.accessEpoch.epoch,
          purpose: taskPurposeFromMode(input.mode),
          parentRunId: input.retryOfRunId ?? input.continuedFromRunId,
          taskReviewTarget: input.reviewTarget,
          generationKey: input.generationKey ?? `task-run:${input.id}`,
          clientOperationId: input.operationId,
          requestedSettings: {
            ...(input.requestedSettings ?? session.requestedSettings),
            runtimeId: session.runtimeId
          },
          promptArtifactId: `prompt-${input.id}`,
          outputArtifactId: `output-${input.id}`,
          diagnosticArtifactId: `diagnostic-${input.id}`,
          instructionProfile: input.instructionProfile,
          clientToolGrants: input.clientToolGrants,
          attachmentSelection: input.attachmentSelection,
          taskDetails: {
            retryOfRunId: input.retryOfRunId,
            continuedFromRunId: input.continuedFromRunId,
            beforeGitSnapshotId: input.beforeGitSnapshotId,
            eventCount: 0
          }
        },
        {
          status: 'QUEUED',
          delivery: 'NOT_SENT',
          recoveryState: 'NONE',
          providerObserved: false
        },
        this.now(),
        this.createId
      );
      if (!draft.artifacts.some((artifact) => artifact.runId === run.id)) {
        await appendInitialRunArtifacts({
          draft,
          run,
          artifactsDir: this.artifactsDir,
          syncDirectory: this.syncDirectoryHook,
          createId: this.createId,
          now: this.now(),
          operationId: input.operationId,
          prompt: input.prompt
        });
      }
      return run;
    });
    return projectTaskRun(stored, this.state);
  }

  private async observeTaskSubagent(
    input: TaskObserveSubagentInput,
    operationId: string
  ): Promise<{
    session: AgentSessionRecord;
    observation: AgentSubagentObservationRecord;
  }> {
    const result = await this.mutate((draft) => {
      requireOperationId(operationId);
      const parent = requireSession(draft, input.parentSessionId);
      if (parent.owner.kind !== 'TASK') {
        throw new Error('Only a Task session can own a Task subagent observation.');
      }
      const parentRun = input.parentRunId
        ? requireOwnedRun(draft, parent.owner, input.parentRunId, parent.id)
        : undefined;
      assertProtocolReference(
        draft,
        input.rawMessage,
        parentRun,
        undefined,
        'subagent observation',
        parent
      );
      const fingerprint = requestFingerprint(input);
      const replay = replayImmutableRecord(
        draft.subagentObservations,
        parent.owner,
        operationId,
        fingerprint,
        'subagent observation'
      );
      if (replay) {
        return {
          session: requireSession(draft, replay.sessionId),
          observation: replay
        };
      }
      const existing = draft.sessions.find(
        (session) =>
          session.runtimeId === parent.runtimeId &&
          session.providerSessionId === input.providerChildSessionId
      );
      if (
        existing &&
        agentOwnerScopeKey(existing.owner) !== agentOwnerScopeKey(parent.owner)
      ) {
        throw new Error(
          'Provider child session is already owned by another Task.'
        );
      }
      const relationshipProblems = [
        input.providerChildSessionId === parent.providerSessionId
          ? 'Provider reported a session as its own child.'
          : undefined,
        input.providerParentSessionId &&
        parent.providerSessionId &&
        input.providerParentSessionId !== parent.providerSessionId
          ? `Supplied parent session ${input.providerParentSessionId} does not match local parent ${parent.providerSessionId}.`
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
      const now = this.now();
      const requestedSettings = {
        ...parent.requestedSettings,
        ...(existing?.requestedSettings ?? {}),
        ...(input.requestedSettings ?? {}),
        runtimeId: parent.runtimeId
      };
      const sessionId = existing?.id ?? this.createId();
      requireSafeId(sessionId, 'session id');
      const executionContext = existing?.executionContext ?? {
        ...clone(parent.executionContext),
        attestation: {
          status: 'INHERITED_UNATTESTED' as const,
          parentSessionId: parent.id,
          reason: 'Provider-observed child session inherited its parent execution boundary.'
        },
        clientOperationId: operationId,
        modelSettings: clone(requestedSettings)
      };
      const accessEpoch = existing?.accessEpoch ??
        createAgentSessionAccessEpoch({
          owner: parent.owner,
          sessionId,
          epoch: 1,
          runtimeId: parent.runtimeId,
          model: requestedSettings.model ?? parent.accessEpoch.model,
          executionContext,
          createdAt: now
        });
      const status =
        input.status === 'RUNNING'
          ? 'ACTIVE'
          : input.status === 'ERRORED'
            ? 'SYSTEM_ERROR'
            : existing?.status ?? 'UNKNOWN';
      const stored: AgentRuntimeSessionRecord = existing
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
            delegatedPrompt: existing.delegatedPrompt ?? input.delegatedPrompt,
            agentPath: input.agentPath ?? existing.agentPath,
            subagentStatus: input.status ?? existing.subagentStatus,
            status,
            materialized: input.materialized ?? existing.materialized,
            requestedSettings,
            recordRevision: existing.recordRevision + 1,
            updatedAt: now
          }
        : {
            id: sessionId,
            owner: clone(parent.owner),
            accessEpoch,
            executionContext,
            clientOperationId: derivedOperationId(operationId, 'child-session'),
            requestFingerprint: requestFingerprint({
              owner: parent.owner,
              sessionId,
              providerSessionId: input.providerChildSessionId,
              parentSessionId: parent.id
            }),
            runtimeId: parent.runtimeId,
            role: 'SUBAGENT',
            providerSessionId: input.providerChildSessionId,
            providerSessionTreeId: input.providerSessionTreeId,
            parentSessionId:
              relationshipState === 'RESOLVED' ? parent.id : undefined,
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
            status,
            materialized: input.materialized ?? false,
            requestedSettings,
            recordRevision: 1,
            createdAt: now,
            updatedAt: now,
            taskContext: clone(parent.taskContext)
          };
      if (existing) replaceSession(draft, stored);
      else draft.sessions.push(stored);
      const observation: AgentRuntimeSubagentObservationRecord = {
        id: this.createId(),
        owner: clone(parent.owner),
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
        rawMessage: clone(input.rawMessage),
        clientOperationId: operationId,
        requestFingerprint: fingerprint,
        recordRevision: 1,
        observedAt: now
      };
      requireSafeId(observation.id, 'subagent observation id');
      draft.subagentObservations.push(observation);
      appendTypedRecordEvent(
        draft,
        this.createId,
        observation,
        'SUBAGENT_RECORDED'
      );
      return { session: stored, observation };
    });
    return {
      session: projectTaskSession(result.session),
      observation: projectTaskSubagent(result.observation, result.session)
    };
  }

  private async createTaskObservedSubagentRun(
    input: TaskCreateObservedSubagentRunInput,
    operationId: string
  ): Promise<RunRecord> {
    const stored = await this.mutate(async (draft) => {
      requireOperationId(operationId);
      const session = requireSession(draft, input.session.id);
      if (session.owner.kind !== 'TASK' || session.role !== 'SUBAGENT') {
        throw new Error('Only an observed Task subagent session can own this run.');
      }
      assertProjectedSessionIdentity(input.session, session);
      const server = draft.servers.find(
        (candidate) => candidate.id === input.serverInstanceId
      );
      if (!server || server.runtimeId !== session.runtimeId) {
        throw new Error('Observed subagent run server ownership is inconsistent.');
      }
      const existing = draft.runs.find(
        (run) =>
          run.providerTurnId === input.providerTurnId &&
          requireSession(draft, run.sessionId).runtimeId === session.runtimeId
      );
      if (existing) {
        if (existing.sessionId !== session.id) {
          throw new Error('Provider turn is already owned by another session.');
        }
        return existing;
      }
      const now = this.now();
      const runId = this.createId();
      requireSafeId(runId, 'run id');
      const promptArtifactId = `prompt-${runId}`;
      const outputArtifactId = `output-${runId}`;
      const diagnosticArtifactId = `diagnostic-${runId}`;
      const prompt =
        input.prompt ?? session.delegatedPrompt ?? 'Provider-observed subagent turn.';
      const run = insertRuntimeRun(
        draft,
        {
          id: runId,
          owner: clone(session.owner),
          scope: {
            kind: 'TASK',
            taskId: session.owner.taskId,
            iterationId: session.taskContext!.iterationId,
            worktreeId: session.taskContext!.worktreeId
          },
          sessionId: session.id,
          sessionAccessEpoch: session.accessEpoch.epoch,
          serverInstanceId: input.serverInstanceId,
          providerTurnId: input.providerTurnId,
          purpose: 'PROVIDER_SUBAGENT',
          parentRunId: input.parentRunId ?? session.parentRunId,
          generationKey: `provider-subagent:${input.providerTurnId}`,
          clientOperationId: operationId,
          requestedSettings: {
            ...(input.requestedSettings ?? session.requestedSettings),
            runtimeId: session.runtimeId
          },
          promptArtifactId,
          outputArtifactId,
          diagnosticArtifactId,
          attachmentSelection: [],
          taskDetails: { eventCount: 0 }
        },
        {
          status: 'RUNNING',
          delivery: 'ACKNOWLEDGED',
          recoveryState: 'NONE',
          startedAt: now,
          providerObserved: true
        },
        now,
        this.createId
      );
      await appendInitialRunArtifacts({
        draft,
        run,
        artifactsDir: this.artifactsDir,
        syncDirectory: this.syncDirectoryHook,
        createId: this.createId,
        now,
        operationId,
        prompt
      });
      return run;
    });
    return projectTaskRun(stored, this.state);
  }

  private async applyTaskRuntimeEventInternal(
    event: DomainEvent,
    statuses: readonly RunRecord['status'][] | undefined,
    operationId: string
  ): Promise<boolean> {
    if (!event.runId) return false;
    return this.mutate((draft) => {
      requireOperationId(operationId);
      const eventFingerprint = domainEventFingerprint(event);
      const prior = draft.events.find(
        (candidate) => candidate.operationId === operationId
      );
      if (prior) {
        if (prior.payload.domainEventFingerprint === eventFingerprint) return true;
        throw new Error('Agent runtime operation conflicts with its durable event.');
      }
      const existing = requireRun(draft, event.runId!);
      if (existing.owner.kind !== 'TASK' || existing.owner.taskId !== event.taskId) {
        throw new Error('Task runtime event ownership does not match its run.');
      }
      if (
        existing.scope.kind !== 'TASK' ||
        (event.iterationId !== undefined &&
          event.iterationId !== existing.scope.iterationId)
      ) {
        throw new Error('Task runtime event generation does not match its run.');
      }
      const current = projectTaskRun(existing, draft);
      if (statuses && !statuses.includes(current.status)) return false;
      const reduced = reduceRun(current, event);
      if (stableStringify(reduced) === stableStringify(current)) return true;
      const stored = updateRuntimeRunRecord(
        draft,
        existing.id,
        existing.recordRevision,
        runtimeRunUpdate(existing, reduced, event.receivedAt),
        operationId,
        event.receivedAt,
        this.createId
      );
      const applied = draft.events[draft.events.length - 1];
      if (applied?.runId === stored.id && applied.operationId === operationId) {
        applied.payload.domainEventFingerprint = eventFingerprint;
        applied.payload.domainEventId = event.id;
      }
      return true;
    });
  }

  private async markTaskTerminalPublicationForRecovery(
    event: DomainEvent,
    operationId: string
  ): Promise<void> {
    if (
      !event.runId ||
      !['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(
        event.type
      )
    ) {
      return;
    }
    const recoveryOperationId = `task-event-recovery:${requestFingerprint({
      operationId,
      eventId: event.id
    })}`;
    await this.mutate((draft) => {
      const run = requireRun(draft, event.runId!);
      if (!isTerminalRuntimeStatus(run.status)) return;
      updateRuntimeRunRecord(
        draft,
        run.id,
        run.recordRevision,
        {
          status: 'RECOVERY_REQUIRED',
          recoveryState: 'RECONCILING',
          endedAt: undefined
        },
        recoveryOperationId,
        this.now(),
        this.createId
      );
    });
  }

  async enqueueRun(
    runId: string,
    priority: AgentSchedulerPriority,
    operationId: string,
    notBefore?: string
  ): Promise<AgentSchedulerQueueEntry> {
    return this.mutate((draft) =>
      insertQueueEntry(
        draft,
        requireRun(draft, runId),
        priority,
        operationId,
        notBefore,
        this.now(),
        this.createId
      )
    );
  }

  async leaseQueueEntry(
    entryId: string,
    expectedRevision: number,
    operationId: string
  ): Promise<AgentSchedulerQueueEntry> {
    return this.transitionQueueEntry(entryId, expectedRevision, operationId, 'LEASED');
  }

  async releaseQueueEntry(
    entryId: string,
    expectedRevision: number,
    operationId: string
  ): Promise<AgentSchedulerQueueEntry> {
    return this.mutate((draft) => {
      requireOperationId(operationId);
      const fingerprint = requestFingerprint({ entryId });
      if (
        replayedOperation(draft, {
          operationId,
          type: 'QUEUE_RELEASED',
          queueEntryId: entryId,
          requestFingerprint: fingerprint
        })
      ) {
        return requireQueueEntry(draft, entryId);
      }
      const index = draft.queueEntries.findIndex((entry) => entry.id === entryId);
      if (index < 0) throw new Error(`Agent runtime queue entry not found: ${entryId}`);
      const existing = draft.queueEntries[index]!;
      if (existing.recordRevision !== expectedRevision) {
        throw new Error('Agent runtime queue entry changed before the requested update.');
      }
      const run = requireRun(draft, existing.runId);
      if (
        existing.status !== 'LEASED' ||
        run.status !== 'QUEUED' ||
        run.delivery !== 'NOT_SENT'
      ) {
        throw new Error('Only a leased, provably unsubmitted run can return to the queue.');
      }
      const stored: AgentSchedulerQueueEntry = {
        ...existing,
        status: 'QUEUED',
        leasedAt: undefined,
        recordRevision: existing.recordRevision + 1
      };
      draft.queueEntries[index] = stored;
      appendEvent(draft, this.createId, this.now(), {
        type: 'QUEUE_RELEASED',
        owner: stored.owner,
        runId: stored.runId,
        sessionId: stored.sessionId,
        queueEntryId: stored.id,
        operationId,
        payload: { requestFingerprint: fingerprint }
      });
      return stored;
    });
  }

  async cancelQueueEntry(
    entryId: string,
    expectedRevision: number,
    reason: string,
    operationId: string
  ): Promise<AgentSchedulerQueueEntry> {
    if (!reason.trim()) throw new Error('Agent runtime queue cancellation requires a reason.');
    return this.transitionQueueEntry(
      entryId,
      expectedRevision,
      operationId,
      'CANCELED',
      reason.trim()
    );
  }

  async settleQueueEntry(
    entryId: string,
    expectedRevision: number,
    operationId: string
  ): Promise<AgentSchedulerQueueEntry> {
    return this.transitionQueueEntry(entryId, expectedRevision, operationId, 'SETTLED');
  }

  async purgeDiscourseConversation(conversationId: string): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }> {
    requireSafeId(conversationId, 'conversation id');
    return this.purgeRuntimeOwner(
      (owner) =>
        owner?.kind === 'DISCOURSE' && owner.conversationId === conversationId,
      'conversation'
    );
  }

  async purgeTask(taskId: string): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }> {
    requireSafeId(taskId, 'task id');
    return this.purgeRuntimeOwner(
      (owner) => owner?.kind === 'TASK' && owner.taskId === taskId,
      'task'
    );
  }

  async purgePromptRefinement(requestId: string): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }> {
    requireSafeId(requestId, 'prompt-refinement request id');
    return this.purgeRuntimeOwner(
      (owner) =>
        owner?.kind === 'PROMPT_REFINEMENT' && owner.requestId === requestId,
      'prompt refinement'
    );
  }

  async purgePreviewRecipeGeneration(
    taskId: string,
    generationId: string
  ): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }> {
    requireSafeId(taskId, 'preview-recipe task id');
    requireSafeId(generationId, 'preview-recipe generation id');
    return this.purgeRuntimeOwner(
      (owner) =>
        owner?.kind === 'PREVIEW_RECIPE_GENERATION' &&
        owner.taskId === taskId &&
        owner.generationId === generationId,
      'preview-recipe generation'
    );
  }

  private async purgeRuntimeOwner(
    owns: (owner: AgentOwnerScope | undefined) => boolean,
    label: string
  ): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }> {
    const result = await this.mutate((draft) => {
      const sessions = draft.sessions.filter((session) => owns(session.owner));
      const sessionIds = new Set(sessions.map((session) => session.id));
      const runs = draft.runs.filter(
        (run) => owns(run.owner) || sessionIds.has(run.sessionId)
      );
      const runIds = new Set(runs.map((run) => run.id));
      const queueEntries = draft.queueEntries.filter((entry) => runIds.has(entry.runId));
      if (runs.some((run) => !isTerminalRuntimeStatus(run.status))) {
        throw new Error(
          `Agent runtime ${label} cannot be purged while a run still needs settlement.`
        );
      }
      if (
        queueEntries.some(
          (entry) => entry.status !== 'SETTLED' && entry.status !== 'CANCELED'
        )
      ) {
        throw new Error(
          `Agent runtime ${label} cannot be purged while scheduler work is active.`
        );
      }
      const artifacts = draft.artifacts.filter((artifact) => runIds.has(artifact.runId));
      const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
      const queueEntryIds = new Set(queueEntries.map((entry) => entry.id));
      draft.sessions = draft.sessions.filter((session) => !sessionIds.has(session.id));
      draft.runs = draft.runs.filter((run) => !runIds.has(run.id));
      draft.queueEntries = draft.queueEntries.filter(
        (entry) => !queueEntryIds.has(entry.id)
      );
      draft.artifacts = draft.artifacts.filter(
        (artifact) => !artifactIds.has(artifact.id)
      );
      draft.telemetryRecords = draft.telemetryRecords.filter(
        (record) =>
          !owns(record.owner) &&
          !(record.sessionId && sessionIds.has(record.sessionId)) &&
          !(record.runId && runIds.has(record.runId))
      );
      purgeTypedRecords(draft, sessionIds, runIds, owns);
      draft.events = draft.events.filter(
        (event) =>
          !owns(event.owner) &&
          !(event.sessionId && sessionIds.has(event.sessionId)) &&
          !(event.runId && runIds.has(event.runId)) &&
          !(event.queueEntryId && queueEntryIds.has(event.queueEntryId)) &&
          !(event.artifactId && artifactIds.has(event.artifactId))
      );
      return {
        sessionCount: sessions.length,
        runCount: runs.length,
        artifactCount: artifacts.length,
        queueEntryCount: queueEntries.length
      };
    }, true);
    await this.cleanupUnreferencedArtifactFiles();
    return result;
  }

  async setShutdownLatched(latched: boolean, operationId: string): Promise<void> {
    await this.mutate((draft) => {
      requireOperationId(operationId);
      const type = latched ? 'SHUTDOWN_LATCHED' : 'SHUTDOWN_CLEARED';
      const fingerprint = requestFingerprint({ latched });
      if (
        replayedOperation(draft, {
          operationId,
          type,
          requestFingerprint: fingerprint
        })
      ) {
        return undefined;
      }
      if (draft.shutdownLatched === latched) return undefined;
      draft.shutdownLatched = latched;
      appendEvent(draft, this.createId, this.now(), {
        type,
        operationId,
        payload: { requestFingerprint: fingerprint }
      });
      return undefined;
    });
  }

  private transitionQueueEntry(
    entryId: string,
    expectedRevision: number,
    operationId: string,
    status: 'LEASED' | 'CANCELED' | 'SETTLED',
    cancelReason?: string
  ): Promise<AgentSchedulerQueueEntry> {
    return this.mutate((draft) => {
      requireOperationId(operationId);
      const fingerprint = requestFingerprint({
        entryId,
        status,
        cancelReason: cancelReason ?? null
      });
      const replay = replayedOperation(draft, {
        operationId,
        type:
          status === 'LEASED'
            ? 'QUEUE_LEASED'
            : status === 'CANCELED'
              ? 'QUEUE_CANCELED'
              : 'QUEUE_SETTLED',
        queueEntryId: entryId,
        requestFingerprint: fingerprint
      });
      if (replay) {
        return requireQueueEntry(draft, entryId);
      }
      const index = draft.queueEntries.findIndex((entry) => entry.id === entryId);
      if (index < 0) throw new Error(`Agent runtime queue entry not found: ${entryId}`);
      const existing = draft.queueEntries[index]!;
      if (existing.recordRevision !== expectedRevision) {
        throw new Error('Agent runtime queue entry changed before the requested update.');
      }
      const allowed =
        status === 'LEASED'
          ? existing.status === 'QUEUED' && !draft.shutdownLatched
          : status === 'CANCELED'
            ? existing.status === 'QUEUED'
            : existing.status === 'LEASED';
      if (!allowed) {
        throw new Error(`Invalid agent runtime queue transition: ${existing.status} -> ${status}`);
      }
      const now = this.now();
      const stored: AgentSchedulerQueueEntry = {
        ...existing,
        status,
        recordRevision: existing.recordRevision + 1,
        ...(status === 'LEASED' ? { leasedAt: now } : { settledAt: now }),
        ...(cancelReason ? { cancelReason } : {})
      };
      draft.queueEntries[index] = stored;
      appendEvent(draft, this.createId, now, {
        type:
          status === 'LEASED'
            ? 'QUEUE_LEASED'
            : status === 'CANCELED'
              ? 'QUEUE_CANCELED'
              : 'QUEUE_SETTLED',
        owner: stored.owner,
        runId: stored.runId,
        sessionId: stored.sessionId,
        queueEntryId: stored.id,
        operationId,
        payload: {
          ...(cancelReason ? { reason: cancelReason } : {}),
          requestFingerprint: fingerprint
        }
      });
      return stored;
    });
  }

  private runtimeIdForRun(run: AgentRuntimeRunRecord): string | undefined {
    return this.state.sessions.find((session) => session.id === run.sessionId)?.runtimeId;
  }

  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.rootDir);
    await ensurePrivateDirectory(this.artifactsDir);
    await cleanupTemporaryFiles(this.rootDir, this.storePath);
    try {
      const raw = await readPrivateStateFile(this.storePath);
      const parsed = JSON.parse(raw) as AgentRuntimeStoreState;
      validateState(parsed);
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = emptyState();
      await this.persist(this.state);
    }
    await this.reconcileArtifacts();
    const prunedServerIds = pruneUnreferencedTerminalAgentServers(this.state);
    if (prunedServerIds.length > 0) {
      this.state.revision += 1;
      validateState(this.state);
      await this.persist(this.state);
    }
    await this.protocolJournal.reconcileServers(
      this.state.servers.map((server) => server.id)
    );
  }

  private async reconcileArtifacts(): Promise<void> {
    const expected = new Set(this.state.artifacts.map((artifact) => artifact.storageKey));
    for (const artifact of this.state.artifacts) {
      await readVerifiedArtifact(this.artifactsDir, artifact);
    }
    for (const entry of await fs.readdir(this.artifactsDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !ARTIFACT_FILE.test(entry.name)) {
        throw new Error('Agent runtime artifact directory contains an unsafe entry.');
      }
      if (!expected.has(entry.name)) {
        const candidate = path.join(this.artifactsDir, entry.name);
        const stat = await fs.lstat(candidate);
        if (!isOwnedByCurrentUser(stat) || !hasNoGroupOrOtherPosixAccess(stat)) {
          throw new Error('Agent runtime orphan artifact failed its integrity check.');
        }
        await fs.unlink(candidate);
      }
    }
    await this.syncDirectoryHook(this.artifactsDir);
  }

  private async cleanupUnreferencedArtifactFiles(): Promise<void> {
    const expected = new Set(this.state.artifacts.map((artifact) => artifact.storageKey));
    let removed = false;
    for (const entry of await fs.readdir(this.artifactsDir, { withFileTypes: true })) {
      if (!ARTIFACT_FILE.test(entry.name) || expected.has(entry.name)) continue;
      const candidate = path.join(this.artifactsDir, entry.name);
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
        throw new Error('Agent runtime orphan artifact failed its integrity check.');
      }
      await fs.unlink(candidate);
      removed = true;
    }
    if (removed) await this.syncDirectoryHook(this.artifactsDir);
  }

  private withProtocolJournal<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closePromise) {
      return Promise.reject(new Error('Agent runtime store is closed.'));
    }
    const initialization = this.ensureInitialized();
    const admittedMutations = this.operationQueue.catch(() => undefined);
    const running = (async () => {
      await initialization;
      await admittedMutations;
      return operation();
    })();
    this.activeProtocolOperations.add(running);
    void running.then(
      () => this.activeProtocolOperations.delete(running),
      () => this.activeProtocolOperations.delete(running)
    );
    return running;
  }

  private mutate<T>(
    operation: (draft: AgentRuntimeStoreState) => T | Promise<T>,
    collectTerminalServers = false
  ): Promise<T> {
    if (this.closePromise) {
      return Promise.reject(new Error('Agent runtime store is closed.'));
    }
    const initialization = this.ensureInitialized();
    const queued = this.operationQueue.catch(() => undefined).then(async () => {
      await initialization;
      if (this.publishedFailure) {
        throw new Error(
          'Agent runtime state was published without confirmed directory sync; restart before continuing.'
        );
      }
      const draft = clone(this.state);
      const before = stableStringify(draft);
      const result = await operation(draft);
      const prunedServerIds = collectTerminalServers
        ? pruneUnreferencedTerminalAgentServers(draft)
        : [];
      if (stableStringify(draft) === before) return clone(result);
      draft.revision += 1;
      validateState(draft);
      try {
        await this.persist(draft);
      } catch (error) {
        if (error instanceof AgentRuntimeStorePublishedError) this.publishedFailure = true;
        throw error;
      }
      this.state = draft;
      await cleanupPrunedServerJournals(this.protocolJournal, prunedServerIds);
      return clone(result);
    });
    this.operationQueue = queued.catch(() => undefined);
    return queued;
  }

  private async persist(state: AgentRuntimeStoreState): Promise<void> {
    const encoded = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > AGENT_RUNTIME_LIMITS.maxRuntimeStateBytes) {
      throw new Error('Agent runtime store exceeds its bounded state limit.');
    }
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let published = false;
    try {
      handle = await fs.open(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await enforcePosixMode(handle, 0o600);
      await handle.sync();
      await this.afterFileSync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.storePath);
      published = true;
      await this.afterRename();
      await this.syncDirectoryHook(this.rootDir);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      if (published) {
        throw new AgentRuntimeStorePublishedError(
          'Agent runtime state was published but its directory sync did not complete.',
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function pruneUnreferencedTerminalAgentServers(
  state: AgentRuntimeStoreState
): string[] {
  const referencedServerIds = collectReferencedAgentServerIds(state);
  const prunedServerIds = state.servers
    .filter(
      (server) =>
        isTerminalAgentServerStatus(server.status) &&
        !referencedServerIds.has(server.id)
    )
    .sort(compareAgentServerDiagnosticsNewestFirst)
    .slice(MAX_UNREFERENCED_TERMINAL_AGENT_SERVERS)
    .map((server) => server.id);
  if (prunedServerIds.length === 0) return [];
  const pruned = new Set(prunedServerIds);
  state.servers = state.servers.filter((server) => !pruned.has(server.id));
  return prunedServerIds;
}

async function cleanupPrunedServerJournals(
  journal: AgentProtocolJournal,
  serverInstanceIds: readonly string[]
): Promise<void> {
  // The record removal is already durable. Startup reconciliation retries any
  // cleanup that fails without risking a dangling durable reference.
  await Promise.allSettled(
    serverInstanceIds.map((serverInstanceId) =>
      journal.removeServer(serverInstanceId)
    )
  );
}

function isTerminalAgentServerStatus(
  status: AgentServerInstance['status']
): boolean {
  return status === 'EXITED' || status === 'FAILED' || status === 'LOST';
}

function collectReferencedAgentServerIds(
  state: AgentRuntimeStoreState
): Set<string> {
  const knownServerIds = new Set(state.servers.map((server) => server.id));
  const referencedServerIds = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (knownServerIds.has(value)) referencedServerIds.add(value);
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const item of Object.values(value)) visit(item);
  };

  for (const [collection, value] of Object.entries(state)) {
    if (collection !== 'servers') visit(value);
  }
  for (const server of state.servers) {
    const { id: _selfIdentity, ...serverMetadata } = server;
    visit(serverMetadata);
  }
  return referencedServerIds;
}

function compareAgentServerDiagnosticsNewestFirst(
  left: AgentServerInstance,
  right: AgentServerInstance
): number {
  const timestampDifference =
    agentServerDiagnosticTimestamp(right) - agentServerDiagnosticTimestamp(left);
  return timestampDifference || right.id.localeCompare(left.id);
}

function agentServerDiagnosticTimestamp(server: AgentServerInstance): number {
  for (const value of [
    server.exitedAt,
    server.disconnectedAt,
    server.lastHealthAt,
    server.initializedAt,
    server.startedAt
  ]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function appendEvent(
  state: AgentRuntimeStoreState,
  createId: () => string,
  occurredAt: string,
  event: Omit<AgentRuntimeEventRecord, 'id' | 'ordinal' | 'occurredAt'>
): void {
  if (state.events.length >= AGENT_RUNTIME_LIMITS.maxEvents) {
    throw new Error('Agent runtime event limit reached.');
  }
  state.events.push({
    ...event,
    id: createId(),
    ordinal: state.nextEventOrdinal++,
    occurredAt
  });
}

function insertRuntimeSession(
  draft: AgentRuntimeStoreState,
  input: CreateRuntimeSessionInput,
  now: string,
  createId: () => string
): AgentRuntimeSessionRecord {
  requireOperationId(input.clientOperationId);
  assertAgentOwnerScope(input.owner);
  assertAccessEpochMatches({
    epoch: input.accessEpoch,
    owner: input.owner,
    sessionId: input.id
  });
  assertExecutionContextMatchesEpoch(input);
  const fingerprint = requestFingerprint(input);
  const existing = draft.sessions.find(
    (session) =>
      agentOwnerScopeKey(session.owner) === agentOwnerScopeKey(input.owner) &&
      session.clientOperationId === input.clientOperationId
  );
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new Error('Agent runtime session operation conflicts with its durable request.');
    }
    return existing;
  }
  if (draft.sessions.some((session) => session.id === input.id)) {
    throw new Error(`Agent runtime session already exists: ${input.id}`);
  }
  if (draft.sessions.length >= AGENT_RUNTIME_LIMITS.maxSessions) {
    throw new Error('Agent runtime session limit reached.');
  }
  const session: AgentRuntimeSessionRecord = {
    ...clone(input),
    requestFingerprint: fingerprint,
    recordRevision: 1,
    createdAt: now,
    updatedAt: now
  };
  draft.sessions.push(session);
  appendEvent(draft, createId, now, {
    type: 'SESSION_CREATED',
    owner: session.owner,
    sessionId: session.id,
    operationId: session.clientOperationId,
    payload: { accessEpoch: session.accessEpoch.epoch }
  });
  return session;
}

function insertRuntimeRun(
  draft: AgentRuntimeStoreState,
  input: CreateRuntimeRunInput,
  initial: Pick<
    AgentRuntimeRunRecord,
    'status' | 'delivery' | 'recoveryState' | 'startedAt'
  > & { providerObserved: boolean },
  now: string,
  createId: () => string
): AgentRuntimeRunRecord {
  requireOperationId(input.clientOperationId);
  if (
    !input.generationKey ||
    Buffer.byteLength(input.generationKey, 'utf8') >
      AGENT_RUNTIME_LIMITS.maxGenerationKeyBytes
  ) {
    throw new Error('Agent runtime generation key is invalid.');
  }
  assertAgentOwnerScope(input.owner);
  assertAgentRunScope(input.scope, input.owner);
  assertAgentRuntimePurposeScope(input.purpose, input.scope);
  const session = requireSession(draft, input.sessionId);
  if (
    agentOwnerScopeKey(session.owner) !== agentOwnerScopeKey(input.owner) ||
    session.accessEpoch.epoch !== input.sessionAccessEpoch
  ) {
    throw new Error('Agent runtime run does not match its session owner/access epoch.');
  }
  const normalizedInput = {
    ...input,
    attachmentSelection: clone(input.attachmentSelection ?? [])
  };
  assertAttachmentSelection(normalizedInput.attachmentSelection);
  const fingerprint = requestFingerprint(normalizedInput);
  const existing = draft.runs.find(
    (run) =>
      agentOwnerScopeKey(run.owner) === agentOwnerScopeKey(input.owner) &&
      run.clientOperationId === input.clientOperationId
  );
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new Error('Agent runtime run operation conflicts with its durable request.');
    }
    return existing;
  }
  if (draft.runs.some((run) => run.id === input.id)) {
    throw new Error(`Agent runtime run already exists: ${input.id}`);
  }
  if (draft.runs.length >= AGENT_RUNTIME_LIMITS.maxRuns) {
    throw new Error('Agent runtime run limit reached.');
  }
  const { providerObserved, ...lifecycle } = initial;
  const run: AgentRuntimeRunRecord = {
    ...clone(normalizedInput),
    ...lifecycle,
    requestFingerprint: fingerprint,
    recordRevision: 1,
    createdAt: now
  };
  draft.runs.push(run);
  appendEvent(draft, createId, now, {
    type: 'RUN_CREATED',
    owner: run.owner,
    runId: run.id,
    sessionId: run.sessionId,
    operationId: run.clientOperationId,
    payload: {
      purpose: run.purpose,
      generationKey: run.generationKey,
      providerObserved
    }
  });
  return run;
}

function insertQueueEntry(
  draft: AgentRuntimeStoreState,
  run: AgentRuntimeRunRecord,
  priority: AgentSchedulerPriority,
  operationId: string,
  notBefore: string | undefined,
  now: string,
  createId: () => string
): AgentSchedulerQueueEntry {
  requireOperationId(operationId);
  const fingerprint = requestFingerprint({
    runId: run.id,
    priority,
    notBefore: notBefore ?? null
  });
  const existing = draft.queueEntries.find((entry) => entry.runId === run.id);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new Error('Agent runtime enqueue operation conflicts with its durable request.');
    }
    return existing;
  }
  if (draft.shutdownLatched) {
    throw new Error('Agent runtime scheduler is shut down.');
  }
  if (draft.queueEntries.length >= AGENT_RUNTIME_LIMITS.maxQueueEntries) {
    throw new Error('Agent runtime queue limit reached.');
  }
  if (run.status !== 'QUEUED' || run.delivery !== 'NOT_SENT') {
    throw new Error('Only an unsubmitted queued run can enter the scheduler.');
  }
  if (notBefore) requireTimestamp(notBefore);
  const entry: AgentSchedulerQueueEntry = {
    id: createId(),
    runId: run.id,
    clientOperationId: operationId,
    requestFingerprint: fingerprint,
    owner: clone(run.owner),
    scope: clone(run.scope),
    sessionId: run.sessionId,
    priority,
    status: 'QUEUED',
    enqueueOrdinal: draft.nextQueueOrdinal++,
    recordRevision: 1,
    enqueuedAt: now,
    ...(notBefore ? { notBefore } : {})
  };
  draft.queueEntries.push(entry);
  appendEvent(draft, createId, now, {
    type: 'QUEUE_ENQUEUED',
    owner: entry.owner,
    runId: run.id,
    sessionId: entry.sessionId,
    queueEntryId: entry.id,
    operationId,
    payload: {
      priority,
      enqueueOrdinal: entry.enqueueOrdinal,
      requestFingerprint: fingerprint
    }
  });
  return entry;
}

type RuntimeRunUpdate = Parameters<AgentRuntimeStore['updateRun']>[2];

function updateRuntimeRunRecord(
  draft: AgentRuntimeStoreState,
  runId: string,
  expectedRevision: number,
  update: RuntimeRunUpdate,
  operationId: string,
  occurredAt: string,
  createId: () => string
): AgentRuntimeRunRecord {
  requireOperationId(operationId);
  const fingerprint = requestFingerprint({ runId, update });
  if (
    replayedOperation(draft, {
      operationId,
      type: 'RUN_UPDATED',
      runId,
      requestFingerprint: fingerprint
    })
  ) {
    return requireRun(draft, runId);
  }
  const existing = requireRun(draft, runId);
  if (existing.recordRevision !== expectedRevision) {
    throw new Error('Agent runtime run changed before the requested update.');
  }
  if (
    update.status &&
    update.status !== existing.status &&
    !RUN_STATUS_TRANSITIONS[existing.status].includes(update.status)
  ) {
    throw new Error(
      `Invalid agent runtime run transition: ${existing.status} -> ${update.status}`
    );
  }
  if (
    update.delivery &&
    update.delivery !== existing.delivery &&
    !DELIVERY_TRANSITIONS[existing.delivery].includes(update.delivery)
  ) {
    throw new Error(
      `Invalid agent runtime delivery transition: ${existing.delivery} -> ${update.delivery}`
    );
  }
  if (update.interruptDelivery) {
    if (!existing.interruptDelivery && update.interruptDelivery !== 'SENDING') {
      throw new Error('Agent runtime interrupt delivery must begin with durable send intent.');
    }
    if (
      existing.interruptDelivery &&
      update.interruptDelivery !== existing.interruptDelivery &&
      update.interruptDelivery !== 'TERMINAL' &&
      !DELIVERY_TRANSITIONS[existing.interruptDelivery].includes(
        update.interruptDelivery
      )
    ) {
      throw new Error(
        `Invalid agent runtime interrupt delivery transition: ${existing.interruptDelivery} -> ${update.interruptDelivery}`
      );
    }
  }
  const stored: AgentRuntimeRunRecord = {
    ...existing,
    ...clone(update),
    recordRevision: existing.recordRevision + 1
  };
  replaceRun(draft, stored);
  appendEvent(draft, createId, occurredAt, {
    type: 'RUN_UPDATED',
    owner: stored.owner,
    runId: stored.id,
    sessionId: stored.sessionId,
    operationId,
    payload: {
      fromStatus: existing.status,
      status: stored.status,
      fromDelivery: existing.delivery,
      delivery: stored.delivery,
      requestFingerprint: fingerprint
    }
  });
  return stored;
}

async function appendInitialRunArtifacts(input: {
  draft: AgentRuntimeStoreState;
  run: AgentRuntimeRunRecord;
  artifactsDir: string;
  syncDirectory: (directory: string) => Promise<void>;
  createId: () => string;
  now: string;
  operationId: string;
  prompt: string;
}): Promise<void> {
  const entries = [
    { id: input.run.promptArtifactId, kind: 'PROMPT' as const, content: input.prompt },
    { id: input.run.outputArtifactId, kind: 'OUTPUT' as const, content: '' },
    {
      id: input.run.diagnosticArtifactId,
      kind: 'DIAGNOSTIC' as const,
      content: ''
    }
  ];
  for (const entry of entries) {
    const encoded = encodeArtifactContent(entry.content);
    const storageKey = artifactStorageKey(entry.id, 1);
    await writeImmutableArtifact(
      input.artifactsDir,
      storageKey,
      encoded.bytes,
      input.syncDirectory
    );
    const artifactOperationId = derivedOperationId(input.operationId, entry.kind);
    const artifact: AgentRuntimeArtifactRecord = {
      id: entry.id,
      owner: clone(input.run.owner),
      runId: input.run.id,
      kind: entry.kind,
      clientOperationId: artifactOperationId,
      requestFingerprint: requestFingerprint({
        id: entry.id,
        runId: input.run.id,
        kind: entry.kind,
        contentSha256: encoded.sha256,
        byteCount: encoded.bytes.byteLength
      }),
      storageKey,
      contentSha256: encoded.sha256,
      byteCount: encoded.bytes.byteLength,
      recordRevision: 1,
      createdAt: input.now,
      updatedAt: input.now
    };
    input.draft.artifacts.push(artifact);
    appendEvent(input.draft, input.createId, input.now, {
      type: 'ARTIFACT_CREATED',
      owner: artifact.owner,
      runId: input.run.id,
      artifactId: artifact.id,
      operationId: artifactOperationId,
      payload: {
        kind: artifact.kind,
        contentSha256: artifact.contentSha256,
        byteCount: artifact.byteCount,
        requestFingerprint: artifact.requestFingerprint
      }
    });
  }
}

function assertCompleteInitialRunArtifacts(
  artifacts: readonly AgentRuntimeArtifactRecord[],
  run: AgentRuntimeRunRecord,
  prompt: string
): void {
  const expected = [
    { id: run.promptArtifactId, kind: 'PROMPT' as const, content: prompt },
    { id: run.outputArtifactId, kind: 'OUTPUT' as const, content: '' },
    { id: run.diagnosticArtifactId, kind: 'DIAGNOSTIC' as const, content: '' }
  ];
  for (const entry of expected) {
    const artifact = artifacts.find((candidate) => candidate.id === entry.id);
    const encoded = encodeArtifactContent(entry.content);
    if (
      !artifact ||
      artifact.kind !== entry.kind ||
      artifact.contentSha256 !== encoded.sha256 ||
      artifact.byteCount !== encoded.bytes.byteLength
    ) {
      throw new Error('Prepared agent runtime turn conflicts with its durable artifacts.');
    }
  }
}

function emptyState(): AgentRuntimeStoreState {
  return {
    schemaVersion: AGENT_RUNTIME_STORE_SCHEMA_VERSION,
    revision: 0,
    nextEventOrdinal: 1,
    nextQueueOrdinal: 1,
    shutdownLatched: false,
    servers: [],
    sessions: [],
    runs: [],
    queueEntries: [],
    artifacts: [],
    telemetryRecords: [],
    items: [],
    interactions: [],
    goalSnapshots: [],
    planRevisions: [],
    usageSnapshots: [],
    settingsObservations: [],
    subagentObservations: [],
    events: []
  };
}

function isUndeliveredSessionReplacement(
  state: AgentRuntimeStoreState,
  replacement: AgentRuntimeSessionRecord,
  replaced: AgentRuntimeSessionRecord
): boolean {
  if (
    replacement.parentSessionId !== replaced.id ||
    replaced.materialized ||
    replacement.runtimeId !== replaced.runtimeId ||
    agentOwnerScopeKey(replacement.owner) !== agentOwnerScopeKey(replaced.owner)
  ) {
    return false;
  }
  return state.runs.some((run) => {
    const retryOfRunId = run.taskDetails?.retryOfRunId;
    if (run.sessionId !== replacement.id || !retryOfRunId) return false;
    const replacedRun = state.runs.find(
      (candidate) =>
        candidate.id === retryOfRunId && candidate.sessionId === replaced.id
    );
    return (
      replacedRun?.status === 'FAILED' &&
      replacedRun.delivery === 'NOT_DELIVERED' &&
      replacedRun.providerTurnId === undefined
    );
  });
}

function validateState(state: AgentRuntimeStoreState): void {
  if (
    !state ||
    typeof state !== 'object' ||
    state.schemaVersion !== AGENT_RUNTIME_STORE_SCHEMA_VERSION
  ) {
    const version = (state as { schemaVersion?: unknown } | undefined)?.schemaVersion;
    throw new Error(
      Number.isSafeInteger(version) && Number(version) > AGENT_RUNTIME_STORE_SCHEMA_VERSION
        ? `Agent runtime schema ${String(version)} is newer than this app supports. Upgrade Task Monki or restore a compatible backup.`
        : `Unsupported or invalid Agent runtime schema ${String(version)}.`
    );
  }
  if (
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Number.isSafeInteger(state.nextEventOrdinal) ||
    state.nextEventOrdinal < 1 ||
    !Number.isSafeInteger(state.nextQueueOrdinal) ||
    state.nextQueueOrdinal < 1 ||
    typeof state.shutdownLatched !== 'boolean' ||
    !Array.isArray(state.servers) ||
    !Array.isArray(state.sessions) ||
    !Array.isArray(state.runs) ||
    !Array.isArray(state.queueEntries) ||
    !Array.isArray(state.artifacts) ||
    !Array.isArray(state.telemetryRecords) ||
    !Array.isArray(state.items) ||
    !Array.isArray(state.interactions) ||
    !Array.isArray(state.goalSnapshots) ||
    !Array.isArray(state.planRevisions) ||
    !Array.isArray(state.usageSnapshots) ||
    !Array.isArray(state.settingsObservations) ||
    !Array.isArray(state.subagentObservations) ||
    !Array.isArray(state.events)
  ) {
    throw new Error('Agent runtime store metadata is invalid.');
  }
  if (
    state.servers.length > AGENT_RUNTIME_LIMITS.maxServerInstances ||
    state.sessions.length > AGENT_RUNTIME_LIMITS.maxSessions ||
    state.runs.length > AGENT_RUNTIME_LIMITS.maxRuns ||
    state.queueEntries.length > AGENT_RUNTIME_LIMITS.maxQueueEntries ||
    state.artifacts.length > AGENT_RUNTIME_LIMITS.maxArtifacts ||
    state.telemetryRecords.length > AGENT_RUNTIME_LIMITS.maxTelemetryRecords ||
    typedRecordCount(state) > AGENT_RUNTIME_LIMITS.maxTypedRecords ||
    state.events.length > AGENT_RUNTIME_LIMITS.maxEvents
  ) {
    throw new Error('Agent runtime store collection exceeds its safety limit.');
  }
  uniqueIds(state.servers, 'servers');
  for (const server of state.servers) assertAgentServer(server);
  const sessionIds = uniqueIds(state.sessions, 'sessions');
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));
  const sessionOperations = new Set<string>();
  const providerSessionIds = new Set<string>();
  for (const session of state.sessions) {
    assertAgentOwnerScope(session.owner);
    assertAccessEpochMatches({ epoch: session.accessEpoch, owner: session.owner, sessionId: session.id });
    assertExecutionContextMatchesEpoch(session);
    requireRevision(session.recordRevision);
    requireTimestamp(session.createdAt);
    requireTimestamp(session.updatedAt);
    if (session.lastAttachedAt !== undefined) {
      requireTimestamp(session.lastAttachedAt);
    }
    if (
      !(session.status in SESSION_STATUS_TRANSITIONS) ||
      typeof session.materialized !== 'boolean' ||
      (session.providerSessionId !== undefined && !session.providerSessionId) ||
      (session.providerSessionTreeId !== undefined && !session.providerSessionTreeId) ||
      session.updatedAt < session.createdAt ||
      (session.providerSessionId !== undefined &&
        providerSessionIds.has(
          `${session.runtimeId}:${session.providerSessionId}`
        ))
    ) {
      throw new Error('Agent runtime session lifecycle metadata is invalid.');
    }
    if (session.owner.kind === 'TASK') {
      if (
        !session.taskContext ||
        !session.taskContext.iterationId ||
        !session.taskContext.worktreeId ||
        !path.isAbsolute(session.taskContext.worktreePath) ||
        session.taskContext.worktreePath !== session.executionContext.primaryCwd
      ) {
        throw new Error('Task agent runtime session context is invalid.');
      }
    } else if (session.taskContext !== undefined) {
      throw new Error('Non-Task agent runtime sessions cannot carry Task context.');
    }
    if (session.providerSessionId !== undefined) {
      providerSessionIds.add(
        `${session.runtimeId}:${session.providerSessionId}`
      );
    }
    if (!HASH.test(session.requestFingerprint)) {
      throw new Error('Agent runtime session request fingerprint is invalid.');
    }
    requireOperationId(session.clientOperationId);
    const operationKey = `${agentOwnerScopeKey(session.owner)}:${session.clientOperationId}`;
    if (sessionOperations.has(operationKey)) {
      throw new Error('Agent runtime sessions contain a duplicate operation.');
    }
    sessionOperations.add(operationKey);
  }
  void sessionIds;
  uniqueIds(state.runs, 'runs');
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  const runOperations = new Set<string>();
  for (const run of state.runs) {
    assertAgentOwnerScope(run.owner);
    assertAgentRunScope(run.scope, run.owner);
    assertAgentRuntimePurposeScope(run.purpose, run.scope);
    const session = sessions.get(run.sessionId);
    if (
      !session ||
      agentOwnerScopeKey(session.owner) !== agentOwnerScopeKey(run.owner) ||
      session.accessEpoch.epoch !== run.sessionAccessEpoch
    ) {
      throw new Error('Agent runtime run references an invalid session/access epoch.');
    }
    requireRevision(run.recordRevision);
    requireTimestamp(run.createdAt);
    assertRuntimeRunLifecycle(run);
    if (!HASH.test(run.requestFingerprint)) {
      throw new Error('Agent runtime run request fingerprint is invalid.');
    }
    requireOperationId(run.clientOperationId);
    if (
      !run.generationKey ||
      Buffer.byteLength(run.generationKey, 'utf8') >
        AGENT_RUNTIME_LIMITS.maxGenerationKeyBytes
    ) {
      throw new Error('Agent runtime run generation key is invalid.');
    }
    if (
      run.contextFreshnessAtCompletion &&
      (run.scope.kind !== 'DISCOURSE' || run.status !== 'COMPLETED')
    ) {
      throw new Error('Only a completed discourse runtime run may carry context freshness.');
    }
    if (Boolean(run.taskReviewTarget) !== (run.purpose === 'TASK_REVIEW')) {
      throw new Error('Agent runtime task review metadata does not match its purpose.');
    }
    if (run.stopRequestedAt !== undefined) requireTimestamp(run.stopRequestedAt);
    if (run.providerTerminalRawMessage) {
      assertProtocolReferenceShape(run.providerTerminalRawMessage);
    }
    assertAttachmentSelection(run.attachmentSelection);
    if (run.attachmentSubmissions) {
      assertAttachmentSubmissions(
        run.attachmentSubmissions,
        run.attachmentSelection,
        run.providerTurnId
      );
    }
    if (
      run.clientToolGrants &&
      (run.clientToolGrants.length > 32 ||
        new Set(run.clientToolGrants).size !== run.clientToolGrants.length ||
        run.clientToolGrants.some(
          (grant) =>
            !grant || Buffer.byteLength(grant, 'utf8') > AGENT_RUNTIME_LIMITS.maxOwnerIdBytes
        ))
    ) {
      throw new Error('Agent runtime client-tool grants are invalid.');
    }
    if (
      Boolean(run.interruptDelivery) !== Boolean(run.stopRequestedAt) ||
      (run.interruptDelivery !== undefined &&
        !(run.interruptDelivery in DELIVERY_TRANSITIONS))
    ) {
      throw new Error('Agent runtime interrupt lifecycle metadata is invalid.');
    }
    const operationKey = `${agentOwnerScopeKey(run.owner)}:${run.clientOperationId}`;
    if (runOperations.has(operationKey)) {
      throw new Error('Agent runtime runs contain a duplicate operation.');
    }
    runOperations.add(operationKey);
  }
  uniqueIds(state.artifacts, 'artifacts');
  const artifactOperations = new Set<string>();
  for (const artifact of state.artifacts) {
    assertAgentOwnerScope(artifact.owner);
    const run = runs.get(artifact.runId);
    if (
      !run ||
      agentOwnerScopeKey(run.owner) !== agentOwnerScopeKey(artifact.owner) ||
      !artifactMatchesRunReference(artifact, run) ||
      artifact.storageKey !== artifactStorageKey(artifact.id, artifact.recordRevision) ||
      !HASH.test(artifact.contentSha256) ||
      !HASH.test(artifact.requestFingerprint) ||
      !Number.isSafeInteger(artifact.byteCount) ||
      artifact.byteCount < 0 ||
      artifact.byteCount > AGENT_RUNTIME_LIMITS.maxArtifactBytes
    ) {
      throw new Error('Agent runtime artifact does not match its run or content metadata.');
    }
    requireRevision(artifact.recordRevision);
    requireOperationId(artifact.clientOperationId);
    requireTimestamp(artifact.createdAt);
    requireTimestamp(artifact.updatedAt);
    const operationKey = `${agentOwnerScopeKey(artifact.owner)}:${artifact.clientOperationId}`;
    if (artifactOperations.has(operationKey)) {
      throw new Error('Agent runtime artifacts contain a duplicate operation.');
    }
    artifactOperations.add(operationKey);
  }
  uniqueIds(state.telemetryRecords, 'telemetry records');
  const telemetryOperations = new Set<string>();
  for (const record of state.telemetryRecords) {
    requireSafeId(record.id, 'telemetry id');
    if (!TELEMETRY_KINDS.has(record.kind)) {
      throw new Error('Agent runtime telemetry kind is invalid.');
    }
    if (record.owner) assertAgentOwnerScope(record.owner);
    requireOperationId(record.clientOperationId);
    requireTimestamp(record.observedAt);
    requireTimestamp(record.createdAt);
    if (!HASH.test(record.requestFingerprint)) {
      throw new Error('Agent runtime telemetry request fingerprint is invalid.');
    }
    assertTelemetryPayload(record.payload);
    assertTelemetryReferences(state, record);
    const operationKey = `${record.owner ? agentOwnerScopeKey(record.owner) : 'app'}:${record.clientOperationId}`;
    if (telemetryOperations.has(operationKey)) {
      throw new Error('Agent runtime telemetry contains a duplicate operation.');
    }
    telemetryOperations.add(operationKey);
  }
  validateItems(state, sessions, runs);
  validateInteractions(state, sessions, runs);
  validateGoalSnapshots(state, sessions);
  validatePlanRevisions(state, sessions, runs);
  validateUsageSnapshots(state, sessions, runs);
  validateSettingsObservations(state, sessions, runs);
  validateSubagentObservations(state, sessions, runs);
  uniqueIds(state.queueEntries, 'queue entries');
  const queueRuns = new Set<string>();
  const queueOrdinals = new Set<number>();
  for (const entry of state.queueEntries) {
    const run = runs.get(entry.runId);
    if (
      !run ||
      run.sessionId !== entry.sessionId ||
      agentOwnerScopeKey(run.owner) !== agentOwnerScopeKey(entry.owner) ||
      stableStringify(run.scope) !== stableStringify(entry.scope) ||
      queueRuns.has(entry.runId) ||
      queueOrdinals.has(entry.enqueueOrdinal)
    ) {
      throw new Error('Agent runtime queue entry does not match its run.');
    }
    requireOperationId(entry.clientOperationId);
    if (!HASH.test(entry.requestFingerprint)) {
      throw new Error('Agent runtime queue request fingerprint is invalid.');
    }
    queueRuns.add(entry.runId);
    queueOrdinals.add(entry.enqueueOrdinal);
    requireRevision(entry.recordRevision);
    requireTimestamp(entry.enqueuedAt);
  }
  uniqueIds(state.events, 'events');
  let priorOrdinal = 0;
  for (const event of state.events) {
    if (event.ordinal <= priorOrdinal || !Number.isSafeInteger(event.ordinal)) {
      throw new Error('Agent runtime event ordinals are invalid.');
    }
    priorOrdinal = event.ordinal;
    requireTimestamp(event.occurredAt);
  }
  if (state.nextEventOrdinal <= priorOrdinal) {
    throw new Error('Agent runtime next event ordinal is invalid.');
  }
  if (state.nextQueueOrdinal <= Math.max(0, ...queueOrdinals)) {
    throw new Error('Agent runtime next queue ordinal is invalid.');
  }
}

function typedRecordCount(state: AgentRuntimeStoreState): number {
  return (
    state.items.length +
    state.interactions.length +
    state.goalSnapshots.length +
    state.planRevisions.length +
    state.usageSnapshots.length +
    state.settingsObservations.length +
    state.subagentObservations.length
  );
}

function validateItems(
  state: AgentRuntimeStoreState,
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>
): void {
  uniqueIds(state.items, 'items');
  const providerItems = new Set<string>();
  for (const item of state.items) {
    const { run } = assertTypedRunRecord(item, sessions, runs, 'item');
    const providerKey = `${item.runId}:${item.providerItemId}`;
    if (
      !item.providerItemId ||
      providerItems.has(providerKey) ||
      !isItemStatus(item.status) ||
      !isItemType(item.type) ||
      item.updatedAt < item.createdAt
    ) {
      throw new Error('Agent runtime item metadata is invalid.');
    }
    providerItems.add(providerKey);
    requireTimestamp(item.createdAt);
    requireTimestamp(item.updatedAt);
    if (item.providerStartedAt) requireTimestamp(item.providerStartedAt);
    if (item.providerCompletedAt) requireTimestamp(item.providerCompletedAt);
    assertTelemetryPayload(item.payload);
    if (item.rawMessage) assertProtocolReferenceShape(item.rawMessage);
    if (item.outputArtifactId) {
      const artifact = state.artifacts.find(
        (candidate) => candidate.id === item.outputArtifactId
      );
      if (!artifact || artifact.runId !== run.id) {
        throw new Error('Agent runtime item output artifact is invalid.');
      }
    }
  }
}

function validateInteractions(
  state: AgentRuntimeStoreState,
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>
): void {
  uniqueIds(state.interactions, 'interactions');
  const activeProviderIds = new Set<string>();
  for (const interaction of state.interactions) {
    assertTypedRunRecord(interaction, sessions, runs, 'interaction');
    if (
      !isInteractionStatus(interaction.status) ||
      !isInteractionType(interaction.type) ||
      !Array.isArray(interaction.allowedActions) ||
      !Array.isArray(interaction.policyWarnings)
    ) {
      throw new Error('Agent runtime interaction metadata is invalid.');
    }
    assertProtocolReferenceShape(interaction.requestRawMessage);
    if (
      interaction.requestRawMessage.serverInstanceId !==
      interaction.serverInstanceId
    ) {
      throw new Error('Agent runtime interaction request evidence is invalid.');
    }
    if (interaction.responseRawMessage) {
      assertProtocolReferenceShape(interaction.responseRawMessage);
      if (
        interaction.responseRawMessage.serverInstanceId !== interaction.serverInstanceId
      ) {
        throw new Error('Agent runtime interaction response evidence is invalid.');
      }
    }
    requireTimestamp(interaction.requestedAt);
    if (interaction.respondedAt) requireTimestamp(interaction.respondedAt);
    if (interaction.resolvedAt) requireTimestamp(interaction.resolvedAt);
    assertTelemetryPayload(interaction.request);
    assertTelemetryPayload(interaction.allowedActions);
    assertTelemetryPayload(interaction.policyWarnings);
    if (interaction.decision !== undefined) assertTelemetryPayload(interaction.decision);
    if (interaction.resolution !== undefined) assertTelemetryPayload(interaction.resolution);
    if (isActiveInteractionStatus(interaction.status)) {
      const key = `${interaction.serverInstanceId}:${String(interaction.providerRequestId)}`;
      if (activeProviderIds.has(key)) {
        throw new Error('Agent runtime interactions contain an active provider-id collision.');
      }
      activeProviderIds.add(key);
    }
  }
}

function validateGoalSnapshots(
  state: AgentRuntimeStoreState,
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>
): void {
  uniqueIds(state.goalSnapshots, 'goal snapshots');
  for (const record of state.goalSnapshots) {
    assertTypedSessionRecord(record, sessions, 'goal snapshot');
    requireTimestamp(record.observedAt);
    if (record.providerCreatedAt) requireTimestamp(record.providerCreatedAt);
    if (record.providerUpdatedAt) requireTimestamp(record.providerUpdatedAt);
    if (!record.taskGoalHash || !record.syncState || !record.source) {
      throw new Error('Agent runtime goal snapshot metadata is invalid.');
    }
    if (record.rawMessage) assertProtocolReferenceShape(record.rawMessage);
  }
}

function validatePlanRevisions(
  state: AgentRuntimeStoreState,
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>
): void {
  uniqueIds(state.planRevisions, 'plan revisions');
  const revisionsByRun = new Map<string, number[]>();
  for (const record of state.planRevisions) {
    assertTypedRunRecord(record, sessions, runs, 'plan revision');
    requireTimestamp(record.observedAt);
    requireRevision(record.revision);
    assertProtocolReferenceShape(record.rawMessage);
    assertTelemetryPayload(record.steps);
    const revisions = revisionsByRun.get(record.runId) ?? [];
    revisions.push(record.revision);
    revisionsByRun.set(record.runId, revisions);
  }
  for (const revisions of revisionsByRun.values()) {
    revisions.sort((left, right) => left - right);
    if (revisions.some((revision, index) => revision !== index + 1)) {
      throw new Error('Agent runtime plan revisions are not contiguous.');
    }
  }
}

function validateUsageSnapshots(
  state: AgentRuntimeStoreState,
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>
): void {
  uniqueIds(state.usageSnapshots, 'usage snapshots');
  for (const record of state.usageSnapshots) {
    assertTypedOptionalRunRecord(record, sessions, runs, 'usage snapshot');
    requireTimestamp(record.observedAt);
    assertTokenUsage(record.total);
    assertTokenUsage(record.last);
    if (
      record.modelContextWindow !== undefined &&
      (!Number.isSafeInteger(record.modelContextWindow) || record.modelContextWindow < 1)
    ) {
      throw new Error('Agent runtime usage context window is invalid.');
    }
    assertProtocolReferenceShape(record.rawMessage);
  }
}

function validateSettingsObservations(
  state: AgentRuntimeStoreState,
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>
): void {
  uniqueIds(state.settingsObservations, 'settings observations');
  for (const record of state.settingsObservations) {
    const session = assertTypedOptionalRunRecord(
      record,
      sessions,
      runs,
      'settings observation'
    );
    requireTimestamp(record.observedAt);
    if (record.settings.runtimeId !== session.runtimeId || !record.source) {
      throw new Error('Agent runtime settings observation is invalid.');
    }
    assertTelemetryPayload(record.settings);
    if (record.rawMessage) assertProtocolReferenceShape(record.rawMessage);
  }
}

function validateSubagentObservations(
  state: AgentRuntimeStoreState,
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>
): void {
  uniqueIds(state.subagentObservations, 'subagent observations');
  for (const record of state.subagentObservations) {
    const child = assertTypedSessionRecord(record, sessions, 'subagent observation');
    const parent = sessions.get(record.parentSessionId);
    if (
      !parent ||
      agentOwnerScopeKey(parent.owner) !== agentOwnerScopeKey(record.owner) ||
      parent.runtimeId !== child.runtimeId ||
      !record.providerChildSessionId ||
      !record.source ||
      !record.relationshipState
    ) {
      throw new Error('Agent runtime subagent observation metadata is invalid.');
    }
    if (record.parentRunId) {
      const run = runs.get(record.parentRunId);
      if (!run || run.sessionId !== parent.id) {
        throw new Error('Agent runtime subagent parent run is invalid.');
      }
    }
    requireTimestamp(record.observedAt);
    assertProtocolReferenceShape(record.rawMessage);
  }
}

function assertTypedRunRecord(
  record: {
    id: string;
    owner: AgentOwnerScope;
    sessionId: string;
    runId: string;
    clientOperationId: string;
    requestFingerprint: string;
    recordRevision: number;
  },
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>,
  label: string
): { session: AgentRuntimeSessionRecord; run: AgentRuntimeRunRecord } {
  const session = assertTypedSessionRecord(record, sessions, label);
  const run = runs.get(record.runId);
  if (
    !run ||
    run.sessionId !== session.id ||
    agentOwnerScopeKey(run.owner) !== agentOwnerScopeKey(record.owner)
  ) {
    throw new Error(`Agent runtime ${label} run ownership is invalid.`);
  }
  return { session, run };
}

function assertTypedOptionalRunRecord(
  record: {
    id: string;
    owner: AgentOwnerScope;
    sessionId: string;
    runId?: string;
    clientOperationId: string;
    requestFingerprint: string;
    recordRevision: number;
  },
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>,
  label: string
): AgentRuntimeSessionRecord {
  const session = assertTypedSessionRecord(record, sessions, label);
  if (record.runId) {
    const run = runs.get(record.runId);
    if (!run || run.sessionId !== session.id) {
      throw new Error(`Agent runtime ${label} run ownership is invalid.`);
    }
  }
  return session;
}

function assertTypedSessionRecord(
  record: {
    id: string;
    owner: AgentOwnerScope;
    sessionId: string;
    clientOperationId: string;
    requestFingerprint: string;
    recordRevision: number;
  },
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  label: string
): AgentRuntimeSessionRecord {
  requireSafeId(record.id, `${label} id`);
  assertAgentOwnerScope(record.owner);
  requireOperationId(record.clientOperationId);
  requireRevision(record.recordRevision);
  if (!HASH.test(record.requestFingerprint)) {
    throw new Error(`Agent runtime ${label} request fingerprint is invalid.`);
  }
  const session = sessions.get(record.sessionId);
  if (
    !session ||
    agentOwnerScopeKey(session.owner) !== agentOwnerScopeKey(record.owner)
  ) {
    throw new Error(`Agent runtime ${label} session ownership is invalid.`);
  }
  return session;
}

function projectTaskRuntimeSnapshot(
  state: AgentRuntimeStoreState,
  artifactsDir: string
): TaskAgentRuntimeSnapshot {
  const sessions = state.sessions.filter(
    (session): session is AgentRuntimeSessionRecord & {
      owner: Extract<AgentOwnerScope, { kind: 'TASK' }>;
    } => session.owner.kind === 'TASK'
  );
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const runs = state.runs.filter(
    (run): run is AgentRuntimeRunRecord & {
      owner: Extract<AgentOwnerScope, { kind: 'TASK' }>;
    } => run.owner.kind === 'TASK'
  );
  const runById = new Map(runs.map((run) => [run.id, run]));
  return {
    runs: [...runs].reverse().map((run) => projectTaskRun(run, state)),
    agentServers: clone(state.servers),
    agentSessions: sessions.map(projectTaskSession),
    agentItems: state.items
      .filter((record) => record.owner.kind === 'TASK')
      .map((record) => projectTaskItem(record, requireMappedRun(runById, record.runId))),
    agentGoalSnapshots: [...state.goalSnapshots]
      .reverse()
      .filter((record) => record.owner.kind === 'TASK')
      .map((record) => projectTaskGoal(record, requireMappedSession(sessionById, record.sessionId))),
    agentPlanRevisions: [...state.planRevisions]
      .reverse()
      .filter((record) => record.owner.kind === 'TASK')
      .map((record) => projectTaskPlan(record, requireMappedRun(runById, record.runId))),
    agentUsageSnapshots: [...state.usageSnapshots]
      .reverse()
      .filter((record) => record.owner.kind === 'TASK')
      .map((record) => projectTaskUsage(record, requireMappedSession(sessionById, record.sessionId))),
    agentSettingsObservations: [...state.settingsObservations]
      .reverse()
      .filter((record) => record.owner.kind === 'TASK')
      .map((record) => projectTaskSettings(record, requireMappedSession(sessionById, record.sessionId))),
    agentSubagentObservations: [...state.subagentObservations]
      .reverse()
      .filter((record) => record.owner.kind === 'TASK')
      .map((record) => projectTaskSubagent(record, requireMappedSession(sessionById, record.sessionId))),
    interactionRequests: state.interactions
      .filter((record) => record.owner.kind === 'TASK')
      .map((record) => projectTaskInteraction(record, state)),
    artifacts: state.artifacts
      .filter(
        (artifact): artifact is AgentRuntimeArtifactRecord & {
          owner: Extract<AgentOwnerScope, { kind: 'TASK' }>;
        } => artifact.owner.kind === 'TASK'
      )
      .map((artifact) => projectTaskArtifact(artifact, artifactsDir))
  };
}

function projectTaskSession(session: AgentRuntimeSessionRecord): AgentSessionRecord {
  if (session.owner.kind !== 'TASK' || !session.taskContext) {
    throw new Error('Cannot project a non-Task runtime session as a Task session.');
  }
  return {
    id: session.id,
    taskId: session.owner.taskId,
    iterationId: session.taskContext.iterationId,
    worktreeId: session.taskContext.worktreeId,
    runtimeId: session.runtimeId,
    role: session.role,
    providerSessionId: session.providerSessionId,
    providerSessionTreeId: session.providerSessionTreeId,
    parentSessionId: session.parentSessionId,
    forkedFromSessionId: session.forkedFromSessionId,
    providerParentSessionId: session.providerParentSessionId,
    providerForkedFromSessionId: session.providerForkedFromSessionId,
    parentRunId: session.parentRunId,
    relationshipState: session.relationshipState,
    relationshipDetail: session.relationshipDetail,
    providerNickname: session.providerNickname,
    providerRole: session.providerRole,
    delegatedPrompt: session.delegatedPrompt,
    agentPath: session.agentPath,
    subagentStatus: session.subagentStatus,
    worktreePath: session.taskContext.worktreePath,
    status: session.status,
    materialized: session.materialized,
    requestedSettings: clone(session.requestedSettings),
    observedSettings: clone(session.observedSettings),
    ownership: 'TASK_MONKI',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastAttachedAt: session.lastAttachedAt
  };
}

function projectTaskRun(
  run: AgentRuntimeRunRecord,
  state: AgentRuntimeStoreState
): RunRecord {
  if (run.owner.kind !== 'TASK' || run.scope.kind !== 'TASK') {
    throw new Error('Cannot project a non-Task runtime run as a Task run.');
  }
  const session = requireSession(state, run.sessionId);
  const source = run.providerTerminalSource;
  return {
    id: run.id,
    runtimeId: session.runtimeId,
    taskId: run.owner.taskId,
    iterationId: run.scope.iterationId,
    worktreeId: run.scope.worktreeId,
    sessionId: run.sessionId,
    serverInstanceId: run.serverInstanceId,
    providerTurnId: run.providerTurnId,
    mode: taskModeFromPurpose(run.purpose),
    origin: run.purpose === 'PROVIDER_SUBAGENT' ? 'PROVIDER_SUBAGENT' : 'TASK_MONKI',
    parentRunId: run.parentRunId,
    generationKey: run.generationKey,
    retryOfRunId: run.taskDetails?.retryOfRunId,
    continuedFromRunId: run.taskDetails?.continuedFromRunId,
    status: run.status,
    recoveryState: run.recoveryState,
    requestedSettings: clone(run.requestedSettings),
    observedSettings: clone(run.observedSettings),
    promptArtifactId: run.promptArtifactId,
    outputArtifactId: run.outputArtifactId,
    diagnosticArtifactId: run.diagnosticArtifactId,
    beforeGitSnapshotId: run.taskDetails?.beforeGitSnapshotId,
    afterGitSnapshotId: run.taskDetails?.afterGitSnapshotId,
    terminalReason: run.terminalReason,
    providerTerminalSource:
      source === 'TURN_COMPLETED_NOTIFICATION' ||
      source === 'RECOVERY_RESUME_RESPONSE'
        ? source
        : undefined,
    providerTerminalRawMessage: clone(run.providerTerminalRawMessage),
    startedAt: run.startedAt ?? run.createdAt,
    lastEventAt: run.lastEventAt,
    endedAt: run.endedAt,
    finalArtifactId: run.finalArtifactId,
    eventCount: run.taskDetails?.eventCount ?? 0,
    lastEventType: run.taskDetails?.lastEventType,
    finalMessage: run.taskDetails?.finalMessage,
    attachmentSelection: clone(run.attachmentSelection),
    attachmentSubmissions: clone(run.attachmentSubmissions)
  };
}

function projectTaskItem(
  record: AgentRuntimeItemRecord,
  run: AgentRuntimeRunRecord
): AgentItemRecord {
  if (run.scope.kind !== 'TASK') throw new Error('Task item has a non-Task run.');
  return {
    id: record.id,
    taskId: run.scope.taskId,
    iterationId: run.scope.iterationId,
    runId: record.runId,
    sessionId: record.sessionId,
    providerItemId: record.providerItemId,
    type: record.type,
    status: record.status,
    payload: clone(record.payload),
    rawMessage: clone(record.rawMessage),
    outputArtifactId: record.outputArtifactId,
    providerStartedAt: record.providerStartedAt,
    providerCompletedAt: record.providerCompletedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function projectTaskInteraction(
  record: AgentRuntimeInteractionRecord,
  state: AgentRuntimeStoreState
): InteractionRequestRecord {
  const run = requireRun(state, record.runId);
  const session = requireSession(state, record.sessionId);
  if (run.scope.kind !== 'TASK' || record.owner.kind !== 'TASK') {
    throw new Error('Task interaction has a non-Task owner.');
  }
  return {
    id: record.id,
    runtimeId: session.runtimeId,
    serverInstanceId: record.serverInstanceId,
    providerRequestId: record.providerRequestId,
    taskId: record.owner.taskId,
    iterationId: run.scope.iterationId,
    runId: record.runId,
    sessionId: record.sessionId,
    providerTurnId: record.providerTurnId,
    providerItemId: record.providerItemId,
    type: record.type,
    status: record.status,
    request: clone(record.request),
    allowedActions: clone(record.allowedActions),
    policyWarnings: [...record.policyWarnings],
    requestRawMessage: clone(record.requestRawMessage),
    decision: clone(record.decision),
    responseRawMessage: clone(record.responseRawMessage),
    resolution: clone(record.resolution),
    requestedAt: record.requestedAt,
    respondedAt: record.respondedAt,
    resolvedAt: record.resolvedAt
  };
}

function taskObservationIdentity(
  session: AgentRuntimeSessionRecord
): { taskId: string; iterationId: string; runtimeId: string } {
  if (session.owner.kind !== 'TASK' || !session.taskContext) {
    throw new Error('Task observation has a non-Task session.');
  }
  return {
    taskId: session.owner.taskId,
    iterationId: session.taskContext.iterationId,
    runtimeId: session.runtimeId
  };
}

function projectTaskGoal(
  record: AgentRuntimeGoalSnapshotRecord,
  session: AgentRuntimeSessionRecord
): AgentGoalSnapshotRecord {
  const identity = taskObservationIdentity(session);
  const { owner: _owner, clientOperationId: _operation, requestFingerprint: _fingerprint, recordRevision: _revision, ...value } = record;
  return { ...clone(value), ...identity };
}

function projectTaskPlan(
  record: AgentRuntimePlanRevisionRecord,
  run: AgentRuntimeRunRecord
): AgentPlanRevisionRecord {
  const session = run.scope.kind === 'TASK'
    ? { taskId: run.scope.taskId, iterationId: run.scope.iterationId }
    : undefined;
  if (!session) throw new Error('Task plan has a non-Task run.');
  const { owner: _owner, clientOperationId: _operation, requestFingerprint: _fingerprint, recordRevision: _recordRevision, ...value } = record;
  return { ...clone(value), ...session, runtimeId: run.requestedSettings.runtimeId! };
}

function projectTaskUsage(
  record: AgentRuntimeUsageSnapshotRecord,
  session: AgentRuntimeSessionRecord
): AgentUsageSnapshotRecord {
  const identity = taskObservationIdentity(session);
  const { owner: _owner, clientOperationId: _operation, requestFingerprint: _fingerprint, recordRevision: _revision, ...value } = record;
  return { ...clone(value), ...identity };
}

function projectTaskSettings(
  record: AgentRuntimeSettingsObservationRecord,
  session: AgentRuntimeSessionRecord
): AgentSettingsObservationRecord {
  const identity = taskObservationIdentity(session);
  const { owner: _owner, clientOperationId: _operation, requestFingerprint: _fingerprint, recordRevision: _revision, ...value } = record;
  return { ...clone(value), ...identity };
}

function projectTaskSubagent(
  record: AgentRuntimeSubagentObservationRecord,
  session: AgentRuntimeSessionRecord
): AgentSubagentObservationRecord {
  const identity = taskObservationIdentity(session);
  const { owner: _owner, clientOperationId: _operation, requestFingerprint: _fingerprint, recordRevision: _revision, ...value } = record;
  return { ...clone(value), ...identity };
}

function projectTaskArtifact(
  artifact: AgentRuntimeArtifactRecord & {
    owner: Extract<AgentOwnerScope, { kind: 'TASK' }>;
  },
  artifactsDir: string
): ArtifactRecord {
  const kind: ArtifactRecord['kind'] =
    artifact.kind === 'PROMPT'
      ? 'agent-prompt'
      : artifact.kind === 'OUTPUT'
        ? 'agent-output'
        : artifact.kind === 'DIAGNOSTIC'
          ? 'agent-diagnostics'
          : 'agent-final';
  return {
    id: artifact.id,
    taskId: artifact.owner.taskId,
    runId: artifact.runId,
    kind,
    path: path.join(artifactsDir, artifact.storageKey),
    byteCount: artifact.byteCount,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt
  };
}

function runtimeSessionUpdate(
  update: Partial<AgentSessionRecord>
): Parameters<AgentRuntimeStore['updateSession']>[2] {
  const result: Record<string, unknown> = {};
  const keys = [
    'providerSessionId', 'providerSessionTreeId', 'parentSessionId',
    'forkedFromSessionId', 'providerParentSessionId',
    'providerForkedFromSessionId', 'parentRunId', 'status', 'materialized',
    'requestedSettings', 'observedSettings', 'relationshipState',
    'relationshipDetail', 'providerNickname', 'providerRole', 'delegatedPrompt',
    'agentPath', 'subagentStatus', 'lastAttachedAt'
  ] as const;
  for (const key of keys) if (key in update) result[key] = clone(update[key]);
  return result as Parameters<AgentRuntimeStore['updateSession']>[2];
}

function runtimeRunUpdate(
  existing: AgentRuntimeRunRecord,
  update: Partial<RunRecord>,
  occurredAt: string
): RuntimeRunUpdate {
  const result: RuntimeRunUpdate = {};
  for (const key of [
    'serverInstanceId', 'providerTurnId', 'status', 'recoveryState',
    'observedSettings', 'terminalReason', 'providerTerminalSource',
    'finalArtifactId', 'lastEventAt', 'endedAt', 'attachmentSubmissions',
    'providerTerminalRawMessage'
  ] as const) {
    if (key in update) (result as Record<string, unknown>)[key] = clone(update[key]);
  }
  const taskDetails = { ...(existing.taskDetails ?? { eventCount: 0 }) };
  let taskDetailsChanged = false;
  for (const [taskKey, runtimeKey] of [
    ['retryOfRunId', 'retryOfRunId'],
    ['continuedFromRunId', 'continuedFromRunId'],
    ['beforeGitSnapshotId', 'beforeGitSnapshotId'],
    ['afterGitSnapshotId', 'afterGitSnapshotId'],
    ['eventCount', 'eventCount'],
    ['lastEventType', 'lastEventType'],
    ['finalMessage', 'finalMessage']
  ] as const) {
    if (taskKey in update) {
      (taskDetails as Record<string, unknown>)[runtimeKey] = clone(update[taskKey]);
      taskDetailsChanged = true;
    }
  }
  if (taskDetailsChanged) result.taskDetails = taskDetails;
  const status = update.status ?? existing.status;
  const providerTurnId =
    'providerTurnId' in update ? update.providerTurnId : existing.providerTurnId;
  if (status === 'STARTING') {
    result.delivery = 'SENDING';
    result.startedAt = existing.startedAt ?? occurredAt;
  } else if (
    status === 'RUNNING' ||
    status === 'AWAITING_APPROVAL' ||
    status === 'AWAITING_USER_INPUT'
  ) {
    result.delivery = 'ACKNOWLEDGED';
    result.startedAt = existing.startedAt ?? occurredAt;
  } else if (status === 'INTERRUPTING') {
    result.delivery = 'ACKNOWLEDGED';
    result.interruptDelivery = existing.interruptDelivery ?? 'SENDING';
    result.stopRequestedAt = existing.stopRequestedAt ?? occurredAt;
  } else if (status === 'RECOVERY_REQUIRED') {
    if (existing.delivery === 'SENDING') {
      result.delivery = 'AMBIGUOUS';
    } else if (existing.delivery === 'NOT_SENT') {
      result.delivery = 'NOT_DELIVERED';
    } else {
      result.delivery = existing.delivery;
    }
  } else if (isTerminalRuntimeStatus(status)) {
    result.delivery = providerTurnId ? 'TERMINAL' : 'NOT_DELIVERED';
    result.endedAt = update.endedAt ?? occurredAt;
    if (existing.interruptDelivery) result.interruptDelivery = 'TERMINAL';
  }
  return result;
}

function taskPurposeFromMode(mode: AgentRunMode): AgentRuntimeRunRecord['purpose'] {
  switch (mode) {
    case 'ANALYSIS': return 'TASK_ANALYSIS';
    case 'IMPLEMENTATION': return 'TASK_IMPLEMENTATION';
    case 'FOLLOW_UP': return 'TASK_FOLLOW_UP';
    case 'RETRY': return 'TASK_RETRY';
    case 'REVIEW': return 'TASK_REVIEW';
    case 'DESIGN': return 'TASK_DESIGN';
    case 'COMPACTION': return 'TASK_COMPACTION';
    case 'SUBAGENT': return 'PROVIDER_SUBAGENT';
  }
}

function taskModeFromPurpose(
  purpose: AgentRuntimeRunRecord['purpose']
): AgentRunMode {
  switch (purpose) {
    case 'TASK_ANALYSIS': return 'ANALYSIS';
    case 'TASK_IMPLEMENTATION': return 'IMPLEMENTATION';
    case 'TASK_FOLLOW_UP': return 'FOLLOW_UP';
    case 'TASK_RETRY': return 'RETRY';
    case 'TASK_REVIEW': return 'REVIEW';
    case 'TASK_DESIGN': return 'DESIGN';
    case 'TASK_COMPACTION': return 'COMPACTION';
    case 'PROVIDER_SUBAGENT': return 'SUBAGENT';
    default: throw new Error(`Cannot project Discourse purpose ${purpose} as a Task run.`);
  }
}

function requireMappedSession(
  sessions: ReadonlyMap<string, AgentRuntimeSessionRecord>,
  id: string
): AgentRuntimeSessionRecord {
  const session = sessions.get(id);
  if (!session) throw new Error(`Task runtime session projection is missing: ${id}`);
  return session;
}

function requireMappedRun(
  runs: ReadonlyMap<string, AgentRuntimeRunRecord>,
  id: string
): AgentRuntimeRunRecord {
  const run = runs.get(id);
  if (!run) throw new Error(`Task runtime run projection is missing: ${id}`);
  return run;
}

function assertProjectedItemOwnership(
  item: Pick<AgentItemRecord, 'taskId' | 'iterationId' | 'sessionId'>,
  run: AgentRuntimeRunRecord
): void {
  if (
    run.scope.kind !== 'TASK' ||
    item.taskId !== run.scope.taskId ||
    item.iterationId !== run.scope.iterationId ||
    item.sessionId !== run.sessionId
  ) throw new Error('Task item ownership does not match its canonical run.');
}

function assertProjectedInteractionOwnership(
  input: Pick<InteractionRequestRecord, 'taskId' | 'iterationId' | 'sessionId'>,
  run: AgentRuntimeRunRecord
): void {
  assertProjectedItemOwnership(input, run);
}

function assertProjectedSessionObservation(
  record: { taskId: string; iterationId: string; runtimeId: string },
  session: AgentRuntimeSessionRecord
): void {
  const identity = taskObservationIdentity(session);
  if (
    record.taskId !== identity.taskId ||
    record.iterationId !== identity.iterationId ||
    record.runtimeId !== identity.runtimeId
  ) throw new Error('Task observation ownership does not match its canonical session.');
}

function assertProjectedRunObservation(
  record: { taskId: string; iterationId: string; sessionId: string; runtimeId: string },
  run: AgentRuntimeRunRecord
): void {
  if (run.scope.kind !== 'TASK') throw new Error('Task observation run is invalid.');
  if (
    record.taskId !== run.scope.taskId ||
    record.iterationId !== run.scope.iterationId ||
    record.sessionId !== run.sessionId ||
    record.runtimeId !== run.requestedSettings.runtimeId
  ) throw new Error('Task observation ownership does not match its canonical run.');
}

function assertProjectedSessionIdentity(
  projected: AgentSessionRecord,
  session: AgentRuntimeSessionRecord
): void {
  const actual = projectTaskSession(session);
  if (
    projected.id !== actual.id || projected.taskId !== actual.taskId ||
    projected.iterationId !== actual.iterationId ||
    projected.worktreeId !== actual.worktreeId || projected.runtimeId !== actual.runtimeId
  ) throw new Error('Projected Task session identity is inconsistent.');
}

function derivedOperationId(operationId: string, part: string): string {
  return `runtime-${crypto.createHash('sha256').update(`${operationId}:${part}`).digest('hex')}`;
}

function translateArtifactMutationError(cause: unknown): unknown {
  return cause instanceof AgentRuntimeStorePublishedError
    ? new AgentRuntimeArtifactMutationAmbiguousError(
        'Agent runtime artifact bytes may have been published before durable sync failed.',
        { cause }
      )
    : cause;
}

function isActiveRuntimeStatus(status: AgentRuntimeRunRecord['status']): boolean {
  return [
    'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT',
    'INTERRUPTING'
  ].includes(status);
}

function isActiveInteractionStatus(
  status: AgentRuntimeInteractionRecord['status']
): boolean {
  return status === 'PENDING' || status === 'RESPONDING';
}

function isItemStatus(value: unknown): value is AgentRuntimeItemRecord['status'] {
  return [
    'STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'DECLINED',
    'INTERRUPTED', 'UNKNOWN'
  ].includes(value as AgentRuntimeItemRecord['status']);
}

function isItemType(value: unknown): value is AgentRuntimeItemRecord['type'] {
  return [
    'USER_MESSAGE', 'AGENT_MESSAGE', 'REASONING_SUMMARY', 'PLAN',
    'COMMAND_EXECUTION', 'FILE_CHANGE', 'MCP_TOOL_CALL', 'DYNAMIC_TOOL_CALL',
    'WEB_SEARCH', 'CONTEXT_COMPACTION', 'REVIEW', 'SUBAGENT', 'OTHER'
  ].includes(value as AgentRuntimeItemRecord['type']);
}

function isInteractionStatus(
  value: unknown
): value is AgentRuntimeInteractionRecord['status'] {
  return [
    'PENDING', 'RESPONDING', 'RESOLVED', 'DECLINED', 'CANCELED',
    'ABORTED_SERVER_LOST', 'STALE'
  ].includes(value as AgentRuntimeInteractionRecord['status']);
}

function isInteractionType(
  value: unknown
): value is AgentRuntimeInteractionRecord['type'] {
  return [
    'COMMAND_APPROVAL', 'FILE_CHANGE_APPROVAL', 'PERMISSION_APPROVAL',
    'MCP_ELICITATION', 'USER_INPUT', 'DYNAMIC_TOOL'
  ].includes(value as AgentRuntimeInteractionRecord['type']);
}

function validateItemTransition(
  current: AgentRuntimeItemRecord['status'],
  next: AgentRuntimeItemRecord['status']
): void {
  if (current === next) return;
  const allowed: Record<AgentRuntimeItemRecord['status'], AgentRuntimeItemRecord['status'][]> = {
    STARTED: ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED', 'UNKNOWN'],
    IN_PROGRESS: ['COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED', 'UNKNOWN'],
    COMPLETED: [], FAILED: [], DECLINED: [], INTERRUPTED: [],
    UNKNOWN: ['STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED']
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid agent runtime item transition: ${current} -> ${next}`);
  }
}

function validateInteractionTransition(
  current: AgentRuntimeInteractionRecord['status'],
  next: AgentRuntimeInteractionRecord['status']
): void {
  if (current === next) return;
  const allowed: Record<AgentRuntimeInteractionRecord['status'], AgentRuntimeInteractionRecord['status'][]> = {
    PENDING: ['RESPONDING', 'DECLINED', 'CANCELED', 'ABORTED_SERVER_LOST', 'STALE'],
    RESPONDING: ['PENDING', 'RESOLVED', 'DECLINED', 'CANCELED', 'ABORTED_SERVER_LOST', 'STALE'],
    RESOLVED: [], DECLINED: [], CANCELED: [], ABORTED_SERVER_LOST: [], STALE: []
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid agent runtime interaction transition: ${current} -> ${next}`);
  }
}

function assertProtocolReferenceShape(reference: AgentProtocolMessageReference): void {
  requireSafeId(reference.serverInstanceId, 'protocol server id');
  requireTimestamp(reference.recordedAt);
  if (
    !Number.isSafeInteger(reference.sequence) || reference.sequence < 1 ||
    !Number.isSafeInteger(reference.byteOffset) || reference.byteOffset < 0 ||
    !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 1 ||
    (reference.segment !== undefined &&
      (!Number.isSafeInteger(reference.segment) || reference.segment < 0)) ||
    !['INBOUND', 'OUTBOUND'].includes(reference.direction) ||
    !HASH.test(reference.sha256)
  ) throw new Error('Agent runtime protocol reference is invalid.');
}

function assertProtocolReference(
  state: AgentRuntimeStoreState,
  reference: AgentProtocolMessageReference,
  run: AgentRuntimeRunRecord | undefined,
  expectedServerId: string | undefined,
  label: string,
  session?: AgentRuntimeSessionRecord
): void {
  assertProtocolReferenceShape(reference);
  const server = state.servers.find(
    (candidate) => candidate.id === reference.serverInstanceId
  );
  const ownerSession = session ?? (run ? requireSession(state, run.sessionId) : undefined);
  if (
    !server ||
    (expectedServerId !== undefined && reference.serverInstanceId !== expectedServerId) ||
    (run?.serverInstanceId !== undefined &&
      reference.serverInstanceId !== run.serverInstanceId) ||
    (ownerSession && server.runtimeId !== ownerSession.runtimeId)
  ) throw new Error(`Agent runtime ${label} protocol ownership is invalid.`);
}

function assertOptionalProtocolReference(
  state: AgentRuntimeStoreState,
  reference: AgentProtocolMessageReference | undefined,
  run: AgentRuntimeRunRecord | undefined,
  label: string,
  expectedServerId?: string,
  session?: AgentRuntimeSessionRecord
): void {
  if (reference) {
    assertProtocolReference(state, reference, run, expectedServerId, label, session);
  }
}

function assertTokenUsage(value: import('../../shared/agent').AgentTokenUsageBreakdown): void {
  for (const count of Object.values(value)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Agent runtime token usage is invalid.');
    }
  }
}

function assertAttachmentSelection(
  selection: readonly AgentRuntimeRunRecord['attachmentSelection'][number][]
): void {
  if (
    !Array.isArray(selection) ||
    selection.length > AGENT_RUNTIME_LIMITS.maxManagedAttachments
  ) {
    throw new Error('Agent runtime attachment selection is invalid.');
  }
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const attachment of selection) {
    if (
      !SAFE_ID.test(attachment.attachmentId) ||
      ids.has(attachment.attachmentId) ||
      !Number.isSafeInteger(attachment.ordinal) ||
      attachment.ordinal < 0 ||
      ordinals.has(attachment.ordinal) ||
      !['image', 'text'].includes(attachment.kind) ||
      !attachment.mediaType ||
      Buffer.byteLength(attachment.mediaType, 'utf8') > 512 ||
      !Number.isSafeInteger(attachment.byteCount) ||
      attachment.byteCount < 0 ||
      !HASH.test(attachment.sha256)
    ) {
      throw new Error('Agent runtime attachment selection is invalid.');
    }
    ids.add(attachment.attachmentId);
    ordinals.add(attachment.ordinal);
  }
}

function assertAttachmentSubmissions(
  submissions: readonly NonNullable<AgentRuntimeRunRecord['attachmentSubmissions']>[number][],
  selection: readonly AgentRuntimeRunRecord['attachmentSelection'][number][],
  providerTurnId: string | undefined
): void {
  if (submissions.length !== selection.length) {
    throw new Error('Agent runtime attachment submission evidence is incomplete.');
  }
  for (const [index, submission] of submissions.entries()) {
    const selected = selection[index];
    requireTimestamp(submission.verifiedAt);
    requireTimestamp(submission.submittedAt);
    if (
      !selected ||
      submission.attachmentId !== selected.attachmentId ||
      submission.ordinal !== selected.ordinal ||
      submission.kind !== selected.kind ||
      submission.mediaType !== selected.mediaType ||
      submission.byteCount !== selected.byteCount ||
      submission.sha256 !== selected.sha256 ||
      !ATTACHMENT_TRANSPORTS.has(submission.transport) ||
      !ATTACHMENT_CORRELATION_KINDS.has(submission.correlation.kind) ||
      !submission.correlation.id ||
      Buffer.byteLength(submission.correlation.id, 'utf8') >
        AGENT_RUNTIME_LIMITS.maxOwnerIdBytes ||
      (submission.correlation.kind === 'provider-turn' &&
        providerTurnId !== undefined &&
        submission.correlation.id !== providerTurnId)
    ) {
      throw new Error('Agent runtime attachment submission evidence is invalid.');
    }
  }
}

function replayImmutableRecord<T extends {
  owner: AgentOwnerScope;
  clientOperationId: string;
  requestFingerprint: string;
}>(
  records: readonly T[],
  owner: AgentOwnerScope,
  operationId: string,
  fingerprint: string,
  label: string
): T | undefined {
  requireOperationId(operationId);
  const record = records.find(
    (candidate) =>
      agentOwnerScopeKey(candidate.owner) === agentOwnerScopeKey(owner) &&
      candidate.clientOperationId === operationId
  );
  if (!record) return undefined;
  if (record.requestFingerprint !== fingerprint) {
    throw new Error(`Agent runtime ${label} operation conflicts with its durable request.`);
  }
  return record;
}

function immutableObservation<T extends object>(
  input: T,
  id: string,
  fingerprint: string,
  observedAt: string
): T & {
  id: string;
  requestFingerprint: string;
  recordRevision: number;
  observedAt: string;
} {
  requireSafeId(id, 'observation id');
  return {
    ...clone(input), id, requestFingerprint: fingerprint, recordRevision: 1, observedAt
  };
}

function appendTypedRecordEvent(
  draft: AgentRuntimeStoreState,
  createId: () => string,
  record: {
    id: string; owner: AgentOwnerScope; sessionId: string; runId?: string;
    clientOperationId: string; requestFingerprint: string; observedAt: string;
  },
  type: Extract<AgentRuntimeEventRecord['type'],
    'GOAL_RECORDED' | 'PLAN_RECORDED' | 'USAGE_RECORDED' | 'SETTINGS_RECORDED' | 'SUBAGENT_RECORDED'>
): void {
  appendEvent(draft, createId, record.observedAt, {
    type, owner: record.owner, sessionId: record.sessionId, runId: record.runId,
    operationId: record.clientOperationId,
    payload: { recordId: record.id, requestFingerprint: record.requestFingerprint }
  });
}

function purgeTypedRecords(
  draft: AgentRuntimeStoreState,
  sessionIds: ReadonlySet<string>,
  runIds: ReadonlySet<string>,
  ownsOwner: (owner: AgentOwnerScope | undefined) => boolean
): void {
  draft.items = draft.items.filter((record) =>
    !ownsOwner(record.owner) && !sessionIds.has(record.sessionId) && !runIds.has(record.runId));
  draft.interactions = draft.interactions.filter((record) =>
    !ownsOwner(record.owner) && !sessionIds.has(record.sessionId) && !runIds.has(record.runId));
  draft.goalSnapshots = draft.goalSnapshots.filter((record) =>
    !ownsOwner(record.owner) && !sessionIds.has(record.sessionId));
  draft.planRevisions = draft.planRevisions.filter((record) =>
    !ownsOwner(record.owner) && !sessionIds.has(record.sessionId) && !runIds.has(record.runId));
  draft.usageSnapshots = draft.usageSnapshots.filter((record) =>
    !ownsOwner(record.owner) && !sessionIds.has(record.sessionId) &&
    !(record.runId && runIds.has(record.runId)));
  draft.settingsObservations = draft.settingsObservations.filter((record) =>
    !ownsOwner(record.owner) && !sessionIds.has(record.sessionId) &&
    !(record.runId && runIds.has(record.runId)));
  draft.subagentObservations = draft.subagentObservations.filter((record) =>
    !ownsOwner(record.owner) && !sessionIds.has(record.sessionId) &&
    !sessionIds.has(record.parentSessionId) &&
    !(record.parentRunId && runIds.has(record.parentRunId)));
}

function assertAgentServer(server: AgentServerInstance): void {
  requireSafeId(server.id, 'server id');
  requireTimestamp(server.startedAt);
  for (const timestamp of [
    server.initializedAt,
    server.lastHealthAt,
    server.disconnectedAt,
    server.exitedAt
  ]) {
    if (timestamp !== undefined) requireTimestamp(timestamp);
  }
  if (
    !server.runtimeId ||
    !server.runtimeKind ||
    !server.transport ||
    !SERVER_STATUSES.has(server.status) ||
    !server.executable ||
    Buffer.byteLength(server.executable, 'utf8') >
      AGENT_RUNTIME_LIMITS.maxPrimaryCwdBytes ||
    !Array.isArray(server.argv) ||
    server.argv.length > 256 ||
    server.argv.some(
      (argument) =>
        typeof argument !== 'string' ||
        Buffer.byteLength(argument, 'utf8') >
          AGENT_RUNTIME_LIMITS.maxPrimaryCwdBytes
    ) ||
    !path.isAbsolute(server.protocolJournalPath) ||
    path.basename(server.protocolJournalPath) !== `${server.id}.ndjson` ||
    (server.pid !== undefined &&
      (!Number.isSafeInteger(server.pid) || server.pid < 1))
  ) {
    throw new Error('Agent runtime server metadata is invalid.');
  }
  if (server.runtimeResolution) assertTelemetryPayload(server.runtimeResolution);
}

function uniqueIds(records: readonly { id: string }[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.id || ids.has(record.id)) {
      throw new Error(`Agent runtime ${label} contain an invalid or duplicate id.`);
    }
    ids.add(record.id);
  }
  return ids;
}

function requireSession(state: AgentRuntimeStoreState, sessionId: string): AgentRuntimeSessionRecord {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Agent runtime session not found: ${sessionId}`);
  return session;
}

function requireOwnedSession(
  state: AgentRuntimeStoreState,
  owner: AgentOwnerScope,
  sessionId: string
): AgentRuntimeSessionRecord {
  const session = requireSession(state, sessionId);
  if (agentOwnerScopeKey(session.owner) !== agentOwnerScopeKey(owner)) {
    throw new Error('Agent runtime record does not match its session owner.');
  }
  return session;
}

function replaceSession(
  state: AgentRuntimeStoreState,
  session: AgentRuntimeSessionRecord
): void {
  const index = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (index < 0) throw new Error(`Agent runtime session not found: ${session.id}`);
  state.sessions[index] = session;
}

function assertExecutionContextMatchesEpoch(
  session: Pick<
    AgentRuntimeSessionRecord,
    | 'id'
    | 'owner'
    | 'runtimeId'
    | 'requestedSettings'
    | 'executionContext'
    | 'accessEpoch'
    | 'parentSessionId'
  >
): void {
  const inheritedModel =
    session.executionContext.attestation.status === 'INHERITED_UNATTESTED' &&
    session.parentSessionId ===
      session.executionContext.attestation.parentSessionId
      ? session.accessEpoch.model
      : undefined;
  const model = session.requestedSettings.model ?? inheritedModel;
  if (!model) throw new Error('Agent runtime session requires a resolved model.');
  const expected = createAgentSessionAccessEpoch({
    owner: session.owner,
    sessionId: session.id,
    epoch: session.accessEpoch.epoch,
    runtimeId: session.runtimeId,
    model,
    executionContext: session.executionContext,
    createdAt: session.accessEpoch.createdAt
  });
  if (expected.executionProfileHash !== session.accessEpoch.executionProfileHash) {
    throw new Error('Agent runtime execution context does not match its access epoch.');
  }
}

function requireRun(state: AgentRuntimeStoreState, runId: string): AgentRuntimeRunRecord {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Agent runtime run not found: ${runId}`);
  return run;
}

function requireOwnedRun(
  state: AgentRuntimeStoreState,
  owner: AgentOwnerScope,
  runId: string,
  sessionId: string
): AgentRuntimeRunRecord {
  const run = requireRun(state, runId);
  if (
    run.sessionId !== sessionId ||
    agentOwnerScopeKey(run.owner) !== agentOwnerScopeKey(owner)
  ) {
    throw new Error('Agent runtime record does not match its run owner.');
  }
  return run;
}

function replaceRun(state: AgentRuntimeStoreState, run: AgentRuntimeRunRecord): void {
  const index = state.runs.findIndex((candidate) => candidate.id === run.id);
  if (index < 0) throw new Error(`Agent runtime run not found: ${run.id}`);
  state.runs[index] = run;
}

function requireItemByProviderId(
  state: AgentRuntimeStoreState,
  runId: string,
  providerItemId: string
): AgentRuntimeItemRecord {
  const item = state.items.find(
    (candidate) =>
      candidate.runId === runId && candidate.providerItemId === providerItemId
  );
  if (!item) throw new Error('Agent runtime item not found.');
  return item;
}

function requireInteraction(
  state: AgentRuntimeStoreState,
  interactionId: string
): AgentRuntimeInteractionRecord {
  const interaction = state.interactions.find(
    (candidate) => candidate.id === interactionId
  );
  if (!interaction) {
    throw new Error(`Agent runtime interaction not found: ${interactionId}`);
  }
  return interaction;
}

function requireArtifact(
  state: AgentRuntimeStoreState,
  artifactId: string
): AgentRuntimeArtifactRecord {
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error(`Agent runtime artifact not found: ${artifactId}`);
  return artifact;
}

function assertArtifactBelongsToRun(
  artifact: {
    id: string;
    owner: AgentOwnerScope;
    runId: string;
    kind: AgentRuntimeArtifactKind;
  },
  run: AgentRuntimeRunRecord
): void {
  if (
    agentOwnerScopeKey(artifact.owner) !== agentOwnerScopeKey(run.owner) ||
    !artifactMatchesRunReference(artifact, run)
  ) {
    throw new Error('Agent runtime artifact ownership does not match its run reference.');
  }
}

function artifactMatchesRunReference(
  artifact: Pick<AgentRuntimeArtifactRecord, 'id' | 'kind'>,
  run: AgentRuntimeRunRecord
): boolean {
  switch (artifact.kind) {
    case 'PROMPT':
      return run.promptArtifactId === artifact.id;
    case 'OUTPUT':
      return run.outputArtifactId === artifact.id;
    case 'DIAGNOSTIC':
      return run.diagnosticArtifactId === artifact.id;
    case 'FINAL':
      return run.finalArtifactId === artifact.id;
  }
}

function requireQueueEntry(
  state: AgentRuntimeStoreState,
  entryId: string
): AgentSchedulerQueueEntry {
  const entry = state.queueEntries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error(`Agent runtime queue entry not found: ${entryId}`);
  return entry;
}

function replayedOperation(
  state: AgentRuntimeStoreState,
  input: {
    operationId: string;
    type: AgentRuntimeEventRecord['type'];
    requestFingerprint: string;
    sessionId?: string;
    runId?: string;
    queueEntryId?: string;
    artifactId?: string;
  }
): boolean {
  const events = state.events.filter((event) => event.operationId === input.operationId);
  if (events.length === 0) return false;
  const matching = events.find(
    (event) =>
      event.type === input.type &&
      (input.sessionId === undefined || event.sessionId === input.sessionId) &&
      (input.runId === undefined || event.runId === input.runId) &&
      (input.queueEntryId === undefined || event.queueEntryId === input.queueEntryId) &&
      (input.artifactId === undefined || event.artifactId === input.artifactId)
  );
  if (matching?.payload.requestFingerprint === input.requestFingerprint) return true;
  throw new Error('Agent runtime operation conflicts with its durable request.');
}

function requireRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Agent runtime record revision is invalid.');
  }
}

function requireOperationId(value: string): void {
  if (!value || Buffer.byteLength(value, 'utf8') > AGENT_RUNTIME_LIMITS.maxClientOperationIdBytes) {
    throw new Error('Agent runtime operation id is invalid.');
  }
}

function requireTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('Agent runtime timestamp is invalid.');
  }
}

function assertTelemetryPayload(payload: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new Error('Agent runtime telemetry payload must be JSON serializable.');
  }
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded, 'utf8') > AGENT_RUNTIME_LIMITS.maxTelemetryPayloadBytes
  ) {
    throw new Error('Agent runtime telemetry payload exceeds its safety limit.');
  }
}

function assertTelemetryReferences(
  state: AgentRuntimeStoreState,
  input: Pick<
    AgentRuntimeTelemetryRecord,
    'owner' | 'sessionId' | 'runId' | 'serverInstanceId' | 'providerIdentity'
  >
): void {
  if ((input.sessionId || input.runId) && !input.owner) {
    throw new Error('Scoped agent telemetry requires an owner.');
  }
  if (input.serverInstanceId) requireSafeId(input.serverInstanceId, 'telemetry server id');
  if (
    input.providerIdentity &&
    Buffer.byteLength(input.providerIdentity, 'utf8') > AGENT_RUNTIME_LIMITS.maxOwnerIdBytes
  ) {
    throw new Error('Agent runtime telemetry provider identity is invalid.');
  }
  const ownerKey = input.owner ? agentOwnerScopeKey(input.owner) : undefined;
  if (input.sessionId) {
    const session = state.sessions.find((candidate) => candidate.id === input.sessionId);
    if (!session || agentOwnerScopeKey(session.owner) !== ownerKey) {
      throw new Error('Agent runtime telemetry references an invalid session owner.');
    }
  }
  if (input.runId) {
    const run = state.runs.find((candidate) => candidate.id === input.runId);
    if (!run || agentOwnerScopeKey(run.owner) !== ownerKey) {
      throw new Error('Agent runtime telemetry references an invalid run owner.');
    }
    if (input.sessionId && run.sessionId !== input.sessionId) {
      throw new Error('Agent runtime telemetry run/session references do not match.');
    }
  }
}

function assertRuntimeRunLifecycle(run: AgentRuntimeRunRecord): void {
  if (!(run.status in RUN_STATUS_TRANSITIONS) || !(run.delivery in DELIVERY_TRANSITIONS)) {
    throw new Error('Agent runtime run status or delivery metadata is invalid.');
  }
  for (const timestamp of [run.startedAt, run.lastEventAt, run.endedAt]) {
    if (timestamp !== undefined) requireTimestamp(timestamp);
  }
  const terminal = isTerminalRuntimeStatus(run.status);
  if (Boolean(run.endedAt) !== terminal) {
    throw new Error('Agent runtime run terminal timestamp does not match its status.');
  }
  if (
    run.status === 'QUEUED' &&
    (run.delivery !== 'NOT_SENT' || run.startedAt !== undefined)
  ) {
    throw new Error('Queued agent runtime work must remain provably unsubmitted.');
  }
  if (run.status === 'STARTING' && run.delivery !== 'SENDING') {
    throw new Error('Starting agent runtime work requires durable send intent.');
  }
  if (
    ['RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING'].includes(
      run.status
    ) &&
    run.delivery !== 'ACKNOWLEDGED'
  ) {
    throw new Error('Active agent runtime work requires acknowledged delivery.');
  }
  if (run.status === 'COMPLETED' && run.delivery !== 'TERMINAL') {
    throw new Error('Completed agent runtime work requires terminal provider evidence.');
  }
  if (
    terminal &&
    run.delivery !== 'TERMINAL' &&
    run.delivery !== 'NOT_DELIVERED'
  ) {
    throw new Error('Terminal agent runtime work has unresolved delivery metadata.');
  }
  if (run.delivery === 'NOT_DELIVERED' && run.providerTurnId) {
    throw new Error('A not-delivered agent runtime run cannot have a provider turn id.');
  }
  if (
    run.status === 'RECOVERY_REQUIRED' &&
    (run.recoveryState === 'NONE' ||
      !['AMBIGUOUS', 'NOT_DELIVERED', 'ACKNOWLEDGED', 'TERMINAL'].includes(
        run.delivery
      ))
  ) {
    throw new Error('Recovery-required agent runtime work lacks recovery metadata.');
  }
  if (run.status === 'INTERRUPTING' && !run.stopRequestedAt) {
    throw new Error('Interrupting agent runtime work requires durable stop intent.');
  }
  if (run.repositoryIntegrity) {
    if (
      run.repositoryIntegrity.beforeFingerprint !== undefined &&
      !HASH.test(run.repositoryIntegrity.beforeFingerprint)
    ) {
      throw new Error('Read-only repository evidence requires a valid before fingerprint.');
    }
    if (
      run.repositoryIntegrity.afterFingerprint !== undefined &&
      !HASH.test(run.repositoryIntegrity.afterFingerprint)
    ) {
      throw new Error('Read-only repository evidence requires a valid after fingerprint.');
    }
    if (run.repositoryIntegrity.checkedAt !== undefined) {
      requireTimestamp(run.repositoryIntegrity.checkedAt);
    }
  }
}

function isTerminalRuntimeStatus(status: AgentRuntimeRunRecord['status']): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(status);
}

function requestFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function domainEventFingerprint(event: DomainEvent): string {
  return requestFingerprint({
    type: event.type,
    taskId: event.taskId,
    iterationId: event.iterationId,
    runId: event.runId,
    agentSessionId: event.agentSessionId,
    serverInstanceId: event.serverInstanceId,
    agentItemId: event.agentItemId,
    interactionRequestId: event.interactionRequestId,
    worktreeId: event.worktreeId,
    previewPlanId: event.previewPlanId,
    previewGenerationId: event.previewGenerationId,
    source: event.source,
    payload: event.payload
  });
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Agent runtime ${label} is invalid.`);
}

function artifactStorageKey(artifactId: string, revision: number): string {
  requireSafeId(artifactId, 'artifact id');
  requireRevision(revision);
  return `${artifactId}-r${revision}.txt`;
}

function encodeArtifactContent(content: string): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > AGENT_RUNTIME_LIMITS.maxArtifactBytes) {
    throw new Error('Agent runtime artifact exceeds its safety limit.');
  }
  return {
    bytes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

async function writeImmutableArtifact(
  directory: string,
  storageKey: string,
  bytes: Buffer,
  syncDirectory: (directory: string) => Promise<void>
): Promise<void> {
  if (!ARTIFACT_FILE.test(storageKey)) {
    throw new Error('Agent runtime artifact storage key is invalid.');
  }
  const filePath = path.join(directory, storageKey);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await enforcePosixMode(handle, 0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await fs.readFile(filePath);
    if (!existing.equals(bytes)) {
      throw new Error('Agent runtime artifact revision already exists with different content.');
    }
  }
}

async function readVerifiedArtifact(
  directory: string,
  artifact: AgentRuntimeArtifactRecord
): Promise<string> {
  if (artifact.storageKey !== artifactStorageKey(artifact.id, artifact.recordRevision)) {
    throw new Error('Agent runtime artifact storage key is invalid.');
  }
  const filePath = path.join(directory, artifact.storageKey);
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size !== artifact.byteCount ||
      !hasNoGroupOrOtherPosixAccess(stat) ||
      !isOwnedByCurrentUser(stat)
    ) {
      throw new Error('Agent runtime artifact file failed its integrity check.');
    }
    const bytes = await handle.readFile();
    if (
      bytes.byteLength !== artifact.byteCount ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.contentSha256
    ) {
      throw new Error('Agent runtime artifact content failed its integrity check.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
    throw new Error('Agent runtime store root failed its integrity check.');
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      directory,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw new Error('Agent runtime store root failed its integrity check.');
  }
  try {
    await enforcePosixMode(handle, 0o700);
  } finally {
    await handle.close();
  }
}

async function readPrivateStateFile(filePath: string): Promise<string> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > AGENT_RUNTIME_LIMITS.maxRuntimeStateBytes ||
      !hasNoGroupOrOtherPosixAccess(stat) ||
      !isOwnedByCurrentUser(stat)
    ) {
      throw new Error('Agent runtime store file failed its integrity check.');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) {
      throw new Error('Agent runtime store file changed while it was read.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function cleanupTemporaryFiles(directory: string, storePath: string): Promise<void> {
  const name = path.basename(storePath);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!(entry.name.startsWith(`${name}.`) && entry.name.endsWith('.tmp'))) continue;
    const candidate = path.join(directory, entry.name);
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
      throw new Error('Agent runtime temporary file failed its integrity check.');
    }
    await fs.unlink(candidate);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
