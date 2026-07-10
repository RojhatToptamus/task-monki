/**
 * Phase 0 prototype only. This is intentionally not wired into Task Monki.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { git } from '../../git/gitCli';

export type PrototypeSourceEntry =
  | {
      path: string;
      kind: 'file';
      mode: number;
      size: number;
      digest: string;
    }
  | {
      path: string;
      kind: 'symlink';
      target: string;
      digest: string;
    }
  | {
      path: string;
      kind: 'deleted';
      digest: string;
    };

export interface PrototypeSourceManifest {
  headSha: string;
  entries: PrototypeSourceEntry[];
  digest: string;
}

export interface PreparePrototypeSourceOptions {
  afterEntryCopied?(relativePath: string): Promise<void> | void;
}

export async function preparePrototypeSource(
  repositoryPath: string,
  destinationPath: string,
  options: PreparePrototypeSourceOptions = {}
): Promise<PrototypeSourceManifest> {
  const repositoryRoot = await fs.realpath(
    path.resolve((await git(repositoryPath, ['rev-parse', '--show-toplevel'])).trim())
  );
  const destinationRoot = await canonicalProspectivePath(destinationPath);
  if (isWithin(repositoryRoot, destinationRoot)) {
    throw new Error('Prototype destination must be outside the repository.');
  }

  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.mkdir(destinationRoot, { recursive: true });

  try {
    const before = await capturePrototypeSourceManifest(repositoryRoot);
    for (const entry of before.entries) {
      if (entry.kind === 'deleted') {
        continue;
      }
      const sourcePath = path.join(repositoryRoot, entry.path);
      const destination = path.join(destinationRoot, entry.path);
      assertWithin(destinationRoot, destination);
      await fs.mkdir(path.dirname(destination), { recursive: true });

      if (entry.kind === 'symlink') {
        await fs.symlink(entry.target, destination);
      } else {
        await fs.copyFile(sourcePath, destination);
        await fs.chmod(destination, entry.mode);
        const copiedDigest = await hashFile(destination);
        if (copiedDigest !== entry.digest) {
          throw new Error(`Source changed while copying ${entry.path}.`);
        }
      }
      await options.afterEntryCopied?.(entry.path);
    }

    const after = await capturePrototypeSourceManifest(repositoryRoot);
    if (after.digest !== before.digest) {
      throw new Error('Source changed while the preview snapshot was being prepared.');
    }

    await fs.writeFile(
      path.join(destinationRoot, '.task-monki-source-manifest.json'),
      `${JSON.stringify(before, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    return before;
  } catch (error) {
    await fs.rm(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function capturePrototypeSourceManifest(
  repositoryPath: string
): Promise<PrototypeSourceManifest> {
  const root = path.resolve(repositoryPath);
  const [headSha, listed, staged] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']).then((value) => value.trim()),
    git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    git(root, ['ls-files', '--stage', '-z'])
  ]);
  const gitModes = parseGitModes(staged);
  const includedPaths = listed.split('\0').filter(Boolean).sort();
  const included = new Set(includedPaths);
  const entries: PrototypeSourceEntry[] = [];

  for (const relativePath of includedPaths) {
    validateRelativePath(relativePath);
    if (gitModes.get(relativePath) === '160000') {
      throw new Error(`Git submodules are not supported by the Phase 0 source policy: ${relativePath}`);
    }

    const absolutePath = path.join(root, relativePath);
    assertWithin(root, absolutePath);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        entries.push({
          path: relativePath,
          kind: 'deleted',
          digest: hashText(`deleted\0${relativePath}`)
        });
        continue;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      if (path.isAbsolute(target)) {
        throw new Error(`Absolute symlinks are not supported: ${relativePath}`);
      }
      const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
      assertWithin(root, resolvedTarget);
      const targetRelative = path.relative(root, resolvedTarget).split(path.sep).join('/');
      if (!included.has(targetRelative)) {
        throw new Error(
          `Symlink target must be included in the source manifest: ${relativePath} -> ${target}`
        );
      }
      entries.push({
        path: relativePath,
        kind: 'symlink',
        target,
        digest: hashText(`symlink\0${relativePath}\0${target}`)
      });
      continue;
    }

    if (!stat.isFile()) {
      throw new Error(`Unsupported source entry type: ${relativePath}`);
    }
    if (await isUnresolvedGitLfsPointer(absolutePath, stat.size)) {
      throw new Error(`Git LFS content is not materialized: ${relativePath}`);
    }
    entries.push({
      path: relativePath,
      kind: 'file',
      mode: stat.mode & 0o777,
      size: stat.size,
      digest: await hashFile(absolutePath)
    });
  }

  return {
    headSha,
    entries,
    digest: manifestDigest(headSha, entries)
  };
}

function parseGitModes(value: string): Map<string, string> {
  const modes = new Map<string, string>();
  for (const record of value.split('\0').filter(Boolean)) {
    const match = /^(\d+)\s+[0-9a-f]+\s+\d+\t(.+)$/s.exec(record);
    if (match) {
      modes.set(match[2], match[1]);
    }
  }
  return modes;
}

function manifestDigest(headSha: string, entries: PrototypeSourceEntry[]): string {
  const hash = createHash('sha256');
  hash.update(`head\0${headSha}\0`);
  for (const entry of entries) {
    hash.update(JSON.stringify(entry));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function isUnresolvedGitLfsPointer(filePath: string, size: number): Promise<boolean> {
  if (size > 1024) {
    return false;
  }
  const content = await fs.readFile(filePath, 'utf8').catch(() => '');
  return (
    content.startsWith('version https://git-lfs.github.com/spec/v1\n') &&
    /\noid sha256:[0-9a-f]{64}\n/.test(content)
  );
}

function validateRelativePath(relativePath: string): void {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes('..') ||
    relativePath.includes('\0')
  ) {
    throw new Error(`Unsafe source path: ${relativePath}`);
  }
}

function assertWithin(root: string, candidate: string): void {
  if (!isWithin(root, candidate)) {
    throw new Error(`Path escapes source root: ${candidate}`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function canonicalProspectivePath(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  const missingSegments: string[] = [];
  let candidate = absolute;
  while (true) {
    try {
      const realAncestor = await fs.realpath(candidate);
      return path.join(realAncestor, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}
