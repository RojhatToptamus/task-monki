import { describe, expect, it } from 'vitest';
import type { GitSnapshotRecord } from '../../shared/contracts';
import {
  assertPublishReady,
  mergeRunSettings,
  transitionBlocker
} from './TaskManagerService';

describe('Phase 3 delivery guards', () => {
  it('allows draft PR publication readiness from committed Git evidence', () => {
    expect(() => assertPublishReady(gitSnapshot('head-1', 'fingerprint-1'))).not.toThrow();
  });

  it('blocks draft PR publication readiness when there are no committed task changes', () => {
    expect(() =>
      assertPublishReady(gitSnapshot('head-1', 'fingerprint-1', { commitsAheadOfBase: 0 }))
    ).toThrow('no committed changes');
  });

  it('blocks draft PR publication readiness when the branch has diverged', () => {
    expect(() =>
      assertPublishReady(gitSnapshot('head-1', 'fingerprint-1', { status: 'DIVERGED' }))
    ).toThrow('Sync the branch');
  });

  it('allows IN_REVIEW only for a matching open pull request', () => {
    expect(
      transitionBlocker(
        {
          completionPolicy: 'MERGED',
          projection: {}
        } as never,
        'IN_REVIEW',
        {
          hasWorktree: true,
          gitHeadSha: 'abc',
          pullRequestStatus: 'OPEN_DRAFT',
          pullRequestHeadSha: 'abc'
        }
      )
    ).toBeUndefined();

    expect(
      transitionBlocker({ completionPolicy: 'MERGED', projection: {} } as never, 'DONE', {
        hasWorktree: true,
        mergeStatus: 'NOT_MERGED'
      })
    ).toContain('merged');
    expect(
      transitionBlocker(
        { completionPolicy: 'MERGED_AND_VERIFIED', projection: {} } as never,
        'DONE',
        {
          hasWorktree: true,
          mergeStatus: 'NOT_MERGED'
        }
      )
    ).toContain('merged');
    expect(
      transitionBlocker(
        { completionPolicy: 'MERGED_AND_VERIFIED', projection: {} } as never,
        'DONE',
        {
          hasWorktree: true,
          mergeStatus: 'MERGED',
          ciStatus: 'FAILING'
        }
      )
    ).toContain('checks');
    expect(
      transitionBlocker(
        { completionPolicy: 'MERGED_AND_VERIFIED', projection: {} } as never,
        'DONE',
        {
          hasWorktree: true,
          mergeStatus: 'MERGED',
          ciStatus: 'PASSING'
        }
      )
    ).toContain('merged PR head');
    expect(
      transitionBlocker(
        { completionPolicy: 'MERGED_AND_VERIFIED', projection: {} } as never,
        'DONE',
        {
          hasWorktree: true,
          mergeStatus: 'MERGED',
          mergeHeadSha: 'merged-head',
          mergePullRequestNumber: 82,
          ciStatus: 'PASSING',
          ciHeadSha: 'old-head',
          ciPullRequestNumber: 82
        }
      )
    ).toContain('merged PR head');
    expect(
      transitionBlocker(
        { completionPolicy: 'MERGED_AND_VERIFIED', projection: {} } as never,
        'DONE',
        {
          hasWorktree: true,
          mergeStatus: 'MERGED',
          mergeHeadSha: 'merged-head',
          mergePullRequestNumber: 82,
          ciStatus: 'PASSING',
          ciHeadSha: 'merged-head',
          ciPullRequestNumber: 82
        }
      )
    ).toBeUndefined();
    expect(
      transitionBlocker({ completionPolicy: 'MERGED', projection: {} } as never, 'DONE', {
        hasWorktree: true,
        mergeStatus: 'MERGED',
        ciStatus: 'FAILING'
      })
    ).toBeUndefined();
  });

  it.each(['ANALYSIS', 'COMPACTION'] as const)(
    'blocks REVIEW after a completed %s run',
    (mode) => {
      expect(
        transitionBlocker(
          {
            currentRunId: 'current-run',
            projection: { agentRun: 'COMPLETED' }
          } as never,
          'REVIEW',
          {
            hasWorktree: true,
            currentRun: { id: 'current-run', mode, status: 'COMPLETED' }
          }
        )
      ).toContain('implementation run');
    }
  );

  it('allows REVIEW after the current implementation run completes', () => {
    expect(
      transitionBlocker(
        {
          currentRunId: 'current-run',
          projection: { agentRun: 'COMPLETED' }
        } as never,
        'REVIEW',
        {
          hasWorktree: true,
          currentRun: {
            id: 'current-run',
            mode: 'IMPLEMENTATION',
            status: 'COMPLETED'
          }
        }
      )
    ).toBeUndefined();
  });

  it.each(['REVIEW', 'IN_REVIEW', 'DONE'] as const)(
    'blocks %s while replacement implementation is required',
    (phase) => {
      const reason = 'Retry or continue this implementation before review.';
      expect(
        transitionBlocker(
          {
            currentRunId: 'current-run',
            completionPolicy: 'LOCAL_ACCEPTANCE',
            projection: {
              implementationRetry: { runId: 'current-run', reason }
            }
          } as never,
          phase,
          {
            hasWorktree: true,
            currentRun: {
              id: 'current-run',
              mode: 'IMPLEMENTATION',
              status: 'COMPLETED'
            },
            pullRequestStatus: 'OPEN_DRAFT',
            mergeStatus: 'MERGED'
          }
        )
      ).toBe(reason);
    }
  );

  it('preserves explicit implementation run safety settings', () => {
    expect(
      mergeRunSettings({
        readOnly: false,
        settings: [
          {
            sandbox: 'DANGER_FULL_ACCESS',
            networkAccess: true,
            approvalPolicy: 'never',
            approvalsReviewer: 'auto_review'
          }
        ]
      })
    ).toEqual({
      sandbox: 'DANGER_FULL_ACCESS',
      networkAccess: true,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    });
  });

  it('enforces read-only sandbox for analysis and review runs', () => {
    expect(
      mergeRunSettings({
        readOnly: true,
        settings: [
          {
            sandbox: 'DANGER_FULL_ACCESS',
            networkAccess: true,
            approvalPolicy: 'on-request',
            approvalsReviewer: 'auto_review'
          }
        ]
      })
    ).toEqual({
      sandbox: 'READ_ONLY',
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    });
  });

  it('preserves auto-review for implementation approval prompts', () => {
    expect(
      mergeRunSettings({
        readOnly: false,
        settings: [
          {
            sandbox: 'WORKSPACE_WRITE',
            networkAccess: true,
            approvalPolicy: 'on-request',
            approvalsReviewer: 'auto_review'
          }
        ]
      })
    ).toEqual({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    });
  });
});

function gitSnapshot(
  headSha: string,
  dirtyFingerprint: string,
  overrides: Partial<GitSnapshotRecord> = {}
): GitSnapshotRecord {
  return {
    id: 'git-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    worktreePath: '/tmp/repo',
    repoRoot: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    headSha,
    baseSha: 'base',
    aheadCount: 1,
    behindCount: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    commitsAheadOfBase: 1,
    committedDiffFileCount: 1,
    workingDiffFileCount: 0,
    diffStat: '1 file changed',
    dirtyFingerprint,
    status: 'COMMITTED_UNPUSHED',
    capturedAt: '2026-06-20T10:00:00.000Z',
    ...overrides
  };
}
