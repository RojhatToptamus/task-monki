import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import type { StoreState } from '../projection/reducer';

const WORKFLOW_PHASES = [
  'BACKLOG', 'READY', 'IN_PROGRESS', 'REVIEW', 'IN_REVIEW', 'DONE',
  'BLOCKED', 'CANCELED', 'ARCHIVED'
] as const;
const RESOLUTIONS = [
  'NONE', 'COMPLETED', 'CANCELED', 'NOT_PLANNED', 'DUPLICATE', 'SUPERSEDED'
] as const;
const COMPLETION_POLICIES = [
  'ARTIFACT_ACCEPTANCE', 'LOCAL_ACCEPTANCE', 'MERGED', 'MERGED_AND_VERIFIED', 'MANUAL'
] as const;
const RUN_MODES = [
  'ANALYSIS', 'IMPLEMENTATION', 'FOLLOW_UP', 'RETRY', 'REVIEW', 'COMPACTION', 'SUBAGENT'
] as const;
const RUN_STATUSES = [
  'QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT',
  'INTERRUPTING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'
] as const;
const RECOVERY_STATES = [
  'NONE', 'RECONCILING', 'RECOVERED', 'REQUIRES_USER_ACTION', 'UNRECOVERABLE'
] as const;
const SERVER_STATUSES = [
  'STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING', 'EXITED', 'FAILED', 'LOST'
] as const;
const SESSION_ROLES = ['PRIMARY', 'ALTERNATIVE', 'REVIEW', 'SUBAGENT'] as const;
const SESSION_STATUSES = [
  'NOT_MATERIALIZED', 'NOT_LOADED', 'IDLE', 'ACTIVE', 'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED', 'UNKNOWN'
] as const;
const RELATIONSHIP_STATES = ['ROOT', 'RESOLVED', 'UNRESOLVED', 'CONTRADICTORY'] as const;
const INTERACTION_STATUSES = [
  'PENDING', 'RESPONDING', 'RESOLVED', 'DECLINED', 'CANCELED',
  'ABORTED_SERVER_LOST', 'STALE'
] as const;
const WORKTREE_STATUSES = [
  'NOT_CREATED', 'CREATING', 'PRESENT', 'LOCKED', 'PRUNABLE', 'MISSING',
  'REMOVING', 'REMOVED', 'ERROR', 'UNKNOWN'
] as const;
const GIT_STATUSES = [
  'NOT_INSPECTED', 'CLEAN', 'DIRTY', 'COMMITTED_UNPUSHED', 'PUSHED',
  'CONFLICTED', 'DIVERGED', 'UNAVAILABLE', 'UNKNOWN'
] as const;
const AGENT_RUNTIME_KINDS = ['APP_SERVER', 'HTTP_AGENT', 'ACP_AGENT', 'NATIVE_AGENT'] as const;
const AGENT_TRANSPORTS = ['STDIO', 'HTTP_SSE', 'UNIX_SOCKET', 'IN_PROCESS'] as const;
const AGENT_ITEM_TYPES = [
  'USER_MESSAGE', 'AGENT_MESSAGE', 'REASONING_SUMMARY', 'PLAN',
  'COMMAND_EXECUTION', 'FILE_CHANGE', 'MCP_TOOL_CALL', 'DYNAMIC_TOOL_CALL',
  'WEB_SEARCH', 'CONTEXT_COMPACTION', 'REVIEW', 'SUBAGENT', 'OTHER'
] as const;
const AGENT_ITEM_STATUSES = [
  'STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'DECLINED',
  'INTERRUPTED', 'UNKNOWN'
] as const;
const INTERACTION_TYPES = [
  'COMMAND_APPROVAL', 'FILE_CHANGE_APPROVAL', 'PERMISSION_APPROVAL',
  'MCP_ELICITATION', 'USER_INPUT', 'DYNAMIC_TOOL'
] as const;
const INTERACTION_ACTIONS = [
  'ACCEPT', 'ACCEPT_FOR_SESSION', 'ACCEPT_EXEC_POLICY_AMENDMENT',
  'APPLY_NETWORK_POLICY_AMENDMENT', 'GRANT_TURN', 'GRANT_SESSION',
  'ANSWER', 'DECLINE', 'DECLINE_FOR_SESSION', 'CANCEL'
] as const;
const PROVIDER_PERMISSION_ACTIONS = [
  'ACCEPT', 'ACCEPT_FOR_SESSION', 'DECLINE', 'DECLINE_FOR_SESSION'
] as const;
const GOAL_SYNC_STATES = [
  'IN_SYNC', 'DIVERGED', 'CLEARED', 'SYNC_FAILED', 'UNKNOWN'
] as const;
const GOAL_STATUSES = [
  'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'
] as const;
const GOAL_SOURCES = [
  'TASK_MONKI_SYNC', 'PROVIDER_NOTIFICATION', 'PROVIDER_CLEARED', 'SYNC_ERROR'
] as const;
const PLAN_STEP_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED'] as const;
const SETTINGS_OBSERVATION_SOURCES = [
  'TASK_MONKI_RESOLUTION', 'THREAD_START_RESPONSE', 'THREAD_RESUME_RESPONSE',
  'THREAD_FORK_RESPONSE', 'THREAD_SETTINGS_NOTIFICATION',
  'MODEL_REROUTED_NOTIFICATION', 'RECOVERY_RESUME_RESPONSE'
] as const;
const SUBAGENT_SOURCES = [
  'THREAD_STARTED_PARENT', 'THREAD_STARTED_FORK', 'THREAD_STARTED_SOURCE',
  'COLLAB_RECEIVER', 'COLLAB_STATE', 'SUBAGENT_ACTIVITY'
] as const;
const SUBAGENT_STATUSES = [
  'PENDING_INIT', 'RUNNING', 'INTERRUPTED', 'COMPLETED', 'ERRORED',
  'SHUTDOWN', 'NOT_FOUND', 'UNKNOWN'
] as const;
const DOMAIN_EVENT_TYPES = [
  'TASK_CREATED', 'TASK_ALTERNATIVE_CREATED', 'TASK_ITERATION_CREATED',
  'TRANSITION_REQUESTED', 'TRANSITION_COMPLETED', 'TRANSITION_BLOCKED',
  'WORKTREE_CREATE_REQUESTED', 'WORKTREE_CREATED', 'WORKTREE_VERIFIED',
  'WORKTREE_FAILED', 'GIT_SNAPSHOT_CAPTURED', 'DELIVERY_COMMIT_CREATED',
  'DIFF_ARTIFACT_CREATED', 'PROMPT_REFINED', 'GITHUB_PREFLIGHT_COMPLETED',
  'BRANCH_PUBLISH_REQUESTED', 'BRANCH_PUBLISHED', 'BRANCH_PUBLISH_FAILED',
  'PR_CREATE_REQUESTED', 'PR_BODY_ARTIFACT_CREATED', 'PR_SNAPSHOT_CAPTURED',
  'CI_ROLLUP_CAPTURED', 'REVIEW_ROLLUP_CAPTURED', 'MERGE_SNAPSHOT_CAPTURED',
  'GITHUB_SYNC_FAILED', 'PROCESS_STARTED', 'AGENT_SESSION_CREATED',
  'AGENT_RUN_STARTED', 'AGENT_ACTIVITY_RECEIVED', 'AGENT_GOAL_UPDATED',
  'AGENT_GOAL_CLEARED', 'AGENT_GOAL_SYNC_FAILED', 'AGENT_PLAN_REVISED',
  'AGENT_USAGE_UPDATED', 'AGENT_SETTINGS_OBSERVED', 'AGENT_SUBAGENT_DISCOVERED',
  'AGENT_SUBAGENT_UPDATED', 'AGENT_SUBAGENT_RELATIONSHIP_UNRESOLVED',
  'AGENT_PROTOCOL_INCIDENT', 'AGENT_ITEM_UPDATED',
  'AGENT_INTERACTION_REQUESTED', 'AGENT_INTERACTION_RESOLVED',
  'AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED',
  'AGENT_MUTATION_AMBIGUOUS', 'AGENT_REVIEW_POLICY_VIOLATION',
  'AGENT_RUNTIME_LOST', 'AGENT_RUNTIME_RECONCILED', 'PROCESS_EXITED',
  'PROCESS_SIGNALED', 'CANCEL_REQUESTED', 'ARTIFACT_CREATED',
  'PROJECTION_UPDATED', 'REPOSITORY_PREFLIGHT_COMPLETED'
] as const;
const DOMAIN_EVENT_SOURCES = [
  'ui', 'provider', 'process', 'storage', 'repository', 'projection', 'git',
  'github', 'prompt'
] as const;
const REQUESTED_ACTION_STATUSES = [
  'NONE', 'REQUESTED', 'STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED',
  'CANCEL_REQUESTED', 'CANCELED'
] as const;
const PROCESS_STATUSES = [
  'CREATED', 'SPAWNING', 'RUNNING', 'EXITED', 'SIGNALED', 'CANCELING',
  'ORPHANED', 'UNKNOWN'
] as const;
const REPOSITORY_PREFLIGHT_STATUSES = ['VALID', 'INVALID', 'UNKNOWN'] as const;
const GITHUB_REPOSITORY_STATUSES = [
  'NOT_CHECKED', 'READY', 'MISSING_REMOTE', 'GH_MISSING', 'AUTH_REQUIRED',
  'UNSUPPORTED_HOST', 'ERROR', 'UNKNOWN'
] as const;
const BRANCH_PUBLICATION_STATUSES = [
  'NOT_PUSHED', 'PUSHING', 'PUSHED', 'FAILED', 'AMBIGUOUS', 'UNKNOWN'
] as const;
const PULL_REQUEST_STATUSES = [
  'UNLINKED', 'NOT_CREATED', 'OPEN_DRAFT', 'OPEN_READY', 'CLOSED_UNMERGED',
  'MERGED', 'UNKNOWN'
] as const;
const CI_CHECK_STATUSES = [
  'NOT_APPLICABLE', 'NO_CHECKS', 'EXPECTED_NOT_REPORTED', 'PENDING',
  'PASSING', 'FAILING', 'CANCELED', 'BLOCKED', 'STALE', 'UNKNOWN'
] as const;
const GITHUB_CHECK_STATUSES = ['passed', 'failed', 'pending', 'skipped', 'canceled'] as const;
const REVIEW_STATUSES = [
  'NOT_APPLICABLE', 'NOT_REQUESTED', 'REQUESTED', 'PENDING',
  'CHANGES_REQUESTED', 'APPROVED', 'SATISFIED', 'STALE', 'UNKNOWN'
] as const;
const REVIEW_GATE_STATUSES = [
  'NOT_RUN', 'RUNNING', 'PASSED', 'NEEDS_CHANGES', 'INCONCLUSIVE', 'FAILED',
  'CANCELED', 'STALE'
] as const;
const MERGE_STATUSES = [
  'NOT_APPLICABLE', 'NOT_MERGED', 'COMPUTING', 'MERGEABLE', 'BLOCKED',
  'QUEUED', 'MERGED', 'CLOSED_UNMERGED', 'UNKNOWN'
] as const;
const ARTIFACT_STATUSES = ['NONE', 'FINAL_MESSAGE_PRESENT', 'MISSING'] as const;
const HEALTH_STATUSES = ['HEALTHY', 'INFO', 'WARNING', 'ERROR', 'BLOCKED'] as const;
const ARTIFACT_KINDS = [
  'agent-prompt', 'agent-output', 'agent-diagnostics', 'agent-final', 'diff',
  'git-snapshot', 'pr-body'
] as const;
const SANDBOXES = ['READ_ONLY', 'WORKSPACE_WRITE', 'DANGER_FULL_ACCESS'] as const;
const APPROVALS_REVIEWERS = ['user', 'auto_review', 'guardian_subagent'] as const;
const PROTOCOL_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Validates JSON-loaded schema-12 primitives before domain code can observe
 * them. Relationship, artifact, attachment, and runtime ownership invariants
 * remain in FileTaskStore where their indexes and filesystem context live.
 */
export function validateCurrentStoreRecords(state: StoreState): void {
  validateCollection(state.tasks, 'tasks', (task) => {
    strings(task, 'tasks', ['runtimeId', 'title', 'prompt', 'repositoryPath']);
    uuidField(task, 'id', 'tasks');
    enumField(task, 'workflowPhase', WORKFLOW_PHASES, 'tasks');
    enumField(task, 'resolution', RESOLUTIONS, 'tasks');
    enumField(task, 'completionPolicy', COMPLETION_POLICIES, 'tasks');
    integer(task, 'phaseVersion', 'tasks', 1);
    optionalStrings(task, 'tasks', ['creationToken', 'creationRequestFingerprint']);
    optionalUuidFields(task, 'tasks', [
      'currentRunId', 'currentAgentSessionId', 'currentIterationId',
      'currentWorktreeId', 'forkedFromTaskId', 'forkedFromRunId'
    ]);
    uuidArray(task, 'forkedAlternativeTaskIds', 'tasks');
    settings(task.agentSettings, 'tasks.agentSettings');
    timestamp(task, 'createdAt', 'tasks');
    timestamp(task, 'updatedAt', 'tasks');
    projection(task.projection);
  });

  validateCollection(state.iterations, 'iterations', (iteration) => {
    strings(iteration, 'iterations', ['branchName', 'baseSha']);
    optionalStrings(iteration, 'iterations', ['baseRef']);
    uuidFields(iteration, 'iterations', [
      'id', 'taskId', 'actionRequestId', 'generationKey'
    ]);
    optionalUuidFields(iteration, 'iterations', ['worktreeId']);
    enumField(
      iteration,
      'status',
      ['ACTIVE', 'SUPERSEDED', 'COMPLETED', 'CANCELED'] as const,
      'iterations'
    );
    timestamp(iteration, 'createdAt', 'iterations');
    timestamp(iteration, 'updatedAt', 'iterations');
  });

  validateCollection(state.worktrees, 'worktrees', (worktree) => {
    strings(worktree, 'worktrees', [
      'repositoryPath', 'worktreePath', 'branchName', 'baseSha'
    ]);
    optionalStrings(worktree, 'worktrees', ['baseRef', 'headSha', 'error']);
    uuidFields(worktree, 'worktrees', ['id', 'taskId', 'iterationId']);
    enumField(worktree, 'status', WORKTREE_STATUSES, 'worktrees');
    timestamp(worktree, 'createdAt', 'worktrees');
    timestamp(worktree, 'updatedAt', 'worktrees');
    optionalTimestamp(worktree, 'lastVerifiedAt', 'worktrees');
  });

  validateCollection(state.gitSnapshots, 'gitSnapshots', (snapshot) => {
    strings(snapshot, 'gitSnapshots', [
      'worktreePath', 'repoRoot', 'gitCommonDir', 'diffStat', 'dirtyFingerprint'
    ], new Set(['diffStat']));
    optionalStrings(snapshot, 'gitSnapshots', [
      'headSha', 'branch', 'baseRef', 'baseSha', 'upstreamRef', 'upstreamSha',
      'operationInProgress'
    ]);
    uuidFields(snapshot, 'gitSnapshots', ['id', 'taskId', 'iterationId', 'worktreeId']);
    optionalUuidFields(snapshot, 'gitSnapshots', ['diffArtifactId']);
    enumField(snapshot, 'status', GIT_STATUSES, 'gitSnapshots');
    for (const key of [
      'aheadCount', 'behindCount', 'stagedCount', 'unstagedCount', 'untrackedCount',
      'conflictedCount', 'commitsAheadOfBase', 'committedDiffFileCount',
      'workingDiffFileCount'
    ] as const) integer(snapshot, key, 'gitSnapshots', 0);
    timestamp(snapshot, 'capturedAt', 'gitSnapshots');
  });

  validateCollection(state.runs, 'runs', (run) => {
    strings(run, 'runs', ['runtimeId']);
    enumField(run, 'mode', RUN_MODES, 'runs');
    enumField(run, 'origin', ['TASK_MONKI', 'PROVIDER_SUBAGENT'] as const, 'runs');
    enumField(run, 'status', RUN_STATUSES, 'runs');
    enumField(run, 'recoveryState', RECOVERY_STATES, 'runs');
    uuidFields(run, 'runs', [
      'id', 'taskId', 'iterationId', 'worktreeId', 'sessionId',
      'promptArtifactId', 'outputArtifactId', 'diagnosticArtifactId'
    ]);
    optionalStrings(run, 'runs', [
      'providerTurnId', 'generationKey', 'terminalReason', 'lastEventType', 'finalMessage'
    ], new Set(['finalMessage']));
    optionalUuidFields(run, 'runs', [
      'serverInstanceId', 'parentRunId', 'retryOfRunId', 'continuedFromRunId',
      'beforeGitSnapshotId', 'afterGitSnapshotId', 'finalArtifactId'
    ]);
    optionalEnumField(
      run,
      'providerTerminalSource',
      ['TURN_COMPLETED_NOTIFICATION', 'RECOVERY_RESUME_RESPONSE'] as const,
      'runs'
    );
    settings(run.requestedSettings, 'runs.requestedSettings');
    if (run.observedSettings !== undefined) settings(run.observedSettings, 'runs.observedSettings');
    integer(run, 'eventCount', 'runs', 0);
    timestamp(run, 'startedAt', 'runs');
    optionalTimestamp(run, 'lastEventAt', 'runs');
    optionalTimestamp(run, 'endedAt', 'runs');
    if (run.providerTerminalRawMessage !== undefined) {
      protocolReference(run.providerTerminalRawMessage, 'runs.providerTerminalRawMessage');
    }
    if (run.attachmentSubmissions !== undefined) {
      if (!Array.isArray(run.attachmentSubmissions)) invalid('runs');
      for (const submission of run.attachmentSubmissions) {
        const record = persistedRecord(submission, 'runs');
        strings(record, 'runs', [
          'attachmentId', 'kind', 'mediaType', 'sha256', 'submittedAs',
          'verifiedAt', 'providerTurnId', 'submittedAt'
        ]);
        sha256Field(record, 'sha256', 'runs');
        enumField(record, 'kind', ['image', 'text'] as const, 'runs');
        enumField(
          record,
          'submittedAs',
          ['localImage', 'nativeFile', 'prompt-file-reference'] as const,
          'runs'
        );
        integer(record, 'ordinal', 'runs', 0);
        integer(record, 'byteCount', 'runs', 1);
        timestamp(record, 'verifiedAt', 'runs');
        timestamp(record, 'submittedAt', 'runs');
      }
    }
  });

  validateCollection(state.agentServers, 'agentServers', (server) => {
    strings(server, 'agentServers', [
      'runtimeId', 'executable', 'protocolJournalPath'
    ]);
    enumField(server, 'status', SERVER_STATUSES, 'agentServers');
    uuidField(server, 'id', 'agentServers');
    enumField(server, 'runtimeKind', AGENT_RUNTIME_KINDS, 'agentServers');
    enumField(server, 'transport', AGENT_TRANSPORTS, 'agentServers');
    stringArray(server, 'argv', 'agentServers');
    optionalStrings(server, 'agentServers', [
      'runtimeVersion', 'schemaVersion', 'schemaHash', 'exitReason'
    ]);
    optionalNullableString(server, 'signal', 'agentServers');
    optionalInteger(server, 'pid', 'agentServers', 1);
    optionalNullableInteger(server, 'exitCode', 'agentServers');
    timestamp(server, 'startedAt', 'agentServers');
    for (const key of [
      'initializedAt', 'lastHealthAt', 'disconnectedAt', 'exitedAt'
    ] as const) optionalTimestamp(server, key, 'agentServers');
    if (server.runtimeResolution !== undefined) {
      const resolution = persistedRecord(server.runtimeResolution, 'agentServers');
      strings(resolution, 'agentServers', ['selectedExecutable', 'selectedSource']);
      optionalStrings(resolution, 'agentServers', ['selectedVersion']);
      optionalStringArray(resolution, 'selectedLaunchArgv', 'agentServers');
      stringArray(resolution, 'requiredCapabilities', 'agentServers');
      if (!Array.isArray(resolution.probes)) invalid('agentServers');
      for (const probe of resolution.probes) {
        const diagnostic = persistedRecord(probe, 'agentServers');
        strings(diagnostic, 'agentServers', [
          'executable',
          'source',
          'detail'
        ], new Set(['detail']));
        booleanField(diagnostic, 'explicit', 'agentServers');
        booleanField(diagnostic, 'compatible', 'agentServers');
        optionalStrings(diagnostic, 'agentServers', [
          'version',
          'launchForm'
        ]);
        optionalStringArray(diagnostic, 'launchArgv', 'agentServers');
        optionalStringArray(diagnostic, 'missingCapabilities', 'agentServers');
      }
    }
  });

  validateCollection(state.agentSessions, 'agentSessions', (session) => {
    strings(session, 'agentSessions', ['runtimeId', 'worktreePath']);
    enumField(session, 'role', SESSION_ROLES, 'agentSessions');
    enumField(session, 'relationshipState', RELATIONSHIP_STATES, 'agentSessions');
    enumField(session, 'status', SESSION_STATUSES, 'agentSessions');
    uuidFields(session, 'agentSessions', ['id', 'taskId', 'iterationId', 'worktreeId']);
    enumField(session, 'ownership', ['TASK_MONKI'] as const, 'agentSessions');
    booleanField(session, 'materialized', 'agentSessions');
    optionalStrings(session, 'agentSessions', [
      'providerSessionId', 'providerSessionTreeId', 'providerParentSessionId',
      'providerForkedFromSessionId', 'relationshipDetail', 'providerNickname',
      'providerRole', 'delegatedPrompt', 'agentPath'
    ], new Set(['relationshipDetail', 'delegatedPrompt']));
    optionalUuidFields(session, 'agentSessions', [
      'parentSessionId', 'forkedFromSessionId', 'parentRunId'
    ]);
    optionalEnumField(session, 'subagentStatus', SUBAGENT_STATUSES, 'agentSessions');
    settings(session.requestedSettings, 'agentSessions.requestedSettings');
    if (session.observedSettings !== undefined) {
      settings(session.observedSettings, 'agentSessions.observedSettings');
    }
    timestamp(session, 'createdAt', 'agentSessions');
    timestamp(session, 'updatedAt', 'agentSessions');
    optionalTimestamp(session, 'lastAttachedAt', 'agentSessions');
  });

  validateCollection(state.agentItems, 'agentItems', (item) => {
    strings(item, 'agentItems', ['providerItemId']);
    uuidFields(item, 'agentItems', ['id', 'taskId', 'iterationId', 'runId', 'sessionId']);
    optionalUuidFields(item, 'agentItems', ['outputArtifactId']);
    enumField(item, 'type', AGENT_ITEM_TYPES, 'agentItems');
    enumField(item, 'status', AGENT_ITEM_STATUSES, 'agentItems');
    optionalTimestamp(item, 'providerStartedAt', 'agentItems');
    optionalTimestamp(item, 'providerCompletedAt', 'agentItems');
    timestamp(item, 'createdAt', 'agentItems');
    timestamp(item, 'updatedAt', 'agentItems');
    if (item.rawMessage !== undefined) protocolReference(item.rawMessage, 'agentItems.rawMessage');
  });

  validateAgentObservations(state);
  validateInteractions(state);
  validateEvents(state);
  validateGitHubRecords(state);
  validateArtifacts(state);
}

function validateAgentObservations(state: StoreState): void {
  for (const [collection, records] of [
    ['agentGoalSnapshots', state.agentGoalSnapshots],
    ['agentPlanRevisions', state.agentPlanRevisions],
    ['agentUsageSnapshots', state.agentUsageSnapshots],
    ['agentSettingsObservations', state.agentSettingsObservations],
    ['agentSubagentObservations', state.agentSubagentObservations]
  ] as ReadonlyArray<readonly [string, readonly unknown[]]>) {
    for (const value of records) {
      const record = persistedRecord(value, collection);
      strings(record, collection, ['runtimeId']);
      uuidFields(record, collection, ['id', 'taskId', 'iterationId', 'sessionId']);
      timestamp(record, 'observedAt', collection);
      if ('rawMessage' in record && record.rawMessage !== undefined) {
        protocolReference(record.rawMessage, `${collection}.rawMessage`);
      }
    }
  }

  for (const record of state.agentGoalSnapshots) {
    strings(record, 'agentGoalSnapshots', ['taskGoalHash']);
    enumField(record, 'syncState', GOAL_SYNC_STATES, 'agentGoalSnapshots');
    enumField(record, 'source', GOAL_SOURCES, 'agentGoalSnapshots');
    optionalStrings(record, 'agentGoalSnapshots', [
      'lastSynchronizedTaskGoalHash', 'providerObjective', 'detail'
    ], new Set(['providerObjective', 'detail']));
    optionalEnumField(record, 'providerStatus', GOAL_STATUSES, 'agentGoalSnapshots');
    for (const key of ['tokenBudget', 'tokensUsed', 'timeUsedSeconds'] as const) {
      optionalInteger(record, key, 'agentGoalSnapshots', 0);
    }
    optionalTimestamp(record, 'providerCreatedAt', 'agentGoalSnapshots');
    optionalTimestamp(record, 'providerUpdatedAt', 'agentGoalSnapshots');
  }
  for (const record of state.agentPlanRevisions) {
    uuidField(record, 'runId', 'agentPlanRevisions');
    optionalStrings(record, 'agentPlanRevisions', ['explanation'], new Set(['explanation']));
    integer(record, 'revision', 'agentPlanRevisions', 1);
    if (!Array.isArray(record.steps)) invalid('agentPlanRevisions');
    for (const step of record.steps) {
      const value = persistedRecord(step, 'agentPlanRevisions');
      strings(value, 'agentPlanRevisions', ['step', 'status']);
      enumField(value, 'status', PLAN_STEP_STATUSES, 'agentPlanRevisions');
    }
  }
  for (const record of state.agentUsageSnapshots) {
    if (record.runId !== undefined) uuidField(record, 'runId', 'agentUsageSnapshots');
    tokenUsage(record.total, 'agentUsageSnapshots');
    tokenUsage(record.last, 'agentUsageSnapshots');
    optionalInteger(record, 'modelContextWindow', 'agentUsageSnapshots', 1);
  }
  for (const record of state.agentSettingsObservations) {
    if (record.runId !== undefined) uuidField(record, 'runId', 'agentSettingsObservations');
    enumField(
      record,
      'source',
      SETTINGS_OBSERVATION_SOURCES,
      'agentSettingsObservations'
    );
    optionalStrings(record, 'agentSettingsObservations', ['detail'], new Set(['detail']));
    settings(record.settings, 'agentSettingsObservations.settings');
  }
  for (const record of state.agentSubagentObservations) {
    strings(record, 'agentSubagentObservations', ['providerChildSessionId']);
    optionalStrings(record, 'agentSubagentObservations', [
      'providerParentSessionId', 'providerForkedFromSessionId', 'delegatedPrompt',
      'providerNickname', 'providerRole', 'agentPath', 'detail'
    ], new Set(['delegatedPrompt', 'detail']));
    uuidField(record, 'parentSessionId', 'agentSubagentObservations');
    optionalUuidFields(record, 'agentSubagentObservations', ['parentRunId']);
    enumField(record, 'source', SUBAGENT_SOURCES, 'agentSubagentObservations');
    enumField(
      record,
      'relationshipState',
      RELATIONSHIP_STATES,
      'agentSubagentObservations'
    );
    optionalEnumField(record, 'status', SUBAGENT_STATUSES, 'agentSubagentObservations');
    if (record.requestedSettings !== undefined) {
      settings(record.requestedSettings, 'agentSubagentObservations.requestedSettings');
    }
  }
}

function validateInteractions(state: StoreState): void {
  validateCollection(state.interactionRequests, 'interactionRequests', (request) => {
    strings(request, 'interactionRequests', ['runtimeId']);
    uuidFields(request, 'interactionRequests', [
      'id', 'serverInstanceId', 'taskId', 'iterationId', 'runId', 'sessionId'
    ]);
    if (
      (typeof request.providerRequestId !== 'string' || !request.providerRequestId) &&
      (typeof request.providerRequestId !== 'number' || !Number.isFinite(request.providerRequestId))
    ) invalid('interactionRequests');
    enumField(request, 'status', INTERACTION_STATUSES, 'interactionRequests');
    enumField(request, 'type', INTERACTION_TYPES, 'interactionRequests');
    optionalStrings(request, 'interactionRequests', ['providerTurnId', 'providerItemId']);
    enumArray(
      request,
      'allowedActions',
      allowedInteractionActions(request.type as string),
      'interactionRequests'
    );
    stringArray(request, 'policyWarnings', 'interactionRequests', true);
    interactionRequestPayload(request.type as string, request.request);
    if (request.decision !== undefined) {
      interactionDecision(request.type as string, request.decision, request.request);
    }
    protocolReference(request.requestRawMessage, 'interactionRequests.requestRawMessage');
    if (request.requestRawMessage.direction !== 'INBOUND') invalid('interactionRequests');
    if (request.responseRawMessage !== undefined) {
      protocolReference(request.responseRawMessage, 'interactionRequests.responseRawMessage');
      if (request.responseRawMessage.direction !== 'OUTBOUND') invalid('interactionRequests');
    }
    timestamp(request, 'requestedAt', 'interactionRequests');
    optionalTimestamp(request, 'respondedAt', 'interactionRequests');
    optionalTimestamp(request, 'resolvedAt', 'interactionRequests');
  });
}

function allowedInteractionActions(type: string): readonly string[] {
  switch (type) {
    case 'COMMAND_APPROVAL':
      return [
        'ACCEPT',
        'ACCEPT_FOR_SESSION',
        'ACCEPT_EXEC_POLICY_AMENDMENT',
        'APPLY_NETWORK_POLICY_AMENDMENT',
        'DECLINE',
        'DECLINE_FOR_SESSION',
        'CANCEL'
      ];
    case 'FILE_CHANGE_APPROVAL':
      return ['ACCEPT', 'ACCEPT_FOR_SESSION', 'DECLINE', 'CANCEL'];
    case 'PERMISSION_APPROVAL':
      return ['GRANT_TURN', 'GRANT_SESSION', 'DECLINE'];
    case 'MCP_ELICITATION':
      return ['ACCEPT', 'DECLINE', 'CANCEL'];
    case 'USER_INPUT':
      return ['ANSWER'];
    case 'DYNAMIC_TOOL':
      return [];
    default:
      return INTERACTION_ACTIONS;
  }
}

function interactionRequestPayload(type: string, value: unknown): void {
  const request = persistedRecord(value, 'interactionRequests');
  switch (type) {
    case 'COMMAND_APPROVAL':
      finiteNumberField(request, 'startedAtMs', 'interactionRequests', 0);
      optionalStrings(
        request,
        'interactionRequests',
        ['approvalId', 'reason', 'command', 'cwd'],
        new Set(['reason', 'command', 'cwd'])
      );
      if (request.commandActions !== undefined) {
        jsonArray(request.commandActions, 'interactionRequests');
      }
      if (request.networkApprovalContext !== undefined) {
        const context = persistedRecord(
          request.networkApprovalContext,
          'interactionRequests'
        );
        strings(context, 'interactionRequests', ['host', 'protocol']);
      }
      optionalStringArray(request, 'proposedExecPolicyAmendment', 'interactionRequests');
      if (request.proposedNetworkPolicyAmendments !== undefined) {
        if (!Array.isArray(request.proposedNetworkPolicyAmendments)) {
          invalid('interactionRequests');
        }
        for (const amendment of request.proposedNetworkPolicyAmendments) {
          networkPolicyAmendment(amendment);
        }
      }
      if (request.providerOptions !== undefined) {
        if (!Array.isArray(request.providerOptions) || request.providerOptions.length === 0) {
          invalid('interactionRequests');
        }
        const optionIds = new Set<string>();
        for (const option of request.providerOptions) {
          const record = persistedRecord(option, 'interactionRequests');
          strings(record, 'interactionRequests', ['id', 'label']);
          enumField(record, 'action', PROVIDER_PERMISSION_ACTIONS, 'interactionRequests');
          if (optionIds.has(record.id as string)) invalid('interactionRequests');
          optionIds.add(record.id as string);
        }
      }
      return;
    case 'FILE_CHANGE_APPROVAL':
      finiteNumberField(request, 'startedAtMs', 'interactionRequests', 0);
      optionalStrings(
        request,
        'interactionRequests',
        ['reason', 'grantRoot'],
        new Set(['reason'])
      );
      if (request.changes !== undefined) {
        if (!Array.isArray(request.changes)) invalid('interactionRequests');
        for (const change of request.changes) {
          strings(
            persistedRecord(change, 'interactionRequests'),
            'interactionRequests',
            ['path', 'kind', 'diff'],
            new Set(['diff'])
          );
        }
      }
      return;
    case 'PERMISSION_APPROVAL':
      finiteNumberField(request, 'startedAtMs', 'interactionRequests', 0);
      stringField(request, 'cwd', 'interactionRequests', true);
      optionalStrings(
        request,
        'interactionRequests',
        ['environmentId', 'reason'],
        new Set(['reason'])
      );
      permissionProfile(request.permissions);
      return;
    case 'MCP_ELICITATION':
      enumField(request, 'mode', ['form', 'url'] as const, 'interactionRequests');
      strings(request, 'interactionRequests', ['serverName', 'message'], new Set(['message']));
      if (request.metadata !== undefined) jsonValue(request.metadata, 'interactionRequests');
      if (request.mode === 'form') {
        persistedRecord(request.requestedSchema, 'interactionRequests');
        jsonValue(request.requestedSchema, 'interactionRequests');
      } else {
        strings(request, 'interactionRequests', ['url', 'elicitationId']);
      }
      return;
    case 'USER_INPUT':
      if (!Array.isArray(request.questions)) invalid('interactionRequests');
      for (const question of request.questions) {
        const record = persistedRecord(question, 'interactionRequests');
        strings(
          record,
          'interactionRequests',
          ['id', 'header', 'question'],
          new Set(['header', 'question'])
        );
        booleanField(record, 'isOther', 'interactionRequests');
        booleanField(record, 'isSecret', 'interactionRequests');
        if (record.options !== undefined) {
          if (!Array.isArray(record.options)) invalid('interactionRequests');
          for (const option of record.options) {
            strings(
              persistedRecord(option, 'interactionRequests'),
              'interactionRequests',
              ['label', 'description'],
              new Set(['description'])
            );
          }
        }
      }
      optionalInteger(request, 'autoResolutionMs', 'interactionRequests', 0);
      return;
    case 'DYNAMIC_TOOL':
      strings(request, 'interactionRequests', ['callId', 'tool']);
      optionalStrings(request, 'interactionRequests', ['namespace']);
      jsonValue(request.arguments, 'interactionRequests');
      return;
    default:
      invalid('interactionRequests');
  }
}

function interactionDecision(type: string, value: unknown, requestValue: unknown): void {
  const decision = persistedRecord(value, 'interactionRequests');
  enumField(decision, 'interactionType', [type], 'interactionRequests');
  switch (type) {
    case 'COMMAND_APPROVAL':
      enumField(
        decision,
        'action',
        [
          'ACCEPT',
          'ACCEPT_FOR_SESSION',
          'ACCEPT_EXEC_POLICY_AMENDMENT',
          'APPLY_NETWORK_POLICY_AMENDMENT',
          'DECLINE',
          'DECLINE_FOR_SESSION',
          'CANCEL'
        ] as const,
        'interactionRequests'
      );
      if (decision.action === 'ACCEPT_EXEC_POLICY_AMENDMENT') {
        stringArray(decision, 'amendment', 'interactionRequests');
      } else if (decision.action === 'APPLY_NETWORK_POLICY_AMENDMENT') {
        networkPolicyAmendment(decision.amendment);
      } else if (
        ['ACCEPT', 'ACCEPT_FOR_SESSION', 'DECLINE', 'DECLINE_FOR_SESSION'].includes(
          decision.action as string
        )
      ) {
        const request = persistedRecord(requestValue, 'interactionRequests');
        const providerOptions = request.providerOptions;
        if (providerOptions === undefined) {
          if (decision.providerOptionId !== undefined) invalid('interactionRequests');
        } else {
          stringField(decision, 'providerOptionId', 'interactionRequests');
          const selected = (providerOptions as unknown[])
            .map((option) => persistedRecord(option, 'interactionRequests'))
            .find((option) => option.id === decision.providerOptionId);
          if (
            !selected ||
            selected.action !== decision.action
          ) {
            invalid('interactionRequests');
          }
        }
      } else if (decision.providerOptionId !== undefined) {
        invalid('interactionRequests');
      }
      return;
    case 'FILE_CHANGE_APPROVAL':
      enumField(
        decision,
        'action',
        ['ACCEPT', 'ACCEPT_FOR_SESSION', 'DECLINE', 'CANCEL'] as const,
        'interactionRequests'
      );
      return;
    case 'PERMISSION_APPROVAL':
      enumField(
        decision,
        'action',
        ['GRANT_TURN', 'GRANT_SESSION', 'DECLINE'] as const,
        'interactionRequests'
      );
      if (decision.action === 'GRANT_TURN' || decision.action === 'GRANT_SESSION') {
        permissionProfile(decision.permissions);
      }
      return;
    case 'MCP_ELICITATION':
      enumField(
        decision,
        'action',
        ['ACCEPT', 'DECLINE', 'CANCEL'] as const,
        'interactionRequests'
      );
      if (decision.action === 'ACCEPT') jsonValue(decision.content, 'interactionRequests');
      return;
    case 'USER_INPUT': {
      enumField(decision, 'action', ['ANSWER'] as const, 'interactionRequests');
      const answers = persistedRecord(decision.answers, 'interactionRequests');
      for (const answer of Object.values(answers)) {
        if (!Array.isArray(answer) || answer.some((item) => typeof item !== 'string')) {
          invalid('interactionRequests');
        }
      }
      return;
    }
    case 'DYNAMIC_TOOL':
      enumField(
        decision,
        'action',
        ['REJECT_UNREGISTERED'] as const,
        'interactionRequests'
      );
      return;
    default:
      invalid('interactionRequests');
  }
}

function permissionProfile(value: unknown): void {
  const permissions = persistedRecord(value, 'interactionRequests');
  if (permissions.network !== undefined) {
    const network = persistedRecord(permissions.network, 'interactionRequests');
    optionalBoolean(network, 'enabled', 'interactionRequests');
  }
  if (permissions.fileSystem === undefined) return;
  const fileSystem = persistedRecord(permissions.fileSystem, 'interactionRequests');
  optionalStringArray(fileSystem, 'read', 'interactionRequests');
  optionalStringArray(fileSystem, 'write', 'interactionRequests');
  optionalInteger(fileSystem, 'globScanMaxDepth', 'interactionRequests', 0);
  if (fileSystem.entries === undefined) return;
  if (!Array.isArray(fileSystem.entries)) invalid('interactionRequests');
  for (const entry of fileSystem.entries) {
    const record = persistedRecord(entry, 'interactionRequests');
    jsonValue(record.path, 'interactionRequests');
    enumField(record, 'access', ['read', 'write', 'deny'] as const, 'interactionRequests');
  }
}

function networkPolicyAmendment(value: unknown): void {
  const amendment = persistedRecord(value, 'interactionRequests');
  strings(amendment, 'interactionRequests', ['host']);
  enumField(amendment, 'action', ['allow', 'deny'] as const, 'interactionRequests');
}

function validateEvents(state: StoreState): void {
  validateCollection(state.events, 'events', (event) => {
    strings(event, 'events', ['sourceEventId']);
    uuidFields(event, 'events', ['id', 'taskId']);
    optionalUuidFields(event, 'events', [
      'iterationId', 'runId', 'agentSessionId', 'serverInstanceId',
      'agentItemId', 'interactionRequestId', 'worktreeId'
    ]);
    enumField(event, 'type', DOMAIN_EVENT_TYPES, 'events');
    enumField(event, 'source', DOMAIN_EVENT_SOURCES, 'events');
    timestamp(event, 'occurredAt', 'events');
    timestamp(event, 'receivedAt', 'events');
  });
}

function validateGitHubRecords(state: StoreState): void {
  for (const [collection, records] of [
    ['githubRepositories', state.githubRepositories],
    ['branchPublications', state.branchPublications],
    ['pullRequests', state.pullRequests],
    ['ciRollups', state.ciRollups],
    ['reviewRollups', state.reviewRollups],
    ['mergeSnapshots', state.mergeSnapshots]
  ] as ReadonlyArray<readonly [string, readonly unknown[]]>) {
    for (const value of records) {
      const record = persistedRecord(value, collection);
      uuidFields(record, collection, ['id', 'taskId', 'iterationId', 'worktreeId']);
    }
  }
  for (const record of state.githubRepositories) {
    optionalStrings(record, 'githubRepositories', [
      'remoteName', 'remoteUrl', 'host', 'owner', 'repo', 'ghVersion', 'authStatus', 'error'
    ]);
    enumField(record, 'status', GITHUB_REPOSITORY_STATUSES, 'githubRepositories');
    optionalEnumField(
      record,
      'authStatus',
      ['AUTHENTICATED', 'UNAUTHENTICATED', 'UNKNOWN'] as const,
      'githubRepositories'
    );
    timestamp(record, 'checkedAt', 'githubRepositories');
  }
  for (const record of state.branchPublications) {
    strings(record, 'branchPublications', ['remoteName', 'branchName', 'remoteRef']);
    optionalStrings(record, 'branchPublications', ['headSha', 'error']);
    enumField(record, 'status', BRANCH_PUBLICATION_STATUSES, 'branchPublications');
    timestamp(record, 'requestedAt', 'branchPublications');
    timestamp(record, 'updatedAt', 'branchPublications');
  }
  for (const record of state.pullRequests) {
    optionalInteger(record, 'number', 'pullRequests', 1);
    optionalStrings(record, 'pullRequests', [
      'url', 'state', 'headRefName', 'headRefOid', 'baseRefName', 'title'
    ], new Set(['title']));
    enumField(record, 'status', PULL_REQUEST_STATUSES, 'pullRequests');
    optionalUuidFields(record, 'pullRequests', ['bodyArtifactId']);
    optionalBoolean(record, 'isDraft', 'pullRequests');
    optionalNullableTimestamp(record, 'mergedAt', 'pullRequests');
    timestamp(record, 'observedAt', 'pullRequests');
  }
  for (const record of state.ciRollups) {
    optionalInteger(record, 'pullRequestNumber', 'ciRollups', 1);
    optionalStrings(record, 'ciRollups', ['headSha']);
    strings(record, 'ciRollups', ['requiredStatus']);
    enumField(record, 'status', CI_CHECK_STATUSES, 'ciRollups');
    enumField(record, 'requiredStatus', CI_CHECK_STATUSES, 'ciRollups');
    for (const key of [
      'totalCount', 'pendingCount', 'passingCount', 'failingCount', 'skippedCount', 'canceledCount'
    ] as const) integer(record, key, 'ciRollups', 0);
    if (!Array.isArray(record.checkDetails)) invalid('ciRollups');
    for (const detail of record.checkDetails) {
      const value = persistedRecord(detail, 'ciRollups');
      strings(value, 'ciRollups', ['name', 'status']);
      enumField(value, 'status', GITHUB_CHECK_STATUSES, 'ciRollups');
      optionalStrings(value, 'ciRollups', [
        'state', 'workflow', 'link', 'description', 'event', 'startedAt', 'completedAt'
      ], new Set(['description']));
    }
    timestamp(record, 'observedAt', 'ciRollups');
  }
  for (const record of state.reviewRollups) {
    optionalInteger(record, 'pullRequestNumber', 'reviewRollups', 1);
    optionalStrings(record, 'reviewRollups', ['headSha', 'reviewDecision']);
    enumField(record, 'status', REVIEW_STATUSES, 'reviewRollups');
    timestamp(record, 'observedAt', 'reviewRollups');
  }
  for (const record of state.mergeSnapshots) {
    optionalInteger(record, 'pullRequestNumber', 'mergeSnapshots', 1);
    optionalStrings(record, 'mergeSnapshots', ['headSha']);
    enumField(record, 'status', MERGE_STATUSES, 'mergeSnapshots');
    optionalNullableTimestamp(record, 'mergedAt', 'mergeSnapshots');
    timestamp(record, 'observedAt', 'mergeSnapshots');
  }
}

function validateArtifacts(state: StoreState): void {
  validateCollection(state.artifacts, 'artifacts', (artifact) => {
    strings(artifact, 'artifacts', ['path']);
    uuidFields(artifact, 'artifacts', ['id', 'taskId']);
    optionalUuidFields(artifact, 'artifacts', ['runId']);
    enumField(artifact, 'kind', ARTIFACT_KINDS, 'artifacts');
    integer(artifact, 'byteCount', 'artifacts', 0);
    timestamp(artifact, 'createdAt', 'artifacts');
    timestamp(artifact, 'updatedAt', 'artifacts');
  });
}

function projection(value: unknown): void {
  const record = persistedRecord(value, 'tasks.projection');
  stringField(record, 'summary', 'tasks.projection', true);
  enumField(record, 'requestedAction', REQUESTED_ACTION_STATUSES, 'tasks.projection');
  enumField(record, 'agentRun', [...RUN_STATUSES, 'IDLE'] as const, 'tasks.projection');
  enumField(record, 'osProcess', PROCESS_STATUSES, 'tasks.projection');
  enumField(
    record,
    'repositoryPreflight',
    REPOSITORY_PREFLIGHT_STATUSES,
    'tasks.projection'
  );
  enumField(record, 'worktree', WORKTREE_STATUSES, 'tasks.projection');
  enumField(record, 'git', GIT_STATUSES, 'tasks.projection');
  enumField(
    record,
    'githubRepository',
    GITHUB_REPOSITORY_STATUSES,
    'tasks.projection'
  );
  enumField(
    record,
    'branchPublication',
    BRANCH_PUBLICATION_STATUSES,
    'tasks.projection'
  );
  enumField(record, 'githubPullRequest', PULL_REQUEST_STATUSES, 'tasks.projection');
  enumField(record, 'ciChecks', CI_CHECK_STATUSES, 'tasks.projection');
  enumField(record, 'reviews', REVIEW_STATUSES, 'tasks.projection');
  enumField(record, 'merge', MERGE_STATUSES, 'tasks.projection');
  enumField(record, 'artifact', ARTIFACT_STATUSES, 'tasks.projection');
  enumField(record, 'health', HEALTH_STATUSES, 'tasks.projection');
  optionalInteger(record, 'githubPullRequestNumber', 'tasks.projection', 1);
  optionalStrings(record, 'tasks.projection', ['githubPullRequestUrl']);
  timestamp(record, 'updatedAt', 'tasks.projection');
  if (!Array.isArray(record.findings)) invalid('tasks.projection');
  for (const finding of record.findings) {
    const item = persistedRecord(finding, 'tasks.projection');
    strings(item, 'tasks.projection', ['id', 'code', 'message']);
    enumField(item, 'severity', HEALTH_STATUSES, 'tasks.projection');
    timestamp(item, 'createdAt', 'tasks.projection');
    optionalTimestamp(item, 'clearedAt', 'tasks.projection');
  }
  if (record.codexReview !== undefined) {
    const review = persistedRecord(record.codexReview, 'tasks.projection');
    enumField(review, 'status', REVIEW_GATE_STATUSES, 'tasks.projection');
    optionalStrings(review, 'tasks.projection', [
      'reviewedHeadSha', 'reviewedDirtyFingerprint', 'summary'
    ], new Set(['summary']));
    optionalUuidFields(review, 'tasks.projection', [
      'runId', 'sourceRunId', 'reviewedGitSnapshotId', 'finalArtifactId'
    ]);
    optionalTimestamp(review, 'updatedAt', 'tasks.projection');
    if (review.result !== undefined) reviewResult(review.result);
  }
}

function reviewResult(value: unknown): void {
  const record = persistedRecord(value, 'tasks.projection');
  enumField(record, 'schemaVersion', ['codex-review/v1'] as const, 'tasks.projection');
  enumField(
    record,
    'verdict',
    ['PASSED', 'NEEDS_CHANGES', 'INCONCLUSIVE'] as const,
    'tasks.projection'
  );
  stringField(record, 'summary', 'tasks.projection', true);
  if (!Array.isArray(record.findings)) invalid('tasks.projection');
  for (const finding of record.findings) {
    const item = persistedRecord(finding, 'tasks.projection');
    strings(item, 'tasks.projection', ['id', 'title', 'explanation']);
    enumField(
      item,
      'severity',
      ['BLOCKER', 'MAJOR', 'MINOR', 'NIT'] as const,
      'tasks.projection'
    );
    optionalStrings(item, 'tasks.projection', ['path', 'recommendation']);
    optionalInteger(item, 'line', 'tasks.projection', 1);
    optionalInteger(item, 'endLine', 'tasks.projection', 1);
  }
}

function settings(value: unknown, collection: string): void {
  const record = persistedRecord(value, collection);
  optionalStrings(record, collection, [
    'runtimeId', 'model', 'modelProvider', 'reasoningEffort', 'serviceTier',
    'approvalPolicy'
  ]);
  optionalEnumField(record, 'sandbox', SANDBOXES, collection);
  optionalEnumField(record, 'approvalsReviewer', APPROVALS_REVIEWERS, collection);
  optionalBoolean(record, 'networkAccess', collection);
  if (record.runtimeOptions !== undefined) persistedRecord(record.runtimeOptions, collection);
}

function tokenUsage(value: unknown, collection: string): void {
  const record = persistedRecord(value, collection);
  for (const key of [
    'totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'
  ] as const) integer(record, key, collection, 0);
}

function protocolReference(value: unknown, collection: string): void {
  const record = persistedRecord(value, collection);
  uuidField(record, 'serverInstanceId', collection);
  enumField(record, 'direction', PROTOCOL_DIRECTIONS, collection);
  sha256Field(record, 'sha256', collection);
  timestamp(record, 'recordedAt', collection);
  integer(record, 'sequence', collection, 1);
  integer(record, 'byteOffset', collection, 0);
  integer(record, 'byteLength', collection, 1);
  optionalInteger(record, 'segment', collection, 0);
}

function validateCollection<T>(
  values: readonly T[],
  collection: string,
  validate: (record: T & Record<string, unknown>) => void
): void {
  for (const value of values) validate(persistedRecord(value, collection) as T & Record<string, unknown>);
}

function persistedRecord(value: unknown, collection: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(collection);
  return value as Record<string, unknown>;
}

function strings(
  record: object,
  collection: string,
  keys: readonly string[],
  allowEmpty: ReadonlySet<string> = new Set()
): void {
  for (const key of keys) stringField(record, key, collection, allowEmpty.has(key));
}

function stringField(
  record: object,
  key: string,
  collection: string,
  allowEmpty = false
): void {
  const value = (record as Record<string, unknown>)[key];
  if (
    typeof value !== 'string' ||
    (!allowEmpty && (value.length === 0 || value.trim() !== value))
  ) invalid(collection);
}

function optionalStrings(
  record: object,
  collection: string,
  keys: readonly string[],
  allowEmpty: ReadonlySet<string> = new Set()
): void {
  const fields = record as Record<string, unknown>;
  for (const key of keys) {
    if (fields[key] !== undefined) stringField(record, key, collection, allowEmpty.has(key));
  }
}

function optionalNullableString(
  record: object,
  key: string,
  collection: string
): void {
  const value = (record as Record<string, unknown>)[key];
  if (value !== undefined && value !== null) stringField(record, key, collection);
}

function stringArray(
  record: object,
  key: string,
  collection: string,
  allowEmpty = false
): void {
  const value = (record as Record<string, unknown>)[key];
  if (
    !Array.isArray(value) ||
    value.some((item) =>
      typeof item !== 'string' || (!allowEmpty && (item.length === 0 || item.trim() !== item))
    )
  ) invalid(collection);
}

function optionalStringArray(
  record: object,
  key: string,
  collection: string
): void {
  if ((record as Record<string, unknown>)[key] !== undefined) stringArray(record, key, collection);
}

function uuidFields(
  record: object,
  collection: string,
  keys: readonly string[]
): void {
  for (const key of keys) uuidField(record, key, collection);
}

function uuidField(record: object, key: string, collection: string): void {
  const value = (record as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !UUID.test(value)) invalid(collection);
}

function optionalUuidFields(
  record: object,
  collection: string,
  keys: readonly string[]
): void {
  const fields = record as Record<string, unknown>;
  for (const key of keys) {
    if (fields[key] !== undefined) uuidField(record, key, collection);
  }
}

function uuidArray(record: object, key: string, collection: string): void {
  const value = (record as Record<string, unknown>)[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !UUID.test(item))) {
    invalid(collection);
  }
}

function integer(
  record: object,
  key: string,
  collection: string,
  minimum: number
): void {
  const value = (record as Record<string, unknown>)[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(collection);
}

function optionalInteger(
  record: object,
  key: string,
  collection: string,
  minimum: number
): void {
  if ((record as Record<string, unknown>)[key] !== undefined) integer(record, key, collection, minimum);
}

function optionalNullableInteger(
  record: object,
  key: string,
  collection: string
): void {
  const value = (record as Record<string, unknown>)[key];
  if (value !== undefined && value !== null) integer(record, key, collection, Number.MIN_SAFE_INTEGER);
}

function finiteNumberField(
  record: object,
  key: string,
  collection: string,
  minimum: number
): void {
  const value = (record as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    invalid(collection);
  }
}

function jsonArray(value: unknown, collection: string): void {
  if (!Array.isArray(value)) invalid(collection);
  for (const item of value) jsonValue(item, collection);
}

function jsonValue(value: unknown, collection: string, depth = 0): void {
  if (depth > 64) invalid(collection);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(collection);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) jsonValue(item, collection, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') invalid(collection);
  for (const item of Object.values(value)) {
    jsonValue(item, collection, depth + 1);
  }
}

function booleanField(record: object, key: string, collection: string): void {
  if (typeof (record as Record<string, unknown>)[key] !== 'boolean') invalid(collection);
}

function optionalBoolean(record: object, key: string, collection: string): void {
  if ((record as Record<string, unknown>)[key] !== undefined) booleanField(record, key, collection);
}

function timestamp(record: object, key: string, collection: string): void {
  if (!isCanonicalTimestamp((record as Record<string, unknown>)[key])) invalid(collection);
}

function optionalTimestamp(record: object, key: string, collection: string): void {
  if ((record as Record<string, unknown>)[key] !== undefined) timestamp(record, key, collection);
}

function optionalNullableTimestamp(
  record: object,
  key: string,
  collection: string
): void {
  const value = (record as Record<string, unknown>)[key];
  if (value !== undefined && value !== null) timestamp(record, key, collection);
}

function enumField(
  record: object,
  key: string,
  allowed: readonly string[],
  collection: string
): void {
  const value = (record as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(collection);
}

function optionalEnumField(
  record: object,
  key: string,
  allowed: readonly string[],
  collection: string
): void {
  if ((record as Record<string, unknown>)[key] !== undefined) {
    enumField(record, key, allowed, collection);
  }
}

function enumArray(
  record: object,
  key: string,
  allowed: readonly string[],
  collection: string
): void {
  const value = (record as Record<string, unknown>)[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !allowed.includes(item))) {
    invalid(collection);
  }
}

function sha256Field(record: object, key: string, collection: string): void {
  const value = (record as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(collection);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function invalid(collection: string): never {
  throw new Error(
    `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: ${collection} contains a malformed record.`
  );
}
