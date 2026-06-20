import type { DomainEvent, RunRecord, Task, TaskSnapshot } from '../../shared/contracts';

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

export function canStartRun(task: Task): boolean {
  return !['RUNNING', 'STARTING', 'QUEUED'].includes(task.projection.codexRun);
}

export function canCancelRun(run: RunRecord | undefined): boolean {
  return run?.processStatus === 'RUNNING';
}

export function formatShortId(id: string): string {
  return id.slice(0, 8);
}
