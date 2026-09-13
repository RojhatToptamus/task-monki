import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Repository,
  Task,
  WorktreeRecord,
  WorktreeStatus
} from '../../shared/contracts';
import {
  enforcePosixMode,
  isOwnedByCurrentUser
} from '../filesystem/secureFilesystem';
import { git, gitSucceeds } from '../git/gitCli';
import { resolveAgentGitMetadata } from '../git/AgentGitMetadata';

export interface WorktreeSpec {
  branchName: string;
  worktreePath: string;
  baseRef?: string;
  baseSha: string;
}

export interface ParsedGitWorktree {
  path: string;
  headSha?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
}

export class WorktreeService {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  getRootDir(): string {
    return this.rootDir;
  }

  buildSpecFromBase(
    task: Task,
    base: { baseRef?: string; baseSha: string }
  ): WorktreeSpec {
    const branchName = `task-monki/task-${task.id.slice(0, 8)}-${slugify(task.title)}`;
    return {
      branchName,
      worktreePath: path.join(this.rootDir, task.id),
      baseRef: base.baseRef,
      baseSha: base.baseSha
    };
  }

  async create(record: WorktreeRecord, repositoryPath: string): Promise<WorktreeRecord> {
    requireFullObjectId(record.baseSha, 'recorded base');
    if (record.headSha) requireFullObjectId(record.headSha, 'last verified head');
    this.assertManaged(record);
    await this.ensureOwnedRoot();
    await this.assertOwnedRecordPath(record);
    const expectedHeadSha = record.headSha ?? record.baseSha;

    if (await pathExists(record.worktreePath)) {
      return requireExpectedHead(
        await this.verify(record, repositoryPath),
        expectedHeadSha
      );
    }

    if (
      expectedHeadSha !== record.baseSha &&
      !(await gitSucceeds(repositoryPath, [
        'merge-base',
        '--is-ancestor',
        record.baseSha,
        expectedHeadSha
      ]))
    ) {
      throw new Error(
        'The last verified task commit is unavailable or no longer descends from the recorded base. Recovery requires review.'
      );
    }

    const branchSha = await resolveLocalBranch(
      repositoryPath,
      `refs/heads/${record.branchName}`
    );

    if (branchSha) {
      if (branchSha !== expectedHeadSha) {
        throw new Error(
          'The task branch already exists at a different commit than the last verified task state. Recovery requires review.'
        );
      }
      await git(repositoryPath, ['worktree', 'add', record.worktreePath, record.branchName], 60_000);
    } else {
      await git(
        repositoryPath,
        ['worktree', 'add', '-b', record.branchName, record.worktreePath, expectedHeadSha],
        60_000
      );
    }

    await enforcePosixMode(record.worktreePath, 0o700);
    return requireExpectedHead(
      await this.verify(record, repositoryPath),
      expectedHeadSha
    );
  }

  async verify(record: WorktreeRecord, repositoryPath: string): Promise<WorktreeRecord> {
    if (record.ownership === 'EXTERNAL') {
      const now = new Date().toISOString();
      try {
        const observed = await inspectExistingWorktree(
          repositoryPath,
          record.worktreePath,
          record.branchName
        );
        return {
          ...record,
          headSha: observed.headSha,
          status: 'PRESENT',
          error: undefined,
          updatedAt: now,
          lastVerifiedAt: now
        };
      } catch (error) {
        return {
          ...record,
          status: (await pathExists(record.worktreePath)) ? 'ERROR' : 'MISSING',
          error: error instanceof Error ? error.message : String(error),
          updatedAt: now,
          lastVerifiedAt: now
        };
      }
    }
    this.assertManaged(record);
    await this.ensureOwnedRoot();
    await this.assertOwnedRecordPath(record);
    requireFullObjectId(record.baseSha, 'recorded base');
    const parsed = await listGitWorktrees(repositoryPath);
    const expectedPath = await canonicalPath(record.worktreePath);
    const resolved = await Promise.all(
      parsed.map(async (candidate) => ({
        candidate,
        canonical: await canonicalPath(candidate.path)
      }))
    );
    const match = resolved.find((candidate) => candidate.canonical === expectedPath)?.candidate;
    if (!match) {
      return {
        ...record,
        status: 'MISSING',
        error: 'Worktree is not present in git worktree list.',
        updatedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString()
      };
    }

    if (match.bare || match.detached || match.branch !== record.branchName) {
      return worktreeVerificationError(
        record,
        'The registered worktree does not use the Task Monki-owned branch. Recovery requires review.'
      );
    }
    if (!match.headSha) {
      return worktreeVerificationError(
        record,
        'Git did not report a commit for the registered worktree. Recovery requires review.'
      );
    }
    const descendsFromBase = await gitSucceeds(repositoryPath, [
      'merge-base',
      '--is-ancestor',
      record.baseSha,
      match.headSha
    ]);
    if (!descendsFromBase) {
      return worktreeVerificationError(
        record,
        'The task branch no longer descends from its recorded base. Recovery requires review.'
      );
    }

    return {
      ...record,
      status: statusForParsedWorktree(match),
      headSha: match.headSha,
      error: undefined,
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString()
    };
  }

  async remove(record: WorktreeRecord, repositoryPath: string): Promise<WorktreeRecord> {
    this.assertManaged(record);
    await this.ensureOwnedRoot();
    await this.assertOwnedRecordPath(record);
    repositoryPath = await canonicalPath(repositoryPath);
    const worktreePath = await canonicalPath(record.worktreePath);
    if (repositoryPath === worktreePath) {
      throw new Error('Task Monki will not remove the original repository checkout.');
    }

    const verified = await this.verify(record, repositoryPath);
    if (verified.status === 'MISSING') {
      return {
        ...verified,
        status: 'REMOVED',
        error: undefined,
        updatedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString()
      };
    }
    if (verified.status === 'LOCKED') {
      throw new Error('The local worktree is locked and cannot be removed by Task Monki.');
    }
    if (await hasUncommittedWork(record.worktreePath)) {
      throw new Error(
        'The local worktree has uncommitted or untracked files. Commit, stash, or clean it before removing the worktree.'
      );
    }

    await git(repositoryPath, ['worktree', 'remove', record.worktreePath], 60_000);
    return {
      ...verified,
      status: 'REMOVED',
      error: undefined,
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString()
    };
  }

  /**
   * Explicit deletion path for a marker-validated managed Design repository.
   * Unlike normal task removal, this path may remove dirty generated bytes.
   */
  async removeOwnedManaged(
    record: WorktreeRecord,
    repository: Pick<Repository, 'kind' | 'path'>
  ): Promise<WorktreeRecord> {
    this.assertManaged(record);
    if (repository.kind !== 'DESIGN_MANAGED') {
      throw new Error('Forced worktree removal is limited to managed Design repositories.');
    }
    await this.ensureOwnedRoot();
    await this.assertOwnedRecordPath(record);
    if (!samePath(record.worktreePath, path.join(this.rootDir, record.taskId))) {
      throw new Error('Managed Design worktree path does not match its task.');
    }
    const repositoryPath = await canonicalPath(repository.path);
    const worktreePath = await canonicalPath(record.worktreePath);
    if (samePath(repositoryPath, worktreePath)) {
      throw new Error('Task Monki will not remove the original repository checkout.');
    }
    const verified = await this.verify(record, repositoryPath);
    if (verified.status === 'MISSING') {
      if (await pathExists(record.worktreePath)) {
        throw new Error('Unregistered content remains at the managed worktree path.');
      }
      const removed = {
        ...verified,
        status: 'REMOVED',
        error: undefined,
        updatedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString()
      } as WorktreeRecord;
      await this.removeOwnedManagedBranch(removed, repositoryPath);
      return removed;
    }
    await git(
      repositoryPath,
      ['worktree', 'remove', '--force', record.worktreePath],
      60_000
    );
    if (await pathExists(record.worktreePath)) {
      throw new Error('Git did not remove the managed Design worktree.');
    }
    const removed = {
      ...verified,
      status: 'REMOVED',
      error: undefined,
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString()
    } as WorktreeRecord;
    await this.removeOwnedManagedBranch(removed, repositoryPath);
    return removed;
  }

  private async removeOwnedManagedBranch(
    record: WorktreeRecord,
    repositoryPath: string
  ): Promise<void> {
    const taskPrefix = `task-monki/task-${record.taskId.slice(0, 8)}-`;
    const legacyDesignBranch = `task-monki/design-${record.taskId.slice(0, 8)}`;
    if (
      !record.branchName.startsWith(taskPrefix) &&
      record.branchName !== legacyDesignBranch
    ) {
      throw new Error('Managed Design branch does not match its task owner.');
    }
    await git(repositoryPath, [
      'check-ref-format',
      `refs/heads/${record.branchName}`
    ]);
    const exists = await gitSucceeds(repositoryPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${record.branchName}`
    ]);
    if (!exists) return;
    await git(repositoryPath, ['branch', '-D', '--', record.branchName]);
  }

  private assertManaged(record: WorktreeRecord): void {
    if (record.ownership !== 'MANAGED') {
      throw new Error('Task Monki cannot create or remove an external checkout.');
    }
  }

  private async ensureOwnedRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
      throw new Error('Task Monki worktree root failed its ownership check.');
    }
    await enforcePosixMode(this.rootDir, 0o700);
  }

  private async assertOwnedRecordPath(record: WorktreeRecord): Promise<void> {
    if (
      !record.taskId ||
      path.basename(record.taskId) !== record.taskId ||
      record.taskId === '.' ||
      record.taskId === '..' ||
      !samePath(path.dirname(path.resolve(record.worktreePath)), this.rootDir)
    ) {
      throw new Error('Task worktree path escaped its configured root.');
    }
    const stat = await fs.lstat(record.worktreePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (
      stat &&
      (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat))
    ) {
      throw new Error('Task worktree path failed its ownership check.');
    }
  }
}

export async function inspectExistingWorktree(
  repositoryPath: string,
  worktreePath: string,
  expectedBranch?: string
): Promise<{ worktreePath: string; branchName: string; headSha: string; gitCommonDir: string }> {
  const metadata = await resolveAgentGitMetadata({ repositoryPath, worktreePath });
  const registered = await listGitWorktrees(metadata.repositoryRoot);
  const match = registered.find((entry) => samePath(entry.path, metadata.worktreeRoot));
  if (!match || match.bare || match.detached || !match.branch) {
    throw new Error('Select a registered checkout on a named branch.');
  }
  if (match.locked || match.prunable) {
    throw new Error('The checkout is locked or unavailable. Repair it in Git before importing it.');
  }
  const branchName = (await git(metadata.worktreeRoot, ['branch', '--show-current'])).trim();
  if (!branchName || branchName !== match.branch || (expectedBranch && branchName !== expectedBranch)) {
    throw new Error(`The checkout must remain on branch ${expectedBranch ?? match.branch}.`);
  }
  const headSha = (await git(metadata.worktreeRoot, [
    'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'
  ])).trim();
  if (headSha !== match.headSha) {
    throw new Error('The checkout changed during inspection. Refresh and try again.');
  }
  return { worktreePath: metadata.worktreeRoot, branchName, headSha, gitCommonDir: metadata.gitCommonDir };
}

export async function listGitWorktrees(repositoryPath: string): Promise<ParsedGitWorktree[]> {
  const output = await git(repositoryPath, ['worktree', 'list', '--porcelain', '-z']);
  return parseGitWorktreeList(output);
}

export function parseGitWorktreeList(output: string): ParsedGitWorktree[] {
  const records: ParsedGitWorktree[] = [];
  let current: ParsedGitWorktree | undefined;

  for (const field of output.split('\0')) {
    if (!field) {
      if (current) {
        records.push(current);
        current = undefined;
      }
      continue;
    }

    const [key, ...rest] = field.split(' ');
    const value = rest.join(' ');

    if (key === 'worktree') {
      if (current) {
        records.push(current);
      }
      current = {
        path: value,
        bare: false,
        detached: false
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === 'HEAD') {
      current.headSha = value;
    } else if (key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'locked') {
      current.locked = value || 'locked';
    } else if (key === 'prunable') {
      current.prunable = value || 'prunable';
    }
  }

  if (current) {
    records.push(current);
  }

  return records;
}

function statusForParsedWorktree(parsed: ParsedGitWorktree): WorktreeStatus {
  if (parsed.locked) {
    return 'LOCKED';
  }
  if (parsed.prunable) {
    return 'PRUNABLE';
  }
  return 'PRESENT';
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasUncommittedWork(worktreePath: string): Promise<boolean> {
  const status = await git(worktreePath, ['status', '--porcelain', '-z']);
  return status.length > 0;
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function requireFullObjectId(value: string, label: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`The ${label} is not an exact Git object ID. Recovery requires review.`);
  }
}

async function resolveLocalBranch(
  repositoryPath: string,
  refName: string
): Promise<string | undefined> {
  try {
    const sha = (
      await git(repositoryPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${refName}^{commit}`
      ])
    ).trim();
    requireFullObjectId(sha, 'task branch commit');
    return sha;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) {
      return undefined;
    }
    throw error;
  }
}

function requireExpectedHead(record: WorktreeRecord, expectedHeadSha: string): WorktreeRecord {
  if (record.status !== 'PRESENT') {
    throw new Error(record.error ?? 'Task Monki could not verify the worktree.');
  }
  if (record.headSha !== expectedHeadSha) {
    throw new Error(
      'The recreated worktree does not match the exact commit approved for creation or recovery. Review its current Git state before retrying.'
    );
  }
  return record;
}

function worktreeVerificationError(
  record: WorktreeRecord,
  error: string
): WorktreeRecord {
  const now = new Date().toISOString();
  return {
    ...record,
    status: 'ERROR',
    error,
    updatedAt: now,
    lastVerifiedAt: now
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
