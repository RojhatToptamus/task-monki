import { describe, expect, it, vi } from 'vitest';
import {
  createUpdateRefreshScheduler,
  taskDataRefreshPlan
} from './updateRefreshScheduler';

describe('createUpdateRefreshScheduler', () => {
  it('keeps high-volume telemetry off board reads and scopes activity to open detail', () => {
    const common = {
      scope: { kind: 'TASK' as const, taskId: 'task-1' },
      taskId: 'task-1',
      runId: 'run-1',
      payload: null,
      at: '2026-07-26T00:00:00.000Z'
    };

    expect(
      taskDataRefreshPlan(
        { ...common, type: 'run.output' },
        { open: true, taskId: 'task-1' }
      )
    ).toEqual({ board: false, detail: 'NONE' });
    expect(
      taskDataRefreshPlan(
        { ...common, type: 'run.activity' },
        { open: false, taskId: 'task-1' }
      )
    ).toEqual({ board: false, detail: 'NONE' });
    expect(
      taskDataRefreshPlan(
        { ...common, type: 'run.activity' },
        { open: true, taskId: 'task-1' }
      )
    ).toEqual({ board: false, detail: 'SELECTED_ACTIVITY' });
    expect(
      taskDataRefreshPlan(
        { ...common, type: 'run.terminal' },
        { open: true, taskId: 'task-1' }
      )
    ).toEqual({ board: true, detail: 'IMMEDIATE' });
    expect(
      taskDataRefreshPlan(
        { ...common, type: 'run.state.updated' },
        { open: false, taskId: 'task-1' }
      )
    ).toEqual({ board: true, detail: 'NONE' });
    expect(
      taskDataRefreshPlan(
        { ...common, type: 'interaction.updated' },
        { open: true, taskId: 'task-1' }
      )
    ).toEqual({ board: true, detail: 'IMMEDIATE' });
  });

  it('refreshes open detail for global and cross-task dependencies', () => {
    const selected = { open: true, taskId: 'task-1' };
    const otherTask = {
      scope: { kind: 'TASK' as const, taskId: 'task-2' },
      taskId: 'task-2',
      payload: null,
      at: '2026-07-26T00:00:00.000Z'
    };

    expect(
      taskDataRefreshPlan(
        {
          type: 'projection.updated',
          scope: { kind: 'APP' },
          taskId: '__browser_poll__',
          payload: null,
          at: '2026-07-26T00:00:00.000Z'
        },
        selected
      )
    ).toEqual({ board: true, detail: 'IMMEDIATE' });
    expect(
      taskDataRefreshPlan(
        { ...otherTask, type: 'preview.updated' },
        selected
      )
    ).toEqual({ board: false, detail: 'IMMEDIATE' });
    expect(
      taskDataRefreshPlan(
        { ...otherTask, type: 'task.deleted' },
        selected
      )
    ).toEqual({ board: true, detail: 'IMMEDIATE' });
    expect(
      taskDataRefreshPlan(
        {
          ...otherTask,
          type: 'task.deleted',
          scope: { kind: 'TASK', taskId: 'task-1' },
          taskId: 'task-1'
        },
        selected
      )
    ).toEqual({ board: true, detail: 'NONE' });
    expect(
      taskDataRefreshPlan(
        { ...otherTask, type: 'repository.updated' },
        selected
      )
    ).toEqual({ board: true, detail: 'IMMEDIATE' });
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
