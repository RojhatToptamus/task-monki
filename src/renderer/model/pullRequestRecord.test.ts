import { describe, expect, it } from 'vitest';
import type { CiRollupRecord, MergeSnapshotRecord, PullRequestSnapshotRecord, ReviewRollupRecord } from '../../shared/contracts';
import { buildPullRequestRecord } from './pullRequestRecord';

const owner = { taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1', observedAt: '2026-10-17T10:00:00.000Z' };
const pullRequest = (overrides: Partial<PullRequestSnapshotRecord> = {}): PullRequestSnapshotRecord => ({
  ...owner, id: 'pr', number: 82, url: 'https://github.com/acme/widgets/pull/82', status: 'OPEN_READY', state: 'OPEN', isDraft: false,
  headRefName: 'task/save', headRefOid: 'head-2', baseRefName: 'main', title: 'Save layouts', ...overrides
});
const ci = (overrides: Partial<CiRollupRecord> = {}): CiRollupRecord => ({
  ...owner, id: 'ci', pullRequestNumber: 82, headSha: 'head-2', status: 'FAILING', requiredStatus: 'UNKNOWN', totalCount: 3,
  pendingCount: 0, passingCount: 2, failingCount: 1, skippedCount: 0, canceledCount: 0,
  checkDetails: [
    { name: 'lint', status: 'passed' },
    { name: 'unit', status: 'failed', startedAt: '2026-10-17T10:00:00Z', completedAt: '2026-10-17T10:03:12Z' },
    { name: 'build', status: 'passed' }
  ],
  ...overrides
});
const review = (overrides: Partial<ReviewRollupRecord> = {}): ReviewRollupRecord => ({
  ...owner, id: 'review', pullRequestNumber: 82, headSha: 'head-2', status: 'CHANGES_REQUESTED',
  feedback: {
    artifactId: '00000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64), capturedAt: owner.observedAt, unresolvedCount: 2, discussionCount: 3,
    reviewers: [{ name: 'bob', state: 'APPROVED' }, { name: 'carol', state: 'REQUESTED' }, { name: 'alice', state: 'CHANGES_REQUESTED' }]
  },
  ...overrides
});
const merge = (raw: Record<string, unknown>, overrides: Partial<MergeSnapshotRecord> = {}): MergeSnapshotRecord => ({
  ...owner, id: 'merge', pullRequestNumber: 82, headSha: 'head-2', status: 'BLOCKED', mergedAt: null, raw, ...overrides
});

describe('buildPullRequestRecord', () => {
  it('states each gate for the current head: failures first, who asked what, and why it cannot merge', () => {
    const record = buildPullRequestRecord({
      pullRequest: pullRequest(), ciRollup: ci(), reviewRollup: review(), mergeSnapshot: merge({ mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE' })
    })!;
    expect(record).toMatchObject({ label: '#82', title: 'Save layouts', state: 'open', head: 'task/save', base: 'main' });
    expect(record.checks).toMatchObject({ summary: '1 failed, 2 passed', tone: 'error' });
    expect(record.checks!.rows.map((row) => [row.name, row.duration])).toEqual([['unit', '3m 12s'], ['lint', undefined], ['build', undefined]]);
    // Who asked for changes leads; then who it waits on; approvals last.
    expect(record.reviewers.map((reviewer) => `${reviewer.name} ${reviewer.word}`)).toEqual(['alice Changes requested', 'carol Waiting', 'bob Approved']);
    expect(record.threads).toEqual({ unresolved: 2, word: '2 unresolved' });
    expect(record.merge).toEqual({ word: 'Behind main', tone: 'error' });
    expect(buildPullRequestRecord({ pullRequest: pullRequest(), mergeSnapshot: merge({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }) })!.merge)
      .toEqual({ word: 'Conflicts with main', tone: 'error' });
    // GitLab's reasons read as the Now panel and the Inbox say them.
    const gitLab = (reason: string) => buildPullRequestRecord({
      pullRequest: pullRequest({ url: 'https://gitlab.com/g/p/-/merge_requests/82' }), provider: 'GITLAB', mergeSnapshot: merge({ detailed_merge_status: reason })
    })!.merge;
    expect(gitLab('need_rebase')).toEqual({ word: 'Behind main', tone: 'error' });
    expect(gitLab('conflict')).toEqual({ word: 'Conflicts with main', tone: 'error' });
  });

  it("never presents an earlier head's checks as current, and a merged pull request asks nothing", () => {
    const moved = buildPullRequestRecord({ pullRequest: pullRequest({ headRefOid: 'head-3' }), ciRollup: ci(), mergeSnapshot: merge({}) })!;
    expect(moved.checks).toEqual({ summary: 'From an earlier head', tone: 'neutral', rows: [] });
    // Merge evidence for an earlier head says nothing about this one.
    expect(moved.merge).toBeUndefined();

    const merged = buildPullRequestRecord({
      pullRequest: pullRequest({ status: 'MERGED', state: 'MERGED', mergedAt: '2026-10-16T09:00:00.000Z' }),
      ciRollup: ci(), reviewRollup: review()
    })!;
    expect(merged).toMatchObject({ state: 'merged', reviewers: [] });
    expect(merged.checks).toBeUndefined();
    expect(merged.threads).toBeUndefined();
    expect(merged.merge?.word).toMatch(/^Merged /u);
    expect(buildPullRequestRecord({ pullRequest: pullRequest({ number: 7, url: 'https://gitlab.com/g/p/-/merge_requests/7' }), provider: 'GITLAB' })!.label).toBe('!7');
  });
});
