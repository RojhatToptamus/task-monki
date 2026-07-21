import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/contracts';
import { createInitialProjection } from '../../shared/contracts';
import { describeTaskAttention } from './taskAttention';

describe('describeTaskAttention', () => {
  it('uses direct recovery copy for ambiguous runtime state', () => {
    const attention = describeTaskAttention(
      taskFixture({
        projection: {
          ...createInitialProjection('2026-01-01T00:00:00.000Z'),
          agentRun: 'RECOVERY_REQUIRED'
        }
      })
    );

    expect(attention).toMatchObject({
      label: 'Recovery required',
      detail: 'Runtime state is ambiguous; inspect recovery details.'
    });
  });

  it('directs failed implementation work to retry instead of review', () => {
    const attention = describeTaskAttention(
      taskFixture({
        workflowPhase: 'IN_PROGRESS',
        projection: {
          ...createInitialProjection('2026-01-01T00:00:00.000Z'),
          agentRun: 'FAILED'
        }
      })
    );

    expect(attention).toMatchObject({
      label: 'Run failed',
      detail: 'Retry or continue the implementation before review.'
    });
  });

  it('surfaces a blocked completed implementation as needing retry', () => {
    const attention = describeTaskAttention(
      taskFixture({
        currentRunId: 'run-1',
        workflowPhase: 'IN_PROGRESS',
        projection: {
          ...createInitialProjection('2026-01-01T00:00:00.000Z'),
          requestedAction: 'FAILED',
          agentRun: 'COMPLETED',
          summary: 'A later Git refresh completed.',
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

  it('labels failing GitHub checks as delivery attention', () => {
    const attention = describeTaskAttention(
      taskFixture({
        projection: {
          ...createInitialProjection('2026-01-01T00:00:00.000Z'),
          ciChecks: 'FAILING'
        }
      })
    );

    expect(attention).toMatchObject({
      label: 'Checks failed',
      detail: 'GitHub checks need attention.'
    });
  });

  it('uses completion language for a merged task that still requires manual acceptance', () => {
    const attention = describeTaskAttention(
      taskFixture({
        completionPolicy: 'MANUAL',
        workflowPhase: 'IN_REVIEW',
        projection: {
          ...createInitialProjection('2026-01-01T00:00:00.000Z'),
          githubPullRequest: 'MERGED',
          merge: 'MERGED',
          summary: 'GitHub reports the pull request merged.'
        }
      })
    );

    expect(attention).toEqual({
      label: 'Waiting for Mark done',
      detail: 'The pull request is merged; this task requires manual completion.',
      tone: 'info'
    });
  });

  it('does not expose raw merge enums in generic delivery attention', () => {
    const attention = describeTaskAttention(
      taskFixture({
        projection: {
          ...createInitialProjection('2026-01-01T00:00:00.000Z'),
          githubPullRequest: 'OPEN_READY',
          merge: 'NOT_MERGED',
          health: 'ERROR',
          summary: 'GitHub merge state: NOT_MERGED.'
        }
      })
    );

    expect(attention).toEqual({
      label: 'Delivery needs attention',
      detail: 'Open the task to review the current GitHub evidence.',
      tone: 'error'
    });
    expect(`${attention?.label} ${attention?.detail}`).not.toContain('NOT_MERGED');
  });
});

function taskFixture(overrides: Partial<Task> = {}): Task {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'task-1',
    runtimeId: 'codex',
    title: 'Task',
    prompt: 'Do the work.',
    repositoryId: '/tmp/repo',
    workflowPhase: 'REVIEW',
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
