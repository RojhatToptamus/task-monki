export interface RuntimeOperationDrain {
  lifecycle: Promise<void>;
  operations: Promise<void>[];
}

/**
 * Serializes runtime lifecycle changes against admitted provider operations.
 * Closing the gate is the single admission boundary used by service shutdown.
 */
export class RuntimeOperationGate {
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly activeOperations = new Set<Promise<void>>();
  private closing = false;

  get isClosing(): boolean {
    return this.closing;
  }

  runOperation<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const operation = this.lifecycleTail.then(() => {
      this.assertOpen();
      return action();
    });
    return this.trackOperation(operation);
  }

  trackOperation<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined
    );
    this.activeOperations.add(settled);
    void settled.then(() => {
      this.activeOperations.delete(settled);
    });
    return operation;
  }

  runLifecycleChange<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.enqueueLifecycleChange(action);
  }

  enqueueLifecycleChange<T>(action: () => Promise<T>): Promise<T> {
    const previousLifecycle = this.lifecycleTail;
    const admittedOperations = [...this.activeOperations];
    const operation = Promise.all([
      previousLifecycle,
      ...admittedOperations
    ]).then(action);
    this.lifecycleTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  close(): RuntimeOperationDrain {
    this.closing = true;
    return {
      lifecycle: this.lifecycleTail,
      operations: [...this.activeOperations]
    };
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new Error(
        'Task Monki is shutting down and cannot start provider work.'
      );
    }
  }
}
