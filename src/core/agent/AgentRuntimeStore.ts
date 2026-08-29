import type {
  AgentRuntimeGoalSnapshotRecord,
  AgentExecutionContext,
  AgentRuntimeInteractionRecord,
  AgentRuntimeItemRecord,
  AgentRuntimePlanRevisionRecord,
  AgentRuntimeSettingsObservationRecord,
  AgentRuntimeSubagentObservationRecord,
  AgentRuntimeUsageSnapshotRecord,
  AgentOwnerScope,
  AgentRuntimeArtifactKind,
  AgentRuntimeArtifactRecord,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord,
  AgentRuntimeStoreState,
  AgentRuntimeTelemetryKind,
  AgentRuntimeTelemetryRecord,
  AgentSchedulerPriority,
  AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';
import type {
  AgentGoalSnapshotRecord,
  AgentExecutionSettings,
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentProtocolMessageReference,
  AgentServerInstance,
  AgentRunMode,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentSubagentObservationRecord,
  AgentSubagentStatus,
  AgentUsageSnapshotRecord,
  InteractionRequestRecord,
  InteractionRequestStatus
} from '../../shared/agent';
import type { ArtifactRecord, DomainEvent, RunRecord } from '../../shared/contracts';

export interface CreateAgentRuntimeServerInput {
  runtimeId: AgentServerInstance['runtimeId'];
  runtimeKind: AgentServerInstance['runtimeKind'];
  transport: AgentServerInstance['transport'];
  executable: string;
  argv: string[];
  runtimeVersion?: string;
  schemaVersion?: string;
  schemaHash?: string;
  runtimeResolution?: AgentServerInstance['runtimeResolution'];
}

export class AgentRuntimeArtifactMutationAmbiguousError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentRuntimeArtifactMutationAmbiguousError';
  }
}

export type TaskRuntimeEventSink = (
  event: DomainEvent,
  operationId: string
) => Promise<void>;

export interface AgentProviderRuntimeStore {
  createAgentServer(
    input: CreateAgentRuntimeServerInput
  ): Promise<AgentServerInstance>;
  listAgentServers(): Promise<AgentServerInstance[]>;
  getAgentServer(serverInstanceId: string): Promise<AgentServerInstance | undefined>;
  updateAgentServer(
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
  ): Promise<AgentServerInstance>;
  appendProtocolMessage(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference>;
  readProtocolMessage(reference: AgentProtocolMessageReference): Promise<{
    raw: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface CreateRuntimeSessionInput
  extends Omit<
    AgentRuntimeSessionRecord,
    | 'recordRevision'
    | 'requestFingerprint'
    | 'createdAt'
    | 'updatedAt'
    | 'lastAttachedAt'
  > {}

export interface CreateRuntimeRunInput
  extends Omit<
    AgentRuntimeRunRecord,
    | 'recordRevision'
    | 'requestFingerprint'
    | 'status'
    | 'delivery'
    | 'interruptDelivery'
    | 'recoveryState'
    | 'createdAt'
    | 'startedAt'
    | 'stopRequestedAt'
    | 'lastEventAt'
    | 'endedAt'
  > {}

export interface CreateObservedRuntimeRunInput extends CreateRuntimeRunInput {
  serverInstanceId: string;
  providerTurnId: string;
  startedAt: string;
}

export interface PrepareRuntimeTurnStoreInput {
  session: CreateRuntimeSessionInput;
  run: CreateRuntimeRunInput;
  prompt: string;
  priority: AgentSchedulerPriority;
  queueOperationId: string;
  notBefore?: string;
}

export interface PreparedRuntimeTurnRecords {
  session: AgentRuntimeSessionRecord;
  run: AgentRuntimeRunRecord;
  queueEntry: AgentSchedulerQueueEntry;
}

export type CreateRuntimeItemInput = Omit<
  AgentRuntimeItemRecord,
  'id' | 'requestFingerprint' | 'recordRevision' | 'createdAt' | 'updatedAt'
> & { id?: string };

export type CreateRuntimeInteractionInput = Omit<
  AgentRuntimeInteractionRecord,
  | 'id'
  | 'status'
  | 'requestFingerprint'
  | 'recordRevision'
  | 'requestedAt'
>;

export type RuntimeInteractionUpdate = Partial<
  Pick<
    AgentRuntimeInteractionRecord,
    | 'status'
    | 'decision'
    | 'responseRawMessage'
    | 'resolution'
    | 'respondedAt'
    | 'resolvedAt'
  >
>;

export type CreateRuntimeGoalSnapshotInput = Omit<
  AgentRuntimeGoalSnapshotRecord,
  'id' | 'requestFingerprint' | 'recordRevision' | 'observedAt'
>;

export type CreateRuntimePlanRevisionInput = Omit<
  AgentRuntimePlanRevisionRecord,
  'id' | 'requestFingerprint' | 'recordRevision' | 'revision' | 'observedAt'
>;

export type CreateRuntimeUsageSnapshotInput = Omit<
  AgentRuntimeUsageSnapshotRecord,
  'id' | 'requestFingerprint' | 'recordRevision' | 'observedAt'
>;

export type CreateRuntimeSettingsObservationInput = Omit<
  AgentRuntimeSettingsObservationRecord,
  'id' | 'requestFingerprint' | 'recordRevision' | 'observedAt'
>;

export type CreateRuntimeSubagentObservationInput = Omit<
  AgentRuntimeSubagentObservationRecord,
  'id' | 'requestFingerprint' | 'recordRevision' | 'observedAt'
>;

export interface TaskAgentRuntimeSnapshot {
  runs: RunRecord[];
  agentServers: AgentServerInstance[];
  agentSessions: AgentSessionRecord[];
  agentItems: AgentItemRecord[];
  agentGoalSnapshots: AgentGoalSnapshotRecord[];
  agentPlanRevisions: AgentPlanRevisionRecord[];
  agentUsageSnapshots: AgentUsageSnapshotRecord[];
  agentSettingsObservations: AgentSettingsObservationRecord[];
  agentSubagentObservations: AgentSubagentObservationRecord[];
  interactionRequests: InteractionRequestRecord[];
  artifacts: ArtifactRecord[];
}

export interface TaskObserveSubagentInput {
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

export interface TaskCreateObservedSubagentRunInput {
  session: AgentSessionRecord;
  providerTurnId: string;
  serverInstanceId: string;
  parentRunId?: string;
  prompt?: string;
  requestedSettings?: AgentExecutionSettings;
}

export interface CreateTaskRuntimeSessionInput {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  worktreePath: string;
  runtimeId: string;
  role?: AgentSessionRecord['role'];
  requestedSettings: AgentExecutionSettings;
  executionContext: AgentExecutionContext;
  operationId: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
}

export interface CreateTaskRuntimeRunInput {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  sessionId: string;
  mode: AgentRunMode;
  prompt: string;
  generationKey?: string;
  requestedSettings?: AgentExecutionSettings;
  beforeGitSnapshotId?: string;
  retryOfRunId?: string;
  continuedFromRunId?: string;
  reviewTarget?: import('../../shared/agent').AgentReviewTarget;
  instructionProfile?: import('../../shared/agent').AgentInstructionProfile;
  operationId: string;
}

/**
 * Runtime-only Task view used by Task orchestration and provider adapters. It
 * intentionally has no Task, Git, attachment, or domain-store operations.
 */
export interface TaskAgentRuntimeAccess {
  snapshot(): Promise<TaskAgentRuntimeSnapshot>;
  createTaskSession(input: CreateTaskRuntimeSessionInput): Promise<AgentSessionRecord>;
  createTaskRun(input: CreateTaskRuntimeRunInput): Promise<RunRecord>;
  getAgentSession(sessionId: string): Promise<AgentSessionRecord | undefined>;
  getAgentSessionByProviderId(
    runtimeId: string,
    providerSessionId: string
  ): Promise<AgentSessionRecord | undefined>;
  updateAgentSession(
    sessionId: string,
    update: Partial<AgentSessionRecord>,
    operationId: string
  ): Promise<AgentSessionRecord>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  getRunByProviderTurnId(
    runtimeId: string,
    providerTurnId: string
  ): Promise<RunRecord | undefined>;
  getActiveRunForSession(sessionId: string): Promise<RunRecord | undefined>;
  getRunsRequiringRecovery(options?: {
    includeQueued?: boolean;
    runtimeId?: string;
  }): Promise<RunRecord[]>;
  updateRun(
    runId: string,
    update: Partial<RunRecord>,
    operationId: string
  ): Promise<RunRecord>;
  getAgentItemsForRun(runId: string): Promise<AgentItemRecord[]>;
  getAgentItemByProviderId(
    runId: string,
    providerItemId: string
  ): Promise<AgentItemRecord | undefined>;
  upsertAgentItem(
    item: Omit<AgentItemRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
    operationId: string
  ): Promise<AgentItemRecord>;
  getInteractionRequest(id: string): Promise<InteractionRequestRecord | undefined>;
  getInteractionRequestByProviderId(
    serverInstanceId: string,
    providerRequestId: string | number
  ): Promise<InteractionRequestRecord | undefined>;
  createInteractionRequest(
    input: Omit<InteractionRequestRecord, 'id' | 'status' | 'requestedAt'>,
    operationId: string
  ): Promise<InteractionRequestRecord>;
  transitionInteractionRequest(
    id: string,
    expectedStatus: InteractionRequestStatus,
    update: RuntimeInteractionUpdate,
    operationId: string
  ): Promise<InteractionRequestRecord>;
  getLatestAgentGoalSnapshot(
    sessionId: string
  ): Promise<AgentGoalSnapshotRecord | undefined>;
  recordAgentGoalSnapshot(
    record: Omit<AgentGoalSnapshotRecord, 'id' | 'observedAt'>,
    operationId: string
  ): Promise<AgentGoalSnapshotRecord>;
  recordAgentPlanRevision(
    record: Omit<AgentPlanRevisionRecord, 'id' | 'revision' | 'observedAt'>,
    operationId: string
  ): Promise<AgentPlanRevisionRecord>;
  recordAgentUsageSnapshot(
    record: Omit<AgentUsageSnapshotRecord, 'id' | 'observedAt'>,
    operationId: string
  ): Promise<AgentUsageSnapshotRecord>;
  recordAgentSettingsObservation(
    record: Omit<AgentSettingsObservationRecord, 'id' | 'observedAt'>,
    operationId: string
  ): Promise<AgentSettingsObservationRecord>;
  recordAgentSubagentObservation(
    record: Omit<AgentSubagentObservationRecord, 'id' | 'observedAt'>,
    operationId: string
  ): Promise<AgentSubagentObservationRecord>;
  observeSubagent(
    input: TaskObserveSubagentInput,
    operationId: string
  ): Promise<{
    session: AgentSessionRecord;
    observation: AgentSubagentObservationRecord;
  }>;
  createObservedSubagentRun(
    input: TaskCreateObservedSubagentRunInput,
    operationId: string
  ): Promise<RunRecord>;
  appendArtifact(
    artifactId: string,
    chunk: string,
    operationId: string
  ): Promise<AgentRuntimeArtifactRecord>;
  writeFinalArtifact(
    taskId: string,
    runId: string,
    content: string,
    operationId: string
  ): Promise<AgentRuntimeArtifactRecord>;
  applyTaskRuntimeEvent(event: DomainEvent, operationId: string): Promise<void>;
  applyTaskRuntimeEventIfRunStatus(
    event: DomainEvent,
    statuses: readonly RunRecord['status'][],
    operationId: string
  ): Promise<boolean>;
}

export interface AgentRuntimeStore extends AgentProviderRuntimeStore {
  init(): Promise<void>;
  close(): Promise<void>;
  snapshot(): Promise<AgentRuntimeStoreState>;
  createSession(input: CreateRuntimeSessionInput): Promise<AgentRuntimeSessionRecord>;
  createRun(input: CreateRuntimeRunInput): Promise<AgentRuntimeRunRecord>;
  createObservedRun(
    input: CreateObservedRuntimeRunInput
  ): Promise<AgentRuntimeRunRecord>;
  prepareRuntimeTurn(
    input: PrepareRuntimeTurnStoreInput
  ): Promise<PreparedRuntimeTurnRecords>;
  getSession(sessionId: string): Promise<AgentRuntimeSessionRecord | undefined>;
  getSessionByProviderId(
    providerSessionId: string,
    runtimeId?: string
  ): Promise<AgentRuntimeSessionRecord | undefined>;
  updateSession(
    sessionId: string,
    expectedRevision: number,
    update: Partial<
      Pick<
        AgentRuntimeSessionRecord,
        | 'providerSessionId'
        | 'providerSessionTreeId'
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
  ): Promise<AgentRuntimeSessionRecord>;
  getRun(runId: string): Promise<AgentRuntimeRunRecord | undefined>;
  getRunByProviderTurnId(
    providerTurnId: string,
    runtimeId?: string
  ): Promise<AgentRuntimeRunRecord | undefined>;
  getActiveRunForSession(sessionId: string): Promise<AgentRuntimeRunRecord | undefined>;
  getRunsRequiringRecovery(options?: {
    includeQueued?: boolean;
    runtimeId?: string;
    owner?: AgentOwnerScope;
  }): Promise<AgentRuntimeRunRecord[]>;
  listRunsByOwner(owner: AgentOwnerScope): Promise<AgentRuntimeRunRecord[]>;
  createArtifact(input: {
    id: string;
    owner: AgentOwnerScope;
    runId: string;
    kind: AgentRuntimeArtifactKind;
    clientOperationId: string;
    content: string;
  }): Promise<AgentRuntimeArtifactRecord>;
  updateArtifact(input: {
    artifactId: string;
    expectedRevision: number;
    clientOperationId: string;
    content: string;
  }): Promise<AgentRuntimeArtifactRecord>;
  getArtifact(artifactId: string): Promise<AgentRuntimeArtifactRecord | undefined>;
  readArtifact(artifactId: string): Promise<string>;
  recordTelemetry(input: {
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
  }): Promise<AgentRuntimeTelemetryRecord>;
  listTelemetryByOwner(owner: AgentOwnerScope): Promise<AgentRuntimeTelemetryRecord[]>;
  updateRun(
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
  ): Promise<AgentRuntimeRunRecord>;
  upsertItem(input: CreateRuntimeItemInput): Promise<AgentRuntimeItemRecord>;
  listItemsForRun(runId: string): Promise<AgentRuntimeItemRecord[]>;
  getItemByProviderId(
    runId: string,
    providerItemId: string
  ): Promise<AgentRuntimeItemRecord | undefined>;
  createInteraction(
    input: CreateRuntimeInteractionInput
  ): Promise<AgentRuntimeInteractionRecord>;
  getInteraction(id: string): Promise<AgentRuntimeInteractionRecord | undefined>;
  getInteractionByProviderId(
    serverInstanceId: string,
    providerRequestId: string | number
  ): Promise<AgentRuntimeInteractionRecord | undefined>;
  updateInteraction(
    id: string,
    expectedRevision: number,
    expectedStatus: InteractionRequestStatus,
    update: RuntimeInteractionUpdate,
    operationId: string
  ): Promise<AgentRuntimeInteractionRecord>;
  listInteractionsByOwner(owner: AgentOwnerScope): Promise<AgentRuntimeInteractionRecord[]>;
  recordGoalSnapshot(
    input: CreateRuntimeGoalSnapshotInput
  ): Promise<AgentRuntimeGoalSnapshotRecord>;
  getLatestGoalSnapshot(
    sessionId: string
  ): Promise<AgentRuntimeGoalSnapshotRecord | undefined>;
  recordPlanRevision(
    input: CreateRuntimePlanRevisionInput
  ): Promise<AgentRuntimePlanRevisionRecord>;
  recordUsageSnapshot(
    input: CreateRuntimeUsageSnapshotInput
  ): Promise<AgentRuntimeUsageSnapshotRecord>;
  recordSettingsObservation(
    input: CreateRuntimeSettingsObservationInput
  ): Promise<AgentRuntimeSettingsObservationRecord>;
  recordSubagentObservation(
    input: CreateRuntimeSubagentObservationInput
  ): Promise<AgentRuntimeSubagentObservationRecord>;
  appendArtifact(
    artifactId: string,
    chunk: string,
    operationId: string
  ): Promise<AgentRuntimeArtifactRecord>;
  writeFinalArtifact(input: {
    artifactId: string;
    owner: AgentOwnerScope;
    runId: string;
    clientOperationId: string;
    content: string;
  }): Promise<AgentRuntimeArtifactRecord>;
  taskAgentRuntimeAccess(eventSink?: TaskRuntimeEventSink): TaskAgentRuntimeAccess;
  enqueueRun(
    runId: string,
    priority: AgentSchedulerPriority,
    operationId: string,
    notBefore?: string
  ): Promise<AgentSchedulerQueueEntry>;
  leaseQueueEntry(
    entryId: string,
    expectedRevision: number,
    operationId: string
  ): Promise<AgentSchedulerQueueEntry>;
  releaseQueueEntry(
    entryId: string,
    expectedRevision: number,
    operationId: string
  ): Promise<AgentSchedulerQueueEntry>;
  cancelQueueEntry(
    entryId: string,
    expectedRevision: number,
    reason: string,
    operationId: string
  ): Promise<AgentSchedulerQueueEntry>;
  settleQueueEntry(
    entryId: string,
    expectedRevision: number,
    operationId: string
  ): Promise<AgentSchedulerQueueEntry>;
  purgeDiscourseConversation(
    conversationId: string
  ): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }>;
  purgeTask(taskId: string): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }>;
  purgePromptRefinement(requestId: string): Promise<{
    sessionCount: number;
    runCount: number;
    artifactCount: number;
    queueEntryCount: number;
  }>;
  setShutdownLatched(latched: boolean, operationId: string): Promise<void>;
}
