import { describe, expect, it } from 'vitest';
import type { GitSnapshotRecord } from '../../shared/contracts';
import { describeGitSnapshot } from './gitSnapshotCopy';

describe('describeGitSnapshot', () => {
  it('renders Git status as human copy while preserving exact values', () => {
    const description = describeGitSnapshot(gitSnapshot({ status: 'COMMITTED_UNPUSHED' }));

    expect(description).toBe('abc12345 · 1 file · committed, not pushed');
    expect(description).not.toContain('COMMITTED_UNPUSHED');
    expect(description).not.toContain('committed_unpushed');
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
