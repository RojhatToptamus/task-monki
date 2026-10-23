import type { TaskCommit, TaskCommitDiffResult } from '../../shared/taskCommits';
import { git, isGitObjectId } from './gitCli';
import { boundedTreeDiff } from './treeDiff';

const GIT_TIMEOUT_MS = 120_000;
/** A capture lists at most this many commits: its latest, oldest first. */
const TASK_COMMIT_LIMIT = 100;
const BODY_LIMIT = 4_000;
const FIELD = '\u0000';
const RECORD = '\u001e';

/**
 * The branch's own commits from `base` to `head`, oldest first: first parents
 * only, so a merge of the base branch is one commit and the base branch's own
 * history stays out. At most `limit` of the latest are listed; `total` counts
 * them all.
 */
export async function listTaskCommits(
  worktreePath: string,
  base: string,
  head: string,
  limit = TASK_COMMIT_LIMIT
): Promise<{ commits: TaskCommit[]; total: number }> {
  const range = commitRange(base, head);
  const [count, log] = await Promise.all([
    git(worktreePath, ['rev-list', '--first-parent', '--count', range, '--'], GIT_TIMEOUT_MS),
    // --reverse orders what --max-count chose: the latest commits, oldest first. A signature check
    // the person's configuration asks for would print into the records.
    git(worktreePath, ['log', '--first-parent', `--max-count=${limit}`, '--reverse', '--no-color', '--no-show-signature',
      '--format=%H%x00%an%x00%aI%x00%s%x00%b%x1e', range, '--'], GIT_TIMEOUT_MS)
  ]);
  const commits = log.split(RECORD).flatMap((record): TaskCommit[] => {
    const [sha, author, authoredAt, subject, body] = record.replace(/^\n/u, '').split(FIELD);
    if (!sha || !isGitObjectId(sha)) return [];
    const text = body?.trim();
    return [{
      sha,
      subject: subject ?? '',
      ...(text ? { body: text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text } : {}),
      author: author ?? '',
      authoredAt: authoredAt ?? ''
    }];
  });
  return { commits, total: Math.max(Number(count.trim()) || 0, commits.length) };
}

/** Whether `sha` is one of the branch's own commits from `base` to `head`. */
export async function isTaskCommit(worktreePath: string, base: string, head: string, sha: string): Promise<boolean> {
  if (!isGitObjectId(sha)) return false;
  const listed = await git(worktreePath, ['rev-list', '--first-parent', commitRange(base, head), '--'], GIT_TIMEOUT_MS);
  return listed.split('\n').includes(sha);
}

/** One commit's change against its first parent; a commit with none is compared against the empty tree. */
export async function readTaskCommitDiff(worktreePath: string, sha: string): Promise<TaskCommitDiffResult> {
  if (!isGitObjectId(sha)) return { status: 'UNAVAILABLE', reason: 'UNREADABLE' };
  try {
    // Its parents as Git lists them: a root commit has none, while a lookup that fails is unreadable, not a root.
    const [, parent] = (await git(worktreePath, ['rev-list', '--parents', '-n', '1', '--end-of-options', sha])).trim().split(' ');
    const from = parent ?? (await git(worktreePath, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '' })).trim();
    const diff = await boundedTreeDiff(worktreePath, from, sha);
    return typeof diff === 'string' ? { status: 'READY', sha, diff } : { status: 'UNAVAILABLE', reason: diff.reason };
  } catch {
    return { status: 'UNAVAILABLE', reason: 'UNREADABLE' };
  }
}

function commitRange(base: string, head: string): string {
  if (!isGitObjectId(base) || !isGitObjectId(head)) throw new Error('A capture names its base and head by object id.');
  return `${base}..${head}`;
}
