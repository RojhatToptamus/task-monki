import type { GitSnapshotRecord, RunRecord } from '../../shared/contracts';
import type { DiffFile } from './diffEvidence';
import { pluralize } from './formatting';

export interface CompletedChangeFile {
  path: string;
  additions: number;
  deletions: number;
  status: DiffFile['status'];
}

export interface CompletedChangeSummary {
  fileCount: number;
  title: string;
  additions: number;
  deletions: number;
  previewFiles: CompletedChangeFile[];
  hiddenFiles: CompletedChangeFile[];
  hiddenFileCount: number;
}

const DEFAULT_PREVIEW_LIMIT = 3;

export function buildCompletedChangeSummary(
  files: DiffFile[],
  previewLimit = DEFAULT_PREVIEW_LIMIT
): CompletedChangeSummary | undefined {
  if (files.length === 0) {
    return undefined;
  }

  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const safePreviewLimit = Math.max(0, previewLimit);
  const mappedFiles = files.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    status: file.status
  }));
  const previewFiles = mappedFiles.slice(0, safePreviewLimit);
  const hiddenFiles = mappedFiles.slice(safePreviewLimit);

  return {
    fileCount: files.length,
    title: `Captured Git changes in ${pluralize(files.length, 'file')}`,
    additions,
    deletions,
    previewFiles,
    hiddenFiles,
    hiddenFileCount: hiddenFiles.length
  };
}

export function hasNewerGitEvidence(
  captured: GitSnapshotRecord,
  gitSnapshots: GitSnapshotRecord[]
): boolean {
  return gitSnapshots.some(
    (snapshot) =>
      snapshot.id !== captured.id &&
      snapshot.taskId === captured.taskId &&
      snapshot.iterationId === captured.iterationId &&
      snapshot.worktreeId === captured.worktreeId &&
      snapshot.capturedAt > captured.capturedAt &&
      (snapshot.headSha !== captured.headSha ||
        snapshot.dirtyFingerprint !== captured.dirtyFingerprint)
  );
}

export function selectCompletedRunChangeSnapshot(
  run: RunRecord | undefined,
  gitSnapshots: GitSnapshotRecord[]
): GitSnapshotRecord | undefined {
  if (!run || run.status !== 'COMPLETED' || !run.afterGitSnapshotId) {
    return undefined;
  }
  return gitSnapshots.find(
    (snapshot) =>
      snapshot.id === run.afterGitSnapshotId &&
      snapshot.taskId === run.taskId &&
      snapshot.iterationId === run.iterationId &&
      snapshot.worktreeId === run.worktreeId
  );
}

/**
 * A run that left the worktree as it found it: the same head and the same
 * uncommitted changes. What its captured diff lists against the base was there
 * before it, such as an opened pull request's own changes.
 */
export function runChangedNothing(run: RunRecord | undefined, gitSnapshots: readonly GitSnapshotRecord[]): boolean {
  if (!run?.beforeGitSnapshotId || !run.afterGitSnapshotId) return false;
  const before = gitSnapshots.find((snapshot) => snapshot.id === run.beforeGitSnapshotId);
  const after = gitSnapshots.find((snapshot) => snapshot.id === run.afterGitSnapshotId);
  return Boolean(before && after && before.headSha === after.headSha && before.dirtyFingerprint === after.dirtyFingerprint);
}

/** Read-only follow-ups must not appear to have produced the same files again. */
export function conversationCaptureRunIds(
  runs: RunRecord[],
  snapshots: GitSnapshotRecord[]
): Set<string> {
  const visible = new Set<string>();
  let previous: GitSnapshotRecord | undefined;
  for (const run of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const capture = selectCompletedRunChangeSnapshot(run, snapshots);
    if (!capture) {
      visible.add(run.id);
      continue;
    }
    const unchanged = previous && capture.headSha && capture.dirtyFingerprint &&
      capture.worktreeId === previous.worktreeId &&
      capture.iterationId === previous.iterationId &&
      capture.headSha === previous.headSha &&
      capture.dirtyFingerprint === previous.dirtyFingerprint;
    if (!unchanged) visible.add(run.id);
    previous = capture;
  }
  return visible;
}
