import type {
  DomainEvent,
  CodexReviewFinding,
  CodexReviewResult,
  Finding,
  HealthStatus,
  RunRecord,
  StatusProjection,
  Task,
  TaskSnapshot,
  PullRequestSnapshotRecord
} from '../../shared/contracts';
import {
  TASK_STORE_SCHEMA_VERSION,
  completionPolicyRequiresMerge,
  createInitialProjection
} from '../../shared/contracts';

export interface StoreState extends TaskSnapshot {}

export function createEmptyState(): StoreState {
  return {
    schemaVersion: TASK_STORE_SCHEMA_VERSION,
    tasks: [],
    iterations: [],
    worktrees: [],
    gitSnapshots: [],
    githubRepositories: [],
    branchPublications: [],
    pullRequests: [],
    ciRollups: [],
    reviewRollups: [],
    mergeSnapshots: [],
    runs: [],
    agentServers: [],
    agentSessions: [],
    agentItems: [],
    agentGoalSnapshots: [],
    agentPlanRevisions: [],
    agentUsageSnapshots: [],
    agentSettingsObservations: [],
    agentSubagentObservations: [],
    interactionRequests: [],
    previewPlans: [],
    previewApprovals: [],
    previewComposeProjects: [],
    previewGenerations: [],
    previewManagedEnvironments: [],
    previewManagedResources: [],
    previewGenerationAttachments: [],
    previewLocalBindings: [],
    previewNodeAttempts: [],
    previewResources: [],
    events: [],
    artifacts: []
  };
}

export function applyEventToState(state: StoreState, event: DomainEvent): StoreState {
  const next: StoreState = {
    schemaVersion: state.schemaVersion,
    tasks: [...state.tasks],
    iterations: [...state.iterations],
    worktrees: [...state.worktrees],
    gitSnapshots: [...state.gitSnapshots],
    githubRepositories: [...state.githubRepositories],
    branchPublications: [...state.branchPublications],
    pullRequests: [...state.pullRequests],
    ciRollups: [...state.ciRollups],
    reviewRollups: [...state.reviewRollups],
    mergeSnapshots: [...state.mergeSnapshots],
    runs: [...state.runs],
    agentServers: [...state.agentServers],
    agentSessions: [...state.agentSessions],
    agentItems: [...state.agentItems],
    agentGoalSnapshots: [...state.agentGoalSnapshots],
    agentPlanRevisions: [...state.agentPlanRevisions],
    agentUsageSnapshots: [...state.agentUsageSnapshots],
    agentSettingsObservations: [...state.agentSettingsObservations],
    agentSubagentObservations: [...state.agentSubagentObservations],
    interactionRequests: [...state.interactionRequests],
    previewPlans: [...state.previewPlans],
    previewApprovals: [...state.previewApprovals],
    previewComposeProjects: [...state.previewComposeProjects],
    previewGenerations: [...state.previewGenerations],
    previewManagedEnvironments: [...state.previewManagedEnvironments],
    previewManagedResources: [...state.previewManagedResources],
    previewGenerationAttachments: [...state.previewGenerationAttachments],
    previewLocalBindings: [...state.previewLocalBindings],
    previewNodeAttempts: [...state.previewNodeAttempts],
    previewResources: [...state.previewResources],
    events: [...state.events, event],
    artifacts: [...state.artifacts]
  };

  const taskIndex = next.tasks.findIndex((task) => task.id === event.taskId);
  const runIndex = event.runId ? next.runs.findIndex((run) => run.id === event.runId) : -1;

  if (taskIndex === -1 && event.type !== 'TASK_CREATED') {
    return next;
  }

  if (event.type === 'TASK_CREATED') {
    return next;
  }

  // Preview is an independent Task Monki domain. Its lifecycle is persisted in
  // preview collections and must never advance or rewrite task workflow truth.
  if (event.type.startsWith('PREVIEW_')) {
    return next;
  }

  if (runIndex >= 0) {
    next.runs[runIndex] = reduceRun(next.runs[runIndex], event);
  }

  if (taskIndex >= 0) {
    const task = next.tasks[taskIndex];
    const eventTargetsCurrentIteration =
      !event.iterationId || !task.currentIterationId || event.iterationId === task.currentIterationId;
    if (!eventTargetsCurrentIteration) {
      return next;
    }
    const currentRun = event.runId
      ? next.runs.find((run) => run.id === event.runId)
      : next.runs.find((run) => run.id === task.currentRunId);
    if (
      event.runId &&
      event.runId !== task.currentRunId &&
      isAgentRunScopedEvent(event.type) &&
      !isReviewRunEvent(task, event, currentRun)
    ) {
      return next;
    }

    next.tasks[taskIndex] = {
      ...task,
      workflowPhase: reduceWorkflowPhase(task, event, currentRun),
      projection: reduceProjection(task.projection, event, currentRun, task),
      updatedAt: event.receivedAt
    };
  }

  return next;
}

function isAgentRunScopedEvent(eventType: DomainEvent['type']): boolean {
  return (
    eventType.startsWith('AGENT_') ||
    eventType === 'PROCESS_STARTED' ||
    eventType === 'PROCESS_EXITED' ||
    eventType === 'PROCESS_SIGNALED' ||
    eventType === 'CANCEL_REQUESTED'
  );
}

export function reduceRun(run: RunRecord, event: DomainEvent): RunRecord {
  switch (event.type) {
    case 'PROCESS_STARTED':
      return {
        ...run,
        status: 'RUNNING',
        lastEventAt: event.receivedAt
      };
    case 'AGENT_ACTIVITY_RECEIVED': {
      const terminalStatus = getString(event.payload, 'terminalStatus');
      const eventType = getString(event.payload, 'eventType');
      const messageText = getString(event.payload, 'messageText');

      return {
        ...run,
        eventCount: run.eventCount + 1,
        lastEventAt: event.receivedAt,
        lastEventType: eventType ?? run.lastEventType,
        status:
          terminalStatus === 'completed'
            ? 'COMPLETED'
            : terminalStatus === 'failed'
              ? 'FAILED'
              : terminalStatus === 'interrupted'
                ? 'INTERRUPTED'
                : [
                      'QUEUED',
                      'STARTING'
                    ].includes(run.status)
                  ? 'RUNNING'
                  : ['AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(run.status) &&
                      (getBoolean(event.payload, 'resumeConfirmed') === true ||
                        isAuthoritativeAgentProgress(eventType))
                    ? 'RUNNING'
                  : run.status,
        finalMessage: messageText ?? run.finalMessage
      };
    }
    case 'AGENT_INTERACTION_REQUESTED':
      return {
        ...run,
        status:
          getString(event.payload, 'type') === 'USER_INPUT'
            ? 'AWAITING_USER_INPUT'
            : 'AWAITING_APPROVAL',
        lastEventAt: event.receivedAt
      };
    case 'AGENT_INTERACTION_RESOLVED':
      return {
        ...run,
        status: getBoolean(event.payload, 'resumeConfirmed') ? 'RUNNING' : run.status,
        lastEventAt: event.receivedAt
      };
    case 'AGENT_RUN_COMPLETED':
      return {
        ...run,
        status: 'COMPLETED',
        endedAt: event.receivedAt,
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? run.finalArtifactId,
        terminalReason: getString(event.payload, 'terminalReason') ?? run.terminalReason
      };
    case 'AGENT_RUN_FAILED':
      return {
        ...run,
        status: 'FAILED',
        endedAt: event.receivedAt,
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? run.finalArtifactId,
        terminalReason:
          getString(event.payload, 'error') ??
          getString(event.payload, 'terminalReason') ??
          run.terminalReason
      };
    case 'AGENT_RUN_INTERRUPTED':
      return {
        ...run,
        status: 'INTERRUPTED',
        endedAt: event.receivedAt,
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? run.finalArtifactId,
        terminalReason:
          getString(event.payload, 'terminalReason') ??
          getString(event.payload, 'signal') ??
          'interrupted'
      };
    case 'AGENT_MUTATION_AMBIGUOUS':
      return {
        ...run,
        status: 'RECOVERY_REQUIRED',
        recoveryState: 'REQUIRES_USER_ACTION',
        terminalReason:
          getString(event.payload, 'reason') ??
          'Provider mutation delivery could not be confirmed.'
      };
    case 'AGENT_RUNTIME_LOST':
      return {
        ...run,
        status: 'RECOVERY_REQUIRED',
        recoveryState: 'RECONCILING',
        terminalReason: getString(event.payload, 'reason') ?? 'Agent runtime exited.'
      };
    case 'AGENT_RUNTIME_RECONCILED':
      return {
        ...run,
        status:
          (getString(event.payload, 'status') as RunRecord['status'] | undefined) ??
          run.status,
        recoveryState:
          (getString(
            event.payload,
            'recoveryState'
          ) as RunRecord['recoveryState'] | undefined) ?? run.recoveryState,
        endedAt:
          getBoolean(event.payload, 'terminal') === true ? event.receivedAt : run.endedAt
      };
    case 'CANCEL_REQUESTED':
      return {
        ...run,
        status: run.status === 'COMPLETED' ? run.status : 'INTERRUPTING'
      };
    default:
      return run;
  }
}

function isAuthoritativeAgentProgress(eventType: string | undefined): boolean {
  return (
    eventType === 'turn/started' ||
    eventType === 'turn/plan/updated' ||
    eventType === 'model/rerouted' ||
    eventType?.startsWith('item/') === true
  );
}

function reduceWorkflowPhase(task: Task, event: DomainEvent, run?: RunRecord): Task['workflowPhase'] {
  switch (event.type) {
    case 'TRANSITION_REQUESTED':
      if (isReviewRunEvent(task, event, run)) {
        return task.workflowPhase;
      }
      return (getString(event.payload, 'toPhase') as Task['workflowPhase'] | undefined) ?? 'IN_PROGRESS';
    case 'AGENT_RUN_STARTED':
      return getString(event.payload, 'mode') === 'REVIEW' ? task.workflowPhase : 'IN_PROGRESS';
    case 'PROCESS_STARTED':
      return isReviewRunEvent(task, event, run) ? task.workflowPhase : 'IN_PROGRESS';
    case 'AGENT_RUN_COMPLETED':
    case 'AGENT_RUN_FAILED':
    case 'AGENT_RUN_INTERRUPTED':
      return task.workflowPhase === 'IN_PROGRESS' ? 'REVIEW' : task.workflowPhase;
    case 'AGENT_RUNTIME_RECONCILED':
      return getBoolean(event.payload, 'terminal') === true &&
        task.workflowPhase === 'IN_PROGRESS'
        ? 'REVIEW'
        : task.workflowPhase;
    case 'TRANSITION_COMPLETED':
      return getString(event.payload, 'toPhase') as Task['workflowPhase'] ?? task.workflowPhase;
    case 'MERGE_SNAPSHOT_CAPTURED':
      if (mergedSnapshotSatisfiesCompletionPolicy(task, event)) {
        return 'DONE';
      }
      return task.workflowPhase;
    default:
      return task.workflowPhase;
  }
}

function mergedSnapshotSatisfiesCompletionPolicy(task: Task, event: DomainEvent): boolean {
  if (
    getString(event.payload, 'status') !== 'MERGED' ||
    !completionPolicyRequiresMerge(task.completionPolicy)
  ) {
    return false;
  }
  return task.completionPolicy === 'MERGED';
}

function isReviewRunEvent(task: Task, event: DomainEvent, run?: RunRecord): boolean {
  return (
    run?.mode === 'REVIEW' ||
    getString(event.payload, 'mode') === 'REVIEW' ||
    Boolean(event.runId && task.projection.codexReview?.runId === event.runId)
  );
}

export function reduceProjection(
  projection: StatusProjection | undefined,
  event: DomainEvent,
  run?: RunRecord,
  task?: Task
): StatusProjection {
  const base = projection ?? createInitialProjection(event.receivedAt);
  const findings = mergeFindings(base.findings, findingsForEvent(event, run));
  if (isCodexReviewProjectionEvent(base, event, run)) {
    return reduceReviewProjection(base, event, run, findings);
  }

  switch (event.type) {
    case 'REPOSITORY_PREFLIGHT_COMPLETED':
      return {
        ...base,
        repositoryPreflight: getString(event.payload, 'status') === 'VALID' ? 'VALID' : 'INVALID',
        health: getString(event.payload, 'status') === 'VALID' ? 'INFO' : 'ERROR',
        summary:
          getString(event.payload, 'status') === 'VALID'
            ? 'Repository preflight passed.'
            : 'Repository preflight failed.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TASK_ITERATION_CREATED':
      return {
        ...base,
        requestedAction: 'REQUESTED',
        worktree: 'CREATING',
        git: 'NOT_INSPECTED',
        summary: 'Task iteration created; preparing isolated worktree.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'WORKTREE_CREATE_REQUESTED':
      return {
        ...base,
        worktree: 'CREATING',
        summary: 'Creating isolated Git worktree for this task.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'WORKTREE_CREATED':
    case 'WORKTREE_VERIFIED': {
      const status = getString(event.payload, 'status');
      return {
        ...base,
        worktree: isWorktreeProjectionStatus(status) ? status : 'PRESENT',
        health: status === 'ERROR' || status === 'MISSING' ? 'ERROR' : base.health,
        summary:
          event.type === 'WORKTREE_CREATED'
            ? 'Isolated worktree is ready.'
            : 'Worktree verification completed.',
        findings,
        updatedAt: event.receivedAt
      };
    }
    case 'WORKTREE_FAILED':
      return {
        ...base,
        worktree: 'ERROR',
        health: 'ERROR',
        summary: 'Worktree creation or verification failed.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TRANSITION_REQUESTED':
      return {
        ...base,
        requestedAction: 'REQUESTED',
        summary: 'Agent turn requested.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TRANSITION_COMPLETED':
      return {
        ...base,
        requestedAction: 'SUCCEEDED',
        summary: transitionCompletedSummary(event.payload),
        findings,
        updatedAt: event.receivedAt
      };
    case 'TRANSITION_BLOCKED':
      return {
        ...base,
        requestedAction: 'FAILED',
        health: 'BLOCKED',
        summary: getString(event.payload, 'reason') ?? 'Workflow transition blocked by missing evidence.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUN_STARTED':
      return {
        ...base,
        requestedAction: 'STARTING',
        agentRun: 'STARTING',
        osProcess: 'SPAWNING',
        codexReview: reduceCodexReview(base.codexReview, event, run),
        summary:
          getString(event.payload, 'mode') === 'IMPLEMENTATION'
            ? 'Starting an implementation turn in the task worktree.'
            : getString(event.payload, 'mode') === 'REVIEW'
              ? 'Starting a Codex review of the current diff.'
            : 'Starting an agent turn.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_STARTED':
      return {
        ...base,
        requestedAction: 'RUNNING',
        agentRun: 'RUNNING',
        osProcess: 'RUNNING',
        health: 'INFO',
        summary: 'Agent turn is active.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'GIT_SNAPSHOT_CAPTURED': {
      const gitStatus = getGitStatus(event.payload);
      const codexReview = reduceCodexReview(base.codexReview, event, run);
      return {
        ...base,
        git: gitStatus ?? base.git,
        codexReview,
        health:
          gitStatus === 'CONFLICTED' || gitStatus === 'UNAVAILABLE'
            ? 'ERROR'
            : base.health,
        summary: gitSnapshotSummary(base, codexReview, gitStatus),
        findings,
        updatedAt: event.receivedAt
      };
    }
    case 'DELIVERY_COMMIT_CREATED':
      return {
        ...base,
        git: 'COMMITTED_UNPUSHED',
        ciChecks: base.githubPullRequest === 'UNLINKED' ? base.ciChecks : 'STALE',
        codexReview: reduceCodexReview(base.codexReview, event, run),
        health: maxHealth(base.health, 'WARNING'),
        summary: 'Delivery commit created. Push and refresh PR status for current GitHub evidence.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'GITHUB_PREFLIGHT_COMPLETED':
      return {
        ...base,
        githubRepository: getGitHubRepositoryStatus(event.payload) ?? base.githubRepository,
        health:
          getGitHubRepositoryStatus(event.payload) === 'READY'
            ? base.health
            : maxHealth(base.health, 'WARNING'),
        summary:
          getGitHubRepositoryStatus(event.payload) === 'READY'
            ? 'GitHub remote and gh authentication are ready.'
            : 'GitHub capability check needs attention.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'BRANCH_PUBLISH_REQUESTED':
      return {
        ...base,
        branchPublication: 'PUSHING',
        summary: 'Publishing task branch to remote.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'BRANCH_PUBLISHED':
      return {
        ...base,
        branchPublication: 'PUSHED',
        git: 'PUSHED',
        summary: 'Task branch was pushed to the remote.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'BRANCH_PUBLISH_FAILED':
      return {
        ...base,
        branchPublication: getString(event.payload, 'status') === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'FAILED',
        health: 'ERROR',
        summary: 'Branch publication failed; reconcile remote state before retry.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PR_CREATE_REQUESTED':
      return {
        ...base,
        githubPullRequest: 'NOT_CREATED',
        summary: 'Creating or locating a draft pull request.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PR_SNAPSHOT_CAPTURED':
      return {
        ...base,
        githubPullRequest: getPullRequestStatus(event.payload) ?? base.githubPullRequest,
        githubPullRequestNumber: getNumber(event.payload, 'number') ?? base.githubPullRequestNumber,
        githubPullRequestUrl: getString(event.payload, 'url') ?? base.githubPullRequestUrl,
        summary: `Pull request status: ${getPullRequestStatus(event.payload) ?? 'UNKNOWN'}.`,
        findings,
        updatedAt: event.receivedAt
      };
    case 'CI_ROLLUP_CAPTURED':
      return {
        ...base,
        ciChecks: getCiChecksStatus(event.payload) ?? base.ciChecks,
        health:
          getCiChecksStatus(event.payload) === 'FAILING' || getCiChecksStatus(event.payload) === 'BLOCKED'
            ? 'ERROR'
            : base.health,
        summary: `GitHub checks: ${getCiChecksStatus(event.payload) ?? 'UNKNOWN'}.`,
        findings,
        updatedAt: event.receivedAt
      };
    case 'REVIEW_ROLLUP_CAPTURED':
      return {
        ...base,
        reviews: getReviewStatus(event.payload) ?? base.reviews,
        health: getReviewStatus(event.payload) === 'CHANGES_REQUESTED' ? 'WARNING' : base.health,
        summary: `GitHub reviews: ${getReviewStatus(event.payload) ?? 'UNKNOWN'}.`,
        findings,
        updatedAt: event.receivedAt
      };
    case 'MERGE_SNAPSHOT_CAPTURED': {
      const merge = getMergeStatus(event.payload) ?? base.merge;
      const completionSatisfied = task
        ? mergedSnapshotSatisfiesCompletionPolicy(task, event)
        : merge === 'MERGED';
      return {
        ...base,
        merge,
        health:
          merge === 'MERGED'
            ? completionSatisfied
              ? 'HEALTHY'
              : base.health
            : merge === 'CLOSED_UNMERGED' || merge === 'BLOCKED'
              ? 'ERROR'
              : base.health,
        summary:
          merge === 'MERGED' && completionSatisfied
            ? 'GitHub reports the pull request merged. Completion policy is satisfied.'
            : merge === 'MERGED'
              ? 'GitHub reports the pull request merged.'
            : `GitHub merge state: ${merge}.`,
        findings,
        updatedAt: event.receivedAt
      };
    }
    case 'GITHUB_SYNC_FAILED':
      return {
        ...base,
        health: maxHealth(base.health, 'WARNING'),
        summary: 'GitHub sync failed; last-known remote state may be stale.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROMPT_REFINED':
      return {
        ...base,
        summary: 'Prompt refined into a structured implementation request.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_INTERACTION_REQUESTED':
      return {
        ...base,
        agentRun:
          getString(event.payload, 'type') === 'USER_INPUT'
            ? 'AWAITING_USER_INPUT'
            : 'AWAITING_APPROVAL',
        health: 'WARNING',
        summary:
          getString(event.payload, 'type') === 'USER_INPUT'
            ? 'Agent turn is waiting for user input.'
            : 'Agent turn is waiting for an approval decision.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_INTERACTION_RESOLVED':
      return {
        ...base,
        agentRun: run?.status ?? base.agentRun,
        summary:
          run?.status === 'RUNNING'
            ? 'Agent interaction was resolved and the turn resumed.'
            : 'Agent interaction was resolved; waiting for authoritative turn progress.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_ACTIVITY_RECEIVED':
      return {
        ...base,
        agentRun: run?.status ?? base.agentRun,
        health: run?.status === 'RUNNING' ? 'INFO' : base.health,
        summary: `Latest agent event: ${getString(event.payload, 'eventType') ?? 'unknown'}.`,
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_GOAL_UPDATED':
      return {
        ...base,
        health:
          getString(event.payload, 'syncState') === 'DIVERGED'
            ? maxHealth(base.health, 'WARNING')
            : base.health,
        summary:
          getString(event.payload, 'syncState') === 'DIVERGED'
            ? 'The provider goal diverges from Task Monki’s authoritative goal.'
            : base.summary,
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_GOAL_CLEARED':
    case 'AGENT_GOAL_SYNC_FAILED':
      return {
        ...base,
        health: maxHealth(base.health, 'WARNING'),
        summary:
          event.type === 'AGENT_GOAL_CLEARED'
            ? 'The provider goal was cleared; Task Monki’s goal remains authoritative.'
            : 'Task Monki could not confirm provider goal synchronization.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_PROTOCOL_INCIDENT':
      return {
        ...base,
        health: maxHealth(base.health, 'WARNING'),
        summary: 'The agent runtime emitted malformed or incomplete protocol output.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'CANCEL_REQUESTED':
      return {
        ...base,
        requestedAction: 'CANCEL_REQUESTED',
        agentRun: base.agentRun === 'COMPLETED' ? base.agentRun : 'INTERRUPTING',
        osProcess: 'CANCELING',
        health: 'WARNING',
        summary: 'Interruption requested; waiting for an authoritative terminal event.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUN_COMPLETED':
      return {
        ...base,
        requestedAction: 'SUCCEEDED',
        agentRun: 'COMPLETED',
        osProcess: terminalOsProcess(base.osProcess),
        codexReview: reduceCodexReview(base.codexReview, event, run),
        artifact: 'FINAL_MESSAGE_PRESENT',
        health: findings.some((finding) => finding.severity === 'WARNING') ? 'WARNING' : 'HEALTHY',
        summary: 'Agent turn completed. Review the provider result and independent Git evidence.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUN_FAILED':
      return {
        ...base,
        requestedAction: 'FAILED',
        agentRun: 'FAILED',
        osProcess: terminalOsProcess(base.osProcess),
        codexReview: reduceCodexReview(base.codexReview, event, run),
        health: 'ERROR',
        summary: 'Agent turn failed. Review provider activity and diagnostics.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUN_INTERRUPTED':
      return {
        ...base,
        requestedAction: 'CANCELED',
        agentRun: 'INTERRUPTED',
        osProcess: terminalOsProcess(base.osProcess),
        codexReview: reduceCodexReview(base.codexReview, event, run),
        health: 'WARNING',
        summary: 'Agent turn was interrupted; the session remains available for continuation.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_MUTATION_AMBIGUOUS':
      return {
        ...base,
        requestedAction: 'FAILED',
        agentRun: 'RECOVERY_REQUIRED',
        codexReview: reduceCodexReview(base.codexReview, event, run),
        health: 'WARNING',
        summary:
          'Turn submission may have reached the provider. Task Monki will not resubmit it automatically.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_REVIEW_POLICY_VIOLATION':
      return {
        ...base,
        health: 'ERROR',
        summary: 'A read-only review changed independent Git state.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUNTIME_LOST':
      return {
        ...base,
        requestedAction: 'FAILED',
        agentRun: 'RECOVERY_REQUIRED',
        osProcess: 'ORPHANED',
        codexReview: reduceCodexReview(base.codexReview, event, run),
        health: 'WARNING',
        summary: 'The agent runtime exited; Task Monki is reconciling the persisted session.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUNTIME_RECONCILED':
      return {
        ...base,
        agentRun:
          (getString(event.payload, 'status') as StatusProjection['agentRun'] | undefined) ??
          base.agentRun,
        codexReview: reduceCodexReview(base.codexReview, event, run),
        health:
          getString(event.payload, 'recoveryState') === 'RECOVERED'
            ? base.health
            : 'WARNING',
        summary:
          getString(event.payload, 'recoveryState') === 'RECOVERED'
            ? 'Agent session state was reconciled after runtime restart.'
            : 'Agent session recovery requires user action.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_EXITED':
      return {
        ...base,
        osProcess: 'EXITED',
        health: getNullableNumber(event.payload, 'exitCode') === 0 ? base.health : 'ERROR',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_SIGNALED':
      return {
        ...base,
        requestedAction: 'CANCELED',
        osProcess: 'SIGNALED',
        health: 'WARNING',
        summary: 'The local runtime ended after a signal.',
        findings,
        updatedAt: event.receivedAt
      };
    default:
      return {
        ...base,
        findings,
        updatedAt: event.receivedAt
      };
  }
}

function isCodexReviewProjectionEvent(
  projection: StatusProjection,
  event: DomainEvent,
  run?: RunRecord
): boolean {
  return (
    getString(event.payload, 'mode') === 'REVIEW' ||
    Boolean(
      event.runId &&
        (run?.mode === 'REVIEW' || projection.codexReview?.runId === event.runId)
    )
  );
}

function reduceReviewProjection(
  base: StatusProjection,
  event: DomainEvent,
  run: RunRecord | undefined,
  findings: Finding[]
): StatusProjection {
  switch (event.type) {
    case 'AGENT_RUN_STARTED':
    case 'AGENT_RUN_COMPLETED':
    case 'AGENT_RUN_FAILED':
    case 'AGENT_RUN_INTERRUPTED':
    case 'AGENT_MUTATION_AMBIGUOUS':
    case 'AGENT_RUNTIME_LOST':
    case 'AGENT_RUNTIME_RECONCILED': {
      const codexReview = reduceCodexReview(base.codexReview, event, run);
      return {
        ...base,
        codexReview,
        findings,
        summary: codexReview?.summary ?? base.summary,
        updatedAt: event.receivedAt
      };
    }
    case 'AGENT_ACTIVITY_RECEIVED':
      return {
        ...base,
        summary: `Latest Codex review event: ${getString(event.payload, 'eventType') ?? 'unknown'}.`,
        findings,
        updatedAt: event.receivedAt
      };
    case 'CANCEL_REQUESTED':
      return {
        ...base,
        summary: 'Codex review stop requested; waiting for the review turn to end.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_STARTED':
      return {
        ...base,
        summary: 'Codex review process is active.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_EXITED':
    case 'PROCESS_SIGNALED':
      return {
        ...base,
        findings,
        updatedAt: event.receivedAt
      };
    case 'AGENT_INTERACTION_REQUESTED':
    case 'AGENT_INTERACTION_RESOLVED':
      return {
        ...base,
        summary: 'Codex review interaction state changed.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TRANSITION_REQUESTED':
      return {
        ...base,
        findings,
        updatedAt: event.receivedAt
      };
    default:
      return {
        ...base,
        findings,
        updatedAt: event.receivedAt
      };
  }
}

function reduceCodexReview(
  review: StatusProjection['codexReview'] | undefined,
  event: DomainEvent,
  run?: RunRecord
): StatusProjection['codexReview'] {
  const base = review ?? { status: 'NOT_RUN' as const };
  const eventMode = getString(event.payload, 'mode') ?? run?.mode;
  const eventRunId = event.runId ?? run?.id;
  const targetsReviewRun =
    run?.mode === 'REVIEW' ||
    eventMode === 'REVIEW' ||
    (Boolean(base.runId) && Boolean(eventRunId) && base.runId === eventRunId);

  switch (event.type) {
    case 'AGENT_RUN_STARTED': {
      if (eventMode === 'REVIEW') {
        return {
          status: 'RUNNING',
          runId: eventRunId,
          sourceRunId: run?.continuedFromRunId,
          reviewedGitSnapshotId:
            getString(event.payload, 'beforeGitSnapshotId') ?? run?.beforeGitSnapshotId,
          reviewedHeadSha: getString(event.payload, 'reviewedHeadSha'),
          reviewedDirtyFingerprint: getString(event.payload, 'reviewedDirtyFingerprint'),
          summary: 'Codex is reviewing the current diff.',
          updatedAt: event.receivedAt
        };
      }
      if (base.status !== 'NOT_RUN' && base.status !== 'RUNNING') {
        return {
          ...base,
          status: 'STALE',
          summary: 'Implementation changed after this Codex review.',
          updatedAt: event.receivedAt
        };
      }
      return base;
    }
    case 'AGENT_RUN_COMPLETED':
      if (!targetsReviewRun) {
        return base;
      }
      const result = getCodexReviewResult(event.payload);
      return {
        ...base,
        status:
          reviewGateStatusFromPayload(event.payload) ??
          reviewGateStatusFromResult(result) ??
          'INCONCLUSIVE',
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? base.finalArtifactId,
        result,
        summary:
          result?.summary ??
          'Codex review completed, but no structured pass/fail verdict was provided.',
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUN_FAILED':
    case 'AGENT_MUTATION_AMBIGUOUS':
    case 'AGENT_RUNTIME_LOST':
      if (!targetsReviewRun) {
        return base;
      }
      return {
        ...base,
        status: 'FAILED',
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? base.finalArtifactId,
        summary:
          getString(event.payload, 'error') ??
          getString(event.payload, 'terminalReason') ??
          getString(event.payload, 'reason') ??
          'Codex review did not complete.',
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUN_INTERRUPTED':
      if (!targetsReviewRun) {
        return base;
      }
      return {
        ...base,
        status: 'CANCELED',
        summary: 'Codex review was stopped before it produced a final result.',
        updatedAt: event.receivedAt
      };
    case 'AGENT_RUNTIME_RECONCILED':
      if (!targetsReviewRun || getBoolean(event.payload, 'terminal') !== true) {
        return base;
      }
      return {
        ...base,
        status:
          getString(event.payload, 'status') === 'COMPLETED'
            ? 'INCONCLUSIVE'
            : getString(event.payload, 'status') === 'INTERRUPTED'
              ? 'CANCELED'
              : 'FAILED',
        summary: 'Codex review state was reconciled after runtime restart.',
        updatedAt: event.receivedAt
      };
    case 'GIT_SNAPSHOT_CAPTURED':
      if (!isTerminalReviewGate(base) || !snapshotDiffersFromReview(base, event.payload)) {
        return base;
      }
      return {
        ...base,
        status: 'STALE',
        summary: 'The current diff changed after this Codex review.',
        updatedAt: event.receivedAt
      };
    case 'DELIVERY_COMMIT_CREATED': {
      const headSha = getString(event.payload, 'headSha');
      if (!isTerminalReviewGate(base) || !headSha) {
        return base;
      }
      return {
        ...base,
        reviewedHeadSha: headSha,
        reviewedDirtyFingerprint: undefined,
        updatedAt: event.receivedAt
      };
    }
    default:
      return base;
  }
}

function terminalOsProcess(osProcess: StatusProjection['osProcess']): StatusProjection['osProcess'] {
  return osProcess === 'SPAWNING' || osProcess === 'RUNNING' || osProcess === 'CANCELING'
    ? 'EXITED'
    : osProcess;
}

function gitSnapshotSummary(
  base: StatusProjection,
  codexReview: StatusProjection['codexReview'] | undefined,
  gitStatus: StatusProjection['git'] | undefined
): string {
  if (
    codexReview?.status === 'STALE' &&
    base.codexReview?.status !== 'STALE' &&
    codexReview.summary
  ) {
    return codexReview.summary;
  }
  if (
    codexReview &&
    isTerminalReviewGate(codexReview) &&
    codexReview.summary
  ) {
    return codexReview.summary;
  }
  return `Git snapshot captured: ${gitStatus ?? 'UNKNOWN'}.`;
}

function isTerminalReviewGate(
  review: StatusProjection['codexReview'] | undefined
): boolean {
  return Boolean(
    review &&
      [
        'PASSED',
        'NEEDS_CHANGES',
        'INCONCLUSIVE',
        'FAILED',
        'CANCELED'
      ].includes(review.status)
  );
}

function snapshotDiffersFromReview(
  review: NonNullable<StatusProjection['codexReview']>,
  payload: unknown
): boolean {
  const headSha = getString(payload, 'headSha');
  const dirtyFingerprint = getString(payload, 'dirtyFingerprint');
  if (review.reviewedHeadSha || review.reviewedDirtyFingerprint) {
    return (
      (Boolean(review.reviewedHeadSha) && review.reviewedHeadSha !== headSha) ||
      (Boolean(review.reviewedDirtyFingerprint) &&
        review.reviewedDirtyFingerprint !== dirtyFingerprint)
    );
  }

  const snapshotId = getString(payload, 'id');
  return Boolean(review.reviewedGitSnapshotId && snapshotId && review.reviewedGitSnapshotId !== snapshotId);
}

function reviewGateStatusFromPayload(
  payload: unknown
): Extract<
  NonNullable<StatusProjection['codexReview']>['status'],
  'PASSED' | 'NEEDS_CHANGES' | 'INCONCLUSIVE'
> | undefined {
  const value = getString(payload, 'codexReviewStatus') ?? getString(payload, 'reviewVerdict');
  if (value === 'PASSED' || value === 'NEEDS_CHANGES' || value === 'INCONCLUSIVE') {
    return value;
  }
  return undefined;
}

function reviewGateStatusFromResult(
  result: CodexReviewResult | undefined
): Extract<
  NonNullable<StatusProjection['codexReview']>['status'],
  'PASSED' | 'NEEDS_CHANGES' | 'INCONCLUSIVE'
> | undefined {
  if (!result) {
    return undefined;
  }
  if (
    result.verdict === 'NEEDS_CHANGES' ||
    result.findings.some(
      (finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR'
    )
  ) {
    return 'NEEDS_CHANGES';
  }
  if (result.verdict === 'PASSED') {
    return 'PASSED';
  }
  return 'INCONCLUSIVE';
}

function getCodexReviewResult(payload: unknown): CodexReviewResult | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>).codexReviewResult;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const verdict = isOneOf(getString(record, 'verdict'), [
    'PASSED',
    'NEEDS_CHANGES',
    'INCONCLUSIVE'
  ]);
  const summary = getString(record, 'summary');
  const findingsValue = record.findings;
  if (!verdict || !summary || !Array.isArray(findingsValue)) {
    return undefined;
  }
  const findings = findingsValue
    .map(getCodexReviewFinding)
    .filter((finding): finding is CodexReviewFinding => Boolean(finding));
  return {
    schemaVersion: 'codex-review/v1',
    verdict,
    summary,
    findings
  };
}

function getCodexReviewFinding(value: unknown): CodexReviewFinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const severity = isOneOf(getString(record, 'severity'), [
    'BLOCKER',
    'MAJOR',
    'MINOR',
    'NIT'
  ]);
  const id = getString(record, 'id');
  const title = getString(record, 'title');
  const explanation = getString(record, 'explanation');
  if (!severity || !id || !title || !explanation) {
    return undefined;
  }
  return {
    id,
    severity,
    title,
    explanation,
    path: getString(record, 'path'),
    line: getNumber(record, 'line'),
    endLine: getNumber(record, 'endLine'),
    recommendation: getString(record, 'recommendation')
  };
}

function findingsForEvent(event: DomainEvent, run?: RunRecord): Finding[] {
  if (event.type === 'AGENT_PROTOCOL_INCIDENT') {
    return [
      {
        id: `${event.id}:protocol`,
        code: 'AGENT_PROTOCOL_INCIDENT',
        severity: 'WARNING',
        message:
          getString(event.payload, 'parseError') ??
          'The agent runtime emitted malformed or incomplete protocol output.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'AGENT_MUTATION_AMBIGUOUS') {
    return [
      {
        id: `${event.id}:ambiguous-mutation`,
        code: 'AGENT_MUTATION_AMBIGUOUS',
        severity: 'WARNING',
        message:
          getString(event.payload, 'reason') ??
          'Provider mutation delivery is ambiguous; automatic resubmission is disabled.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'AGENT_REVIEW_POLICY_VIOLATION') {
    return [
      {
        id: `${event.id}:review-policy`,
        code: 'AGENT_REVIEW_CHANGED_GIT',
        severity: 'ERROR',
        message: 'The provider review changed Git state despite a read-only policy.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'PROCESS_EXITED' && getNullableNumber(event.payload, 'exitCode') !== 0) {
    return [
      {
        id: `${event.id}:exit`,
        code: 'PROCESS_NON_ZERO_EXIT',
        severity: 'ERROR',
        message: `Process exited with code ${getNullableNumber(event.payload, 'exitCode')}.`,
        createdAt: event.receivedAt
      }
    ];
  }

  if (
    event.type === 'PROCESS_EXITED' &&
    run &&
    !['COMPLETED', 'FAILED', 'INTERRUPTED'].includes(run.status)
  ) {
    return [
      {
        id: `${event.id}:unknown-agent-terminal`,
        code: 'PROCESS_EXITED_WITHOUT_AGENT_TERMINAL_EVENT',
        severity: 'WARNING',
        message: 'The runtime exited before an authoritative agent terminal event was observed.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'WORKTREE_FAILED') {
    return [
      {
        id: `${event.id}:worktree`,
        code: 'WORKTREE_OPERATION_FAILED',
        severity: 'ERROR',
        message: getString(event.payload, 'error') ?? 'Worktree operation failed.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'TRANSITION_BLOCKED') {
    return [
      {
        id: `${event.id}:transition-blocked`,
        code: 'WORKFLOW_TRANSITION_BLOCKED',
        severity: 'BLOCKED',
        message: getString(event.payload, 'reason') ?? 'Transition blocked.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'GITHUB_PREFLIGHT_COMPLETED' && getString(event.payload, 'status') !== 'READY') {
    return [
      {
        id: `${event.id}:github-preflight`,
        code: 'GITHUB_PREFLIGHT_NOT_READY',
        severity: 'WARNING',
        message: getString(event.payload, 'error') ?? 'GitHub remote or gh authentication is not ready.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'BRANCH_PUBLISH_FAILED') {
    return [
      {
        id: `${event.id}:branch-publish`,
        code: 'BRANCH_PUBLISH_FAILED',
        severity: 'ERROR',
        message: getString(event.payload, 'error') ?? 'Branch publication failed.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'MERGE_SNAPSHOT_CAPTURED' && getString(event.payload, 'status') === 'CLOSED_UNMERGED') {
    return [
      {
        id: `${event.id}:closed-unmerged`,
        code: 'PR_CLOSED_WITHOUT_MERGE',
        severity: 'ERROR',
        message: 'GitHub reports the pull request was closed without merge.',
        createdAt: event.receivedAt
      }
    ];
  }

  return [];
}

function mergeFindings(existing: Finding[], additions: Finding[]): Finding[] {
  if (additions.length === 0) {
    return existing;
  }

  const byCode = new Map(existing.map((finding) => [finding.code, finding]));
  for (const finding of additions) {
    byCode.set(finding.code, finding);
  }
  return [...byCode.values()];
}

function maxHealth(a: HealthStatus, b: HealthStatus): HealthStatus {
  const order: HealthStatus[] = ['HEALTHY', 'INFO', 'WARNING', 'ERROR', 'BLOCKED'];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function getString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function getBoolean(payload: unknown, key: string): boolean | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getGitStatus(payload: unknown): StatusProjection['git'] | undefined {
  const value = getString(payload, 'status');
  if (
    value === 'NOT_INSPECTED' ||
    value === 'CLEAN' ||
    value === 'DIRTY' ||
    value === 'COMMITTED_UNPUSHED' ||
    value === 'PUSHED' ||
    value === 'CONFLICTED' ||
    value === 'DIVERGED' ||
    value === 'UNAVAILABLE' ||
    value === 'UNKNOWN'
  ) {
    return value;
  }
  return undefined;
}

function isWorktreeProjectionStatus(value: string | undefined): value is StatusProjection['worktree'] {
  return (
    value === 'NOT_CREATED' ||
    value === 'CREATING' ||
    value === 'PRESENT' ||
    value === 'LOCKED' ||
    value === 'PRUNABLE' ||
    value === 'MISSING' ||
    value === 'REMOVING' ||
    value === 'REMOVED' ||
    value === 'ERROR' ||
    value === 'UNKNOWN'
  );
}

function getGitHubRepositoryStatus(payload: unknown): StatusProjection['githubRepository'] | undefined {
  const value = getString(payload, 'status');
  return isOneOf(value, [
    'NOT_CHECKED',
    'READY',
    'MISSING_REMOTE',
    'GH_MISSING',
    'AUTH_REQUIRED',
    'UNSUPPORTED_HOST',
    'ERROR',
    'UNKNOWN'
  ]);
}

function getPullRequestStatus(payload: unknown): PullRequestSnapshotRecord['status'] | undefined {
  const value = getString(payload, 'status');
  return isOneOf(value, [
    'UNLINKED',
    'NOT_CREATED',
    'OPEN_DRAFT',
    'OPEN_READY',
    'CLOSED_UNMERGED',
    'MERGED',
    'UNKNOWN'
  ]);
}

function getCiChecksStatus(payload: unknown): StatusProjection['ciChecks'] | undefined {
  const value = getString(payload, 'status');
  return isOneOf(value, [
    'NOT_APPLICABLE',
    'NO_CHECKS',
    'EXPECTED_NOT_REPORTED',
    'PENDING',
    'PASSING',
    'FAILING',
    'CANCELED',
    'BLOCKED',
    'STALE',
    'UNKNOWN'
  ]);
}

function getReviewStatus(payload: unknown): StatusProjection['reviews'] | undefined {
  const value = getString(payload, 'status');
  return isOneOf(value, [
    'NOT_APPLICABLE',
    'NOT_REQUESTED',
    'REQUESTED',
    'PENDING',
    'CHANGES_REQUESTED',
    'APPROVED',
    'SATISFIED',
    'STALE',
    'UNKNOWN'
  ]);
}

function getMergeStatus(payload: unknown): StatusProjection['merge'] | undefined {
  const value = getString(payload, 'status');
  return isOneOf(value, [
    'NOT_APPLICABLE',
    'NOT_MERGED',
    'COMPUTING',
    'MERGEABLE',
    'BLOCKED',
    'QUEUED',
    'MERGED',
    'CLOSED_UNMERGED',
    'UNKNOWN'
  ]);
}

function isOneOf<const T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function transitionCompletedSummary(payload: unknown): string {
  const toPhase = getString(payload, 'toPhase');
  return `Workflow moved to ${toPhase ?? 'the requested phase'}.`;
}

function getNumber(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

function getNullableNumber(payload: unknown, key: string): number | null | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' || value === null ? value : undefined;
}
