import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DesignSourceCheckpoint,
  Repository,
  WorktreeRecord
} from '../../shared/contracts';
import { isTaskCreationToken } from '../../shared/contracts';
import type { ManagedDesignRepositoryInput } from '../storage/FileTaskStore';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../filesystem/secureFilesystem';
import { git, type GitExecutionOptions } from '../git/gitCli';
import { listGitWorktrees } from '../worktree/WorktreeService';

export const DESIGN_REPOSITORY_MARKER = '.task-monki-design-repository.json';
const MARKER_SCHEMA_VERSION = 1 as const;
const INITIAL_BRANCH = 'main';
const INITIAL_COMMIT_MESSAGE = 'Initialize Task Monki Design source';
const INITIAL_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>New Design</title>
</head>
<body>
  <main>
    <h1>New Design</h1>
    <p>Replace this minimal shell with the requested experience.</p>
  </main>
</body>
</html>
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_MARKER_BYTES = 64 * 1024;

interface DesignRepositoryMarker {
  schemaVersion: typeof MARKER_SCHEMA_VERSION;
  repositoryId: string;
  creationToken: string;
  state: 'STAGING' | 'READY';
  initialCommitSha?: string;
  createdAt: string;
}

export interface DesignSourceServiceOptions {
  repositoryRoot: string;
  worktreeRoot: string;
}

export interface DesignSourceOwnership {
  designId: string;
  repository: Repository;
  worktree: WorktreeRecord;
  turnId: string;
  runId: string;
}

export interface CaptureDesignCandidateInput extends DesignSourceOwnership {
  expectedParentCommit: string;
}

export type DesignCandidateCapture =
  | {
      kind: 'NO_CHANGE';
      commitSha: string;
      treeSha: string;
    }
  | {
      kind: 'CAPTURED';
      checkpoint: DesignSourceCheckpoint;
    };

export interface PublishDesignCandidateInput extends DesignSourceOwnership {
  checkpoint: DesignSourceCheckpoint;
}

export interface PublishedDesignCandidateCheckpoint
  extends DesignSourceCheckpoint {
  candidateCommitSha: string;
}

export type DesignCandidateRecovery =
  | { state: 'PARENT' }
  | {
      state: 'CANDIDATE_REF';
      checkpoint: PublishedDesignCandidateCheckpoint;
    };

export interface DesignRepositoryReconciliation {
  removedRepositoryIds: string[];
  retainedPaths: string[];
}

/**
 * Owns only Task Monki-managed Design Git sources. Git remains the source of
 * ready bytes; the service does not mirror files or revision history.
 */
export class DesignSourceService {
  private readonly repositoryRoot: string;
  private readonly worktreeRoot: string;

  constructor(options: DesignSourceServiceOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.worktreeRoot = path.resolve(options.worktreeRoot);
    if (samePath(this.repositoryRoot, this.worktreeRoot)) {
      throw new Error('Design repository and worktree roots must be distinct.');
    }
  }

  async prepareBlankRepository(input: {
    creationToken: string;
  }): Promise<ManagedDesignRepositoryInput> {
    if (!isTaskCreationToken(input.creationToken)) {
      throw new Error('Managed Design creation token is invalid.');
    }
    await this.ensureRoots();
    const existing = await this.findRepositoryByCreationToken(input.creationToken);
    if (existing) return this.completeStagingRepository(existing.path, existing.marker);

    const repositoryId = randomUUID();
    const repositoryPath = this.expectedRepositoryPath(repositoryId);
    await fs.mkdir(repositoryPath, { mode: 0o700 });
    await enforcePosixMode(repositoryPath, 0o700);
    const marker: DesignRepositoryMarker = {
      schemaVersion: MARKER_SCHEMA_VERSION,
      repositoryId,
      creationToken: input.creationToken,
      state: 'STAGING',
      createdAt: new Date().toISOString()
    };
    await writeMarker(repositoryPath, marker);
    return this.completeStagingRepository(repositoryPath, marker);
  }

  async captureCandidate(
    input: CaptureDesignCandidateInput
  ): Promise<DesignCandidateCapture> {
    await this.assertSourceOwnership(input, input.expectedParentCommit);
    const firstTree = await this.captureWorktreeTree(
      input.worktree.worktreePath,
      input.expectedParentCommit
    );
    await this.assertSourceOwnership(input, input.expectedParentCommit);
    const secondTree = await this.captureWorktreeTree(
      input.worktree.worktreePath,
      input.expectedParentCommit
    );
    await this.assertSourceOwnership(input, input.expectedParentCommit);
    if (firstTree !== secondTree) {
      throw new Error('Design source changed during immutable capture.');
    }
    const parentTree = cleanGitOutput(
      await managedGit(input.repository.path, [
        'rev-parse',
        '--verify',
        `${input.expectedParentCommit}^{tree}`
      ])
    );
    if (firstTree === parentTree) {
      return {
        kind: 'NO_CHANGE',
        commitSha: input.expectedParentCommit,
        treeSha: firstTree
      };
    }
    return {
      kind: 'CAPTURED',
      checkpoint: {
        repositoryId: input.repository.id,
        worktreeId: input.worktree.id,
        branchName: input.worktree.branchName,
        expectedParentCommit: input.expectedParentCommit,
        treeSha: firstTree
      }
    };
  }

  async publishCandidateCommit(
    input: PublishDesignCandidateInput
  ): Promise<PublishedDesignCandidateCheckpoint> {
    await this.assertCheckpointOwnership(input);
    const recovered = await this.recoverCandidate(input);
    if (recovered.state === 'CANDIDATE_REF') return recovered.checkpoint;

    const recoverableCommit = await this.findRecoverableCandidateCommit(input);
    if (recoverableCommit) {
      await managedGit(input.repository.path, [
        'update-ref',
        `refs/heads/${input.checkpoint.branchName}`,
        recoverableCommit,
        input.checkpoint.expectedParentCommit
      ]);
      await this.assertCandidateCommit(input, recoverableCommit);
      return { ...input.checkpoint, candidateCommitSha: recoverableCommit };
    }

    const message = candidateCommitMessage(input);
    const candidateCommitSha = cleanGitOutput(
      await managedGit(
        input.repository.path,
        [
          'commit-tree',
          input.checkpoint.treeSha,
          '-p',
          input.checkpoint.expectedParentCommit
        ],
        {
          stdin: `${message}\n`,
          env: {
            GIT_AUTHOR_NAME: 'Task Monki',
            GIT_AUTHOR_EMAIL: 'task-monki@localhost',
            GIT_COMMITTER_NAME: 'Task Monki',
            GIT_COMMITTER_EMAIL: 'task-monki@localhost'
          }
        }
      )
    );
    assertGitObjectId(candidateCommitSha, 'candidate commit');
    await this.assertCandidateCommit(input, candidateCommitSha);
    await managedGit(input.repository.path, [
      'update-ref',
      `refs/heads/${input.checkpoint.branchName}`,
      candidateCommitSha,
      input.checkpoint.expectedParentCommit
    ]);
    await this.assertCandidateCommit(input, candidateCommitSha);
    return { ...input.checkpoint, candidateCommitSha };
  }

  async recoverCandidate(
    input: PublishDesignCandidateInput
  ): Promise<DesignCandidateRecovery> {
    await this.assertCheckpointOwnership(input);
    const currentCommit = await this.readBranchCommit(
      input.repository.path,
      input.checkpoint.branchName
    );
    if (currentCommit === input.checkpoint.expectedParentCommit) {
      return { state: 'PARENT' };
    }
    if (
      input.checkpoint.candidateCommitSha &&
      currentCommit !== input.checkpoint.candidateCommitSha
    ) {
      throw new Error('Design candidate branch no longer matches its checkpoint.');
    }
    await this.assertCandidateCommit(input, currentCommit);
    return {
      state: 'CANDIDATE_REF',
      checkpoint: { ...input.checkpoint, candidateCommitSha: currentCommit }
    };
  }

  async repairCandidateIndex(
    input: DesignSourceOwnership & {
      checkpoint: PublishedDesignCandidateCheckpoint;
    }
  ): Promise<void> {
    await this.assertCheckpointOwnership(input);
    const currentCommit = await this.readBranchCommit(
      input.repository.path,
      input.checkpoint.branchName
    );
    if (currentCommit !== input.checkpoint.candidateCommitSha) {
      throw new Error('Design candidate branch changed before index repair.');
    }
    await this.assertCandidateCommit(input, currentCommit);
    await managedGit(input.worktree.worktreePath, [
      'read-tree',
      `${input.checkpoint.candidateCommitSha}^{tree}`
    ]);
    const indexTree = cleanGitOutput(
      await managedGit(input.worktree.worktreePath, ['write-tree'])
    );
    if (indexTree !== input.checkpoint.treeSha) {
      throw new Error('Design worktree index repair did not select the candidate tree.');
    }
  }

  async removeManagedRepository(repository: Repository): Promise<void> {
    if (repository.kind !== 'DESIGN_MANAGED') {
      throw new Error('Task Monki never removes a registered repository.');
    }
    await this.ensureRoots();
    const repositoryPath = this.expectedRepositoryPath(repository.id);
    if (!samePath(repositoryPath, path.resolve(repository.path))) {
      throw new Error('Managed Design repository is outside its owned root.');
    }
    const stat = await fs.lstat(repositoryPath).catch(missingAsUndefined);
    if (!stat) return;
    await assertPrivateOwnedDirectory(repositoryPath, stat);
    const marker = await readMarker(repositoryPath);
    if (!marker || marker.repositoryId !== repository.id) {
      throw new Error('Managed Design repository marker does not match its record.');
    }
    await assertNoLinkedWorktrees(repositoryPath, marker.state);
    await fs.rm(repositoryPath, { recursive: true });
    await syncDirectoryIfSupported(this.repositoryRoot);
  }

  async reconcileOrphanedRepositories(
    referencedRepositories: readonly Pick<Repository, 'id' | 'kind' | 'path'>[]
  ): Promise<DesignRepositoryReconciliation> {
    await this.ensureRoots();
    const referenced = new Map(
      referencedRepositories
        .filter((repository) => repository.kind === 'DESIGN_MANAGED')
        .map((repository) => [repository.id, path.resolve(repository.path)])
    );
    const removedRepositoryIds: string[] = [];
    const retainedPaths: string[] = [];
    for (const entry of await fs.readdir(this.repositoryRoot, { withFileTypes: true })) {
      const repositoryPath = path.join(this.repositoryRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        retainedPaths.push(repositoryPath);
        continue;
      }
      const marker = await readMarker(repositoryPath).catch(() => undefined);
      if (!marker || !samePath(repositoryPath, this.expectedRepositoryPath(marker.repositoryId))) {
        retainedPaths.push(repositoryPath);
        continue;
      }
      if (samePath(referenced.get(marker.repositoryId) ?? '', repositoryPath)) continue;
      try {
        await assertNoLinkedWorktrees(repositoryPath, marker.state);
        await fs.rm(repositoryPath, { recursive: true });
        removedRepositoryIds.push(marker.repositoryId);
      } catch {
        retainedPaths.push(repositoryPath);
      }
    }
    if (removedRepositoryIds.length > 0) {
      await syncDirectoryIfSupported(this.repositoryRoot);
    }
    return { removedRepositoryIds, retainedPaths };
  }

  private async ensureRoots(): Promise<void> {
    await ensurePrivateOwnedRoot(this.repositoryRoot);
    await ensurePrivateOwnedRoot(this.worktreeRoot);
    if (samePath(await fs.realpath(this.repositoryRoot), await fs.realpath(this.worktreeRoot))) {
      throw new Error('Design repository and worktree roots resolve to the same directory.');
    }
  }

  private expectedRepositoryPath(repositoryId: string): string {
    if (!UUID.test(repositoryId)) throw new Error('Managed Design repository id is invalid.');
    return path.join(this.repositoryRoot, repositoryId);
  }

  private async findRepositoryByCreationToken(
    creationToken: string
  ): Promise<{ path: string; marker: DesignRepositoryMarker } | undefined> {
    let match: { path: string; marker: DesignRepositoryMarker } | undefined;
    for (const entry of await fs.readdir(this.repositoryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const repositoryPath = path.join(this.repositoryRoot, entry.name);
      const marker = await readMarker(repositoryPath).catch(() => undefined);
      if (!marker || marker.creationToken !== creationToken) continue;
      if (match) throw new Error('Multiple managed Design repositories use one creation token.');
      if (!samePath(repositoryPath, this.expectedRepositoryPath(marker.repositoryId))) {
        throw new Error('Managed Design repository marker escaped its owned path.');
      }
      match = { path: repositoryPath, marker };
    }
    return match;
  }

  private async completeStagingRepository(
    repositoryPath: string,
    marker: DesignRepositoryMarker
  ): Promise<ManagedDesignRepositoryInput> {
    await assertPrivateOwnedDirectory(repositoryPath, await fs.lstat(repositoryPath));
    if (marker.state === 'READY') {
      await verifyInitialRepository(repositoryPath, marker);
      return repositoryInput(repositoryPath, marker);
    }

    const allowed = new Set(['.git', DESIGN_REPOSITORY_MARKER, 'index.html']);
    const entries = await fs.readdir(repositoryPath);
    if (entries.some((entry) => !allowed.has(entry))) {
      throw new Error('Staging Design repository contains unexpected files.');
    }
    if (!(await exists(path.join(repositoryPath, '.git')))) {
      await managedGit(repositoryPath, ['init', '--initial-branch', INITIAL_BRANCH]);
    }
    await managedGit(repositoryPath, ['config', 'user.name', 'Task Monki']);
    await managedGit(repositoryPath, ['config', 'user.email', 'task-monki@localhost']);
    await ensureMarkerExcluded(repositoryPath);
    const indexPath = path.join(repositoryPath, 'index.html');
    const existingIndex = await fs.readFile(indexPath, 'utf8').catch(missingAsUndefined);
    if (existingIndex !== undefined && existingIndex !== INITIAL_INDEX_HTML) {
      throw new Error('Staging Design repository initial source changed before registration.');
    }
    if (existingIndex === undefined) {
      await writePrivateFile(indexPath, INITIAL_INDEX_HTML);
    }
    if (!(await gitReferenceExists(repositoryPath, 'HEAD'))) {
      await managedGit(repositoryPath, ['add', '--', 'index.html']);
      await managedGit(repositoryPath, [
        'commit',
        '--no-gpg-sign',
        '-m',
        INITIAL_COMMIT_MESSAGE
      ]);
    }
    const initialCommitSha = cleanGitOutput(
      await managedGit(repositoryPath, ['rev-parse', '--verify', 'HEAD'])
    );
    const ready: DesignRepositoryMarker = {
      ...marker,
      state: 'READY',
      initialCommitSha
    };
    await verifyInitialRepository(repositoryPath, ready);
    await writeMarker(repositoryPath, ready);
    return repositoryInput(repositoryPath, ready);
  }

  private async assertSourceOwnership(
    input: DesignSourceOwnership,
    expectedCommit: string
  ): Promise<void> {
    await this.ensureRoots();
    if (
      input.repository.kind !== 'DESIGN_MANAGED' ||
      input.worktree.taskId !== input.designId ||
      input.worktree.repositoryId !== input.repository.id ||
      !UUID.test(input.designId) ||
      !UUID.test(input.turnId) ||
      !UUID.test(input.runId)
    ) {
      throw new Error('Design source ownership is inconsistent.');
    }
    assertGitObjectId(expectedCommit, 'expected parent');
    const expectedRepositoryPath = this.expectedRepositoryPath(input.repository.id);
    if (!samePath(path.resolve(input.repository.path), expectedRepositoryPath)) {
      throw new Error('Design source repository escaped its managed root.');
    }
    const expectedWorktreePath = path.join(this.worktreeRoot, input.designId);
    if (!samePath(path.resolve(input.worktree.worktreePath), expectedWorktreePath)) {
      throw new Error('Design source worktree escaped its managed root.');
    }
    await assertPrivateOwnedDirectory(
      expectedRepositoryPath,
      await fs.lstat(expectedRepositoryPath)
    );
    await assertPrivateOwnedDirectory(
      expectedWorktreePath,
      await fs.lstat(expectedWorktreePath)
    );
    const marker = await readMarker(expectedRepositoryPath);
    if (
      marker?.state !== 'READY' ||
      marker.repositoryId !== input.repository.id
    ) {
      throw new Error('Design source repository marker is invalid.');
    }
    const worktrees = await listGitWorktrees(expectedRepositoryPath);
    const worktreeRealPath = await fs.realpath(expectedWorktreePath);
    const registered = await Promise.all(
      worktrees.map(async (candidate) => ({
        candidate,
        realPath: await fs.realpath(candidate.path).catch(() => path.resolve(candidate.path))
      }))
    );
    if (!registered.some((candidate) => samePath(candidate.realPath, worktreeRealPath))) {
      throw new Error('Design source worktree is not registered to its repository.');
    }
    const branchRef = cleanGitOutput(
      await managedGit(expectedWorktreePath, ['symbolic-ref', '--quiet', 'HEAD'])
    );
    if (branchRef !== `refs/heads/${input.worktree.branchName}`) {
      throw new Error('Design source worktree is on an unexpected branch.');
    }
    const currentCommit = cleanGitOutput(
      await managedGit(expectedWorktreePath, ['rev-parse', '--verify', 'HEAD'])
    );
    if (currentCommit !== expectedCommit) {
      throw new Error('Design source branch changed from its expected parent.');
    }
  }

  private async assertCheckpointOwnership(
    input: PublishDesignCandidateInput
  ): Promise<void> {
    if (
      input.checkpoint.repositoryId !== input.repository.id ||
      input.checkpoint.worktreeId !== input.worktree.id ||
      input.checkpoint.branchName !== input.worktree.branchName ||
      !GIT_OBJECT_ID.test(input.checkpoint.treeSha)
    ) {
      throw new Error('Design source checkpoint ownership is inconsistent.');
    }
    await this.assertSourceOwnershipForCandidate(input);
  }

  private async assertSourceOwnershipForCandidate(
    input: PublishDesignCandidateInput
  ): Promise<void> {
    const current = await this.readBranchCommit(
      input.repository.path,
      input.checkpoint.branchName
    );
    await this.assertSourceOwnership(input, current);
  }

  private async assertCandidateCommit(
    input: PublishDesignCandidateInput,
    candidateCommitSha: string
  ): Promise<void> {
    if (!(await this.candidateCommitMatches(input, candidateCommitSha))) {
      throw new Error('Design candidate commit does not match its recorded owners.');
    }
  }

  private async findRecoverableCandidateCommit(
    input: PublishDesignCandidateInput
  ): Promise<string | undefined> {
    const output = await managedGit(input.repository.path, [
      'fsck',
      '--full',
      '--unreachable',
      '--no-reflogs',
      '--no-progress'
    ]);
    const candidates = [...output.matchAll(/^(?:dangling|unreachable) commit ([a-f0-9]{40,64})$/gmu)]
      .map((match) => match[1]!)
      .sort();
    for (const candidate of candidates) {
      if (await this.candidateCommitMatches(input, candidate)) return candidate;
    }
    return undefined;
  }

  private async candidateCommitMatches(
    input: PublishDesignCandidateInput,
    candidateCommitSha: string
  ): Promise<boolean> {
    assertGitObjectId(candidateCommitSha, 'candidate commit');
    const parents = cleanGitOutput(
      await managedGit(input.repository.path, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        candidateCommitSha
      ])
    ).split(/\s+/u);
    const treeSha = cleanGitOutput(
      await managedGit(input.repository.path, [
        'rev-parse',
        '--verify',
        `${candidateCommitSha}^{tree}`
      ])
    );
    const message = (
      await managedGit(input.repository.path, [
        'log',
        '-1',
        '--format=%B',
        candidateCommitSha
      ])
    ).trimEnd();
    return !(
      parents.length !== 2 ||
      parents[1] !== input.checkpoint.expectedParentCommit ||
      treeSha !== input.checkpoint.treeSha ||
      message !== candidateCommitMessage(input)
    );
  }

  private async readBranchCommit(repositoryPath: string, branchName: string): Promise<string> {
    if (!branchName || branchName.startsWith('-')) {
      throw new Error('Design branch name is invalid.');
    }
    await managedGit(repositoryPath, [
      'check-ref-format',
      `refs/heads/${branchName}`
    ]);
    const commit = cleanGitOutput(
      await managedGit(repositoryPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${branchName}`
      ])
    );
    assertGitObjectId(commit, 'branch commit');
    return commit;
  }

  private async captureWorktreeTree(
    worktreePath: string,
    expectedParentCommit: string
  ): Promise<string> {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-design-index-')
    );
    await enforcePosixMode(temporaryRoot, 0o700);
    const indexPath = path.join(temporaryRoot, 'index');
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      await managedGit(worktreePath, ['read-tree', expectedParentCommit], { env });
      await managedGit(worktreePath, ['add', '-A', '--', '.'], { env, timeout: 60_000 });
      const treeSha = cleanGitOutput(
        await managedGit(worktreePath, ['write-tree'], { env })
      );
      assertGitObjectId(treeSha, 'captured tree');
      return treeSha;
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function candidateCommitMessage(input: DesignSourceOwnership & {
  checkpoint: DesignSourceCheckpoint;
}): string {
  return [
    'Task Monki Design candidate',
    '',
    `Design: ${input.designId}`,
    `Turn: ${input.turnId}`,
    `Run: ${input.runId}`,
    `Parent: ${input.checkpoint.expectedParentCommit}`,
    `Tree: ${input.checkpoint.treeSha}`
  ].join('\n');
}

async function managedGit(
  cwd: string,
  argv: string[],
  options: GitExecutionOptions = {}
): Promise<string> {
  return git(cwd, argv, {
    ...options,
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      ...options.env
    }
  });
}

async function ensurePrivateOwnedRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
    throw new Error(`Managed Design root failed its ownership check: ${root}`);
  }
  await enforcePosixMode(root, 0o700);
  await assertPrivateOwnedDirectory(root, await fs.lstat(root));
}

async function assertPrivateOwnedDirectory(
  directoryPath: string,
  stat: Awaited<ReturnType<typeof fs.lstat>>
): Promise<void> {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !isOwnedByCurrentUser(stat)
  ) {
    throw new Error(`Managed Design directory failed its ownership check: ${directoryPath}`);
  }
  if (!hasNoGroupOrOtherPosixAccess(stat)) {
    throw new Error(`Managed Design directory is not private: ${directoryPath}`);
  }
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await enforcePosixMode(handle, 0o600);
  } finally {
    await handle.close();
  }
  await syncDirectoryIfSupported(path.dirname(filePath));
}

async function writeMarker(
  repositoryPath: string,
  marker: DesignRepositoryMarker
): Promise<void> {
  const markerPath = path.join(repositoryPath, DESIGN_REPOSITORY_MARKER);
  const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await handle.sync();
    await enforcePosixMode(handle, 0o600);
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, markerPath);
  await syncDirectoryIfSupported(repositoryPath);
}

async function readMarker(
  repositoryPath: string
): Promise<DesignRepositoryMarker | undefined> {
  const markerPath = path.join(repositoryPath, DESIGN_REPOSITORY_MARKER);
  const handle = await fs.open(
    markerPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  ).catch(missingAsUndefined);
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > MAX_MARKER_BYTES ||
      !isOwnedByCurrentUser(stat) ||
      !hasNoGroupOrOtherPosixAccess(stat)
    ) {
      throw new Error('Managed Design repository marker failed its integrity check.');
    }
    const value = JSON.parse(await handle.readFile('utf8')) as Partial<DesignRepositoryMarker>;
    if (
      value.schemaVersion !== MARKER_SCHEMA_VERSION ||
      typeof value.repositoryId !== 'string' ||
      !UUID.test(value.repositoryId) ||
      typeof value.creationToken !== 'string' ||
      !isTaskCreationToken(value.creationToken) ||
      (value.state !== 'STAGING' && value.state !== 'READY') ||
      !isCanonicalTimestamp(value.createdAt) ||
      (value.state === 'READY' &&
        (typeof value.initialCommitSha !== 'string' ||
          !GIT_OBJECT_ID.test(value.initialCommitSha))) ||
      (value.state === 'STAGING' && value.initialCommitSha !== undefined)
    ) {
      throw new Error('Managed Design repository marker is malformed.');
    }
    return value as DesignRepositoryMarker;
  } finally {
    await handle.close();
  }
}

async function ensureMarkerExcluded(repositoryPath: string): Promise<void> {
  const infoPath = path.join(repositoryPath, '.git', 'info');
  await fs.mkdir(infoPath, { recursive: true, mode: 0o700 });
  const excludePath = path.join(infoPath, 'exclude');
  const current = await fs.readFile(excludePath, 'utf8').catch(missingAsUndefined);
  const line = `/${DESIGN_REPOSITORY_MARKER}`;
  if (current?.split(/\r?\n/u).includes(line)) return;
  const next = `${current ?? ''}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
  if (current === undefined) {
    await writePrivateFile(excludePath, next);
  } else {
    await fs.writeFile(excludePath, next, { encoding: 'utf8', mode: 0o600 });
  }
}

async function verifyInitialRepository(
  repositoryPath: string,
  marker: DesignRepositoryMarker
): Promise<void> {
  if (marker.state !== 'READY' || !marker.initialCommitSha) {
    throw new Error('Managed Design repository is not ready.');
  }
  const head = cleanGitOutput(
    await managedGit(repositoryPath, ['rev-parse', '--verify', 'HEAD'])
  );
  const branch = cleanGitOutput(
    await managedGit(repositoryPath, ['symbolic-ref', '--short', 'HEAD'])
  );
  const files = await managedGit(repositoryPath, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    head
  ]);
  const index = await managedGit(repositoryPath, ['show', `${head}:index.html`]);
  const remotes = cleanGitOutput(await managedGit(repositoryPath, ['remote']));
  const status = await managedGit(repositoryPath, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  ]);
  if (
    head !== marker.initialCommitSha ||
    branch !== INITIAL_BRANCH ||
    files !== 'index.html\0' ||
    index !== INITIAL_INDEX_HTML ||
    remotes !== '' ||
    status !== ''
  ) {
    throw new Error('Managed Design repository initial commit failed verification.');
  }
}

function repositoryInput(
  repositoryPath: string,
  marker: DesignRepositoryMarker
): ManagedDesignRepositoryInput {
  if (marker.state !== 'READY' || !marker.initialCommitSha) {
    throw new Error('Managed Design repository is not ready.');
  }
  return {
    id: marker.repositoryId,
    name: `Design ${marker.repositoryId.slice(0, 8)}`,
    path: repositoryPath,
    headSha: marker.initialCommitSha,
    branch: INITIAL_BRANCH,
    checkedAt: new Date().toISOString()
  };
}

async function assertNoLinkedWorktrees(
  repositoryPath: string,
  markerState: DesignRepositoryMarker['state']
): Promise<void> {
  if (markerState === 'STAGING' && !(await exists(path.join(repositoryPath, '.git')))) {
    return;
  }
  const repositoryRealPath = await fs.realpath(repositoryPath);
  const worktrees = await listGitWorktrees(repositoryPath);
  for (const worktree of worktrees) {
    const worktreePath = await fs.realpath(worktree.path).catch(() => path.resolve(worktree.path));
    if (!samePath(worktreePath, repositoryRealPath)) {
      throw new Error('Managed Design repository still owns a linked worktree.');
    }
  }
}

async function gitReferenceExists(repositoryPath: string, reference: string): Promise<boolean> {
  try {
    await managedGit(repositoryPath, ['rev-parse', '--verify', reference]);
    return true;
  } catch {
    return false;
  }
}

function cleanGitOutput(value: string): string {
  return value.replace(/[\r\n]+$/u, '');
}

function assertGitObjectId(value: string, label: string): void {
  if (!GIT_OBJECT_ID.test(value)) throw new Error(`Design ${label} is invalid.`);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function missingAsUndefined(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT') return undefined;
  throw error;
}
