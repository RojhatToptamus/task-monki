import { useEffect, useMemo, useState } from 'react';
import type { ReviewChangesResult } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { inspectGitDiffEvidence, type DiffFile } from '../model/diffEvidence';

export interface ReviewChangesView {
  loading: boolean;
  /** The files changed since the review, exactly; absent while loading or when the review's code was not kept. */
  files?: DiffFile[];
}

/** Reads under way, by task, review and capture: the task page and the Review tab read the same changes once. */
const reading = new Map<string, Promise<ReviewChangesResult | undefined>>();

function readReviewChanges(key: string, taskId: string, reviewRunId: string): Promise<ReviewChangesResult | undefined> {
  const known = reading.get(key);
  if (known) return known;
  const read = taskManagerApi.readReviewChanges({ taskId, reviewRunId })
    // A review whose code cannot be read falls back to the file comparison.
    .catch(() => undefined)
    .finally(() => reading.delete(key));
  reading.set(key, read);
  return read;
}

/**
 * What changed from the code a review read to the worktree now, read again
 * whenever the worktree's capture changes (`refreshKey`).
 */
export function useReviewChanges(taskId: string, reviewRunId: string | undefined, refreshKey: string | undefined): ReviewChangesView {
  const [result, setResult] = useState<{ key: string; value?: ReviewChangesResult }>();
  const key = reviewRunId ? `${taskId}\u0000${reviewRunId}\u0000${refreshKey ?? ''}` : undefined;

  useEffect(() => {
    if (!key || !reviewRunId) return;
    let canceled = false;
    void readReviewChanges(key, taskId, reviewRunId).then((value) => { if (!canceled) setResult({ key, value }); });
    return () => { canceled = true; };
  }, [key, reviewRunId, taskId]);

  const current = result?.key === key ? result : undefined;
  const files = useMemo(
    () => (current?.value?.status === 'READY' ? inspectGitDiffEvidence(current.value.diff).files : undefined),
    [current]
  );
  return { loading: Boolean(key) && !current, files };
}
