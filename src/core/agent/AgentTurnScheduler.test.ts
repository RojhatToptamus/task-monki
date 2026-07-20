import { describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_STORE_SCHEMA_VERSION,
  type AgentOwnerScope,
  type AgentRunScope,
  type AgentRuntimeRunRecord,
  type AgentRuntimeStoreState,
  type AgentSchedulerPriority,
  type AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';
import { selectNextAgentTurn } from './AgentTurnScheduler';

const now = '2026-07-13T00:10:00.000Z';

describe('selectNextAgentTurn', () => {
  it('prioritizes foreground tasks but promotes old discourse work to prevent starvation', () => {
    const recentTask = queued('task', taskOwner('task-1'), taskScope('task-1'), 'TASK_FOREGROUND', 2, 0);
    const oldDiscourse = queued(
      'discourse',
      discourseOwner('conversation-1', 'participant-1'),
      discourseScope('conversation-1', 'wave-1', 'job-1'),
      'DISCOURSE_BACKGROUND',
      1,
      180_000
    );
    expect(selectNextAgentTurn(state([oldDiscourse, recentTask]), now)?.id).toBe('discourse');
  });

  it('round-robins owners at the same effective priority', () => {
    const ownerA = discourseOwner('conversation-a', 'participant-a');
    const ownerB = discourseOwner('conversation-b', 'participant-b');
    const previouslyLeased = {
      ...queued(
        'a-old',
        ownerA,
        discourseScope('conversation-a', 'wave-old', 'job-old'),
        'DISCOURSE_RESPONSE',
        1,
        60_000
      ),
      status: 'SETTLED' as const,
      leasedAt: '2026-07-13T00:09:30.000Z',
      settledAt: '2026-07-13T00:09:40.000Z'
    };
    const nextA = queued(
      'a-next',
      ownerA,
      discourseScope('conversation-a', 'wave-2', 'job-2'),
      'DISCOURSE_RESPONSE',
      2,
      30_000
    );
    const nextB = queued(
      'b-next',
      ownerB,
      discourseScope('conversation-b', 'wave-1', 'job-1'),
      'DISCOURSE_RESPONSE',
      3,
      30_000
    );
    expect(selectNextAgentTurn(state([previouslyLeased, nextA, nextB]), now)?.id).toBe('b-next');
  });

  it('allows same-wave peers but blocks a second active wave and a leased session', () => {
    const owner = discourseOwner('conversation-1', 'participant-1');
    const active = {
      ...queued(
        'active',
        owner,
        discourseScope('conversation-1', 'wave-1', 'job-1'),
        'DISCOURSE_RESPONSE',
        1,
        0,
        'session-active'
      ),
      status: 'LEASED' as const,
      leasedAt: '2026-07-13T00:09:59.000Z'
    };
    const sameSession = queued(
      'same-session',
      owner,
      discourseScope('conversation-1', 'wave-1', 'job-2'),
      'DISCOURSE_RESPONSE',
      2,
      0,
      'session-active'
    );
    const secondWave = queued(
      'second-wave',
      owner,
      discourseScope('conversation-1', 'wave-2', 'job-3'),
      'DISCOURSE_RESPONSE',
      3,
      0,
      'session-wave-2'
    );
    const peer = queued(
      'peer',
      discourseOwner('conversation-1', 'participant-2'),
      discourseScope('conversation-1', 'wave-1', 'job-4'),
      'DISCOURSE_RESPONSE',
      4,
      0,
      'session-peer'
    );
    expect(selectNextAgentTurn(state([active, sameSession, secondWave, peer]), now)?.id).toBe('peer');
  });

  it('holds global capacity until leases are explicitly settled and respects not-before', () => {
    const entries = [1, 2].map((ordinal) => ({
      ...queued(
        `active-${ordinal}`,
        taskOwner(`task-${ordinal}`),
        taskScope(`task-${ordinal}`),
        'TASK_FOREGROUND',
        ordinal,
        0,
        `session-${ordinal}`
      ),
      status: 'LEASED' as const,
      leasedAt: '2026-07-13T00:09:00.000Z'
    }));
    const waiting = queued(
      'waiting',
      taskOwner('task-3'),
      taskScope('task-3'),
      'TASK_FOREGROUND',
      3,
      0,
      'session-3'
    );
    expect(selectNextAgentTurn(state([...entries, waiting]), now)).toBeUndefined();
    const future = { ...waiting, notBefore: '2026-07-13T00:11:00.000Z' };
    expect(selectNextAgentTurn(state([future]), now)).toBeUndefined();
  });

  it('does not lease after the durable shutdown latch', () => {
    const snapshot = state([
      queued('task', taskOwner('task-1'), taskScope('task-1'), 'TASK_FOREGROUND', 1, 0)
    ]);
    snapshot.shutdownLatched = true;
    expect(selectNextAgentTurn(snapshot, now)).toBeUndefined();
  });
});

function state(entries: AgentSchedulerQueueEntry[]): AgentRuntimeStoreState {
  const runs = entries.map((entry) => runtimeRun(entry));
  return {
    schemaVersion: AGENT_RUNTIME_STORE_SCHEMA_VERSION,
    revision: 1,
    nextEventOrdinal: 1,
    nextQueueOrdinal: Math.max(0, ...entries.map((entry) => entry.enqueueOrdinal)) + 1,
    shutdownLatched: false,
    servers: [],
    sessions: [],
    runs,
    queueEntries: entries,
    artifacts: [],
    telemetryRecords: [],
    events: [],
    migrations: []
  };
}

function runtimeRun(entry: AgentSchedulerQueueEntry): AgentRuntimeRunRecord {
  return {
    id: entry.runId,
    owner: entry.owner,
    scope: entry.scope,
    sessionId: entry.sessionId,
    sessionAccessEpoch: 1,
    purpose: entry.scope.kind === 'TASK' ? 'TASK_IMPLEMENTATION' : 'DISCOURSE_ANSWER',
    generationKey: `${entry.id}-generation`,
    clientOperationId: `${entry.id}-operation`,
    requestFingerprint: 'a'.repeat(64),
    status: 'QUEUED',
    delivery: 'NOT_SENT',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: `${entry.id}-prompt`,
    outputArtifactId: `${entry.id}-output`,
    diagnosticArtifactId: `${entry.id}-diagnostics`,
    recordRevision: 1,
    createdAt: entry.enqueuedAt
  };
}

function queued(
  id: string,
  owner: AgentOwnerScope,
  scope: AgentRunScope,
  priority: AgentSchedulerPriority,
  enqueueOrdinal: number,
  ageMs: number,
  sessionId = `${id}-session`
): AgentSchedulerQueueEntry {
  return {
    id,
    runId: `${id}-run`,
    clientOperationId: `${id}-enqueue`,
    requestFingerprint: 'b'.repeat(64),
    owner,
    scope,
    sessionId,
    priority,
    status: 'QUEUED',
    enqueueOrdinal,
    recordRevision: 1,
    enqueuedAt: new Date(Date.parse(now) - ageMs).toISOString()
  };
}

function taskOwner(taskId: string): AgentOwnerScope {
  return { kind: 'TASK', taskId };
}

function discourseOwner(conversationId: string, stableParticipantId: string): AgentOwnerScope {
  return { kind: 'DISCOURSE', conversationId, stableParticipantId };
}

function taskScope(taskId: string): AgentRunScope {
  return {
    kind: 'TASK',
    taskId,
    iterationId: `${taskId}-iteration`,
    worktreeId: `${taskId}-worktree`
  };
}

function discourseScope(
  conversationId: string,
  waveId: string,
  jobId: string
): AgentRunScope {
  return {
    kind: 'DISCOURSE',
    conversationId,
    waveId,
    jobId,
    contextSnapshotId: `${waveId}-context`,
    attemptId: `${jobId}-attempt`
  };
}
