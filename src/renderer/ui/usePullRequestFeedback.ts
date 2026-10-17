import { useEffect, useRef, useState } from 'react';
import { parsePullRequestFeedback, type PullRequestFeedback, type ReviewRollupRecord } from '../../shared/contracts';

/**
 * The pull request feedback a task's latest review observation points at.
 * Each reading is an immutable artifact, read once; while a newer one loads,
 * the last reading of the same task and pull request stays, so threads never
 * blink out under the reader. A response for another task is ignored.
 */
export function usePullRequestFeedback(
  rollup: Pick<ReviewRollupRecord, 'taskId' | 'pullRequestNumber' | 'feedback'> | undefined,
  read: ((artifactId: string) => Promise<string>) | undefined
): PullRequestFeedback | undefined {
  const [loaded, setLoaded] = useState<{ taskId: string; artifactId: string; feedback?: PullRequestFeedback }>();
  // The reader's identity can change every render; only the artifact decides when to read.
  const readRef = useRef(read);
  readRef.current = read;
  const taskId = rollup?.taskId;
  const artifactId = rollup?.feedback?.artifactId;
  const number = rollup?.pullRequestNumber;
  useEffect(() => {
    const reader = readRef.current;
    if (!taskId || !artifactId || !reader) return;
    let canceled = false;
    void reader(artifactId).then(
      (text) => { if (!canceled) setLoaded({ taskId, artifactId, feedback: parsePullRequestFeedback(text, number) }); },
      () => { if (!canceled) setLoaded({ taskId, artifactId }); }
    );
    return () => { canceled = true; };
  }, [taskId, artifactId, number]);
  if (!loaded || !artifactId || loaded.taskId !== taskId) return undefined;
  return loaded.feedback?.number === number ? loaded.feedback : undefined;
}
