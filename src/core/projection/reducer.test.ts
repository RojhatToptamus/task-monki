import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { DomainEvent, RunRecord, Task } from '../../shared/contracts';
import { applyEventToState, reduceProjection, reduceRun } from './reducer';

const now = '2026-06-20T10:00:00.000Z';

describe('projection reducer', () => {
  it('separates Codex completion from process exit', () => {
    const projection = createInitialProjection(now);
    const run = createRun();
    const event = createEvent('CODEX_RUN_COMPLETED', {
      terminalStatus: 'completed',
      finalArtifactId: 'artifact-1'
    });

    const next = reduceProjection(projection, event, run);

    expect(next.codexRun).toBe('COMPLETED');
    expect(next.artifact).toBe('FINAL_MESSAGE_PRESENT');
    expect(next.osProcess).toBe('UNKNOWN');
    expect(next.summary).toContain('Review the final artifact');
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
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };
    const state = applyEventToState(
      {
        tasks: [task],
        iterations: [],
        worktrees: [],
        gitSnapshots: [],
        testRuns: [],
        githubRepositories: [],
        branchPublications: [],
        pullRequests: [],
        ciRollups: [],
        reviewRollups: [],
        mergeSnapshots: [],
        runs: [],
        events: [],
        artifacts: []
      },
      {
        ...createEvent('CODEX_RUN_COMPLETED', {
          terminalStatus: 'completed',
          finalArtifactId: 'artifact-old'
        }),
        iterationId: 'iteration-old'
      }
    );

    expect(state.tasks[0].projection.codexRun).toBe('UNKNOWN');
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
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };

    const state = applyEventToState(
      {
        tasks: [task],
        iterations: [],
        worktrees: [],
        gitSnapshots: [],
        testRuns: [],
        githubRepositories: [],
        branchPublications: [],
        pullRequests: [],
        ciRollups: [],
        reviewRollups: [],
        mergeSnapshots: [],
        runs: [],
        events: [],
        artifacts: []
      },
      {
        ...createEvent('TEST_RUN_STARTED', { command: 'npm test' }),
        iterationId: 'iteration-1'
      }
    );

    expect(state.tasks[0].workflowPhase).toBe('REVIEW');
    expect(state.tasks[0].projection.tests).toBe('QUEUED');
  });
});

describe('run reducer', () => {
  it('updates run event counts and terminal Codex state', () => {
    const run = createRun();
    const next = reduceRun(
      run,
      createEvent('CODEX_EVENT_PARSED', {
        eventType: 'turn.completed',
        terminalStatus: 'completed',
        messageText: 'done'
      })
    );

    expect(next.eventCount).toBe(1);
    expect(next.status).toBe('COMPLETED');
    expect(next.finalMessage).toBe('done');
  });
});

function createRun(): RunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    mode: 'READ_ONLY_ANALYSIS',
    status: 'RUNNING',
    processStatus: 'RUNNING',
    executable: 'codex',
    argv: [],
    cwd: '/tmp/repo',
    startedAt: now,
    stdoutArtifactId: 'stdout',
    stderrArtifactId: 'stderr',
    jsonlArtifactId: 'jsonl',
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
