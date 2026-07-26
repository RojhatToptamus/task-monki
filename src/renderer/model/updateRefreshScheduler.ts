import type { AppUpdateEvent } from '../../shared/contracts';

export interface UpdateRefreshScheduler {
  request(): void;
  cancelPending(): void;
  dispose(): void;
}

export type TaskSnapshotRefreshKind = 'NONE' | 'IMMEDIATE' | 'SELECTED_ACTIVITY';

export function taskSnapshotRefreshKind(
  event: AppUpdateEvent,
  detail: { open: boolean; taskId?: string }
): TaskSnapshotRefreshKind {
  if (event.type === 'run.output') {
    return 'NONE';
  }
  if (event.type === 'run.activity') {
    return detail.open && event.taskId === detail.taskId
      ? 'SELECTED_ACTIVITY'
      : 'NONE';
  }
  return 'IMMEDIATE';
}

export interface UpdateRefreshSchedulerOptions {
  delayMs: number;
  refresh: () => Promise<void>;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export function createUpdateRefreshScheduler({
  delayMs,
  refresh,
  setTimer,
  clearTimer
}: UpdateRefreshSchedulerOptions): UpdateRefreshScheduler {
  let disposed = false;
  let pending = false;
  let timer: unknown;
  let inFlight: Promise<void> | undefined;

  const schedule = () => {
    if (disposed || timer || inFlight) {
      return;
    }
    timer = setTimer(run, delayMs);
  };

  const run = () => {
    timer = undefined;
    if (disposed || !pending) {
      return;
    }
    pending = false;
    const current = refresh();
    inFlight = current;
    void current
      .catch(() => undefined)
      .finally(() => {
        if (inFlight === current) {
          inFlight = undefined;
        }
        if (pending) {
          schedule();
        }
      });
  };

  const cancelPending = () => {
    pending = false;
    if (timer) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  return {
    request() {
      if (disposed) {
        return;
      }
      pending = true;
      schedule();
    },
    cancelPending,
    dispose() {
      disposed = true;
      cancelPending();
    }
  };
}
