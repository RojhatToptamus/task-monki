import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SIDE_QUESTION_SNAPSHOT_MAX_FILE_BYTES, SIDE_QUESTION_SNAPSHOT_MAX_TOTAL_BYTES } from '../../shared/sideQuestions';
import type { ReviewChangesResult } from '../../shared/contracts';
import { git, gitResult } from './gitCli';

const GIT_TIMEOUT_MS = 120_000;
/** A diff of changes since a review larger than this is not shown; the full diff still is. */
export const REVIEW_CHANGES_MAX_BYTES = 8 * 1024 * 1024;

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
 * and nothing is ever written to the user's repository. "What changed since a
 * review" is then an exact diff from that tree to the worktree as it is now.
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
      const recorded = await gitResult(store.dir, ['rev-parse', '--verify', '--quiet', `${reviewRef(taskId, reviewRunId)}^{tree}`], GIT_TIMEOUT_MS)
        .then((result) => result.stdout.trim(), () => '');
      if (!recorded) return { status: 'UNAVAILABLE', reason: 'NOT_RECORDED' };
      if (expectedTree && recorded !== expectedTree) return { status: 'UNAVAILABLE', reason: 'UNREADABLE' };
      try {
        const current = await this.writeTree(worktreePath, store);
        const diff = await git(worktreePath, ['diff-tree', '-p', '-M', '--no-color', '--no-ext-diff', recorded, current], { timeout: GIT_TIMEOUT_MS, env: store.env });
        if (Buffer.byteLength(diff) > REVIEW_CHANGES_MAX_BYTES) return { status: 'UNAVAILABLE', reason: 'TOO_LARGE' };
        return { status: 'READY', reviewRunId, tree: recorded, diff };
      } catch (error) {
        // A tree whose objects the source repository has since pruned, or output past the buffer.
        return { status: 'UNAVAILABLE', reason: /maxBuffer/i.test(String(error)) ? 'TOO_LARGE' : 'UNREADABLE' };
      }
    });
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

  /** The worktree's content as a tree, staged in a private copy of its index so the worktree is untouched. */
  private async writeTree(worktreePath: string, store: SnapshotRepository): Promise<string> {
    const index = path.join(store.dir, `index-${randomUUID()}`);
    const env = { ...store.env, GIT_INDEX_FILE: index };
    try {
      // The worktree's own index carries the staged changes and the stat cache, so only edited files are hashed.
      const ownIndex = path.resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim());
      if (await exists(ownIndex)) await fs.copyFile(ownIndex, index);
      else await git(worktreePath, ['read-tree', 'HEAD'], { timeout: GIT_TIMEOUT_MS, env });
      await git(worktreePath, ['add', '--update', '--', '.'], { timeout: GIT_TIMEOUT_MS, env });
      const untracked = await untrackedWithinLimits(worktreePath, env);
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

/** Untracked files Git does not ignore, within the same limits as a side question's snapshot. */
async function untrackedWithinLimits(worktreePath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const listed = (await git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: GIT_TIMEOUT_MS, env }))
    .split('\0').filter(Boolean);
  const kept: string[] = [];
  let total = 0;
  for (const relative of listed) {
    const stat = await fs.lstat(path.join(worktreePath, relative)).catch(() => undefined);
    if (!stat || !(stat.isFile() || stat.isSymbolicLink())) continue;
    if (stat.size > SIDE_QUESTION_SNAPSHOT_MAX_FILE_BYTES || total + stat.size > SIDE_QUESTION_SNAPSHOT_MAX_TOTAL_BYTES) continue;
    total += stat.size;
    kept.push(relative);
  }
  return kept;
}

function reviewRef(taskId: string, reviewRunId: string): string {
  return `refs/tasks/${taskId}/reviews/${reviewRunId}`;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}
