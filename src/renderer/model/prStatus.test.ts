import { describe, expect, it } from 'vitest';
import {
  createInitialProjection,
  type BranchPublicationRecord,
  type CiRollupRecord,
  type GitSnapshotRecord,
  type MergeSnapshotRecord,
  type PullRequestSnapshotRecord,
  type ReviewRollupRecord,
  type Task
} from '../../shared/contracts';
import {
  buildFailingChecksInvestigationPrompt,
  buildPrStatusActionState,
  buildPrStatusCreateOrPushTitle,
  buildPrStatusViewModel,
  checksMayNotHaveStarted,
  shouldShowPrStatusOnOverview
} from './prStatus';
import { deliveryWords } from './deliveryWords';

const now = '2026-07-01T10:00:00.000Z';

describe('a GitLab merge request', () => {
  it('reads in GitLab words while GitHub tasks keep theirs', () => {
    const input = {
      task: taskFixture(),
      gitSnapshot: gitFixture(),
      pullRequest: prFixture({ url: 'https://gitlab.com/group/project/-/merge_requests/82' }),
      reviewRollup: reviewFixture({ status: 'CHANGES_REQUESTED' as const })
    };
    expect(buildPrStatusViewModel({ ...input, provider: 'GITLAB' })).toMatchObject({
      headline: 'Changes requested', prIdentityLine: '!82 Odd Minute Check', deliveryNoun: 'MR'
    });
    expect(buildPrStatusViewModel(input)).toMatchObject({ headline: 'Changes requested', prIdentityLine: '#82 Odd Minute Check' });
    // Numbers in running text take GitLab's sign too.
    expect(deliveryWords('PR #82 and pull request #83', 'GITLAB')).toBe('MR !82 and merge request !83');
  });
});

describe('a task opened from a pull request', () => {
  const opened = (crossRepository = false) => taskFixture({
    prompt: '',
    remoteSource: {
      provider: 'GITHUB', host: 'github.com', repositoryPath: 'example/repo', kind: 'PULL_REQUEST', number: 82,
      url: 'https://github.com/example/repo/pull/82', title: 'Odd Minute Check',
      snapshotArtifactId: '00000000-0000-4000-8000-000000000001', capturedAt: now,
      pullRequest: { headRefName: 'feature', baseRefName: 'main', crossRepository, headSha: 'aaa111', mergeBaseSha: 'base' }
    }
  });

  it('never offers to create a pull request while its own is unread', () => {
    const view = buildPrStatusViewModel({ task: opened(), gitSnapshot: gitFixture() });
    expect(view).toMatchObject({ canCreateDraftPr: false, canPushUpdate: false, canRefresh: true });
  });

  it('offers Sync branch when the pull request moved ahead of a clean worktree', () => {
    const view = buildPrStatusViewModel({
      task: opened(),
      gitSnapshot: gitFixture({ headSha: 'aaa111', upstreamSha: 'bbb222', behindCount: 1, status: 'PUSHED' }),
      pullRequest: prFixture({ headRefOid: 'bbb222' })
    });
    expect(view).toMatchObject({ kind: 'PR_NEWER_COMMITS', canSyncBranch: true, canPushUpdate: false });
    expect(buildPrStatusActionState({ view }).syncDisabled).toBe(false);
  });

  it('offers Sync branch after a rewrite only while the worktree holds nothing of its own', () => {
    const rewritten = { pullRequest: prFixture({ headRefOid: 'ccc333' }) };
    const atOldHead = buildPrStatusViewModel({
      task: opened(), ...rewritten, observedPullRequestHeads: ['ccc333', 'bbb222'],
      gitSnapshot: gitFixture({ headSha: 'bbb222', upstreamSha: 'ccc333', aheadCount: 1, behindCount: 1, status: 'DIVERGED' })
    });
    const withLocalCommit = buildPrStatusViewModel({
      task: opened(), ...rewritten, observedPullRequestHeads: ['ccc333', 'bbb222'],
      gitSnapshot: gitFixture({ headSha: 'ddd444', upstreamSha: 'ccc333', aheadCount: 2, behindCount: 1, status: 'DIVERGED' })
    });
    // Nothing of the worktree's own is at stake, so the card reads as a rewrite, not a conflict.
    expect(atOldHead).toMatchObject({ kind: 'BRANCH_DIVERGED', canSyncBranch: true, headline: 'PR rewritten', tone: 'action' });
    expect(withLocalCommit).toMatchObject({ kind: 'BRANCH_DIVERGED', canSyncBranch: false, headline: 'Branch diverged' });
  });

  it('holds Sync while the worktree has changes and states the reason', () => {
    const view = buildPrStatusViewModel({
      task: opened(),
      gitSnapshot: gitFixture({ headSha: 'aaa111', upstreamSha: 'bbb222', behindCount: 1, unstagedCount: 1, status: 'DIRTY' }),
      pullRequest: prFixture({ headRefOid: 'bbb222' })
    });
    expect(buildPrStatusActionState({ view })).toMatchObject({
      syncDisabled: true, syncReason: 'Commit or discard the worktree changes first.'
    });
  });

  it('states that Task Monki does not push to a fork instead of offering an update that cannot run', () => {
    const view = buildPrStatusViewModel({
      task: opened(true),
      gitSnapshot: gitFixture({ headSha: 'eee555', upstreamSha: 'aaa111', aheadCount: 1, status: 'COMMITTED_UNPUSHED' }),
      pullRequest: prFixture({ headRefOid: 'aaa111' })
    });
    expect(view).toMatchObject({ kind: 'LOCAL_NOT_PUSHED', canPushUpdate: false, guidanceLine: 'Task Monki does not push to forks.' });
  });
});

describe('buildPrStatusViewModel', () => {
  it('shows no PR before delivery exists', () => {
    const view = buildPrStatusViewModel({ task: taskFixture() });

    expect(view.headline).toBe('No PR');
    expect(view.canCreateDraftPr).toBe(true);
    expect(view.createDraftPrDisabledReason).toBe('Refresh Git evidence before opening a PR.');
    expect(view.canRefresh).toBe(false);
  });

  it('disables PR creation before click when there are no task changes to publish', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture({
        projection: {
          ...createInitialProjection(now),
          worktree: 'PRESENT',
          git: 'CLEAN'
        }
      }),
      gitSnapshot: gitFixture({
        status: 'CLEAN',
        commitsAheadOfBase: 0,
        committedDiffFileCount: 0
      })
    });
    const actionState = buildPrStatusActionState({ view });

    expect(view.headline).toBe('No PR');
    expect(view.leadLine).toBe('Run implementation or make a task change before opening a PR.');
    expect(actionState.createOrPushDisabled).toBe(true);
    expect(actionState.createOrPushReason).toBe(
      'Run implementation or make a task change before opening a PR.'
    );
  });

  it('keeps delivery unavailable until a blocked implementation is retried', () => {
    const reason = 'Retry the implementation or continue unfinished work before review.';
    const task = taskFixture({
      currentRunId: 'run-1',
      projection: {
        ...createInitialProjection(now),
        worktree: 'PRESENT',
        git: 'DIRTY',
        implementationRetry: { runId: 'run-1', reason }
      }
    });
    const view = buildPrStatusViewModel({
      task,
      gitSnapshot: gitFixture({ status: 'DIRTY', workingDiffFileCount: 1 })
    });
    const actions = buildPrStatusActionState({
      view,
      implementationRetryReason: reason
    });

    expect(view.canCreateDraftPr).toBe(true);
    expect(view.createDraftPrDisabledReason).toBe(reason);
    expect(actions.createOrPushDisabled).toBe(true);
    expect(actions.createOrPushReason).toBe(reason);
  });

  it('explains why no PR action is unavailable before a worktree exists', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture({
        projection: {
          ...createInitialProjection(now),
          worktree: 'NOT_CREATED'
        }
      })
    });

    expect(view.canCreateDraftPr).toBe(false);
    expect(view.leadLine).toBe('A worktree is required before a draft PR can be opened.');
  });

  it('prioritizes failing checks over Waiting for review', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({
        status: 'FAILING',
        failingCount: 2,
        passingCount: 3,
        skippedCount: 1,
        checkDetails: [
          {
            name: 'lint-and-test',
            status: 'failed',
            workflow: 'CI',
            link: 'https://github.com/example/repo/actions/runs/1',
            startedAt: '2026-07-01T09:00:00.000Z',
            completedAt: '2026-07-01T09:03:02.000Z'
          }
        ]
      }),
      reviewRollup: {
        id: 'review-1',
        taskId: 'task-1',
        iterationId: 'iteration-1',
        worktreeId: 'worktree-1',
        pullRequestNumber: 82,
        headSha: 'abc123',
        status: 'REQUESTED',
        observedAt: now
      }
    });

    expect(view.headline).toBe('Checks failed');
    expect(view.prTitle).toBe('Odd Minute Check');
    expect(view.prIdentityLine).toBe('#82 Odd Minute Check');
    expect(view.checkSummaryLine).toBe('2 failed, 1 skipped, 3 passed');
    expect(view.evidenceLine).toBeUndefined();
    expect(view.guidanceLine).toBeUndefined();
    expect(view.canInvestigateFailure).toBe(true);
    expect(view.checkGroups[0]).toMatchObject({ status: 'failed', defaultOpen: false });
  });

  it('allows blocked checks to start the same failure investigation flow', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({
        status: 'BLOCKED',
        failingCount: 0,
        totalCount: 0
      })
    });

    expect(view.headline).toBe('Checks failed');
    expect(view.guidanceLine).toBeUndefined();
    expect(view.evidenceLine).toBeUndefined();
    expect(view.canInvestigateFailure).toBe(true);
  });

  it('orders check rows by severity like the PR status card spec', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({
        status: 'FAILING',
        checkDetails: [
          { name: 'passed-check', status: 'passed' },
          { name: 'skipped-check', status: 'skipped' },
          { name: 'pending-check', status: 'pending' },
          { name: 'canceled-check', status: 'canceled' },
          { name: 'failed-check', status: 'failed' }
        ]
      })
    });

    expect(view.checkGroups.map((group) => group.status)).toEqual([
      'failed',
      'canceled',
      'pending',
      'skipped',
      'passed'
    ]);
    expect(view.evidenceLine).toBeUndefined();
  });

  it('uses aggregate check evidence only when exact check rows are unavailable', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({
        status: 'PENDING',
        pendingCount: 2,
        passingCount: 1
      })
    });

    expect(view.headline).toBe('Checks pending');
    expect(view.checkGroups).toEqual([]);
    expect(view.checkSummaryLine).toBe('2 pending, 1 passed');
    expect(view.evidenceLine).toBe('2 pending, 1 passed');
  });

  it('uses the spec copy for refreshed time and ready evidence', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'PASSING', passingCount: 3 }),
      reviewRollup: reviewFixture({ status: 'APPROVED' }),
      mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
    });

    expect(view.headline).toBe('Ready to merge');
    expect(view.refreshedLine).not.toContain('Refreshed');
    expect(view.checkSummaryLine).toBeUndefined();
    expect(view.reviewLine).toBe('Approved');
    expect(view.mergeLine).toBe('Mergeable');
    expect(view.evidenceLine).toBe('3 checks passed for head abc123, approved, mergeable');
  });

  it('shows passing checks only when they match the current PR identity', () => {
    const current = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ isDraft: true, status: 'OPEN_DRAFT' }),
      ciRollup: ciFixture({ status: 'PASSING', passingCount: 2 })
    });
    const stale = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ pullRequestNumber: 81, status: 'PASSING', passingCount: 2 })
    });
    const unknown = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ number: undefined }),
      ciRollup: ciFixture({ status: 'PASSING', passingCount: 2 })
    });

    expect(current.evidenceLine).toBe('2 checks passed for head abc123');
    expect(stale).toMatchObject({ kind: 'STALE', headline: 'Checks stale' });
    expect(stale.evidenceLine).toBeUndefined();
    expect(unknown).toMatchObject({ kind: 'UNKNOWN', headline: 'Checks identity unknown' });
  });

  it('keeps missing, not-reported, no-check, and unknown CI states distinct', () => {
    const missing = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      reviewRollup: reviewFixture({ status: 'REQUESTED' })
    });
    const expected = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'EXPECTED_NOT_REPORTED' })
    });
    const none = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'NO_CHECKS' })
    });
    const skipped = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'NO_CHECKS', totalCount: 2, skippedCount: 2 })
    });
    const unknown = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'UNKNOWN' })
    });

    expect(missing.evidenceLine).toBe('Checks not observed');
    expect(expected.headline).toBe('Expected checks not reported');
    expect(skipped.headline).toBe('Checks skipped');
    // No checks at all, or unknown checks, is evidence to state — not a headline
    // that outranks the pull request's own state (PR_STATUS_CARD_FLOW priority).
    expect(none.headline).toBe('Open PR');
    expect(none.evidenceLine).toBe('No checks reported');
    expect(unknown.headline).toBe('Open PR');
    expect(unknown.evidenceLine).toBe('Checks unknown');
  });

  it('waits on reviewers once the person answered a review that requested changes', () => {
    const feedback = (lastViewerCommentAt?: string) => ({
      artifactId: '00000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64), capturedAt: now, unresolvedCount: 1, discussionCount: 2,
      reviewers: [{ name: 'alice', state: 'CHANGES_REQUESTED' as const }], lastOtherCommentAt: '2026-10-17T10:00:00.000Z',
      ...(lastViewerCommentAt ? { lastViewerCommentAt } : {})
    });
    const view = (lastViewerCommentAt?: string) => buildPrStatusViewModel({
      task: taskFixture(), pullRequest: prFixture(), ciRollup: ciFixture({ status: 'PASSING', totalCount: 1, passingCount: 1 }),
      reviewRollup: reviewFixture({ status: 'CHANGES_REQUESTED', feedback: feedback(lastViewerCommentAt) }), mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
    });
    expect(view()).toMatchObject({ kind: 'GITHUB_CHANGES_REQUESTED', headline: 'Changes requested', fact: 'alice requested changes, 1 unresolved thread' });
    expect(view('2026-10-17T10:05:00.000Z')).toMatchObject({ kind: 'GITHUB_REVIEW_WAITING', headline: 'Waiting for review', fact: 'Waiting on alice', canMerge: false });
  });

  it('does not call a pushed head ready to merge before its checks had a minute to start', () => {
    const pullRequest = prFixture();
    const earlier = ciFixture({ id: 'ci-0', headSha: 'old111', status: 'PASSING', totalCount: 2, passingCount: 2, observedAt: '2026-10-17T10:00:00.000Z' });
    const pushed = ciFixture({ headSha: 'abc123', status: 'NO_CHECKS', totalCount: 0, observedAt: '2026-10-17T10:05:00.000Z' });
    // Earlier heads had checks, so none yet for this one may only mean they have not started.
    expect(checksMayNotHaveStarted(pullRequest, [pushed, earlier])).toBe(true);
    const view = buildPrStatusViewModel({
      task: taskFixture(), pullRequest, ciRollup: pushed, checksMayNotHaveStarted: true,
      reviewRollup: reviewFixture({ status: 'NOT_REQUESTED' }), mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
    });
    expect(view).toMatchObject({ kind: 'CHECKS_PENDING', headline: 'Checks pending', canMerge: false, fact: 'No checks reported yet' });
    // A reading a minute after the head appeared that still has none says this head has no checks.
    const later = ciFixture({ id: 'ci-2', headSha: 'abc123', status: 'NO_CHECKS', totalCount: 0, observedAt: '2026-10-17T10:06:10.000Z' });
    expect(checksMayNotHaveStarted(pullRequest, [later, pushed, earlier])).toBe(false);
    // A pull request that never had checks is a repository without CI.
    expect(checksMayNotHaveStarted(pullRequest, [pushed])).toBe(false);
  });

  it('keeps GitHub review and draft state visible in a repository without CI', () => {
    const changesRequested = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'NO_CHECKS' }),
      reviewRollup: reviewFixture({ status: 'CHANGES_REQUESTED' })
    });
    const draft = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ isDraft: true }),
      ciRollup: ciFixture({ status: 'NOT_APPLICABLE' })
    });

    expect(changesRequested.headline).toBe('Changes requested');
    expect(changesRequested.evidenceLine).toBe('No checks reported');
    expect(draft.headline).toBe('Draft PR');
    expect(draft.evidenceLine).toBeUndefined();
  });

  it('does not apply delivery records without the current PR identity', () => {
    const failedChecks = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ headSha: undefined, status: 'FAILING', failingCount: 1 })
    });
    const requestedChanges = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      reviewRollup: reviewFixture({ headSha: undefined, status: 'CHANGES_REQUESTED' })
    });
    const terminalMerge = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      mergeSnapshot: mergeFixture({ headSha: undefined, status: 'MERGED' })
    });

    expect(failedChecks).toMatchObject({ kind: 'UNKNOWN', headline: 'Checks identity unknown' });
    expect(requestedChanges).toMatchObject({ kind: 'UNKNOWN', headline: 'Review identity unknown' });
    expect(terminalMerge).toMatchObject({ kind: 'OPEN', headline: 'Open PR' });
  });

  it('does not let a stale merge record make the current PR terminal', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ headRefOid: 'current-head' }),
      mergeSnapshot: mergeFixture({ headSha: 'old-head', status: 'MERGED' })
    });

    expect(view).toMatchObject({ kind: 'STALE', headline: 'Checks stale' });
  });

  it('does not call a PR ready to merge when CI or review evidence is missing', () => {
    const missingCi = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      reviewRollup: reviewFixture({ status: 'APPROVED' }),
      mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
    });
    const missingReview = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'PASSING', passingCount: 3 }),
      mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
    });

    expect(missingCi.headline).toBe('Open PR');
    expect(missingReview.headline).toBe('Open PR');
  });

  it('keeps draft PR ahead of ready-to-merge evidence', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ isDraft: true, status: 'OPEN_DRAFT' }),
      ciRollup: ciFixture({ status: 'PASSING', passingCount: 3 }),
      reviewRollup: reviewFixture({ status: 'APPROVED' }),
      mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
    });

    expect(view.headline).toBe('Draft PR');
  });

  it('does not add redundant evidence copy for review headline states', () => {
    const waiting = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      reviewRollup: reviewFixture({ status: 'REQUESTED' })
    });
    const changesRequested = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      reviewRollup: reviewFixture({ status: 'CHANGES_REQUESTED' })
    });

    expect(waiting.headline).toBe('Waiting for review');
    expect(waiting.reviewLine).toBeUndefined();
    expect(changesRequested.headline).toBe('Changes requested');
    expect(changesRequested.reviewLine).toBeUndefined();
  });

  it('says who asked for changes and what is unresolved, for the open pull request the feedback was read with', () => {
    const feedback = {
      artifactId: '00000000-0000-4000-8000-000000000002', digest: 'a'.repeat(64), capturedAt: now,
      unresolvedCount: 2, discussionCount: 3, reviewers: [{ name: 'alice', state: 'CHANGES_REQUESTED' as const }]
    };
    const view = (pullRequest: Partial<PullRequestSnapshotRecord>, reviewRollup: Partial<ReviewRollupRecord> = {}) => buildPrStatusViewModel({
      task: taskFixture(), gitSnapshot: gitFixture(), pullRequest: prFixture(pullRequest),
      reviewRollup: reviewFixture({ status: 'CHANGES_REQUESTED', feedback, ...reviewRollup })
    });
    expect(view({})).toMatchObject({ headline: 'Changes requested', feedbackLine: 'alice requested changes, 2 unresolved threads' });
    // A merged pull request asks nothing more, and another pull request's feedback is not this one's.
    expect(view({ status: 'MERGED', state: 'MERGED' }).feedbackLine).toBeUndefined();
    expect(view({}, { pullRequestNumber: 81 }).feedbackLine).toBeUndefined();
  });

  it('does not carry ready evidence copy into terminal or freshness states', () => {
    const merged = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ status: 'MERGED', state: 'MERGED' }),
      reviewRollup: reviewFixture({ status: 'APPROVED' }),
      mergeSnapshot: mergeFixture({ status: 'MERGED' })
    });
    const stale = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ headRefOid: 'new-head' }),
      ciRollup: ciFixture({ headSha: 'old-head', status: 'PASSING', passingCount: 3 }),
      reviewRollup: reviewFixture({ status: 'APPROVED' }),
      mergeSnapshot: mergeFixture({ headSha: 'new-head', status: 'MERGEABLE' })
    });

    expect(merged.headline).toBe('Merged');
    expect(merged.reviewLine).toBeUndefined();
    expect(merged.mergeLine).toBeUndefined();
    expect(stale.headline).toBe('Checks stale');
    expect(stale.reviewLine).toBeUndefined();
    expect(stale.mergeLine).toBeUndefined();
  });

  it('covers the full PR status card state matrix', () => {
    const cases: Array<{
      name: string;
      input: Parameters<typeof buildPrStatusViewModel>[0];
      expected: {
        kind: string;
        headline: string;
        tone: string;
        canCreateDraftPr?: boolean;
        canRefresh?: boolean;
        canInvestigateFailure?: boolean;
        canPushUpdate?: boolean;
      };
    }> = [
      {
        name: 'no PR',
        input: { task: taskFixture() },
        expected: {
          kind: 'NO_PR',
          headline: 'No PR',
          tone: 'neutral',
          canCreateDraftPr: true,
          canRefresh: false
        }
      },
      {
        name: 'draft PR',
        input: { task: taskFixture(), pullRequest: prFixture({ isDraft: true, status: 'OPEN_DRAFT' }) },
        expected: { kind: 'DRAFT', headline: 'Draft PR', tone: 'info', canRefresh: true }
      },
      {
        name: 'open PR',
        input: { task: taskFixture(), pullRequest: prFixture() },
        expected: { kind: 'OPEN', headline: 'Open PR', tone: 'neutral', canRefresh: true }
      },
      {
        name: 'pending checks',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          ciRollup: ciFixture({ status: 'PENDING', pendingCount: 2, passingCount: 1 })
        },
        expected: { kind: 'CHECKS_PENDING', headline: 'Checks pending', tone: 'action' }
      },
      {
        name: 'failed checks',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          ciRollup: ciFixture({ status: 'FAILING', failingCount: 1 })
        },
        expected: {
          kind: 'CHECKS_FAILED',
          headline: 'Checks failed',
          tone: 'error',
          canInvestigateFailure: true
        }
      },
      {
        name: 'canceled checks',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          ciRollup: ciFixture({ status: 'CANCELED', canceledCount: 1 })
        },
        expected: { kind: 'CHECKS_CANCELED', headline: 'Checks canceled', tone: 'action' }
      },
      {
        name: 'no required checks',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          ciRollup: ciFixture({ status: 'NO_CHECKS', totalCount: 2, skippedCount: 2 })
        },
        expected: { kind: 'NO_REQUIRED_CHECKS', headline: 'Checks skipped', tone: 'action' }
      },
      {
        name: 'review waiting',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          reviewRollup: reviewFixture({ status: 'REQUESTED' })
        },
        expected: { kind: 'GITHUB_REVIEW_WAITING', headline: 'Waiting for review', tone: 'action' }
      },
      {
        name: 'changes requested',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          reviewRollup: reviewFixture({ status: 'CHANGES_REQUESTED' })
        },
        expected: {
          kind: 'GITHUB_CHANGES_REQUESTED',
          headline: 'Changes requested',
          tone: 'error'
        }
      },
      {
        name: 'ready to merge',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          ciRollup: ciFixture({ status: 'PASSING', passingCount: 3 }),
          reviewRollup: reviewFixture({ status: 'APPROVED' }),
          mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
        },
        expected: { kind: 'READY_TO_MERGE', headline: 'Ready to merge', tone: 'success' }
      },
      {
        // A repository without CI never reports a check; the platform's merge state decides.
        name: 'ready to merge without CI',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          ciRollup: ciFixture({ status: 'NO_CHECKS', totalCount: 0 }),
          reviewRollup: reviewFixture({ status: 'NOT_REQUESTED' }),
          mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
        },
        expected: { kind: 'READY_TO_MERGE', headline: 'Ready to merge', tone: 'success' }
      },
      {
        name: 'merged',
        input: { task: taskFixture(), pullRequest: prFixture({ status: 'MERGED', state: 'MERGED' }) },
        expected: { kind: 'MERGED', headline: 'Merged', tone: 'success' }
      },
      {
        name: 'closed without merge',
        input: {
          task: taskFixture(),
          pullRequest: prFixture({ status: 'CLOSED_UNMERGED', state: 'CLOSED' }),
          gitSnapshot: gitFixture({ status: 'COMMITTED_UNPUSHED' })
        },
        expected: {
          kind: 'CLOSED_UNMERGED',
          headline: 'Closed without merge',
          tone: 'error',
          canCreateDraftPr: true
        }
      },
      {
        name: 'branch diverged',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          gitSnapshot: gitFixture({ status: 'DIVERGED' })
        },
        expected: { kind: 'BRANCH_DIVERGED', headline: 'Branch diverged', tone: 'error' }
      },
      {
        name: 'stale evidence',
        input: {
          task: taskFixture(),
          pullRequest: prFixture({ headRefOid: 'new-head' }),
          ciRollup: ciFixture({ headSha: 'old-head', status: 'PASSING', passingCount: 2 })
        },
        expected: {
          kind: 'STALE',
          headline: 'Checks stale',
          tone: 'action',
          canInvestigateFailure: false
        }
      },
      {
        name: 'local changes not pushed',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          gitSnapshot: gitFixture({ unstagedCount: 1, workingDiffFileCount: 1, status: 'DIRTY' })
        },
        expected: {
          kind: 'LOCAL_NOT_PUSHED',
          headline: 'Changes not pushed',
          tone: 'action',
          canInvestigateFailure: false,
          canPushUpdate: true
        }
      },
      {
        name: 'PR has newer commits',
        input: {
          task: taskFixture(),
          pullRequest: prFixture({ headRefOid: 'remote-head' }),
          gitSnapshot: gitFixture({ headSha: 'local-head', status: 'CLEAN' }),
          branchPublication: branchPublicationFixture({ headSha: 'local-head' })
        },
        expected: { kind: 'PR_NEWER_COMMITS', headline: 'PR has newer commits', tone: 'action' }
      }
    ];

    for (const scenario of cases) {
      const view = buildPrStatusViewModel(scenario.input);
      expect(
        {
          kind: view.kind,
          headline: view.headline,
          tone: view.tone,
          canCreateDraftPr: view.canCreateDraftPr,
          canRefresh: view.canRefresh,
          canInvestigateFailure: view.canInvestigateFailure,
          canPushUpdate: view.canPushUpdate
        },
        scenario.name
      ).toMatchObject(scenario.expected);
    }
  });

  it('marks PR evidence stale when rollups are for a different PR head', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ headRefOid: 'new-head' }),
      ciRollup: ciFixture({ headSha: 'old-head', status: 'PASSING', passingCount: 3 })
    });

    expect(view.headline).toBe('Checks stale');
    expect(view.freshnessLine).toBe('Refresh PR status for the current head.');
  });

  it('does not offer failing-check investigation when check evidence is stale', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ headRefOid: 'new-head' }),
      ciRollup: ciFixture({
        headSha: 'old-head',
        status: 'FAILING',
        failingCount: 1,
        checkDetails: [
          {
            name: 'lint-and-test',
            status: 'failed',
            workflow: 'CI',
            link: 'https://github.com/example/repo/actions/runs/1'
          }
        ]
      })
    });

    expect(view.kind).toBe('STALE');
    expect(view.freshnessLine).toBe('Refresh PR status for the current head.');
    expect(view.canInvestigateFailure).toBe(false);
    expect(view.guidanceLine).toBeUndefined();
    expect(view.checkSummaryLine).toBeUndefined();
    expect(view.evidenceLine).toBeUndefined();
    expect(view.checkGroups).toEqual([]);
  });

  it('marks local commits as not pushed when local head differs from PR head', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ headRefOid: 'remote-head' }),
      gitSnapshot: gitFixture({ headSha: 'local-head', status: 'COMMITTED_UNPUSHED' }),
      branchPublication: {
        id: 'publication-1',
        taskId: 'task-1',
        iterationId: 'iteration-1',
        worktreeId: 'worktree-1',
        remoteName: 'origin',
        branchName: 'task/auth-refresh',
        remoteRef: 'origin/task/auth-refresh',
        headSha: 'remote-head',
        status: 'PUSHED',
        requestedAt: now,
        updatedAt: now
      }
    });

    expect(view.headline).toBe('Changes not pushed');
    expect(view.canPushUpdate).toBe(true);
  });

  it('does not inherit failing-check actions while local changes need to be pushed', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      gitSnapshot: gitFixture({ unstagedCount: 1, workingDiffFileCount: 1, status: 'DIRTY' }),
      ciRollup: ciFixture({
        status: 'FAILING',
        failingCount: 1,
        checkDetails: [
          {
            name: 'lint-and-test',
            status: 'failed',
            workflow: 'CI',
            link: 'https://github.com/example/repo/actions/runs/1'
          }
        ]
      })
    });

    expect(view.kind).toBe('LOCAL_NOT_PUSHED');
    expect(view.freshnessLine).toBe('Local worktree has uncommitted changes.');
    expect(view.canPushUpdate).toBe(true);
    expect(view.canInvestigateFailure).toBe(false);
    expect(view.guidanceLine).toBeUndefined();
    expect(view.checkSummaryLine).toBeUndefined();
    expect(view.evidenceLine).toBeUndefined();
    expect(view.checkGroups).toEqual([]);
  });

  it('turns a rejected push into an actionable branch state', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      gitSnapshot: gitFixture({ status: 'COMMITTED_UNPUSHED', headSha: 'local-head' }),
      branchPublication: branchPublicationFixture({
        status: 'FAILED',
        headSha: 'old-head',
        error: 'Remote branch has newer commits. Sync the branch before pushing again.'
      })
    });

    expect(view.headline).toBe('Branch diverged');
    expect(view.freshnessLine).toBe(
      'Remote branch has newer commits. Sync the branch before pushing again.'
    );
    expect(view.canPushUpdate).toBe(false);
  });

  it('offers a safe remote recheck while an interrupted push remains ambiguous', () => {
    const reason =
      'Remote branch is at abc123, not the attempted def456. Sync or inspect the remote before retrying.';
    const withoutPr = buildPrStatusViewModel({
      task: taskFixture(),
      gitSnapshot: gitFixture({ status: 'COMMITTED_UNPUSHED' }),
      branchPublication: branchPublicationFixture({
        status: 'AMBIGUOUS',
        error: reason
      })
    });
    const withPr = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      gitSnapshot: gitFixture({ status: 'COMMITTED_UNPUSHED' }),
      branchPublication: branchPublicationFixture({
        status: 'AMBIGUOUS',
        error: reason
      })
    });

    expect(withoutPr).toMatchObject({
      headline: 'No PR',
      leadLine: reason,
      canCreateDraftPr: true
    });
    expect(buildPrStatusActionState({ view: withoutPr }).createOrPushDisabled).toBe(
      false
    );
    expect(withPr).toMatchObject({
      headline: 'Branch diverged',
      freshnessLine: reason,
      canPushUpdate: true
    });
    expect(buildPrStatusActionState({ view: withPr }).createOrPushDisabled).toBe(
      false
    );
  });

  it('keeps retryable push failures visible without disabling the next push attempt', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      gitSnapshot: gitFixture({ status: 'COMMITTED_UNPUSHED', headSha: 'local-head' }),
      branchPublication: branchPublicationFixture({
        status: 'FAILED',
        headSha: 'old-head',
        error: 'GitHub authentication required.'
      })
    });
    const actions = buildPrStatusActionState({ view });

    expect(view.headline).toBe('Changes not pushed');
    expect(view.freshnessLine).toBe('Last push failed: GitHub authentication required.');
    expect(view.canPushUpdate).toBe(true);
    expect(actions.createOrPushDisabled).toBe(false);
  });

  it('keeps retryable PR creation publication failures visible without dead-ending the action', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      gitSnapshot: gitFixture({ status: 'COMMITTED_UNPUSHED' }),
      branchPublication: branchPublicationFixture({
        status: 'FAILED',
        error: 'GitHub authentication required.'
      })
    });
    const actions = buildPrStatusActionState({ view });

    expect(view.headline).toBe('No PR');
    expect(view.leadLine).toBe('Last push failed: GitHub authentication required.');
    expect(view.canCreateDraftPr).toBe(true);
    expect(actions.createOrPushDisabled).toBe(false);
  });

  it('allows creating a replacement draft PR after a PR is closed without merge', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ status: 'CLOSED_UNMERGED', state: 'CLOSED' }),
      gitSnapshot: gitFixture({ status: 'COMMITTED_UNPUSHED' })
    });
    const actions = buildPrStatusActionState({ view });

    expect(view.headline).toBe('Closed without merge');
    expect(view.canCreateDraftPr).toBe(true);
    expect(actions.createOrPushDisabled).toBe(false);
  });

  it('builds a targeted failing CI investigation prompt', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({
        status: 'FAILING',
        failingCount: 1,
        checkDetails: [
          {
            name: 'build',
            status: 'failed',
            workflow: 'CI',
            link: 'https://github.com/example/repo/actions/runs/2'
          }
        ]
      })
    });

    expect(buildFailingChecksInvestigationPrompt(view)).toContain(
      'Fix the failing GitHub checks for PR #82 at head abc123.'
    );
    expect(buildFailingChecksInvestigationPrompt(view)).toContain(
      '- build (CI): status failed | https://github.com/example/repo/actions/runs/2'
    );
    expect(buildFailingChecksInvestigationPrompt(view)).toContain('Do not push; the person pushes the update from Task Monki.');
  });
});

describe('buildPrStatusActionState', () => {
  it('keeps refresh available but pauses mutating PR actions while review runs', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'FAILING', failingCount: 1 })
    });

    const actions = buildPrStatusActionState({
      view,
      pauseReason: 'review-running',
      hasInvestigationSource: true
    });

    expect(actions.refreshDisabled).toBe(false);
    expect(actions.createOrPushDisabled).toBe(true);
    expect(actions.investigateDisabled).toBe(true);
    expect(actions.investigateReason).toBe('Delivery actions pause while review runs.');
    expect(actions.hint).toBe('Delivery actions pause while review runs.');
  });

  it('disables all PR actions while a GitHub action is already running', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      gitSnapshot: gitFixture({ unstagedCount: 1, workingDiffFileCount: 1, status: 'DIRTY' })
    });

    const actions = buildPrStatusActionState({
      view,
      deliveryBusy: true,
      hasInvestigationSource: true
    });

    expect(actions.refreshDisabled).toBe(true);
    expect(actions.createOrPushDisabled).toBe(true);
    expect(actions.investigateDisabled).toBe(true);
    expect(actions.refreshReason).toBe('GitHub action is in progress.');
    expect(actions.hint).toBe('GitHub action is in progress.');
  });

  it('explains when failing checks cannot be investigated from a source run', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({ status: 'FAILING', failingCount: 1 })
    });

    const actions = buildPrStatusActionState({
      view,
      hasInvestigationSource: false
    });

    expect(actions.refreshDisabled).toBe(false);
    expect(actions.investigateDisabled).toBe(true);
    expect(actions.investigateReason).toBe('No completed run is available.');
    expect(actions.hint).toBe('No completed run is available.');
  });
});

describe('buildPrStatusCreateOrPushTitle', () => {
  it('omits a disabled action title when the same reason is already visible', () => {
    expect(
      buildPrStatusCreateOrPushTitle(
        { leadLine: 'Run implementation or make a task change before opening a PR.' },
        'Run implementation or make a task change before opening a PR.'
      )
    ).toBeUndefined();
  });

  it('keeps paused action titles when they are not visible in the card', () => {
    expect(
      buildPrStatusCreateOrPushTitle(
        { leadLine: 'Run implementation or make a task change before opening a PR.' },
        'Delivery actions pause while the agent runs.'
      )
    ).toBe('Delivery actions pause while the agent runs.');
  });
});

describe('shouldShowPrStatusOnOverview', () => {
  it('hides neutral unstarted states and keeps blockers, delivery decisions, or evidence visible', () => {
    const cleanNoChange = buildPrStatusViewModel({
      task: taskFixture(),
      gitSnapshot: gitFixture({
        commitsAheadOfBase: 0,
        committedDiffFileCount: 0
      })
    });
    const dirty = buildPrStatusViewModel({
      task: taskFixture(),
      gitSnapshot: gitFixture({
        unstagedCount: 1,
        workingDiffFileCount: 1,
        status: 'DIRTY'
      })
    });
    const publicationFailed = buildPrStatusViewModel({
      task: taskFixture(),
      gitSnapshot: gitFixture(),
      branchPublication: branchPublicationFixture({
        status: 'FAILED',
        error: 'Push failed. Try again.'
      })
    });
    const diverged = buildPrStatusViewModel({
      task: taskFixture(),
      gitSnapshot: gitFixture({ status: 'DIVERGED', behindCount: 1 })
    });
    const existing = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture()
    });
    const stale = buildPrStatusViewModel({
      task: taskFixture(),
      gitSnapshot: gitFixture({
        headSha: 'local-newer',
        commitsAheadOfBase: 2,
        committedDiffFileCount: 2
      }),
      pullRequest: prFixture({ headRefOid: 'published-older' })
    });
    const terminal = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture({ status: 'MERGED', state: 'MERGED' })
    });
    const notCreated = buildPrStatusViewModel({
      task: taskFixture({
        projection: {
          ...createInitialProjection(now),
          worktree: 'NOT_CREATED'
        }
      })
    });
    const notInspected = buildPrStatusViewModel({
      task: taskFixture({
        projection: {
          ...createInitialProjection(now),
          worktree: 'PRESENT',
          git: 'NOT_INSPECTED'
        }
      })
    });
    const missingWorktree = buildPrStatusViewModel({
      task: taskFixture({
        projection: {
          ...createInitialProjection(now),
          worktree: 'MISSING'
        }
      })
    });
    const worktreeError = buildPrStatusViewModel({
      task: taskFixture({
        projection: {
          ...createInitialProjection(now),
          worktree: 'ERROR'
        }
      })
    });

    expect(shouldShowPrStatusOnOverview(cleanNoChange)).toBe(false);
    expect(shouldShowPrStatusOnOverview(notCreated)).toBe(false);
    expect(shouldShowPrStatusOnOverview(notInspected)).toBe(false);
    for (const view of [
      dirty,
      publicationFailed,
      diverged,
      existing,
      stale,
      terminal,
      missingWorktree,
      worktreeError
    ]) {
      expect(shouldShowPrStatusOnOverview(view)).toBe(true);
    }
  });
});

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: overrides.kind ?? 'NORMAL',
    runtimeId: 'codex',
    title: 'Task',
    prompt: 'Prompt',
    repositoryId: '/tmp/repo',
    workflowPhase: 'REVIEW',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    projection: {
      ...createInitialProjection(now),
      worktree: 'PRESENT'
    },
    ...overrides
  };
}

describe('the pull request step', () => {
  it('offers ready for review only for a current draft whose checks did not fail, and merge only when the evidence says it would merge', () => {
    const draft = (extra: Partial<Parameters<typeof buildPrStatusViewModel>[0]> = {}) => buildPrStatusViewModel({
      task: taskFixture(), pullRequest: prFixture({ status: 'OPEN_DRAFT', isDraft: true }), gitSnapshot: gitFixture({ status: 'PUSHED' }),
      branchPublication: branchPublicationFixture(), ...extra
    });
    expect(draft()).toMatchObject({ kind: 'DRAFT', canMarkReady: true, canMerge: false });
    // Work the draft does not hold yet is pushed first; a failure is fixed first.
    expect(draft({ gitSnapshot: gitFixture({ status: 'DIRTY', unstagedCount: 1 }) })).toMatchObject({ kind: 'LOCAL_NOT_PUSHED', canMarkReady: false });
    const failed = draft({ ciRollup: ciFixture({ status: 'FAILING', totalCount: 2, failingCount: 2, checkDetails: [
      { name: 'unit', status: 'failed' }, { name: 'lint', status: 'failed' }
    ] }) });
    expect(failed).toMatchObject({ kind: 'CHECKS_FAILED', canMarkReady: false, fact: 'unit and lint failed' });

    const ready = buildPrStatusViewModel({
      task: taskFixture(), pullRequest: prFixture(), gitSnapshot: gitFixture({ status: 'PUSHED' }), branchPublication: branchPublicationFixture(),
      ciRollup: ciFixture({ status: 'PASSING', totalCount: 3, passingCount: 3 }),
      reviewRollup: reviewFixture({ status: 'APPROVED' }), mergeSnapshot: mergeFixture({ status: 'MERGEABLE' })
    });
    expect(ready).toMatchObject({ kind: 'READY_TO_MERGE', canMerge: true, canMarkReady: false });
    const waiting = buildPrStatusViewModel({
      task: taskFixture(), pullRequest: prFixture(), gitSnapshot: gitFixture({ status: 'PUSHED' }), branchPublication: branchPublicationFixture(),
      reviewRollup: reviewFixture({ status: 'REQUESTED' }), mergeSnapshot: mergeFixture({ status: 'NOT_MERGED' })
    });
    expect(waiting).toMatchObject({ kind: 'GITHUB_REVIEW_WAITING', canMerge: false });

    // A base that moved holds the merge back; the agent can merge it in, and the step says which way it moved.
    const behind = buildPrStatusViewModel({
      task: taskFixture(), pullRequest: prFixture(), gitSnapshot: gitFixture({ status: 'PUSHED' }), branchPublication: branchPublicationFixture(),
      reviewRollup: reviewFixture({ status: 'APPROVED' }),
      mergeSnapshot: mergeFixture({ status: 'BLOCKED', raw: { mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE' } })
    });
    expect(behind).toMatchObject({ baseUpdate: { base: 'main', reason: 'BEHIND' }, fact: 'Behind main', canMerge: false });
    // Commits on the pull request's branch beside the worktree's own are pulled in, never pushed over.
    const diverged = buildPrStatusViewModel({
      task: taskFixture(), pullRequest: prFixture(), gitSnapshot: gitFixture({ status: 'DIVERGED', aheadCount: 1, behindCount: 2 }),
      branchPublication: branchPublicationFixture()
    });
    expect(diverged).toMatchObject({ kind: 'BRANCH_DIVERGED', canPullChanges: true, canPushUpdate: false });
  });
});

function prFixture(overrides: Partial<PullRequestSnapshotRecord> = {}): PullRequestSnapshotRecord {
  return {
    id: 'pr-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    number: 82,
    url: 'https://github.com/example/repo/pull/82',
    status: 'OPEN_READY',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'task/auth-refresh',
    headRefOid: 'abc123',
    baseRefName: 'main',
    title: 'Odd Minute Check',
    observedAt: now,
    ...overrides
  };
}

function ciFixture(overrides: Partial<CiRollupRecord> = {}): CiRollupRecord {
  return {
    id: 'ci-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    pullRequestNumber: 82,
    headSha: 'abc123',
    status: 'PASSING',
    requiredStatus: 'UNKNOWN',
    totalCount: 0,
    pendingCount: 0,
    passingCount: 0,
    failingCount: 0,
    skippedCount: 0,
    canceledCount: 0,
    checkDetails: [],
    observedAt: now,
    ...overrides
  };
}

function gitFixture(overrides: Partial<GitSnapshotRecord> = {}): GitSnapshotRecord {
  return {
    id: 'git-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    worktreePath: '/tmp/repo',
    repoRoot: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    headSha: 'abc123',
    branch: 'task/auth-refresh',
    baseSha: 'base',
    aheadCount: 0,
    behindCount: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    commitsAheadOfBase: 1,
    committedDiffFileCount: 1,
    workingDiffFileCount: 0,
    diffStat: '',
    dirtyFingerprint: 'clean',
    status: 'CLEAN',
    capturedAt: now,
    ...overrides
  };
}

function branchPublicationFixture(
  overrides: Partial<BranchPublicationRecord> = {}
): BranchPublicationRecord {
  return {
    id: 'publication-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    remoteName: 'origin',
    branchName: 'task/auth-refresh',
    remoteRef: 'origin/task/auth-refresh',
    headSha: 'abc123',
    status: 'PUSHED',
    requestedAt: now,
    updatedAt: now,
    ...overrides
  };
}

function reviewFixture(overrides: Partial<ReviewRollupRecord> = {}): ReviewRollupRecord {
  return {
    id: 'review-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    pullRequestNumber: 82,
    headSha: 'abc123',
    status: 'REQUESTED',
    observedAt: now,
    ...overrides
  };
}

function mergeFixture(overrides: Partial<MergeSnapshotRecord> = {}): MergeSnapshotRecord {
  return {
    id: 'merge-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    pullRequestNumber: 82,
    headSha: 'abc123',
    status: 'MERGEABLE',
    observedAt: now,
    ...overrides
  };
}
