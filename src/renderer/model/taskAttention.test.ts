import { describe, expect, it } from 'vitest';
import { makeTaskRecord } from '../../testSupport/rendererRecords';
import { describeTaskAttention } from './taskAttention';

describe('describeTaskAttention', () => {
  it.each([
    {
      name: 'approval',
      task: makeTaskRecord({ projection: { agentRun: 'AWAITING_APPROVAL' } }),
      expected: { label: 'Needs approval', tone: 'warning' }
    },
    {
      name: 'user input',
      task: makeTaskRecord({ projection: { agentRun: 'AWAITING_USER_INPUT' } }),
      expected: { label: 'Needs input', tone: 'warning' }
    },
    {
      name: 'ambiguous recovery',
      task: makeTaskRecord({ projection: { agentRun: 'RECOVERY_REQUIRED' } }),
      expected: { label: 'Recovery required', tone: 'error' }
    },
    {
      name: 'lost runtime',
      task: makeTaskRecord({ projection: { agentRun: 'LOST' } }),
      expected: { label: 'Runtime lost', tone: 'error' }
    },
    {
      name: 'failed implementation',
      task: makeTaskRecord({
        workflowPhase: 'IN_PROGRESS',
        projection: { agentRun: 'FAILED' }
      }),
      expected: { label: 'Run failed', tone: 'error' }
    },
    {
      name: 'blocked task',
      task: makeTaskRecord({
        workflowPhase: 'BLOCKED',
        projection: { summary: 'A repository decision is required.' }
      }),
      expected: { label: 'Blocked', tone: 'error' }
    },
    {
      name: 'closed pull request',
      task: makeTaskRecord({
        projection: { githubPullRequest: 'CLOSED_UNMERGED' }
      }),
      expected: { label: 'PR closed without merge', tone: 'error' }
    },
    {
      name: 'failing checks',
      task: makeTaskRecord({ projection: { ciChecks: 'FAILING' } }),
      expected: { label: 'Checks failed', tone: 'error' }
    },
    {
      name: 'GitHub changes requested',
      task: makeTaskRecord({ projection: { reviews: 'CHANGES_REQUESTED' } }),
      expected: { label: 'Changes requested', tone: 'warning' }
    },
    {
      name: 'blocked merge',
      task: makeTaskRecord({ projection: { merge: 'BLOCKED' } }),
      expected: { label: 'Merge blocked', tone: 'error' }
    },
    {
      name: 'manual completion after merge',
      task: makeTaskRecord({
        completionPolicy: 'MANUAL',
        workflowPhase: 'IN_REVIEW',
        projection: { githubPullRequest: 'MERGED', merge: 'MERGED' }
      }),
      expected: { label: 'Waiting for Mark done', tone: 'info' }
    },
    {
      name: 'generic delivery error',
      task: makeTaskRecord({
        projection: {
          githubPullRequest: 'OPEN_READY',
          merge: 'NOT_MERGED',
          health: 'ERROR',
          summary: 'GitHub merge state: NOT_MERGED.'
        }
      }),
      expected: { label: 'Delivery needs attention', tone: 'error' }
    }
  ])('selects the highest-priority $name state', ({ task, expected }) => {
    expect(describeTaskAttention(task)).toMatchObject(expected);
  });

  it('keeps a blocked completed implementation ahead of delivery and review state', () => {
    const attention = describeTaskAttention(
      makeTaskRecord({
        currentRunId: 'run-1',
        workflowPhase: 'IN_PROGRESS',
        projection: {
          requestedAction: 'FAILED',
          agentRun: 'COMPLETED',
          ciChecks: 'FAILING',
          implementationRetry: {
            runId: 'run-1',
            reason: 'The declined execution produced no Git change.'
          }
        }
      })
    );

    expect(attention).toEqual({
      label: 'Needs retry',
      detail: 'The declined execution produced no Git change.',
      tone: 'warning'
    });
  });

  it('sanitizes generic delivery attention and returns nothing for neutral state', () => {
    const delivery = describeTaskAttention(
      makeTaskRecord({
        projection: {
          githubPullRequest: 'OPEN_READY',
          merge: 'NOT_MERGED',
          health: 'ERROR',
          summary: 'GitHub merge state: NOT_MERGED.'
        }
      })
    );

    expect(delivery?.detail).toBe('Open the task to review the current GitHub evidence.');
    expect(JSON.stringify(delivery)).not.toContain('NOT_MERGED');
    expect(describeTaskAttention(makeTaskRecord())).toBeUndefined();
  });
});
