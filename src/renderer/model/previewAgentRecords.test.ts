import { expect, it } from 'vitest';
import type { AgentConversationRecords } from './previewAgentRecords';
import { partitionPreviewAgentRecords } from './previewAgentRecords';

it('keeps Preview runs, their records and their messages out of the task conversation', () => {
  const records = {
    runs: [{ id: 'impl', mode: 'IMPLEMENTATION' }, { id: 'prev', mode: 'PREVIEW' }, { id: 'review', mode: 'REVIEW' }],
    items: [{ id: 'i1', runId: 'impl' }, { id: 'i2', runId: 'prev' }],
    instructions: [{ id: 'm1', runId: 'impl' }, { id: 'm2', runId: 'prev', role: 'PREVIEW' }, { id: 'm3', role: 'PREVIEW', status: 'QUEUED' }],
    interactions: [{ id: 'q1', runId: 'prev' }, { id: 'q2', runId: 'impl' }],
    sessions: [{ id: 's1', role: 'PRIMARY' }, { id: 's2', role: 'PREVIEW' }, { id: 's3', role: 'REVIEW' }],
    plans: [{ id: 'p1', runId: 'prev' }]
  } as unknown as AgentConversationRecords;
  const { task, preview } = partitionPreviewAgentRecords(records);
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
