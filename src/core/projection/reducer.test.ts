import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { DomainEvent, RunRecord, Task } from '../../shared/contracts';
import { applyEventToState, createEmptyState, reduceProjection, reduceRun } from './reducer';

const now = '2026-06-20T10:00:00.000Z';

describe('projection reducer', () => {
  it('separates agent completion from process exit', () => {
    const projection = createInitialProjection(now);
    const run = createRun();
    const event = createEvent('AGENT_RUN_COMPLETED', {
      terminalStatus: 'completed',
      finalArtifactId: 'artifact-1'
    });

    const next = reduceProjection(projection, event, run);

    expect(next.agentRun).toBe('COMPLETED');
    expect(next.artifact).toBe('FINAL_MESSAGE_PRESENT');
    expect(next.osProcess).toBe('UNKNOWN');
    expect(next.summary).toContain('independent Git evidence');
  });

  it('records non-zero process exits as errors', () => {
    const projection = createInitialProjection(now);
    const next = reduceProjection(projection, createEvent('PROCESS_EXITED', { exitCode: 2 }));

    expect(next.osProcess).toBe('EXITED');
    expect(next.health).toBe('ERROR');
    expect(next.findings.some((finding) => finding.code === 'PROCESS_NON_ZERO_EXIT')).toBe(true);
  });

  it('marks cancellation as waiting until a signal or terminal event arrives', () => {
    const projection = createInitialProjection(now);
    const next = reduceProjection(projection, createEvent('CANCEL_REQUESTED', {}));

    expect(next.requestedAction).toBe('CANCEL_REQUESTED');
    expect(next.osProcess).toBe('CANCELING');
    expect(next.summary).toContain('waiting');
  });

  it('does not let an old iteration event overwrite the current task projection', () => {
    const task: Task = {
      id: 'task-1',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'IN_PROGRESS',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      currentIterationId: 'iteration-new',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };
    const state = applyEventToState(
      { ...createEmptyState(), tasks: [task] },
      {
        ...createEvent('AGENT_RUN_COMPLETED', {
          terminalStatus: 'completed',
          finalArtifactId: 'artifact-old'
        }),
        iterationId: 'iteration-old'
      }
    );

    expect(state.tasks[0].projection.agentRun).toBe('IDLE');
    expect(state.tasks[0].workflowPhase).toBe('IN_PROGRESS');
  });

  it('keeps test execution as evidence without moving workflow phase', () => {
    const task: Task = {
      id: 'task-1',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'REVIEW',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      currentIterationId: 'iteration-1',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };

    const state = applyEventToState(
      { ...createEmptyState(), tasks: [task] },
      {
        ...createEvent('TEST_RUN_STARTED', { command: 'npm test' }),
        iterationId: 'iteration-1'
      }
    );

    expect(state.tasks[0].workflowPhase).toBe('REVIEW');
    expect(state.tasks[0].projection.tests).toBe('QUEUED');
  });

  it('keeps provider plans, usage, and goals separate from workflow and verified tests', () => {
    const task: Task = {
      id: 'task-1',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'IN_PROGRESS',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      currentIterationId: 'iteration-1',
      currentRunId: 'run-1',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };
    const initial = {
      ...createEmptyState(),
      tasks: [task],
      runs: [createRun()]
    };
    const withPlan = applyEventToState(initial, {
      ...createEvent('AGENT_PLAN_REVISED', { revision: 1, stepCount: 1 }),
      iterationId: 'iteration-1'
    });
    const withUsage = applyEventToState(withPlan, {
      ...createEvent('AGENT_USAGE_UPDATED', { totalTokens: 100 }),
      iterationId: 'iteration-1'
    });
    const withDivergence = applyEventToState(withUsage, {
      ...createEvent('AGENT_GOAL_UPDATED', { syncState: 'DIVERGED' }),
      iterationId: 'iteration-1'
    });

    expect(withDivergence.tasks[0].workflowPhase).toBe('IN_PROGRESS');
    expect(withDivergence.tasks[0].projection.tests).toBe('NOT_RUN');
    expect(withDivergence.tasks[0].projection.health).toBe('WARNING');
  });
});

describe('run reducer', () => {
  it('updates run event counts and terminal agent state', () => {
    const run = createRun();
    const next = reduceRun(
      run,
      createEvent('AGENT_ACTIVITY_RECEIVED', {
        eventType: 'turn.completed',
        terminalStatus: 'completed',
        messageText: 'done'
      })
    );

    expect(next.eventCount).toBe(1);
    expect(next.status).toBe('COMPLETED');
    expect(next.finalMessage).toBe('done');
  });

  it('waits for authoritative progress after an interaction resolves', () => {
    const waiting = { ...createRun(), status: 'AWAITING_APPROVAL' as const };
    const resolved = reduceRun(
      waiting,
      createEvent('AGENT_INTERACTION_RESOLVED', { status: 'RESOLVED' })
    );
    const resumed = reduceRun(
      resolved,
      createEvent('AGENT_ACTIVITY_RECEIVED', { eventType: 'item/started' })
    );
    const unrelated = reduceRun(
      resolved,
      createEvent('AGENT_ACTIVITY_RECEIVED', { eventType: 'thread/name/updated' })
    );

    expect(resolved.status).toBe('AWAITING_APPROVAL');
    expect(resumed.status).toBe('RUNNING');
    expect(unrelated.status).toBe('AWAITING_APPROVAL');
  });
});

function createRun(): RunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'ANALYSIS',
    origin: 'TASK_MONKI',
    status: 'RUNNING',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt',
    outputArtifactId: 'output',
    diagnosticArtifactId: 'diagnostic',
    startedAt: now,
    eventCount: 0
  };
}

function createEvent(type: DomainEvent['type'], payload: unknown): DomainEvent {
  return {
    id: `event-${type}`,
    type,
    taskId: 'task-1',
    runId: 'run-1',
    source: 'process',
    sourceEventId: `source-${type}`,
    occurredAt: now,
    receivedAt: now,
    payload
  };
}
