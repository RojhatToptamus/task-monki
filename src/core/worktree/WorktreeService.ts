import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryPreflight, Task, WorktreeRecord, WorktreeStatus } from '../../shared/contracts';
import { git, gitSucceeds } from '../git/gitCli';

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
  constructor(private readonly rootDir: string) {}

  buildSpec(task: Task, preflight: RepositoryPreflight): WorktreeSpec {
    if (preflight.status !== 'VALID' || !preflight.headSha) {
      throw new Error(preflight.error ?? 'Repository preflight must pass before creating a worktree.');
    }

    const branchName = `codex/task-${task.id.slice(0, 8)}-${slugify(task.title)}`;
    return {
      branchName,
      worktreePath: path.join(this.rootDir, task.id),
      baseRef: preflight.branch,
      baseSha: preflight.headSha
    };
  }

  async create(record: WorktreeRecord): Promise<WorktreeRecord> {
    await fs.mkdir(path.dirname(record.worktreePath), { recursive: true });

    if (await pathExists(record.worktreePath)) {
      return this.verify(record);
    }

    const branchExists = await gitSucceeds(record.repositoryPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${record.branchName}`
    ]);

    if (branchExists) {
      await git(record.repositoryPath, ['worktree', 'add', record.worktreePath, record.branchName], 60_000);
    } else {
      await git(
        record.repositoryPath,
        ['worktree', 'add', '-b', record.branchName, record.worktreePath, record.baseSha],
        60_000
      );
    }

    return this.verify(record);
  }

  async verify(record: WorktreeRecord): Promise<WorktreeRecord> {
    const parsed = await listGitWorktrees(record.repositoryPath);
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

    return {
      ...record,
      status: statusForParsedWorktree(match),
      headSha: match.headSha,
      error: undefined,
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString()
    };
  }
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

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}
