import { useEffect, useRef } from 'react';

/** Observe on opening an external task or returning to the app, never on a data reload. */
export function useExternalCheckoutObservation(input: {
  taskId?: string;
  paused: boolean;
  isActionPending(): boolean;
  observe(taskId: string): Promise<unknown>;
  refresh(): Promise<void>;
  onError(error: unknown): void;
}) {
  const current = useRef(input);
  current.current = input;
  const openedTask = useRef<string | undefined>(undefined);
  const pending = useRef(new Set<string>());

  useEffect(() => {
    const taskId = input.taskId;
    if (!taskId) {
      openedTask.current = undefined;
      return;
    }
    let canceled = false;
    const observe = async () => {
      if (current.current.paused || current.current.isActionPending() || pending.current.has(taskId)) return;
      openedTask.current = taskId;
      pending.current.add(taskId);
      try {
        await current.current.observe(taskId);
      } catch (caught) {
        if (!canceled) current.current.onError(caught);
      } finally {
        pending.current.delete(taskId);
        if (!canceled) await current.current.refresh();
      }
    };
    const onFocus = () => { void observe(); };
    window.addEventListener('focus', onFocus);
    if (openedTask.current !== taskId) void observe();
    return () => {
      canceled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [input.taskId, input.paused]);
}
