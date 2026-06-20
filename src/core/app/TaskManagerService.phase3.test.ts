import { describe, expect, it } from 'vitest';
import type { GitSnapshotRecord } from '../../shared/contracts';
import { assertPublishReady, transitionBlocker } from './TaskManagerService';

describe('Phase 3 delivery guards', () => {
  it('blocks publish when local tests are stale for the current git generation', () => {
    expect(() =>
      assertPublishReady(gitSnapshot('head-2', 'fingerprint-2'), {
        status: 'PASSED',
        testedHeadSha: 'head-1',
        testedDirtyFingerprint: 'fingerprint-1'
      })
    ).toThrow('stale');
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
});

function gitSnapshot(headSha: string, dirtyFingerprint: string): GitSnapshotRecord {
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
    capturedAt: '2026-06-20T10:00:00.000Z'
  };
}
