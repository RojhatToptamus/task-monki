import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFilePortable } from '../process/portableChildProcess';
import { getGitExecutablePath, git } from './gitCli';

export interface ReviewGitMetadata {
  repositoryRoot: string;
  worktreeRoot: string;
  gitDir: string;
  gitCommonDir: string;
}

/**
 * Resolves a concrete Git executable for a confined review subprocess. On
 * macOS, /usr/bin/git is an xcrun shim that writes a cache under TMPDIR, so
 * resolve the developer-tool Git binary before entering the read-only sandbox.
 */
export async function resolveReviewGitExecutablePath(): Promise<string> {
  try {
    let executable = await canonicalExecutable(
      await resolveExecutableOnPath(getGitExecutablePath())
    );
    if (process.platform === 'darwin' && samePath(executable, '/usr/bin/git')) {
      const { stdout } = await execFilePortable('/usr/bin/xcrun', ['--find', 'git'], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });
      const developerGit = stdout.trim();
      if (!path.isAbsolute(developerGit)) {
        throw new Error('xcrun did not report an absolute Git executable.');
      }
      executable = await canonicalExecutable(developerGit);
    }

    return executable;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot resolve trusted Git metadata for agent review: ${detail}`
    );
  }
}

async function canonicalExecutable(executable: string): Promise<string> {
  const canonical = await fs.realpath(executable).catch(() => {
    throw new Error('The Git executable does not exist.');
  });
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) {
    throw new Error('The Git executable is not a regular file.');
  }
  await fs.access(canonical, fsConstants.X_OK);
  return path.resolve(canonical);
}

/**
 * Resolves the exact Git metadata required by a detached review and proves
 * that it belongs to the selected repository/worktree relationship.
 */
export async function resolveReviewGitMetadata(input: {
  repositoryPath: string;
  worktreePath: string;
}): Promise<ReviewGitMetadata> {
  try {
    const repositoryPath = await canonicalDirectory(
      input.repositoryPath,
      'selected repository'
    );
    const worktreePath = await canonicalDirectory(
      input.worktreePath,
      'task worktree'
    );
    await assertGitEntryIsNotSymlink(worktreePath);
    const [
      repositoryRootOutput,
      repositoryCommonOutput,
      worktreeRootOutput,
      gitDirOutput,
      gitCommonOutput,
      worktreeListOutput
    ] = await Promise.all([
      git(repositoryPath, ['rev-parse', '--show-toplevel']),
      git(repositoryPath, ['rev-parse', '--git-common-dir']),
      git(worktreePath, ['rev-parse', '--show-toplevel']),
      git(worktreePath, ['rev-parse', '--git-dir']),
      git(worktreePath, ['rev-parse', '--git-common-dir']),
      git(repositoryPath, ['worktree', 'list', '--porcelain', '-z'])
    ]);

    const repositoryRoot = await canonicalGitDirectory(
      repositoryPath,
      repositoryRootOutput,
      'repository root'
    );
    const worktreeRoot = await canonicalGitDirectory(
      worktreePath,
      worktreeRootOutput,
      'worktree root'
    );
    const repositoryCommonDir = await canonicalGitDirectory(
      repositoryPath,
      repositoryCommonOutput,
      'repository common Git directory'
    );
    const gitDir = await canonicalGitDirectory(
      worktreePath,
      gitDirOutput,
      'worktree Git directory'
    );
    const gitCommonDir = await canonicalGitDirectory(
      worktreePath,
      gitCommonOutput,
      'worktree common Git directory'
    );

    if (!samePath(repositoryPath, repositoryRoot)) {
      throw new Error(
        'The selected repository path is not its Git top-level directory.'
      );
    }
    if (!samePath(worktreePath, worktreeRoot)) {
      throw new Error('The task worktree path is not its Git top-level directory.');
    }
    if (!samePath(repositoryCommonDir, gitCommonDir)) {
      throw new Error(
        'The task worktree does not use the selected repository common Git directory.'
      );
    }
    if (!samePath(gitDir, gitCommonDir) && !isInside(gitDir, gitCommonDir)) {
      throw new Error(
        'The task worktree Git directory is outside the selected repository common Git directory.'
      );
    }

    const registeredWorktrees = worktreeListOutput
      .split('\0')
      .filter((field) => field.startsWith('worktree '))
      .map((field) => field.slice('worktree '.length));
    const canonicalRegisteredWorktrees = (
      await Promise.all(
        registeredWorktrees.map((candidate) =>
          canonicalDirectory(candidate, 'registered Git worktree').catch(
            () => undefined
          )
        )
      )
    ).filter((candidate): candidate is string => candidate !== undefined);
    if (
      !canonicalRegisteredWorktrees.some((candidate) =>
        samePath(candidate, worktreeRoot)
      )
    ) {
      throw new Error('The task worktree is not registered with the selected repository.');
    }

    await assertWorktreeGitEntry(worktreeRoot, gitDir);
    assertNarrowPermissionDirectory(gitCommonDir);

    return { repositoryRoot, worktreeRoot, gitDir, gitCommonDir };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot resolve trusted Git metadata for agent review: ${detail}`
    );
  }
}

async function assertWorktreeGitEntry(
  worktreeRoot: string,
  expectedGitDir: string
): Promise<void> {
  const gitEntry = path.join(worktreeRoot, '.git');
  const stat = await fs.lstat(gitEntry);
  if (stat.isSymbolicLink()) {
    throw new Error('The task worktree .git entry must not be a symbolic link.');
  }
  if (stat.isDirectory()) {
    const canonical = await fs.realpath(gitEntry);
    if (!samePath(canonical, expectedGitDir)) {
      throw new Error(
        'The task worktree .git directory does not match Git metadata.'
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      'The task worktree .git entry is not a regular file or directory.'
    );
  }

  const pointer = (await fs.readFile(gitEntry, 'utf8')).trim();
  if (
    !pointer.startsWith('gitdir: ') ||
    pointer.slice('gitdir: '.length).trim() === ''
  ) {
    throw new Error('The task worktree .git pointer is invalid.');
  }
  const pointerPath = pointer.slice('gitdir: '.length).trim();
  const pointerTarget = await canonicalDirectory(
    path.isAbsolute(pointerPath)
      ? pointerPath
      : path.resolve(worktreeRoot, pointerPath),
    'worktree .git pointer target'
  );
  if (!samePath(pointerTarget, expectedGitDir)) {
    throw new Error('The task worktree .git pointer does not match Git metadata.');
  }
}

async function assertGitEntryIsNotSymlink(worktreeRoot: string): Promise<void> {
  const stat = await fs.lstat(path.join(worktreeRoot, '.git'));
  if (stat.isSymbolicLink()) {
    throw new Error('The task worktree .git entry must not be a symbolic link.');
  }
}

async function canonicalGitDirectory(
  cwd: string,
  output: string,
  label: string
): Promise<string> {
  const candidate = output.trim();
  if (!candidate) throw new Error(`Git did not report the ${label}.`);
  return canonicalDirectory(
    path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate),
    label
  );
}

async function canonicalDirectory(
  candidate: string,
  label: string
): Promise<string> {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`The ${label} path must be absolute.`);
  }
  const canonical = await fs.realpath(path.resolve(candidate)).catch(() => {
    throw new Error(`The ${label} must be an existing directory.`);
  });
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) {
    throw new Error(`The ${label} must be an existing directory.`);
  }
  return path.resolve(canonical);
}

function assertNarrowPermissionDirectory(candidate: string): void {
  const filesystemRoot = path.parse(candidate).root;
  if (
    samePath(candidate, filesystemRoot) ||
    samePath(candidate, path.resolve(os.homedir()))
  ) {
    throw new Error(
      'The Git metadata permission cannot grant a filesystem root or home directory.'
    );
  }
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string): boolean {
  return (
    path.isAbsolute(left) &&
    path.isAbsolute(right) &&
    path.relative(left, right) === ''
  );
}

async function resolveExecutableOnPath(executable: string): Promise<string> {
  if (path.isAbsolute(executable)) return path.resolve(executable);
  if (executable.includes(path.sep)) {
    throw new Error('The configured Git executable path must be absolute.');
  }

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((extension) => extension.trim())
          .filter(Boolean)
      : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue through the configured executable search path.
      }
    }
  }
  throw new Error('The configured Git executable is unavailable.');
}
