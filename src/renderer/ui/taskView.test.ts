import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { Task } from '../../shared/contracts';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  canRequestCodexReviewChanges,
  columnTasks,
  computeNavCounts,
  describeTaskHeaderState,
  evidenceLineForTask,
  finishActionsForTask,
  finishRequirementsForTask,
  getFinishEvidenceState,
  markDoneModalCopy
} from './taskView';

const now = '2026-06-24T10:00:00.000Z';

describe('task card view model', () => {
  it('shows review gate status for tasks in the Review phase', () => {
    const vm = buildTaskCardVM(
      createTask({
        projection: {
          ...createInitialProjection(now),
          agentRun: 'COMPLETED',
          codexReview: { status: 'NOT_RUN' }
        },
        workflowPhase: 'REVIEW'
      })
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
          codexReview: { status: 'RUNNING' }
        },
        workflowPhase: 'REVIEW'
      })
    );

    expect(vm.stateLabel).toBe('Needs approval');
    expect(vm.stateTone).toBe('action');
    expect(vm.hasDecision).toBe(true);
    expect(vm.decisionLabel).toBe('Needs you');
  });

  it('keeps a running review gate in the review lane even if the phase is stale', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        agentRun: 'COMPLETED',
        codexReview: { status: 'RUNNING', runId: 'review-run' }
      },
      workflowPhase: 'IN_PROGRESS'
    });
    const vm = buildTaskCardVM(task);
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
          codexReview: { status: 'INCONCLUSIVE' }
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
        codexReview: { status: 'NEEDS_CHANGES' }
      },
      workflowPhase: 'REVIEW'
    });

    expect(buildTaskCardVM(task).stateLabel).toBe('Needs changes');
    expect(describeTaskHeaderState(task)).toEqual({ label: 'In review', tone: 'info' });
  });

  it('builds a quiet evidence line while keeping bad evidence noticeable', () => {
    const clean = evidenceLineForTask(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'CLEAN',
          tests: 'PASSED',
          githubPullRequest: 'NOT_CREATED'
        }
      })
    );
    const dirty = evidenceLineForTask(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'DIRTY',
          tests: 'FAILED',
          githubPullRequest: 'OPEN_DRAFT',
          ciChecks: 'BLOCKED'
        }
      })
    );

    expect(clean).toEqual([
      { label: 'git clean' },
      { label: 'tests pass' },
      { label: 'no PR' }
    ]);
    expect(dirty).toEqual([
      { label: 'git dirty', tone: 'action' },
      { label: 'tests fail', tone: 'error' },
      { label: 'PR draft' },
      { label: 'CI blocked', tone: 'error' }
    ]);
  });

  it('keeps active follow-up work in progress and labels it as fixing review feedback', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        agentRun: 'RUNNING',
        codexReview: {
          status: 'STALE',
          runId: 'review-run',
          result: {
            schemaVersion: 'codex-review/v1',
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
          codexReview: { status: 'STALE', runId: 'review-run' }
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
      })
    );

    expect(vm.meta).toBe('repo');
    expect(vm.stateLabel).toBe('Archived');
    expect(vm.stateTone).toBe('neutral');
    expect(vm.archived).toBe(true);
  });

  it('allows requesting changes from actionable review results', () => {
    const finding = {
      id: 'finding-1',
      severity: 'BLOCKER' as const,
      title: 'Leaky listener',
      explanation: 'Listener is not cleaned up.'
    };
    const result = {
      schemaVersion: 'codex-review/v1' as const,
      verdict: 'NEEDS_CHANGES' as const,
      summary: 'Fix listener cleanup.',
      findings: [finding]
    };

    expect(
      canRequestCodexReviewChanges({ status: 'NEEDS_CHANGES', result })
    ).toBe(true);
    expect(
      canRequestCodexReviewChanges({ status: 'NEEDS_CHANGES' })
    ).toBe(true);
    expect(
      canRequestCodexReviewChanges({ status: 'INCONCLUSIVE' })
    ).toBe(true);
    expect(
      canRequestCodexReviewChanges({ status: 'CANCELED', result })
    ).toBe(false);
    expect(
      canRequestCodexReviewChanges({ status: 'STALE', result })
    ).toBe(false);
    expect(
      canRequestCodexReviewChanges({ status: 'FAILED' }, 'FAILED', true)
    ).toBe(true);
    expect(
      canRequestCodexReviewChanges({ status: 'FAILED' })
    ).toBe(false);
  });

  it('allows clean local completion only when review, tests, and Git evidence are healthy', () => {
    const state = getFinishEvidenceState(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'CLEAN',
          tests: 'PASSED',
          codexReview: { status: 'PASSED' }
        },
        workflowPhase: 'REVIEW'
      })
    );

    expect(state).toEqual({ mode: 'clean', warnings: [] });
  });

  it('uses Mark done anyway when tests are missing or stale despite a passing review', () => {
    const missingTests = getFinishEvidenceState(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'CLEAN',
          tests: 'NOT_RUN',
          codexReview: { status: 'PASSED' }
        },
        workflowPhase: 'REVIEW'
      })
    );
    const staleTests = getFinishEvidenceState(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'CLEAN',
          tests: 'STALE',
          codexReview: { status: 'PASSED' }
        },
        workflowPhase: 'REVIEW'
      })
    );

    expect(missingTests.mode).toBe('override');
    expect(missingTests.warnings.map((warning) => warning.title)).toContain(
      'No local test run is recorded.'
    );
    expect(staleTests.mode).toBe('override');
    expect(staleTests.warnings.map((warning) => warning.title)).toContain(
      'Local test evidence is stale.'
    );
  });

  it('uses Mark done anyway when Git is dirty even if review and tests passed', () => {
    const state = getFinishEvidenceState(
      createTask({
        projection: {
          ...createInitialProjection(now),
          git: 'DIRTY',
          tests: 'PASSED',
          codexReview: { status: 'PASSED' }
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
          tests: 'STALE',
          codexReview: { status: 'NEEDS_CHANGES' }
        },
        workflowPhase: 'REVIEW'
      }),
      'NEEDS_CHANGES',
      2
    );

    expect(requirements).toEqual([
      { label: 'Review', detail: 'needs changes', tone: 'error', unresolved: true },
      { label: 'Tests', detail: 'stale', tone: 'action', unresolved: true },
      { label: 'Tree', detail: '2 dirty', tone: 'action', unresolved: true }
    ]);
  });

  it('labels finish actions with Create draft PR as the main delivery path', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'DIRTY',
        tests: 'PASSED',
        codexReview: { status: 'PASSED' }
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
        id: 'create-draft-pr',
        label: 'Create draft PR',
        kind: 'primary',
        disabled: false,
        withIssues: undefined
      },
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

  it('keeps Create draft PR available when Mark done requires an override after a local commit', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'COMMITTED_UNPUSHED',
        tests: 'STALE',
        codexReview: { status: 'STALE', runId: 'review-run' }
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
            title: 'Local test evidence is stale.',
            detail: 'Rerun tests for the current Git state before marking done cleanly.'
          }
        ]
      }
    });

    expect(actions.map((action) => action.label)).toEqual([
      'Create draft PR',
      'Commit',
      'Mark done anyway'
    ]);
    expect(actions.find((action) => action.id === 'create-draft-pr')?.disabled).toBe(false);
    expect(actions.find((action) => action.id === 'commit')?.disabled).toBe(true);
  });

  it('disables local completion while review is running', () => {
    const task = createTask({
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'DIRTY',
        tests: 'PASSED',
        codexReview: { status: 'RUNNING', runId: 'review-run' }
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
    expect(markDoneModalCopy(true, false)).toMatchObject({
      title: 'Mark done anyway',
      body: 'Records the current local result as done. No commit or PR is created, and these checks stay unresolved:',
      confirmLabel: 'Mark done anyway'
    });
    expect(markDoneModalCopy(true, true).confirmLabel).toBe('Marking done...');
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    prompt: 'Prompt',
    repositoryPath: '/tmp/repo',
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
