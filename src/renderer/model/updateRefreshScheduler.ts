export interface UpdateRefreshScheduler {
  request(): void;
  dispose(): void;
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

  return {
    request() {
      if (disposed) {
        return;
      }
      pending = true;
      schedule();
    },
    dispose() {
      disposed = true;
      pending = false;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
    }
  };
}
