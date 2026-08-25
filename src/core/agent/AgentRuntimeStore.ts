import type {
  AgentOwnerScope,
  AgentRuntimeArtifactKind,
  AgentRuntimeArtifactRecord,
  AgentRuntimeMigrationRecord,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord,
  AgentRuntimeStoreState,
  AgentRuntimeTelemetryKind,
  AgentRuntimeTelemetryRecord,
  AgentSchedulerPriority,
  AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';
import type {
  AgentProtocolMessageReference,
  AgentServerInstance
} from '../../shared/agent';

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

export interface AgentRuntimeStore extends AgentProviderRuntimeStore {
  init(): Promise<void>;
  close(): Promise<void>;
  snapshot(): Promise<AgentRuntimeStoreState>;
  getTaskStoreV11Migration(): Promise<AgentRuntimeMigrationRecord | undefined>;
  recordTaskStoreV11Migration(input: {
    sourceSha256: string;
    sessionCount: number;
    runCount: number;
    operationId: string;
  }): Promise<AgentRuntimeMigrationRecord>;
  createSession(input: CreateRuntimeSessionInput): Promise<AgentRuntimeSessionRecord>;
  createRun(input: CreateRuntimeRunInput): Promise<AgentRuntimeRunRecord>;
  createObservedRun(
    input: CreateObservedRuntimeRunInput
  ): Promise<AgentRuntimeRunRecord>;
  getSession(sessionId: string): Promise<AgentRuntimeSessionRecord | undefined>;
  getSessionByProviderId(
    providerSessionId: string
  ): Promise<AgentRuntimeSessionRecord | undefined>;
  updateSession(
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
  ): Promise<AgentRuntimeSessionRecord>;
  getRun(runId: string): Promise<AgentRuntimeRunRecord | undefined>;
  getRunByProviderTurnId(
    providerTurnId: string
  ): Promise<AgentRuntimeRunRecord | undefined>;
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
        | 'finalArtifactId'
        | 'startedAt'
        | 'stopRequestedAt'
        | 'lastEventAt'
        | 'endedAt'
      >
    >,
    operationId: string
  ): Promise<AgentRuntimeRunRecord>;
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
  setShutdownLatched(latched: boolean, operationId: string): Promise<void>;
}
