import type { GitSnapshotRecord } from '../../shared/contracts';

/**
 * The code a review read, or will read. A review reads the worktree as it is,
 * so a commit alone would understate it when the worktree also had staged,
 * unstaged or untracked changes.
 */
export interface ReviewedCode {
  /** The commit, shortened. */
  head?: string;
  /** The worktree's uncommitted changes came with the commit. */
  uncommitted: boolean;
}

type WorktreeCounts = Pick<GitSnapshotRecord, 'stagedCount' | 'unstagedCount' | 'untrackedCount'>;

/** Whether a Git snapshot's worktree had changes not yet committed. */
export function hasUncommittedChanges(counts: WorktreeCounts): boolean {
  return counts.stagedCount + counts.unstagedCount + counts.untrackedCount > 0;
}

/** From the commit the review recorded and the Git snapshot it read (or will read). */
export function reviewedCode(headSha: string | undefined, snapshot: (WorktreeCounts & Pick<GitSnapshotRecord, 'headSha'>) | undefined): ReviewedCode | undefined {
  const head = (headSha ?? snapshot?.headSha)?.slice(0, 7);
  const uncommitted = snapshot ? hasUncommittedChanges(snapshot) : false;
  return head || uncommitted ? { head, uncommitted } : undefined;
}

/** "a1b2c3d and uncommitted changes", for a line with no room for markup. */
export function reviewedCodeText(code: ReviewedCode): string {
  if (!code.head) return 'Uncommitted changes';
  return code.uncommitted ? `${code.head} and uncommitted changes` : code.head;
}
