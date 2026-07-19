import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupervisedProcess } from '../../process/ProcessSupervisor';
import {
  CodexEphemeralRunError,
  superviseCodexEphemeralProcess
} from './CodexEphemeralReadOnlyRunner';

afterEach(() => {
  vi.useRealTimers();
});

describe('CodexEphemeralReadOnlyRunner', () => {
  it('does not reject a timeout until the child process has been stopped', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter() as SupervisedProcess['events'];
    let releaseCancellation: (() => void) | undefined;
    const cancellationFinished = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationCount = 0;
    const run = superviseCodexEphemeralProcess(
      {
        pid: 123,
        events,
        cancel: async () => {
          cancellationCount += 1;
          await cancellationFinished;
        }
      },
      30
    );
    let resultSettled = false;
    const observedResult = run.result.catch((error: unknown) => error).finally(() => {
      resultSettled = true;
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(cancellationCount).toBe(1);
    expect(resultSettled).toBe(false);

    releaseCancellation?.();
    await Promise.resolve();
    expect(resultSettled).toBe(false);

    events.emit('close', { exitCode: null, signal: 'SIGINT' });
    await expect(observedResult).resolves.toMatchObject({
      code: 'TIMED_OUT'
    } satisfies Partial<CodexEphemeralRunError>);
  });
});
