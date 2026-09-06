import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  InspectWorktreeImportRequest,
  Task,
  TaskSnapshot,
  WorktreeComparison
} from '../../shared/contracts';
import { resolveAgentGitMetadata } from '../git/AgentGitMetadata';
import { git } from '../git/gitCli';
import type { WorktreeSpec } from './WorktreeService';

export async function inspectExistingCheckout(
  repositoryPath: string,
  input: InspectWorktreeImportRequest
): Promise<WorktreeSpec & { gitCommonDir: string; headSha: string; baseRef: string }> {
  if (typeof input.branchName !== 'string' || !input.branchName.trim()) {
    throw new Error('Select a checkout on a named branch.');
  }
  const metadata = await resolveAgentGitMetadata({
    repositoryPath,
    worktreePath: input.worktreePath,
    expectedBranch: input.branchName
  });
  const headSha = (await git(metadata.worktreeRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const base = await resolveWorktreeComparison(metadata.worktreeRoot, input.comparison);
  await resolveAgentGitMetadata({
    repositoryPath,
    worktreePath: metadata.worktreeRoot,
    expectedBranch: input.branchName
  });
  return {
    worktreePath: metadata.worktreeRoot,
    branchName: input.branchName,
    gitCommonDir: metadata.gitCommonDir,
    headSha,
    ...base
  };
}

export async function resolveWorktreeComparison(
  worktreePath: string,
  comparison: WorktreeComparison
): Promise<{ baseRef: string; baseSha: string }> {
  if (
    !comparison ||
    !['MERGE_BASE', 'COMMIT'].includes(comparison.type) ||
    typeof comparison.ref !== 'string' ||
    !comparison.ref.trim() ||
    comparison.ref.length > 1024
  ) {
    throw new Error('Select a comparison branch or commit.');
  }
  const baseRef = comparison.ref.trim();
  const commit = (await git(worktreePath, [
    'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`
  ])).trim();
  const baseSha = comparison.type === 'COMMIT'
    ? commit
    : (await git(worktreePath, ['merge-base', commit, 'HEAD'])).trim();
  if (!baseSha) throw new Error('The selected comparison has no common commit with this checkout.');
  return { baseRef: comparison.type === 'COMMIT' ? commit : baseRef, baseSha };
}

/** Remote URL equality is deliberately not repository identity. */
export async function findExistingWorktreeTask(
  state: Pick<TaskSnapshot, 'repositories' | 'worktrees' | 'tasks' | 'gitSnapshots'>,
  input: { worktreePath: string; gitCommonDir: string; branchName: string; repositoryId: string },
  excludeTaskId?: string
): Promise<Task | undefined> {
  const expectedPath = await canonicalPath(input.worktreePath);
  const commonDirectories = new Map<string, string | undefined>();
  for (const worktree of state.worktrees) {
    if (worktree.taskId === excludeTaskId) continue;
    const task = state.tasks.find((candidate) => candidate.id === worktree.taskId);
    if (!task) continue;
    if (samePath(await canonicalPath(worktree.worktreePath), expectedPath)) return task;
    if (worktree.branchName !== input.branchName) continue;
    if (worktree.repositoryId === input.repositoryId) return task;
    if (!commonDirectories.has(worktree.repositoryId)) {
      const repository = state.repositories.find((candidate) => candidate.id === worktree.repositoryId);
      const observed = repository && await git(repository.path, ['rev-parse', '--git-common-dir'])
        .then((value) => canonicalPath(path.resolve(repository.path, value.trim())))
        .catch(() => undefined);
      // A disconnected repository retains its last observed physical identity.
      const historical = state.gitSnapshots.find((snapshot) => snapshot.worktreeId === worktree.id)?.gitCommonDir;
      commonDirectories.set(worktree.repositoryId, observed ?? (historical && await canonicalPath(historical)));
    }
    const commonDirectory = commonDirectories.get(worktree.repositoryId);
    if (commonDirectory && samePath(commonDirectory, input.gitCommonDir)) return task;
  }
  return undefined;
}

async function canonicalPath(candidate: string): Promise<string> {
  return fs.realpath(candidate).catch(() => path.resolve(candidate));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
