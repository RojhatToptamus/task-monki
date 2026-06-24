import { describe, expect, it } from 'vitest';
import type { GitSnapshotRecord } from '../../shared/contracts';
import {
  assertPublishReady,
  mergeRunSettings,
  transitionBlocker
} from './TaskManagerService';

describe('Phase 3 delivery guards', () => {
  it('allows draft PR publication readiness without local test evidence', () => {
    expect(() => assertPublishReady(gitSnapshot('head-1', 'fingerprint-1'))).not.toThrow();
  });

  it('blocks draft PR publication readiness when there are no committed task changes', () => {
    expect(() =>
      assertPublishReady(gitSnapshot('head-1', 'fingerprint-1', { commitsAheadOfBase: 0 }))
    ).toThrow('no committed changes');
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
  });

  it('preserves explicit implementation run safety settings', () => {
    expect(
      mergeRunSettings({
        readOnly: false,
        settings: [
          {
            sandbox: 'DANGER_FULL_ACCESS',
            networkAccess: true,
            approvalPolicy: 'never'
          }
        ]
      })
    ).toEqual({
      sandbox: 'DANGER_FULL_ACCESS',
      networkAccess: true,
      approvalPolicy: 'never'
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
            approvalPolicy: 'never'
          }
        ]
      })
    ).toEqual({
      sandbox: 'READ_ONLY',
      networkAccess: true,
      approvalPolicy: 'never'
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
