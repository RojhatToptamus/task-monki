import { useEffect, useMemo, useState } from 'react';
import {
  parseReviewWalkthrough,
  type ReviewChangesResult,
  type ReviewWalkthrough,
  type ReviewWalkthroughState
} from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { inspectGitDiffEvidence, type DiffFile } from '../model/diffEvidence';

export interface WalkthroughView {
  /** A stored walkthrough or its change is still being read. */
  loading: boolean;
  /** The walkthrough as Task Monki checked and kept it; absent when none is stored or it could not be read. */
  walkthrough?: ReviewWalkthrough;
  /** The change it describes, as the Diff's files; absent while loading or when it cannot be shown. */
  files?: DiffFile[];
  /** Why the change cannot be shown. */
  diffUnavailable?: Extract<ReviewChangesResult, { status: 'UNAVAILABLE' }>['reason'];
}

interface Reading {
  key: string;
  walkthrough?: ReviewWalkthrough;
  diff: ReviewChangesResult;
}

/**
 * The review gate's stored walkthrough with the change it describes: the diff
 * from the base the review compared against to the code it read, so a worktree
 * edited since still reads with one set of line numbers. Both are immutable for
 * their review, read together once, so they always belong to one revision.
 */
export function useWalkthrough(taskId: string, state: ReviewWalkthroughState | undefined): WalkthroughView {
  const stored = state?.status === 'STORED' ? state : undefined;
  const reviewRunId = stored?.reviewRunId;
  const artifactId = stored?.artifactId;
  const key = reviewRunId && artifactId ? `${taskId}\u0000${reviewRunId}\u0000${artifactId}` : undefined;
  const [reading, setReading] = useState<Reading>();

  // Both are immutable for their review: a reading already held for this one is not read again.
  const held = reading?.key === key;
  useEffect(() => {
    if (!key || !reviewRunId || !artifactId || held) return;
    let canceled = false;
    void Promise.all([
      taskManagerApi.readArtifact({ artifactId }).then((text) => parseReviewWalkthrough(text, reviewRunId), () => undefined),
      taskManagerApi.readReviewedDiff({ taskId, reviewRunId })
        .catch((): ReviewChangesResult => ({ status: 'UNAVAILABLE', reason: 'UNREADABLE' }))
    ]).then(([walkthrough, diff]) => {
      if (!canceled) setReading({ key, walkthrough, diff });
    });
    return () => { canceled = true; };
  }, [key, taskId, reviewRunId, artifactId, held]);

  const current = reading?.key === key ? reading : undefined;
  const files = useMemo(
    () => (current?.diff.status === 'READY' ? inspectGitDiffEvidence(current.diff.diff).files : undefined),
    [current]
  );
  return {
    loading: Boolean(key) && !current,
    ...(current?.walkthrough ? { walkthrough: current.walkthrough } : {}),
    ...(files ? { files } : {}),
    ...(current?.diff.status === 'UNAVAILABLE' ? { diffUnavailable: current.diff.reason } : {})
  };
}
