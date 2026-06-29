import { describe, expect, it, vi } from 'vitest';
import { createUpdateRefreshScheduler } from './updateRefreshScheduler';

describe('createUpdateRefreshScheduler', () => {
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
