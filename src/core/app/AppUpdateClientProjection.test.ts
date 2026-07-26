import { describe, expect, it } from 'vitest';
import type { AppUpdateEvent } from '../../shared/contracts';
import { projectAppUpdateEventForClient } from './AppUpdateClientProjection';

describe('projectAppUpdateEventForClient', () => {
  const common = {
    scope: { kind: 'TASK' as const, taskId: 'task-1' },
    taskId: 'task-1',
    at: '2026-07-26T00:00:00.000Z'
  };

  it('removes provider output from the Electron/browser event projection', () => {
    const projected = projectAppUpdateEventForClient({
      ...common,
      type: 'run.output',
      runId: 'run-1',
      payload: { text: 'x'.repeat(1024 * 1024) }
    });

    expect(projected.payload).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThan(512);
  });

  it('retains payloads consumed directly by renderer workflows', () => {
    const recipe = { taskId: 'task-1', status: 'READY' };
    const projected = projectAppUpdateEventForClient({
      ...common,
      type: 'preview.recipe-generation.updated',
      payload: recipe
    } as AppUpdateEvent);

    expect(projected.payload).toEqual(recipe);

    const delta = { jobId: 'job-1', publication: { text: 'bounded delta' } };
    expect(
      projectAppUpdateEventForClient({
        type: 'discourse.delta',
        scope: {
          kind: 'DISCOURSE',
          conversationId: 'conversation-1',
          jobId: 'job-1'
        },
        taskId: 'discourse:conversation-1',
        payload: delta,
        at: common.at
      }).payload
    ).toEqual(delta);
  });
});
