import { describe, expect, it } from 'vitest';
import type { TaskCommit } from '../../shared/contracts';
import { ALL_CHANGES, scopeChoices, stepCommit, steppedCommits, type ScopeSources } from './reviewScope';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const commit = (sha: string, subject: string, hoursAgo: number): TaskCommit =>
  ({ sha: sha.repeat(40).slice(0, 40), subject, author: 'Ana', authoredAt: new Date(NOW - hoursAgo * 3_600_000).toISOString() });
const RAISE = commit('a', 'Raise the limit', 5);
const RETRY = commit('b', 'Retry uploads', 2);
const sources = (overrides: Partial<ScopeSources>): ScopeSources => ({ committed: true, uncommitted: false, commits: [RAISE, RETRY], total: 2, ...overrides });
const labels = (choices: ReturnType<typeof scopeChoices>) => choices.map((choice) => [choice.lead ?? '', choice.label, choice.meta ?? '', choice.separated ? '|' : '']);

describe('the scopes the Diff offers', () => {
  it('reads the branch in order under the whole change, all its commits and the uncommitted work only beside each other', () => {
    expect(labels(scopeChoices(sources({ sinceReview: 'Since the review', uncommitted: true }), NOW))).toEqual([
      ['', 'All changes', '', ''],
      ['', 'Since the review', '', ''],
      ['', 'All commits', '', '|'],
      ['1', 'Raise the limit', '5h', ''],
      ['2', 'Retry uploads', '2h', ''],
      ['', 'Uncommitted', '', '']
    ]);
    // With nothing uncommitted, all the commits are the whole change.
    expect(labels(scopeChoices(sources({}), NOW)).map(([, label]) => label)).toEqual(['All changes', 'Raise the limit', 'Retry uploads']);
  });

  it('never offers what shows the same as another: one commit alone is the whole change', () => {
    expect(scopeChoices(sources({ commits: [RAISE], total: 1 }), NOW).map((choice) => choice.label)).toEqual(['All changes']);
    expect(steppedCommits(sources({ commits: [RAISE], total: 1 }))).toEqual([]);
    // Beside uncommitted work it is not, and stands for all the commits.
    expect(scopeChoices(sources({ commits: [RAISE], total: 1, uncommitted: true }), NOW).map((choice) => choice.label))
      .toEqual(['All changes', 'Raise the limit', 'Uncommitted']);
    // Without the commits, the capture's layers still split.
    expect(scopeChoices(sources({ commits: [], total: 0, uncommitted: true }), NOW).map((choice) => choice.label))
      .toEqual(['All changes', 'All commits', 'Uncommitted']);
  });

  it('numbers the latest commits in the branch\'s whole history when the older ones are left out', () => {
    expect(scopeChoices(sources({ total: 40 }), NOW).flatMap((choice) => (choice.lead ? [choice.lead] : []))).toEqual(['39', '40']);
  });
});

describe('stepping through commits', () => {
  const commits = [RAISE, RETRY];
  it('moves to the next or previous commit and stops at either end', () => {
    expect(stepCommit(commits, { kind: 'commit', sha: RAISE.sha }, 1)).toEqual({ kind: 'commit', sha: RETRY.sha });
    expect(stepCommit(commits, { kind: 'commit', sha: RETRY.sha }, -1)).toEqual({ kind: 'commit', sha: RAISE.sha });
    expect(stepCommit(commits, { kind: 'commit', sha: RETRY.sha }, 1)).toBeUndefined();
    expect(stepCommit(commits, { kind: 'commit', sha: RAISE.sha }, -1)).toBeUndefined();
  });

  it('enters the history from any other scope at its first commit going forward and its last going back', () => {
    expect(stepCommit(commits, ALL_CHANGES, 1)).toEqual({ kind: 'commit', sha: RAISE.sha });
    expect(stepCommit(commits, ALL_CHANGES, -1)).toEqual({ kind: 'commit', sha: RETRY.sha });
    expect(stepCommit([], ALL_CHANGES, 1)).toBeUndefined();
  });
});
