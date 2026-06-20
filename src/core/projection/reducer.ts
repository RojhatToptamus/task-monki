import type {
  DomainEvent,
  Finding,
  HealthStatus,
  RunRecord,
  StatusProjection,
  Task,
  TaskSnapshot,
  TestRunRecord,
  PullRequestSnapshotRecord
} from '../../shared/contracts';
import { createInitialProjection } from '../../shared/contracts';

export interface StoreState extends TaskSnapshot {}

export function createEmptyState(): StoreState {
  return {
    tasks: [],
    iterations: [],
    worktrees: [],
    gitSnapshots: [],
    testRuns: [],
    githubRepositories: [],
    branchPublications: [],
    pullRequests: [],
    ciRollups: [],
    reviewRollups: [],
    mergeSnapshots: [],
    runs: [],
    events: [],
    artifacts: []
  };
}

export function applyEventToState(state: StoreState, event: DomainEvent): StoreState {
  const next: StoreState = {
    tasks: [...state.tasks],
    iterations: [...state.iterations],
    worktrees: [...state.worktrees],
    gitSnapshots: [...state.gitSnapshots],
    testRuns: [...state.testRuns],
    githubRepositories: [...state.githubRepositories],
    branchPublications: [...state.branchPublications],
    pullRequests: [...state.pullRequests],
    ciRollups: [...state.ciRollups],
    reviewRollups: [...state.reviewRollups],
    mergeSnapshots: [...state.mergeSnapshots],
    runs: [...state.runs],
    events: [...state.events, event],
    artifacts: [...state.artifacts]
  };

  const taskIndex = next.tasks.findIndex((task) => task.id === event.taskId);
  const runIndex = event.runId ? next.runs.findIndex((run) => run.id === event.runId) : -1;
  const testRunIndex = event.testRunId
    ? next.testRuns.findIndex((testRun) => testRun.id === event.testRunId)
    : -1;

  if (taskIndex === -1 && event.type !== 'TASK_CREATED') {
    return next;
  }

  if (event.type === 'TASK_CREATED') {
    return next;
  }

  if (runIndex >= 0) {
    next.runs[runIndex] = reduceRun(next.runs[runIndex], event);
  }

  if (testRunIndex >= 0) {
    next.testRuns[testRunIndex] = reduceTestRun(next.testRuns[testRunIndex], event);
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

    next.tasks[taskIndex] = {
      ...task,
      workflowPhase: reduceWorkflowPhase(task, event),
      projection: reduceProjection(task.projection, event, currentRun),
      updatedAt: event.receivedAt
    };
  }

  return next;
}

export function reduceTestRun(testRun: TestRunRecord, event: DomainEvent): TestRunRecord {
  switch (event.type) {
    case 'TEST_PROCESS_STARTED':
      return {
        ...testRun,
        status: 'RUNNING',
        processStatus: 'RUNNING'
      };
    case 'TEST_RUN_COMPLETED': {
      const exitCode = getNullableNumber(event.payload, 'exitCode');
      const signal = getString(event.payload, 'signal') as NodeJS.Signals | undefined;
      const error = getString(event.payload, 'error');
      return {
        ...testRun,
        status: error ? 'ERROR' : signal ? 'CANCELED' : exitCode === 0 ? 'PASSED' : 'FAILED',
        processStatus: signal ? 'SIGNALED' : 'EXITED',
        exitCode,
        signal: signal ?? null,
        endedAt: event.receivedAt
      };
    }
    case 'TEST_RESULT_STALE':
      return {
        ...testRun,
        status: 'STALE',
        staleReason: getString(event.payload, 'reason')
      };
    default:
      return testRun;
  }
}

export function reduceRun(run: RunRecord, event: DomainEvent): RunRecord {
  switch (event.type) {
    case 'PROCESS_STARTED':
      return {
        ...run,
        processStatus: 'RUNNING',
        status: 'RUNNING',
        pid: getNumber(event.payload, 'pid'),
        lastEventAt: event.receivedAt
      };
    case 'CODEX_EVENT_PARSED': {
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
                ? 'CANCELED'
                : run.status === 'QUEUED' || run.status === 'STARTING'
                  ? 'RUNNING'
                  : run.status,
        finalMessage: messageText ?? run.finalMessage
      };
    }
    case 'CODEX_RUN_COMPLETED':
      return {
        ...run,
        status: 'COMPLETED',
        endedAt: event.receivedAt,
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? run.finalArtifactId
      };
    case 'CODEX_RUN_FAILED':
      return {
        ...run,
        status: 'FAILED',
        endedAt: event.receivedAt,
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? run.finalArtifactId
      };
    case 'PROCESS_EXITED':
      return {
        ...run,
        processStatus: 'EXITED',
        exitCode: getNullableNumber(event.payload, 'exitCode'),
        signal: null,
        endedAt: event.receivedAt
      };
    case 'PROCESS_SIGNALED':
      return {
        ...run,
        processStatus: 'SIGNALED',
        signal: getString(event.payload, 'signal') as NodeJS.Signals | null,
        exitCode: null,
        endedAt: event.receivedAt,
        status: run.status === 'COMPLETED' ? run.status : 'CANCELED'
      };
    case 'CANCEL_REQUESTED':
      return {
        ...run,
        processStatus: 'CANCELING',
        status: run.status === 'COMPLETED' ? run.status : 'CANCELED'
      };
    default:
      return run;
  }
}

function reduceWorkflowPhase(task: Task, event: DomainEvent): Task['workflowPhase'] {
  switch (event.type) {
    case 'TRANSITION_REQUESTED':
    case 'ACTION_ATTEMPT_STARTED':
    case 'PROCESS_STARTED':
      return 'IN_PROGRESS';
    case 'CODEX_RUN_COMPLETED':
    case 'CODEX_RUN_FAILED':
    case 'PROCESS_EXITED':
    case 'PROCESS_SIGNALED':
      return task.workflowPhase === 'IN_PROGRESS' ? 'REVIEW' : task.workflowPhase;
    case 'TEST_RUN_STARTED':
    case 'TEST_PROCESS_STARTED':
      return 'TESTING';
    case 'TRANSITION_COMPLETED':
      return getString(event.payload, 'toPhase') as Task['workflowPhase'] ?? task.workflowPhase;
    case 'MERGE_SNAPSHOT_CAPTURED':
      if (getString(event.payload, 'status') === 'MERGED') {
        return 'DONE';
      }
      return task.workflowPhase;
    default:
      return task.workflowPhase;
  }
}

export function reduceProjection(
  projection: StatusProjection | undefined,
  event: DomainEvent,
  run?: RunRecord
): StatusProjection {
  const base = projection ?? createInitialProjection(event.receivedAt);
  const findings = mergeFindings(base.findings, findingsForEvent(event, run));

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
        tests: 'NOT_RUN',
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
        summary: 'Codex run requested.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TRANSITION_COMPLETED':
      return {
        ...base,
        requestedAction: 'SUCCEEDED',
        summary: `Workflow moved to ${getString(event.payload, 'toPhase') ?? 'the requested phase'}.`,
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
    case 'ACTION_ATTEMPT_STARTED':
      return {
        ...base,
        requestedAction: 'STARTING',
        codexRun: 'STARTING',
        osProcess: 'SPAWNING',
        summary:
          getString(event.payload, 'mode') === 'IMPLEMENTATION'
            ? 'Starting implementation Codex run in the task worktree.'
            : 'Starting read-only Codex run.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_STARTED':
      return {
        ...base,
        requestedAction: 'RUNNING',
        codexRun: 'RUNNING',
        osProcess: 'RUNNING',
        health: 'INFO',
        summary: 'Codex run is active.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'GIT_SNAPSHOT_CAPTURED':
      return {
        ...base,
        git: getGitStatus(event.payload) ?? base.git,
        health:
          getGitStatus(event.payload) === 'CONFLICTED' || getGitStatus(event.payload) === 'UNAVAILABLE'
            ? 'ERROR'
            : base.health,
        summary: `Git snapshot captured: ${getGitStatus(event.payload) ?? 'UNKNOWN'}.`,
        findings,
        updatedAt: event.receivedAt
      };
    case 'DELIVERY_COMMIT_CREATED':
      return {
        ...base,
        git: 'COMMITTED_UNPUSHED',
        tests: 'STALE',
        health: maxHealth(base.health, 'WARNING'),
        summary: 'Delivery commit created. Re-run tests before publishing.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TEST_RUN_STARTED':
      return {
        ...base,
        tests: 'QUEUED',
        summary: 'Local test command queued.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TEST_PROCESS_STARTED':
      return {
        ...base,
        tests: 'RUNNING',
        summary: 'Local test command is running.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TEST_RUN_COMPLETED': {
      const exitCode = getNullableNumber(event.payload, 'exitCode');
      const signal = getString(event.payload, 'signal');
      const error = getString(event.payload, 'error');
      const tests = error ? 'ERROR' : signal ? 'CANCELED' : exitCode === 0 ? 'PASSED' : 'FAILED';
      return {
        ...base,
        tests,
        health: tests === 'PASSED' ? base.health : tests === 'FAILED' || tests === 'ERROR' ? 'ERROR' : 'WARNING',
        summary:
          tests === 'PASSED'
            ? 'Local tests passed for the current Git generation.'
            : `Local tests ended with ${tests}.`,
        findings,
        updatedAt: event.receivedAt
      };
    }
    case 'TEST_RESULT_STALE':
      return {
        ...base,
        tests: 'STALE',
        health: maxHealth(base.health, 'WARNING'),
        summary: 'Local test result is stale because the Git generation changed.',
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
      return {
        ...base,
        merge,
        health:
          merge === 'MERGED'
            ? 'HEALTHY'
            : merge === 'CLOSED_UNMERGED' || merge === 'BLOCKED'
              ? 'ERROR'
              : base.health,
        summary:
          merge === 'MERGED'
            ? 'GitHub reports the pull request merged. Completion policy is satisfied.'
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
    case 'CODEX_EVENT_PARSED':
      return {
        ...base,
        codexRun: run?.status ?? base.codexRun,
        summary: `Latest Codex event: ${getString(event.payload, 'eventType') ?? 'unknown'}.`,
        findings,
        updatedAt: event.receivedAt
      };
    case 'CODEX_STDERR_CHUNK':
      return {
        ...base,
        health: maxHealth(base.health, 'WARNING'),
        summary: 'Codex wrote diagnostic output to stderr.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'CANCEL_REQUESTED':
      return {
        ...base,
        requestedAction: 'CANCEL_REQUESTED',
        osProcess: 'CANCELING',
        health: 'WARNING',
        summary: 'Cancellation requested; waiting for process termination.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'CODEX_RUN_COMPLETED':
      return {
        ...base,
        requestedAction: 'SUCCEEDED',
        codexRun: 'COMPLETED',
        artifact: 'FINAL_MESSAGE_PRESENT',
        health: findings.some((finding) => finding.severity === 'WARNING') ? 'WARNING' : 'HEALTHY',
        summary: 'Codex run completed. Review the final artifact and Git evidence.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'CODEX_RUN_FAILED':
      return {
        ...base,
        requestedAction: 'FAILED',
        codexRun: 'FAILED',
        health: 'ERROR',
        summary: 'Codex run failed. Review logs for details.',
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
        codexRun: base.codexRun === 'COMPLETED' ? base.codexRun : 'CANCELED',
        health: 'WARNING',
        summary: 'Run ended after a cancellation signal.',
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

function findingsForEvent(event: DomainEvent, run?: RunRecord): Finding[] {
  if (event.type === 'CODEX_STDERR_CHUNK') {
    return [
      {
        id: `${event.id}:stderr`,
        code: 'CODEX_STDERR_OUTPUT',
        severity: 'WARNING',
        message: 'Codex produced stderr output; inspect diagnostics.',
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

  if (event.type === 'PROCESS_EXITED' && run?.status === 'UNKNOWN') {
    return [
      {
        id: `${event.id}:unknown-codex-terminal`,
        code: 'PROCESS_EXITED_WITHOUT_CODEX_TERMINAL_EVENT',
        severity: 'WARNING',
        message: 'Process exited before a terminal Codex event was observed.',
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

  if (event.type === 'TEST_RUN_COMPLETED' && getNullableNumber(event.payload, 'exitCode') !== 0) {
    return [
      {
        id: `${event.id}:test-failed`,
        code: 'LOCAL_TESTS_NOT_PASSING',
        severity: 'ERROR',
        message: `Local tests exited with code ${getNullableNumber(event.payload, 'exitCode') ?? 'unknown'}.`,
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
