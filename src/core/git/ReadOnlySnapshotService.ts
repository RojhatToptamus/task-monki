import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SIDE_QUESTION_SNAPSHOT_MAX_FILE_BYTES,
  SIDE_QUESTION_SNAPSHOT_MAX_TOTAL_BYTES
} from '../../shared/sideQuestions';
import {
  canonicalPath,
  enforcePosixMode,
  isOwnedByCurrentUser
} from '../filesystem/secureFilesystem';
import { listGitWorktrees } from '../worktree/WorktreeService';
import { inspectGitWorkingTreeFingerprint } from './GitSnapshotService';
import { git } from './gitCli';

export type ReadOnlySnapshotOmissionReason =
  | 'LARGER_THAN_FILE_LIMIT'
  | 'TOTAL_LIMIT_REACHED'
  | 'NOT_A_FILE';

export interface ReadOnlySnapshotOmission {
  /** Path relative to the worktree root. */
  path: string;
  reason: ReadOnlySnapshotOmissionReason;
}

export interface ReadOnlySnapshot {
  taskId: string;
  threadId: string;
  /** Absolute path of the read-only checkout. */
  path: string;
  /** The live worktree's HEAD when the snapshot was taken. */
  headSha: string;
  /** The live worktree's dirty fingerprint when the snapshot was taken. */
  fingerprint: string;
  takenAt: string;
  /** Untracked files the size limits left out. */
  omitted: ReadOnlySnapshotOmission[];
  /** Whether `prepare` returned the thread's existing snapshot. */
  reused: boolean;
}

export interface ReadOnlySnapshotServiceOptions {
  /** Directory owned by this profile that holds `<taskId>/<threadId>` snapshots. */
  root: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => Date;
}

interface SnapshotEntry extends Omit<ReadOnlySnapshot, 'reused'> {
  liveWorktreePath: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const GIT_TIMEOUT_MS = 120_000;
const FILE_CONCURRENCY = 32;
// Snapshot checkouts must not run repository hooks or download LFS objects. A
// skipped smudge leaves LFS pointers, which match the pointers in `git diff`.
const SNAPSHOT_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: os.devNull,
  GIT_LFS_SKIP_SMUDGE: '1'
};
const DIFF_ARGS = [
  '--binary',
  '--full-index',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--ignore-submodules=all',
  '--src-prefix=a/',
  '--dst-prefix=b/'
] as const;

/**
 * Disposable read-only copies of task worktrees for side questions asked while the
 * implementation agent changes the live checkout. Each is a detached Git worktree at the
 * live HEAD with the live staged, unstaged and untracked changes copied in, and every file
 * and directory except its `.git` link made read-only. A task holds at most one snapshot.
 * Snapshots are process-owned: none survives a restart.
 */
export class ReadOnlySnapshotService {
  private readonly root: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => Date;
  private readonly entries = new Map<string, SnapshotEntry>();
  private readonly taskWork = new Map<string, Promise<unknown>>();
  /** Repositories that registered a snapshot of this process. */
  private readonly repositories = new Set<string>();

  constructor(options: ReadOnlySnapshotServiceOptions) {
    this.root = path.resolve(options.root);
    this.maxFileBytes = options.maxFileBytes ?? SIDE_QUESTION_SNAPSHOT_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? SIDE_QUESTION_SNAPSHOT_MAX_TOTAL_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Returns the thread's snapshot of the live worktree. The existing snapshot is reused
   * while the live HEAD and dirty fingerprint are unchanged; otherwise the task's snapshot
   * is replaced.
   */
  prepare(
    taskId: string,
    threadId: string,
    worktree: { worktreePath: string }
  ): Promise<ReadOnlySnapshot> {
    requireSegment(taskId, 'task');
    requireSegment(threadId, 'thread');
    return this.serialize(taskId, async () => {
      const live = path.resolve(worktree.worktreePath);
      let headSha: string;
      let fingerprint: string;
      try {
        headSha = await resolveHead(live);
        fingerprint = await inspectGitWorkingTreeFingerprint(live);
      } catch (error) {
        throw new Error(`Task Monki could not read the task worktree for a snapshot: ${errorMessage(error)}`, { cause: error });
      }
      const existing = this.entries.get(taskId);
      if (
        existing &&
        existing.threadId === threadId &&
        existing.liveWorktreePath === live &&
        existing.headSha === headSha &&
        existing.fingerprint === fingerprint &&
        (await isDirectory(existing.path))
      ) {
        return { ...snapshotFromEntry(existing), reused: true };
      }
      // A stale snapshot of the same thread is refreshed in place, which rewrites only
      // what changed; a fresh checkout replaces it if that fails.
      const refreshable = Boolean(
        existing &&
        existing.threadId === threadId &&
        existing.liveWorktreePath === live &&
        (await isDirectory(existing.path))
      );
      if (existing && !refreshable) await this.removeDirectory(existing.path, existing.liveWorktreePath);
      this.entries.delete(taskId);
      let created: SnapshotEntry;
      try {
        created = await this.create(taskId, threadId, live, headSha, fingerprint, refreshable);
      } catch (error) {
        if (!refreshable) throw error;
        created = await this.create(taskId, threadId, live, headSha, fingerprint, false);
      }
      this.entries.set(taskId, created);
      return { ...snapshotFromEntry(created), reused: false };
    });
  }

  /**
   * Removes the task's snapshot, or only the thread's when `threadId` is given. Succeeds
   * when there is none.
   */
  remove(taskId: string, threadId?: string): Promise<void> {
    requireSegment(taskId, 'task');
    if (threadId !== undefined) requireSegment(threadId, 'thread');
    return this.serialize(taskId, async () => {
      const entry = this.entries.get(taskId);
      if (entry && (threadId === undefined || entry.threadId === threadId)) {
        await this.removeDirectory(entry.path, entry.liveWorktreePath);
        this.entries.delete(taskId);
      }
      // A snapshot left by an earlier process or a failed removal has no entry.
      const leftovers = threadId === undefined
        ? await listDirectories(path.join(this.root, taskId))
        : [path.join(this.root, taskId, threadId)];
      for (const directory of leftovers) {
        if (await pathExists(directory)) await this.removeDirectory(directory);
      }
      await removeEmptyDirectory(path.join(this.root, taskId));
    });
  }

  removeTask(taskId: string): Promise<void> {
    return this.remove(taskId);
  }

  /**
   * Removes every snapshot under the root and every registration of one in the
   * repositories this process created snapshots in, plus `repositoryPaths`, including
   * registrations whose directories disappeared. A repository that cannot be listed is
   * skipped; failing to remove a snapshot is reported.
   */
  async sweep(repositoryPaths: readonly string[] = []): Promise<void> {
    await Promise.allSettled([...this.taskWork.values()]);
    const failures: unknown[] = [];
    for (const taskDirectory of await listDirectories(this.root)) {
      try {
        await this.serialize(path.basename(taskDirectory), async () => {
          this.entries.delete(path.basename(taskDirectory));
          for (const directory of await listDirectories(taskDirectory)) {
            await this.removeDirectory(directory);
          }
          await removeEmptyDirectory(taskDirectory);
        });
      } catch (error) {
        failures.push(error);
      }
    }
    this.entries.clear();
    const root = canonicalPath(this.root) ?? this.root;
    const repositories = new Set([...repositoryPaths, ...this.repositories].map((item) => path.resolve(item)));
    for (const repositoryPath of repositories) {
      if (!(await isDirectory(repositoryPath))) continue;
      const registered = await listGitWorktrees(repositoryPath)
        .then((entries) => entries.filter((entry) => isInside(root, canonicalPath(entry.path) ?? entry.path)))
        .catch(() => []);
      if (registered.length === 0) continue;
      try {
        for (const entry of registered) {
          await git(repositoryPath, ['worktree', 'remove', '--force', entry.path], GIT_TIMEOUT_MS)
            .catch(() => undefined);
        }
        await pruneIfStillRegistered(repositoryPath, registered.map((entry) => entry.path));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) this.repositories.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Task Monki could not remove every read-only snapshot.');
    }
  }

  private async create(
    taskId: string,
    threadId: string,
    live: string,
    headSha: string,
    fingerprint: string,
    refresh: boolean
  ): Promise<SnapshotEntry> {
    await ensurePrivateDirectory(this.root);
    const taskDirectory = path.join(this.root, taskId);
    await ensurePrivateDirectory(taskDirectory);
    const target = path.join(taskDirectory, threadId);
    // Clears a leftover directory or a registration whose directory disappeared.
    if (!refresh) await this.removeDirectory(target, live);
    const takenAt = this.now().toISOString();
    const patches = {
      staged: path.join(taskDirectory, `.staged-${randomUUID()}.patch`),
      working: path.join(taskDirectory, `.working-${randomUUID()}.patch`)
    };
    try {
      // Patches go through files so binary and non-UTF-8 content stays byte-exact.
      await git(live, ['diff', '--cached', ...DIFF_ARGS, `--output=${patches.staged}`, headSha, '--'], GIT_TIMEOUT_MS);
      await git(live, ['diff', ...DIFF_ARGS, `--output=${patches.working}`, headSha, '--'], GIT_TIMEOUT_MS);
      const untracked = await listUntracked(live);
      this.repositories.add(live);
      if (refresh) {
        await setWritable(target, true);
        await git(target, ['reset', '-q', '--hard', headSha], { timeout: GIT_TIMEOUT_MS, env: SNAPSHOT_GIT_ENV });
        await git(target, ['clean', '-ffdxq'], { timeout: GIT_TIMEOUT_MS, env: SNAPSHOT_GIT_ENV });
      } else {
        await git(live, ['worktree', 'add', '--detach', target, headSha], { timeout: GIT_TIMEOUT_MS, env: SNAPSHOT_GIT_ENV });
        const repositoryPath = await gitRepositoryOf(target);
        if (repositoryPath) this.repositories.add(repositoryPath);
        await enforcePosixMode(target, 0o700);
      }
      // Staged changes go to the snapshot index only; all working changes go to its files.
      if (await hasContent(patches.staged)) {
        await git(target, ['apply', '--cached', '--binary', '--whitespace=nowarn', patches.staged], { timeout: GIT_TIMEOUT_MS, env: SNAPSHOT_GIT_ENV });
      }
      if (await hasContent(patches.working)) {
        await git(target, ['apply', '--binary', '--whitespace=nowarn', patches.working], { timeout: GIT_TIMEOUT_MS, env: SNAPSHOT_GIT_ENV });
      }
      const omitted = await this.copyUntracked(live, target, untracked);
      await setWritable(target, false);
      // Permission changes alter file ctimes. Refresh the snapshot index once so later
      // status checks, such as the read-only comparison, need not rehash those files.
      await git(target, ['update-index', '-q', '--refresh'], { timeout: GIT_TIMEOUT_MS, env: SNAPSHOT_GIT_ENV })
        .catch(() => undefined);
      return { taskId, threadId, path: target, headSha, fingerprint, takenAt, omitted, liveWorktreePath: live };
    } catch (error) {
      await this.removeDirectory(target, live).catch(() => undefined);
      throw new Error(`Task Monki could not prepare a read-only snapshot of the worktree: ${errorMessage(error)}`, { cause: error });
    } finally {
      await Promise.all(Object.values(patches).map((file) => fs.rm(file, { force: true })));
    }
  }

  private async copyUntracked(
    live: string,
    target: string,
    relativePaths: readonly string[]
  ): Promise<ReadOnlySnapshotOmission[]> {
    const inspected = await mapConcurrent(relativePaths, async (relative) => {
      const source = path.resolve(live, relative);
      const destination = path.resolve(target, relative);
      if (relative.endsWith('/') || !isInside(live, source) || !isInside(target, destination)) {
        return { relative, source, destination, kind: 'OTHER' as const, size: 0 };
      }
      const stat = await fs.lstat(source).catch(() => undefined);
      if (!stat) return undefined;
      const kind = stat.isSymbolicLink() ? 'LINK' as const : stat.isFile() ? 'FILE' as const : 'OTHER' as const;
      return { relative, source, destination, kind, size: kind === 'FILE' ? stat.size : 0 };
    });
    const omitted: ReadOnlySnapshotOmission[] = [];
    const copies: Array<NonNullable<(typeof inspected)[number]>> = [];
    let total = 0;
    for (const file of inspected) {
      if (!file) continue;
      if (file.kind === 'OTHER') {
        omitted.push({ path: file.relative.replace(/\/$/u, ''), reason: 'NOT_A_FILE' });
      } else if (file.size > this.maxFileBytes) {
        omitted.push({ path: file.relative, reason: 'LARGER_THAN_FILE_LIMIT' });
      } else if (total + file.size > this.maxTotalBytes) {
        omitted.push({ path: file.relative, reason: 'TOTAL_LIMIT_REACHED' });
      } else {
        total += file.size;
        copies.push(file);
      }
    }
    await mapConcurrent(copies, async (file) => {
      await fs.mkdir(path.dirname(file.destination), { recursive: true });
      if (file.kind === 'LINK') {
        await fs.symlink(await fs.readlink(file.source), file.destination);
      } else {
        await fs.copyFile(file.source, file.destination, fsConstants.COPYFILE_FICLONE);
      }
    });
    return omitted;
  }

  /**
   * Restores write permission, removes the Git worktree registration and the directory.
   * Git's own prune runs only when a registration survives `worktree remove`, because it
   * would also drop unrelated registrations of missing checkouts.
   */
  private async removeDirectory(target: string, liveWorktreePath?: string): Promise<void> {
    if (!isInside(this.root, target)) throw new Error('A snapshot path escaped its root.');
    if (await pathExists(target)) await setWritable(target, true).catch(() => undefined);
    const repositoryPath = (await gitRepositoryOf(target)) ??
      (liveWorktreePath && (await isDirectory(liveWorktreePath)) ? liveWorktreePath : undefined);
    if (repositoryPath) {
      await git(repositoryPath, ['worktree', 'remove', '--force', target], GIT_TIMEOUT_MS).catch(() => undefined);
    }
    await fs.rm(target, { recursive: true, force: true });
    if (repositoryPath) await pruneIfStillRegistered(repositoryPath, [target]);
  }

  private serialize<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.taskWork.get(taskId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(action);
    const settled = work.catch(() => undefined);
    this.taskWork.set(taskId, settled);
    void settled.then(() => {
      if (this.taskWork.get(taskId) === settled) this.taskWork.delete(taskId);
    });
    return work;
  }
}

function snapshotFromEntry(entry: SnapshotEntry): Omit<ReadOnlySnapshot, 'reused'> {
  return {
    taskId: entry.taskId,
    threadId: entry.threadId,
    path: entry.path,
    headSha: entry.headSha,
    fingerprint: entry.fingerprint,
    takenAt: entry.takenAt,
    omitted: entry.omitted.map((item) => ({ ...item }))
  };
}

async function resolveHead(worktreePath: string): Promise<string> {
  const sha = (await git(worktreePath, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) throw new Error('Git did not report the worktree HEAD.');
  return sha;
}

async function listUntracked(worktreePath: string): Promise<string[]> {
  const output = await git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], GIT_TIMEOUT_MS);
  return output.split('\0').filter(Boolean).sort();
}

/** The repository that registers a snapshot, from the gitdir in its `.git` link. */
async function gitRepositoryOf(target: string): Promise<string | undefined> {
  const link = await fs.readFile(path.join(target, '.git'), 'utf8').catch(() => undefined);
  const gitdir = link?.match(/^gitdir:\s*(.+?)\s*$/mu)?.[1];
  if (!gitdir) return undefined;
  const adminDirectory = path.resolve(target, gitdir);
  if (path.basename(path.dirname(adminDirectory)) !== 'worktrees') return undefined;
  const commonDirectory = path.dirname(path.dirname(adminDirectory));
  const repositoryPath = path.basename(commonDirectory) === '.git'
    ? path.dirname(commonDirectory)
    : commonDirectory;
  return (await isDirectory(repositoryPath)) ? repositoryPath : undefined;
}

async function pruneIfStillRegistered(repositoryPath: string, targets: readonly string[]): Promise<void> {
  const expected = new Set(targets.map((target) => canonicalPath(target) ?? path.resolve(target)));
  const stillRegistered = async () =>
    (await listGitWorktrees(repositoryPath)).some((entry) =>
      expected.has(canonicalPath(entry.path) ?? path.resolve(entry.path)));
  if (!(await stillRegistered())) return;
  await git(repositoryPath, ['worktree', 'prune'], GIT_TIMEOUT_MS);
  if (await stillRegistered()) {
    throw new Error('Git still registers a removed read-only snapshot.');
  }
}

/**
 * Makes every file and directory except the root `.git` link read-only, or restores the
 * write access that changing and removing entries needs. POSIX needs writable directories
 * only, so unchanged files keep their status; Windows also needs writable files. Entries
 * that already have the wanted access are left untouched.
 */
async function setWritable(root: string, writable: boolean): Promise<void> {
  const files = !writable || process.platform === 'win32';
  const update = async (entry: string, directory: boolean, isRoot = false): Promise<void> => {
    if (!directory && !files) return;
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink()) return;
    const mode = stat.mode & 0o7777;
    const next = writable ? mode | (directory ? 0o700 : 0o200) : mode & 0o7555;
    if (directory) {
      // A directory must be writable before its entries change, and read-only only after.
      if (writable && next !== mode) await enforcePosixMode(entry, next);
      const children = (await fs.readdir(entry, { withFileTypes: true }))
        .filter((child) => !child.isSymbolicLink() && !(isRoot && child.name === '.git'));
      await mapConcurrent(children, (child) => update(path.join(entry, child.name), child.isDirectory()));
      if (!writable && next !== mode) await enforcePosixMode(entry, next);
      return;
    }
    if (next !== mode) await enforcePosixMode(entry, next);
  };
  await update(root, true, true);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
    throw new Error('The read-only snapshot directory failed its ownership check.');
  }
  await enforcePosixMode(directory, 0o700);
}

async function listDirectories(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  const remaining = await fs.readdir(directory).catch(() => undefined);
  if (!remaining) return;
  // Patch files from an interrupted snapshot are this owner's scratch files.
  for (const name of remaining) {
    if (/^\.(?:staged|working)-[0-9a-f-]+\.patch$/u.test(name)) {
      await fs.rm(path.join(directory, name), { force: true });
    }
  }
  await fs.rmdir(directory).catch(() => undefined);
}

async function hasContent(file: string): Promise<boolean> {
  return ((await fs.stat(file).catch(() => undefined))?.size ?? 0) > 0;
}

async function isDirectory(candidate: string): Promise<boolean> {
  return (await fs.stat(candidate).catch(() => undefined))?.isDirectory() ?? false;
}

async function pathExists(candidate: string): Promise<boolean> {
  return (await fs.lstat(candidate).catch(() => undefined)) !== undefined;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function requireSegment(value: string, label: string): void {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
    throw new Error(`A valid ${label} ID is required for a snapshot.`);
  }
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(FILE_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === 'string' && stderr.trim() ? `${error.message.split('\n')[0]} ${stderr.trim()}` : error.message;
  }
  return String(error);
}
