/**
 * Provider-neutral contracts for Task Monki's global agent discourse domain.
 *
 * These records intentionally reference tasks, repositories, provider sessions,
 * and runtime artifacts by opaque ID. The owning stores resolve those IDs; a
 * discourse conversation never owns a task, repository path, or provider
 * thread.
 */

export const DISCOURSE_LIMITS = {
  maxContextReferencesPerWave: 8,
  maxFilesystemRootsPerWave: 3,
  maxTeamParticipants: 3,
  maxTeamJobs: 4,
  maxPanelParticipants: 3,
  maxHumanMessageBytes: 32 * 1024,
  maxAgentContributionBytes: 64 * 1024,
  maxContextManifestBytesPerReference: 64 * 1024,
  maxContextManifestBytesPerWave: 512 * 1024,
  maxRecentTranscriptBytes: 256 * 1024,
  maxRecentTranscriptTokens: 48_000,
  maxRecentTranscriptMessages: 80,
  maxEventsPerConversation: 100_000,
  maxEventLogSegments: 512,
  maxSummaryBytes: 32 * 1024,
  maxWaveOutputBytes: 256 * 1024,
  promptContextSafetyPermille: 800,
  defaultReservedOutputTokens: 16_000,
  transcriptPageSize: 100,
  maxConversationSummariesInSnapshot: 500,
  deltaCoalesceIntervalMs: 75,
  maxPendingDeltaBytesPerJob: 32 * 1024,
  foregroundTaskSchedulerP95DelayMs: 250,
  maxDeltaEventsPerBatch: 256,
  maxDeltaBatchBytes: 512 * 1024,
  maxSnapshotBytes: 2 * 1024 * 1024
} as const;

export type DiscourseConversationStatus = 'OPEN' | 'ARCHIVED';

export type DiscourseDefaultPolicy = 'TEAM' | 'PANEL' | 'DIRECT' | 'NONE';

/** Current user-authored response waves. */
export type CurrentDiscourseWavePolicy = Exclude<DiscourseDefaultPolicy, 'NONE'>;

/** Read/recovery compatibility for conversations written by earlier prototypes. */
export type LegacyDiscourseWavePolicy =
  | 'TARGETED_REVIEW'
  | 'TARGETED_REPLY'
  | 'SYNTHESIS';

export type DiscourseWavePolicy =
  | CurrentDiscourseWavePolicy
  | LegacyDiscourseWavePolicy;

export type DiscourseParticipantRole = 'LEAD' | 'SKEPTIC' | 'VERIFIER' | 'GENERAL';

export interface DiscourseConversationRecord {
  id: string;
  title: string;
  status: DiscourseConversationStatus;
  defaultPolicy: DiscourseDefaultPolicy;
  participantIds: string[];
  pinnedContextRevisionId?: string;
  recordRevision: number;
  latestOrdinal: number;
  readOrdinal: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type BuiltInAgentProfileId =
  | 'builtin.lead'
  | 'builtin.skeptic'
  | 'builtin.verifier';

export interface AgentProfileRecord {
  id: BuiltInAgentProfileId;
  displayName: string;
  roleTemplate: DiscourseParticipantRole;
  defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT';
  defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT';
  roleContractVersion: number;
  revision: number;
}

export interface AgentProfileCatalogEntry {
  profile: AgentProfileRecord;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  unavailableReason?: string;
  configurationRequired?: boolean;
  resolvedSettings?: {
    runtimeId: string;
    modelId: string;
    model: string;
    modelProvider: string;
    reasoningEffort?: string;
    serviceTier?: string;
  };
}

export interface AgentProfileCatalogSnapshot {
  profiles: AgentProfileCatalogEntry[];
  refreshedAt: string;
}

export interface DiscourseParticipantRecord {
  id: string;
  conversationId: string;
  agentProfileId: string;
  currentRevisionId: string;
  enabled: boolean;
  recordRevision: number;
  createdAt: string;
}

export interface DiscourseParticipantRevisionRecord {
  id: string;
  conversationId: string;
  stableParticipantId: string;
  agentProfileId: string;
  profileRevision: number;
  displayNameSnapshot: string;
  runtimeId: string;
  model: string;
  modelProvider: string;
  reasoningEffort?: string;
  serviceTier?: string;
  configuredRole: DiscourseParticipantRole;
  roleContractVersion: number;
  roleContractHash: string;
  revision: number;
  createdAt: string;
}

/** Immutable execution identity copied onto a job when its wave is planned. */
export interface AgentAssignmentSnapshot {
  stableParticipantId: string;
  participantRevisionId: string;
  agentProfileId: string;
  profileRevision: number;
  displayNameSnapshot: string;
  runtimeId: string;
  model: string;
  modelProvider: string;
  reasoningEffort?: string;
  serviceTier?: string;
  configuredRole: DiscourseParticipantRole;
  roleContractVersion: number;
  roleContractHash: string;
  assignmentRole: DiscourseAssignmentRole;
  required: boolean;
}

/** Durable handoff between accepted user input and fallible context/runtime preparation. */
export interface DiscourseAcceptedSendRecord {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  clientMessageId: string;
  policy: Exclude<DiscourseDefaultPolicy, 'NONE'>;
  assignments: AgentAssignmentSnapshot[];
  /** Exact bounded conversation window visible to every initial response job. */
  visibleMessageIds: string[];
  previewFingerprint: string;
  requestFingerprint: string;
  status: 'PENDING' | 'CANCELED';
  recordRevision: number;
  createdAt: string;
  canceledAt?: string;
}

export type DiscourseAssignmentRole =
  | 'PRIMARY'
  | 'REVIEWER'
  | 'PANELIST'
  | 'RESPONDENT'
  | 'SYNTHESIZER';

export type DiscourseMessageAuthor =
  | { kind: 'USER' }
  | {
      kind: 'AGENT';
      stableParticipantId: string;
      participantRevisionId: string;
      displayNameSnapshot: string;
    }
  | { kind: 'SYSTEM' };

export type DiscourseMessageFreshness = 'FRESH' | 'CHANGED_DURING_JOB' | 'UNKNOWN';

export interface DiscourseMessageRecord {
  id: string;
  conversationId: string;
  ordinal: number;
  author: DiscourseMessageAuthor;
  body: string;
  status: 'VISIBLE' | 'SUPERSEDED' | 'TOMBSTONE';
  replyToMessageId?: string;
  supersedesMessageId?: string;
  sourceMessageIds: string[];
  waveId?: string;
  jobId?: string;
  contextSnapshotId?: string;
  /** Frozen context selection for this message; later pin changes do not rewrite it. */
  contextRevisionId?: string;
  clientMessageId?: string;
  requestFingerprint?: string;
  freshnessAtCompletion?: DiscourseMessageFreshness;
  createdAt: string;
}

export type DiscourseContextEntityKind = 'TASK' | 'REPOSITORY';
export type DiscourseContextScope = 'MESSAGE' | 'PINNED';
export type DiscourseContextAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'TOMBSTONED';

/** A live ID-based reference. Filesystem paths never cross this boundary. */
interface ConversationContextLinkBase {
  id: string;
  conversationId: string;
  entityKind: DiscourseContextEntityKind;
  entityId: string;
  availability: DiscourseContextAvailability;
  recordRevision: number;
  createdAt: string;
  updatedAt: string;
}

export type ConversationContextLinkRecord =
  | (ConversationContextLinkBase & {
      scope: 'MESSAGE';
      createdByMessageId: string;
    })
  | (ConversationContextLinkBase & {
      scope: 'PINNED';
      createdByMessageId?: string;
    });

interface ConversationContextReferenceSnapshotBase {
  contextLinkId: string;
  entityKind: DiscourseContextEntityKind;
  entityId: string;
  labelSnapshot: string;
  availability: DiscourseContextAvailability;
}

export type ConversationContextReferenceSnapshot =
  | (ConversationContextReferenceSnapshotBase & {
      scope: 'MESSAGE';
      createdByMessageId: string;
    })
  | (ConversationContextReferenceSnapshotBase & {
      scope: 'PINNED';
      createdByMessageId?: string;
    });

export interface ConversationContextRevisionRecord {
  id: string;
  conversationId: string;
  revision: number;
  references: ConversationContextReferenceSnapshot[];
  createdAt: string;
}

export type ContextSnapshotStatus = 'RESOLVING' | 'READY' | 'PARTIAL' | 'BLOCKED';
export type ContextSourceAccessMode = 'FILESYSTEM_READ' | 'METADATA_ONLY' | 'UNAVAILABLE';

export interface ContextGenerationFingerprint {
  algorithm: string;
  value: string;
  components: string[];
}

export interface ContextSnapshotSourceRecord {
  contextLinkId: string;
  entityKind: DiscourseContextEntityKind;
  entityId: string;
  labelSnapshot: string;
  required: boolean;
  availability: DiscourseContextAvailability;
  accessMode: ContextSourceAccessMode;
  repositoryId?: string;
  worktreeId?: string;
  branch?: string;
  headSha?: string;
  generation?: ContextGenerationFingerprint;
  inspectedAt?: string;
  exclusionReasons: string[];
}

/**
 * Size of the reusable frozen-context baseline carried by a snapshot. The
 * input measures cover context references, background transcript, and summary
 * content only; trigger messages, exact targets, role instructions, and phase
 * output are assessed separately for every agent job before runtime creation.
 */
export interface ContextSnapshotBudgetRecord {
  inputBytes: number;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  sourceCount: number;
}

/**
 * Immutable manifest of what one wave resolved. It is not a repository copy and
 * intentionally contains no local filesystem path or attachment delivery path.
 */
interface ContextSnapshotBase {
  id: string;
  conversationId: string;
  waveId: string;
  contextRevisionId: string;
  recordRevision: number;
  sources: ContextSnapshotSourceRecord[];
  transcriptOrdinals: number[];
  summaryRevisionId?: string;
  attachmentIds: string[];
  permissionProfileHash?: string;
  budget: ContextSnapshotBudgetRecord;
  exclusions: string[];
  contextSchemaVersion: number;
  promptPolicyVersion: number;
  createdAt: string;
}

export type ContextSnapshotRecord = ContextSnapshotBase &
  (
    | { status: 'RESOLVING'; resolvedAt?: never; error?: never }
    | { status: 'READY' | 'PARTIAL'; resolvedAt: string; error?: never }
    | { status: 'BLOCKED'; resolvedAt: string; error: StructuredDiscourseError }
  );

export type DiscourseWaveStatus =
  | 'PLANNED'
  | 'SNAPSHOTTING'
  | 'QUEUED'
  | 'RUNNING'
  | 'STOP_REQUESTED'
  | 'STOPPING'
  | 'RECOVERY_REQUIRED'
  | 'SETTLED';

export type DiscourseWavePhase = 'ANSWER' | 'REVIEW' | 'CORRECT' | 'SYNTHESIZE' | 'COMPLETE';
export type DiscourseWaveOutcome =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'NO_RESPONSE'
  | 'CANCELED'
  | 'STALE'
  | 'FAILED';
export type DiscourseWaveSettlementReason =
  | 'COMPLETED'
  | 'USER_CANCELED'
  | 'SUPERSEDED'
  | 'STOPPED'
  | 'CONTEXT_CHANGED'
  | 'FAILED';

export interface DiscourseResponseWaveRecord {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  policy: DiscourseWavePolicy;
  policyVersion: number;
  assignments: AgentAssignmentSnapshot[];
  sourceMessageIds: string[];
  plannedContextRevisionId: string;
  contextSnapshotId?: string;
  attempt: number;
  recordRevision: number;
  status: DiscourseWaveStatus;
  phase?: DiscourseWavePhase;
  outcome?: DiscourseWaveOutcome;
  settlementReason?: DiscourseWaveSettlementReason;
  clientOperationId: string;
  requestFingerprint: string;
  dispatchGate:
    | {
        status: 'READY';
        previewFingerprint: string;
        confirmedAtRevision: number;
      }
    | {
        status: 'RECONFIRMATION_REQUIRED';
        previewFingerprint: string;
        currentFingerprint: string;
        mismatchReason: string;
      };
  createdAt: string;
  startedAt?: string;
  settledAt?: string;
}

export type CurrentDiscourseJobRole =
  | 'ANSWER'
  | 'CRITIQUE'
  | 'CORRECT';

export type LegacyDiscourseJobRole =
  | 'TARGETED_REPLY'
  | 'SYNTHESIZE'
  | 'COMPACT_HISTORY';

export type DiscourseJobRole = CurrentDiscourseJobRole | LegacyDiscourseJobRole;

export type DiscourseJobStatus =
  | 'QUEUED'
  | 'RESOLVING_CONTEXT'
  | 'STARTING'
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | 'RECOVERY_REQUIRED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED'
  | 'CONTEXT_STALE';

export type DiscourseDeliveryStatus =
  | 'NOT_SENT'
  | 'SENDING'
  | 'ACKNOWLEDGED'
  | 'NOT_DELIVERED'
  | 'AMBIGUOUS'
  | 'TERMINAL';

export type DiscourseReviewOutcome = 'CONCERNS' | 'NO_CONCERN_FOUND' | 'ABSTAINED';
export type DiscourseCorrectionOutcome =
  | 'REVISED'
  | 'DEFENDED'
  | 'PARTIALLY_REVISED'
  | 'ACKNOWLEDGED_UNRESOLVED'
  | 'ABSTAINED';

export type DiscourseJobResult =
  | { kind: 'CONTRIBUTION'; outputMessageId: string }
  | {
      kind: 'REVIEW';
      outcome: DiscourseReviewOutcome;
      reviewedScope: string;
      limitations: string[];
      requiredAccessAvailable: boolean;
      concernIds: string[];
      outputMessageId?: string;
    }
  | {
      kind: 'CORRECTION';
      outcome: DiscourseCorrectionOutcome;
      limitations: string[];
      outputMessageId?: string;
    }
  | { kind: 'COMPACTION'; summaryRevisionId: string };

export type StructuredDiscourseErrorCode =
  | 'CONTEXT_UNAVAILABLE'
  | 'CONTEXT_UNSAFE'
  | 'CONTEXT_TOO_LARGE'
  | 'CONTEXT_CHANGED'
  | 'PERMISSION_ATTESTATION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_INTERACTION_UNSUPPORTED'
  | 'DELIVERY_NOT_CONFIRMED'
  | 'DELIVERY_AMBIGUOUS'
  | 'INVALID_RESULT'
  | 'OUTPUT_MISSING'
  | 'INTERNAL_FAILURE';

export interface StructuredDiscourseError {
  code: StructuredDiscourseErrorCode;
  message: string;
  category: 'CONTEXT' | 'PERMISSION' | 'PROVIDER' | 'DELIVERY' | 'VALIDATION' | 'INTERNAL';
  retryable: boolean;
  detail?: string;
}

export interface DiscourseAgentJobRecord {
  id: string;
  conversationId: string;
  waveId: string;
  assignment: AgentAssignmentSnapshot;
  role: DiscourseJobRole;
  phase: number;
  targetMessageIds: string[];
  visibleMessageIds: string[];
  contextSnapshotId?: string;
  attemptId: string;
  generationKey: string;
  recordRevision: number;
  sessionId?: string;
  executionProfileHash?: string;
  runId?: string;
  status: DiscourseJobStatus;
  delivery: DiscourseDeliveryStatus;
  freshnessAtCompletion?: DiscourseMessageFreshness;
  result?: DiscourseJobResult;
  promptArtifactId?: string;
  outputArtifactId?: string;
  error?: StructuredDiscourseError;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type DiscourseConcernSeverity = 'ADVISORY' | 'MATERIAL' | 'BLOCKING';
export type DiscourseConcernConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type DiscourseConcernEvidenceStatus =
  | 'OBSERVED_CONTEXT'
  | 'CITED_SOURCE'
  | 'LOGICAL_CONTRADICTION'
  | 'SPECULATIVE';

export interface DiscourseConcernRecord {
  id: string;
  conversationId: string;
  waveId: string;
  reviewJobId: string;
  reviewerParticipantRevisionId: string;
  targetMessageId: string;
  targetClaim: string;
  category: string;
  severity: DiscourseConcernSeverity;
  confidence: DiscourseConcernConfidence;
  evidenceStatus: DiscourseConcernEvidenceStatus;
  reason: string;
  evidence: string;
  suggestedResolution: string;
  requiredAccessAvailable: boolean;
  redundantOfConcernId?: string;
  recordRevision: number;
  resolution?: {
    correctionJobId: string;
    correctionMessageId?: string;
    outcome: DiscourseCorrectionOutcome;
  };
  createdAt: string;
}

/** One eligibility rule is shared by orchestration and user-facing summaries. */
export function isEligibleDiscourseConcern(concern: DiscourseConcernRecord): boolean {
  return (
    !concern.redundantOfConcernId &&
    (concern.severity === 'MATERIAL' || concern.severity === 'BLOCKING') &&
    (concern.confidence === 'MEDIUM' || concern.confidence === 'HIGH') &&
    concern.evidenceStatus !== 'SPECULATIVE' &&
    concern.requiredAccessAvailable
  );
}

export interface DiscourseSummaryRecord {
  id: string;
  conversationId: string;
  revision: number;
  coveredOrdinalStart: number;
  coveredOrdinalEnd: number;
  sourceChecksum: string;
  runtimeId: string;
  model: string;
  promptVersion: number;
  body: string;
  createdAt: string;
}

export interface DiscourseDraftToken {
  id: string;
  kind: 'TASK' | 'REPOSITORY' | 'AGENT';
  entityId: string;
  labelSnapshot: string;
}

/**
 * Composer input intentionally omits the durable token id. The discourse
 * store derives that identity from the typed entity reference so renderer
 * keys never leak into the persisted contract.
 */
export type DiscourseDraftTokenInput = Omit<DiscourseDraftToken, 'id'>;

export interface DiscourseDraftRecord {
  id: string;
  conversationId?: string;
  recordRevision: number;
  body: string;
  replyToMessageId?: string;
  supersedesMessageId?: string;
  sourceMessageIds?: string[];
  policy: DiscourseDefaultPolicy;
  agentSelections?: DiscourseAgentSelectionInput[];
  /** Durable identity of an agent send that may already have been accepted. */
  pendingClientMessageId?: string;
  tokens: DiscourseDraftToken[];
  updatedAt: string;
}

export interface DiscourseContextSelection {
  entityKind: DiscourseContextEntityKind;
  entityId: string;
}

export interface DiscourseContextSelectionSnapshot extends DiscourseContextSelection {
  labelSnapshot: string;
  availability: DiscourseContextAvailability;
}

export interface DiscourseMentionTaskEntry {
  id: string;
  title: string;
  repositoryId?: string;
  repositoryName: string;
  workflowPhase: string;
  availability: DiscourseContextAvailability;
  archived: boolean;
}

export interface DiscourseMentionRepositoryEntry {
  id: string;
  displayName: string;
  displayPath: string;
  taskCount: number;
  availability: DiscourseContextAvailability;
  accessMode: ContextSourceAccessMode;
  unavailableReason?: string;
}

/** Bounded, renderer-safe discovery catalog. Paths are display-only, never authority. */
export interface DiscourseMentionCatalogSnapshot {
  agents: AgentProfileCatalogEntry[];
  runtimeCatalog: import('./agent').AgentRuntimeCatalog;
  tasks: DiscourseMentionTaskEntry[];
  repositories: DiscourseMentionRepositoryEntry[];
  refreshedAt: string;
}

/** Renderer-selected identity; core resolves provider/service details from the live catalog. */
export interface DiscourseAgentSelectionInput {
  agentProfileId: BuiltInAgentProfileId;
  runtimeId?: import('./agent').AgentRuntimeId;
  modelId?: string;
  reasoningEffort?: string;
}

export interface DiscourseContextPreviewReference
  extends DiscourseContextSelectionSnapshot {
  scope: DiscourseContextScope;
  repositoryId?: string;
  repositoryName?: string;
  taskTitle?: string;
  taskWorkflowPhase?: string;
  accessMode: ContextSourceAccessMode;
  exclusionReasons: string[];
}

export interface DiscourseContextPreview {
  fingerprint: string;
  expiresAt: string;
  references: DiscourseContextPreviewReference[];
  deduplicatedRepositoryIds: string[];
  filesystemRootCount: number;
  metadataOnly: boolean;
  policy: {
    filesystem: 'READ_ONLY';
    writes: false;
    network: false;
    externalTools: false;
    approvals: 'NEVER';
  };
  exclusions: string[];
}

export interface CreateDiscourseConversationRequest {
  title: string;
  defaultPolicy: DiscourseDefaultPolicy;
  agents: DiscourseAgentSelectionInput[];
  clientOperationId: string;
}

export interface AppendHumanDiscourseMessageRequest {
  conversationId: string;
  body: string;
  replyToMessageId?: string;
  supersedesMessageId?: string;
  sourceMessageIds?: string[];
  context: DiscourseContextSelection[];
  clientMessageId: string;
}

export interface SendDiscourseMessageRequest
  extends AppendHumanDiscourseMessageRequest {
  policy: DiscourseDefaultPolicy;
  agents: DiscourseAgentSelectionInput[];
  previewFingerprint?: string;
}

export interface SendDiscourseMessageResult {
  message: DiscourseMessageRecord;
  wave?: DiscourseResponseWaveRecord;
  jobs: DiscourseAgentJobRecord[];
}

export interface ResumeDiscourseAcceptedSendRequest {
  conversationId: string;
  acceptedSendId: string;
}

export interface CancelDiscourseAcceptedSendRequest {
  conversationId: string;
  acceptedSendId: string;
  expectedConversationRevision: number;
  clientOperationId: string;
}

export interface ConfirmDiscourseWaveContextRequest {
  conversationId: string;
  waveId: string;
  previewFingerprint: string;
  expectedWaveRevision: number;
  clientOperationId: string;
}

export interface StopDiscourseWaveRequest {
  conversationId: string;
  waveId: string;
  clientOperationId: string;
  reason: string;
}

export interface SetPinnedDiscourseContextRequest {
  conversationId: string;
  context: DiscourseContextSelection[];
  expectedRevision: number;
  clientOperationId: string;
}

export interface SaveDiscourseDraftRequest {
  draftId?: string;
  conversationId?: string;
  expectedRevision?: number;
  body: string;
  replyToMessageId?: string;
  supersedesMessageId?: string;
  sourceMessageIds?: string[];
  policy: DiscourseDefaultPolicy;
  agentSelections?: DiscourseAgentSelectionInput[];
  pendingClientMessageId?: string;
  tokens: DiscourseDraftTokenInput[];
}

export interface DeleteDiscourseDraftRequest {
  draftId: string;
  expectedRevision: number;
}

export interface TombstoneDiscourseMessageRequest {
  conversationId: string;
  messageId: string;
  expectedConversationRevision: number;
  clientOperationId: string;
}

export interface RenameDiscourseConversationRequest {
  conversationId: string;
  title: string;
  expectedRevision: number;
  clientOperationId: string;
}

export interface SetDiscourseConversationReadRequest {
  conversationId: string;
  readOrdinal: number;
  expectedRevision: number;
  clientOperationId: string;
}

export interface SetDiscourseConversationArchivedRequest {
  conversationId: string;
  archived: boolean;
  expectedRevision: number;
  clientOperationId: string;
}

export interface DeleteDiscourseConversationRequest {
  conversationId: string;
  expectedRevision: number;
  clientOperationId: string;
}

export interface ListDiscourseConversationsRequest {
  status?: DiscourseConversationStatus;
  cursor?: string;
  limit?: number;
}

export interface ListDiscourseMessagesRequest {
  conversationId: string;
  beforeCursor?: string;
  limit?: number;
}

export interface GetDiscourseMessageByClientIdRequest {
  conversationId: string;
  clientMessageId: string;
}

export interface PreviewDiscourseContextRequest {
  conversationId?: string;
  messageContext: DiscourseContextSelection[];
}

export type DiscourseAuditEventType =
  | 'CONVERSATION_CREATED'
  | 'CONVERSATION_UPDATED'
  | 'MESSAGE_APPENDED'
  | 'CONTEXT_RESOLVED'
  | 'WAVE_TRANSITIONED'
  | 'JOB_TRANSITIONED'
  | 'DELIVERY_TRANSITIONED'
  | 'RECOVERY_DECIDED'
  | 'CONVERSATION_DELETED';

export type DiscourseJsonValue =
  | null
  | boolean
  | number
  | string
  | DiscourseJsonValue[]
  | { [key: string]: DiscourseJsonValue };

export interface DiscourseAuditEventRecord {
  id: string;
  conversationId: string;
  waveId?: string;
  jobId?: string;
  type: DiscourseAuditEventType;
  payload: Record<string, DiscourseJsonValue>;
  at: string;
}

export type DiscourseIdempotencyDecision = 'NEW' | 'REPLAY';

export const DISCOURSE_STORE_SCHEMA_VERSION = 1 as const;

export interface DiscourseConversationSummary {
  id: string;
  title: string;
  status: DiscourseConversationStatus;
  defaultPolicy: DiscourseDefaultPolicy;
  participantIds: string[];
  latestOrdinal: number;
  readOrdinal: number;
  unreadCount: number;
  needsAttention: boolean;
  activeWaveCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  archivedAt?: string;
}

export interface DiscourseConversationTombstoneRecord {
  conversationId: string;
  deletedAt: string;
  clientOperationId: string;
  requestFingerprint: string;
  lastEventSequence: number;
}

export interface DiscourseConversationAggregateRecord {
  conversation: DiscourseConversationRecord;
  participants: DiscourseParticipantRecord[];
  participantRevisions: DiscourseParticipantRevisionRecord[];
  acceptedSends: DiscourseAcceptedSendRecord[];
  contextLinks: ConversationContextLinkRecord[];
  contextRevisions: ConversationContextRevisionRecord[];
  contextSnapshots: ContextSnapshotRecord[];
  waves: DiscourseResponseWaveRecord[];
  jobs: DiscourseAgentJobRecord[];
  concerns: DiscourseConcernRecord[];
  summaries: DiscourseSummaryRecord[];
  drafts: DiscourseDraftRecord[];
  latestEventSequence: number;
}

export interface DiscourseConversationPage {
  conversations: DiscourseConversationSummary[];
  nextCursor?: string;
}

export interface DiscourseMessagePage {
  messages: DiscourseMessageRecord[];
  previousCursor?: string;
}
