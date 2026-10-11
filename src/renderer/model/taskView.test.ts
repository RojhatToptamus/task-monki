import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { DomainEvent, Task } from '../../shared/contracts';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  canRequestReviewChanges,
  columnTasks,
  computeNavCounts,
  describeRunFailureBanner,
  describeTaskCompletionEvidence,
  describeTaskStatus,
  cardPullRequestForTask,
  reviewFindingCountLabel,
  selectTaskCardRepositoryIdentity,
  shouldShowInboxRepository,
  tasksSpanMultipleRepositories
} from './taskView';
import {
  finishRequirementsForTask,
  getFinishEvidenceState,
  markDoneModalCopy
} from './taskFinish';

const now = '2026-06-24T10:00:00.000Z';

describe('task card view model', () => {
  it('distinguishes marked-done, automatic, and unknown completion sources', () => {
    const doneTask = createTask({ workflowPhase: 'DONE' });
    const markedDoneEvent: DomainEvent = {
      id: 'event-done',
      type: 'TRANSITION_COMPLETED',
      taskId: doneTask.id,
      source: 'ui',
      sourceEventId: 'source-done',
      occurredAt: now,
      receivedAt: now,
      payload: { fromPhase: 'REVIEW', toPhase: 'DONE', reason: 'Accepted locally' }
    };

    expect(describeTaskCompletionEvidence(doneTask, [markedDoneEvent])).toMatchObject({
      label: 'Marked done'
    });
    expect(describeTaskCompletionEvidence(
      createTask({
        workflowPhase: 'DONE',
        completionPolicy: 'MERGED',
        projection: { ...createInitialProjection(now), merge: 'MERGED' }
      }),
      []
    )).toMatchObject({ label: 'Auto-completed' });
    expect(describeTaskCompletionEvidence(doneTask, [])).toMatchObject({
      label: 'Completion unknown'
    });
    expect(describeTaskCompletionEvidence(createTask(), [])).toBeUndefined();
  });

  it('uses the latest workflow transition when it explains a Done task', () => {
    const oldDone: DomainEvent = {
      id: 'event-old-done',
      type: 'TRANSITION_COMPLETED',
      taskId: 'task-1',
      source: 'ui',
      sourceEventId: 'source-old-done',
      occurredAt: now,
      receivedAt: now,
      payload: { fromPhase: 'REVIEW', toPhase: 'DONE' }
    };
    const reopened: DomainEvent = {
      ...oldDone,
      id: 'event-reopened',
      sourceEventId: 'source-reopened',
      occurredAt: '2026-06-24T10:01:00.000Z',
      receivedAt: '2026-06-24T10:01:00.000Z',
      payload: { fromPhase: 'DONE', toPhase: 'REVIEW' }
    };
    const autoCompleted = createTask({
      workflowPhase: 'DONE',
      completionPolicy: 'MERGED',
      projection: { ...createInitialProjection(now), merge: 'MERGED' }
    });

    expect(describeTaskCompletionEvidence(autoCompleted, [oldDone, reopened])).toMatchObject({
      label: 'Auto-completed'
    });
  });

  it('shows review gate status for tasks in the Review phase', () => {
    const vm = buildTaskCardVM(
      createTask({
        projection: {
          ...createInitialProjection(now),
          agentRun: 'COMPLETED',
          agentReview: { status: 'NOT_RUN' }
        },
        workflowPhase: 'REVIEW'
      }),
      { repositoryName: 'repo' }
    );

    expect(vm.stateLabel).toBe('Ready for review');
    expect(vm.stateTone).toBe('action');
  });

  it('shows user-blocking attention before review gate status', () => {
    const vm = buildTaskCardVM(
      createTask({
        projection: {
          ...createInitialProjection(now),
          agentRun: 'AWAITING_APPROVAL',
          agentReview: { status: 'RUNNING' }
        },
        workflowPhase: 'REVIEW'
      })
    );

    expect(vm.stateLabel).toBe('Needs approval');
    expect(vm.stateTone).toBe('action');
  });

  it('keeps a failed implementation in progress and does not label it ready for review', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        agentRun: 'FAILED',
        agentReview: { status: 'NOT_RUN' }
      },
      workflowPhase: 'IN_PROGRESS'
    });
    const vm = buildTaskCardVM(task);
    const reviewColumn = BOARD_COLUMNS.find((column) => column.key === 'review')!;
    const progressColumn = BOARD_COLUMNS.find((column) => column.key === 'progress')!;

    expect(vm.stateLabel).toBe('Run failed');
    expect(vm.stateTone).toBe('error');
    expect(computeNavCounts([task]).review).toBe(0);
    expect(columnTasks([task], reviewColumn)).toHaveLength(0);
    expect(columnTasks([task], progressColumn)).toHaveLength(1);
    // The banner names the state in the board card's word; its actions say what to do.
    expect(describeRunFailureBanner(task)).toEqual({
      status: 'FAILED',
      title: 'Run failed'
    });
  });

  it('keeps a failed run\'s recorded reason as reported context, never the latest task event', () => {
    const task = createTask({
      currentRunId: 'run-1',
      projection: {
        ...createInitialProjection(now),
        agentRun: 'FAILED',
        summary: 'Worktree verification completed.'
      },
      workflowPhase: 'IN_PROGRESS'
    });

    // The provider's message is attributed context, never Task Monki's own detail.
    expect(describeRunFailureBanner(task, { id: 'run-1', terminalReason: 'Codex exited before the turn finished' }))
      .toEqual({
        status: 'FAILED',
        title: 'Run failed',
        reportedReason: 'Codex exited before the turn finished.'
      });
    // Neither an older run's reason nor the latest unrelated task event explains this failure.
    const unrelated = describeRunFailureBanner(task, { id: 'run-0', terminalReason: 'Old failure' });
    expect(unrelated?.reportedReason).toBeUndefined();
    expect(unrelated?.detail).toBeUndefined();
  });

  it('shows retry state when local evidence blocks a provider-completed implementation', () => {
    const reason =
      'A provider execution request was declined and this run produced no Git change.';
    const task = createTask({
      currentRunId: 'run-1',
      projection: {
        ...createInitialProjection(now),
        requestedAction: 'FAILED',
        agentRun: 'COMPLETED',
        summary: 'A later Git refresh completed.',
        implementationRetry: { runId: 'run-1', reason }
      },
      workflowPhase: 'IN_PROGRESS'
    });
    const vm = buildTaskCardVM(task);

    expect(vm.stateLabel).toBe('Needs retry');
    expect(vm.stateTone).toBe('action');
    expect(describeTaskStatus(task)).toEqual({ label: 'Needs retry', tone: 'action' });
    expect(describeRunFailureBanner(task)).toEqual({
      status: 'NEEDS_RETRY',
      title: 'Needs retry',
      detail: reason
    });
  });

  it('reserves ambiguous provider-state copy for recovery and runtime loss', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        agentRun: 'RECOVERY_REQUIRED',
        summary: 'The turn outcome is ambiguous.'
      },
      workflowPhase: 'IN_PROGRESS'
    });

    expect(describeRunFailureBanner(task)).toEqual({
      status: 'RECOVERY_REQUIRED',
      title: 'Recovery required',
      detail: 'Task Monki could not confirm how the run ended and will not resubmit it on its own.'
    });
    // The run's own reason is context beside Task Monki's explanation, never in place of it.
    expect(
      describeRunFailureBanner(
        { ...task, currentRunId: 'run-1' },
        { id: 'run-1', terminalReason: 'stdio transport closed' }
      )
    ).toMatchObject({
      detail: expect.stringMatching(/will not resubmit it/),
      reportedReason: 'stdio transport closed.'
    });
  });

  it('keeps a running review gate in the review lane even if the phase is stale', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        agentRun: 'COMPLETED',
        agentReview: { status: 'RUNNING', runId: 'review-run' }
      },
      workflowPhase: 'IN_PROGRESS'
    });
    const vm = buildTaskCardVM(task, { repositoryName: 'repo' });
    const reviewColumn = BOARD_COLUMNS.find((column) => column.key === 'review')!;
    const progressColumn = BOARD_COLUMNS.find((column) => column.key === 'progress')!;

    expect(vm.stateLabel).toBe('Reviewing');
    expect(computeNavCounts([task]).review).toBe(1);
    expect(columnTasks([task], reviewColumn)).toHaveLength(1);
    expect(columnTasks([task], progressColumn)).toHaveLength(0);
  });

  it('ranks recovery and a broken checkout above Git and delivery problems', () => {
    const status = (projection: Partial<Task['projection']>, workflowPhase: Task['workflowPhase'] = 'IN_PROGRESS') =>
      describeTaskStatus(createTask({ projection: { ...createInitialProjection(now), ...projection }, workflowPhase })).label;

    // The decision slot offers Continue for an interrupted run, so the header says so.
    expect(status({ agentRun: 'INTERRUPTED', git: 'CONFLICTED' })).toBe('Interrupted');
    // Retry cannot run without the checkout, so the checkout comes first.
    expect(status({ agentRun: 'FAILED', worktree: 'MISSING' })).toBe('Checkout missing');
    // A request the user owes still leads.
    expect(status({ agentRun: 'AWAITING_APPROVAL', worktree: 'MISSING' })).toBe('Needs approval');
  });

  it('names what an open or merged pull request asks for instead of a bare phase', () => {
    const status = (projection: Partial<Task['projection']>) =>
      describeTaskStatus(createTask({
        projection: { ...createInitialProjection(now), agentRun: 'COMPLETED', githubPullRequest: 'OPEN_READY', ...projection },
        workflowPhase: 'IN_REVIEW'
      })).label;

    expect(status({ git: 'PUSHED' })).toBe('In review');
    expect(status({ git: 'DIVERGED' })).toBe('Branch diverged');
    expect(status({ git: 'COMMITTED_UNPUSHED' })).toBe('Changes not pushed');
    expect(status({ git: 'PUSHED', ciChecks: 'STALE' })).toBe('Checks stale');
    // A merged pull request ends delivery even before the task is done.
    expect(status({ githubPullRequest: 'MERGED', merge: 'MERGED', ciChecks: 'STALE' })).toBe('Merged');
    // In the Review lane, "In review" only restates the lane.
    const vm = buildTaskCardVM(createTask({
      projection: { ...createInitialProjection(now), agentRun: 'COMPLETED', githubPullRequest: 'OPEN_READY', git: 'PUSHED' },
      workflowPhase: 'IN_REVIEW'
    }), { columnKey: 'review' });
    expect(vm.showState).toBe(false);
  });

  it('labels inconclusive review output directly', () => {
    const vm = buildTaskCardVM(
      createTask({
        projection: {
          ...createInitialProjection(now),
          agentRun: 'COMPLETED',
          agentReview: { status: 'INCONCLUSIVE' }
        },
        workflowPhase: 'REVIEW'
      })
    );

    expect(vm.stateLabel).toBe('Inconclusive');
    expect(vm.stateTone).toBe('action');
  });

  it('never says a review is running unless one is', () => {
    const inReview = (projection: Partial<Task['projection']>) => describeTaskStatus(createTask({
      projection: { ...createInitialProjection(now), agentRun: 'COMPLETED', ...projection },
      workflowPhase: 'REVIEW'
    })).label;

    expect(inReview({ agentReview: { status: 'NEEDS_CHANGES' } })).toBe('Needs changes');
    expect(inReview({})).toBe('Ready for review');
    expect(inReview({ agentReview: { status: 'RUNNING' } })).toBe('Reviewing');
    // Once a pull request carries delivery, the optional agent review stops naming the state…
    expect(inReview({ githubPullRequest: 'OPEN_DRAFT' })).toBe('In review');
    // …and verified delivery evidence outranks the review gate.
    expect(inReview({ githubPullRequest: 'OPEN_READY', ciChecks: 'FAILING' })).toBe('Checks failed');
    expect(inReview({ worktree: 'MISSING' })).toBe('Checkout missing');
  });

  it('reads the board summary\'s effective review status, which decisions move both ways', () => {
    // A board summary carries the status once every decision applies, so the card follows it.
    const summarized = (agentReview: Record<string, unknown>) => describeTaskStatus(createTask({
      projection: { ...createInitialProjection(now), agentRun: 'COMPLETED', agentReview: agentReview as never },
      workflowPhase: 'REVIEW'
    })).label;

    expect(summarized({ status: 'PASSED', hasResult: true, findingCounts: { BLOCKER: 1 }, effectiveStatus: 'NEEDS_CHANGES' }))
      .toBe('Needs changes');
    expect(summarized({ status: 'NEEDS_CHANGES', hasResult: true, findingCounts: {}, effectiveStatus: 'INCONCLUSIVE' }))
      .toBe('Inconclusive');
    expect(summarized({ status: 'NEEDS_CHANGES', hasResult: true, findingCounts: {}, effectiveStatus: 'PASSED' }))
      .toBe('Review passed');
  });

  it('names a card pull request by number and state, and says delivery progress once', () => {
    const pullRequest = (projection: Partial<Task['projection']>) =>
      cardPullRequestForTask(createTask({
        projection: { ...createInitialProjection(now), agentRun: 'COMPLETED', ...projection },
        workflowPhase: 'IN_REVIEW'
      }));

    // No pull request is the absence of delivery state, not a footer.
    expect(pullRequest({ git: 'CLEAN', githubPullRequest: 'NOT_CREATED' })).toBeUndefined();
    expect(pullRequest({ githubPullRequest: 'OPEN_DRAFT', githubPullRequestNumber: 82, ciChecks: 'PENDING' }))
      .toEqual({ number: 82, state: 'draft', note: 'checks pending' });
    // The status word already says Checks failed, so the footer does not repeat it.
    expect(pullRequest({ githubPullRequest: 'OPEN_READY', githubPullRequestNumber: 82, ciChecks: 'FAILING' }))
      .toEqual({ number: 82, state: 'open' });
    // Scalars alone never claim ready to merge.
    expect(pullRequest({ githubPullRequest: 'OPEN_READY', githubPullRequestNumber: 82, ciChecks: 'PASSING', merge: 'MERGEABLE' }))
      .toEqual({ number: 82, state: 'open', note: 'checks passing, mergeable' });
    // A merged or closed pull request says so with its state alone.
    expect(pullRequest({ githubPullRequest: 'MERGED', githubPullRequestNumber: 82, merge: 'MERGED', ciChecks: 'FAILING' }))
      .toEqual({ number: 82, state: 'merged' });
    expect(pullRequest({ githubPullRequest: 'CLOSED_UNMERGED', githubPullRequestNumber: 82 }))
      .toEqual({ number: 82, state: 'closed' });
  });

  it('keeps active follow-up work in progress and labels it as fixing review feedback', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        agentRun: 'RUNNING',
        agentReview: {
          status: 'STALE',
          runId: 'review-run',
          result: {
            schemaVersion: 'agent-review/v1',
            verdict: 'NEEDS_CHANGES',
            summary: 'Fix review findings.',
            findings: [
              {
                id: 'finding-1',
                severity: 'BLOCKER',
                title: 'Leaky listener',
                explanation: 'Listener is not cleaned up.'
              }
            ]
          }
        }
      },
      workflowPhase: 'IN_PROGRESS'
    });
    const vm = buildTaskCardVM(task);
    const reviewColumn = BOARD_COLUMNS.find((column) => column.key === 'review')!;
    const progressColumn = BOARD_COLUMNS.find((column) => column.key === 'progress')!;

    expect(vm.stateLabel).toBe('Fixing review feedback');
    expect(vm.stateTone).toBe('info');
    expect(computeNavCounts([task]).review).toBe(0);
    expect(columnTasks([task], reviewColumn)).toHaveLength(0);
    expect(columnTasks([task], progressColumn)).toHaveLength(1);
  });

  it('shows a completed follow-up in Review as needing re-review', () => {
    const vm = buildTaskCardVM(
      createTask({
        projection: {
          ...createInitialProjection(now),
          agentRun: 'COMPLETED',
          agentReview: { status: 'STALE', runId: 'review-run' }
        },
        workflowPhase: 'REVIEW'
      })
    );

    expect(vm.stateLabel).toBe('Needs re-review');
    expect(vm.stateTone).toBe('action');
  });

  it('shows Archived as the card state even when the last agent run completed', () => {
    const vm = buildTaskCardVM(
      createTask({
        projection: {
          ...createInitialProjection(now),
          agentRun: 'COMPLETED',
          git: 'DIRTY'
        },
        workflowPhase: 'ARCHIVED'
      }),
      { repositoryName: 'repo' }
    );

    expect(vm.meta).toBe('repo');
    expect(vm.stateLabel).toBe('Archived');
    expect(vm.stateTone).toBe('neutral');
    expect(vm.archived).toBe(true);
  });

  it('drops the repo line when cards share a single repository', () => {
    const task = createTask();
    expect(buildTaskCardVM(task, { showRepo: true, repositoryName: 'repo' }).meta).toBe('repo');
    expect(buildTaskCardVM(task, { showRepo: false }).meta).toBeUndefined();
  });

  it('shows a lineage cue for a forked task', () => {
    expect(buildTaskCardVM(createTask()).lineage).toBeUndefined();
    const forked = createTask({ forkedFromTaskId: 'src12345-6789' });
    expect(buildTaskCardVM(forked, { taskTitles: new Map([['src12345-6789', 'Add rate limiting']]) }).lineage).toBe('Fork of Add rate limiting');
    expect(buildTaskCardVM(forked).lineage).toBe('Fork');
  });

  it('summarizes review findings by severity for the review queue', () => {
    const withFindings = createTask({
      projection: {
        ...createInitialProjection(now),
        agentReview: {
          status: 'NEEDS_CHANGES',
          runId: 'r',
          result: {
            schemaVersion: 'agent-review/v1',
            verdict: 'NEEDS_CHANGES',
            summary: 'Fix these.',
            findings: [
              { id: 'a', severity: 'BLOCKER', title: 'A', explanation: 'x' },
              { id: 'b', severity: 'MAJOR', title: 'B', explanation: 'y' },
              { id: 'c', severity: 'MAJOR', title: 'C', explanation: 'z' }
            ]
          }
        }
      }
    });
    expect(reviewFindingCountLabel(withFindings)).toBe('1 blocker, 2 major');
    expect(reviewFindingCountLabel(createTask())).toBeUndefined();
  });

  it('detects when a task set spans more than one repository', () => {
    const a = createTask({ id: 'a', repositoryId: '/tmp/repo-a' });
    const b = createTask({ id: 'b', repositoryId: '/tmp/repo-a' });
    const c = createTask({ id: 'c', repositoryId: '/tmp/repo-b' });
    expect(tasksSpanMultipleRepositories([a, b])).toBe(false);
    expect(tasksSpanMultipleRepositories([a, b, c])).toBe(true);
    expect(tasksSpanMultipleRepositories([])).toBe(false);
  });

  it('resolves card repository identity for global, single-repository, and missing-repository views', () => {
    const repositoryNames = new Map([
      ['repository-a', { name: 'repo', status: 'AVAILABLE' as const }],
      ['repository-b', { name: 'repo-secondary', status: 'AVAILABLE' as const }],
      ['repository-missing', { name: 'offline-repo', status: 'MISSING' as const }]
    ]);

    expect(
      selectTaskCardRepositoryIdentity('repository-a', repositoryNames, true)
    ).toEqual({ showRepo: true, repositoryName: 'repo' });
    expect(
      selectTaskCardRepositoryIdentity('repository-a', repositoryNames, false)
    ).toEqual({ showRepo: false, repositoryName: 'repo' });
    expect(
      selectTaskCardRepositoryIdentity('repository-missing', repositoryNames, false)
    ).toEqual({ showRepo: true, repositoryName: 'offline-repo' });
    expect(
      selectTaskCardRepositoryIdentity('repository-absent', repositoryNames, false)
    ).toEqual({ showRepo: true, repositoryName: 'Missing repository' });
  });

  it('shows Inbox repository identity only when it distinguishes or identifies a missing repository', () => {
    const a = createTask({ id: 'a', repositoryId: 'repository-a' });
    const b = createTask({ id: 'b', repositoryId: 'repository-a' });
    const c = createTask({ id: 'c', repositoryId: 'repository-b' });

    expect(
      shouldShowInboxRepository([a, b], [{ id: 'repository-a', status: 'AVAILABLE' }])
    ).toBe(false);
    expect(
      shouldShowInboxRepository([a, c], [
        { id: 'repository-a', status: 'AVAILABLE' },
        { id: 'repository-b', status: 'AVAILABLE' }
      ])
    ).toBe(true);
    expect(
      shouldShowInboxRepository([a], [{ id: 'repository-a', status: 'MISSING' }])
    ).toBe(true);
    expect(shouldShowInboxRepository([a], [])).toBe(true);
  });

  it('suppresses a status pill that only restates its column', () => {
    const ready = createTask({ workflowPhase: 'READY' });
    expect(buildTaskCardVM(ready, { columnKey: 'ready' }).showState).toBe(false);
    // The same "Ready" state keeps its pill outside the Backlog / Ready column.
    expect(buildTaskCardVM(ready).showState).toBe(true);

    const done = createTask({ workflowPhase: 'DONE' });
    expect(buildTaskCardVM(done, { columnKey: 'done' }).showState).toBe(false);

    const inProgress = createTask({ workflowPhase: 'IN_PROGRESS' });
    expect(buildTaskCardVM(inProgress, { columnKey: 'progress' }).showState).toBe(false);

    // A pill that refines the Review column is kept.
    const needsChanges = createTask({
      projection: {
        ...createInitialProjection(now),
        agentReview: { status: 'NEEDS_CHANGES', runId: 'r' }
      },
      workflowPhase: 'REVIEW'
    });
    expect(buildTaskCardVM(needsChanges, { columnKey: 'review' }).showState).toBe(true);
  });

  it('allows requesting changes from actionable review results', () => {
    const finding = {
      id: 'finding-1',
      severity: 'BLOCKER' as const,
      title: 'Leaky listener',
      explanation: 'Listener is not cleaned up.'
    };
    const result = {
      schemaVersion: 'agent-review/v1' as const,
      verdict: 'NEEDS_CHANGES' as const,
      summary: 'Fix listener cleanup.',
      findings: [finding]
    };

    expect(
      canRequestReviewChanges({ status: 'NEEDS_CHANGES', result })
    ).toBe(true);
    expect(
      canRequestReviewChanges({ status: 'NEEDS_CHANGES' })
    ).toBe(true);
    // An inconclusive review offers changes only through open findings, never its prose.
    expect(
      canRequestReviewChanges({ status: 'INCONCLUSIVE' })
    ).toBe(false);
    expect(
      canRequestReviewChanges({ status: 'INCONCLUSIVE', result: { ...result, verdict: 'INCONCLUSIVE', findings: [{ ...finding, severity: 'MINOR' }] } })
    ).toBe(true);
    expect(
      canRequestReviewChanges({ status: 'CANCELED', result })
    ).toBe(false);
    expect(
      canRequestReviewChanges({ status: 'STALE', result })
    ).toBe(false);
    expect(
      canRequestReviewChanges({ status: 'FAILED' })
    ).toBe(false);
    expect(
      canRequestReviewChanges({ status: 'FAILED', result })
    ).toBe(true);
    expect(
      canRequestReviewChanges({ status: 'FAILED' })
    ).toBe(false);
  });

});

describe('task finish policy', () => {

  it('stops treating a review as asking for changes once its last open finding is dismissed', () => {
    const finding = { id: 'f1', severity: 'MAJOR' as const, title: 'Limiter state is per process', explanation: 'Each replica keeps its own buckets.' };
    const review = (decisions: NonNullable<Task['projection']['agentReview']>['findingDecisions']) => createTask({
      projection: {
        ...createInitialProjection(now),
        git: 'CLEAN',
        agentReview: {
          status: 'NEEDS_CHANGES', runId: 'review-1', findingDecisions: decisions,
          result: { schemaVersion: 'agent-review/v1', verdict: 'NEEDS_CHANGES', summary: 'Fix the limiter.', findings: [finding] }
        }
      },
      workflowPhase: 'REVIEW'
    });
    const open = review([]);
    const dismissed = review([{ id: 'd1', reviewRunId: 'review-1', findingId: 'f1', kind: 'DISMISS', dismissReason: 'ACCEPTED', note: 'One replica', createdAt: now }]);

    expect(getFinishEvidenceState(open).mode).toBe('override');
    expect(describeTaskStatus(open).label).toBe('Needs changes');
    expect(getFinishEvidenceState(dismissed)).toEqual({ mode: 'clean', warnings: [] });
    expect(describeTaskStatus(dismissed).label).not.toBe('Needs changes');
  });

  it('allows clean local completion only when review and Git evidence are healthy', () => {
    const state = getFinishEvidenceState(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'CLEAN',
          agentReview: { status: 'PASSED' }
        },
        workflowPhase: 'REVIEW'
      })
    );

    expect(state).toEqual({ mode: 'clean', warnings: [] });
  });

  it('uses Mark done anyway when Git is dirty even if review passed', () => {
    const state = getFinishEvidenceState(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'DIRTY',
          agentReview: { status: 'PASSED' }
        },
        workflowPhase: 'REVIEW'
      }),
      'PASSED',
      2
    );

    expect(state.mode).toBe('override');
    expect(state.warnings).toContainEqual({
      title: 'Working tree is dirty.',
      detail: '2 uncommitted files remain. Commit or open a PR to share the work.'
    });
  });

  it('summarizes finish requirements without duplicate verdict chips', () => {
    const requirements = finishRequirementsForTask(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'DIRTY',
          agentReview: { status: 'NEEDS_CHANGES' }
        },
        workflowPhase: 'REVIEW'
      }),
      'NEEDS_CHANGES',
      2
    );

    expect(requirements).toEqual([
      { label: 'Review', fact: 'Agent review requested changes', tone: 'error', unresolved: true },
      { label: 'Tree', fact: '2 uncommitted files', tone: 'action', unresolved: true }
    ]);
  });

  it('keeps manually local-acceptance PR evidence as clean local completion', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'PUSHED',
        branchPublication: 'PUSHED',
        githubPullRequest: 'OPEN_READY',
        githubPullRequestNumber: 9,
        ciChecks: 'PASSING',
        merge: 'MERGEABLE',
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'IN_REVIEW',
      completionPolicy: 'LOCAL_ACCEPTANCE'
    });

    const finishEvidence = getFinishEvidenceState(task, 'PASSED', 0, 'MERGEABLE');
    const requirements = finishRequirementsForTask(task, 'PASSED', 0, 'MERGEABLE');

    expect(finishEvidence).toEqual({ mode: 'clean', warnings: [] });
    expect(requirements).toEqual([
      { label: 'Review', fact: 'Agent review passed', tone: 'success', unresolved: false },
      { label: 'Tree', fact: 'Pushed', tone: 'success', unresolved: false }
    ]);
  });

  it('blocks local completion for merged-policy tasks until GitHub reports merged', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'PUSHED',
        branchPublication: 'PUSHED',
        githubPullRequest: 'OPEN_READY',
        githubPullRequestNumber: 9,
        ciChecks: 'PASSING',
        merge: 'MERGEABLE',
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'IN_REVIEW',
      completionPolicy: 'MERGED'
    });

    const finishEvidence = getFinishEvidenceState(task, 'PASSED', 0, 'MERGEABLE');
    const requirements = finishRequirementsForTask(task, 'PASSED', 0, 'MERGEABLE');

    expect(finishEvidence).toEqual({
      mode: 'blocked',
      warnings: [
        {
          title: 'Pull request is not merged.',
          detail: 'This task requires a merged PR before it can be marked done.'
        }
      ]
    });
    expect(requirements).toContainEqual({
      label: 'Merge',
      fact: 'Ready to merge',
      tone: 'action',
      unresolved: true
    });
  });

  it('allows clean completion for merged-policy tasks after merge evidence lands', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'PUSHED',
        branchPublication: 'PUSHED',
        githubPullRequest: 'MERGED',
        githubPullRequestNumber: 9,
        ciChecks: 'PASSING',
        merge: 'MERGED',
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'IN_REVIEW',
      completionPolicy: 'MERGED'
    });

    const finishEvidence = getFinishEvidenceState(task, 'PASSED', 0, 'MERGED');
    const requirements = finishRequirementsForTask(task, 'PASSED', 0, 'MERGED');

    expect(finishEvidence).toEqual({ mode: 'clean', warnings: [] });
    expect(requirements).toContainEqual({
      label: 'Merge',
      fact: 'Merged',
      tone: 'success',
      unresolved: false
    });
  });

  it('applies merge requirements to merged-and-verified completion policy', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'PUSHED',
        branchPublication: 'PUSHED',
        githubPullRequest: 'OPEN_READY',
        githubPullRequestNumber: 9,
        ciChecks: 'PASSING',
        merge: 'MERGEABLE',
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'IN_REVIEW',
      completionPolicy: 'MERGED_AND_VERIFIED'
    });

    const verifiedChecksEvidence = {
      ciStatus: 'PASSING' as const,
      ciHeadSha: 'head',
      ciPullRequestNumber: 9,
      mergeHeadSha: 'head',
      mergePullRequestNumber: 9
    };

    expect(
      getFinishEvidenceState(
        task,
        'PASSED',
        0,
        'MERGEABLE',
        'PASSING',
        verifiedChecksEvidence
      ).mode
    ).toBe('blocked');
    const requirements = finishRequirementsForTask(
      task,
      'PASSED',
      0,
      'MERGEABLE',
      'PASSING',
      verifiedChecksEvidence
    );
    expect(requirements).toContainEqual({
      label: 'Merge',
      fact: 'Ready to merge',
      tone: 'action',
      unresolved: true
    });
    expect(requirements).toContainEqual({
      label: 'Checks',
      fact: 'Checks passed',
      tone: 'success',
      unresolved: false
    });
  });

  it('blocks merged-and-verified completion after merge when checks are not passing', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'PUSHED',
        branchPublication: 'PUSHED',
        githubPullRequest: 'MERGED',
        githubPullRequestNumber: 9,
        ciChecks: 'FAILING',
        merge: 'MERGED',
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'IN_REVIEW',
      completionPolicy: 'MERGED_AND_VERIFIED'
    });

    expect(getFinishEvidenceState(task, 'PASSED', 0, 'MERGED', 'FAILING')).toEqual({
      mode: 'blocked',
      warnings: [
        {
          title: 'GitHub checks are not passing.',
          detail:
            'This task requires passing GitHub checks for the merged PR head before it can be marked done.'
        }
      ]
    });
    expect(finishRequirementsForTask(task, 'PASSED', 0, 'MERGED', 'FAILING')).toContainEqual({
      label: 'Checks',
      fact: 'Checks failed',
      tone: 'error',
      unresolved: true
    });
  });

  it('blocks merged-and-verified completion when passing checks are for an old head', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'PUSHED',
        branchPublication: 'PUSHED',
        githubPullRequest: 'MERGED',
        githubPullRequestNumber: 9,
        ciChecks: 'PASSING',
        merge: 'MERGED',
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'IN_REVIEW',
      completionPolicy: 'MERGED_AND_VERIFIED'
    });
    const staleChecksEvidence = {
      ciStatus: 'PASSING' as const,
      ciHeadSha: 'old-head',
      ciPullRequestNumber: 9,
      mergeHeadSha: 'merged-head',
      mergePullRequestNumber: 9
    };

    expect(
      getFinishEvidenceState(task, 'PASSED', 0, 'MERGED', 'PASSING', staleChecksEvidence)
    ).toEqual({
      mode: 'blocked',
      warnings: [
        {
          title: 'GitHub checks are not current.',
          detail:
            'This task requires passing GitHub checks for the merged PR head before it can be marked done.'
        }
      ]
    });
    expect(
      finishRequirementsForTask(task, 'PASSED', 0, 'MERGED', 'PASSING', staleChecksEvidence)
    ).toContainEqual({
      label: 'Checks',
      fact: 'Checks passed on an older head',
      tone: 'action',
      unresolved: true
    });
  });

  it('allows merged-and-verified completion when merged-head checks are passing', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'PUSHED',
        branchPublication: 'PUSHED',
        githubPullRequest: 'MERGED',
        githubPullRequestNumber: 9,
        ciChecks: 'PASSING',
        merge: 'MERGED',
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'IN_REVIEW',
      completionPolicy: 'MERGED_AND_VERIFIED'
    });
    const currentChecksEvidence = {
      ciStatus: 'PASSING' as const,
      ciHeadSha: 'merged-head',
      ciPullRequestNumber: 9,
      mergeHeadSha: 'merged-head',
      mergePullRequestNumber: 9
    };

    expect(
      getFinishEvidenceState(task, 'PASSED', 0, 'MERGED', 'PASSING', currentChecksEvidence)
    ).toEqual({ mode: 'clean', warnings: [] });
    expect(
      finishRequirementsForTask(task, 'PASSED', 0, 'MERGED', 'PASSING', currentChecksEvidence)
    ).toContainEqual({
      label: 'Checks',
      fact: 'Checks passed',
      tone: 'success',
      unresolved: false
    });
  });

  it('uses Mark done language in the confirmation modal copy', () => {
    expect(markDoneModalCopy(false, false)).toMatchObject({
      title: 'Mark done',
      body: 'Records the current local result as done without creating a commit or PR.',
      confirmLabel: 'Mark done'
    });
    expect(markDoneModalCopy(false, false, { hasPullRequest: true })).toMatchObject({
      title: 'Mark done',
      body: 'Records this task as done in Task Monki. The existing PR is left unchanged; no new commit or PR is created.',
      confirmLabel: 'Mark done'
    });
    expect(markDoneModalCopy(true, false)).toMatchObject({
      title: 'Mark done anyway',
      body: 'Records the current local result as done. No commit or PR is created, and these checks stay unresolved:',
      confirmLabel: 'Mark done anyway'
    });
    expect(markDoneModalCopy(true, false, { hasPullRequest: true })).toMatchObject({
      title: 'Mark done anyway',
      body: 'Records this task as done in Task Monki. The existing PR is left unchanged, and these checks stay unresolved:',
      confirmLabel: 'Mark done anyway'
    });
    expect(markDoneModalCopy(true, true).confirmLabel).toBe('Marking done…');
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: overrides.kind ?? 'NORMAL',
    runtimeId: 'codex',
    title: 'Task',
    prompt: 'Prompt',
    repositoryId: '/tmp/repo',
    workflowPhase: 'READY',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    projection: createInitialProjection(now),
    ...overrides
  };
}
