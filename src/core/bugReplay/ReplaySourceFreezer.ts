import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../git/gitCli';
import { inspectGitWorkingTreeFingerprint } from '../git/GitSnapshotService';
import type { ReadOnlySnapshotOmission } from '../git/ReadOnlySnapshotService';
import { bugReplayRef, type ReviewSnapshotStore } from '../git/ReviewSnapshotStore';
import { PreviewSourcePreparer } from '../preview/PreviewSourcePreparer';
import { assertPathWithin } from '../preview/PreviewPaths';

/**
 * Freezes a task's code for Bug Replay: the worktree's exact content (committed, staged,
 * unstaged and untracked files Git does not ignore) becomes a pinned tree in the private
 * snapshot store, and each run gets a single-use, writable export of that tree. The verdict is
 * bound to the tree id, never to the live worktree.
 */
export class ReplaySourceFreezer {
  private readonly preparer: PreviewSourcePreparer;

  constructor(
    private readonly snapshots: ReviewSnapshotStore,
    /** `<previewhost root>/sources/bug-replay`: inside Previewhost's allowed root, apart from Design's captures. */
    readonly exportRoot: string,
    storeId: string
  ) {
    this.preparer = new PreviewSourcePreparer(exportRoot, storeId);
  }

  /** Captures and pins the worktree. Files changing while it is read are retried once, then refused. */
  async capture(worktreePath: string, taskId: string, refName: string): Promise<{ treeId: string }> {
    const ref = bugReplayRef(taskId, refName);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await inspectGitWorkingTreeFingerprint(worktreePath);
      const { treeId, omitted } = await this.snapshots.captureTree(worktreePath, ref);
      if (omitted.length > 0) {
        await this.snapshots.releaseRef(worktreePath, ref);
        throw new ReplaySourceError('OMITTED_FILES', cannotCopy(omitted));
      }
      const after = await inspectGitWorkingTreeFingerprint(worktreePath);
      if (before === after) return { treeId };
      await this.snapshots.releaseRef(worktreePath, ref);
    }
    throw new ReplaySourceError('CHANGING', 'Files changed while copying');
  }

  async pin(worktreePath: string, taskId: string, refName: string, treeId: string): Promise<void> {
    await this.snapshots.pinTree(worktreePath, bugReplayRef(taskId, refName), treeId);
  }

  async release(worktreePath: string, taskId: string, refName: string): Promise<void> {
    await this.snapshots.releaseRef(worktreePath, bugReplayRef(taskId, refName));
  }

  async available(worktreePath: string, treeId: string): Promise<boolean> {
    return this.snapshots.hasTree(worktreePath, treeId);
  }

  /** Writes a fresh export of the tree for one run, then copies the chosen ignored env files into it. */
  async export(input: {
    worktreePath: string;
    taskId: string;
    runId: string;
    treeId: string;
    envFiles: Array<{ relativePath: string; bytes: Buffer }>;
    signal?: AbortSignal;
  }): Promise<{ generationRoot: string; sourcePath: string; tracked: Map<string, string> }> {
    const prepared = await this.preparer.prepareExactTree({
      repositoryPath: input.worktreePath,
      gitEnvironment: await this.snapshots.gitEnvironment(input.worktreePath),
      taskId: input.taskId,
      generationId: input.runId,
      treeId: input.treeId,
      signal: input.signal
    });
    try {
      for (const file of input.envFiles) {
        const destination = path.join(prepared.sourcePath, file.relativePath);
        assertPathWithin(prepared.sourcePath, destination, 'Env file copy');
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.writeFile(destination, file.bytes, { mode: 0o600, flag: 'wx' });
      }
      const tracked = await this.trackedBlobs(input.worktreePath, input.treeId);
      return { generationRoot: prepared.generationRoot, sourcePath: prepared.sourcePath, tracked };
    } catch (error) {
      await this.cleanup(input.taskId, input.runId).catch(() => undefined);
      throw error;
    }
  }

  /** Tracked files of the export whose content no longer matches `expected`. */
  async changedFiles(sourcePath: string, expected: Map<string, string>): Promise<string[]> {
    const paths = [...expected.keys()];
    const changed: string[] = [];
    for (let offset = 0; offset < paths.length; offset += 2_000) {
      const batch = paths.slice(offset, offset + 2_000);
      const present: string[] = [];
      for (const relative of batch) {
        const stat = await fs.lstat(path.join(sourcePath, relative)).catch(() => undefined);
        if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) changed.push(relative);
        else if (stat.isFile()) present.push(relative);
      }
      if (present.length === 0) continue;
      const output = await git(sourcePath, ['hash-object', '--no-filters', '--stdin-paths'], {
        timeout: 120_000,
        stdin: `${present.join('\n')}\n`
      });
      const hashes = output.split('\n').filter(Boolean);
      present.forEach((relative, index) => {
        if (hashes[index] !== expected.get(relative)) changed.push(relative);
      });
      if (changed.length >= 50) break;
    }
    return changed.sort().slice(0, 50);
  }

  async cleanup(taskId: string, runId: string): Promise<boolean> {
    return this.preparer.cleanupOwnedGeneration({ taskId, generationId: runId });
  }

  /** Removes exports no run row owns, by their ownership marker only. */
  async sweep(liveRunIds: ReadonlySet<string>): Promise<void> {
    await this.preparer.cleanupOrphanedGenerations(liveRunIds);
  }

  /** Regular files of the tree and their blob ids; links are compared by presence only. */
  private async trackedBlobs(worktreePath: string, treeId: string): Promise<Map<string, string>> {
    const env = await this.snapshots.gitEnvironment(worktreePath);
    const output = await git(worktreePath, ['ls-tree', '-rz', '--full-tree', treeId], { timeout: 120_000, env });
    const tracked = new Map<string, string>();
    for (const record of output.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) blob ([0-9a-f]+)\t(.+)$/s.exec(record);
      if (match && (match[1] === '100644' || match[1] === '100755')) tracked.set(match[3], match[2]);
    }
    return tracked;
  }
}

/** Why untracked files kept a clean copy from being exact, and what makes it possible again. */
function cannotCopy(omitted: ReadOnlySnapshotOmission[]): string {
  const names = (entries: ReadOnlySnapshotOmission[]) =>
    `${entries.slice(0, 2).map((entry) => entry.path).join(', ')}${entries.length > 2 ? ` and ${entries.length - 2} more` : ''}`;
  const large = omitted.filter((entry) => entry.reason === 'LARGER_THAN_FILE_LIMIT');
  if (large.length) return `Untracked files over 5 MB can't be copied: ${names(large)}. Ignore or remove them.`;
  if (omitted.some((entry) => entry.reason === 'TOTAL_LIMIT_REACHED')) return "Untracked files over 256 MB in all can't be copied. Ignore or remove some.";
  return `Only regular files can be copied: ${names(omitted)}. Ignore or remove them.`;
}

export class ReplaySourceError extends Error {
  constructor(
    readonly code: 'OMITTED_FILES' | 'CHANGING' | 'UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'ReplaySourceError';
  }
}
