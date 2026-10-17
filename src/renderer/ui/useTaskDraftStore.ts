import { useCallback, useRef, useState } from 'react';

const KEPT_TASKS = 40;

/**
 * A per-task draft kept in memory and saved through `write`, one write at a time
 * per task: an edit made while a write is in flight is saved right after it, so
 * the last edit always lands. A failed save is reported per task and the draft
 * stays in memory. Only the most recent tasks are kept. `write` must be stable.
 */
export function useTaskDraftStore<T>(write: (taskId: string, value: T) => Promise<void>) {
  const [values, setValues] = useState<Record<string, T>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const writes = useRef(new Map<string, { value: T; work?: Promise<void>; error?: string }>());

  const save = useCallback((taskId: string, value: T) => {
    setValues((current) => {
      const entries = Object.entries(current).filter(([id]) => id !== taskId).slice(-(KEPT_TASKS - 1));
      return { ...Object.fromEntries(entries), [taskId]: value };
    });
    const entry = writes.current.get(taskId) ?? { value };
    entry.value = value;
    entry.error = undefined;
    writes.current.set(taskId, entry);
    if (entry.work) return;
    entry.work = (async () => {
      let saved: T;
      do {
        saved = entry.value;
        await write(taskId, saved);
      } while (saved !== entry.value);
      setErrors((current) => ({ ...current, [taskId]: undefined }));
    })().catch((caught: unknown) => {
      entry.error = `Draft could not be saved: ${caught instanceof Error ? caught.message : String(caught)}`;
      setErrors((current) => ({ ...current, [taskId]: entry.error }));
      throw caught;
    }).finally(() => {
      entry.work = undefined;
      for (const [id, previous] of writes.current) {
        if (writes.current.size <= KEPT_TASKS) break;
        if (id !== taskId && !previous.work && !previous.error) writes.current.delete(id);
      }
    });
    void entry.work.catch(() => undefined);
  }, [write]);

  /** Waits for the task's pending save; rejects when the last save failed. */
  const flush = useCallback(async (taskId: string) => {
    const pending = writes.current.get(taskId);
    await pending?.work;
    if (pending?.error) throw new Error(pending.error);
  }, []);

  return { values, errors, save, flush };
}
