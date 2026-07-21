import { describe, expect, it } from 'vitest';
import { createInitialProjection, type RunRecord, type Task } from '../../shared/contracts';
import { shouldShowMoveToReviewHeaderAction } from '../model/taskReviewActions';

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

  it('hides the action when Task Monki blocked review after provider completion', () => {
    const task = taskFixture();
    task.projection.requestedAction = 'FAILED';
    task.projection.agentRun = 'COMPLETED';
    task.projection.implementationRetry = {
      runId: 'current-run',
      reason: 'Retry before review.'
    };
    const run = runFixture({ mode: 'IMPLEMENTATION' });

    expect(shouldShowMoveToReviewHeaderAction(task, run)).toBe(false);
  });
});

function taskFixture(): Pick<Task, 'currentRunId' | 'workflowPhase' | 'projection'> {
  return {
    currentRunId: 'current-run',
    workflowPhase: 'IN_PROGRESS',
    projection: createInitialProjection('2026-07-19T00:00:00.000Z')
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
