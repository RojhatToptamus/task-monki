import { describe, expect, it } from 'vitest';
import type { RunRecord, Task } from '../../shared/contracts';
import { shouldShowMoveToReviewHeaderAction } from './TaskDetail';

describe('TaskDetail Move to review header action', () => {
  it.each(['ANALYSIS', 'COMPACTION'] as const)(
    'does not expose the action after a completed %s run',
    (mode) => {
      const task = taskFixture();
      const run = runFixture({ mode });

      expect(shouldShowMoveToReviewHeaderAction(task, run)).toBe(false);
    }
  );

  it('exposes the action after the current implementation run completes', () => {
    const task = taskFixture();
    const run = runFixture({ mode: 'IMPLEMENTATION' });

    expect(shouldShowMoveToReviewHeaderAction(task, run)).toBe(true);
  });
});

function taskFixture(): Pick<Task, 'currentRunId' | 'workflowPhase'> {
  return {
    currentRunId: 'current-run',
    workflowPhase: 'IN_PROGRESS'
  };
}

function runFixture(
  overrides: Partial<Pick<RunRecord, 'id' | 'mode' | 'status'>> = {}
): Pick<RunRecord, 'id' | 'mode' | 'status'> {
  return {
    id: 'current-run',
    mode: 'IMPLEMENTATION',
    status: 'COMPLETED',
    ...overrides
  };
}
