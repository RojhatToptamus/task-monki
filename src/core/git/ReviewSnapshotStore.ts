import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReviewChangesResult } from '../../shared/contracts';
import { changeIndexText, parseReviewedDiff, type ReviewedDiffFile } from '../review/ReviewedDiff';
import { GIT_HOOKS_OFF_ENV, git, gitResult } from './gitCli';
import { planUntrackedFiles } from './ReadOnlySnapshotService';
import { boundedTreeDiff } from './treeDiff';

const GIT_TIMEOUT_MS = 120_000;

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

  constructor(private readonly root: string) {}

  /** Writes the worktree's current content as a tree in the store, unpinned; returns its id. */
  async capture(worktreePath: string): Promise<string> {
    const store = await this.storeFor(worktreePath);
    return this.serialize(store.dir, () => this.writeTree(worktreePath, store));
  }

  /** Keeps a captured tree as the code a review read. */
  async pin(worktreePath: string, taskId: string, reviewRunId: string, tree: string): Promise<void> {
    const store = await this.storeFor(worktreePath);
    await this.serialize(store.dir, () => git(store.dir, ['update-ref', reviewRef(taskId, reviewRunId), tree], GIT_TIMEOUT_MS));
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
   * The change a review read, as one diff from the base it compared against to
   * the tree it read. A recorded tree that differs from `expectedTree` is never
   * shown as the review's.
   */
  async reviewedDiff(worktreePath: string, taskId: string, reviewRunId: string, baseSha: string, expectedTree?: string): Promise<ReviewChangesResult> {
    const store = await this.storeFor(worktreePath);
    return this.serialize(store.dir, async () => {
      const recorded = await this.recordedTree(store, taskId, reviewRunId, expectedTree);
      if (typeof recorded !== 'string') return recorded;
      const diff = await boundedTreeDiff(worktreePath, baseSha, recorded, store.env);
      return typeof diff === 'string'
        ? { status: 'READY', reviewRunId, tree: recorded, diff }
        : { status: 'UNAVAILABLE', reason: diff.reason };
    });
  }

  /**
   * The change from `baseSha` to a captured tree, file by file with its hunks,
   * and as the review prompt lists it. Bounded like the diff it reads.
   */
  async changeIndex(worktreePath: string, baseSha: string, tree: string): Promise<ReviewChangeIndex> {
    try {
      const store = await this.storeFor(worktreePath);
      const diff = await this.serialize(store.dir, () => boundedTreeDiff(worktreePath, baseSha, tree, store.env));
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
      await git(store.dir, ['prune', '--expire=now'], GIT_TIMEOUT_MS).catch(() => undefined);
    });
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
    // Reads through to the source repository's objects; rewritten in case the repository moved.
    await fs.writeFile(path.join(dir, 'objects', 'info', 'alternates'), `${objects}\n`);
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
  private async writeTree(worktreePath: string, store: SnapshotRepository): Promise<string> {
    const index = path.join(store.dir, `index-${randomUUID()}`);
    // A private index is no one's change, so no hook runs for it: hooks can live in the
    // worktree itself (a relative `core.hooksPath`), and there they may be a pull request's.
    const env = { ...store.env, GIT_INDEX_FILE: index, ...GIT_HOOKS_OFF_ENV };
    try {
      // The worktree's own index carries the staged changes and the stat cache, so only edited files are hashed.
      const ownIndex = path.resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim());
      if (await exists(ownIndex)) await fs.copyFile(ownIndex, index);
      else await git(worktreePath, ['read-tree', 'HEAD'], { timeout: GIT_TIMEOUT_MS, env });
      await git(worktreePath, ['add', '--update', '--', '.'], { timeout: GIT_TIMEOUT_MS, env });
      const untracked = (await planUntrackedFiles(worktreePath)).files.map((file) => file.relative);
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

function reviewRef(taskId: string, reviewRunId: string): string {
  return `refs/tasks/${taskId}/reviews/${reviewRunId}`;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}
