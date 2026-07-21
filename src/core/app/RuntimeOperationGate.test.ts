import { describe, expect, it } from 'vitest';
import { RuntimeOperationGate } from './RuntimeOperationGate';

describe('RuntimeOperationGate', () => {
  it('waits for admitted operations before applying a lifecycle change', async () => {
    const gate = new RuntimeOperationGate();
    const events: string[] = [];
    let releaseOperation!: () => void;
    const operationBlock = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operation = gate.runOperation(async () => {
      events.push('operation-started');
      await operationBlock;
      events.push('operation-finished');
    });
    await Promise.resolve();

    const lifecycle = gate.runLifecycleChange(async () => {
      events.push('lifecycle');
    });
    await Promise.resolve();
    expect(events).toEqual(['operation-started']);

    releaseOperation();
    await Promise.all([operation, lifecycle]);
    expect(events).toEqual([
      'operation-started',
      'operation-finished',
      'lifecycle'
    ]);
  });

  it('starts later operations only after the current lifecycle change settles', async () => {
    const gate = new RuntimeOperationGate();
    let releaseLifecycle!: () => void;
    const lifecycleBlock = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });
    let operationStarted = false;
    const lifecycle = gate.runLifecycleChange(() => lifecycleBlock);
    const operation = gate.runOperation(async () => {
      operationStarted = true;
    });

    await Promise.resolve();
    expect(operationStarted).toBe(false);
    releaseLifecycle();
    await Promise.all([lifecycle, operation]);
    expect(operationStarted).toBe(true);
  });

  it('closes admission and returns the exact work shutdown must join', async () => {
    const gate = new RuntimeOperationGate();
    let releaseOperation!: () => void;
    const operationBlock = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let markOperationStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      markOperationStarted = resolve;
    });
    const operation = gate.runOperation(async () => {
      markOperationStarted();
      await operationBlock;
    });
    await operationStarted;

    const drain = gate.close();
    expect(gate.isClosing).toBe(true);
    expect(drain.operations).toHaveLength(1);
    expect(() => gate.runOperation(async () => undefined)).toThrow(
      'cannot start provider work'
    );
    expect(() => gate.runLifecycleChange(async () => undefined)).toThrow(
      'cannot start provider work'
    );

    releaseOperation();
    await Promise.all([operation, drain.lifecycle, ...drain.operations]);
  });

  it('tracks rejected operations as settled drain work', async () => {
    const gate = new RuntimeOperationGate();
    let markOperationStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      markOperationStarted = resolve;
    });
    let releaseOperation!: () => void;
    const operationBlock = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operation = gate.runOperation(async () => {
      markOperationStarted();
      await operationBlock;
      throw new Error('provider failed');
    });
    await operationStarted;
    const drain = gate.close();
    releaseOperation();

    await expect(operation).rejects.toThrow('provider failed');
    await expect(Promise.all(drain.operations)).resolves.toEqual([undefined]);
  });
});
