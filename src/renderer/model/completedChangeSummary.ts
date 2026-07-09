import type { GitSnapshotRecord, RunRecord } from '../../shared/contracts';
import type { DiffFile } from './diffEvidence';

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
    title: `Edited ${files.length} ${plural(files.length, 'file')}`,
    additions,
    deletions,
    previewFiles,
    hiddenFiles,
    hiddenFileCount: hiddenFiles.length
  };
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

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
