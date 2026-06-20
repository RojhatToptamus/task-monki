import type {
  DomainEvent,
  GitSnapshotRecord,
  RunRecord,
  Task,
  TaskSnapshot,
  TestRunRecord,
  WorktreeRecord
} from '../../shared/contracts';

export function selectTaskRuns(snapshot: TaskSnapshot, taskId: string): RunRecord[] {
  return snapshot.runs
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function selectTaskEvents(snapshot: TaskSnapshot, taskId: string): DomainEvent[] {
  return snapshot.events
    .filter((event) => event.taskId === taskId)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

export function selectActiveRun(task: Task, runs: RunRecord[]): RunRecord | undefined {
  return runs.find((run) => run.id === task.currentRunId) ?? runs[0];
}

export function selectCurrentWorktree(snapshot: TaskSnapshot, task: Task): WorktreeRecord | undefined {
  return snapshot.worktrees.find((worktree) => worktree.id === task.currentWorktreeId);
}

export function selectLatestGitSnapshot(
  snapshot: TaskSnapshot,
  task: Task
): GitSnapshotRecord | undefined {
  return snapshot.gitSnapshots
    .filter((gitSnapshot) => gitSnapshot.taskId === task.id && gitSnapshot.iterationId === task.currentIterationId)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
}

export function selectLatestTestRun(snapshot: TaskSnapshot, task: Task): TestRunRecord | undefined {
  return snapshot.testRuns
    .filter((testRun) => testRun.taskId === task.id && testRun.iterationId === task.currentIterationId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function canStartRun(task: Task): boolean {
  return !['RUNNING', 'STARTING', 'QUEUED'].includes(task.projection.codexRun);
}

export function canPrepareWorktree(task: Task): boolean {
  return !['CREATING', 'PRESENT'].includes(task.projection.worktree);
}

export function canRunTests(task: Task): boolean {
  return task.projection.worktree === 'PRESENT' && task.projection.tests !== 'RUNNING';
}

export function canCancelRun(run: RunRecord | undefined): boolean {
  return run?.processStatus === 'RUNNING';
}

export function formatShortId(id: string): string {
  return id.slice(0, 8);
}
