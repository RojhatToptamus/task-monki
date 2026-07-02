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
  buildPrStatusViewModel
} from './prStatus';

const now = '2026-07-01T10:00:00.000Z';

describe('buildPrStatusViewModel', () => {
  it('shows no PR before delivery exists', () => {
    const view = buildPrStatusViewModel({ task: taskFixture() });

    expect(view.headline).toBe('No PR');
    expect(view.canCreateDraftPr).toBe(true);
    expect(view.canRefresh).toBe(false);
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
    expect(view.checkSummaryLine).toBe('2 failed · 1 skipped · 3 passed');
    expect(view.canInvestigateFailure).toBe(true);
    expect(view.checkGroups[0]).toMatchObject({ status: 'failed', defaultOpen: true });
  });

  it('orders check rows by severity like the PR status card spec', () => {
    const view = buildPrStatusViewModel({
      task: taskFixture(),
      pullRequest: prFixture(),
      ciRollup: ciFixture({
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
          pullRequest: prFixture({ status: 'CLOSED_UNMERGED', state: 'CLOSED' })
        },
        expected: { kind: 'CLOSED_UNMERGED', headline: 'Closed without merge', tone: 'error' }
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
        expected: { kind: 'STALE', headline: 'Stale', tone: 'action' }
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
    repositoryPath: '/tmp/repo',
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
