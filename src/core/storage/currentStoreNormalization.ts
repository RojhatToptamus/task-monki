import type {
  AgentReviewGateStatus,
  AgentSessionRecord,
  RunRecord,
  StatusProjection,
  Task
} from '../../shared/contracts';
import {
  TASK_STORE_SCHEMA_VERSION,
  getImplementationRetryReason,
  isImplementationRunMode
} from '../../shared/contracts';
import type { StoreState } from '../projection/reducer';
import {
  agentReviewStatusFromResult,
  parseAgentReviewResult
} from '../review/AgentReviewContract';

type UnvalidatedCurrentStore = {
  schemaVersion?: unknown;
  reviewRollups?: unknown;
};

/**
 * Repairs narrowly identified writer defects before current-schema validation.
 * Unknown shapes and all other malformed records remain fail-closed.
 */
export function normalizePersistedStateBeforeValidation<
  T extends UnvalidatedCurrentStore
>(state: T): { state: T; changed: boolean } {
  if (
    state.schemaVersion !== TASK_STORE_SCHEMA_VERSION ||
    !Array.isArray(state.reviewRollups)
  ) {
    return { state, changed: false };
  }

  let changed = false;
  const reviewRollups = state.reviewRollups.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).reviewDecision !== ''
    ) {
      return value;
    }
    changed = true;
    const { reviewDecision: _blankDecision, ...record } = value as Record<
      string,
      unknown
    >;
    return record;
  });

  return changed
    ? {
        state: { ...state, reviewRollups } as T,
        changed: true
      }
    : { state, changed: false };
}

/** Applies explicit, idempotent repairs to a validated current-schema state. */
export function normalizeLoadedState(
  state: StoreState
): { state: StoreState; changed: boolean } {
  let changed = false;
  const previewResources = state.previewResources.filter(
    (resource) =>
      (resource as { adapterKind: string }).adapterKind === 'NATIVE_PROCESS'
  );
  if (previewResources.length !== state.previewResources.length) {
    changed = true;
  }
  const activeRunStatuses: RunRecord['status'][] = [
    'QUEUED',
    'STARTING',
    'RUNNING',
    'AWAITING_APPROVAL',
    'AWAITING_USER_INPUT',
    'INTERRUPTING'
  ];
  const runs = state.runs.map((run) => {
    if (isStaleIdleReviewRun(run, state.agentSessions)) {
      changed = true;
      return {
        ...run,
        status: 'RECOVERY_REQUIRED' as const,
        recoveryState: 'REQUIRES_USER_ACTION' as const,
        terminalReason:
          run.terminalReason ??
          'Agent review stopped sending updates before Task Monki received a terminal event.'
      };
    }
    if (!isStaleInterruptingReviewRun(run, state.agentSessions)) {
      return run;
    }
    changed = true;
    return {
      ...run,
      status: 'INTERRUPTED' as const,
      recoveryState: 'NONE' as const,
      endedAt: run.endedAt ?? run.lastEventAt ?? run.startedAt,
      terminalReason:
        run.terminalReason ??
        'Agent review stop was reconciled after the provider reported no active turn.'
    };
  });
  const tasks = state.tasks.map((task) => {
    const taskCurrentRun = task.currentRunId
      ? runs.find((run) => run.id === task.currentRunId)
      : undefined;
    const shouldRepairImplementationPhase = Boolean(
      taskCurrentRun &&
        isImplementationRunMode(taskCurrentRun.mode) &&
        ['FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
          taskCurrentRun.status
        ) &&
        task.workflowPhase === 'REVIEW'
    );
    const normalizedTask = shouldRepairImplementationPhase
      ? { ...task, workflowPhase: 'IN_PROGRESS' as const }
      : task;
    if (shouldRepairImplementationPhase) changed = true;

    const currentRun = findReviewRunForRepair(normalizedTask, runs);
    if (!currentRun) return normalizedTask;

    const hasActiveNonReviewRun =
      taskCurrentRun !== undefined &&
      taskCurrentRun.mode !== 'REVIEW' &&
      activeRunStatuses.includes(taskCurrentRun.status);
    const hasNewerNonReviewWorkThatIsNotReviewReady = Boolean(
      taskCurrentRun &&
        taskCurrentRun.mode !== 'REVIEW' &&
        !(
          isImplementationRunMode(taskCurrentRun.mode) &&
          taskCurrentRun.status === 'COMPLETED'
        )
    );
    const shouldRepairPhase =
      !shouldRepairImplementationPhase &&
      !getImplementationRetryReason(normalizedTask) &&
      !hasActiveNonReviewRun &&
      !hasNewerNonReviewWorkThatIsNotReviewReady &&
      !['REVIEW', 'IN_REVIEW', 'DONE', 'CANCELED', 'ARCHIVED'].includes(
        normalizedTask.workflowPhase
      );
    const currentReview = normalizedTask.projection.agentReview;
    const sameProjectedReview = currentReview?.runId === currentRun.id;
    const reviewResult =
      parseAgentReviewResult(currentRun.finalMessage) ??
      (sameProjectedReview ? currentReview?.result : undefined);
    const projectedReviewStatus =
      sameProjectedReview && currentReview?.status !== 'RUNNING'
        ? currentReview?.status
        : undefined;
    const reviewStatus: AgentReviewGateStatus =
      (sameProjectedReview && currentReview?.status === 'STALE'
        ? 'STALE'
        : agentReviewStatusFromResult(reviewResult)) ??
      projectedReviewStatus ??
      (currentRun.status === 'COMPLETED'
        ? 'INCONCLUSIVE'
        : currentRun.status === 'INTERRUPTED'
          ? 'CANCELED'
          : ['FAILED', 'RECOVERY_REQUIRED', 'LOST'].includes(currentRun.status)
            ? 'FAILED'
            : 'RUNNING');
    const repairedSourceRun =
      taskCurrentRun?.mode === 'REVIEW'
        ? findSourceRunForReviewRepair(currentRun, runs)
        : undefined;
    const shouldRepairCurrentRun = Boolean(repairedSourceRun);
    const shouldRepairReview =
      !currentReview ||
      currentReview.runId !== currentRun.id ||
      currentReview.status !== reviewStatus ||
      (!currentReview.result && Boolean(reviewResult));

    if (!shouldRepairPhase && !shouldRepairReview && !shouldRepairCurrentRun) {
      return normalizedTask;
    }

    changed = true;
    const reviewedSnapshot = currentRun.beforeGitSnapshotId
      ? state.gitSnapshots.find(
          (snapshot) => snapshot.id === currentRun.beforeGitSnapshotId
        )
      : undefined;
    const repairedAgentRun = repairedSourceRun?.status as
      | StatusProjection['agentRun']
      | undefined;
    return {
      ...normalizedTask,
      workflowPhase: shouldRepairPhase ? 'REVIEW' : normalizedTask.workflowPhase,
      currentRunId: repairedSourceRun?.id ?? normalizedTask.currentRunId,
      currentAgentSessionId:
        repairedSourceRun?.sessionId ?? normalizedTask.currentAgentSessionId,
      currentIterationId:
        repairedSourceRun?.iterationId ?? normalizedTask.currentIterationId,
      currentWorktreeId:
        repairedSourceRun?.worktreeId ?? normalizedTask.currentWorktreeId,
      projection: {
        ...normalizedTask.projection,
        agentRun: repairedAgentRun ?? normalizedTask.projection.agentRun,
        agentReview: {
          ...currentReview,
          status: reviewStatus,
          runId: currentRun.id,
          sourceRunId:
            currentRun.continuedFromRunId ?? currentReview?.sourceRunId,
          reviewedGitSnapshotId:
            currentRun.beforeGitSnapshotId ??
            currentReview?.reviewedGitSnapshotId,
          reviewedHeadSha:
            reviewedSnapshot?.headSha ?? currentReview?.reviewedHeadSha,
          reviewedDirtyFingerprint:
            reviewedSnapshot?.dirtyFingerprint ??
            currentReview?.reviewedDirtyFingerprint,
          finalArtifactId:
            currentRun.finalArtifactId ?? currentReview?.finalArtifactId,
          result: reviewResult ?? currentReview?.result,
          summary:
            reviewStatus === 'STALE'
              ? currentReview?.summary
              : (reviewResult?.summary ??
                (reviewStatus === 'RUNNING'
                  ? 'An agent is reviewing the current diff.'
                  : reviewStatus === 'CANCELED'
                    ? 'Agent review was stopped before completion.'
                    : reviewStatus === 'FAILED'
                      ? (currentRun.terminalReason ??
                        'Agent review needs attention before it can be accepted.')
                      : currentReview?.summary)),
          updatedAt:
            currentRun.lastEventAt ??
            currentRun.startedAt ??
            currentReview?.updatedAt
        }
      },
      updatedAt:
        currentRun.lastEventAt ?? currentRun.startedAt ?? normalizedTask.updatedAt
    };
  });

  return changed
    ? { state: { ...state, runs, tasks, previewResources }, changed }
    : { state, changed };
}

function isStaleIdleReviewRun(
  run: RunRecord,
  sessions: AgentSessionRecord[]
): boolean {
  if (run.mode !== 'REVIEW' || !['STARTING', 'RUNNING'].includes(run.status)) {
    return false;
  }
  const session = sessions.find((candidate) => candidate.id === run.sessionId);
  return (
    session?.role === 'REVIEW' &&
    ['IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED'].includes(
      session.status
    )
  );
}

function isStaleInterruptingReviewRun(
  run: RunRecord,
  sessions: AgentSessionRecord[]
): boolean {
  if (run.mode !== 'REVIEW' || run.status !== 'INTERRUPTING') return false;
  const session = sessions.find((candidate) => candidate.id === run.sessionId);
  return (
    session?.role === 'REVIEW' &&
    ['IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED'].includes(
      session.status
    )
  );
}

function findReviewRunForRepair(
  task: Task,
  runs: RunRecord[]
): RunRecord | undefined {
  const projectedRunId = task.projection.agentReview?.runId;
  if (projectedRunId) {
    const projectedRun = runs.find(
      (run) =>
        run.id === projectedRunId &&
        run.taskId === task.id &&
        run.mode === 'REVIEW' &&
        (!task.currentIterationId || run.iterationId === task.currentIterationId)
    );
    if (projectedRun) return projectedRun;
  }
  if (task.currentRunId) {
    const currentRun = runs.find(
      (run) =>
        run.id === task.currentRunId &&
        run.taskId === task.id &&
        run.mode === 'REVIEW' &&
        (!task.currentIterationId || run.iterationId === task.currentIterationId)
    );
    if (currentRun) return currentRun;
  }
  return runs
    .filter(
      (run) =>
        run.taskId === task.id &&
        run.mode === 'REVIEW' &&
        (!task.currentIterationId || run.iterationId === task.currentIterationId)
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function findSourceRunForReviewRepair(
  reviewRun: RunRecord,
  runs: RunRecord[]
): RunRecord | undefined {
  if (reviewRun.continuedFromRunId) {
    const sourceRun = runs.find(
      (run) =>
        run.id === reviewRun.continuedFromRunId &&
        run.taskId === reviewRun.taskId &&
        isImplementationRunMode(run.mode)
    );
    if (sourceRun) return sourceRun;
  }
  return runs
    .filter(
      (run) =>
        run.taskId === reviewRun.taskId &&
        run.iterationId === reviewRun.iterationId &&
        isImplementationRunMode(run.mode)
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
