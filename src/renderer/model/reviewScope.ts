import type { TaskCommit } from '../../shared/contracts';
import { formatShortAge } from './timeAgo';

/**
 * What the Diff compares: the whole change, its Git layers (what is committed,
 * what is not), what changed since the review, or one commit of the branch.
 */
export type ReviewScope =
  | { kind: 'all' | 'committed' | 'uncommitted' | 'since-review' }
  | { kind: 'commit'; sha: string };

export const ALL_CHANGES: ReviewScope = { kind: 'all' };
export const SINCE_REVIEW: ReviewScope = { kind: 'since-review' };
const COMMITTED: ReviewScope = { kind: 'committed' };
const UNCOMMITTED: ReviewScope = { kind: 'uncommitted' };

export function sameScope(left: ReviewScope, right: ReviewScope): boolean {
  return left.kind === 'commit' || right.kind === 'commit'
    ? left.kind === 'commit' && right.kind === 'commit' && left.sha === right.sha
    : left.kind === right.kind;
}

/** A scope as the Diff's menu offers it. */
export interface ScopeChoice {
  scope: ReviewScope;
  label: string;
  /** A commit's place in the branch's history, from 1. */
  lead?: string;
  /** A commit's age. */
  meta?: string;
  /** Starts the branch's history. */
  separated?: boolean;
}

export interface ScopeSources {
  /** The label of what changed since the review, while anything did. */
  sinceReview?: string;
  /** The capture holds committed changes, and uncommitted ones. */
  committed: boolean;
  uncommitted: boolean;
  /** The branch's latest commits, oldest first, and how many it has. */
  commits: readonly TaskCommit[];
  total: number;
}

/**
 * The commits the Diff steps through: the branch's, unless its one commit is
 * the whole change.
 */
export function steppedCommits({ commits, committed, uncommitted }: ScopeSources): readonly TaskCommit[] {
  return commits.length > 1 || (commits.length === 1 && committed && uncommitted) ? commits : [];
}

/**
 * The scopes the Diff offers, none empty and none showing what another does:
 * the whole change, what changed since the review when anything did, then the
 * branch's history in order: all its commits while work beside them is
 * uncommitted, each commit, and the uncommitted work.
 */
export function scopeChoices(sources: ScopeSources, now: number = Date.now()): ScopeChoice[] {
  const commits = steppedCommits(sources);
  const layered = sources.committed && sources.uncommitted;
  const history: ScopeChoice[] = [
    ...(layered && commits.length !== 1 ? [{ scope: COMMITTED, label: 'All commits' }] : []),
    ...commits.map((commit, index): ScopeChoice => {
      const age = formatShortAge(commit.authoredAt, now);
      return {
        scope: { kind: 'commit', sha: commit.sha },
        label: commit.subject || commit.sha.slice(0, 7),
        lead: String(sources.total - commits.length + index + 1),
        ...(age ? { meta: age } : {})
      };
    }),
    ...(layered ? [{ scope: UNCOMMITTED, label: 'Uncommitted' }] : [])
  ];
  return [
    { scope: ALL_CHANGES, label: 'All changes' },
    ...(sources.sinceReview ? [{ scope: SINCE_REVIEW, label: sources.sinceReview }] : []),
    ...history.map((choice, index) => (index === 0 ? { ...choice, separated: true } : choice))
  ];
}

/**
 * The commit before or after the one compared; from any other scope, the first
 * going forward and the last going back. None past either end.
 */
export function stepCommit(commits: readonly TaskCommit[], scope: ReviewScope, direction: 1 | -1): ReviewScope | undefined {
  const at = scope.kind === 'commit' ? commits.findIndex((commit) => commit.sha === scope.sha) : -1;
  const commit = commits[at < 0 ? (direction > 0 ? 0 : commits.length - 1) : at + direction];
  return commit ? { kind: 'commit', sha: commit.sha } : undefined;
}
