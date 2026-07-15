import type {
  AgentExecutionSettings,
  AgentProviderId,
  AgentRecoveryState,
  AgentReviewTarget,
  AgentRunStatus,
  AgentServerInstance,
  AgentSessionRelationshipState,
  AgentSessionRole,
  AgentSessionStatus,
  AgentSubagentStatus
} from './agent';

export const AGENT_RUNTIME_STORE_SCHEMA_VERSION = 2 as const;

export const AGENT_RUNTIME_LIMITS = {
  maxSessions: 20_000,
  maxRuns: 100_000,
  maxQueueEntries: 10_000,
  maxArtifacts: 300_000,
  maxTelemetryRecords: 500_000,
  maxServerInstances: 2_000,
  maxProtocolMessageBytes: 10 * 1024 * 1024,
  maxProtocolMessagesPerServer: 100_000,
  maxProtocolJournalBytesPerServer: 256 * 1024 * 1024,
  maxEvents: 200_000,
  maxOwnerIdBytes: 512,
  maxClientOperationIdBytes: 512,
  maxGenerationKeyBytes: 1024,
  maxPrimaryCwdBytes: 16 * 1024,
  maxExecutionRoots: 3,
  maxManagedAttachments: 10,
  maxArtifactBytes: 4 * 1024 * 1024,
  maxTelemetryPayloadBytes: 256 * 1024,
  maxRuntimeStateBytes: 128 * 1024 * 1024
} as const;

export const AGENT_SCHEDULER_POLICY = {
  version: 1,
  maxActiveTurns: 2,
  maxActiveTurnsPerConversation: 2,
  maxActiveTurnsPerSession: 1,
  agingPromotionIntervalMs: 30_000,
  optimisticLeaseRetries: 8
} as const;

/** Durable participant/task owner. It never fabricates a task for discourse. */
export type AgentOwnerScope =
  | { kind: 'TASK'; taskId: string }
  | {
      kind: 'DISCOURSE';
      conversationId: string;
      stableParticipantId: string;
    };

/** Exact execution generation copied onto a run before provider mutation. */
export type AgentRunScope =
  | {
      kind: 'TASK';
      taskId: string;
      iterationId: string;
      worktreeId: string;
    }
  | {
      kind: 'DISCOURSE';
      conversationId: string;
      waveId: string;
      jobId: string;
      contextSnapshotId: string;
      attemptId: string;
    };

export interface AgentAttestedReadRoot {
  canonicalPath: string;
  kind: 'WORKTREE' | 'REPOSITORY' | 'EMPTY_MANAGED';
  entityId?: string;
}

export interface AgentManagedAttachmentAccess {
  attachmentId: string;
  contentSha256: string;
  byteCount: number;
}

/**
 * Full model-visible execution boundary. The profile hash is derived from this
 * complete structure; a changed root, cwd, attachment, tool mode, or setting
 * requires another access epoch.
 */
export interface AgentExecutionContext {
  attestation:
    | { status: 'ATTESTED' }
    | { status: 'LEGACY_UNATTESTED'; reason: string }
    | {
        status: 'INHERITED_UNATTESTED';
        parentSessionId: string;
        reason: string;
      };
  primaryCwd: string;
  readRoots: AgentAttestedReadRoot[];
  managedAttachments: AgentManagedAttachmentAccess[];
  permissionProfileHash: string;
  modelSettings: AgentExecutionSettings;
  externalTools: {
    network: boolean;
    webSearch: 'disabled' | 'cached' | 'live';
    mcpServers: boolean;
    apps: boolean;
    dynamicTools: boolean;
  };
  clientOperationId: string;
}

export interface AgentSessionAccessEpoch {
  owner: AgentOwnerScope;
  sessionId: string;
  epoch: number;
  executionProfileHash: string;
  primaryCwd: string;
  providerId: AgentProviderId;
  model: string;
  createdAt: string;
}

export interface AgentRuntimeSessionRecord {
  id: string;
  owner: AgentOwnerScope;
  accessEpoch: AgentSessionAccessEpoch;
  executionContext: AgentExecutionContext;
  clientOperationId: string;
  requestFingerprint: string;
  provider: AgentProviderId;
  role: AgentSessionRole;
  providerSessionId?: string;
  providerSessionTreeId?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  providerParentSessionId?: string;
  providerForkedFromSessionId?: string;
  parentRunId?: string;
  relationshipState: AgentSessionRelationshipState;
  relationshipDetail?: string;
  providerNickname?: string;
  providerRole?: string;
  delegatedPrompt?: string;
  agentPath?: string;
  subagentStatus?: AgentSubagentStatus;
  status: AgentSessionStatus;
  materialized: boolean;
  requestedSettings: AgentExecutionSettings;
  observedSettings?: AgentExecutionSettings;
  recordRevision: number;
  createdAt: string;
  updatedAt: string;
  lastAttachedAt?: string;
}

export type AgentRuntimePurpose =
  | 'TASK_IMPLEMENTATION'
  | 'TASK_FOLLOW_UP'
  | 'TASK_RETRY'
  | 'TASK_REVIEW'
  | 'PROVIDER_SUBAGENT'
  | 'DISCOURSE_ANSWER'
  | 'DISCOURSE_CRITIQUE'
  | 'DISCOURSE_CORRECT'
  | 'DISCOURSE_TARGETED_REPLY'
  | 'DISCOURSE_SYNTHESIZE'
  | 'DISCOURSE_COMPACT_HISTORY';

export type AgentRuntimeDeliveryStatus =
  | 'NOT_SENT'
  | 'SENDING'
  | 'ACKNOWLEDGED'
  | 'NOT_DELIVERED'
  | 'AMBIGUOUS'
  | 'TERMINAL';

export interface AgentRuntimeRunRecord {
  id: string;
  owner: AgentOwnerScope;
  scope: AgentRunScope;
  sessionId: string;
  sessionAccessEpoch: number;
  serverInstanceId?: string;
  providerTurnId?: string;
  purpose: AgentRuntimePurpose;
  parentRunId?: string;
  taskReviewTarget?: AgentReviewTarget;
  generationKey: string;
  clientOperationId: string;
  requestFingerprint: string;
  status: AgentRunStatus;
  delivery: AgentRuntimeDeliveryStatus;
  interruptDelivery?: AgentRuntimeDeliveryStatus;
  recoveryState: AgentRecoveryState;
  requestedSettings: AgentExecutionSettings;
  observedSettings?: AgentExecutionSettings;
  promptArtifactId: string;
  outputArtifactId: string;
  diagnosticArtifactId: string;
  finalArtifactId?: string;
  terminalReason?: string;
  providerTerminalSource?: string;
  contextFreshnessAtCompletion?: 'FRESH' | 'CHANGED_DURING_JOB' | 'UNKNOWN';
  stopRequestedAt?: string;
  recordRevision: number;
  createdAt: string;
  startedAt?: string;
  lastEventAt?: string;
  endedAt?: string;
}

export type AgentRuntimeArtifactKind = 'PROMPT' | 'OUTPUT' | 'DIAGNOSTIC' | 'FINAL';

/** Immutable-file revision metadata. Paths are resolved only by the owning store. */
export interface AgentRuntimeArtifactRecord {
  id: string;
  owner: AgentOwnerScope;
  runId: string;
  kind: AgentRuntimeArtifactKind;
  clientOperationId: string;
  requestFingerprint: string;
  storageKey: string;
  contentSha256: string;
  byteCount: number;
  recordRevision: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentRuntimeTelemetryKind =
  | 'SERVER'
  | 'ITEM'
  | 'INTERACTION'
  | 'GOAL'
  | 'PLAN'
  | 'USAGE'
  | 'SETTINGS'
  | 'SUBAGENT'
  | 'PROTOCOL_REFERENCE';

/** Immutable normalized observation. Raw protocol bytes remain in bounded journals. */
export interface AgentRuntimeTelemetryRecord {
  id: string;
  kind: AgentRuntimeTelemetryKind;
  owner?: AgentOwnerScope;
  sessionId?: string;
  runId?: string;
  serverInstanceId?: string;
  providerIdentity?: string;
  clientOperationId: string;
  requestFingerprint: string;
  payload: unknown;
  observedAt: string;
  createdAt: string;
}

export type AgentSchedulerPriority =
  | 'TASK_FOREGROUND'
  | 'DISCOURSE_RESPONSE'
  | 'DISCOURSE_TARGETED'
  | 'DISCOURSE_BACKGROUND';

export type AgentSchedulerQueueStatus =
  | 'QUEUED'
  | 'LEASED'
  | 'CANCELED'
  | 'SETTLED';

export interface AgentSchedulerQueueEntry {
  id: string;
  runId: string;
  clientOperationId: string;
  requestFingerprint: string;
  owner: AgentOwnerScope;
  scope: AgentRunScope;
  sessionId: string;
  priority: AgentSchedulerPriority;
  status: AgentSchedulerQueueStatus;
  enqueueOrdinal: number;
  recordRevision: number;
  enqueuedAt: string;
  notBefore?: string;
  leasedAt?: string;
  settledAt?: string;
  cancelReason?: string;
}

export type AgentRuntimeEventType =
  | 'SESSION_CREATED'
  | 'SESSION_UPDATED'
  | 'RUN_CREATED'
  | 'RUN_UPDATED'
  | 'ARTIFACT_CREATED'
  | 'ARTIFACT_UPDATED'
  | 'TELEMETRY_RECORDED'
  | 'QUEUE_ENQUEUED'
  | 'QUEUE_LEASED'
  | 'QUEUE_RELEASED'
  | 'QUEUE_CANCELED'
  | 'QUEUE_SETTLED'
  | 'SHUTDOWN_LATCHED'
  | 'SHUTDOWN_CLEARED'
  | 'MIGRATION_IMPORTED';

export interface AgentRuntimeEventRecord {
  id: string;
  ordinal: number;
  type: AgentRuntimeEventType;
  owner?: AgentOwnerScope;
  runId?: string;
  sessionId?: string;
  queueEntryId?: string;
  artifactId?: string;
  operationId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface AgentRuntimeMigrationRecord {
  source: 'TASK_STORE_V11';
  sourceSha256: string;
  importedAt: string;
  sessionCount: number;
  runCount: number;
}

export interface AgentRuntimeStoreState {
  schemaVersion: typeof AGENT_RUNTIME_STORE_SCHEMA_VERSION;
  revision: number;
  nextEventOrdinal: number;
  nextQueueOrdinal: number;
  shutdownLatched: boolean;
  servers: AgentServerInstance[];
  sessions: AgentRuntimeSessionRecord[];
  runs: AgentRuntimeRunRecord[];
  queueEntries: AgentSchedulerQueueEntry[];
  artifacts: AgentRuntimeArtifactRecord[];
  telemetryRecords: AgentRuntimeTelemetryRecord[];
  events: AgentRuntimeEventRecord[];
  migrations: AgentRuntimeMigrationRecord[];
}

export function agentOwnerScopeKey(scope: AgentOwnerScope): string {
  return scope.kind === 'TASK'
    ? `task:${scope.taskId}`
    : `discourse:${scope.conversationId}:${scope.stableParticipantId}`;
}

export function agentRunScopeBelongsToOwner(
  scope: AgentRunScope,
  owner: AgentOwnerScope
): boolean {
  return scope.kind === 'TASK'
    ? owner.kind === 'TASK' && owner.taskId === scope.taskId
    : owner.kind === 'DISCOURSE' && owner.conversationId === scope.conversationId;
}
