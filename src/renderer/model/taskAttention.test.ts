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
      name: 'Changes requested',
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
      expected: { label: 'Ready to mark done', tone: 'info' }
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

  it('asks for the person on a finished review: a question, a failure, fixes to review again, or findings to decide', () => {
    const reviewed = (agentReview: object, agentRun: 'COMPLETED' | 'RUNNING' = 'COMPLETED') => makeTaskRecord({
      workflowPhase: 'REVIEW',
      projection: { agentRun, agentReview: { runId: 'review-1', ...agentReview } as never }
    });
    const blocking = { schemaVersion: 'agent-review/v1', verdict: 'NEEDS_CHANGES', summary: 'One leak.',
      findings: [{ id: 'leak', severity: 'MAJOR', title: 'Listener leaks', explanation: 'Never removed.' }] };

    expect(describeTaskAttention(reviewed({ status: 'STALE', requestAnswer: { awaitingDecision: true } })))
      .toEqual({ label: 'Agent asked a question', kind: 'question', tone: 'warning' });
    expect(describeTaskAttention(reviewed({ status: 'FAILED' }))).toEqual({ label: 'Review failed', kind: 'failure', tone: 'error' });
    expect(describeTaskAttention(reviewed({ status: 'STALE', requestAnswer: { awaitingDecision: false } })))
      .toEqual({ label: 'Fixes ready for review', kind: 'review', tone: 'info' });
    expect(describeTaskAttention(reviewed({ status: 'NEEDS_CHANGES', result: blocking })))
      .toEqual({ label: 'Needs changes', kind: 'review', tone: 'warning' });
    // A board summary carries the same facts without the review result.
    expect(describeTaskAttention({ ...makeTaskRecord({ workflowPhase: 'REVIEW' }), projection: {
      ...makeTaskRecord().projection, agentRun: 'COMPLETED',
      agentReview: { status: 'STALE', hasResult: true, findingCounts: {}, requestAnswered: { awaitingDecision: true } }
    } } as never)).toMatchObject({ label: 'Agent asked a question' });
    // Work in flight, a passed review and a stale one nobody answered wait on nobody.
    expect(describeTaskAttention(reviewed({ status: 'NEEDS_CHANGES', result: blocking }, 'RUNNING'))).toBeUndefined();
    expect(describeTaskAttention(reviewed({ status: 'PASSED' }))).toBeUndefined();
    expect(describeTaskAttention(reviewed({ status: 'STALE' }))).toBeUndefined();
  });

  it('never asks for attention on finished tasks', () => {
    for (const workflowPhase of ['DONE', 'CANCELED', 'ARCHIVED'] as const) {
      expect(describeTaskAttention(makeTaskRecord({
        workflowPhase,
        projection: { githubPullRequest: 'MERGED', merge: 'MERGED', health: 'ERROR', worktree: 'MISSING' }
      }))).toBeUndefined();
    }
  });

  it('asks nothing of a merged pull request, whatever its last review decision or checks said', () => {
    const merged = makeTaskRecord({ workflowPhase: 'IN_PROGRESS', projection: {
      githubPullRequest: 'MERGED', merge: 'MERGED', reviews: 'CHANGES_REQUESTED', ciChecks: 'FAILING'
    } });
    expect(describeTaskAttention(merged)).toBeUndefined();
    // Finishing it by hand is still the person's step.
    expect(describeTaskAttention({ ...merged, completionPolicy: 'MANUAL' })).toMatchObject({ label: 'Ready to mark done' });
  });

  it('says what a delivery waits on beneath its word, from the facts a board summary carries', () => {
    const open = { githubPullRequest: 'OPEN_READY' as const, githubPullRequestNumber: 9 };
    const withFacts = (projection: NonNullable<NonNullable<Parameters<typeof makeTaskRecord>[0]>['projection']>, delivery: object) =>
      ({ ...makeTaskRecord({ projection: { ...open, ...projection } }), delivery });
    expect(describeTaskAttention(withFacts({ ciChecks: 'FAILING' }, { failingChecks: { names: ['unit', 'lint', 'build'], count: 3 } })))
      .toMatchObject({ label: 'Checks failed', detail: 'unit, lint and build failed' });
    // Names only the first few, never as if they were all.
    expect(describeTaskAttention(withFacts({ ciChecks: 'FAILING' }, { failingChecks: { names: ['unit', 'lint', 'build'], count: 5 } })))
      .toMatchObject({ detail: 'unit, lint and 3 more failed' });
    expect(describeTaskAttention(withFacts({ reviews: 'CHANGES_REQUESTED' }, {
      feedback: { unresolvedCount: 2, reviewers: [{ name: 'alice', state: 'CHANGES_REQUESTED' }] }
    }))).toMatchObject({ label: 'Changes requested', detail: 'alice requested changes, 2 unresolved threads' });
    expect(describeTaskAttention(withFacts({ merge: 'BLOCKED' }, { baseMoved: { base: 'main', reason: 'CONFLICTS' } })))
      .toMatchObject({ label: 'Merge blocked', detail: 'Conflicts with main' });
    expect(describeTaskAttention(withFacts({ health: 'ERROR', branchPublication: 'FAILED' }, { pushError: 'Remote branch has newer commits.' })))
      .toMatchObject({ label: 'Push failed', detail: 'Remote branch has newer commits.' });
    // A push that may have landed is not called failed.
    expect(describeTaskAttention(withFacts({ health: 'ERROR', branchPublication: 'AMBIGUOUS' }, {})))
      .toMatchObject({ label: 'Push unconfirmed' });
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
