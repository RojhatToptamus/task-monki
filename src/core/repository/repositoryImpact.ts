import type { RepositoryImpact, TaskSnapshot } from '../../shared/contracts';

const ACTIVE_RUN_STATUSES = new Set([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
]);

export function selectRepositoryImpact(
  snapshot: TaskSnapshot,
  repositoryId: string
): RepositoryImpact {
  const taskIds = new Set(
    snapshot.tasks
      .filter((task) => task.repositoryId === repositoryId)
      .map((task) => task.id)
  );
  const activeRunCount = snapshot.runs.filter(
    (run) => taskIds.has(run.taskId) && ACTIVE_RUN_STATUSES.has(run.status)
  ).length;
  const latestPullRequests = new Map<string, (typeof snapshot.pullRequests)[number]>();
  for (const pullRequest of snapshot.pullRequests) {
    if (!taskIds.has(pullRequest.taskId)) continue;
    const current = latestPullRequests.get(pullRequest.taskId);
    if (!current || current.observedAt < pullRequest.observedAt) {
      latestPullRequests.set(pullRequest.taskId, pullRequest);
    }
  }
  return {
    repositoryId,
    taskCount: taskIds.size,
    activeRunCount,
    worktreeCount: snapshot.worktrees.filter(
      (worktree) =>
        worktree.repositoryId === repositoryId && worktree.status !== 'REMOVED'
    ).length,
    openPullRequestCount: [...latestPullRequests.values()].filter((pullRequest) =>
      pullRequest.status === 'OPEN_DRAFT' || pullRequest.status === 'OPEN_READY'
    ).length,
    blockingReason:
      activeRunCount > 0
        ? 'Stop or finish active repository runs before disconnecting it.'
        : undefined
  };
}
