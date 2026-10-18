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
import { baseMovedReason, getImplementationRetryReason, pullRequestRewrittenUnder, type RemoteProvider } from '../../shared/contracts';
import { deliveryNoun, deliveryWords } from './deliveryWords';
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
  prTitle?: string;
  prIdentityLine?: string;
  prHeadSha?: string;
  headRefName?: string;
  baseRefName?: string;
  checkSummaryLine?: string;
  evidenceLine?: string;
  reviewLine?: string;
  mergeLine?: string;
  freshnessLine?: string;
  guidanceLine?: string;
  leadLine?: string;
  /** What the pull request's people ask of it: who requested changes, who it waits on, unresolved threads. */
  feedbackLine?: string;
  refreshedLine?: string;
  checkGroups: PrCheckGroup[];
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
  /** PR on GitHub, MR on GitLab. */
  deliveryNoun?: 'PR' | 'MR';
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

export interface PrCheckGroup {
  status: GitHubCheckDetailRecord['status'];
  label: string;
  checks: GitHubCheckDetailRecord[];
  defaultOpen: boolean;
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
  const busyReason = input.deliveryBusy ? deliveryWords('GitHub action is in progress.', input.provider ?? 'GITHUB') : undefined;
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
    deliveryNoun: deliveryNoun(provider),
    headline: words(view.headline),
    prIdentityLine: view.prIdentityLine?.replace(/^#(\d+)/u, '!$1'),
    checkSummaryLine: words(view.checkSummaryLine),
    evidenceLine: words(view.evidenceLine),
    reviewLine: words(view.reviewLine),
    mergeLine: words(view.mergeLine),
    freshnessLine: words(view.freshnessLine),
    guidanceLine: words(view.guidanceLine),
    leadLine: words(view.leadLine),
    feedbackLine: words(view.feedbackLine),
    fact: words(view.fact),
    createDraftPrDisabledReason: words(view.createDraftPrDisabledReason),
    pushUpdateDisabledReason: words(view.pushUpdateDisabledReason),
    syncBranchDisabledReason: words(view.syncBranchDisabledReason)
  };
}

function buildPrStatusFacts(input: Parameters<typeof buildPrStatusCore>[0]): PrStatusViewModel {
  const view = buildPrStatusCore(input);
  const failing = view.checkGroups.find((group) => group.status === 'failed')?.checks ?? [];
  const open = input.pullRequest?.status === 'OPEN_DRAFT' || input.pullRequest?.status === 'OPEN_READY';
  const freshnessProblem = ['STALE', 'LOCAL_NOT_PUSHED', 'PR_NEWER_COMMITS', 'BRANCH_DIVERGED'].includes(view.kind);
  // A fork's branch is its author's: commits merged here could not be pushed back.
  const fork = Boolean(input.task.remoteSource?.pullRequest?.crossRepository);
  const baseUpdate = open && !freshnessProblem && input.pullRequest ? baseMoved(input.pullRequest, input.mergeSnapshot) : undefined;
  return {
    ...view,
    // Ready once the draft is what the worktree holds and nothing it ran failed.
    canMarkReady: open && Boolean(input.pullRequest?.isDraft) && !freshnessProblem && view.kind !== 'CHECKS_FAILED' && !baseUpdate,
    canMerge: view.kind === 'READY_TO_MERGE',
    canPullChanges: open && !fork && !view.canSyncBranch && (view.kind === 'BRANCH_DIVERGED' || view.kind === 'PR_NEWER_COMMITS') &&
      input.branchPublication?.status !== 'AMBIGUOUS',
    ...(baseUpdate && !fork ? { baseUpdate } : {}),
    fact: baseUpdate && view.kind !== 'CHECKS_FAILED'
      ? `${baseUpdate.reason === 'CONFLICTS' ? 'Conflicts with' : 'Behind'} ${baseUpdate.base}`
      : stepFact(view, failing)
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
      return view.freshnessLine ?? view.guidanceLine;
    case 'READY_TO_MERGE':
    case 'DRAFT':
    case 'OPEN':
      // What is missing is the record's to say ("Checks: None"); the step says only what is there.
      return view.feedbackLine ?? (view.checkSummaryLine || view.evidenceLine?.includes(' passed')
        ? view.evidenceLine?.replace(/ for head [0-9a-f]+/u, '')
        : undefined);
    case 'CLOSED_UNMERGED':
      return view.guidanceLine;
    default:
      return view.leadLine ?? view.feedbackLine ?? view.checkSummaryLine;
  }
}

/** How long a pushed head can report no checks before its CI has registered them. */
const CHECKS_REGISTER_WITHIN_MS = 60_000;

/**
 * Whether "no checks" for the pull request's head may only mean they have not
 * started. A head reports none until its CI registers them, moments after the
 * push. When an earlier head of the same pull request had checks, only a
 * reading of this head taken a minute after it first appeared says it has none.
 */
export function checksMayNotHaveStarted(
  pullRequest: Pick<PullRequestSnapshotRecord, 'number' | 'headRefOid'> | undefined,
  ciRollups: readonly CiRollupRecord[]
): boolean {
  const head = pullRequest?.headRefOid;
  if (!pullRequest?.number || !head) return false;
  const own = ciRollups.filter((record) => record.pullRequestNumber === pullRequest.number);
  if (!own.some((record) => record.headSha && record.headSha !== head && record.totalCount > 0)) return false;
  const seen = own.filter((record) => record.headSha === head).map((record) => Date.parse(record.observedAt)).filter(Number.isFinite);
  return seen.length > 0 && Math.max(...seen) - Math.min(...seen) < CHECKS_REGISTER_WITHIN_MS;
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
  observedPullRequestHeads?: readonly (string | undefined)[];
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
      checkGroups: []
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
  const reviewLine = formatReviewLine(reviewRollup);
  const mergeLine = formatMergeLine(mergeSnapshot);
  const passingChecks = currentPassingCheckEvidence(pullRequest, ciRollup);
  const terminal = terminalPrStatus(pullRequest, mergeSnapshot);

  if (terminal) {
    if (terminal.kind === 'CLOSED_UNMERGED') {
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
        leavableHeads: [openedPullRequest?.headSha, ...(input.observedPullRequestHeads ?? [])].filter((head): head is string => Boolean(head)),
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
      ...(rewritten ? { headline: 'PR rewritten', tone: 'action' as const } : {}),
      freshnessLine: rewritten ? 'This worktree has no commits of its own.' : freshness.line,
      guidanceLine: fork && (freshness.kind === 'LOCAL_NOT_PUSHED' || freshness.kind === 'BRANCH_DIVERGED')
        ? 'Task Monki does not push to forks.'
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
      ...(checksStarting ? { leadLine: 'No checks reported yet' } : {}),
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
      prTitle: cleanPrTitle(pr.title),
      prIdentityLine: formatPrIdentityLine(pr),
      prHeadSha: pr.headRefOid,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      refreshedLine: formatRefreshLine(pr.observedAt),
      checkGroups: [],
      canCreateDraftPr: false,
      canRefresh: true,
      canInvestigateFailure: false,
      canPushUpdate: false
    };
  }
}

function checkEvidence(
  ciRollup: CiRollupRecord
): Pick<PrStatusViewModel, 'checkGroups' | 'checkSummaryLine' | 'evidenceLine'> {
  const checkGroups = groupChecks(ciRollup.checkDetails ?? []);
  const checkSummaryLine = formatCheckSummary(ciRollup);
  return {
    checkGroups,
    checkSummaryLine,
    evidenceLine: checkGroups.length === 0 && hasCheckCounts(ciRollup) ? checkSummaryLine : undefined
  };
}

function cleanPrTitle(title: string | undefined): string | undefined {
  const value = title?.trim();
  return value ? value : undefined;
}

function formatPrIdentityLine(pr: PullRequestSnapshotRecord): string {
  const number = pr.number ? `#${pr.number}` : 'PR';
  const title = cleanPrTitle(pr.title);
  return title ? `${number} ${title}` : number;
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
  logs?: { entries: Array<{ name: string; text: string; truncated: boolean }>; boundary: string }
): string {
  const failingChecks = view.checkGroups
    .find((group) => group.status === 'failed')
    ?.checks ?? [];
  return buildFailingChecksInvestigationPromptTemplate({
    ...(view.deliveryNoun === 'MR' ? { provider: 'GITLAB' as const } : {}),
    ...(logs ? { logs: logs.entries, boundary: logs.boundary } : {}),
    prNumber: view.prNumber,
    prHeadSha: view.prHeadSha,
    prUrl: view.prUrl,
    headRefName: view.headRefName,
    baseRefName: view.baseRefName,
    failingChecks
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
}): { kind?: PrStatusKind; line?: string; pushUpdateDisabledReason?: string } {
  const { gitSnapshot, branchPublication, pullRequest, ciRollup, reviewRollup, mergeSnapshot } = input;
  const prHead = pullRequest.headRefOid;
  const staleEvidence = [ciRollup, reviewRollup, mergeSnapshot].some(
    (row) => row && deliveryEvidenceIdentity(pullRequest, row) === 'STALE'
  );
  if (branchPublication?.status === 'AMBIGUOUS') {
    return {
      kind: 'BRANCH_DIVERGED',
      line:
        branchPublication.error ??
        'The prior push could not be confirmed. Retry to recheck the remote safely.'
    };
  }
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
  // The branch measured against this pull request head: Task Monki observed that the
  // pull request is ahead, so a push would be refused whatever the worktree holds.
  if (gitSnapshot?.headSha && prHead && gitSnapshot.headSha !== prHead && gitSnapshot.upstreamSha === prHead &&
      gitSnapshot.aheadCount === 0 && gitSnapshot.behindCount > 0) {
    return {
      kind: 'PR_NEWER_COMMITS',
      line: 'This worktree is behind the PR.'
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
): Pick<PrStatusViewModel, 'checkGroups' | 'checkSummaryLine' | 'evidenceLine'> {
  if (
    ciRollup?.status !== 'PASSING' ||
    !ciRollup.headSha ||
    deliveryEvidenceIdentity(pullRequest, ciRollup) !== 'CURRENT'
  ) {
    return { checkGroups: [] };
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
      : { kind: 'GITHUB_CHANGES_REQUESTED', headline: 'Changes requested', tone: 'error' };
  }
  if (reviewRollup?.status === 'REQUESTED' || reviewRollup?.status === 'PENDING') {
    return { kind: 'GITHUB_REVIEW_WAITING', headline: 'Waiting for review', tone: 'action' };
  }
  return undefined;
}

/** A review that requested changes the person has since answered: it waits on its reviewers. */
function answeredReview(reviewRollup: ReviewRollupRecord): boolean {
  return reviewRollup.status === 'CHANGES_REQUESTED' && Boolean(reviewRollup.feedback) &&
    reviewTurn(reviewRollup.feedback!, true) === 'REVIEWERS';
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
function formatRefreshLine(value?: string, now = new Date()): string | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const read = new Date(timestamp);
  const today = read.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, today
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(read);
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
