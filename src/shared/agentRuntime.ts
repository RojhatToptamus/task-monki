import type {
  AgentGoalObservationSource,
  AgentGoalStatus,
  AgentGoalSyncState,
  AgentInstructionProfile,
  AgentInteractionAction,
  AgentInteractionDecision,
  AgentInteractionRequestPayload,
  AgentItemStatus,
  AgentItemType,
  AgentObservationSource,
  AgentPlanStep,
  AgentProtocolMessageReference,
  AgentExecutionSettings,
  AgentRuntimeId,
  AgentRecoveryState,
  AgentReviewTarget,
  AgentRunStatus,
  AgentServerInstance,
  AgentSessionRelationshipState,
  AgentSessionRole,
  AgentSessionStatus,
  AgentSubagentObservationSource,
  AgentTokenUsageBreakdown,
  AgentSubagentStatus
} from './agent';
import type {
  AgentAttachmentSelection,
  AttachmentSubmissionRecord
} from './attachments';

export const AGENT_RUNTIME_STORE_SCHEMA_VERSION = 6 as const;

export const AGENT_RUNTIME_LIMITS = {
  maxSessions: 20_000,
  maxRuns: 100_000,
  maxQueueEntries: 10_000,
  maxArtifacts: 300_000,
  maxTelemetryRecords: 500_000,
  maxTypedRecords: 500_000,
  maxServerInstances: 2_000,
  maxProtocolMessageBytes: 10 * 1024 * 1024,
  maxProtocolMessagesPerServer: 100_000,
  maxProtocolJournalBytesPerServer: 256 * 1024 * 1024,
  maxEvents: 200_000,
  maxGlobalOperationReceipts: 256,
  maxOwnerIdBytes: 512,
  maxClientOperationIdBytes: 512,
  maxGenerationKeyBytes: 1024,
  maxPrimaryCwdBytes: 16 * 1024,
  maxExecutionRoots: 3,
  maxManagedAttachments: 10,
  maxArtifactBytes: 4 * 1024 * 1024,
  maxTelemetryPayloadBytes: 256 * 1024
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
  | { kind: 'PROMPT_REFINEMENT'; requestId: string }
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
    }
  | {
      kind: 'PROMPT_REFINEMENT';
      requestId: string;
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
    | {
        status: 'INHERITED_UNATTESTED';
        parentSessionId: string;
        reason: string;
      };
  primaryCwd: string;
  /** Logical repository access requested by the workflow. */
  repositoryAccess: 'READ_ONLY' | 'WRITE';
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
  runtimeId: AgentRuntimeId;
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
  runtimeId: AgentRuntimeId;
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
  /** Task-only identity needed to project the existing task session contract. */
  taskContext?: {
    iterationId: string;
    worktreeId: string;
    worktreePath: string;
  };
}

export type AgentRuntimePurpose =
  | 'TASK_ANALYSIS'
  | 'TASK_IMPLEMENTATION'
  | 'TASK_FOLLOW_UP'
  | 'TASK_RETRY'
  | 'TASK_REVIEW'
  | 'TASK_DESIGN'
  | 'TASK_COMPACTION'
  | 'PROVIDER_SUBAGENT'
  | 'PROMPT_REFINEMENT'
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
  /** Durable before/after evidence for a provider-native read-only turn. */
  repositoryIntegrity?: {
    beforeFingerprint?: string;
    afterFingerprint?: string;
    status: 'PENDING' | 'UNCHANGED' | 'CHANGED' | 'UNVERIFIABLE';
    checkedAt?: string;
    detail?: string;
  };
  instructionProfile?: AgentInstructionProfile;
  /** Exact ordered files selected by the workflow before provider submission. */
  attachmentSelection: AgentAttachmentSelection[];
  attachmentSubmissions?: AttachmentSubmissionRecord[];
  providerTerminalRawMessage?: AgentProtocolMessageReference;
  /** Exact app-owned tools granted to this run. Empty means no app-owned tool. */
  clientToolGrants?: string[];
  /** Task-owned projection details that do not apply to Discourse runs. */
  taskDetails?: {
    retryOfRunId?: string;
    continuedFromRunId?: string;
    beforeGitSnapshotId?: string;
    afterGitSnapshotId?: string;
    eventCount: number;
    lastEventType?: string;
    finalMessage?: string;
  };
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

interface AgentRuntimeTypedRecordBase {
  id: string;
  owner: AgentOwnerScope;
  sessionId: string;
  clientOperationId: string;
  requestFingerprint: string;
  recordRevision: number;
}

/** Mutable provider item. Task fields are derived from its owner and run scope. */
export interface AgentRuntimeItemRecord extends AgentRuntimeTypedRecordBase {
  runId: string;
  providerItemId: string;
  type: AgentItemType;
  status: AgentItemStatus;
  payload: unknown;
  rawMessage?: AgentProtocolMessageReference;
  outputArtifactId?: string;
  providerStartedAt?: string;
  providerCompletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Actionable provider request. It is mutable and cannot be stored as telemetry. */
export interface AgentRuntimeInteractionRecord extends AgentRuntimeTypedRecordBase {
  runId: string;
  serverInstanceId: string;
  providerRequestId: string | number;
  providerTurnId?: string;
  providerItemId?: string;
  type:
    | 'COMMAND_APPROVAL'
    | 'FILE_CHANGE_APPROVAL'
    | 'PERMISSION_APPROVAL'
    | 'MCP_ELICITATION'
    | 'USER_INPUT'
    | 'DYNAMIC_TOOL';
  status:
    | 'PENDING'
    | 'RESPONDING'
    | 'RESOLVED'
    | 'DECLINED'
    | 'CANCELED'
    | 'ABORTED_SERVER_LOST'
    | 'STALE';
  request: AgentInteractionRequestPayload;
  allowedActions: AgentInteractionAction[];
  policyWarnings: string[];
  requestRawMessage: AgentProtocolMessageReference;
  decision?: AgentInteractionDecision;
  responseRawMessage?: AgentProtocolMessageReference;
  resolution?: unknown;
  requestedAt: string;
  respondedAt?: string;
  resolvedAt?: string;
}

export interface AgentRuntimeGoalSnapshotRecord extends AgentRuntimeTypedRecordBase {
  taskGoalHash: string;
  lastSynchronizedTaskGoalHash?: string;
  providerObjective?: string;
  providerStatus?: AgentGoalStatus;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  syncState: AgentGoalSyncState;
  source: AgentGoalObservationSource;
  detail?: string;
  rawMessage?: AgentProtocolMessageReference;
  providerCreatedAt?: string;
  providerUpdatedAt?: string;
  observedAt: string;
}

export interface AgentRuntimePlanRevisionRecord extends AgentRuntimeTypedRecordBase {
  runId: string;
  revision: number;
  explanation?: string;
  steps: AgentPlanStep[];
  rawMessage: AgentProtocolMessageReference;
  observedAt: string;
}

export interface AgentRuntimeUsageSnapshotRecord extends AgentRuntimeTypedRecordBase {
  runId?: string;
  total: AgentTokenUsageBreakdown;
  last: AgentTokenUsageBreakdown;
  modelContextWindow?: number;
  rawMessage: AgentProtocolMessageReference;
  observedAt: string;
}

export interface AgentRuntimeSettingsObservationRecord extends AgentRuntimeTypedRecordBase {
  runId?: string;
  source: AgentObservationSource;
  settings: AgentExecutionSettings;
  detail?: string;
  rawMessage?: AgentProtocolMessageReference;
  observedAt: string;
}

export interface AgentRuntimeSubagentObservationRecord extends AgentRuntimeTypedRecordBase {
  parentSessionId: string;
  parentRunId?: string;
  providerChildSessionId: string;
  providerParentSessionId?: string;
  providerForkedFromSessionId?: string;
  source: AgentSubagentObservationSource;
  relationshipState: AgentSessionRelationshipState;
  status?: AgentSubagentStatus;
  delegatedPrompt?: string;
  requestedSettings?: AgentExecutionSettings;
  providerNickname?: string;
  providerRole?: string;
  agentPath?: string;
  detail?: string;
  rawMessage: AgentProtocolMessageReference;
  observedAt: string;
}

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
  | 'ITEM_UPSERTED'
  | 'INTERACTION_CREATED'
  | 'INTERACTION_UPDATED'
  | 'GOAL_RECORDED'
  | 'PLAN_RECORDED'
  | 'USAGE_RECORDED'
  | 'SETTINGS_RECORDED'
  | 'SUBAGENT_RECORDED'
  | 'QUEUE_ENQUEUED'
  | 'QUEUE_LEASED'
  | 'QUEUE_RELEASED'
  | 'QUEUE_CANCELED'
  | 'QUEUE_SETTLED'
  | 'SHUTDOWN_LATCHED'
  | 'SHUTDOWN_CLEARED';

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
  items: AgentRuntimeItemRecord[];
  interactions: AgentRuntimeInteractionRecord[];
  goalSnapshots: AgentRuntimeGoalSnapshotRecord[];
  planRevisions: AgentRuntimePlanRevisionRecord[];
  usageSnapshots: AgentRuntimeUsageSnapshotRecord[];
  settingsObservations: AgentRuntimeSettingsObservationRecord[];
  subagentObservations: AgentRuntimeSubagentObservationRecord[];
  events: AgentRuntimeEventRecord[];
}

export function agentOwnerScopeKey(scope: AgentOwnerScope): string {
  if (scope.kind === 'TASK') return `task:${scope.taskId}`;
  if (scope.kind === 'PROMPT_REFINEMENT') {
    return `prompt-refinement:${scope.requestId}`;
  }
  return `discourse:${scope.conversationId}:${scope.stableParticipantId}`;
}

export function agentRunScopeBelongsToOwner(
  scope: AgentRunScope,
  owner: AgentOwnerScope
): boolean {
  if (scope.kind === 'TASK') {
    return owner.kind === 'TASK' && owner.taskId === scope.taskId;
  }
  if (scope.kind === 'PROMPT_REFINEMENT') {
    return owner.kind === 'PROMPT_REFINEMENT' && owner.requestId === scope.requestId;
  }
  return owner.kind === 'DISCOURSE' && owner.conversationId === scope.conversationId;
}
