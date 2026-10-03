import { describe, expect, it } from 'vitest';
import { makeAgentItemRecord, makeRunRecord } from '../../testSupport/rendererRecords';
import { sessionEntries } from './agentSession';

describe('agent session history', () => {
  it('shows normalized agent messages once without exposing generated user-prompt echoes', () => {
    const run = makeRunRecord({ status: 'COMPLETED', finalMessage: 'Work complete.' });
    const entries = sessionEntries(run, [
      makeAgentItemRecord({ type: 'USER_MESSAGE', payload: { text: 'Generated execution wrapper' } }),
      makeAgentItemRecord({ id: 'answer', type: 'AGENT_MESSAGE', status: 'IN_PROGRESS', payload: { text: 'Work complete.' } })
    ], []);
    expect(entries).toEqual([expect.objectContaining({ kind: 'message', author: 'Agent', text: 'Work complete.', status: undefined })]);
    expect(sessionEntries(run, [], [])).toEqual([expect.objectContaining({ kind: 'message', text: 'Work complete.' })]);
  });

  it('stops live activity after interruption while retaining the provider record unchanged', () => {
    const run = makeRunRecord({ status: 'INTERRUPTED' });
    const item = makeAgentItemRecord({ type: 'COMMAND_EXECUTION', status: 'IN_PROGRESS', payload: { command: 'npm test' } });
    const entries = sessionEntries(run, [item], []);
    expect(entries.flatMap((entry) => entry.kind === 'activity' ? entry.rows : [])).toEqual([
      expect.objectContaining({ status: 'failed', tone: 'neutral', label: 'Stopped' })
    ]);
    expect(item.status).toBe('IN_PROGRESS');
  });
  it('does not claim file changes for a named tool without changed-file evidence', () => {
    const entries = sessionEntries(makeRunRecord({ status: 'COMPLETED' }), [
      makeAgentItemRecord({ type: 'FILE_CHANGE', status: 'COMPLETED', payload: { tool: 'todowrite', state: { input: { todos: [] } } } })
    ], []);
    expect(entries).toEqual([expect.objectContaining({ kind: 'activity', rows: [expect.objectContaining({ kind: 'tool', label: 'Tool', detail: 'todowrite' })] })]);
  });

  it('keeps tool starts between their surrounding messages when completion arrives later', () => {
    const run = makeRunRecord({ status: 'COMPLETED' });
    const entries = sessionEntries(run, [
      makeAgentItemRecord({ id: 'before', type: 'AGENT_MESSAGE', createdAt: '2026-07-19T12:01:00Z', payload: { text: 'I will check the files.' } }),
      makeAgentItemRecord({ id: 'tool', type: 'COMMAND_EXECUTION', status: 'COMPLETED', createdAt: '2026-07-19T12:02:00Z', providerCompletedAt: '2026-07-19T12:04:00Z', payload: { command: '/bin/zsh -c "npm test"', durationMs: 0 } }),
      makeAgentItemRecord({ id: 'after', type: 'AGENT_MESSAGE', createdAt: '2026-07-19T12:03:00Z', payload: { text: 'The check is finishing.' } }),
      makeAgentItemRecord({ id: 'file', type: 'FILE_CHANGE', status: 'COMPLETED', createdAt: '2026-07-19T12:05:00Z', payload: { changes: [{ path: '/tmp/worktree/src/hello.py', kind: 'add' }] } })
    ], [], '/tmp/worktree');
    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'activity', 'message', 'activity']);
    expect(entries[1]).toMatchObject({ rows: [expect.objectContaining({ detail: 'npm test', metric: undefined })] });
    expect(entries[3]).toMatchObject({ rows: [expect.objectContaining({ detail: 'src/hello.py' })] });
  });

});
