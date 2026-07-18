import { describe, expect, it } from 'vitest';
import type {
  PreviewGenerationRecord,
  PreviewLocalAttachmentRequirement,
  PreviewPlanRecord,
  Task
} from '../../shared/contracts';
import {
  createPreviewAttachmentBindingDraft,
  materializePreviewAttachmentTarget,
  selectPreviewTaskRouteOptions
} from './previewBindings';

const httpRequirement: PreviewLocalAttachmentRequirement = {
  attachmentId: 'backend',
  attachmentType: 'http',
  allowedTargetTypes: ['endpoint', 'task-preview-route'],
  usages: []
};

describe('Preview attachment bindings', () => {
  it('lists declared cross-task routes even when their producer is stopped', () => {
    const consumer = task('consumer', 'Frontend');
    const producer = task('producer', 'Backend');
    const plan = {
      taskId: producer.id,
      iterationId: producer.currentIterationId,
      createdAt: '2026-01-01T00:00:00.000Z',
      executionPlan: { routes: [{ id: 'api', service: 'web', port: 'http', primary: true }] }
    } as PreviewPlanRecord;

    expect(selectPreviewTaskRouteOptions([consumer, producer], [plan], [], consumer.id)).toEqual([{
      taskId: 'producer', taskTitle: 'Backend', routeId: 'api', available: false
    }]);
  });

  it('reports route availability separately from stable identity', () => {
    const consumer = task('consumer', 'Frontend');
    const producer = task('producer', 'Backend');
    const plan = {
      taskId: producer.id,
      iterationId: producer.currentIterationId,
      createdAt: '2026-01-01T00:00:00.000Z',
      executionPlan: { routes: [{ id: 'api', service: 'web', port: 'http', primary: true }] }
    } as PreviewPlanRecord;
    const generation = {
      taskId: producer.id,
      iterationId: producer.currentIterationId,
      routingState: 'ACTIVE',
      state: 'READY',
      routes: [{ id: 'api', state: 'ATTACHED' }]
    } as PreviewGenerationRecord;

    expect(selectPreviewTaskRouteOptions(
      [consumer, producer], [plan], [generation], consumer.id
    )[0]?.available).toBe(true);
  });

  it('materializes typed literal and task-route targets from one bounded draft model', () => {
    const draft = createPreviewAttachmentBindingDraft(httpRequirement, [{
      taskId: 'producer', taskTitle: 'Backend', routeId: 'api', available: false
    }]);
    expect(() => materializePreviewAttachmentTarget(httpRequirement, draft)).toThrow('host');
    expect(materializePreviewAttachmentTarget(httpRequirement, {
      ...draft, scheme: 'https', host: 'backend.test', port: '8443', basePath: '/v1'
    })).toEqual({
      type: 'endpoint', scheme: 'https', host: 'backend.test', port: 8443, basePath: '/v1'
    });
    expect(materializePreviewAttachmentTarget(httpRequirement, {
      ...draft, mode: 'task-preview-route'
    })).toEqual({
      type: 'task-preview-route', targetTaskId: 'producer', routeId: 'api', basePath: '/'
    });
  });
});

function task(id: string, title: string): Task {
  return {
    id,
    title,
    currentIterationId: `${id}-iteration`
  } as Task;
}
