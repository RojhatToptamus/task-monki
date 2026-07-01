export type AgentProviderId = string;

export type CapabilityMaturity =
  | 'stable'
  | 'experimental'
  | 'inferred'
  | 'unsupported';

export interface AgentCapability {
  maturity: CapabilityMaturity;
  detail?: string;
}

export interface AgentProviderCapabilities {
  provider: AgentProviderId;
  modelCatalog: AgentCapability;
  reasoningEffort: AgentCapability;
  persistentSessions: AgentCapability;
  sessionResume: AgentCapability;
  sessionFork: AgentCapability;
  activeTurnSteering: AgentCapability;
  turnInterruption: AgentCapability;
  truePause: AgentCapability;
  interactiveApprovals: AgentCapability;
  userInputRequests: AgentCapability;
  goals: AgentCapability;
  plans: AgentCapability;
  review: AgentCapability;
  subagents: AgentCapability;
  backgroundTerminals: AgentCapability;
  dynamicTools: AgentCapability;
}

export type AgentRunStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'AWAITING_USER_INPUT'
  | 'INTERRUPTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'RECOVERY_REQUIRED'
  | 'LOST';

export type AgentRunMode =
  | 'ANALYSIS'
  | 'IMPLEMENTATION'
  | 'FOLLOW_UP'
  | 'RETRY'
  | 'REVIEW'
  | 'COMPACTION'
  | 'SUBAGENT';

export type AgentRunOrigin = 'TASK_MONKI' | 'PROVIDER_SUBAGENT';

export type AgentRecoveryState =
  | 'NONE'
  | 'RECONCILING'
  | 'RECOVERED'
  | 'REQUIRES_USER_ACTION'
  | 'UNRECOVERABLE';

export type AgentRuntimeKind = 'APP_SERVER';
export type AgentTransport = 'STDIO' | 'UNIX_SOCKET' | 'IN_PROCESS';
export type AgentServerStatus =
  | 'STARTING'
  | 'READY'
  | 'RUNNING'
  | 'DEGRADED'
  | 'STOPPING'
  | 'EXITED'
  | 'FAILED'
  | 'LOST';

export type AgentSessionRole = 'PRIMARY' | 'ALTERNATIVE' | 'REVIEW' | 'SUBAGENT';
export type AgentSessionRelationshipState =
  | 'ROOT'
  | 'RESOLVED'
  | 'UNRESOLVED'
  | 'CONTRADICTORY';
export type AgentSubagentStatus =
  | 'PENDING_INIT'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'COMPLETED'
  | 'ERRORED'
  | 'SHUTDOWN'
  | 'NOT_FOUND'
  | 'UNKNOWN';
export type AgentSubagentObservationSource =
  | 'THREAD_STARTED_PARENT'
  | 'THREAD_STARTED_FORK'
  | 'THREAD_STARTED_SOURCE'
  | 'COLLAB_RECEIVER'
  | 'COLLAB_STATE'
  | 'SUBAGENT_ACTIVITY';
export type AgentSessionStatus =
  | 'NOT_MATERIALIZED'
  | 'NOT_LOADED'
  | 'IDLE'
  | 'ACTIVE'
  | 'AWAITING_APPROVAL'
  | 'AWAITING_USER_INPUT'
  | 'SYSTEM_ERROR'
  | 'ARCHIVED'
  | 'DELETED'
  | 'UNKNOWN';

export interface AgentExecutionSettings {
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  sandbox?: 'READ_ONLY' | 'WORKSPACE_WRITE' | 'DANGER_FULL_ACCESS';
  networkAccess?: boolean;
  approvalPolicy?: string;
}

export type CodexWebSearchMode = 'disabled' | 'cached' | 'live';
export type CodexMcpServersMode = 'disabled' | 'all';
export type CodexAppsMode = 'disabled' | 'enabled';

export interface CodexExternalToolSettings {
  webSearchMode: CodexWebSearchMode;
  mcpServers: CodexMcpServersMode;
  apps: CodexAppsMode;
}

export interface ExternalExecutablePathSettings {
  gitExecutablePath: string | null;
  codexExecutablePath: string | null;
  ghExecutablePath: string | null;
}

export type TaskManagerThemePreference = 'light' | 'dark' | 'device';

export interface TaskManagerRepositorySettings {
  knownPaths: string[];
  selectedPath: string | null;
}

export interface TaskManagerAppSettings {
  schemaVersion: 1;
  theme: TaskManagerThemePreference;
  sidebarCollapsed: boolean;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  promptRefinementModel?: string;
  reviewModel?: string;
  reviewReasoningEffort?: string;
  codexExternalTools: CodexExternalToolSettings;
  externalExecutables: ExternalExecutablePathSettings;
  repositories: TaskManagerRepositorySettings;
}

export const DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS: CodexExternalToolSettings = {
  webSearchMode: 'disabled',
  mcpServers: 'disabled',
  apps: 'disabled'
};

export const DEFAULT_EXTERNAL_EXECUTABLE_PATH_SETTINGS: ExternalExecutablePathSettings = {
  gitExecutablePath: null,
  codexExecutablePath: null,
  ghExecutablePath: null
};

export const DEFAULT_PROMPT_REFINEMENT_MODEL = 'gpt-5.3-codex-spark';

export const DEFAULT_TASK_MANAGER_APP_SETTINGS: TaskManagerAppSettings = {
  schemaVersion: 1,
  theme: 'device',
  sidebarCollapsed: false,
  codexExternalTools: DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
  externalExecutables: DEFAULT_EXTERNAL_EXECUTABLE_PATH_SETTINGS,
  repositories: {
    knownPaths: [],
    selectedPath: null
  }
};

export type AgentObservationSource =
  | 'THREAD_START_RESPONSE'
  | 'THREAD_RESUME_RESPONSE'
  | 'THREAD_FORK_RESPONSE'
  | 'THREAD_SETTINGS_NOTIFICATION'
  | 'MODEL_REROUTED_NOTIFICATION'
  | 'RECOVERY_RESUME_RESPONSE';

export interface AgentSettingsObservationRecord {
  id: string;
  taskId: string;
  iterationId: string;
  sessionId: string;
  runId?: string;
  provider: AgentProviderId;
  source: AgentObservationSource;
  settings: AgentExecutionSettings;
  detail?: string;
  rawMessage?: AgentProtocolMessageReference;
  observedAt: string;
}

export type AgentGoalSyncState =
  | 'IN_SYNC'
  | 'DIVERGED'
  | 'CLEARED'
  | 'SYNC_FAILED'
  | 'UNKNOWN';

export type AgentGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete';

export type AgentGoalObservationSource =
  | 'TASK_MONKI_SYNC'
  | 'PROVIDER_NOTIFICATION'
  | 'PROVIDER_CLEARED'
  | 'SYNC_ERROR';

export interface AgentGoalSnapshotRecord {
  id: string;
  taskId: string;
  iterationId: string;
  sessionId: string;
  provider: AgentProviderId;
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

export interface AgentPlanStep {
  step: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
}

export interface AgentPlanRevisionRecord {
  id: string;
  taskId: string;
  iterationId: string;
  runId: string;
  sessionId: string;
  provider: AgentProviderId;
  revision: number;
  explanation?: string;
  steps: AgentPlanStep[];
  rawMessage: AgentProtocolMessageReference;
  observedAt: string;
}

export interface AgentTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface AgentUsageSnapshotRecord {
  id: string;
  taskId: string;
  iterationId: string;
  sessionId: string;
  runId?: string;
  provider: AgentProviderId;
  total: AgentTokenUsageBreakdown;
  last: AgentTokenUsageBreakdown;
  modelContextWindow?: number;
  rawMessage: AgentProtocolMessageReference;
  observedAt: string;
}

export type AgentReviewTarget =
  | { type: 'UNCOMMITTED_CHANGES' }
  | { type: 'BASE_BRANCH'; branch: string }
  | { type: 'COMMIT'; sha: string; title?: string }
  | { type: 'CUSTOM'; instructions: string };

export type AgentRetryStrategy = 'SAME_SESSION' | 'FORK';

export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };

export interface AgentRuntimeProbeDiagnostic {
  executable: string;
  source: string;
  explicit: boolean;
  compatible: boolean;
  version?: string;
  launchArgv?: string[];
  launchForm?: string;
  missingCapabilities?: string[];
  detail: string;
}

export interface AgentRuntimeResolutionDiagnostics {
  selectedExecutable: string;
  selectedSource: string;
  selectedVersion?: string;
  selectedLaunchArgv?: string[];
  requiredCapabilities: string[];
  probes: AgentRuntimeProbeDiagnostic[];
}

export interface AgentServerInstance {
  id: string;
  provider: AgentProviderId;
  runtimeKind: AgentRuntimeKind;
  transport: AgentTransport;
  status: AgentServerStatus;
  executable: string;
  argv: string[];
  pid?: number;
  runtimeVersion?: string;
  schemaVersion?: string;
  schemaHash?: string;
  runtimeResolution?: AgentRuntimeResolutionDiagnostics;
  protocolJournalPath: string;
  startedAt: string;
  initializedAt?: string;
  lastHealthAt?: string;
  disconnectedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  exitReason?: string;
}

export interface AgentSessionRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
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
  worktreePath: string;
  status: AgentSessionStatus;
  materialized: boolean;
  requestedSettings: AgentExecutionSettings;
  observedSettings?: AgentExecutionSettings;
  ownership: 'TASK_MONKI';
  createdAt: string;
  updatedAt: string;
  lastAttachedAt?: string;
}

export interface AgentSubagentObservationRecord {
  id: string;
  taskId: string;
  iterationId: string;
  sessionId: string;
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

export type AgentItemStatus =
  | 'STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'DECLINED'
  | 'INTERRUPTED'
  | 'UNKNOWN';

export type AgentItemType =
  | 'USER_MESSAGE'
  | 'AGENT_MESSAGE'
  | 'REASONING_SUMMARY'
  | 'PLAN'
  | 'COMMAND_EXECUTION'
  | 'FILE_CHANGE'
  | 'MCP_TOOL_CALL'
  | 'DYNAMIC_TOOL_CALL'
  | 'WEB_SEARCH'
  | 'CONTEXT_COMPACTION'
  | 'REVIEW'
  | 'SUBAGENT'
  | 'OTHER';

export interface AgentProtocolMessageReference {
  serverInstanceId: string;
  sequence: number;
  direction: 'INBOUND' | 'OUTBOUND';
  recordedAt: string;
  byteOffset: number;
  byteLength: number;
  sha256: string;
}

export interface AgentItemRecord {
  id: string;
  taskId: string;
  iterationId: string;
  runId: string;
  sessionId: string;
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

export type InteractionRequestType =
  | 'COMMAND_APPROVAL'
  | 'FILE_CHANGE_APPROVAL'
  | 'PERMISSION_APPROVAL'
  | 'MCP_ELICITATION'
  | 'USER_INPUT'
  | 'DYNAMIC_TOOL';

export type InteractionRequestStatus =
  | 'PENDING'
  | 'RESPONDING'
  | 'RESOLVED'
  | 'DECLINED'
  | 'CANCELED'
  | 'ABORTED_SERVER_LOST'
  | 'STALE';

export type AgentInteractionAction =
  | 'ACCEPT'
  | 'ACCEPT_FOR_SESSION'
  | 'ACCEPT_EXEC_POLICY_AMENDMENT'
  | 'APPLY_NETWORK_POLICY_AMENDMENT'
  | 'GRANT_TURN'
  | 'GRANT_SESSION'
  | 'ANSWER'
  | 'DECLINE'
  | 'CANCEL';

export interface AgentNetworkApprovalContext {
  host: string;
  protocol: string;
}

export interface AgentNetworkPolicyAmendment {
  host: string;
  action: 'allow' | 'deny';
}

export interface AgentCommandApprovalRequest {
  startedAtMs: number;
  approvalId?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  commandActions?: AgentJsonValue[];
  networkApprovalContext?: AgentNetworkApprovalContext;
  proposedExecPolicyAmendment?: string[];
  proposedNetworkPolicyAmendments?: AgentNetworkPolicyAmendment[];
}

export interface AgentFileChangeApprovalRequest {
  startedAtMs: number;
  reason?: string;
  grantRoot?: string;
  changes?: Array<{
    path: string;
    kind: string;
    diff: string;
  }>;
}

export interface AgentFileSystemPermissionEntry {
  path: AgentJsonValue;
  access: 'read' | 'write' | 'deny';
}

export interface AgentFileSystemPermissions {
  read?: string[];
  write?: string[];
  globScanMaxDepth?: number;
  entries?: AgentFileSystemPermissionEntry[];
}

export interface AgentPermissionProfile {
  network?: { enabled?: boolean };
  fileSystem?: AgentFileSystemPermissions;
}

export interface AgentPermissionApprovalRequest {
  startedAtMs: number;
  environmentId?: string;
  cwd: string;
  reason?: string;
  permissions: AgentPermissionProfile;
}

export type AgentMcpElicitationRequest =
  | {
      mode: 'form';
      serverName: string;
      message: string;
      metadata?: AgentJsonValue;
      requestedSchema: { [key: string]: AgentJsonValue };
    }
  | {
      mode: 'url';
      serverName: string;
      message: string;
      metadata?: AgentJsonValue;
      url: string;
      elicitationId: string;
    };

export interface AgentUserInputOption {
  label: string;
  description: string;
}

export interface AgentUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: AgentUserInputOption[];
}

export interface AgentUserInputRequest {
  questions: AgentUserInputQuestion[];
  autoResolutionMs?: number;
}

export interface AgentDynamicToolRequest {
  callId: string;
  namespace?: string;
  tool: string;
  arguments: AgentJsonValue;
}

export type AgentInteractionRequestPayload =
  | AgentCommandApprovalRequest
  | AgentFileChangeApprovalRequest
  | AgentPermissionApprovalRequest
  | AgentMcpElicitationRequest
  | AgentUserInputRequest
  | AgentDynamicToolRequest;

export type AgentCommandApprovalDecision =
  | { interactionType: 'COMMAND_APPROVAL'; action: 'ACCEPT' }
  | { interactionType: 'COMMAND_APPROVAL'; action: 'ACCEPT_FOR_SESSION' }
  | {
      interactionType: 'COMMAND_APPROVAL';
      action: 'ACCEPT_EXEC_POLICY_AMENDMENT';
      amendment: string[];
    }
  | {
      interactionType: 'COMMAND_APPROVAL';
      action: 'APPLY_NETWORK_POLICY_AMENDMENT';
      amendment: AgentNetworkPolicyAmendment;
    }
  | { interactionType: 'COMMAND_APPROVAL'; action: 'DECLINE' }
  | { interactionType: 'COMMAND_APPROVAL'; action: 'CANCEL' };

export type AgentFileChangeApprovalDecision =
  | { interactionType: 'FILE_CHANGE_APPROVAL'; action: 'ACCEPT' }
  | { interactionType: 'FILE_CHANGE_APPROVAL'; action: 'ACCEPT_FOR_SESSION' }
  | { interactionType: 'FILE_CHANGE_APPROVAL'; action: 'DECLINE' }
  | { interactionType: 'FILE_CHANGE_APPROVAL'; action: 'CANCEL' };

export type AgentPermissionApprovalDecision =
  | {
      interactionType: 'PERMISSION_APPROVAL';
      action: 'GRANT_TURN' | 'GRANT_SESSION';
      permissions: AgentPermissionProfile;
    }
  | { interactionType: 'PERMISSION_APPROVAL'; action: 'DECLINE' };

export type AgentMcpElicitationDecision =
  | {
      interactionType: 'MCP_ELICITATION';
      action: 'ACCEPT';
      content: AgentJsonValue;
    }
  | { interactionType: 'MCP_ELICITATION'; action: 'DECLINE' | 'CANCEL' };

export type AgentUserInputDecision = {
  interactionType: 'USER_INPUT';
  action: 'ANSWER';
  answers: Record<string, string[]>;
};

export type AgentDynamicToolDecision = {
  interactionType: 'DYNAMIC_TOOL';
  action: 'REJECT_UNREGISTERED';
};

export type AgentInteractionDecision =
  | AgentCommandApprovalDecision
  | AgentFileChangeApprovalDecision
  | AgentPermissionApprovalDecision
  | AgentMcpElicitationDecision
  | AgentUserInputDecision
  | AgentDynamicToolDecision;

export interface InteractionRequestRecord {
  id: string;
  serverInstanceId: string;
  providerRequestId: string | number;
  taskId: string;
  iterationId: string;
  runId: string;
  sessionId: string;
  providerTurnId?: string;
  providerItemId?: string;
  type: InteractionRequestType;
  status: InteractionRequestStatus;
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

export interface AgentModel {
  id: string;
  provider: AgentProviderId;
  model: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  serviceTiers: string[];
  defaultServiceTier?: string;
  inputModalities: string[];
  isDefault: boolean;
}

export interface AgentPreflight {
  provider: AgentProviderId;
  ready: boolean;
  capabilities: AgentProviderCapabilities;
  runtimeVersion?: string;
  accountLabel?: string;
  problems: string[];
  warnings: string[];
}

export interface AgentProviderState {
  preflight: AgentPreflight;
  models: AgentModel[];
  refreshedAt: string;
}

export interface AgentSessionSnapshot {
  session: AgentSessionRecord;
  runs: Array<{
    id: string;
    providerTurnId?: string;
    status: AgentRunStatus;
  }>;
}
