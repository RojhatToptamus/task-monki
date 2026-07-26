import type {
  DomainEvent,
  GitSnapshotRecord,
  GitHubRepositoryRecord,
  BranchPublicationRecord,
  PullRequestSnapshotRecord,
  CiRollupRecord,
  ReviewRollupRecord,
  MergeSnapshotRecord,
  RunRecord,
  Task,
  TaskSnapshot,
  WorktreeRecord
} from '../../shared/contracts';
import { getImplementationRetryReason } from '../../shared/contracts';

export function selectTaskRuns(snapshot: Pick<TaskSnapshot, 'runs'>, taskId: string): RunRecord[] {
  return snapshot.runs
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function selectTaskEvents(snapshot: Pick<TaskSnapshot, 'events'>, taskId: string): DomainEvent[] {
  return snapshot.events
    .filter((event) => event.taskId === taskId)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

export function selectActiveRun(task: Task, runs: RunRecord[]): RunRecord | undefined {
  return runs.find((run) => run.id === task.currentRunId) ?? runs[0];
}

export function selectCurrentWorktree(
  snapshot: Pick<TaskSnapshot, 'worktrees'>,
  task: Task
): WorktreeRecord | undefined {
  return snapshot.worktrees.find((worktree) => worktree.id === task.currentWorktreeId);
}

export function selectLatestGitSnapshot(
  snapshot: Pick<TaskSnapshot, 'gitSnapshots'>,
  task: Task
): GitSnapshotRecord | undefined {
  return snapshot.gitSnapshots
    .filter((gitSnapshot) => gitSnapshot.taskId === task.id && gitSnapshot.iterationId === task.currentIterationId)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
}

export function selectLatestGitHubRepository(
  snapshot: Pick<TaskSnapshot, 'githubRepositories'>,
  task: Task
): GitHubRepositoryRecord | undefined {
  return snapshot.githubRepositories
    .filter((record) => record.taskId === task.id && record.iterationId === task.currentIterationId)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
}

export function selectLatestBranchPublication(
  snapshot: Pick<TaskSnapshot, 'branchPublications'>,
  task: Task
): BranchPublicationRecord | undefined {
  return snapshot.branchPublications
    .filter((record) => record.taskId === task.id && record.iterationId === task.currentIterationId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function selectLatestPullRequest(
  snapshot: Pick<TaskSnapshot, 'pullRequests'>,
  task: Task
): PullRequestSnapshotRecord | undefined {
  return snapshot.pullRequests
    .filter((record) => record.taskId === task.id && record.iterationId === task.currentIterationId)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

export function selectLatestCiRollup(
  snapshot: Pick<TaskSnapshot, 'ciRollups'>,
  task: Task
): CiRollupRecord | undefined {
  return snapshot.ciRollups
    .filter((record) => record.taskId === task.id && record.iterationId === task.currentIterationId)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

export function selectLatestReviewRollup(
  snapshot: Pick<TaskSnapshot, 'reviewRollups'>,
  task: Task
): ReviewRollupRecord | undefined {
  return snapshot.reviewRollups
    .filter((record) => record.taskId === task.id && record.iterationId === task.currentIterationId)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

export function selectLatestMergeSnapshot(
  snapshot: Pick<TaskSnapshot, 'mergeSnapshots'>,
  task: Task
): MergeSnapshotRecord | undefined {
  return snapshot.mergeSnapshots
    .filter((record) => record.taskId === task.id && record.iterationId === task.currentIterationId)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

export function canStartRun(task: Task): boolean {
  if (task.currentRunId) {
    return false;
  }
  return ![
    'RUNNING',
    'STARTING',
    'QUEUED',
    'AWAITING_APPROVAL',
    'AWAITING_USER_INPUT',
    'INTERRUPTING'
  ].includes(task.projection.agentRun);
}

export function canPrepareWorktree(task: Task): boolean {
  return !['CREATING', 'PRESENT'].includes(task.projection.worktree);
}

export function canCreateDeliveryCommit(task: Task): boolean {
  return (
    task.projection.worktree === 'PRESENT' &&
    task.projection.git === 'DIRTY' &&
    !getImplementationRetryReason(task)
  );
}

export function canCancelRun(run: RunRecord | undefined): boolean {
  return Boolean(
    run &&
      ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(
        run.status
      )
  );
}

export function formatShortId(id: string): string {
  return id.slice(0, 8);
}
