import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitSnapshotRecord, GitStatus, WorktreeRecord } from '../../shared/contracts';
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

export async function inspectGitSnapshot(worktree: WorktreeRecord): Promise<Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>> {
  const [
    repoRoot,
    gitCommonDir,
    statusOutput,
    headSha,
    branch,
    upstreamSha,
    committedDiffNames,
    workingDiffNames,
    diffStat,
    dirtyFingerprint,
    commitsAheadOfBase
  ] = await Promise.all([
    git(worktree.worktreePath, ['rev-parse', '--show-toplevel']),
    git(worktree.worktreePath, ['rev-parse', '--git-common-dir']),
    git(worktree.worktreePath, ['status', '--porcelain=v2', '--branch', '-z']),
    git(worktree.worktreePath, ['rev-parse', 'HEAD']).catch(() => ''),
    git(worktree.worktreePath, ['branch', '--show-current']).catch(() => ''),
    git(worktree.worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
      .then((ref) => git(worktree.worktreePath, ['rev-parse', ref.trim()]))
      .catch(() => ''),
    git(worktree.worktreePath, ['diff', '--name-only', `${worktree.baseSha}..HEAD`]).catch(() => ''),
    git(worktree.worktreePath, ['diff', '--name-only']).catch(() => ''),
    buildDiffStat(worktree),
    computeDirtyFingerprint(worktree.worktreePath),
    git(worktree.worktreePath, ['rev-list', '--count', `${worktree.baseSha}..HEAD`])
      .then((value) => Number(value.trim()) || 0)
      .catch(() => 0)
  ]);

  const parsedStatus = parseGitStatusPorcelain(statusOutput);
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
    upstreamSha: upstreamSha.trim() || undefined,
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
  const [committed, staged, unstaged, stat] = await Promise.all([
    git(worktree.worktreePath, ['diff', `${worktree.baseSha}..HEAD`]).catch((error) =>
      formatGitError('Committed diff', error)
    ),
    git(worktree.worktreePath, ['diff', '--cached']).catch((error) =>
      formatGitError('Staged diff', error)
    ),
    git(worktree.worktreePath, ['diff']).catch((error) => formatGitError('Unstaged diff', error)),
    buildDiffStat(worktree)
  ]);

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
    unstaged || 'No unstaged diff.',
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
  const [committed, working] = await Promise.all([
    git(worktree.worktreePath, ['diff', '--stat', `${worktree.baseSha}..HEAD`]).catch(() => ''),
    git(worktree.worktreePath, ['diff', '--stat']).catch(() => '')
  ]);
  return [committed.trim(), working.trim()].filter(Boolean).join('\n');
}

async function computeDirtyFingerprint(worktreePath: string): Promise<string> {
  const [statusOutput, unstaged, staged] = await Promise.all([
    git(worktreePath, ['status', '--porcelain=v2', '--branch', '-z']).catch(() => ''),
    git(worktreePath, ['diff', '--binary']).catch(() => ''),
    git(worktreePath, ['diff', '--cached', '--binary']).catch(() => '')
  ]);
  const parsed = parseGitStatusPorcelain(statusOutput);
  const hash = createHash('sha256');
  hash.update(statusOutput);
  hash.update('\0unstaged\0');
  hash.update(unstaged);
  hash.update('\0staged\0');
  hash.update(staged);

  for (const relativePath of parsed.untrackedPaths.sort()) {
    const absolutePath = path.resolve(worktreePath, relativePath);
    if (!absolutePath.startsWith(path.resolve(worktreePath))) {
      continue;
    }
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.isFile() && stat.size <= 1024 * 1024) {
        hash.update('\0untracked\0');
        hash.update(relativePath);
        hash.update(await fs.readFile(absolutePath));
      } else {
        hash.update(`\0untracked-meta\0${relativePath}:${stat.size}:${stat.mtimeMs}`);
      }
    } catch {
      hash.update(`\0untracked-missing\0${relativePath}`);
    }
  }

  return hash.digest('hex');
}

async function detectOperationInProgress(worktreePath: string): Promise<string | undefined> {
  const gitDir = (await git(worktreePath, ['rev-parse', '--git-dir'])).trim();
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
    } catch {
      // continue
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

function formatGitError(label: string, error: unknown): string {
  return `## ${label} unavailable\n\n${error instanceof Error ? error.message : String(error)}`;
}
