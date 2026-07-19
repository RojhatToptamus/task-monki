import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../git/gitCli';
import {
  assertPathWithin,
  canonicalProspectivePath,
  isPathWithin
} from './PreviewPaths';

export type PreviewSourceEntry =
  | { path: string; kind: 'file'; mode: number; size: number; digest: string }
  | { path: string; kind: 'symlink'; target: string; digest: string }
  | { path: string; kind: 'deleted'; digest: string };

export interface PreviewSourceManifest {
  version: 1;
  headSha: string;
  entries: PreviewSourceEntry[];
  digest: string;
}

export interface PreviewSourceLimits {
  maxEntries: number;
  maxPathBytes: number;
  maxTotalSourceBytes: number;
  maxManifestBytes: number;
}

export const DEFAULT_PREVIEW_SOURCE_LIMITS: PreviewSourceLimits = {
  maxEntries: 100_000,
  maxPathBytes: 4_096,
  maxTotalSourceBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 32 * 1024 * 1024
};

interface PreviewWorkspaceMarker {
  version: 1;
  storeId: string;
  taskId: string;
  generationId: string;
  previewRootDigest: string;
  createdAt: string;
}

export interface PreparePreviewSourceInput {
  repositoryPath: string;
  taskId: string;
  generationId: string;
  expectedHeadSha: string;
  afterEntryCopied?(relativePath: string): Promise<void> | void;
}

export interface PreparedPreviewSource {
  generationRoot: string;
  sourcePath: string;
  manifest: PreviewSourceManifest;
  markerDigest: string;
}

export class PreviewSourcePreparer {
  constructor(
    private readonly previewRoot: string,
    private readonly storeId: string,
    private readonly limits: PreviewSourceLimits = DEFAULT_PREVIEW_SOURCE_LIMITS
  ) {}

  getGenerationPath(taskId: string, generationId: string): string {
    return path.resolve(this.previewRoot, taskId, generationId);
  }

  async prepare(input: PreparePreviewSourceInput): Promise<PreparedPreviewSource> {
    const repositoryRoot = await fs.realpath(
      path.resolve((await git(input.repositoryPath, ['rev-parse', '--show-toplevel'])).trim())
    );
    const previewRoot = await canonicalProspectivePath(this.previewRoot);
    const generationRoot = await canonicalProspectivePath(
      path.join(this.previewRoot, input.taskId, input.generationId)
    );
    assertPathWithin(previewRoot, generationRoot, 'Preview generation root');
    if (generationRoot === previewRoot || isPathWithin(repositoryRoot, generationRoot)) {
      throw new Error('Preview generation must be a distinct path outside the task worktree.');
    }

    await fs.mkdir(path.dirname(generationRoot), { recursive: true });
    try {
      await fs.mkdir(generationRoot, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Preview generation workspace already exists: ${generationRoot}`);
      }
      throw error;
    }

    const marker: PreviewWorkspaceMarker = {
      version: 1,
      storeId: this.storeId,
      taskId: input.taskId,
      generationId: input.generationId,
      previewRootDigest: hashText(previewRoot),
      createdAt: new Date().toISOString()
    };
    const markerPath = path.join(generationRoot, 'ownership.json');
    await writeJsonAtomic(markerPath, marker);
    const sourcePath = path.join(generationRoot, 'source');

    try {
      await fs.mkdir(sourcePath, { mode: 0o700 });
      const before = await capturePreviewSourceManifest(repositoryRoot, this.limits);
      if (before.headSha !== input.expectedHeadSha) {
        throw new Error('Git HEAD changed before preview source preparation began.');
      }

      for (const entry of before.entries) {
        if (entry.kind === 'deleted') continue;
        const source = path.join(repositoryRoot, entry.path);
        const destination = path.join(sourcePath, entry.path);
        assertPathWithin(sourcePath, destination, 'Prepared source path');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (entry.kind === 'symlink') {
          await fs.symlink(entry.target, destination);
        } else {
          await fs.copyFile(source, destination);
          await fs.chmod(destination, entry.mode);
          if ((await hashFile(destination)) !== entry.digest) {
            throw new Error(`Source changed while copying ${entry.path}.`);
          }
        }
        await input.afterEntryCopied?.(entry.path);
      }

      const after = await capturePreviewSourceManifest(repositoryRoot, this.limits);
      if (after.digest !== before.digest) {
        throw new Error('Source changed while the preview generation was being prepared.');
      }
      return {
        generationRoot,
        sourcePath,
        manifest: before,
        markerDigest: hashText(canonicalJson(marker))
      };
    } catch (error) {
      await this.cleanupOwnedGeneration({
        taskId: input.taskId,
        generationId: input.generationId
      });
      throw error;
    }
  }

  async cleanupOwnedGeneration(input: { taskId: string; generationId: string }): Promise<boolean> {
    const previewRoot = await canonicalProspectivePath(this.previewRoot);
    const prospective = await canonicalProspectivePath(
      path.join(this.previewRoot, input.taskId, input.generationId)
    );
    assertPathWithin(previewRoot, prospective, 'Preview cleanup path');
    if (prospective === previewRoot) {
      throw new Error('Refusing to remove the preview root itself.');
    }

    let generationRoot: string;
    try {
      generationRoot = await fs.realpath(prospective);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    assertPathWithin(previewRoot, generationRoot, 'Preview cleanup path');

    const marker = JSON.parse(
      await fs.readFile(path.join(generationRoot, 'ownership.json'), 'utf8')
    ) as Partial<PreviewWorkspaceMarker>;
    if (
      marker.version !== 1 ||
      marker.storeId !== this.storeId ||
      marker.taskId !== input.taskId ||
      marker.generationId !== input.generationId ||
      marker.previewRootDigest !== hashText(previewRoot)
    ) {
      throw new Error('Preview workspace ownership marker does not match; cleanup refused.');
    }
    await fs.rm(generationRoot, { recursive: true, force: false });
    return true;
  }
}

export async function capturePreviewSourceManifest(
  repositoryPath: string,
  limits: PreviewSourceLimits = DEFAULT_PREVIEW_SOURCE_LIMITS
): Promise<PreviewSourceManifest> {
  const root = await fs.realpath(path.resolve(repositoryPath));
  const [headSha, listed, staged] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']).then((value) => value.trim()),
    git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    git(root, ['ls-files', '--stage', '-z'])
  ]);
  const gitModes = parseGitModes(staged);
  const includedPaths = listed.split('\0').filter(Boolean).sort();
  if (includedPaths.length > limits.maxEntries) {
    throw new Error(`Preview source exceeds the ${limits.maxEntries} entry limit.`);
  }
  const included = new Set(includedPaths);
  const entries: PreviewSourceEntry[] = [];
  let totalSourceBytes = 0;

  for (const relativePath of includedPaths) {
    validateRelativePath(relativePath);
    if (Buffer.byteLength(relativePath) > limits.maxPathBytes) {
      throw new Error(`Preview source path exceeds ${limits.maxPathBytes} bytes: ${relativePath}`);
    }
    if (gitModes.get(relativePath) === '160000') {
      throw new Error(`Git submodules are unsupported by native previews: ${relativePath}`);
    }
    const absolutePath = path.join(root, relativePath);
    assertPathWithin(root, absolutePath, 'Source path');
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
        throw new Error(`Absolute symlinks are unsupported by native previews: ${relativePath}`);
      }
      const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
      assertPathWithin(root, resolvedTarget, 'Symlink target');
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
    totalSourceBytes += stat.size;
    if (totalSourceBytes > limits.maxTotalSourceBytes) {
      throw new Error(
        `Preview source exceeds the ${limits.maxTotalSourceBytes} byte aggregate limit.`
      );
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

  const manifest: PreviewSourceManifest = {
    version: 1,
    headSha,
    entries,
    digest: manifestDigest(headSha, entries)
  };
  serializePreviewSourceManifest(manifest, limits.maxManifestBytes);
  return manifest;
}

export function serializePreviewSourceManifest(
  manifest: PreviewSourceManifest,
  maxBytes = DEFAULT_PREVIEW_SOURCE_LIMITS.maxManifestBytes
): string {
  const serialized = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(serialized) > maxBytes) {
    throw new Error(`Preview source manifest exceeds the ${maxBytes} byte limit.`);
  }
  return serialized;
}

function parseGitModes(value: string): Map<string, string> {
  const modes = new Map<string, string>();
  for (const record of value.split('\0').filter(Boolean)) {
    const match = /^(\d+)\s+[0-9a-f]+\s+\d+\t(.+)$/s.exec(record);
    if (match) modes.set(match[2], match[1]);
  }
  return modes;
}

function manifestDigest(headSha: string, entries: PreviewSourceEntry[]): string {
  const hash = createHash('sha256');
  hash.update(`version\0${1}\0head\0${headSha}\0`);
  for (const entry of entries) {
    hash.update(canonicalJson(entry));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function isUnresolvedGitLfsPointer(filePath: string, size: number): Promise<boolean> {
  if (size > 1024) return false;
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, filePath);
}
