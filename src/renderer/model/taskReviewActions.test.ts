import { describe, expect, it } from 'vitest';
import { makeRunRecord, makeTaskRecord } from '../../testSupport/rendererRecords';
import { shouldShowMoveToReviewHeaderAction } from './taskReviewActions';

describe('shouldShowMoveToReviewHeaderAction', () => {
  it.each([
    ['ANALYSIS', false],
    ['COMPACTION', false],
    ['IMPLEMENTATION', true]
  ] as const)('returns %s completion eligibility as %s', (mode, expected) => {
    const task = makeTaskRecord({
      currentRunId: 'current-run',
      workflowPhase: 'IN_PROGRESS'
    });
    const run = makeRunRecord({
      id: 'current-run',
      mode,
      status: 'COMPLETED'
    });

    expect(shouldShowMoveToReviewHeaderAction(task, run)).toBe(expected);
  });

  it('hides the action when local evidence requires another implementation pass', () => {
    const task = makeTaskRecord({
      currentRunId: 'current-run',
      workflowPhase: 'IN_PROGRESS',
      projection: {
        requestedAction: 'FAILED',
        agentRun: 'COMPLETED',
        implementationRetry: {
          runId: 'current-run',
          reason: 'Retry before review.'
        }
      }
    });
    const run = makeRunRecord({ id: 'current-run', status: 'COMPLETED' });

    expect(shouldShowMoveToReviewHeaderAction(task, run)).toBe(false);
  });
});
