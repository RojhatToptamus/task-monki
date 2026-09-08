import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRecord } from '../../../shared/contracts';
import {
  enforcePosixMode,
  ensurePrivateDirectory,
  isOwnedByCurrentUser,
  posixModeMatches,
  syncDirectoryIfSupported
} from '../../filesystem/secureFilesystem';
import { ManagedFileStore, type ManagedFileReference } from './ManagedFileStore';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ARTIFACT_REVISION_FILE = new RegExp(
  `^(${UUID.source.slice(1, -1)})-([a-f0-9]{64})\\.log$`,
  'u'
);
const CAPTURE_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.log$/u;

/**
 * Owns Task-domain artifact bytes. Authoritative revisions are immutable;
 * preview subprocesses write only to private capture files which are
 * reconciled into immutable revisions by the Task store.
 */
export class SqliteTaskArtifactStore {
  private readonly managedFileRoot: string;
  private readonly artifactRoot: string;
  private readonly captureRoot: string;

  constructor(private readonly managedFiles: ManagedFileStore) {
    this.managedFileRoot = managedFiles.rootPath;
    this.artifactRoot = path.join(this.managedFileRoot, 'task', 'artifacts');
    this.captureRoot = path.join(
      path.dirname(this.managedFileRoot),
      'task-artifact-captures'
    );
  }

  async init(): Promise<void> {
    await this.managedFiles.init();
    await ensurePrivateDirectory(this.artifactRoot);
    await ensurePrivateDirectory(this.captureRoot);
  }

  async publish(artifactId: string, contents: Uint8Array): Promise<ManagedFileReference & { path: string }> {
    assertArtifactId(artifactId);
    const bytes = Buffer.from(contents);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reference = await this.managedFiles.publish(
      artifactStorageKey(artifactId, randomUUID(), sha256),
      bytes
    );
    return { ...reference, path: this.absolutePath(reference.storageKey) };
  }

  reference(record: ArtifactRecord): ManagedFileReference {
    const relative = path.relative(path.resolve(this.managedFileRoot), path.resolve(record.path));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Task artifact escaped the managed-file root.');
    }
    const storageKey = relative.split(path.sep).join('/');
    const match = /^task\/artifacts\/([^/]+)\/(.+)$/u.exec(storageKey);
    const revision = match ? ARTIFACT_REVISION_FILE.exec(match[2]!) : undefined;
    if (!match || !revision || match[1] !== record.id || !UUID.test(match[1])) {
      throw new Error(`Task artifact ${record.id} has an invalid immutable storage key.`);
    }
    if (!Number.isSafeInteger(record.byteCount) || record.byteCount < 0) {
      throw new Error(`Task artifact ${record.id} has an invalid byte count.`);
    }
    return { storageKey, byteCount: record.byteCount, sha256: revision[2]! };
  }

  async verify(record: ArtifactRecord): Promise<void> {
    await this.managedFiles.verify(this.reference(record));
  }

  async read(record: ArtifactRecord, maxBytes: number): Promise<Buffer> {
    return this.managedFiles.read(this.reference(record), maxBytes);
  }

  deleteRevision(record: ArtifactRecord): Promise<'DELETED' | 'MISSING'> {
    return this.managedFiles.deleteAfterReferenceCommit(this.reference(record).storageKey);
  }

  deleteStorageKey(storageKey: string): Promise<'DELETED' | 'MISSING'> {
    const match = /^task\/artifacts\/([^/]+)\/(.+)$/u.exec(storageKey);
    if (!match || !UUID.test(match[1]!) || !ARTIFACT_REVISION_FILE.test(match[2]!)) {
      throw new Error('Task artifact garbage-collection key is invalid.');
    }
    return this.managedFiles.deleteAfterReferenceCommit(storageKey);
  }

  async createCapture(artifactId: string): Promise<string> {
    await this.init();
    const capturePath = this.capturePath(artifactId);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(
        capturePath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      await enforcePosixMode(handle, 0o600);
      await handle.sync();
      await syncDirectoryIfSupported(this.captureRoot);
      return capturePath;
    } catch (error) {
      await fs.unlink(capturePath).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async readCapture(artifactId: string, maxBytes: number): Promise<Buffer | undefined> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error('Task artifact capture limit is invalid.');
    }
    const capturePath = this.capturePath(artifactId);
    let before: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      before = await fs.lstat(capturePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    assertPrivateCapture(before);
    const handle = await fs.open(
      capturePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    try {
      const stat = await handle.stat();
      assertPrivateCapture(stat);
      if (!sameFile(before, stat)) {
        throw new Error('Task artifact capture changed identity while it was read.');
      }
      if (stat.size > maxBytes) {
        throw new Error('Stored task artifact exceeds its byte limit.');
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength !== stat.size) {
        throw new Error('Task artifact capture changed while it was read.');
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async deleteCapture(artifactId: string): Promise<void> {
    const capturePath = this.capturePath(artifactId);
    try {
      const stat = await fs.lstat(capturePath);
      assertPrivateCapture(stat);
      await fs.unlink(capturePath);
      await syncDirectoryIfSupported(this.captureRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async reconcile(records: readonly ArtifactRecord[]): Promise<void> {
    await this.init();
    const expectedKeys = new Set<string>();
    const expectedCaptureIds = new Set<string>();
    for (const record of records) {
      const reference = this.reference(record);
      if (expectedKeys.has(reference.storageKey)) {
        throw new Error('Task artifact records contain a duplicate immutable revision.');
      }
      expectedKeys.add(reference.storageKey);
      if (record.kind === 'preview-stdout' || record.kind === 'preview-stderr') {
        expectedCaptureIds.add(record.id);
      }
      await this.managedFiles.verify(reference);
    }

    for (const storageKey of await collectStorageKeys(this.artifactRoot, this.managedFileRoot)) {
      if (!expectedKeys.has(storageKey)) {
        await this.managedFiles.deleteAfterReferenceCommit(storageKey);
      }
    }
    for (const entry of await readDirectory(this.captureRoot)) {
      const match = CAPTURE_FILE.exec(entry.name);
      if (entry.isSymbolicLink() || !entry.isFile() || !match) {
        throw new Error('Task artifact capture directory contains an unsafe entry.');
      }
      const stat = await fs.lstat(path.join(this.captureRoot, entry.name));
      assertPrivateCapture(stat);
      if (!expectedCaptureIds.has(match[1])) await this.deleteCapture(match[1]);
    }
  }

  private capturePath(artifactId: string): string {
    assertArtifactId(artifactId);
    return path.join(this.captureRoot, `${artifactId}.log`);
  }

  private absolutePath(storageKey: string): string {
    return path.join(this.managedFileRoot, ...storageKey.split('/'));
  }
}

function artifactStorageKey(artifactId: string, revisionId: string, sha256: string): string {
  assertArtifactId(artifactId);
  if (!UUID.test(revisionId)) throw new Error('Task artifact revision id is invalid.');
  if (!SHA256.test(sha256)) throw new Error('Task artifact digest is invalid.');
  return `task/artifacts/${artifactId}/${revisionId}-${sha256}.log`;
}

function assertArtifactId(artifactId: string): void {
  if (!UUID.test(artifactId)) throw new Error('Task artifact id is invalid.');
}

function assertPrivateCapture(stat: { isFile(): boolean; isSymbolicLink?(): boolean; uid: number | bigint; mode: number | bigint }): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink?.() === true ||
    !isOwnedByCurrentUser(stat) ||
    !posixModeMatches(stat, 0o600)
  ) {
    throw new Error('Task artifact capture failed its integrity check.');
  }
}

function sameFile(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

async function collectStorageKeys(directory: string, root: string): Promise<string[]> {
  const keys: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readDirectory(current)) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('Task artifact directory contains an unsafe entry.');
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        if (/^\..+\.task-monki-[0-9a-f-]{36}\.tmp$/u.test(entry.name)) continue;
        const relative = path.relative(root, absolute);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('Task artifact escaped the managed-file root.');
        }
        keys.push(relative.split(path.sep).join('/'));
      }
    }
  };
  await visit(directory);
  return keys;
}

async function readDirectory(directory: string): Promise<Dirent<string>[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
