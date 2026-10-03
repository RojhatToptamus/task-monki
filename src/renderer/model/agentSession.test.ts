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
});
