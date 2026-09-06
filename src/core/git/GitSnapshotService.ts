import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitSnapshotRecord, GitStatus, WorktreeRecord } from '../../shared/contracts';
import { resolveAgentGitMetadata } from './AgentGitMetadata';
import { git } from './gitCli';

interface ParsedStatus {
  headSha?: string;
  branch?: string;
  upstreamRef?: string;
  aheadCount: number;
  behindCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedPaths: string[];
  conflictedCount: number;
}

const GIT_STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '--branch',
  '--untracked-files=all',
  '-z'
] as const;

/**
 * Checks checkout identity and Git state before and after evidence capture.
 * This detects observed changes; it does not lock out external writers.
 */
export async function captureGitObservation(
  worktree: WorktreeRecord,
  repositoryPath: string
): Promise<{
  snapshot: Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>;
  diffEvidence: string;
}> {
  const beforeIdentity = await inspectGitIdentity(worktree, repositoryPath);
  const snapshot = await inspectGitSnapshot(worktree);
  const diffEvidence = await buildDiffEvidence(worktree);
  const after = await inspectGitSnapshot(worktree);
  const afterIdentity = await inspectGitIdentity(worktree, repositoryPath);
  if (
    beforeIdentity !== afterIdentity ||
    snapshot.branch !== worktree.branchName ||
    after.branch !== worktree.branchName ||
    JSON.stringify(snapshot) !== JSON.stringify(after)
  ) {
    throw new Error('Git changed during observation. Refresh to capture the current checkout.');
  }
  return { snapshot, diffEvidence };
}

async function inspectGitIdentity(worktree: WorktreeRecord, repositoryPath: string): Promise<string> {
  const metadata = await resolveAgentGitMetadata({
    repositoryPath,
    worktreePath: worktree.worktreePath,
    expectedBranch: worktree.branchName
  });
  const directories = await Promise.all(
    [metadata.repositoryRoot, metadata.worktreeRoot, metadata.gitDir, metadata.gitCommonDir]
      .map(async (directory) => {
        const stat = await fs.stat(directory);
        return [directory, stat.dev, stat.ino];
      })
  );
  return JSON.stringify(directories);
}

function readGit(cwd: string, argv: string[]): Promise<string> {
  const args = argv[0] === 'diff'
    ? ['diff', '--no-ext-diff', '--no-textconv', ...argv.slice(1)]
    : argv;
  return git(cwd, ['-c', 'core.fsmonitor=false', ...args], {
    env: { GIT_OPTIONAL_LOCKS: '0' }
  });
}

export async function inspectGitSnapshot(worktree: WorktreeRecord): Promise<Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>> {
  const [
    repoRoot,
    gitCommonDir,
    statusOutput,
    headSha,
    branch,
    committedDiffNames,
    workingDiffNames,
    diffStat,
    dirtyFingerprint,
    commitsAheadOfBase
  ] = await Promise.all([
    readGit(worktree.worktreePath, ['rev-parse', '--show-toplevel']),
    readGit(worktree.worktreePath, ['rev-parse', '--git-common-dir']),
    readGit(worktree.worktreePath, [...GIT_STATUS_ARGS]),
    readGit(worktree.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    readGit(worktree.worktreePath, ['branch', '--show-current']),
    readGit(worktree.worktreePath, ['diff', '--name-only', `${worktree.baseSha}..HEAD`]),
    readGit(worktree.worktreePath, ['diff', '--name-only']),
    buildDiffStat(worktree),
    inspectGitWorkingTreeFingerprint(worktree.worktreePath),
    readGit(worktree.worktreePath, ['rev-list', '--count', `${worktree.baseSha}..HEAD`])
      .then((value) => Number(value.trim()))
  ]);

  const parsedStatus = parseGitStatusPorcelain(statusOutput);
  if (
    parsedStatus.headSha !== headSha.trim() ||
    parsedStatus.branch !== (branch.trim() || '(detached)') ||
    (worktree.ownership === 'EXTERNAL' && branch.trim() !== worktree.branchName)
  ) {
    throw new Error('Git branch or HEAD changed during observation. Refresh the expected branch.');
  }
  // Git retains branch.upstream after pruning a remote-tracking branch. Ask
  // Git for its full ref before resolving it; a present but broken ref still
  // fails observation rather than being mistaken for an absent upstream.
  const upstreamRef = parsedStatus.upstreamRef
    ? (await readGit(worktree.worktreePath, [
        'for-each-ref', '--format=%(upstream)', `refs/heads/${branch.trim()}`
      ])).trim()
    : '';
  const upstreamExists = upstreamRef
    ? await readGit(worktree.worktreePath, ['show-ref', '--verify', '--quiet', upstreamRef])
        .then(() => true, (error: unknown) => {
          if ((error as { code?: unknown }).code === 1) return false;
          throw error;
        })
    : false;
  const upstreamSha = upstreamExists
    ? (await readGit(worktree.worktreePath, ['rev-parse', '--verify', `${upstreamRef}^{commit}`])).trim()
    : undefined;
  const committedDiffFileCount = countLines(committedDiffNames);
  const workingDiffFileCount = new Set([
    ...workingDiffNames.split('\n').filter(Boolean),
    ...parsedStatus.untrackedPaths
  ]).size;

  return {
    taskId: worktree.taskId,
    iterationId: worktree.iterationId,
    worktreeId: worktree.id,
    worktreePath: worktree.worktreePath,
    repoRoot: repoRoot.trim(),
    gitCommonDir: path.resolve(worktree.worktreePath, gitCommonDir.trim()),
    headSha: headSha.trim() || parsedStatus.headSha,
    branch: branch.trim() || parsedStatus.branch,
    baseRef: worktree.baseRef,
    baseSha: worktree.baseSha,
    upstreamRef: parsedStatus.upstreamRef,
    upstreamSha,
    aheadCount: parsedStatus.aheadCount,
    behindCount: parsedStatus.behindCount,
    stagedCount: parsedStatus.stagedCount,
    unstagedCount: parsedStatus.unstagedCount,
    untrackedCount: parsedStatus.untrackedPaths.length,
    conflictedCount: parsedStatus.conflictedCount,
    operationInProgress: await detectOperationInProgress(worktree.worktreePath),
    commitsAheadOfBase,
    committedDiffFileCount,
    workingDiffFileCount,
    diffStat,
    dirtyFingerprint,
    status: deriveGitStatus({
      ...parsedStatus,
      committedDiffFileCount,
      commitsAheadOfBase
    })
  };
}

export async function buildDiffEvidence(worktree: WorktreeRecord): Promise<string> {
  const [committed, staged, unstaged, untracked, stat] = await Promise.all([
    readGit(worktree.worktreePath, ['diff', `${worktree.baseSha}..HEAD`]),
    readGit(worktree.worktreePath, ['diff', '--cached']),
    readGit(worktree.worktreePath, ['diff']),
    buildUntrackedDiff(worktree.worktreePath),
    buildDiffStat(worktree)
  ]);
  const unstagedAndUntracked = [unstaged.trim(), untracked.trim()].filter(Boolean).join('\n');

  return [
    '# Git diff evidence',
    '',
    `Worktree: ${worktree.worktreePath}`,
    `Branch: ${worktree.branchName}`,
    `Base: ${worktree.baseSha}`,
    '',
    '## Diff stat',
    '',
    stat || 'No diff stat.',
    '',
    '## Committed diff',
    '',
    committed || 'No committed diff.',
    '',
    '## Staged diff',
    '',
    staged || 'No staged diff.',
    '',
    '## Unstaged diff',
    '',
    unstagedAndUntracked || 'No unstaged diff.',
    ''
  ].join('\n');
}

export function parseGitStatusPorcelain(output: string): ParsedStatus {
  const parsed: ParsedStatus = {
    aheadCount: 0,
    behindCount: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedPaths: [],
    conflictedCount: 0
  };

  for (const record of output.split('\0').filter(Boolean)) {
    if (record.startsWith('# branch.oid ')) {
      parsed.headSha = record.slice('# branch.oid '.length).trim();
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      parsed.branch = record.slice('# branch.head '.length).trim();
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      parsed.upstreamRef = record.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(record);
      parsed.aheadCount = match ? Number(match[1]) : 0;
      parsed.behindCount = match ? Number(match[2]) : 0;
      continue;
    }

    if (record.startsWith('? ')) {
      parsed.untrackedPaths.push(record.slice(2));
      continue;
    }

    if (record.startsWith('u ')) {
      parsed.conflictedCount += 1;
      continue;
    }

    if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const xy = record.slice(2, 4);
      if (xy.includes('U')) {
        parsed.conflictedCount += 1;
        continue;
      }
      if (xy[0] && xy[0] !== '.') {
        parsed.stagedCount += 1;
      }
      if (xy[1] && xy[1] !== '.') {
        parsed.unstagedCount += 1;
      }
    }
  }

  return parsed;
}

async function buildDiffStat(worktree: WorktreeRecord): Promise<string> {
  const [committed, working, untracked] = await Promise.all([
    readGit(worktree.worktreePath, ['diff', '--stat', `${worktree.baseSha}..HEAD`]),
    readGit(worktree.worktreePath, ['diff', '--stat']),
    buildUntrackedDiffStat(worktree.worktreePath)
  ]);
  return [committed.trim(), working.trim(), untracked.trim()].filter(Boolean).join('\n');
}

async function buildUntrackedDiff(worktreePath: string): Promise<string> {
  const paths = await getUntrackedPaths(worktreePath);
  const chunks: string[] = [];

  for (const relativePath of paths) {
    const diff = await gitDiffAllowingChanges(worktreePath, [
      'diff',
      '--no-index',
      '--',
      '/dev/null',
      relativePath
    ]);
    const normalizedDiff = hasDiffFileHeader(diff)
      ? diff.trimEnd()
      : syntheticAddedFileDiff(relativePath);
    chunks.push(normalizedDiff);
  }

  return chunks.join('\n');
}

function hasDiffFileHeader(diff: string): boolean {
  return /^diff --git /m.test(diff);
}

function syntheticAddedFileDiff(relativePath: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${relativePath}`
  ].join('\n');
}

async function buildUntrackedDiffStat(worktreePath: string): Promise<string> {
  const paths = await getUntrackedPaths(worktreePath);
  const chunks: string[] = [];

  for (const relativePath of paths) {
    const stat = await gitDiffAllowingChanges(worktreePath, [
      'diff',
      '--no-index',
      '--stat',
      '--',
      '/dev/null',
      relativePath
    ]);
    if (stat.trim()) {
      chunks.push(stat.trimEnd());
    }
  }

  return chunks.join('\n');
}

async function getUntrackedPaths(worktreePath: string): Promise<string[]> {
  const statusOutput = await readGit(worktreePath, [...GIT_STATUS_ARGS]);
  return parseGitStatusPorcelain(statusOutput).untrackedPaths.sort();
}

async function gitDiffAllowingChanges(cwd: string, argv: string[]): Promise<string> {
  try {
    return await readGit(cwd, argv);
  } catch (error) {
    const gitError = error as { code?: unknown; stdout?: unknown };
    // --no-index also exits 1 for an unreadable path, with no diff output.
    if (gitError.code === 1 && typeof gitError.stdout === 'string' && gitError.stdout.length > 0) {
      return gitError.stdout;
    }
    throw error;
  }
}

/**
 * Captures live Git content for evidence and discourse context. Required reads
 * fail closed, and observation never runs configured diff/textconv helpers.
 */
export async function inspectGitWorkingTreeFingerprint(worktreePath: string): Promise<string> {
  const [statusOutput, unstaged, staged] = await Promise.all([
    readGit(worktreePath, [...GIT_STATUS_ARGS]),
    readGit(worktreePath, ['diff', '--binary']),
    readGit(worktreePath, ['diff', '--cached', '--binary'])
  ]);
  return hashDirtyFingerprint(worktreePath, statusOutput, unstaged, staged);
}

async function hashDirtyFingerprint(
  worktreePath: string,
  statusOutput: string,
  unstaged: string,
  staged: string
): Promise<string> {
  const parsed = parseGitStatusPorcelain(statusOutput);
  const hash = createHash('sha256');
  hash.update(statusOutput);
  hash.update('\0unstaged\0');
  hash.update(unstaged);
  hash.update('\0staged\0');
  hash.update(staged);

  for (const relativePath of parsed.untrackedPaths.sort()) {
    const absolutePath = path.resolve(worktreePath, relativePath);
    const relative = path.relative(path.resolve(worktreePath), absolutePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Untracked Git path escaped the worktree.');
    }
    const stat = await fs.lstat(absolutePath);
    hash.update('\0untracked\0');
    hash.update(relativePath);
    if (stat.isSymbolicLink()) {
      hash.update('\0mode:120000\0');
      hash.update(await fs.readlink(absolutePath));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Cannot fingerprint untracked Git entry: ${relativePath}`);
    }
    const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`Cannot fingerprint untracked Git entry: ${relativePath}`);
      // Git records file type and the owner's executable bit, not all permissions.
      hash.update(before.mode & 0o100 ? '\0mode:100755\0' : '\0mode:100644\0');
      // Bound the stream to the observed size even when an external process appends.
      if (before.size > 0) {
        for await (const chunk of handle.createReadStream({ autoClose: false, end: before.size - 1 })) {
          hash.update(chunk);
        }
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('Untracked file changed during observation. Refresh to capture its current content.');
      }
    } finally {
      await handle.close();
    }
  }

  return hash.digest('hex');
}

async function detectOperationInProgress(worktreePath: string): Promise<string | undefined> {
  const gitDir = (await readGit(worktreePath, ['rev-parse', '--git-dir'])).trim();
  const markers: Array<[string, string]> = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect']
  ];

  for (const [marker, label] of markers) {
    try {
      await fs.access(path.resolve(worktreePath, gitDir, marker));
      return label;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return undefined;
}

function deriveGitStatus(input: ParsedStatus & { committedDiffFileCount: number; commitsAheadOfBase: number }): GitStatus {
  if (input.conflictedCount > 0) {
    return 'CONFLICTED';
  }
  if (input.aheadCount > 0 && input.behindCount > 0) {
    return 'DIVERGED';
  }
  if (input.stagedCount > 0 || input.unstagedCount > 0 || input.untrackedPaths.length > 0) {
    return 'DIRTY';
  }
  if (input.aheadCount > 0 || input.commitsAheadOfBase > 0) {
    return input.upstreamRef && input.aheadCount === 0 ? 'PUSHED' : 'COMMITTED_UNPUSHED';
  }
  return 'CLEAN';
}

function countLines(value: string): number {
  return value.split('\n').filter(Boolean).length;
}
