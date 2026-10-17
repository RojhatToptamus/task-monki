import type {
  CiRollupRecord,
  GitHubCheckDetailRecord,
  GitHubRepositoryRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import type { PullRequestMergeMethod, PullRequestMergeOptions } from '../../shared/pullRequestActions';
import type { PullRequestDiscussion, PullRequestFeedback } from '../../shared/pullRequestFeedback';
import type { RemoteProvider, RemoteRepositoryRef } from '../../shared/remoteWork';

/**
 * Where a linked task's pull or merge request lives. Without a target, the
 * platform repository is found from the checkout, as it always was.
 */
export interface DeliveryTarget {
  repository: RemoteRepositoryRef;
  /** The repository the branch is pushed to when it is not `repository`, a fork. */
  headRepository?: RemoteRepositoryRef;
}

/** The remote a delivery pushes through. */
export interface DeliveryRemote {
  remoteName: string;
  remoteUrl: string;
  host: string;
  owner: string;
  repo: string;
}

/** One observation of a pull or merge request, split into Task Monki's evidence records. */
export interface PullRequestSync {
  pullRequest: Omit<PullRequestSnapshotRecord, 'id' | 'observedAt'>;
  ci: Omit<CiRollupRecord, 'id' | 'observedAt'>;
  reviews: Omit<ReviewRollupRecord, 'id' | 'observedAt'>;
  merge: Omit<MergeSnapshotRecord, 'id' | 'observedAt'>;
  /** What people said on it; absent when it could not be read, so the last reading stands. */
  feedback?: PullRequestFeedback;
}

/** The pull or merge request an action addresses, as Task Monki last recorded it. */
export interface PullRequestAddress {
  number: number;
  url: string;
  target?: DeliveryTarget;
}

/**
 * A platform's pull or merge request delivery. Git pushes stay with Git; this is
 * what the platform's CLI does: readiness, creation, lookup and status, and the
 * person's own steps on it: ready, merge, replies and resolving, review requests.
 */
export interface PullRequestDelivery {
  readonly provider: RemoteProvider;
  preflight(task: Task, worktree: WorktreeRecord, pushRemote?: DeliveryRemote): Promise<Omit<GitHubRepositoryRecord, 'id' | 'checkedAt'>>;
  createOrFindDraftPullRequest(input: {
    worktree: WorktreeRecord;
    baseRef?: string;
    body: string;
    title: string;
    target?: DeliveryTarget;
  }): Promise<PullRequestSync>;
  findOpenPullRequest(worktree: WorktreeRecord, target?: DeliveryTarget): Promise<PullRequestSync | undefined>;
  viewPullRequest(worktree: WorktreeRecord, selector: string | number, target?: DeliveryTarget): Promise<PullRequestSync>;
  pullRequestBase(worktree: WorktreeRecord, requestedBranch?: string): Promise<string>;
  markReadyForReview(worktree: WorktreeRecord, address: PullRequestAddress): Promise<void>;
  readMergeOptions(worktree: WorktreeRecord, address: PullRequestAddress): Promise<PullRequestMergeOptions>;
  /** Merges exactly `expectedHeadSha`; the platform refuses when the head moved. */
  mergePullRequest(worktree: WorktreeRecord, address: PullRequestAddress, input: {
    method: PullRequestMergeMethod;
    expectedHeadSha: string;
    /** The branch to delete after the merge, when the person asked and it can be deleted. */
    deleteBranch?: string;
  }): Promise<void>;
  /** Replies on a discussion's own thread; a discussion that has none takes a comment on the pull request. */
  replyToDiscussion(worktree: WorktreeRecord, address: PullRequestAddress, discussion: Pick<PullRequestDiscussion, 'id' | 'kind'>, body: string): Promise<void>;
  resolveDiscussion(worktree: WorktreeRecord, address: PullRequestAddress, discussionId: string): Promise<void>;
  commentOnPullRequest(worktree: WorktreeRecord, address: PullRequestAddress, body: string): Promise<void>;
  /** Asks people for another review; false when the platform cannot be asked from here. */
  readonly canRequestReviewers: boolean;
  requestReviewers(worktree: WorktreeRecord, address: PullRequestAddress, names: string[]): Promise<void>;
  /** The raw log of a failing check, when its link names a job this platform serves. */
  readCheckLog(worktree: WorktreeRecord, address: PullRequestAddress, check: GitHubCheckDetailRecord): Promise<string | undefined>;
}
