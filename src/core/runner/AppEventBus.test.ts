import { describe, expect, it, vi } from 'vitest';
import { AppEventBus } from './AppEventBus';

describe('AppEventBus ownership', () => {
  it('normalizes legacy task events to an explicit task scope', () => {
    const bus = new AppEventBus();
    const listener = vi.fn();
    bus.on(listener);
    bus.emit({
      type: 'run.output',
      taskId: 'task-1',
      payload: { text: 'hello' },
      at: '2026-07-13T00:00:00.000Z'
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        scope: { kind: 'TASK', taskId: 'task-1' }
      })
    );
  });

  it('preserves discourse scope while using a compatibility routing key', () => {
    const bus = new AppEventBus();
    const listener = vi.fn();
    bus.on(listener);
    bus.emit({
      type: 'discourse.message.appended',
      scope: { kind: 'DISCOURSE', conversationId: 'conversation-1' },
      taskId: 'discourse:conversation-1',
      payload: { messageId: 'message-1' },
      at: '2026-07-13T00:00:00.000Z'
    });
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      scope: { kind: 'DISCOURSE', conversationId: 'conversation-1' },
      taskId: 'discourse:conversation-1'
    });
  });
});
