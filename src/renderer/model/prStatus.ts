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

export type PrStatusActionPauseReason =
  | 'review-starting'
  | 'review-running'
  | 'implementation-running';

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
  guidanceLine?: string;
  leadLine?: string;
  refreshedLine?: string;
  checkGroups: PrCheckGroup[];
  canCreateDraftPr: boolean;
  canRefresh: boolean;
  canInvestigateFailure: boolean;
  canPushUpdate: boolean;
  createDraftPrDisabledReason?: string;
  pushUpdateDisabledReason?: string;
}

export interface PrStatusActionState {
  refreshDisabled: boolean;
  createOrPushDisabled: boolean;
  investigateDisabled: boolean;
  refreshReason?: string;
  createOrPushReason?: string;
  investigateReason?: string;
  hint?: string;
}

export interface PrCheckGroup {
  status: GitHubCheckDetailRecord['status'];
  label: string;
  checks: GitHubCheckDetailRecord[];
  defaultOpen: boolean;
}

export function buildPrStatusActionState(input: {
  view: PrStatusViewModel;
  deliveryBusy?: boolean;
  pauseReason?: PrStatusActionPauseReason;
  hasInvestigationSource?: boolean;
}): PrStatusActionState {
  const busyReason = input.deliveryBusy ? 'GitHub action is in progress.' : undefined;
  const mutationPauseReason = busyReason ?? prStatusPauseText(input.pauseReason);
  const missingInvestigationSource =
    input.view.canInvestigateFailure && !input.hasInvestigationSource
      ? 'No completed run is available.'
      : undefined;
  const createOrPushReason =
    mutationPauseReason ??
    (input.view.canCreateDraftPr
      ? input.view.createDraftPrDisabledReason
      : input.view.canPushUpdate
        ? input.view.pushUpdateDisabledReason
        : undefined);
  const investigateReason = mutationPauseReason ?? missingInvestigationSource;
  return {
    refreshDisabled: Boolean(input.deliveryBusy),
    createOrPushDisabled: Boolean(createOrPushReason),
    investigateDisabled: Boolean(investigateReason),
    refreshReason: busyReason,
    createOrPushReason,
    investigateReason,
    hint:
      mutationPauseReason &&
      (input.view.canCreateDraftPr || input.view.canPushUpdate || input.view.canInvestigateFailure)
        ? mutationPauseReason
        : createOrPushReason ?? missingInvestigationSource
  };
}

function prStatusPauseText(reason: PrStatusActionPauseReason | undefined): string | undefined {
  switch (reason) {
    case 'review-starting':
      return 'Delivery actions pause while review starts.';
    case 'review-running':
      return 'Delivery actions pause while review runs.';
    case 'implementation-running':
      return 'Delivery actions pause while the agent runs.';
    default:
      return undefined;
  }
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
    const createDraftPr = createDraftPrAvailability(task, gitSnapshot, branchPublication);
    return {
      kind: 'NO_PR',
      headline: 'No PR',
      tone: 'neutral',
      hasPullRequest: false,
      leadLine: createDraftPr.line,
      canCreateDraftPr: createDraftPr.showAction,
      canRefresh: false,
      canInvestigateFailure: false,
      canPushUpdate: false,
      createDraftPrDisabledReason: createDraftPr.disabledReason,
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
    if (terminal.kind === 'CLOSED_UNMERGED') {
      const createDraftPr = createDraftPrAvailability(task, gitSnapshot, branchPublication);
      return {
        ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
        ...terminal,
        guidanceLine: createDraftPr.line,
        canCreateDraftPr: createDraftPr.showAction,
        createDraftPrDisabledReason: createDraftPr.disabledReason
      };
    }
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
      canPushUpdate: freshness.kind === 'LOCAL_NOT_PUSHED',
      pushUpdateDisabledReason: freshness.pushUpdateDisabledReason
    };
  }

  const checksStatus = checksToStatus(ciRollup);
  if (checksStatus) {
    return {
      ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
      ...checksStatus,
      guidanceLine:
        checksStatus.kind === 'CHECKS_FAILED'
          ? formatFailingChecksGuidance(ciRollup)
          : undefined
    };
  }

  const reviewStatus = reviewToStatus(reviewRollup);
  if (reviewStatus) {
    return {
      ...baseStatus(pullRequest, checkGroups, checkSummaryLine),
      ...reviewStatus
    };
  }

  const ready = isReadyToMerge(pullRequest, ciRollup, reviewRollup, mergeSnapshot);
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
      canInvestigateFailure: ciRollup?.status === 'FAILING' || ciRollup?.status === 'BLOCKED',
      canPushUpdate: false
    };
  }
}

function createDraftPrAvailability(
  task: Task,
  gitSnapshot?: GitSnapshotRecord,
  branchPublication?: BranchPublicationRecord
): { showAction: boolean; line?: string; disabledReason?: string } {
  if (task.projection.worktree !== 'PRESENT') {
    return {
      showAction: false,
      line: 'A worktree is required before a draft PR can be opened.',
      disabledReason: 'A worktree is required before a draft PR can be opened.'
    };
  }

  if (branchPublication?.status === 'PUSHING') {
    return {
      showAction: true,
      line: 'Branch publication is already in progress.',
      disabledReason: 'Branch publication is already in progress.'
    };
  }
  if (branchPublication?.status === 'FAILED' && branchPublication.error) {
    if (isRemoteNewerPublicationError(branchPublication.error)) {
      return {
        showAction: true,
        line: branchPublication.error,
        disabledReason: branchPublication.error
      };
    }
    return {
      showAction: true,
      line: `Last push failed: ${branchPublication.error}`
    };
  }

  if (!gitSnapshot) {
    switch (task.projection.git) {
      case 'DIRTY':
      case 'COMMITTED_UNPUSHED':
      case 'PUSHED':
        return { showAction: true };
      case 'CLEAN':
        return {
          showAction: true,
          line: 'Run implementation or make a task change before opening a PR.',
          disabledReason: 'Run implementation or make a task change before opening a PR.'
        };
      case 'CONFLICTED':
        return {
          showAction: true,
          line: 'Resolve Git conflicts before opening a PR.',
          disabledReason: 'Resolve Git conflicts before opening a PR.'
        };
      case 'DIVERGED':
        return {
          showAction: true,
          line: 'Sync the branch before opening a PR.',
          disabledReason: 'Sync the branch before opening a PR.'
        };
      case 'UNAVAILABLE':
      case 'UNKNOWN':
        return {
          showAction: true,
          line: 'Git status must be available before opening a PR.',
          disabledReason: 'Git status must be available before opening a PR.'
        };
      case 'NOT_INSPECTED':
        return {
          showAction: true,
          line: 'Refresh Git evidence before opening a PR.',
          disabledReason: 'Refresh Git evidence before opening a PR.'
        };
    }
  }

  if (gitSnapshot.conflictedCount > 0 || gitSnapshot.status === 'CONFLICTED') {
    return {
      showAction: true,
      line: 'Resolve Git conflicts before opening a PR.',
      disabledReason: 'Resolve Git conflicts before opening a PR.'
    };
  }
  if (gitSnapshot.status === 'DIVERGED' || gitSnapshot.behindCount > 0) {
    return {
      showAction: true,
      line: 'Sync the branch before opening a PR.',
      disabledReason: 'Sync the branch before opening a PR.'
    };
  }
  if (gitSnapshot.status === 'UNAVAILABLE' || gitSnapshot.status === 'UNKNOWN') {
    return {
      showAction: true,
      line: 'Git status must be available before opening a PR.',
      disabledReason: 'Git status must be available before opening a PR.'
    };
  }

  const workingChangeCount =
    gitSnapshot.stagedCount +
    gitSnapshot.unstagedCount +
    gitSnapshot.untrackedCount +
    gitSnapshot.workingDiffFileCount;
  const hasCommittedTaskDiff =
    gitSnapshot.commitsAheadOfBase > 0 && gitSnapshot.committedDiffFileCount > 0;
  if (workingChangeCount > 0 || hasCommittedTaskDiff) {
    return { showAction: true };
  }

  return {
    showAction: true,
    line: 'Run implementation or make a task change before opening a PR.',
    disabledReason: 'Run implementation or make a task change before opening a PR.'
  };
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
}): { kind?: PrStatusKind; line?: string; pushUpdateDisabledReason?: string } {
  const { gitSnapshot, branchPublication, pullRequest, ciRollup, reviewRollup, mergeSnapshot } = input;
  const prHead = pullRequest.headRefOid;
  const staleEvidence = [ciRollup?.headSha, reviewRollup?.headSha, mergeSnapshot?.headSha].some(
    (headSha) => Boolean(headSha && prHead && headSha !== prHead)
  );
  if (branchPublication?.status === 'FAILED' && branchPublication.error) {
    if (isRemoteNewerPublicationError(branchPublication.error)) {
      return {
        kind: 'BRANCH_DIVERGED',
        line: branchPublication.error
      };
    }
    return {
      kind: 'LOCAL_NOT_PUSHED',
      line: `Last push failed: ${branchPublication.error}`
    };
  }
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

function formatFailingChecksGuidance(ciRollup?: CiRollupRecord): string | undefined {
  const failingChecks = (ciRollup?.checkDetails ?? []).filter((check) => check.status === 'failed');
  const failingCount = ciRollup?.failingCount ?? failingChecks.length;
  if (ciRollup?.status === 'BLOCKED' && failingCount === 0 && failingChecks.length === 0) {
    return 'GitHub checks are blocked. Investigate the failure, fix the branch, then push an update.';
  }
  const first = failingChecks[0];
  const firstLabel = first
    ? `${first.name}${first.workflow ? ` in ${first.workflow}` : ''}`
    : undefined;
  const subject =
    failingCount > 1
      ? `${failingCount} checks failed${firstLabel ? `; start with ${firstLabel}` : ''}`
      : `${firstLabel ?? 'A GitHub check'} failed`;
  const description = first?.description?.trim();
  const detail = description ? `: ${sentenceCase(description)}` : '.';
  return `${subject}${detail} Investigate the failure, fix the branch, then push an update.`;
}

function isRemoteNewerPublicationError(error: string | undefined): boolean {
  return Boolean(error?.toLowerCase().includes('newer commits'));
}

function sentenceCase(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
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
  pullRequest: PullRequestSnapshotRecord,
  ciRollup?: CiRollupRecord,
  reviewRollup?: ReviewRollupRecord,
  mergeSnapshot?: MergeSnapshotRecord
): boolean {
  if (
    pullRequest.status !== 'OPEN_READY' ||
    pullRequest.isDraft ||
    !ciRollup ||
    !reviewRollup ||
    !mergeSnapshot ||
    !evidenceMatchesPullRequestHead(pullRequest, ciRollup, reviewRollup, mergeSnapshot)
  ) {
    return false;
  }
  const checksSatisfied = ciRollup.status === 'PASSING';
  const reviewSatisfied =
    ['APPROVED', 'SATISFIED', 'NOT_REQUESTED', 'NOT_APPLICABLE'].includes(reviewRollup.status);
  return checksSatisfied && reviewSatisfied && mergeSnapshot?.status === 'MERGEABLE';
}

function evidenceMatchesPullRequestHead(
  pullRequest: PullRequestSnapshotRecord,
  ciRollup: CiRollupRecord,
  reviewRollup: ReviewRollupRecord,
  mergeSnapshot: MergeSnapshotRecord
): boolean {
  const prHead = pullRequest.headRefOid;
  if (!prHead || typeof pullRequest.number !== 'number') {
    return false;
  }
  const rows = [ciRollup, reviewRollup, mergeSnapshot];
  return rows.every(
    (row) => row?.headSha === prHead && row.pullRequestNumber === pullRequest.number
  );
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
        defaultOpen: false
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
