import type {
  BranchPublicationRecord,
  CiRollupRecord,
  GitHubCheckDetailRecord,
  GitSnapshotRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  WorktreeRecord,
  Task
} from '../../shared/contracts';
import { baseMovedReason, getImplementationRetryReason, pullRequestRewrittenUnder, remoteProviderName, type RemoteProvider } from '../../shared/contracts';
import { deliveryWords } from './deliveryWords';
import { baseMovedLine, pluralize } from './formatting';
import { pullRequestFeedbackLine, reviewWaitingLine } from './pullRequestFeedback';
import { reviewTurn } from '../../shared/pullRequestFeedback';
import { buildFailingChecksInvestigationPromptTemplate } from '../../shared/promptTemplates';

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
  | 'implementation-running'
  | 'question-running';

export interface PrStatusViewModel {
  kind: PrStatusKind;
  headline: string;
  tone: PrStatusTone;
  overviewRelevant: boolean;
  hasPullRequest: boolean;
  prNumber?: number;
  prUrl?: string;
  prHeadSha?: string;
  headRefName?: string;
  baseRefName?: string;
  checkSummaryLine?: string;
  evidenceLine?: string;
  reviewLine?: string;
  mergeLine?: string;
  freshnessLine?: string;
  /** What a push failure, an unconfirmed push, a rewrite or uncommitted files add to the title. */
  freshnessFact?: string;
  /** A head just pushed whose checks have not had time to register. */
  checksNotReported?: boolean;
  guidanceLine?: string;
  leadLine?: string;
  /** What the pull request's people ask of it: who requested changes, who it waits on, unresolved threads. */
  feedbackLine?: string;
  refreshedLine?: string;
  /** The checks that failed for the current head, which Fix checks sends. */
  failingChecks: GitHubCheckDetailRecord[];
  canCreateDraftPr: boolean;
  canRefresh: boolean;
  canInvestigateFailure: boolean;
  canPushUpdate: boolean;
  /** A task opened from a pull request can move its clean worktree to the pull request's newer head. */
  canSyncBranch?: boolean;
  /** A current draft whose checks did not fail can be marked ready for review. */
  canMarkReady?: boolean;
  /** Task Monki's evidence for the current head says the platform would merge it. */
  canMerge?: boolean;
  /** The pull request's branch has commits beside the worktree's own: the agent can merge them in. */
  canPullChanges?: boolean;
  /** The base moved: the pull request is behind it or conflicts with it, and the agent can merge it in. */
  baseUpdate?: { base: string; reason: 'BEHIND' | 'CONFLICTS' };
  /**
   * The one fact the step turns on, as the Now panel states it under its title:
   * which checks failed, who asked for changes, what is not pushed.
   */
  fact?: string;
  createDraftPrDisabledReason?: string;
  pushUpdateDisabledReason?: string;
  syncBranchDisabledReason?: string;
}

export interface PrStatusActionState {
  refreshDisabled: boolean;
  createOrPushDisabled: boolean;
  investigateDisabled: boolean;
  syncDisabled: boolean;
  refreshReason?: string;
  createOrPushReason?: string;
  investigateReason?: string;
  syncReason?: string;
  /** Why no delivery step can run now: another action, a review or the agent is working. */
  pauseReason?: string;
  hint?: string;
}

export type DeliveryEvidenceIdentity = 'CURRENT' | 'STALE' | 'UNKNOWN';

export function deliveryEvidenceIdentity(
  pullRequest: Pick<PullRequestSnapshotRecord, 'number' | 'headRefOid'> | undefined,
  evidence: Pick<CiRollupRecord, 'headSha' | 'pullRequestNumber'> |
    Pick<ReviewRollupRecord, 'headSha' | 'pullRequestNumber'> |
    Pick<MergeSnapshotRecord, 'headSha' | 'pullRequestNumber'>
): DeliveryEvidenceIdentity {
  if (
    !pullRequest?.headRefOid ||
    typeof pullRequest.number !== 'number' ||
    !evidence.headSha ||
    typeof evidence.pullRequestNumber !== 'number'
  ) {
    return 'UNKNOWN';
  }
  return evidence.headSha === pullRequest.headRefOid &&
    evidence.pullRequestNumber === pullRequest.number
    ? 'CURRENT'
    : 'STALE';
}

const NO_TASK_CHANGES_PR_REASON =
  'Run implementation or make a task change before opening a PR.';

export function buildPrStatusActionState(input: {
  view: PrStatusViewModel;
  deliveryBusy?: boolean;
  pauseReason?: PrStatusActionPauseReason;
  implementationRetryReason?: string;
  hasInvestigationSource?: boolean;
  provider?: RemoteProvider;
}): PrStatusActionState {
  const busyReason = input.deliveryBusy ? `${remoteProviderName(input.provider ?? 'GITHUB')} action is in progress.` : undefined;
  const mutationPauseReason =
    busyReason ??
    prStatusPauseText(input.pauseReason) ??
    input.implementationRetryReason;
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
  const syncReason = input.view.canSyncBranch ? mutationPauseReason ?? input.view.syncBranchDisabledReason : undefined;
  return {
    refreshDisabled: Boolean(input.deliveryBusy),
    createOrPushDisabled: Boolean(createOrPushReason),
    investigateDisabled: Boolean(investigateReason),
    syncDisabled: Boolean(syncReason),
    refreshReason: busyReason,
    createOrPushReason,
    investigateReason,
    syncReason,
    ...(mutationPauseReason ? { pauseReason: mutationPauseReason } : {}),
    hint:
      mutationPauseReason &&
      (input.view.canCreateDraftPr || input.view.canPushUpdate || input.view.canInvestigateFailure)
        ? mutationPauseReason
        : createOrPushReason ?? missingInvestigationSource
  };
}

export function buildPrStatusCreateOrPushTitle(
  view: Pick<PrStatusViewModel, 'leadLine' | 'freshnessLine' | 'guidanceLine'>,
  createOrPushReason?: string
): string | undefined {
  const visibleReason = view.leadLine ?? view.freshnessLine ?? view.guidanceLine;
  return createOrPushReason === visibleReason ? undefined : createOrPushReason;
}

export function shouldShowPrStatusOnOverview(view: PrStatusViewModel): boolean {
  return view.overviewRelevant;
}

function prStatusPauseText(reason: PrStatusActionPauseReason | undefined): string | undefined {
  switch (reason) {
    case 'review-starting':
      return 'Delivery actions pause while review starts.';
    case 'review-running':
      return 'Delivery actions pause while review runs.';
    case 'implementation-running':
      return 'Delivery actions pause while the agent runs.';
    case 'question-running':
      return 'Delivery actions pause while a question is answered.';
    default:
      return undefined;
  }
}

/** PR Status in the delivering platform's words: GitLab tasks read MR, `!N` and GitLab. */
export function buildPrStatusViewModel(input: Parameters<typeof buildPrStatusFacts>[0] & { provider?: RemoteProvider }): PrStatusViewModel {
  const view = buildPrStatusFacts(input);
  const provider = input.provider ?? 'GITHUB';
  if (provider !== 'GITLAB') return view;
  const words = <T extends string | undefined>(text: T) => deliveryWords(text, provider);
  return {
    ...view,
    headline: words(view.headline),
    evidenceLine: words(view.evidenceLine),
    freshnessLine: words(view.freshnessLine),
    guidanceLine: words(view.guidanceLine),
    leadLine: words(view.leadLine),
    fact: words(view.fact),
    createDraftPrDisabledReason: words(view.createDraftPrDisabledReason),
    pushUpdateDisabledReason: words(view.pushUpdateDisabledReason),
    syncBranchDisabledReason: words(view.syncBranchDisabledReason)
  };
}

/** The worktree and the pull request hold different commits: the PR's facts are not about this work yet. */
export function isFreshnessProblem(kind: PrStatusKind): boolean {
  return kind === 'STALE' || kind === 'LOCAL_NOT_PUSHED' || kind === 'PR_NEWER_COMMITS' || kind === 'BRANCH_DIVERGED';
}

function buildPrStatusFacts(input: Parameters<typeof buildPrStatusCore>[0]): PrStatusViewModel {
  const view = buildPrStatusCore(input);
  const failing = view.failingChecks;
  const open = input.pullRequest?.status === 'OPEN_DRAFT' || input.pullRequest?.status === 'OPEN_READY';
  const freshnessProblem = isFreshnessProblem(view.kind);
  // A fork's branch is its author's: commits merged here could not be pushed back.
  const fork = Boolean(input.task.remoteSource?.pullRequest?.crossRepository);
  const baseUpdate = open && !freshnessProblem && input.pullRequest ? baseMoved(input.pullRequest, input.mergeSnapshot) : undefined;
  return {
    ...view,
    // A base that moved comes before checks and reviews, as its step does: until the
    // branch is updated, what ran describes commits the merge would not hold.
    ...(baseUpdate ? { headline: 'Merge blocked', tone: 'error' as const } : {}),
    // Ready once the draft is what the worktree holds and nothing it ran failed.
    canMarkReady: open && Boolean(input.pullRequest?.isDraft) && !freshnessProblem && view.kind !== 'CHECKS_FAILED' && !baseUpdate,
    canMerge: view.kind === 'READY_TO_MERGE',
    canPullChanges: open && !fork && !view.canSyncBranch && (view.kind === 'BRANCH_DIVERGED' || view.kind === 'PR_NEWER_COMMITS') &&
      input.branchPublication?.status !== 'AMBIGUOUS',
    ...(baseUpdate && !fork ? { baseUpdate } : {}),
    fact: baseUpdate ? baseMovedLine(baseUpdate.reason, baseUpdate.base) : stepFact(view, failing)
  };
}

/** Whether the platform holds the pull request back because its base moved: behind it, or conflicting with it. */
function baseMoved(pullRequest: PullRequestSnapshotRecord, merge: MergeSnapshotRecord | undefined): PrStatusViewModel['baseUpdate'] {
  if (!merge || merge.status !== 'BLOCKED' || deliveryEvidenceIdentity(pullRequest, merge) !== 'CURRENT' || !pullRequest.baseRefName) return undefined;
  const reason = baseMovedReason(merge.raw);
  return reason ? { base: pullRequest.baseRefName, reason } : undefined;
}

/** The one fact a step turns on; the record beside it holds the rest. */
function stepFact(view: PrStatusViewModel, failing: readonly GitHubCheckDetailRecord[]): string | undefined {
  switch (view.kind) {
    case 'CHECKS_FAILED':
      return failing.length === 0 ? view.checkSummaryLine
        : failing.length <= 2 ? `${failing.map((check) => check.name).join(' and ')} failed`
          : `${failing.length} checks failed`;
    case 'GITHUB_CHANGES_REQUESTED':
    case 'GITHUB_REVIEW_WAITING':
      return view.feedbackLine;
    case 'STALE':
    case 'LOCAL_NOT_PUSHED':
    case 'PR_NEWER_COMMITS':
    case 'BRANCH_DIVERGED':
      // The title says what moved; a failed or unconfirmed push, a rewrite or a fork says more.
      return view.freshnessFact ?? view.guidanceLine;
    case 'READY_TO_MERGE':
    case 'DRAFT':
    case 'OPEN':
      // What passed is the record's to say; open threads are what the step turns on.
      return view.feedbackLine;
    case 'CLOSED_UNMERGED':
      return view.guidanceLine;
    default:
      return view.leadLine;
  }
}

/** How long a pushed head can report no checks before its CI has registered them. */
const CHECKS_REGISTER_WITHIN_MS = 60_000;

/**
 * Whether "no checks" for the pull request's head may only mean they have not
 * started. A head reports none until its CI registers them: moments after the
 * push, and again for a moment after its failed checks are run again. When the
 * pull request had checks before, only a reading taken a minute after this
 * head's checks went missing says it has none.
 */
export function checksMayNotHaveStarted(
  pullRequest: Pick<PullRequestSnapshotRecord, 'number' | 'headRefOid'> | undefined,
  ciRollups: readonly CiRollupRecord[]
): boolean {
  const head = pullRequest?.headRefOid;
  if (!pullRequest?.number || !head) return false;
  const own = ciRollups.filter((record) => record.pullRequestNumber === pullRequest.number);
  if (!own.some((record) => record.totalCount > 0)) return false;
  const time = (record: CiRollupRecord) => Date.parse(record.observedAt);
  const ofHead = own.filter((record) => record.headSha === head && Number.isFinite(time(record)));
  const lastWithChecks = Math.max(-Infinity, ...ofHead.filter((record) => record.totalCount > 0).map(time));
  const missing = ofHead.filter((record) => !record.totalCount && time(record) > lastWithChecks).map(time);
  return missing.length > 0 && Math.max(...missing) - Math.min(...missing) < CHECKS_REGISTER_WITHIN_MS;
}

function buildPrStatusCore(input: {
  task: Task;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  branchPublication?: BranchPublicationRecord;
  pullRequest?: PullRequestSnapshotRecord;
  ciRollup?: CiRollupRecord;
  reviewRollup?: ReviewRollupRecord;
  mergeSnapshot?: MergeSnapshotRecord;
  /** Every head of the linked pull request Task Monki has observed, newest first. */
  observedPullRequestHeads?: readonly string[];
  /** No checks so far may only mean they have not started (`checksMayNotHaveStarted`). */
  checksMayNotHaveStarted?: boolean;
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
  const external = input.worktree?.ownership === 'EXTERNAL';
  const externalPublishReason = external
    ? task.projection.worktree !== 'PRESENT' || !gitSnapshot || ['UNKNOWN', 'UNAVAILABLE', 'CONFLICTED'].includes(gitSnapshot.status)
      ? 'Refresh or reconnect the checkout before publishing.'
      : gitSnapshot.operationInProgress
        ? 'Finish the current Git operation before publishing.'
      : gitSnapshot.stagedCount + gitSnapshot.unstagedCount + gitSnapshot.untrackedCount > 0
        ? 'Commit external changes in your editor or terminal before publishing.'
        : undefined
    : undefined;

  const openedPullRequest = task.remoteSource?.kind === 'PULL_REQUEST' ? task.remoteSource.pullRequest : undefined;
  if ((!hasPullRequest || !pullRequest) && openedPullRequest) {
    // A task opened from a pull request never creates one; reading it again is the only step.
    return {
      kind: 'UNKNOWN',
      headline: 'Unknown',
      tone: 'neutral',
      overviewRelevant: true,
      hasPullRequest: false,
      canCreateDraftPr: false,
      canRefresh: true,
      canInvestigateFailure: false,
      canPushUpdate: false,
      failingChecks: []
    };
  }
  if (!hasPullRequest || !pullRequest) {
    const createDraftPr = createDraftPrAvailability(task, gitSnapshot, branchPublication, externalPublishReason, input.worktree?.ownership);
    return {
      kind: 'NO_PR',
      headline: 'No PR',
      tone: 'neutral',
      overviewRelevant: external || createDraftPr.overviewRelevant,
      hasPullRequest: false,
      leadLine: createDraftPr.line,
      canCreateDraftPr: createDraftPr.showAction,
      canRefresh: external,
      canInvestigateFailure: false,
      canPushUpdate: false,
      createDraftPrDisabledReason: createDraftPr.disabledReason,
      failingChecks: []
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
  const reviewLine = formatReviewLine(reviewRollup);
  const mergeLine = formatMergeLine(mergeSnapshot);
  const passingChecks = currentPassingCheckEvidence(pullRequest, ciRollup);
  const terminal = terminalPrStatus(pullRequest, mergeSnapshot);

  if (terminal) {
    // A replacement draft is the task's own; a task opened from a pull request never creates one.
    if (terminal.kind === 'CLOSED_UNMERGED' && !openedPullRequest) {
      const createDraftPr = createDraftPrAvailability(task, gitSnapshot, branchPublication, externalPublishReason, input.worktree?.ownership);
      return {
        ...baseStatus(pullRequest),
        ...terminal,
        guidanceLine: createDraftPr.line,
        canCreateDraftPr: createDraftPr.showAction,
        createDraftPrDisabledReason: createDraftPr.disabledReason
      };
    }
    return {
      ...baseStatus(pullRequest),
      ...terminal
    };
  }

  const freshnessStatus = freshnessToStatus(freshness);
  if (freshnessStatus) {
    // Sync moves a worktree that holds no commits of its own: one behind the pull
    // request, or one still at a head the pull request had before it was rewritten.
    const canSyncBranch = Boolean(openedPullRequest) && (
      freshness.kind === 'PR_NEWER_COMMITS' ||
      pullRequestRewrittenUnder({
        leavableHeads: input.observedPullRequestHeads ?? [],
        localHead: gitSnapshot?.headSha,
        diverged: freshness.kind === 'BRANCH_DIVERGED',
        pushUnconfirmed: branchPublication?.status === 'AMBIGUOUS'
      })
    );
    const dirty = (gitSnapshot?.stagedCount ?? 0) + (gitSnapshot?.unstagedCount ?? 0) + (gitSnapshot?.untrackedCount ?? 0) > 0;
    // A fork's branch belongs to its author: Task Monki never pushes there, so
    // the card states that once instead of offering an update that cannot run.
    const fork = Boolean(openedPullRequest?.crossRepository);
    // A rewrite under a worktree with nothing of its own is news, not a conflict.
    const rewritten = canSyncBranch && freshness.kind === 'BRANCH_DIVERGED';
    return {
      ...baseStatus(pullRequest),
      ...freshnessStatus,
      // A failed or unconfirmed push reads as the board reads it, in its error ink.
      ...(freshness.headline ? { headline: freshness.headline, tone: 'error' as const } : {}),
      ...(rewritten ? { headline: 'PR rewritten', tone: 'action' as const } : {}),
      freshnessLine: rewritten ? 'No commits of its own' : freshness.line,
      // Only a rewrite, a push that failed or went unconfirmed, or uncommitted files say more than the title.
      ...(rewritten ? { freshnessFact: 'No commits of its own' } : freshness.fact ? { freshnessFact: freshness.fact } : {}),
      guidanceLine: fork && (freshness.kind === 'LOCAL_NOT_PUSHED' || freshness.kind === 'BRANCH_DIVERGED')
        ? 'Task Monki does not push to forks'
        : undefined,
      canPushUpdate:
        !fork &&
        !canSyncBranch &&
        (freshness.kind === 'LOCAL_NOT_PUSHED' ||
          branchPublication?.status === 'AMBIGUOUS'),
      canSyncBranch,
      syncBranchDisabledReason: canSyncBranch && dirty ? 'Commit or discard the worktree changes first.' : undefined,
      pushUpdateDisabledReason: externalPublishReason ?? freshness.pushUpdateDisabledReason
    };
  }

  if (ciRollup && deliveryEvidenceIdentity(pullRequest, ciRollup) === 'UNKNOWN') {
    return {
      ...baseStatus(pullRequest),
      kind: 'UNKNOWN',
      headline: 'Checks identity unknown',
      tone: 'neutral'
    };
  }

  // A head just pushed is not ready to merge before its checks have had a chance to start.
  const checksStarting = Boolean(input.checksMayNotHaveStarted) && ciRollup?.status === 'NO_CHECKS' && !ciRollup.totalCount;
  const checksStatus = checksStarting
    ? { kind: 'CHECKS_PENDING' as const, headline: 'Checks pending', tone: 'action' as const }
    : checksToStatus(ciRollup);
  if (checksStatus && ciRollup) {
    return {
      ...baseStatus(pullRequest),
      ...checkEvidence(ciRollup),
      ...checksStatus,
      ...(checksStarting ? { checksNotReported: true } : {}),
      canInvestigateFailure: checksStatus.kind === 'CHECKS_FAILED'
    };
  }

  const reviewStatus = reviewToStatus(reviewRollup);
  if (reviewStatus && reviewRollup) {
    if (deliveryEvidenceIdentity(pullRequest, reviewRollup) === 'UNKNOWN') {
      return {
        ...baseStatus(pullRequest),
        ...passingChecks,
        kind: 'UNKNOWN',
        headline: 'Review identity unknown',
        tone: 'neutral',
        evidenceLine: passingChecks.evidenceLine
      };
    }
    return {
      ...baseStatus(pullRequest),
      ...passingChecks,
      ...reviewStatus,
      evidenceLine: passingChecks.evidenceLine ?? checksAbsenceLine(ciRollup)
    };
  }

  const ready = isReadyToMerge(pullRequest, ciRollup, reviewRollup, mergeSnapshot);
  if (ready) {
    return {
      ...baseStatus(pullRequest),
      kind: 'READY_TO_MERGE',
      headline: 'Ready to merge',
      tone: 'success',
      ...passingChecks,
      reviewLine,
      mergeLine,
      evidenceLine: formatEvidenceLine(passingChecks.evidenceLine, reviewLine, mergeLine)
    };
  }

  return {
    ...baseStatus(pullRequest),
    ...passingChecks,
    kind: pullRequest.isDraft ? 'DRAFT' : 'OPEN',
    headline: pullRequest.isDraft ? 'Draft PR' : 'Open PR',
    tone: pullRequest.isDraft ? 'info' : 'neutral',
    evidenceLine: passingChecks.evidenceLine ?? checksAbsenceLine(ciRollup)
  };

  function baseStatus(pr: PullRequestSnapshotRecord): PrStatusViewModel {
    // Feedback read with this pull request; a merged or closed one asks nothing more.
    const feedback = reviewRollup?.feedback && reviewRollup.pullRequestNumber === pr.number &&
      (pr.status === 'OPEN_DRAFT' || pr.status === 'OPEN_READY') ? reviewRollup.feedback : undefined;
    const feedbackLine = feedback
      ? reviewRollup && answeredReview(reviewRollup) ? reviewWaitingLine(feedback) : pullRequestFeedbackLine(feedback)
      : undefined;
    return {
      kind: 'UNKNOWN',
      headline: 'Unknown',
      tone: 'neutral',
      overviewRelevant: true,
      hasPullRequest: true,
      ...(feedbackLine ? { feedbackLine } : {}),
      prNumber: pr.number,
      prUrl: pr.url,
      prHeadSha: pr.headRefOid,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      refreshedLine: formatRefreshLine(pr.observedAt),
      failingChecks: [],
      canCreateDraftPr: false,
      canRefresh: true,
      canInvestigateFailure: false,
      canPushUpdate: false
    };
  }
}

function checkEvidence(
  ciRollup: CiRollupRecord
): Pick<PrStatusViewModel, 'failingChecks' | 'checkSummaryLine' | 'evidenceLine'> {
  const checkSummaryLine = formatCheckSummary(ciRollup);
  return {
    failingChecks: ciRollup.checkDetails.filter((check) => check.status === 'failed'),
    checkSummaryLine,
    evidenceLine: ciRollup.checkDetails.length === 0 && hasCheckCounts(ciRollup) ? checkSummaryLine : undefined
  };
}

/** Facts read as one sentence, not as a string of separator-joined labels. */
function formatEvidenceLine(...parts: Array<string | undefined>): string | undefined {
  const line = parts
    .filter((part): part is string => Boolean(part))
    .map((part, index) => (index === 0 ? part : part.charAt(0).toLocaleLowerCase() + part.slice(1)))
    .join(', ');
  return line || undefined;
}

function hasCheckCounts(ciRollup: CiRollupRecord): boolean {
  return [
    ciRollup.failingCount,
    ciRollup.canceledCount,
    ciRollup.pendingCount,
    ciRollup.skippedCount,
    ciRollup.passingCount
  ].some((count) => Boolean(count && count > 0));
}

function createDraftPrAvailability(
  task: Task,
  gitSnapshot?: GitSnapshotRecord,
  branchPublication?: BranchPublicationRecord,
  externalPublishReason?: string,
  ownership?: WorktreeRecord['ownership']
): {
  showAction: boolean;
  overviewRelevant: boolean;
  line?: string;
  disabledReason?: string;
} {
  if (externalPublishReason) {
    return { showAction: true, overviewRelevant: true, line: externalPublishReason, disabledReason: externalPublishReason };
  }
  const retryReason = getImplementationRetryReason(task);
  if (retryReason) {
    return {
      showAction: true,
      overviewRelevant: true,
      line: retryReason,
      disabledReason: retryReason
    };
  }
  if (task.projection.worktree !== 'PRESENT') {
    return {
      showAction: false,
      overviewRelevant: ['LOCKED', 'PRUNABLE', 'MISSING', 'ERROR', 'UNKNOWN'].includes(
        task.projection.worktree
      ),
      line: 'A worktree is required before a draft PR can be opened.',
      disabledReason: 'A worktree is required before a draft PR can be opened.'
    };
  }

  if (branchPublication?.status === 'PUSHING') {
    return {
      showAction: true,
      overviewRelevant: true,
      line: 'Branch publication is already in progress.',
      disabledReason: 'Branch publication is already in progress.'
    };
  }
  if (branchPublication?.status === 'AMBIGUOUS') {
    const reason =
      branchPublication.error ??
      'The prior push could not be confirmed. Retry to recheck the remote safely.';
    return {
      showAction: true,
      overviewRelevant: true,
      line: reason
    };
  }
  if (branchPublication?.status === 'FAILED' && branchPublication.error) {
    if (isRemoteNewerPublicationError(branchPublication.error)) {
      return {
        showAction: true,
        overviewRelevant: true,
        line: branchPublication.error,
        disabledReason: branchPublication.error
      };
    }
    return {
      showAction: true,
      overviewRelevant: true,
      line: `Last push failed: ${branchPublication.error}`
    };
  }

  if (!gitSnapshot) {
    switch (task.projection.git) {
      case 'DIRTY':
      case 'COMMITTED_UNPUSHED':
      case 'PUSHED':
        return { showAction: true, overviewRelevant: true };
      case 'CLEAN':
        return {
          showAction: true,
          overviewRelevant: false,
          line: NO_TASK_CHANGES_PR_REASON,
          disabledReason: NO_TASK_CHANGES_PR_REASON
        };
      case 'CONFLICTED':
        return {
          showAction: true,
          overviewRelevant: true,
          line: 'Resolve Git conflicts before opening a PR.',
          disabledReason: 'Resolve Git conflicts before opening a PR.'
        };
      case 'DIVERGED':
        return {
          showAction: true,
          overviewRelevant: true,
          line: 'Sync the branch before opening a PR.',
          disabledReason: 'Sync the branch before opening a PR.'
        };
      case 'UNAVAILABLE':
      case 'UNKNOWN':
        return {
          showAction: true,
          overviewRelevant: true,
          line: 'Git status must be available before opening a PR.',
          disabledReason: 'Git status must be available before opening a PR.'
        };
      case 'NOT_INSPECTED':
        return {
          showAction: true,
          overviewRelevant: false,
          line: 'Refresh Git evidence before opening a PR.',
          disabledReason: 'Refresh Git evidence before opening a PR.'
        };
    }
  }

  if (gitSnapshot.conflictedCount > 0 || gitSnapshot.status === 'CONFLICTED') {
    return {
      showAction: true,
      overviewRelevant: true,
      line: 'Resolve Git conflicts before opening a PR.',
      disabledReason: 'Resolve Git conflicts before opening a PR.'
    };
  }
  if (gitSnapshot.status === 'DIVERGED' || gitSnapshot.behindCount > 0) {
    return {
      showAction: true,
      overviewRelevant: true,
      line: 'Sync the branch before opening a PR.',
      disabledReason: 'Sync the branch before opening a PR.'
    };
  }
  if (gitSnapshot.status === 'UNAVAILABLE' || gitSnapshot.status === 'UNKNOWN') {
    return {
      showAction: true,
      overviewRelevant: true,
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
  if (ownership === 'EXTERNAL' || workingChangeCount > 0 || hasCommittedTaskDiff) {
    return { showAction: true, overviewRelevant: true };
  }

  return {
    showAction: true,
    overviewRelevant: false,
    line: NO_TASK_CHANGES_PR_REASON,
    disabledReason: NO_TASK_CHANGES_PR_REASON
  };
}

export function buildFailingChecksInvestigationPrompt(
  view: PrStatusViewModel,
  provider: RemoteProvider,
  logs?: { entries: Array<{ name: string; text: string; truncated: boolean }>; boundary: string }
): string {
  return buildFailingChecksInvestigationPromptTemplate({
    provider,
    ...(logs ? { logs: logs.entries, boundary: logs.boundary } : {}),
    prNumber: view.prNumber,
    prHeadSha: view.prHeadSha,
    prUrl: view.prUrl,
    headRefName: view.headRefName,
    baseRefName: view.baseRefName,
    failingChecks: view.failingChecks
  });
}

function terminalPrStatus(
  pullRequest: PullRequestSnapshotRecord,
  mergeSnapshot?: MergeSnapshotRecord
): Pick<PrStatusViewModel, 'kind' | 'headline' | 'tone'> | undefined {
  const currentMerge = mergeSnapshot &&
    deliveryEvidenceIdentity(pullRequest, mergeSnapshot) === 'CURRENT'
    ? mergeSnapshot
    : undefined;
  if (pullRequest.status === 'MERGED' || currentMerge?.status === 'MERGED') {
    return {
      kind: 'MERGED',
      headline: 'Merged',
      tone: 'success'
    };
  }
  if (
    pullRequest.status === 'CLOSED_UNMERGED' ||
    currentMerge?.status === 'CLOSED_UNMERGED'
  ) {
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
}): { kind?: PrStatusKind; line?: string; fact?: string; headline?: string; pushUpdateDisabledReason?: string } {
  const { gitSnapshot, branchPublication, pullRequest, ciRollup, reviewRollup, mergeSnapshot } = input;
  const prHead = pullRequest.headRefOid;
  const staleEvidence = [ciRollup, reviewRollup, mergeSnapshot].some(
    (row) => row && deliveryEvidenceIdentity(pullRequest, row) === 'STALE'
  );
  // A push that failed or went unconfirmed is named as the board names it, with what the remote said.
  if (branchPublication?.status === 'AMBIGUOUS') {
    const line = branchPublication.error ?? 'Last push not confirmed';
    // Without the remote's own words, the title says it all.
    return { kind: 'BRANCH_DIVERGED', line, ...(branchPublication.error ? { fact: line } : {}), headline: 'Push unconfirmed' };
  }
  // What Git observed outranks a push that failed before it: once the branch is seen to
  // diverge, bringing in the other side is the step, not pushing again.
  if (
    gitSnapshot?.status === 'DIVERGED' ||
    ((gitSnapshot?.aheadCount ?? 0) > 0 && (gitSnapshot?.behindCount ?? 0) > 0)
  ) {
    return {
      kind: 'BRANCH_DIVERGED',
      line: 'Local branch and PR branch both changed'
    };
  }
  if (branchPublication?.status === 'FAILED' && branchPublication.error && isRemoteNewerPublicationError(branchPublication.error)) {
    const line = branchPublication.error;
    // Read before the push was refused, the pull request does not hold the commits that refused
    // it: reading it is the step, as bringing in the head on record would merge only what the
    // worktree holds. One read ends it.
    if (Date.parse(pullRequest.observedAt) < Date.parse(branchPublication.updatedAt)) {
      return { kind: 'STALE', line, fact: line, headline: 'Push failed' };
    }
    // Measured against the head read since, Git says what is left, and a branch that had not
    // brought it in would have diverged above. Otherwise bringing it in is the step.
    if (!prHead || gitSnapshot?.upstreamSha !== prHead) {
      return { kind: 'BRANCH_DIVERGED', line, fact: line, headline: 'Push failed' };
    }
  } else if (branchPublication?.status === 'FAILED' && branchPublication.error) {
    return {
      kind: 'LOCAL_NOT_PUSHED',
      line: `Last push failed: ${branchPublication.error}`,
      fact: branchPublication.error,
      headline: 'Push failed'
    };
  }
  if (staleEvidence) {
    return {
      kind: 'STALE',
      line: 'From an earlier head'
    };
  }
  // The branch measured against this pull request head: Task Monki observed that the
  // pull request is ahead, so a push would be refused whatever the worktree holds.
  if (gitSnapshot?.headSha && prHead && gitSnapshot.headSha !== prHead && gitSnapshot.upstreamSha === prHead &&
      gitSnapshot.aheadCount === 0 && gitSnapshot.behindCount > 0) {
    return {
      kind: 'PR_NEWER_COMMITS',
      line: 'This worktree is behind the PR'
    };
  }
  const dirtyFiles = (gitSnapshot?.stagedCount ?? 0) + (gitSnapshot?.unstagedCount ?? 0) + (gitSnapshot?.untrackedCount ?? 0);
  if (dirtyFiles > 0) {
    // Push update commits these first: how many is what the title does not say.
    return {
      kind: 'LOCAL_NOT_PUSHED',
      line: 'Local worktree has uncommitted changes',
      fact: pluralize(dirtyFiles, 'uncommitted file')
    };
  }
  const localHead = gitSnapshot?.headSha;
  if (localHead && prHead && localHead !== prHead) {
    if (gitSnapshot.status === 'COMMITTED_UNPUSHED' || branchPublication?.headSha !== localHead) {
      return {
        kind: 'LOCAL_NOT_PUSHED',
        line: 'Local branch has newer commits'
      };
    }
    return {
      kind: 'PR_NEWER_COMMITS',
      line: 'This worktree is behind the PR'
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
      return { kind: 'STALE', headline: 'Checks stale', tone: 'action' };
    case 'LOCAL_NOT_PUSHED':
      return { kind: 'LOCAL_NOT_PUSHED', headline: 'Changes not pushed', tone: 'action' };
    case 'PR_NEWER_COMMITS':
      return { kind: 'PR_NEWER_COMMITS', headline: 'PR has newer commits', tone: 'action' };
    default:
      return undefined;
  }
}

function isRemoteNewerPublicationError(error: string | undefined): boolean {
  return Boolean(error?.toLowerCase().includes('newer commits'));
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
    // Only checks that ran and were all skipped make a headline
    // (PR_STATUS_CARD_FLOW, NO_REQUIRED_CHECKS). A pull request with no checks
    // at all — a repository without CI — leaves the headline to GitHub review
    // and draft state; checksAbsenceLine says what is missing instead.
    case 'NO_CHECKS':
      return ciRollup.totalCount > 0
        ? { kind: 'NO_REQUIRED_CHECKS', headline: 'Checks skipped', tone: 'action' }
        : undefined;
    case 'EXPECTED_NOT_REPORTED':
      return { kind: 'CHECKS_PENDING', headline: 'Expected checks not reported', tone: 'action' };
    case 'STALE':
      return { kind: 'STALE', headline: 'Checks stale', tone: 'action' };
    default:
      return undefined;
  }
}

/** What the evidence line says when no check verdict leads the headline. */
function checksAbsenceLine(ciRollup?: CiRollupRecord): string | undefined {
  switch (ciRollup?.status) {
    case undefined:
      return 'Checks not observed';
    case 'NO_CHECKS':
      return ciRollup.totalCount > 0 ? undefined : 'No checks reported';
    // Checks that do not apply have nothing to report.
    case 'NOT_APPLICABLE':
      return undefined;
    case 'UNKNOWN':
      return 'Checks unknown';
    default:
      return undefined;
  }
}

function currentPassingCheckEvidence(
  pullRequest: PullRequestSnapshotRecord,
  ciRollup?: CiRollupRecord
): Pick<PrStatusViewModel, 'failingChecks' | 'checkSummaryLine' | 'evidenceLine'> {
  if (
    ciRollup?.status !== 'PASSING' ||
    !ciRollup.headSha ||
    deliveryEvidenceIdentity(pullRequest, ciRollup) !== 'CURRENT'
  ) {
    return { failingChecks: [] };
  }
  const evidence = checkEvidence(ciRollup);
  const count = ciRollup.passingCount > 0
    ? `${ciRollup.passingCount} ${ciRollup.passingCount === 1 ? 'check' : 'checks'}`
    : 'Checks';
  return {
    ...evidence,
    evidenceLine: `${count} passed for head ${ciRollup.headSha.slice(0, 8)}`
  };
}

function reviewToStatus(
  reviewRollup?: ReviewRollupRecord
): Pick<PrStatusViewModel, 'kind' | 'headline' | 'tone'> | undefined {
  if (reviewRollup?.status === 'CHANGES_REQUESTED') {
    // Answered after everyone else, or asked again: the verdict stands until its reviewers look.
    return answeredReview(reviewRollup)
      ? { kind: 'GITHUB_REVIEW_WAITING', headline: 'Waiting for review', tone: 'action' }
      : { kind: 'GITHUB_CHANGES_REQUESTED', headline: 'Changes requested', tone: 'action' };
  }
  if (reviewRollup?.status === 'REQUESTED' || reviewRollup?.status === 'PENDING') {
    return { kind: 'GITHUB_REVIEW_WAITING', headline: 'Waiting for review', tone: 'action' };
  }
  return undefined;
}

/** A review that requested changes the person has since answered: it waits on its reviewers. */
function answeredReview(reviewRollup: ReviewRollupRecord): boolean {
  return reviewRollup.status === 'CHANGES_REQUESTED' && Boolean(reviewRollup.feedback) &&
    reviewTurn(reviewRollup.feedback!) === 'REVIEWERS';
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
  // A repository without CI reports no checks at all; the platform's own merge
  // state already holds back a pull request whose required checks have not run.
  const checksSatisfied = ciRollup.status === 'PASSING' || (ciRollup.status === 'NO_CHECKS' && !ciRollup.totalCount);
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
  const rows = [ciRollup, reviewRollup, mergeSnapshot];
  return rows.every((row) => deliveryEvidenceIdentity(pullRequest, row) === 'CURRENT');
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
  return parts.join(', ');
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

/** When the pull request was last read: the time today, the day before that. */
function formatRefreshLine(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const read = new Date(timestamp);
  const today = read.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, today
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(read);
}

function countPart(count: number | undefined, label: string): string | undefined {
  return count && count > 0 ? `${count} ${label}` : undefined;
}
