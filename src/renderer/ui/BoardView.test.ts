import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/contracts';
import { createInitialProjection } from '../../shared/contracts';
import { describeTaskAttention } from './BoardView';

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
      label: 'Delivery blocked',
      detail: 'Remote checks are failing.'
    });
  });
});

function taskFixture(overrides: Partial<Task> = {}): Task {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'task-1',
    title: 'Task',
    prompt: 'Do the work.',
    repositoryPath: '/tmp/repo',
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
