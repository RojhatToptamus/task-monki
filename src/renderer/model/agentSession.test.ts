import { describe, expect, it } from 'vitest';
import type { TaskInstruction } from '../../shared/contracts';
import { makeAgentItemRecord, makeRunRecord } from '../../testSupport/rendererRecords';
import { conversationPreview, earlierHistory, sessionEntries, sessionTurn, stepsSummary, type SessionEntry, type SessionTurn } from './agentSession';

describe('agent session history', () => {
  it('shows normalized agent messages once without exposing generated user-prompt echoes', () => {
    const run = makeRunRecord({ status: 'COMPLETED', finalMessage: 'Work complete.' });
    const entries = sessionEntries(run, [
      makeAgentItemRecord({ type: 'USER_MESSAGE', payload: { text: 'Generated execution wrapper' } }),
      makeAgentItemRecord({ id: 'answer', type: 'AGENT_MESSAGE', status: 'IN_PROGRESS', payload: { text: 'Work complete.' } })
    ], []);
    expect(entries).toEqual([expect.objectContaining({ kind: 'message', author: 'Agent', text: 'Work complete.' })]);
    expect(entries[0]).not.toHaveProperty('status');
    expect(sessionEntries(run, [], [])).toEqual([expect.objectContaining({ kind: 'message', text: 'Work complete.' })]);
    expect(conversationPreview(sessionTurn(run, [
      makeAgentItemRecord({ type: 'USER_MESSAGE', payload: { text: 'Generated execution wrapper' } }),
      makeAgentItemRecord({ id: 'answer', type: 'AGENT_MESSAGE', payload: { text: 'Work complete.' } })
    ], []))).toBe('Work complete.');
  });

  it('stops live activity after interruption while retaining the provider record unchanged', () => {
    const run = makeRunRecord({ status: 'INTERRUPTED' });
    const item = makeAgentItemRecord({ type: 'COMMAND_EXECUTION', status: 'IN_PROGRESS', payload: { command: 'npm test' } });
    expect(toolRows(sessionEntries(run, [item], []))).toEqual([
      expect.objectContaining({ status: 'failed', tone: 'neutral', label: 'Stopped' })
    ]);
    expect(item.status).toBe('IN_PROGRESS');
  });

  it('does not claim file changes for a stored named tool without changed-file evidence', () => {
    const entries = sessionEntries(makeRunRecord({ status: 'COMPLETED' }), [
      makeAgentItemRecord({ type: 'FILE_CHANGE', status: 'COMPLETED', payload: { tool: 'todowrite', state: { input: { todos: [] } } } })
    ], []);
    expect(toolRows(entries)).toEqual([expect.objectContaining({ kind: 'tool', label: 'Tool', detail: 'todowrite' })]);
    expect(stepsSummary(entries[0]!.kind === 'steps' ? entries[0]!.steps : [])).toBe('Used 1 tool');
  });

  it('keeps tool starts between their surrounding messages when completion arrives later', () => {
    const run = makeRunRecord({ status: 'COMPLETED' });
    const entries = sessionEntries(run, [
      makeAgentItemRecord({ id: 'before', type: 'AGENT_MESSAGE', createdAt: '2026-07-19T12:01:00Z', payload: { text: 'I will check the files.' } }),
      makeAgentItemRecord({ id: 'tool', type: 'COMMAND_EXECUTION', status: 'COMPLETED', createdAt: '2026-07-19T12:02:00Z', providerCompletedAt: '2026-07-19T12:04:00Z', payload: { command: '/bin/zsh -c "npm test"', durationMs: 0 } }),
      makeAgentItemRecord({ id: 'after', type: 'AGENT_MESSAGE', createdAt: '2026-07-19T12:03:00Z', payload: { text: 'The check is finishing.' } }),
      makeAgentItemRecord({ id: 'file', type: 'FILE_CHANGE', status: 'COMPLETED', createdAt: '2026-07-19T12:05:00Z', payload: { changes: [{ path: '/tmp/worktree/src/hello.py', kind: 'add' }] } })
    ], [], '/tmp/worktree');
    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'steps', 'message', 'steps']);
    expect(toolRows([entries[1]!])).toEqual([expect.objectContaining({ detail: 'npm test', metric: undefined })]);
    expect(toolRows([entries[3]!])).toEqual([expect.objectContaining({ detail: 'src/hello.py' })]);
  });

  it('opens each turn with what the user actually sent and steers in arrival order', () => {
    const first = makeRunRecord({ id: 'first', status: 'COMPLETED', startedAt: '2026-07-19T12:00:00Z', endedAt: '2026-07-19T12:02:30Z' });
    const items = [
      makeAgentItemRecord({ id: 'plan-note', runId: 'first', createdAt: '2026-07-19T12:00:10Z', payload: { text: 'Looking at the parser.' } }),
      makeAgentItemRecord({ id: 'read', runId: 'first', type: 'COMMAND_EXECUTION', createdAt: '2026-07-19T12:00:20Z', payload: { command: 'cat README.md', commandActions: [{ type: 'read', name: 'README.md', path: 'README.md' }] } }),
      makeAgentItemRecord({ id: 'done', runId: 'first', createdAt: '2026-07-19T12:02:00Z', payload: { text: 'The parser now accepts tabs.' } })
    ];
    const steer = instruction({ id: 'steer', mode: 'STEER', runId: 'first', status: 'SUBMITTED', text: 'Also keep spaces.', createdAt: '2026-07-19T12:00:15Z' });
    const turn = sessionTurn(first, items, [steer], { prompt: 'Fix the parser.' });
    expect(turn.opener).toMatchObject({ kind: 'prompt', text: 'Fix the parser.' });
    expect(turn.entries.map((entry) => entry.kind === 'message' ? `${entry.author}: ${entry.text}` : entry.kind)).toEqual([
      'Agent: Looking at the parser.', 'You: Also keep spaces.', 'steps', 'Agent: The parser now accepts tabs.'
    ]);
    expect(turn).toMatchObject({ state: 'completed', durationMs: 150_000, answer: 'The parser now accepts tabs.' });

    const retry = makeRunRecord({ id: 'retry', mode: 'RETRY', status: 'FAILED', startedAt: '2026-07-19T12:05:00Z', finalMessage: 'Partial notes.' });
    const retried = sessionTurn(retry, [], []);
    expect(retried.opener).toMatchObject({ kind: 'marker', label: 'Retried' });
    expect(retried.answer).toBeUndefined();
    const followUp = makeRunRecord({ id: 'follow-up', mode: 'FOLLOW_UP', status: 'RUNNING', startedAt: '2026-07-19T12:06:00Z' });
    expect(sessionTurn(followUp, [], [instruction({ id: 'ask', runId: 'follow-up', mode: 'FOLLOW_UP', text: 'Add a test.' })]).opener)
      .toMatchObject({ kind: 'prompt', text: 'Add a test.' });
  });

  it('loads earlier history by page without leaving a turn outcome detached from its turn', () => {
    const turns = [turnWith('a', 30), turnWith('b', 50), turnWith('c', 100)];
    const latest = earlierHistory(turns, { first: turns.length, clip: 0 });
    expect(latest).toEqual({ first: 2, clip: 22 });
    // One page finishes the clipped turn, takes the whole turn before it, then starts the next.
    const page = earlierHistory(turns, latest);
    expect(page).toEqual({ first: 0, clip: 26 });
    expect(earlierHistory(turns, page)).toEqual({ first: 0, clip: 0 });
    // A page boundary that would show only an outcome keeps the turn's last entry with it.
    expect(earlierHistory([turnWith('x', 10), turnWith('y', 77)], { first: 2, clip: 0 })).toEqual({ first: 0, clip: 9 });
  });
});

function toolRows(entries: SessionEntry[]) {
  return entries.flatMap((entry) => entry.kind === 'steps' ? entry.steps.flatMap((step) => step.kind === 'tool' ? [step.row] : []) : []);
}

function turnWith(key: string, count: number): SessionTurn {
  const run = makeRunRecord({ id: key, status: 'COMPLETED' });
  return { key, run, state: 'completed', entries: Array.from({ length: count }, (_, index) => ({
    key: `${key}-${index}`, at: run.startedAt, kind: 'message' as const, author: 'Agent' as const, text: `${index}`
  })) };
}

function instruction(overrides: Partial<TaskInstruction>): TaskInstruction {
  return {
    id: 'instruction-1', taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1', sourceRunId: 'run-1',
    sessionId: 'session-1', order: 1, text: 'Next step.', mode: 'QUEUE', status: 'SUBMITTED',
    createdAt: '2026-07-19T12:00:00Z', updatedAt: '2026-07-19T12:00:00Z', ...overrides
  };
}
