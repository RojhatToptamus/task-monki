import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  enforcePosixMode,
  ensurePrivateDirectory,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../../filesystem/secureFilesystem';

const STORAGE_KEY_MAX_LENGTH = 1_024;
const STORAGE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TEMP_FILE = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.task-monki-[0-9a-f-]{36}\.tmp$/u;
const DEFAULT_STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;
const COPY_BUFFER_BYTES = 256 * 1_024;

export interface ManagedFileReference {
  storageKey: string;
  byteCount: number;
  sha256: string;
}

export interface ManagedFileIntegrityIssue {
  storageKey: string;
  kind: 'MISSING' | 'CORRUPT' | 'ORPHAN' | 'UNSAFE';
  detail: string;
  actual?: Pick<ManagedFileReference, 'byteCount' | 'sha256'>;
}

export interface ManagedFileIntegrityReport {
  checkedReferences: number;
  checkedFiles: number;
  issues: ManagedFileIntegrityIssue[];
}

export interface ManagedFileStoreOptions {
  now?: () => Date;
  createId?: () => string;
  staleTempAgeMs?: number;
}

export interface ManagedFileDeletionBarrier {
  release(): void;
}

export class ManagedFileIntegrityError extends Error {
  readonly name = 'ManagedFileIntegrityError';

  constructor(message: string, readonly storageKey?: string) {
    super(message);
  }
}

/**
 * Owns immutable, application-managed bytes below one private root. Database
 * rows own reachability; this class owns durable file publication and
 * integrity verification only.
 */
export class ManagedFileStore {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly staleTempAgeMs: number;
  private initialization?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private deletionBarriers = 0;
  private readonly deletionWaiters = new Set<() => void>();

  constructor(
    private readonly rootDirectory: string,
    options: ManagedFileStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.staleTempAgeMs = options.staleTempAgeMs ?? DEFAULT_STALE_TEMP_AGE_MS;
    if (!Number.isSafeInteger(this.staleTempAgeMs) || this.staleTempAgeMs < 0) {
      throw new Error('Managed file stale-temp age must be a non-negative integer.');
    }
  }

  get rootPath(): string {
    return path.resolve(this.rootDirectory);
  }

  init(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  publish(storageKey: string, contents: Uint8Array): Promise<ManagedFileReference> {
    return this.enqueue(async () => {
      await this.init();
      assertStorageKey(storageKey);
      const bytes = Buffer.from(contents);
      const reference: ManagedFileReference = {
        storageKey,
        byteCount: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      };
      const target = this.pathFor(storageKey);
      await this.ensureParent(storageKey);

      const existing = await lstatIfExists(target);
      if (existing) {
        await verifyImmutableFile(target, reference);
        return reference;
      }

      const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.task-monki-${this.createId()}.tmp`
      );
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(
          temporary,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            (fsConstants.O_NOFOLLOW ?? 0),
          0o600
        );
        await handle.writeFile(bytes);
        await enforcePosixMode(handle, 0o400);
        const written = await handle.stat();
        assertSafeRegularFile(written, temporary);
        if (written.size !== bytes.byteLength) {
          throw new ManagedFileIntegrityError(
            'Managed file publication wrote an incomplete file.',
            storageKey
          );
        }
        await handle.sync();
        await handle.close();
        handle = undefined;

        const raced = await lstatIfExists(target);
        if (raced) {
          await verifyImmutableFile(target, reference);
          await fs.unlink(temporary);
          return reference;
        }
        await fs.rename(temporary, target);
        await syncDirectoryIfSupported(path.dirname(target));
        await verifyImmutableFile(target, reference);
        return reference;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
  }

  verify(reference: ManagedFileReference): Promise<void> {
    return this.enqueue(async () => {
      await this.verifyDirect(reference);
    });
  }

  read(reference: ManagedFileReference, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      return Promise.reject(
        new Error('Managed file read limit must be a non-negative integer.')
      );
    }
    if (reference.byteCount > maxBytes) {
      return Promise.reject(
        new ManagedFileIntegrityError(
          'Managed file exceeds the requested read limit.',
          reference.storageKey
        )
      );
    }
    return this.enqueue(async () => {
      await this.verifyDirect(reference);
      return readVerifiedImmutableFile(
        this.pathFor(reference.storageKey),
        reference,
        maxBytes
      );
    });
  }

  /** Returns a core-only path after verifying that the immutable bytes match. */
  async resolveVerifiedPath(reference: ManagedFileReference): Promise<string> {
    await this.verify(reference);
    return this.pathFor(reference.storageKey);
  }

  /**
   * Copies verified bytes into a caller-owned private staging area. This is
   * used by backup construction; the destination must not already exist.
   */
  async copyVerifiedTo(reference: ManagedFileReference, destination: string): Promise<void> {
    await this.init();
    assertReference(reference);
    await this.assertSafeAncestors(reference.storageKey);
    await copyVerifiedPrivateFile(
      this.pathFor(reference.storageKey),
      destination,
      reference
    );
  }

  /**
   * Physical deletion is intentionally named for its ordering requirement:
   * callers invoke it only after the authoritative database reference commits.
   */
  deleteAfterReferenceCommit(storageKey: string): Promise<'DELETED' | 'MISSING'> {
    return this.enqueue(async () => {
      await this.init();
      assertStorageKey(storageKey);
      await this.waitForDeletionBarriers();
      const filePath = this.pathFor(storageKey);
      const stat = await lstatIfExists(filePath);
      if (!stat) return 'MISSING';
      await this.assertSafeAncestors(storageKey);
      assertSafeRegularFile(stat, filePath);
      await fs.unlink(filePath);
      await syncDirectoryIfSupported(path.dirname(filePath));
      await this.removeEmptyParents(path.dirname(filePath));
      return 'DELETED';
    });
  }

  /** Prevents physical deletion while a database snapshot's files are copied. */
  beginDeletionBarrier(): Promise<ManagedFileDeletionBarrier> {
    return this.enqueue(async () => {
      await this.init();
      this.deletionBarriers += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.deletionBarriers -= 1;
          if (this.deletionBarriers === 0) {
            for (const resolve of this.deletionWaiters) resolve();
            this.deletionWaiters.clear();
          }
        }
      };
    });
  }

  cleanupStaleTemporaryFiles(): Promise<number> {
    return this.enqueue(async () => {
      await ensureManagedDirectory(this.rootDirectory);
      const files = await collectManagedFiles(this.rootDirectory);
      const cutoff = this.now().getTime() - this.staleTempAgeMs;
      let removed = 0;
      for (const file of files) {
        if (!file.temporary || file.stat.mtimeMs > cutoff) continue;
        await fs.unlink(file.absolutePath);
        await syncDirectoryIfSupported(path.dirname(file.absolutePath));
        removed += 1;
      }
      return removed;
    });
  }

  /** Waits until every managed-file operation admitted before this call settles. */
  async drain(): Promise<void> {
    await this.enqueue(async () => undefined);
  }

  async inspect(references: readonly ManagedFileReference[]): Promise<ManagedFileIntegrityReport> {
    await this.init();
    const expected = new Map<string, ManagedFileReference>();
    for (const reference of references) {
      assertReference(reference);
      const duplicate = expected.get(reference.storageKey);
      if (
        duplicate &&
        (duplicate.byteCount !== reference.byteCount || duplicate.sha256 !== reference.sha256)
      ) {
        throw new Error(`Conflicting managed file references for ${reference.storageKey}.`);
      }
      expected.set(reference.storageKey, reference);
    }

    const files = await collectManagedFiles(this.rootDirectory);
    const byKey = new Map(
      files.filter((file) => !file.temporary).map((file) => [file.storageKey, file])
    );
    const issues: ManagedFileIntegrityIssue[] = [];

    for (const reference of expected.values()) {
      const file = byKey.get(reference.storageKey);
      if (!file) {
        issues.push({
          storageKey: reference.storageKey,
          kind: 'MISSING',
          detail: 'The authoritative record references a file that is not present.'
        });
        continue;
      }
      try {
        const actual = await inspectPrivateImmutableFile(file.absolutePath);
        if (actual.byteCount !== reference.byteCount || actual.sha256 !== reference.sha256) {
          issues.push({
            storageKey: reference.storageKey,
            kind: 'CORRUPT',
            detail: 'The managed file does not match its authoritative size and digest.',
            actual
          });
        }
      } catch (error) {
        issues.push({
          storageKey: reference.storageKey,
          kind: 'UNSAFE',
          detail: errorMessage(error)
        });
      }
    }

    for (const file of byKey.values()) {
      if (expected.has(file.storageKey)) continue;
      try {
        issues.push({
          storageKey: file.storageKey,
          kind: 'ORPHAN',
          detail: 'The managed file has no authoritative database reference.',
          actual: await inspectPrivateImmutableFile(file.absolutePath)
        });
      } catch (error) {
        issues.push({
          storageKey: file.storageKey,
          kind: 'UNSAFE',
          detail: errorMessage(error)
        });
      }
    }

    issues.sort((left, right) =>
      left.storageKey.localeCompare(right.storageKey) || left.kind.localeCompare(right.kind)
    );
    return {
      checkedReferences: expected.size,
      checkedFiles: byKey.size,
      issues
    };
  }

  private async initialize(): Promise<void> {
    await ensureManagedDirectory(this.rootDirectory);
    await this.cleanupStaleTemporaryFilesDirect();
  }

  private async verifyDirect(reference: ManagedFileReference): Promise<void> {
    await this.init();
    assertReference(reference);
    await this.assertSafeAncestors(reference.storageKey);
    await verifyImmutableFile(this.pathFor(reference.storageKey), reference);
  }

  private async cleanupStaleTemporaryFilesDirect(): Promise<void> {
    const files = await collectManagedFiles(this.rootDirectory);
    const cutoff = this.now().getTime() - this.staleTempAgeMs;
    for (const file of files) {
      if (!file.temporary || file.stat.mtimeMs > cutoff) continue;
      await fs.unlink(file.absolutePath);
      await syncDirectoryIfSupported(path.dirname(file.absolutePath));
    }
  }

  private async ensureParent(storageKey: string): Promise<void> {
    const segments = storageKey.split('/').slice(0, -1);
    let directory = this.rootDirectory;
    for (const segment of segments) {
      directory = path.join(directory, segment);
      await ensureManagedDirectory(directory);
    }
  }

  private async assertSafeAncestors(storageKey: string): Promise<void> {
    assertStorageKey(storageKey);
    const segments = storageKey.split('/').slice(0, -1);
    let directory = this.rootDirectory;
    assertSafeDirectory(await fs.lstat(directory), directory);
    for (const segment of segments) {
      directory = path.join(directory, segment);
      assertSafeDirectory(await fs.lstat(directory), directory);
    }
  }

  private pathFor(storageKey: string): string {
    assertStorageKey(storageKey);
    return path.join(this.rootDirectory, ...storageKey.split('/'));
  }

  private async waitForDeletionBarriers(): Promise<void> {
    if (this.deletionBarriers === 0) return;
    await new Promise<void>((resolve) => this.deletionWaiters.add(resolve));
  }

  private async removeEmptyParents(start: string): Promise<void> {
    let directory = start;
    while (directory !== this.rootDirectory) {
      try {
        await fs.rmdir(directory);
        const parent = path.dirname(directory);
        await syncDirectoryIfSupported(parent);
        directory = parent;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'ENOENT') return;
        throw error;
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface CollectedManagedFile {
  absolutePath: string;
  storageKey: string;
  stat: Stats;
  temporary: boolean;
}

async function collectManagedFiles(root: string): Promise<CollectedManagedFile[]> {
  const files: CollectedManagedFile[] = [];
  const walk = async (directory: string, segments: string[]): Promise<void> => {
    assertSafeDirectory(await fs.lstat(directory), directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new ManagedFileIntegrityError(
          `Managed storage contains a symbolic link: ${absolutePath}`
        );
      }
      if (stat.isDirectory()) {
        assertSafeDirectory(stat, absolutePath);
        if (!STORAGE_KEY_SEGMENT.test(entry.name)) {
          throw new ManagedFileIntegrityError(
            `Managed storage contains an unsafe directory: ${absolutePath}`
          );
        }
        await walk(absolutePath, [...segments, entry.name]);
        continue;
      }
      assertSafeRegularFile(stat, absolutePath);
      const temporary = TEMP_FILE.test(entry.name);
      const name = temporary
        ? entry.name
        : [...segments, entry.name].join('/');
      if (!temporary) assertStorageKey(name);
      files.push({ absolutePath, storageKey: name, stat, temporary });
    }
  };
  await walk(root, []);
  return files;
}

export function assertStorageKey(storageKey: string): void {
  if (
    storageKey.length === 0 ||
    storageKey.length > STORAGE_KEY_MAX_LENGTH ||
    storageKey.includes('\\') ||
    path.posix.isAbsolute(storageKey)
  ) {
    throw new ManagedFileIntegrityError('Managed file storage key is unsafe.', storageKey);
  }
  const segments = storageKey.split('/');
  if (segments.some((segment) => !STORAGE_KEY_SEGMENT.test(segment))) {
    throw new ManagedFileIntegrityError('Managed file storage key is unsafe.', storageKey);
  }
}

async function ensureManagedDirectory(directory: string): Promise<void> {
  try {
    await ensurePrivateDirectory(directory);
  } catch (error) {
    throw new ManagedFileIntegrityError(
      `Managed directory failed its integrity check: ${directory}. ${errorMessage(error)}`
    );
  }
}

function assertReference(reference: ManagedFileReference): void {
  assertStorageKey(reference.storageKey);
  if (!Number.isSafeInteger(reference.byteCount) || reference.byteCount < 0) {
    throw new ManagedFileIntegrityError('Managed file byte count is invalid.', reference.storageKey);
  }
  if (!SHA256.test(reference.sha256)) {
    throw new ManagedFileIntegrityError('Managed file digest is invalid.', reference.storageKey);
  }
}

function assertSafeDirectory(stat: Stats, directory: string): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !isOwnedByCurrentUser(stat) ||
    !hasNoGroupOrOtherPosixAccess(stat)
  ) {
    throw new ManagedFileIntegrityError(`Managed directory failed its integrity check: ${directory}`);
  }
}

function assertSafeRegularFile(stat: Stats, filePath: string): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !isOwnedByCurrentUser(stat) ||
    !hasNoGroupOrOtherPosixAccess(stat) ||
    (process.platform !== 'win32' && stat.nlink !== 1)
  ) {
    throw new ManagedFileIntegrityError(`Managed file failed its integrity check: ${filePath}`);
  }
}

export async function inspectPrivateImmutableFile(
  filePath: string
): Promise<Pick<ManagedFileReference, 'byteCount' | 'sha256'>> {
  const handle = await openImmutableFile(filePath);
  try {
    const before = await handle.stat();
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.byteLength, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) {
        throw new ManagedFileIntegrityError(
          `Managed file became incomplete while reading: ${filePath}`
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(before, after) || before.size !== after.size) {
      throw new ManagedFileIntegrityError(`Managed file changed while reading: ${filePath}`);
    }
    return { byteCount: before.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function verifyImmutableFile(
  filePath: string,
  expected: ManagedFileReference
): Promise<void> {
  const actual = await inspectPrivateImmutableFile(filePath);
  if (actual.byteCount !== expected.byteCount || actual.sha256 !== expected.sha256) {
    throw new ManagedFileIntegrityError(
      'Managed file does not match its authoritative metadata.',
      expected.storageKey
    );
  }
}

async function readVerifiedImmutableFile(
  filePath: string,
  expected: ManagedFileReference,
  maxBytes: number
): Promise<Buffer> {
  if (expected.byteCount > maxBytes) {
    throw new ManagedFileIntegrityError(
      'Managed file exceeds the requested read limit.',
      expected.storageKey
    );
  }
  const handle = await openImmutableFile(filePath);
  try {
    const before = await handle.stat();
    if (before.size !== expected.byteCount) {
      throw new ManagedFileIntegrityError(
        'Managed file size does not match its metadata.',
        expected.storageKey
      );
    }
    const contents = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.byteLength - offset,
        offset
      );
      if (bytesRead === 0) {
        throw new ManagedFileIntegrityError(
          'Managed file became incomplete while reading.',
          expected.storageKey
        );
      }
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      !sameFileIdentity(before, after) ||
      before.size !== after.size ||
      createHash('sha256').update(contents).digest('hex') !== expected.sha256
    ) {
      throw new ManagedFileIntegrityError('Managed file changed or is corrupt.', expected.storageKey);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export async function copyVerifiedPrivateFile(
  source: string,
  destination: string,
  expected: Pick<ManagedFileReference, 'byteCount' | 'sha256'>
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(destination));
  const sourceHandle = await openImmutableFile(source);
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const before = await sourceHandle.stat();
    if (before.size !== expected.byteCount) {
      throw new ManagedFileIntegrityError(`Managed file size does not match before copy: ${source}`);
    }
    destinationHandle = await fs.open(
      destination,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.byteLength, before.size - offset);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, offset);
      if (bytesRead === 0) {
        throw new ManagedFileIntegrityError(`Managed file became incomplete during copy: ${source}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          offset + written
        );
        if (result.bytesWritten === 0) {
          throw new ManagedFileIntegrityError(
            `Managed file destination stopped accepting bytes: ${destination}`
          );
        }
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (
      !sameFileIdentity(before, after) ||
      before.size !== after.size ||
      hash.digest('hex') !== expected.sha256
    ) {
      throw new ManagedFileIntegrityError(`Managed file changed or is corrupt during copy: ${source}`);
    }
    await enforcePosixMode(destinationHandle, 0o400);
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = undefined;
    await syncDirectoryIfSupported(path.dirname(destination));
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    await fs.unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await sourceHandle.close();
  }
}

async function openImmutableFile(filePath: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const pathStat = await fs.lstat(filePath);
  assertSafeRegularFile(pathStat, filePath);
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0)
  );
  try {
    const stat = await handle.stat();
    assertSafeRegularFile(stat, filePath);
    if (!sameFileIdentity(pathStat, stat)) {
      throw new ManagedFileIntegrityError(`Managed file changed while opening: ${filePath}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino)
  );
}

async function lstatIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
