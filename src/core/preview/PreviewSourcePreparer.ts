import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { git, getGitExecutablePath } from '../git/gitCli';
import { spawnPortable } from '../process/portableChildProcess';
import {
  assertPathWithin,
  canonicalProspectivePath,
  isPathWithin
} from './PreviewPaths';

export interface PreviewSourceLimits {
  maxEntries: number;
  maxPathBytes: number;
  maxTotalSourceBytes: number;
  maxTreeBytes: number;
}

export const DEFAULT_PREVIEW_SOURCE_LIMITS: PreviewSourceLimits = {
  maxEntries: 100_000,
  maxPathBytes: 4_096,
  maxTotalSourceBytes: 2 * 1024 * 1024 * 1024,
  maxTreeBytes: 32 * 1024 * 1024
};

interface PreviewWorkspaceMarker {
  version: 1;
  storeId: string;
  taskId: string;
  generationId: string;
  previewRootDigest: string;
  createdAt: string;
}

export interface PrepareExactCommitPreviewSourceInput {
  repositoryPath: string;
  taskId: string;
  generationId: string;
  commitSha: string;
  signal?: AbortSignal;
}

export interface PreparedPreviewSource {
  generationRoot: string;
  sourcePath: string;
  commitSha: string;
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

  async cleanupOrphanedGenerations(recordedIds: ReadonlySet<string>): Promise<void> {
    const tasks = await fs.readdir(this.previewRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const task of tasks) {
      if (!task.isDirectory() || task.isSymbolicLink()) continue;
      for (const generation of await fs.readdir(path.join(this.previewRoot, task.name), { withFileTypes: true })) {
        if (!generation.isDirectory() || generation.isSymbolicLink() || recordedIds.has(generation.name)) continue;
        let marker: Partial<PreviewWorkspaceMarker>;
        try {
          marker = JSON.parse(await fs.readFile(path.join(this.previewRoot, task.name, generation.name, 'ownership.json'), 'utf8'));
        } catch (error) {
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (marker.storeId !== this.storeId || marker.taskId !== task.name || marker.generationId !== generation.name) continue;
        await this.cleanupOwnedGeneration({ taskId: task.name, generationId: generation.name });

      }
    }
  }

  async prepareExactCommit(
    input: PrepareExactCommitPreviewSourceInput
  ): Promise<PreparedPreviewSource> {
    throwIfAborted(input.signal);
    const repositoryRoot = await fs.realpath(
      path.resolve((await git(input.repositoryPath, ['rev-parse', '--show-toplevel'])).trim())
    );
    const commitSha = (
      await git(repositoryRoot, ['rev-parse', '--verify', `${input.commitSha}^{commit}`])
    ).trim();
    if (commitSha !== input.commitSha) {
      throw new Error('Exact-commit Preview source requires the full canonical commit SHA.');
    }

    const workspace = await this.createOwnedWorkspace(
      repositoryRoot,
      input.taskId,
      input.generationId
    );
    const { generationRoot, sourcePath } = workspace;

    try {
      await fs.mkdir(sourcePath, { mode: 0o700 });
      const treeEntries = await readExactCommitTree(
        repositoryRoot,
        commitSha,
        this.limits,
        input.signal
      );
      await exportExactCommitBlobs({
        repositoryRoot,
        sourcePath,
        treeEntries,
        limits: this.limits,
        signal: input.signal
      });
      return { generationRoot, sourcePath, commitSha };

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
    // The generation is the owned resource. Its empty parent is cosmetic and
    // has no durable cleanup state, so a parent removal failure must not turn a
    // completed generation cleanup into an unretryable failure.
    await fs.rmdir(path.dirname(generationRoot)).catch(() => undefined);
    return true;
  }

  private async createOwnedWorkspace(
    repositoryRoot: string,
    taskId: string,
    generationId: string
  ): Promise<{
    generationRoot: string;
    sourcePath: string;
    marker: PreviewWorkspaceMarker;
  }> {
    const previewRoot = await canonicalProspectivePath(this.previewRoot);
    const generationRoot = await canonicalProspectivePath(
      path.join(this.previewRoot, taskId, generationId)
    );
    assertPathWithin(previewRoot, generationRoot, 'Preview generation root');
    if (generationRoot === previewRoot || isPathWithin(repositoryRoot, generationRoot)) {
      throw new Error('Preview generation must be a distinct path outside the task worktree.');
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await fs.mkdir(path.dirname(generationRoot), { recursive: true });
      try {
        await fs.mkdir(generationRoot, { recursive: false, mode: 0o700 });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          throw new Error(`Preview generation workspace already exists: ${generationRoot}`);
        }
        // Final-generation cleanup can remove an empty task directory between
        // the parent and generation mkdir calls. Recreate it once.
        if (code !== 'ENOENT' || attempt > 0) throw error;
      }
    }

    const marker: PreviewWorkspaceMarker = {
      version: 1,
      storeId: this.storeId,
      taskId,
      generationId,
      previewRootDigest: hashText(previewRoot),
      createdAt: new Date().toISOString()
    };
    await writeJsonAtomic(path.join(generationRoot, 'ownership.json'), marker);
    return {
      generationRoot,
      sourcePath: path.join(generationRoot, 'source'),
      marker
    };
  }
}

interface ExactCommitTreeEntry {
  mode: '100644' | '100755' | '120000';
  objectId: string;
  path: string;
  size: number;
}

async function readExactCommitTree(
  repositoryRoot: string,
  commitSha: string,
  limits: PreviewSourceLimits,
  signal?: AbortSignal
): Promise<ExactCommitTreeEntry[]> {
  const entries: ExactCommitTreeEntry[] = [];
  let treeBytes = 0;
  let totalSourceBytes = 0;
  await readNullDelimitedGitOutput({
    repositoryRoot,
    argv: ['ls-tree', '-rz', '-l', '--full-tree', commitSha],
    signal,
    maxRecordBytes: limits.maxPathBytes + 256,
    onRecord(record) {
      const separator = record.indexOf(0x09);
      if (separator < 1) throw new Error('Git returned a malformed exact-commit tree entry.');
      const metadata = record.subarray(0, separator).toString('ascii');
      const pathBytes = record.subarray(separator + 1);
      if (!isUtf8(pathBytes)) {
        throw new Error('Exact-commit Preview paths must use valid UTF-8.');
      }
      const relativePath = pathBytes.toString('utf8');
      const match = /^(\d{6}) (\S+) ([0-9a-f]+)\s+(\S+)$/.exec(metadata);
      if (!match) throw new Error('Git returned a malformed exact-commit tree entry.');
      const [, mode, objectType, objectId, rawSize] = match;
      validateExactCommitPath(relativePath);
      if (Buffer.byteLength(relativePath) > limits.maxPathBytes) {
        throw new Error(
          `Preview source path exceeds ${limits.maxPathBytes} bytes: ${relativePath}`
        );
      }
      if (mode === '160000') {
        throw new Error(`Git submodules are unsupported by exact-commit previews: ${relativePath}`);
      }
      if ((mode !== '100644' && mode !== '100755' && mode !== '120000') || objectType !== 'blob') {
        throw new Error(`Unsupported exact-commit source entry: ${relativePath}`);
      }
      const size = Number(rawSize);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Git returned an invalid blob size for ${relativePath}.`);
      }
      totalSourceBytes += size;
      if (totalSourceBytes > limits.maxTotalSourceBytes) {
        throw new Error(
          `Preview source exceeds the ${limits.maxTotalSourceBytes} byte aggregate limit.`
        );
      }
      entries.push({ mode, objectId, path: relativePath, size });
      if (entries.length > limits.maxEntries) {
        throw new Error(`Preview source exceeds the ${limits.maxEntries} entry limit.`);
      }
      treeBytes += Buffer.byteLength(relativePath) + objectId.length + 160;
      if (treeBytes > limits.maxTreeBytes) {
        throw new Error(
          `Preview source tree exceeds the ${limits.maxTreeBytes} byte limit.`
        );
      }
    }
  });
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return entries;
}

async function exportExactCommitBlobs(input: {
  repositoryRoot: string;
  sourcePath: string;
  treeEntries: ExactCommitTreeEntry[];
  limits: PreviewSourceLimits;
  signal?: AbortSignal;
}): Promise<void> {
  const child = spawnPortable(getGitExecutablePath(), ['cat-file', '--batch'], {
    cwd: input.repositoryRoot,
    stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;
  const reader = new ChildByteReader(child);
  const stderr = collectBoundedStream(child.stderr, 64 * 1024);
  const exit = childExit(child);
  const abort = () => child.kill('SIGKILL');
  input.signal?.addEventListener('abort', abort, { once: true });
  const links: Array<{ path: string; target: string }> = [];

  try {
    for (const treeEntry of input.treeEntries) {
      throwIfAborted(input.signal);
      await writeChildInput(child, `${treeEntry.objectId}\n`);
      const header = (await reader.readLine(512)).toString('ascii');
      const match = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header);
      if (!match || match[1] !== treeEntry.objectId || match[2] !== 'blob') {
        throw new Error(`Git could not read exact-commit blob for ${treeEntry.path}.`);
      }
      const size = Number(match[3]);
      if (!Number.isSafeInteger(size) || size < 0 || size !== treeEntry.size) {
        throw new Error(`Git returned an invalid blob size for ${treeEntry.path}.`);
      }

      const destination = path.join(input.sourcePath, treeEntry.path);
      assertPathWithin(input.sourcePath, destination, 'Prepared exact-commit source path');
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (treeEntry.mode === '120000') {
        if (size > input.limits.maxPathBytes) throw new Error(`Preview symlink target is too long: ${treeEntry.path}`);
        const chunks: Buffer[] = [];
        await reader.consume(size, async (chunk) => { chunks.push(Buffer.from(chunk)); });
        const bytes = Buffer.concat(chunks);
        if (!isUtf8(bytes) || (await reader.readByte()) !== 0x0a) throw new Error('Invalid Git symlink content.');
        const target = bytes.toString('utf8');
        if (!target || target.includes('\0') || path.isAbsolute(target) || target.includes('\\')) {
          throw new Error(`Unsafe Preview source symlink: ${treeEntry.path}`);
        }
        assertPathWithin(input.sourcePath, path.resolve(path.dirname(destination), target), 'Preview symlink target');
        links.push({ path: treeEntry.path, target });
        continue;
      }
      const mode = treeEntry.mode === '100755' ? 0o755 : 0o644;
      const handle = await fs.open(destination, 'wx', mode);
      const smallContent: Buffer[] = [];
      try {
        await reader.consume(size, async (chunk) => {
          throwIfAborted(input.signal);
          if (size <= 1024) smallContent.push(Buffer.from(chunk));
          await writeAll(handle, chunk);
        });
      } finally {
        await handle.close();
      }
      const terminator = await reader.readByte();
      if (terminator !== 0x0a) {
        throw new Error(`Git returned malformed blob framing for ${treeEntry.path}.`);
      }
      if (size <= 1024 && isUnresolvedGitLfsPointerContent(Buffer.concat(smallContent))) {
        throw new Error(`Git LFS content is not materialized: ${treeEntry.path}`);
      }
      await fs.chmod(destination, mode);
    }
    // Materialize links after regular files so no export write follows a link.
    for (const entry of links) {
      await fs.symlink(entry.target, path.join(input.sourcePath, entry.path));
    }
    for (const entry of links) {
      assertPathWithin(input.sourcePath, await fs.realpath(path.join(input.sourcePath, entry.path)), 'Resolved Preview symlink');
    }
    child.stdin.end();
    const status = await exit;
    const errorOutput = await stderr;
    if (status.code !== 0) {
      throw new Error(
        `Git exact-commit export failed${errorOutput ? `: ${errorOutput}` : '.'}`
      );
    }
    throwIfAborted(input.signal);
  } catch (error) {
    child.kill('SIGKILL');
    await Promise.allSettled([exit, stderr]);
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}

async function readNullDelimitedGitOutput(input: {
  repositoryRoot: string;
  argv: string[];
  signal?: AbortSignal;
  maxRecordBytes: number;
  onRecord(record: Buffer): void;
}): Promise<void> {
  throwIfAborted(input.signal);
  const child = spawnPortable(getGitExecutablePath(), input.argv, {
    cwd: input.repositoryRoot,
    stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;
  child.stdin.end();
  const stderr = collectBoundedStream(child.stderr, 64 * 1024);
  const exit = childExit(child);
  const abort = () => child.kill('SIGKILL');
  input.signal?.addEventListener('abort', abort, { once: true });
  let pending = Buffer.alloc(0);
  try {
    for await (const value of child.stdout) {
      throwIfAborted(input.signal);
      const chunk = Buffer.from(value);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let separator = pending.indexOf(0);
      while (separator >= 0) {
        const record = pending.subarray(0, separator);
        if (record.length > input.maxRecordBytes) {
          throw new Error('Git exact-commit tree entry exceeds the path limit.');
        }
        input.onRecord(record);
        pending = pending.subarray(separator + 1);
        separator = pending.indexOf(0);
      }
      if (pending.length > input.maxRecordBytes) {
        throw new Error('Git exact-commit tree entry exceeds the path limit.');
      }
    }
    const status = await exit;
    const errorOutput = await stderr;
    if (status.code !== 0) {
      throw new Error(
        `Git exact-commit tree read failed${errorOutput ? `: ${errorOutput}` : '.'}`
      );
    }
    if (pending.length !== 0) {
      throw new Error('Git returned an incomplete exact-commit tree entry.');
    }
    throwIfAborted(input.signal);
  } catch (error) {
    child.kill('SIGKILL');
    await Promise.allSettled([exit, stderr]);
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}

class ChildByteReader {
  private readonly iterator: AsyncIterator<Buffer | string>;
  private pending: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.iterator = child.stdout[Symbol.asyncIterator]();
  }

  async readLine(maxBytes: number): Promise<Buffer> {
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.pending.subarray(0, newline);
        this.pending = this.pending.subarray(newline + 1);
        if (line.length > maxBytes) throw new Error('Git batch header exceeds its size limit.');
        return line;
      }
      if (this.pending.length > maxBytes) {
        throw new Error('Git batch header exceeds its size limit.');
      }
      await this.readMore();
    }
  }

  async consume(size: number, consumeChunk: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (this.pending.length === 0) await this.readMore();
      const length = Math.min(remaining, this.pending.length);
      const chunk = this.pending.subarray(0, length);
      this.pending = this.pending.subarray(length);
      remaining -= length;
      await consumeChunk(chunk);
    }
  }

  async readByte(): Promise<number> {
    if (this.pending.length === 0) await this.readMore();
    const value = this.pending[0];
    this.pending = this.pending.subarray(1);
    return value;
  }

  private async readMore(): Promise<void> {
    if (this.ended) throw new Error('Git batch output ended before the blob was complete.');
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      throw new Error('Git batch output ended before the blob was complete.');
    }
    const chunk = Buffer.from(next.value);
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
  }
}

async function writeAll(handle: fs.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset, null);
    if (result.bytesWritten < 1) throw new Error('Preview source file write made no progress.');
    offset += result.bytesWritten;
  }
}

async function writeChildInput(child: ChildProcessWithoutNullStreams, value: string): Promise<void> {
  if (child.stdin.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.stdin.off('drain', onDrain);
      child.stdin.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdin.once('drain', onDrain);
    child.stdin.once('error', onError);
  });
}

function childExit(child: { once(event: 'error', listener: (error: Error) => void): unknown; once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown }): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function collectBoundedStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of stream) {
    if (total >= maxBytes) continue;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const retained = chunk.subarray(0, maxBytes - total);
    chunks.push(retained);
    total += retained.length;
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Preview source preparation was canceled.');
}

function validateExactCommitPath(relativePath: string): void {
  validateRelativePath(relativePath);
  const segments = relativePath.split('/');
  if (
    relativePath.includes('\\') ||
    segments.some((segment) => !segment || segment === '.' || segment.toLowerCase() === '.git')
  ) {
    throw new Error(`Unsafe exact-commit source path: ${relativePath}`);
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUnresolvedGitLfsPointerContent(content: Buffer): boolean {
  const value = content.toString('utf8');
  return (
    value.startsWith('version https://git-lfs.github.com/spec/v1\n') &&
    /\noid sha256:[0-9a-f]{64}\n/.test(value)
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
