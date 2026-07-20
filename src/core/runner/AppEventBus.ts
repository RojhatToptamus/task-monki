import { EventEmitter } from 'node:events';
import type { AppUpdateEvent, LegacyTaskAppUpdateEvent } from '../../shared/contracts';

export class AppEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: AppUpdateEvent | LegacyTaskAppUpdateEvent): void {
    const scoped: AppUpdateEvent = 'scope' in event
      ? event
      : { ...event, scope: { kind: 'TASK', taskId: event.taskId } };
    if (
      scoped.scope.kind === 'TASK' &&
      scoped.taskId !== undefined &&
      scoped.taskId !== scoped.scope.taskId
    ) {
      throw new Error('Task app event scope does not match its compatibility task id.');
    }
    this.emitter.emit('update', scoped);
  }

  on(listener: (event: AppUpdateEvent) => void): () => void {
    this.emitter.on('update', listener);
    return () => this.emitter.off('update', listener);
  }
}
