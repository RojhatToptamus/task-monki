import { expect, it } from 'vitest';
import type { AgentConversationRecords } from './agentRecords';
import { partitionAgentRecords } from './agentRecords';

it('keeps Preview runs, records and messages out of the task conversation', () => {
  const records = {
    runs: [
      { id: 'impl', mode: 'IMPLEMENTATION', sessionId: 's1' }, { id: 'prev', mode: 'PREVIEW', sessionId: 's2' },
      { id: 'review', mode: 'REVIEW', sessionId: 's3' }
    ],
    items: [{ id: 'i1', runId: 'impl' }, { id: 'i2', runId: 'prev' }],
    instructions: [
      { id: 'm1', runId: 'impl' }, { id: 'm2', runId: 'prev', role: 'PREVIEW' }, { id: 'm3', role: 'PREVIEW', status: 'QUEUED' }
    ],
    interactions: [{ id: 'q1', runId: 'prev' }, { id: 'q2', runId: 'impl' }],
    sessions: [{ id: 's1', role: 'PRIMARY' }, { id: 's2', role: 'PREVIEW' }, { id: 's3', role: 'REVIEW' }],
    plans: [{ id: 'p1', runId: 'prev' }]
  } as unknown as AgentConversationRecords;
  const { task, preview } = partitionAgentRecords(records);
  // The review run stays with the task.
  expect(task.runs.map((run) => run.id)).toEqual(['impl', 'review']);
  expect(task.items.map((item) => item.id)).toEqual(['i1']);
  expect(task.instructions.map((item) => item.id)).toEqual(['m1']);
  expect(task.interactions.map((item) => item.id)).toEqual(['q2']);
  expect(task.sessions.map((item) => item.id)).toEqual(['s1', 's3']);
  expect(task.plans).toEqual([]);
  expect(preview.runs.map((run) => run.id)).toEqual(['prev']);
  expect(preview.items.map((item) => item.id)).toEqual(['i2']);
  expect(preview.instructions.map((item) => item.id)).toEqual(['m2', 'm3']);
  expect(preview.interactions.map((item) => item.id)).toEqual(['q1']);
  expect(preview.sessions.map((item) => item.id)).toEqual(['s2']);
  expect(preview.plans.map((item) => item.id)).toEqual(['p1']);
});

it('gives side questions their own conversation, even while the implementation run is active', () => {
  const records = {
    runs: [
      { id: 'impl', mode: 'IMPLEMENTATION', status: 'RUNNING', sessionId: 's1' },
      { id: 'side', mode: 'SIDE_QUESTION', status: 'COMPLETED', sessionId: 's5' }
    ],
    items: [{ id: 'i1', runId: 'impl' }, { id: 'i4', runId: 'side' }],
    instructions: [{ id: 'm1', runId: 'impl' }, { id: 'm5', runId: 'side', role: 'SIDE', threadId: 't1' }],
    interactions: [],
    sessions: [{ id: 's1', role: 'PRIMARY' }, { id: 's5', role: 'SIDE' }],
    plans: []
  } as unknown as AgentConversationRecords;
  const { task, side } = partitionAgentRecords(records);
  expect(task.runs.map((run) => run.id)).toEqual(['impl']);
  expect(task.items.map((item) => item.id)).toEqual(['i1']);
  expect(task.sessions.map((item) => item.id)).toEqual(['s1']);
  expect(side.runs.map((run) => run.id)).toEqual(['side']);
  expect(side.items.map((item) => item.id)).toEqual(['i4']);
  expect(side.instructions.map((item) => item.id)).toEqual(['m5']);
  expect(side.sessions.map((item) => item.id)).toEqual(['s5']);
});
