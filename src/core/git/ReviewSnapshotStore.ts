import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReviewChangesResult } from '../../shared/contracts';
import { changeIndexText, parseReviewedDiff, type ReviewedDiffFile } from '../review/ReviewedDiff';
import { GIT_HOOKS_OFF_ENV, git, gitResult } from './gitCli';
import { planUntrackedFiles, type ReadOnlySnapshotOmission } from './ReadOnlySnapshotService';
import { boundedTreeDiff } from './treeDiff';

const GIT_TIMEOUT_MS = 120_000;
/** A store is pruned at most this often, and keeps objects younger than the grace, so a tree captured and not pinned yet keeps its content. */
const PRUNE_INTERVAL_MS = 10 * 60_000;
const PRUNE_GRACE = '1.hour.ago';

type UnavailableReason = Extract<ReviewChangesResult, { status: 'UNAVAILABLE' }>['reason'];

/** The change a review read, file by file, and as its prompt lists it. */
export type ReviewChangeIndex =
  | { status: 'READY'; files: ReviewedDiffFile[]; text: string }
  | { status: 'UNAVAILABLE'; reason: Exclude<UnavailableReason, 'NOT_RECORDED'> };

interface SnapshotRepository {
  /** The private bare repository that holds this source repository's review trees. */
  dir: string;
  /** Git environment that writes new objects to the store and reads the source repository's own. */
  env: NodeJS.ProcessEnv;
}

/**
 * The code each review read, kept exactly. When a review starts, the worktree's
 * content (committed, staged and unstaged edits, and untracked files Git does
 * not ignore, within the snapshot size limits) is written as a Git tree into a
 * private bare repository under the profile, one per source repository, and
 * pinned by a ref named for the task and the review. The store borrows the
 * source repository's objects read-only, so only new file contents are stored,
 * and nothing is ever written to the user's repository. The change a review read
 * is then an exact diff from its base to that tree, and "what changed since a
 * review" one from that tree to the worktree as it is now.
 */
export class ReviewSnapshotStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly prunedAt = new Map<string, number>();

  constructor(private readonly root: string) {}

  /** Writes the worktree's current content as a tree in the store, unpinned; returns its id. */
  async capture(worktreePath: string): Promise<string> {
    const store = await this.storeFor(worktreePath);
    return this.serialize(store.dir, () => this.writeTree(worktreePath, store));
  }

  /** Keeps a captured tree as the code a review read. */
  pin(worktreePath: string, taskId: string, reviewRunId: string, tree: string): Promise<void> {
    return this.pinTree(worktreePath, reviewRef(taskId, reviewRunId), tree);
  }

  /** Lets go of the code kept for a review that never started; its tree goes with the store's next prune. */
  unpin(worktreePath: string, taskId: string, reviewRunId: string): Promise<void> {
    return this.releaseRef(worktreePath, reviewRef(taskId, reviewRunId));
  }

  /**
   * The changes from the code a review read to the worktree as it is now. A
   * recorded tree that differs from `expectedTree` is never shown as the review's.
   */
  async changesSince(worktreePath: string, taskId: string, reviewRunId: string, expectedTree?: string): Promise<ReviewChangesResult> {
    const store = await this.storeFor(worktreePath);
    return this.serialize(store.dir, async () => {
      const recorded = await this.recordedTree(store, taskId, reviewRunId, expectedTree);
      if (typeof recorded !== 'string') return recorded;
      let current: string;
      try {
        current = await this.writeTree(worktreePath, store);
      } catch {
        return { status: 'UNAVAILABLE', reason: 'UNREADABLE' };
      }
      const diff = await boundedTreeDiff(worktreePath, recorded, current, store.env);
      return typeof diff === 'string'
        ? { status: 'READY', reviewRunId, tree: recorded, diff }
        : { status: 'UNAVAILABLE', reason: diff.reason };
    });
  }

  /**
   * Captures the worktree's exact content and pins it under `ref` in one serialized step, so a
   * concurrent prune cannot collect the new objects. Untracked files the size limits leave out
   * are returned instead of being dropped silently.
   */
  async captureTree(worktreePath: string, ref: string): Promise<{ treeId: string; omitted: ReadOnlySnapshotOmission[] }> {
    assertOwnedRef(ref);
    const store = await this.storeFor(worktreePath);
    return this.serialize(store.dir, async () => {
      const plan = await planUntrackedFiles(worktreePath);
      const treeId = await this.writeTree(worktreePath, store, plan);
      await git(store.dir, ['update-ref', ref, treeId], GIT_TIMEOUT_MS);
      return { treeId, omitted: plan.omitted };
    });
  }

  /** Pins an existing tree under another owned ref. */
  async pinTree(worktreePath: string, ref: string, treeId: string): Promise<void> {
    assertOwnedRef(ref);
    const store = await this.storeFor(worktreePath);
    await this.serialize(store.dir, () => git(store.dir, ['update-ref', ref, treeId], GIT_TIMEOUT_MS));
  }

  /** Lets go of one owned ref; its objects go with the store's next prune. */
  async releaseRef(worktreePath: string, ref: string): Promise<void> {
    assertOwnedRef(ref);
    const store = await this.storeFor(worktreePath);
    await this.serialize(store.dir, () => git(store.dir, ['update-ref', '-d', ref], GIT_TIMEOUT_MS).catch(() => undefined));
    if (Date.now() - (this.prunedAt.get(store.dir) ?? 0) >= PRUNE_INTERVAL_MS) await this.prune(store);
  }

  /** True when the store can still read every object of the tree. */
  async hasTree(worktreePath: string, treeId: string): Promise<boolean> {
    const store = await this.storeFor(worktreePath);
    return this.serialize(store.dir, async () => {
      try {
        await git(worktreePath, ['ls-tree', '-r', '--full-tree', '--name-only', treeId], { timeout: GIT_TIMEOUT_MS, env: store.env });
        return true;
      } catch {
        return false;
      }
    });
  }

  /** The Git environment that reads the store's trees and the source repository's objects. */
  async gitEnvironment(worktreePath: string): Promise<NodeJS.ProcessEnv> {
    return { ...(await this.storeFor(worktreePath)).env };
  }

  /** Blob ids and modes of the given paths in a tree; absent paths are left out. */
  async entriesAt(worktreePath: string, treeId: string, paths: string[]): Promise<Map<string, { mode: string; blob: string }>> {
    if (paths.length === 0) return new Map();
    return this.entries(worktreePath, await this.storeFor(worktreePath), treeId, paths);
  }

  /** Every path in a tree, for rules that look for files by name. */
  async listTree(worktreePath: string, treeId: string): Promise<string[]> {
    const store = await this.storeFor(worktreePath);
    const output = await git(worktreePath, ['ls-tree', '-rz', '--full-tree', '--name-only', treeId], { timeout: GIT_TIMEOUT_MS, env: store.env });
    return output.split('\0').filter(Boolean);
  }

  /** The text of one file in a tree, bounded; undefined when it is absent or larger than the bound. */
  async readText(worktreePath: string, treeId: string, filePath: string, maxBytes = 512 * 1024): Promise<string | undefined> {
    const store = await this.storeFor(worktreePath);
    const entry = (await this.entries(worktreePath, store, treeId, [filePath])).get(filePath);
    if (!entry) return undefined;
    const size = Number((await git(worktreePath, ['cat-file', '-s', entry.blob], { timeout: GIT_TIMEOUT_MS, env: store.env })).trim());
    if (!Number.isFinite(size) || size > maxBytes) return undefined;
    return git(worktreePath, ['cat-file', 'blob', entry.blob], { timeout: GIT_TIMEOUT_MS, env: store.env });
  }

  /**
   * Lines added between two trees, with their paths, for scanning. Bounded: a diff larger than the
   * Git output limit fails, and at most `maxLines` lines are returned.
   */
  async addedLines(worktreePath: string, fromTree: string, toTree: string, maxLines = 5_000): Promise<Array<{ path: string; text: string }>> {
    const store = await this.storeFor(worktreePath);
    const output = await git(
      worktreePath,
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', fromTree, toTree],
      { timeout: GIT_TIMEOUT_MS, env: store.env }
    );
    const lines: Array<{ path: string; text: string }> = [];
    let current = '';
    for (const line of output.split('\n')) {
      if (line.startsWith('+++ ')) {
        current = line.startsWith('+++ b/') ? line.slice(6) : '';
        continue;
      }
      if (!current || !line.startsWith('+')) continue;
      lines.push({ path: current, text: line.slice(1) });
      if (lines.length >= maxLines) break;
    }
    return lines;
  }

  private async entries(worktreePath: string, store: SnapshotRepository, treeId: string, paths: string[]): Promise<Map<string, { mode: string; blob: string }>> {
    const entries = new Map<string, { mode: string; blob: string }>();
    const output = await git(worktreePath, ['ls-tree', '-z', '--full-tree', treeId, '--', ...paths], { timeout: GIT_TIMEOUT_MS, env: store.env });
    for (const record of output.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(record);
      if (match && match[2] === 'blob') entries.set(match[4], { mode: match[1], blob: match[3] });
    }
    return entries;
  }

  /**
   * The change a review read, as one diff from the base it compared against to
   * the tree it read. A recorded tree that differs from `expectedTree` is never
   * shown as the review's.
   */
  async reviewedDiff(worktreePath: string, taskId: string, reviewRunId: string, baseSha: string, expectedTree?: string): Promise<ReviewChangesResult> {
    // Reads pinned objects only, so it waits on no capture.
    const store = await this.storeFor(worktreePath);
    const recorded = await this.recordedTree(store, taskId, reviewRunId, expectedTree);
    if (typeof recorded !== 'string') return recorded;
    const diff = await boundedTreeDiff(worktreePath, baseSha, recorded, store.env);
    return typeof diff === 'string'
      ? { status: 'READY', reviewRunId, tree: recorded, diff }
      : { status: 'UNAVAILABLE', reason: diff.reason };
  }

  /**
   * The change from `baseSha` to a captured tree, file by file with its hunks,
   * and as the review prompt lists it. Bounded like the diff it reads; it reads
   * kept objects only, so it waits on no capture.
   */
  async changeIndex(worktreePath: string, baseSha: string, tree: string): Promise<ReviewChangeIndex> {
    try {
      const store = await this.storeFor(worktreePath);
      const diff = await boundedTreeDiff(worktreePath, baseSha, tree, store.env);
      if (typeof diff !== 'string') return { status: 'UNAVAILABLE', reason: diff.reason };
      const files = parseReviewedDiff(diff);
      return { status: 'READY', files, text: changeIndexText(files) };
    } catch {
      return { status: 'UNAVAILABLE', reason: 'UNREADABLE' };
    }
  }

  /** Lets go of every review tree of a task; the trees themselves go with the store's next prune. */
  async removeTask(worktreePath: string, taskId: string): Promise<void> {
    const store = await this.storeFor(worktreePath);
    await this.serialize(store.dir, async () => {
      const refs = (await git(store.dir, ['for-each-ref', '--format=%(refname)', `refs/tasks/${taskId}/`], GIT_TIMEOUT_MS))
        .split('\n').filter(Boolean);
      if (refs.length) await git(store.dir, ['update-ref', '--stdin'], { timeout: GIT_TIMEOUT_MS, stdin: refs.map((ref) => `delete ${ref}\n`).join('') });
    });
    await this.prune(store);
  }

  /** Collects the objects no ref keeps any more, except those younger than the grace. */
  private async prune(store: SnapshotRepository): Promise<void> {
    this.prunedAt.set(store.dir, Date.now());
    await this.serialize(store.dir, () => git(store.dir, ['prune', `--expire=${PRUNE_GRACE}`], GIT_TIMEOUT_MS).catch(() => undefined));
  }

  private async storeFor(worktreePath: string): Promise<SnapshotRepository> {
    const commonDir = path.resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-common-dir'])).trim());
    const objects = path.join(await fs.realpath(commonDir), 'objects');
    const dir = path.join(this.root, `${createHash('sha256').update(objects).digest('hex').slice(0, 24)}.git`);
    if (!(await exists(path.join(dir, 'HEAD')))) {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await git(this.root, ['init', '--bare', '--quiet', dir], GIT_TIMEOUT_MS);
      await git(dir, ['config', 'gc.auto', '0'], GIT_TIMEOUT_MS);
    }
    // Reads through to the source repository's objects; rewritten when the repository moved, and
    // replaced whole, so a Git process reading it never sees it empty.
    const alternates = path.join(dir, 'objects', 'info', 'alternates');
    if ((await fs.readFile(alternates, 'utf8').catch(() => '')) !== `${objects}\n`) {
      const next = `${alternates}.${randomUUID()}`;
      await fs.writeFile(next, `${objects}\n`);
      await fs.rename(next, alternates);
    }
    return { dir, env: { GIT_OBJECT_DIRECTORY: path.join(dir, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects } };
  }

  /** The tree pinned for a review, unless it is missing or is not `expectedTree`. */
  private async recordedTree(
    store: SnapshotRepository,
    taskId: string,
    reviewRunId: string,
    expectedTree: string | undefined
  ): Promise<string | Extract<ReviewChangesResult, { status: 'UNAVAILABLE' }>> {
    const recorded = await gitResult(store.dir, ['rev-parse', '--verify', '--quiet', `${reviewRef(taskId, reviewRunId)}^{tree}`], GIT_TIMEOUT_MS)
      .then((result) => result.stdout.trim(), () => '');
    if (!recorded) return { status: 'UNAVAILABLE', reason: 'NOT_RECORDED' };
    if (expectedTree && recorded !== expectedTree) return { status: 'UNAVAILABLE', reason: 'UNREADABLE' };
    return recorded;
  }

  /** The worktree's content as a tree, staged in a private copy of its index so the worktree is untouched. */
  private async writeTree(worktreePath: string, store: SnapshotRepository, plan?: Awaited<ReturnType<typeof planUntrackedFiles>>): Promise<string> {
    const index = path.join(store.dir, `index-${randomUUID()}`);
    // A private index is no one's change, so no hook runs for it: hooks can live in the
    // worktree itself (a relative `core.hooksPath`), and there they may be a pull request's.
    const env = { ...store.env, GIT_INDEX_FILE: index, ...GIT_HOOKS_OFF_ENV };
    try {
      // The worktree's own index carries the staged changes and the stat cache, so only edited files are hashed.
      const ownIndex = path.resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim());
      const indexTimes = await fs.stat(ownIndex).catch(() => undefined);
      if (indexTimes) {
        await fs.copyFile(ownIndex, index);
        // Git trusts a file's cached stat unless the file changed within the second the index was
        // written. The copy keeps the index's own time, read before copying, so an edit made in
        // that second is still read from disk rather than missed.
        await fs.utimes(index, indexTimes.atime, indexTimes.mtime);
      } else await git(worktreePath, ['read-tree', 'HEAD'], { timeout: GIT_TIMEOUT_MS, env });
      await git(worktreePath, ['add', '--update', '--', '.'], { timeout: GIT_TIMEOUT_MS, env });
      const untracked = (plan ?? (await planUntrackedFiles(worktreePath))).files.map((file) => file.relative);
      if (untracked.length) {
        await git(worktreePath, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { timeout: GIT_TIMEOUT_MS, env, stdin: untracked.join('\0') });
      }
      return (await git(worktreePath, ['write-tree'], { timeout: GIT_TIMEOUT_MS, env })).trim();
    } finally {
      await fs.rm(index, { force: true });
      await fs.rm(`${index}.lock`, { force: true });
    }
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }
}

/** Bug Replay keeps its trees under its own namespace beside the review refs. */
export function bugReplayRef(taskId: string, name: string): string {
  return `refs/tasks/${taskId}/bug-replay/${name}`;
}

function assertOwnedRef(ref: string): void {
  if (!/^refs\/tasks\/[A-Za-z0-9-]+\/(?:reviews|bug-replay)\/[A-Za-z0-9._-]+$/.test(ref)) {
    throw new Error('The snapshot ref is not owned by Task Monki.');
  }
}

function reviewRef(taskId: string, reviewRunId: string): string {
  return `refs/tasks/${taskId}/reviews/${reviewRunId}`;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}
