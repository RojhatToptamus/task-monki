import { isDetachedRunMode } from './agent';
import type { RunRecord, TaskInstruction } from './contracts';

/** Untracked files larger than this are left out of a side question's worktree snapshot. */
export const SIDE_QUESTION_SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Untracked files beyond this total are left out of a side question's worktree snapshot. */
export const SIDE_QUESTION_SNAPSHOT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** The SIDE question that a SIDE_QUESTION run answers. */
export function sideQuestionForRun(
  instructions: readonly TaskInstruction[],
  runId: string
): TaskInstruction | undefined {
  return instructions.find((item) => item.role === 'SIDE' && item.runId === runId);
}

/**
 * Whether a run can change the task's live worktree. A side question asked while one is
 * active reads a read-only snapshot instead of the live checkout.
 */
export function runMayWriteTaskWorktree(run: Pick<RunRecord, 'mode'>): boolean {
  return !isDetachedRunMode(run.mode);
}

/**
 * Whether an active run holds the task's live worktree, so other agent work and Git
 * actions wait for it. Every run does except a side question that reads a snapshot: the
 * implementation agent and Git actions continue beside it.
 */
export function runHoldsTaskWorktree(
  run: Pick<RunRecord, 'id' | 'mode'>,
  instructions: readonly TaskInstruction[]
): boolean {
  return run.mode !== 'SIDE_QUESTION' || !sideQuestionForRun(instructions, run.id)?.snapshotTakenAt;
}
