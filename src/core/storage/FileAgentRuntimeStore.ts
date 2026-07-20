import crypto, { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentProtocolMessageReference,
  AgentServerInstance
} from '../../shared/agent';
import {
  AGENT_RUNTIME_LIMITS,
  AGENT_RUNTIME_STORE_SCHEMA_VERSION,
  agentOwnerScopeKey,
  type AgentOwnerScope,
  type AgentRuntimeArtifactKind,
  type AgentRuntimeArtifactRecord,
  type AgentRuntimeMigrationRecord,
  type AgentRuntimeEventRecord,
  type AgentRuntimeRunRecord,
  type AgentRuntimeSessionRecord,
  type AgentRuntimeStoreState,
  type AgentRuntimeTelemetryKind,
  type AgentRuntimeTelemetryRecord,
  type AgentSchedulerPriority,
  type AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';
import {
  assertAccessEpochMatches,
  assertAgentOwnerScope,
  assertAgentRunScope,
  createAgentSessionAccessEpoch
} from '../agent/AgentRuntimeOwnership';
import { validateAgentServerTransition } from '../agent/AgentServerLifecycle';
import { AgentProtocolJournal } from '../agent/journal/AgentProtocolJournal';
import type {
  AgentRuntimeStore,
  CreateAgentRuntimeServerInput,
  CreateObservedRuntimeRunInput,
  CreateRuntimeRunInput,
  CreateRuntimeSessionInput
} from '../agent/AgentRuntimeStore';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../filesystem/secureFilesystem';

const RUNTIME_FILE_NAME = 'runtime.json';
const V1_BACKUP_FILE_NAME = 'runtime.schema-v1.backup.json';
const ARTIFACT_DIRECTORY = 'artifacts';
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

const RUN_STATUS_TRANSITIONS: Record<AgentRuntimeRunRecord['status'], readonly AgentRuntimeRunRecord['status'][]> = {
  QUEUED: ['STARTING', 'INTERRUPTED', 'FAILED', 'RECOVERY_REQUIRED'],
  STARTING: ['RUNNING', 'INTERRUPTING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  RUNNING: ['AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  AWAITING_APPROVAL: ['RUNNING', 'INTERRUPTING', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  AWAITING_USER_INPUT: ['RUNNING', 'INTERRUPTING', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  INTERRUPTING: ['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'],
  RECOVERY_REQUIRED: ['STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'],
  LOST: ['RECOVERY_REQUIRED', 'COMPLETED', 'FAILED', 'INTERRUPTED'],
  COMPLETED: [],
  FAILED: [],
  INTERRUPTED: []
};

const DELIVERY_TRANSITIONS: Record<AgentRuntimeRunRecord['delivery'], readonly AgentRuntimeRunRecord['delivery'][]> = {
  NOT_SENT: ['SENDING', 'NOT_DELIVERED'],
  SENDING: ['ACKNOWLEDGED', 'NOT_DELIVERED', 'AMBIGUOUS'],
  ACKNOWLEDGED: ['TERMINAL', 'AMBIGUOUS'],
  AMBIGUOUS: ['ACKNOWLEDGED', 'TERMINAL', 'NOT_DELIVERED'],
  NOT_DELIVERED: [],
  TERMINAL: []
};
const SESSION_STATUS_TRANSITIONS: Record<
  AgentRuntimeSessionRecord['status'],
  readonly AgentRuntimeSessionRecord['status'][]
> = {
  NOT_MATERIALIZED: ['IDLE', 'ACTIVE', 'SYSTEM_ERROR', 'DELETED'],
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
  SYSTEM_ERROR: ['IDLE', 'NOT_LOADED', 'DELETED'],
  ARCHIVED: ['IDLE', 'DELETED'],
  DELETED: [],
  UNKNOWN: ['IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED']
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
  private operationQueue: Promise<unknown> = Promise.resolve();
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
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  async close(): Promise<void> {
    await this.operationQueue.catch(() => undefined);
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
    });
  }

  async appendProtocolMessage(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    if (!(await this.getAgentServer(serverInstanceId))) {
      throw new Error('Protocol journal server instance is not owned by this runtime.');
    }
    return this.protocolJournal.append(serverInstanceId, direction, raw, metadata);
  }

  async readProtocolMessage(reference: AgentProtocolMessageReference) {
    if (!(await this.getAgentServer(reference.serverInstanceId))) {
      throw new Error('Protocol journal server instance is not owned by this runtime.');
    }
    return this.protocolJournal.read(reference);
  }

  async getTaskStoreV11Migration(): Promise<AgentRuntimeMigrationRecord | undefined> {
    await this.init();
    return clone(this.state.migrations.find((migration) => migration.source === 'TASK_STORE_V11'));
  }

  async recordTaskStoreV11Migration(input: {
    sourceSha256: string;
    sessionCount: number;
    runCount: number;
    operationId: string;
  }): Promise<AgentRuntimeMigrationRecord> {
    return this.mutate((draft) => {
      requireOperationId(input.operationId);
      if (
        !HASH.test(input.sourceSha256) ||
        !Number.isSafeInteger(input.sessionCount) ||
        input.sessionCount < 0 ||
        !Number.isSafeInteger(input.runCount) ||
        input.runCount < 0
      ) {
        throw new Error('Task runtime migration metadata is invalid.');
      }
      const existing = draft.migrations.find(
        (migration) => migration.source === 'TASK_STORE_V11'
      );
      if (existing) return existing;
      const migration: AgentRuntimeMigrationRecord = {
        source: 'TASK_STORE_V11',
        sourceSha256: input.sourceSha256,
        importedAt: this.now(),
        sessionCount: input.sessionCount,
        runCount: input.runCount
      };
      draft.migrations.push(migration);
      appendEvent(draft, this.createId, migration.importedAt, {
        type: 'MIGRATION_IMPORTED',
        operationId: input.operationId,
        payload: {
          source: migration.source,
          sourceSha256: migration.sourceSha256,
          sessionCount: migration.sessionCount,
          runCount: migration.runCount
        }
      });
      return migration;
    });
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<AgentRuntimeSessionRecord> {
    return this.mutate((draft) => {
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
      const now = this.now();
      const session: AgentRuntimeSessionRecord = {
        ...clone(input),
        requestFingerprint: fingerprint,
        recordRevision: 1,
        createdAt: now,
        updatedAt: now
      };
      draft.sessions.push(session);
      appendEvent(draft, this.createId, now, {
        type: 'SESSION_CREATED',
        owner: session.owner,
        sessionId: session.id,
        operationId: session.clientOperationId,
        payload: { accessEpoch: session.accessEpoch.epoch }
      });
      return session;
    });
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
    providerSessionId: string
  ): Promise<AgentRuntimeSessionRecord | undefined> {
    await this.init();
    return clone(
      this.state.sessions.find((session) => session.providerSessionId === providerSessionId)
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
        | 'status'
        | 'materialized'
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
      const fingerprint = requestFingerprint({ sessionId, expectedRevision, update });
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
        update.providerSessionId !== existing.providerSessionId
      ) {
        throw new Error('Agent runtime provider session identity is immutable.');
      }
      if (
        update.providerSessionId !== undefined &&
        draft.sessions.some(
          (session) =>
            session.id !== existing.id &&
            session.providerSessionId === update.providerSessionId
        )
      ) {
        throw new Error('Agent runtime provider session identity is already assigned.');
      }
      if (
        update.providerSessionTreeId !== undefined &&
        existing.providerSessionTreeId !== undefined &&
        update.providerSessionTreeId !== existing.providerSessionTreeId
      ) {
        throw new Error('Agent runtime provider session tree identity is immutable.');
      }
      if (update.lastAttachedAt) requireTimestamp(update.lastAttachedAt);
      const stored: AgentRuntimeSessionRecord = {
        ...existing,
        ...clone(update),
        recordRevision: existing.recordRevision + 1,
        updatedAt: this.now()
      };
      if (
        typeof stored.materialized !== 'boolean' ||
        (existing.materialized && !stored.materialized) ||
        (stored.providerSessionId !== undefined && !stored.materialized)
      ) {
        throw new Error('Agent runtime session materialization cannot be reversed.');
      }
      draft.sessions[index] = stored;
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
    providerTurnId: string
  ): Promise<AgentRuntimeRunRecord | undefined> {
    await this.init();
    return clone(this.state.runs.find((run) => run.providerTurnId === providerTurnId));
  }

  async listRunsByOwner(owner: AgentOwnerScope): Promise<AgentRuntimeRunRecord[]> {
    await this.init();
    assertAgentOwnerScope(owner);
    const key = agentOwnerScopeKey(owner);
    return clone(this.state.runs.filter((run) => agentOwnerScopeKey(run.owner) === key));
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
        | 'finalArtifactId'
        | 'startedAt'
        | 'stopRequestedAt'
        | 'lastEventAt'
        | 'endedAt'
      >
    >,
    operationId: string
  ): Promise<AgentRuntimeRunRecord> {
    return this.mutate((draft) => {
      requireOperationId(operationId);
      const fingerprint = requestFingerprint({ runId, expectedRevision, update });
      const replay = replayedOperation(draft, {
        operationId,
        type: 'RUN_UPDATED',
        runId,
        requestFingerprint: fingerprint
      });
      if (replay) return requireRun(draft, runId);
      const index = draft.runs.findIndex((run) => run.id === runId);
      if (index < 0) throw new Error(`Agent runtime run not found: ${runId}`);
      const existing = draft.runs[index]!;
      if (existing.recordRevision !== expectedRevision) {
        throw new Error('Agent runtime run changed before the requested update.');
      }
      if (
        update.status &&
        update.status !== existing.status &&
        !RUN_STATUS_TRANSITIONS[existing.status].includes(update.status)
      ) {
        throw new Error(`Invalid agent runtime run transition: ${existing.status} -> ${update.status}`);
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
        if (!existing.interruptDelivery) {
          if (update.interruptDelivery !== 'SENDING') {
            throw new Error('Agent runtime interrupt delivery must begin with durable send intent.');
          }
        } else if (
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
      const stored = {
        ...existing,
        ...clone(update),
        recordRevision: existing.recordRevision + 1
      };
      draft.runs[index] = stored;
      appendEvent(draft, this.createId, this.now(), {
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
    });
  }

  async enqueueRun(
    runId: string,
    priority: AgentSchedulerPriority,
    operationId: string,
    notBefore?: string
  ): Promise<AgentSchedulerQueueEntry> {
    return this.mutate((draft) => {
      requireOperationId(operationId);
      const run = requireRun(draft, runId);
      const fingerprint = requestFingerprint({ runId, priority, notBefore: notBefore ?? null });
      const existing = draft.queueEntries.find((entry) => entry.runId === runId);
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
      const now = this.now();
      const entry: AgentSchedulerQueueEntry = {
        id: this.createId(),
        runId,
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
      appendEvent(draft, this.createId, now, {
        type: 'QUEUE_ENQUEUED',
        owner: entry.owner,
        runId,
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
    });
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
      const fingerprint = requestFingerprint({ entryId, expectedRevision });
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
    const result = await this.mutate((draft) => {
      const ownsConversation = (owner: AgentOwnerScope | undefined) =>
        owner?.kind === 'DISCOURSE' && owner.conversationId === conversationId;
      const sessions = draft.sessions.filter((session) => ownsConversation(session.owner));
      const sessionIds = new Set(sessions.map((session) => session.id));
      const runs = draft.runs.filter(
        (run) => ownsConversation(run.owner) || sessionIds.has(run.sessionId)
      );
      const runIds = new Set(runs.map((run) => run.id));
      const queueEntries = draft.queueEntries.filter((entry) => runIds.has(entry.runId));
      if (runs.some((run) => !isTerminalRuntimeStatus(run.status))) {
        throw new Error(
          'Agent runtime conversation cannot be purged while a run still needs settlement.'
        );
      }
      if (
        queueEntries.some(
          (entry) => entry.status !== 'SETTLED' && entry.status !== 'CANCELED'
        )
      ) {
        throw new Error(
          'Agent runtime conversation cannot be purged while scheduler work is active.'
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
          !ownsConversation(record.owner) &&
          !(record.sessionId && sessionIds.has(record.sessionId)) &&
          !(record.runId && runIds.has(record.runId))
      );
      draft.events = draft.events.filter(
        (event) =>
          !ownsConversation(event.owner) &&
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
    });
    await this.cleanupUnreferencedArtifactFiles();
    return result;
  }

  async purgeTask(taskId: string): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }> {
    requireSafeId(taskId, 'task id');
    const result = await this.mutate((draft) => {
      const ownsTask = (owner: AgentOwnerScope | undefined) =>
        owner?.kind === 'TASK' && owner.taskId === taskId;
      const sessions = draft.sessions.filter((session) => ownsTask(session.owner));
      const sessionIds = new Set(sessions.map((session) => session.id));
      const runs = draft.runs.filter(
        (run) => ownsTask(run.owner) || sessionIds.has(run.sessionId)
      );
      const runIds = new Set(runs.map((run) => run.id));
      const queueEntries = draft.queueEntries.filter((entry) => runIds.has(entry.runId));
      if (runs.some((run) => !isTerminalRuntimeStatus(run.status))) {
        throw new Error('Agent runtime task cannot be purged while a run needs settlement.');
      }
      if (
        queueEntries.some(
          (entry) => entry.status !== 'SETTLED' && entry.status !== 'CANCELED'
        )
      ) {
        throw new Error('Agent runtime task cannot be purged while scheduler work is active.');
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
          !ownsTask(record.owner) &&
          !(record.sessionId && sessionIds.has(record.sessionId)) &&
          !(record.runId && runIds.has(record.runId))
      );
      draft.events = draft.events.filter(
        (event) =>
          !ownsTask(event.owner) &&
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
    });
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
        expectedRevision,
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

  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.rootDir);
    await ensurePrivateDirectory(this.artifactsDir);
    await cleanupTemporaryFiles(this.rootDir, this.storePath);
    try {
      const raw = await readPrivateStateFile(this.storePath);
      const decoded = JSON.parse(raw) as unknown;
      const parsed =
        runtimeSchemaVersion(decoded) === 1
          ? await this.migrateSchemaV1(decoded, raw)
          : (decoded as AgentRuntimeStoreState);
      validateState(parsed);
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = emptyState();
      await this.persist(this.state);
    }
    await this.protocolJournal.reconcileServers(
      this.state.servers.map((server) => server.id)
    );
    await this.reconcileArtifacts();
  }

  private async migrateSchemaV1(
    decoded: unknown,
    source: string
  ): Promise<AgentRuntimeStoreState> {
    const migrated = migrateRuntimeSchemaV1(decoded);
    validateState(migrated);
    await writeImmutablePrivateFile(
      path.join(this.rootDir, V1_BACKUP_FILE_NAME),
      Buffer.from(source, 'utf8'),
      this.syncDirectoryHook
    );
    await this.persist(migrated);
    return migrated;
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

  private mutate<T>(operation: (draft: AgentRuntimeStoreState) => T | Promise<T>): Promise<T> {
    const queued = this.operationQueue.catch(() => undefined).then(async () => {
      await this.init();
      if (this.publishedFailure) {
        throw new Error(
          'Agent runtime state was published without confirmed directory sync; restart before continuing.'
        );
      }
      const draft = clone(this.state);
      const before = stableStringify(draft);
      const result = await operation(draft);
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
  const session = requireSession(draft, input.sessionId);
  if (
    agentOwnerScopeKey(session.owner) !== agentOwnerScopeKey(input.owner) ||
    session.accessEpoch.epoch !== input.sessionAccessEpoch
  ) {
    throw new Error('Agent runtime run does not match its session owner/access epoch.');
  }
  const fingerprint = requestFingerprint(input);
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
    ...clone(input),
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
    events: [],
    migrations: []
  };
}

function runtimeSchemaVersion(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  return Number.isSafeInteger(version) ? Number(version) : undefined;
}

/**
 * Schema v1 predated complete execution-context attestation and generic
 * telemetry. Its records remain useful history, but they are never promoted
 * to trusted reusable access epochs during migration.
 */
function migrateRuntimeSchemaV1(value: unknown): AgentRuntimeStoreState {
  if (!value || typeof value !== 'object' || runtimeSchemaVersion(value) !== 1) {
    throw new Error('Agent runtime schema-v1 migration source is invalid.');
  }
  const legacy = clone(value) as Record<string, unknown>;
  if (!Number.isSafeInteger(legacy.revision) || !Array.isArray(legacy.sessions)) {
    throw new Error('Agent runtime schema-v1 migration source metadata is invalid.');
  }
  const sessions = legacy.sessions.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('Agent runtime schema-v1 session is invalid.');
    }
    const session = candidate as AgentRuntimeSessionRecord;
    if (!session.executionContext || typeof session.executionContext !== 'object') {
      throw new Error('Agent runtime schema-v1 execution context is invalid.');
    }
    const executionContext = {
      ...session.executionContext,
      attestation: {
        status: 'LEGACY_UNATTESTED' as const,
        reason:
          'Agent runtime schema v1 did not durably attest the complete execution scope. Start a fresh access epoch before reuse.'
      }
    };
    const accessEpoch = createAgentSessionAccessEpoch({
      owner: session.owner,
      sessionId: session.id,
      epoch: session.accessEpoch?.epoch,
      runtimeId: session.runtimeId,
      model: executionContext.modelSettings?.model ?? session.accessEpoch?.model,
      executionContext,
      createdAt: session.accessEpoch?.createdAt
    });
    const migrated: AgentRuntimeSessionRecord = {
      ...session,
      accessEpoch,
      executionContext,
      requestFingerprint: ''
    };
    const {
      recordRevision: _recordRevision,
      requestFingerprint: _requestFingerprint,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      lastAttachedAt: _lastAttachedAt,
      ...request
    } = migrated;
    migrated.requestFingerprint = requestFingerprint(request);
    return migrated;
  });
  return {
    ...(legacy as unknown as AgentRuntimeStoreState),
    schemaVersion: AGENT_RUNTIME_STORE_SCHEMA_VERSION,
    revision: Number(legacy.revision) + 1,
    sessions,
    servers: Array.isArray(legacy.servers)
      ? (legacy.servers as AgentServerInstance[])
      : [],
    telemetryRecords: Array.isArray(legacy.telemetryRecords)
      ? (legacy.telemetryRecords as AgentRuntimeTelemetryRecord[])
      : [],
    migrations: Array.isArray(legacy.migrations)
      ? (legacy.migrations as AgentRuntimeMigrationRecord[])
      : []
  };
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
    !Array.isArray(state.events) ||
    !Array.isArray(state.migrations)
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
      (session.providerSessionId !== undefined &&
        (!session.providerSessionId || !session.materialized)) ||
      (session.providerSessionTreeId !== undefined && !session.providerSessionTreeId) ||
      session.updatedAt < session.createdAt ||
      (session.providerSessionId !== undefined &&
        providerSessionIds.has(session.providerSessionId))
    ) {
      throw new Error('Agent runtime session lifecycle metadata is invalid.');
    }
    if (session.providerSessionId !== undefined) {
      providerSessionIds.add(session.providerSessionId);
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
  const migrationSources = new Set<string>();
  for (const migration of state.migrations) {
    if (
      migration.source !== 'TASK_STORE_V11' ||
      migrationSources.has(migration.source) ||
      !HASH.test(migration.sourceSha256) ||
      !Number.isSafeInteger(migration.sessionCount) ||
      migration.sessionCount < 0 ||
      !Number.isSafeInteger(migration.runCount) ||
      migration.runCount < 0
    ) {
      throw new Error('Agent runtime migration metadata is invalid.');
    }
    requireTimestamp(migration.importedAt);
    migrationSources.add(migration.source);
  }
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

function assertExecutionContextMatchesEpoch(
  session: Pick<
    AgentRuntimeSessionRecord,
    'id' | 'owner' | 'runtimeId' | 'requestedSettings' | 'executionContext' | 'accessEpoch'
  >
): void {
  const model = session.requestedSettings.model;
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
      !['AMBIGUOUS', 'NOT_DELIVERED', 'ACKNOWLEDGED'].includes(run.delivery))
  ) {
    throw new Error('Recovery-required agent runtime work lacks recovery metadata.');
  }
  if (run.status === 'INTERRUPTING' && !run.stopRequestedAt) {
    throw new Error('Interrupting agent runtime work requires durable stop intent.');
  }
}

function isTerminalRuntimeStatus(status: AgentRuntimeRunRecord['status']): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(status);
}

function requestFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
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

async function writeImmutablePrivateFile(
  filePath: string,
  bytes: Buffer,
  syncDirectory: (directory: string) => Promise<void>
): Promise<void> {
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
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readPrivateStateFile(filePath);
    if (!Buffer.from(existing, 'utf8').equals(bytes)) {
      throw new Error('Agent runtime schema-v1 backup conflicts with the migration source.');
    }
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
