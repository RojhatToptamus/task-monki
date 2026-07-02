import type {
  BranchPublicationRecord,
  CiRollupRecord,
  GitHubCheckDetailRecord,
  GitSnapshotRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  Task
} from '../../shared/contracts';

export type PrStatusTone = 'neutral' | 'info' | 'action' | 'success' | 'error';

export type PrStatusKind =
  | 'NO_PR'
  | 'DRAFT'
  | 'OPEN'
  | 'CHECKS_PENDING'
  | 'CHECKS_FAILED'
  | 'CHECKS_CANCELED'
  | 'NO_REQUIRED_CHECKS'
  | 'GITHUB_REVIEW_WAITING'
  | 'GITHUB_CHANGES_REQUESTED'
  | 'READY_TO_MERGE'
  | 'MERGED'
  | 'CLOSED_UNMERGED'
  | 'STALE'
  | 'LOCAL_NOT_PUSHED'
  | 'PR_NEWER_COMMITS'
  | 'BRANCH_DIVERGED'
  | 'UNKNOWN';

export interface PrStatusViewModel {
  kind: PrStatusKind;
  headline: string;
  tone: PrStatusTone;
  hasPullRequest: boolean;
  prNumber?: number;
  prUrl?: string;
  prHeadSha?: string;
  headRefName?: string;
  baseRefName?: string;
  checkSummaryLine?: string;
  reviewLine?: string;
  mergeLine?: string;
  freshnessLine?: string;
  leadLine?: string;
  refreshedLine?: string;
  checkGroups: PrCheckGroup[];
  canCreateDraftPr: boolean;
  canRefresh: boolean;
  canInvestigateFailure: boolean;
  canPushUpdate: boolean;
}

export interface PrCheckGroup {
  status: GitHubCheckDetailRecord['status'];
  label: string;
  checks: GitHubCheckDetailRecord[];
  defaultOpen: boolean;
}

export function buildPrStatusViewModel(input: {
  task: Task;
  gitSnapshot?: GitSnapshotRecord;
  branchPublication?: BranchPublicationRecord;
  pullRequest?: PullRequestSnapshotRecord;
  ciRollup?: CiRollupRecord;
  reviewRollup?: ReviewRollupRecord;
  mergeSnapshot?: MergeSnapshotRecord;
}): PrStatusViewModel {
  const {
    task,
    gitSnapshot,
    branchPublication,
    pullRequest,
    ciRollup,
    reviewRollup,
    mergeSnapshot
  } = input;
  const hasPullRequest = Boolean(pullRequest?.number || pullRequest?.url);

  if (!hasPullRequest || !pullRequest) {
    const canCreateDraftPr = task.projection.worktree === 'PRESENT';
    return {
      kind: 'NO_PR',
      headline: 'No PR',
      tone: 'neutral',
      hasPullRequest: false,
      leadLine: canCreateDraftPr
        ? undefined
        : 'A worktree is required before a draft PR can be opened.',
      canCreateDraftPr,
      canRefresh: false,
      canInvestigateFailure: false,
      canPushUpdate: false,
      checkGroups: []
    };
  }

  const freshness = deriveFreshness({
    gitSnapshot,
    branchPublication,
    pullRequest,
    ciRollup,
    reviewRollup,
    mergeSnapshot
  });
  const checkGroups = groupChecks(ciRollup?.checkDetails ?? []);
  const checkSummaryLine = formatCheckSummary(ciRollup);
  const reviewLine = formatReviewLine(reviewRollup);
  const mergeLine = formatMergeLine(mergeSnapshot);
  const terminal = terminalPrStatus(pullRequest, mergeSnapshot);

  if (terminal) {
    return {
      ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
      ...terminal
    };
  }

  const freshnessStatus = freshnessToStatus(freshness);
  if (freshnessStatus) {
    return {
      ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
      ...freshnessStatus,
      freshnessLine: freshness.line,
      canPushUpdate: freshness.kind === 'LOCAL_NOT_PUSHED'
    };
  }

  const checksStatus = checksToStatus(ciRollup);
  if (checksStatus) {
    return {
      ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
      ...checksStatus
    };
  }

  const reviewStatus = reviewToStatus(reviewRollup);
  if (reviewStatus) {
    return {
      ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
      ...reviewStatus
    };
  }

  const ready = isReadyToMerge(ciRollup, reviewRollup, mergeSnapshot);
  if (ready) {
    return {
      ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
      kind: 'READY_TO_MERGE',
      headline: 'Ready to merge',
      tone: 'success',
      reviewLine,
      mergeLine
    };
  }

  return {
    ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
    kind: pullRequest.isDraft ? 'DRAFT' : 'OPEN',
    headline: pullRequest.isDraft ? 'Draft PR' : 'Open PR',
    tone: pullRequest.isDraft ? 'info' : 'neutral'
  };

  function baseStatus(
    pr: PullRequestSnapshotRecord,
    groups: PrCheckGroup[],
    summaryLine?: string
  ): PrStatusViewModel {
    return {
      kind: 'UNKNOWN',
      headline: 'Unknown',
      tone: 'neutral',
      hasPullRequest: true,
      prNumber: pr.number,
      prUrl: pr.url,
      prHeadSha: pr.headRefOid,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      checkSummaryLine: summaryLine,
      refreshedLine: formatRefreshLine(pr.observedAt),
      checkGroups: groups,
      canCreateDraftPr: false,
      canRefresh: true,
      canInvestigateFailure: ciRollup?.status === 'FAILING',
      canPushUpdate: false
    };
  }
}

export function buildBoardDeliveryLine(task: Task): string {
  const number = task.projection.githubPullRequestNumber;
  const prefix =
    task.projection.githubPullRequest === 'UNLINKED' ||
    task.projection.githubPullRequest === 'NOT_CREATED'
      ? 'No PR'
      : number
        ? `PR #${number}`
        : 'PR';
  if (prefix === 'No PR') {
    return prefix;
  }
  const status = boardDeliveryStatus(task);
  return status ? `${prefix} | ${status}` : prefix;
}

export function buildFailingChecksInvestigationPrompt(view: PrStatusViewModel): string {
  const failingChecks = view.checkGroups
    .find((group) => group.status === 'failed')
    ?.checks ?? [];
  const checkLines = failingChecks.length
    ? failingChecks.map(
        (check) =>
          `- ${check.name}${check.workflow ? ` (${check.workflow})` : ''}: ${[
            `status ${check.state ?? check.status}`,
            check.event ? `event ${check.event}` : undefined,
            check.startedAt ? `started ${check.startedAt}` : undefined,
            check.completedAt ? `completed ${check.completedAt}` : undefined,
            check.link ?? 'no link available'
          ]
            .filter((part): part is string => Boolean(part))
            .join(' | ')}`
      )
    : ['- Failing check details were not available from gh pr checks.'];
  return [
    `Investigate the failing GitHub checks for PR #${view.prNumber ?? 'unknown'} at head ${view.prHeadSha?.slice(0, 12) ?? 'unknown'}.`,
    view.prUrl ? `PR URL: ${view.prUrl}` : undefined,
    view.headRefName && view.baseRefName ? `Branch: ${view.headRefName} -> ${view.baseRefName}` : undefined,
    '',
    'Focus on these failing checks:',
    ...checkLines,
    '',
    'Inspect the current worktree, identify likely causes, make local fixes if needed, and summarize what changed. Do not push unless the user approves.'
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function terminalPrStatus(
  pullRequest: PullRequestSnapshotRecord,
  mergeSnapshot?: MergeSnapshotRecord
): Pick<PrStatusViewModel, 'kind' | 'headline' | 'tone'> | undefined {
  if (pullRequest.status === 'MERGED' || mergeSnapshot?.status === 'MERGED') {
    return {
      kind: 'MERGED',
      headline: 'Merged',
      tone: 'success'
    };
  }
  if (pullRequest.status === 'CLOSED_UNMERGED' || mergeSnapshot?.status === 'CLOSED_UNMERGED') {
    return {
      kind: 'CLOSED_UNMERGED',
      headline: 'Closed without merge',
      tone: 'error'
    };
  }
  return undefined;
}

function deriveFreshness(input: {
  gitSnapshot?: GitSnapshotRecord;
  branchPublication?: BranchPublicationRecord;
  pullRequest: PullRequestSnapshotRecord;
  ciRollup?: CiRollupRecord;
  reviewRollup?: ReviewRollupRecord;
  mergeSnapshot?: MergeSnapshotRecord;
}): { kind?: PrStatusKind; line?: string } {
  const { gitSnapshot, branchPublication, pullRequest, ciRollup, reviewRollup, mergeSnapshot } = input;
  const prHead = pullRequest.headRefOid;
  const staleEvidence = [ciRollup?.headSha, reviewRollup?.headSha, mergeSnapshot?.headSha].some(
    (headSha) => Boolean(headSha && prHead && headSha !== prHead)
  );
  if (
    gitSnapshot?.status === 'DIVERGED' ||
    ((gitSnapshot?.aheadCount ?? 0) > 0 && (gitSnapshot?.behindCount ?? 0) > 0)
  ) {
    return {
      kind: 'BRANCH_DIVERGED',
      line: 'Local branch and PR branch both changed.'
    };
  }
  if (staleEvidence) {
    return {
      kind: 'STALE',
      line: `Refresh PR status for the current head.`
    };
  }
  const hasDirtyLocalChanges =
    (gitSnapshot?.stagedCount ?? 0) +
      (gitSnapshot?.unstagedCount ?? 0) +
      (gitSnapshot?.untrackedCount ?? 0) >
    0;
  if (hasDirtyLocalChanges) {
    return {
      kind: 'LOCAL_NOT_PUSHED',
      line: 'Local worktree has uncommitted changes.'
    };
  }
  const localHead = gitSnapshot?.headSha;
  if (localHead && prHead && localHead !== prHead) {
    if (gitSnapshot.status === 'COMMITTED_UNPUSHED' || branchPublication?.headSha !== localHead) {
      return {
        kind: 'LOCAL_NOT_PUSHED',
        line: 'Local branch has newer commits.'
      };
    }
    return {
      kind: 'PR_NEWER_COMMITS',
      line: 'This worktree is behind the PR.'
    };
  }
  return {};
}

function freshnessToStatus(
  freshness: { kind?: PrStatusKind; line?: string }
): Pick<PrStatusViewModel, 'kind' | 'headline' | 'tone'> | undefined {
  switch (freshness.kind) {
    case 'BRANCH_DIVERGED':
      return { kind: 'BRANCH_DIVERGED', headline: 'Branch diverged', tone: 'error' };
    case 'STALE':
      return { kind: 'STALE', headline: 'Stale', tone: 'action' };
    case 'LOCAL_NOT_PUSHED':
      return { kind: 'LOCAL_NOT_PUSHED', headline: 'Local changes not pushed', tone: 'action' };
    case 'PR_NEWER_COMMITS':
      return { kind: 'PR_NEWER_COMMITS', headline: 'PR has newer commits', tone: 'action' };
    default:
      return undefined;
  }
}

function checksToStatus(
  ciRollup?: CiRollupRecord
): Pick<PrStatusViewModel, 'kind' | 'headline' | 'tone'> | undefined {
  switch (ciRollup?.status) {
    case 'FAILING':
    case 'BLOCKED':
      return { kind: 'CHECKS_FAILED', headline: 'Checks failed', tone: 'error' };
    case 'PENDING':
      return { kind: 'CHECKS_PENDING', headline: 'Checks pending', tone: 'action' };
    case 'CANCELED':
      return { kind: 'CHECKS_CANCELED', headline: 'Checks canceled', tone: 'action' };
    case 'NO_CHECKS':
      return ciRollup.totalCount > 0
        ? { kind: 'NO_REQUIRED_CHECKS', headline: 'No required checks ran', tone: 'action' }
        : undefined;
    default:
      return undefined;
  }
}

function reviewToStatus(
  reviewRollup?: ReviewRollupRecord
): Pick<PrStatusViewModel, 'kind' | 'headline' | 'tone'> | undefined {
  if (reviewRollup?.status === 'CHANGES_REQUESTED') {
    return { kind: 'GITHUB_CHANGES_REQUESTED', headline: 'GitHub changes requested', tone: 'error' };
  }
  if (reviewRollup?.status === 'REQUESTED' || reviewRollup?.status === 'PENDING') {
    return { kind: 'GITHUB_REVIEW_WAITING', headline: 'GitHub review waiting', tone: 'action' };
  }
  return undefined;
}

function isReadyToMerge(
  ciRollup?: CiRollupRecord,
  reviewRollup?: ReviewRollupRecord,
  mergeSnapshot?: MergeSnapshotRecord
): boolean {
  const checksSatisfied = !ciRollup || ciRollup.status === 'PASSING';
  const reviewSatisfied =
    !reviewRollup ||
    ['APPROVED', 'SATISFIED', 'NOT_REQUESTED', 'NOT_APPLICABLE'].includes(reviewRollup.status);
  return checksSatisfied && reviewSatisfied && mergeSnapshot?.status === 'MERGEABLE';
}

function formatCheckSummary(ciRollup?: CiRollupRecord): string | undefined {
  if (!ciRollup) {
    return undefined;
  }
  if (ciRollup.status === 'PASSING') {
    return undefined;
  }
  const parts = [
    countPart(ciRollup.failingCount, 'failed'),
    countPart(ciRollup.canceledCount, 'canceled'),
    countPart(ciRollup.pendingCount, 'pending'),
    countPart(ciRollup.skippedCount, 'skipped'),
    countPart(ciRollup.passingCount, 'passed')
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return 'No checks reported';
  }
  return parts.join(' · ');
}

function formatReviewLine(reviewRollup?: ReviewRollupRecord): string | undefined {
  switch (reviewRollup?.status) {
    case 'APPROVED':
    case 'SATISFIED':
      return 'Approved';
    default:
      return undefined;
  }
}

function formatMergeLine(mergeSnapshot?: MergeSnapshotRecord): string | undefined {
  switch (mergeSnapshot?.status) {
    case 'MERGEABLE':
      return 'Mergeable';
    default:
      return undefined;
  }
}

function formatRefreshLine(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function groupChecks(checks: GitHubCheckDetailRecord[]): PrCheckGroup[] {
  const order: Array<GitHubCheckDetailRecord['status']> = [
    'failed',
    'canceled',
    'pending',
    'skipped',
    'passed'
  ];
  return order
    .map((status) => {
      const rows = checks.filter((check) => check.status === status);
      return {
        status,
        label: checkGroupLabel(status, rows.length),
        checks: rows,
        defaultOpen: status === 'failed' && rows.length > 0
      };
    })
    .filter((group) => group.checks.length > 0);
}

function checkGroupLabel(status: GitHubCheckDetailRecord['status'], count: number): string {
  const label =
    status === 'passed'
      ? 'successful'
      : status === 'failed'
        ? 'failed'
        : status;
  return `${count} ${label}`;
}

function countPart(count: number | undefined, label: string): string | undefined {
  return count && count > 0 ? `${count} ${label}` : undefined;
}

function boardDeliveryStatus(task: Task): string | undefined {
  if (task.projection.merge === 'MERGED' || task.projection.githubPullRequest === 'MERGED') {
    return 'merged';
  }
  if (
    task.projection.merge === 'CLOSED_UNMERGED' ||
    task.projection.githubPullRequest === 'CLOSED_UNMERGED'
  ) {
    return 'closed';
  }
  if (task.projection.ciChecks === 'FAILING' || task.projection.ciChecks === 'BLOCKED') {
    return 'checks failing';
  }
  if (task.projection.ciChecks === 'PENDING') {
    return 'checks pending';
  }
  if (task.projection.ciChecks === 'CANCELED') {
    return 'checks canceled';
  }
  if (task.projection.reviews === 'CHANGES_REQUESTED') {
    return 'changes requested';
  }
  if (task.projection.reviews === 'REQUESTED' || task.projection.reviews === 'PENDING') {
    return 'review waiting';
  }
  if (task.projection.ciChecks === 'PASSING' && task.projection.merge === 'MERGEABLE') {
    return 'ready to merge';
  }
  if (task.projection.githubPullRequest === 'OPEN_DRAFT') {
    return 'draft';
  }
  if (task.projection.githubPullRequest === 'OPEN_READY') {
    return 'open';
  }
  return undefined;
}
