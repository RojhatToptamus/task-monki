import { describe, expect, it } from 'vitest';
import type { DomainEvent, RunRecord } from '../../shared/contracts';
import { buildTaskHistory } from './taskHistory';

const baseAt = '2026-06-24T10:00:00.000Z';

describe('task history model', () => {
  it('keeps meaningful task activity and drops noisy provider telemetry', () => {
    const runs = [
      run({ id: 'run-1', mode: 'IMPLEMENTATION' }),
      run({ id: 'review-1', mode: 'REVIEW' }),
      run({ id: 'follow-up-1', mode: 'FOLLOW_UP' })
    ];
    const history = buildTaskHistory(
      [
        event('TASK_CREATED', { title: 'Polish task detail' }),
        event('AGENT_PLAN_REVISED', { revision: 2 }),
        event('AGENT_RUN_STARTED', { mode: 'IMPLEMENTATION' }, 'run-1'),
        event('AGENT_RUN_COMPLETED', { terminalStatus: 'completed' }, 'run-1'),
        event('AGENT_RUN_STARTED', { mode: 'REVIEW' }, 'review-1'),
        event(
          'AGENT_RUN_COMPLETED',
          { terminalStatus: 'completed', codexReviewStatus: 'NEEDS_CHANGES' },
          'review-1'
        ),
        event('AGENT_RUN_STARTED', { mode: 'FOLLOW_UP' }, 'follow-up-1'),
        event('CANCEL_REQUESTED', {}, 'follow-up-1'),
        event('GIT_SNAPSHOT_CAPTURED', { status: 'DIRTY', workingDiffFileCount: 4 })
      ],
      runs
    );

    expect(history.map((item) => item.title)).toEqual([
      'User request created',
      'Implementation started',
      'Implementation finished',
      'AI review started',
      'AI review finished',
      'Change request started',
      'Stop run requested',
      'Git evidence refreshed'
    ]);
    expect(history.find((item) => item.title === 'AI review finished')?.detail).toBe(
      'Needs Changes'
    );
  });
});

function event(
  type: DomainEvent['type'],
  payload: unknown,
  runId?: string
): DomainEvent {
  return {
    id: `${type}-${runId ?? 'task'}`,
    type,
    taskId: 'task-1',
    runId,
    source: 'ui',
    sourceEventId: `${type}-${runId ?? 'task'}`,
    occurredAt: baseAt,
    receivedAt: baseAt,
    payload
  };
}

function run(input: Pick<RunRecord, 'id' | 'mode'>): RunRecord {
  return {
    id: input.id,
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: input.mode,
    origin: 'TASK_MONKI',
    status: 'COMPLETED',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt',
    outputArtifactId: 'output',
    diagnosticArtifactId: 'diagnostic',
    startedAt: baseAt,
    eventCount: 0
  };
}
