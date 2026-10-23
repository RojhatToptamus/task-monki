import { describe, expect, it } from 'vitest';
import type { CiRollupRecord, MergeSnapshotRecord, PullRequestSnapshotRecord, ReviewRollupRecord } from '../../shared/contracts';
import { buildPullRequestRecord, rerunnableCheck } from './pullRequestRecord';

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
    artifactId: '00000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64), unresolvedCount: 2, discussionCount: 3,
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

  it('tells running checks from canceled ones, says when a pushed head has none yet, and keeps each gate to its own fact', () => {
    // Checks in flight are running work; a canceled one asks nothing and is never drawn as running.
    expect(buildPullRequestRecord({ pullRequest: pullRequest(), ciRollup: ci({ status: 'PENDING', failingCount: 0, pendingCount: 1, passingCount: 2 }) })!.checks)
      .toMatchObject({ summary: '1 pending, 2 passed', tone: 'working' });
    expect(buildPullRequestRecord({ pullRequest: pullRequest(), ciRollup: ci({ status: 'CANCELED', failingCount: 0, canceledCount: 1, passingCount: 2 }) })!.checks)
      .toMatchObject({ summary: '1 canceled, 2 passed', tone: 'neutral' });
    // A head just pushed has not had its checks register: that is not "None".
    const pushed = ci({ status: 'NO_CHECKS', totalCount: 0, failingCount: 0, passingCount: 0, checkDetails: [] });
    expect(buildPullRequestRecord({ pullRequest: pullRequest(), ciRollup: pushed, checksNotReported: true })!.checks)
      .toEqual({ summary: 'Not reported yet', tone: 'neutral', rows: [] });
    // A request for changes is the person's to take up, in the board's waiting tone; one still asked owes nothing.
    expect(buildPullRequestRecord({ pullRequest: pullRequest(), reviewRollup: review() })!.reviewers.slice(0, 2))
      .toEqual([
        { name: 'alice', word: 'Changes requested', tone: 'action', waiting: false },
        { name: 'carol', word: 'Waiting', tone: 'neutral', waiting: true }
      ]);
    // GitLab's merge gate states only what no other gate does.
    const gitLab = (reason: string) => buildPullRequestRecord({
      pullRequest: pullRequest({ url: 'https://gitlab.com/g/p/-/merge_requests/82' }), provider: 'GITLAB',
      mergeSnapshot: merge({ detailed_merge_status: reason }, { status: 'NOT_MERGED' })
    })!.merge;
    for (const ownedElsewhere of ['draft_status', 'requested_changes', 'ci_must_pass', 'ci_still_running', 'discussions_not_resolved']) {
      expect(gitLab(ownedElsewhere), ownedElsewhere).toBeUndefined();
    }
    expect(gitLab('not_approved')).toEqual({ word: 'Needs approval', tone: 'neutral' });
    // Every other reason a person settles on GitLab is the Merge gate's to state.
    for (const settledOnGitLab of ['status_checks_must_pass', 'security_policy_pipeline_check', 'merge_time', 'jira_association_missing', 'title_regex']) {
      expect(gitLab(settledOnGitLab), settledOnGitLab).toEqual({ word: expect.stringMatching(/\w/u), tone: 'neutral' });
    }
    // A merge request GitLab is merging asks nothing.
    expect(gitLab('not_open')).toBeUndefined();
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

describe('rerunnableCheck', () => {
  it('offers a re-run only for a job of the pull request\'s own repository', () => {
    const pullRequest = 'https://github.com/acme/widgets/pull/9';
    expect(rerunnableCheck('https://github.com/acme/widgets/actions/runs/1/job/2', pullRequest)).toBe(true);
    // A fork's run, or a status from another system, is not this pull request's to start.
    expect(rerunnableCheck('https://github.com/someone/widgets/actions/runs/1/job/2', pullRequest)).toBe(false);
    expect(rerunnableCheck('https://ci.example.com/build/7', pullRequest)).toBe(false);
    expect(rerunnableCheck('https://gitlab.com/group/sub/app/-/jobs/5', 'https://gitlab.com/group/sub/app/-/merge_requests/3')).toBe(true);
    expect(rerunnableCheck('https://gitlab.com/group/other/-/jobs/5', 'https://gitlab.com/group/sub/app/-/merge_requests/3')).toBe(false);
  });
});
