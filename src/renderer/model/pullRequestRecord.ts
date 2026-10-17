import {
  baseMovedReason,
  type CiRollupRecord,
  type GitHubCheckDetailRecord,
  type MergeSnapshotRecord,
  type PullRequestReviewer,
  type PullRequestSnapshotRecord,
  type RemoteProvider,
  type ReviewRollupRecord
} from '../../shared/contracts';
import { deliveryEvidenceIdentity } from './prStatus';

export type RecordTone = 'success' | 'error' | 'action' | 'neutral';

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
  platform: 'GitHub' | 'GitLab';
  head?: string;
  base?: string;
  /** Checks for the current head, failures first. */
  checks?: { summary: string; tone: RecordTone; rows: PullRequestRecordCheckRow[] };
  /** Each reviewer's own state, when the platform's reviews were read. */
  reviewers: Array<{ name: string; word: string; tone: RecordTone }>;
  /** The review decision alone, when no reviewer was read. */
  review?: { word: string; tone: RecordTone };
  threads?: { unresolved: number; word: string };
  merge?: { word: string; tone: RecordTone };
}

const REVIEWER_WORDS: Record<PullRequestReviewer['state'], { word: string; tone: RecordTone; order: number }> = {
  CHANGES_REQUESTED: { word: 'Changes requested', tone: 'error', order: 0 },
  REQUESTED: { word: 'Waiting', tone: 'action', order: 1 },
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
}): PullRequestRecordView | undefined {
  const { pullRequest } = input;
  if (!pullRequest || (!pullRequest.number && !pullRequest.url)) return undefined;
  const gitLab = input.provider === 'GITLAB';
  const state = pullRequest.status === 'MERGED' ? 'merged'
    : pullRequest.status === 'CLOSED_UNMERGED' ? 'closed'
      : pullRequest.status === 'OPEN_DRAFT' || pullRequest.isDraft ? 'draft' : 'open';
  const current = <T extends { headSha?: string; pullRequestNumber?: number }>(record: T | undefined) =>
    record && deliveryEvidenceIdentity(pullRequest, record) === 'CURRENT' ? record : undefined;
  const open = state === 'draft' || state === 'open';
  const feedback = input.reviewRollup?.pullRequestNumber === pullRequest.number ? input.reviewRollup?.feedback : undefined;
  const reviewers = (feedback?.reviewers ?? [])
    .map((reviewer) => ({ name: reviewer.name, ...REVIEWER_WORDS[reviewer.state] }))
    .sort((left, right) => left.order - right.order)
    .map(({ name, word, tone }) => ({ name, word, tone }));
  return {
    label: pullRequest.number ? `${gitLab ? '!' : '#'}${pullRequest.number}` : gitLab ? 'Merge request' : 'Pull request',
    ...(pullRequest.title?.trim() ? { title: pullRequest.title.trim() } : {}),
    ...(pullRequest.url ? { url: pullRequest.url } : {}),
    state,
    platform: gitLab ? 'GitLab' : 'GitHub',
    ...(pullRequest.headRefName ? { head: pullRequest.headRefName } : {}),
    ...(pullRequest.baseRefName ? { base: pullRequest.baseRefName } : {}),
    // A merged or closed pull request's checks and threads no longer ask anything.
    ...(open ? checksOf(input.ciRollup, current(input.ciRollup)) : {}),
    reviewers: open ? reviewers : [],
    ...(open && reviewers.length === 0 ? reviewOf(current(input.reviewRollup)) : {}),
    ...(open && feedback && feedback.discussionCount > 0 ? {
      threads: {
        unresolved: feedback.unresolvedCount,
        word: feedback.unresolvedCount > 0 ? `${feedback.unresolvedCount} unresolved` : 'All resolved'
      }
    } : {}),
    ...mergeOf(pullRequest, current(input.mergeSnapshot), gitLab)
  };
}

function checksOf(rollup: CiRollupRecord | undefined, current: CiRollupRecord | undefined): Pick<PullRequestRecordView, 'checks'> {
  if (!rollup) return {};
  if (!current) return { checks: { summary: 'From an earlier head', tone: 'neutral', rows: [] } };
  const rows = [...(current.checkDetails ?? [])]
    .sort((left, right) => CHECK_ORDER.indexOf(left.status) - CHECK_ORDER.indexOf(right.status))
    .map((check) => {
      const duration = checkDuration(check.startedAt, check.completedAt);
      return duration ? { ...check, duration } : check;
    });
  const counts = rows.length > 0
    ? {
        failed: rows.filter((row) => row.status === 'failed').length,
        canceled: rows.filter((row) => row.status === 'canceled').length,
        pending: rows.filter((row) => row.status === 'pending').length,
        passed: rows.filter((row) => row.status === 'passed').length,
        skipped: rows.filter((row) => row.status === 'skipped').length
      }
    : {
        failed: current.failingCount,
        canceled: current.canceledCount,
        pending: current.pendingCount,
        passed: current.passingCount,
        skipped: current.skippedCount
      };
  const parts = [
    counts.failed ? `${counts.failed} failed` : '',
    counts.canceled ? `${counts.canceled} canceled` : '',
    counts.pending ? `${counts.pending} running` : '',
    counts.passed ? `${counts.passed} passed` : '',
    // Skipped checks count only when nothing else ran.
    !counts.failed && !counts.canceled && !counts.pending && !counts.passed && counts.skipped ? `${counts.skipped} skipped` : ''
  ].filter(Boolean);
  const tone: RecordTone = counts.failed ? 'error' : counts.canceled || counts.pending ? 'action' : counts.passed ? 'success' : 'neutral';
  return { checks: { summary: parts.join(', ') || 'None', tone, rows } };
}

function reviewOf(rollup: ReviewRollupRecord | undefined): Pick<PullRequestRecordView, 'review'> {
  switch (rollup?.status) {
    case 'APPROVED':
    case 'SATISFIED':
      return { review: { word: 'Approved', tone: 'success' } };
    case 'CHANGES_REQUESTED':
      return { review: { word: 'Changes requested', tone: 'error' } };
    case 'REQUESTED':
    case 'PENDING':
      return { review: { word: 'Required', tone: 'action' } };
    default:
      return {};
  }
}

const GITLAB_NOT_YET: Record<string, string> = {
  draft_status: 'Draft',
  not_approved: 'Needs approval',
  requested_changes: 'Changes requested',
  ci_must_pass: 'Needs a passing pipeline',
  ci_still_running: 'Pipeline running',
  discussions_not_resolved: 'Unresolved threads'
};

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
  if (moved === 'BEHIND') return { merge: { word: base ? `Behind ${base}` : 'Behind its base', tone: 'error' } };
  if (moved === 'CONFLICTS') return { merge: { word: base ? `Conflicts with ${base}` : 'Conflicts', tone: 'error' } };
  if (gitLab) {
    const reason = typeof raw.detailed_merge_status === 'string' ? raw.detailed_merge_status : '';
    if (merge.status === 'MERGEABLE') return { merge: { word: 'No conflicts', tone: 'success' } };
    if (merge.status === 'COMPUTING') return { merge: { word: 'Checking', tone: 'neutral' } };
    const word = GITLAB_NOT_YET[reason];
    return word ? { merge: { word, tone: merge.status === 'BLOCKED' ? 'error' : 'neutral' } }
      : merge.status === 'BLOCKED' ? { merge: { word: 'Blocked', tone: 'error' } } : {};
  }
  const mergeState = typeof raw.mergeStateStatus === 'string' ? raw.mergeStateStatus.toUpperCase() : '';
  switch (merge.status) {
    case 'MERGEABLE':
      return { merge: { word: 'No conflicts', tone: 'success' } };
    case 'BLOCKED':
      return { merge: { word: 'Blocked', tone: 'error' } };
    case 'NOT_MERGED':
      // A draft is its own state; branch rules hold the rest until their checks and reviews are met.
      return mergeState === 'DRAFT' || pullRequest.isDraft ? {} : { merge: { word: 'Waiting on branch rules', tone: 'neutral' } };
    case 'COMPUTING':
      return { merge: { word: 'Checking', tone: 'neutral' } };
    default:
      return {};
  }
}

function checkDuration(startedAt?: string, completedAt?: string): string | undefined {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const completed = completedAt ? Date.parse(completedAt) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return undefined;
  const seconds = Math.round((completed - started) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function formatDay(value: string | undefined): string | undefined {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp))
    : undefined;
}
