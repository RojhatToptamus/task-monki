import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { Task } from '../../shared/contracts';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  canRequestCodexReviewChanges,
  columnTasks,
  computeNavCounts
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

    expect(vm.stateLabel).toBe('Needs review');
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

    expect(vm.stateLabel).toBe('AI reviewing');
    expect(computeNavCounts([task]).review).toBe(1);
    expect(columnTasks([task], reviewColumn)).toHaveLength(1);
    expect(columnTasks([task], progressColumn)).toHaveLength(0);
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
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    projection: createInitialProjection(now),
    ...overrides
  };
}
