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
      expected: { label: 'GitHub changes requested', tone: 'warning' }
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
      kind: 'retry',
      detail: 'The declined execution produced no Git change.',
      tone: 'warning'
    });
  });

  it('names local checkout failures by their owner instead of GitHub delivery', () => {
    // Every task starts with githubPullRequest UNLINKED; that must not read as delivery evidence.
    const unlinked = { githubPullRequest: 'UNLINKED' as const, health: 'ERROR' as const };
    expect(describeTaskAttention(makeTaskRecord({
      workflowPhase: 'READY',
      projection: { ...unlinked, worktree: 'ERROR', summary: 'Worktree creation or verification failed.' }
    }))).toMatchObject({ label: 'Worktree setup failed', kind: 'checkout', tone: 'error' });
    expect(describeTaskAttention(makeTaskRecord({
      workflowPhase: 'READY',
      projection: { ...unlinked, worktree: 'MISSING', summary: 'Worktree verification completed.' }
    }))).toMatchObject({ label: 'Checkout missing' });
    expect(describeTaskAttention(makeTaskRecord({
      workflowPhase: 'READY',
      projection: { ...unlinked, worktree: 'PRESENT', git: 'CONFLICTED' }
    }))).toMatchObject({ label: 'Git conflicts', kind: 'git' });
    // A broken checkout is the actionable fact even when delivery evidence is also bad.
    expect(describeTaskAttention(makeTaskRecord({
      workflowPhase: 'REVIEW',
      projection: { githubPullRequest: 'OPEN_READY', ciChecks: 'FAILING', health: 'ERROR', worktree: 'MISSING' }
    }))).toMatchObject({ label: 'Checkout missing' });
    expect(describeTaskAttention(makeTaskRecord({
      workflowPhase: 'READY',
      projection: { ...unlinked, worktree: 'PRESENT', summary: 'Branch publication failed; reconcile remote state before retry.' }
    }))).toEqual({
      label: 'Needs attention',
      kind: 'failure',
      detail: 'Branch publication failed; reconcile remote state before retry.',
      tone: 'error'
    });
  });

  it('never asks for attention on finished tasks', () => {
    for (const workflowPhase of ['DONE', 'CANCELED', 'ARCHIVED'] as const) {
      expect(describeTaskAttention(makeTaskRecord({
        workflowPhase,
        projection: { githubPullRequest: 'MERGED', merge: 'MERGED', health: 'ERROR', worktree: 'MISSING' }
      }))).toBeUndefined();
    }
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

    expect(delivery).toEqual({ label: 'Delivery needs attention', kind: 'delivery', tone: 'error' });
    expect(JSON.stringify(delivery)).not.toContain('NOT_MERGED');
    expect(describeTaskAttention(makeTaskRecord())).toBeUndefined();
  });
});
