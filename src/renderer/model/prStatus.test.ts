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
  buildBoardDeliveryLine,
  buildFailingChecksInvestigationPrompt,
  buildPrStatusActionState,
  buildPrStatusCreateOrPushTitle,
  buildPrStatusViewModel
} from './prStatus';

const now = '2026-07-01T10:00:00.000Z';

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

  it('prioritizes failing checks over GitHub review waiting', () => {
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
    expect(view.checkSummaryLine).toBe('2 failed · 1 skipped · 3 passed');
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
    expect(view.checkSummaryLine).toBe('2 pending · 1 passed');
    expect(view.evidenceLine).toBe('2 pending · 1 passed');
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
    expect(view.evidenceLine).toBe('Approved · Mergeable');
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

    expect(waiting.headline).toBe('GitHub review waiting');
    expect(waiting.reviewLine).toBeUndefined();
    expect(changesRequested.headline).toBe('GitHub changes requested');
    expect(changesRequested.reviewLine).toBeUndefined();
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
    expect(stale.headline).toBe('Stale');
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
        expected: { kind: 'NO_REQUIRED_CHECKS', headline: 'No required checks ran', tone: 'action' }
      },
      {
        name: 'review waiting',
        input: {
          task: taskFixture(),
          pullRequest: prFixture(),
          reviewRollup: reviewFixture({ status: 'REQUESTED' })
        },
        expected: { kind: 'GITHUB_REVIEW_WAITING', headline: 'GitHub review waiting', tone: 'action' }
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
          headline: 'GitHub changes requested',
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
          headline: 'Stale',
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
          headline: 'Local changes not pushed',
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

    expect(view.headline).toBe('Stale');
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

    expect(view.headline).toBe('Local changes not pushed');
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

    expect(view.headline).toBe('Local changes not pushed');
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
      'Investigate the failing GitHub checks for PR #82 at head abc123.'
    );
    expect(buildFailingChecksInvestigationPrompt(view)).toContain(
      '- build (CI): status failed | https://github.com/example/repo/actions/runs/2'
    );
    expect(buildFailingChecksInvestigationPrompt(view)).toContain('Do not push unless the user approves.');
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

describe('buildBoardDeliveryLine', () => {
  it('shows one compact PR delivery line', () => {
    expect(
      buildBoardDeliveryLine(
        taskFixture({
          projection: {
            ...createInitialProjection(now),
            githubPullRequest: 'OPEN_READY',
            githubPullRequestNumber: 82,
            ciChecks: 'FAILING'
          }
        })
      )
    ).toBe('PR #82 | checks failing');
  });
});

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
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
