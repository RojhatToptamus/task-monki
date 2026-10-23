/**
 * A task's commits, read one at a time in the Review tab: the branch's own
 * history (its first parents) from the base a capture compares against to the
 * head it captured, oldest first.
 */
export interface TaskCommit {
  sha: string;
  /** The message's first line. */
  subject: string;
  /** The rest of the message, bounded; absent when there is none. */
  body?: string;
  author: string;
  /** ISO 8601. */
  authoredAt: string;
}

export interface ReadTaskCommitsRequest {
  taskId: string;
  /** The capture whose commits are read, from its base to its head. */
  gitSnapshotId: string;
}

export type TaskCommitsResult =
  /** The latest commits, oldest first; `total` counts them all, those past the limit included. */
  | { status: 'READY'; commits: TaskCommit[]; total: number }
  /** The capture has no base or head, or its worktree is gone. */
  | { status: 'UNAVAILABLE' };

export interface ReadTaskCommitDiffRequest extends ReadTaskCommitsRequest {
  /** One of the capture's listed commits. */
  sha: string;
}

export type TaskCommitDiffResult =
  /** The commit's change against its first parent. */
  | { status: 'READY'; sha: string; diff: string }
  | { status: 'UNAVAILABLE'; reason: 'TOO_LARGE' | 'UNREADABLE' };
