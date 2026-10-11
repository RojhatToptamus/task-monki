import { describe, expect, it } from 'vitest';
import type { GitSnapshotRecord } from '../../shared/contracts';
import { reviewedCode, reviewedCodeText } from './reviewedCode';

describe('reviewedCode', () => {
  it('names the commit, and the uncommitted changes when the worktree had any', () => {
    expect(reviewedCode(undefined, gitSnapshot())).toEqual({ head: 'abc1234', uncommitted: false });
    expect(reviewedCode('feedfacecafe', gitSnapshot({ untrackedCount: 2 }))).toEqual({ head: 'feedfac', uncommitted: true });
    expect(reviewedCodeText({ head: 'feedfac', uncommitted: true })).toBe('feedfac and uncommitted changes');
    expect(reviewedCodeText({ head: 'feedfac', uncommitted: false })).toBe('feedfac');
    expect(reviewedCodeText({ uncommitted: true })).toBe('Uncommitted changes');
    expect(reviewedCode(undefined, undefined)).toBeUndefined();
  });
});

function gitSnapshot(overrides: Partial<GitSnapshotRecord> = {}): GitSnapshotRecord {
  return {
    id: 'git-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    worktreePath: '/tmp/task',
    repoRoot: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    headSha: 'abc1234567890',
    branch: 'codex/task',
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
    dirtyFingerprint: 'clean',
    status: 'COMMITTED_UNPUSHED',
    capturedAt: '2026-07-19T10:00:00.000Z',
    ...overrides
  };
}
