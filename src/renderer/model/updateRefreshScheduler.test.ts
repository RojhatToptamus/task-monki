import { describe, expect, it, vi } from 'vitest';
import {
  createUpdateRefreshScheduler,
  taskSnapshotRefreshKind
} from './updateRefreshScheduler';

describe('createUpdateRefreshScheduler', () => {
  it('does not rebuild a full snapshot for high-volume run telemetry', () => {
    const common = {
      scope: { kind: 'TASK' as const, taskId: 'task-1' },
      taskId: 'task-1',
      runId: 'run-1',
      payload: null,
      at: '2026-07-26T00:00:00.000Z'
    };

    expect(
      taskSnapshotRefreshKind(
        { ...common, type: 'run.output' },
        { open: true, taskId: 'task-1' }
      )
    ).toBe('NONE');
    expect(
      taskSnapshotRefreshKind(
        { ...common, type: 'run.activity' },
        { open: false, taskId: 'task-1' }
      )
    ).toBe('NONE');
    expect(
      taskSnapshotRefreshKind(
        { ...common, type: 'run.activity' },
        { open: true, taskId: 'task-1' }
      )
    ).toBe('SELECTED_ACTIVITY');
    expect(
      taskSnapshotRefreshKind(
        { ...common, type: 'run.terminal' },
        { open: true, taskId: 'task-1' }
      )
    ).toBe('IMMEDIATE');
  });

  it('coalesces bursty update events into one refresh', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const scheduler = createUpdateRefreshScheduler({
      delayMs: 100,
      refresh,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();

    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('runs another refresh after updates arrive while a refresh is in flight', async () => {
    vi.useFakeTimers();
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const scheduler = createUpdateRefreshScheduler({
      delayMs: 100,
      refresh,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    });

    scheduler.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('continues scheduling after a refresh rejects', async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('api unavailable'))
      .mockResolvedValue(undefined);
    const scheduler = createUpdateRefreshScheduler({
      delayMs: 100,
      refresh,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    });

    scheduler.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('cancels a delayed refresh when a prompt state refresh supersedes it', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const scheduler = createUpdateRefreshScheduler({
      delayMs: 1_000,
      refresh,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    });

    scheduler.request();
    scheduler.cancelPending();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(refresh).not.toHaveBeenCalled();
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('clears a pending refresh on dispose', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const scheduler = createUpdateRefreshScheduler({
      delayMs: 100,
      refresh,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    });

    scheduler.request();
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(100);

    expect(refresh).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
