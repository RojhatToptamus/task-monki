import { describe, expect, it } from 'vitest';
import { createInitialProjection, type Task } from '../../shared/contracts';
import { describeTaskLifecycle } from './taskLifecycle';
import { describeTaskStatus } from './taskView';

const now = '2026-10-09T10:00:00.000Z';

describe('task lifecycle', () => {
  it('walks the board lanes in fixed words and carries the board card status at the task position', () => {
    const cases: Array<{ task: Task; states: string[]; status: string }> = [
      { task: createTask({ workflowPhase: 'READY' }), states: ['current', 'upcoming', 'upcoming', 'upcoming'], status: 'Ready' },
      {
        task: createTask({
          workflowPhase: 'IN_PROGRESS',
          projection: { ...createInitialProjection(now), agentRun: 'AWAITING_APPROVAL' }
        }),
        states: ['done', 'current', 'upcoming', 'upcoming'],
        status: 'Needs approval'
      },
      { task: createTask({ workflowPhase: 'IN_REVIEW' }), states: ['done', 'done', 'current', 'upcoming'], status: 'In review' },
      { task: createTask({ workflowPhase: 'DONE' }), states: ['done', 'done', 'done', 'current'], status: 'Done' }
    ];
    for (const { task, states, status } of cases) {
      const steps = describeTaskLifecycle(task);
      expect(steps.map((step) => step.label)).toEqual(['Ready', 'In progress', 'Review', 'Done']);
      expect(steps.map((step) => step.state)).toEqual(states);
      const position = steps.find((step) => step.state === 'current');
      expect(position?.status).toEqual(describeTaskStatus(task));
      expect(position?.status?.label).toBe(status);
      expect(steps.filter((step) => step.status)).toHaveLength(1);
    }
  });

  it('names a phase that shares a lane by its own word, and marks only real work as in flight', () => {
    const labelAt = (task: Task) => describeTaskLifecycle(task).find((step) => step.state === 'current');
    // A canceled task never reads as Done; a backlog item never reads as Ready.
    expect(labelAt(createTask({ workflowPhase: 'CANCELED' }))?.label).toBe('Canceled');
    expect(labelAt(createTask({ workflowPhase: 'BACKLOG' }))?.label).toBe('Backlog');
    // An open In progress task with nothing running is not work in flight.
    expect(labelAt(createTask({ workflowPhase: 'IN_PROGRESS' }))?.inFlight).toBe(false);
    expect(labelAt(createTask({
      workflowPhase: 'IN_PROGRESS',
      projection: { ...createInitialProjection(now), agentRun: 'RUNNING' }
    }))?.inFlight).toBe(true);
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'NORMAL',
    runtimeId: 'codex',
    title: 'Task',
    prompt: 'Prompt',
    repositoryId: 'repo-1',
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
