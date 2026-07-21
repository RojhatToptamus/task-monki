import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { Task } from '../../shared/contracts';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  canRequestReviewChanges,
  columnTasks,
  computeNavCounts,
  describeRunFailureBanner,
  describeTaskHeaderState,
  evidenceLineForTask,
  finishActionsForTask,
  finishRequirementsForTask,
  getFinishEvidenceState,
  markDoneModalCopy,
  reviewFindingCountLabel,
  selectTaskCardRepositoryIdentity,
  shouldShowInboxRepository,
  tasksSpanMultipleRepositories
} from './taskView';

const now = '2026-06-24T10:00:00.000Z';

describe('task card view model', () => {
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
    expect(describeRunFailureBanner(task)).toEqual({
      status: 'FAILED',
      title: 'The agent run failed',
      detail: expect.stringMatching(/retry in this session or continue/i)
    });
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
    expect(describeTaskHeaderState(task)).toEqual({ label: 'Needs retry', tone: 'action' });
    expect(describeRunFailureBanner(task)).toEqual({
      status: 'NEEDS_RETRY',
      title: 'Implementation needs another pass',
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
      title: 'Task Monki cannot prove the final provider state',
      detail: 'The turn outcome is ambiguous.'
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

    expect(vm.stateLabel).toBe('Reviewing...');
    expect(computeNavCounts([task]).review).toBe(1);
    expect(columnTasks([task], reviewColumn)).toHaveLength(1);
    expect(columnTasks([task], progressColumn)).toHaveLength(0);
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

  it('keeps review verdicts out of the task detail header state', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        agentRun: 'COMPLETED',
        agentReview: { status: 'NEEDS_CHANGES' }
      },
      workflowPhase: 'REVIEW'
    });

    expect(buildTaskCardVM(task).stateLabel).toBe('Needs changes');
    expect(describeTaskHeaderState(task)).toEqual({ label: 'In review', tone: 'info' });
  });

  it('drops the No-PR evidence line while keeping bad evidence noticeable', () => {
    const clean = evidenceLineForTask(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'CLEAN',
          githubPullRequest: 'NOT_CREATED'
        }
      })
    );
    const dirty = evidenceLineForTask(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'DIRTY',
          githubPullRequest: 'OPEN_DRAFT',
          githubPullRequestNumber: 82,
          ciChecks: 'BLOCKED'
        }
      })
    );

    expect(clean).toEqual([]);
    expect(dirty).toEqual([{ value: 'PR #82', label: 'checks failing', tone: 'error' }]);
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
    expect(buildTaskCardVM(forked).lineage).toBe('fork of #src12345');
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
    expect(reviewFindingCountLabel(withFindings)).toBe('1 blocker · 2 major');
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
    expect(
      canRequestReviewChanges({ status: 'INCONCLUSIVE' })
    ).toBe(true);
    expect(
      canRequestReviewChanges({ status: 'CANCELED', result })
    ).toBe(false);
    expect(
      canRequestReviewChanges({ status: 'STALE', result })
    ).toBe(false);
    expect(
      canRequestReviewChanges({ status: 'FAILED' }, 'FAILED', true)
    ).toBe(true);
    expect(
      canRequestReviewChanges({ status: 'FAILED' })
    ).toBe(false);
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
      { label: 'Review', detail: 'needs changes', tone: 'error', unresolved: true },
      { label: 'Tree', detail: '2 dirty', tone: 'action', unresolved: true }
    ]);
  });

  it('keeps Finish actions scoped to local completion', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'DIRTY',
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'REVIEW'
    });

    expect(
      finishActionsForTask({
        task,
        reviewStatus: 'PASSED',
        finishEvidence: { mode: 'clean', warnings: [] }
      }).map((action) => ({
        id: action.id,
        label: action.label,
        kind: action.kind,
        disabled: action.disabled,
        withIssues: action.withIssues
      }))
    ).toEqual([
      {
        id: 'commit',
        label: 'Commit',
        kind: 'outline',
        disabled: false,
        withIssues: undefined
      },
      {
        id: 'mark-done',
        label: 'Mark done',
        kind: 'outline',
        disabled: false,
        withIssues: false
      }
    ]);
  });

  it('keeps Commit disabled when Mark done requires an override after a local commit', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'COMMITTED_UNPUSHED',
        agentReview: { status: 'STALE', runId: 'review-run' }
      },
      workflowPhase: 'REVIEW'
    });

    const actions = finishActionsForTask({
      task,
      reviewStatus: 'STALE',
      finishEvidence: {
        mode: 'override',
        warnings: [
          {
            title: 'Review is stale.',
            detail: 'Run review again before marking done cleanly, or mark done anyway.'
          }
        ]
      }
    });

    expect(actions.map((action) => action.label)).toEqual(['Commit', 'Mark done anyway']);
    expect(actions.find((action) => action.id === 'commit')?.disabled).toBe(true);
  });

  it('does not offer Create draft PR after an open PR exists', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'PUSHED',
        githubPullRequest: 'OPEN_READY',
        githubPullRequestNumber: 82,
        agentReview: { status: 'PASSED' }
      },
      workflowPhase: 'IN_REVIEW'
    });

    const actions = finishActionsForTask({
      task,
      reviewStatus: 'PASSED',
      finishEvidence: { mode: 'clean', warnings: [] }
    });

    expect(actions.map((action) => action.id)).toEqual(['commit', 'mark-done']);
    expect(actions.find((action) => action.id === 'commit')?.disabled).toBe(true);
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
    const actions = finishActionsForTask({
      task,
      reviewStatus: 'PASSED',
      finishEvidence
    });

    expect(finishEvidence).toEqual({ mode: 'clean', warnings: [] });
    expect(requirements).toEqual([
      { label: 'Review', detail: 'passed', tone: 'success', unresolved: false },
      { label: 'Tree', detail: 'pushed', tone: 'success', unresolved: false }
    ]);
    expect(actions.find((action) => action.id === 'mark-done')).toMatchObject({
      label: 'Mark done',
      disabled: false,
      withIssues: false
    });
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
    const actions = finishActionsForTask({
      task,
      reviewStatus: 'PASSED',
      finishEvidence
    });

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
      detail: 'ready, not merged',
      tone: 'action',
      unresolved: true
    });
    expect(actions.find((action) => action.id === 'mark-done')).toMatchObject({
      label: 'Mark done',
      disabled: true,
      withIssues: false
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
    const actions = finishActionsForTask({
      task,
      reviewStatus: 'PASSED',
      finishEvidence
    });

    expect(finishEvidence).toEqual({ mode: 'clean', warnings: [] });
    expect(requirements).toContainEqual({
      label: 'Merge',
      detail: 'merged',
      tone: 'success',
      unresolved: false
    });
    expect(actions.find((action) => action.id === 'mark-done')).toMatchObject({
      label: 'Mark done',
      disabled: false,
      withIssues: false
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
      detail: 'ready, not merged',
      tone: 'action',
      unresolved: true
    });
    expect(requirements).toContainEqual({
      label: 'Checks',
      detail: 'passing',
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
      detail: 'failing',
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
      detail: 'not current',
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
      detail: 'passing',
      tone: 'success',
      unresolved: false
    });
  });

  it('disables local completion while review is running', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'DIRTY',
        agentReview: { status: 'RUNNING', runId: 'review-run' }
      },
      workflowPhase: 'REVIEW'
    });

    expect(
      finishActionsForTask({
        task,
        reviewStatus: 'RUNNING',
        finishEvidence: { mode: 'override', warnings: [] }
      })
    ).toEqual([
      {
        id: 'mark-done',
        label: 'Mark done anyway',
        kind: 'outline',
        disabled: true,
        withIssues: true
      }
    ]);
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
    expect(markDoneModalCopy(true, true).confirmLabel).toBe('Marking done...');
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
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
