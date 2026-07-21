import type {
  GitSnapshotRecord,
  RunRecord,
  Task,
  TaskSnapshot
} from '../../shared/contracts';
import {
  completionPolicyRequiresMerge,
  completionPolicyRequiresPassingChecks,
  getImplementationRetryReason,
  isImplementationRunMode,
  verifiedChecksMatchMergeHead
} from '../../shared/contracts';

export const ACTIVE_AGENT_RUN_STATUSES: ReadonlySet<RunRecord['status']> = new Set([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
]);

export interface TaskTransitionEvidence {
  hasWorktree: boolean;
  currentRun?: Pick<RunRecord, 'id' | 'mode' | 'status'>;
  hasGitSnapshot?: boolean;
  gitStatus?: Task['projection']['git'];
  gitHeadSha?: string;
  gitDirtyFingerprint?: string;
  pullRequestStatus?: Task['projection']['githubPullRequest'];
  pullRequestHeadSha?: string;
  ciStatus?: Task['projection']['ciChecks'];
  ciHeadSha?: string;
  ciPullRequestNumber?: number;
  mergeStatus?: Task['projection']['merge'];
  mergeHeadSha?: string;
  mergePullRequestNumber?: number;
}

export function taskDeletionBlocker(
  task: Task,
  snapshot: TaskSnapshot
): string | undefined {
  const activeRun = snapshot.runs.find(
    (run) => run.taskId === task.id && ACTIVE_AGENT_RUN_STATUSES.has(run.status)
  );
  if (activeRun) {
    return 'Stop or let the active agent run finish before deleting this task.';
  }

  const activeInteraction = snapshot.interactionRequests.find(
    (request) =>
      request.taskId === task.id &&
      ['PENDING', 'RESPONDING'].includes(request.status)
  );
  if (activeInteraction) {
    return 'Resolve the pending provider request before deleting this task.';
  }

  return undefined;
}

export function transitionBlocker(
  task: Task,
  toPhase: Task['workflowPhase'],
  evidence: TaskTransitionEvidence
): string | undefined {
  if (toPhase === 'IN_PROGRESS') {
    return evidence.hasWorktree
      ? undefined
      : 'A task worktree is required before implementation starts.';
  }
  if (toPhase === 'REVIEW') {
    if (!evidence.hasWorktree) {
      return 'A task worktree is required before review.';
    }
    if (
      !evidence.currentRun ||
      evidence.currentRun.id !== task.currentRunId ||
      evidence.currentRun.status !== 'COMPLETED' ||
      !isImplementationRunMode(evidence.currentRun.mode)
    ) {
      return 'The current implementation run must complete successfully before moving to review.';
    }
    return getImplementationRetryReason(task);
  }
  if (toPhase === 'IN_REVIEW') {
    const retryReason = getImplementationRetryReason(task);
    if (retryReason) return retryReason;
    if (
      evidence.pullRequestStatus !== 'OPEN_DRAFT' &&
      evidence.pullRequestStatus !== 'OPEN_READY'
    ) {
      return 'A matching open GitHub pull request is required before IN_REVIEW.';
    }
    if (
      evidence.gitHeadSha &&
      evidence.pullRequestHeadSha &&
      evidence.gitHeadSha !== evidence.pullRequestHeadSha
    ) {
      return 'GitHub pull request head SHA does not match the current task branch HEAD.';
    }
    return undefined;
  }
  if (toPhase === 'DONE') {
    const retryReason = getImplementationRetryReason(task);
    if (retryReason) return retryReason;
    if (
      completionPolicyRequiresMerge(task.completionPolicy) &&
      evidence.mergeStatus !== 'MERGED'
    ) {
      return 'GitHub must report the pull request merged before DONE.';
    }
    if (
      completionPolicyRequiresPassingChecks(task.completionPolicy) &&
      !verifiedChecksMatchMergeHead({
        ciStatus: evidence.ciStatus,
        ciHeadSha: evidence.ciHeadSha,
        ciPullRequestNumber: evidence.ciPullRequestNumber,
        mergeHeadSha: evidence.mergeHeadSha,
        mergePullRequestNumber: evidence.mergePullRequestNumber
      })
    ) {
      return 'GitHub checks must pass for the merged PR head before DONE.';
    }
    return undefined;
  }
  if (toPhase === 'ARCHIVED') {
    return activeTaskOperationBlocker(task);
  }
  return undefined;
}

export function assertPublishReady(
  latestGit: GitSnapshotRecord | undefined
): asserts latestGit is GitSnapshotRecord {
  if (!latestGit) {
    throw new Error('Refresh Git evidence before opening a draft PR.');
  }
  if (latestGit.status === 'DIRTY') {
    throw new Error(
      'Create a delivery commit before opening a draft PR. Dirty worktree changes cannot be pushed.'
    );
  }
  if (latestGit.status === 'CONFLICTED' || latestGit.status === 'UNAVAILABLE') {
    throw new Error(`Git status ${latestGit.status} blocks draft PR creation.`);
  }
  if (latestGit.status === 'DIVERGED') {
    throw new Error('Sync the branch before opening a draft PR.');
  }
  if (latestGit.status === 'UNKNOWN') {
    throw new Error('Git status must be available before opening a draft PR.');
  }
  if (latestGit.commitsAheadOfBase <= 0 || latestGit.committedDiffFileCount <= 0) {
    throw new Error(
      'The task branch has no committed changes to open a draft PR for.'
    );
  }
}

function activeTaskOperationBlocker(task: Task): string | undefined {
  if (
    ACTIVE_AGENT_RUN_STATUSES.has(
      task.projection.agentRun as RunRecord['status']
    )
  ) {
    return 'Stop or let the active agent run finish before changing this task.';
  }
  if (
    ['REQUESTED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED'].includes(
      task.projection.requestedAction
    )
  ) {
    return 'Resolve the pending provider request before changing this task.';
  }
  return undefined;
}
