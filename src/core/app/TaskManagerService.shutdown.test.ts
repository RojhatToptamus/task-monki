import { describe, expect, it } from 'vitest';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService shutdown coordination', () => {
  it('begins provider shutdown before waiting for preview cleanup', async () => {
    const events: string[] = [];
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
    const service = Object.create(TaskManagerService.prototype) as TaskManagerService;
    const internals = service as unknown as {
      agents: { shutdown(): Promise<void> };
      previews: { shutdown(): Promise<void> };
    };
    internals.agents = {
      async shutdown() {
        events.push('agent-started');
      }
    };
    internals.previews = {
      async shutdown() {
        events.push('preview-started');
        await previewGate;
        events.push('preview-finished');
      }
    };

    const shutdown = service.shutdown();
    await Promise.resolve();
    expect(events).toEqual(['agent-started', 'preview-started']);
    releasePreview();
    await shutdown;
    expect(events).toEqual(['agent-started', 'preview-started', 'preview-finished']);
  });
});
