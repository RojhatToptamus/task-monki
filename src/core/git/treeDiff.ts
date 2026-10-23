import { git, isGitObjectId } from './gitCli';

const GIT_TIMEOUT_MS = 120_000;
/** A diff larger than this is not shown; the worktree's full capture still is. */
const TREE_DIFF_MAX_BYTES = 8 * 1024 * 1024;

/**
 * One unified diff between two trees or commits, named by object id, bounded.
 * Paths are written as they are, so a file name in any script reads the same in
 * the diff and in its index. `env` lets a private object store lend the objects
 * it holds.
 */
export async function boundedTreeDiff(
  cwd: string,
  from: string,
  to: string,
  env?: NodeJS.ProcessEnv
): Promise<string | { reason: 'TOO_LARGE' | 'UNREADABLE' }> {
  // Git reads an option anywhere among the revisions, so only object ids reach it.
  if (!isGitObjectId(from) || !isGitObjectId(to)) return { reason: 'UNREADABLE' };
  try {
    const diff = await git(
      cwd,
      ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-p', '-M', '-U3', '--no-color', '--no-ext-diff', from, to],
      { timeout: GIT_TIMEOUT_MS, env }
    );
    return Buffer.byteLength(diff) > TREE_DIFF_MAX_BYTES ? { reason: 'TOO_LARGE' } : diff;
  } catch (error) {
    // Objects the repository has since pruned, or output past the buffer.
    return { reason: /maxBuffer/i.test(String(error)) ? 'TOO_LARGE' : 'UNREADABLE' };
  }
}
