import type {
  CiRollupRecord,
  GitHubRepositoryRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
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
}

/**
 * A platform's pull or merge request delivery. Git pushes stay with Git; this is
 * what the platform's CLI does: readiness, creation, lookup and status.
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
}
