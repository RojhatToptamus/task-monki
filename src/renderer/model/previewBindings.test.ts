import { describe, expect, it } from 'vitest';
import type {
  PreviewLocalAttachmentRequirement
} from '../../shared/contracts';
import {
  createPreviewAttachmentBindingDraft,
  materializePreviewAttachmentTarget
} from './previewBindings';

const httpRequirement: PreviewLocalAttachmentRequirement = {
  attachmentId: 'backend',
  attachmentType: 'http',
  allowedTargetTypes: ['endpoint', 'task-preview-route'],
  usages: []
};

describe('Preview attachment bindings', () => {
  it('materializes typed literal and task-route targets from one bounded draft model', () => {
    const draft = createPreviewAttachmentBindingDraft(httpRequirement);
    expect(() => materializePreviewAttachmentTarget(httpRequirement, draft)).toThrow('host');
    expect(() => materializePreviewAttachmentTarget(httpRequirement, {
      ...draft, mode: 'task-preview-route'
    })).toThrow('Select a valid Preview route');
    expect(materializePreviewAttachmentTarget(httpRequirement, {
      ...draft, scheme: 'https', host: 'backend.test', port: '8443', basePath: '/v1'
    })).toEqual({
      type: 'endpoint', scheme: 'https', host: 'backend.test', port: 8443, basePath: '/v1'
    });
    expect(materializePreviewAttachmentTarget(httpRequirement, {
      ...draft, mode: 'task-preview-route', targetTaskId: 'producer', routeId: 'api'
    })).toEqual({
      type: 'task-preview-route', targetTaskId: 'producer', routeId: 'api', basePath: '/'
    });
  });
});
