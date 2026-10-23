import { useEffect, useMemo, useState } from 'react';
import type { TaskCommit, TaskCommitDiffResult, TaskCommitsResult } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { inspectGitDiffEvidence, type DiffFile } from '../model/diffEvidence';

const NO_COMMITS: { commits: readonly TaskCommit[]; total: number } = { commits: [], total: 0 };

/**
 * A capture's commits, oldest first, read once per capture; none for an
 * earlier capture or when they cannot be read. The last list read stays while
 * the next capture's is read, so the menu never empties in between.
 */
export function useTaskCommits(taskId: string, gitSnapshotId: string | undefined): { commits: readonly TaskCommit[]; total: number } {
  const [result, setResult] = useState<TaskCommitsResult>();
  useEffect(() => {
    if (!gitSnapshotId) return;
    let canceled = false;
    void taskManagerApi.listTaskCommits({ taskId, gitSnapshotId }).then(
      (value) => { if (!canceled) setResult(value); },
      () => { if (!canceled) setResult({ status: 'UNAVAILABLE' }); }
    );
    return () => { canceled = true; };
  }, [gitSnapshotId, taskId]);
  return gitSnapshotId && result?.status === 'READY' ? result : NO_COMMITS;
}

/** The last commit whose change was read: its files, or why there are none. */
export interface CommitChange {
  sha: string;
  files: DiffFile[];
  unavailable?: Extract<TaskCommitDiffResult, { status: 'UNAVAILABLE' }>['reason'];
}

/**
 * One commit's change, read when `sha` is chosen. What it returns is the last
 * change read, which stays while the next is read: the Diff moves to a commit
 * once its change is there, never through an empty state. A commit never
 * changes, so a new capture keeps what was read.
 */
export function useCommitChange(taskId: string, gitSnapshotId: string | undefined, sha: string | undefined): CommitChange | undefined {
  const [result, setResult] = useState<{ sha: string; value: TaskCommitDiffResult }>();
  useEffect(() => {
    if (!gitSnapshotId || !sha) return;
    let canceled = false;
    void taskManagerApi.readTaskCommitDiff({ taskId, gitSnapshotId, sha }).then(
      (value) => { if (!canceled) setResult({ sha, value }); },
      () => { if (!canceled) setResult({ sha, value: { status: 'UNAVAILABLE', reason: 'UNREADABLE' } }); }
    );
    return () => { canceled = true; };
  }, [gitSnapshotId, sha, taskId]);
  return useMemo(() => {
    if (!result) return undefined;
    const { value } = result;
    // Named for its commit, a file's blocks never share an id with another diff's of the same file.
    return value.status === 'READY'
      ? { sha: result.sha, files: inspectGitDiffEvidence(value.diff, `Commit ${result.sha}`).files }
      : { sha: result.sha, files: [], unavailable: value.reason };
  }, [result]);
}
