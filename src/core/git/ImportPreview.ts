import type { ImportPreview } from '../../shared/contracts';
import { git, gitSucceeds } from './gitCli';
import { inspectExistingWorkSnapshot } from './GitSnapshotService';

/** Expected comparison validation, safe to show across the HTTP boundary. */
export class ImportPreviewError extends Error {}

export async function inspectImportPreview(input: {
  worktreePath: string;
  branchName: string;
  baseRef?: string;
  repositoryBranch?: string;
}): Promise<ImportPreview> {
  let baseRef = input.baseRef?.trim();
  if (!baseRef) {
    const remoteDefault = await git(input.worktreePath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
      .then((ref) => ref.trim().replace(/^refs\/remotes\/origin\//, '')).catch(() => undefined);
    for (const branch of [remoteDefault, 'main', 'master', input.repositoryBranch]) {
      if (branch && await gitSucceeds(input.worktreePath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
        baseRef = `refs/heads/${branch}`;
        break;
      }
    }
  }
  if (!baseRef) throw new ImportPreviewError('No local comparison branch is available. Choose HEAD or a commit.');
  const baseSha = await git(input.worktreePath, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])
    .then((sha) => sha.trim()).catch(() => { throw new ImportPreviewError('Enter a valid local branch or commit.'); });
  const snapshot = await inspectExistingWorkSnapshot({ ...input, baseRef, baseSha });
  const [log, status, numstat] = await Promise.all([
    git(input.worktreePath, ['log', '-50', '--format=%H%x00%s', `${baseSha}..${snapshot.headSha}`, '--']),
    git(input.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all', '-z']),
    git(input.worktreePath, ['diff', '--numstat', '-z', snapshot.headSha!, '--'])
  ]);
  const lineCounts = new Map<string, { additions: number; deletions: number }>();
  const stats = numstat.split('\0');
  for (let index = 0; index < stats.length; index += 1) {
    const stat = stats[index]!;
    if (!stat) continue;
    const firstTab = stat.indexOf('\t');
    const secondTab = stat.indexOf('\t', firstTab + 1);
    const additions = Number(stat.slice(0, firstTab));
    const deletions = Number(stat.slice(firstTab + 1, secondTab));
    let filePath = stat.slice(secondTab + 1);
    if (!filePath) { // Rename records contain original and current paths after the counts.
      filePath = stats[index + 2]!;
      index += 2;
    }
    if (Number.isFinite(additions) && Number.isFinite(deletions)) lineCounts.set(filePath, { additions, deletions });
  }
  const files: ImportPreview['files'] = [];
  const entries = status.split('\0');
  let fileCount = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const statusCode = entry.slice(0, 2);
    fileCount += 1;
    if (files.length < 100) files.push({ path: entry.slice(3), status: statusCode.trim(), ...lineCounts.get(entry.slice(3)) });
    if (/[RC]/.test(statusCode)) index += 1; // -z emits the original rename/copy path next.
  }
  return {
    baseRef, baseSha, headSha: snapshot.headSha!,
    commitCount: snapshot.commitsAheadOfBase,
    commits: log.trim().split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf('\0');
      return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
    }),
    fileCount, files,
    unavailableReason: snapshot.conflictedCount || snapshot.operationInProgress
      ? 'Finish the current Git operation and resolve conflicts before importing.' : undefined
  };
}
