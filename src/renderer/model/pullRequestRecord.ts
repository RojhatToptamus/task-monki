import {
  baseMovedReason,
  formatRemoteWorkNumber,
  gitLabMergeReason,
  remoteWorkLabel,
  type CiRollupRecord,
  type GitHubCheckDetailRecord,
  type MergeSnapshotRecord,
  type PullRequestReviewer,
  type PullRequestSnapshotRecord,
  type RemoteProvider,
  type ReviewRollupRecord
} from '../../shared/contracts';
import { formatElapsed } from './agentSession';
import { baseMovedLine } from './formatting';
import { deliveryEvidenceIdentity } from './prStatus';

/** A gate word's ink: verified, blocked, owed by the person, running, or none. */
export type RecordTone = 'success' | 'error' | 'action' | 'working' | 'neutral';

export interface PullRequestRecordCheckRow extends GitHubCheckDetailRecord {
  /** How long it ran, when it finished: "3m 12s". */
  duration?: string;
}

/**
 * A pull request as the task's record states it, beside the step it needs:
 * where it goes, and each gate a merge waits on, from Task Monki's evidence
 * for the pull request's current head. Nothing here asks for an action; the
 * Now panel does.
 */
export interface PullRequestRecordView {
  /** `#82`, or `!7` for a GitLab merge request. */
  label: string;
  title?: string;
  url?: string;
  state: 'draft' | 'open' | 'merged' | 'closed';
  provider: RemoteProvider;
  head?: string;
  base?: string;
  /** Checks for the current head, failures first. */
  checks?: { summary: string; tone: RecordTone; rows: PullRequestRecordCheckRow[] };
  /** Each reviewer's own state; an app is one that cannot be asked to review again. */
  reviewers: Array<{ name: string; word: string; tone: RecordTone; waiting: boolean; bot?: boolean }>;
  /** The review decision alone, when no reviewer was read. */
  review?: { word: string; tone: RecordTone };
  threads?: { unresolved: number; word: string };
  merge?: { word: string; tone: RecordTone };
}

// Changes requested is the person's to take up, in the waiting tone the board gives it;
// a reviewer still to answer owes the next move, so nothing is asked of the person.
const REVIEWER_WORDS: Record<PullRequestReviewer['state'], { word: string; tone: RecordTone; order: number }> = {
  CHANGES_REQUESTED: { word: 'Changes requested', tone: 'action', order: 0 },
  REQUESTED: { word: 'Waiting', tone: 'neutral', order: 1 },
  APPROVED: { word: 'Approved', tone: 'success', order: 2 },
  COMMENTED: { word: 'Commented', tone: 'neutral', order: 3 }
};

const CHECK_ORDER: Array<GitHubCheckDetailRecord['status']> = ['failed', 'canceled', 'pending', 'skipped', 'passed'];

export function buildPullRequestRecord(input: {
  pullRequest?: PullRequestSnapshotRecord;
  ciRollup?: CiRollupRecord;
  reviewRollup?: ReviewRollupRecord;
  mergeSnapshot?: MergeSnapshotRecord;
  provider?: RemoteProvider;
  /** A head just pushed whose checks have not had time to register. */
  checksNotReported?: boolean;
}): PullRequestRecordView | undefined {
  const { pullRequest } = input;
  if (!pullRequest || (!pullRequest.number && !pullRequest.url)) return undefined;
  const provider = input.provider ?? 'GITHUB';
  const state = pullRequest.status === 'MERGED' ? 'merged'
    : pullRequest.status === 'CLOSED_UNMERGED' ? 'closed'
      : pullRequest.status === 'OPEN_DRAFT' || pullRequest.isDraft ? 'draft' : 'open';
  const current = <T extends { headSha?: string; pullRequestNumber?: number }>(record: T | undefined) =>
    record && deliveryEvidenceIdentity(pullRequest, record) === 'CURRENT' ? record : undefined;
  const open = state === 'draft' || state === 'open';
  const feedback = input.reviewRollup?.pullRequestNumber === pullRequest.number ? input.reviewRollup?.feedback : undefined;
  const reviewers = (feedback?.reviewers ?? [])
    .map((reviewer) => ({ name: reviewer.name, bot: reviewer.bot, waiting: reviewer.state === 'REQUESTED', ...REVIEWER_WORDS[reviewer.state] }))
    .sort((left, right) => left.order - right.order)
    .map(({ name, word, tone, waiting, bot }) => ({ name, word, tone, waiting, ...(bot ? { bot } : {}) }));
  return {
    label: pullRequest.number ? formatRemoteWorkNumber(provider, 'PULL_REQUEST', pullRequest.number) : remoteWorkLabel(provider, 'PULL_REQUEST'),
    ...(pullRequest.title?.trim() ? { title: pullRequest.title.trim() } : {}),
    ...(pullRequest.url ? { url: pullRequest.url } : {}),
    state,
    provider,
    ...(pullRequest.headRefName ? { head: pullRequest.headRefName } : {}),
    ...(pullRequest.baseRefName ? { base: pullRequest.baseRefName } : {}),
    // A merged or closed pull request's checks and threads no longer ask anything.
    ...(open ? checksOf(input.ciRollup, current(input.ciRollup), input.checksNotReported) : {}),
    reviewers: open ? reviewers : [],
    ...(open && reviewers.length === 0 ? reviewOf(current(input.reviewRollup)) : {}),
    ...(open && feedback && feedback.discussionCount > 0 ? {
      threads: {
        unresolved: feedback.unresolvedCount,
        word: feedback.unresolvedCount > 0 ? `${feedback.unresolvedCount} unresolved` : 'All resolved'
      }
    } : {}),
    ...mergeOf(pullRequest, current(input.mergeSnapshot), provider === 'GITLAB')
  };
}

function checksOf(
  rollup: CiRollupRecord | undefined,
  current: CiRollupRecord | undefined,
  notReported = false
): Pick<PullRequestRecordView, 'checks'> {
  if (!rollup) return {};
  if (!current) return { checks: { summary: 'From an earlier head', tone: 'neutral', rows: [] } };
  if (notReported && current.status === 'NO_CHECKS' && current.totalCount === 0) {
    return { checks: { summary: 'Not reported yet', tone: 'neutral', rows: [] } };
  }
  const rows = [...current.checkDetails]
    .sort((left, right) => CHECK_ORDER.indexOf(left.status) - CHECK_ORDER.indexOf(right.status))
    .map((check) => {
      const duration = checkDuration(check.startedAt, check.completedAt);
      return duration ? { ...check, duration } : check;
    });
  // The rollup counts every check; the stored rows are bounded.
  const counts = {
    failed: current.failingCount,
    canceled: current.canceledCount,
    pending: current.pendingCount,
    passed: current.passingCount,
    skipped: current.skippedCount
  };
  const parts = [
    counts.failed ? `${counts.failed} failed` : '',
    counts.canceled ? `${counts.canceled} canceled` : '',
    counts.pending ? `${counts.pending} pending` : '',
    counts.passed ? `${counts.passed} passed` : '',
    // Skipped checks count only when nothing else ran.
    !counts.failed && !counts.canceled && !counts.pending && !counts.passed && counts.skipped ? `${counts.skipped} skipped` : ''
  ].filter(Boolean);
  // Failures are blocked, checks in flight are running work, and a canceled or skipped one asks nothing.
  const tone: RecordTone = counts.failed ? 'error' : counts.pending ? 'working' : counts.canceled ? 'neutral' : counts.passed ? 'success' : 'neutral';
  return { checks: { summary: parts.join(', ') || 'None', tone, rows } };
}

function reviewOf(rollup: ReviewRollupRecord | undefined): Pick<PullRequestRecordView, 'review'> {
  switch (rollup?.status) {
    case 'APPROVED':
    case 'SATISFIED':
      return { review: { word: 'Approved', tone: 'success' } };
    case 'CHANGES_REQUESTED':
      return { review: { word: 'Changes requested', tone: 'action' } };
    case 'REQUESTED':
    case 'PENDING':
      return { review: { word: 'Required', tone: 'neutral' } };
    default:
      return {};
  }
}

function mergeOf(
  pullRequest: PullRequestSnapshotRecord,
  merge: MergeSnapshotRecord | undefined,
  gitLab: boolean
): Pick<PullRequestRecordView, 'merge'> {
  if (pullRequest.status === 'MERGED' || merge?.status === 'MERGED') {
    const at = formatDay(pullRequest.mergedAt ?? merge?.mergedAt ?? undefined);
    return { merge: { word: at ? `Merged ${at}` : 'Merged', tone: 'success' } };
  }
  if (pullRequest.status === 'CLOSED_UNMERGED' || merge?.status === 'CLOSED_UNMERGED') {
    return { merge: { word: 'Closed without merge', tone: 'neutral' } };
  }
  if (!merge) return {};
  const raw = (merge.raw && typeof merge.raw === 'object' ? merge.raw : {}) as Record<string, unknown>;
  const base = pullRequest.baseRefName;
  // A base that moved reads the same on both platforms, and as the Now panel and the Inbox say it.
  const moved = merge.status === 'BLOCKED' ? baseMovedReason(raw) : undefined;
  if (moved) return { merge: { word: baseMovedLine(moved, base), tone: 'error' } };
  switch (merge.status) {
    case 'MERGEABLE':
      return { merge: { word: 'No conflicts', tone: 'success' } };
    case 'BLOCKED':
      return { merge: { word: 'Blocked', tone: 'error' } };
    case 'NOT_MERGED': {
      // GitLab names its reason, which the draft state, the reviews, the checks or the threads may already state.
      if (gitLab) {
        const word = gitLabMergeReason(raw.detailed_merge_status)?.gate;
        return word ? { merge: { word, tone: 'neutral' } } : {};
      }
      // A draft is its own state; branch rules hold the rest until their checks and reviews are met.
      const mergeState = typeof raw.mergeStateStatus === 'string' ? raw.mergeStateStatus.toUpperCase() : '';
      return mergeState === 'DRAFT' || pullRequest.isDraft ? {} : { merge: { word: 'Waiting on branch rules', tone: 'neutral' } };
    }
    case 'COMPUTING':
      return { merge: { word: 'Checking', tone: 'neutral' } };
    default:
      return {};
  }
}

function checkDuration(startedAt?: string, completedAt?: string): string | undefined {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const completed = completedAt ? Date.parse(completedAt) : NaN;
  // GitHub reports a time it does not have as year one; that is no time at all.
  if (!(started > 0) || !(completed > 0) || completed < started) return undefined;
  return formatElapsed(completed - started);
}

function formatDay(value: string | undefined): string | undefined {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp))
    : undefined;
}

/** A check the platform can run again from here: a GitHub Actions job, or a GitLab job. */
export function rerunnableCheck(link: string | undefined, pullRequestUrl: string | undefined): boolean {
  const job = /^(https:\/\/[^/]+\/.+?)\/(?:actions\/runs\/\d+\/job\/\d+|-\/jobs\/\d+)(?:[/?#]|$)/u.exec(link ?? '');
  const repository = /^(https:\/\/[^/]+\/.+?)\/(?:pull\/\d+|-\/merge_requests\/\d+)(?:[/?#]|$)/u.exec(pullRequestUrl ?? '');
  // Only a job of the pull request's own repository: one elsewhere is not its to re-run.
  return Boolean(job && repository && job[1]!.toLowerCase() === repository[1]!.toLowerCase());
}
