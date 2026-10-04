import type { RunRecord } from '../../shared/contracts';
import { isImplementationRunMode } from '../../shared/contracts';

export function canStopTaskRun(run: RunRecord | undefined): boolean {
  if (!run) return false;
  if (run.status === 'QUEUED') return true;
  return (
    Boolean(run.providerTurnId) &&
    ['RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(run.status)
  );
}

export function selectProgressRun(
  preferredRun: RunRecord | undefined,
  runs: RunRecord[]
): RunRecord | undefined {
  if (preferredRun && (isImplementationRunMode(preferredRun.mode) || preferredRun.mode === 'ANALYSIS')) {
    return preferredRun;
  }
  return [...runs]
    .filter((run) => (isImplementationRunMode(run.mode) || run.mode === 'ANALYSIS'))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
