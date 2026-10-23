import { useMemo, useState } from 'react';
import type { ArtifactRecord, TaskCommit } from '../../shared/contracts';
import type { DiffFile } from '../model/diffEvidence';
import { ALL_CHANGES, SINCE_REVIEW, sameScope, scopeChoices, steppedCommits, type ReviewScope, type ScopeChoice } from '../model/reviewScope';
import { filesChangedSinceReview, normalizeReviewPath } from '../model/reviewWorkspace';
import { useDiffArtifact, type DiffArtifactView } from './useDiffArtifact';
import { useReviewChanges } from './useReviewChanges';
import { useCommitChange, useTaskCommits } from './useTaskCommits';

/** What the Diff can compare: the capture, the code the review read, and the capture's commits. */
export interface ReviewScopeSources {
  taskId: string;
  /** The review is out of date: what changed since it leads. */
  stale: boolean;
  /** An earlier capture is read as it was taken: no review comparison and no commits. */
  historical: boolean;
  changesSince?: { reviewRunId: string; label: string; refreshKey?: string };
  currentDiffArtifactId?: string;
  reviewedDiffArtifactId?: string;
  artifacts: readonly ArtifactRecord[];
  gitSnapshotId?: string;
}

/** What the Diff compares, and what it can compare instead. */
export interface ReviewScopeView {
  /** The capture the Diff reads, by Git layer. */
  capture: DiffArtifactView;
  /** What the Diff shows. */
  scope: ReviewScope;
  /** What the person chose: the scope shown, or a commit while its change is read. */
  choice: ReviewScope;
  /** The scopes on offer, in the menu's order; never an empty one. */
  choices: readonly ScopeChoice[];
  /** The commits [ and ] step through, oldest first. */
  commits: readonly TaskCommit[];
  /** The commit compared, and its number in the branch's history. */
  commit?: { commit: TaskCommit; number: number; total: number };
  /** The scope's files, before the checkout fills their gaps. */
  files: DiffFile[];
  loading: boolean;
  /** Exactly what changed since the review: its removed lines are the reviewed code's. */
  exactChanges: boolean;
  /** Why the scope holds no file. */
  empty: string;
  choose(scope: ReviewScope): void;
}

/**
 * The Diff's scope: the whole change by default, or what changed since the
 * review while an out-of-date review has changes since it; else what the person
 * chose, while it is still offered. A commit is read when chosen, and shown
 * once its change is there.
 */
export function useReviewScope(sources: ReviewScopeSources): ReviewScopeView {
  const { taskId, stale, historical, changesSince } = sources;
  const capture = useDiffArtifact(sources.currentDiffArtifactId, sources.artifacts);
  const reviewed = useDiffArtifact(sources.reviewedDiffArtifactId, sources.artifacts);
  const canCompareSinceReview = stale && !historical && !reviewed.missing && !reviewed.error;
  // Exactly what changed since the review, from the code it read; without that code, the files whose diff changed.
  const changes = useReviewChanges(taskId, historical ? undefined : changesSince?.reviewRunId, changesSince?.refreshKey);
  const changedSinceReview = useMemo(
    () => (canCompareSinceReview && !reviewed.loading && !capture.loading ? filesChangedSinceReview(reviewed.filesByScope.all, capture.filesByScope.all) : undefined),
    [canCompareSinceReview, capture.filesByScope.all, capture.loading, reviewed.filesByScope.all, reviewed.loading]
  );
  const sinceReviewAvailable = changes.files ? changes.files.length > 0 : Boolean(changedSinceReview?.size);
  const gitSnapshotId = historical ? undefined : sources.gitSnapshotId;
  const { commits, total } = useTaskCommits(taskId, gitSnapshotId);
  const sinceReviewLabel = sinceReviewAvailable ? changesSince?.label ?? 'Since the review' : undefined;
  const committed = capture.filesByScope.committed.length > 0;
  const uncommitted = capture.filesByScope.uncommitted.length > 0;
  const { choices, stepped } = useMemo(() => {
    const sources = { sinceReview: sinceReviewLabel, committed, uncommitted, commits, total };
    return { choices: scopeChoices(sources), stepped: steppedCommits(sources) };
  }, [commits, committed, sinceReviewLabel, total, uncommitted]);

  const [chosen, choose] = useState<ReviewScope>();
  // A choice no longer offered gives way to the default.
  const wanted = chosen && choices.some((choice) => sameScope(choice.scope, chosen)) ? chosen : stale && sinceReviewAvailable ? SINCE_REVIEW : ALL_CHANGES;
  const change = useCommitChange(taskId, gitSnapshotId, wanted.kind === 'commit' ? wanted.sha : undefined);
  // A commit shows once its change is read; until then the Diff keeps what it shows.
  const ready = wanted.kind !== 'commit' || change?.sha === wanted.sha;
  const [shown, setShown] = useState(wanted);
  if (ready && !sameScope(shown, wanted)) setShown(wanted);
  const scope = ready ? wanted : shown;

  const files = useMemo(() => {
    if (scope.kind === 'commit') return change?.sha === scope.sha ? change.files : [];
    if (scope.kind !== 'since-review') return capture.filesByScope[scope.kind];
    return changes.files ?? capture.filesByScope.all.filter((file) => changedSinceReview?.has(normalizeReviewPath(file.path)));
  }, [capture.filesByScope, change, changedSinceReview, changes.files, scope]);
  const at = scope.kind === 'commit' ? commits.findIndex((commit) => commit.sha === scope.sha) : -1;
  const empty = scope.kind === 'since-review' ? 'Nothing changed since the review.'
    : scope.kind !== 'commit' ? 'No changes in this scope.'
      : change?.unavailable === 'TOO_LARGE' ? 'This commit is too large to show.'
        : change?.unavailable ? 'This commit could not be read.' : 'This commit changes no files.';

  return {
    capture,
    scope,
    choice: wanted,
    choices,
    commits: stepped,
    ...(at >= 0 ? { commit: { commit: commits[at]!, number: total - commits.length + at + 1, total } } : {}),
    files,
    // Until the reviewed diff is read, the default scope is unknown, so the tab is loading, not showing one and then the other.
    loading: capture.loading || (canCompareSinceReview && !chosen && (reviewed.loading || changes.loading)),
    exactChanges: scope.kind === 'since-review' && Boolean(changes.files),
    empty,
    choose
  };
}
