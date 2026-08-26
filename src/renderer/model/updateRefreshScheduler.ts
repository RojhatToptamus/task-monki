import type { AppUpdateEvent } from '../../shared/contracts';

export interface UpdateRefreshScheduler {
  request(): void;
  cancelPending(): void;
  dispose(): void;
}

export type TaskDataRefreshUrgency = 'NONE' | 'IMMEDIATE' | 'SELECTED_ACTIVITY';

export interface TaskDataRefreshPlan {
  board: boolean;
  detail: TaskDataRefreshUrgency;
}

export function taskDataRefreshPlan(
  event: AppUpdateEvent,
  detail: { open: boolean; taskId?: string }
): TaskDataRefreshPlan {
  const selectedTaskEvent =
    detail.open &&
    Boolean(detail.taskId) &&
    event.scope.kind === 'TASK' &&
    event.taskId === detail.taskId;
  if (event.type === 'run.output') {
    return { board: false, detail: 'NONE' };
  }
  if (event.type === 'run.activity') {
    return {
      board: false,
      detail: selectedTaskEvent ? 'SELECTED_ACTIVITY' : 'NONE'
    };
  }
  if (
    event.type === 'runtime.updated' ||
    event.type === 'preview.recipe-generation.updated' ||
    event.type === 'preview.log.updated' ||
    event.type.startsWith('discourse.')
  ) {
    return { board: false, detail: 'NONE' };
  }
  if (
    event.type === 'agent.goal.updated' ||
    event.type === 'run.diagnostic' ||
    event.type === 'prompt.refined'
  ) {
    return {
      board: false,
      detail: selectedTaskEvent ? 'IMMEDIATE' : 'NONE'
    };
  }
  if (event.type === 'preview.updated') {
    return {
      board: false,
      detail: detail.open ? 'IMMEDIATE' : 'NONE'
    };
  }
  if (event.type === 'projection.updated') {
    return {
      board: true,
      detail: detail.open ? 'IMMEDIATE' : 'NONE'
    };
  }
  if (event.type === 'repository.updated' || event.type === 'task.updated') {
    return {
      board: true,
      detail: detail.open ? 'IMMEDIATE' : 'NONE'
    };
  }
  if (event.type === 'task.deleted') {
    return {
      board: true,
      detail:
        detail.open && !selectedTaskEvent
          ? 'IMMEDIATE'
          : 'NONE'
    };
  }
  if (
    event.type === 'board.updated' ||
    event.type === 'board.deleted'
  ) {
    return { board: true, detail: 'NONE' };
  }
  return {
    board: true,
    detail: selectedTaskEvent ? 'IMMEDIATE' : 'NONE'
  };
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
