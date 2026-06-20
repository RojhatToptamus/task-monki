import { EventEmitter } from 'node:events';
import type { AppUpdateEvent } from '../../shared/contracts';

export class AppEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: AppUpdateEvent): void {
    this.emitter.emit('update', event);
  }

  on(listener: (event: AppUpdateEvent) => void): () => void {
    this.emitter.on('update', listener);
    return () => this.emitter.off('update', listener);
  }
}
