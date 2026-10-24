import { useCallback, useEffect, useRef, useState } from 'react';
import type { BugReplaySnapshot } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';

const UPDATE_DELAY_MS = 120;

/**
 * What can change the bug or whether Record bug is offered: the worktree, the recipe in it, the
 * task's phase, and an agent turn starting or ending.
 */
const BUG_INPUTS = new Set(['bugReplay.updated', 'task.updated', 'worktree.updated', 'preview.updated', 'git.updated', 'run.started', 'run.terminal']);

/**
 * The task's bug as Task Monki holds it. Read once per task and again after Bug Replay or the
 * task says something changed; bursts of updates are read once, and a read still in flight
 * when the task changes is dropped.
 */
export function useBugReplay(taskId: string | undefined): {
  snapshot?: BugReplaySnapshot;
  error?: string;
  refresh(): void;
} {
  const [state, setState] = useState<{ taskId?: string; snapshot?: BugReplaySnapshot; error?: string }>({});
  const readRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!taskId) return;
    let disposed = false;
    let reading = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (disposed) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const snapshot = await taskManagerApi.getBugReplay({ taskId });
        if (!disposed) setState({ taskId, snapshot });
      } catch (cause) {
        if (!disposed) setState((current) => ({ taskId, snapshot: current.taskId === taskId ? current.snapshot : undefined, error: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        reading = false;
        if (again && !disposed) {
          again = false;
          void read();
        }
      }
    };
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, UPDATE_DELAY_MS);
    };
    readRef.current = () => void read();
    void read();
    const unsubscribe = taskManagerApi.onUpdate((event) => {
      if (event.taskId !== taskId) return;
      if (BUG_INPUTS.has(event.type)) soon();
    });
    return () => {
      disposed = true;
      readRef.current = () => undefined;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [taskId]);

  const refresh = useCallback(() => readRef.current(), []);
  const current = state.taskId === taskId ? state : {};
  return { snapshot: current.snapshot, error: current.error, refresh };
}
